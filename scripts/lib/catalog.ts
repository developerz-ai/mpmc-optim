import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ScriptEntry = { readonly command: string; readonly summary: string };

const SUMMARY = /\/\*\*\s*(.+?)\s*\*\//s;

/** Every top-level script with the summary from its first doc comment. */
export function scriptCatalog(scriptsDir: string): ScriptEntry[] {
  return readdirSync(scriptsDir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort()
    .map((name) => {
      const summary = SUMMARY.exec(readFileSync(join(scriptsDir, name), 'utf8'))?.[1];
      return { command: `bun scripts/${name}`, summary: summary ?? '(no summary)' };
    });
}
