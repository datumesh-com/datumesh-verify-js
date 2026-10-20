// Test 3: URI round-trip identity, format(parse(uri)) = uri, for every valid URI vector; plus
// formatUri on references and the HTTPS mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUri, formatUri, httpsUrl, canonicalize, DatumeshError } from '../dist/esm/index.js';
import { loadVectors, text } from './helpers.mjs';

const uris = loadVectors().filter((v) => v.kind === 'uri');

for (const v of uris.filter((v) => v.valid)) {
  test(`round trip: ${v.id}`, () => {
    const ref = parseUri(v.input, v.signature);
    assert.deepEqual(ref, v.object);
    assert.equal(formatUri(ref), v.input);
    assert.equal(formatUri(v.object), v.input);
    assert.equal(text(canonicalize(ref, 'ref')), v.canonical);
    assert.equal(httpsUrl(v.input, 'mesh.example'), v.https);
  });
}

for (const v of uris.filter((v) => !v.valid)) {
  test(`rejected: ${v.id} -> ${v.error}`, () => {
    assert.throws(() => parseUri(v.input, v.signature), (e) => e instanceof DatumeshError && e.code === v.error);
  });
}

test('formatUri percent-encodes every non-literal byte with uppercase hex', () => {
  const ref = { ns: 'rates.example.org', fn: 'fx_rate', args: { base: { type: 'string', value: 'a b+c/\u{FC}*' }, date: '*', quote: { type: 'string', value: '' } } };
  const uri = formatUri(ref);
  assert.equal(uri, 'cell://rates.example.org/fx_rate?base=a%20b%2Bc%2F%C3%BC%2A&date=*&quote=');
  const sig = { args: { base: { type: 'string', valid: false }, date: { type: 'date', valid: true }, quote: { type: 'string', valid: false } }, returns: 'number' };
  assert.deepEqual(parseUri(uri, sig), ref);
});

test('formatUri rejects invalid references with their codes', () => {
  assert.throws(() => formatUri({ ns: 'Rates.example.org', fn: 'x', args: {} }), (e) => e.code === 'E_CANON_NAME');
  assert.throws(() => formatUri({ ns: 'a.example', fn: 'x', args: { n: { type: 'number', value: '1.50' } } }), (e) => e.code === 'E_CANON_NUMBER');
  assert.throws(() => formatUri({ ns: 'a.example', fn: 'x', args: {}, asof: '2024-01-01T00:00:00Z' }), (e) => e.code === 'E_CANON_INSTANT');
});

test('parseUri validates the signature it is given', () => {
  assert.throws(() => parseUri('cell://math.example/pi', { args: {}, returns: 'decimal' }), (e) => e.code === 'E_CANON_TYPE' && e.path === 'signature.returns');
  assert.throws(() => parseUri('cell://math.example/pi', null), TypeError);
});
