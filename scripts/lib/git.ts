import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './run';

/** Tracked and new files as absolute paths, honouring .gitignore. Symlinks are skipped. */
export function projectFiles(root: string): string[] {
  return run(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root })
    .split('\n')
    .filter(Boolean)
    .map((file) => join(root, file))
    .filter((file) => existsSync(file) && lstatSync(file).isFile())
    .sort();
}
