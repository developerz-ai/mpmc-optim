import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkDocs } from './check';

describe('checkDocs', () => {
  let root: string;

  beforeEach(() => {
    root = join(mkdtempSync(join(tmpdir(), 'check-docs-')), 'repo');
    mkdirSync(root);
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root });
  });

  afterEach(() => rmSync(dirname(root), { recursive: true, force: true }));

  const write = (name: string, content: string) => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const codes = () => checkDocs(root).map((finding) => finding.code);

  test('clean docs pass', () => {
    write('docs/idea/README.md', '[A](a.md#-hello-world)\n');
    write('docs/idea/a.md', '## 🧠 Hello, world\n\n| x | y |\n|---|---|\n| 1 | 2 |\n');
    expect(codes()).toEqual([]);
  });

  test('broken link', () => {
    write('a.md', '[x](missing.md)\n');
    expect(codes()).toEqual(['broken-link']);
  });

  test('link outside the repo is broken, even when the target exists', () => {
    writeFileSync(join(dirname(root), 'outside.md'), '# x\n');
    write('a.md', '[x](../outside.md)\n');
    expect(codes()).toEqual(['broken-link']);
  });

  test('broken anchor', () => {
    write('a.md', '# Title\n\n[x](#nope)\n');
    expect(codes()).toEqual(['broken-anchor']);
  });

  test('links in code are ignored', () => {
    write('a.md', '`[x](no.md)`\n\n```md\n[y](no.md)\n```\n');
    expect(codes()).toEqual([]);
  });

  test('unindexed doc', () => {
    write('docs/idea/README.md', '# Build\n');
    write('docs/idea/phase.md', '# Phase\n');
    expect(codes()).toEqual(['unindexed-doc']);
  });

  test('indexed folder with no README', () => {
    write('docs/idea/phase.md', '# Phase\n');
    expect(codes()).toEqual(['missing-index']);
  });

  test('table with the wrong cell count', () => {
    write('a.md', '| x | y |\n|---|---|\n| 1 | 2 | 3 |\n');
    expect(codes()).toEqual(['table-columns']);
  });

  test('unclosed fence', () => {
    write('a.md', '```cpp\nint x;\n');
    expect(codes()).toEqual(['unclosed-fence']);
  });

  test('a secret is reported without its value', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    write('notes.txt', `token=${token}\n`);
    const findings = checkDocs(root);
    expect(findings.map((finding) => finding.code)).toEqual(['secret']);
    expect(JSON.stringify(findings)).not.toContain(token);
  });

  test('binary files are skipped', () => {
    writeFileSync(join(root, 'image.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    expect(codes()).toEqual([]);
  });
});
