// Blobs (SPEC 3.7, 10.1 step 7.7). For the valid blob receipt vector: the unmodified content
// passes; every single-bit flip of the content, and removing or adding one byte, fails with
// E_BLOB_MISMATCH. Plus the blob lexical form and how verify takes content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, verify, keysFromResponse, parseUri, formatUri, DatumeshError, ERROR_CODES } from '../dist/esm/index.js';
import { vector, text } from './helpers.mjs';

const v = vector('receipt/blob-value');
const keys = Object.entries(v.keys).map(([h, e]) => keysFromResponse(h, typeof e.https.status === 'number' ? e.https.status : null, e.https.body));
const content = Uint8Array.from(Buffer.from(v.blob_hex, 'hex'));
const H = '9dc30a40021f1f79d8dd9437ec9014ce134138326b72fcb9696485ab3d69330a';

test('the blob vector: content of 46 bytes whose SHA-256 is the blob hash', () => {
  const value = JSON.parse(v.input).value;
  assert.match(value, /^[0-9a-f]{64}:46:text\/csv$/);
  assert.equal(content.length, 46);
});

test('unmodified content passes, at level signed (as Uint8Array, Buffer and ArrayBuffer)', () => {
  for (const blob of [content, Buffer.from(content), content.slice().buffer]) {
    const r = verify(v.input, keys, null, blob);
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.code, 'OK');
    assert.equal(r.level, 'signed');
    assert.equal(r.blobChecked, true);
    assert.equal(r.hash, v.sha256);
  }
  const plain = verify(v.input, keys);
  assert.equal(plain.ok, true, 'without content, step 7.7 does not run');
  assert.equal(plain.blobChecked, false);
  assert.equal(verify(v.input, keys, undefined, undefined).ok, true);
});

test('every single-bit flip of the content fails with E_BLOB_MISMATCH', () => {
  let n = 0;
  for (let i = 0; i < content.length * 8; i++) {
    const b = content.slice();
    b[i >> 3] ^= 1 << (i & 7);
    const r = verify(v.input, keys, null, b);
    assert.equal(r.code, 'E_BLOB_MISMATCH', `bit ${i}`);
    assert.equal(r.ok, false);
    assert.equal(r.level, null);
    assert.equal(r.blobChecked, false);
    assert.equal(r.hash, v.sha256);
    n++;
  }
  assert.equal(n, 368);
});

test('removing any one byte, or adding one byte anywhere, fails with E_BLOB_MISMATCH', () => {
  for (let i = 0; i < content.length; i++) {
    const shorter = new Uint8Array([...content.slice(0, i), ...content.slice(i + 1)]);
    assert.equal(verify(v.input, keys, null, shorter).code, 'E_BLOB_MISMATCH', `remove byte ${i}`);
  }
  for (let i = 0; i <= content.length; i++) {
    for (const x of [0x00, 0x0a, 0xff, content[i % content.length]]) {
      const longer = new Uint8Array([...content.slice(0, i), x, ...content.slice(i)]);
      assert.equal(verify(v.input, keys, null, longer).code, 'E_BLOB_MISMATCH', `add 0x${x.toString(16)} at ${i}`);
    }
  }
  assert.equal(verify(v.input, keys, null, new Uint8Array()).code, 'E_BLOB_MISMATCH');
});

test('the invalid blob vectors', () => {
  for (const id of ['invalid/receipt-blob-mismatch', 'invalid/receipt-blob-length-mismatch']) {
    const w = vector(id);
    assert.equal(verify(w.input, keys, null, Uint8Array.from(Buffer.from(w.blob_hex, 'hex'))).code, w.error, id);
    assert.equal(verify(w.input, keys).ok, true, `${id} is signature-valid without content`);
  }
});

test('step 7.7 runs after steps 1-6 and after step 7 when recomputing', () => {
  const bad = new Uint8Array([1]);
  const r = JSON.parse(v.input);
  assert.equal(verify({ ...r, sig: '0'.repeat(128) }, keys, null, bad).code, 'E_SIGNATURE');
  assert.equal(verify(v.input, [], null, bad).code, 'E_KEY_UNAVAILABLE');
  // With recompute: a recomputation failure comes first, then the content.
  const recompute = { value: { type: 'blob', value: r.value } };
  assert.equal(verify(v.input, keys, recompute, bad).code, 'E_FN_UNAVAILABLE');
});

test('content given for a receipt whose type is not blob is E_SCHEMA (step 7.7), after steps 1-6 and 7', () => {
  const s = vector('receipt/stored-number');
  const ks = Object.entries(s.keys).map(([h, e]) => keysFromResponse(h, e.https.status, e.https.body));
  for (const c of [new Uint8Array([1, 2, 3]), new Uint8Array()]) {
    const r = verify(s.input, ks, null, c);
    assert.equal(r.code, 'E_SCHEMA');
    assert.equal(r.blobChecked, false);
  }
  assert.equal(verify(s.input, ks, s.recompute, new Uint8Array([1])).code, 'E_SCHEMA');
  assert.equal(verify({ ...JSON.parse(s.input), sig: '0'.repeat(128) }, ks, null, new Uint8Array([1])).code, 'E_SIGNATURE');
  const w = vector('invalid/receipt-content-not-blob');
  assert.equal(verify(w.input, ks, w.recompute ?? null, Uint8Array.from(Buffer.from(w.blob_hex, 'hex'))).code, 'E_SCHEMA');
});

test('recomputation and the content check together: level recomputed, blobChecked true', () => {
  const w = vector('receipt/blob-value-recomputed');
  const ks = Object.entries(w.keys).map(([h, e]) => keysFromResponse(h, e.https.status, e.https.body));
  const r = verify(w.input, ks, w.recompute, content);
  assert.deepEqual([r.ok, r.level, r.blobChecked], [true, 'recomputed', true]);
  const flipped = content.slice();
  flipped[0] ^= 1;
  assert.equal(verify(w.input, ks, w.recompute, flipped).code, 'E_BLOB_MISMATCH');
  assert.deepEqual([verify(w.input, ks, w.recompute).level, verify(w.input, ks, w.recompute).blobChecked], ['recomputed', false]);
});

test('blob content of the wrong JavaScript type is a programmer error', () => {
  for (const b of ['abc', 5, {}, [1, 2], true]) assert.throws(() => verify(v.input, keys, null, b), TypeError, String(b));
});

test('ERROR_CODES has the blob codes', () => {
  assert.ok(ERROR_CODES.includes('E_CANON_BLOB'));
  assert.ok(ERROR_CODES.includes('E_BLOB_MISMATCH'));
});

const scalar = (value) => ({ type: 'blob', value });
const blobCode = (value) => {
  try {
    canonicalize(scalar(value), 'scalar');
    return 'OK';
  } catch (e) {
    if (e instanceof DatumeshError) return e.code;
    throw e;
  }
};

test('blob lexical form (SPEC 3.7)', () => {
  const ok = [`${H}:17:text/plain`, `${H}:0:application/octet-stream`, `${H}:9007199254740991:a/b`, `${H}:17:3gpp/x`, `${H}:17:a/b!#$&-^_.+`, `${H}:17:application/vnd.ms-excel`, `${H}:17:${'a'.repeat(126)}/b`, `${H}:17:a/${'b'.repeat(126)}`];
  const bad = [
    '', H, `${H}:17`, `${H}::text/plain`, `${H}:17:`, `${H}:017:text/plain`, `${H}:00:text/plain`, `${H}:-1:text/plain`, `${H}:+1:text/plain`, `${H}:1.0:text/plain`, `${H}:1e3:text/plain`,
    `${H}:9007199254740992:text/plain`, `${H}:10000000000000000:text/plain`, `${H}:99999999999999999999:text/plain`,
    `${H.toUpperCase()}:17:text/plain`, `${H.slice(1)}:17:text/plain`, `${H}a:17:text/plain`, `${'g'.repeat(64)}:17:text/plain`,
    `${H}:17:text`, `${H}:17:text/`, `${H}:17:/plain`, `${H}:17:text/plain/x`, `${H}:17:text/Plain`, `${H}:17:TEXT/plain`, `${H}:17:text/plain;charset=utf-8`,
    `${H}:17:text/plain charset`, `${H}:17:text/ plain`, `${H}:17:text/*`, `${H}:17:text/.plain`, `${H}:17:+text/plain`, `${H}:17:-a/b`, `${H}:17:text/pläin`, `${H}:17:text/plain\u0007`,
    `${H}:17:text/plain:x`, ` ${H}:17:text/plain`, `${H}:17:text/plain `, `${H}:17:${'a'.repeat(127)}/b`, `${H}:17:a/${'b'.repeat(127)}`,
  ];
  for (const s of ok) assert.equal(blobCode(s), 'OK', s);
  for (const s of bad) assert.equal(blobCode(s), 'E_CANON_BLOB', JSON.stringify(s));
  assert.equal(blobCode(true), 'E_CANON_TYPE');
  assert.equal(text(canonicalize(scalar(`${H}:17:text/plain`))), `{"type":"blob","value":"${H}:17:text/plain"}`);
});

test('blobs in cell URIs: ":" literal, "/" and "+" percent-encoded', () => {
  const sig = { args: { file: { type: 'blob', valid: false } }, returns: 'string' };
  const ref = { args: { file: { type: 'blob', value: `${H}:17:application/ld+json` } }, fn: 'describe', ns: 'files.example.org' };
  const uri = formatUri(ref);
  assert.equal(uri, `cell://files.example.org/describe?file=${H}:17:application%2Fld%2Bjson`);
  assert.deepEqual(parseUri(uri, sig), ref);
  assert.throws(() => parseUri(`cell://files.example.org/describe?file=${H}%3A17%3Aapplication%2Fld%2Bjson`, sig), (e) => e.code === 'E_CANON_PERCENT');
  assert.throws(() => parseUri(`cell://files.example.org/describe?file=${H}:17:application/ld%2Bjson`, sig), (e) => e.code === 'E_CANON_PERCENT');
  assert.throws(() => parseUri('cell://files.example.org/describe?file=x', sig), (e) => e.code === 'E_CANON_BLOB');
});

test('a blob cannot be a valid-time argument of a receipt (step 4)', () => {
  const r = JSON.parse(v.input);
  const file = { type: 'blob', value: `${H}:17:text/plain` };
  r.cell.args.file = file;
  r.valid.file = file;
  assert.throws(() => canonicalize(r, 'receipt'), (e) => e.code === 'E_VALID_MISMATCH');
});
