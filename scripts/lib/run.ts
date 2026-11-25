import { ScriptError } from './script-error';

export const DEFAULT_RUN_TIMEOUT_MS = 120_000;

export type RunOptions = { readonly cwd: string; readonly timeoutMs?: number };

/** The single subprocess boundary: bounded, captured, and failing with a coded error. */
export function run(command: readonly string[], options: RunOptions): string {
  const label = command.join(' ');
  const timeout = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync([...command], { cwd: options.cwd, timeout });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ScriptError('MPMC_SPAWN_FAILED', `${label}: ${reason}`, `install ${command[0]}`);
  }
  if (result.exitedDueToTimeout) {
    throw new ScriptError(
      'MPMC_SPAWN_TIMED_OUT',
      `${label} ran past ${timeout} ms`,
      'check for a hung process, or pass a longer timeoutMs',
    );
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr?.toString().trim() ?? '';
    throw new ScriptError(
      'MPMC_COMMAND_FAILED',
      `${label} exited ${result.exitCode}${detail ? `: ${detail}` : ''}`,
      `run \`${label}\` in ${options.cwd}`,
    );
  }
  return result.stdout?.toString() ?? '';
}
