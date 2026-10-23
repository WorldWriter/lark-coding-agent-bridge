import type { NormalizedMessage, ResourceDescriptor } from '@larksuiteoapi/node-sdk';
import type { BaseMessage, QuoteContent, WsFrame } from '@wecom/aibot-node-sdk';

/**
 * WeCom AI-bot frame → bridge `NormalizedMessage`.
 *
 * The bridge was written against the Feishu SDK's normalized shape, so the
 * cheapest way to plug WeCom in is to produce the exact same shape here and
 * leave intake / queue / run-flow untouched. Field-by-field mapping:
 *
 *   messageId        ← body.msgid
 *   chatId           ← body.chatid, falling back to the sender's userid
 *                      (single-chat frames carry no chatid — the DM *is*
 *                      the user, same convention as Hermes' adapter)
 *   chatType         ← 'group' | 'p2p'
 *   senderId         ← body.from.userid (WeCom userid, NOT a Feishu open_id)
 *   content          ← text / voice transcript / mixed text items
 *   resources        ← image / file / video / mixed-images, keyed by a
 *                      synthetic fileKey that the raw-client shim resolves
 *                      back to {url, aeskey} for download
 *   mentionedBot     ← true in groups (WeCom only delivers @bot messages)
 *   replyToMessageId ← synthetic quote id when the frame carries `quote`;
 *                      the quote body is returned alongside so the shim can
 *                      answer `im.v1.message.get` for it without a network call
 */

export interface WecomResourceSource {
  url: string;
  aeskey?: string;
  kind: ResourceDescriptor['type'];
  fileName?: string;
}

export interface WecomQuoteRecord {
  messageId: string;
  senderId: string;
  content: string;
  rawContentType: string;
  createTime: number;
}

export interface NormalizedWecomFrame {
  message: NormalizedMessage;
  resources: Map<string, WecomResourceSource>;
  quote?: WecomQuoteRecord;
}

export const WECOM_QUOTE_ID_PREFIX = 'wecom-quote:';

export function normalizeWecomFrame(frame: WsFrame<BaseMessage>): NormalizedWecomFrame | undefined {
  const body = frame.body;
  if (!body || typeof body !== 'object') return undefined;
  const msgid = str(body.msgid);
  const senderId = str(body.from?.userid);
  if (!msgid || !senderId) return undefined;

  const isGroup = str(body.chattype).toLowerCase() === 'group';
  const chatId = str(body.chatid) || senderId;
  const msgtype = str(body.msgtype).toLowerCase();
  const resources = new Map<string, WecomResourceSource>();
  const descriptors: ResourceDescriptor[] = [];

  const addResource = (
    kind: ResourceDescriptor['type'],
    source: { url?: string; aeskey?: string } | undefined,
    index: number,
    fileName?: string,
  ): void => {
    const url = str(source?.url);
    if (!url) return;
    const fileKey = `wecom:${msgid}:${kind}:${index}`;
    resources.set(fileKey, {
      url,
      ...(source?.aeskey ? { aeskey: source.aeskey } : {}),
      kind,
      ...(fileName ? { fileName } : {}),
    });
    descriptors.push({ type: kind, fileKey, ...(fileName ? { fileName } : {}) });
  };

  let content = '';
  switch (msgtype) {
    case 'text':
      content = str((body as { text?: { content?: unknown } }).text?.content);
      break;
    case 'voice':
      // WeCom ships the transcript in voice.content; the audio itself isn't
      // exposed to AI bots, so the transcript is the whole message.
      content = str((body as { voice?: { content?: unknown } }).voice?.content);
      break;
    case 'image':
      addResource('image', (body as { image?: { url?: string; aeskey?: string } }).image, 0);
      break;
    case 'file': {
      const file = (body as { file?: { url?: string; aeskey?: string; filename?: string; name?: string } }).file;
      addResource('file', file, 0, str(file?.filename) || str(file?.name) || undefined);
      break;
    }
    case 'video':
      addResource('video', (body as { video?: { url?: string; aeskey?: string } }).video, 0);
      break;
    case 'mixed': {
      const items = (body as { mixed?: { msg_item?: unknown } }).mixed?.msg_item;
      const texts: string[] = [];
      let imageIndex = 0;
      for (const item of Array.isArray(items) ? items : []) {
        const it = item as { msgtype?: string; text?: { content?: unknown }; image?: { url?: string; aeskey?: string } };
        if (it.msgtype === 'text') {
          const t = str(it.text?.content);
          if (t) texts.push(t);
        } else if (it.msgtype === 'image') {
          addResource('image', it.image, imageIndex++);
        }
      }
      content = texts.join('\n');
      break;
    }
    default:
      content = str((body as { text?: { content?: unknown } }).text?.content);
  }

  if (isGroup) content = stripLeadingMention(content);

  const createTime = toMillis(body.create_time) || Date.now();
  const quote = body.quote ? quoteRecord(body.quote, msgid, createTime) : undefined;

  const message: NormalizedMessage = {
    messageId: msgid,
    chatId,
    chatType: isGroup ? 'group' : 'p2p',
    senderId,
    content,
    rawContentType: msgtype || 'text',
    resources: descriptors,
    mentions: [],
    mentionAll: false,
    // WeCom only delivers group messages that @ the bot, so every group
    // frame is by definition a mention. p2p never needs one.
    mentionedBot: isGroup,
    ...(quote ? { replyToMessageId: quote.messageId } : {}),
    createTime,
    raw: frame,
  };

  return { message, resources, ...(quote ? { quote } : {}) };
}

function quoteRecord(quote: QuoteContent, parentMsgId: string, createTime: number): WecomQuoteRecord {
  const type = str(quote.msgtype).toLowerCase();
  let content = '';
  if (type === 'text') content = str(quote.text?.content);
  else if (type === 'voice') content = str(quote.voice?.content);
  else if (type === 'mixed') {
    const items = quote.mixed?.msg_item;
    content = (Array.isArray(items) ? items : [])
      .map((it) => (it.msgtype === 'text' ? str(it.text?.content) : '[图片]'))
      .filter(Boolean)
      .join('\n');
  } else if (type === 'image') content = '[图片]';
  else if (type === 'file') content = '[文件]';
  return {
    messageId: `${WECOM_QUOTE_ID_PREFIX}${parentMsgId}`,
    senderId: '',
    content,
    rawContentType: type || 'text',
    createTime,
  };
}

/**
 * Group frames arrive as "@BotName 你好"; the client inserts the mention as
 * plain text (no structured mention list like Feishu). Strip one leading
 * @token so slash commands such as "@小天才 /status" still parse.
 */
export function stripLeadingMention(text: string): string {
  return text.replace(/^@\S+\s*/u, '').trim();
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

function toMillis(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  // WeCom timestamps are unix seconds; tolerate ms if a future SDK switches.
  return n < 1e12 ? n * 1000 : n;
}
