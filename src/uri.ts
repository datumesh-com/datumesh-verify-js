// Cell URIs (SPEC.md section 5).
import { fail } from './errors.js';
import { isObject, memberPath, normalizeValue, sortedKeys, toJson, type JsonObject, type JsonValue } from './json.js';
import { LIMITS, checkArgName, checkDnsName, checkInstant, checkName, checkNamespace, checkTypedValue, isTypeName, type TypeName } from './lexical.js';
import { utf8Decode, utf8Encode } from './utf8.js';
import { validate } from './validate.js';

/** A typed scalar (SPEC 4.1). */
export interface TypedScalar {
  type: TypeName;
  value: string | boolean;
}

/** A cell reference (SPEC 4.3): what a cell URI denotes. `"*"` marks a slice. */
export interface CellRef {
  args: Record<string, TypedScalar | '*'>;
  fn: string;
  ns: string;
  asof?: string;
}

/** A unit in a signature (SPEC 7.1): a literal from units.md, an argument reference, or a rate. */
export type UnitRef = { arg: string };
export type Unit = string | UnitRef | { of: string | UnitRef; per: string | UnitRef };

/** A function descriptor's `signature` member (SPEC 7). Numbers declare a unit. */
export interface Signature {
  args: Record<string, { type: TypeName; valid: boolean; unit?: Unit }>;
  returns: Exclude<TypeName, 'number'> | { type: 'number'; unit: Unit };
}

const SCHEME = 'cell://';

function isLiteral(c: string): boolean {
  return /^[A-Za-z0-9\-._~:]$/.test(c);
}

function decodeValue(v: string, path: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < v.length; ) {
    const c = v[i];
    if (c === '%') {
      const h = v.slice(i + 1, i + 3);
      if (!/^[0-9A-F]{2}$/.test(h)) fail('E_CANON_PERCENT', 'percent-encoding must be % and two uppercase hex digits', path);
      const b = parseInt(h, 16);
      if (isLiteral(String.fromCharCode(b))) fail('E_CANON_PERCENT', `${JSON.stringify(String.fromCharCode(b))} must not be percent-encoded`, path);
      bytes.push(b);
      i += 3;
    } else if (isLiteral(c)) {
      bytes.push(c.charCodeAt(0));
      i++;
    } else {
      const cp = v.codePointAt(i)!;
      fail('E_CANON_PERCENT', `${JSON.stringify(String.fromCodePoint(cp))} must be percent-encoded`, path);
    }
  }
  const s = utf8Decode(Uint8Array.from(bytes));
  if (s === null) fail('E_CANON_PERCENT', 'percent-encoded bytes are not UTF-8', path);
  return s;
}

function encodeValue(s: string): string {
  let out = '';
  for (const b of utf8Encode(s)) {
    const c = String.fromCharCode(b);
    out += isLiteral(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * SPEC 5.4 step 5: the signature is taken as given (it comes from a descriptor already checked
 * under section 7), but it must be readable: an object with an `args` object whose members are
 * objects with a string `type` (E_SCHEMA otherwise, in JCS order of names). Nothing else in it is
 * examined; an unknown type name fails only when a value of that argument is read (step 6).
 */
function readSignature(signature: unknown): JsonObject {
  let sig: JsonValue;
  try {
    sig = normalizeValue(signature, 'signature');
  } catch {
    fail('E_SCHEMA', 'the signature is not JSON data', 'signature');
  }
  if (!isObject(sig)) fail('E_SCHEMA', 'the signature is not an object', 'signature');
  const args = sig.args;
  if (!isObject(args)) fail('E_SCHEMA', 'the signature has no args object', 'signature.args');
  for (const k of sortedKeys(args)) {
    const d = args[k];
    if (!isObject(d) || typeof d.type !== 'string') fail('E_SCHEMA', `the declaration of ${JSON.stringify(k)} is not an object with a string type`, memberPath('signature.args', k));
  }
  return sig;
}

/**
 * Parse a cell URI into a cell reference, taking argument types from the function's
 * signature (SPEC 5.4). Checks run in the order of SPEC 5.4 and the first failure is thrown as
 * a DatumeshError.
 */
export function parseUri(uri: string, signature: Signature | unknown): CellRef {
  if (typeof uri !== 'string') throw new TypeError('uri must be a string');

  // 1. Outer grammar.
  if (!uri.startsWith(SCHEME) || uri.includes('#')) fail('E_PARSE_URI', 'not cell://<namespace>/<function>[?<query>] without fragment', '$');
  const rest = uri.slice(SCHEME.length);
  const q = rest.indexOf('?');
  const path = q < 0 ? rest : rest.slice(0, q);
  const query = q < 0 ? null : rest.slice(q + 1);
  if (query === '') fail('E_PARSE_URI', 'empty query', '$');
  // SPEC 5.1: an @ or : in the authority is userinfo or a port (E_PARSE_URI).
  const authority = path.split('/')[0];
  if (authority.includes('@')) fail('E_PARSE_URI', 'a cell URI has no userinfo', '$');
  if (authority.includes(':')) fail('E_PARSE_URI', 'a cell URI has no port', '$');
  const params = (query === null ? [] : query.split('&')).map((p) => {
    const e = p.indexOf('=');
    if (e < 0) fail('E_PARSE_URI', `parameter without '=': ${JSON.stringify(p)}`, '$');
    return { name: p.slice(0, e), value: p.slice(e + 1) };
  });

  // 2. Namespace and function name.
  const slash = path.lastIndexOf('/');
  if (slash < 0) fail('E_CANON_NAME', 'missing namespace', 'uri.path');
  const ns = path.slice(0, slash);
  const fn = path.slice(slash + 1);
  checkNamespace(ns, 'uri.path');
  checkName(fn, 'uri.path');
  if (path.length > LIMITS.function_name) fail('E_CANON_LIMIT', 'function name too long', 'uri.path');

  // 3. Parameter names, left to right.
  const at = (n: string) => `uri.query.${n}`;
  // asof: when the last parameter is asof, that is the asof parameter and any earlier asof is a
  // repetition (E_CANON_ARG_DUPLICATE); otherwise an asof anywhere is out of place
  // (E_CANON_ARG_ORDER). SPEC 5.2 does not say which applies when both do; this matches the
  // reference tool (DEFECTS.md).
  let prev: string | null = null;
  const lastIsAsof = params.length > 0 && params[params.length - 1].name === 'asof';
  params.forEach((p, i) => {
    if (p.name === 'asof') {
      if (!lastIsAsof) fail('E_CANON_ARG_ORDER', 'asof appears once, as the last parameter', at(p.name));
      if (i !== params.length - 1) fail('E_CANON_ARG_DUPLICATE', 'asof repeated', at(p.name));
      return;
    }
    checkArgName(p.name, at(p.name));
    if (prev !== null && p.name === prev) fail('E_CANON_ARG_DUPLICATE', `argument ${JSON.stringify(p.name)} repeated`, at(p.name));
    if (prev !== null && p.name < prev) fail('E_CANON_ARG_ORDER', 'arguments must be sorted by name', at(p.name));
    prev = p.name;
  });
  const argParams = params.filter((p) => p.name !== 'asof');

  // 4. Argument count.
  if (argParams.length > LIMITS.args) fail('E_CANON_LIMIT', `more than ${LIMITS.args} arguments`, 'uri.query');

  // 5. The signature (readable, E_SCHEMA), then the arguments against it: unknown arguments,
  // then missing ones.
  const declared = readSignature(signature).args as JsonObject;
  for (const p of argParams) {
    if (!Object.prototype.hasOwnProperty.call(declared, p.name)) fail('E_ARG_UNKNOWN', `function declares no argument ${JSON.stringify(p.name)}`, at(p.name));
  }
  const present = new Set(argParams.map((p) => p.name));
  for (const n of sortedKeys(declared)) {
    if (!present.has(n)) fail('E_ARG_MISSING', `argument ${JSON.stringify(n)} absent; use ${n}=* for a slice`, 'uri.query');
  }

  // 6. Values, left to right: percent-encoding, then the lexical form.
  const args: Record<string, TypedScalar | '*'> = {};
  for (const p of argParams) {
    if (p.value === '*') {
      args[p.name] = '*';
      continue;
    }
    const type = (declared[p.name] as JsonObject).type as TypeName;
    const s = decodeValue(p.value, at(p.name));
    if (!isTypeName(type)) fail('E_CANON_TYPE', `unknown type ${JSON.stringify(type)} in the signature`, `signature.args.${p.name}.type`);
    if (type === 'boolean') {
      if (s !== 'true' && s !== 'false') fail('E_CANON_TYPE', 'boolean must be true or false', at(p.name));
      args[p.name] = { type, value: s === 'true' };
    } else {
      checkTypedValue(type, s, at(p.name));
      args[p.name] = { type, value: s };
    }
  }

  // 7. asof.
  const ref: CellRef = { args, fn, ns };
  const asofParam = params.find((p) => p.name === 'asof');
  if (asofParam) {
    const s = decodeValue(asofParam.value, at('asof'));
    checkInstant(s, at('asof'));
    ref.asof = s;
  }
  return ref;
}

/** Write the unique cell URI of a cell reference (SPEC 5.2). Throws DatumeshError if invalid. */
export function formatUri(ref: CellRef | unknown): string {
  const v = toJson(ref);
  validate(v, 'ref');
  const o = v as JsonObject;
  const args = o.args as JsonObject;
  const parts: string[] = [];
  for (const k of sortedKeys(args)) {
    const a = args[k];
    if (a === '*') parts.push(`${k}=*`);
    else if (isObject(a) && typeof a.value === 'boolean') parts.push(`${k}=${a.value ? 'true' : 'false'}`);
    else parts.push(`${k}=${encodeValue((a as JsonObject).value as string)}`);
  }
  if (typeof o.asof === 'string') parts.push(`asof=${encodeValue(o.asof)}`);
  return `${SCHEME}${o.ns as string}/${o.fn as string}${parts.length ? `?${parts.join('&')}` : ''}`;
}

/** The HTTPS URL of a cell URI on mesh host `mesh` (SPEC 5.3). */
export function httpsUrl(uri: string, mesh: string): string {
  if (!uri.startsWith(SCHEME)) fail('E_PARSE_URI', 'not a cell URI', '$');
  // SPEC 5.3: the mesh is a DNS name on the default HTTPS port (no port, IP address or userinfo).
  checkDnsName(mesh, 'mesh');
  return `https://${mesh}/cell/${uri.slice(SCHEME.length)}`;
}
