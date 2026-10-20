// Test 2: for every valid receipt vector, every single-bit flip of the canonical receipt bytes
// fails verification, and every single-bit flip of the raw 64-byte signature fails with
// E_SIGNATURE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, verify, keysFromResponse } from '../dist/esm/index.js';
import { loadVectors } from './helpers.mjs';

const receipts = loadVectors().filter((v) => v.kind === 'receipt' && v.valid);
const keysOf = (v) => Object.entries(v.keys).map(([h, e]) => keysFromResponse(h, typeof e.https.status === 'number' ? e.https.status : null, e.https.body));

let flips = 0;
let sigFlips = 0;
const codes = {};

for (const v of receipts) {
  test(`bit flips: ${v.id}`, () => {
    const keys = keysOf(v);
    const canonical = canonicalize(v.input, 'receipt');
    const base = verify(canonical, keys);
    assert.equal(base.ok, true, `unflipped canonical receipt must verify: ${base.code} ${base.detail}`);
    for (let i = 0; i < canonical.length * 8; i++) {
      const b = canonical.slice();
      b[i >> 3] ^= 1 << (i & 7);
      const r = verify(b, keys);
      assert.equal(r.ok, false, `flip of bit ${i} (byte ${i >> 3}) verified`);
      codes[r.code] = (codes[r.code] ?? 0) + 1;
      flips++;
    }
    const receipt = JSON.parse(v.input);
    const sig = Buffer.from(receipt.sig, 'hex');
    assert.equal(sig.length, 64);
    for (let i = 0; i < 512; i++) {
      const s = Buffer.from(sig);
      s[i >> 3] ^= 1 << (i & 7);
      const r = verify({ ...receipt, sig: s.toString('hex') }, keys);
      assert.equal(r.code, 'E_SIGNATURE', `signature bit ${i}: ${r.code}`);
      sigFlips++;
    }
  });
}

test('bit flip totals', () => {
  assert.equal(receipts.length, 10);
  assert.ok(flips > 50000, `ran ${flips} flips`);
  assert.equal(sigFlips, receipts.length * 512);
  console.log(`DIAG: canonical-byte flips: ${flips}; signature flips: ${sigFlips}; codes: ${JSON.stringify(codes)}`);
});
