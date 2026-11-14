/**
 * Classes (SPEC.md section 16, since spec-0.5.0): the class descriptor and its define-time
 * checks (16.1, 16.2), key normalisation (16.4, in normalisation.ts), object keys (16.5), describe
 * answers (16.8) and the define-time check of a function (2.5, the `define` vectors).
 *
 * Everything is synchronous and offline. Input is JSON text, UTF-8 bytes or a parsed value. A rule
 * break throws DatumeshError with its 10.2 code; a caller's misuse (a wrong argument type) throws
 * TypeError.
 */
import { DatumeshError, fail } from './errors.js';
import { has, isObject, memberPath, newObject, sortedKeys, toJson, type JsonObject, type JsonValue } from './json.js';
import { jcsBytes, jcsText } from './jcs.js';
import { sha256Hex } from './hash.js';
import { isKeyRule } from './normalisation.js';
import { LIMITS, URL_RE, checkArgName, checkDate, checkFunctionName, checkHex, checkInstant, checkName, checkNamespace, checkString, isDate, isInstant, isNumber, isTypeName, isHex, type TypeName } from './lexical.js';
import { canonUnit, structUnit } from './units.js';
import { validate } from './validate.js';
import { isUnrooted } from './licence.js';
import { utf8Length } from './utf8.js';

export { KEY_NORMALISATIONS, checkKeyNormalisation, type KeyNormalisation } from './normalisation.js';

/** The environment a class is defined in (the `env` of a `class` vector, SPEC 11). */
export interface ClassEnv {
  /** The namespace of the definer: a namespace defines classes under itself only (E_CLASS_OWNER). */
  definer: string;
  /** Function descriptors known to define (JSON text, bytes or parsed), found by their hash. */
  functions: unknown[];
  /** Flattened class descriptors known to define (parents and interfaces), found by class hash. */
  classes: unknown[];
}

/** A defined class: the flattened descriptor's canonical text and the class hash. */
export interface ClassDefinition {
  /** Canonical bytes (6.2) of the flattened descriptor, as UTF-8 text. */
  flattened: string;
  /** SHA-256 of those bytes, lowercase hex. */
  classHash: string;
}

/** A decoded object key (16.5): the class name and its keys, each a typed scalar or a nested object. */
export interface DecodedObject {
  class: string;
  keys: { [name: string]: TypedScalar | DecodedObject };
}

/** A typed scalar of an object key (16.5): a boolean, date, instant, number or string key. */
export interface TypedScalar {
  type: 'boolean' | 'date' | 'instant' | 'number' | 'string';
  value: string | boolean;
}

/** What `checkDescribe` found: which of the two answer kinds (16.8) it checked. */
export interface DescribeResult {
  kind: 'class' | 'object';
}

// ---------------------------------------------------------------- helpers

const sha256 = (b: Uint8Array): string => sha256Hex(b);
const jcsOf = (v: JsonValue): string => jcsText(v);
const isLowerHex64 = (s: unknown): s is string => typeof s === 'string' && isHex(s, 64);

/** The namespace of a full name: everything before its last `/` (2.3). */
function namespaceOf(name: string): string {
  return name.slice(0, name.lastIndexOf('/'));
}

/** The lowercase class or function name check that 16.5 folds into E_KEY_ENCODING. */
function encodingFailure(detail: string): never {
  fail('E_KEY_ENCODING', detail, '$');
}

/** A scalar's canonical form (3.1, 3.2, 3.3, 3.5) for an object key; any failure is E_KEY_ENCODING. */
function checkKeyScalar(type: string, value: unknown): void {
  if (type === 'boolean') {
    if (typeof value !== 'boolean') encodingFailure('a boolean key is true or false');
    return;
  }
  if (typeof value !== 'string') encodingFailure(`a ${type} key is a string of its lexical form`);
  if (type === 'number') {
    if (!isNumber(value)) encodingFailure(`not a number in its lexical form: ${JSON.stringify(value)}`);
  } else if (type === 'date') {
    if (!isDate(value)) encodingFailure(`not a date: ${JSON.stringify(value)}`);
  } else if (type === 'instant') {
    if (!isInstant(value)) encodingFailure(`not an instant: ${JSON.stringify(value)}`);
  } else if (type === 'string') {
    try {
      checkString(value, '$');
    } catch (e) {
      if (e instanceof DatumeshError) encodingFailure(`not a string: ${e.detail}`);
      throw e;
    }
  } else encodingFailure(`a ${type} is not an object key type`);
}

// ---------------------------------------------------------------- class descriptors: structure (E_SCHEMA)

const CLASS_MEMBERS = ['extent', 'final', 'implements', 'inverse', 'keys', 'lookup', 'maps', 'methods', 'open', 'order', 'parent', 'steward'] as const;
const CLASS_REQUIRED = ['keys', 'methods', 'order', 'steward'] as const;

function structMembers(o: JsonObject, required: readonly string[], optional: readonly string[], path: string): void {
  for (const n of [...new Set([...Object.keys(o), ...required])].sort()) {
    if (!has(o, n)) fail('E_SCHEMA', `missing member ${JSON.stringify(n)}`, path);
    if (!required.includes(n) && !optional.includes(n)) fail('E_SCHEMA', `unexpected member ${JSON.stringify(n)}`, path);
  }
}

function structStringArray(v: JsonValue, path: string, nonEmpty: boolean): void {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) fail('E_SCHEMA', 'expected an array of strings', path);
  if (nonEmpty && v.length === 0) fail('E_SCHEMA', 'an optional member is absent rather than empty', path);
}

function structObject(v: JsonValue, path: string, required: readonly string[], optional: readonly string[]): JsonObject {
  if (!isObject(v)) fail('E_SCHEMA', 'expected an object', path);
  structMembers(v, required, optional, path);
  return v;
}

/** SPEC 16.1, the structure over the whole descriptor (E_SCHEMA), before any canonical rule. */
function structClass(d: JsonValue): JsonObject {
  const o = structObject(d, '$', CLASS_REQUIRED, CLASS_MEMBERS.filter((m) => !(CLASS_REQUIRED as readonly string[]).includes(m)));
  const keys = o.keys;
  if (!isObject(keys)) fail('E_SCHEMA', 'keys is an object', '$.keys');
  for (const k of sortedKeys(keys)) {
    const p = memberPath('$.keys', k);
    const decl = keys[k];
    if (!isObject(decl)) fail('E_SCHEMA', 'a key declaration is an object', p);
    if (has(decl, 'class')) {
      structMembers(decl, ['class'], [], p);
      if (typeof decl.class !== 'string') fail('E_SCHEMA', 'class is a string', memberPath(p, 'class'));
    } else {
      structMembers(decl, ['type'], ['key_normalisation', 'unit'], p);
      if (typeof decl.type !== 'string') fail('E_SCHEMA', 'type is a string', memberPath(p, 'type'));
      if (has(decl, 'unit')) structUnit(decl.unit, memberPath(p, 'unit'));
      if (has(decl, 'key_normalisation') && typeof decl.key_normalisation !== 'string') fail('E_SCHEMA', 'key_normalisation is a string', memberPath(p, 'key_normalisation'));
    }
  }
  structStringArray(o.order, '$.order', false);
  const methods = o.methods;
  if (!isObject(methods)) fail('E_SCHEMA', 'methods is an object', '$.methods');
  for (const m of sortedKeys(methods)) if (typeof methods[m] !== 'string') fail('E_SCHEMA', 'a method is a function hash', memberPath('$.methods', m));
  structObject(o.steward, '$.steward', ['namespace', 'process'], []);
  const s = o.steward as JsonObject;
  if (typeof s.namespace !== 'string' || typeof s.process !== 'string') fail('E_SCHEMA', 'steward has a namespace and a process', '$.steward');
  if (has(o, 'parent') && typeof o.parent !== 'string') fail('E_SCHEMA', 'parent is a class hash', '$.parent');
  if (has(o, 'final') && o.final !== true) fail('E_SCHEMA', 'final is true when present', '$.final');
  if (has(o, 'open')) structStringArray(o.open, '$.open', true);
  if (has(o, 'maps')) structStringArray(o.maps, '$.maps', true);
  if (has(o, 'inverse')) structStringArray(o.inverse, '$.inverse', true);
  if (has(o, 'implements')) structStringArray(o.implements, '$.implements', true);
  if (has(o, 'lookup') && typeof o.lookup !== 'string') fail('E_SCHEMA', 'lookup is a method name', '$.lookup');
  if (has(o, 'extent')) {
    const e = structObject(o.extent, '$.extent', [], ['exists', 'keys']);
    if (sortedKeys(e).length === 0) fail('E_SCHEMA', 'an optional member is absent rather than empty', '$.extent');
    for (const k of sortedKeys(e)) if (typeof e[k] !== 'string') fail('E_SCHEMA', 'an extent function is a hash', memberPath('$.extent', k));
  }
  return o;
}

// ---------------------------------------------------------------- class descriptors: the 16.1 member rules

/** A URL of an unrooted or rooted host's change process: an https URL by the licence rule of 8.1. */
function checkStewardProcess(v: string, path: string): void {
  if (!URL_RE.test(v) || v.length > LIMITS.licence_url) fail('E_CLASS_MEMBER', 'steward.process is an https URL', path);
}

/** A key of a class: a scalar key (type, unit for number, key_normalisation for string) or a class-typed key. */
function checkKeyDecl(decl: JsonObject, path: string): void {
  if (has(decl, 'class')) {
    checkFunctionName(decl.class as string, memberPath(path, 'class'));
    return;
  }
  const t = decl.type as string;
  if (!isTypeName(t) || t === 'blob') fail('E_CANON_TYPE', `a key is a scalar type but blob: ${JSON.stringify(t)}`, memberPath(path, 'type'));
  if (t === 'number') {
    if (!has(decl, 'unit')) fail('E_CANON_UNIT', 'a number key declares its unit', path);
    canonUnit(decl.unit as JsonValue, {}, memberPath(path, 'unit'));
  } else if (has(decl, 'unit')) {
    fail('E_CANON_UNIT', 'only a number key has a unit', memberPath(path, 'unit'));
  }
  if (t === 'string') {
    if (!has(decl, 'key_normalisation') || !isKeyRule(decl.key_normalisation, true)) {
      fail('E_CLASS_MEMBER', 'a string key declares one of the rules of 16.4 as key_normalisation', path);
    }
  } else if (has(decl, 'key_normalisation')) {
    fail('E_CLASS_MEMBER', 'only a string key has a key_normalisation', memberPath(path, 'key_normalisation'));
  }
}

/**
 * SPEC 16.1: the members' canonical rules, in the check order given there. Structure is checked
 * before (structClass). Parents, methods' functions and the interfaces are 16.2's, not here.
 */
function checkClassMembers(o: JsonObject): void {
  const keys = o.keys as JsonObject;
  if (Object.keys(keys).length > 32) fail('E_CANON_LIMIT', 'more than 32 keys', '$.keys');
  for (const k of sortedKeys(keys)) {
    const p = memberPath('$.keys', k);
    checkArgName(k, p);
    checkKeyDecl(keys[k] as JsonObject, p);
  }
  const order = o.order as string[];
  const keyNames = Object.keys(keys);
  if (order.length !== keyNames.length || new Set(order).size !== order.length || order.some((n) => !has(keys, n))) {
    fail('E_CANON_SET', 'order lists every key exactly once', '$.order');
  }
  const methods = o.methods as JsonObject;
  for (const m of sortedKeys(methods)) {
    const p = memberPath('$.methods', m);
    checkName(m, p);
    checkHex(methods[m] as string, 64, p);
  }
  const steward = o.steward as JsonObject;
  checkNamespace(steward.namespace as string, '$.steward.namespace');
  checkStewardProcess(steward.process as string, '$.steward.process');
  if (has(o, 'parent')) checkHex(o.parent as string, 64, '$.parent');
  if (has(o, 'open')) {
    const open = o.open as string[];
    if (!open.every((x, i) => i === 0 || open[i - 1] < x)) fail('E_CANON_SET', 'open is ascending and unique', '$.open');
    if (!has(o, 'final')) fail('E_CLASS_MEMBER', 'open is for a final class', '$.open');
    for (const m of open) if (!has(methods, m)) fail('E_CLASS_MEMBER', `open names no method: ${JSON.stringify(m)}`, '$.open');
  }
  if (has(o, 'maps')) {
    const maps = o.maps as string[];
    for (const [i, u] of maps.entries()) {
      if (!/^[a-z][a-z0-9+.-]*:[\x21-\x7e]*$/.test(u) || u.length > LIMITS.licence_url) fail('E_CLASS_MEMBER', 'maps holds URIs: a scheme and printable ASCII, at most 512 characters', `$.maps[${i}]`);
    }
    if (!maps.every((x, i) => i === 0 || maps[i - 1] < x)) fail('E_CANON_SET', 'maps is ascending and unique', '$.maps');
  }
  if (has(o, 'inverse')) {
    const inv = o.inverse as string[];
    if (!inv.every((x, i) => i === 0 || inv[i - 1] < x)) fail('E_CANON_SET', 'inverse is ascending and unique', '$.inverse');
    for (const a of inv) {
      checkName(a, '$.inverse');
      if (!has(methods, `by_${a}`)) fail('E_CLASS_MEMBER', `inverse ${a} needs the method by_${a}`, '$.inverse');
    }
  }
  if (has(o, 'lookup') && !has(methods, o.lookup as string)) fail('E_CLASS_MEMBER', 'lookup names a method of the class', '$.lookup');
  if (has(o, 'extent')) {
    const e = o.extent as JsonObject;
    for (const k of sortedKeys(e)) checkHex(e[k] as string, 64, memberPath('$.extent', k));
  }
  if (has(o, 'implements')) {
    const impl = o.implements as string[];
    for (const h of impl) checkHex(h, 64, '$.implements');
    if (!impl.every((x, i) => i === 0 || impl[i - 1] < x)) fail('E_CANON_SET', 'implements is ascending and unique', '$.implements');
  }
}

/** Structure and the 16.1 member rules of a flattened or written descriptor (no env). */
function checkClassDescriptor(v: JsonValue): JsonObject {
  const o = structClass(v);
  checkClassMembers(o);
  return o;
}

// ---------------------------------------------------------------- env indexes

/** Function descriptors of an env by their hash; a descriptor that is not valid has no hash here. */
function indexFunctions(list: unknown[]): Map<string, JsonObject> {
  const m = new Map<string, JsonObject>();
  for (const f of list) {
    let v: JsonValue;
    try {
      v = toJson(f);
      validate(v, 'function');
    } catch (e) {
      if (e instanceof DatumeshError) continue;
      throw e;
    }
    m.set(sha256(jcsBytes(v)), v as JsonObject);
  }
  return m;
}

/** Flattened class descriptors of an env by their class hash; an invalid one is left out. */
function indexClasses(list: unknown[]): Map<string, JsonObject> {
  const m = new Map<string, JsonObject>();
  for (const c of list) {
    let v: JsonValue;
    try {
      v = toJson(c);
      checkClassDescriptor(v);
    } catch (e) {
      if (e instanceof DatumeshError) continue;
      throw e;
    }
    m.set(sha256(jcsBytes(v)), v as JsonObject);
  }
  return m;
}

// ---------------------------------------------------------------- 16.2 define

/** Compare two JSON values by their canonical form. */
const same = (a: JsonValue | undefined, b: JsonValue | undefined): boolean => (a === undefined || b === undefined ? a === b : jcsOf(a) === jcsOf(b));

/** The keys a method of a class takes: the class keys, or the parent's for a method the parent had (16.2). */
function keyCount(name: string, parent: JsonObject | null, flat: JsonObject): number {
  return parent && has(parent.methods as JsonObject, name) ? (parent.order as string[]).length : (flat.order as string[]).length;
}

/** Whether a function's first arguments are the class keys in class order, with each key's declaration (16.2 step 6). */
function takesKeys(fn: JsonObject, flat: JsonObject, count: number, exact: boolean, what: string, rules: boolean, code: 'E_CLASS_METHOD' | 'E_CLASS_MEMBER' = 'E_CLASS_METHOD'): void {
  function bad(detail: string): never {
    return fail(code, detail, '$');
  }
  const sig = fn.signature as JsonObject;
  const args = sig.args as JsonObject;
  const order = sig.order as string[] | undefined;
  if (!order) bad(`${what} has no order`);
  const keys = flat.keys as JsonObject;
  const classOrder = flat.order as string[];
  if (order.length < count || (exact && order.length !== count) || Object.keys(args).length < count) bad(`${what} does not take the class keys`);
  for (let i = 0; i < count; i++) {
    const k = classOrder[i];
    if (order[i] !== k) bad(`${what} takes the class keys in class order`);
    const decl = keys[k] as JsonObject;
    const arg = has(args, k) ? (args[k] as JsonObject) : null;
    if (!arg) bad(`${what} takes the key ${k}`);
    if (has(decl, 'class')) {
      if (arg.type !== 'string' || !same(arg.classes, [decl.class as string]) || has(arg, 'key_normalisation')) bad(`${what}: key ${k} is an object key of ${decl.class as string}`);
    } else {
      if (arg.type !== decl.type) bad(`${what}: key ${k} has the key's type`);
      if (decl.type === 'number' && !same(arg.unit, decl.unit)) bad(`${what}: key ${k} has the key's unit`);
      if (rules && decl.type === 'string' && ((arg.key_normalisation as string | undefined) ?? 'none') !== (decl.key_normalisation as string)) {
        bad(`${what}: key ${k} carries the key's normalisation`);
      }
    }
  }
}

/** The lookup method (16.1, 16.2 step 6): exactly one string argument label, returning a key of this class. */
function checkLookup(fn: JsonObject, name: string): void {
  const sig = fn.signature as JsonObject;
  const args = sig.args as JsonObject;
  const ok =
    sortedKeys(args).join() === 'label' &&
    same(sig.order as JsonValue, ['label']) &&
    isObject(args.label) &&
    (args.label as JsonObject).type === 'string' &&
    (args.label as JsonObject).valid === false &&
    !has(args.label as JsonObject, 'classes') &&
    isObject(sig.returns) &&
    sortedKeys(sig.returns as JsonObject).join() === 'classes,type' &&
    (sig.returns as JsonObject).type === 'string' &&
    same((sig.returns as JsonObject).classes, [name]);
  if (!ok) fail('E_CLASS_MEMBER', 'lookup takes exactly one string argument label and returns a key of this class', '$.lookup');
}

/** A returned key of the named classes (16.2 step 6, same_as and by_<attribute>). */
function returnsKeyOf(fn: JsonObject, classes: JsonValue | null): boolean {
  const r = (fn.signature as JsonObject).returns;
  if (!isObject(r) || r.type !== 'string' || !has(r, 'classes')) return false;
  if (classes === null) return true;
  return same(r.classes, classes);
}

/**
 * Define a class (16.2): check `descriptor` (the author's JSON text, bytes or parsed object) under
 * the class `name`, flatten it onto its parent from `env.classes`, check methods against
 * `env.functions`, and return the flattened descriptor and class hash. Throws DatumeshError with
 * the first failure in 16.1/16.2 check order.
 */
export function defineClass(descriptor: unknown, name: string, env: ClassEnv): ClassDefinition {
  if (typeof name !== 'string') throw new TypeError('defineClass(descriptor, name, env): name is a string');
  if (!env || typeof env !== 'object' || typeof env.definer !== 'string' || !Array.isArray(env.functions) || !Array.isArray(env.classes)) {
    throw new TypeError('defineClass(descriptor, name, env): env is {definer, functions, classes}');
  }
  const written = toJson(descriptor);
  // 1. The name (2.3), then the owner (E_CLASS_OWNER: the definer's namespace is the class's).
  checkFunctionName(name, '$name');
  if (!name.startsWith(`${env.definer}/`)) fail('E_CLASS_OWNER', `${env.definer} defines classes under itself only, not ${name}`, '$name');
  // 2. The descriptor as written (16.1).
  const own = checkClassDescriptor(written);
  const fns = indexFunctions(env.functions);
  const classes = indexClasses(env.classes);
  // 3. The parent: known, no key redeclared; flatten.
  let parent: JsonObject | null = null;
  let flat: JsonObject;
  if (has(own, 'parent')) {
    parent = classes.get(own.parent as string) ?? null;
    if (!parent) fail('E_CLASS_PARENT', 'the parent class descriptor is not known to define', '$.parent');
    for (const k of Object.keys(own.keys as JsonObject)) {
      if (has(parent.keys as JsonObject, k)) fail('E_CLASS_INHERIT', `key ${k} is inherited, not declared again`, '$.keys');
    }
    // 4. Overrides: a method of a final parent not listed in its open is not overridden; an override
    // keeps the signature of the method it overrides.
    const ownMethods = own.methods as JsonObject;
    const parentMethods = parent.methods as JsonObject;
    for (const m of sortedKeys(ownMethods)) {
      if (!has(parentMethods, m) || parentMethods[m] === ownMethods[m]) continue;
      if (parent.final === true && !((parent.open as string[] | undefined) ?? []).includes(m)) fail('E_CLASS_FINAL', `${m} is final in the parent`, `$.methods.${m}`);
      const a = fns.get(parentMethods[m] as string);
      const b = fns.get(ownMethods[m] as string);
      if (a && b && (!same((a.signature as JsonObject).args, (b.signature as JsonObject).args) || !same((a.signature as JsonObject).returns, (b.signature as JsonObject).returns) || !same((a.signature as JsonObject).order, (b.signature as JsonObject).order))) {
        fail('E_CLASS_OVERRIDE', `${m} keeps the signature of the method it overrides`, `$.methods.${m}`);
      }
    }
    flat = flatten(own, parent);
  } else {
    flat = own;
  }
  // 5. The flattened descriptor, as a class descriptor again.
  checkClassMembers(flat);
  // 6. Methods, in JCS order of names.
  const methods = flat.methods as JsonObject;
  const inverse = (flat.inverse as string[] | undefined) ?? [];
  for (const m of sortedKeys(methods)) {
    const fn = fns.get(methods[m] as string);
    if (!fn) fail('E_CLASS_METHOD', `no function descriptor for method ${m}`, `$.methods.${m}`);
    if (has(flat, 'lookup') && flat.lookup === m) {
      checkLookup(fn, name);
      continue;
    }
    takesKeys(fn, flat, keyCount(m, parent, flat), false, `method ${m}`, true);
    if (m === 'same_as' && !returnsKeyOf(fn, null)) fail('E_CLASS_METHOD', 'same_as returns a key of another class', `$.methods.${m}`);
    if (m === 'same_as' && returnsKeyOf(fn, [name])) fail('E_CLASS_METHOD', 'same_as returns a key of another class, not this one', `$.methods.${m}`);
    if (m.startsWith('by_') && inverse.includes(m.slice(3)) && !returnsKeyOf(fn, [name])) fail('E_CLASS_METHOD', `${m} returns a key of this class`, `$.methods.${m}`);
  }
  // 7. Extent: functions taking exactly the class keys and returning a boolean.
  if (has(flat, 'extent')) {
    const e = flat.extent as JsonObject;
    for (const k of sortedKeys(e)) {
      const fn = fns.get(e[k] as string);
      if (!fn) fail('E_CLASS_MEMBER', `no function descriptor for extent.${k}`, `$.extent.${k}`);
      takesKeys(fn, flat, (flat.order as string[]).length, true, `extent.${k}`, false, 'E_CLASS_MEMBER');
      if ((fn.signature as JsonObject).returns !== 'boolean') fail('E_CLASS_MEMBER', `extent.${k} returns a boolean`, `$.extent.${k}`);
    }
  }
  // 8. Interfaces: keyless classes whose methods the class has, with the same signature once the keys are taken away.
  for (const h of (flat.implements as string[] | undefined) ?? []) {
    const iface = classes.get(h);
    if (!iface || sortedKeys(iface.keys as JsonObject).length !== 0) fail('E_CLASS_INTERFACE', 'implements names a keyless class the define knows', '$.implements');
    const imethods = iface.methods as JsonObject;
    for (const im of sortedKeys(imethods)) {
      if (!has(methods, im)) fail('E_CLASS_INTERFACE', `the class has the interface method ${im}`, '$.implements');
      const want = fns.get(imethods[im] as string);
      const got = fns.get(methods[im] as string);
      if (!want || !got) fail('E_CLASS_INTERFACE', `no function descriptor for ${im}`, '$.implements');
      const n = keyCount(im, parent, flat);
      const gs = got.signature as JsonObject;
      const ws = want.signature as JsonObject;
      const rest = (gs.order as string[]).slice(n);
      const restArgs = newObject();
      for (const a of rest) restArgs[a] = (gs.args as JsonObject)[a];
      if (!same(rest as unknown as JsonValue, ws.order as JsonValue) || !same(restArgs, ws.args) || !same(gs.returns, ws.returns)) {
        fail('E_CLASS_INTERFACE', `the class method ${im} has the interface's signature once the keys are taken away`, '$.implements');
      }
    }
  }
  const flattened = jcsOf(flat);
  return { flattened, classHash: sha256(jcsBytes(flat)) };
}

/** Flattening (16.2 step 3): keys and order of the parent then the class's own, methods overlaid, implements the union. */
function flatten(own: JsonObject, parent: JsonObject): JsonObject {
  const out = newObject();
  out.steward = own.steward;
  out.keys = { ...(parent.keys as JsonObject), ...(own.keys as JsonObject) } as JsonValue;
  out.order = [...(parent.order as string[]), ...(own.order as string[])];
  out.methods = { ...(parent.methods as JsonObject), ...(own.methods as JsonObject) } as JsonValue;
  const impl = [...new Set([...((parent.implements as string[] | undefined) ?? []), ...((own.implements as string[] | undefined) ?? [])])].sort();
  if (impl.length > 0) out.implements = impl;
  for (const k of ['parent', 'final', 'open', 'maps', 'inverse', 'lookup', 'extent']) if (has(own, k)) out[k] = own[k];
  return out;
}

/** Class hash (16.1): SHA-256 of the canonical bytes of a flattened class descriptor, checked as 16.1 does. */
export function classHash(flattened: unknown): string {
  const v = toJson(flattened);
  checkClassDescriptor(v);
  return sha256(jcsBytes(v));
}

// ---------------------------------------------------------------- 16.5 object keys

const KEY_NAME_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** A key name in an encoding: an argument name (2.4), not reserved; anything else is E_KEY_ENCODING. */
function keyNameOk(s: string): boolean {
  return KEY_NAME_RE.test(s) && s.length <= LIMITS.name && s !== 'asof' && s !== 'fn_hash' && !s.startsWith('dm_');
}

/** A full class name in an encoding (2.3). */
function classNameOk(s: string): boolean {
  try {
    checkFunctionName(s, '$');
    return true;
  } catch (e) {
    if (e instanceof DatumeshError) return false;
    throw e;
  }
}

/** Quote a string as 16.5 does: `"` doubled inside. */
const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/**
 * Parse a key encoding (16.5). Throws DatumeshError E_KEY_ENCODING unless `encoding` is exactly the
 * canonical encoding of what it decodes to. `encoding` is text.
 */
export function parseObjectKey(encoding: string): DecodedObject {
  if (typeof encoding !== 'string') throw new TypeError('parseObjectKey(encoding): encoding is a string');
  const s = encoding;
  let i = 0;
  const peek = (): string => s.charAt(i);
  const take = (c: string): void => {
    if (s.charAt(i) !== c) encodingFailure(`expected ${JSON.stringify(c)} at ${i}`);
    i++;
  };
  const readEncoding = (depth: number): DecodedObject => {
    if (depth > 8) encodingFailure('nested too deeply');
    const open = s.indexOf('(', i);
    if (open < 0) encodingFailure('a key encoding is a class name and (');
    const cls = s.slice(i, open);
    if (!classNameOk(cls)) encodingFailure(`not a full class name: ${JSON.stringify(cls)}`);
    i = open + 1;
    const keys: { [name: string]: TypedScalar | DecodedObject } = {};
    let last: string | null = null;
    if (peek() === ')') {
      i++;
      return { class: cls, keys };
    }
    for (;;) {
      const colon = s.indexOf(':', i);
      if (colon < 0) encodingFailure('a key pair is name:value');
      const name = s.slice(i, colon);
      if (!keyNameOk(name)) encodingFailure(`not a key name: ${JSON.stringify(name)}`);
      if (last !== null && !(last < name)) encodingFailure('key names are strictly ascending');
      last = name;
      i = colon + 1;
      keys[name] = readValue(depth);
      if (peek() === ',') {
        i++;
        continue;
      }
      take(')');
      return { class: cls, keys };
    }
  };
  const readValue = (depth: number): TypedScalar | DecodedObject => {
    if (peek() === '"') {
      i++;
      let value = '';
      for (;;) {
        if (i >= s.length) encodingFailure('an unclosed string');
        const c = s.charAt(i);
        if (c === '"') {
          if (s.charAt(i + 1) === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += c;
        i++;
      }
      checkKeyScalar('string', value);
      return { type: 'string', value };
    }
    // An unquoted token: a nested encoding, or a scalar up to the next , or ).
    let j = i;
    while (j < s.length && s[j] !== ',' && s[j] !== ')' && s[j] !== '(') j++;
    if (s[j] === '(') return readEncoding(depth + 1);
    const tok = s.slice(i, j);
    i = j;
    if (tok === 'true' || tok === 'false') return { type: 'boolean', value: tok === 'true' };
    if (isInstant(tok)) return { type: 'instant', value: tok };
    if (isDate(tok)) return { type: 'date', value: tok };
    if (isNumber(tok)) return { type: 'number', value: tok };
    encodingFailure(`not a key value: ${JSON.stringify(tok)}`);
  };
  const d = readEncoding(0);
  if (i !== s.length) encodingFailure('nothing after the key encoding');
  return d;
}

/**
 * Format a decoded object as its one canonical key encoding (16.5): keys sorted by name, strings
 * quoted with `"` doubled, nested objects unquoted. Throws DatumeshError E_KEY_ENCODING for an
 * object that is not well formed, TypeError when it is not an object.
 */
export function formatObjectKey(object: DecodedObject): string {
  if (!isObject(object as unknown as JsonValue)) throw new TypeError('formatObjectKey(object): object is an object');
  const o = object as unknown as JsonObject;
  if (typeof o.class !== 'string' || !classNameOk(o.class)) encodingFailure('a class is a full class name');
  if (!isObject(o.keys)) encodingFailure('keys is an object');
  const keys = o.keys as JsonObject;
  const parts: string[] = [];
  for (const name of sortedKeys(keys)) {
    if (!keyNameOk(name)) encodingFailure(`not a key name: ${JSON.stringify(name)}`);
    const v = keys[name];
    if (!isObject(v)) encodingFailure('a key value is an object');
    if (has(v, 'class')) {
      parts.push(`${name}:${formatObjectKey(v as unknown as DecodedObject)}`);
      continue;
    }
    if (sortedKeys(v).join() !== 'type,value') encodingFailure('a scalar key has a type and a value');
    const t = v.type;
    if (typeof t !== 'string' || !['boolean', 'date', 'instant', 'number', 'string'].includes(t)) encodingFailure('a key type is boolean, date, instant, number or string');
    checkKeyScalar(t, v.value);
    parts.push(`${name}:${t === 'string' ? quote(v.value as string) : String(v.value)}`);
  }
  return `${o.class}(${parts.join(',')})`;
}

/** The object's JSON form, validated: `{"class", "class_hash", "keys"}`, each key a typed scalar. */
function objectValue(object: unknown): JsonObject {
  const v = toJson(object as JsonValue);
  if (!isObject(v)) fail('E_SCHEMA', 'an object is a JSON object', '$');
  structMembers(v, ['class', 'class_hash', 'keys'], [], '$');
  if (typeof v.class !== 'string' || !classNameOk(v.class)) fail('E_SCHEMA', 'class is a full class name', '$.class');
  if (!isLowerHex64(v.class_hash)) fail('E_CANON_HEX', 'class_hash is 64 lowercase hex digits', '$.class_hash');
  const keys = v.keys;
  if (!isObject(keys)) fail('E_SCHEMA', 'keys is an object', '$.keys');
  for (const k of sortedKeys(keys)) {
    const p = memberPath('$.keys', k);
    checkArgName(k, p);
    const sc = keys[k];
    if (!isObject(sc)) fail('E_SCHEMA', 'a key is a typed scalar', p);
    structMembers(sc, ['type', 'value'], [], p);
    if (typeof sc.type !== 'string' || !isTypeName(sc.type) || sc.type === 'blob') fail('E_CANON_TYPE', 'a key is a scalar type but blob', memberPath(p, 'type'));
    checkTyped(sc.type as TypeName, sc.value, memberPath(p, 'value'));
  }
  return v;
}

function checkTyped(type: TypeName, value: JsonValue, path: string): void {
  if (type === 'boolean') {
    if (typeof value !== 'boolean') fail('E_CANON_TYPE', 'boolean value is true or false', path);
    return;
  }
  if (typeof value !== 'string') fail('E_CANON_TYPE', `${type} value is a string of its lexical form`, path);
  if (type === 'number') {
    if (!isNumber(value)) fail('E_CANON_NUMBER', 'not a canonical number', path);
  } else if (type === 'date') checkDate(value, path);
  else if (type === 'instant') checkInstant(value, path);
  else checkString(value, path);
}

/**
 * The canonical bytes (6.2) of an object `{"class", "class_hash", "keys"}` (16.5), given as JSON
 * text, bytes or a parsed object. Throws DatumeshError for a malformed object (the code is the
 * validator's; a class-typed key has no form in the object JSON, see DEFECTS.md).
 */
export function objectJson(object: unknown): Uint8Array {
  return jcsBytes(objectValue(object));
}

/** Object id (16.5): SHA-256 of the object's canonical bytes, lowercase hex. */
export function objectId(object: unknown): string {
  return sha256(objectJson(object));
}

/** Short id (16.8): the first 12 hex digits of a cell id or object id (64 lowercase hex digits, else E_CANON_HEX). */
export function shortId(id: string): string {
  if (typeof id !== 'string') throw new TypeError('shortId(id): id is a string');
  if (!isLowerHex64(id)) fail('E_CANON_HEX', 'an id is 64 lowercase hex digits', '$');
  return id.slice(0, 12);
}

// ---------------------------------------------------------------- 16.8 describe

/** The canonical call form of an object (16.8): class name and every key labelled in ascending order. */
function callForm(object: JsonObject): string {
  const keys = object.keys as JsonObject;
  const parts = sortedKeys(keys).map((k) => {
    const sc = keys[k] as JsonObject;
    const lit = sc.type === 'string' ? quote(sc.value as string) : String(sc.value);
    return `${k}: ${lit}`;
  });
  return `${object.class as string}(${parts.join(', ')})`;
}

const hasExactly = (o: JsonObject, required: readonly string[], optional: readonly string[], what: string): void => {
  for (const n of [...new Set([...Object.keys(o), ...required])].sort()) {
    if (!has(o, n)) fail('E_DESCRIBE', `${what} has no ${n}`, '$');
    if (!required.includes(n) && !optional.includes(n)) fail('E_DESCRIBE', `${what} has no member ${n}`, '$');
  }
};

/**
 * Check a describe answer (16.8), JSON text, bytes or a parsed object, against what the caller
 * holds: `classes`, from class name to flattened class descriptor (an object; may be empty).
 * Throws DatumeshError E_DESCRIBE (or the parse codes for text that is not strict JSON).
 */
export function checkDescribe(answer: unknown, classes: { [name: string]: unknown }): DescribeResult {
  if (!classes || typeof classes !== 'object') throw new TypeError('checkDescribe(answer, classes): classes is an object');
  const a = toJson(answer as JsonValue);
  if (!isObject(a)) fail('E_DESCRIBE', 'a describe answer is a JSON object', '$');
  try {
    if (a.kind === 'class') {
      checkClassAnswer(a);
      return { kind: 'class' };
    }
    if (a.kind === 'object') {
      checkObjectAnswer(a, classes);
      return { kind: 'object' };
    }
    fail('E_DESCRIBE', 'kind is class or object', '$.kind');
  } catch (e) {
    if (e instanceof DatumeshError && e.code !== 'E_DESCRIBE') fail('E_DESCRIBE', e.detail, e.path);
    throw e;
  }
}

function checkClassAnswer(a: JsonObject): void {
  hasExactly(a, ['kind', 'class', 'class_hash', 'descriptor', 'methods'], [], 'a class answer');
  if (typeof a.class !== 'string') fail('E_DESCRIBE', 'class is a name', '$.class');
  checkFunctionName(a.class, '$.class');
  if (!isObject(a.descriptor)) fail('E_DESCRIBE', 'descriptor is an object', '$.descriptor');
  const desc = checkClassDescriptor(a.descriptor);
  if (a.class_hash !== sha256(jcsBytes(desc))) fail('E_DESCRIBE', 'class_hash is the hash of the descriptor', '$.class_hash');
  if (!isObject(a.methods)) fail('E_DESCRIBE', 'methods is an object', '$.methods');
  const table = a.methods as JsonObject;
  const dm = desc.methods as JsonObject;
  if (sortedKeys(table).join() !== sortedKeys(dm).join()) fail('E_DESCRIBE', 'the method table lists the descriptor\'s methods and no other', '$.methods');
  for (const m of sortedKeys(table)) {
    const e = table[m];
    if (!isObject(e)) fail('E_DESCRIBE', 'a method entry is an object', `$.methods.${m}`);
    hasExactly(e, ['fn', 'fn_hash', 'args', 'returns'], ['description'], `method ${m}`);
    if (e.fn !== `${a.class as string}/${m}`) fail('E_DESCRIBE', 'fn is the class name and the method name', `$.methods.${m}.fn`);
    if (e.fn_hash !== dm[m]) fail('E_DESCRIBE', 'fn_hash is the descriptor\'s hash for the method', `$.methods.${m}.fn_hash`);
    if (!isObject(e.args)) fail('E_DESCRIBE', 'args is an object', `$.methods.${m}.args`);
    if (has(e, 'description')) {
      if (typeof e.description !== 'string' || utf8Length(e.description) > 1024) fail('E_DESCRIBE', 'description is a string of at most 1024 bytes', `$.methods.${m}.description`);
    }
  }
}

function checkObjectAnswer(a: JsonObject, classes: { [name: string]: unknown }): void {
  hasExactly(a, ['kind', 'object', 'object_id', 'short_id', 'call', 'methods'], ['same_as'], 'an object answer');
  const obj = objectValue(a.object);
  const id = sha256(jcsBytes(obj));
  if (a.object_id !== id) fail('E_DESCRIBE', 'object_id is the object\'s id', '$.object_id');
  if (a.short_id !== id.slice(0, 12)) fail('E_DESCRIBE', 'short_id is the first 12 hex digits of object_id', '$.short_id');
  if (a.call !== callForm(obj)) fail('E_DESCRIBE', 'call is the object\'s call form', '$.call');
  if (!Array.isArray(a.methods) || a.methods.some((x) => typeof x !== 'string')) fail('E_DESCRIBE', 'methods is an array of names', '$.methods');
  const methods = a.methods as string[];
  if (!methods.every((x, i) => i === 0 || methods[i - 1] < x)) fail('E_DESCRIBE', 'methods is ascending and unique', '$.methods');
  if (has(a, 'same_as')) {
    if (!Array.isArray(a.same_as) || a.same_as.length === 0) fail('E_DESCRIBE', 'same_as is a non-empty array', '$.same_as');
    for (const k of a.same_as as JsonValue[]) {
      if (typeof k !== 'string') fail('E_DESCRIBE', 'same_as holds key encodings', '$.same_as');
      parseObjectKey(k);
    }
  }
  // A held class (found by the object's class hash) gives its keys and methods.
  for (const name of sortedKeys(classes as JsonObject)) {
    let held: JsonObject;
    try {
      held = checkClassDescriptor(toJson(classes[name] as JsonValue));
    } catch (e) {
      if (e instanceof DatumeshError) continue;
      throw e;
    }
    if (sha256(jcsBytes(held)) !== obj.class_hash) continue;
    const hk = held.keys as JsonObject;
    const ok = obj.keys as JsonObject;
    if (sortedKeys(hk).join() !== sortedKeys(ok).join()) fail('E_DESCRIBE', 'the object\'s keys are the class\'s', '$.object.keys');
    for (const k of sortedKeys(hk)) {
      if ((hk[k] as JsonObject).type !== (ok[k] as JsonObject).type) fail('E_DESCRIBE', `key ${k} has the class's type`, '$.object.keys');
    }
    if (methods.join() !== sortedKeys(held.methods as JsonObject).join()) fail('E_DESCRIBE', 'the object\'s methods are the class\'s', '$.methods');
    return;
  }
  if (!Array.isArray(a.methods)) fail('E_DESCRIBE', 'methods is an array', '$.methods');
}

// ---------------------------------------------------------------- 2.5 define

/**
 * The define-time check of a function (2.5, 7): `name` is a full function name (E_CANON_NAME),
 * `descriptor` a function descriptor (the codes of canonicalising it), and a function under a
 * rooted namespace has no input under an unrooted one (E_UNROOTED_INPUT, at the first such input
 * in `inputs` order). Formula bodies' own rules (15.6) are not checked. Returns the canonical
 * bytes and function hash.
 */
export function checkDefine(descriptor: unknown, name: string): { canonical: Uint8Array; hash: string } {
  if (typeof name !== 'string') throw new TypeError('checkDefine(descriptor, name): name is a string');
  checkFunctionName(name, '$name');
  const v = toJson(descriptor);
  validate(v, 'function');
  const canonical = jcsBytes(v);
  if (!isUnrooted(namespaceOf(name))) {
    for (const input of (v as JsonObject).inputs as string[]) {
      if (isUnrooted(namespaceOf(input))) fail('E_UNROOTED_INPUT', `a rooted function reads ${input}, under an unrooted namespace`, '$.inputs');
    }
  }
  return { canonical, hash: sha256(canonical) };
}
