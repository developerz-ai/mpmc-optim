#!/usr/bin/env bun
/** Cut a release: check main is clean, synced and green, then push the next vX.Y.Z tag. Takes patch, minor or major. Supports --dry-run. */
import { REPO_ROOT } from './lib/paths';
import { runScript } from './lib/report';
import { run } from './lib/run';
import { ScriptError } from './lib/script-error';
import { nextTag, parseBump } from './lib/version';

const exec = (...command: string[]) => run(command, { cwd: REPO_ROOT }).trim();

function requireReady(): string {
  const refuse = (message: string, fix: string): never => {
    throw new ScriptError('MPMC_RELEASE_NOT_READY', message, fix);
  };
  if (exec('git', 'branch', '--show-current') !== 'main') {
    refuse('releases are cut from main', 'git checkout main');
  }
  if (exec('git', 'status', '--porcelain') !== '') {
    refuse('the working tree has changes', 'commit them first');
  }
  exec('git', 'fetch', '--tags', 'origin', 'main');
  const head = exec('git', 'rev-parse', 'HEAD');
  if (head !== exec('git', 'rev-parse', 'origin/main')) {
    refuse('main and origin/main differ', 'git pull --ff-only, or push');
  }
  const ci = exec(
    ...['gh', 'run', 'list', '--workflow', 'ci.yml', '--commit', head, '--limit', '1'],
    ...['--json', 'conclusion', '--jq', '.[0].conclusion // "missing"'],
  );
  if (ci !== 'success')
    refuse(`CI on ${head.slice(0, 9)} is ${ci || 'pending'}`, 'wait for green CI');
  return head;
}

await runScript((argv) => {
  const bump = parseBump(argv.find((arg) => !arg.startsWith('--')));
  const head = requireReady();
  const tag = nextTag(exec('git', 'tag', '--list').split('\n'), bump);
  if (argv.includes('--dry-run')) {
    console.log(`would tag ${head.slice(0, 9)} as ${tag}`);
    return 0;
  }
  exec('git', 'tag', '--annotate', tag, '--message', tag, head);
  exec('git', 'push', 'origin', tag);
  console.log(`pushed ${tag}. release.yml reruns the gate and publishes it: gh run watch`);
  return 0;
});
