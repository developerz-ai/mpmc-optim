import { splitLines } from './text';

export type SnippetMode = 'compile' | 'run';
export type Snippet = {
  readonly file: string;
  readonly line: number;
  readonly mode: SnippetMode;
  readonly code: string;
};
export type SnippetError = { readonly line: number; readonly message: string };

const FENCE = /^(`{3,}|~{3,})\s*(\S*)/;
const MARKER = /^\s*\/\/\s*check:\s*(\S+)\s*$/;

function modeOf(value: string): SnippetMode | null {
  return value === 'compile' || value === 'run' ? value : null;
}

/** C++ blocks whose first line is a `// check:` marker, plus markers that name no known mode. */
export function extractSnippets(
  file: string,
  text: string,
): { snippets: Snippet[]; errors: SnippetError[] } {
  const snippets: Snippet[] = [];
  const errors: SnippetError[] = [];
  let open: { fence: string; isCpp: boolean; line: number; body: string[] } | null = null;

  splitLines(text).forEach((content, index) => {
    const match = FENCE.exec(content);
    if (open === null) {
      if (match?.[1])
        open = { fence: match[1], isCpp: match[2] === 'cpp', line: index + 2, body: [] };
      return;
    }
    const closes =
      match?.[1]?.[0] === open.fence[0] && (match?.[1]?.length ?? 0) >= open.fence.length;
    if (!closes || match?.[2]) {
      open.body.push(content);
      return;
    }
    const marker = open.isCpp ? MARKER.exec(open.body[0] ?? '')?.[1] : undefined;
    if (marker !== undefined) {
      const mode = modeOf(marker);
      if (mode) snippets.push({ file, line: open.line, mode, code: `${open.body.join('\n')}\n` });
      else errors.push({ line: open.line, message: `unknown marker "check: ${marker}"` });
    }
    open = null;
  });
  return { snippets, errors };
}
