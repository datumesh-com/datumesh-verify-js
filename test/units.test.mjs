// Units (SPEC 7.1, units.md): the embedded unit list equals spec/units.md; resolvedUnit agrees
// with every `unit` vector; every listed literal is accepted in a descriptor, and near-misses are
// rejected with E_CANON_UNIT; unit shapes, index units and the order of the descriptor checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import canonicalizeJcs from 'canonicalize';
import { join } from 'node:path';
import { canonicalize, functionHash, resolvedUnit, verify, keysFromResponse, DatumeshError } from '../dist/esm/index.js';
import { render, parseUnitsMd, UNITS_MD, OUT } from '../tools/gen-units.mjs';
import { loadVectors, vector, root } from './helpers.mjs';

const unitsMd = readFileSync(UNITS_MD, 'utf8');
const groups = parseUnitsMd(unitsMd);
const LITERALS = Object.values(groups).flat();
const CURRENCIES = groups.currency;

const code = (fn) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DatumeshError) return e.code;
    throw e;
  }
  return 'OK';
};
const desc = (args, returns) => ({ code: { body: '', lang: 'stored' }, inputs: [], signature: { args, returns } });
const ret = (unit) => desc({}, { type: 'number', unit });
const argUnit = (unit) => desc({ x: { type: 'number', unit, valid: false } }, 'boolean');
const fnCode = (d) => code(() => canonicalize(d, 'function'));

test('the embedded unit list (src/units-data.ts) is generated from spec/units.md', () => {
  assert.equal(readFileSync(OUT, 'utf8'), render(unitsMd));
  assert.deepEqual(Object.keys(groups), ['currency', 'physical', 'ratio']);
  assert.equal(CURRENCIES.length, 189);
  for (const u of ['EUR', 'USD', 'GRD', 'XAU', 'degC', 'm/s', 'kWh', '1', 'count', 'percent', 'bp', 'mm', 'cm', 'km/h', 'hPa', 'W/m2', 'permille']) assert.ok(LITERALS.includes(u), u);
  assert.equal(LITERALS.length, 189 + 16 + 5);
  assert.ok(!LITERALS.includes('W/m²'));
  assert.ok(!CURRENCIES.includes('XXX'));
});

test('the currency list agrees with schemas/defs.schema.json', () => {
  const defs = JSON.parse(readFileSync(join(root, 'spec/schemas/defs.schema.json'), 'utf8')).$defs;
  assert.deepEqual([...defs.currency.enum].sort(), [...CURRENCIES].sort());
  assert.deepEqual([...defs.unitLiteral.anyOf[0].enum].sort(), [...LITERALS].sort());
});

const unitVectors = loadVectors().filter((v) => v.kind === 'unit');

test('there are unit vectors, valid and invalid', () => {
  assert.equal(unitVectors.length, 13);
  assert.ok(unitVectors.some((v) => v.valid && v.unit === null));
});

for (const v of unitVectors) {
  test(`resolvedUnit: ${v.id} -> ${v.valid ? JSON.stringify(v.unit) : v.error}`, () => {
    const { cell, descriptor } = JSON.parse(v.input);
    if (v.valid) {
      assert.equal(resolvedUnit(descriptor, cell), v.unit);
      // JSON text and bytes work too.
      assert.equal(resolvedUnit(JSON.stringify(descriptor), new TextEncoder().encode(JSON.stringify(cell))), v.unit);
    } else {
      assert.equal(code(() => resolvedUnit(descriptor, cell)), v.error);
    }
  });
}

test('every literal unit in units.md is accepted as a return unit and as an argument unit', () => {
  for (const u of LITERALS) {
    assert.equal(fnCode(ret(u)), 'OK', u);
    assert.equal(fnCode(argUnit(u)), 'OK', u);
  }
});

test('every currency is accepted on either side of a rate; other literals are not', () => {
  for (const c of CURRENCIES) {
    assert.equal(fnCode(ret({ of: c, per: 'EUR' })), 'OK', c);
    assert.equal(fnCode(ret({ of: 'EUR', per: c })), 'OK', c);
  }
  for (const u of [...groups.physical, ...groups.ratio, 'index:2015=100']) {
    assert.equal(fnCode(ret({ of: u, per: 'EUR' })), 'E_CANON_UNIT', u);
    assert.equal(fnCode(ret({ of: 'EUR', per: u })), 'E_CANON_UNIT', u);
  }
});

test('near-misses of listed units are rejected with E_CANON_UNIT', () => {
  const near = new Set(['°C', '°C', 'USD/EUR', 'EUR/USD', 'EUR per USD', 'usd', 'Eur', 'degc', 'DEGC', 'deg C', 'kwh', 'KWH', 'kW h', 'M/S', 'm/S', 'm s-1', 'Percent', 'PERCENT', '%', 'BP', 'Count', 'XXX', 'ABC', '', ' ', 'dollars', 'index', 'index:', 'index:2015', '1.0', '01', 'EUR\u0000', '﻿EUR', 'ＥＵＲ']);
  for (const u of LITERALS) {
    near.add(` ${u}`);
    near.add(`${u} `);
    near.add(`${u}\n`);
    near.add(`\t${u}`);
    if (u.length > 1) near.add(`${u[0]} ${u.slice(1)}`);
    if (u.toLowerCase() !== u) near.add(u.toLowerCase());
    if (u.toUpperCase() !== u) near.add(u.toUpperCase());
    const swapped = [...u].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
    if (swapped !== u) near.add(swapped);
  }
  let n = 0;
  for (const u of near) {
    if (LITERALS.includes(u)) continue; // e.g. "M" would be no unit, but "m" uppercased is "M": not listed either way
    assert.equal(fnCode(ret(u)), 'E_CANON_UNIT', JSON.stringify(u));
    assert.equal(fnCode(argUnit(u)), 'E_CANON_UNIT', JSON.stringify(u));
    n++;
  }
  assert.ok(n > 900, `${n} near-misses`);
});

test('index units (units.md 2.4)', () => {
  const ok = ['index:2015=100', 'index:1984-01-03=1000', 'index:2015-12=1', 'index:2016-02-29=100', 'index:0001=0.5', 'index:9999-12-31=1', `index:2015=${'1'.repeat(53)}`];
  const bad = ['index:2015=0', 'index:2015=-1', 'index:2015=100.0', 'index:2015=0100', 'index:2015=+1', 'index:2015=1e2', 'index:0000=100', 'index:2015-13=100', 'index:2015-00=100', 'index:2015-02-29=100', 'index:2015-1=100', 'index:15=100', 'index: 2015=100', 'Index:2015=100', 'index:2015=', 'index:2015-01-01-01=1', 'index:2015/01=1', `index:2015=${'1'.repeat(54)}`, 'index:2015=-0', 'index:2015=.5'];
  for (const u of ok) assert.equal(fnCode(ret(u)), 'OK', u);
  for (const u of bad) assert.equal(fnCode(ret(u)), 'E_CANON_UNIT', u);
});

test('argument references name a string argument of the same signature', () => {
  const S = { type: 'string', valid: false };
  assert.equal(fnCode(desc({ c: S, x: { type: 'number', unit: { arg: 'c' }, valid: false } }, { type: 'number', unit: { of: { arg: 'c' }, per: { arg: 'c' } } })), 'OK');
  assert.equal(fnCode(desc({ c: { type: 'string', valid: true } }, { type: 'number', unit: { arg: 'c' } })), 'OK');
  for (const [name, args, unit] of [
    ['missing', {}, { arg: 'c' }],
    ['a date', { c: { type: 'date', valid: false } }, { arg: 'c' }],
    ['a blob', { c: { type: 'blob', valid: false } }, { arg: 'c' }],
    ['a number (itself)', { c: { type: 'number', unit: { arg: 'c' }, valid: false } }, { arg: 'c' }],
    ['not a name', { c: S }, { arg: 'C' }],
    ['reserved', { c: S }, { arg: 'asof' }],
    ['a rate side', { c: { type: 'date', valid: false } }, { of: { arg: 'c' }, per: 'EUR' }],
  ]) {
    assert.equal(fnCode(desc(args, { type: 'number', unit })), 'E_CANON_UNIT', name);
  }
});

test('unit shapes other than a string, {arg} or {of, per} are E_SCHEMA', () => {
  for (const u of [1, true, null, [], ['EUR'], {}, { arg: 5 }, { arg: 'c', x: 1 }, { of: 'USD' }, { per: 'EUR' }, { of: 'USD', per: 'EUR', scale: '1' }, { arg: 'c', of: 'USD', per: 'EUR' }, { of: 5, per: 'EUR' }, { of: 'USD', per: null }, { of: { of: 'USD', per: 'EUR' }, per: 'EUR' }, { of: { arg: 'c', x: 1 }, per: 'EUR' }]) {
    assert.equal(fnCode(ret(u)), 'E_SCHEMA', JSON.stringify(u));
    assert.equal(fnCode(argUnit(u)), 'E_SCHEMA', JSON.stringify(u));
  }
});

test('declarations and returns: which code, in which order (SPEC 7)', () => {
  const N = (unit) => ({ type: 'number', unit });
  const cases = [
    // returns
    [desc({}, 'number'), 'E_CANON_UNIT'],
    [desc({}, { type: 'number' }), 'E_CANON_UNIT'],
    [desc({}, { type: 'boolean' }), 'E_CANON_UNIT'],
    [desc({}, { type: 'blob' }), 'E_CANON_UNIT'],
    [desc({}, { type: 'string', unit: '1' }), 'E_CANON_UNIT'],
    [desc({}, { type: 'bogus', unit: '1' }), 'E_CANON_TYPE'],
    [desc({}, { type: 'bogus' }), 'E_CANON_TYPE'],
    [desc({}, 'bogus'), 'E_CANON_TYPE'],
    [desc({}, { type: 5, unit: '1' }), 'E_SCHEMA'],
    [desc({}, { unit: '1' }), 'E_SCHEMA'],
    [desc({}, { type: 'number', unit: 'EUR', valid: false }), 'E_SCHEMA'],
    [desc({}, { type: 'string', x: 1 }), 'E_SCHEMA'],
    [desc({}, null), 'E_SCHEMA'],
    [desc({}, 5), 'E_SCHEMA'],
    [desc({}, 'blob'), 'OK'],
    [desc({}, 'boolean'), 'OK'],
    // arguments: type, then unit, then valid
    [desc({ a: { type: 'number', valid: false } }, 'boolean'), 'E_CANON_UNIT'],
    [desc({ a: { type: 'number', valid: true } }, 'boolean'), 'E_CANON_UNIT'],
    [desc({ a: { type: 'number', unit: '1', valid: true } }, 'boolean'), 'E_CANON_TYPE'],
    [desc({ a: { type: 'boolean', unit: '1', valid: true } }, 'boolean'), 'E_CANON_UNIT'],
    [desc({ a: { type: 'bogus', unit: '1', valid: false } }, 'boolean'), 'E_CANON_TYPE'],
    [desc({ a: { type: 'string', unit: '1', valid: false } }, 'boolean'), 'E_CANON_UNIT'],
    [desc({ a: { type: 'blob', valid: true } }, 'boolean'), 'E_CANON_TYPE'],
    [desc({ a: { type: 'blob', unit: '1', valid: false } }, 'boolean'), 'E_CANON_UNIT'],
    [desc({ a: { type: 'number', unit: 'EUR' } }, 'boolean'), 'E_SCHEMA'],
    [desc({ A: { type: 'number', valid: false } }, 'boolean'), 'E_CANON_ARG_NAME'],
    // step 2 (shapes) runs over the whole descriptor before step 3
    [desc({ a: { type: 'number', unit: 'usd', valid: false } }, N(1)), 'E_SCHEMA'],
    [desc({ a: { type: 'bogus', valid: false } }, N(1)), 'E_SCHEMA'],
    [desc({ a: { type: 'string', unit: 5, valid: false } }, 'boolean'), 'E_SCHEMA'],
    [desc({}, N({ of: 'kg', per: 5 })), 'E_SCHEMA'],
    // step 3: arguments in order, a reference looks only at the named declaration's type
    [desc({ a: N({ arg: 'b' }), b: { type: 'bogus', valid: false } }, 'boolean'), 'E_SCHEMA'],
    [desc({ a: { ...N({ arg: 'b' }), valid: false }, b: { type: 'bogus', valid: false } }, 'boolean'), 'E_CANON_UNIT'],
    [desc({ a: { ...N({ arg: 'B' }), valid: false }, B: { type: 'string', valid: false } }, 'boolean'), 'E_CANON_ARG_NAME'], // "B" sorts first
    [desc({ a: { type: 'number', valid: false } }, N('zz')), 'E_CANON_UNIT'],
    [desc({ a: { type: 'bogus', valid: false } }, N('zz')), 'E_CANON_TYPE'],
  ];
  for (const [d, want] of cases) assert.equal(fnCode(d), want, JSON.stringify(d.signature));
});

test('resolvedUnit: lookup, slices, argument checks and the order of checks', () => {
  const fx = JSON.parse(vector('unit/fx-rate').input);
  const conv = JSON.parse(vector('unit/argument-reference').input);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const withArgs = (base, f) => {
    const c = clone(base.cell);
    f(c.args, c);
    return c;
  };
  const R = (base, f) => code(() => resolvedUnit(base.descriptor, withArgs(base, f)));
  const U = (base, f) => resolvedUnit(base.descriptor, withArgs(base, f));
  // Only the arguments the unit references are looked at.
  assert.equal(U(fx, (a) => (a.date = '*')), 'USD/EUR');
  assert.equal(U(fx, (a) => delete a.date), 'USD/EUR');
  assert.equal(U(fx, (a) => (a.zz = { type: 'string', value: 'x' })), 'USD/EUR');
  assert.equal(U(fx, (a) => (a.date = { type: 'string', value: 'x' })), 'USD/EUR');
  assert.equal(U(conv, (a) => (a.base = { type: 'string', value: 'dollars' })), 'USD');
  // A referenced value may be any literal unit, but a rate side must be a currency.
  for (const u of ['index:2015=100', 'count', '1', 'm/s', 'degC', 'GRD']) assert.equal(U(conv, (a) => (a.quote.value = u)), u);
  for (const u of ['USD/EUR', 'usd', 'dollars', '', 'index:2015=0']) assert.equal(R(conv, (a) => (a.quote.value = u)), 'E_CANON_UNIT', u);
  for (const u of ['kg', 'index:2015=100', '1']) assert.equal(R(fx, (a) => (a.quote.value = u)), 'E_CANON_UNIT', u);
  // Per referenced argument, of before per: missing, slice, type, value.
  assert.equal(R(fx, (a) => delete a.quote), 'E_ARG_MISSING');
  assert.equal(R(fx, (a) => (a.quote = '*')), 'E_SLICE');
  assert.equal(R(conv, (a) => (a.quote = '*')), 'E_SLICE');
  assert.equal(R(fx, (a) => (a.quote = { type: 'date', value: '2024-03-15' })), 'E_ARG_TYPE');
  assert.equal(R(fx, (a) => ((a.quote = '*'), (a.base = { type: 'string', value: 'kg' }))), 'E_SLICE');
  assert.equal(R(fx, (a) => ((a.quote = { type: 'string', value: 'kg' }), (a.base = '*'))), 'E_CANON_UNIT');
  assert.equal(R(fx, (a) => (delete a.quote, (a.base = '*'))), 'E_ARG_MISSING');
  // No unit for other return types, whatever the cell.
  const nb = JSON.parse(vector('unit/no-unit').input);
  assert.equal(U(nb, (a) => (a.calendar = '*')), null);
  // units.md 3: the cell (structure, canonical form), fn_hash, the descriptor (structure,
  // canonical form), then substitution.
  const badCell = withArgs(fx, (a, c) => (c.ns = 'Bad.example'));
  const badDesc = clone(fx.descriptor);
  badDesc.code.lang = 'Bad';
  assert.equal(code(() => resolvedUnit(badDesc, fx.cell)), 'E_FN_HASH_MISMATCH');
  assert.equal(code(() => resolvedUnit(badDesc, { ...fx.cell, fn_hash: functionHashOf(badDesc) })), 'E_CANON_NAME');
  assert.equal(code(() => resolvedUnit(badDesc, badCell)), 'E_CANON_NAME');
  assert.equal(code(() => resolvedUnit(5, badCell)), 'E_CANON_NAME');
  assert.equal(code(() => resolvedUnit(5, fx.cell)), 'E_FN_HASH_MISMATCH');
  assert.equal(code(() => resolvedUnit({ ...fx.descriptor, y: 1 }, fx.cell)), 'E_FN_HASH_MISMATCH');
  const schemaBad = { ...fx.descriptor, y: 1 };
  assert.equal(code(() => resolvedUnit(schemaBad, { ...fx.cell, fn_hash: functionHashOf(schemaBad) })), 'E_SCHEMA');
  assert.equal(code(() => resolvedUnit(5, { ...fx.cell, fn_hash: functionHashOf(5) })), 'E_SCHEMA');
  assert.equal(code(() => resolvedUnit({ ...fx.descriptor, y: 1 }, { ...fx.cell, x: 1 })), 'E_SCHEMA');
  assert.equal(code(() => resolvedUnit(fx.descriptor, { ...fx.cell, asof: '2024-03-16T09:00:00.000000Z' })), 'E_SCHEMA');
  assert.equal(code(() => resolvedUnit(fx.descriptor, '{"args":{},"args":{}}')), 'E_PARSE_DUPLICATE_KEY');
  assert.equal(code(() => resolvedUnit(fx.descriptor, '{')), 'E_PARSE_JSON');
});

// A hash computed without the library's validation (the descriptor is deliberately invalid).
function functionHashOf(d) {
  return createHash('sha256').update(canonicalizeJcs(d)).digest('hex');
}

test('function hashes of the unit vectors; a spec-0.1.1 descriptor with a number fails E_CANON_UNIT', () => {
  const fx = vector('function/stored-fx-rate');
  assert.equal(functionHash(fx.input), '7b58ecb8fd23b644c87951d0bd609790ff547cbb23fed27186c669ce2ce0aa80');
  const old = JSON.parse(fx.input);
  old.signature.returns = 'number';
  assert.equal(code(() => functionHash(old)), 'E_CANON_UNIT');
  // Descriptors with no number member are unchanged since spec-0.1.1 (SPEC 14).
  const nb = JSON.parse(vector('unit/no-unit').input);
  assert.equal(functionHash(nb.descriptor), 'ed1f0ecb7166dd6d70ae263456e3af94147d4781f43035e534b9368e9561f84a');
});

test('recomputation checks the descriptor with its units (step 7.1) and the return type of an object returns (7.4)', () => {
  const v = vector('receipt/stored-number');
  const keys = Object.entries(v.keys).map(([h, e]) => keysFromResponse(h, e.https.status, e.https.body));
  assert.equal(verify(v.input, keys, v.recompute).level, 'recomputed');
  const old = JSON.parse(JSON.stringify(v.recompute));
  old.descriptor.signature.returns = 'number';
  assert.equal(verify(v.input, keys, old).code, 'E_FN_HASH_MISMATCH');
});

test('resolvedUnit throws TypeError only for missing arguments', () => {
  const fx = JSON.parse(vector('unit/fx-rate').input);
  assert.throws(() => resolvedUnit(undefined, fx.cell), TypeError);
  assert.throws(() => resolvedUnit(fx.descriptor), TypeError);
});
