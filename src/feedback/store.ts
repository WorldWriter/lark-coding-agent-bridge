import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';

export const statuses = ['待确认', '待处理', '处理中', '已解决', '不处理'] as const;
export const categories = ['待分类', 'Bug', '体验', '需求'] as const;
export interface FeedbackEvent {
  messageId: string; actor: string; at: string; action: string; text: string;
}
export interface Feedback {
  id: string; sourceMessageId: string; reporter: string; receivedAt: string;
  original: string; text: string; status: string; category: string;
  owner?: string; related?: string; attachments?: { file: string; name?: string; messageId: string }[]; events: FeedbackEvent[];
}
interface Ledger { version: 1; records: Feedback[]; pending?: Record<string, { id: string; expires: number }> }
export class FeedbackError extends Error {}

/** A profile/account/chat ledger. Atomic replacement plus an inter-process lock:
 * acknowledgement is only sent after persistence; damaged data fails closed. */
export class FeedbackStore {
  constructor(private root: string, private scope: string) {}
  async transaction<T>(fn: (records: Feedback[], ledger: Ledger) => T): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = join(this.root, createHash('sha256').update(this.scope).digest('hex') + '.json');
    const release = await lockfile.lock(file, { realpath: false, retries: { retries: 20, minTimeout: 20, maxTimeout: 100 } });
    let tmp: string | undefined;
    try {
      let ledger: Ledger;
      try { ledger = JSON.parse(await readFile(file, 'utf8')) as Ledger; }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        ledger = { version: 1, records: [] };
      }
      if (ledger.version !== 1 || !Array.isArray(ledger.records) || ledger.records.some(r =>
        !r || typeof r.id !== 'string' || typeof r.text !== 'string' || typeof r.original !== 'string' ||
        typeof r.reporter !== 'string' || typeof r.sourceMessageId !== 'string' || typeof r.receivedAt !== 'string' ||
        !statuses.includes(r.status as typeof statuses[number]) || !categories.includes(r.category as typeof categories[number]) ||
        !Array.isArray(r.events) || r.events.some(e => !e || typeof e.actor !== 'string' || typeof e.messageId !== 'string' || typeof e.at !== 'string' || typeof e.action !== 'string' || typeof e.text !== 'string') ||
        (r.attachments !== undefined && (!Array.isArray(r.attachments) || r.attachments.some(a => !a || !/^[a-f0-9]{64}$/.test(a.file)))))) {
        throw new Error('Invalid feedback ledger');
      }
      const before = JSON.stringify(ledger);
      const result = fn(ledger.records, ledger);
      const after = JSON.stringify(ledger);
      if (before !== after) {
        tmp = `${file}.${randomUUID()}.tmp`;
        const handle = await open(tmp, 'wx', 0o600);
        try { await handle.writeFile(after); await handle.sync(); } finally { await handle.close(); }
        await rename(tmp, file);
      }
      return result;
    } finally {
      if (tmp) await rm(tmp, { force: true });
      await release();
    }
  }
  async submit(input: { messageId: string; actor: string; original: string; text: string }): Promise<Feedback> {
    return this.transaction(records => {
      const existing = records.find(r => r.sourceMessageId === input.messageId);
      if (existing) return existing;
      if (!input.text.trim() || input.text.length > 8000) throw new FeedbackError('请填写 1–8000 字的反馈内容。');
      const item: Feedback = {
        id: `FB-${randomUUID()}`, sourceMessageId: input.messageId, reporter: input.actor,
        receivedAt: new Date().toISOString(), original: input.original, text: input.text,
        status: '待确认', category: '待分类', events: [],
      };
      records.push(item);
      return item;
    });
  }
  async attach(id: string, files: { file: string; name?: string }[], actor: string, messageId: string): Promise<void> {
    await this.transaction((records, ledger) => {
      const item = records.find(r => r.id === id);
      if (!item) throw new FeedbackError('当前会话没有这个反馈编号。');
      if (!item.events.some(e => e.messageId === messageId)) {
        item.attachments ??= [];
        item.attachments.push(...files.map(file => ({ ...file, messageId })));
        item.events.push({ messageId, actor, at: new Date().toISOString(), action: '附件', text: `已保存 ${files.length} 个附件` });
      }
      if (ledger.pending?.[actor]?.id === id) delete ledger.pending[actor];
    });
  }
  async selectAttachment(actor: string, id: string): Promise<void> {
    await this.transaction((records, ledger) => {
      if (!records.some(r => r.id === id)) throw new FeedbackError('当前私聊没有这个反馈编号。');
      ledger.pending ??= {};
      ledger.pending[actor] = { id, expires: Date.now() + 600_000 };
    });
  }
  async pendingAttachment(actor: string): Promise<string | undefined> {
    return this.transaction((_records, ledger) => {
      const p = ledger.pending?.[actor];
      return p && p.expires > Date.now() ? p.id : undefined;
    });
  }
  async clearAttachment(actor: string): Promise<void> {
    await this.transaction((_records, ledger) => { if (ledger.pending) delete ledger.pending[actor]; });
  }
  async list(): Promise<Feedback[]> { return this.transaction(records => structuredClone(records)); }
  async update(id: string, action: string, text: string, actor: string, messageId: string, admin: boolean): Promise<Feedback> {
    return this.transaction(records => {
      const item = records.find(r => r.id === id);
      if (!item) throw new FeedbackError('当前会话没有这个反馈编号。请用“反馈列表”查询。');
      if (action !== '补充' && !admin) throw new FeedbackError('只有管理员可以修改分类、负责人、状态或关联反馈。');
      if (!text.trim() || text.length > 8000) throw new FeedbackError('请填写 1–8000 字的内容。');
      if (item.events.some(e => e.messageId === messageId)) return item;
      if (action === '状态') {
        const [status, ...reason] = text.split(/\s+/);
        if (!statuses.includes(status as typeof statuses[number])) throw new FeedbackError(`状态可选：${statuses.join('、')}。`);
        if ((status === '已解决' || status === '不处理') && !reason.join(' ').trim()) throw new FeedbackError('关闭反馈时请同时填写处理结果或原因。');
        item.status = status!;
      } else if (action === '分类') {
        if (!categories.includes(text as typeof categories[number])) throw new FeedbackError(`分类可选：${categories.join('、')}。`);
        item.category = text;
      } else if (action === '负责人') { item.owner = text; }
      else if (action === '关联') {
        if (text === id || !records.some(r => r.id === text)) throw new FeedbackError('只能关联当前会话内另一条真实反馈。');
        item.related = text;
      } else if (action !== '补充') throw new FeedbackError('不支持的反馈操作。');
      item.events.push({ messageId, actor, at: new Date().toISOString(), action, text });
      return item;
    });
  }
}
