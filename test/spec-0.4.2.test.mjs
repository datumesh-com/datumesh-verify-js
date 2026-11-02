// What spec-0.4.2 changes for a verifier library (SPEC 14 spec-0.4.2: pins in URIs, references and
// requests and their echo; trust `computed` and the request's `mesh`; slice pages (5.6); batches
// (5.7); the `versions` endpoint; E_SLICE_AT_CELL and E_NAME_UNBOUND; `fn_hash` reserved), through
// the public API. The vectors run in test/conformance.test.mjs; these tests pin the result shapes,
// and compare the library with the reference tool on test/fixtures/oracle-probes-0.4.2.jsonl.gz
// (tools/oracle-diff/probes_0_4_2.py, canon.py as a black box) where SPEC.md leaves a case open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as lib from '../dist/esm/index.js';
import { makeRunner } from '../tools/vector-runner.mjs';
import { root, vector } from './helpers.mjs';

const { checkEnvelope, checkSlicePage, checkBatch, parseUri, formatUri, canonicalize, cellHash, resolveMesh, keysFromResponse, ERROR_CODES, DatumeshError } = lib;
const keysOf = (v) => Object.entries(v.keys).map(([h, e]) => keysFromResponse(h, e.https.status, e.https.body));
const codeOf = (f) => {
  try {
    f();
    return 'OK';
  } catch (e) {
    if (e instanceof DatumeshError) return e.code;
    throw e;
  }
};
const PIN = '7b58ecb8fd23b644c87951d0bd609790ff547cbb23fed27186c669ce2ce0aa80';

test('ERROR_CODES: E_SLICE_AT_CELL and E_NAME_UNBOUND after E_MESH_DOC, last (SPEC 10.2)', () => {
  assert.deepEqual(ERROR_CODES.slice(-3), ['E_MESH_DOC', 'E_SLICE_AT_CELL', 'E_NAME_UNBOUND']);
  assert.equal(ERROR_CODES.length, 48);
});

test('the library agrees with the reference tool on every spec-0.4.2 probe', async () => {
  const lines = gunzipSync(readFileSync(join(root, 'test', 'fixtures', 'oracle-probes-0.4.2.jsonl.gz'))).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.length >= 120, `${lines.length} probes`);
  const run = makeRunner(lib, (b) => createHash('sha256').update(b).digest('hex'));
  const diffs = [];
  for (const { vector: v, oracle } of lines) {
    const got = (await run(v)).error ?? 'success';
    if (got !== oracle) diffs.push(`${v.id}: reference ${oracle}, library ${got}`);
  }
  assert.deepEqual(diffs, []);
});

test('2.4, 4.3, 5.1-5.4: fn_hash is reserved; a reference and a URI carry the pin before asof', () => {
  const v = vector('uri/pinned-asof');
  const ref = parseUri(v.input, v.signature);
  assert.equal(ref.fn_hash, PIN);
  assert.equal(formatUri(ref), v.input);
  const { asof, ...noAsof } = ref;
  assert.equal(cellHash(noAsof), cellHash(JSON.parse(vector('ref/pinned').input)));
  assert.equal(formatUri(noAsof), v.input.replace(/&asof=.*$/, ''));
  assert.equal(codeOf(() => formatUri({ ...ref, fn_hash: PIN.toUpperCase() })), 'E_CANON_HEX');
  assert.equal(codeOf(() => canonicalize({ args: { fn_hash: { type: 'string', value: 'x' } }, fn: 'f', ns: 'a.example.org' }, 'ref')), 'E_CANON_ARG_NAME');
  const d = JSON.parse(vector('function/stored-fx-rate').input);
  assert.equal(codeOf(() => lib.functionHash({ ...d, signature: { ...d.signature, args: { ...d.signature.args, fn_hash: { type: 'string', valid: false } } } })), 'E_CANON_ARG_NAME');
});

test('5.5: the fn_hash echo, trust computed against mesh, the new codes; EnvelopeResult.fnHash', () => {
  const p = vector('envelope/ok-pinned');
  const r = checkEnvelope(p.status, p.input, keysOf(p), p.request);
  assert.deepEqual([r.ok, r.code, r.fnHash, r.trust], [true, 'OK', PIN, 'primary']);
  const c = vector('envelope/ok-computed-mesh');
  const rc = checkEnvelope(c.status, c.input, keysOf(c), c.request);
  assert.deepEqual([rc.ok, rc.trust, rc.fnHash], [true, 'computed', null]);
  assert.equal(checkEnvelope(c.status, c.input, keysOf(c), { ...c.request, mesh: 'other.example.net' }).code, 'E_ENVELOPE');
  const { mesh, ...noMesh } = c.request;
  assert.equal(checkEnvelope(c.status, c.input, keysOf(c), noMesh).code, 'OK');
  const u = vector('envelope/not-covered-name-unbound');
  assert.deepEqual([checkEnvelope(404, u.input, [], u.request).code, checkEnvelope(500, '{"outcome":"error","error":"E_NAME_UNBOUND"}', [], u.request).code], ['OK', 'E_ENVELOPE']);
  // A request description of the wrong shape is the caller's error. The pin and the host asked
  // are compared as given (the reference tool does not reject them; DEFECTS.md 52): a malformed
  // pin is never echoed, and a malformed mesh never names the signer.
  for (const m of ['Mesh.example', 'calc.example.net:443', '']) assert.equal(checkEnvelope(c.status, c.input, keysOf(c), { ...c.request, mesh: m }).code, 'E_ENVELOPE', m);
  assert.equal(checkEnvelope(p.status, p.input, keysOf(p), { ...p.request, fn_hash: PIN.toUpperCase() }).code, 'E_ENVELOPE');
  for (const bad of [{ fn_hash: 5 }, { mesh: 5 }, { slice_id: PIN }, { x: 1 }]) {
    assert.throws(() => checkEnvelope(404, u.input, [], { ...u.request, ...bad }), TypeError, JSON.stringify(bad));
  }
});

test('5.6 checkSlicePage: per-member results; refusals as envelopes; malformed request descriptions throw', () => {
  const v = vector('envelope/slice-page');
  const r = checkSlicePage(v.status, v.input, keysOf(v), v.request);
  assert.deepEqual([r.ok, r.code, r.outcome], [true, 'OK', 'ok']);
  assert.deepEqual(r.page.members.map((m) => ({ outcome: m.outcome, receipt_hash: m.receiptHash, trust: m.trust })), v.results);
  assert.equal(r.page.next, JSON.parse(v.input).next);
  assert.equal(r.page.slice.fn, 'fx_rate');
  const nc = vector('envelope/slice-not-covered');
  const x = checkSlicePage(nc.status, nc.input, [], nc.request);
  assert.deepEqual([x.ok, x.outcome, x.page], [true, 'not_covered', null]);
  for (const bad of [{ slice_id: 'x' }, { after: 5 }, { after: { quote: 'GBP' } }, { cell_id: PIN }, { job: 'a'.repeat(32) }]) {
    assert.throws(() => checkSlicePage(v.status, v.input, keysOf(v), { ...v.request, ...bad }), TypeError, JSON.stringify(bad));
  }
});

test('5.6 at a468606: a cursor is compared on the open arguments only; a missing one or another key type is E_ENVELOPE', () => {
  const v = vector('envelope/slice-after');
  const ks = keysOf(v);
  const at = (after) => checkSlicePage(v.status, v.input, ks, { ...v.request, after }).code;
  const q = v.request.after.quote;
  assert.equal(at({ ...v.request.after, zz: { type: 'date', value: '2024-01-01' } }), 'OK');
  assert.equal(at({ base: { type: 'string', value: 'EUR' } }), 'E_ENVELOPE');
  assert.equal(at({}), 'E_ENVELOPE');
  for (const t of [{ type: 'number', value: '1' }, { type: 'date', value: '2024-01-01' }, { type: 'boolean', value: true }]) assert.equal(at({ quote: t }), 'E_ENVELOPE', JSON.stringify(t));
  assert.equal(at({ quote: q }), 'OK');
});

test('5.7 checkBatch: whole-batch checks, then items in place; a refusal is one envelope', () => {
  const v = vector('batch/item-failures');
  const r = checkBatch(v.status, v.input, keysOf(v), v.requests);
  assert.deepEqual([r.ok, r.code, r.outcome], [true, 'OK', null]);
  assert.deepEqual(r.items.map((i) => (i.ok ? i.outcome : i.code)), v.results.map((x) => x.outcome ?? x.error));
  const f = vector('batch/refused');
  const rf = checkBatch(f.status, f.input, keysOf(f), f.requests);
  assert.deepEqual([rf.ok, rf.outcome, rf.items], [true, 'rate_limited', null]);
  const s = vector('invalid/batch-short');
  const rs = checkBatch(s.status, s.input, keysOf(s), s.requests);
  assert.deepEqual([rs.ok, rs.code, rs.items], [false, 'E_ENVELOPE', null]);
  assert.throws(() => checkBatch(200, '[]', [], 'x'), TypeError);
  assert.throws(() => checkBatch(200, '[]', [], [{ cell_id: 'x' }]), TypeError);
});

test('9.6: versions is an optional known endpoint with exactly {cell}', () => {
  const v = vector('mesh/versions');
  const r = resolveMesh(v.host, { keys: { status: 200, body: v.env.keys.https.body }, mesh: { status: 200, body: v.env.mesh.https.body } });
  assert.equal(r.ok, true);
  assert.equal(r.endpoints.versions, v.endpoints.versions);
  assert.ok(lib.MESH_ENDPOINTS.versions && !lib.MESH_ENDPOINTS.versions.required);
});
