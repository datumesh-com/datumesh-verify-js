// What spec-0.3.0 changes (SPEC 14, spec-0.3.0), one test per statement, through the public API.
// The vectors are also run by test/conformance.test.mjs; these tests pin the library's result
// shape (code, level, path, blobChecked) and the forms the vectors cannot express in JS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, verify, checkEnvelope, keysFromResponse, ERROR_CODES, DatumeshError } from '../dist/esm/index.js';
import { vector, utf8 } from './helpers.mjs';

const keysOf = (v) => Object.entries(v.keys).map(([h, e]) => keysFromResponse(h, e.https.status, e.https.body));
const hexToBytes = (h) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
const stored = vector('receipt/stored-number');
const keys = keysOf(stored);
const withoutValue = (rc) => {
  const { value, ...rest } = rc;
  return rest;
};

test('D17 revised (10.1 step 7.5): input asofs at or before the receipt asof; later is E_TIME_ORDER', () => {
  const earlier = vector('receipt/computed-inputs-earlier-asof');
  const r = verify(earlier.input, keysOf(earlier), earlier.recompute);
  assert.equal(r.code, 'OK');
  assert.equal(r.level, 'recomputed');
  const equal = vector('receipt/computed-input-equal-asof');
  assert.equal(verify(equal.input, keysOf(equal), equal.recompute).level, 'recomputed');
  const later = vector('invalid/receipt-input-later-asof');
  const bad = verify(later.input, keysOf(later), later.recompute);
  assert.equal(bad.code, 'E_TIME_ORDER');
  assert.equal(bad.path, '$.inputs');
  // tx must still be the latest input tx: the lineage vector keeps passing, and an altered tx
  // fails at the signature first, so the rule is covered by the existing vectors.
  const lineage = vector('receipt/computed-with-lineage');
  assert.equal(verify(lineage.input, keysOf(lineage), lineage.recompute).level, 'recomputed');
});

test('D31 revised (5.5 step 5): for ok as for stale, the receipt asof is at or before the requested asof', () => {
  const v = vector('envelope/served-ok');
  const ks = keysOf(v);
  const body = JSON.parse(v.input);
  const R = body.receipt;
  const at = (outcome, asof, extra = {}) => {
    const b = { ...body, outcome, ...extra };
    if (outcome === 'ok') delete b.age_seconds;
    const req = asof === undefined ? { cell_id: v.request.cell_id } : { cell_id: v.request.cell_id, asof };
    return checkEnvelope(200, JSON.stringify(b), ks, req);
  };
  for (const outcome of ['ok', 'stale']) {
    const extra = outcome === 'stale' ? { age_seconds: 60 } : {};
    assert.equal(at(outcome, R.asof, extra).code, 'OK', `${outcome} equal`);
    assert.equal(at(outcome, '9999-12-31T23:59:59.999999Z', extra).code, 'OK', `${outcome} later request`);
    assert.equal(at(outcome, undefined, extra).code, 'OK', `${outcome} no requested asof`);
    const r = at(outcome, '2000-01-01T00:00:00.000000Z', extra);
    assert.equal(r.code, 'E_ENVELOPE', `${outcome} earlier request`);
    assert.equal(r.path, '$.receipt.asof');
  }
  // Unchanged: age_seconds required for stale, not allowed for ok.
  assert.equal(at('stale', R.asof).code, 'E_ENVELOPE');
  assert.equal(at('ok', R.asof, { age_seconds: 1 }).code, 'E_ENVELOPE');
});

test('E_EVAL_UNAVAILABLE is in ERROR_CODES after E_VALUE_MISMATCH, before E_BLOB_MISMATCH', () => {
  const i = ERROR_CODES.indexOf('E_EVAL_UNAVAILABLE');
  assert.equal(ERROR_CODES[i - 1], 'E_VALUE_MISMATCH');
  assert.equal(ERROR_CODES[i + 1], 'E_BLOB_MISMATCH');
});

test('10.1 step 7.6: no evaluation is success at level signed with code E_EVAL_UNAVAILABLE at $.value', () => {
  const r = verify(stored.input, keys, withoutValue(stored.recompute));
  assert.deepEqual(
    { ok: r.ok, code: r.code, level: r.level, hash: r.hash, key: r.key, path: r.path, blobChecked: r.blobChecked },
    { ok: true, code: 'E_EVAL_UNAVAILABLE', level: 'signed', hash: stored.sha256, key: 'rates.example.org#d712b32a2cc5cb7c', path: '$.value', blobChecked: false },
  );
  assert.match(r.detail, /evaluat/);
  // value: undefined is the same as no value.
  assert.equal(verify(stored.input, keys, { ...stored.recompute, value: undefined }).code, 'E_EVAL_UNAVAILABLE');
  // With the value, as before: recomputed, code OK, no path.
  const full = verify(stored.input, keys, stored.recompute);
  assert.deepEqual([full.ok, full.code, full.level, full.path], [true, 'OK', 'recomputed', null]);
  // Without recompute at all: signed, OK (step 7 did not start, so nothing to report).
  const plain = verify(stored.input, keys);
  assert.deepEqual([plain.ok, plain.code, plain.level, plain.path], [true, 'OK', 'signed', null]);
  for (const id of ['receipt/eval-unavailable-stored', 'receipt/eval-unavailable-computed']) {
    const v = vector(id);
    const res = verify(v.input, keysOf(v), v.recompute);
    assert.deepEqual([res.ok, res.code, res.level, res.path], [true, 'E_EVAL_UNAVAILABLE', 'signed', '$.value'], id);
  }
});

test('10.1 step 7.6: E_EVAL_UNAVAILABLE only after 7.1-7.5 pass; a failure there is reported instead', () => {
  const rc = withoutValue(stored.recompute);
  assert.equal(verify(stored.input, keys, { inputs: {} }).code, 'E_FN_UNAVAILABLE');
  assert.equal(verify(stored.input, keys, { ...rc, descriptor: { ...rc.descriptor, inputs: ['x.example/y'] } }).code, 'E_FN_HASH_MISMATCH');
  for (const id of ['invalid/receipt-eval-unavailable-fn-unavailable', 'invalid/receipt-eval-unavailable-input-unavailable', 'invalid/receipt-eval-unavailable-input-later-asof']) {
    const v = vector(id);
    const res = verify(v.input, keysOf(v), v.recompute);
    assert.deepEqual([res.ok, res.code, res.level], [false, v.error, null], id);
  }
  // Steps 1-6 come first.
  const R = JSON.parse(stored.input);
  assert.equal(verify({ ...R, value: '2' }, keys, rc).code, 'E_SIGNATURE');
});

test('10.1 step 7.7 after E_EVAL_UNAVAILABLE: pass keeps the code, failure replaces it', () => {
  const v = vector('receipt/eval-unavailable-blob-checked');
  const ks = keysOf(v);
  const content = hexToBytes(v.blob_hex);
  const ok = verify(v.input, ks, v.recompute, content);
  assert.deepEqual([ok.ok, ok.code, ok.level, ok.path, ok.blobChecked], [true, 'E_EVAL_UNAVAILABLE', 'signed', '$.value', true]);
  const bad = content.slice();
  bad[0] ^= 1;
  const r = verify(v.input, ks, v.recompute, bad);
  assert.deepEqual([r.ok, r.code, r.level, r.blobChecked], [false, 'E_BLOB_MISMATCH', null, false]);
  const m = vector('invalid/receipt-eval-unavailable-blob-mismatch');
  assert.equal(verify(m.input, keysOf(m), m.recompute, hexToBytes(m.blob_hex)).code, 'E_BLOB_MISMATCH');
  // Content for a non-blob value is still E_SCHEMA, after the evaluation check.
  assert.equal(verify(stored.input, keys, withoutValue(stored.recompute), new Uint8Array(1)).code, 'E_SCHEMA');
});

test('5.5: an error envelope may carry E_EVAL_UNAVAILABLE; bad_request may not', () => {
  const v = vector('envelope/error-eval-unavailable');
  assert.equal(checkEnvelope(v.status, v.input, [], v.request).code, 'OK');
  assert.equal(checkEnvelope(400, '{"outcome":"bad_request","error":"E_EVAL_UNAVAILABLE"}', [], v.request).code, 'E_ENVELOPE');
});

test('D35 (10.1 step 7.1): null or any non-descriptor value fails the hash check; only absence is unavailable', () => {
  const rc = stored.recompute;
  const code = (descriptor) => verify(stored.input, keys, { ...rc, descriptor }).code;
  assert.equal(code(undefined), 'E_FN_UNAVAILABLE');
  assert.equal(verify(stored.input, keys, { inputs: rc.inputs, value: rc.value }).code, 'E_FN_UNAVAILABLE');
  for (const d of [null, 'null', '"x"', JSON.stringify(JSON.stringify(rc.descriptor)), '5', '[]', '{}', {}, [], utf8('null'), utf8(JSON.stringify(JSON.stringify(rc.descriptor)))]) {
    const r = verify(stored.input, keys, { ...rc, descriptor: d });
    assert.equal(r.code, 'E_FN_HASH_MISMATCH', JSON.stringify(d));
    assert.equal(r.path, '$.cell.fn_hash');
  }
  // Text and bytes are parsed strictly first, reporting a parse failure with its code.
  assert.equal(code('{"a":1,"a":1}'), 'E_PARSE_DUPLICATE_KEY');
  assert.equal(code(''), 'E_PARSE_JSON');
  assert.equal(code(utf8('{')), 'E_PARSE_JSON');
  // The descriptor itself, as a value, text or bytes: recomputed.
  for (const d of [rc.descriptor, JSON.stringify(rc.descriptor), utf8(JSON.stringify(rc.descriptor))]) assert.equal(verify(stored.input, keys, { ...rc, descriptor: d }).level, 'recomputed');
  for (const id of ['invalid/receipt-descriptor-null', 'invalid/receipt-descriptor-text']) {
    const v = vector(id);
    assert.equal(verify(v.input, keysOf(v), { ...v.recompute, descriptor: JSON.stringify(v.recompute.descriptor) }).code, 'E_FN_HASH_MISMATCH', id);
  }
  assert.equal(verify(stored.input, keys, { ...withoutValue(rc), descriptor: null }).code, 'E_FN_HASH_MISMATCH');
});

test('9.3 (DEF-16(b)): only the integer 200 is a retrieved key document', () => {
  const body = stored.keys['rates.example.org'].https.body;
  assert.equal(keysFromResponse('rates.example.org', 200, body).ok, true);
  for (const status of ['200', undefined, null, 200.5, '', 'error', [200], { status: 200 }, true, NaN, 0, 404, 301]) {
    const r = keysFromResponse('rates.example.org', status, body);
    assert.equal(r.code, 'E_KEY_UNAVAILABLE', String(status));
    assert.equal(verify(stored.input, r).code, 'E_KEY_UNAVAILABLE', String(status));
  }
  assert.equal(keysFromResponse('rates.example.org', 200n, body).code, 'E_KEY_UNAVAILABLE');
});

test('3.7 (note 32): the 128-character limit is on the whole media type; no per-name limit', () => {
  const H = '9dc30a40021f1f79d8dd9437ec9014ce134138326b72fcb9696485ab3d69330a';
  const blob = (mt) => {
    try {
      canonicalize({ type: 'blob', value: `${H}:17:${mt}` }, 'scalar');
      return 'OK';
    } catch (e) {
      if (e instanceof DatumeshError) return e.code;
      throw e;
    }
  };
  assert.equal(blob(`a/${'x'.repeat(126)}`), 'OK');
  assert.equal(blob(`${'x'.repeat(126)}/a`), 'OK');
  assert.equal(blob(`a/${'x'.repeat(127)}`), 'E_CANON_BLOB');
  assert.equal(blob(`${'x'.repeat(127)}/a`), 'E_CANON_BLOB');
  assert.equal(blob(`${'x'.repeat(63)}/${'y'.repeat(64)}`), 'OK');
  assert.equal(blob(`${'x'.repeat(64)}/${'y'.repeat(64)}`), 'E_CANON_BLOB');
});
