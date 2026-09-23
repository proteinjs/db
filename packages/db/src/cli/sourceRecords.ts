#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { SourceRecordsCli } from './SourceRecordsCli';

/** The `source-records` bin: the pull command on Node's own fetch and file system. */
const nodeFetch = (globalThis as any).fetch;
if (typeof nodeFetch !== 'function') {
  console.error('source-records needs a Node with a global fetch (Node 18 or later)');
  process.exit(1);
}

new SourceRecordsCli({
  fetch: (url, init) => nodeFetch(url, init),
  readFile: (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined),
  writeFile: (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  },
  env: process.env,
  log: (line) => console.log(line),
})
  .run(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
