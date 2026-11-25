import { expect, test } from 'bun:test';
import { anchors, githubSlug, localLinks, proseLines, tableCellCount } from './markdown';

test('slug matches GitHub', () => {
  expect(githubSlug('🔥 Profilers: which one?')).toBe('-profilers-which-one');
  expect(githubSlug('⚙️ 4. Core runtime')).toBe('-4-core-runtime');
  expect(githubSlug('`ag` and [links](x.md)')).toBe('ag-and-links');
});

test('repeated headings get numbered anchors', () => {
  expect([...anchors('# Rules\n## Rules\n')]).toEqual(['rules', 'rules-1']);
});

test('headings inside code are not anchors', () => {
  expect(anchors('```md\n# Nope\n```\n').size).toBe(0);
});

test('a longer fence is not closed by a shorter one', () => {
  expect(proseLines('````\n```\n````\nafter').lines.map((line) => line.text)).toEqual(['after']);
});

test('local links skip URLs and inline code', () => {
  expect(localLinks('[a](b.md) [c](https://x.dev) `[d](e.md)`')).toEqual(['b.md']);
});

test('table cells count unescaped pipes only', () => {
  expect(tableCellCount('| a | b |')).toBe(2);
  expect(tableCellCount('| a\\|b | c |')).toBe(2);
  expect(tableCellCount('a | b | c')).toBe(3);
});
