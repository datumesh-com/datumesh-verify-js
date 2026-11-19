// What spec-0.6.0 changes for a verifier library (CONTRACT-build2-part1-libs.md items 1-8, with
// C1-C7 of CONTRACT-build2-part1-spec.md), through the public API. The vectors run in
// test/conformance.test.mjs and, here, per item; the rest are focused tests derived from the
// vectors and the contracts. SPEC.md's text for 0.6.0 was not written when these tests were
// (spec 640898c has the vectors only), so every rule here is the contract's, and the API shape
// where the contracts leave it open is stated in the comments (and in the commit message).
//
// TEST-FIRST COMMIT: these tests fail until the features exist. The tests that name no new
// feature (the old suites) pass.
//
// API specified by this file (additions to the 0.5.x API):
//   SPEC_VERSION 'spec-0.6.0'; VERSION '0.6.0'.
//   ERROR_CODES: ..., 'E_DESCRIBE', 'E_WHATIF_UNSUPPORTED', 'E_WHATIF_NO_SOLUTION' (10.2 order; none is a verification result).
//   verify(...).source: the receipt's `source` object ({name, url, retrieved, sha256?, takeover?}), else null.
//   Trust gains 'relayed'. FAULTS gains 'E_WHATIF_NO_SOLUTION'.
//   EnvelopeRequest gains `overrides` (canonical array) and `solve` (the vary cell id); a malformed one is a TypeError (the caller's error, 5.5).
//   checkEnvelope result gains `kind` ('receipt' | 'scenario' | null), `scenario` (Scenario | null) and `cycle` (Cycle | null).
//     A checked scenario is { ok: true, kind: 'scenario', outcome: 'scenario', scenario: { cell, type, value, asof, overrides, solved }, receiptHash: null, trust: null, ... }:
//     never a receipt (no receiptHash, no trust, kind 'scenario'). `solved` is { vary, value } or null.
//   checkDescribe returns { kind: 'function', fn, fnHash, tests, source } for a function answer (tests and source null when absent).
//   MESH_ENDPOINTS.whatif = { placeholders: [], required: false }; resolveMesh returns it in `endpoints`.
//   Types exported: Scenario, ScenarioOverride, Cycle, CycleFix, SourceInfo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import * as lib from '../dist/esm/index.js';
import * as cjs from '../dist/cjs/index.js';
import { makeRunner, compare, SKIPPED_KINDS, MESH_ENDPOINTS as RUNNER_ENDPOINTS, receiptKeys, responseOf, recomputeOf } from '../tools/vector-runner.mjs';
import { root, loadVectors, vector } from './helpers.mjs';

const { ERROR_CODES, DatumeshError, checkEnvelope, checkSlicePage, resolveMesh, verify, canonicalize, receiptPayload, checkDescribe } = lib;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const run = makeRunner(lib, sha256);
const all = loadVectors();
const byId = Object.fromEntries(all.map((v) => [v.id, v]));
const isNew = (v) => v.description.startsWith('spec-0.6.0');
const fresh = all.filter(isNew);
const codeOf = (f) => {
  try {
    f();
    return 'OK';
  } catch (e) {
    if (e instanceof DatumeshError) return e.code;
    throw e;
  }
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const env = (v, body = v.input, status = v.status, request = v.request) => checkEnvelope(status, body, receiptKeys(lib, v), request);

async function conforms(ids) {
  assert.ok(ids.length > 0);
  for (const id of ids) {
    assert.ok(byId[id], `no vector ${id}`);
    assert.deepEqual(compare(byId[id], await run(byId[id])), [], id);
  }
}
const ids = (kind, valid) => fresh.filter((v) => v.kind === kind && (valid === undefined || v.valid === valid)).map((v) => v.id);

// ------------------------------------------------------------------------------------------
// Versions, the submodule, the changelog
// ------------------------------------------------------------------------------------------

test('versions name spec-0.6.0 and 0.6.0 (both builds, package.json)', () => {
  assert.equal(lib.SPEC_VERSION, 'spec-0.6.0');
  assert.equal(cjs.SPEC_VERSION, 'spec-0.6.0');
  assert.equal(lib.VERSION, '0.6.0');
  assert.equal(cjs.VERSION, '0.6.0');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.6.0');
  assert.equal(pkg.datumesh.spec, 'spec-0.6.0');
});

test('the spec submodule is at 640898c: 1564 vectors, 90 of them new (11 call, skipped)', () => {
  assert.equal(all.length, 1564);
  assert.equal(fresh.length, 90);
  assert.equal(fresh.filter((v) => v.kind === 'call').length, 11);
  assert.equal(fresh.filter((v) => !SKIPPED_KINDS.includes(v.kind)).length, 79);
});

test('the CHANGELOG has the 0.6.0 entry with the spec-0.6.0 compatibility line (C2, verbatim)', () => {
  const log = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(log, /0\.6\.0/);
  const line = 'A mesh that serves receipts with `source` is unverifiable by clients on core < 0.4.0 or datumesh < 0.6.0 (@datumesh/verify < 0.6.0); such receipts are new, and every receipt signed before them verifies unchanged.';
  assert.ok(log.replace(/\s+/g, ' ').includes(line));
});

// ------------------------------------------------------------------------------------------
// Runner: every new vector of the kinds the library runs
// ------------------------------------------------------------------------------------------

test('the runner runs every new receipt, envelope, describe and mesh vector and skips the call ones', async () => {
  assert.deepEqual([ids('receipt').length, ids('envelope').length, ids('describe').length, ids('mesh').length], [16, 36, 22, 5]);
  for (const k of ['receipt', 'envelope', 'describe', 'mesh']) await conforms(ids(k));
  for (const v of fresh.filter((x) => x.kind === 'call')) assert.deepEqual(await run(v), { id: v.id, error: null, skipped: 'call' }, v.id);
});

test('the runner knows the whatif endpoint', () => {
  assert.ok(RUNNER_ENDPOINTS.includes('whatif'));
});

test('a scenario vector gives the runner the outcome and no receipt hash or trust', async () => {
  for (const id of ids('envelope', true).filter((i) => /scenario/.test(i))) {
    const got = await run(byId[id]);
    assert.equal(got.error, null, id);
    assert.equal(got.outcome, byId[id].outcome, id);
    assert.equal(got.receipt_hash, undefined, id);
    assert.equal(got.trust, undefined, id);
  }
});

// ------------------------------------------------------------------------------------------
// Codes (item 6)
// ------------------------------------------------------------------------------------------

test('10.2: the two whatif codes follow E_DESCRIBE, in that order', () => {
  const i = ERROR_CODES.indexOf('E_DESCRIBE');
  assert.ok(i > 0);
  assert.deepEqual(ERROR_CODES.slice(i), ['E_DESCRIBE', 'E_WHATIF_UNSUPPORTED', 'E_WHATIF_NO_SOLUTION']);
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
  assert.deepEqual(cjs.ERROR_CODES, ERROR_CODES);
});

test('E_WHATIF_NO_SOLUTION is a fault of a not_covered envelope, marked a request fault', () => {
  assert.ok(lib.FAULTS.includes('E_WHATIF_NO_SOLUTION'));
  assert.ok(!lib.FAULTS.includes('E_WHATIF_UNSUPPORTED')); // a bad_request, not a fault
});

// ------------------------------------------------------------------------------------------
// Receipts: source (item 1, C2)
// ------------------------------------------------------------------------------------------

const relayed = vector('receipt/relayed-full');
const relayedReq = vector('receipt/relayed-required');
const receiptOf = (v) => JSON.parse(v.input);
const keysOf = (v) => receiptKeys(lib, v);

test('a relayed stored receipt verifies like any stored receipt and exposes its source', () => {
  const r = verify(relayed.input, keysOf(relayed), recomputeOf(relayed));
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(r.source, receiptOf(relayed).source);
  assert.deepEqual(Object.keys(r.source).sort(), ['name', 'retrieved', 'sha256', 'takeover', 'url']);
  const r2 = verify(relayedReq.input, keysOf(relayedReq));
  assert.equal(r2.ok, true, r2.detail);
  assert.deepEqual(Object.keys(r2.source).sort(), ['name', 'retrieved', 'url']);
});

test('a receipt without source has source null (every receipt signed before 0.6.0 verifies unchanged)', () => {
  const old = all.find((v) => v.kind === 'receipt' && v.valid && !isNew(v) && JSON.parse(v.input).inputs.length === 0 && JSON.parse(v.input).cell.ns === 'rates.example.org');
  const r = verify(old.input, receiptKeys(lib, old));
  assert.equal(r.ok, true);
  assert.equal(r.source, null);
  assert.equal(r.hash, old.sha256);
});

test('a failed verification has source null', () => {
  const bad = clone(receiptOf(relayed));
  bad.source.url = 'https://bank.example.com/other';
  const r = verify(bad, keysOf(relayed));
  assert.equal(r.ok, false);
  assert.equal(r.source, null);
});

test('source is part of the payload: hashed and signed like every member', () => {
  const r = receiptOf(relayed);
  const withSource = new TextDecoder().decode(receiptPayload(r));
  assert.ok(withSource.includes('"source":{"name":"bank.example.com"'), withSource.slice(0, 300)); // canonical member order: name first among name, retrieved, sha256, takeover, url
  assert.equal(sha256(receiptPayload(r)), relayed.sha256);
  assert.equal(lib.receiptHash(r), relayed.sha256);
  // Changing any member of source after signing breaks the signature (steps 1-4 pass, step 6 fails).
  for (const [k, val] of [['name', 'ecb.europa.eu'], ['url', 'https://bank.example.com/x'], ['retrieved', '2024-03-15T15:31:00.000000Z'], ['sha256', '0'.repeat(64)], ['takeover', 'https://bank.example.com/t']]) {
    const t = clone(r);
    t.source[k] = val;
    assert.equal(verify(t, keysOf(relayed)).code, 'E_SIGNATURE', k);
  }
  const dropped = clone(r);
  delete dropped.source;
  assert.equal(verify(dropped, keysOf(relayed)).code, 'E_SIGNATURE');
});

test('retrieved <= issued: equal is accepted, later is E_TIME_ORDER', () => {
  const r = clone(receiptOf(relayed));
  r.source.retrieved = r.issued;
  assert.equal(codeOf(() => canonicalize(r, 'receipt')), 'OK');
  const late = clone(r);
  late.source.retrieved = '2999-01-01T00:00:00.000000Z';
  assert.equal(codeOf(() => canonicalize(late, 'receipt')), 'E_TIME_ORDER');
});

// 10.1 order: source's members are checked in member order name, retrieved, sha256, takeover, url,
// and each member's rule gives its code.
test('source: each member rule has its code, and the members are checked in order name, retrieved, sha256, takeover, url', () => {
  const base = receiptOf(relayed);
  const code = (mut) => {
    const r = clone(base);
    mut(r.source, r);
    return codeOf(() => canonicalize(r, 'receipt'));
  };
  assert.equal(code(() => {}), 'OK');
  assert.equal(code((s) => (s.name = 'Not A Name')), 'E_CANON_NAME');
  assert.equal(code((s) => (s.retrieved = '2024-03-15')), 'E_CANON_INSTANT');
  assert.equal(code((s) => (s.sha256 = 'D'.repeat(64))), 'E_CANON_HEX');
  assert.equal(code((s) => (s.sha256 = 'ab')), 'E_CANON_HEX');
  assert.equal(code((s) => (s.takeover = 'http://bank.example.com/t')), 'E_CANON_LICENCE');
  assert.equal(code((s) => (s.url = 'http://bank.example.com/u')), 'E_CANON_LICENCE');
  assert.equal(code((s) => (s.url = `https://bank.example.com/${'a'.repeat(500)}`)), 'E_CANON_LIMIT');
  assert.equal(code((s) => (s.url = 'https://bank.example.com/é')), 'E_CANON_LICENCE');
  assert.equal(code((s) => (s.extra = 1)), 'E_SCHEMA');
  assert.equal(code((s) => delete s.retrieved), 'E_SCHEMA');
  assert.equal(code((s) => delete s.url), 'E_SCHEMA');
  assert.equal(code((s) => delete s.name), 'E_SCHEMA');
  assert.equal(code((s) => (s.name = 'rates.example.org')), 'E_SCHEMA'); // a publisher does not relay itself
  assert.equal(code((s, r) => (r.source = 'x')), 'E_SCHEMA');
  assert.equal(code((s, r) => (r.source = [])), 'E_SCHEMA');
  assert.equal(code((s) => (s.sha256 = 7)), 'E_SCHEMA');
  // The 512-character limit is the licence URL rule: 512 is the longest accepted.
  assert.equal(code((s) => (s.url = `https://bank.example.com/${'a'.repeat(512 - 'https://bank.example.com/'.length)}`)), 'OK');
  assert.equal(code((s) => (s.url = `https://bank.example.com/${'a'.repeat(513 - 'https://bank.example.com/'.length)}`)), 'E_CANON_LIMIT');
  // Order: the first failing member in name, retrieved, sha256, takeover, url wins.
  assert.equal(code((s) => ((s.name = 'Not A Name'), (s.retrieved = 'x'), (s.sha256 = 'X'), (s.takeover = 'x'), (s.url = 'x'))), 'E_CANON_NAME');
  assert.equal(code((s) => ((s.retrieved = 'x'), (s.sha256 = 'X'), (s.takeover = 'x'), (s.url = 'x'))), 'E_CANON_INSTANT');
  assert.equal(code((s) => ((s.sha256 = 'X'), (s.takeover = 'x'), (s.url = 'x'))), 'E_CANON_HEX');
  assert.equal(code((s) => ((s.takeover = 'x'), (s.url = 'x'))), 'E_CANON_LICENCE');
  assert.equal(code((s) => ((s.url = 'x'), (s.name = 'rates.example.org'))), 'E_SCHEMA'); // name equal to the host is a schema failure, before the url's
});

test('source is allowed only when inputs is empty (E_SCHEMA otherwise)', () => {
  const r = clone(receiptOf(relayed));
  r.inputs = [`${'a'.repeat(64)}`];
  assert.equal(codeOf(() => canonicalize(r, 'receipt')), 'E_SCHEMA');
});

test('a receipt still rejects other unknown members (source is the only new one)', () => {
  const r = clone(receiptOf(relayed));
  r.sourcee = r.source;
  delete r.source;
  assert.equal(codeOf(() => canonicalize(r, 'receipt')), 'E_SCHEMA');
});

test('the invalid receipt vectors give their exact codes', async () => {
  const want = {
    'invalid/receipt-source-with-inputs': 'E_SCHEMA',
    'invalid/receipt-source-extra-member': 'E_SCHEMA',
    'invalid/receipt-source-missing-retrieved': 'E_SCHEMA',
    'invalid/receipt-source-missing-url': 'E_SCHEMA',
    'invalid/receipt-source-name-is-publisher': 'E_SCHEMA',
    'invalid/receipt-source-name-bad': 'E_CANON_NAME',
    'invalid/receipt-source-retrieved-bad': 'E_CANON_INSTANT',
    'invalid/receipt-source-sha256-uppercase': 'E_CANON_HEX',
    'invalid/receipt-source-sha256-short': 'E_CANON_HEX',
    'invalid/receipt-source-url-http': 'E_CANON_LICENCE',
    'invalid/receipt-source-url-non-ascii': 'E_CANON_LICENCE',
    'invalid/receipt-source-takeover-bad': 'E_CANON_LICENCE',
    'invalid/receipt-source-url-too-long': 'E_CANON_LIMIT',
    'invalid/receipt-source-retrieved-after-issued': 'E_TIME_ORDER',
  };
  assert.deepEqual(Object.keys(want).sort(), ids('receipt', false).sort());
  for (const [id, code] of Object.entries(want)) assert.equal((await run(byId[id])).error, code, id);
});

// ------------------------------------------------------------------------------------------
// Trust: relayed (item 2, C2)
// ------------------------------------------------------------------------------------------

test('trust relayed: the signer is the host of cell.ns, inputs empty, and the receipt has source', () => {
  const v = byId['envelope/relayed'];
  const r = env(v);
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.outcome, 'ok');
  assert.equal(r.trust, 'relayed');
  assert.equal(r.kind, 'receipt');
  assert.equal(r.scenario, null);
  assert.equal(r.receiptHash, v.receipt_hash);
});

test('trust: primary needs no source, relayed needs source (both directions are E_ENVELOPE)', () => {
  const v = byId['envelope/relayed'];
  const body = JSON.parse(v.input);
  body.trust = 'primary';
  const a = env(v, JSON.stringify(body));
  assert.deepEqual([a.ok, a.code], [false, 'E_ENVELOPE']);
  assert.match(a.detail, /relayed|source/);
  const p = byId['envelope/ok-primary'] ?? all.find((x) => x.kind === 'envelope' && x.valid && x.outcome === 'ok' && x.trust === 'primary' && !isNew(x));
  const pb = JSON.parse(p.input);
  assert.equal(pb.trust, 'primary');
  assert.equal(env(p).trust, 'primary');
  pb.trust = 'relayed';
  const b = env(p, JSON.stringify(pb));
  assert.deepEqual([b.ok, b.code], [false, 'E_ENVELOPE']);
});

test('trust relayed is a function of the receipt alone: the mesh asked does not change it', () => {
  const v = byId['envelope/relayed'];
  const other = env(v, v.input, v.status, { ...v.request, mesh: 'mirror.example.net' });
  assert.equal(other.ok, true, other.detail);
  assert.equal(other.trust, 'relayed');
  const same = env(v, v.input, v.status, { ...v.request, mesh: 'rates.example.org' });
  assert.equal(same.ok, true, same.detail);
  assert.equal(same.trust, 'relayed');
  // Mirrored: a relayed receipt labelled computed, verified or unverified is wrong.
  for (const t of ['computed', 'verified', 'unverified']) {
    const body = JSON.parse(v.input);
    body.trust = t;
    assert.equal(env(v, JSON.stringify(body)).code, 'E_ENVELOPE', t);
  }
});

test('trust vectors (relayed, primary with source, relayed without, mirror) conform', async () => {
  await conforms(['envelope/relayed', 'invalid/envelope-trust-primary-with-source', 'invalid/envelope-trust-relayed-without-source', 'invalid/envelope-trust-relayed-mirror']);
});

// ------------------------------------------------------------------------------------------
// Envelopes: request description overrides and solve (item 3, C5)
// ------------------------------------------------------------------------------------------

const S = byId['envelope/scenario-value-override'];

test('a request with a malformed overrides or solve is the caller\'s error (TypeError, 5.5)', () => {
  const bad = [
    { overrides: 'x' },
    { overrides: {} },
    { overrides: [1] },
    { overrides: [{}] },
    { overrides: [{ cell: S.request.overrides[0].cell }] },
    { overrides: [{ ...S.request.overrides[0], extra: 1 }] },
    { overrides: Array.from({ length: 65 }, () => S.request.overrides[0]) },
    { overrides: S.request.overrides, solve: 'F'.repeat(64) },
    { overrides: S.request.overrides, solve: 'abc' },
    { overrides: S.request.overrides, solve: 7 },
    { overrides: null },
  ];
  for (const extra of bad) assert.throws(() => checkEnvelope(S.status, S.input, receiptKeys(lib, S), { ...S.request, ...extra }), TypeError, JSON.stringify(extra).slice(0, 80));
});

test('a request with well-formed overrides, an empty overrides with solve, and an asof-less request are accepted', () => {
  assert.equal(env(S).ok, true);
  const solved = byId['envelope/scenario-solved'];
  assert.deepEqual(solved.request.overrides, []);
  assert.equal(typeof solved.request.solve, 'string');
  assert.equal(env(solved).ok, true);
  assert.equal(env(byId['envelope/scenario-no-asof-sent']).ok, true);
});

test('a scenario is its own result kind: not a receipt, no hash, no trust', () => {
  const r = env(S);
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.code, 'OK');
  assert.equal(r.outcome, 'scenario');
  assert.equal(r.kind, 'scenario');
  assert.equal(r.receiptHash, null);
  assert.equal(r.trust, null);
  assert.equal(r.fault, null);
  assert.equal(r.pending, null);
  assert.equal(r.cycle, null);
  assert.ok(!('receipt' in r));
  assert.deepEqual(Object.keys(r.scenario).sort(), ['asof', 'cell', 'overrides', 'solved', 'type', 'value']);
  assert.equal(r.scenario.type, 'number');
  assert.equal(r.scenario.value, '120');
  assert.equal(r.scenario.asof, '2024-03-16T09:00:00.000000Z');
  assert.equal(r.scenario.solved, null);
  assert.equal(r.scenario.cell.fn, 'convert');
  assert.equal(r.scenario.cell.ns, 'calc.example.net');
  assert.equal(r.scenario.overrides.length, 2);
  assert.deepEqual(r.scenario.overrides[0].value, { type: 'number', value: '0.9' });
  assert.deepEqual(r.scenario.overrides, JSON.parse(S.input).scenario.overrides);
});

test('a verified receipt result is kind receipt and has no scenario', () => {
  const ok = all.find((x) => x.kind === 'envelope' && x.valid && x.outcome === 'ok' && !x.request?.slice_id && !isNew(x));
  const r = env(ok);
  assert.equal(r.kind, 'receipt');
  assert.equal(r.scenario, null);
  assert.equal(typeof r.receiptHash, 'string');
});

test('an outcome without a receipt or scenario has kind null', () => {
  const v = byId['envelope/scenario-not-covered'];
  const r = env(v);
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.outcome, 'not_covered');
  assert.equal(r.kind, null);
  assert.equal(r.scenario, null);
  const failed = env(S, S.input, 500);
  assert.equal(failed.ok, false);
  assert.equal(failed.kind, null);
  assert.equal(failed.scenario, null);
});

test('a slice override scenario: the cell asked is the added one', () => {
  const v = byId['envelope/scenario-slice-override'];
  const r = env(v);
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.kind, 'scenario');
  assert.equal(r.scenario.value, '1.2');
  const o = r.scenario.overrides[0];
  assert.deepEqual(Object.keys(o).sort(), ['add', 'remove', 'slice']);
  assert.equal(o.add.length, 1);
  assert.equal(o.remove.length, 1);
  assert.deepEqual(o.add[0].value, { type: 'number', value: '1.2' });
});

test('solve: solved is present exactly when solve was sent, and states the value found', () => {
  const v = byId['envelope/scenario-solved'];
  const r = env(v);
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.kind, 'scenario');
  assert.ok(r.scenario.solved);
  assert.deepEqual(Object.keys(r.scenario.solved).sort(), ['value', 'vary']);
  assert.equal(r.scenario.solved.value.type, 'number');
  assert.equal(typeof r.scenario.solved.value.value, 'string');
  assert.equal(r.scenario.solved.vary.fn, 'fx_rate');
  // The same body when no solve was sent: E_ENVELOPE (solved unrequested).
  const noSolve = { ...v.request };
  delete noSolve.solve;
  const a = env(v, v.input, v.status, noSolve);
  assert.deepEqual([a.ok, a.code], [false, 'E_ENVELOPE']);
  // Sent solve naming another vary cell: E_ENVELOPE.
  const b = env(v, v.input, v.status, { ...v.request, solve: '0'.repeat(64) });
  assert.deepEqual([b.ok, b.code], [false, 'E_ENVELOPE']);
  // solve sent, solved missing: E_ENVELOPE.
  const body = JSON.parse(v.input);
  delete body.scenario.solved;
  assert.equal(env(v, JSON.stringify(body)).code, 'E_ENVELOPE');
});

test('scenario binding (step 5): cell, asof, overrides byte for byte, sorted; every failure is E_ENVELOPE', () => {
  const mutate = (f, request = S.request) => {
    const body = JSON.parse(S.input);
    f(body.scenario);
    return env(S, JSON.stringify(body), 200, request);
  };
  assert.equal(mutate(() => {}).ok, true);
  const e = (r) => [r.ok, r.code];
  assert.deepEqual(e(mutate((s) => (s.cell.args.amount.value = '101'))), [false, 'E_ENVELOPE']); // wrong cell
  assert.deepEqual(e(mutate((s) => (s.asof = '2024-03-16T09:00:00.000001Z'))), [false, 'E_ENVELOPE']);
  assert.deepEqual(e(mutate((s) => s.overrides.reverse())), [false, 'E_ENVELOPE']); // unsorted echo of a sorted request
  assert.deepEqual(e(mutate((s) => (s.overrides[0].value.value = '0.8'))), [false, 'E_ENVELOPE']); // wrong echo
  assert.deepEqual(e(mutate((s) => s.overrides.pop())), [false, 'E_ENVELOPE']);
  assert.deepEqual(e(mutate((s) => (s.extra = 1))), [false, 'E_ENVELOPE']);
  assert.deepEqual(e(mutate((s) => delete s.asof)), [false, 'E_ENVELOPE']);
  assert.deepEqual(e(mutate((s) => delete s.value)), [false, 'E_ENVELOPE']);
  // The echo compares canonical JSON: member order and whitespace do not matter.
  assert.equal(mutate((s) => (s.overrides = s.overrides.map((o) => ({ value: o.value, cell: o.cell })))).ok, true);
  // When no asof was sent, any instant is accepted; when one was sent it must be equal.
  assert.equal(env(byId['envelope/scenario-no-asof-sent']).ok, true);
  const noAsof = byId['envelope/scenario-no-asof-sent'];
  assert.equal(env(noAsof, noAsof.input, 200, { ...noAsof.request, asof: '2024-03-17T00:00:00.000000Z' }).code, 'E_ENVELOPE');
});

test('scenario outcome: only with overrides in the request; ok, stale and pending are then refused', () => {
  const noOverrides = { ...S.request };
  delete noOverrides.overrides;
  const a = env(S, S.input, 200, noOverrides);
  assert.deepEqual([a.ok, a.code, a.kind], [false, 'E_ENVELOPE', null]);
  const emptyOverrides = env(S, S.input, 200, { ...S.request, overrides: [] });
  assert.equal(emptyOverrides.code, 'E_ENVELOPE'); // an empty array is not the echo of two overrides
  // ok with overrides in the request.
  for (const id of ['invalid/envelope-ok-with-overrides', 'invalid/envelope-stale-with-overrides']) {
    const v = byId[id];
    assert.ok(v.request.overrides, id);
    const r = env(v);
    assert.deepEqual([r.ok, r.code], [false, 'E_ENVELOPE'], id);
  }
});

test('scenario is not an answer of the slice endpoint (E_ENVELOPE)', () => {
  const page = checkSlicePage(200, S.input, receiptKeys(lib, S), { slice_id: 'a'.repeat(64) });
  assert.equal(page.ok, false);
  assert.equal(page.code, 'E_ENVELOPE');
});

test('other outcomes at whatif: not_covered, bad_request with the whatif and override codes', () => {
  const nc = byId['envelope/scenario-not-covered'];
  assert.equal(env(nc).ok, true);
  const bad = (error, status = 400) => env(S, JSON.stringify({ outcome: 'bad_request', error }), status);
  for (const code of ['E_WHATIF_UNSUPPORTED', 'E_CANON_ARG_DUPLICATE', 'E_CANON_TYPE', 'E_SLICE_MEMBER']) {
    const r = bad(code);
    assert.equal(r.ok, true, `${code}: ${r.detail}`);
    assert.equal(r.outcome, 'bad_request');
    assert.equal(r.error, code);
    assert.equal(r.kind, null);
  }
  const nosol = env(S, JSON.stringify({ outcome: 'not_covered', fault: 'E_WHATIF_NO_SOLUTION' }), 404);
  assert.equal(nosol.ok, true, nosol.detail);
  assert.equal(nosol.outcome, 'not_covered');
  assert.equal(nosol.fault, 'E_WHATIF_NO_SOLUTION');
  assert.equal(nosol.error, null);
  const wrong = env(S, JSON.stringify({ outcome: 'not_covered', fault: 'E_WHATIF_UNSUPPORTED' }), 404);
  assert.equal(wrong.code, 'E_ENVELOPE'); // not a fault
});

test('every new envelope vector conforms and the invalid ones give E_ENVELOPE', async () => {
  const invalid = ids('envelope', false);
  assert.equal(invalid.length, 27);
  for (const id of invalid) assert.equal(byId[id].error, 'E_ENVELOPE', id);
  await conforms(ids('envelope'));
});

// ------------------------------------------------------------------------------------------
// Envelopes: cycle on error (C6)
// ------------------------------------------------------------------------------------------

test('error with E_EVAL_UNAVAILABLE may carry a cycle: its path and fixes are exposed', () => {
  const v = byId['envelope/error-cycle'];
  const r = env(v);
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.outcome, 'error');
  assert.equal(r.error, 'E_EVAL_UNAVAILABLE');
  assert.equal(r.kind, null);
  assert.deepEqual(r.cycle, JSON.parse(v.input).cycle);
  assert.deepEqual(Object.keys(r.cycle).sort(), ['fixes', 'path']);
  assert.ok(r.cycle.path.length >= 2);
  assert.equal(r.cycle.path[0], r.cycle.path[r.cycle.path.length - 1]);
  const all4 = env(byId['envelope/error-cycle-all-fixes']);
  assert.deepEqual(all4.cycle.fixes, ['asof', 'lag', 'step', 'solver']);
  const self = env(byId['envelope/error-cycle-self']);
  assert.equal(self.cycle.path.length, 2);
  assert.equal(self.cycle.path[0], self.cycle.path[1]);
});

test('an error envelope without cycle has cycle null', () => {
  const r = env(S, JSON.stringify({ outcome: 'error', error: 'E_EVAL_UNAVAILABLE' }), 503);
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.cycle, null);
});

test('cycle rules: at least 2 calls, first equals last, fixes distinct, non-empty, in order asof lag step solver', () => {
  const base = JSON.parse(byId['envelope/error-cycle'].input);
  const check = (f, status = 503) => {
    const b = clone(base);
    f(b);
    return env(byId['envelope/error-cycle'], JSON.stringify(b), status).code;
  };
  assert.equal(check(() => {}), 'OK');
  assert.equal(check((b) => (b.cycle.path = ['a/f()'])), 'E_ENVELOPE'); // a path of 1
  assert.equal(check((b) => (b.cycle.path = [])), 'E_ENVELOPE');
  assert.equal(check((b) => b.cycle.path.pop()), 'E_ENVELOPE'); // ends differ
  assert.equal(check((b) => (b.cycle.path[2] = 'calc.example.net/other()')), 'E_ENVELOPE');
  assert.equal(check((b) => (b.cycle.path[1] = 7)), 'E_ENVELOPE');
  assert.equal(check((b) => (b.cycle.fixes = [])), 'E_ENVELOPE');
  assert.equal(check((b) => (b.cycle.fixes = ['lag', 'asof'])), 'E_ENVELOPE');
  assert.equal(check((b) => (b.cycle.fixes = ['asof', 'asof'])), 'E_ENVELOPE');
  assert.equal(check((b) => (b.cycle.fixes = ['retry'])), 'E_ENVELOPE');
  assert.equal(check((b) => (b.cycle.fixes = ['solver'])), 'OK');
  assert.equal(check((b) => (b.cycle.extra = 1)), 'E_ENVELOPE');
  assert.equal(check((b) => delete b.cycle.fixes), 'E_ENVELOPE');
  assert.equal(check((b) => delete b.cycle.path), 'E_ENVELOPE');
  assert.equal(check((b) => (b.cycle = [])), 'E_ENVELOPE');
  assert.equal(check((b) => (b.error = 'E_INPUT_UNAVAILABLE')), 'E_ENVELOPE'); // cycle only with E_EVAL_UNAVAILABLE
  assert.equal(check((b) => ((b.outcome = 'not_covered'), delete b.error), 404), 'E_ENVELOPE');
});

// ------------------------------------------------------------------------------------------
// describe (item 4, C7)
// ------------------------------------------------------------------------------------------

const D = (id) => byId[id];

test('a function answer: kind function, with fn, hash, tests and source', () => {
  const v = D('describe/function-tests-source');
  const r = checkDescribe(v.input, v.classes, v.functions);
  assert.equal(r.kind, 'function');
  assert.equal(r.fn, 'rates.example.org/fx_rate');
  assert.equal(r.fnHash, '7b58ecb8fd23b644c87951d0bd609790ff547cbb23fed27186c669ce2ce0aa80');
  assert.deepEqual(r.tests, { count: 7, branches: 4, covered: 3, counterexamples: 0 });
  assert.deepEqual(r.source, { name: 'bank.example.com', relayed_by: 'rates.example.org', takeover: 'https://bank.example.com/publish/takeover' });
});

test('a minimal function answer has tests and source null; with or without the descriptor held', () => {
  for (const id of ['describe/function-minimal', 'describe/function-not-held']) {
    const v = D(id);
    const r = checkDescribe(v.input, v.classes, v.functions);
    assert.equal(r.kind, 'function', id);
    assert.equal(r.tests, null, id);
    assert.equal(r.source, null, id);
    assert.equal(r.fnHash.length, 64);
  }
  assert.equal(D('describe/function-not-held').functions, undefined);
});

test('class and object describe answers still return their kind', () => {
  const cls = all.find((v) => v.kind === 'describe' && v.valid && !isNew(v) && JSON.parse(v.input).kind === 'class');
  assert.equal(checkDescribe(cls.input, cls.classes, cls.functions).kind, 'class');
});

test('with the descriptor held, args and returns must agree with it; each failure is E_DESCRIBE', () => {
  const v = D('describe/function-tests-source');
  const base = JSON.parse(v.input);
  const code = (f, held = v.functions) => {
    const a = clone(base);
    f(a);
    return codeOf(() => checkDescribe(JSON.stringify(a), v.classes, held));
  };
  assert.equal(code(() => {}), 'OK');
  assert.equal(code((a) => delete a.args.quote), 'E_DESCRIBE');
  assert.equal(code((a) => (a.args.extra = { type: 'string', valid: false })), 'E_DESCRIBE');
  assert.equal(code((a) => (a.args.date.type = 'instant')), 'E_DESCRIBE');
  assert.equal(code((a) => (a.args.date.valid = false)), 'E_DESCRIBE');
  assert.equal(code((a) => (a.returns.type = 'string')), 'E_DESCRIBE');
  // The same disagreements pass when the descriptor is not held (shape only).
  assert.equal(code((a) => delete a.args.quote, undefined), 'OK');
  assert.equal(code((a) => (a.returns.type = 'string'), undefined), 'OK');
  // A held descriptor that is not the one of fn_hash (its hash differs) is not checked against.
  const other = clone(v.functions);
  other[0].signature.returns.type = 'string';
  assert.equal(code(() => {}, other), 'OK');
});

test('function answer shape: exactly kind, fn, fn_hash, args, returns (+ description, tests, source)', () => {
  const v = D('describe/function-tests-source');
  const base = JSON.parse(v.input);
  const code = (f) => {
    const a = clone(base);
    f(a);
    return codeOf(() => checkDescribe(JSON.stringify(a), v.classes, undefined));
  };
  assert.equal(code(() => {}), 'OK');
  assert.equal(code((a) => (a.extra = 1)), 'E_DESCRIBE');
  for (const k of ['kind', 'fn', 'fn_hash', 'args', 'returns']) assert.equal(code((a) => delete a[k]), 'E_DESCRIBE', k);
  assert.equal(code((a) => delete a.description), 'OK');
  assert.equal(code((a) => delete a.tests), 'OK');
  assert.equal(code((a) => delete a.source), 'OK');
  assert.equal(code((a) => (a.fn_hash = a.fn_hash.toUpperCase())), 'E_DESCRIBE');
  assert.equal(code((a) => (a.fn_hash = 'ab')), 'E_DESCRIBE');
  assert.equal(code((a) => (a.fn = 'Not A Name')), 'E_DESCRIBE');
  assert.equal(code((a) => (a.description = '')), 'E_DESCRIBE');
  assert.equal(code((a) => (a.description = 'x'.repeat(1025))), 'E_DESCRIBE');
  assert.equal(code((a) => (a.description = 'x'.repeat(1024))), 'OK');
});

test('tests: integers by 5.5, covered <= branches, exactly four members', () => {
  const v = D('describe/function-tests-source');
  const base = JSON.parse(v.input);
  const withTests = (t) => {
    const a = clone(base);
    a.tests = t;
    return codeOf(() => checkDescribe(JSON.stringify(a), v.classes, undefined));
  };
  assert.equal(withTests({ count: 7, branches: 4, covered: 4, counterexamples: 0 }), 'OK');
  assert.equal(withTests({ count: 7, branches: 4, covered: 5, counterexamples: 0 }), 'E_DESCRIBE');
  assert.equal(withTests({ count: -1, branches: 4, covered: 3, counterexamples: 0 }), 'E_DESCRIBE');
  assert.equal(withTests({ count: 7, branches: 4, covered: 3 }), 'E_DESCRIBE');
  assert.equal(withTests({ count: 7, branches: 4, covered: 3, counterexamples: 0, extra: 1 }), 'E_DESCRIBE');
  assert.equal(withTests({ count: '7', branches: 4, covered: 3, counterexamples: 0 }), 'E_DESCRIBE');
  // A count written 1.0 or 1e0 in the JSON text is not an integer by 5.5, though it is the number 1.
  for (const lexical of ['1.0', '1e0', '1E0', '10e-1']) {
    const text = JSON.stringify(base).replace('"count":7', `"count":${lexical}`);
    assert.ok(text.includes(`"count":${lexical}`));
    assert.equal(codeOf(() => checkDescribe(text, v.classes, undefined)), 'E_DESCRIBE', lexical);
  }
});

test('source of a relayed function: name (DNS), relayed_by (the mesh host) and takeover (https), all required', () => {
  const v = D('describe/function-tests-source');
  const base = JSON.parse(v.input);
  const code = (f) => {
    const a = clone(base);
    f(a.source);
    return codeOf(() => checkDescribe(JSON.stringify(a), v.classes, undefined));
  };
  assert.equal(code(() => {}), 'OK');
  assert.equal(code((s) => delete s.takeover), 'E_DESCRIBE');
  assert.equal(code((s) => delete s.name), 'E_DESCRIBE');
  assert.equal(code((s) => delete s.relayed_by), 'E_DESCRIBE');
  assert.equal(code((s) => (s.takeover = 'http://bank.example.com/t')), 'E_DESCRIBE');
  assert.equal(code((s) => (s.name = 'Not A Name')), 'E_DESCRIBE');
  assert.equal(code((s) => (s.relayed_by = 'not a host')), 'E_DESCRIBE');
  assert.equal(code((s) => (s.extra = 1)), 'E_DESCRIBE');
});

test('the describe vectors conform: 6 valid and 16 invalid, every invalid one E_DESCRIBE', async () => {
  assert.equal(ids('describe', true).length, 6);
  assert.equal(ids('describe', false).length, 16);
  for (const id of ids('describe', false)) assert.equal(byId[id].error, 'E_DESCRIBE', id);
  await conforms(ids('describe'));
});

test('class answers: method entries may carry tests and source (checked with E_DESCRIBE)', async () => {
  // The class vectors with tests/source in a method entry are in the new describe vectors; check that one exists and conforms.
  const withMethodTests = all.filter((v) => v.kind === 'describe' && isNew(v) && v.valid && JSON.parse(v.input).kind === 'class');
  assert.ok(withMethodTests.length >= 1);
  for (const v of withMethodTests) {
    const methods = Object.values(JSON.parse(v.input).methods);
    assert.ok(methods.some((m) => m.tests !== undefined || m.source !== undefined), v.id);
    assert.equal(checkDescribe(v.input, v.classes, v.functions).kind, 'class');
  }
});

// ------------------------------------------------------------------------------------------
// Mesh document: whatif (item 5)
// ------------------------------------------------------------------------------------------

test('whatif is an optional endpoint with no placeholders', () => {
  assert.deepEqual(lib.MESH_ENDPOINTS.whatif, { placeholders: [], required: false });
  assert.deepEqual(cjs.MESH_ENDPOINTS.whatif, { placeholders: [], required: false });
});

test('a mesh document with a whatif endpoint resolves and keeps it; a placeholder in it is E_MESH_DOC', async () => {
  for (const id of ['mesh/whatif', 'mesh/whatif-required-only']) {
    const v = byId[id];
    const r = resolveMesh(v.host, { keys: responseOf(v.env.keys), mesh: responseOf(v.env.mesh) });
    assert.equal(r.ok, true, `${id}: ${r.detail}`);
    assert.deepEqual(r.endpoints, v.endpoints, id);
  }
  const r = resolveMesh('mesh.example.org', { keys: responseOf(byId['mesh/whatif'].env.keys), mesh: responseOf(byId['mesh/whatif'].env.mesh) });
  assert.match(r.endpoints.whatif, /^https:\/\/mesh\.example\.org\//);
  assert.ok(!/[{}]/.test(r.endpoints.whatif));
  assert.deepEqual(ids('mesh', false).sort(), ['invalid/mesh-whatif-lone-brace', 'invalid/mesh-whatif-other-host', 'invalid/mesh-whatif-placeholder']);
  for (const id of ids('mesh', false)) {
    const v = byId[id];
    const bad = resolveMesh(v.host, { keys: responseOf(v.env.keys), mesh: responseOf(v.env.mesh) });
    assert.equal(bad.ok, false, id);
    assert.equal(bad.code, 'E_MESH_DOC', id);
  }
  await conforms(ids('mesh'));
});

test('a mesh document without whatif has no whatif in its endpoints', () => {
  const v = all.find((x) => x.kind === 'mesh' && x.valid && !isNew(x));
  const r = resolveMesh(v.host, { keys: responseOf(v.env.keys), mesh: responseOf(v.env.mesh) });
  assert.equal(r.ok, true);
  assert.ok(!('whatif' in r.endpoints));
});

// ------------------------------------------------------------------------------------------
// TypeScript types
// ------------------------------------------------------------------------------------------

function typecheck(source) {
  const dir = mkdtempSync(join(tmpdir(), 'datumesh-types-'));
  try {
    const file = join(dir, 'check.ts');
    writeFileSync(file, source.replace('__LIB__', join(root, 'dist', 'esm', 'index.js').replace(/\.js$/, '')));
    const program = ts.createProgram([file], { noEmit: true, strict: true, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020, moduleResolution: ts.ModuleResolutionKind.NodeJs, skipLibCheck: true, types: [] });
    return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('types: Trust, ErrorCode, Fault, EnvelopeRequest, EnvelopeResult, VerifyResult and DescribeResult carry the 0.6.0 members', () => {
  const diags = typecheck(`
import { checkEnvelope, verify, checkDescribe, MESH_ENDPOINTS, type Trust, type ErrorCode, type Fault, type EnvelopeRequest, type EnvelopeResult, type Scenario, type ScenarioOverride, type Cycle, type CycleFix, type SourceInfo, type DescribeResult } from '__LIB__';
const t: Trust = 'relayed';
const c1: ErrorCode = 'E_WHATIF_UNSUPPORTED';
const c2: ErrorCode = 'E_WHATIF_NO_SOLUTION';
const f: Fault = 'E_WHATIF_NO_SOLUTION';
const req: EnvelopeRequest = { cell_id: 'a', asof: 'x', overrides: [], solve: 'b' };
declare const r: EnvelopeResult;
const kind: 'receipt' | 'scenario' | null = r.kind;
const sc: Scenario | null = r.scenario;
const cy: Cycle | null = r.cycle;
const fixes: CycleFix[] | undefined = cy?.fixes;
const path: string[] | undefined = cy?.path;
if (sc) {
  const v: string = sc.value;
  const ty: string = sc.type;
  const asof: string = sc.asof;
  const ov: ScenarioOverride[] = sc.overrides;
  const vary = sc.solved?.vary;
  const solvedValue = sc.solved?.value.value;
}
declare const vr: ReturnType<typeof verify>;
const src: SourceInfo | null = vr.source;
const name: string | undefined = src?.name;
const takeover: string | undefined = src?.takeover;
declare const d: DescribeResult;
if (d.kind === 'function') {
  const fnHash: string = d.fnHash;
  const n: number | undefined = d.tests?.count;
}
const w: boolean = MESH_ENDPOINTS.whatif.required;
export { t, c1, c2, f, req, kind, sc, cy, fixes, path, src, name, takeover, w };
`);
  assert.deepEqual(diags, []);
});

test('types: a Scenario cannot be used as a verified receipt (no receipt, receiptHash, trust)', () => {
  const diags = typecheck(`
import { type Scenario } from '__LIB__';
declare const s: Scenario;
// @ts-expect-error a scenario has no trust
const a = s.trust;
// @ts-expect-error a scenario has no receipt hash
const b = s.receiptHash;
// @ts-expect-error a scenario has no receipt
const c = s.receipt;
export { a, b, c };
`);
  assert.deepEqual(diags, []);
});

test('types: a checked scenario is told from a receipt by the kind discriminant', () => {
  const diags = typecheck(`
import { type EnvelopeResult } from '__LIB__';
declare const r: EnvelopeResult;
if (r.ok && r.kind === 'scenario') {
  const s = r.scenario;
  // @ts-expect-error a scenario result is never null once kind is scenario
  const n: null = r.scenario;
  const hash: null = r.receiptHash;
  const trust: null = r.trust;
  void s; void n; void hash; void trust;
}
`);
  assert.deepEqual(diags, []);
});
