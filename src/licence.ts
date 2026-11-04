// Since spec-0.4.3: licence inheritance (SPEC.md 8.5), the entitlement check (10.3), the input
// licences of a receipt (10.3, followed as step 7.5 obtains them) and unrooted namespaces (2.5).
// Pure functions: no keys are fetched and nothing is evaluated.
import { DatumeshError, fail } from './errors.js';
import { sha256Hex } from './hash.js';
import { jcsBytes } from './jcs.js';
import { isObject, toJson, type JsonObject, type JsonValue } from './json.js';
import { checkFunctionName, checkInstant, checkLicence, checkNamespace } from './lexical.js';
import { collectSources, keysFromDocument, validateDeclarations, type Declarations, type KeysResult } from './keys.js';
import { validate } from './validate.js';
import { Stop, verifySigned } from './verify.js';

/** The named outcomes of the inheritance rule (8.5): three give a licence, four refuse. */
export type LicenceReason = 'no_inputs' | 'open' | 'declared' | 'share_alike_conflict' | 'restricted_conflict' | 'not_declared' | 'declaration_not_open';

/** The eight reasons of the entitlement check (10.3): the rule's seven and `licence_mismatch`. */
export type EntitlementReason = LicenceReason | 'licence_mismatch';

/** The result of the inheritance rule (8.5). */
export interface LicenceResult {
  /** The result's licence, or null when the mesh may not compute the cell (it answers `unlicensed`). */
  licence: string | null;
  /** The step that decided. */
  reason: LicenceReason;
}

/** The answer of the entitlement check (10.3). */
export interface EntitlementResult {
  entitled: boolean;
  reason: EntitlementReason;
  /** The licence the rule of 8.5 gives for the receipt, or null when the rule refuses. */
  licence: string | null;
}

/** SPEC 8.5: the open tiers, each in its listed order (least to most demanding). */
export const LICENCE_TIERS: readonly (readonly string[])[] = [
  ['CC0-1.0', 'PDDL-1.0'],
  ['MIT', 'Apache-2.0', 'CC-BY-4.0', 'OGL-UK-3.0'],
  ['CC-BY-SA-4.0', 'ODbL-1.0'],
];

function tierOf(licence: string): 1 | 2 | 3 | 4 {
  for (let i = 0; i < 3; i++) if (LICENCE_TIERS[i].includes(licence)) return (i + 1) as 1 | 2 | 3;
  return 4;
}

function licenceArg(l: unknown, what: string): string {
  if (typeof l !== 'string') throw new TypeError(`${what} must be a licence string`);
  checkLicence(l, '$');
  return l;
}

/**
 * The tier of a licence (SPEC 8.5): 1 public domain, 2 attribution, 3 share-alike, 4 restricted
 * (any https:// URL and any other identifier). Compared byte for byte: `cc0-1.0` is restricted.
 * Throws DatumeshError (E_CANON_LICENCE, E_CANON_LIMIT) for a string that is not a licence by 8.1.
 */
export function licenceTier(licence: string): 1 | 2 | 3 | 4 {
  return tierOf(licenceArg(licence, 'licence'));
}

/** Declarations as the rule reads them: a function name to its entries. Type-checked only. */
function declarationsArg(d: unknown): Declarations {
  if (d === null || d === undefined) return {};
  if (!isObject(d as JsonValue)) throw new TypeError('declarations must be an object mapping a function name to its entries, or null for none');
  const out: Declarations = Object.create(null);
  for (const [name, entries] of Object.entries(d as Record<string, unknown>)) {
    if (!Array.isArray(entries)) throw new TypeError(`declarations[${JSON.stringify(name)}] must be an array of entries`);
    out[name] = entries.map((e, i) => {
      const ok =
        isObject(e as JsonValue) &&
        typeof (e as Record<string, unknown>).licence === 'string' &&
        typeof (e as Record<string, unknown>).valid_from === 'string' &&
        ((e as Record<string, unknown>).valid_to === undefined || typeof (e as Record<string, unknown>).valid_to === 'string');
      if (!ok) throw new TypeError(`declarations[${JSON.stringify(name)}][${i}] must be {licence, valid_from, valid_to?}, all strings`);
      return e as Declarations[string][number];
    });
  }
  return out;
}

/** The rule of 8.5 on checked arguments. */
function rule(L: readonly string[], D: Declarations, fn: string, issued: string, meshLicence: string): LicenceResult {
  // 1. No inputs: the mesh's own licence.
  if (L.length === 0) return { licence: meshLicence, reason: 'no_inputs' };
  const distinct = [...new Set(L)];
  const shareAlike = distinct.filter((l) => tierOf(l) === 3);
  const restricted = distinct.filter((l) => tierOf(l) === 4);
  // 2. Share-alike with a different share-alike licence, or with any restricted one.
  if (shareAlike.length > 0 && (shareAlike.length > 1 || restricted.length > 0)) return { licence: null, reason: 'share_alike_conflict' };
  // 3. Two different restricted licences.
  if (restricted.length > 1) return { licence: null, reason: 'restricted_conflict' };
  // 4. One restricted licence: declared for fn, open at issued (valid_from <= issued < valid_to).
  if (restricted.length === 1) {
    const r = restricted[0];
    const own = Object.prototype.hasOwnProperty.call(D, fn) ? D[fn] : [];
    const naming = own.filter((e) => e.licence === r);
    if (naming.length === 0) return { licence: null, reason: 'not_declared' };
    // Instants are fixed width, so string order is time order (SPEC 3.3).
    if (!naming.some((e) => e.valid_from <= issued && (e.valid_to === undefined || issued < e.valid_to))) return { licence: null, reason: 'declaration_not_open' };
    return { licence: r, reason: 'declared' };
  }
  // 5. Open inputs only: the highest tier present, and in it the identifier listed last.
  for (let t = 2; t >= 0; t--) {
    const present = LICENCE_TIERS[t].filter((l) => distinct.includes(l));
    if (present.length) return { licence: present[present.length - 1], reason: 'open' };
  }
  /* c8 ignore next */
  throw new Error('unreachable: every licence has a tier');
}

/**
 * Licence inheritance (SPEC 8.5) as a pure function. `licences` are the input receipts' licences
 * (slice members included, repeats allowed); `declarations` the function's publisher's (9.2:
 * from the key document of the host of `cell.ns`), `{}`, null or undefined for none; `fn` the
 * function's full name (`cell.ns + "/" + cell.fn`); `issued` the receipt's `issued`; `meshLicence`
 * the mesh's own licence, for a cell with no input receipt. Returns the result's licence with the
 * step that decided, or `licence: null` with the reason the mesh refuses (it answers
 * `unlicensed`). Throws TypeError for arguments of the wrong JS type, and DatumeshError for a
 * licence, function name or instant that breaks its grammar (8.1, 2.3, 3.3).
 */
export function inheritLicence(licences: readonly string[], declarations: Declarations | null | undefined, fn: string, issued: string, meshLicence: string): LicenceResult {
  if (!Array.isArray(licences)) throw new TypeError('licences must be an array of licence strings');
  const L = licences.map((l, i) => licenceArg(l, `licences[${i}]`));
  const D = declarationsArg(declarations);
  if (typeof fn !== 'string') throw new TypeError('fn must be a full function name');
  checkFunctionName(fn, '$');
  if (typeof issued !== 'string') throw new TypeError('issued must be an instant');
  checkInstant(issued, '$');
  return rule(L, D, fn, issued, licenceArg(meshLicence, 'meshLicence'));
}

function receiptArg(receipt: unknown): JsonObject {
  const r = toJson(receipt);
  validate(r, 'receipt');
  return r as JsonObject;
}

/** K for the entitlement check: a checked key document, as a KeysResult, a parsed document or its JSON text. */
function keyDocumentArg(k: unknown): KeysResult {
  let r: KeysResult;
  if (typeof k === 'string' || k instanceof Uint8Array) r = keysFromDocumentText(k);
  else if (isObject(k as JsonValue) && typeof (k as Record<string, unknown>).ok === 'boolean' && typeof (k as Record<string, unknown>).host === 'string') r = k as KeysResult;
  else if (isObject(k as JsonValue)) r = keysFromDocument(k);
  else throw new TypeError('the key document must be a KeysResult, a parsed key document or its JSON text');
  if (!r.ok) throw new TypeError(`the key document is not a valid key document (${r.code}: ${r.detail})`);
  if (r.declarations !== undefined) {
    // A KeysResult may have been built by hand: hold its declarations to 9.2 as well.
    try {
      validateDeclarations(r.declarations as unknown as JsonValue, r.host);
    } catch (e) {
      throw new TypeError(`the key document's declarations break SPEC 9.2: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return r;
}

function keysFromDocumentText(t: string | Uint8Array): KeysResult {
  let doc: JsonValue;
  try {
    doc = toJson(t);
  } catch (e) {
    throw new TypeError(`the key document is not strict JSON (${e instanceof DatumeshError ? e.code : String(e)})`);
  }
  return keysFromDocument(doc);
}

/**
 * The entitlement check (SPEC 10.3) as a pure function of R, L and K. `receipt` is R (JSON text,
 * bytes or a parsed object; checked as a receipt, DatumeshError if it is not one); it should have
 * passed verification (10.1) first, which this function does not repeat. `inputLicences` is L,
 * the licences of R's input receipts, slice members included, one per receipt (see
 * `inputLicences`). `keyDocument` is K, the key document of R's publisher's host, the host of
 * `R.cell.ns` (whatever host signed): a KeysResult (from `keysFromResponse` or `fetchKeys`), a
 * parsed key document or its JSON text. Returns entitled or not with one of the eight reasons,
 * and the licence the rule gives (null when it refuses). The answer is about the licence only:
 * it is not a verification result.
 *
 * A K of another host, a K that is not a valid key document, an L that is not an array of
 * licences, or a non-empty L for a receipt without inputs, is the caller's error: TypeError.
 */
export function checkEntitlement(receipt: unknown, inputLicences: readonly string[], keyDocument: unknown): EntitlementResult {
  const R = receiptArg(receipt);
  if (!Array.isArray(inputLicences)) throw new TypeError('inputLicences must be an array of licence strings (the licences of the input receipts)');
  const L = inputLicences.map((l, i) => licenceArg(l, `inputLicences[${i}]`));
  const cell = R.cell as JsonObject;
  const ns = cell.ns as string;
  const host = ns.split('/')[0];
  const K = keyDocumentArg(keyDocument);
  if (K.host !== host) throw new TypeError(`the key document is for ${K.host}, not for ${host}, the host of the receipt's cell.ns (SPEC 10.3)`);
  if ((R.inputs as string[]).length === 0 && L.length > 0) throw new TypeError('the receipt has no inputs, so it has no input licences');
  const fn = `${ns}/${cell.fn as string}`;
  // 1. The rule of 8.5, with R.licence standing for the mesh's own licence.
  const r = rule(L, K.declarations ?? {}, fn, R.issued as string, R.licence as string);
  // 2. A refusal: not entitled, with the step's reason.
  if (r.licence === null) return { entitled: false, reason: r.reason, licence: null };
  // 3. Another licence than R's, byte for byte.
  if (r.licence !== R.licence) return { entitled: false, reason: 'licence_mismatch', licence: r.licence };
  // 4. Entitled, with the rule's reason.
  return { entitled: true, reason: r.reason, licence: r.licence };
}

/**
 * L for the entitlement check (SPEC 10.3): the licences of R's input receipts, in R's `inputs`
 * order, a slice entry giving one licence per member receipt in manifest order. `receipts` maps
 * a receipt hash to the input receipt (JSON text, bytes or a parsed object), slice members
 * included; `manifests` maps a slice entry to its manifest `{"members", "slice"}`, as for
 * `verify`'s `recompute`. Each receipt and manifest must hash to the entry that names it, as step
 * 7.5 obtains them: one missing or with another hash is E_INPUT_UNAVAILABLE, a receipt that is
 * not a receipt E_INPUT_INVALID, a malformed manifest its own code. With `keys` (any key source
 * `verify` accepts), each input receipt is also verified through step 6 (E_INPUT_INVALID).
 * Declared inputs, membership and times are verification's (10.1 step 7.5), not checked here.
 * Throws DatumeshError, or TypeError for arguments of the wrong JS type.
 */
export function inputLicences(receipt: unknown, receipts: Record<string, unknown>, manifests?: Record<string, unknown> | null, keys?: unknown): string[] {
  const R = receiptArg(receipt);
  const isMap = (m: unknown) => typeof m === 'object' && m !== null && !Array.isArray(m);
  if (!isMap(receipts)) throw new TypeError('receipts must be an object mapping receipt hash to receipt');
  if (manifests !== undefined && manifests !== null && !isMap(manifests)) throw new TypeError('manifests must be an object mapping slice entry to manifest');
  const ms = manifests ?? {};
  const sources = keys === undefined || keys === null ? null : collectSources(keys);
  const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  const licenceOf = (h: string, what: string): string => {
    if (!own(receipts, h)) fail('E_INPUT_UNAVAILABLE', `${what} ${h} not available`, '$.inputs');
    let r: JsonObject;
    let hash: string;
    if (sources) {
      try {
        const s = verifySigned(receipts[h], sources, () => undefined);
        r = s.receipt;
        hash = s.hash;
      } catch (e) {
        if (e instanceof Stop) fail('E_INPUT_INVALID', `${what} ${h}: ${e.code}: ${e.detail}`, '$.inputs');
        throw e;
      }
    } else {
      try {
        r = receiptArg(receipts[h]);
      } catch (e) {
        if (e instanceof DatumeshError) fail('E_INPUT_INVALID', `${what} ${h}: ${e.code}: ${e.detail}`, '$.inputs');
        throw e;
      }
      const o: JsonObject = Object.create(null);
      for (const k of Object.keys(r)) if (k !== 'sig') o[k] = r[k];
      hash = sha256Hex(jcsBytes(o));
    }
    if (hash !== h) fail('E_INPUT_UNAVAILABLE', `the ${what} supplied does not hash to ${h}`, '$.inputs');
    return r.licence as string;
  };
  const out: string[] = [];
  for (const entry of R.inputs as string[]) {
    if (!entry.startsWith('slice:')) {
      out.push(licenceOf(entry, 'input receipt'));
      continue;
    }
    if (!own(ms, entry)) fail('E_INPUT_UNAVAILABLE', `no manifest for slice entry ${entry}`, '$.inputs');
    let m: JsonObject;
    try {
      const v = toJson(ms[entry]);
      validate(v, 'manifest', '$.manifest');
      m = v as JsonObject;
    } catch (e) {
      if (e instanceof DatumeshError) fail(e.code, `manifest for ${entry}: ${e.detail}`, '$.inputs');
      throw e;
    }
    if (sha256Hex(jcsBytes(m.slice)) !== entry.slice(6, 70) || sha256Hex(jcsBytes(m.members)) !== entry.slice(71)) {
      fail('E_INPUT_UNAVAILABLE', `the manifest offered does not hash to the entry ${entry}`, '$.inputs');
    }
    for (const h of m.members as string[]) out.push(licenceOf(h, 'member receipt'));
  }
  return out;
}

/**
 * SPEC 2.5: is a namespace (or a host, or a full function name) unrooted, that is, is the last
 * label of its host `invalid` (`local.invalid`, `agent-7.local.invalid`, `local.invalid/notes`)?
 * Every other namespace is rooted. Throws DatumeshError (E_CANON_NAME) for a string that is not a
 * namespace by 2.3, TypeError for a non-string.
 */
export function isUnrooted(namespace: string): boolean {
  if (typeof namespace !== 'string') throw new TypeError('namespace must be a string');
  checkNamespace(namespace, '$');
  const host = namespace.split('/')[0];
  return host.split('.').pop() === 'invalid';
}
