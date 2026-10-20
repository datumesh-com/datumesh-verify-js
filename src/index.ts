/**
 * @datumesh/verify: verify Datumesh receipts (SPEC.md, revision spec-0.2.1).
 *
 * Everything here is synchronous and offline except fetchKeys, the only function that uses the
 * network.
 */
import { fail } from './errors.js';
import { sha256Hex, keyIdOf, fromHex } from './hash.js';
import { newObject, toJson, type JsonObject, type JsonValue } from './json.js';
import { jcsBytes } from './jcs.js';
import { isHex } from './lexical.js';
import { KINDS, cellUnit, inferKind, validate, type Kind } from './validate.js';

export { DatumeshError, ERROR_CODES, SPEC_VERSION, type ErrorCode } from './errors.js';
export { verify, type VerifyResult, type Recompute } from './verify.js';
export { checkEnvelope, type EnvelopeResult, type EnvelopeRequest, type Outcome, type Trust } from './envelope.js';
export { parseUri, formatUri, httpsUrl, type CellRef, type TypedScalar, type Signature, type Unit, type UnitRef } from './uri.js';
export { keysFromResponse, keysFromDocument, fetchKeys, FETCH_TIMEOUT_MS, type KeysResult, type KeyEntry, type KeyMap, type KeySource } from './keys.js';
export type { Kind } from './validate.js';
export type { JsonValue } from './json.js';

/** Library version. */
export const VERSION = '0.2.1';

function parseAndValidate(input: unknown, kind: Kind | undefined | null): { value: JsonValue; kind: Kind } {
  if (kind !== undefined && kind !== null && !KINDS.includes(kind)) throw new TypeError(`unknown kind ${JSON.stringify(kind)}; expected one of ${KINDS.join(', ')}`);
  const value = toJson(input);
  const k = kind ?? inferKind(value);
  validate(value, k);
  return { value, kind: k };
}

/**
 * Validate `input` as `kind` and return its RFC 8785 canonical bytes. `input` is JSON text,
 * UTF-8 bytes, or an already-parsed value. `kind` is "scalar", "cell", "ref", "function" or
 * "receipt" (inferred from the members when omitted), or "jcs" for plain RFC 8785 with only the
 * strict-parsing rules of SPEC 6.1. A receipt is returned whole, `sig` included, and is checked
 * through SPEC 10.1 step 4. Throws DatumeshError.
 */
export function canonicalize(input: unknown, kind?: Kind | null): Uint8Array {
  return jcsBytes(parseAndValidate(input, kind).value);
}

/** Cell id (SPEC 4.4): SHA-256 of the cell's canonical bytes, lowercase hex. Throws DatumeshError. */
export function cellHash(cell: unknown): string {
  return sha256Hex(jcsBytes(parseAndValidate(cell, 'cell').value));
}

/** Function hash (SPEC 7): SHA-256 of the descriptor's canonical bytes. Throws DatumeshError. */
export function functionHash(descriptor: unknown): string {
  return sha256Hex(jcsBytes(parseAndValidate(descriptor, 'function').value));
}

/** Receipt hash (SPEC 8.3): SHA-256 of the canonical receipt without `sig`. Throws DatumeshError. */
export function receiptHash(receipt: unknown): string {
  return sha256Hex(receiptPayload(receipt));
}

/** The signed payload of a receipt (SPEC 8.3): canonical bytes without `sig`. Throws DatumeshError. */
export function receiptPayload(receipt: unknown): Uint8Array {
  const r = parseAndValidate(receipt, 'receipt').value as JsonObject;
  const o = newObject();
  for (const k of Object.keys(r)) if (k !== 'sig') o[k] = r[k];
  return jcsBytes(o);
}

/**
 * The unit of a cell's value (SPEC 7.1, units.md section 3): the descriptor's return unit with
 * the cell's argument values substituted, e.g. "USD/EUR"; null when the function does not
 * return a number. `descriptor` must be the cell's function (E_FN_HASH_MISMATCH otherwise).
 * Both are JSON text, bytes or parsed objects. Throws DatumeshError like canonicalize, and
 * E_ARG_MISSING / E_SLICE / E_ARG_TYPE / E_CANON_UNIT when a referenced argument cannot give a
 * unit.
 */
export function resolvedUnit(descriptor: unknown, cell: unknown): string | null {
  if (descriptor === undefined || cell === undefined) throw new TypeError('resolvedUnit(descriptor, cell) needs both arguments');
  const d = toJson(descriptor);
  const c = toJson(cell);
  return cellUnit(d, c, (x) => sha256Hex(jcsBytes(x)));
}

/** Key id of an Ed25519 public key given as 64 lowercase hex digits (SPEC 9.1). Throws DatumeshError. */
export function keyId(publicKeyHex: string): string {
  if (typeof publicKeyHex !== 'string' || !isHex(publicKeyHex, 64)) fail('E_CANON_HEX', 'expected 64 lowercase hex digits', '$');
  return keyIdOf(fromHex(publicKeyHex));
}

