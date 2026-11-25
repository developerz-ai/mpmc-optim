import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import type { Finding } from './report';
import { ScriptError } from './script-error';
import type { Snippet } from './snippets';

const FLAGS = ['-std=c++23', '-O2', '-Wall', '-Wextra', '-Werror', '-pthread'];
/** -latomic: GCC calls into libatomic for 16-byte atomics. */
const LIBS = ['-latomic'];
const COMPILE_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 60_000;

type Outcome = { readonly ok: boolean; readonly detail: string };

async function exec(command: string[], timeout: number): Promise<Outcome> {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe', timeout });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (child.signalCode) return { ok: false, detail: `killed by ${child.signalCode}` };
  return { ok: code === 0, detail: code === 0 ? '' : `exit ${code}: ${(err || out).trim()}` };
}

/** The compilers to use: MPMC_CXX (space separated) or both defaults. A missing one is an error. */
export function requireCompilers(configured = process.env.MPMC_CXX): string[] {
  const names = (configured?.trim() || 'clang++ g++').split(/\s+/);
  const missing = names.filter((name) => Bun.which(name) === null);
  if (missing.length) {
    throw new ScriptError(
      'MPMC_COMPILER_MISSING',
      `not found: ${missing.join(', ')}`,
      'install it, or set MPMC_CXX to the compilers you have',
    );
  }
  return names;
}

async function checkOne(snippet: Snippet, compiler: string, base: string): Promise<Finding | null> {
  const fail = (code: string, detail: string): Finding => {
    const { file, line } = snippet;
    return { file, line, code, message: `${compiler}: ${detail}` };
  };
  const source = `${base}.cpp`;
  await Bun.write(source, snippet.code);
  const compile =
    snippet.mode === 'compile'
      ? [compiler, ...FLAGS, '-fsyntax-only', source]
      : [compiler, ...FLAGS, source, '-o', base, ...LIBS];
  const built = await exec(compile, COMPILE_TIMEOUT_MS);
  if (!built.ok) return fail('snippet-compile', built.detail);
  if (snippet.mode === 'compile') return null;
  const ran = await exec([base], RUN_TIMEOUT_MS);
  return ran.ok ? null : fail('snippet-run', ran.detail);
}

/** Checks each snippet with each compiler, half the cores at a time. */
export async function checkSnippets(
  snippets: readonly Snippet[],
  compilers: readonly string[],
  workDir: string,
): Promise<Finding[]> {
  const jobs = snippets.flatMap((snippet, s) =>
    compilers.map((compiler, c) => ({ snippet, compiler, base: join(workDir, `s${s}-${c}`) })),
  );
  const findings: Finding[] = [];
  let next = 0;
  const worker = async () => {
    for (let job = jobs[next++]; job; job = jobs[next++]) {
      const finding = await checkOne(job.snippet, job.compiler, job.base);
      if (finding) findings.push(finding);
    }
  };
  const workers = Math.max(1, Math.floor(availableParallelism() / 2));
  await Promise.all(Array.from({ length: workers }, worker));
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
