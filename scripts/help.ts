#!/usr/bin/env bun
/** List every repo script and what it does. Supports --json. */
import { scriptCatalog } from './lib/catalog';
import { runScript } from './lib/report';

await runScript((argv) => {
  const entries = scriptCatalog(import.meta.dir);
  if (argv.includes('--json')) {
    console.log(JSON.stringify(entries, null, 2));
  } else {
    const width = Math.max(...entries.map((entry) => entry.command.length));
    for (const { command, summary } of entries) console.log(`${command.padEnd(width)}  ${summary}`);
  }
  return 0;
});
