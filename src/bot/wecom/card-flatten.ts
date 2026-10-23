/**
 * Flatten a Feishu card JSON (CardKit 1.0 `elements` or 2.0 `body.elements`)
 * into WeCom-friendly markdown.
 *
 * WeCom AI bots have template cards, but nothing that maps onto the bridge's
 * free-form cards (collapsible panels, markdown blocks, callback buttons). The
 * commands (`/help`, `/status`, `/ws`, …) build cards unconditionally, so on
 * WeCom we degrade: walk the JSON tree, keep every text-bearing node in
 * document order, render buttons as `[label]` hints and `hr` as a rule.
 * Callback values are dropped on purpose — there is no card action channel.
 */
export function flattenCardToMarkdown(card: unknown): string {
  const lines: string[] = [];
  const root = (card ?? {}) as Record<string, unknown>;
  const title = pick(root, ['header', 'title', 'content']);
  if (title) lines.push(`**${title}**`);
  walk(root.body ?? root.elements ?? root, lines, 0);
  return collapseBlankLines(lines.join('\n')).trim();
}

const SKIP_KEYS = new Set(['value', 'config', 'summary', 'behaviors', 'icon', 'border', 'header']);

function walk(node: unknown, out: string[], depth: number): void {
  if (depth > 12 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const tag = typeof obj.tag === 'string' ? obj.tag : undefined;

  switch (tag) {
    case 'markdown':
    case 'lark_md':
    case 'plain_text': {
      const content = typeof obj.content === 'string' ? obj.content : '';
      if (content.trim()) out.push(content);
      return;
    }
    case 'div': {
      const text = pick(obj, ['text', 'content']);
      if (text) out.push(text);
      walk(obj.fields, out, depth + 1);
      return;
    }
    case 'note': {
      const parts: string[] = [];
      for (const el of asArray(obj.elements)) {
        const c = pick(el as Record<string, unknown>, ['content']);
        if (c) parts.push(c);
      }
      if (parts.length > 0) out.push(parts.join(' '));
      return;
    }
    case 'hr':
      out.push('---');
      return;
    case 'button': {
      const label = pick(obj, ['text', 'content']);
      if (label) out.push(`[${label}]`);
      return;
    }
    case 'action': {
      const labels: string[] = [];
      for (const a of asArray(obj.actions)) {
        const label = pick(a as Record<string, unknown>, ['text', 'content']);
        if (label) labels.push(`[${label}]`);
      }
      if (labels.length > 0) out.push(labels.join('  '));
      return;
    }
    case 'collapsible_panel': {
      const header = (obj.header ?? {}) as Record<string, unknown>;
      const titleMd = pick(header, ['title', 'content']);
      if (titleMd) out.push(`> ${titleMd}`);
      walk(obj.elements, out, depth + 1);
      return;
    }
    case 'column_set':
    case 'column':
    case 'form':
      walk(obj.columns ?? obj.elements, out, depth + 1);
      return;
    case 'input':
    case 'select_static':
    case 'standard_icon':
    case 'img':
      return;
    default:
      break;
  }

  for (const [key, value] of Object.entries(obj)) {
    if (SKIP_KEYS.has(key)) continue;
    if (value && typeof value === 'object') walk(value, out, depth + 1);
  }
}

function pick(obj: Record<string, unknown> | undefined, path: string[]): string {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' ? cur.trim() : '';
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function collapseBlankLines(s: string): string {
  return s.replace(/\n{3,}/g, '\n\n');
}
