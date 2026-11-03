import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, stat, rm, readFile, rename } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import type { CommandContext } from '../commands';
import { resolveAppPaths } from '../config/app-paths';
import { canRunAdminCommand } from '../policy/access';
import { log } from '../core/logger';
import { FeedbackError, FeedbackStore, type Feedback } from './store';

export const FEEDBACK_HELP = `反馈收集（仅当前群或私聊）
• 反馈：问题描述（建议写明页面、操作、预期和实际结果）
• 反馈列表 [页码] / 反馈汇总 / 查看反馈 编号 [页码]
• 补充反馈 编号 内容
• 反馈附件 编号 → 随后在同一私聊发送图片或文件（10 分钟内）
• 查看反馈附件 编号 序号（从 1 开始）；取消反馈附件
• 管理员：反馈分类 编号 Bug|体验|需求；反馈负责人 编号 姓名
• 管理员：反馈状态 编号 待确认|待处理|处理中|已解决|不处理 [结果或原因]
• 管理员：关联反馈 编号 另一编号
反馈只在收到明确提交并保存成功后登记；不自动监听全部群聊，不自动承诺排期。群附件请在私聊新建反馈后上传，私聊内容不会自动公开到群。`;
const commands: Record<string, string> = {
  '反馈列表': 'list', '反馈汇总': 'summary', '反馈帮助': 'help', '查看反馈': 'show',
  '补充反馈': '补充', '反馈分类': '分类', '反馈负责人': '负责人', '反馈状态': '状态',
  '取消反馈附件': 'cancel-attachment', '查看反馈附件': 'file', '关联反馈': '关联', '反馈附件': 'attachment',
};
export function parseFeedback(text: string): { action: string; args: string } | undefined {
  const t = text.trim();
  const submit = /^(?:反馈\s*[:：]|提交反馈\s+|\/feedback\s+add\s+)([\s\S]*)$/.exec(t);
  if (submit) return { action: 'add', args: submit[1]!.trim() };
  if (t === '/feedback' || t === '反馈') return { action: 'help', args: '' };
  for (const [name, action] of Object.entries(commands)) {
    if (t === name || t.startsWith(name + ' ')) return { action, args: t.slice(name.length).trim() };
  }
}
const safe = (s: string) => s.replace(/[\\`*_<>\[\]#]/g, c => '\\' + c);
const pageNumber = (s: string) => {
  if (s && !/^[1-9]\d*$/.test(s)) throw new FeedbackError('页码必须为正整数。');
  return Number(s || 1);
};
function detail(item: Feedback, page = 1): string {
  const text = `反馈 ${item.id}\n状态：${item.status} · ${item.category}\n提出人：${safe(item.reporter)}\n收到时间：${item.receivedAt}\n负责人：${safe(item.owner ?? '待确认')}\n来源消息：${safe(item.sourceMessageId)}\n${item.related ? `关联：${item.related}\n` : ''}\n附件：${item.attachments?.length ?? 0} 个（查看反馈附件 编号 序号）\n原始反馈：\n${safe(item.text)}\n\n${item.events.map(e => `${e.at} ${safe(e.actor)} · ${e.action}：${safe(e.text)}`).join('\n')}`;
  const pages = Math.max(1, Math.ceil(text.length / 3000));
  if (page > pages) throw new FeedbackError(`只有 ${pages} 页。`);
  return `${text.slice((page - 1) * 3000, page * 3000)}\n\n第 ${page}/${pages} 页；查看反馈 ${item.id} ${Math.min(page + 1, pages)}`;
}

/** Called after the normal intake authorization/mention gates, before any LLM.
 * Actor and scope are supplied by the platform, never parsed from user text. */
export async function tryHandleFeedback(ctx: CommandContext): Promise<boolean> {
  const parsed = parseFeedback(ctx.msg.content);
  const profileDir = resolveAppPaths({ rootDir: dirname(ctx.controls.configPath), profile: ctx.controls.profile }).profileDir;
  const scope = JSON.stringify([ctx.controls.profileConfig.accounts.app.tenant, ctx.controls.profileConfig.accounts.app.id, ctx.scope,
    ctx.msg.chatType === 'p2p' ? ctx.msg.senderId : 'group']);
  const root = join(profileDir, 'feedback');
  const store = new FeedbackStore(root, scope);
  const send = async (markdown: string) => ctx.channel.send(ctx.msg.chatId, { markdown }, {
    replyTo: ctx.msg.messageId, ...(ctx.chatMode === 'topic' ? { replyInThread: true } : {}),
  });
  const saveAttachments = async (id: string) => {
    if (ctx.msg.resources.length > 5) throw new FeedbackError('每次最多 5 个附件，本次附件未登记，请分批发送。');
    const files: { file: string; name: string }[] = [];
    const blobDir = join(root, 'attachments', createHash('sha256').update(scope).digest('hex'));
    await mkdir(blobDir, { recursive: true, mode: 0o700 });
    for (const resource of ctx.msg.resources) {
      if (resource.type === 'sticker') throw new FeedbackError('表情不能作为反馈附件，请发送图片或文件。');
      const file = createHash('sha256').update(ctx.msg.messageId + resource.fileKey).digest('hex');
      const target = join(blobDir, file);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        const result = await ctx.channel.downloadResourceToFile(ctx.msg.messageId, resource.fileKey, resource.type === 'image' ? 'image' : 'file', temporary);
        await chmod(temporary, 0o600);
        if ((await stat(temporary)).size > 20 * 1024 * 1024) throw new FeedbackError('附件超过 20MB，未登记。请压缩后重试。');
        await rename(temporary, target);
        const extensions: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'application/pdf': '.pdf', 'text/plain': '.txt' };
        const name = basename(resource.fileName ?? `attachment${extensions[result.contentType ?? ''] ?? '.bin'}`).replace(/[\x00-\x1f]/g, '').slice(0, 150) || 'attachment.bin';
        files.push({ file, name });
      } finally { await rm(temporary, { force: true }); }
    }
    await store.attach(id, files, ctx.msg.senderId, ctx.msg.messageId);
    return files.length;
  };
  let handled = !!parsed;
  try {
    if (!parsed) {
      if (!ctx.msg.resources.length || ctx.msg.chatType !== 'p2p') return false;
      handled = true;
      const pending = await store.pendingAttachment(ctx.msg.senderId);
      if (!pending) return false;
      const count = await saveAttachments(pending);
      await send(`已保存 ${count} 个附件到 ${pending}。`);
      return true;
    }
    const { action, args } = parsed;
    if (action === 'cancel-attachment') { await store.clearAttachment(ctx.msg.senderId); await send('已取消等待反馈附件。'); return true; }
    if (action === 'help') { await send(FEEDBACK_HELP); return true; }
    if (action === 'add') {
      const item = await store.submit({ messageId: ctx.msg.messageId, actor: ctx.msg.senderId, original: ctx.msg.content, text: args });
      let attachmentNote = '';
      if (ctx.msg.resources.length) {
        try { attachmentNote = `\n已保存 ${await saveAttachments(item.id)} 个附件。`; }
        catch { attachmentNote = '\n文本已保存，但附件保存失败。请用“反馈附件 编号”重新上传。'; }
      }
      await send(`已记录反馈 ${item.id}${attachmentNote}\n状态：${item.status}\n${safe(item.text.slice(0, 300))}\n\n可用“补充反馈 ${item.id} 内容”继续补充。附件请在私聊使用“反馈附件 ${item.id}”。`);
      return true;
    }
    if (action === 'list' || action === 'summary') {
      const records = await store.list();
      if (!records.length) { await send('当前会话还没有已记录的反馈。发送“反馈：内容”开始。'); return true; }
      if (action === 'summary') {
        const open = records.filter(r => !['已解决', '不处理'].includes(r.status));
        const highlights = open.slice(0, 5).map(r => `• ${r.id} · ${r.status} · ${safe(r.text.replace(/\s+/g, ' ').slice(0, 100))}`).join('\n');
        const counts = (key: 'category' | 'status') => [...new Set(records.map(r => r[key]))].map(v => `${v} ${records.filter(r => r[key] === v).length}`).join('；');
        await send(`当前会话共 ${records.length} 条原始反馈（关联反馈仍分别计数）。\n分类：${counts('category')}\n状态：${counts('status')}\n负责人待确认：${records.filter(r => !r.owner).length}\n\n待跟进 ${open.length} 条（按提交时间展示前 5 条）：\n${highlights || '无'}\n\n使用“反馈列表”查看具体问题。分类由管理员确认，不自动推断排期或优先级。`);
      } else {
        const page = pageNumber(args); const pages = Math.ceil(records.length / 10);
        if (page > pages) throw new FeedbackError(`只有 ${pages} 页。`);
        const rows = records.slice().reverse().slice((page - 1) * 10, page * 10);
        await send(`反馈列表 · 第 ${page}/${pages} 页 · 共 ${records.length} 条\n` + rows.map(r => `• ${r.id} · ${r.status} · ${r.category}\n  ${safe(r.text.replace(/\s+/g, ' ').slice(0, 100))}`).join('\n') + '\n查看反馈 编号 / 反馈列表 页码');
      }
      return true;
    }
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args);
    if (!match) throw new FeedbackError('请填写反馈编号。发送“反馈帮助”查看用法。');
    const id = match[1]!; const value = match[2]?.trim() ?? '';
    if (action === 'file') {
      const item = (await store.list()).find(r => r.id === id);
      const attachment = item?.attachments?.[pageNumber(value) - 1];
      if (!attachment || !/^[a-f0-9]{64}$/.test(attachment.file)) throw new FeedbackError('当前反馈没有这个附件序号。');
      const filePath = join(root, 'attachments', createHash('sha256').update(scope).digest('hex'), attachment.file);
      await ctx.channel.send(ctx.msg.chatId, { file: { source: await readFile(filePath), fileName: attachment.name ?? `${id}-${pageNumber(value)}.bin` } }, { replyTo: ctx.msg.messageId });
    } else if (action === 'show') {
      const item = (await store.list()).find(r => r.id === id);
      if (!item) throw new FeedbackError('当前会话没有这个反馈编号。');
      await send(detail(item, pageNumber(value)));
    } else if (action === 'attachment') {
      if (ctx.msg.chatType !== 'p2p') throw new FeedbackError('企微群附件当前无法接收。请在私聊新建反馈，再使用“反馈附件 编号”。');
      await store.selectAttachment(ctx.msg.senderId, id);
      await send('请在 10 分钟内发送图片或文件，每次最多 5 个、每个不超过 20MB。附件保存在当前私聊反馈，不自动公开到群。');
    } else {
      const admin = canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok;
      const item = await store.update(id, action, value, ctx.msg.senderId, ctx.msg.messageId, admin);
      await send(`已保存${action}：${item.id}\n状态：${item.status} · ${item.category}\n${safe(value.slice(0, 500))}`);
    }
  } catch (err) {
    if (!handled) return false;
    if (!(err instanceof FeedbackError)) log.warn('feedback', 'operation-failed', { action: parsed?.action ?? 'attachment' });
    await send(err instanceof FeedbackError ? err.message : '反馈操作未能确认成功，请稍后重试或用“反馈列表”核对；不要重复改写原文。');
  }
  return true;
}
