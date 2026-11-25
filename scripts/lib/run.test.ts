import { expect, test } from 'bun:test';
import { run } from './run';
import { ScriptError } from './script-error';

const cwd = import.meta.dir;

function codeOf(body: () => unknown): string {
  try {
    body();
  } catch (error) {
    if (error instanceof ScriptError) return error.code;
    throw error;
  }
  throw new Error('expected a ScriptError');
}

test('returns stdout', () => {
  expect(run(['bun', '-e', 'console.log("hi")'], { cwd }).trim()).toBe('hi');
});

test('a failing command is a coded error', () => {
  expect(codeOf(() => run(['bun', '-e', 'process.exit(3)'], { cwd }))).toBe('MPMC_COMMAND_FAILED');
});

test('a missing binary is a coded error', () => {
  expect(codeOf(() => run(['mpmc-no-such-binary'], { cwd }))).toBe('MPMC_SPAWN_FAILED');
});

test('a hung command is killed at its deadline', () => {
  const hang = ['bun', '-e', 'setInterval(() => {}, 1000)'];
  expect(codeOf(() => run(hang, { cwd, timeoutMs: 200 }))).toBe('MPMC_SPAWN_TIMED_OUT');
});
