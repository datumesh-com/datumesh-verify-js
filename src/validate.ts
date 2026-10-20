// Structure (SPEC 10.1 step 2, E_SCHEMA), canonical form (step 3) and receipt consistency
// (step 4) for every kind of Datumesh object. Within a step members are examined in JCS order,
// depth first; at each object its member set is checked before its members.
import { fail } from './errors.js';
import { has, isObject, memberPath, sortedKeys, type JsonObject, type JsonValue } from './json.js';
import {
  LIMITS,
  VALID_TIME_TYPES,
  checkArgName,
  checkFunctionName,
  checkHex,
  checkInstant,
  checkKeyRef,
  checkLicence,
  checkName,
  checkNamespace,
  checkString,
  checkTypedValue,
  isTypeName,
} from './lexical.js';
import { canonUnit, resolveUnit, structUnit } from './units.js';

export type Kind = 'scalar' | 'cell' | 'ref' | 'function' | 'receipt' | 'jcs';
export const KINDS: readonly Kind[] = ['scalar', 'cell', 'ref', 'function', 'receipt', 'jcs'];

const SLICE = '*';

// ---------------------------------------------------------------- step 2: structure

function expectObject(v: JsonValue, path: string): JsonObject {
  if (!isObject(v)) fail('E_SCHEMA', 'expected an object', path);
  return v;
}

function members(o: JsonObject, required: readonly string[], optional: readonly string[], path: string): void {
  const names = new Set([...Object.keys(o), ...required]);
  for (const n of [...names].sort()) {
    if (!has(o, n)) fail('E_SCHEMA', `missing member ${JSON.stringify(n)}`, path);
    if (!required.includes(n) && !optional.includes(n)) fail('E_SCHEMA', `unexpected member ${JSON.stringify(n)}`, path);
  }
}

function expectString(o: JsonObject, k: string, path: string): void {
  if (typeof o[k] !== 'string') fail('E_SCHEMA', `${k} must be a string`, memberPath(path, k));
}

function structScalar(v: JsonValue, path: string): void {
  const o = expectObject(v, path);
  members(o, ['type', 'value'], [], path);
  expectString(o, 'type', path);
  if (typeof o.value !== 'string' && typeof o.value !== 'boolean') {
    fail('E_SCHEMA', 'value must be a string or a boolean', memberPath(path, 'value'));
  }
}

function structArgs(v: JsonValue, path: string): void {
  const o = expectObject(v, path);
  for (const k of sortedKeys(o)) {
    if (o[k] === SLICE) continue;
    structScalar(o[k], memberPath(path, k));
  }
}

function structCell(v: JsonValue, path: string, ref: boolean): void {
  const o = expectObject(v, path);
  if (ref) members(o, ['args', 'fn', 'ns'], ['asof'], path);
  else members(o, ['args', 'fn', 'fn_hash', 'ns'], [], path);
  for (const k of sortedKeys(o)) {
    if (k === 'args') structArgs(o.args, memberPath(path, 'args'));
    else expectString(o, k, path);
  }
}

function structFunction(v: JsonValue, path: string): void {
  const o = expectObject(v, path);
  members(o, ['code', 'inputs', 'signature'], [], path);
  const codePath = memberPath(path, 'code');
  const code = expectObject(o.code, codePath);
  members(code, ['body', 'lang'], [], codePath);
  expectString(code, 'body', codePath);
  expectString(code, 'lang', codePath);
  const inputs = o.inputs;
  if (!Array.isArray(inputs) || inputs.some((x) => typeof x !== 'string')) {
    fail('E_SCHEMA', 'inputs must be an array of strings', memberPath(path, 'inputs'));
  }
  structSignature(o.signature, memberPath(path, 'signature'));
}

export function structSignature(v: JsonValue, path: string): void {
  const sig = expectObject(v, path);
  members(sig, ['args', 'returns'], [], path);
  const argsPath = memberPath(path, 'args');
  const args = expectObject(sig.args, argsPath);
  for (const k of sortedKeys(args)) {
    const p = memberPath(argsPath, k);
    const d = expectObject(args[k], p);
    members(d, ['type', 'valid'], ['unit'], p);
    expectString(d, 'type', p);
    if (has(d, 'unit')) structUnit(d.unit, memberPath(p, 'unit'));
    if (typeof d.valid !== 'boolean') fail('E_SCHEMA', 'valid must be a boolean', memberPath(p, 'valid'));
  }
  // SPEC 7: a type name, or {"type", "unit"} (the unit's absence is E_CANON_UNIT, in step 3).
  const rp = memberPath(path, 'returns');
  const r = sig.returns;
  if (typeof r === 'string') return;
  if (!isObject(r)) fail('E_SCHEMA', 'returns must be a type name or an object', rp);
  members(r, ['type'], ['unit'], rp);
  expectString(r, 'type', rp);
  if (has(r, 'unit')) structUnit(r.unit, memberPath(rp, 'unit'));
}

const RECEIPT_MEMBERS = [
  'asof',
  'cell',
  'computed_by',
  'inputs',
  'issued',
  'licence',
  'proto',
  'publisher',
  'sig',
  'summary',
  'tx',
  'type',
  'valid',
  'value',
] as const;

function structReceipt(v: JsonValue, path: string): void {
  const o = expectObject(v, path);
  members(o, RECEIPT_MEMBERS, [], path);
  for (const k of sortedKeys(o)) {
    const p = memberPath(path, k);
    switch (k) {
      case 'cell':
        structCell(o.cell, p, false);
        break;
      case 'inputs': {
        const a = o.inputs;
        if (!Array.isArray(a) || a.some((x) => typeof x !== 'string')) fail('E_SCHEMA', 'inputs must be an array of strings', p);
        break;
      }
      case 'valid':
        structArgs(o.valid, p);
        break;
      case 'value':
        if (typeof o.value !== 'string' && typeof o.value !== 'boolean') fail('E_SCHEMA', 'value must be a string or a boolean', p);
        break;
      case 'proto':
        expectString(o, k, path);
        if (o.proto !== 'datumesh/1') fail('E_SCHEMA', "proto must be 'datumesh/1'", p);
        break;
      default:
        expectString(o, k, path);
    }
  }
}

// ---------------------------------------------------------------- step 3: canonical form

function canonScalar(o: JsonObject, path: string): void {
  const t = o.type;
  if (!isTypeName(t)) fail('E_CANON_TYPE', `unknown type ${JSON.stringify(t)}`, memberPath(path, 'type'));
  checkTypedValue(t, o.value, memberPath(path, 'value'));
}

function canonArgs(o: JsonObject, path: string): void {
  if (Object.keys(o).length > LIMITS.args) fail('E_CANON_LIMIT', `more than ${LIMITS.args} arguments`, path);
  for (const k of sortedKeys(o)) {
    const p = memberPath(path, k);
    checkArgName(k, p);
    if (o[k] !== SLICE) canonScalar(o[k] as JsonObject, p);
  }
}

function canonCell(o: JsonObject, path: string): void {
  for (const k of sortedKeys(o)) {
    const p = memberPath(path, k);
    const v = o[k] as string;
    if (k === 'args') canonArgs(o.args as JsonObject, p);
    else if (k === 'asof') checkInstant(v, p);
    else if (k === 'fn') checkName(v, p);
    else if (k === 'fn_hash') checkHex(v, 64, p);
    else if (k === 'ns') checkNamespace(v, p);
  }
  if ((o.ns as string).length + 1 + (o.fn as string).length > LIMITS.function_name) {
    fail('E_CANON_LIMIT', 'function name too long', path);
  }
}

function canonStringSet(a: string[], path: string, each: (s: string, p: string) => void): void {
  a.forEach((s, i) => each(s, `${path}[${i}]`));
  for (let i = 1; i < a.length; i++) {
    if (!(a[i - 1] < a[i])) fail('E_CANON_SET', 'entries must be strictly ascending', path);
  }
  if (a.length > LIMITS.inputs) fail('E_CANON_LIMIT', `more than ${LIMITS.inputs} inputs`, path);
}

export function canonSignature(sig: JsonObject, path: string): void {
  const argsPath = memberPath(path, 'args');
  const args = sig.args as JsonObject;
  if (Object.keys(args).length > LIMITS.args) fail('E_CANON_LIMIT', `more than ${LIMITS.args} arguments`, argsPath);
  for (const k of sortedKeys(args)) {
    const p = memberPath(argsPath, k);
    checkArgName(k, p);
    const d = args[k] as JsonObject;
    // SPEC 7: type, then unit, then valid.
    if (!isTypeName(d.type)) fail('E_CANON_TYPE', `unknown type ${JSON.stringify(d.type)}`, memberPath(p, 'type'));
    if (d.type === 'number') {
      if (!has(d, 'unit')) fail('E_CANON_UNIT', 'a number argument declares its unit', p);
      canonUnit(d.unit, args, memberPath(p, 'unit'));
    } else if (has(d, 'unit')) {
      fail('E_CANON_UNIT', 'only number arguments have a unit', memberPath(p, 'unit'));
    }
    if (d.valid === true && !VALID_TIME_TYPES.includes(d.type)) {
      fail('E_CANON_TYPE', 'a valid-time argument must be a date, instant or string', p);
    }
  }
  const rp = memberPath(path, 'returns');
  const r = sig.returns;
  if (typeof r === 'string') {
    if (!isTypeName(r)) fail('E_CANON_TYPE', `unknown type ${JSON.stringify(r)}`, rp);
    if (r === 'number') fail('E_CANON_UNIT', 'a number return is {"type": "number", "unit": ...}, not the bare name', rp);
    return;
  }
  const o = r as JsonObject;
  if (!isTypeName(o.type)) fail('E_CANON_TYPE', `unknown type ${JSON.stringify(o.type)}`, memberPath(rp, 'type'));
  if (o.type !== 'number') fail('E_CANON_UNIT', 'only a number return is written as an object', rp);
  if (!has(o, 'unit')) fail('E_CANON_UNIT', 'a number return declares its unit', rp);
  canonUnit(o.unit, args, memberPath(rp, 'unit'));
}

/** The return type named by a valid signature's `returns` (SPEC 10.1 step 7.4). */
export function returnType(sig: JsonObject): string {
  const r = sig.returns;
  return typeof r === 'string' ? r : ((r as JsonObject).type as string);
}

function canonFunction(o: JsonObject, path: string): void {
  const code = o.code as JsonObject;
  const codePath = memberPath(path, 'code');
  checkString(code.body as string, memberPath(codePath, 'body'), { body: true });
  checkName(code.lang as string, memberPath(codePath, 'lang'));
  canonStringSet(o.inputs as string[], memberPath(path, 'inputs'), checkFunctionName);
  canonSignature(o.signature as JsonObject, memberPath(path, 'signature'));
}

function canonReceipt(o: JsonObject, path: string): void {
  for (const k of sortedKeys(o)) {
    const p = memberPath(path, k);
    const v = o[k];
    switch (k) {
      case 'asof':
      case 'issued':
      case 'tx':
        checkInstant(v as string, p);
        break;
      case 'cell':
        canonCell(v as JsonObject, p);
        break;
      case 'computed_by':
        checkKeyRef(v as string, p);
        break;
      case 'inputs':
        canonStringSet(v as string[], p, (s, q) => checkHex(s, 64, q));
        break;
      case 'licence':
        checkLicence(v as string, p);
        break;
      case 'publisher':
        checkNamespace(v as string, p);
        break;
      case 'sig':
        checkHex(v as string, 128, p);
        break;
      case 'summary':
        if (v === '') fail('E_CANON_STRING', 'summary must not be empty', p);
        checkString(v as string, p, { limit: LIMITS.summary });
        break;
      case 'type':
        if (!isTypeName(v)) fail('E_CANON_TYPE', `unknown type ${JSON.stringify(v)}`, p);
        break;
      case 'valid':
        canonArgs(v as JsonObject, p);
        break;
      case 'value':
        checkTypedValue(o.type as never, v, p);
        break;
    }
  }
}

// ---------------------------------------------------------------- step 4: consistency

function consistency(o: JsonObject, path: string): void {
  const cell = o.cell as JsonObject;
  const args = cell.args as JsonObject;
  const valid = o.valid as JsonObject;
  const argsPath = memberPath(memberPath(path, 'cell'), 'args');
  const validPath = memberPath(path, 'valid');
  for (const k of sortedKeys(args)) {
    if (args[k] === SLICE) fail('E_SLICE', 'a receipt is for one cell, not a slice', memberPath(argsPath, k));
  }
  for (const k of sortedKeys(valid)) {
    if (valid[k] === SLICE) fail('E_SLICE', 'a receipt is for one cell, not a slice', memberPath(validPath, k));
  }
  if (o.publisher !== cell.ns) fail('E_PUBLISHER_MISMATCH', 'publisher must equal cell.ns', memberPath(path, 'publisher'));
  for (const k of sortedKeys(valid)) {
    const v = valid[k] as JsonObject;
    const a = has(args, k) ? (args[k] as JsonObject) : null;
    if (!a || a.type !== v.type || a.value !== v.value) {
      fail('E_VALID_MISMATCH', `valid.${k} does not echo cell.args.${k}`, validPath);
    }
    if (!VALID_TIME_TYPES.includes(v.type as string)) {
      fail('E_VALID_MISMATCH', 'valid-time arguments are dates, instants or strings', validPath);
    }
  }
  const tx = o.tx as string;
  const asof = o.asof as string;
  const issued = o.issued as string;
  // Instants are fixed width, so string order is time order (SPEC 3.3).
  if (!(tx <= asof && asof <= issued)) fail('E_TIME_ORDER', 'requires tx <= asof <= issued', path);
}

// ---------------------------------------------------------------- entry points

/** Validate `v` as `kind` (steps 2-3; for receipts also step 4). Throws DatumeshError. */
export function validate(v: JsonValue, kind: Kind, path = '$'): void {
  switch (kind) {
    case 'jcs':
      return;
    case 'scalar':
      structScalar(v, path);
      canonScalar(v as JsonObject, path);
      return;
    case 'cell':
    case 'ref':
      structCell(v, path, kind === 'ref');
      canonCell(v as JsonObject, path);
      return;
    case 'function':
      structFunction(v, path);
      canonFunction(v as JsonObject, path);
      return;
    case 'receipt':
      structReceipt(v, path);
      canonReceipt(v as JsonObject, path);
      consistency(v as JsonObject, path);
      return;
  }
}

/**
 * The unit of a cell's value (SPEC 7.1, units.md 3). Order: the cell (structure, canonical
 * form), fn_hash against the descriptor (E_FN_HASH_MISMATCH), the descriptor (structure,
 * canonical form), then substitution.
 */
export function cellUnit(desc: JsonValue, cell: JsonValue, fnHash: (d: JsonValue) => string): string | null {
  structCell(cell, 'cell', false);
  canonCell(cell as JsonObject, 'cell');
  if (fnHash(desc) !== (cell as JsonObject).fn_hash) fail('E_FN_HASH_MISMATCH', 'the descriptor does not hash to cell.fn_hash', 'descriptor');
  structFunction(desc, 'descriptor');
  canonFunction(desc as JsonObject, 'descriptor');
  const sig = (desc as JsonObject).signature as JsonObject;
  return resolveUnit(sig.returns, (cell as JsonObject).args as JsonObject, 'descriptor.signature.returns', 'cell.args');
}

/** Receipt step 2 only: true when the receipt has the right members and JSON types. */
export function receiptStructure(v: JsonValue): void {
  structReceipt(v, '$');
}

/** Receipt steps 3 and 4, after receiptStructure has passed. */
export function receiptCanonicalAndConsistent(v: JsonValue): void {
  canonReceipt(v as JsonObject, '$');
  consistency(v as JsonObject, '$');
}

/**
 * Infer the kind of an object from its members when the caller gives none: a receipt has
 * `sig`, `proto` or `computed_by`; a descriptor `signature` or `code`; a cell `fn_hash`; a cell
 * reference `fn`, `ns` or `args`; a typed scalar `type` or `value`. Anything else is E_SCHEMA.
 */
export function inferKind(v: JsonValue): Exclude<Kind, 'jcs'> {
  if (!isObject(v)) fail('E_SCHEMA', 'cannot infer the kind of a non-object; pass kind', '$');
  const h = (k: string) => has(v, k);
  if (h('sig') || h('proto') || h('computed_by')) return 'receipt';
  if (h('signature') || h('code')) return 'function';
  if (h('fn_hash')) return 'cell';
  if (h('fn') || h('ns') || h('args')) return 'ref';
  if (h('type') || h('value')) return 'scalar';
  fail('E_SCHEMA', 'cannot infer the kind from the members; pass kind', '$');
}
