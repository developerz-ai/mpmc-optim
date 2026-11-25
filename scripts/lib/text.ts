import { readFileSync } from 'node:fs';

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** The file as text, or null when its bytes are not UTF-8. Read errors still throw. */
export function readUtf8(path: string): string | null {
  const bytes = readFileSync(path);
  try {
    return UTF8.decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}
