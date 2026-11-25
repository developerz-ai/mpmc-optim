import { expect, test } from 'bun:test';
import { extractSnippets } from './snippets';

const block = (body: string, info = 'cpp', fence = '```') => `${fence}${info}\n${body}\n${fence}\n`;

test('finds marked C++ blocks with their line and mode', () => {
  const text = `# T\n\n${block('// check: compile\nint x;')}${block('// check: run\nint main() {}')}`;
  const { snippets, errors } = extractSnippets('a.md', text);
  expect(snippets.map(({ line, mode }) => ({ line, mode }))).toEqual([
    { line: 4, mode: 'compile' },
    { line: 8, mode: 'run' },
  ]);
  expect(snippets[0]?.code).toBe('// check: compile\nint x;\n');
  expect(errors).toEqual([]);
});

test('ignores unmarked blocks, other languages and markers below the first line', () => {
  const text = block('int x;') + block('// check: run', 'c') + block('int x;\n// check: compile');
  expect(extractSnippets('a.md', text).snippets).toEqual([]);
});

test('a marked block quoted inside a longer fence is not a snippet', () => {
  const text = block(block('// check: run\nint main() {}'), 'md', '````');
  expect(extractSnippets('a.md', text).snippets).toEqual([]);
});

test('an unknown mode is an error, not a silent skip', () => {
  const { errors } = extractSnippets('a.md', block('// check: runn\nint x;'));
  expect(errors).toEqual([{ line: 2, message: 'unknown marker "check: runn"' }]);
});
