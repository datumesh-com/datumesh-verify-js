#!/usr/bin/env node
// Conformance runner (CONTRACT.md): reads one SPEC.md section 11 vector object per line on stdin
// and writes one JSON line per input: {"id", "error": <code or null>, ...outputs}, where the
// outputs are exactly the section 11 output fields for the vector's kind. Keys for `keys`
// vectors and receipt `keys` envs go through keysFromResponse; URIs map to mesh.example.
// Uses the ESM build (run `npm run build` first); DATUMESH_BUILD=cjs uses the CommonJS build.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { makeRunner } from './vector-runner.mjs';

const lib = process.env.DATUMESH_BUILD === 'cjs' ? createRequire(import.meta.url)('../dist/cjs/index.js') : await import('../dist/esm/index.js');
const run = makeRunner(lib, (b) => createHash('sha256').update(b).digest('hex'));
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  process.stdout.write(JSON.stringify(await run(JSON.parse(line))) + '\n');
}
