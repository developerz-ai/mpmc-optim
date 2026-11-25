#!/usr/bin/env bun
/** Compile and run the marked C++ snippets in docs. Accepts markdown paths and --json. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { checkSnippets, requireCompilers } from './lib/compile';
import { projectFiles } from './lib/git';
import { REPO_ROOT } from './lib/paths';
import { type Finding, report, runScript } from './lib/report';
import { extractSnippets, type Snippet } from './lib/snippets';
import { readUtf8 } from './lib/text';

await runScript(async (argv) => {
  const named = argv.filter((arg) => !arg.startsWith('--')).map((arg) => resolve(arg));
  const files = named.length
    ? named
    : projectFiles(REPO_ROOT).filter((path) => path.endsWith('.md'));
  const findings: Finding[] = [];
  const snippets: Snippet[] = [];
  for (const path of files) {
    const file = relative(REPO_ROOT, path);
    const found = extractSnippets(file, readUtf8(path) ?? '');
    snippets.push(...found.snippets);
    for (const error of found.errors) findings.push({ file, code: 'snippet-marker', ...error });
  }
  const compilers = requireCompilers();
  const workDir = mkdtempSync(join(tmpdir(), 'mpmc-snippets-'));
  try {
    findings.push(...(await checkSnippets(snippets, compilers, workDir)));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  return report(`snippets (${snippets.length} x ${compilers.join(', ')})`, findings, argv);
});
