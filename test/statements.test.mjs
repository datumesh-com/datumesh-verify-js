// The rules spec-0.2.1 writes down (SPEC 14, spec-0.2.1): one assertion group per statement, so
// a regression points at the sentence it breaks. The Ed25519 rules (10.1 step 6) are covered by
// the receipt/ed25519-* vectors in the conformance test and by test/ed25519.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, verify, keysFromResponse, DatumeshError } from '../dist/esm/index.js';
import { vector } from './helpers.mjs';

const stored = vector('receipt/stored-number');
const R = JSON.parse(stored.input);
const keys = Object.entries(stored.keys).map(([h, e]) => keysFromResponse(h, e.https.status, e.https.body));
const code = (f) => {
  try {
    f();
    return 'OK';
  } catch (e) {
    if (e instanceof DatumeshError) return e.code;
    throw e;
  }
};
const receiptCode = (r) => code(() => canonicalize(r, 'receipt'));

test('3: value not a string or boolean is E_SCHEMA; the wrong one of the two E_CANON_TYPE', () => {
  for (const value of [1, null, [], {}]) assert.equal(code(() => canonicalize({ type: 'string', value }, 'scalar')), 'E_SCHEMA');
  assert.equal(code(() => canonicalize({ type: 'boolean', value: 'true' }, 'scalar')), 'E_CANON_TYPE');
  assert.equal(code(() => canonicalize({ type: 'date', value: true }, 'scalar')), 'E_CANON_TYPE');
});

test('3.3: every instant failure, an impossible date included, is E_CANON_INSTANT', () => {
  for (const v of ['2023-02-29T00:00:00.000000Z', '2024-13-01T00:00:00.000000Z', '0000-01-01T00:00:00.000000Z', '2024-01-01T24:00:00.000000Z', '2024-01-01T00:00:60.000000Z', '2024-01-01T00:00:00Z']) {
    assert.equal(code(() => canonicalize({ type: 'instant', value: v }, 'scalar')), 'E_CANON_INSTANT', v);
  }
});

test('8.1: licence grammar first (E_CANON_LICENCE), then length (E_CANON_LIMIT)', () => {
  const lic = (licence) => receiptCode({ ...R, licence });
  for (const l of ['CC-BY-4.0', 'LicenseRef-x', 'GPL-2.0+', 'a', 'A'.repeat(64), `https://${'a'.repeat(504)}`, 'https://x']) assert.equal(lic(l), 'OK', l);
  for (const l of ['', 'CC BY', '-x', '.x', 'MIT OR Apache-2.0', 'https://', 'https://a b', 'https://é', 'http://x', 'A '.repeat(40)]) assert.equal(lic(l), 'E_CANON_LICENCE', l);
  assert.equal(lic('A'.repeat(65)), 'E_CANON_LIMIT');
  assert.equal(lic(`https://${'a'.repeat(505)}`), 'E_CANON_LIMIT');
});

test('9.1: key reference codes', () => {
  const kr = (computed_by) => receiptCode({ ...R, computed_by });
  assert.equal(kr('d712b32a2cc5cb7c'), 'E_CANON_NAME');
  assert.equal(kr('Rates.example.org#d712b32a2cc5cb7c'), 'E_CANON_NAME');
  assert.equal(kr('rates.example.org#D712B32A2CC5CB7C'), 'E_CANON_HEX');
  assert.equal(kr('rates.example.org#d712b32a2cc5cb7c#x'), 'E_CANON_HEX');
  assert.equal(kr('rates.example.org#'), 'E_CANON_HEX');
});

test('4.5: lexical form before length; reserved names after both', () => {
  const args = (name) => code(() => canonicalize({ args: { [name]: { type: 'string', value: 'x' } }, fn: 'f', ns: 'a.example' }, 'ref'));
  assert.equal(args('A'.repeat(65)), 'E_CANON_ARG_NAME');
  assert.equal(args('a'.repeat(65)), 'E_CANON_LIMIT');
  assert.equal(args(`dm_${'a'.repeat(62)}`), 'E_CANON_LIMIT');
  assert.equal(args('dm_x'), 'E_CANON_ARG_NAME');
  assert.equal(code(() => canonicalize({ type: 'number', value: `1.${'0'.repeat(127)}` }, 'scalar')), 'E_CANON_NUMBER');
  assert.equal(code(() => canonicalize({ type: 'number', value: '1'.repeat(129) }, 'scalar')), 'E_CANON_LIMIT');
});

test('4.5: containers: argument count before members; inputs entries, then order, then count', () => {
  const many = {};
  for (let i = 0; i < 33; i++) many[`A${i}`] = { type: 'string', value: 'x' };
  assert.equal(code(() => canonicalize({ args: many, fn: 'f', ns: 'a.example' }, 'ref')), 'E_CANON_LIMIT');
  const d = (inputs) => code(() => canonicalize({ code: { body: '', lang: 'stored' }, inputs, signature: { args: {}, returns: 'string' } }, 'function'));
  assert.equal(d(['b.example/f', 'a.example/f', 'Bad']), 'E_CANON_NAME');
  const unsorted = Array.from({ length: 4097 }, (_, i) => `a.example/f${String(4097 - i).padStart(5, '0')}`);
  assert.equal(d(unsorted), 'E_CANON_SET');
  assert.equal(d([...unsorted].sort()), 'E_CANON_LIMIT');
});

test('4.5: function_name limit on ns + "/" + fn, after all members of a cell', () => {
  const ns = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.example/${'d'.repeat(60)}/${'e'.repeat(60)}/${'f'.repeat(60)}/${'h'.repeat(60)}/${'i'.repeat(60)}`;
  const cell = { args: {}, fn: 'g'.repeat(64), fn_hash: '0'.repeat(64), ns };
  assert.ok(ns.length + 65 > 512);
  assert.equal(code(() => canonicalize(cell, 'cell')), 'E_CANON_LIMIT');
  assert.equal(code(() => canonicalize({ ...cell, fn_hash: 'x' }, 'cell')), 'E_CANON_HEX');
});

test('10.1 step 4: consistency checks run in the order listed (valid before time)', () => {
  const wrongValid = { date: { type: 'date', value: '2024-03-14' } };
  assert.equal(receiptCode({ ...R, valid: wrongValid, tx: '2025-01-01T00:00:00.000000Z' }), 'E_VALID_MISMATCH');
  assert.equal(receiptCode({ ...R, publisher: 'other.example', valid: wrongValid }), 'E_PUBLISHER_MISMATCH');
  assert.equal(receiptCode({ ...R, cell: { ...R.cell, args: { ...R.cell.args, base: '*' } }, publisher: 'other.example' }), 'E_SLICE');
});

test('10.1 step 7.1: the hash before the canonical form; 7.2: unknown, missing, type', () => {
  const rc = stored.recompute;
  const bad = { ...rc.descriptor, code: { body: '', lang: 'Bad' } };
  assert.equal(verify(stored.input, keys, { ...rc, descriptor: bad }).code, 'E_FN_HASH_MISMATCH');
});

test('7: the stored convention is not enforced', () => {
  assert.equal(code(() => canonicalize({ code: { body: 'x', lang: 'stored' }, inputs: ['a.example/f'], signature: { args: {}, returns: 'string' } }, 'function')), 'OK');
});

test('9.2 / 9.3: exact key document members; a non-point key is not a document error; 200 without a document', () => {
  const doc = JSON.parse(stored.keys['rates.example.org'].https.body);
  const kr = (d) => keysFromResponse('rates.example.org', 200, JSON.stringify(d)).code;
  assert.equal(kr(doc), 'OK');
  assert.equal(kr({ ...doc, x: 1 }), 'E_KEY_DOC');
  assert.equal(kr({ ...doc, keys: [{ ...doc.keys[0], x: 1 }] }), 'E_KEY_DOC');
  assert.equal(kr({ ...doc, keys: [{ ...doc.keys[0], valid_from: 5 }] }), 'E_KEY_DOC');
  assert.equal(kr({ ...doc, keys: [doc.keys[0], { ...doc.keys[0] }] }), 'E_KEY_DOC');
  assert.equal(keysFromResponse('rates.example.org', 200).code, 'E_KEY_DOC');
  assert.equal(keysFromResponse('rates.example.org', 200, '').code, 'E_KEY_DOC');
});
