import { isAbsolute, join, relative } from 'node:path';

export const REPO_ROOT = join(import.meta.dir, '..', '..');

export function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
}
