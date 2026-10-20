// Test 6: results do not depend on the runtime's Unicode version. Strings are checked against
// Unicode 15.1 tables shipped in src/unicode-data.ts (generated from the UCD by
// tools/gen-unicode.mjs); String.prototype.normalize and \p{...} are never used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { nfc, isNFC, isAssigned, codePoints } from '../dist/esm/unicode.js';
import { canonicalize, DatumeshError } from '../dist/esm/index.js';
import { makeRunner } from '../tools/vector-runner.mjs';
import * as lib from '../dist/esm/index.js';
import { root, loadVectors } from './helpers.mjs';

const cps = (s) => s.split(' ').map((h) => parseInt(h, 16));
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

test('NFC agrees with every line of NormalizationTest-15.1.0.txt', () => {
  const lines = gunzipSync(readFileSync(join(root, 'test/fixtures/NormalizationTest-15.1.0.txt.gz'))).toString('utf8').split('\n');
  assert.match(lines[0], /NormalizationTest-15\.1\.0\.txt/);
  let n = 0;
  let part = '';
  const part1 = new Set();
  for (const line of lines) {
    if (line.startsWith('@Part')) {
      part = line.trim();
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    const [c1, c2, c3, c4, c5] = line.split(';').slice(0, 5).map(cps);
    if (part.startsWith('@Part1')) part1.add(c1[0]);
    const s = (a) => String.fromCodePoint(...a);
    assert.ok(eq(nfc(c1), c2) && eq(nfc(c2), c2) && eq(nfc(c3), c2), `NFC c2: ${line}`);
    assert.ok(eq(nfc(c4), c4) && eq(nfc(c5), c4), `NFC c4: ${line}`);
    assert.equal(isNFC(s(c2)), true, line);
    assert.equal(isNFC(s(c1)), eq(c1, c2), line);
    n++;
  }
  assert.ok(n > 19000, `${n} lines`);
  // Part 1 rule: every code point not listed in Part 1 is its own NFC.
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) c = 0xe000;
    if (!part1.has(c)) assert.ok(eq(nfc([c]), [c]), `U+${c.toString(16)}`);
  }
});

test('assigned code points match spec/tools/unicode-15.1-assigned.txt exactly', () => {
  const want = new Uint8Array(0x110000);
  for (const line of readFileSync(join(root, 'spec/tools/unicode-15.1-assigned.txt'), 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [a, b] = line.split('..').map((h) => parseInt(h, 16));
    for (let c = a; c <= b; c++) want[c] = 1;
  }
  for (let c = 0; c <= 0x10ffff; c++) if (isAssigned(c) !== !!want[c]) assert.fail(`U+${c.toString(16)}`);
});

test('Unicode 15.1 repertoire, independent of the engine', () => {
  const scalar = (s) => canonicalize({ type: 'string', value: s }, 'scalar');
  // Added in Unicode 15.1 (Node 18 ships 15.0): accepted.
  for (const s of ['\u{2EBF0}', '\u{2EE5D}', '\u{2FFC}', '\u{2FFF}', '\u{31EF}']) assert.ok(scalar(s));
  // Added in 15.0 and 14.0: accepted.
  for (const s of ['\u{11F00}', '\u{1F6DC}', '\u{1E08F}', '\u{870}']) assert.ok(scalar(s));
  // Added in 16.0 (after the pin) and never assigned: rejected.
  for (const s of ['\u{1C89}', '\u{1F8B2}', '\u{378}', '\u{FFFF}', '\u{E0080}']) {
    assert.throws(() => scalar(s), (e) => e instanceof DatumeshError && e.code === 'E_CANON_STRING', s);
  }
  // NFC involving marks added after Unicode 13 (U+1E08F has ccc 230; U+1DFA has ccc 218):
  assert.equal(isNFC('a\u{1E08F}\u{301}'), true);
  assert.equal(isNFC('a\u{301}\u{1DFA}'), false); // ccc 230 before ccc 218: not canonically ordered
  assert.equal(isNFC('a\u{1DFA}\u{301}'), false); // composes to U+00E1 + U+1DFA
  assert.equal(isNFC('\u{E1}\u{1DFA}'), true);
  // U+1E08F (ccc 230, Unicode 15.0) before U+0323 (ccc 220) is not canonically ordered, so the
  // string is not NFC. An engine older than Unicode 15.0 (Node 18.0.0 ships 14.0) treats U+1E08F
  // as unassigned, i.e. ccc 0, and its String.prototype.normalize leaves the string unchanged:
  // relying on it would accept a string SPEC 3.5 rejects.
  const tricky = 'q\u{1E08F}\u0323';
  assert.equal(isNFC(tricky), false);
  assert.throws(() => scalar(tricky), (e) => e.code === 'E_CANON_STRING');
  assert.equal(isNFC('q\u0323\u{1E08F}'), true); // (a + U+0323 would compose to U+1EA1)
  const engine = {
    node: process.version,
    unicode: process.versions.unicode,
    icu: process.versions.icu,
    'engine thinks U+1E08F unassigned': /\p{Cn}/u.test('\u{1E08F}'),
    'engine thinks U+2EBF0 unassigned': /\p{Cn}/u.test('\u{2EBF0}'),
    'engine NFC would accept q+1E08F+0323': tricky.normalize('NFC') === tricky,
  };
  console.log(`DIAG: engine: ${JSON.stringify(engine)}`);
});

test('the library never calls String.prototype.normalize', async () => {
  const src = readdirSync(join(root, 'dist/esm')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(root, 'dist/esm', f), 'utf8').replace(/^\s*\/\/.*$/gm, '')).join('\n');
  assert.doesNotMatch(src, /\.normalize\s*\(/);
  assert.doesNotMatch(src, /\\p\{/);
  const saved = String.prototype.normalize;
  String.prototype.normalize = () => {
    throw new Error('String.prototype.normalize must not be used');
  };
  try {
    const run = makeRunner(lib, (b) => createHash('sha256').update(b).digest('hex'));
    for (const v of loadVectors()) {
      const got = await run(v);
      assert.equal(got.error, v.valid ? null : v.error, v.id);
    }
    assert.equal(isNFC('Zu\u{308}rich'), false);
  } finally {
    String.prototype.normalize = saved;
  }
});

test('codePoints keeps lone surrogates visible', () => {
  assert.deepEqual(codePoints('a\ud800b\u{1F600}'), [0x61, 0xd800, 0x62, 0x1f600]);
});
