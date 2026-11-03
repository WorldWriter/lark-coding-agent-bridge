import { mkdtemp, rm, readdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedbackStore } from '../../../src/feedback/store';
import { parseFeedback } from '../../../src/feedback/handler';
import { tryHandleCommand, type CommandContext } from '../../../src/commands';

const roots: string[] = [];
async function root() { const dir = await mkdtemp(join(tmpdir(), 'feedback-test-')); roots.push(dir); return dir; }
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
const input = (messageId: string) => ({ messageId, actor: 'alice', original: '反馈：第一行\n第二行', text: '第一行\n第二行' });

describe('durable feedback', () => {
  it('preserves multiline original, concurrent retries and survives new store instance', async () => {
    const dir = await root();
    const stores = [new FeedbackStore(dir, 'group-a'), new FeedbackStore(dir, 'group-a')];
    const items = await Promise.all(stores.map(s => s.submit(input('m1'))));
    expect(items[0]!.id).toBe(items[1]!.id);
    expect(await new FeedbackStore(dir, 'group-a').list()).toHaveLength(1);
    expect(items[0]!.original).toBe(input('m1').original);
    expect(await new FeedbackStore(dir, 'group-b').list()).toEqual([]);
  });
  it('enforces status ownership and same-scope references with immutable history', async () => {
    const s = new FeedbackStore(await root(), 'a'); const r = await s.submit(input('m1'));
    await expect(s.update(r.id, '状态', '处理中', 'guest', 'm2', false)).rejects.toThrow('管理员');
    await expect(s.update(r.id, '状态', '已解决', 'owner', 'm3', true)).rejects.toThrow('结果');
    await expect(s.update(r.id, '关联', 'other-scope', 'owner', 'm4', true)).rejects.toThrow('真实反馈');
    await s.update(r.id, '补充', '补充说明', 'bob', 'm5', false);
    await s.update(r.id, '补充', '补充说明', 'bob', 'm5', false);
    await s.update(r.id, '状态', '已解决 已发布修复', 'owner', 'm6', true);
    const saved = (await s.list())[0]!;
    expect(saved.events).toHaveLength(2); expect(saved.original).toBe(input('m1').original);
    expect(saved.status).toBe('已解决');
  });
  it('does not overwrite corrupt data or acknowledge it as empty', async () => {
    const dir = await root(); const s = new FeedbackStore(dir, 'a'); await s.submit(input('m'));
    const file = (await readdir(dir)).find(f => f.endsWith('.json'))!;
    await writeFile(join(dir, file), '{broken');
    await expect(s.list()).rejects.toThrow();
    await expect(s.submit(input('m2'))).rejects.toThrow();
    expect(await readFile(join(dir, file), 'utf8')).toBe('{broken');
  });
  it('persists attachment selection by actor and requires same scope', async () => {
    const dir = await root(); const s = new FeedbackStore(dir, 'dm-a'); const r = await s.submit(input('m'));
    await s.selectAttachment('alice', r.id);
    expect(await new FeedbackStore(dir, 'dm-a').pendingAttachment('alice')).toBe(r.id);
    expect(await s.pendingAttachment('bob')).toBeUndefined();
    await expect(new FeedbackStore(dir, 'dm-b').selectAttachment('bob', r.id)).rejects.toThrow();
    await s.attach(r.id, [{ file: 'f'.repeat(64) }], 'alice', 'file-message');
    await s.attach(r.id, [{ file: 'f'.repeat(64) }], 'alice', 'file-message');
    expect((await s.list())[0]!.attachments).toHaveLength(1);
    expect(await s.pendingAttachment('alice')).toBeUndefined();
  });
});

async function harness() {
  const dir = await root(); const replies: unknown[] = [];
  const ctx = {
    scope: 'chat-a', chatMode: 'group', msg: { chatId: 'chat-a', chatType: 'group', senderId: 'alice', messageId: 'm1', content: '', resources: [] },
    controls: { profile: 'test', configPath: join(dir, 'config.json'), ownerRefreshState: 'ok', botOwnerId: 'owner', profileConfig: { accounts: { app: { id: 'bot' } }, access: { admins: ['owner'] } } },
    channel: { send: async (_chat: string, content: unknown) => { replies.push(content); return { messageId: 'response' }; }, downloadResourceToFile: async (_m: string, _k: string, _type: string, path: string) => { await writeFile(path, 'test file'); return {}; } },
  } as unknown as CommandContext;
  let n = 0;
  return { ctx, replies, async run(text: string) { ctx.msg.content = text; ctx.msg.messageId = `m${++n}`; return tryHandleCommand(ctx); }, last() { return JSON.stringify(replies.at(-1)); } };
}
describe('feedback chat flow without an LLM', () => {
  it('recognizes explicit intent only and preserves multiline text', () => {
    expect(parseFeedback('帮我分析一下用户反馈')).toBeUndefined();
    expect(parseFeedback('反馈：第一行\n第二行')?.args).toBe('第一行\n第二行');
  });
  it('submit -> query -> supplement -> summary -> authorized close, isolated from another chat', async () => {
    const h = await harness();
    expect(await h.run('反馈：按钮点了没反应')).toBe(true);
    const id = h.last().match(/FB-[a-f0-9-]{36}/)![0];
    await h.run(`补充反馈 ${id} Safari 可复现`); expect(h.last()).toContain('已保存');
    await h.run(`反馈状态 ${id} 已解决 修复完成`); expect(h.last()).toContain('管理员');
    h.ctx.msg.senderId = 'owner'; await h.run(`反馈分类 ${id} Bug`);
    await h.run(`反馈状态 ${id} 已解决 修复完成`); expect(h.last()).toContain('已保存');
    await h.run(`查看反馈 ${id}`); expect(h.last()).toContain('Safari');
    await h.run('反馈汇总'); expect(h.last()).toContain('Bug 1'); expect(h.last()).toContain('已解决 1');
    h.ctx.scope = 'chat-b'; await h.run(`查看反馈 ${id}`); expect(h.last()).toContain('没有这个反馈');
  });
  it('uploads, persists and retrieves a private attachment after explicit selection', async () => {
    const h = await harness(); h.ctx.msg.chatType = 'p2p'; h.ctx.chatMode = 'p2p';
    await h.run('反馈：截图问题'); const id = h.last().match(/FB-[a-f0-9-]{36}/)![0];
    await h.run(`反馈附件 ${id}`);
    h.ctx.msg.resources = [{ type: 'file', fileKey: 'key' }];
    await h.run(''); expect(h.last()).toContain('已保存 1 个附件');
    h.ctx.msg.resources = []; await h.run(`查看反馈附件 ${id} 1`);
    expect(h.last()).toContain('test file'.split('').map(c => c.charCodeAt(0)).join(','));
  });
  it('paginates large feedback without dropping later supplements', async () => {
    const h = await harness(); await h.run('反馈：' + '内容'.repeat(3500));
    const id = h.last().match(/FB-[a-f0-9-]{36}/)![0];
    await h.run(`补充反馈 ${id} 最后一条补充`);
    await h.run(`查看反馈 ${id} 3`); expect(h.last()).toContain('最后一条补充');
    await h.run('反馈列表 999'); expect(h.last()).toContain('只有 1 页');
  });
  it('does not acknowledge failed attachment downloads and allows retry/cancel', async () => {
    const h = await harness(); h.ctx.msg.chatType = 'p2p'; h.ctx.chatMode = 'p2p';
    await h.run('反馈：附件失败'); const id = h.last().match(/FB-[a-f0-9-]{36}/)![0];
    await h.run(`反馈附件 ${id}`);
    h.ctx.channel.downloadResourceToFile = async () => { throw new Error('private URL secret'); };
    h.ctx.msg.resources = [{ type: 'file', fileKey: 'failed' }];
    await h.run(''); expect(h.last()).toContain('未能确认成功'); expect(h.last()).not.toContain('secret');
    h.ctx.msg.resources = []; await h.run(`查看反馈 ${id}`); expect(h.last()).toContain('附件：0 个');
    await h.run('取消反馈附件'); expect(h.last()).toContain('已取消');
  });
  it('honors stricter attachment policy and expires pending uploads visibly', async () => {
    const h = await harness(); h.ctx.msg.chatType = 'p2p'; h.ctx.chatMode = 'p2p';
    await h.run('反馈：限制'); const id = h.last().match(/FB-[a-f0-9-]{36}/)![0];
    await h.run(`反馈附件 ${id}`);
    h.ctx.controls.profileConfig.attachments = { maxCount: 0 } as never;
    h.ctx.msg.resources = [{ type: 'file', fileKey: 'key' }];
    await h.run(''); expect(h.last()).toContain('最多 0 个附件');
    const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 700_000);
    try { await h.run(''); expect(h.last()).toContain('超过 10 分钟'); } finally { clock.mockRestore(); }
  });
  it('reports storage failure rather than success', async () => {
    const h = await harness();
    const dir = join(h.ctx.controls.configPath, '..', 'profiles');
    await writeFile(dir, 'not a directory');
    await h.run('反馈：不能保存'); expect(h.last()).toContain('未能确认成功');
    expect(h.last()).not.toContain('已记录');
  });
});
