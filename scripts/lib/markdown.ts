import { splitLines } from './text';

export type Line = { readonly number: number; readonly text: string };

const FENCE = /^\s*(```+|~~~+)/;
const HEADING = /^#{1,6}\s+(.+?)\s*#*$/;
const HTML_ANCHOR = /<a\s+name="([^"]+)"/g;
const LINK = /(?<!\\)\]\(([^()\s]+)\)/g;
const INLINE_CODE = /(`+).+?\1/g;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const UNESCAPED_PIPE = /(?<!\\)\|/g;
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

/** Lines outside fenced code, plus the line of a fence that never closes. */
export function proseLines(text: string): { lines: Line[]; unclosedAt: number | null } {
  const lines: Line[] = [];
  let fence: string | null = null;
  let openedAt = 0;
  splitLines(text).forEach((line, index) => {
    const number = index + 1;
    const marker = FENCE.exec(line)?.[1];
    if (!marker) {
      if (fence === null) lines.push({ number, text: line });
    } else if (fence === null) {
      fence = marker;
      openedAt = number;
    } else if (marker[0] === fence[0] && marker.length >= fence.length) {
      fence = null;
    }
  });
  return { lines, unclosedAt: fence === null ? null : openedAt };
}

/** The anchor GitHub generates for a heading. */
export function githubSlug(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\- ]/gu, '')
    .replaceAll(' ', '-');
}

export function anchors(text: string): Set<string> {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  for (const { text: line } of proseLines(text).lines) {
    for (const match of line.matchAll(HTML_ANCHOR)) {
      if (match[1]) result.add(match[1]);
    }
    const heading = HEADING.exec(line)?.[1];
    if (!heading) continue;
    const slug = githubSlug(heading);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    result.add(count ? `${slug}-${count}` : slug);
  }
  return result;
}

/** Relative link targets on a line, ignoring inline code and external URLs. */
export function localLinks(line: string): string[] {
  return [...line.replace(INLINE_CODE, '').matchAll(LINK)]
    .map((match) => match[1] ?? '')
    .filter((target) => target && !EXTERNAL.test(target));
}

export function isTableDivider(line: string): boolean {
  return TABLE_DIVIDER.test(line);
}

/** Cells in a table row. GitHub splits on every unescaped pipe, even inside inline code. */
export function tableCellCount(row: string): number {
  const body = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return (body.match(UNESCAPED_PIPE)?.length ?? 0) + 1;
}
