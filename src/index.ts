/**
 * @datumesh/verify: verify Datumesh receipts (SPEC.md, revision spec-0.4.3).
 *
 * Everything here is synchronous and offline except fetchKeys, the only function that uses the
 * network.
 */
import { fail } from './errors.js';
import { sha256Hex, keyIdOf, fromHex } from './hash.js';
import { newObject, toJson, type JsonObject, type JsonValue } from './json.js';
import { jcsBytes } from './jcs.js';
import { isHex } from './lexical.js';
import { KINDS, cellUnit, inferKind, validate, validateMembers, type Kind } from './validate.js';

export { DatumeshError, ERROR_CODES, SPEC_VERSION, type ErrorCode } from './errors.js';
export { verify, type VerifyResult, type Recompute } from './verify.js';
export { checkEnvelope, checkSlicePage, checkBatch, type EnvelopeResult, type EnvelopeRequest, type Outcome, type Trust, type Fault, type Pending, type SliceRequest, type SliceMember, type SlicePage, type SlicePageResult, type BatchResult, type ForeignDetail, FOREIGN_DETAILS } from './envelope.js';
export { resolveMesh, MESH_ENDPOINTS, type MeshResult, type DocumentResponse } from './mesh.js';
export { parseUri, formatUri, httpsUrl, type CellRef, type TypedScalar, type Signature, type Unit, type UnitRef } from './uri.js';
export { keysFromResponse, keysFromDocument, fetchKeys, FETCH_TIMEOUT_MS, FETCH_MAX_BYTES, type KeysResult, type KeyEntry, type KeyMap, type KeySource, type Declarations, type DeclarationEntry } from './keys.js';
export { inheritLicence, checkEntitlement, inputLicences, isUnrooted, licenceTier, LICENCE_TIERS, type LicenceResult, type LicenceReason, type EntitlementResult, type EntitlementReason } from './licence.js';
export type { Kind } from './validate.js';
export type { JsonValue } from './json.js';

/** Library version. */
export const VERSION = '0.4.3';

function parseAndValidate(input: unknown, kind: Kind | undefined | null): { value: JsonValue; kind: Kind } {
  if (kind !== undefined && kind !== null && !KINDS.includes(kind)) throw new TypeError(`unknown kind ${JSON.stringify(kind)}; expected one of ${KINDS.join(', ')}`);
  const value = toJson(input);
  const k = kind ?? inferKind(value);
  validate(value, k);
  return { value, kind: k };
}

/**
 * Validate `input` as `kind` and return its RFC 8785 canonical bytes. `input` is JSON text,
 * UTF-8 bytes, or an already-parsed value. `kind` is "scalar", "cell", "ref", "function",
 * "receipt", or since spec-0.4.0 "slice" (a slice object, SPEC 4.4: a cell object with open or
 * ranged arguments, or a version slice) or "manifest" (`{"members", "slice"}`, SPEC 15.13);
 * inferred from the members when omitted (pass "slice" for a slice object with markers or
 * ranges); or "jcs" for plain RFC 8785 with only the
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

/**
 * Slice id (SPEC 4.4, 15.13): SHA-256 of the slice object's canonical bytes. For an unbounded
 * slice it is the cell id of the cell object with its markers. Throws DatumeshError.
 */
export function sliceId(slice: unknown): string {
  return sha256Hex(jcsBytes(parseAndValidate(slice, 'slice').value));
}

/**
 * Members hash (SPEC 15.13): SHA-256 of the canonical bytes of the JSON array of member receipt
 * hashes, which must be 64 lowercase hex digits each, strictly ascending, at most 1,048,576. For
 * an empty slice it is the hash of `[]`. Throws DatumeshError.
 */
export function membersHash(members: unknown): string {
  const v = toJson(members);
  validateMembers(v);
  return sha256Hex(jcsBytes(v));
}

/**
 * The `inputs` entry of a slice read (SPEC 8.1, 15.13): `slice:<slice id>:<members hash>`, from
 * its manifest `{"members", "slice"}` (JSON text, bytes or a parsed object). Throws DatumeshError.
 */
export function sliceEntry(manifest: unknown): string {
  const m = parseAndValidate(manifest, 'manifest').value as JsonObject;
  return `slice:${sha256Hex(jcsBytes(m.slice))}:${sha256Hex(jcsBytes(m.members))}`;
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

