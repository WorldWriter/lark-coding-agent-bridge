#!/usr/bin/env node
/**
 * WeCom AI-bot 验门脚本（路线 B 第 0 步）。
 *
 * 用官方 @wecom/aibot-node-sdk 直连企微长连接网关，回声每条消息，并把
 * 后续接入最关心的几个未知数逐个打印出来：
 *   1. BotID / Secret / 网络是否能过认证
 *   2. 单聊帧有没有 chatid（预期：没有，靠 from.userid）
 *   3. 群里 @ 机器人能否收到；群里发图片 / 文件是否如官方文档所说收不到
 *   4. 流式回复（同一 stream id 多帧 + finish）是否生效
 *   5. 主动推送 aibot_send_msg 对单聊（chatid=userid）和群聊是否被接受
 *      —— 这决定日报能不能走这个 bot（用 --send 触发）
 *   6. 附件下载 + AES 解密是否正常
 *
 * 用法：
 *   WECOM_BOT_ID=xxx WECOM_SECRET=yyy node scripts/wecom-probe.mjs
 *   ... --send <chatid-or-userid> "文本"   # 连上后主动推一条，验证第 5 项
 *   ... --welcome "欢迎语"                  # enter_chat 事件 5 秒内回欢迎语
 */
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';

const botId = process.env.WECOM_BOT_ID ?? '';
const secret = process.env.WECOM_SECRET ?? '';
if (!botId || !secret) {
  console.error('缺 WECOM_BOT_ID / WECOM_SECRET 环境变量');
  process.exit(2);
}

const args = process.argv.slice(2);
const argValue = (flag, n = 1) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args.slice(i + 1, i + 1 + n) : undefined;
};
const sendSpec = argValue('--send', 2);
const welcome = argValue('--welcome', 1)?.[0];

const seen = { frames: 0, groups: new Set(), dms: new Set() };
const client = new WSClient({
  botId,
  secret,
  logger: quietLogger(),
});

client.on('connected', () => console.log('[ws] connected'));
client.on('authenticated', async () => {
  console.log('[ws] authenticated ✓  (BotID/Secret/网络 三项通过)');
  if (sendSpec) {
    const [chatid, text] = sendSpec;
    try {
      const res = await client.sendMessage(chatid, {
        msgtype: 'markdown',
        markdown: { content: text ?? 'probe: 主动推送测试' },
      });
      console.log('[send] 主动推送 OK', summarizeFrame(res));
    } catch (err) {
      console.log('[send] 主动推送 FAILED →', String(err?.message ?? err));
    }
  }
  console.log('现在去企微：① 私聊发文字 ② 群里 @ 它 ③ 私聊发图片 ④ 群里发图片（预期收不到）');
});
client.on('disconnected', (reason) => console.log('[ws] disconnected:', reason));
client.on('reconnecting', (n) => console.log('[ws] reconnecting attempt', n));
client.on('error', (err) => console.log('[ws] error:', err?.message ?? err));
client.on('event.disconnected_event', () => console.log('[ws] ⚠️ 被新连接踢下线（同 BotID 只允许一条长连接）'));
client.on('event.enter_chat', async (frame) => {
  console.log('[event] enter_chat from', frame.body?.from?.userid);
  if (welcome) {
    try {
      await client.replyWelcome(frame, { msgtype: 'text', text: { content: welcome } });
      console.log('[event] welcome sent');
    } catch (err) {
      console.log('[event] welcome FAILED →', String(err?.message ?? err));
    }
  }
});

client.on('message', async (frame) => {
  seen.frames += 1;
  const b = frame.body ?? {};
  const isGroup = b.chattype === 'group';
  if (isGroup) seen.groups.add(b.chatid);
  else seen.dms.add(b.from?.userid);
  console.log(
    `[msg#${seen.frames}] ${b.chattype} chatid=${b.chatid ?? '(none)'} from=${b.from?.userid} ` +
      `type=${b.msgtype} quote=${b.quote ? b.quote.msgtype : '-'} req_id=${frame.headers?.req_id}`,
  );
  const text = b.text?.content ?? b.voice?.content ?? '';
  if (text) console.log('       text:', JSON.stringify(text.slice(0, 120)));

  const media = b.image ?? b.file ?? b.video;
  if (media?.url) {
    try {
      const { buffer, filename } = await client.downloadFile(media.url, media.aeskey);
      console.log(
        `       media: ${buffer.length} bytes, magic=${buffer.subarray(0, 4).toString('hex')} filename=${filename ?? '-'} (AES ${media.aeskey ? 'yes' : 'no'})`,
      );
    } catch (err) {
      console.log('       media download FAILED →', String(err?.message ?? err));
    }
  }

  try {
    const streamId = generateReqId('stream');
    await client.replyStream(frame, streamId, '收到，正在处理…（流式帧 1/3）', false);
    await sleep(1200);
    await client.replyStream(frame, streamId, '收到，正在处理…（流式帧 2/3）\n\n> 这一帧应该覆盖上一帧', false);
    await sleep(1200);
    const echo = text ? `你说：${text}` : `收到一条 ${b.msgtype} 消息`;
    await client.replyStream(
      frame,
      streamId,
      `${echo}\n\n- chattype: ${b.chattype}\n- chatid: ${b.chatid ?? '(none)'}\n- from: ${b.from?.userid}\n\n_probe 回声完毕（3/3，finish=true）_`,
      true,
    );
    console.log('       stream reply ✓');
  } catch (err) {
    console.log('       stream reply FAILED →', String(err?.message ?? err));
  }
});

process.on('SIGINT', () => {
  console.log('\n汇总: frames=%d groups=%d dms=%d', seen.frames, seen.groups.size, seen.dms.size);
  if (seen.groups.size) console.log('群 chatid（可用于 --send 测主动推送）:', [...seen.groups].join(', '));
  if (seen.dms.size) console.log('单聊 userid（可用于 --send 测主动推送）:', [...seen.dms].join(', '));
  client.disconnect();
  process.exit(0);
});

console.log('连接 wss://openws.work.weixin.qq.com …  (Ctrl-C 退出并打印汇总)');
client.connect();

function summarizeFrame(frame) {
  return JSON.stringify({ errcode: frame?.errcode, errmsg: frame?.errmsg, req_id: frame?.headers?.req_id });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function quietLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: (...m) => console.log('[sdk:warn]', ...m), error: (...m) => console.log('[sdk:error]', ...m) };
}
