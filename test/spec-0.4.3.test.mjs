// What spec-0.4.3 changes for a verifier library (SPEC 14 spec-0.4.3: licence inheritance (8.5),
// `declarations` in the key document (9.2, 4.5), the entitlement check (10.3), unrooted
// namespaces (2.5), E_FOREIGN_UNAVAILABLE with `detail` (5.5, 10.2)), through the public API. The
// vectors run in test/conformance.test.mjs; these tests pin the result shapes and the caller's
// errors, and compare the library with the reference tool on
// test/fixtures/oracle-probes-0.4.3.jsonl.gz (tools/oracle-diff/probes_0_4_3.py, canon.py as a
// black box) where SPEC.md leaves a case to the implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as lib from '../dist/esm/index.js';
import * as cjs from '../dist/cjs/index.js';
import { makeRunner } from '../tools/vector-runner.mjs';
import { root, vector } from './helpers.mjs';

const { keysFromResponse, keysFromDocument, verify, checkEnvelope, checkBatch, resolveMesh, inheritLicence, checkEntitlement, inputLicences, isUnrooted, licenceTier, receiptHash, ERROR_CODES, FOREIGN_DETAILS, DatumeshError } = lib;
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
const T0 = '2024-03-16T09:00:00.000000Z';
const URL1 = 'https://rates.example.org/licences/restricted';
const URL2 = 'https://other.example.org/licence';
const FN = 'calc.example.net/convert';
const decl = (entries) => ({ [FN]: entries });

test('versions name spec-0.4.3 and 0.4.3', () => {
  assert.equal(lib.SPEC_VERSION, 'spec-0.4.3');
  assert.equal(lib.VERSION, '0.4.3');
  assert.equal(cjs.VERSION, '0.4.3');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.4.3');
  assert.equal(pkg.datumesh.spec, 'spec-0.4.3');
});

test('ERROR_CODES: E_FOREIGN_UNAVAILABLE last, after E_NAME_UNBOUND (SPEC 10.2)', () => {
  assert.deepEqual(ERROR_CODES.slice(-2), ['E_NAME_UNBOUND', 'E_FOREIGN_UNAVAILABLE']);
  assert.equal(ERROR_CODES.length, 49);
  assert.deepEqual([...FOREIGN_DETAILS], ['offline', 'network', 'dns', 'tls', 'timeout', 'refused']);
});

test('the library agrees with the reference tool on every spec-0.4.3 probe', async () => {
  const lines = gunzipSync(readFileSync(join(root, 'test', 'fixtures', 'oracle-probes-0.4.3.jsonl.gz'))).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.length >= 160, `${lines.length} probes`);
  const run = makeRunner(lib, (b) => createHash('sha256').update(b).digest('hex'));
  const diffs = [];
  for (const { vector: v, oracle } of lines) {
    const got = await run(v);
    // A licence probe's oracle is the reference's {licence, reason}, an entitlement probe's
    // {entitled, reason}; every other probe's, its code ("success" when accepted).
    const mine = got.error ?? (v.kind === 'licence' ? JSON.stringify({ licence: got.licence, reason: got.reason }) : v.kind === 'entitlement' ? JSON.stringify({ entitled: got.entitled, reason: got.reason }) : 'success');
    // The reference's JSON is Python's (spaced): compare the values.
    const norm = (x) => (x.startsWith('{') ? JSON.stringify(JSON.parse(x)) : x);
    if (norm(mine) !== norm(oracle)) diffs.push(`${v.id}: reference ${oracle}, library ${mine}`);
  }
  assert.deepEqual(diffs, []);
});

test('9.2: declarations are parsed, exposed as given, and change nothing in verification', () => {
  const v = vector('keys/declarations');
  const r = keysFromResponse(v.host, v.env.https.status, v.env.https.body);
  assert.deepEqual([r.ok, r.code], [true, 'OK']);
  assert.deepEqual(r.declarations, v.declarations);
  assert.deepEqual(r.keys.map((k) => k.id), v.key_ids);
  // A document without declarations has no declarations member at all.
  const plain = vector('keys/https-document');
  assert.equal(Object.prototype.hasOwnProperty.call(keysFromResponse(plain.host, 200, plain.env.https.body), 'declarations'), false);
  // keysFromDocument takes the parsed document the same way.
  const d = keysFromDocument(JSON.parse(v.env.https.body));
  assert.deepEqual(d.declarations, v.declarations);
  // receipt/keydoc-declarations: the same receipt verifies identically with and without them.
  const rv = vector('receipt/keydoc-declarations');
  const withDecl = verify(rv.input, keysOf(rv));
  const docs = Object.entries(rv.keys).map(([h, e]) => {
    const o = JSON.parse(e.https.body);
    delete o.declarations;
    return keysFromResponse(h, 200, JSON.stringify(o));
  });
  const without = verify(rv.input, docs);
  assert.deepEqual([withDecl.ok, withDecl.code, withDecl.hash, withDecl.level], [without.ok, without.code, without.hash, without.level]);
  assert.equal(withDecl.ok, true);
  // A raw key document with declarations is a key source for verify as well.
  assert.equal(verify(rv.input, Object.values(rv.keys).map((e) => JSON.parse(e.https.body))).ok, true);
});

test('9.2: anything malformed in declarations rejects the whole document with E_KEY_DOC', () => {
  const v = vector('keys/declarations');
  const base = JSON.parse(v.env.https.body);
  const host = v.host;
  const entry = { licence: URL1, valid_from: '2020-01-01T00:00:00.000000Z' };
  const code = (declarations) => keysFromResponse(host, 200, JSON.stringify({ ...base, declarations })).code;
  const name = `${host}/f`;
  assert.equal(code({ [name]: [entry] }), 'OK');
  assert.equal(code({ [`${host}/a/b/f`]: [entry] }), 'OK'); // a path namespace under the host
  const bad = {
    'not an object': [],
    null: null,
    'a string': 'x',
    '{}': {},
    'subdomain': { [`sub.${host}/f`]: [entry] },
    'parent domain': { ['example.org/f']: [entry] },
    'another host': { ['calc.example.net/f']: [entry] },
    'bare host': { [host]: [entry] },
    'uppercase name': { [`${host}/F`]: [entry] },
    'empty array': { [name]: [] },
    'not an array': { [name]: entry },
    'entry not an object': { [name]: ['x'] },
    'missing licence': { [name]: [{ valid_from: entry.valid_from }] },
    'missing valid_from': { [name]: [{ licence: URL1 }] },
    'extra member': { [name]: [{ ...entry, note: 'x' }] },
    'licence not a string': { [name]: [{ ...entry, licence: 5 }] },
    'bad licence': { [name]: [{ ...entry, licence: 'MIT License' }] },
    'licence URL too long': { [name]: [{ ...entry, licence: `https://${'a'.repeat(505)}` }] },
    'bad instant': { [name]: [{ ...entry, valid_from: '2020-01-01T00:00:00Z' }] },
    'valid_to equal': { [name]: [{ ...entry, valid_to: entry.valid_from }] },
    'valid_to null': { [name]: [{ ...entry, valid_to: null }] },
    '17 entries': { [name]: Array(17).fill(entry) },
    '65 names': Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`${host}/f${i}`, [entry]])),
  };
  for (const [what, d] of Object.entries(bad)) assert.equal(code(d), 'E_KEY_DOC', what);
  assert.equal(code({ [name]: Array(16).fill(entry) }), 'OK');
  assert.equal(code(Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`${host}/f${i}`, [entry]]))), 'OK');
  // Still no other member (9.2).
  assert.equal(keysFromResponse(host, 200, JSON.stringify({ ...base, declaration: {} })).code, 'E_KEY_DOC');
  // 9.6 step 5 checks declarations with the rest of the key document.
  const m = vector('mesh/keydoc-declarations');
  const ok = resolveMesh(m.host, { keys: { status: 200, body: m.env.keys.https.body }, mesh: { status: 200, body: m.env.mesh.https.body } });
  assert.equal(ok.ok, true);
  const k = JSON.parse(m.env.keys.https.body);
  k.declarations = {};
  assert.equal(resolveMesh(m.host, { keys: { status: 200, body: JSON.stringify(k) }, mesh: { status: 200, body: m.env.mesh.https.body } }).code, 'E_KEY_DOC');
});

test('8.5 licenceTier: three open tiers in order, everything else restricted (byte for byte)', () => {
  const tiers = { 'CC0-1.0': 1, 'PDDL-1.0': 1, MIT: 2, 'Apache-2.0': 2, 'CC-BY-4.0': 2, 'OGL-UK-3.0': 2, 'CC-BY-SA-4.0': 3, 'ODbL-1.0': 3, 'CC-BY-NC-4.0': 4, 'cc0-1.0': 4, 'mit': 4, [URL1]: 4 };
  for (const [l, t] of Object.entries(tiers)) assert.equal(licenceTier(l), t, l);
  assert.equal(codeOf(() => licenceTier('MIT License')), 'E_CANON_LICENCE');
  assert.throws(() => licenceTier(5), TypeError);
});

test('8.5 inheritLicence: the five steps in order', () => {
  const I = (L, D = null, meshLicence = 'CC-BY-4.0', issued = T0) => inheritLicence(L, D, FN, issued, meshLicence);
  assert.deepEqual(I([]), { licence: 'CC-BY-4.0', reason: 'no_inputs' });
  assert.deepEqual(I([], null, URL1), { licence: URL1, reason: 'no_inputs' });
  assert.deepEqual(I(['MIT', 'CC0-1.0', 'CC-BY-4.0']), { licence: 'CC-BY-4.0', reason: 'open' });
  assert.deepEqual(I(['OGL-UK-3.0', 'CC-BY-4.0']), { licence: 'OGL-UK-3.0', reason: 'open' });
  assert.deepEqual(I(['PDDL-1.0', 'CC0-1.0']), { licence: 'PDDL-1.0', reason: 'open' });
  assert.deepEqual(I(['ODbL-1.0', 'MIT', 'ODbL-1.0']), { licence: 'ODbL-1.0', reason: 'open' });
  // Step 2 before every restricted outcome, declared or not.
  const open = decl([{ licence: URL1, valid_from: '2020-01-01T00:00:00.000000Z' }]);
  assert.deepEqual(I(['ODbL-1.0', 'CC-BY-SA-4.0']), { licence: null, reason: 'share_alike_conflict' });
  assert.deepEqual(I(['ODbL-1.0', URL1], open), { licence: null, reason: 'share_alike_conflict' });
  assert.deepEqual(I(['ODbL-1.0', URL1, URL2], open), { licence: null, reason: 'share_alike_conflict' });
  // Step 3 before step 4.
  assert.deepEqual(I([URL1, URL2], { [FN]: [open[FN][0], { licence: URL2, valid_from: open[FN][0].valid_from }] }), { licence: null, reason: 'restricted_conflict' });
  assert.deepEqual(I([URL1, URL2]), { licence: null, reason: 'restricted_conflict' });
  // Step 4.
  assert.deepEqual(I([URL1, 'MIT', URL1], open), { licence: URL1, reason: 'declared' });
  assert.deepEqual(I([URL1]), { licence: null, reason: 'not_declared' });
  assert.deepEqual(I([URL1], { 'calc.example.net/other': open[FN] }), { licence: null, reason: 'not_declared' });
  assert.deepEqual(I([URL1], decl([{ licence: URL2, valid_from: '2020-01-01T00:00:00.000000Z' }])), { licence: null, reason: 'not_declared' });
  const closed = decl([{ licence: URL1, valid_from: '2020-01-01T00:00:00.000000Z', valid_to: T0 }]);
  assert.deepEqual(I([URL1], closed), { licence: null, reason: 'declaration_not_open' }); // valid_to is exclusive
  assert.deepEqual(I([URL1], decl([{ licence: URL1, valid_from: T0 }])), { licence: URL1, reason: 'declared' }); // valid_from inclusive
  assert.deepEqual(I([URL1], decl([{ licence: URL1, valid_from: '2024-03-16T09:00:00.000001Z' }])), { licence: null, reason: 'declaration_not_open' });
  assert.deepEqual(I([URL1], decl([...closed[FN], { licence: URL1, valid_from: '2024-03-16T08:00:00.000000Z' }])), { licence: URL1, reason: 'declared' });
  // {} and null and undefined are all "no declarations".
  for (const none of [{}, null, undefined]) assert.deepEqual(I([URL1], none), { licence: null, reason: 'not_declared' });
});

test('8.5 inheritLicence: malformed arguments', () => {
  assert.throws(() => inheritLicence('MIT', null, FN, T0, 'MIT'), TypeError);
  assert.throws(() => inheritLicence([5], null, FN, T0, 'MIT'), TypeError);
  assert.throws(() => inheritLicence(['MIT'], [], FN, T0, 'MIT'), TypeError);
  assert.throws(() => inheritLicence(['MIT'], { [FN]: 'x' }, FN, T0, 'MIT'), TypeError);
  assert.throws(() => inheritLicence(['MIT'], { [FN]: [{ licence: 5, valid_from: T0 }] }, FN, T0, 'MIT'), TypeError);
  assert.equal(codeOf(() => inheritLicence(['MIT License'], null, FN, T0, 'MIT')), 'E_CANON_LICENCE');
  assert.equal(codeOf(() => inheritLicence(['MIT'], null, 'convert', T0, 'MIT')), 'E_CANON_NAME');
  assert.equal(codeOf(() => inheritLicence(['MIT'], null, FN, '2024-03-16', 'MIT')), 'E_CANON_INSTANT');
  assert.equal(codeOf(() => inheritLicence([], null, FN, T0, '')), 'E_CANON_LICENCE');
});

test('10.3 checkEntitlement and inputLicences: the vectors through the API; K of another host is the caller\'s error', () => {
  for (const id of ['entitlement/restricted-declared', 'entitlement/slice-members', 'entitlement/stored-no-inputs', 'entitlement/licence-mismatch']) {
    const v = vector(id);
    const ks = keysOf(v);
    const R = JSON.parse(v.input);
    const L = inputLicences(v.input, v.receipts ?? {}, v.manifests ?? {}, ks);
    assert.deepEqual(L, inputLicences(R, v.receipts ?? {}, v.manifests ?? {}), id); // keys optional
    const host = R.cell.ns.split('/')[0];
    const K = ks.find((k) => k.host === host);
    const e = checkEntitlement(v.input, L, K);
    assert.deepEqual([e.entitled, e.reason], [v.entitled, v.reason], id);
    // K as the parsed document and as its JSON text, too.
    const body = v.keys[host].https.body;
    assert.deepEqual(checkEntitlement(R, L, JSON.parse(body)), e, id);
    assert.deepEqual(checkEntitlement(R, L, body), e, id);
    const other = ks.find((k) => k.host !== host);
    assert.throws(() => checkEntitlement(R, L, other), TypeError, id);
  }
  const v = vector('entitlement/slice-members');
  // In manifest order: one licence per member receipt.
  const members = JSON.parse(Object.values(v.manifests)[0]).members;
  assert.deepEqual(inputLicences(v.input, v.receipts, v.manifests), members.map((h) => JSON.parse(v.receipts[h]).licence));
  assert.deepEqual(inputLicences(v.input, v.receipts, v.manifests).sort(), ['CC-BY-SA-4.0', 'CC0-1.0']);
  const e = checkEntitlement(v.input, ['CC0-1.0', 'CC-BY-SA-4.0'], keysOf(v).find((k) => k.host === 'calc.example.net'));
  assert.deepEqual(e, { entitled: true, reason: 'open', licence: 'CC-BY-SA-4.0' });
  // A refusal has no licence; a mismatch names the licence the rule gives.
  const m = vector('entitlement/licence-mismatch');
  assert.deepEqual(checkEntitlement(m.input, ['CC-BY-4.0'], keysOf(m).find((k) => k.host === 'calc.example.net')), { entitled: false, reason: 'licence_mismatch', licence: 'CC-BY-4.0' });
  const s = vector('entitlement/share-alike-conflict');
  assert.deepEqual(checkEntitlement(s.input, ['CC-BY-SA-4.0', 'ODbL-1.0'], keysOf(s).find((k) => k.host === 'calc.example.net')), { entitled: false, reason: 'share_alike_conflict', licence: null });
  // A K that failed its checks, or is not a key document at all, is the caller's error too.
  const K = keysOf(m).find((k) => k.host === 'calc.example.net');
  assert.throws(() => checkEntitlement(m.input, ['CC-BY-4.0'], { ok: false, code: 'E_KEY_UNAVAILABLE', host: 'calc.example.net', detail: '' }), TypeError);
  assert.throws(() => checkEntitlement(m.input, ['CC-BY-4.0'], { ...K, declarations: { 'calc.example.net/f': [] } }), TypeError);
  assert.throws(() => checkEntitlement(m.input, ['CC-BY-4.0'], { ...K, declarations: { 'other.example.net/f': [{ licence: 'X', valid_from: T0 }] } }), TypeError);
  assert.throws(() => checkEntitlement(m.input, ['CC-BY-4.0'], 5), TypeError);
  assert.throws(() => checkEntitlement(m.input, 'CC-BY-4.0', K), TypeError);
  // L for a receipt without inputs must be empty.
  const st = vector('entitlement/stored-no-inputs');
  assert.throws(() => checkEntitlement(st.input, ['MIT'], keysOf(st).find((k) => k.host === 'rates.example.org')), TypeError);
  // R must be a receipt.
  assert.equal(codeOf(() => checkEntitlement('{"x":1}', [], K)), 'E_SCHEMA');
});

test('10.3 inputLicences: what is missing or does not hash is E_INPUT_UNAVAILABLE; a bad input E_INPUT_INVALID', () => {
  const v = vector('entitlement/open-inherited');
  const [h] = JSON.parse(v.input).inputs;
  assert.equal(codeOf(() => inputLicences(v.input, {}, {})), 'E_INPUT_UNAVAILABLE');
  const other = vector('entitlement/restricted-declared');
  const otherText = Object.values(other.receipts)[0];
  assert.notEqual(receiptHash(otherText), h);
  assert.equal(codeOf(() => inputLicences(v.input, { [h]: otherText }, {})), 'E_INPUT_UNAVAILABLE');
  const tampered = JSON.parse(v.receipts[h]);
  tampered.sig = '0'.repeat(128);
  assert.equal(codeOf(() => inputLicences(v.input, { [h]: JSON.stringify(tampered) }, {})), 'OK'); // same hash: sig is not hashed
  assert.equal(codeOf(() => inputLicences(v.input, { [h]: JSON.stringify(tampered) }, {}, keysOf(v))), 'E_INPUT_INVALID');
  assert.equal(codeOf(() => inputLicences(v.input, { [h]: '{' }, {})), 'E_INPUT_INVALID');
  const s = vector('entitlement/slice-members');
  const [entry] = JSON.parse(s.input).inputs;
  assert.equal(codeOf(() => inputLicences(s.input, s.receipts, {})), 'E_INPUT_UNAVAILABLE');
  const man = JSON.parse(s.manifests[entry]);
  assert.equal(codeOf(() => inputLicences(s.input, s.receipts, { [entry]: JSON.stringify({ ...man, members: man.members.slice(1) }) })), 'E_INPUT_UNAVAILABLE');
  const [m0] = man.members;
  const rest = { ...s.receipts };
  delete rest[m0];
  assert.equal(codeOf(() => inputLicences(s.input, rest, s.manifests)), 'E_INPUT_UNAVAILABLE');
  assert.throws(() => inputLicences(s.input, 'x', {}), TypeError);
  assert.throws(() => inputLicences(s.input, {}, []), TypeError);
});

test('2.5 isUnrooted: a namespace or host whose host ends in the label invalid', () => {
  for (const s of ['local.invalid', 'agent-7.local.invalid', 'local.invalid/notes', 'a.invalid/x/y']) assert.equal(isUnrooted(s), true, s);
  for (const s of ['example.org', 'invalid.example.org', 'rates.example.org/stats', 'example.invalidx', 'mesh.example']) assert.equal(isUnrooted(s), false, s);
  for (const s of ['invalid', 'Local.invalid', 'local.invalid/', '', 'local.invalid#k']) assert.equal(codeOf(() => isUnrooted(s)), 'E_CANON_NAME', s);
  assert.throws(() => isUnrooted(5), TypeError);
  // 2.5: no grammar change; a cell under local.invalid canonicalises, and its receipt verifies with
  // the key document supplied (and not without it).
  const c = vector('cell/unrooted-namespace');
  assert.equal(codeOf(() => lib.canonicalize(c.input, 'cell')), 'OK');
  const r = vector('receipt/unrooted-key-supplied');
  assert.equal(verify(r.input, keysOf(r)).ok, true);
  assert.equal(verify(r.input, []).code, 'E_KEY_UNAVAILABLE');
});

test('5.5: E_FOREIGN_UNAVAILABLE is an error envelope with 502 and a detail; detail nowhere else', () => {
  const v = vector('envelope/error-foreign-unavailable-timeout');
  const r = checkEnvelope(v.status, v.input, [], v.request);
  assert.deepEqual([r.ok, r.outcome, r.foreignDetail], [true, 'error', 'timeout']);
  const req = v.request;
  const env = (o, status = 502) => checkEnvelope(status, JSON.stringify(o), [], req);
  for (const d of FOREIGN_DETAILS) assert.equal(env({ outcome: 'error', error: 'E_FOREIGN_UNAVAILABLE', detail: d }).foreignDetail, d);
  assert.equal(env({ outcome: 'error', error: 'E_FOREIGN_UNAVAILABLE' }).code, 'E_ENVELOPE');
  assert.equal(env({ outcome: 'error', error: 'E_FOREIGN_UNAVAILABLE', detail: 'Timeout' }).code, 'E_ENVELOPE');
  assert.equal(env({ outcome: 'error', error: 'E_FOREIGN_UNAVAILABLE', detail: 5 }).code, 'E_ENVELOPE');
  assert.equal(env({ outcome: 'error', error: 'E_FOREIGN_UNAVAILABLE', detail: 'dns' }, 500).code, 'E_ENVELOPE');
  assert.equal(env({ outcome: 'error', error: 'E_FOREIGN_UNAVAILABLE', detail: 'dns' }, 503).code, 'E_ENVELOPE');
  assert.equal(env({ outcome: 'error', error: 'E_INPUT_UNAVAILABLE', detail: 'dns' }).code, 'E_ENVELOPE');
  const plain = env({ outcome: 'error', error: 'E_INPUT_UNAVAILABLE' });
  assert.deepEqual([plain.ok, plain.foreignDetail], [true, null]);
  assert.equal(env({ outcome: 'not_covered', error: 'E_FOREIGN_UNAVAILABLE', detail: 'dns' }, 404).code, 'E_ENVELOPE');
  assert.equal(env({ outcome: 'bad_request', error: 'E_FOREIGN_UNAVAILABLE', detail: 'dns' }, 400).code, 'E_ENVELOPE');
  assert.equal(env({ outcome: 'unlicensed', detail: 'dns' }, 403).code, 'E_ENVELOPE');
  // With a pinned request the echo rule still holds for error envelopes.
  const PIN = '7b58ecb8fd23b644c87951d0bd609790ff547cbb23fed27186c669ce2ce0aa80';
  assert.equal(checkEnvelope(502, JSON.stringify({ outcome: 'error', error: 'E_FOREIGN_UNAVAILABLE', detail: 'dns' }), [], { ...req, fn_hash: PIN }).code, 'E_ENVELOPE');
  assert.equal(checkEnvelope(502, JSON.stringify({ outcome: 'error', error: 'E_FOREIGN_UNAVAILABLE', detail: 'dns', fn_hash: PIN }), [], { ...req, fn_hash: PIN }).foreignDetail, 'dns');
  // In a batch: an item's own status, and a refusal of the whole batch.
  const item = { envelope: { outcome: 'error', error: 'E_FOREIGN_UNAVAILABLE', detail: 'refused' }, status: 502 };
  const b = checkBatch(200, JSON.stringify([item, { ...item, status: 500 }]), [], [req, req]);
  assert.deepEqual(b.items.map((i) => (i.ok ? i.foreignDetail : i.code)), ['refused', 'E_ENVELOPE']);
  assert.deepEqual([checkBatch(502, JSON.stringify(item.envelope), [], [req]).outcome], ['error']);
  // Never a verification result.
  assert.ok(!ERROR_CODES.slice(0, -1).includes('E_FOREIGN_UNAVAILABLE'));
});
