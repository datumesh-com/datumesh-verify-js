#!/usr/bin/env node
// Runs tools/run-vectors.mjs over every file in spec/vectors/ and compares its output with the
// files: valid vectors must match every output field, invalid ones must give exactly `error`.
// Prints a per-kind summary; exits non-zero on any mismatch.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare } from './vector-runner.mjs';

export { compare };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'spec', 'vectors');

export function loadVectors() {
  const vs = [];
  for (const g of readdirSync(dir).sort()) for (const f of readdirSync(join(dir, g)).sort()) vs.push(JSON.parse(readFileSync(join(dir, g, f), 'utf8')));
  return vs;
}

export function runAll(env = {}) {
  const vs = loadVectors();
  const stdout = execFileSync(process.execPath, [join(root, 'tools', 'run-vectors.mjs')], { input: vs.map((v) => JSON.stringify(v)).join('\n') + '\n', maxBuffer: 1 << 28, env: { ...process.env, ...env } }).toString();
  const lines = stdout.trim().split('\n').map((l) => JSON.parse(l));
  if (lines.length !== vs.length) throw new Error(`runner produced ${lines.length} lines for ${vs.length} vectors`);
  return vs.map((v, i) => ({ v, got: lines[i], problems: compare(v, lines[i]) }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = runAll({ DATUMESH_BUILD: process.argv[2] === 'cjs' ? 'cjs' : 'esm' });
  const summary = {};
  let bad = 0;
  for (const { v, problems } of results) {
    const key = `${v.kind} ${v.valid ? 'valid' : 'invalid'}`;
    summary[key] ??= { pass: 0, fail: 0 };
    if (problems.length) {
      bad++;
      summary[key].fail++;
      console.log(`FAIL ${v.id}: ${problems.join('; ')}`);
    } else summary[key].pass++;
  }
  for (const k of Object.keys(summary).sort()) console.log(`${k.padEnd(18)} pass ${summary[k].pass} fail ${summary[k].fail}`);
  console.log(`${results.length - bad}/${results.length} vectors pass`);
  process.exit(bad ? 1 : 0);
}
