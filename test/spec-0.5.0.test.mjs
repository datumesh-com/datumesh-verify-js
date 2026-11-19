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
const isNew060 = (v) => /^spec-0\.6\.[01]/.test(v.description ?? ''); // build2-part1: the new vectors (0.6.0, 0.6.1) are not part of the older blocks

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

// Superseded on build2-part1: the versions are spec-0.6.0 and 0.6.0 (test/spec-0.6.0.test.mjs). What stays true of 0.5.x is that the
// two builds agree with each other and with package.json.
test('versions: both builds and package.json agree (spec-0.5.0 and 0.5.1 until build2-part1, spec-0.6.0 and 0.6.0 after)', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(lib.VERSION, pkg.version);
  assert.equal(cjs.VERSION, pkg.version);
  assert.equal(cjs.SPEC_VERSION, lib.SPEC_VERSION);
  assert.equal(pkg.datumesh.spec, lib.SPEC_VERSION);
});

// build2-part1: the submodule is at 640898c (spec-0.6.0, vectors only); the spec-0.5.0 set of 1474 vectors is the ones whose description
// does not start with "spec-0.6.0" (the set of 0.6.0's own is counted in test/spec-0.6.0.test.mjs).
test('the spec-0.5.0 set (c8896ad) is still all there: 1474 vectors, none of them changed', () => {
  assert.equal(all.filter((v) => !isNew060(v)).length, 1474);
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
  assert.equal(ERROR_CODES.length, 65); // 63 at spec-0.5.0; spec-0.6.0 appends E_WHATIF_UNSUPPORTED and E_WHATIF_NO_SOLUTION (last, after E_DESCRIBE)
  const i = ERROR_CODES.indexOf('E_FOREIGN_UNAVAILABLE');
  assert.equal(i, 48);
  assert.deepEqual(ERROR_CODES.slice(i + 1), ['E_UNROOTED_INPUT', 'E_NAMESPACE_SUSPENDED', 'E_CLASS_MEMBER', 'E_CLASS_PARENT', 'E_CLASS_INHERIT', 'E_CLASS_OVERRIDE', 'E_CLASS_FINAL', 'E_CLASS_METHOD', 'E_CLASS_INTERFACE', 'E_CLASS_OWNER', 'E_KEY_NORMALISATION', 'E_KEY_ENCODING', 'E_SHORT_ID_AMBIGUOUS', 'E_DESCRIBE', 'E_WHATIF_UNSUPPORTED', 'E_WHATIF_NO_SOLUTION']);
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
  assert.deepEqual([...lib.FAULTS].sort(), ['E_FORMULA_ABSENT', 'E_FORMULA_DISPATCH_KEY', 'E_FORMULA_DIV_ZERO', 'E_FORMULA_DOMAIN', 'E_FORMULA_EMPTY', 'E_FORMULA_FUTURE', 'E_FORMULA_KEY', 'E_FORMULA_RANGE', 'E_WHATIF_NO_SOLUTION']); // + E_WHATIF_NO_SOLUTION since spec-0.6.0 (a request fault, not a formula fault)
});

// ------------------------------------------------------------------------------------------
// Item 3: envelopes (5.5)
// ------------------------------------------------------------------------------------------

const envelopeVectors = idsWhere((v) => v.kind === 'envelope' && /spec-0\.5\.0/.test(v.description));
const check = (v, body, status = v.status, request = v.request) => checkEnvelope(status, typeof body === 'string' ? body : JSON.stringify(body), keysOf(v), request);

test('item 3: the new envelope vectors', async () => {
  assert.equal(envelopeVectors.length, 25); // c8896ad: + 6 (re-pin 1, 2)
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
  for (const fault of lib.FAULTS.filter((f) => f !== 'E_WHATIF_NO_SOLUTION')) assert.equal(check(v, { outcome: 'not_covered', fault }).code, 'OK', fault);
  // spec-0.6.0 (5.9): E_WHATIF_NO_SOLUTION is the fault of a whatif request with solve only; this request has none.
  assert.equal(check(v, { outcome: 'not_covered', fault: 'E_WHATIF_NO_SOLUTION' }).code, 'E_ENVELOPE');
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
  const NOT = ['E_ENVELOPE', 'E_JOB_UNKNOWN', 'E_SLICE_AT_CELL', 'E_NAME_UNBOUND', 'E_FOREIGN_UNAVAILABLE', 'E_UNROOTED_INPUT', 'E_NAMESPACE_SUSPENDED', 'E_CLASS_MEMBER', 'E_CLASS_PARENT', 'E_CLASS_INHERIT', 'E_CLASS_OVERRIDE', 'E_CLASS_FINAL', 'E_CLASS_METHOD', 'E_CLASS_INTERFACE', 'E_CLASS_OWNER', 'E_KEY_NORMALISATION', 'E_KEY_ENCODING', 'E_SHORT_ID_AMBIGUOUS', 'E_DESCRIBE', 'E_WHATIF_UNSUPPORTED', 'E_WHATIF_NO_SOLUTION'];
  for (const c of ERROR_CODES) assert.equal(check(v, { outcome: 'error', error: c }, 503).code, NOT.includes(c) ? 'E_ENVELOPE' : 'OK', c);
  for (const outcome of ['error', 'bad_request', 'unlicensed', 'payment_required']) for (const c of ['E_UNROOTED_INPUT']) assert.notEqual(check(v, { outcome, error: c }, { error: 500, bad_request: 400, unlicensed: 403, payment_required: 402 }[outcome]).code, 'OK', `${outcome} ${c}`);
  // bad_request carries the parse codes, E_CANON_HEX, E_SLICE_AT_CELL and (since spec-0.5.0) the key codes and E_SHORT_ID_AMBIGUOUS (c8896ad: RS-b, PY-1).
  const ok400 = ERROR_CODES.filter((c) => check(v, { outcome: 'bad_request', error: c }, 400).code === 'OK');
  assert.deepEqual(ok400, ['E_PARSE_URI', 'E_CANON_NAME', 'E_CANON_ARG_NAME', 'E_CANON_ARG_DUPLICATE', 'E_CANON_ARG_ORDER', 'E_CANON_PERCENT', 'E_CANON_TYPE', 'E_CANON_NUMBER', 'E_CANON_DATE', 'E_CANON_INSTANT', 'E_CANON_STRING', 'E_CANON_BLOB', 'E_CANON_HEX', 'E_CANON_LIMIT', 'E_ARG_UNKNOWN', 'E_ARG_MISSING', 'E_SLICE_AT_CELL', 'E_KEY_NORMALISATION', 'E_KEY_ENCODING', 'E_SHORT_ID_AMBIGUOUS']);
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

test('item 5: the class vectors (14 valid, 36 invalid at spec-0.6.1; 12 and 33 at spec-0.5.0)', async () => {
  assert.equal(classVectors.length, 50);
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

test('item 6: the normalisation vectors (9 valid, 15 invalid)', async () => {
  await conforms(idsWhere((v) => v.kind === 'normalisation'));
});

test('item 6: each rule of the closed list (16.4)', () => {
  const ok = (rule, s) => codeOf(() => lib.checkKeyNormalisation(rule, s));
  // none: any string, the empty one too
  for (const s of ['', 'x y', 'é', '‍', ' ']) assert.equal(ok('none', s), 'OK', JSON.stringify(s)); // NFC U+00E9: an NFD value is E_CANON_STRING under none too (3.5 first)
  // every rule but none rejects the empty string; a value that is not NFC is not a string value by 3.5: E_CANON_STRING under every rule (c8896ad, JS-2)
  for (const rule of ['upper_ascii', 'nfc_strict', 'arabic_skeleton', 'hebrew_consonantal', 'greek_unaccented']) {
    assert.equal(ok(rule, ''), 'E_KEY_NORMALISATION', `${rule} empty`);
    assert.equal(ok(rule, 'é'), 'E_CANON_STRING', `${rule} not NFC`);
  }
  // upper_ascii: printable ASCII U+0021 to U+007E and no lowercase letter
  for (const s of ['EUR', '1M', 'XAMS:ASML', '~!', '`', '{', '@', '[']) assert.equal(ok('upper_ascii', s), 'OK', s);
  for (const s of ['eur', 'EUr', 'EUR ', ' EUR', 'E UR', 'É', 'Ａ']) assert.equal(ok('upper_ascii', s), 'E_KEY_NORMALISATION', JSON.stringify(s));
  for (const s of ['EUR\n', '\x7f', '\x1f']) assert.equal(ok('upper_ascii', s), 'E_CANON_STRING', JSON.stringify(s)); // a control character: 3.5 first (c8896ad, JS-2)
  // nfc_strict: no format character, no line or paragraph separator, no space but U+0020, no leading, trailing or repeated U+0020
  for (const s of ['a b', 'é', '가', 'x']) assert.equal(ok('nfc_strict', s), 'OK', s);
  for (const s of ['a  b', ' a', 'a ', 'a b', 'a b', 'a b', 'a‍b', 'a​b', '﻿', '­', 'a　b', 'a b']) assert.equal(ok('nfc_strict', s), 'E_KEY_NORMALISATION', JSON.stringify(s));
  // arabic_skeleton: no mark U+0610-U+061A, U+064B-U+065F, U+0670, U+06D6-U+06DC, U+06DF-U+06E8, U+06EA-U+06ED, no tatweel U+0640
  for (const s of ['بسم ٱلله', '؛', '٠', '۝', '۞', '۩', 'ۮ', 'abc']) assert.equal(ok('arabic_skeleton', s), 'OK', JSON.stringify(s));
  for (const s of ['بَ', 'ـ', 'ٰ', 'ؐ', 'ؚ', 'ً', 'ٟ', 'ۖ', 'ۜ', '۟', 'ۨ', '۪', 'ۭ']) assert.equal(ok('arabic_skeleton', s), 'E_KEY_NORMALISATION', JSON.stringify(s));
  // hebrew_consonantal: no point or accent U+0591-U+05C7 except maqaf U+05BE, paseq U+05C0, sof pasuq U+05C3, nun hafukha U+05C6
  for (const s of ['בראשית', 'את־השמים', '־', '׀', '׃', '׆']) assert.equal(ok('hebrew_consonantal', s), 'OK', JSON.stringify(s));
  for (const s of ['בְ', '֑', 'ֽ', 'ֿ', 'ׁ', 'ׂ', 'ׄ', 'ׅ', 'ׇ']) assert.equal(ok('hebrew_consonantal', s), 'E_KEY_NORMALISATION', JSON.stringify(s));
  // greek_unaccented: no combining mark U+0300-U+036F in its NFD form
  for (const s of ['λογος', 'Ͱ', 'Ω']) assert.equal(ok('greek_unaccented', s), 'OK', s);
  for (const s of ['λόγος', 'ά', 'Ϊ', 'ΐ', 'ᾳ', 'ἀ', 'ͅ', '̀', 'ͯ', 'ῶ']) assert.equal(ok('greek_unaccented', s), 'E_KEY_NORMALISATION', JSON.stringify(s));
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

test('item 7: the key vectors (7 valid, 10 invalid)', async () => {
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

test('item 8: the describe vectors (6 valid, 18 invalid)', async () => {
  await conforms(idsWhere((v) => v.kind === 'describe' && !isNew060(v)));
});

test('item 8: a class answer and an object answer pass; the result names the kind', () => {
  const c = byId['describe/class'];
  const o = byId['describe/object'];
  assert.deepEqual(lib.checkDescribe(c.input, c.classes), { kind: 'class', publisher: null });
  assert.deepEqual(lib.checkDescribe(o.input, o.classes), { kind: 'object' });
  // text, bytes or a parsed object
  assert.deepEqual(lib.checkDescribe(JSON.parse(c.input), c.classes), { kind: 'class', publisher: null });
  assert.deepEqual(lib.checkDescribe(new TextEncoder().encode(o.input), o.classes), { kind: 'object' });
  // `classes` is what the caller holds, by name: an answer for a class the caller does not hold is checked on its own
  assert.deepEqual(lib.checkDescribe(c.input, {}), { kind: 'class', publisher: null });
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
  assert.deepEqual(OUTPUTS.key, ['decoded', 'object', 'object_id', 'class_hash']); // c8896ad: the last three for a vector given class_hash (class_hash echoed, the reference's output form)
  assert.deepEqual(OUTPUTS.define, ['canonical', 'sha256']);
  assert.deepEqual([OUTPUTS.normalisation, OUTPUTS.describe], [[], []]);
  for (const v of all.filter((x) => ['class', 'normalisation', 'key', 'describe', 'define'].includes(x.kind) && x.valid && !isNew060(x))) {
    const got = await run(v);
    const outputs = v.kind === 'key' && v.class_hash === undefined ? ['decoded'] : OUTPUTS[v.kind];
    assert.deepEqual(Object.keys(got).sort(), ['error', 'id', ...outputs].sort(), v.id);
    assert.equal(got.error, null, v.id);
  }
  for (const v of all.filter((x) => ['class', 'normalisation', 'key', 'describe', 'define'].includes(x.kind) && !x.valid && !isNew060(x))) assert.deepEqual(await run(v), { id: v.id, error: v.error }, v.id);
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
  const older = all.filter((v) => !/spec-0\.5\.0/.test(v.description ?? '') && !isNew060(v) && !SKIPPED_KINDS.includes(v.kind));
  assert.ok(older.length > 600);
  const bad = [];
  for (const v of older) if (compare(v, await run(v)).length) bad.push(v.id);
  assert.deepEqual(bad.slice(0, 10), []);
});

// ==========================================================================================
// Re-pin to spec c8896ad (CONTRACT-0.5.0-libs-repin.md, SPEC 14 "Library findings (verifier
// libraries, spec-0.5.0)", points 1-8). Spec c8896ad is 6d5633e plus 8 formula-evaluator vectors,
// so a verifier library runs 818 of 1474 vectors. One block per re-pin point, in the contract's
// order. IMPL-NOTES-0.5.0.md "Re-pin to c8896ad" maps each test to its point and section.
//
// TEST-FIRST COMMIT: the tests of points 1, 2, 3, 5 and 6 fail until the library follows the
// text; the tests of 4, 7 and 8 pin what the library already does (the findings of other libraries).
// ==========================================================================================

const REQUEST_STATUS = { error: 500, bad_request: 400, not_covered: 404, unlicensed: 403, payment_required: 402 };

// ------------------------------------------------------------------------------------------
// Re-pin 1: E_KEY_NORMALISATION and E_KEY_ENCODING are bad_request codes (5.5, 5.8, 10.2)
// ------------------------------------------------------------------------------------------

test('re-pin 1: the four key-code envelope vectors (2 valid bad_request, 2 invalid in error)', async () => {
  await conforms(['envelope/bad-request-key-normalisation', 'envelope/bad-request-key-encoding', 'invalid/envelope-key-normalisation-in-error', 'invalid/envelope-key-encoding-in-error']);
  for (const id of ['envelope/bad-request-key-normalisation', 'envelope/bad-request-key-encoding']) assert.equal(byId[id].valid, true, id);
  for (const id of ['invalid/envelope-key-normalisation-in-error', 'invalid/envelope-key-encoding-in-error']) assert.equal(byId[id].error, 'E_ENVELOPE', id);
});

test('re-pin 1: the key codes are bad_request codes at 400, and in no other outcome', () => {
  const v = byId['envelope/bad-request-key-encoding'];
  for (const code of ['E_KEY_NORMALISATION', 'E_KEY_ENCODING']) {
    const r = check(v, { outcome: 'bad_request', error: code }, 400);
    assert.equal(r.ok, true, code);
    assert.equal(r.outcome, 'bad_request');
    assert.equal(r.error, code);
    for (const status of [200, 404, 500]) assert.equal(check(v, { outcome: 'bad_request', error: code }, status).code, 'E_ENVELOPE', `${code} at ${status}`);
    for (const outcome of ['error', 'not_covered', 'unlicensed', 'payment_required']) {
      const body = { outcome, error: code, ...(outcome === 'payment_required' ? { quote: { price: '1', currency: 'EUR' } } : {}) };
      assert.equal(check(v, body, REQUEST_STATUS[outcome]).code, 'E_ENVELOPE', `${code} in ${outcome}`);
    }
  }
});

test('re-pin 1: bad_request carries exactly the parse codes, E_CANON_HEX, E_SLICE_AT_CELL, E_SHORT_ID_AMBIGUOUS and the two key codes (5.5)', () => {
  const v = byId['envelope/bad-request-key-encoding'];
  const ok400 = ERROR_CODES.filter((c) => check(v, { outcome: 'bad_request', error: c }, 400).code === 'OK');
  assert.deepEqual(ok400, ['E_PARSE_URI', 'E_CANON_NAME', 'E_CANON_ARG_NAME', 'E_CANON_ARG_DUPLICATE', 'E_CANON_ARG_ORDER', 'E_CANON_PERCENT', 'E_CANON_TYPE', 'E_CANON_NUMBER', 'E_CANON_DATE', 'E_CANON_INSTANT', 'E_CANON_STRING', 'E_CANON_BLOB', 'E_CANON_HEX', 'E_CANON_LIMIT', 'E_ARG_UNKNOWN', 'E_ARG_MISSING', 'E_SLICE_AT_CELL', 'E_KEY_NORMALISATION', 'E_KEY_ENCODING', 'E_SHORT_ID_AMBIGUOUS']);
});

// ------------------------------------------------------------------------------------------
// Re-pin 2: the exact list of codes an error envelope may not carry (5.5, 10.2)
// ------------------------------------------------------------------------------------------

test('re-pin 2: an error envelope carries every code of 10.2 except exactly the 20 listed (18 at spec-0.5.0, + the two whatif codes, spec-0.6.0)', () => {
  const v = byId['envelope/error-500'];
  const NOT_IN_ERROR = ['E_ENVELOPE', 'E_DESCRIBE', 'E_JOB_UNKNOWN', 'E_SLICE_AT_CELL', 'E_NAME_UNBOUND', 'E_SHORT_ID_AMBIGUOUS', 'E_KEY_NORMALISATION', 'E_KEY_ENCODING', 'E_UNROOTED_INPUT', 'E_NAMESPACE_SUSPENDED',
    'E_CLASS_MEMBER', 'E_CLASS_PARENT', 'E_CLASS_INHERIT', 'E_CLASS_OVERRIDE', 'E_CLASS_FINAL', 'E_CLASS_METHOD', 'E_CLASS_INTERFACE', 'E_CLASS_OWNER', 'E_WHATIF_UNSUPPORTED', 'E_WHATIF_NO_SOLUTION'];
  assert.equal(NOT_IN_ERROR.length, 20); // the client's 2, the request codes 6 (E_JOB_UNKNOWN, E_SLICE_AT_CELL, E_NAME_UNBOUND, E_SHORT_ID_AMBIGUOUS and the two key codes), the define and write codes 10
  for (const c of NOT_IN_ERROR) assert.ok(ERROR_CODES.includes(c), c);
  for (const c of ERROR_CODES) {
    // E_FOREIGN_UNAVAILABLE is allowed in `error`, with status 502 and a `detail` (5.5)
    const body = c === 'E_FOREIGN_UNAVAILABLE' ? { outcome: 'error', error: c, detail: 'offline' } : { outcome: 'error', error: c };
    const status = c === 'E_FOREIGN_UNAVAILABLE' ? 502 : 500;
    assert.equal(check(v, body, status).code, NOT_IN_ERROR.includes(c) ? 'E_ENVELOPE' : 'OK', c);
  }
  // the two key codes are the ones the library let through before c8896ad
  for (const c of ['E_KEY_NORMALISATION', 'E_KEY_ENCODING']) for (const status of [500, 503, 599]) assert.equal(check(v, { outcome: 'error', error: c }, status).code, 'E_ENVELOPE', `${c} ${status}`);
});

test('re-pin 2: the invalid error-envelope vectors of the list (class code, E_DESCRIBE, key codes) are E_ENVELOPE', async () => {
  await conforms(['invalid/envelope-class-code-in-error', 'invalid/envelope-describe-in-error', 'invalid/envelope-key-normalisation-in-error', 'invalid/envelope-key-encoding-in-error', 'invalid/envelope-short-id-in-error']);
});

// ------------------------------------------------------------------------------------------
// Re-pin 3: 16.4: a key value is first a string value by 3.5; none accepts ""; nfc_strict's spaces
// ------------------------------------------------------------------------------------------

const RULES = ['none', 'upper_ascii', 'nfc_strict', 'arabic_skeleton', 'hebrew_consonantal', 'greek_unaccented'];
const normCode = (rule, s) => codeOf(() => lib.checkKeyNormalisation(rule, s));

test('re-pin 3: the normalisation vectors of c8896ad (none empty; none with tab, LF, NUL, NFD; nfc_strict U+00A0; upper_ascii empty)', async () => {
  await conforms(['normalisation/none-empty', 'invalid/normalisation-none-tab', 'invalid/normalisation-none-newline', 'invalid/normalisation-none-nul', 'invalid/normalisation-none-nfd', 'invalid/normalisation-nfc-strict-nbsp', 'invalid/normalisation-upper-ascii-empty']);
  assert.equal(byId['invalid/normalisation-none-tab'].error, 'E_CANON_STRING');
  assert.equal(byId['invalid/normalisation-nfc-strict-nbsp'].error, 'E_KEY_NORMALISATION');
  assert.equal(byId['invalid/normalisation-upper-ascii-empty'].error, 'E_KEY_NORMALISATION');
});

test('re-pin 3: under every rule a key value is first a string value (3.5): E_CANON_STRING for a control character, an unassigned code point or a non-NFC string', () => {
  for (const rule of RULES) {
    for (const [what, s] of [['tab', 'a\tb'], ['line feed', 'EUR\n'], ['carriage return', 'a\rb'], ['NUL', 'a\0b'], ['DEL', '\x7f'], ['U+0085', 'a\x85b'], ['U+009F', '\x9f'], ['NFD', 'e\u0301'], ['unassigned U+0378', 'a\u0378'], ['lone surrogate', 'a\ud800']]) {
      assert.equal(normCode(rule, s), 'E_CANON_STRING', `${rule}: ${what}`);
    }
    // 3.5's order: characters, then NFC, then length; a 1025-byte string with a control character is E_CANON_STRING
    assert.equal(normCode(rule, `\t${'A'.repeat(1030)}`), 'E_CANON_STRING', `${rule}: control character first`);
  }
});

test('re-pin 3: under every rule a key value over 1024 bytes is E_CANON_LIMIT (3.5), never E_KEY_NORMALISATION', () => {
  for (const rule of RULES) {
    assert.equal(normCode(rule, 'A'.repeat(1025)), 'E_CANON_LIMIT', rule);
    assert.equal(normCode(rule, '\u00e9'.repeat(513)), 'E_CANON_LIMIT', `${rule}: 1026 bytes in 513 characters`);
  }
  assert.equal(normCode('none', 'A'.repeat(1024)), 'OK');
  assert.equal(normCode('upper_ascii', 'A'.repeat(1024)), 'OK');
  assert.equal(normCode('none', '\u00e9'.repeat(512)), 'OK'); // 1024 bytes
});

test('re-pin 3: none accepts every string valid by 3.5, the empty string included; every other rule rejects the empty string', () => {
  for (const s of ['', ' ', '  a  ', 'EUR', 'eur', '\u200d', '\u00a0', '\u2028', '\ufeff', '\ue000', 'e\u0301'.normalize('NFC')]) assert.equal(normCode('none', s), 'OK', JSON.stringify(s));
  for (const rule of RULES.slice(1)) assert.equal(normCode(rule, ''), 'E_KEY_NORMALISATION', rule);
});

test('re-pin 3: nfc_strict refuses each Unicode 15.1 White_Space character but U+0020 (rule), or 3.5 refuses it first (controls, U+2000, U+2001)', () => {
  // refused by the rule: valid string values (assigned, NFC, not controls)
  const byRule = [0x00a0, 0x1680, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
  for (const cp of byRule) {
    const c = String.fromCodePoint(cp);
    for (const s of [`a${c}b`, c, `${c}a`, `a${c}`]) assert.equal(normCode('nfc_strict', s), 'E_KEY_NORMALISATION', `U+${cp.toString(16)} in ${JSON.stringify(s)}`);
    assert.equal(normCode('none', `a${c}b`), 'OK', `none accepts U+${cp.toString(16)}`);
  }
  // refused by 3.5 first: the controls U+0009-U+000D and U+0085, and U+2000 and U+2001, which are not NFC
  for (const cp of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2000, 0x2001]) assert.equal(normCode('nfc_strict', `a${String.fromCodePoint(cp)}b`), 'E_CANON_STRING', `U+${cp.toString(16)}`);
  // U+0020 itself: allowed inside, not leading, trailing or repeated
  assert.equal(normCode('nfc_strict', 'a b'), 'OK');
  for (const s of [' a', 'a ', 'a  b', ' ']) assert.equal(normCode('nfc_strict', s), 'E_KEY_NORMALISATION', JSON.stringify(s));
  // format characters (Cf) are still refused; characters that are not White_Space are not
  for (const cp of [0x00ad, 0x200b, 0x200d, 0x2060, 0xfeff, 0x180e]) assert.equal(normCode('nfc_strict', `a${String.fromCodePoint(cp)}b`), 'E_KEY_NORMALISATION', `Cf U+${cp.toString(16)}`);
  assert.equal(normCode('nfc_strict', 'a\u2800b'), 'OK'); // BRAILLE PATTERN BLANK is not White_Space
});

// ------------------------------------------------------------------------------------------
// Re-pin 4: an unknown rule: E_CLASS_MEMBER in a class key, E_SCHEMA on a function argument; empty classes E_CANON_SET (16.1, 7)
// ------------------------------------------------------------------------------------------

test('re-pin 4: the four function vectors and the class-lookup vector of c8896ad', async () => {
  await conforms(['invalid/function-classes-empty', 'invalid/function-returns-classes-empty', 'invalid/function-key-normalisation-unknown', 'invalid/function-key-normalisation-none-number', 'invalid/class-lookup-keys-only']);
});

test('re-pin 4: on a function argument an unknown rule is E_SCHEMA, checked before the type; a real rule on another type is E_CANON_TYPE', () => {
  for (const bad of ['bogus', 'NONE', 'Upper_Ascii', 'upper-ascii', 'nfc', 'none ']) {
    assert.equal(fnCode(fnWith((a) => (a.isin.key_normalisation = bad))), 'E_SCHEMA', `string argument: ${bad}`);
    for (const type of ['date', 'boolean', 'blob']) assert.equal(fnCode(fnWith((a, s) => ((a.x = { type, valid: false, key_normalisation: bad }), s.order.push('x')))), 'E_SCHEMA', `${type} argument: ${bad}`);
    assert.equal(fnCode(fnWith((a, s) => ((a.n = { type: 'number', unit: '1', valid: false, key_normalisation: bad }), s.order.push('n')))), 'E_SCHEMA', `number argument: ${bad}`);
  }
  // "none" written out is not a rule of the descriptor: E_SCHEMA on a string argument, and on a number argument before E_CANON_TYPE
  assert.equal(fnCode(fnWith((a, s) => ((a.n = { type: 'number', unit: '1', valid: false, key_normalisation: 'none' }), s.order.push('n')))), 'E_SCHEMA');
  for (const rule of ['upper_ascii', 'nfc_strict', 'arabic_skeleton', 'hebrew_consonantal', 'greek_unaccented']) assert.equal(fnCode(fnWith((a, s) => ((a.n = { type: 'number', unit: '1', valid: false, key_normalisation: rule }), s.order.push('n')))), 'E_CANON_TYPE', rule);
});

test('re-pin 4: an empty classes, in an argument or in a return, is E_CANON_SET', () => {
  assert.equal(fnCode(fnWith((a) => ((a.isin.classes = []), delete a.isin.key_normalisation))), 'E_CANON_SET');
  assert.equal(fnCode(fnWith((a, s) => (s.returns = { type: 'string', classes: [] }))), 'E_CANON_SET');
  assert.equal(fnCode(fnWith((a, s) => (s.returns = { type: 'string', classes: ['a.example.org/k'] }))), 'OK');
  // an empty classes is checked after the names: an empty list has none to be bad, a bad name in a non-empty list is E_CANON_NAME
  assert.equal(fnCode(fnWith((a) => ((a.isin.classes = ['Bad']), delete a.isin.key_normalisation))), 'E_CANON_NAME');
});

test('re-pin 4: in a class key an unknown rule is E_CLASS_MEMBER (16.1); none is a rule there', () => {
  const v = byId['class/fx-pair'];
  const withKeyRule = (rule) => {
    const d = JSON.parse(v.input);
    d.keys.base.key_normalisation = rule;
    return codeOf(() => lib.defineClass(d, v.name, v.env));
  };
  for (const bad of ['bogus', 'NONE', 'upper-ascii', '']) assert.equal(withKeyRule(bad), 'E_CLASS_MEMBER', JSON.stringify(bad));
  // a key declared `none` is allowed: the methods' functions then carry no rule on that argument (absent means none), 16.2 step 6
  const d = JSON.parse(v.input);
  d.keys.base.key_normalisation = 'none';
  const env = structuredClone(v.env);
  const rate = env.functions.find((f) => functionHash(f) === d.methods.rate);
  assert.ok(rate);
  delete rate.signature.args.base.key_normalisation;
  d.methods.rate = functionHash(rate);
  assert.equal(codeOf(() => lib.defineClass(d, v.name, env)), 'OK');
  // while the method still carries upper_ascii on that key, the rules differ: E_CLASS_METHOD
  const d2 = JSON.parse(v.input);
  d2.keys.base.key_normalisation = 'none';
  assert.equal(codeOf(() => lib.defineClass(d2, v.name, v.env)), 'E_CLASS_METHOD');
});

// ------------------------------------------------------------------------------------------
// Re-pin 5: the describe check is six numbered steps (16.8)
// ------------------------------------------------------------------------------------------

const describeVectors = idsWhere((v) => v.kind === 'describe' && !isNew060(v));
const callOf = (o) => `${o.class}(${Object.keys(o.keys).sort().map((k) => `${k}: ${o.keys[k].type === 'string' ? `"${o.keys[k].value.replaceAll('"', '""')}"` : o.keys[k].value}`).join(', ')})`;
/** An object answer for `a` with `f` applied to its object and the ids and call form recomputed, so that only step 5 can fail. */
const objectAnswer = (a, f) => {
  const b = structuredClone(a);
  f(b.object);
  b.object_id = lib.objectId(b.object);
  b.short_id = b.object_id.slice(0, 12);
  b.call = callOf(b.object);
  return b;
};

test('re-pin 5: all 24 describe vectors (6 valid, 18 invalid) run, with the method functions when the vector has them', async () => {
  assert.equal(describeVectors.length, 24);
  await conforms(describeVectors);
  assert.deepEqual(describeVectors.filter((id) => byId[id].functions !== undefined).sort(), ['describe/class-functions', 'invalid/describe-class-args', 'invalid/describe-class-returns']);
});

test('re-pin 5: step 1, parse: the parse codes are their own, not E_DESCRIBE (6.1)', () => {
  const c = byId['describe/class'];
  assert.equal(codeOf(() => lib.checkDescribe('{"kind": "object",', c.classes)), 'E_PARSE_JSON');
  assert.equal(codeOf(() => lib.checkDescribe('', c.classes)), 'E_PARSE_JSON');
  assert.equal(codeOf(() => lib.checkDescribe('\ufeff' + c.input, c.classes)), 'E_PARSE_JSON');
  assert.equal(codeOf(() => lib.checkDescribe('{"kind": "class", "kind": "class"}', c.classes)), 'E_PARSE_DUPLICATE_KEY');
  assert.equal(codeOf(() => lib.checkDescribe('{"kind": "class", "\\u006bind": "class"}', c.classes)), 'E_PARSE_DUPLICATE_KEY'); // compared after unescaping
  assert.equal(codeOf(() => lib.checkDescribe(`${'['.repeat(65)}${']'.repeat(65)}`, c.classes)), 'E_PARSE_JSON');
  assert.equal(codeOf(() => lib.checkDescribe('{"kind": NaN}', c.classes)), 'E_PARSE_JSON');
  // a parse failure comes before the shape: JSON that parses but has the wrong shape is E_DESCRIBE
  assert.equal(codeOf(() => lib.checkDescribe('{"kind": "class"}', c.classes)), 'E_DESCRIBE');
  assert.equal(codeOf(() => lib.checkDescribe(new TextEncoder().encode('{"kind": "object",'), c.classes)), 'E_PARSE_JSON');
});

test('re-pin 5: step 4, the held class is found by class_hash and never by name', () => {
  const o = byId['describe/object'];
  const a = JSON.parse(o.input);
  const verse = o.classes['scripture.example.org/verse'];
  assert.equal(lib.classHash(verse), a.object.class_hash);
  // held under another name: still found, so its key types are checked (step 5)
  const renamed = { 'unrelated.example.org/name': verse, 'rates.example.org/fx_pair': o.classes['rates.example.org/fx_pair'] };
  assert.equal(codeOf(() => lib.checkDescribe(a, renamed)), 'OK');
  const wrongType = objectAnswer(a, (obj) => (obj.keys.book = { type: 'number', value: '1' }));
  assert.equal(codeOf(() => lib.checkDescribe(wrongType, o.classes)), 'E_DESCRIBE');
  assert.equal(codeOf(() => lib.checkDescribe(wrongType, renamed)), 'E_DESCRIBE', 'a held class is found by its hash, whatever name the caller files it under');
  assert.equal(codeOf(() => lib.checkDescribe(wrongType, { 'x.example.org/y': verse })), 'E_DESCRIBE');
  assert.equal(codeOf(() => lib.checkDescribe(wrongType, {})), 'OK', 'nothing held: only steps 1-3 are checked, and the ids and call follow from the object');
  // the answer's class name is not a lookup key: a held class of that name but another hash is not the held class
  const n = byId['describe/object-not-held'];
  const na = JSON.parse(n.input);
  assert.equal(codeOf(() => lib.checkDescribe(na, n.classes)), 'OK');
  const clash = objectAnswer(na, (obj) => (obj.class = 'scripture.example.org/verse')); // class_hash is still cdcd...: not the held verse class
  assert.equal(codeOf(() => lib.checkDescribe(clash, n.classes)), 'OK', 'same name as a held class, another hash: not held');
});

test('re-pin 5: step 4, a client holding no class stops after step 3 (the answer\'s ids, short id and call form)', async () => {
  await conforms(['describe/object-not-held', 'invalid/describe-object-not-held-call']);
  const n = byId['describe/object-not-held'];
  const a = JSON.parse(n.input);
  assert.deepEqual(lib.checkDescribe(a, {}), { kind: 'object' });
  for (const f of [(b) => (b.call = 'bible.example.org/passage(osis: "Gen.1.2")'), (b) => (b.object_id = 'ab'.repeat(32)), (b) => (b.short_id = 'abababababab'), (b) => (b.call = 'bible.example.org/passage(osis:"Gen.1.1")')]) {
    const b = structuredClone(a);
    f(b);
    assert.equal(codeOf(() => lib.checkDescribe(b, {})), 'E_DESCRIBE');
    assert.equal(codeOf(() => lib.checkDescribe(b, n.classes)), 'E_DESCRIBE');
  }
  // a normalisation that the held class would refuse is not checked when that class is not held
  const o = byId['invalid/describe-object-key-normalisation'];
  assert.equal(codeOf(() => lib.checkDescribe(o.input, o.classes)), 'E_DESCRIBE');
  assert.equal(codeOf(() => lib.checkDescribe(o.input, {})), 'OK');
});

test('re-pin 5: step 5, an object answer against the held class: key names, types and normalisations, and methods', () => {
  await_(['invalid/describe-object-key-names', 'invalid/describe-object-key-type', 'invalid/describe-object-key-normalisation']);
  const o = byId['describe/object'];
  const a = JSON.parse(o.input);
  assert.equal(codeOf(() => lib.checkDescribe(objectAnswer(a, (obj) => (obj.keys.extra = { type: 'string', value: 'x' })), o.classes)), 'E_DESCRIBE');
  assert.equal(codeOf(() => lib.checkDescribe(objectAnswer(a, (obj) => delete obj.keys.verse), o.classes)), 'E_DESCRIBE');
  assert.equal(codeOf(() => lib.checkDescribe(objectAnswer(a, (obj) => (obj.keys.verse = { type: 'string', value: '1' })), o.classes)), 'E_DESCRIBE');
  // a string key is canonical under its key's normalisation (16.4): here the held fx_pair says upper_ascii
  const f = byId['describe/class'];
  const fa = JSON.parse(byId['invalid/describe-object-key-normalisation'].input);
  const good = objectAnswer(fa, (obj) => (obj.keys.base.value = 'EUR'));
  assert.equal(codeOf(() => lib.checkDescribe(good, f.classes)), 'OK');
  assert.equal(codeOf(() => lib.checkDescribe(objectAnswer(fa, (obj) => (obj.keys.base.value = 'EUr')), f.classes)), 'E_DESCRIBE');
  assert.equal(codeOf(() => lib.checkDescribe(objectAnswer(fa, (obj) => (obj.keys.base.value = '')), f.classes)), 'E_DESCRIBE');
  assert.equal(codeOf(() => lib.checkDescribe(objectAnswer(fa, (obj) => (obj.keys.base.value = '')), {})), 'OK');
});

test('re-pin 5: step 5 and 6, args and returns are checked only against the method functions the client holds', async () => {
  await conforms(['describe/class-args-unchecked', 'describe/class-functions', 'invalid/describe-class-args', 'invalid/describe-class-returns']);
  const bad = byId['invalid/describe-class-args'];
  const badReturns = byId['invalid/describe-class-returns'];
  // checkDescribe takes the method functions' descriptors as an optional third argument
  assert.equal(codeOf(() => lib.checkDescribe(bad.input, bad.classes, bad.functions)), 'E_DESCRIBE');
  assert.equal(codeOf(() => lib.checkDescribe(badReturns.input, badReturns.classes, badReturns.functions)), 'E_DESCRIBE');
  assert.equal(codeOf(() => lib.checkDescribe(bad.input, bad.classes)), 'OK', 'no functions held: args and returns are not checked');
  assert.equal(codeOf(() => lib.checkDescribe(bad.input, bad.classes, [])), 'OK');
  assert.equal(codeOf(() => lib.checkDescribe(badReturns.input, badReturns.classes)), 'OK');
  assert.equal(codeOf(() => lib.checkDescribe(badReturns.input, badReturns.classes, [])), 'OK');
  // a method whose descriptor the client does not hold (by its fn_hash) is not checked
  const rate = JSON.parse(bad.input).methods.rate.fn_hash;
  const without = (fs) => fs.filter((f) => functionHash(f) !== rate);
  assert.equal(without(bad.functions).length, bad.functions.length - 1);
  assert.equal(codeOf(() => lib.checkDescribe(bad.input, bad.classes, without(bad.functions))), 'OK');
  assert.equal(codeOf(() => lib.checkDescribe(badReturns.input, badReturns.classes, without(badReturns.functions))), 'OK');
  // the matching answer passes with every function held
  const good = byId['describe/class-functions'];
  assert.deepEqual(lib.checkDescribe(good.input, good.classes, good.functions), { kind: 'class', publisher: null });
  assert.deepEqual(lib.checkDescribe(good.input, good.classes), { kind: 'class', publisher: null });
  // args: exactly the function's arguments after the class keys; any difference is E_DESCRIBE
  const a = JSON.parse(good.input);
  const edit = (m, f) => {
    const b = structuredClone(a);
    f(b.methods[m]);
    return codeOf(() => lib.checkDescribe(b, good.classes, good.functions));
  };
  assert.equal(edit('rate', () => {}), 'OK');
  assert.equal(edit('rate', (e) => (e.args.extra = { type: 'string', valid: false })), 'E_DESCRIBE');
  assert.equal(edit('rate', (e) => (e.args.date.valid = false)), 'E_DESCRIBE');
  assert.equal(edit('rate', (e) => (e.returns = { type: 'number', unit: '1' })), 'E_DESCRIBE');
  assert.equal(edit('forward', (e) => delete e.args.tenor), 'E_DESCRIBE');
  assert.equal(edit('named', (e) => (e.returns = { type: 'string' })), 'E_DESCRIBE');
});

test('re-pin 5: step 2, a description is 1 to 1024 bytes valid by 3.5 (the empty one is E_DESCRIBE)', async () => {
  await conforms(['invalid/describe-description-empty']);
  const v = byId['describe/class'];
  const a = JSON.parse(v.input);
  const name = Object.keys(a.methods)[0];
  const code = (d) => {
    const b = structuredClone(a);
    b.methods[name].description = d;
    return codeOf(() => lib.checkDescribe(b, v.classes));
  };
  assert.equal(code('x'), 'OK');
  assert.equal(code('x'.repeat(1024)), 'OK');
  for (const d of ['', 'x'.repeat(1025), 'a\tb', 'a\nb', 'e\u0301', 'a\u0378', 5, null, ['x']]) assert.equal(code(d), 'E_DESCRIBE', JSON.stringify(d)?.slice(0, 30));
  assert.equal(code('\u00e9'.repeat(512)), 'OK');
  assert.equal(code('\u00e9'.repeat(513)), 'E_DESCRIBE');
});

test('re-pin 5: step 2, same_as is ascending and unique, at least one object key', async () => {
  await conforms(['invalid/describe-same-as-duplicate', 'invalid/describe-same-as-unsorted']);
  const o = byId['describe/object'];
  const a = JSON.parse(o.input);
  const A = 'bible.example.org/passage(osis:"Gen.1.1")';
  const B = 'bible.example.org/passage(osis:"Gen.1.2")';
  const C = 'bible.example.org/passage(osis:"Gen.1.3")';
  const code = (same_as, classes = o.classes) => codeOf(() => lib.checkDescribe({ ...a, same_as }, classes));
  assert.equal(code([A]), 'OK');
  assert.equal(code([A, B]), 'OK');
  assert.equal(code([A, B, C]), 'OK');
  for (const list of [[B, A], [A, A], [A, B, B], [A, C, B], [C, B, A], [A, B, A]]) {
    assert.equal(code(list), 'E_DESCRIBE', JSON.stringify(list));
    assert.equal(code(list, {}), 'E_DESCRIBE', `${JSON.stringify(list)} with nothing held`);
  }
  assert.equal(code([]), 'E_DESCRIBE');
  assert.equal(code([A, 'not a key']), 'E_DESCRIBE');
});

test('re-pin 5: a class-typed key in an object answer is a typed string scalar of its encoding, and its call form quotes it (16.5, 16.8)', async () => {
  await conforms(['describe/object-class-typed-key']);
  const v = byId['describe/object-class-typed-key'];
  const a = JSON.parse(v.input);
  assert.deepEqual(a.object.keys.base, { type: 'string', value: 'iso.example.org/currency(code:"EUR")' });
  assert.equal(a.call, 'rates.example.org/ccy_pair(base: "iso.example.org/currency(code:""EUR"")", quote: "iso.example.org/currency(code:""USD"")")');
  assert.deepEqual(lib.checkDescribe(a, v.classes), { kind: 'object' });
  const edit = (f) => {
    const b = structuredClone(a);
    f(b);
    return codeOf(() => lib.checkDescribe(b, v.classes));
  };
  // a nested object is not a typed scalar
  assert.equal(edit((b) => (b.object.keys.base = { class: 'iso.example.org/currency', keys: { code: { type: 'string', value: 'EUR' } } })), 'E_DESCRIBE');
  // the call form is the quoted encoding, not the bare one
  assert.equal(edit((b) => (b.call = 'rates.example.org/ccy_pair(base: iso.example.org/currency(code:"EUR"), quote: iso.example.org/currency(code:"USD"))')), 'E_DESCRIBE');
  assert.equal(edit((b) => (b.call = 'rates.example.org/ccy_pair(base: "iso.example.org/currency(code:\\"EUR\\")", quote: "iso.example.org/currency(code:\\"USD\\")")')), 'E_DESCRIBE');
  // the value of a class-typed key is the encoding of an object of that class (16.5): not an encoding, or another spelling, is E_DESCRIBE when the class is held
  assert.equal(edit((b) => (b.object = { ...b.object, keys: { ...b.object.keys, base: { type: 'string', value: 'EUR' } } })), 'E_DESCRIBE');
  assert.equal(codeOf(() => lib.checkDescribe(objectAnswer(a, (obj) => (obj.keys.base = { type: 'string', value: 'EUR' })), v.classes)), 'E_DESCRIBE');
  assert.equal(codeOf(() => lib.checkDescribe(objectAnswer(a, (obj) => (obj.keys.base = { type: 'string', value: 'iso.example.org/currency(code: "EUR")' })), v.classes)), 'E_DESCRIBE');
  assert.equal(codeOf(() => lib.checkDescribe(objectAnswer(a, (obj) => (obj.keys.base = { type: 'string', value: 'iso.example.org/currency(code:"EUR")' })), v.classes)), 'OK');
});

// the step-5 test above names its vectors through this helper (conformance of the vectors themselves)
function await_(ids) {
  for (const id of ids) assert.ok(byId[id] && byId[id].valid === false && byId[id].error === 'E_DESCRIBE', id);
}

// ------------------------------------------------------------------------------------------
// Re-pin 6: a class-typed key in the object JSON; nested object ids (16.5)
// ------------------------------------------------------------------------------------------

test('re-pin 6: the key vectors given class_hash have object and object_id (key/nested-object), and the runner outputs them', async () => {
  const v = byId['key/nested-object'];
  assert.ok(v.class_hash && v.object && v.object_id);
  assert.deepEqual(OUTPUTS.key, ['decoded', 'object', 'object_id', 'class_hash']);
  await conforms(['key/nested-object', 'key/at-limit']);
  // a key vector without class_hash has neither
  for (const x of all.filter((k) => k.kind === 'key' && k.valid && k.class_hash === undefined)) assert.equal(x.object === undefined && x.object_id === undefined, true, x.id);
  const got = await run(v);
  assert.deepEqual(got.object, v.object);
  assert.equal(got.object_id, v.object_id);
  assert.equal(got.class_hash, v.class_hash); // echoed, as the reference's output form has it
});

test('re-pin 6: the object JSON holds a class-typed key as the typed string scalar of its encoding (16.5)', () => {
  const v = byId['key/nested-object'];
  const decoded = lib.parseObjectKey(v.input);
  // nested keys decode to objects; the object JSON has their encodings as string scalars
  assert.equal(decoded.keys.base.class, 'iso.example.org/currency');
  const withHash = { ...decoded, class_hash: v.class_hash };
  const bytes = lib.objectJson(withHash);
  assert.equal(text(bytes), '{"class":"rates.example.org/ccy_pair","class_hash":"7dec090c2573450e6e9ee022f0d3c128529afa551c7f9bf47e949f0bfb2937c4","keys":{"base":{"type":"string","value":"iso.example.org/currency(code:\\"EUR\\")"},"quote":{"type":"string","value":"iso.example.org/currency(code:\\"USD\\")"}}}');
  assert.deepEqual(JSON.parse(text(bytes)), v.object);
  assert.equal(lib.objectId(withHash), v.object_id);
  assert.equal(sha256(bytes), v.object_id);
  assert.equal(v.object_id, 'fcb2180650816aab6614bc0fd855fdec3301e41eab5a6bbcea0970f3cb7a590a'); // the id SPEC 16.5 prints
  // the JSON form of the same object (typed string scalars) has the same bytes and id
  assert.equal(text(lib.objectJson(v.object)), text(bytes));
  assert.equal(lib.objectId(v.object), v.object_id);
  assert.equal(lib.objectId(JSON.stringify(v.object)), v.object_id);
  // each key's encoding is the formatted nested object
  for (const k of ['base', 'quote']) assert.equal(v.object.keys[k].value, lib.formatObjectKey(decoded.keys[k]));
});

test('re-pin 6: a nested object\'s id: its own object (with its own class hash) has an id, and a nested key adds no member to the parent', () => {
  const v = byId['key/nested-object'];
  const base = lib.parseObjectKey(v.input).keys.base;
  const hashOfCurrency = 'ab'.repeat(32);
  const nestedObject = { ...base, class_hash: hashOfCurrency };
  // {"class":"iso.example.org/currency","class_hash":...,"keys":{"code":{"type":"string","value":"EUR"}}}
  assert.equal(text(lib.objectJson(nestedObject)), `{"class":"iso.example.org/currency","class_hash":"${hashOfCurrency}","keys":{"code":{"type":"string","value":"EUR"}}}`);
  assert.equal(lib.objectId(nestedObject), sha256(new TextEncoder().encode(`{"class":"iso.example.org/currency","class_hash":"${hashOfCurrency}","keys":{"code":{"type":"string","value":"EUR"}}}`)));
  // changing the encoding of a nested key changes the parent's id; its spelling is the one canonical spelling
  const other = lib.parseObjectKey('rates.example.org/ccy_pair(base:iso.example.org/currency(code:"EUR"),quote:iso.example.org/currency(code:"GBP"))');
  assert.notEqual(lib.objectId({ ...other, class_hash: v.class_hash }), v.object_id);
});

// ------------------------------------------------------------------------------------------
// Re-pin 7: a key encoding is at most 1024 bytes as a whole; every decoding failure is E_KEY_ENCODING (16.5)
// ------------------------------------------------------------------------------------------

const keyOf = (n, ch = 'x') => `a.example.org/k(a:"${ch.repeat(n)}")`;
const encCode = (s) => codeOf(() => lib.parseObjectKey(s));

test('re-pin 7: the key vectors of c8896ad: at the limit, too long, calendar date, control character, NFD', async () => {
  await conforms(['key/at-limit', 'invalid/key-too-long', 'invalid/key-date-calendar', 'invalid/key-string-control', 'invalid/key-string-nfd']);
  assert.equal(Buffer.byteLength(byId['key/at-limit'].input), 1024);
  assert.equal(Buffer.byteLength(byId['invalid/key-too-long'].input), 1025);
  for (const id of ['invalid/key-too-long', 'invalid/key-date-calendar', 'invalid/key-string-control', 'invalid/key-string-nfd']) assert.equal(byId[id].error, 'E_KEY_ENCODING', id);
});

test('re-pin 7: an encoding is one string value: 1024 bytes as a whole, which bounds each string inside it', () => {
  const overhead = Buffer.byteLength(keyOf(0));
  assert.equal(Buffer.byteLength(keyOf(1024 - overhead)), 1024);
  assert.equal(encCode(keyOf(1024 - overhead)), 'OK');
  assert.equal(lib.formatObjectKey(lib.parseObjectKey(keyOf(1024 - overhead))), keyOf(1024 - overhead));
  // the string inside is 1003 bytes, within 3.5's limit; the whole is 1025 bytes
  assert.equal(encCode(keyOf(1025 - overhead)), 'E_KEY_ENCODING');
  assert.equal(encCode(keyOf(1024)), 'E_KEY_ENCODING');
  assert.equal(encCode(keyOf(2000)), 'E_KEY_ENCODING');
  // multi-byte characters count as bytes
  const m = Math.floor((1024 - overhead) / 2);
  assert.equal(encCode(keyOf(m, '\u00e9')), 'OK');
  assert.equal(encCode(keyOf(m + 1, '\u00e9')), 'E_KEY_ENCODING');
  // several keys: the bound is on the whole, not on each string
  const two = (n) => `a.example.org/k(a:"${'x'.repeat(n)}",b:"${'y'.repeat(n)}")`;
  assert.equal(encCode(two(499)), 'OK'); // 26 + 2n bytes: exactly 1024
  assert.equal(encCode(two(500)), 'E_KEY_ENCODING'); // 1026
  assert.equal(encCode(two(507)), 'E_KEY_ENCODING'); // 1025+ bytes, each string far under the limit
  assert.ok(Buffer.byteLength(two(507)) > 1024);
  // nested encodings count in the whole
  const nested = `a.example.org/k(a:b.example.org/c(d:"${'x'.repeat(1000)}"))`;
  assert.ok(Buffer.byteLength(nested) > 1024);
  assert.equal(encCode(nested), 'E_KEY_ENCODING');
});

test('re-pin 7: every failure to decode is E_KEY_ENCODING: dates and instants that are not real, strings that break 3.5, syntax, order, trailing text', () => {
  const bad = [
    'a.example.org/k(a:2024-02-30)', 'a.example.org/k(a:2023-02-29)', 'a.example.org/k(a:2024-13-01)', 'a.example.org/k(a:2024-00-10)', 'a.example.org/k(a:2024-04-31)',
    'a.example.org/k(a:2024-03-15T25:00:00.000000Z)', 'a.example.org/k(a:2024-03-15T09:60:00.000000Z)', 'a.example.org/k(a:2024-02-30T09:00:00.000000Z)', 'a.example.org/k(a:2024-03-15T09:00:00Z)',
    'a.example.org/k(a:"a\tb")', 'a.example.org/k(a:"a\nb")', 'a.example.org/k(a:"a\0b")', 'a.example.org/k(a:"a\x7fb")', 'a.example.org/k(a:"e\u0301")', 'a.example.org/k(a:"a\u0378")',
    'a.example.org/k(a:1,a:2)', 'a.example.org/k(b:1,a:2)', 'a.example.org/k(a:1)x', 'a.example.org/k(a:1))', 'a.example.org/k(a:1) ', 'a.example.org/k(a:"x"', 'a.example.org/k(a:"x"y)', 'a.example.org/k(a:b.example.org/c()x)',
    'a.example.org/k(a:1.0)', 'a.example.org/k(a:00)', 'a.example.org/k(a:NaN)', '', '()', 'a.example.org/k(', 'a.example.org/k(a:)', 'a.example.org/k(:1)',
    'a.example.org/k(a:b.example.org/c(d:"x"),b:b.example.org/c(d:"e\u0301"))',
  ];
  for (const s of bad) assert.equal(encCode(s), 'E_KEY_ENCODING', JSON.stringify(s));
  // and the same strings with a valid spelling decode
  for (const s of ['a.example.org/k(a:2024-02-29)', 'a.example.org/k(a:2024-03-15T09:00:00.000000Z)', 'a.example.org/k(a:"a b")', 'a.example.org/k(a:"\u00e9")', 'a.example.org/k(a:-0.5,b:true)', 'a.example.org/k(a:b.example.org/c(d:"x"))']) assert.equal(encCode(s), 'OK', s);
  assert.equal(encCode('a.example.org/k(a:2023-02-29)'), 'E_KEY_ENCODING');
  assert.equal(encCode('a.example.org/k(a:2000-02-29)'), 'OK'); // 2000 is a leap year
  assert.equal(encCode('a.example.org/k(a:1900-02-29)'), 'E_KEY_ENCODING'); // 1900 is not
});

// ------------------------------------------------------------------------------------------
// Re-pin 8: the short id of a malformed id is E_CANON_HEX (16.8)
// ------------------------------------------------------------------------------------------

test('re-pin 8: shortId of a string that is not 64 lowercase hex digits is E_CANON_HEX', () => {
  const id = byId['describe/object'];
  const full = JSON.parse(id.input).object_id;
  assert.equal(lib.shortId(full), full.slice(0, 12));
  assert.equal(lib.shortId(full), JSON.parse(id.input).short_id);
  for (const bad of ['', 'a', full.slice(0, 12), full.slice(0, 63), `${full}0`, full.toUpperCase(), `${full.slice(0, 63)}g`, ` ${full.slice(1)}`, `${full.slice(0, 63)}\n`, `0x${full.slice(2)}`, full.replace(/.$/, 'G'), 'z'.repeat(64), `${full.slice(0, 63)}\u0661`]) {
    assert.equal(codeOf(() => lib.shortId(bad)), 'E_CANON_HEX', JSON.stringify(bad));
  }
  // a short id is taken of a full id only: a short id has no short id
  assert.equal(codeOf(() => lib.shortId(lib.shortId(full))), 'E_CANON_HEX');
  assert.throws(() => lib.shortId(undefined), TypeError);
  assert.throws(() => lib.shortId(null), TypeError);
  assert.throws(() => lib.shortId(12345), TypeError);
});
