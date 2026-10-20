// Test 5: RFC 8785. The `canonicalize` dependency itself, and this library's canonicalize()
// (strict parse + canonicalize), pass every Appendix B sample and the two main examples
// (sections 3.2.2-3.2.4 and 3.2.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import serialize from 'canonicalize';
import { canonicalize, DatumeshError } from '../dist/esm/index.js';
import { root, text } from './helpers.mjs';

const fx = JSON.parse(readFileSync(join(root, 'test/fixtures/rfc8785.json'), 'utf8'));

function fromIeee(hex) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, BigInt(`0x${hex}`));
  return dv.getFloat64(0);
}

test('Appendix B has 26 rows (24 numbers, NaN, Infinity)', () => {
  assert.equal(fx.appendixB.length, 26);
  assert.equal(fx.appendixB.filter((r) => r.json === null).length, 2);
});

for (const row of fx.appendixB) {
  const n = fromIeee(row.ieee754);
  if (row.json === null) {
    test(`Appendix B ${row.ieee754} (${row.comment}) is rejected`, () => {
      assert.ok(!Number.isFinite(n));
      assert.throws(() => serialize(n));
      assert.throws(() => canonicalize([n], 'jcs'), (e) => e instanceof DatumeshError && e.code === 'E_PARSE_JSON');
    });
    continue;
  }
  test(`Appendix B ${row.ieee754} -> ${row.json}`, () => {
    assert.equal(serialize(n), row.json, 'canonicalize package');
    assert.equal(text(canonicalize([n], 'jcs')), `[${row.json}]`, 'library, parsed value');
    // Through the strict parser: the expected text reads back to the same double.
    assert.equal(text(canonicalize(`[${row.json}]`, 'jcs')), `[${row.json}]`, 'library, JSON text');
    assert.equal(Object.is(JSON.parse(row.json), n) || (n === 0 && JSON.parse(row.json) === 0), true);
  });
}

test('RFC 8785 3.2.2-3.2.4: the main example gives exactly the bytes of 3.2.4', () => {
  const bytes = canonicalize(fx.mainExample.input, 'jcs');
  assert.equal(Buffer.from(bytes).toString('hex'), fx.mainExample.utf8Hex);
  assert.equal(Buffer.from(serialize(JSON.parse(fx.mainExample.input)), 'utf8').toString('hex'), fx.mainExample.utf8Hex);
});

test('RFC 8785 3.2.3: the sorting example orders members by UTF-16 code units', () => {
  // (Object.values would reorder: JavaScript lists integer-like keys such as "1" first.)
  const order = (s) => fx.sortingExample.order.map((name) => s.indexOf(`"${name}"`));
  const ascending = (a) => a.every((x, i) => x >= 0 && (i === 0 || a[i - 1] < x));
  const out = text(canonicalize(fx.sortingExample.input, 'jcs'));
  assert.ok(ascending(order(out)), out);
  assert.ok(ascending(order(serialize(JSON.parse(fx.sortingExample.input)))));
  assert.equal(out, '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u{F6}":"Latin Small Letter O With Diaeresis","\u{20AC}":"Euro Sign","\u{1F600}":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}');
});

test('strict parsing (SPEC 6.1) before canonicalisation', () => {
  const bad = [
    ['{"a":1,"a":2}', 'E_PARSE_DUPLICATE_KEY'],
    ['{"a":1,"\\u0061":2}', 'E_PARSE_DUPLICATE_KEY'],
    ['["\\ud800"]', 'E_PARSE_JSON'],
    ['["\\udc00\\ud800"]', 'E_PARSE_JSON'],
    ['[NaN]', 'E_PARSE_JSON'],
    ['[Infinity]', 'E_PARSE_JSON'],
    ['[-Infinity]', 'E_PARSE_JSON'],
    ['[1e400]', 'E_PARSE_JSON'],
    ['[-1e400]', 'E_PARSE_JSON'],
    ['\u{FEFF}[]', 'E_PARSE_JSON'],
    ['[1,]', 'E_PARSE_JSON'],
    ['[01]', 'E_PARSE_JSON'],
    ['[+1]', 'E_PARSE_JSON'],
    ['[.5]', 'E_PARSE_JSON'],
    ['[1.]', 'E_PARSE_JSON'],
    ['["a\u0001"]', 'E_PARSE_JSON'],
    ['["\\x"]', 'E_PARSE_JSON'],
    ['[\u000b1]', 'E_PARSE_JSON'],
    ['', 'E_PARSE_JSON'],
    ['[] x', 'E_PARSE_JSON'],
    ["['a']", 'E_PARSE_JSON'],
    ['["\ud800"]', 'E_PARSE_JSON'],
    ['['.repeat(1002) + ']'.repeat(1002), 'E_PARSE_JSON'],
  ];
  for (const [t, code] of bad) {
    assert.throws(() => canonicalize(t, 'jcs'), (e) => e instanceof DatumeshError && e.code === code, JSON.stringify(t).slice(0, 60));
  }
  const badBytes = [
    [[0xef, 0xbb, 0xbf, 0x5b, 0x5d], 'BOM'],
    [[0x5b, 0x22, 0xc3, 0x28, 0x22, 0x5d], 'bad continuation'],
    [[0x5b, 0x22, 0xc0, 0xaf, 0x22, 0x5d], 'overlong'],
    [[0x5b, 0x22, 0xed, 0xa0, 0x80, 0x22, 0x5d], 'encoded surrogate'],
    [[0x5b, 0x22, 0xf4, 0x90, 0x80, 0x80, 0x22, 0x5d], 'above U+10FFFF'],
    [[0x5b, 0x22, 0xe2, 0x82], 'truncated'],
  ];
  for (const [b, why] of badBytes) {
    assert.throws(() => canonicalize(Uint8Array.from(b), 'jcs'), (e) => e.code === 'E_PARSE_JSON', why);
  }
  // Accepted: underflow to zero is within the double range; escapes are decoded; the
  // canonical form of -0 is 0; nesting up to the implementation limit.
  assert.equal(text(canonicalize('[1e-400, -0, 0.0]', 'jcs')), '[0,0,0]');
  assert.equal(text(canonicalize('{"\\ud83d\\ude00":"\\u00e9\\/"}', 'jcs')), '{"\u{1F600}":"\u{E9}/"}');
  assert.equal(text(canonicalize('['.repeat(1000) + ']'.repeat(1000), 'jcs')), '['.repeat(1000) + ']'.repeat(1000));
});

test('parsed values are checked against the JSON data model', () => {
  for (const v of [[undefined], [() => 1], [1n], [new Date(0)], [new Map()], [NaN], ['\ud800'], { ['\udc00']: 1 }]) {
    assert.throws(() => canonicalize(v, 'jcs'), (e) => e instanceof DatumeshError && e.code === 'E_PARSE_JSON');
  }
  const cyclic = [];
  cyclic.push(cyclic);
  assert.throws(() => canonicalize(cyclic, 'jcs'), (e) => e.code === 'E_PARSE_JSON');
  // __proto__ as a member name is data, not a prototype.
  assert.equal(text(canonicalize('{"__proto__":{"x":1},"a":2}', 'jcs')), '{"__proto__":{"x":1},"a":2}');
  assert.equal(text(canonicalize(JSON.parse('{"__proto__":{"x":1}}'), 'jcs')), '{"__proto__":{"x":1}}');
});
