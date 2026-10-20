// Units (SPEC.md 7.1, units.md): shapes in a signature (step 2, E_SCHEMA), validity against the
// closed list (step 3, E_CANON_UNIT), and resolution of a cell's unit (units.md section 3).
import { fail } from './errors.js';
import { has, isObject, memberPath, type JsonObject, type JsonValue } from './json.js';
import { isDate, isNumber } from './lexical.js';
import { UNIT_GROUPS } from './units-data.js';

const CURRENCY = new Set(UNIT_GROUPS.currency);
const LITERAL = new Set(Object.values(UNIT_GROUPS).flat());
const INDEX_RE = /^index:([0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?)=(.*)$/;
const INDEX_MAX = 64;

/** A currency code from units.md 2.1 (List One and the withdrawn codes). */
export function isCurrency(s: unknown): boolean {
  return typeof s === 'string' && CURRENCY.has(s);
}

/** units.md 2.4: index:<YYYY[-MM[-DD]]>=<number greater than 0>, at most 64 characters. */
export function isIndexUnit(s: string): boolean {
  if (s.length > INDEX_MAX) return false;
  const m = INDEX_RE.exec(s);
  if (!m) return false;
  const [y, mo = '01', d = '01'] = m[1].split('-');
  if (!isDate(`${y}-${mo}-${d}`)) return false;
  return isNumber(m[2]) && !m[2].startsWith('-') && m[2] !== '0';
}

/** A literal unit (units.md section 2): a listed string or an index unit. Byte-for-byte. */
export function isUnitLiteral(s: unknown): boolean {
  return typeof s === 'string' && (LITERAL.has(s) || isIndexUnit(s));
}

const isRef = (u: JsonObject): boolean => Object.keys(u).length === 1 && has(u, 'arg') && typeof u.arg === 'string';

/**
 * Step 2 for a unit: a string, {"arg": <string>}, or {"of": side, "per": side} where a side is
 * a string or {"arg": <string>}. Anything else is E_SCHEMA (SPEC 7.1, units.md 1).
 */
export function structUnit(u: JsonValue, path: string): void {
  if (typeof u === 'string') return;
  if (isObject(u)) {
    if (isRef(u)) return;
    const keys = Object.keys(u);
    if (keys.length === 2 && has(u, 'of') && has(u, 'per')) {
      for (const side of ['of', 'per']) {
        const v = u[side];
        if (typeof v === 'string' || (isObject(v) && isRef(v))) continue;
        fail('E_SCHEMA', 'a rate side is a currency code or {"arg": name}', memberPath(path, side));
      }
      return;
    }
  }
  fail('E_SCHEMA', 'a unit is a string, {"arg": name} or {"of", "per"}', path);
}

/**
 * Step 3 for a unit whose shape passed structUnit. `args` is the signature's `args`: a
 * reference must name one of them whose declared type is `string` (E_CANON_UNIT).
 */
export function canonUnit(u: JsonValue, args: JsonObject, path: string): void {
  const checkRef = (r: JsonObject, p: string) => {
    const name = r.arg as string;
    const d = has(args, name) ? args[name] : null;
    if (!isObject(d) || d.type !== 'string') fail('E_CANON_UNIT', `a unit names a string argument of the signature: ${JSON.stringify(name)}`, p);
  };
  if (typeof u === 'string') {
    if (!isUnitLiteral(u)) fail('E_CANON_UNIT', `not a unit listed in units.md: ${JSON.stringify(u)}`, path);
    return;
  }
  const o = u as JsonObject;
  if (has(o, 'arg')) return checkRef(o, path);
  for (const side of ['of', 'per']) {
    const v = o[side];
    const p = memberPath(path, side);
    if (typeof v === 'string') {
      if (!isCurrency(v)) fail('E_CANON_UNIT', `a rate side is a currency code: ${JSON.stringify(v)}`, p);
    } else checkRef(v as JsonObject, p);
  }
}

/**
 * units.md section 3: the unit of one cell's value, for a descriptor and a cell that have
 * passed validation and whose fn_hash matches. `returns` is the signature's `returns`.
 * A referenced argument must be bound (E_ARG_MISSING), not a slice (E_SLICE), of its declared
 * type (E_ARG_TYPE), and a literal unit (E_CANON_UNIT); on a rate side, a currency.
 */
export function resolveUnit(returns: JsonValue, cellArgs: JsonObject, path: string, argsPath: string): string | null {
  if (!isObject(returns)) return null; // only a number return is an object, and only it has a unit
  const u = returns.unit as JsonValue;
  const side = (v: JsonValue, p: string, currency: boolean): string => {
    if (typeof v === 'string') return v; // a literal, already checked by canonUnit
    const name = (v as JsonObject).arg as string;
    const ap = memberPath(argsPath, name);
    if (!has(cellArgs, name)) fail('E_ARG_MISSING', `the cell does not bind ${JSON.stringify(name)}`, argsPath);
    const a = cellArgs[name];
    if (a === '*') fail('E_SLICE', `${name} is a slice; its unit is not one string`, ap);
    const scalar = a as JsonObject;
    if (scalar.type !== 'string') fail('E_ARG_TYPE', `${name} is declared string`, ap);
    const value = scalar.value as string;
    if (currency ? !isCurrency(value) : !isUnitLiteral(value)) {
      fail('E_CANON_UNIT', `argument ${name} is not ${currency ? 'a currency code' : 'a unit'}: ${JSON.stringify(value)}`, p);
    }
    return value;
  };
  const p = memberPath(path, 'unit');
  if (typeof u === 'string') return u;
  const o = u as JsonObject;
  if (has(o, 'arg')) return side(o, p, false);
  const of = side(o.of, memberPath(p, 'of'), true);
  const per = side(o.per, memberPath(p, 'per'), true);
  return `${of}/${per}`;
}
