import { expect, test } from 'bun:test';
import { ScriptError } from './script-error';
import { latestTag, nextTag, parseBump } from './version';

test('latest is numeric, not alphabetical, and ignores other tags', () => {
  expect(latestTag(['v0.9.0', 'v0.10.0', 'nightly', 'v1.0.0-rc.1'])).toBe('v0.10.0');
  expect(latestTag(['nightly'])).toBeNull();
});

test('bumps reset the lower parts', () => {
  expect(nextTag(['v1.2.3'], 'patch')).toBe('v1.2.4');
  expect(nextTag(['v1.2.3'], 'minor')).toBe('v1.3.0');
  expect(nextTag(['v1.2.3'], 'major')).toBe('v2.0.0');
});

test('the first release is v0.1.0', () => {
  expect(nextTag([], 'patch')).toBe('v0.1.0');
});

test('an unknown bump is a coded error', () => {
  expect(() => parseBump('huge')).toThrow(ScriptError);
  expect(() => parseBump(undefined)).toThrow(ScriptError);
});
