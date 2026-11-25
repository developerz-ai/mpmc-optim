import { ScriptError } from './script-error';

export type Finding = {
  readonly file: string;
  readonly line: number;
  readonly code: string;
  readonly message: string;
};

const wantsJson = (argv: readonly string[]) => argv.includes('--json');

/** Prints findings for humans or as JSON, and returns the process exit code. */
export function report(name: string, findings: readonly Finding[], argv: readonly string[]) {
  if (wantsJson(argv)) {
    console.log(JSON.stringify({ ok: findings.length === 0, errors: findings }, null, 2));
  } else {
    for (const f of findings) console.log(`${f.file}:${f.line}: ${f.code}: ${f.message}`);
    console.log(findings.length ? `${name}: ${findings.length} problem(s)` : `${name}: ok`);
  }
  return findings.length ? 1 : 0;
}

/** Runs a script body. A ScriptError prints its code and fix, and anything else stays a crash. */
export async function runScript(
  body: (argv: readonly string[]) => number | Promise<number>,
): Promise<never> {
  const argv = process.argv.slice(2);
  try {
    process.exit(await body(argv));
  } catch (error) {
    if (!(error instanceof ScriptError)) throw error;
    const { code, message, fix } = error;
    if (wantsJson(argv)) console.log(JSON.stringify({ ok: false, code, message, fix }, null, 2));
    else console.error(`${code}: ${message}\nfix: ${fix}`);
    process.exit(2);
  }
}
