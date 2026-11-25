import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { anchors, isTableDivider, type Line, localLinks, tableCellCount } from '../markdown';
import { isInside } from '../paths';
import type { Finding } from '../report';
import { splitLines } from '../text';

export type MarkdownFile = {
  readonly root: string;
  readonly path: string;
  readonly lines: readonly Line[];
};

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bsk_live_[A-Za-z0-9]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

export function checkLinks({ root, path, lines }: MarkdownFile): Finding[] {
  const findings: Finding[] = [];
  const file = relative(root, path);
  for (const { number: line, text } of lines) {
    for (const target of localLinks(text)) {
      const [filePart = '', fragment] = target.split('#', 2);
      const resolved = filePart ? resolve(dirname(path), filePart) : path;
      if (!isInside(root, resolved) || !existsSync(resolved)) {
        findings.push({ file, line, code: 'broken-link', message: `${target} does not exist` });
      } else if (
        fragment &&
        extname(resolved) === '.md' &&
        !anchors(readFileSync(resolved, 'utf8')).has(fragment)
      ) {
        findings.push({
          file,
          line,
          code: 'broken-anchor',
          message: `${target} has no such heading`,
        });
      }
    }
  }
  return findings;
}

export function checkTables({ root, path, lines }: MarkdownFile): Finding[] {
  const findings: Finding[] = [];
  const file = relative(root, path);
  const byNumber = new Map(lines.map(({ number, text }) => [number, text]));
  for (const { number, text } of lines) {
    const header = byNumber.get(number - 1);
    if (!header?.includes('|') || !isTableDivider(text)) continue;
    const expected = tableCellCount(header);
    for (let line = number + 1; byNumber.get(line)?.includes('|'); line++) {
      if (tableCellCount(byNumber.get(line) ?? '') !== expected) {
        findings.push({ file, line, code: 'table-columns', message: `expected ${expected} cells` });
      }
    }
  }
  return findings;
}

export function checkIndexes(root: string, folders: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const folder of folders) {
    const directory = join(root, folder);
    if (!existsSync(directory)) continue;
    const index = join(directory, 'README.md');
    if (!existsSync(index)) {
      findings.push({
        file: folder,
        line: 1,
        code: 'missing-index',
        message: 'folder has no README.md',
      });
      continue;
    }
    const text = readFileSync(index, 'utf8');
    for (const name of readdirSync(directory).sort()) {
      if (name.endsWith('.md') && name !== 'README.md' && !text.includes(`(${name}`)) {
        findings.push({
          file: `${folder}/${name}`,
          line: 1,
          code: 'unindexed-doc',
          message: `add ${name} to ${folder}/README.md`,
        });
      }
    }
  }
  return findings;
}

/** Reports where a credential appears and never includes its value. */
export function checkSecrets(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  splitLines(text).forEach((content, index) => {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
      findings.push({
        file,
        line: index + 1,
        code: 'secret',
        message: 'possible credential, value not shown',
      });
    }
  });
  return findings;
}
