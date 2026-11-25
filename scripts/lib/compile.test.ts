import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSnippets, requireCompilers } from './compile';
import { ScriptError } from './script-error';
import type { SnippetMode } from './snippets';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snippets-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const codes = async (mode: SnippetMode, code: string) => {
  const snippet = { file: 'a.md', line: 3, mode, code };
  const findings = await checkSnippets([snippet], requireCompilers('g++'), dir);
  return findings.map((finding) => finding.code);
};

test('valid code passes in both modes', async () => {
  expect(await codes('compile', 'int f();')).toEqual([]);
  expect(await codes('run', 'int main() { return 0; }')).toEqual([]);
});

test('a type error is reported', async () => {
  expect(await codes('compile', 'int x = "no";')).toEqual(['snippet-compile']);
});

test('a warning is an error', async () => {
  expect(await codes('compile', 'int f() {}')).toEqual(['snippet-compile']);
});

test('a non-zero exit is reported', async () => {
  expect(await codes('run', 'int main() { return 3; }')).toEqual(['snippet-run']);
});

test('a missing compiler is a coded error', () => {
  expect(() => requireCompilers('mpmc-no-such-cxx')).toThrow(ScriptError);
});
