import { ScriptError } from './script-error';

export const BUMPS = ['patch', 'minor', 'major'] as const;
export type Bump = (typeof BUMPS)[number];
type Version = readonly [major: number, minor: number, patch: number];

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseTag(tag: string): Version | null {
  const match = TAG.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function parseBump(value: string | undefined): Bump {
  const bump = BUMPS.find((name) => name === value);
  if (bump) return bump;
  throw new ScriptError(
    'MPMC_RELEASE_USAGE',
    `expected one of ${BUMPS.join(', ')}, got ${value ?? 'nothing'}`,
    'bun scripts/release.ts patch --dry-run',
  );
}

/** The highest release among the tags. Tags that are not vX.Y.Z are ignored. */
export function latestTag(tags: readonly string[]): string | null {
  const versions = tags.map(parseTag).filter((version) => version !== null);
  versions.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  return versions[0] ? `v${versions[0].join('.')}` : null;
}

/** The next tag. With no release yet, every bump starts at v0.1.0. */
export function nextTag(tags: readonly string[], bump: Bump): string {
  const current = parseTag(latestTag(tags) ?? '');
  if (!current) return 'v0.1.0';
  const [major, minor, patch] = current;
  if (bump === 'major') return `v${major + 1}.0.0`;
  if (bump === 'minor') return `v${major}.${minor + 1}.0`;
  return `v${major}.${minor}.${patch + 1}`;
}
