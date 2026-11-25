import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { scriptCatalog } from './catalog';

test('lists every script with a summary and no test files', () => {
  const entries = scriptCatalog(join(import.meta.dir, '..'));
  expect(entries.map((entry) => entry.command)).toEqual([
    'bun scripts/check-docs.ts',
    'bun scripts/check-snippets.ts',
    'bun scripts/help.ts',
    'bun scripts/release.ts',
  ]);
  for (const entry of entries) expect(entry.summary).not.toBe('(no summary)');
});
