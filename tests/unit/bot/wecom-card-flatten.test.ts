import { describe, expect, it } from 'vitest';
import { flattenCardToMarkdown } from '../../../src/bot/wecom/card-flatten';
import { renderCard } from '../../../src/card/run-renderer';
import { initialState, reduce } from '../../../src/card/run-state';
import { helpCard, statusCard } from '../../../src/card/templates';

describe('flattenCardToMarkdown', () => {
  it('keeps the help card readable: title, command list, buttons as hints, rule', () => {
    const md = flattenCardToMarkdown(helpCard('小天才'));
    expect(md.startsWith('**💡 使用帮助**')).toBe(true);
    expect(md).toContain('`/new` `/reset`');
    expect(md).toContain('其他内容直接交给 小天才');
    expect(md).toContain('---');
    expect(md).toContain('[📊 状态]  [🔁 恢复会话]');
    // Callback payloads never leak into the text.
    expect(md).not.toContain('cmd');
  });

  it('flattens a CardKit 2.0 run card: markdown blocks + panel titles, no stop button payload', () => {
    let state = reduce(initialState, { type: 'text', delta: '第一段结论。' });
    state = reduce(state, {
      type: 'tool_use',
      id: 't1',
      name: 'Bash',
      input: { command: 'git status' },
    });
    const card = renderCard(state, { signCallback: () => 'TOKEN' });
    const md = flattenCardToMarkdown(card);
    expect(md).toContain('第一段结论。');
    expect(md).toContain('> ');
    expect(md).toContain('Bash');
    expect(md).toContain('[⏹ 终止]');
    expect(md).not.toContain('TOKEN');
    expect(md).not.toContain('bridge_token');
  });

  it('renders status card fields without JSON noise', () => {
    const md = flattenCardToMarkdown(
      statusCard({
        profileName: 'wecom',
        cwd: '/tmp/ws',
        sessionId: 'sess-12345678',
        sessionStale: false,
        agentName: 'Claude Code',
        runtimeAccess: { label: '权限', value: 'full' },
        activeRun: false,
        ownerState: 'ok',
        scope: 'zhangsan',
        chatMode: 'p2p',
      }),
    );
    expect(md).toContain('**📊 当前状态**');
    expect(md).toContain('`/tmp/ws`');
    expect(md).toContain('`sess-123…`');
    expect(md).toContain('[🆕 新会话]');
    expect(md).not.toMatch(/"tag"/);
  });

  it('tolerates junk input', () => {
    expect(flattenCardToMarkdown(undefined)).toBe('');
    expect(flattenCardToMarkdown({ elements: [{ tag: 'img', img_key: 'x' }] })).toBe('');
  });
});
