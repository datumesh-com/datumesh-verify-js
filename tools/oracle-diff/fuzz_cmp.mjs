// Compares this library (dist/esm) with the reference tool's verdicts in /out/fuzz.jsonl.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const lib = await import('/w/dist/esm/index.js'); // the repo is mounted at /w
const { makeRunner } = await import('/w/tools/vector-runner.mjs');
const run = makeRunner(lib, (b) => createHash('sha256').update(b).digest('hex'));
const lines = readFileSync('/out/fuzz.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const diffs = {};
let same = 0, threw = 0;
for (const { vector: v, oracle } of lines) {
  let mine;
  // licence and entitlement probes (spec-0.4.3) carry the reference's result as JSON, not a code.
  const shape = (g) => g.error ?? (v.kind === 'licence' ? JSON.stringify({ licence: g.licence, reason: g.reason }) : v.kind === 'entitlement' ? JSON.stringify({ entitled: g.entitled, reason: g.reason }) : 'success');
  try { mine = shape(await run(v)); } catch (e) { mine = 'THREW ' + e; threw++; }
  const norm = (x) => (typeof x === 'string' && x.startsWith('{') ? JSON.stringify(JSON.parse(x)) : x); // the reference's JSON is spaced
  if (norm(mine) === norm(oracle)) { same++; continue; }
  const k = `${v.kind}: oracle ${oracle} / mine ${mine}`;
  (diffs[k] ??= []).push(v);
}
console.log(`${same}/${lines.length} agree; threw ${threw}`);
for (const [k, vs] of Object.entries(diffs).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n== ${vs.length}x ${k}`);
  for (const v of vs.slice(0, 2)) console.log('   ', JSON.stringify(v.kind === 'uri' ? v.input : v.kind === 'keys' ? v.env : v.input).slice(0, 600), v.recompute ? ' RECOMPUTE' : '');
}
