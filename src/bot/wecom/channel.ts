import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import {
  WSClient,
  generateReqId,
  type BaseMessage,
  type EventMessage,
  type WSClientOptions,
  type WeComMediaType,
  type WsFrame,
  type WsFrameHeaders,
} from '@wecom/aibot-node-sdk';
import { log, reportMetric } from '../../core/logger';
import { flattenCardToMarkdown } from './card-flatten';
import {
  normalizeWecomFrame,
  type WecomQuoteRecord,
  type WecomResourceSource,
} from './frame-normalizer';
import { clipMarkdownForWecom } from './markdown-limits';
import { createWecomRawClient, type WecomSendTarget } from './raw-client-shim';

/**
 * WeCom (企业微信) transport for the bridge.
 *
 * The bridge talks to a channel through seven members of the Feishu SDK's
 * `LarkChannel` (`on / connect / disconnect / send / stream / getChatMode /
 * botIdentity`, plus `rawClient` + `getConnectionStatus`). This object
 * implements that same surface on top of WeCom's AI-bot WebSocket gateway
 * so intake, queueing, run-flow, sessions and policy stay untouched.
 *
 * WeCom specifics that shape the design:
 *   - Outbound connection (`wss://openws.work.weixin.qq.com`), one live
 *     connection per BotID; a second login kicks the first.
 *   - Replies are correlated to the inbound frame (`req_id`). We remember the
 *     last frame per chat and per message so later sends (and the bridge's
 *     `replyTo`) can target it. Proactive `aibot_send_msg` is the fallback.
 *   - Streaming = repeatedly sending the full text under one `stream.id` with
 *     `finish=false`, then once with `finish=true`; a stream must finish
 *     within 10 minutes, so long runs roll over to a fresh stream id.
 *   - Per-chat rate limit (30/min) → leading-edge throttle on stream flushes.
 *   - Markdown payload ≤ 20480 bytes → clipped with a notice.
 */

export interface WecomChannelOptions {
  botId: string;
  secret: string;
  /** Display name reported as `botIdentity.name` and used in prompts. */
  botName?: string;
  /** WeCom userid treated as bot owner (admin tier for commands). */
  ownerId?: string;
  wsUrl?: string;
  /** Optional proxy agent for the WebSocket (`https-proxy-agent`). */
  proxyAgent?: unknown;
  /** Min interval between stream frames to one chat. Default 2500ms. */
  streamThrottleMs?: number;
  /** Start a new stream id after this long. Default 9 minutes. */
  streamRolloverMs?: number;
  connectTimeoutMs?: number;
  /** Sent within the 5s window after a user first enters the DM. */
  welcomeText?: string;
  /** Test seam: build the SDK client. */
  createClient?: (options: WSClientOptions) => WecomSdkClient;
}

/** The subset of `@wecom/aibot-node-sdk`'s WSClient we depend on. */
export interface WecomSdkClient {
  on(event: string, listener: (...args: any[]) => void): unknown;
  connect(): unknown;
  disconnect(): void;
  replyStream(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish?: boolean,
  ): Promise<unknown>;
  sendMessage(chatid: string, body: Record<string, unknown>): Promise<unknown>;
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>;
  uploadMedia(
    fileBuffer: Buffer,
    options: { type: WeComMediaType; filename: string },
  ): Promise<{ media_id: string }>;
  replyMedia(frame: WsFrameHeaders, mediaType: WeComMediaType, mediaId: string): Promise<unknown>;
  sendMediaMessage(chatid: string, mediaType: WeComMediaType, mediaId: string): Promise<unknown>;
  replyWelcome(frame: WsFrameHeaders, body: Record<string, unknown>): Promise<unknown>;
  readonly isConnected: boolean;
}

export interface WecomChannelHandlers {
  message?: (msg: NormalizedMessage) => void | Promise<void>;
  reconnecting?: () => void;
  reconnected?: () => void;
  error?: (err: Error & { code?: string }) => void;
  [other: string]: unknown;
}

export interface WecomSendOptions {
  replyTo?: string;
  replyInThread?: boolean;
}

interface MarkdownStreamController {
  append(chunk: string): Promise<void>;
  setContent(full: string): Promise<void>;
  readonly messageId: string;
}

interface CardStreamController {
  update(next: object | ((current: object) => object)): Promise<void>;
  readonly messageId: string;
  readonly current: object;
}

type SendInput =
  | { markdown: string }
  | { text: string }
  | { post: object }
  | { card: object }
  | { image: { source: string | Buffer } }
  | { file: { source: string | Buffer; fileName: string } }
  | { audio: { source: string | Buffer } }
  | { video: { source: string | Buffer } };

type StreamInput =
  | { markdown: (ctrl: MarkdownStreamController) => Promise<void> }
  | { card: { initial: object; producer: (ctrl: CardStreamController) => Promise<void> } };

const DEFAULT_STREAM_THROTTLE_MS = 2_500;
const DEFAULT_STREAM_ROLLOVER_MS = 9 * 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const MAX_REMEMBERED_FRAMES = 2_000;
const MAX_REMEMBERED_RESOURCES = 2_000;
const EMPTY_REPLY_PLACEHOLDER = '_（未返回内容）_';

export class WecomChannel {
  readonly platform = 'wecom' as const;
  readonly botIdentity: { openId: string; name: string };
  readonly rawClient: Record<string, unknown>;

  private readonly opts: WecomChannelOptions;
  private client: WecomSdkClient | undefined;
  private handlers: WecomChannelHandlers = {};
  private authenticatedOnce = false;
  private connecting = false;
  private reconnectAttempts = 0;

  private readonly framesByMsgId = new Map<string, WsFrameHeaders>();
  private readonly chatByMsgId = new Map<string, string>();
  private readonly lastFrameByChat = new Map<string, WsFrameHeaders>();
  private readonly chatTypes = new Map<string, 'p2p' | 'group'>();
  private readonly knownGroups = new Set<string>();
  private readonly resources = new Map<string, WecomResourceSource>();
  private readonly quotes = new Map<string, WecomQuoteRecord>();
  private readonly seenMsgIds = new Set<string>();

  constructor(opts: WecomChannelOptions) {
    this.opts = opts;
    this.botIdentity = { openId: opts.botId, name: opts.botName ?? 'WeCom Bot' };
    this.rawClient = createWecomRawClient({
      sendMarkdown: (target, markdown) => this.sendMarkdown(target, markdown),
      ...(opts.ownerId ? { ownerId: opts.ownerId } : {}),
      knownChats: () => [...this.knownGroups].map((id) => ({ chat_id: id, name: `企微群 ${id.slice(-6)}` })),
      quotes: this.quotes,
      resources: this.resources,
      download: (source) => this.download(source),
    });
  }

  on(handlers: WecomChannelHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  async connect(): Promise<void> {
    if (this.client) return;
    const sdkOptions: WSClientOptions = {
      botId: this.opts.botId,
      secret: this.opts.secret,
      ...(this.opts.wsUrl ? { wsUrl: this.opts.wsUrl } : {}),
      ...(this.opts.proxyAgent ? { wsOptions: { agent: this.opts.proxyAgent as never } } : {}),
      logger: sdkLogger(),
    };
    const client = this.opts.createClient
      ? this.opts.createClient(sdkOptions)
      : (new WSClient(sdkOptions) as unknown as WecomSdkClient);
    this.client = client;
    this.connecting = true;

    const authenticated = new Promise<void>((resolve, reject) => {
      const timeoutMs = this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        if (!this.authenticatedOnce) reject(new Error(`wecom handshake timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      client.on('authenticated', () => {
        clearTimeout(timer);
        this.connecting = false;
        if (!this.authenticatedOnce) {
          this.authenticatedOnce = true;
          log.info('wecom', 'authenticated', { botId: this.opts.botId });
          resolve();
          return;
        }
        this.reconnectAttempts = 0;
        this.handlers.reconnected?.();
      });
      client.on('error', (err: Error & { code?: string }) => {
        if (!this.authenticatedOnce) {
          clearTimeout(timer);
          this.connecting = false;
          reject(err);
          return;
        }
        this.handlers.error?.(err);
      });
    });

    client.on('reconnecting', (attempt: number) => {
      this.reconnectAttempts = typeof attempt === 'number' ? attempt : this.reconnectAttempts + 1;
      this.handlers.reconnecting?.();
    });
    client.on('disconnected', (reason: string) => {
      log.warn('wecom', 'disconnected', { reason });
    });
    client.on('event.disconnected_event', () => {
      // Another process logged in with the same BotID. Mirrors the Feishu
      // "same app online twice" footgun; surface it loudly.
      log.warn('wecom', 'kicked-by-new-connection', { botId: this.opts.botId });
      console.error('⚠️ 企微网关：同一 BotID 有新连接接入，本连接被踢下线。');
    });
    client.on('event.enter_chat', (frame: WsFrame<EventMessage>) => {
      void this.handleEnterChat(frame);
    });
    client.on('message', (frame: WsFrame<BaseMessage>) => {
      void this.handleMessage(frame).catch((err) => log.fail('wecom', err, { step: 'handle-message' }));
    });

    client.connect();
    await authenticated;
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connecting = false;
    client?.disconnect();
  }

  getConnectionStatus(): { state: 'connected' | 'connecting' | 'disconnected'; reconnectAttempts: number } {
    const connected = this.client?.isConnected === true;
    return {
      state: connected ? 'connected' : this.connecting ? 'connecting' : 'disconnected',
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  async getChatMode(chatId: string): Promise<'p2p' | 'group' | 'topic'> {
    return this.chatTypes.get(chatId) ?? 'group';
  }

  async send(chatId: string, input: SendInput, opts: WecomSendOptions = {}): Promise<{ messageId: string }> {
    const target: WecomSendTarget = { chatId, ...(opts.replyTo ? { replyTo: opts.replyTo } : {}) };
    if ('markdown' in input) return this.sendMarkdown(target, input.markdown);
    if ('text' in input) return this.sendMarkdown(target, input.text);
    if ('card' in input) return this.sendMarkdown(target, flattenCardToMarkdown(input.card));
    if ('post' in input) return this.sendMarkdown(target, flattenCardToMarkdown(input.post));
    if ('image' in input) return this.sendMedia(target, 'image', input.image.source, 'image.png');
    if ('file' in input) return this.sendMedia(target, 'file', input.file.source, input.file.fileName);
    if ('audio' in input) return this.sendMedia(target, 'voice', input.audio.source, 'voice.amr');
    if ('video' in input) return this.sendMedia(target, 'video', input.video.source, 'video.mp4');
    throw new Error('wecom send: unsupported input');
  }

  /**
   * Stream a reply. The bridge's producer calls `setContent(full)` on every
   * state change; we coalesce those into at most one WeCom frame per
   * `streamThrottleMs`, always sending the latest full text, and close the
   * stream with `finish=true` once the producer resolves.
   */
  async stream(chatId: string, input: StreamInput, opts: WecomSendOptions = {}): Promise<void> {
    const client = this.requireClient();
    const target: WecomSendTarget = { chatId, ...(opts.replyTo ? { replyTo: opts.replyTo } : {}) };
    const frame = this.resolveFrame(target);
    const throttleMs = this.opts.streamThrottleMs ?? DEFAULT_STREAM_THROTTLE_MS;
    const rolloverMs = this.opts.streamRolloverMs ?? DEFAULT_STREAM_ROLLOVER_MS;

    let latest = '';
    let dirty = false;
    let closed = false;
    let streamId = generateReqId('stream');
    let segmentStartedAt = Date.now();
    let lastFlushAt = 0;
    let timer: NodeJS.Timeout | undefined;
    let chain: Promise<void> = Promise.resolve();
    let frames = 0;

    const pushFrame = async (content: string, finish: boolean): Promise<void> => {
      if (!frame) return;
      await client.replyStream(frame, streamId, clipMarkdownForWecom(content), finish);
      frames += 1;
      lastFlushAt = Date.now();
    };

    const flushOnce = async (): Promise<void> => {
      if (!dirty || closed) return;
      dirty = false;
      if (Date.now() - segmentStartedAt >= rolloverMs) {
        // 10-minute stream window: close this segment and continue in a new one.
        await pushFrame(latest, true);
        streamId = generateReqId('stream');
        segmentStartedAt = Date.now();
        log.info('wecom', 'stream-rollover', { chatId });
      }
      await pushFrame(latest, false);
    };

    const scheduleFlush = (): void => {
      if (closed || timer) return;
      const wait = Math.max(0, throttleMs - (Date.now() - lastFlushAt));
      timer = setTimeout(() => {
        timer = undefined;
        chain = chain.then(flushOnce).catch((err) => {
          log.warn('wecom', 'stream-frame-failed', { chatId, err: errMessage(err) });
        });
      }, wait);
    };

    const markdownCtrl: MarkdownStreamController = {
      get messageId() {
        return streamId;
      },
      async setContent(full: string) {
        latest = full;
        dirty = true;
        scheduleFlush();
      },
      async append(chunk: string) {
        latest += chunk;
        dirty = true;
        scheduleFlush();
      },
    };

    let current: object = {};
    const cardCtrl: CardStreamController = {
      get messageId() {
        return streamId;
      },
      get current() {
        return current;
      },
      async update(next) {
        current = typeof next === 'function' ? next(current) : next;
        await markdownCtrl.setContent(flattenCardToMarkdown(current));
      },
    };

    try {
      if ('markdown' in input) {
        await input.markdown(markdownCtrl);
      } else {
        current = input.card.initial;
        await input.card.producer(cardCtrl);
      }
    } finally {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    }
    await chain;

    const finalText = latest.trim() ? latest : EMPTY_REPLY_PLACEHOLDER;
    if (frame) {
      // Re-open to send the terminal frame even if the throttle swallowed
      // the last update; `closed` only guards the timer path.
      await client.replyStream(frame, streamId, clipMarkdownForWecom(finalText), true);
      frames += 1;
    } else {
      // No inbound frame to reply to (e.g. restarted mid-conversation):
      // degrade to a single proactive message with the final text.
      await client.sendMessage(chatId, {
        msgtype: 'markdown',
        markdown: { content: clipMarkdownForWecom(finalText) },
      });
      frames += 1;
    }
    reportMetric('wecom_stream_frames', frames, { kind: 'stream' });
  }

  // ---------------------------------------------------------------------------

  private async handleMessage(frame: WsFrame<BaseMessage>): Promise<void> {
    const normalized = normalizeWecomFrame(frame);
    if (!normalized) {
      log.warn('wecom', 'frame-ignored', { reason: 'unparseable' });
      return;
    }
    const { message, resources, quote } = normalized;
    if (this.seenMsgIds.has(message.messageId)) return;
    remember(this.seenMsgIds, message.messageId, MAX_REMEMBERED_FRAMES);

    const headers: WsFrameHeaders = { headers: frame.headers };
    rememberMap(this.framesByMsgId, message.messageId, headers, MAX_REMEMBERED_FRAMES);
    rememberMap(this.chatByMsgId, message.messageId, message.chatId, MAX_REMEMBERED_FRAMES);
    this.lastFrameByChat.set(message.chatId, headers);
    this.chatTypes.set(message.chatId, message.chatType === 'group' ? 'group' : 'p2p');
    if (message.chatType === 'group') this.knownGroups.add(message.chatId);
    for (const [key, source] of resources) rememberMap(this.resources, key, source, MAX_REMEMBERED_RESOURCES);
    if (quote) rememberMap(this.quotes, quote.messageId, quote, MAX_REMEMBERED_FRAMES);

    log.info('wecom', 'inbound', {
      chatType: message.chatType,
      msgType: message.rawContentType,
      resources: message.resources.length,
      quoted: Boolean(quote),
    });
    await this.handlers.message?.(message);
  }

  private async handleEnterChat(frame: WsFrame<EventMessage>): Promise<void> {
    const userId = frame.body?.from?.userid;
    log.info('wecom', 'enter-chat', { userId });
    if (!this.opts.welcomeText || !this.client) return;
    try {
      await this.client.replyWelcome(
        { headers: frame.headers },
        { msgtype: 'text', text: { content: this.opts.welcomeText } },
      );
    } catch (err) {
      log.warn('wecom', 'welcome-failed', { err: errMessage(err) });
    }
  }

  private async sendMarkdown(target: WecomSendTarget, markdown: string): Promise<{ messageId: string }> {
    const client = this.requireClient();
    const content = clipMarkdownForWecom(markdown);
    const frame = this.resolveFrame(target);
    const messageId = generateReqId('msg');
    if (frame) {
      // A one-frame finished stream is the one reply shape we know every
      // inbound req_id accepts; it renders as a normal markdown message.
      await client.replyStream(frame, messageId, content, true);
      return { messageId };
    }
    const chatId = target.chatId || (target.replyTo ? this.chatByMsgId.get(target.replyTo) : undefined);
    if (!chatId) throw new Error('wecom send: no chat to deliver to');
    await client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content } });
    return { messageId };
  }

  private async sendMedia(
    target: WecomSendTarget,
    type: WeComMediaType,
    source: string | Buffer,
    fileName: string,
  ): Promise<{ messageId: string }> {
    const client = this.requireClient();
    const buffer = typeof source === 'string' ? await readFile(source) : source;
    const filename = typeof source === 'string' ? basename(source) : fileName;
    const { media_id } = await client.uploadMedia(buffer, { type, filename });
    const frame = this.resolveFrame(target);
    if (frame) {
      await client.replyMedia(frame, type, media_id);
    } else {
      await client.sendMediaMessage(target.chatId, type, media_id);
    }
    return { messageId: generateReqId('media') };
  }

  private async download(source: WecomResourceSource): Promise<{ buffer: Buffer; mime: string }> {
    const client = this.requireClient();
    const { buffer, filename } = await client.downloadFile(source.url, source.aeskey);
    return { buffer, mime: sniffMime(buffer, filename ?? source.fileName, source.kind) };
  }

  private resolveFrame(target: WecomSendTarget): WsFrameHeaders | undefined {
    if (target.replyTo) {
      const byMsg = this.framesByMsgId.get(target.replyTo);
      if (byMsg) return byMsg;
    }
    const chatId = target.chatId || (target.replyTo ? this.chatByMsgId.get(target.replyTo) : undefined);
    return chatId ? this.lastFrameByChat.get(chatId) : undefined;
  }

  private requireClient(): WecomSdkClient {
    if (!this.client) throw new Error('wecom channel not connected');
    return this.client;
  }
}

export function createWecomChannel(opts: WecomChannelOptions): WecomChannel {
  return new WecomChannel(opts);
}

function remember(set: Set<string>, value: string, max: number): void {
  set.add(value);
  if (set.size > max) {
    const first = set.values().next().value;
    if (first !== undefined) set.delete(first);
  }
}

function rememberMap<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.set(key, value);
  if (map.size > max) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  amr: 'audio/amr',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function sniffMime(buffer: Buffer, fileName: string | undefined, kind: string): string {
  const head = buffer.subarray(0, 12);
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && head.toString('ascii', 0, 6).startsWith('GIF8')) return 'image/gif';
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (head.length >= 5 && head.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  const ext = fileName?.split('.').pop()?.toLowerCase();
  if (ext && EXT_MIME[ext]) return EXT_MIME[ext];
  if (kind === 'image') return 'image/png';
  if (kind === 'video') return 'video/mp4';
  if (kind === 'audio') return 'audio/amr';
  return 'application/octet-stream';
}

function sdkLogger(): WSClientOptions['logger'] {
  return {
    debug: () => {},
    info: () => {},
    warn: (message: string, ...args: unknown[]) => log.warn('wecom-sdk', 'warn', { message, args: stringify(args) }),
    error: (message: string, ...args: unknown[]) => log.warn('wecom-sdk', 'error', { message, args: stringify(args) }),
  };
}

function stringify(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
