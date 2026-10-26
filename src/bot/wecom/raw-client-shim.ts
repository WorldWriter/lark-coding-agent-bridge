import { writeFile } from 'node:fs/promises';
import { log } from '../../core/logger';
import { flattenCardToMarkdown } from './card-flatten';
import type { WecomQuoteRecord, WecomResourceSource } from './frame-normalizer';

/**
 * A stand-in for `LarkChannel.rawClient` on WeCom.
 *
 * The bridge reaches past the channel abstraction in a handful of places
 * (reactions, quote lookup, attachment download, managed cards, app-owner
 * lookup, known-chats listing). Rather than touching every call site, we
 * answer the exact Feishu-shaped calls they make with WeCom equivalents or
 * harmless no-ops, and fail loudly — with the dotted path — for anything
 * else so a new call site can't silently misbehave.
 */

export class WecomUnsupportedApiError extends Error {
  readonly code = 'WECOM_UNSUPPORTED_API';
  constructor(readonly apiPath: string) {
    super(`Feishu API not available on WeCom: ${apiPath}`);
    this.name = 'WecomUnsupportedApiError';
  }
}

export interface WecomSendTarget {
  chatId: string;
  replyTo?: string;
}

export interface WecomRawClientDeps {
  sendMarkdown(target: WecomSendTarget, markdown: string): Promise<{ messageId: string }>;
  /** WeCom userid treated as the bot owner (admin tier). */
  ownerId?: string;
  knownChats(): Array<{ chat_id: string; name: string }>;
  quotes: ReadonlyMap<string, WecomQuoteRecord>;
  resources: ReadonlyMap<string, WecomResourceSource>;
  download(source: WecomResourceSource): Promise<{ buffer: Buffer; mime: string }>;
}

interface StoredCard {
  card: unknown;
  sentTo?: WecomSendTarget;
}

export function createWecomRawClient(deps: WecomRawClientDeps): Record<string, unknown> {
  const cards = new Map<string, StoredCard>();
  let nextCard = 1;
  let nextMessage = 1;

  const sendContent = async (
    target: WecomSendTarget,
    msgType: string | undefined,
    content: string | undefined,
  ): Promise<{ data: { message_id: string } }> => {
    const markdown = contentToMarkdown(msgType, content, cards, target);
    if (!markdown.trim()) {
      return { data: { message_id: `wecom-empty-${nextMessage++}` } };
    }
    const sent = await deps.sendMarkdown(target, markdown);
    return { data: { message_id: sent.messageId } };
  };

  const explicit = {
    async request(payload: { method?: string; url?: string }): Promise<unknown> {
      const url = payload?.url ?? '';
      if (url.startsWith('/open-apis/im/v1/chats')) {
        return { data: { items: deps.knownChats(), has_more: false } };
      }
      throw new WecomUnsupportedApiError(`request ${payload?.method ?? ''} ${url}`.trim());
    },
    application: {
      v6: {
        application: {
          async get(): Promise<unknown> {
            if (!deps.ownerId) {
              throw new Error('wecom owner not configured (set access.admins[0])');
            }
            return { data: { app: { owner: { owner_id: deps.ownerId } } } };
          },
        },
      },
    },
    cardkit: {
      v1: {
        card: {
          async create(payload: { data?: { data?: string } }): Promise<unknown> {
            const cardId = `wecom-card-${nextCard++}`;
            cards.set(cardId, { card: parseJson(payload?.data?.data) });
            return { data: { card_id: cardId } };
          },
          async update(payload: {
            path?: { card_id?: string };
            data?: { card?: { data?: string } };
          }): Promise<unknown> {
            const cardId = payload?.path?.card_id ?? '';
            const entry = cards.get(cardId);
            const card = parseJson(payload?.data?.card?.data);
            if (!entry) {
              cards.set(cardId, { card });
              return {};
            }
            entry.card = card;
            // Cards can't be edited in place on WeCom; a form update becomes a
            // follow-up message in the same chat.
            if (entry.sentTo) {
              const md = flattenCardToMarkdown(card);
              if (md.trim()) await deps.sendMarkdown(entry.sentTo, md);
            }
            return {};
          },
        },
      },
    },
    im: {
      v1: {
        message: {
          async create(payload: {
            params?: { receive_id_type?: string };
            data?: { receive_id?: string; msg_type?: string; content?: string };
          }): Promise<unknown> {
            const chatId = payload?.data?.receive_id ?? '';
            if (!chatId) throw new Error('im.v1.message.create: receive_id required');
            return sendContent({ chatId }, payload?.data?.msg_type, payload?.data?.content);
          },
          async reply(payload: {
            path?: { message_id?: string };
            data?: { msg_type?: string; content?: string };
          }): Promise<unknown> {
            const replyTo = payload?.path?.message_id ?? '';
            if (!replyTo) throw new Error('im.v1.message.reply: message_id required');
            // The channel resolves chatId from the replied-to frame.
            return sendContent({ chatId: '', replyTo }, payload?.data?.msg_type, payload?.data?.content);
          },
          async delete(): Promise<unknown> {
            return {};
          },
          async get(payload: { path?: { message_id?: string } }): Promise<unknown> {
            const id = payload?.path?.message_id ?? '';
            const quote = deps.quotes.get(id);
            if (!quote) throw new WecomUnsupportedApiError(`im.v1.message.get(${id})`);
            return {
              data: {
                items: [
                  {
                    message_id: quote.messageId,
                    msg_type: 'text',
                    body: { content: JSON.stringify({ text: quote.content }) },
                    sender: quote.senderId ? { id: quote.senderId } : undefined,
                    create_time: String(quote.createTime),
                  },
                ],
              },
            };
          },
        },
        messageReaction: {
          // No reactions on WeCom. Returning no id makes the bridge skip the
          // cleanup step without logging a warning.
          async create(): Promise<unknown> {
            return { data: {} };
          },
          async delete(): Promise<unknown> {
            return {};
          },
        },
        messageResource: {
          async get(payload: { path?: { file_key?: string } }): Promise<unknown> {
            const fileKey = payload?.path?.file_key ?? '';
            const source = deps.resources.get(fileKey);
            if (!source) throw new Error(`wecom resource not found: ${fileKey}`);
            const { buffer, mime } = await deps.download(source);
            return {
              headers: { 'content-type': mime },
              async writeFile(path: string): Promise<void> {
                await writeFile(path, buffer);
              },
            };
          },
        },
      },
    },
  };

  const markCardSent = (cardId: string, target: WecomSendTarget): void => {
    const entry = cards.get(cardId);
    if (entry) entry.sentTo = target;
  };

  return withUnsupportedFallback(
    Object.assign(explicit, { __wecomMarkCardSent: markCardSent }),
    [],
  ) as Record<string, unknown>;
}

/** Translate a Feishu `msg_type` + content JSON into markdown. */
function contentToMarkdown(
  msgType: string | undefined,
  content: string | undefined,
  cards: Map<string, StoredCard>,
  target: WecomSendTarget,
): string {
  const parsed = parseJson(content) as Record<string, unknown> | undefined;
  switch (msgType) {
    case 'text':
      return typeof parsed?.text === 'string' ? parsed.text : content ?? '';
    case 'interactive': {
      const ref = parsed as { type?: string; data?: { card_id?: string } } | undefined;
      if (ref?.type === 'card' && ref.data?.card_id) {
        const entry = cards.get(ref.data.card_id);
        if (entry) {
          entry.sentTo = target;
          return flattenCardToMarkdown(entry.card);
        }
        return '';
      }
      return flattenCardToMarkdown(parsed);
    }
    case 'post':
      return flattenPost(parsed);
    default:
      log.warn('wecom', 'unknown-msg-type', { msgType });
      return typeof content === 'string' ? content : '';
  }
}

function flattenPost(post: Record<string, unknown> | undefined): string {
  if (!post) return '';
  const lines: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.text === 'string') lines.push(obj.text);
    if (typeof obj.title === 'string') lines.unshift(`**${obj.title}**`);
    if (obj.content) visit(obj.content);
    for (const v of Object.values(obj)) if (Array.isArray(v)) visit(v);
  };
  visit(post);
  return lines.join('\n');
}

function parseJson(s: string | undefined): unknown {
  if (typeof s !== 'string') return undefined;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Wrap `obj` so that any property path not explicitly provided resolves to
 * a callable that throws `WecomUnsupportedApiError` naming the path. Nested
 * plain objects are wrapped recursively; functions are returned as-is.
 */
function withUnsupportedFallback(obj: Record<string, unknown>, path: string[]): unknown {
  return new Proxy(obj, {
    get(target, prop) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop);
      if (prop === 'then') return undefined;
      if (prop in target) {
        const value = target[prop];
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return withUnsupportedFallback(value as Record<string, unknown>, [...path, prop]);
        }
        return value;
      }
      return unsupported([...path, prop]);
    },
  });
}

function unsupported(path: string[]): unknown {
  const thrower = (): never => {
    throw new WecomUnsupportedApiError(path.join('.'));
  };
  return new Proxy(thrower, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then') return undefined;
      return unsupported([...path, prop]);
    },
    apply() {
      return thrower();
    },
  });
}
