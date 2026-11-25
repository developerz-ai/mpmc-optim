import { extname, relative, resolve } from 'node:path';
import { projectFiles } from '../git';
import { proseLines } from '../markdown';
import type { Finding } from '../report';
import { readUtf8 } from '../text';
import { checkIndexes, checkLinks, checkSecrets, checkTables } from './rules';

const INDEXED_FOLDERS = ['docs/idea'];

/** Runs every docs rule over the project and returns all findings. */
export function checkDocs(rootPath: string): Finding[] {
  const root = resolve(rootPath);
  const findings = checkIndexes(root, INDEXED_FOLDERS);
  for (const path of projectFiles(root)) {
    const text = readUtf8(path);
    if (text === null) continue;
    const file = relative(root, path);
    findings.push(...checkSecrets(file, text));
    if (extname(path) !== '.md') continue;
    const { lines, unclosedAt } = proseLines(text);
    if (unclosedAt !== null) {
      findings.push({
        file,
        line: unclosedAt,
        code: 'unclosed-fence',
        message: 'code fence never closes',
      });
    }
    const markdown = { root, path, lines };
    findings.push(...checkLinks(markdown), ...checkTables(markdown));
  }
  return findings;
}
