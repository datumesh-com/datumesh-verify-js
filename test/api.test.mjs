// API behaviour: hashes, kind inference, error objects, verify never throwing on bad receipts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as esm from '../dist/esm/index.js';
import { root, vector, text } from './helpers.mjs';

const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
const { canonicalize, cellHash, receiptHash, functionHash, verify, keysFromResponse, DatumeshError, ERROR_CODES, SPEC_VERSION, keyId } = esm;
const stored = vector('receipt/stored-number');
const keys = Object.entries(stored.keys).map(([h, e]) => keysFromResponse(h, e.https.status, e.https.body));

test('SPEC_VERSION and package metadata', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(SPEC_VERSION, 'spec-0.2.1');
  assert.equal(esm.VERSION, '0.2.1');
  assert.equal(pkg.datumesh.spec, SPEC_VERSION);
  assert.equal(pkg.version, esm.VERSION);
  assert.equal(pkg.name, '@datumesh/verify');
  assert.equal(ERROR_CODES.length, 41);
  assert.ok(ERROR_CODES.includes('E_KEY_UNAVAILABLE'));
  for (const c of ['E_CANON_UNIT', 'E_CANON_BLOB', 'E_BLOB_MISMATCH', 'E_ENVELOPE']) assert.ok(ERROR_CODES.includes(c), c);
});

test('ESM and CommonJS builds export the same API', () => {
  assert.deepEqual(Object.keys(cjs).filter((k) => k !== '__esModule' && k !== 'default').sort(), Object.keys(esm).sort());
  assert.equal(cjs.verify(stored.input, keys).ok, true);
});

test('hashes', () => {
  assert.equal(receiptHash(stored.input), stored.sha256);
  assert.equal(receiptHash(JSON.parse(stored.input)), stored.sha256);
  assert.equal(receiptHash(new TextEncoder().encode(stored.input)), stored.sha256);
  const cell = vector('cell/fx-rate');
  assert.equal(cellHash(cell.input), cell.sha256);
  const fn = vector('function/stored-fx-rate');
  assert.equal(functionHash(fn.input), fn.sha256);
  assert.equal(JSON.parse(stored.input).cell.fn_hash, fn.sha256);
  assert.equal(keyId('843baeb22bfd0364fb1b7262b367fb3202e7886c69a070fecf8e343fedb1eabf'), 'd712b32a2cc5cb7c');
  assert.throws(() => cellHash(vector('invalid/cell-uppercase-namespace').input), (e) => e.code === 'E_CANON_NAME');
  assert.throws(() => receiptHash(vector('invalid/receipt-slice').input), (e) => e.code === 'E_SLICE');
});

test('canonicalize infers the kind when it is omitted', () => {
  for (const id of ['scalar/string-nfc', 'cell/fx-rate', 'ref/fx-rate-asof', 'function/computed-convert']) {
    const v = vector(id);
    assert.equal(text(canonicalize(v.input)), v.canonical, id);
  }
  assert.equal(text(canonicalize(stored.input)), text(canonicalize(stored.input, 'receipt')));
  assert.throws(() => canonicalize('{"x":1}'), (e) => e instanceof DatumeshError && e.code === 'E_SCHEMA');
  assert.throws(() => canonicalize('[1]'), (e) => e.code === 'E_SCHEMA');
  assert.throws(() => canonicalize('{}', 'nonsense'), TypeError);
});

test('DatumeshError carries code, path and detail', () => {
  try {
    canonicalize(vector('invalid/scalar-number-trailing-zero').input, 'scalar');
    assert.fail('no error');
  } catch (e) {
    assert.ok(e instanceof DatumeshError);
    assert.ok(e instanceof Error);
    assert.equal(e.code, 'E_CANON_NUMBER');
    assert.equal(e.path, '$.value');
    assert.equal(typeof e.detail, 'string');
    assert.equal(e.name, 'DatumeshError');
  }
});

test('VerifyResult shape', () => {
  const ok = verify(stored.input, keys);
  assert.deepEqual(Object.keys(ok).sort(), ['blobChecked', 'code', 'detail', 'hash', 'key', 'level', 'ok', 'path']);
  assert.deepEqual({ ok: ok.ok, code: ok.code, level: ok.level, hash: ok.hash, key: ok.key, path: ok.path, blobChecked: ok.blobChecked }, { ok: true, code: 'OK', level: 'signed', hash: stored.sha256, key: 'rates.example.org#d712b32a2cc5cb7c', path: null, blobChecked: false });
  const full = verify(stored.input, keys, stored.recompute);
  assert.equal(full.level, 'recomputed');
  const bad = verify(vector('invalid/receipt-tampered-value').input, keys);
  assert.deepEqual({ ok: bad.ok, code: bad.code, level: bad.level, key: bad.key, path: bad.path }, { ok: false, code: 'E_SIGNATURE', level: null, key: null, path: '$.sig' });
  assert.equal(typeof bad.hash, 'string');
  const unparsable = verify('{', keys);
  assert.equal(unparsable.hash, null);
  assert.equal(unparsable.code, 'E_PARSE_JSON');
});

test('verify never throws for invalid receipts', () => {
  const base = stored.input;
  let seed = 1;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  const inputs = [undefined, null, 0, true, [], {}, 'null', '[]', '"x"', new Uint8Array(), new Uint8Array([0xff]), { sig: 5 }, JSON.parse(base), Symbol.iterator, () => 1];
  for (let i = 0; i < 3000; i++) {
    const chars = [...base];
    const k = 1 + rand(4);
    for (let j = 0; j < k; j++) {
      const at = rand(chars.length);
      const op = rand(3);
      if (op === 0) chars.splice(at, 1);
      else if (op === 1) chars.splice(at, 0, String.fromCharCode(rand(0x80)));
      else chars[at] = String.fromCharCode(rand(0x3000));
    }
    inputs.push(chars.join(''));
  }
  for (const input of inputs) {
    const r = verify(input, keys, stored.recompute);
    assert.equal(typeof r.ok, 'boolean');
    if (r.ok) assert.equal(r.hash, stored.sha256);
    else assert.ok(ERROR_CODES.includes(r.code), r.code);
  }
});

test('recompute argument errors are programmer errors', () => {
  assert.throws(() => verify(stored.input, keys, 5), TypeError);
  assert.throws(() => verify(stored.input, keys, { descriptor: {} }), TypeError);
  assert.throws(() => verify(stored.input, keys, { value: { type: 'number', value: '1' }, inputs: [] }), TypeError);
});

test('recompute: descriptor as JSON text; input receipts as objects', () => {
  const v = vector('receipt/computed-with-lineage');
  const ks = Object.entries(v.keys).map(([h, e]) => keysFromResponse(h, e.https.status, e.https.body));
  const rc = { ...v.recompute, descriptor: JSON.stringify(v.recompute.descriptor) };
  assert.equal(verify(v.input, ks, rc).level, 'recomputed');
  const objInputs = Object.fromEntries(Object.entries(v.recompute.inputs).map(([h, t]) => [h, JSON.parse(t)]));
  assert.equal(verify(v.input, ks, { ...v.recompute, inputs: objInputs }).level, 'recomputed');
  const tampered = { ...v.recompute, descriptor: { ...v.recompute.descriptor, inputs: [] } };
  assert.equal(verify(v.input, ks, tampered).code, 'E_FN_HASH_MISMATCH');
});
