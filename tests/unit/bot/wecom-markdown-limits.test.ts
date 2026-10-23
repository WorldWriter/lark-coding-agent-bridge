import { describe, expect, it } from 'vitest';
import { clipMarkdownForWecom, WECOM_MARKDOWN_MAX_BYTES } from '../../../src/bot/wecom/markdown-limits';

describe('clipMarkdownForWecom', () => {
  it('returns short text untouched', () => {
    expect(clipMarkdownForWecom('hello')).toBe('hello');
  });

  it('clips multi-byte text under the WeCom byte ceiling and appends a notice', () => {
    const text = '中'.repeat(10_000); // 30 000 bytes
    const out = clipMarkdownForWecom(text);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(WECOM_MARKDOWN_MAX_BYTES);
    expect(out.endsWith('_…（内容过长已截断）_')).toBe(true);
    expect(out.startsWith('中中中')).toBe(true);
  });

  it('never splits a surrogate pair', () => {
    const text = '😀'.repeat(100);
    const out = clipMarkdownForWecom(text, 60);
    for (const ch of out) expect(ch.length === 1 ? ch.charCodeAt(0) < 0xd800 || ch.charCodeAt(0) > 0xdfff : true).toBe(true);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(60);
  });
});
