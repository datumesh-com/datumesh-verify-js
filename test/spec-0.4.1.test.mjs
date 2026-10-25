// What spec-0.4.1 changes for a verifier library (SPEC 14 spec-0.4.1: the `pending` outcome and job
// binding, E_JOB_UNKNOWN, the mesh document and cross-mesh resolution with E_MESH_DOC), through the
// public API. The vectors run in test/conformance.test.mjs; these tests pin the result shapes and
// compare the library with the reference tool on test/fixtures/oracle-probes-0.4.1.jsonl.gz
// (tools/oracle-diff/probes_0_4_1.py, canon.py as a black box) where SPEC.md leaves a case open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as lib from '../dist/esm/index.js';
import { makeRunner } from '../tools/vector-runner.mjs';
import { root, vector, utf8 } from './helpers.mjs';

const { checkEnvelope, resolveMesh, verify, keysFromResponse, ERROR_CODES } = lib;

test('ERROR_CODES: E_JOB_UNKNOWN and E_MESH_DOC after E_ENVELOPE, last (SPEC 10.2)', () => {
  assert.deepEqual(ERROR_CODES.slice(-3), ['E_ENVELOPE', 'E_JOB_UNKNOWN', 'E_MESH_DOC']);
});

test('the library agrees with the reference tool on every spec-0.4.1 probe', async () => {
  const lines = gunzipSync(readFileSync(join(root, 'test', 'fixtures', 'oracle-probes-0.4.1.jsonl.gz'))).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.length >= 100, `${lines.length} probes`);
  const run = makeRunner(lib, (b) => createHash('sha256').update(b).digest('hex'));
  const diffs = [];
  for (const { vector: v, oracle } of lines) {
    const got = (await run(v)).error ?? 'success';
    if (got !== oracle) diffs.push(`${v.id}: reference ${oracle}, library ${got}`);
  }
  assert.deepEqual(diffs, []);
});

test('5.5 pending: the result exposes job, poll and estimate; no receipt, no trust', () => {
  const v = vector('envelope/pending');
  const r = checkEnvelope(v.status, v.input, [], v.request);
  const b = JSON.parse(v.input);
  assert.deepEqual([r.ok, r.code, r.outcome, r.trust, r.receiptHash, r.fault, r.path], [true, 'OK', 'pending', null, null, null, null]);
  assert.deepEqual(r.pending, { job: b.job, poll: b.poll, estimateSeconds: b.estimate_seconds });
  // Bytes work; another status is E_ENVELOPE.
  assert.equal(checkEnvelope(202, utf8(v.input), [], v.request).code, 'OK');
  assert.equal(checkEnvelope(200, v.input, [], v.request).code, 'E_ENVELOPE');
  // Polled: the job given must be the envelope's.
  assert.equal(checkEnvelope(202, v.input, [], { ...v.request, job: b.job }).code, 'OK');
  const other = checkEnvelope(202, v.input, [], { ...v.request, job: 'b'.repeat(32) });
  assert.deepEqual([other.code, other.pending], ['E_ENVELOPE', null]);
  // Other outcomes carry no pending member.
  const ok = vector('envelope/job-result-ok');
  assert.equal(checkEnvelope(ok.status, ok.input, Object.entries(ok.keys).map(([h, e]) => keysFromResponse(h, e.https.status, e.https.body)), ok.request).pending, null);
});

test('5.5 job binding: a job result binds to the original request; E_JOB_UNKNOWN only at a job URL', () => {
  const v = vector('envelope/job-unknown');
  assert.equal(checkEnvelope(400, v.input, [], v.request).code, 'OK');
  const { job, ...cellRequest } = v.request;
  assert.equal(checkEnvelope(400, v.input, [], cellRequest).code, 'E_ENVELOPE');
  assert.equal(checkEnvelope(500, '{"outcome":"error","error":"E_JOB_UNKNOWN"}', [], v.request).code, 'E_ENVELOPE');
  assert.equal(checkEnvelope(500, '{"outcome":"error","error":"E_MESH_DOC"}', [], cellRequest).code, 'OK');
  // A malformed job in the request description is the caller's error.
  for (const bad of ['B'.repeat(32), 'a'.repeat(31), 'a'.repeat(65), 5, null]) {
    assert.throws(() => checkEnvelope(400, v.input, [], { ...cellRequest, job: bad }), TypeError, String(bad));
  }
  assert.throws(() => checkEnvelope(400, v.input, [], { ...v.request, x: 1 }), TypeError);
});

test('9.6 resolveMesh: bindings and the known endpoints; failures with the order\'s codes; never throws', () => {
  const v = vector('mesh/extension-members');
  const res = (e) => ({ status: e.https.status, body: e.https.body });
  const r = resolveMesh(v.host, { keys: res(v.env.keys), mesh: res(v.env.mesh) });
  const doc = JSON.parse(v.env.mesh.https.body);
  assert.deepEqual([r.ok, r.code, r.host, r.path], [true, 'OK', 'mesh.example.org', null]);
  assert.equal(r.bindings, doc.bindings);
  assert.equal(r.endpoints.x_graphql, undefined);
  assert.deepEqual(Object.keys(r.endpoints).sort(), ['blob', 'cell', 'cells', 'descriptor', 'explain', 'find', 'jobs', 'manifest', 'receipt', 'slice', 'verify']);
  // The validated keys come along, as from keysFromResponse.
  assert.deepEqual(r.keys, keysFromResponse(v.host, 200, v.env.keys.https.body).keys);
  // Bytes work too.
  assert.equal(resolveMesh(v.host, { keys: { status: 200, body: utf8(v.env.keys.https.body) }, mesh: { status: 200, body: utf8(v.env.mesh.https.body) } }).code, 'OK');
  const fail = (keys, mesh) => {
    const x = resolveMesh(v.host, { keys, mesh });
    assert.deepEqual([x.ok, x.bindings, x.endpoints, x.keys], [false, null, null, null]);
    return x.code;
  };
  assert.equal(fail({ status: null }, { status: null }), 'E_KEY_UNAVAILABLE');
  assert.equal(fail({ status: '200', body: v.env.keys.https.body }, res(v.env.mesh)), 'E_KEY_UNAVAILABLE');
  assert.equal(fail(res(v.env.keys), { status: 404 }), 'E_MESH_DOC');
  assert.equal(fail(res(v.env.keys), { status: 200 }), 'E_MESH_DOC');
  assert.equal(fail(res(v.env.keys), undefined), 'E_MESH_DOC');
  assert.equal(fail(undefined, res(v.env.mesh)), 'E_KEY_UNAVAILABLE');
  assert.equal(fail({ status: 200, body: '{' }, res(v.env.mesh)), 'E_KEY_DOC');
  assert.equal(fail(res(v.env.keys), { status: 200, body: '[]' }), 'E_MESH_DOC');
  assert.throws(() => resolveMesh(v.host), TypeError);
  assert.throws(() => resolveMesh(5, { keys: {}, mesh: {} }), TypeError);
});

test('E_MESH_DOC and E_JOB_UNKNOWN are never verification results', () => {
  // A host with a key document and no mesh document still issues verifiable receipts.
  const s = vector('receipt/stored-number');
  const keys = Object.entries(s.keys).map(([h, e]) => keysFromResponse(h, e.https.status, e.https.body));
  assert.equal(verify(s.input, keys).code, 'OK');
});
