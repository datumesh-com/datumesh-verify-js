// What spec-0.6.1 changes for a verifier library (SPEC.md 2.3, 2.5, 5.1, 16.8; D106, D108), through
// the public API. The vectors run in test/conformance.test.mjs; these tests pin the rules the
// vectors do not state in one place: a later DNS segment is a label only (the host alone decides
// the publisher and rootedness), the last segment and a method name stay `name`, and describe's
// `publisher` must be the host of the name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUri, isUnrooted, checkDescribe, DatumeshError } from '../dist/esm/index.js';
import { vector } from './helpers.mjs';

const codeOf = (f) => {
  try {
    f();
    return 'OK';
  } catch (e) {
    if (e instanceof DatumeshError) return e.code;
    throw e;
  }
};
const uri = (path) => `cell://${path}?base=EUR`;
const SIG = { args: { base: { type: 'string', valid: false } }, returns: { type: 'string' } };

test('a DNS name in a later segment is a cell URI namespace segment (2.3, 5.1)', () => {
  const ref = parseUri(uri('datumesh.com/relay/ecb.europa.eu/fx_reference'), SIG);
  assert.equal(ref.ns, 'datumesh.com/relay/ecb.europa.eu');
  assert.equal(ref.fn, 'fx_reference');
  for (const ok of ['datumesh.com/relay/bank-x.example/rate', 'datumesh.com/relay/xn--bcher-kva.example/rate', 'datumesh.com/relay/bankofengland.co.uk/bank_rate', 'datumesh.com/relay/ecb.europa.eu/rate/treasury.gov/yield']) {
    assert.equal(codeOf(() => parseUri(uri(ok), SIG)), 'OK', ok);
  }
});

test('a later segment that is neither a name nor a DNS name, or a DNS name in the function, is E_CANON_NAME (2.3)', () => {
  const bad = [
    'datumesh.com/relay/ECB.europa.eu/rate', // uppercase
    'datumesh.com/relay/ecb.europa.eu./rate', // trailing dot
    'datumesh.com/relay/ecb_x.europa.eu/rate', // underscore
    'datumesh.com/relay/ecb..eu/rate', // empty label
    'datumesh.com/relay/-ecb.europa.eu/rate', // leading hyphen
    'datumesh.com/relay/10.0.0.1/rate', // all-digit last label
    'datumesh.com/relay/bank-x/rate', // a hyphen and no dot is neither a name nor a DNS name
    'datumesh.com/relay/ecb.europa.eu', // a DNS name as the function
    'datumesh.com/relay/ecb.europa.eu/fx.rate', // a dotted function name
  ];
  for (const p of bad) assert.equal(codeOf(() => parseUri(uri(p), SIG)), 'E_CANON_NAME', p);
});

test('the 64-character limit is for name segments; a DNS segment takes 253 (2.3, 4.5)', () => {
  const dns253 = [63, 63, 63, 61].map((n) => 'a'.repeat(n)).join('.'); // 253 characters: 63-character labels, the last 61
  assert.equal(dns253.length, 253);
  assert.equal(codeOf(() => parseUri(uri(`datumesh.com/relay/${dns253}/rate`), SIG)), 'OK');
  const name65 = `datumesh.com/relay/${'a'.repeat(65)}/rate`;
  assert.equal(codeOf(() => parseUri(uri(name65), SIG)), 'E_CANON_LIMIT');
});

test('unrooted is decided by the host alone (2.5): a later DNS segment is a label', () => {
  assert.equal(isUnrooted('rates.example.org/x/foo.invalid'), false);
  assert.equal(isUnrooted('local.invalid/x/foo.example'), true);
  assert.equal(isUnrooted('local.invalid/notes'), true);
  assert.equal(isUnrooted('datumesh.com/relay/ecb.europa.eu'), false);
});

test('describe publisher is the host of the name (16.8): a domain in a later segment is never the publisher', () => {
  const base = JSON.parse(vector('describe/function-publisher').input);
  const withPub = (fn, publisher) => JSON.stringify({ ...base, fn, publisher });
  const fn = 'datumesh.com/relay/ecb.europa.eu/fx_reference';
  assert.equal(codeOf(() => checkDescribe(withPub(fn, 'ecb.europa.eu'), {})), 'E_DESCRIBE');
  assert.equal(codeOf(() => checkDescribe(withPub(fn, 'datumesh.com'), {})), 'OK');
  assert.equal(checkDescribe(withPub(fn, 'datumesh.com'), {}).publisher, 'datumesh.com');
  assert.equal(codeOf(() => checkDescribe(withPub(fn, 'DATUMESH.com'), {})), 'E_DESCRIBE');
  assert.equal(codeOf(() => checkDescribe(withPub(fn, 'datumesh.com/relay'), {})), 'E_DESCRIBE');
  assert.equal(codeOf(() => checkDescribe(withPub(fn, 42), {})), 'E_DESCRIBE');
});

test('describe publisher is optional and additive: an answer without it has publisher null', () => {
  const v = vector('describe/function-without-publisher');
  assert.equal(checkDescribe(v.input, v.classes ?? {}, v.functions).publisher, null);
  const c = vector('describe/class-publisher');
  assert.equal(checkDescribe(c.input, c.classes).publisher, JSON.parse(c.input).publisher);
  assert.equal(codeOf(() => checkDescribe(vector('invalid/describe-object-publisher').input, {})), 'E_DESCRIBE');
});
