// What spec-0.5.0 changes for a verifier library (CONTRACT-0.5.0-libs.md items 1-10; SPEC 14
// spec-0.5.0), through the public API. One block per contract item, in the contract's order. The
// vectors themselves run in test/conformance.test.mjs; here each item gets focused tests derived
// from the vectors and from the spec text, and the library is compared with the reference tool
// (spec/tools/canon.py, a black box) on test/fixtures/oracle-probes-0.5.0.jsonl.gz, produced by
// tools/oracle-diff/probes_0_5_0.py, where the vectors leave a case open.
//
// TEST-FIRST COMMIT: these tests fail until the features exist (IMPL-NOTES-0.5.0.md). The tests
// that name no new feature (the old suites, the version strings) pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ed25519 } from '@noble/curves/ed25519';
import * as lib from '../dist/esm/index.js';
import * as cjs from '../dist/cjs/index.js';
import { makeRunner, compare, OUTPUTS, SKIPPED_KINDS, hexToBytes, responseOf, recomputeOf } from '../tools/vector-runner.mjs';
import { root, vector, loadVectors, text } from './helpers.mjs';

const { ERROR_CODES, DatumeshError, checkEnvelope, checkSlicePage, resolveMesh, keysFromResponse, verify, canonicalize, functionHash, receiptPayload } = lib;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const run = makeRunner(lib, sha256);
const all = loadVectors();
const byId = Object.fromEntries(all.map((v) => [v.id, v]));
const keysOf = (v) => Object.entries(v.keys ?? {}).map(([h, e]) => keysFromResponse(h, typeof e.https.status === 'number' ? e.https.status : null, e.https.body));
const codeOf = (f) => {
  try {
    f();
    return 'OK';
  } catch (e) {
    if (e instanceof DatumeshError) return e.code;
    throw e;
  }
};
const T0 = '2024-03-16T09:00:00.000000Z';

/** Run vectors through the conformance runner and require every output to match. */
async function conforms(ids) {
  assert.ok(ids.length > 0);
  for (const id of ids) {
    assert.ok(byId[id], `no vector ${id}`);
    assert.deepEqual(compare(byId[id], await run(byId[id])), [], id);
  }
}
const idsWhere = (f) => all.filter(f).map((v) => v.id);

/** Probes: the reference tool's verdict for each (item, vector); `success` means accepted. */
const probes = gunzipSync(readFileSync(join(root, 'test', 'fixtures', 'oracle-probes-0.5.0.jsonl.gz'))).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
async function agreesOnProbes(item) {
  const mine = probes.filter((p) => p.vector.item === item);
  assert.ok(mine.length > 0);
  const diffs = [];
  for (const { vector: v, oracle } of mine) {
    const got = await run(v);
    const code = got.error ?? 'success';
    if (code !== oracle) diffs.push(`${v.id} [${v.kind}]: reference ${oracle}, library ${code}`);
  }
  assert.deepEqual(diffs.slice(0, 12), [], `${diffs.length} of ${mine.length} probes differ`);
  return mine.length;
}

// ------------------------------------------------------------------------------------------
// Versions (the package, both builds)
// ------------------------------------------------------------------------------------------

test('versions name spec-0.5.0 and 0.5.0', () => {
  assert.equal(lib.SPEC_VERSION, 'spec-0.5.0');
  assert.equal(lib.VERSION, '0.5.0');
  assert.equal(cjs.VERSION, '0.5.0');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.5.0');
  assert.equal(pkg.datumesh.spec, 'spec-0.5.0');
});

test('the spec submodule is spec-0.5.0 (7bed002) and the set has 1426 vectors', () => {
  assert.equal(all.length, 1426);
  assert.ok(readFileSync(join(root, 'spec', 'SPEC.md'), 'utf8').startsWith('# Datumesh protocol, version 1\n\nStatus: draft, revision `spec-0.5.0`'));
});

test('both builds export the new functions', () => {
  for (const m of [lib, cjs]) {
    for (const f of ['defineClass', 'classHash', 'checkKeyNormalisation', 'parseObjectKey', 'formatObjectKey', 'objectJson', 'objectId', 'shortId', 'checkDescribe', 'checkDefine']) assert.equal(typeof m[f], 'function', f);
    assert.deepEqual([...m.KEY_NORMALISATIONS], ['none', 'upper_ascii', 'nfc_strict', 'arabic_skeleton', 'hebrew_consonantal', 'greek_unaccented']);
  }
});

// ------------------------------------------------------------------------------------------
// Item 1: loopback URLs for unrooted hosts (9.6, 5.5, 5.6, 9.8, 2.5)
// ------------------------------------------------------------------------------------------

const loopbackMesh = (origin, host = 'local.invalid') => {
  const v = byId['mesh/unrooted-loopback-port'];
  const mesh = v.env.mesh.https.body.replaceAll('http://127.0.0.1:8471', origin);
  return resolveMesh(host, { keys: responseOf(v.env.keys), mesh: { status: 200, body: mesh } });
};

test('item 1: the loopback vectors (mesh documents, poll, next)', async () => {
  await conforms(idsWhere((v) => /loopback|describe-endpoint/.test(v.id)));
  assert.ok(idsWhere((v) => /loopback/.test(v.id)).length >= 14);
});

test('item 1: an unrooted host\'s mesh document may be on one loopback origin (9.6)', () => {
  const v = byId['mesh/unrooted-loopback-port'];
  const r = loopbackMesh('http://127.0.0.1:8471');
  assert.equal(r.ok, true);
  assert.equal(r.bindings, v.bindings);
  assert.deepEqual(r.endpoints, v.endpoints);
  // exactly 127.0.0.1, [::1] or localhost, an optional port of 1 to 65535 without leading zeros
  for (const origin of ['http://127.0.0.1', 'http://[::1]', 'http://[::1]:8080', 'http://localhost', 'http://localhost:1', 'http://localhost:65535']) {
    const x = loopbackMesh(origin);
    assert.equal(x.code, 'OK', origin);
    assert.equal(x.bindings, `${origin}/bindings`);
    assert.equal(Object.values(x.endpoints).every((u) => u.startsWith(`${origin}/`)), true, origin);
  }
  for (const origin of ['http://localhost:0', 'http://localhost:65536', 'http://localhost:08080', 'http://localhost:', 'http://LOCALHOST', 'http://127.0.0.2', 'http://127.1', 'http://0.0.0.0', 'http://[0:0:0:0:0:0:0:1]', 'http://localhost.', 'http://u@localhost',
    'https://127.0.0.1', 'https://localhost', 'http://192.168.1.20:8471', 'http://example.org']) {
    assert.equal(loopbackMesh(origin).code, 'E_MESH_DOC', origin);
  }
});

test('item 1: every URL of one mesh document has one origin, bindings included (9.6)', () => {
  const v = byId['mesh/unrooted-loopback-port'];
  const edit = (f) => {
    const d = JSON.parse(v.env.mesh.https.body);
    f(d);
    return resolveMesh('local.invalid', { keys: responseOf(v.env.keys), mesh: { status: 200, body: JSON.stringify(d) } }).code;
  };
  assert.equal(edit(() => {}), 'OK');
  assert.equal(edit((d) => (d.endpoints.cell = 'http://127.0.0.1:8472/cell/{cell}')), 'E_MESH_DOC'); // another port
  assert.equal(edit((d) => (d.endpoints.cell = 'http://localhost:8471/cell/{cell}')), 'E_MESH_DOC'); // another name
  assert.equal(edit((d) => (d.bindings = 'https://local.invalid/bindings')), 'E_MESH_DOC'); // https and loopback
  assert.equal(edit((d) => (d.bindings = 'http://127.0.0.1:8472/bindings')), 'E_MESH_DOC');
  assert.equal(edit((d) => (d.endpoints.cell = `http://127.0.0.1:8471/cell/${'a'.repeat(500)}/{cell}`)), 'E_MESH_DOC'); // more than 512 characters
  assert.equal(edit((d) => (d.endpoints.cell = 'http://127.0.0.1:8471/cell/ {cell}')), 'E_MESH_DOC'); // not printable ASCII
  // the unrooted host's own https URLs are as before
  const https = byId['mesh/describe-endpoint'].env.mesh.https.body.replaceAll('mesh.example.org', 'local.invalid');
  assert.equal(resolveMesh('local.invalid', { keys: responseOf(v.env.keys), mesh: { status: 200, body: https } }).code, 'OK');
});

test('item 1: a rooted host stays https only (9.6)', () => {
  const r = byId['invalid/mesh-rooted-http-loopback'];
  assert.equal(resolveMesh(r.host, { keys: responseOf(r.env.keys), mesh: responseOf(r.env.mesh) }).code, 'E_MESH_DOC');
  for (const origin of ['http://127.0.0.1:8471', 'http://localhost', 'http://[::1]:1']) {
    const mesh = byId['mesh/describe-endpoint'].env.mesh.https.body.replaceAll('https://mesh.example.org', origin);
    assert.equal(resolveMesh('mesh.example.org', { keys: responseOf(r.env.keys), mesh: { status: 200, body: mesh } }).code, 'E_MESH_DOC', origin);
  }
});

test('item 1: a loopback poll passes only for a request naming the unrooted mesh asked (5.5)', () => {
  const v = byId['envelope/pending-poll-loopback-unrooted'];
  const keys = keysOf(v);
  const ask = (body, req) => checkEnvelope(202, JSON.stringify(body), keys, req);
  const body = JSON.parse(v.input);
  assert.equal(v.request.mesh, 'local.invalid');
  assert.equal(ask(body, v.request).ok, true);
  assert.equal(ask(body, v.request).outcome, 'pending');
  const noMesh = { ...v.request };
  delete noMesh.mesh;
  assert.equal(ask(body, noMesh).code, 'E_ENVELOPE'); // no mesh named
  assert.equal(ask(body, { ...v.request, mesh: 'mesh.example.org' }).code, 'E_ENVELOPE'); // a rooted mesh
  assert.equal(ask(body, { ...v.request, mesh: 'my.invalid.example.org' }).code, 'E_ENVELOPE'); // rooted: its last label is org
  for (const poll of ['http://localhost/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01', 'http://[::1]:65535/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01', 'https://local.invalid/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01']) assert.equal(ask({ ...body, poll }, v.request).code, 'OK', poll);
  for (const poll of ['http://127.0.0.1:0/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01', 'http://LOCALHOST/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01', 'https://127.0.0.1/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01', 'http://local.invalid/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01',
    'http://192.168.1.20:8471/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01', 'http://127.0.0.1:8471/jobs/ffffffffffffffffffffffffffffffff', 'http://127.0.0.1:8471/cell/4f9c2a7e1b3d5f60817a9c2e4b6d8f01', 'http://localhost:8471/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01?x=1']) {
    assert.equal(ask({ ...body, poll }, v.request).code, 'E_ENVELOPE', poll);
  }
  // Without `mesh`, `poll` is accepted for any DNS name but no loopback URL (5.5).
  assert.equal(ask({ ...body, poll: 'https://other.example.org/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01' }, noMesh).code, 'OK');
});

test('item 1: a loopback next of a slice page passes only for the unrooted mesh asked (5.6, 9.8)', () => {
  const v = byId['envelope/slice-next-loopback-unrooted'];
  const keys = keysOf(v);
  const page = (body, req) => checkSlicePage(200, JSON.stringify(body), keys, req);
  const body = JSON.parse(v.input);
  assert.equal(page(body, v.request).ok, true);
  const noMesh = { ...v.request };
  delete noMesh.mesh;
  assert.equal(page(body, noMesh).code, 'E_ENVELOPE');
  assert.equal(page(body, { ...v.request, mesh: 'mesh.example.org' }).code, 'E_ENVELOPE');
  const tail = body.next.slice('http://localhost:8471'.length);
  assert.equal(page({ ...body, next: `http://[::1]${tail}` }, v.request).code, 'OK');
  assert.equal(page({ ...body, next: `https://local.invalid${tail}` }, v.request).code, 'OK');
  for (const next of [`http://127.0.0.1:99999${tail}`, `http://example.org${tail}`, `http://LOCALHOST${tail}`]) assert.equal(page({ ...body, next }, v.request).code, 'E_ENVELOPE', next);
});

test('item 1: probes agree with the reference tool (mesh documents, poll, next)', async () => {
  await agreesOnProbes(1);
});

// ------------------------------------------------------------------------------------------
// Item 2: codes (10.2)
// ------------------------------------------------------------------------------------------

test('item 2: ERROR_CODES gains fourteen codes after E_FOREIGN_UNAVAILABLE, in the order of 10.2', () => {
  assert.equal(ERROR_CODES.length, 63);
  const i = ERROR_CODES.indexOf('E_FOREIGN_UNAVAILABLE');
  assert.equal(i, 48);
  assert.deepEqual(ERROR_CODES.slice(i + 1), ['E_UNROOTED_INPUT', 'E_NAMESPACE_SUSPENDED', 'E_CLASS_MEMBER', 'E_CLASS_PARENT', 'E_CLASS_INHERIT', 'E_CLASS_OVERRIDE', 'E_CLASS_FINAL', 'E_CLASS_METHOD', 'E_CLASS_INTERFACE', 'E_CLASS_OWNER', 'E_KEY_NORMALISATION', 'E_KEY_ENCODING', 'E_SHORT_ID_AMBIGUOUS', 'E_DESCRIBE']);
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
  // The formula codes of 15.11 are not in 10.2: E_FORMULA_KEY and E_FORMULA_DISPATCH_KEY are faults, not codes.
  assert.equal(ERROR_CODES.some((c) => c.startsWith('E_FORMULA')), false);
});

test('item 2: every code of the table has a vector or a probe that raises it, and every vector\'s code is listed', () => {
  for (const v of all) if (!v.valid && v.error && /^E_(CLASS|KEY_N|KEY_E|DESCRIBE|UNROOTED|SHORT)/.test(v.error)) assert.ok(ERROR_CODES.includes(v.error), `${v.id}: ${v.error}`);
  const raised = new Set(all.filter((v) => !v.valid).map((v) => v.error));
  for (const c of ['E_UNROOTED_INPUT', 'E_CLASS_MEMBER', 'E_CLASS_PARENT', 'E_CLASS_INHERIT', 'E_CLASS_OVERRIDE', 'E_CLASS_FINAL', 'E_CLASS_METHOD', 'E_CLASS_INTERFACE', 'E_CLASS_OWNER', 'E_KEY_NORMALISATION', 'E_KEY_ENCODING', 'E_DESCRIBE']) assert.ok(raised.has(c), `no invalid vector with ${c}`);
  // E_NAMESPACE_SUSPENDED and E_SHORT_ID_AMBIGUOUS are envelope codes: a valid not_covered / bad_request vector carries each.
  assert.equal(byId['envelope/not-covered-namespace-suspended'].valid, true);
  assert.equal(byId['envelope/bad-request-short-id-ambiguous'].valid, true);
});

test('item 2: none of the new codes is a verification result (10.2)', async () => {
  // verify() reports a verification code or OK for every receipt vector; never a define, write, class, key-reader, describe or envelope code.
  const NOT_VERIFICATION = ERROR_CODES.slice(ERROR_CODES.indexOf('E_FOREIGN_UNAVAILABLE') + 1);
  for (const v of all.filter((x) => x.kind === 'receipt')) {
    const r = verify(v.input ?? Buffer.from(v.input_hex, 'hex'), Object.entries(v.keys ?? {}).map(([h, e]) => keysFromResponse(h, e.https.status === 'error' ? null : e.https.status, e.https.body)), null, null);
    assert.equal(NOT_VERIFICATION.includes(r.code), false, v.id);
  }
});

test('item 2: the faults E_FORMULA_KEY and E_FORMULA_DISPATCH_KEY are exported with the other faults (5.5, 15.11)', () => {
  assert.deepEqual([...lib.FAULTS].sort(), ['E_FORMULA_ABSENT', 'E_FORMULA_DIV_ZERO', 'E_FORMULA_DISPATCH_KEY', 'E_FORMULA_DOMAIN', 'E_FORMULA_EMPTY', 'E_FORMULA_FUTURE', 'E_FORMULA_KEY', 'E_FORMULA_RANGE']);
});

// ------------------------------------------------------------------------------------------
// Item 3: envelopes (5.5)
// ------------------------------------------------------------------------------------------

const envelopeVectors = idsWhere((v) => v.kind === 'envelope' && /spec-0\.5\.0/.test(v.description));
const check = (v, body, status = v.status, request = v.request) => checkEnvelope(status, typeof body === 'string' ? body : JSON.stringify(body), keysOf(v), request);

test('item 3: the new envelope vectors', async () => {
  assert.equal(envelopeVectors.length, 19);
  await conforms(envelopeVectors);
});

test('item 3: resolved and shadows are read, and a result exposes them (5.5, 16.7, 16.9)', () => {
  const lookup = byId['envelope/resolved-lookup'];
  const r = check(lookup, lookup.input);
  assert.equal(r.ok, true);
  assert.deepEqual(r.resolved, JSON.parse(lookup.input).resolved);
  assert.equal(r.resolved.resolutions[0].kind, 'lookup');
  assert.equal(r.resolved.resolutions[0].asof, '2026-06-01T00:00:00.000000Z');
  assert.equal(r.shadows, null);
  const short = byId['envelope/resolved-short-call'];
  assert.deepEqual(check(short, short.input).resolved, JSON.parse(short.input).resolved);
  assert.equal(check(short, short.input).resolved.aliases_tx, '2026-05-01T00:00:00.000000Z');
  const sh = byId['envelope/shadows-reference-class'];
  const s = check(sh, sh.input);
  assert.deepEqual(s.shadows, { class: 'rates.example.org/fx_pair', reference: 'ab'.repeat(32) });
  assert.equal(s.resolved, null);
  // A plain envelope has neither.
  const plain = byId['envelope/not-covered-fault'];
  const p = check(plain, plain.input);
  assert.equal(p.resolved, null);
  assert.equal(p.shadows, null);
});

test('item 3: the shape of resolved (exactly call, resolutions and optionally aliases_tx; resolutions exactly from, kind, to, and asof for lookup)', () => {
  const short = byId['envelope/resolved-short-call'];
  const lookup = byId['envelope/resolved-lookup'];
  const edit = (v, f) => {
    const b = JSON.parse(v.input);
    f(b.resolved);
    return check(v, b).code;
  };
  assert.equal(edit(short, () => {}), 'OK');
  assert.equal(edit(short, (r) => delete r.aliases_tx), 'OK');
  assert.equal(edit(short, (r) => (r.resolutions = [])), 'OK');
  for (const kind of ['alias', 'default', 'method', 'lookup']) {
    assert.equal(edit(short, (r) => (r.resolutions = [kind === 'lookup' ? { from: 'a', kind, to: 'b', asof: T0 } : { from: 'a', kind, to: 'b' }])), 'OK', kind);
  }
  assert.equal(edit(short, (r) => (r.call = '')), 'E_ENVELOPE');
  assert.equal(edit(short, (r) => (r.call = 5)), 'E_ENVELOPE');
  assert.equal(edit(short, (r) => delete r.call), 'E_ENVELOPE');
  assert.equal(edit(short, (r) => delete r.resolutions), 'E_ENVELOPE');
  assert.equal(edit(short, (r) => (r.resolutions = {})), 'E_ENVELOPE');
  assert.equal(edit(short, (r) => (r.aliases_tx = '2026-05-01')), 'E_ENVELOPE');
  assert.equal(edit(short, (r) => (r.note = 'x')), 'E_ENVELOPE');
  for (const kind of ['guess', 'label', 'Alias', '']) assert.equal(edit(short, (r) => (r.resolutions = [{ from: 'a', kind, to: 'b' }])), 'E_ENVELOPE', kind);
  assert.equal(edit(short, (r) => (r.resolutions = [{ from: 'a', kind: 'alias' }])), 'E_ENVELOPE'); // no to
  assert.equal(edit(short, (r) => (r.resolutions = [{ from: 'a', kind: 'alias', to: 'b', asof: T0 }])), 'E_ENVELOPE'); // asof only on lookup
  assert.equal(edit(short, (r) => (r.resolutions = [{ from: 1, kind: 'alias', to: 'b' }])), 'E_ENVELOPE');
  assert.equal(edit(lookup, () => {}), 'OK');
  assert.equal(edit(lookup, (r) => delete r.resolutions[0].asof), 'E_ENVELOPE'); // a lookup carries asof
  assert.equal(edit(lookup, (r) => (r.resolutions[0].asof = '2026-06-01')), 'E_ENVELOPE'); // an instant
  for (const bad of ['x', null, []]) {
    const b = JSON.parse(short.input);
    b.resolved = bad;
    assert.equal(check(short, b).code, 'E_ENVELOPE');
  }
});

test('item 3: shadows is exactly class and reference (a class name and a class hash)', () => {
  const v = byId['envelope/shadows-reference-class'];
  const edit = (f) => {
    const b = JSON.parse(v.input);
    f(b.shadows);
    return check(v, b).code;
  };
  assert.equal(edit(() => {}), 'OK');
  assert.equal(edit((s) => (s.reference = 'AB'.repeat(32))), 'E_ENVELOPE');
  assert.equal(edit((s) => (s.reference = 'ab'.repeat(31))), 'E_ENVELOPE');
  assert.equal(edit((s) => (s.class = 'fx_pair')), 'E_ENVELOPE');
  assert.equal(edit((s) => (s.class = 'Rates.example.org/fx_pair')), 'E_ENVELOPE');
  assert.equal(edit((s) => (s.extra = 1)), 'E_ENVELOPE');
  assert.equal(edit((s) => delete s.class), 'E_ENVELOPE');
  assert.equal(edit((s) => delete s.reference), 'E_ENVELOPE');
});

test('item 3: resolved and shadows are optional on ok, stale, not_covered, unlicensed, payment_required and error, and on no other outcome', () => {
  const R = JSON.parse(byId['envelope/resolved-short-call'].input).resolved;
  const S = { class: 'rates.example.org/fx_pair', reference: 'ab'.repeat(32) };
  const base = [
    ['envelope/served-stale', 200],
    ['envelope/job-result-ok', 200],
    ['envelope/unlicensed', 403],
    ['envelope/payment-required', 402],
    ['envelope/error-500', 500],
    ['envelope/not-covered-fault', 404],
  ];
  for (const [id, status] of base) {
    const v = byId[id];
    const b = JSON.parse(v.input);
    assert.equal(check(v, b, status).code, 'OK', id);
    assert.equal(check(v, { ...b, shadows: S }, status).code, 'OK', `${id} + shadows`);
    assert.equal(check(v, { ...b, resolved: R }, status).code, 'OK', `${id} + resolved`);
    const both = check(v, { ...b, resolved: R, shadows: S }, status);
    assert.deepEqual([both.resolved, both.shadows], [R, S], id);
  }
  for (const [id, status] of [['envelope/bad-request-argument', 400], ['envelope/rate-limited', 429], ['envelope/pending-no-asof', 202]]) {
    const v = byId[id];
    const b = JSON.parse(v.input);
    assert.equal(check(v, b, status).code, 'OK', id);
    assert.equal(check(v, { ...b, shadows: S }, status).code, 'E_ENVELOPE', `${id} + shadows`);
    assert.equal(check(v, { ...b, resolved: R }, status).code, 'E_ENVELOPE', `${id} + resolved`);
  }
});

test('item 3: not_covered with E_NAMESPACE_SUSPENDED, never with fault, never in another outcome (9.9, 5.5)', () => {
  const v = byId['envelope/not-covered-namespace-suspended'];
  const r = check(v, v.input);
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'not_covered');
  assert.equal(r.error, 'E_NAMESPACE_SUSPENDED');
  assert.equal(r.fault, null);
  const b = JSON.parse(v.input);
  assert.equal(check(v, { ...b, fault: 'E_FORMULA_KEY' }).code, 'E_ENVELOPE'); // fault and error together
  assert.equal(check(v, { ...b, fn_hash: '7b58ecb8fd23b644c87951d0bd609790ff547cbb23fed27186c669ce2ce0aa80' }, 404, { ...v.request, fn_hash: '7b58ecb8fd23b644c87951d0bd609790ff547cbb23fed27186c669ce2ce0aa80' }).code, 'OK');
  for (const status of [200, 400, 500]) assert.equal(check(v, b, status).code, 'E_ENVELOPE', String(status));
  // not_covered carries only E_NAME_UNBOUND and E_NAMESPACE_SUSPENDED as `error`.
  for (const c of ERROR_CODES) assert.equal(check(v, { outcome: 'not_covered', error: c }).code, ['E_NAME_UNBOUND', 'E_NAMESPACE_SUSPENDED'].includes(c) ? 'OK' : 'E_ENVELOPE', c);
  // In no other outcome (invalid/envelope-namespace-suspended-in-error).
  for (const [outcome, status, extra] of [['error', 500, {}], ['bad_request', 400, {}], ['unlicensed', 403, {}]]) assert.equal(check(v, { outcome, error: 'E_NAMESPACE_SUSPENDED', ...extra }, status).code, 'E_ENVELOPE', outcome);
  assert.equal(check(byId['invalid/envelope-namespace-suspended-in-error'], byId['invalid/envelope-namespace-suspended-in-error'].input).code, 'E_ENVELOPE');
});

test('item 3: the faults E_FORMULA_KEY and E_FORMULA_DISPATCH_KEY on not_covered (15.11, 16.4, 16.6)', () => {
  for (const id of ['envelope/not-covered-fault-key', 'envelope/not-covered-fault-dispatch-key']) {
    const v = byId[id];
    const r = check(v, v.input);
    assert.equal(r.ok, true, id);
    assert.equal(r.outcome, 'not_covered');
    assert.equal(r.fault, JSON.parse(v.input).fault);
    assert.equal(r.error, null);
    for (const status of [200, 500]) assert.equal(check(v, v.input, status).code, 'E_ENVELOPE', `${id} ${status}`);
  }
  const v = byId['envelope/not-covered-fault-key'];
  for (const fault of ['E_FORMULA_DISPATCH', 'E_FORMULA_TYPE', 'E_FORMULA_METHOD', 'e_formula_key', 'E_KEY_NORMALISATION']) assert.equal(check(v, { outcome: 'not_covered', fault }).code, 'E_ENVELOPE', fault); // not faults
  for (const fault of lib.FAULTS) assert.equal(check(v, { outcome: 'not_covered', fault }).code, 'OK', fault);
  assert.equal(check(v, { outcome: 'ok', fault: 'E_FORMULA_KEY' }, 200).code, 'E_ENVELOPE'); // only on not_covered
});

test('item 3: E_SHORT_ID_AMBIGUOUS in bad_request only (16.8)', () => {
  const v = byId['envelope/bad-request-short-id-ambiguous'];
  const r = check(v, v.input);
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'bad_request');
  assert.equal(r.error, 'E_SHORT_ID_AMBIGUOUS');
  for (const status of [200, 404, 500]) assert.equal(check(v, v.input, status).code, 'E_ENVELOPE', String(status));
  for (const outcome of ['error', 'not_covered', 'unlicensed']) assert.equal(check(v, { outcome, error: 'E_SHORT_ID_AMBIGUOUS' }, { error: 500, not_covered: 404, unlicensed: 403 }[outcome]).code, 'E_ENVELOPE', outcome);
  assert.equal(check(byId['invalid/envelope-short-id-in-error'], byId['invalid/envelope-short-id-in-error'].input).code, 'E_ENVELOPE');
});

test('item 3: the define and write codes appear in no read envelope; an error envelope carries no define, class or describe code', () => {
  const v = byId['envelope/error-500'];
  const NOT = ['E_ENVELOPE', 'E_JOB_UNKNOWN', 'E_SLICE_AT_CELL', 'E_NAME_UNBOUND', 'E_FOREIGN_UNAVAILABLE', 'E_UNROOTED_INPUT', 'E_NAMESPACE_SUSPENDED', 'E_CLASS_MEMBER', 'E_CLASS_PARENT', 'E_CLASS_INHERIT', 'E_CLASS_OVERRIDE', 'E_CLASS_FINAL', 'E_CLASS_METHOD', 'E_CLASS_INTERFACE', 'E_CLASS_OWNER', 'E_SHORT_ID_AMBIGUOUS', 'E_DESCRIBE'];
  for (const c of ERROR_CODES) assert.equal(check(v, { outcome: 'error', error: c }, 503).code, NOT.includes(c) ? 'E_ENVELOPE' : 'OK', c);
  for (const outcome of ['error', 'bad_request', 'unlicensed', 'payment_required']) for (const c of ['E_UNROOTED_INPUT']) assert.notEqual(check(v, { outcome, error: c }, { error: 500, bad_request: 400, unlicensed: 403, payment_required: 402 }[outcome]).code, 'OK', `${outcome} ${c}`);
  // bad_request carries the parse codes, E_CANON_HEX, E_SLICE_AT_CELL and (since spec-0.5.0) E_SHORT_ID_AMBIGUOUS.
  const ok400 = ERROR_CODES.filter((c) => check(v, { outcome: 'bad_request', error: c }, 400).code === 'OK');
  assert.deepEqual(ok400, ['E_PARSE_URI', 'E_CANON_NAME', 'E_CANON_ARG_NAME', 'E_CANON_ARG_DUPLICATE', 'E_CANON_ARG_ORDER', 'E_CANON_PERCENT', 'E_CANON_TYPE', 'E_CANON_NUMBER', 'E_CANON_DATE', 'E_CANON_INSTANT', 'E_CANON_STRING', 'E_CANON_BLOB', 'E_CANON_HEX', 'E_CANON_LIMIT', 'E_ARG_UNKNOWN', 'E_ARG_MISSING', 'E_SLICE_AT_CELL', 'E_SHORT_ID_AMBIGUOUS']);
});

test('item 3: the lookup resolution kind (16.7, D93) and its asof', () => {
  const v = byId['envelope/resolved-lookup'];
  const b = JSON.parse(v.input);
  assert.deepEqual(Object.keys(b.resolved.resolutions[0]).sort(), ['asof', 'from', 'kind', 'to']);
  assert.equal(check(v, b).code, 'OK');
  assert.equal(check(byId['invalid/envelope-resolved-lookup-asof'], byId['invalid/envelope-resolved-lookup-asof'].input).code, 'E_ENVELOPE');
});

test('item 3: probes agree with the reference tool (resolved, shadows, not_covered, faults, error codes per outcome)', async () => {
  await agreesOnProbes(3);
});

// ------------------------------------------------------------------------------------------
// Item 4: function descriptors (7)
// ------------------------------------------------------------------------------------------

const FB = JSON.parse(byId['function/argument-key-normalisation'].input);
const fnWith = (f) => {
  const d = structuredClone(FB);
  f(d.signature.args, d.signature);
  return d;
};
const fnCode = (d) => codeOf(() => canonicalize(d, 'function'));

test('item 4: the function vectors (key_normalisation, and the invalid ones)', async () => {
  await conforms(idsWhere((v) => v.kind === 'function' && /spec-0\.5\.0/.test(v.description)));
});

test('item 4: key_normalisation on a string argument; absent means none, so none written out is E_SCHEMA; elsewhere E_CANON_TYPE', () => {
  assert.equal(fnCode(FB), 'OK');
  for (const rule of ['upper_ascii', 'nfc_strict', 'arabic_skeleton', 'hebrew_consonantal', 'greek_unaccented']) assert.equal(fnCode(fnWith((a) => (a.isin.key_normalisation = rule))), 'OK', rule);
  assert.equal(fnCode(fnWith((a) => delete a.isin.key_normalisation)), 'OK'); // none
  for (const bad of ['none', 'NFC_STRICT', 'upper-ascii', '', 'lower_ascii', ' upper_ascii', 5, null, ['upper_ascii'], true]) assert.equal(fnCode(fnWith((a) => (a.isin.key_normalisation = bad))), 'E_SCHEMA', JSON.stringify(bad));
  // any other declaration: E_CANON_TYPE (a date; a number; with classes)
  assert.equal(fnCode(fnWith((a) => (a.date.key_normalisation = 'upper_ascii'))), 'E_CANON_TYPE');
  assert.equal(fnCode(fnWith((a, s) => ((a.n = { type: 'number', unit: '1', valid: false, key_normalisation: 'upper_ascii' }), s.order.push('n')))), 'E_CANON_TYPE');
  assert.equal(fnCode(fnWith((a) => (a.isin.classes = ['a.example.org/k']))), 'E_CANON_TYPE'); // classes with a rule
  // a rule that is not in the list is E_SCHEMA before the type is looked at
  assert.equal(fnCode(fnWith((a) => (a.date.key_normalisation = 'bogus'))), 'E_SCHEMA');
  assert.equal(fnCode(fnWith((a) => (a.date.key_normalisation = 'none'))), 'E_SCHEMA');
});

test('item 4: the rule is part of the descriptor: a new hash, and the descriptor without it keeps its hash', () => {
  const plain = fnWith((a) => delete a.isin.key_normalisation);
  const ruled = FB;
  assert.notEqual(functionHash(plain), functionHash(ruled));
  assert.equal(functionHash(ruled), byId['function/argument-key-normalisation'].sha256);
  // spec-0.4.3 descriptors are unchanged: the hash of every older valid function vector still holds
  for (const v of all.filter((x) => x.kind === 'function' && x.valid && !/spec-0\.5\.0/.test(x.description))) assert.equal(functionHash(v.input), v.sha256, v.id);
});

test('item 4: classes on a string argument and on returns (ascending, unique, at least one; E_CANON_NAME, then E_CANON_SET)', () => {
  const cls = (list, extra = {}) => fnWith((a) => {
    delete a.isin.key_normalisation;
    a.isin.classes = list;
    Object.assign(a.isin, extra);
  });
  assert.equal(fnCode(cls(['a.example.org/k'])), 'OK');
  assert.equal(fnCode(cls(['a.example.org/a', 'b.example.org/b'])), 'OK');
  assert.equal(fnCode(cls(['b.example.org/b', 'a.example.org/a'])), 'E_CANON_SET');
  assert.equal(fnCode(cls(['a.example.org/a', 'a.example.org/a'])), 'E_CANON_SET');
  assert.equal(fnCode(cls([])), 'E_CANON_SET');
  assert.equal(fnCode(cls(['k'])), 'E_CANON_NAME');
  assert.equal(fnCode(cls(['A.example.org/k'])), 'E_CANON_NAME');
  assert.equal(fnCode(cls(['a.example.org/k', 'bad'])), 'E_CANON_NAME');
  assert.equal(fnCode(cls('a.example.org/k')), 'E_SCHEMA');
  assert.equal(fnCode(cls([5])), 'E_SCHEMA');
  // classes on any other type is E_CANON_TYPE
  assert.equal(fnCode(fnWith((a) => (a.date.classes = ['a.example.org/k']))), 'E_CANON_TYPE');
  for (const type of ['number', 'boolean', 'blob']) assert.equal(fnCode(fnWith((a, s) => ((a.n = { type, valid: false, classes: ['a.example.org/k'], ...(type === 'number' ? { unit: '1' } : {}) }), s.order.push('n')))), 'E_CANON_TYPE', type);
  // returns: {"type": "string", "classes": [...]}; another type E_CANON_TYPE; with a unit E_CANON_UNIT
  const ret = (r) => fnWith((a, s) => (s.returns = r));
  assert.equal(fnCode(ret({ type: 'string', classes: ['a.example.org/k'] })), 'OK');
  assert.equal(fnCode(ret({ type: 'string', classes: ['b.example.org/b', 'a.example.org/a'] })), 'E_CANON_SET');
  assert.equal(fnCode(ret({ type: 'string', classes: ['a.example.org/k'], unit: '1' })), 'E_CANON_UNIT');
  assert.equal(fnCode(ret({ type: 'number', classes: ['a.example.org/k'], unit: '1' })), 'E_CANON_TYPE');
  assert.equal(fnCode(ret({ type: 'boolean', classes: ['a.example.org/k'] })), 'E_CANON_TYPE');
  assert.equal(fnCode(ret({ type: 'string' })), 'E_CANON_UNIT'); // a returned string needs `classes` to be a key: a bare name has no unit (7)
  assert.equal(fnCode(ret({ type: 'string', classes: ['bad'] })), 'E_CANON_NAME');
  // the canonical form is the JCS of the descriptor as given
  const d = cls(['a.example.org/a', 'b.example.org/b']);
  assert.equal(text(canonicalize(d, 'function')).includes('"classes":["a.example.org/a","b.example.org/b"]'), true);
});

test('item 4: default "asof" on a valid-time date or instant argument only', () => {
  const dflt = (type, valid, value) => fnWith((a, s) => ((a.d2 = { type, valid, default: value }), s.order.push('d2')));
  assert.equal(fnCode(dflt('date', true, 'asof')), 'OK');
  assert.equal(fnCode(dflt('instant', true, 'asof')), 'OK');
  for (const value of ['now', '', 5, null, 'ASOF']) {
    assert.equal(fnCode(dflt('date', true, value)), 'E_SCHEMA', JSON.stringify(value));
    assert.equal(fnCode(dflt('instant', true, value)), 'E_SCHEMA', JSON.stringify(value));
  }
  assert.equal(fnCode(dflt('date', false, 'asof')), 'E_CANON_TYPE'); // not valid-time
  assert.equal(fnCode(dflt('instant', false, 'asof')), 'E_CANON_TYPE');
  assert.equal(fnCode(dflt('string', false, 'asof')), 'E_CANON_TYPE');
  assert.equal(fnCode(dflt('boolean', true, 'asof')), 'E_CANON_TYPE');
  assert.equal(fnCode(fnWith((a) => (a.isin.default = 'asof'))), 'E_CANON_TYPE');
  // check order within an argument (7): type, unit, valid, then classes, default, key_normalisation, then extent
  assert.equal(fnCode(fnWith((a) => ((a.isin.key_normalisation = 'bogus'), (a.isin.default = 'now')))), 'E_SCHEMA'); // structure first
  assert.equal(fnCode(fnWith((a) => ((a.isin.classes = ['bad']), (a.isin.key_normalisation = 'upper_ascii')))), 'E_CANON_NAME'); // classes before key_normalisation
});

test('item 4: a verifier of spec-0.5.0 accepts a receipt whose descriptor has classes, default or key_normalisation (10.1 step 7.1)', () => {
  const stored = byId['receipt/stored-number'];
  const keys = keysOf(stored);
  const rc = recomputeOf(stored); // the descriptor as JSON text
  const base = JSON.parse(stored.input);
  const variants = {
    key_normalisation: (d) => ((d.signature.args.base.key_normalisation = 'upper_ascii'), (d.signature.args.quote.key_normalisation = 'upper_ascii')),
    classes: (d) => (d.signature.args.base.classes = ['iso.example.org/currency']),
    default: (d) => (d.signature.args.date.default = 'asof'),
  };
  assert.equal(verify(stored.input, keys, rc).ok, true);
  for (const [name, edit] of Object.entries(variants)) {
    const descriptor = structuredClone(stored.recompute.descriptor);
    edit(descriptor);
    const fn_hash = functionHash(descriptor); // throws E_SCHEMA before spec-0.5.0
    const receipt = { ...base, cell: { ...base.cell, fn_hash }, sig: '00'.repeat(64) };
    const payload = receiptPayload(JSON.stringify(receipt));
    receipt.sig = Buffer.from(ed25519.sign(payload, hexToBytes(stored.keypair.seed))).toString('hex');
    const r = verify(JSON.stringify(receipt), keys, { ...rc, descriptor: JSON.stringify(descriptor) });
    assert.equal(r.ok, true, `${name}: ${r.code} ${r.detail}`);
    assert.equal(r.level, 'recomputed', name);
  }
});

test('item 4: probes agree with the reference tool (key_normalisation, classes, default, returns)', async () => {
  await agreesOnProbes(4);
});

// ------------------------------------------------------------------------------------------
// Item 5: classes (16.1, 16.2)
// ------------------------------------------------------------------------------------------

const classVectors = all.filter((v) => v.kind === 'class');
const classEnv = (v, over = {}) => ({ ...v.env, ...over });

test('item 5: the class vectors (12 valid, 32 invalid)', async () => {
  assert.equal(classVectors.length, 44);
  await conforms(classVectors.map((v) => v.id));
});

test('item 5: the class hash is SHA-256 of the canonical flattened descriptor, and defineClass returns both', () => {
  for (const v of classVectors.filter((x) => x.valid)) {
    const r = lib.defineClass(v.input, v.name, v.env);
    assert.equal(r.flattened, v.flattened, v.id);
    assert.equal(r.classHash, v.class_hash, v.id);
    assert.equal(sha256(Buffer.from(r.flattened, 'utf8')), r.classHash, v.id); // the hash is of exactly these bytes
    assert.equal(lib.classHash(r.flattened), r.classHash, v.id); // the flattened descriptor is itself a class descriptor
    assert.equal(lib.classHash(JSON.parse(r.flattened)), r.classHash, v.id);
  }
  // the class name is not part of the hash; members in another order give the same bytes
  const a = byId['class/fx-pair'];
  const b = byId['class/fx-pair-reordered'];
  assert.notEqual(a.input, b.input);
  assert.equal(lib.defineClass(a.input, a.name, a.env).classHash, lib.defineClass(b.input, b.name, b.env).classHash);
  assert.equal(lib.defineClass(a.input, 'rates.example.org/fx_pair/other', a.env).classHash, a.class_hash);
});

test('item 5: the flattened descriptor has no empty or false optional members and keeps parent (16.1, 16.2)', () => {
  const sub = byId['class/subclass-flattened'];
  const flat = JSON.parse(lib.defineClass(sub.input, sub.name, sub.env).flattened);
  const own = JSON.parse(sub.input);
  assert.ok(own.parent);
  assert.equal(flat.parent, own.parent); // parent stays
  const parent = JSON.parse(sub.env.classes[0] instanceof Object ? JSON.stringify(sub.env.classes[0]) : sub.env.classes[0]);
  assert.deepEqual(flat.order, [...parent.order, ...own.order.filter((k) => !parent.order.includes(k))]); // the parent's order, then the class's own
  for (const k of Object.keys(parent.keys)) assert.deepEqual(flat.keys[k], parent.keys[k]); // keys are inherited
  for (const [m, h] of Object.entries(parent.methods)) assert.equal(flat.methods[m], h); // methods the parent's, overlaid by the class's own
  for (const [m, h] of Object.entries(own.methods)) assert.equal(flat.methods[m], h);
  for (const [k, x] of Object.entries(flat)) assert.equal(Array.isArray(x) && x.length === 0, false, `${k} is absent, never empty`);
  assert.equal('final' in flat && flat.final !== true, false);
});

test('item 5: defineClass takes the descriptor and the environment as text, bytes or parsed values, and changes none of them', () => {
  const v = byId['class/subclass-flattened'];
  const want = lib.defineClass(v.input, v.name, v.env);
  const parsedEnv = {
    definer: v.env.definer,
    functions: v.env.functions.map((f) => (typeof f === 'string' ? JSON.parse(f) : f)),
    classes: v.env.classes.map((c) => (typeof c === 'string' ? JSON.parse(c) : c)),
  };
  const before = JSON.stringify(parsedEnv);
  assert.deepEqual(lib.defineClass(JSON.parse(v.input), v.name, parsedEnv), want);
  assert.deepEqual(lib.defineClass(new TextEncoder().encode(v.input), v.name, parsedEnv), want);
  const textEnv = { definer: v.env.definer, functions: parsedEnv.functions.map((f) => JSON.stringify(f)), classes: parsedEnv.classes.map((c) => JSON.stringify(c)) };
  assert.deepEqual(lib.defineClass(v.input, v.name, textEnv), want);
  assert.equal(JSON.stringify(parsedEnv), before);
  // a caller's misuse is a TypeError, not an E_ code (as for the request descriptions of 5.5)
  assert.throws(() => lib.defineClass(v.input, 5, v.env), TypeError);
  assert.throws(() => lib.defineClass(v.input, v.name, null), TypeError);
  assert.throws(() => lib.defineClass(v.input, v.name, { definer: v.env.definer }), TypeError);
});

test('item 5: every class code of 16.2, in its order: the vectors', () => {
  const want = { E_CLASS_MEMBER: 1, E_CLASS_PARENT: 1, E_CLASS_INHERIT: 1, E_CLASS_OVERRIDE: 1, E_CLASS_FINAL: 1, E_CLASS_METHOD: 1, E_CLASS_INTERFACE: 1, E_CLASS_OWNER: 1 };
  for (const c of Object.keys(want)) assert.ok(classVectors.some((v) => v.error === c), c);
  // the codes of 16.1 and 7 that a class descriptor also raises
  for (const c of ['E_SCHEMA', 'E_CANON_NAME', 'E_CANON_ARG_NAME', 'E_CANON_TYPE', 'E_CANON_UNIT', 'E_CANON_SET', 'E_CANON_HEX']) assert.ok(classVectors.some((v) => v.error === c), c);
});

test('item 5: define\'s checks in order (16.2): the name, then the owner, then the descriptor, the parent, the methods', () => {
  const fx = byId['class/fx-pair'];
  const def = (over = {}, name = fx.name, descriptor = fx.input) => codeOf(() => lib.defineClass(descriptor, name, classEnv(fx, over)));
  const mut = (f) => {
    const d = JSON.parse(fx.input);
    f(d);
    return JSON.stringify(d);
  };
  assert.equal(def(), 'OK');
  assert.equal(def({}, 'fx_pair'), 'E_CANON_NAME');
  assert.equal(def({}, 'Rates.example.org/fx_pair'), 'E_CANON_NAME');
  assert.equal(def({ definer: 'other.example.org' }), 'E_CLASS_OWNER');
  assert.equal(def({}, 'other.example.org/fx_pair'), 'E_CLASS_OWNER');
  // the name first, then the owner, then the descriptor as written
  assert.equal(def({ definer: 'other.example.org' }, 'fx_pair', mut((d) => (d.x = 1))), 'E_CANON_NAME');
  assert.equal(def({ definer: 'other.example.org' }, fx.name, mut((d) => (d.x = 1))), 'E_CLASS_OWNER');
  assert.equal(def({}, fx.name, mut((d) => (d.x = 1))), 'E_SCHEMA');
  // within the descriptor: structure over the whole first, then keys, order, methods, steward, parent, open, maps, inverse, lookup, extent, implements
  assert.equal(def({}, fx.name, mut((d) => ((d.extra = 1), (d.keys.base.type = 'blob')))), 'E_SCHEMA');
  assert.equal(def({}, fx.name, mut((d) => ((d.keys.base.type = 'blob'), (d.order = ['base'])))), 'E_CANON_TYPE');
  assert.equal(def({}, fx.name, mut((d) => ((d.order = ['base']), (d.methods.Rate = d.methods.rate), delete d.methods.rate))), 'E_CANON_SET');
  assert.equal(def({}, fx.name, mut((d) => ((d.methods.Rate = d.methods.rate), delete d.methods.rate, (d.steward.process = 'http://x.example.org/')))), 'E_CANON_NAME');
  assert.equal(def({}, fx.name, mut((d) => ((d.steward.process = 'http://x.example.org/'), (d.parent = 'ab'.repeat(32))))), 'E_CLASS_MEMBER');
  assert.equal(def({}, fx.name, mut((d) => ((d.parent = 'ab'.repeat(32)), (d.open = ['rate'])))), 'E_CLASS_MEMBER'); // open without final, before the parent is looked up
  assert.equal(def({}, fx.name, mut((d) => ((d.open = ['rate']), (d.maps = ['nocolon'])))), 'E_CLASS_MEMBER');
  assert.equal(def({}, fx.name, mut((d) => (d.parent = 'ab'.repeat(32)))), 'E_CLASS_PARENT');
  assert.equal(def({}, fx.name, mut((d) => ((d.parent = 'ab'.repeat(32)), (d.methods.rate = 'cd'.repeat(32))))), 'E_CLASS_PARENT'); // the parent before the methods
  assert.equal(def({}, fx.name, mut((d) => (d.methods.rate = 'cd'.repeat(32)))), 'E_CLASS_METHOD');
  // E_CLASS_MEMBER for the members of 16.1
  assert.equal(def({}, fx.name, mut((d) => (d.steward.process = 'http://rates.example.org/classes/change'))), 'E_CLASS_MEMBER');
  assert.equal(def({}, fx.name, mut((d) => (d.keys.base = { type: 'string' }))), 'E_CLASS_MEMBER'); // a string key without a rule
  assert.equal(def({}, fx.name, mut((d) => (d.keys.base.type = 'date'))), 'E_CLASS_MEMBER'); // a rule on another type
  assert.equal(def({}, fx.name, mut((d) => (d.final = true, d.open = ['zzz']))), 'E_CLASS_MEMBER'); // open names no method
  assert.equal(def({}, fx.name, mut((d) => (d.lookup = 'rate'))), 'E_CLASS_MEMBER');
  assert.equal(def({}, fx.name, mut((d) => (d.lookup = 'nonesuch'))), 'E_CLASS_MEMBER');
  // the empty and false optional members are E_SCHEMA
  for (const f of [(d) => (d.final = false), (d) => (d.open = []), (d) => (d.maps = []), (d) => (d.inverse = []), (d) => (d.extent = {}), (d) => (d.implements = [])]) assert.equal(def({}, fx.name, mut(f)), 'E_SCHEMA');
  // sets are ascending and unique
  assert.equal(def({}, fx.name, mut((d) => ((d.final = true), (d.open = ['rate', 'rate'])))), 'E_CANON_SET');
  assert.equal(def({}, fx.name, mut((d) => (d.maps = ['b:c', 'a:b']))), 'E_CANON_SET');
  assert.equal(def({}, fx.name, mut((d) => (d.inverse = ['b', 'a']))), 'E_CANON_SET');
  // at most 32 keys
  assert.equal(def({}, fx.name, mut((d) => { for (let i = 0; i < 31; i++) { d.keys[`k${String(i).padStart(2, '0')}`] = { type: 'boolean' }; d.order.push(`k${String(i).padStart(2, '0')}`); } })), 'E_CANON_LIMIT');
});

test('item 5: the method and key normalisation must match: E_CLASS_METHOD (16.2 step 6, D92)', () => {
  const fx = byId['class/fx-pair'];
  const def = (v, f) => {
    const d = JSON.parse(v.input);
    f(d);
    return codeOf(() => lib.defineClass(JSON.stringify(d), v.name, v.env));
  };
  for (const rule of ['none', 'nfc_strict', 'arabic_skeleton']) {
    assert.equal(def(fx, (d) => (d.keys.base.key_normalisation = rule)), 'E_CLASS_METHOD', rule); // methods carry upper_ascii
    assert.equal(def(fx, (d) => (d.keys.quote.key_normalisation = rule)), 'E_CLASS_METHOD', rule);
  }
  // absent in the function means none: a class key declared none matches a method argument without the member
  const none = byId['class/keyed-none-ruleless-methods'];
  assert.equal(def(none, () => {}), 'OK');
  assert.equal(def(none, (d) => (d.keys.base.key_normalisation = 'upper_ascii')), 'E_CLASS_METHOD');
  assert.equal(def(none, (d) => (d.keys.base.key_normalisation = 'nfc_strict')), 'E_CLASS_METHOD');
  assert.equal(def(byId['class/fx-pair'], (d) => (d.order = ['quote', 'base'])), 'E_CLASS_METHOD'); // the keys first, in class order
  assert.equal(codeOf(() => lib.defineClass(byId['invalid/class-method-normalisation'].input, fx.name, byId['invalid/class-method-normalisation'].env)), 'E_CLASS_METHOD');
});

test('item 5: lookup is read in 16.1\'s check order and exempt from taking the keys (D93)', () => {
  const v = byId['class/lookup'];
  const r = lib.defineClass(v.input, v.name, v.env);
  assert.equal(JSON.parse(r.flattened).lookup, 'named');
  for (const id of ['invalid/class-lookup-not-a-method', 'invalid/class-lookup-returns', 'invalid/class-lookup-signature']) assert.equal(codeOf(() => lib.defineClass(byId[id].input, byId[id].name, byId[id].env)), 'E_CLASS_MEMBER', id);
  const edit = (f) => {
    const d = JSON.parse(v.input);
    f(d);
    return codeOf(() => lib.defineClass(JSON.stringify(d), v.name, v.env));
  };
  assert.equal(edit((d) => (d.lookup = 'rate')), 'E_CLASS_METHOD'); // rate takes the keys first, not one label (16.2 step 6: the method check, before the lookup's own)
  assert.equal(edit((d) => (d.lookup = 5)), 'E_SCHEMA');
});

test('item 5: subclasses: flattening needs the parent, no redeclared key, overrides keep signatures, final classes (16.2)', () => {
  for (const id of ['class/subclass-flattened', 'class/subclass-override', 'class/subclass-of-final-adds', 'class/subclass-of-final-overrides-open']) {
    const v = byId[id];
    assert.equal(codeOf(() => lib.defineClass(v.input, v.name, { ...v.env, classes: [] })), 'E_CLASS_PARENT', id); // the parent descriptor is needed
    assert.equal(codeOf(() => lib.defineClass(v.input, v.name, { ...v.env, definer: 'other.example.org' })), 'E_CLASS_OWNER', id);
    assert.equal(lib.defineClass(v.input, v.name, v.env).classHash, v.class_hash, id);
  }
  for (const [id, code] of [['invalid/class-inherit-redeclared', 'E_CLASS_INHERIT'], ['invalid/class-override-final', 'E_CLASS_FINAL'], ['invalid/class-override-unit', 'E_CLASS_OVERRIDE'], ['invalid/class-parent-unknown', 'E_CLASS_PARENT'], ['invalid/class-owner', 'E_CLASS_OWNER']]) {
    const v = byId[id];
    assert.equal(codeOf(() => lib.defineClass(v.input, v.name, v.env)), code, id);
  }
  // a child's hash names the parent's hash, so it is the same whatever else is in env.classes
  const v = byId['class/subclass-flattened'];
  const extra = byId['class/fx-pair'].flattened;
  assert.equal(lib.defineClass(v.input, v.name, { ...v.env, classes: [...v.env.classes, extra] }).classHash, v.class_hash);
});

test('item 5: interfaces, same_as, inverse, extent (16.2 steps 6-8)', () => {
  for (const id of ['class/interface', 'class/implements-interface', 'class/same-as-and-inverse', 'class/all-members']) {
    const v = byId[id];
    assert.equal(lib.defineClass(v.input, v.name, v.env).flattened, v.flattened, id);
  }
  for (const [id, code] of [['invalid/class-implements-keyed', 'E_CLASS_INTERFACE'], ['invalid/class-implements-missing-method', 'E_CLASS_INTERFACE'], ['invalid/class-same-as-self', 'E_CLASS_METHOD'], ['invalid/class-inverse-without-method', 'E_CLASS_MEMBER'], ['invalid/class-extent-signature', 'E_CLASS_MEMBER']]) {
    const v = byId[id];
    assert.equal(codeOf(() => lib.defineClass(v.input, v.name, v.env)), code, id);
  }
});

test('item 5: classHash checks a flattened descriptor as 16.1 does', () => {
  const flat = byId['class/fx-pair'].flattened;
  assert.equal(lib.classHash(flat), byId['class/fx-pair'].class_hash);
  const d = JSON.parse(flat);
  assert.equal(codeOf(() => lib.classHash({ ...d, extra: 1 })), 'E_SCHEMA');
  assert.equal(codeOf(() => lib.classHash({ ...d, final: false })), 'E_SCHEMA');
  const { steward, ...rest } = d;
  void steward;
  assert.equal(codeOf(() => lib.classHash(rest)), 'E_SCHEMA');
  assert.equal(codeOf(() => lib.classHash({ ...d, order: ['base'] })), 'E_CANON_SET');
  assert.equal(codeOf(() => lib.classHash('not json')), 'E_PARSE_JSON');
});

test('item 5: probes agree with the reference tool (16.1 members, 16.2 order and codes)', async () => {
  await agreesOnProbes(5);
});

// ------------------------------------------------------------------------------------------
// Item 6: key normalisation (16.4)
// ------------------------------------------------------------------------------------------

test('item 6: the normalisation vectors (8 valid, 9 invalid)', async () => {
  await conforms(idsWhere((v) => v.kind === 'normalisation'));
});

test('item 6: each rule of the closed list (16.4)', () => {
  const ok = (rule, s) => codeOf(() => lib.checkKeyNormalisation(rule, s));
  // none: any string, the empty one too
  for (const s of ['', 'x y', 'é', '‍', ' ']) assert.equal(ok('none', s), 'OK', JSON.stringify(s));
  // every rule but none rejects the empty string and a value that is not NFC
  for (const rule of ['upper_ascii', 'nfc_strict', 'arabic_skeleton', 'hebrew_consonantal', 'greek_unaccented']) {
    assert.equal(ok(rule, ''), 'E_KEY_NORMALISATION', `${rule} empty`);
    assert.equal(ok(rule, 'é'), 'E_KEY_NORMALISATION', `${rule} not NFC`);
  }
  // upper_ascii: printable ASCII U+0021 to U+007E and no lowercase letter
  for (const s of ['EUR', '1M', 'XAMS:ASML', '~!', '`', '{', '@', '[']) assert.equal(ok('upper_ascii', s), 'OK', s);
  for (const s of ['eur', 'EUr', 'EUR ', ' EUR', 'E UR', 'É', 'EUR\n', '\x7f', '\x1f', 'Ａ']) assert.equal(ok('upper_ascii', s), 'E_KEY_NORMALISATION', JSON.stringify(s));
  // nfc_strict: no format character, no line or paragraph separator, no space but U+0020, no leading, trailing or repeated U+0020
  for (const s of ['a b', 'é', '가', 'x']) assert.equal(ok('nfc_strict', s), 'OK', s);
  for (const s of ['a  b', ' a', 'a ', 'a b', 'a b', 'a b', 'a‍b', 'a​b', '﻿', '­', 'a　b', 'a b']) assert.equal(ok('nfc_strict', s), 'E_KEY_NORMALISATION', JSON.stringify(s));
  // arabic_skeleton: no mark U+0610-U+061A, U+064B-U+065F, U+0670, U+06D6-U+06DC, U+06DF-U+06E8, U+06EA-U+06ED, no tatweel U+0640
  for (const s of ['بسم ٱلله', '؛', '٠', '۝', '۞', '۩', 'ۮ', 'abc']) assert.equal(ok('arabic_skeleton', s), 'OK', JSON.stringify(s));
  for (const s of ['بَ', 'ـ', 'ٰ', 'ؐ', 'ؚ', 'ً', 'ٟ', 'ۖ', 'ۜ', '۟', 'ۨ', '۪', 'ۭ']) assert.equal(ok('arabic_skeleton', s), 'E_KEY_NORMALISATION', JSON.stringify(s));
  // hebrew_consonantal: no point or accent U+0591-U+05C7 except maqaf U+05BE, paseq U+05C0, sof pasuq U+05C3, nun hafukha U+05C6
  for (const s of ['בראשית', 'את־השמים', '־', '׀', '׃', '׆', '׈']) assert.equal(ok('hebrew_consonantal', s), 'OK', JSON.stringify(s));
  for (const s of ['בְ', '֑', 'ֽ', 'ֿ', 'ׁ', 'ׂ', 'ׄ', 'ׅ', 'ׇ']) assert.equal(ok('hebrew_consonantal', s), 'E_KEY_NORMALISATION', JSON.stringify(s));
  // greek_unaccented: no combining mark U+0300-U+036F in its NFD form
  for (const s of ['λογος', 'Ͱ', 'Ω']) assert.equal(ok('greek_unaccented', s), 'OK', s);
  for (const s of ['λόγος', 'ά', 'Ϊ', 'ΐ', 'ᾳ', 'ἀ', 'ͅ', '̀', 'ͯ', 'ῶ']) assert.equal(ok('greek_unaccented', s), 'E_KEY_NORMALISATION', JSON.stringify(s));
});

test('item 6: the check is pure: it returns nothing, repairs nothing, and misuse is a TypeError', () => {
  assert.equal(lib.checkKeyNormalisation('upper_ascii', 'EUR'), undefined);
  assert.throws(() => lib.checkKeyNormalisation('upper_ascii', 'eur'), (e) => e instanceof DatumeshError && e.code === 'E_KEY_NORMALISATION' && e.path !== undefined);
  assert.throws(() => lib.checkKeyNormalisation('upper_ascii', 5), TypeError);
  assert.throws(() => lib.checkKeyNormalisation(5, 'x'), TypeError);
  assert.throws(() => lib.checkKeyNormalisation('bogus', 'x')); // not a rule of the list: an error (the reference tool says E_CLASS_MEMBER; SPEC 16.4 does not say)
  assert.equal(lib.KEY_NORMALISATIONS.length, 6);
});

test('item 6: probes agree with the reference tool', async () => {
  await agreesOnProbes(6);
});

// ------------------------------------------------------------------------------------------
// Item 7: object keys (16.5)
// ------------------------------------------------------------------------------------------

test('item 7: the key vectors (5 valid, 6 invalid)', async () => {
  await conforms(idsWhere((v) => v.kind === 'key'));
});

test('item 7: parse and format the key encoding, one canonical string per object', () => {
  for (const v of all.filter((x) => x.kind === 'key' && x.valid)) {
    const d = lib.parseObjectKey(v.input);
    assert.deepEqual(d, v.decoded, v.id);
    assert.equal(lib.formatObjectKey(d), v.input, v.id);
  }
  // format sorts the keys by name, whatever the order of the object
  const d = { class: 'a.example.org/k', keys: { b: { type: 'number', value: '2' }, a: { type: 'string', value: 'x"y' }, c: { type: 'boolean', value: false } } };
  assert.equal(lib.formatObjectKey(d), 'a.example.org/k(a:"x""y",b:2,c:false)');
  assert.deepEqual(lib.parseObjectKey('a.example.org/k(a:"x""y",b:2,c:false)'), { class: 'a.example.org/k', keys: { a: { type: 'string', value: 'x"y' }, b: { type: 'number', value: '2' }, c: { type: 'boolean', value: false } } });
  // nested class-typed keys are unquoted; a quoted nested encoding is a string
  const nested = byId['key/nested'];
  assert.equal(lib.parseObjectKey(nested.input).keys.base.class, 'iso.example.org/currency');
  assert.deepEqual(lib.parseObjectKey('a.example.org/k(a:"b.example.org/c()")').keys.a, { type: 'string', value: 'b.example.org/c()' });
  assert.deepEqual(lib.parseObjectKey('a.example.org/k(a:b.example.org/c())').keys.a, { class: 'b.example.org/c', keys: {} });
  assert.equal(lib.formatObjectKey({ class: 'a.example.org/singleton', keys: {} }), 'a.example.org/singleton()');
});

test('item 7: anything but the exact canonical encoding is E_KEY_ENCODING', () => {
  for (const v of all.filter((x) => x.kind === 'key' && !x.valid)) assert.equal(codeOf(() => lib.parseObjectKey(v.input)), 'E_KEY_ENCODING', v.id);
  for (const s of ['a.example.org/k(a:1, b:2)', 'a.example.org/k(b:2,a:1)', 'a.example.org/k(a:1,a:2)', 'a.example.org/k(a:1,)', 'a.example.org/k(a:1.50)', 'a.example.org/k(a:01)', 'a.example.org/k(a:+1)', 'a.example.org/k(a:True)', "a.example.org/k(a:'x')",
    'a.example.org/k(a:x)', 'a.example.org/k(a:2024-3-15)', 'a.example.org/k(a:2024-03-15T09:00:00Z)', 'a.example.org/k(a:"x" )', ' a.example.org/k()', 'a.example.org/k() ', 'a.example.org/k()\n', 'A.example.org/k()', 'a.example.org/K()', 'k()', 'a.example.org/k', 'a.example.org/k(A:1)',
    'a.example.org/k(asof:1)', 'a.example.org/k(a-b:1)', 'a.example.org/k(a:b.example.org/C())', 'a.example.org/k(a:"café")', 'a.example.org/k(a:"line\nbreak")', `a.example.org/k(a:"${'x'.repeat(1030)}")`]) {
    assert.equal(codeOf(() => lib.parseObjectKey(s)), 'E_KEY_ENCODING', JSON.stringify(s).slice(0, 60));
  }
  for (const s of ['a.example.org/k()', 'a.example.org/k/m()', 'a.example.org/k(a:"")', 'a.example.org/k(a:-0.5)', 'a.example.org/k(a:2024-03-15T09:00:00.000000Z)', 'a.example.org/k(a_b:1)', 'a.example.org/k(a:"café")']) assert.equal(lib.formatObjectKey(lib.parseObjectKey(s)), s, s);
  assert.throws(() => lib.parseObjectKey(5), TypeError);
  assert.throws(() => lib.formatObjectKey(null), TypeError);
  assert.throws(() => lib.formatObjectKey({ class: 'Bad', keys: {} }), DatumeshError);
});

test('item 7: the object JSON, the object id and the short id (16.5, 16.8)', () => {
  const v = byId['describe/object'];
  const a = JSON.parse(v.input);
  assert.equal(lib.objectId(a.object), a.object_id);
  assert.equal(lib.objectId(JSON.stringify(a.object)), a.object_id);
  assert.equal(lib.objectId(new TextEncoder().encode(JSON.stringify(a.object))), a.object_id);
  const bytes = lib.objectJson(a.object);
  assert.equal(text(bytes), '{"class":"scripture.example.org/verse","class_hash":"da35ace3d0349fedaf8d749bd6c372a9ad95bdb8b918b91f08e91d5721a2a2e6","keys":{"book":{"type":"string","value":"Gen"},"chapter":{"type":"number","value":"1"},"corpus":{"type":"string","value":"tanakh"},"verse":{"type":"number","value":"1"}}}');
  assert.equal(sha256(bytes), a.object_id);
  assert.equal(lib.shortId(a.object_id), a.short_id);
  assert.equal(lib.shortId(a.object_id).length, 12);
  assert.equal(lib.shortId('ab'.repeat(32)), 'abababababab');
  // a cell id has a short id too
  assert.equal(lib.shortId(byId['envelope/resolved-lookup'].request.cell_id), 'f566f2838815');
  for (const bad of ['', 'ab', 'AB'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), 'zz'.repeat(32), '23185273656a']) assert.equal(codeOf(() => lib.shortId(bad)), 'E_CANON_HEX', bad);
  assert.throws(() => lib.shortId(5), TypeError);
  // a malformed object is an error
  for (const bad of [{ class: 'a.example.org/k', keys: {} }, { ...a.object, extra: 1 }, { ...a.object, class: 'bad' }, { ...a.object, class_hash: 'AB'.repeat(32) }, { ...a.object, keys: { verse: { type: 'number', value: 1 } } }, { ...a.object, keys: [] }]) {
    assert.throws(() => lib.objectId(bad), DatumeshError, JSON.stringify(bad).slice(0, 50));
  }
});

test('item 7: probes agree with the reference tool (key encodings)', async () => {
  await agreesOnProbes(7);
});

// ------------------------------------------------------------------------------------------
// Item 8: describe (16.8)
// ------------------------------------------------------------------------------------------

test('item 8: the describe vectors (2 valid, 6 invalid)', async () => {
  await conforms(idsWhere((v) => v.kind === 'describe'));
});

test('item 8: a class answer and an object answer pass; the result names the kind', () => {
  const c = byId['describe/class'];
  const o = byId['describe/object'];
  assert.deepEqual(lib.checkDescribe(c.input, c.classes), { kind: 'class' });
  assert.deepEqual(lib.checkDescribe(o.input, o.classes), { kind: 'object' });
  // text, bytes or a parsed object
  assert.deepEqual(lib.checkDescribe(JSON.parse(c.input), c.classes), { kind: 'class' });
  assert.deepEqual(lib.checkDescribe(new TextEncoder().encode(o.input), o.classes), { kind: 'object' });
  // `classes` is what the caller holds, by name: an answer for a class the caller does not hold is checked on its own
  assert.deepEqual(lib.checkDescribe(c.input, {}), { kind: 'class' });
  assert.deepEqual(lib.checkDescribe(o.input, {}), { kind: 'object' });
  assert.throws(() => lib.checkDescribe(c.input, null), TypeError);
  assert.throws(() => lib.checkDescribe(c.input), TypeError);
});

test('item 8: a class answer: exactly kind, class, class_hash, descriptor, methods; the hash is the descriptor\'s; the table is the descriptor\'s methods', () => {
  const v = byId['describe/class'];
  const a = JSON.parse(v.input);
  assert.equal(a.class_hash, lib.classHash(a.descriptor)); // follows from what the answer states
  const edit = (f, classes = v.classes) => {
    const b = structuredClone(a);
    f(b);
    return codeOf(() => lib.checkDescribe(b, classes));
  };
  assert.equal(edit(() => {}), 'OK');
  for (const k of ['kind', 'class', 'class_hash', 'descriptor', 'methods']) assert.equal(edit((b) => delete b[k]), 'E_DESCRIBE', k);
  assert.equal(edit((b) => (b.x = 1)), 'E_DESCRIBE');
  assert.equal(edit((b) => (b.kind = 'Class')), 'E_DESCRIBE');
  assert.equal(edit((b) => (b.kind = 'object')), 'E_DESCRIBE');
  assert.equal(edit((b) => (b.class_hash = 'ab'.repeat(32))), 'E_DESCRIBE');
  assert.equal(edit((b) => (b.class_hash = b.class_hash.toUpperCase())), 'E_DESCRIBE');
  assert.equal(edit((b) => (b.descriptor.steward.process = 'https://rates.example.org/other')), 'E_DESCRIBE'); // the hash no longer follows
  assert.equal(edit((b) => (b.class = 'Bad')), 'E_DESCRIBE');
  // the method table: from each method name of the descriptor, and no other
  const names = Object.keys(a.methods);
  assert.equal(edit((b) => delete b.methods[names[0]]), 'E_DESCRIBE');
  assert.equal(edit((b) => (b.methods.extra = structuredClone(b.methods[names[0]]))), 'E_DESCRIBE');
  for (const name of names) {
    for (const k of ['fn', 'fn_hash', 'args', 'returns']) assert.equal(edit((b) => delete b.methods[name][k]), 'E_DESCRIBE', `${name}.${k}`);
    assert.equal(edit((b) => (b.methods[name].fn = 'rates.example.org/fx_pair/other')), 'E_DESCRIBE', name);
    assert.equal(edit((b) => (b.methods[name].fn_hash = 'ab'.repeat(32))), 'E_DESCRIBE', name); // not the descriptor's hash for the method
    assert.equal(edit((b) => (b.methods[name].extra = 1)), 'E_DESCRIBE', name);
    assert.equal(edit((b) => (b.methods[name].description = 5)), 'E_DESCRIBE', name);
    assert.equal(edit((b) => (b.methods[name].description = 'x'.repeat(1024))), 'OK', name); // at most 1024 bytes (3.5)
    assert.equal(edit((b) => (b.methods[name].description = 'x'.repeat(1025))), 'E_DESCRIBE', name);
    assert.equal(edit((b) => (b.methods[name].description = 'é'.repeat(512))), 'OK', name);
    assert.equal(edit((b) => (b.methods[name].description = 'é'.repeat(513))), 'E_DESCRIBE', name);
  }
});

test('item 8: an object answer: exactly kind, object, object_id, short_id, call, methods and optionally same_as; ids follow from the object', () => {
  const v = byId['describe/object'];
  const a = JSON.parse(v.input);
  const edit = (f, classes = v.classes) => {
    const b = structuredClone(a);
    f(b);
    return codeOf(() => lib.checkDescribe(b, classes));
  };
  assert.equal(edit(() => {}), 'OK');
  for (const k of ['kind', 'object', 'object_id', 'short_id', 'call', 'methods']) assert.equal(edit((b) => delete b[k]), 'E_DESCRIBE', k);
  assert.equal(edit((b) => delete b.same_as), 'OK'); // optional
  assert.equal(edit((b) => (b.same_as = [])), 'E_DESCRIBE'); // an optional member is absent, never empty
  assert.equal(edit((b) => (b.same_as = ['x'])), 'E_DESCRIBE'); // object keys (16.5)
  assert.equal(edit((b) => (b.same_as = 'bible.example.org/passage(osis:"Gen.1.1")')), 'E_DESCRIBE');
  assert.equal(edit((b) => (b.x = 1)), 'E_DESCRIBE');
  assert.equal(edit((b) => (b.kind = 'class')), 'E_DESCRIBE');
  assert.equal(edit((b) => (b.object_id = 'ab'.repeat(32))), 'E_DESCRIBE');
  assert.equal(edit((b) => (b.object_id = b.object_id.toUpperCase())), 'E_DESCRIBE');
  for (const s of [a.object_id.slice(0, 12).toUpperCase(), a.object_id.slice(0, 11), a.object_id.slice(0, 13), a.object_id.slice(1, 13), '']) assert.equal(edit((b) => (b.short_id = s)), 'E_DESCRIBE', s);
  // the call form: the class name and every key labelled in ascending order
  for (const call of ['scripture.example.org/verse(verse: 1, book: "Gen", chapter: 1, corpus: "tanakh")', 'scripture.example.org/verse(book: "Gen", chapter: 1, corpus: "tanakh", verse: 2)', 'scripture.example.org/verse(book: "Gen", chapter: "1", corpus: "tanakh", verse: 1)',
    'scripture.example.org/verse(book:"Gen",chapter:1,corpus:"tanakh",verse:1)', 'scripture.example.org/other(book: "Gen", chapter: 1, corpus: "tanakh", verse: 1)']) assert.equal(edit((b) => (b.call = call)), 'E_DESCRIBE', call);
  assert.equal(edit((b) => (b.call = 'scripture.example.org/verse(corpus: "x")'), {}), 'E_DESCRIBE'); // the call follows from the object even when the class is not held
  // the object's class is the held one: its keys and methods are the class's
  assert.equal(edit((b) => (b.methods = ['consonantal', 'text'])), 'E_DESCRIBE');
  assert.equal(edit((b) => (b.methods = ['consonantal', 'next', 'text', 'zzz'])), 'E_DESCRIBE');
  assert.equal(edit((b) => (b.methods = ['text', 'next', 'consonantal'])), 'E_DESCRIBE'); // ascending
  assert.equal(edit((b) => (b.methods = ['consonantal', 'consonantal', 'next', 'text'])), 'E_DESCRIBE');
  assert.equal(edit((b) => (b.object.class_hash = 'ab'.repeat(32))), 'E_DESCRIBE'); // the id no longer follows
  assert.equal(edit((b) => delete b.object.keys.verse), 'E_DESCRIBE');
  assert.equal(edit((b) => (b.object.keys.extra = { type: 'string', value: 'x' })), 'E_DESCRIBE');
  assert.equal(edit((b) => (b.object.keys.book = { type: 'number', value: '1' })), 'E_DESCRIBE'); // the class says string
  assert.equal(edit((b) => (b.object.class = 'scripture.example.org/nonesuch')), 'E_DESCRIBE');
});

test('item 8: not JSON, or not an object, is E_PARSE_JSON or E_DESCRIBE', () => {
  const c = byId['describe/class'];
  assert.equal(codeOf(() => lib.checkDescribe('not json', c.classes)), 'E_PARSE_JSON');
  assert.equal(codeOf(() => lib.checkDescribe('{"kind":"class","kind":"class"}', c.classes)), 'E_PARSE_DUPLICATE_KEY');
  for (const x of ['[]', '"x"', '5', 'null', '{}']) assert.equal(codeOf(() => lib.checkDescribe(x, c.classes)), 'E_DESCRIBE', x);
});

test('item 8: probes agree with the reference tool', async () => {
  await agreesOnProbes(8);
});

// ------------------------------------------------------------------------------------------
// Item 9: define (2.5)
// ------------------------------------------------------------------------------------------

test('item 9: the define vectors (3 valid, 4 invalid)', async () => {
  await conforms(idsWhere((v) => v.kind === 'define'));
});

test('item 9: a rooted function may not read an unrooted one; every other pair is allowed (2.5)', () => {
  const d = (inputs) => ({ signature: { args: {}, returns: { type: 'number', unit: '1' } }, inputs, code: { lang: 'expr', body: '' } });
  const def = (name, inputs) => codeOf(() => lib.checkDefine(d(inputs), name));
  assert.equal(def('calc.example.net/total', ['rates.example.org/fx_rate']), 'OK');
  assert.equal(def('calc.example.net/total', []), 'OK');
  assert.equal(def('calc.example.net/total', ['local.invalid/fx']), 'E_UNROOTED_INPUT');
  assert.equal(def('calc.example.net/total', ['local.invalid/fx', 'rates.example.org/fx_rate']), 'E_UNROOTED_INPUT');
  assert.equal(def('calc.example.net/total', ['a.invalid/x', 'b.example.org/y']), 'E_UNROOTED_INPUT');
  assert.equal(def('calc.example.net/total', ['x.local.invalid/a/b']), 'E_UNROOTED_INPUT'); // any host under .invalid, any path
  assert.equal(def('local.invalid/total', ['rates.example.org/fx_rate']), 'OK'); // unrooted reads rooted
  assert.equal(def('local.invalid/total', ['local.invalid/fx']), 'OK'); // and unrooted
  assert.equal(def('local.invalid/total', ['local.invalid/fx', 'rates.example.org/fx_rate']), 'OK');
  assert.equal(def('x.local.invalid/total', ['x.local.invalid/a/b']), 'OK');
  // rooted means the last label is not `invalid`
  for (const name of ['my.invalid.example.org/total', 'invalid.example.org/total', 'localinvalid.com/total', 'local.invalid.com/total']) {
    assert.equal(def(name, ['rates.example.org/fx_rate']), 'OK', name);
    assert.equal(def(name, ['local.invalid/fx']), 'E_UNROOTED_INPUT', name);
  }
});

test('item 9: define checks the name (2.3), then the descriptor (section 7), then E_UNROOTED_INPUT, and is not a verification code', () => {
  const U = 'local.invalid/fx';
  const base = (f) => {
    const d = JSON.parse(byId['invalid/define-rooted-reads-unrooted'].input);
    f?.(d);
    return d;
  };
  const def = (name, f) => codeOf(() => lib.checkDefine(base(f), name));
  for (const name of ['total', 'invalid/total', 'LOCAL.INVALID/total', 'local.Invalid/total', 'calc.example.net/', '/total', 'calc.example.net/Total', 'calc.example.net', 'local.invalid', '', 'calc.example.net/total@x']) assert.equal(def(name), 'E_CANON_NAME', JSON.stringify(name)); // neither rooted nor unrooted
  assert.equal(def('calc.example.net/total'), 'E_UNROOTED_INPUT');
  assert.equal(def('total', (d) => (d.x = 1)), 'E_CANON_NAME'); // the name before the descriptor
  assert.equal(def('calc.example.net/total', (d) => (d.x = 1)), 'E_SCHEMA'); // the descriptor before the rule
  assert.equal(def('calc.example.net/total', (d) => (d.signature.returns.unit = 'bogus')), 'E_CANON_UNIT');
  assert.equal(def('calc.example.net/total', (d) => (d.inputs = [U, 'rates.example.org/fx_rate'])), 'E_UNROOTED_INPUT');
  assert.equal(def('calc.example.net/total', (d) => (d.inputs = ['rates.example.org/fx_rate', U])), 'E_CANON_SET'); // unsorted inputs: the descriptor first
  assert.equal(def('calc.example.net/total', (d) => (d.inputs = [U, U])), 'E_CANON_SET');
  assert.equal(def('calc.example.net/total', (d) => (d.inputs = ['invalid/fx'])), 'E_CANON_NAME'); // an input that is not a name
  assert.equal(def('calc.example.net/total', (d) => (d.inputs = ['LOCAL.INVALID/fx'])), 'E_CANON_NAME');
  // the result: canonical bytes and hash of the descriptor
  const ok = byId['define/rooted-reads-rooted'];
  const r = lib.checkDefine(ok.input, ok.name);
  assert.equal(text(r.canonical), ok.canonical);
  assert.equal(r.hash, ok.sha256);
  assert.equal(r.hash, functionHash(ok.input));
  assert.deepEqual(Object.keys(r).sort(), ['canonical', 'hash']);
  // a verifier does not check it (2.5): verify() and canonicalize() accept the descriptor of a rooted function reading an unrooted one
  const bad = byId['invalid/define-rooted-reads-unrooted'];
  assert.equal(codeOf(() => canonicalize(bad.input, 'function')), 'OK');
  assert.throws(() => lib.checkDefine(bad.input, 5), TypeError);
});

test('item 9: probes agree with the reference tool', async () => {
  await agreesOnProbes(9);
});

// ------------------------------------------------------------------------------------------
// Item 10: the runner
// ------------------------------------------------------------------------------------------

test('item 10: the runner runs the new kinds and skips the same five', async () => {
  assert.deepEqual([...SKIPPED_KINDS].sort(), ['call', 'decimal', 'excel', 'formula', 'formula-eval']);
  for (const k of ['class', 'normalisation', 'key', 'describe', 'define', 'envelope', 'mesh', 'function', 'licence', 'entitlement']) assert.equal(SKIPPED_KINDS.includes(k), false, k);
  assert.deepEqual(OUTPUTS.class, ['flattened', 'class_hash']);
  assert.deepEqual(OUTPUTS.key, ['decoded']);
  assert.deepEqual(OUTPUTS.define, ['canonical', 'sha256']);
  assert.deepEqual([OUTPUTS.normalisation, OUTPUTS.describe], [[], []]);
  for (const v of all.filter((x) => ['class', 'normalisation', 'key', 'describe', 'define'].includes(x.kind) && x.valid)) {
    const got = await run(v);
    assert.deepEqual(Object.keys(got).sort(), ['error', 'id', ...OUTPUTS[v.kind]].sort(), v.id);
    assert.equal(got.error, null, v.id);
  }
  for (const v of all.filter((x) => ['class', 'normalisation', 'key', 'describe', 'define'].includes(x.kind) && !x.valid)) assert.deepEqual(await run(v), { id: v.id, error: v.error }, v.id);
  for (const v of all.filter((x) => SKIPPED_KINDS.includes(x.kind)).slice(0, 5)) assert.deepEqual(await run(v), { id: v.id, error: null, skipped: v.kind });
});

test('item 10: the licence and entitlement vectors of spec-0.5.0 (invalid ones carry an error)', async () => {
  const ids = idsWhere((v) => (v.kind === 'licence' || v.kind === 'entitlement') && !v.valid);
  assert.equal(ids.length, 9);
  await conforms(ids);
  // 8.5: the arguments are checked first, in order: each input licence, fn, issued, then the mesh's licence
  const lic = (licences, fn, issued, meshLicence) => codeOf(() => lib.inheritLicence(licences, null, fn, issued, meshLicence));
  const F = 'calc.example.net/convert';
  assert.equal(lic(['MIT'], F, T0, 'CC-BY-4.0'), 'OK');
  assert.equal(lic(['MIT License'], F, T0, 'CC-BY-4.0'), 'E_CANON_LICENCE'); // with a space: rejected, not taken as restricted
  assert.equal(lic(['MIT'], 'convert', T0, 'CC-BY-4.0'), 'E_CANON_NAME');
  assert.equal(lic(['MIT'], F, '2024-03-16', 'CC-BY-4.0'), 'E_CANON_INSTANT');
  assert.equal(lic(['MIT'], F, T0, 'MIT License'), 'E_CANON_LICENCE');
  assert.equal(lic(['MIT License'], 'convert', 'x', 'y z'), 'E_CANON_LICENCE'); // the first failure, in that order
  assert.equal(lic(['MIT'], 'convert', 'x', 'y z'), 'E_CANON_NAME');
  assert.equal(lic(['MIT'], F, 'x', 'y z'), 'E_CANON_INSTANT');
});

test('item 10: entitlement collects L as step 7.5 does, in inputs order, with its codes (10.3)', async () => {
  await conforms(['invalid/entitlement-input-missing', 'invalid/entitlement-input-other-hash', 'invalid/entitlement-input-bad-signature', 'invalid/entitlement-manifest-missing', 'invalid/entitlement-member-missing', 'invalid/entitlement-receipt-bad-signature']);
  assert.equal(byId['invalid/entitlement-input-missing'].error, 'E_INPUT_UNAVAILABLE');
  assert.equal(byId['invalid/entitlement-input-bad-signature'].error, 'E_INPUT_INVALID');
});

test('the old vectors still conform (the conformance test is the full run; this is a spot check of every older kind)', async () => {
  const older = all.filter((v) => !/spec-0\.5\.0/.test(v.description ?? '') && !SKIPPED_KINDS.includes(v.kind));
  assert.ok(older.length > 600);
  const bad = [];
  for (const v of older) if (compare(v, await run(v)).length) bad.push(v.id);
  assert.deepEqual(bad.slice(0, 10), []);
});
