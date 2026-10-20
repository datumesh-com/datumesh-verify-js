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
  const sig = { args: { base: { type: 'string', valid: false }, date: { type: 'date', valid: true }, quote: { type: 'string', valid: false } }, returns: { type: 'number', unit: 'EUR' } };
  assert.deepEqual(parseUri(uri, sig), ref);
});

test('formatUri rejects invalid references with their codes', () => {
  assert.throws(() => formatUri({ ns: 'Rates.example.org', fn: 'x', args: {} }), (e) => e.code === 'E_CANON_NAME');
  assert.throws(() => formatUri({ ns: 'a.example', fn: 'x', args: { n: { type: 'number', value: '1.50' } } }), (e) => e.code === 'E_CANON_NUMBER');
  assert.throws(() => formatUri({ ns: 'a.example', fn: 'x', args: {}, asof: '2024-01-01T00:00:00Z' }), (e) => e.code === 'E_CANON_INSTANT');
});

test('parseUri takes the signature as given (SPEC 5.4) and uses only argument types', () => {
  // The signature is not validated: a spec-0.1.1 bare number return, an unknown return type,
  // a unit on a string argument or extra members do not matter.
  for (const sig of [{ args: {}, returns: 'number' }, { args: {}, returns: 'decimal' }, { args: {}, returns: { type: 'number', unit: 'zz' } }, { args: {}, returns: 'number', extra: 1 }]) {
    assert.equal(parseUri('cell://math.example/pi', sig).fn, 'pi');
  }
  const sig = { args: { base: { type: 'string', unit: 'EUR', valid: 'x' } }, returns: 'number' };
  assert.deepEqual(parseUri('cell://a.example/f?base=EUR', sig).args, { base: { type: 'string', value: 'EUR' } });
  // An argument type outside the six fails when a value is read for it; a slice reads none.
  assert.throws(() => parseUri('cell://a.example/f?base=EUR', { args: { base: { type: 'decimal', valid: false } }, returns: 'string' }), (e) => e.code === 'E_CANON_TYPE');
  assert.deepEqual(parseUri('cell://a.example/f?base=*', { args: { base: { type: 'decimal', valid: false } }, returns: 'string' }).args, { base: '*' });
  assert.throws(() => parseUri('cell://a.example/f?base=EUR', { args: { base: { type: 5, valid: false } }, returns: 'string' }), (e) => e.code === 'E_SCHEMA');
  assert.throws(() => parseUri('cell://a.example/f?base=EUR', { args: { base: { valid: false } }, returns: 'string' }), (e) => e.code === 'E_SCHEMA');
  assert.throws(() => parseUri('cell://a.example/f?base=%zz', { args: { base: { type: 'decimal', valid: false } }, returns: 'string' }), (e) => e.code === 'E_CANON_PERCENT');
  // Something that is not a signature at all is a programmer error.
  for (const bad of [null, undefined, 5, 'x', { returns: 'string' }, { args: 5 }]) assert.throws(() => parseUri('cell://math.example/pi', bad), TypeError);
});

test('outer grammar first (SPEC 5.1, 5.4 step 1): userinfo, port, empty parameter', () => {
  const sig = { args: { base: { type: 'string', valid: false } }, returns: { type: 'number', unit: 'EUR' } };
  for (const uri of ['cell://u@rates.example.org/fx_rate?base=x', 'cell://rates.example.org:443/fx_rate?base=x', 'cell://Rates.example.org/fx_rate?base=x&&', 'cell://rates.example.org/fx_rate?base', 'cell://rates.example.org/fx_rate?', 'cell://rates.example.org/fx_rate#x', 'CELL://rates.example.org/fx_rate']) {
    assert.throws(() => parseUri(uri, sig), (e) => e.code === 'E_PARSE_URI', uri);
  }
  // A colon or @ elsewhere in the path is an invalid name, not a port.
  assert.throws(() => parseUri('cell://rates.example.org/a:b/fx_rate?base=x', sig), (e) => e.code === 'E_CANON_NAME');
  assert.throws(() => parseUri('cell://rates.example.org', sig), (e) => e.code === 'E_CANON_NAME');
});

test('asof placement: a trailing asof is the parameter, earlier ones repeat it', () => {
  const sig = { args: { base: { type: 'string', valid: false }, date: { type: 'date', valid: true }, quote: { type: 'string', valid: false } }, returns: { type: 'number', unit: 'EUR' } };
  const A = 'asof=2024-03-16T09:00:00.000000Z';
  const B = 'cell://rates.example.org/fx_rate?';
  const cases = [
    [`${B}base=EUR&${A}&quote=USD&date=2024-03-15&${A}`, 'E_CANON_ARG_DUPLICATE'],
    [`${B}${A}&${A}`, 'E_CANON_ARG_DUPLICATE'],
    [`${B}base=EUR&date=2024-03-15&quote=USD&${A}&${A}&zz=1`, 'E_CANON_ARG_ORDER'],
    [`${B}${A}&base=EUR&date=2024-03-15&quote=USD`, 'E_CANON_ARG_ORDER'],
    [`${B}${A}&Base=EUR`, 'E_CANON_ARG_ORDER'],
    [`${B}base=EUR&date=2024-03-15&base=x&quote=USD`, 'E_CANON_ARG_ORDER'],
    [`${B}base=EUR&base=EUR&date=2024-03-15&quote=USD`, 'E_CANON_ARG_DUPLICATE'],
  ];
  for (const [uri, code] of cases) assert.throws(() => parseUri(uri, sig), (e) => e.code === code, uri);
  assert.equal(parseUri(`${B}base=EUR&date=2024-03-15&quote=USD&${A}`, sig).asof, '2024-03-16T09:00:00.000000Z');
});
