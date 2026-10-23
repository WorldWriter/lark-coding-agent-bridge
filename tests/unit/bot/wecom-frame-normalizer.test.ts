import { describe, expect, it } from 'vitest';
import {
  WECOM_QUOTE_ID_PREFIX,
  normalizeWecomFrame,
  stripLeadingMention,
} from '../../../src/bot/wecom/frame-normalizer';

function frame(body: Record<string, unknown>, reqId = 'req-1') {
  return { cmd: 'aibot_msg_callback', headers: { req_id: reqId }, body } as never;
}

describe('normalizeWecomFrame', () => {
  it('maps a single-chat text frame: chatId falls back to the sender userid', () => {
    const out = normalizeWecomFrame(
      frame({
        msgid: 'm1',
        aibotid: 'bot',
        chattype: 'single',
        from: { userid: 'zhangsan' },
        create_time: 1_760_000_000,
        msgtype: 'text',
        text: { content: '你好' },
      }),
    );
    expect(out).toBeDefined();
    const msg = out!.message;
    expect(msg.messageId).toBe('m1');
    expect(msg.chatId).toBe('zhangsan');
    expect(msg.chatType).toBe('p2p');
    expect(msg.senderId).toBe('zhangsan');
    expect(msg.content).toBe('你好');
    expect(msg.mentionedBot).toBe(false);
    expect(msg.resources).toEqual([]);
    expect(msg.createTime).toBe(1_760_000_000_000);
    expect(msg.replyToMessageId).toBeUndefined();
  });

  it('maps a group frame: chatid wins, leading @mention stripped, mentionedBot true', () => {
    const out = normalizeWecomFrame(
      frame({
        msgid: 'm2',
        chatid: 'wrkSFfCgAA',
        chattype: 'group',
        from: { userid: 'lisi' },
        msgtype: 'text',
        text: { content: '@小天才 /status' },
      }),
    )!;
    expect(out.message.chatId).toBe('wrkSFfCgAA');
    expect(out.message.chatType).toBe('group');
    expect(out.message.content).toBe('/status');
    expect(out.message.mentionedBot).toBe(true);
  });

  it('turns image / file / video payloads into resource descriptors keyed for the shim', () => {
    const out = normalizeWecomFrame(
      frame({
        msgid: 'm3',
        chattype: 'single',
        from: { userid: 'u' },
        msgtype: 'file',
        file: { url: 'https://cdn/x', aeskey: 'k', filename: 'report.pdf' },
      }),
    )!;
    expect(out.message.resources).toEqual([
      { type: 'file', fileKey: 'wecom:m3:file:0', fileName: 'report.pdf' },
    ]);
    expect(out.resources.get('wecom:m3:file:0')).toEqual({
      url: 'https://cdn/x',
      aeskey: 'k',
      kind: 'file',
      fileName: 'report.pdf',
    });
    expect(out.message.content).toBe('');
  });

  it('joins mixed text items and collects mixed images', () => {
    const out = normalizeWecomFrame(
      frame({
        msgid: 'm4',
        chattype: 'single',
        from: { userid: 'u' },
        msgtype: 'mixed',
        mixed: {
          msg_item: [
            { msgtype: 'text', text: { content: '看这张' } },
            { msgtype: 'image', image: { url: 'https://cdn/i1', aeskey: 'a' } },
            { msgtype: 'text', text: { content: '和这张' } },
            { msgtype: 'image', image: { url: 'https://cdn/i2' } },
          ],
        },
      }),
    )!;
    expect(out.message.content).toBe('看这张\n和这张');
    expect(out.message.resources.map((r) => r.fileKey)).toEqual([
      'wecom:m4:image:0',
      'wecom:m4:image:1',
    ]);
  });

  it('uses the voice transcript as content', () => {
    const out = normalizeWecomFrame(
      frame({
        msgid: 'm5',
        chattype: 'single',
        from: { userid: 'u' },
        msgtype: 'voice',
        voice: { content: '转写文本' },
      }),
    )!;
    expect(out.message.content).toBe('转写文本');
    expect(out.message.rawContentType).toBe('voice');
  });

  it('exposes a quote as a synthetic replyTo id plus a quote record', () => {
    const out = normalizeWecomFrame(
      frame({
        msgid: 'm6',
        chattype: 'single',
        from: { userid: 'u' },
        msgtype: 'text',
        text: { content: '这个怎么办' },
        quote: { msgtype: 'text', text: { content: '原消息' } },
      }),
    )!;
    expect(out.message.replyToMessageId).toBe(`${WECOM_QUOTE_ID_PREFIX}m6`);
    expect(out.quote).toMatchObject({
      messageId: `${WECOM_QUOTE_ID_PREFIX}m6`,
      content: '原消息',
      rawContentType: 'text',
    });
  });

  it('rejects frames without msgid or sender', () => {
    expect(normalizeWecomFrame(frame({ chattype: 'single', msgtype: 'text' }))).toBeUndefined();
    expect(normalizeWecomFrame({ headers: { req_id: 'x' } } as never)).toBeUndefined();
  });
});

describe('stripLeadingMention', () => {
  it('strips exactly one leading @token', () => {
    expect(stripLeadingMention('@bot hi')).toBe('hi');
    expect(stripLeadingMention('@bot @you hi')).toBe('@you hi');
    expect(stripLeadingMention('hi @bot')).toBe('hi @bot');
  });
});
