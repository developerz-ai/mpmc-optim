#!/usr/bin/env bun
/** Check docs: links, anchors, indexes, tables, code fences and secrets. Supports --json. */
import { checkDocs } from './lib/docs/check';
import { REPO_ROOT } from './lib/paths';
import { report, runScript } from './lib/report';

await runScript((argv) => report('docs', checkDocs(REPO_ROOT), argv));
