/**
 * WeCom AI-bot markdown payload limits.
 *
 * Official doc (智能机器人长连接, 2026-10): markdown.content ≤ 20480 bytes,
 * UTF-8. We clip at a safer threshold so the truncation notice and any
 * SDK framing never push us over, and cut on a UTF-8 character boundary.
 */
export const WECOM_MARKDOWN_MAX_BYTES = 20_480;
const SAFE_LIMIT_BYTES = 19_800;
const TRUNCATION_NOTE = '\n\n_…（内容过长已截断）_';

export function clipMarkdownForWecom(text: string, limitBytes: number = SAFE_LIMIT_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= limitBytes) return text;
  const budget = Math.max(0, limitBytes - Buffer.byteLength(TRUNCATION_NOTE, 'utf8'));
  let lo = 0;
  let hi = text.length;
  // Binary search the largest prefix (in code units) that fits the byte budget.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= budget) lo = mid;
    else hi = mid - 1;
  }
  let cut = text.slice(0, lo);
  // Don't split a surrogate pair.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}${TRUNCATION_NOTE}`;
}
