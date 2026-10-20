// SPEC.md 10.1 step 6: strict Ed25519. Each case in test/fixtures/ed25519-cases.json carries
// libsodium's verdict (PyNaCl crypto_sign_open, see gen_ed25519_cases.py); this library must
// agree on every one. The cases also show where @noble/curves' verify() alone (zip215: false)
// is more permissive than the spec, which is why the library adds its own checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { verifyEd25519Strict } from '../dist/esm/ed25519.js';
import { root } from './helpers.mjs';

const cases = JSON.parse(readFileSync(join(root, 'test/fixtures/ed25519-cases.json'), 'utf8'));
const hex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

test('fixture covers the strictness rules', () => {
  const names = cases.map((c) => c.name);
  for (const n of ['honest', 's-plus-l', 'small-order-R-0', 'small-order-A-1', 'identity-A-forged', 'mixed-order-A-k-not-0-mod-8', 'mixed-order-A-k-0-mod-8', 'neg-zero-A-y1']) assert.ok(names.includes(n), n);
  assert.ok(names.some((n) => n.startsWith('noncanonical-A-')) && names.some((n) => n.startsWith('noncanonical-R-')));
});

for (const c of cases) {
  test(`${c.name}: ${c.libsodium ? 'accepted' : 'rejected'} (${c.why})`, () => {
    assert.equal(verifyEd25519Strict(hex(c.sig), hex(c.msg), hex(c.pub)), c.libsodium);
  });
}

test('where noble zip215:false alone would differ from libsodium', () => {
  const differ = [];
  for (const c of cases) {
    let noble;
    try {
      noble = ed25519.verify(hex(c.sig), hex(c.msg), hex(c.pub), { zip215: false });
    } catch {
      noble = false;
    }
    if (noble !== c.libsodium) differ.push(c.name);
  }
  // Small-order R (any of the 8, with S = k*a) and the cofactored equation with mixed-order A.
  assert.deepEqual(differ.sort(), ['mixed-order-A-k-not-0-mod-8', ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `small-order-R-${i}`)]);
  console.log(`DIAG: noble zip215:false accepts what the spec rejects in: ${differ.join(', ')}`);
});

test('length checks', () => {
  const c = cases.find((x) => x.name === 'honest');
  assert.equal(verifyEd25519Strict(hex(c.sig).subarray(0, 63), hex(c.msg), hex(c.pub)), false);
  assert.equal(verifyEd25519Strict(hex(c.sig), hex(c.msg), hex(c.pub).subarray(0, 31)), false);
});
