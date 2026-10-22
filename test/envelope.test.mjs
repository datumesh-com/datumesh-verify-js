// Response envelopes (SPEC 5.5): every envelope vector through checkEnvelope; for each valid
// envelope vector, the same body with any other HTTP status fails with E_ENVELOPE; plus member
// rules, the order of the checks, and checkEnvelope never throwing for invalid input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import canonicalizeJcs from 'canonicalize';
import { checkEnvelope, keysFromResponse, ERROR_CODES } from '../dist/esm/index.js';
import { loadVectors, vector } from './helpers.mjs';

const envelopes = loadVectors().filter((v) => v.kind === 'envelope');
const keysOf = (v) => Object.entries(v.keys).map(([h, e]) => keysFromResponse(h, typeof e.https.status === 'number' ? e.https.status : null, e.https.body));
const STATUS = { ok: [200], stale: [200], not_covered: [404], unlicensed: [403], payment_required: [402], rate_limited: [429], bad_request: [400] };
const matches = (outcome, s) => (outcome === 'error' ? s >= 500 && s <= 599 : STATUS[outcome].includes(s));
const OTHER = [100, 199, 200, 201, 204, 301, 302, 304, 400, 401, 402, 403, 404, 409, 429, 499, 500, 502, 503, 599, 600, 0, 999];

test('there are envelope vectors for every outcome', () => {
  assert.equal(envelopes.length, 50);
  const outcomes = new Set(envelopes.filter((v) => v.valid).map((v) => v.outcome));
  assert.deepEqual([...outcomes].sort(), ['bad_request', 'error', 'not_covered', 'ok', 'payment_required', 'rate_limited', 'stale', 'unlicensed']);
});

for (const v of envelopes) {
  test(`checkEnvelope: ${v.id} -> ${v.valid ? v.outcome : v.error}`, () => {
    const r = checkEnvelope(v.status, v.input, keysOf(v), v.request);
    assert.deepEqual(Object.keys(r).sort(), ['code', 'detail', 'ok', 'outcome', 'path', 'receiptHash', 'trust']);
    if (v.valid) {
      assert.equal(r.ok, true, r.detail);
      assert.equal(r.code, 'OK');
      assert.equal(r.outcome, v.outcome);
      assert.equal(r.trust, v.trust ?? null);
      assert.equal(r.receiptHash, v.receipt_hash ?? null);
      assert.equal(r.path, null);
      // Bytes work too.
      assert.equal(checkEnvelope(v.status, new TextEncoder().encode(v.input), keysOf(v), v.request).code, 'OK');
    } else {
      assert.equal(r.ok, false);
      assert.equal(r.code, v.error, r.detail);
      assert.equal(r.outcome, null);
      assert.equal(r.trust, null);
    }
  });
}

for (const v of envelopes.filter((v) => v.valid)) {
  test(`wrong HTTP status: ${v.id} (outcome ${v.outcome}, status ${v.status})`, () => {
    let n = 0;
    for (const s of OTHER) {
      if (matches(v.outcome, s)) continue;
      const r = checkEnvelope(s, v.input, keysOf(v), v.request);
      assert.equal(r.code, 'E_ENVELOPE', `status ${s}`);
      n++;
    }
    assert.ok(n >= 15);
  });
}

const okv = vector('envelope/ok-primary');
const KEYS = keysOf(okv);
const R = JSON.parse(okv.input).receipt;
const RH = okv.receipt_hash;
const REQ = okv.request;
const env = (status, body, req = REQ) => checkEnvelope(status, typeof body === 'string' ? body : JSON.stringify(body), KEYS, req);
const codeOf = (status, body) => env(status, body).code;
const receiptHashOf = (r) => {
  const o = { ...r };
  delete o.sig;
  return createHash('sha256').update(canonicalizeJcs(o)).digest('hex');
};

test('the receipt hash is that of the embedded receipt', () => {
  assert.equal(receiptHashOf(R), RH);
  assert.equal(env(200, { outcome: 'ok', trust: 'primary', receipt: R }).receiptHash, RH);
});

test('members per outcome (step 2)', () => {
  const ok = { outcome: 'ok', trust: 'primary', receipt: R };
  assert.equal(codeOf(200, ok), 'OK');
  assert.equal(codeOf(200, { ...ok, superseded_by: 'f'.repeat(64) }), 'OK');
  assert.equal(codeOf(200, { ...ok, superseded_by: 'f'.repeat(64), reason: 'x' }), 'OK');
  assert.equal(codeOf(200, { ...ok, outcome: 'stale', age_seconds: 0, superseded_by: 'f'.repeat(64), reason: 'x' }), 'OK');
  for (const extra of ['age_seconds', 'quote', 'retry_after_seconds', 'error', 'x']) assert.equal(codeOf(200, { ...ok, [extra]: 1 }), 'E_ENVELOPE', extra);
  for (const [outcome, status, body] of [
    ['not_covered', 404, {}],
    ['unlicensed', 403, {}],
    ['payment_required', 402, { quote: { amount: '1', authorise: 'https://m.example/p', currency: 'EUR' } }],
    ['rate_limited', 429, { retry_after_seconds: 1 }],
    ['error', 500, { error: 'E_SIGNATURE' }],
  ]) {
    assert.equal(codeOf(status, { outcome, ...body }), 'OK', outcome);
    for (const extra of ['receipt', 'trust', 'superseded_by', 'reason', 'age_seconds', 'zz']) {
      if (extra in body) continue;
      assert.equal(codeOf(status, { outcome, ...body, [extra]: extra === 'receipt' ? R : 'primary' }), 'E_ENVELOPE', `${outcome} + ${extra}`);
    }
    if (Object.keys(body).length) assert.equal(codeOf(status, { outcome }), 'E_ENVELOPE', `${outcome} without its member`);
  }
  for (const body of ['[]', '"ok"', 'true', '1', '{}', '{"outcome":5}', '{"outcome":null}', '{"outcome":"OK"}', '{"outcome":"ok "}', '{"receipt":{}}']) assert.equal(codeOf(200, body), 'E_ENVELOPE', body);
});

test('member values (step 2)', () => {
  const stale = (age) => `{"outcome":"stale","trust":"primary","receipt":${JSON.stringify(R)},"age_seconds":${age}}`;
  const rl = (n) => `{"outcome":"rate_limited","retry_after_seconds":${n}}`;
  // Integers written 0 or [1-9][0-9]*, at most 2^53 - 1 (SPEC 5.5): the text decides.
  for (const n of ['0', '1', '86400', '9007199254740991']) {
    assert.equal(codeOf(200, stale(n)), 'OK', n);
    assert.equal(codeOf(429, rl(n)), 'OK', n);
  }
  for (const n of ['1.0', '30.0', '1e2', '3e1', '1.5e1', '-0', '1E0', '0e0', '9007199254740990.6', '1e-400', '-1', '1.5', '0.1', '9007199254740992', '99999999999999999999', '1e16', 'true', 'false', 'null', '"5"', '[]', '{}', '-1e-1']) {
    assert.equal(codeOf(200, stale(n)), 'E_ENVELOPE', n);
    assert.equal(codeOf(429, rl(n)), 'E_ENVELOPE', n);
  }
  assert.equal(codeOf(429, rl('1e400')), 'E_PARSE_JSON');
  // error: a code from SPEC 10.2 other than E_ENVELOPE; bad_request: a URI parse code.
  for (const c of ERROR_CODES) assert.equal(codeOf(503, { outcome: 'error', error: c }), c === 'E_ENVELOPE' ? 'E_ENVELOPE' : 'OK', c);
  for (const c of ['E_TEAPOT', 'OK', '', 'e_signature', 'E_SIGNATURE ', 5, null]) assert.equal(codeOf(503, { outcome: 'error', error: c }), 'E_ENVELOPE', String(c));
  const PARSE = ['E_PARSE_URI', 'E_CANON_NAME', 'E_CANON_ARG_NAME', 'E_CANON_ARG_DUPLICATE', 'E_CANON_ARG_ORDER', 'E_CANON_PERCENT', 'E_CANON_TYPE', 'E_CANON_NUMBER', 'E_CANON_DATE', 'E_CANON_INSTANT', 'E_CANON_STRING', 'E_CANON_BLOB', 'E_CANON_LIMIT', 'E_ARG_UNKNOWN', 'E_ARG_MISSING'];
  for (const c of ERROR_CODES) assert.equal(codeOf(400, { outcome: 'bad_request', error: c }), PARSE.includes(c) ? 'OK' : 'E_ENVELOPE', c);
  assert.equal(codeOf(400, { outcome: 'bad_request' }), 'E_ENVELOPE');
  assert.equal(codeOf(400, { outcome: 'bad_request', error: 'E_PARSE_URI', receipt: R }), 'E_ENVELOPE');
  assert.equal(codeOf(500, { outcome: 'bad_request', error: 'E_PARSE_URI' }), 'E_ENVELOPE');
  assert.equal(codeOf(400, { outcome: 'error', error: 'E_PARSE_URI' }), 'E_ENVELOPE');
  // trust
  for (const t of ['trusted', 'PRIMARY', '', 1, null]) assert.equal(codeOf(200, { outcome: 'ok', trust: t, receipt: R }), 'E_ENVELOPE', String(t));
  // receipt must be an object
  for (const r of ['x', 1, [], null, true]) assert.equal(codeOf(200, { outcome: 'ok', trust: 'primary', receipt: r }), 'E_ENVELOPE', JSON.stringify(r));
  // superseded_by: a receipt hash
  for (const h of ['F'.repeat(64), 'f'.repeat(63), 'f'.repeat(65), 5, null]) assert.equal(codeOf(200, { outcome: 'ok', trust: 'primary', receipt: R, superseded_by: h }), 'E_ENVELOPE', String(h));
  // reason: a non-empty string under the string rules and the summary limit
  const sup = { outcome: 'ok', trust: 'primary', receipt: R, superseded_by: 'f'.repeat(64) };
  assert.equal(codeOf(200, { ...sup, reason: 'é'.repeat(512) }), 'OK');
  for (const reason of ['', 'a\u0007', 'Zürich', '͸', 'a'.repeat(1025), 'é'.repeat(513), 5, null]) assert.equal(codeOf(200, { ...sup, reason }), 'E_ENVELOPE', JSON.stringify(reason).slice(0, 20));
  // quote
  const Q = { amount: '0.05', authorise: 'https://mesh.example/pay?q=7f3a', currency: 'EUR' };
  const pq = (q) => codeOf(402, { outcome: 'payment_required', quote: q });
  assert.equal(pq(Q), 'OK');
  assert.equal(pq({ ...Q, currency: 'GRD' }), 'OK');
  assert.equal(pq({ ...Q, authorise: `https://${'a'.repeat(504)}` }), 'OK');
  assert.equal(pq({ ...Q, amount: '1'.repeat(128) }), 'OK');
  for (const q of [
    { ...Q, amount: '0' }, { ...Q, amount: '-1' }, { ...Q, amount: '0.50' }, { ...Q, amount: '1'.repeat(129) }, { ...Q, amount: 0.05 }, { ...Q, amount: '-0' },
    { ...Q, authorise: 'http://mesh.example/pay' }, { ...Q, authorise: 'https://' }, { ...Q, authorise: 'https://a b' }, { ...Q, authorise: `https://${'a'.repeat(505)}` }, { ...Q, authorise: 'https://mesh.example/é' },
    { ...Q, currency: 'XXX' }, { ...Q, currency: 'eur' }, { ...Q, currency: 'kg' }, { ...Q, currency: 'EURO' }, { ...Q, currency: 1 },
    { ...Q, x: 1 }, { amount: '1', currency: 'EUR' }, 'x', [], null,
  ]) {
    assert.equal(pq(q), 'E_ENVELOPE', JSON.stringify(q));
  }
});

test('HTTP status per outcome (step 3)', () => {
  assert.equal(codeOf(500, { outcome: 'error', error: 'E_SIGNATURE' }), 'OK');
  assert.equal(codeOf(599, { outcome: 'error', error: 'E_SIGNATURE' }), 'OK');
  for (const s of [499, 600, 200, 404]) assert.equal(codeOf(s, { outcome: 'error', error: 'E_SIGNATURE' }), 'E_ENVELOPE', String(s));
});

test('the order of the checks: parse, members, status, receipt (steps 1-4)', () => {
  const tampered = { ...R, value: '2' };
  const badName = { ...R, cell: { ...R.cell, ns: 'Bad.example' } };
  assert.equal(codeOf(200, { outcome: 'ok', trust: 'primary', receipt: tampered }), 'E_SIGNATURE');
  assert.equal(codeOf(404, { outcome: 'ok', trust: 'primary', receipt: tampered }), 'E_ENVELOPE');
  assert.equal(codeOf(200, { outcome: 'ok', trust: 'zz', receipt: tampered }), 'E_ENVELOPE');
  assert.equal(codeOf(200, { outcome: 'ok', trust: 'primary', receipt: badName }), 'E_CANON_NAME');
  assert.equal(codeOf(404, { outcome: 'ok', trust: 'primary', receipt: badName }), 'E_ENVELOPE');
  const missing = { ...R };
  delete missing.summary;
  assert.equal(codeOf(200, { outcome: 'ok', trust: 'primary', receipt: missing }), 'E_SCHEMA');
  assert.equal(codeOf(200, { outcome: 'ok', trust: 'primary', receipt: { ...R, proto: 'datumesh/2' } }), 'E_SCHEMA');
  assert.equal(checkEnvelope(200, JSON.stringify({ outcome: 'ok', trust: 'primary', receipt: R }), [], REQ).code, 'E_KEY_UNAVAILABLE');
  const text = JSON.stringify({ outcome: 'ok', trust: 'primary', receipt: R });
  assert.equal(codeOf(200, text.replace('{"sig"', '{"sig":"x","sig"')), 'E_PARSE_DUPLICATE_KEY');
  assert.equal(codeOf(404, '{"outcome":"not_covered","outcome":"not_covered"}'), 'E_PARSE_DUPLICATE_KEY');
  assert.equal(codeOf(404, '﻿{"outcome":"not_covered"}'), 'E_PARSE_JSON');
  assert.equal(checkEnvelope(404, new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), KEYS, REQ).code, 'E_PARSE_JSON');
  assert.equal(checkEnvelope(404, new Uint8Array([0x7b, 0xff, 0x7d]), KEYS, REQ).code, 'E_PARSE_JSON');
  assert.equal(codeOf(404, '{"outcome":"not_covered"'), 'E_PARSE_JSON');
});

test('trust is checked against the receipt; superseded_by is not the receipt itself', () => {
  const ok = (trust, receipt = R) => ({ outcome: 'ok', trust, receipt });
  assert.equal(codeOf(200, ok('verified')), 'E_ENVELOPE');
  assert.equal(codeOf(200, ok('unverified')), 'E_ENVELOPE');
  const mirror = JSON.parse(vector('envelope/ok-mirror').input).receipt;
  assert.equal(codeOf(200, ok('unverified', mirror)), 'OK');
  assert.equal(codeOf(200, ok('verified', mirror)), 'OK');
  assert.equal(codeOf(200, ok('primary', mirror)), 'E_ENVELOPE');
  const computed = vector('envelope/ok-unverified');
  const CR = JSON.parse(computed.input).receipt;
  assert.equal(CR.computed_by.split('#')[0], CR.cell.ns, 'a computed receipt signed by its own host');
  assert.equal(checkEnvelope(200, JSON.stringify(ok('primary', CR)), keysOf(computed), computed.request).code, 'E_ENVELOPE');
  const path = vector('envelope/ok-primary-namespace-path');
  const PR = JSON.parse(path.input).receipt;
  assert.equal(checkEnvelope(200, JSON.stringify(ok('unverified', PR)), keysOf(path), path.request).code, 'E_ENVELOPE');
  assert.equal(codeOf(200, { ...ok('primary'), superseded_by: RH }), 'E_ENVELOPE');
  const r = env(200, { ...ok('primary'), superseded_by: RH });
  assert.equal(r.receiptHash, RH, 'the receipt was verified before the envelope failed');
});

test('the receipt answers the request (step 5): cell id, and asof when one was asked for', () => {
  const ok = { outcome: 'ok', trust: 'primary', receipt: R };
  const other = 'e920bb15287699a37973578621cd346a7411270ad08cf1cbd3cbaaa5096aa608';
  assert.equal(env(200, ok, { cell_id: REQ.cell_id }).code, 'OK');
  assert.equal(env(200, ok, { cell_id: REQ.cell_id, asof: R.asof }).code, 'OK');
  assert.equal(env(200, ok, { cell_id: other, asof: R.asof }).code, 'E_ENVELOPE');
  assert.equal(env(200, ok, { cell_id: other }).code, 'E_ENVELOPE');
  // Since spec-0.3.0 (D31 revised): for ok as for stale, at or before the requested asof.
  assert.equal(env(200, ok, { cell_id: REQ.cell_id, asof: '2024-03-16T09:00:00.000001Z' }).code, 'OK');
  assert.equal(env(200, ok, { cell_id: REQ.cell_id, asof: '9999-12-31T23:59:59.999999Z' }).code, 'OK');
  const stale = { ...ok, outcome: 'stale', age_seconds: 5 };
  assert.equal(env(200, stale, { cell_id: other }).code, 'E_ENVELOPE');
  // For stale, the receipt's asof is at or before the requested one (D31); for ok too.
  assert.equal(env(200, stale, { cell_id: REQ.cell_id, asof: R.asof }).code, 'OK');
  assert.equal(env(200, stale, { cell_id: REQ.cell_id, asof: '2024-03-16T09:00:00.000001Z' }).code, 'OK');
  assert.equal(env(200, stale, { cell_id: REQ.cell_id, asof: '9999-12-31T23:59:59.999999Z' }).code, 'OK');
  assert.equal(env(200, stale, { cell_id: REQ.cell_id, asof: '2024-03-16T08:59:59.999999Z' }).code, 'E_ENVELOPE');
  assert.equal(env(200, ok, { cell_id: REQ.cell_id, asof: '2024-03-16T08:59:59.999999Z' }).code, 'E_ENVELOPE');
  // After the receipt's own verification (step 4), before trust (step 6).
  assert.equal(env(200, { ...ok, receipt: { ...R, value: '2' } }, { cell_id: other }).code, 'E_SIGNATURE');
  const r = env(200, { ...ok, trust: 'verified' }, { cell_id: other });
  assert.equal(r.code, 'E_ENVELOPE');
  assert.match(r.detail, /request/);
  // Envelopes without a receipt do not use the request beyond its shape.
  assert.equal(env(404, { outcome: 'not_covered' }, { cell_id: other }).code, 'OK');
});

test('the request is required and must be {cell_id, asof?}', () => {
  const body = '{"outcome":"not_covered"}';
  for (const req of [undefined, null, 'x', {}, { cell_id: 'F'.repeat(64) }, { cell_id: REQ.cell_id, asof: '2024-03-16' }, { cell_id: REQ.cell_id, x: 1 }, { cell_id: 5 }]) {
    assert.throws(() => checkEnvelope(404, body, KEYS, req), TypeError, JSON.stringify(req));
  }
});

test('checkEnvelope never throws for invalid bodies', () => {
  const base = JSON.stringify({ outcome: 'stale', trust: 'primary', receipt: R, age_seconds: 5, superseded_by: 'f'.repeat(64), reason: 'Corrected.' });
  let seed = 7;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  const bodies = ['', 'null', '{}', new Uint8Array(), new Uint8Array([0xff]), { outcome: 'ok' }, [], 5, null];
  for (let i = 0; i < 1500; i++) {
    const chars = [...base];
    for (let j = 0; j < 1 + rand(3); j++) {
      const at = rand(chars.length);
      const op = rand(3);
      if (op === 0) chars.splice(at, 1);
      else if (op === 1) chars.splice(at, 0, String.fromCharCode(rand(0x80)));
      else chars[at] = String.fromCharCode(rand(0x3000));
    }
    bodies.push(chars.join(''));
  }
  for (const b of bodies) {
    for (const s of [200, 404]) {
      const r = checkEnvelope(s, b, KEYS, REQ);
      assert.equal(typeof r.ok, 'boolean');
      assert.ok(r.code === 'OK' || ERROR_CODES.includes(r.code), r.code);
    }
  }
});

test('a status that is not an integer is a programmer error', () => {
  for (const s of ['200', null, undefined, 200.5, NaN]) assert.throws(() => checkEnvelope(s, '{"outcome":"not_covered"}', KEYS, REQ), TypeError, String(s));
});
