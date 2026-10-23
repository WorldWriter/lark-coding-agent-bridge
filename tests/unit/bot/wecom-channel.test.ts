import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { createWecomChannel, type WecomSdkClient } from '../../../src/bot/wecom/channel';
import { WecomUnsupportedApiError } from '../../../src/bot/wecom/raw-client-shim';

interface StreamCall {
  reqId: string;
  streamId: string;
  content: string;
  finish: boolean;
}

class FakeSdk extends EventEmitter implements WecomSdkClient {
  readonly streams: StreamCall[] = [];
  readonly sent: Array<{ chatid: string; body: Record<string, unknown> }> = [];
  readonly media: Array<{ kind: 'reply' | 'send'; type: string; mediaId: string; target: string }> = [];
  readonly welcomes: Array<{ reqId: string; body: Record<string, unknown> }> = [];
  connected = false;
  failAuth = false;
  downloadPayload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  connect(): void {
    setImmediate(() => {
      if (this.failAuth) {
        this.emit('error', Object.assign(new Error('auth failed'), { code: 'WS_AUTH_FAILURE_EXHAUSTED' }));
        return;
      }
      this.connected = true;
      this.emit('connected');
      this.emit('authenticated');
    });
  }
  disconnect(): void {
    this.connected = false;
  }
  async replyStream(frame: { headers: { req_id: string } }, streamId: string, content: string, finish = false) {
    this.streams.push({ reqId: frame.headers.req_id, streamId, content, finish });
    return {} as never;
  }
  async sendMessage(chatid: string, body: Record<string, unknown>) {
    this.sent.push({ chatid, body });
    return {} as never;
  }
  async downloadFile(_url: string, _aesKey?: string) {
    return { buffer: this.downloadPayload, filename: 'pic.png' };
  }
  async uploadMedia(_buf: Buffer, options: { type: string; filename: string }) {
    return { media_id: `media-${options.type}-${options.filename}` };
  }
  async replyMedia(frame: { headers: { req_id: string } }, type: string, mediaId: string) {
    this.media.push({ kind: 'reply', type, mediaId, target: frame.headers.req_id });
    return {} as never;
  }
  async sendMediaMessage(chatid: string, type: string, mediaId: string) {
    this.media.push({ kind: 'send', type, mediaId, target: chatid });
    return {} as never;
  }
  async replyWelcome(frame: { headers: { req_id: string } }, body: Record<string, unknown>) {
    this.welcomes.push({ reqId: frame.headers.req_id, body });
    return {} as never;
  }
  get isConnected(): boolean {
    return this.connected;
  }

  /** Push an inbound text frame as the gateway would. */
  inbound(body: Record<string, unknown>, reqId = `req-${this.streams.length + this.sent.length + 1}`): void {
    this.emit('message', { cmd: 'aibot_msg_callback', headers: { req_id: reqId }, body });
  }
}

async function setup(opts: { throttleMs?: number; rolloverMs?: number; welcomeText?: string } = {}) {
  const sdk = new FakeSdk();
  const received: NormalizedMessage[] = [];
  const channel = createWecomChannel({
    botId: 'bot-1',
    secret: 's',
    botName: '小天才',
    ownerId: 'owner-userid',
    streamThrottleMs: opts.throttleMs ?? 20,
    streamRolloverMs: opts.rolloverMs ?? 60_000,
    connectTimeoutMs: 500,
    ...(opts.welcomeText ? { welcomeText: opts.welcomeText } : {}),
    createClient: () => sdk,
  });
  channel.on({ message: async (m) => void received.push(m) });
  await channel.connect();
  return { sdk, channel, received };
}

const settle = () => new Promise((r) => setTimeout(r, 5));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WecomChannel', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  it('connects on authenticated and reports identity + status', async () => {
    const { channel } = await setup();
    expect(channel.botIdentity).toEqual({ openId: 'bot-1', name: '小天才' });
    expect(channel.getConnectionStatus().state).toBe('connected');
    expect(channel.platform).toBe('wecom');
  });

  it('rejects connect when the gateway refuses credentials', async () => {
    const sdk = new FakeSdk();
    sdk.failAuth = true;
    const channel = createWecomChannel({ botId: 'b', secret: 's', createClient: () => sdk, connectTimeoutMs: 200 });
    await expect(channel.connect()).rejects.toThrow('auth failed');
  });

  it('normalizes inbound frames, remembers chat mode, and replies via the inbound frame', async () => {
    const { sdk, channel, received } = await setup();
    sdk.inbound({ msgid: 'm1', chattype: 'group', chatid: 'g1', from: { userid: 'u1' }, msgtype: 'text', text: { content: '@小天才 hi' } }, 'req-g1');
    await settle();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ chatId: 'g1', chatType: 'group', senderId: 'u1', content: 'hi' });
    expect(await channel.getChatMode('g1')).toBe('group');
    expect(await channel.getChatMode('nobody')).toBe('group');

    await channel.send('g1', { markdown: '**回复**' }, { replyTo: 'm1' });
    expect(sdk.streams).toHaveLength(1);
    expect(sdk.streams[0]).toMatchObject({ reqId: 'req-g1', content: '**回复**', finish: true });
    expect(sdk.sent).toHaveLength(0);
  });

  it('dedupes redelivered frames', async () => {
    const { sdk, received } = await setup();
    const body = { msgid: 'dup', chattype: 'single', from: { userid: 'u1' }, msgtype: 'text', text: { content: 'x' } };
    sdk.inbound(body, 'r1');
    sdk.inbound(body, 'r2');
    await settle();
    expect(received).toHaveLength(1);
  });

  it('falls back to proactive sendMessage when no inbound frame is known for the chat', async () => {
    const { sdk, channel } = await setup();
    await channel.send('u-unknown', { markdown: 'hello' });
    expect(sdk.sent).toEqual([{ chatid: 'u-unknown', body: { msgtype: 'markdown', markdown: { content: 'hello' } } }]);
  });

  it('streams: leading-edge frame, coalesced updates, terminal finish=true with latest text', async () => {
    const { sdk, channel } = await setup({ throttleMs: 40 });
    sdk.inbound({ msgid: 'm2', chattype: 'single', from: { userid: 'u2' }, msgtype: 'text', text: { content: 'go' } }, 'req-u2');
    await settle();

    await channel.stream(
      'u2',
      {
        markdown: async (ctrl) => {
          await ctrl.setContent('a');
          await ctrl.setContent('ab');
          await ctrl.setContent('abc');
          await wait(60);
          await ctrl.setContent('abcd');
        },
      },
      { replyTo: 'm2' },
    );

    const frames = sdk.streams;
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.every((f) => f.reqId === 'req-u2')).toBe(true);
    const ids = new Set(frames.map((f) => f.streamId));
    expect(ids.size).toBe(1);
    const last = frames[frames.length - 1]!;
    expect(last).toMatchObject({ content: 'abcd', finish: true });
    expect(frames.slice(0, -1).every((f) => f.finish === false)).toBe(true);
    // Coalescing: 'a' and 'ab' never both go out individually.
    expect(frames.filter((f) => f.content === 'ab').length + frames.filter((f) => f.content === 'a').length).toBeLessThanOrEqual(1);
  });

  it('streams: rolls over to a new stream id after the window and sends a placeholder when empty', async () => {
    const { sdk, channel } = await setup({ throttleMs: 5, rolloverMs: 30 });
    sdk.inbound({ msgid: 'm3', chattype: 'single', from: { userid: 'u3' }, msgtype: 'text', text: { content: 'go' } }, 'req-u3');
    await settle();
    await channel.stream('u3', {
      markdown: async (ctrl) => {
        await ctrl.setContent('one');
        await wait(50);
        await ctrl.setContent('two');
        await wait(20);
      },
    });
    const ids = [...new Set(sdk.streams.map((f) => f.streamId))];
    expect(ids.length).toBe(2);
    const firstSegmentEnd = sdk.streams.find((f) => f.streamId === ids[0] && f.finish);
    expect(firstSegmentEnd).toBeDefined();
    expect(sdk.streams[sdk.streams.length - 1]).toMatchObject({ streamId: ids[1], content: 'two', finish: true });

    sdk.streams.length = 0;
    await channel.stream('u3', { markdown: async () => {} });
    expect(sdk.streams).toEqual([
      expect.objectContaining({ content: '_（未返回内容）_', finish: true }),
    ]);
  });

  it('streams card producers by flattening each update to markdown', async () => {
    const { sdk, channel } = await setup({ throttleMs: 5 });
    sdk.inbound({ msgid: 'm4', chattype: 'single', from: { userid: 'u4' }, msgtype: 'text', text: { content: 'go' } }, 'req-u4');
    await settle();
    await channel.stream('u4', {
      card: {
        initial: { elements: [{ tag: 'markdown', content: 'init' }] },
        producer: async (ctrl) => {
          await ctrl.update({ elements: [{ tag: 'markdown', content: '**done**' }, { tag: 'hr' }] });
        },
      },
    });
    expect(sdk.streams[sdk.streams.length - 1]).toMatchObject({ content: '**done**\n---', finish: true });
  });

  it('sends media through upload + replyMedia / sendMediaMessage', async () => {
    const { sdk, channel } = await setup();
    sdk.inbound({ msgid: 'm5', chattype: 'single', from: { userid: 'u5' }, msgtype: 'text', text: { content: 'go' } }, 'req-u5');
    await settle();
    await channel.send('u5', { file: { source: Buffer.from('abc'), fileName: 'a.txt' } }, { replyTo: 'm5' });
    await channel.send('elsewhere', { image: { source: Buffer.from('img') } });
    expect(sdk.media).toEqual([
      { kind: 'reply', type: 'file', mediaId: 'media-file-a.txt', target: 'req-u5' },
      { kind: 'send', type: 'image', mediaId: 'media-image-image.png', target: 'elsewhere' },
    ]);
  });

  it('answers welcome events when configured', async () => {
    const { sdk } = await setup({ welcomeText: '你好，我是小天才' });
    sdk.emit('event', {});
    sdk.emit('event.enter_chat', { headers: { req_id: 'ev-1' }, body: { from: { userid: 'u' }, msgtype: 'event', event: { eventtype: 'enter_chat' } } });
    await settle();
    expect(sdk.welcomes).toEqual([{ reqId: 'ev-1', body: { msgtype: 'text', text: { content: '你好，我是小天才' } } }]);
  });

  describe('rawClient shim', () => {
    it('answers the Feishu-shaped calls the bridge makes', async () => {
      const { sdk, channel } = await setup();
      sdk.inbound(
        {
          msgid: 'm6',
          chattype: 'group',
          chatid: 'g6',
          from: { userid: 'u6' },
          msgtype: 'text',
          text: { content: 'q' },
          quote: { msgtype: 'text', text: { content: '被引用' } },
        },
        'req-g6',
      );
      await settle();
      const raw = channel.rawClient as any;

      // reactions → no id, no throw
      expect(await raw.im.v1.messageReaction.create({ path: { message_id: 'm6' } })).toEqual({ data: {} });
      expect(await raw.im.v1.messageReaction.delete({})).toEqual({});

      // owner lookup → configured admin
      const owner = await raw.application.v6.application.get({ params: {}, path: { app_id: 'bot-1' } });
      expect(owner.data.app.owner.owner_id).toBe('owner-userid');

      // known chats → groups seen so far
      const chats = await raw.request({ method: 'GET', url: '/open-apis/im/v1/chats?page_size=100' });
      expect(chats.data.items).toEqual([{ chat_id: 'g6', name: expect.any(String) }]);

      // quote lookup → Feishu-shaped items
      const got = await raw.im.v1.message.get({ path: { message_id: 'wecom-quote:m6' } });
      expect(got.data.items[0]).toMatchObject({
        message_id: 'wecom-quote:m6',
        msg_type: 'text',
        body: { content: JSON.stringify({ text: '被引用' }) },
      });

      // text reply → markdown via inbound frame
      const replied = await raw.im.v1.message.reply({
        path: { message_id: 'm6' },
        data: { msg_type: 'text', content: JSON.stringify({ text: '提示' }) },
      });
      expect(replied.data.message_id).toEqual(expect.any(String));
      expect(sdk.streams[sdk.streams.length - 1]).toMatchObject({ reqId: 'req-g6', content: '提示', finish: true });

      // managed card → create + create message by reference → flattened markdown
      const created = await raw.cardkit.v1.card.create({
        data: { type: 'card_json', data: JSON.stringify({ header: { title: { content: '标题' } }, elements: [{ tag: 'div', text: { content: '正文' } }] }) },
      });
      await raw.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: 'g6', msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: created.data.card_id } }) },
      });
      expect(sdk.streams[sdk.streams.length - 1]).toMatchObject({ content: '**标题**\n正文', finish: true });

      // delete → no-op
      expect(await raw.im.v1.message.delete({ path: { message_id: 'x' } })).toEqual({});
    });

    it('downloads and decrypts attachments through the SDK and sniffs the mime type', async () => {
      const { sdk, channel } = await setup();
      sdk.inbound({ msgid: 'm7', chattype: 'single', from: { userid: 'u7' }, msgtype: 'image', image: { url: 'https://cdn/i', aeskey: 'k' } }, 'req-u7');
      await settle();
      const raw = channel.rawClient as any;
      const result = await raw.im.v1.messageResource.get({ params: { type: 'image' }, path: { message_id: 'm7', file_key: 'wecom:m7:image:0' } });
      expect(result.headers['content-type']).toBe('image/png');
      const dir = await mkdtemp(join(tmpdir(), 'wecom-media-'));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      const target = join(dir, 'out.bin');
      await result.writeFile(target);
      expect(await readFile(target)).toEqual(sdk.downloadPayload);
    });

    it('throws a named error with the dotted path for anything Feishu-only', async () => {
      const { channel } = await setup();
      const raw = channel.rawClient as any;
      expect(() => raw.im.v1.chat.create({})).toThrow(WecomUnsupportedApiError);
      expect(() => raw.im.v1.chat.create({})).toThrow('im.v1.chat.create');
      await expect(raw.request({ method: 'GET', url: '/open-apis/drive/v1/files' })).rejects.toThrow(WecomUnsupportedApiError);
    });
  });
});
