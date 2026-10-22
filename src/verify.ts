// Receipt verification (SPEC.md 10.1). Synchronous, offline, no global state, no logging.
import { DatumeshError, type ErrorCode } from './errors.js';
import { verifyEd25519Strict } from './ed25519.js';
import { fromHex, sha256Hex } from './hash.js';
import { has, newObject, sortedKeys, toJson, type JsonObject, type JsonValue } from './json.js';
import { jcsBytes } from './jcs.js';
import { collectSources, lookupKey, type Sources } from './keys.js';
import { checkBlob } from './lexical.js';
import { receiptCanonicalAndConsistent, receiptStructure, returnType, validate } from './validate.js';

export interface VerifyResult {
  /**
   * True when the receipt is signature-valid (and, if recompute was given with a value, fully
   * verified).
   */
  ok: boolean;
  /**
   * "OK" or a SPEC 10.2 error code. With `ok` true it is "OK", or `E_EVAL_UNAVAILABLE` when
   * recompute was given without a value: steps 7.1-7.5 passed but the function was not evaluated
   * (SPEC 10.1 step 7.6), so `level` is "signed" and `path` is "$.value". That is the one code
   * reported with success.
   */
  code: 'OK' | ErrorCode;
  /** "signed" (steps 1-6) or "recomputed" (steps 1-7) when ok, else null. */
  level: 'signed' | 'recomputed' | null;
  /** The receipt hash, once the receipt has the structure of a receipt (step 2), else null. */
  hash: string | null;
  /** The `computed_by` key reference when ok, else null. */
  key: string | null;
  /** Human-readable explanation. */
  detail: string;
  /** Where the failure was found (a JSON path like `$.cell.args.base`), or null. */
  path: string | null;
  /** True only when blob content was supplied and step 7.7 ran and passed. Does not change `level`. */
  blobChecked: boolean;
}

/** Input for SPEC 10.1 step 7. The library does not evaluate functions; `value` is the result. */
export interface Recompute {
  /**
   * The function descriptor for cell.fn_hash: a parsed JSON value, or JSON text / UTF-8 bytes,
   * parsed strictly first. Absent (undefined): E_FN_UNAVAILABLE. Anything else obtained, `null`
   * included, is a descriptor offered: if it is not the descriptor it fails the hash check
   * (E_FN_HASH_MISMATCH; SPEC 10.1 step 7.1). A JS string is always JSON text.
   */
  descriptor?: unknown;
  /** Input receipts by receipt hash, as JSON text (or bytes, or parsed objects). */
  inputs?: Record<string, unknown>;
  /**
   * What evaluating the function produced: a typed scalar. Absent (undefined) when the function
   * could not be evaluated: once 7.1-7.5 pass, the result is success at level "signed" with code
   * E_EVAL_UNAVAILABLE (SPEC 10.1 step 7.6).
   */
  value?: { type: string; value: string | boolean };
}

class Stop extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly detail: string,
    readonly path: string | null,
  ) {
    super(detail);
  }
}

function stop(code: ErrorCode, detail: string, path: string | null = '$'): never {
  throw new Stop(code, detail, path);
}

function withoutSig(r: JsonObject): JsonObject {
  const o = newObject();
  for (const k of Object.keys(r)) if (k !== 'sig') o[k] = r[k];
  return o;
}

interface Signed {
  receipt: JsonObject;
  hash: string;
}

/** Steps 1-6. Throws Stop; returns the parsed receipt and its hash. */
function verifySigned(input: unknown, sources: Sources, setHash: (h: string) => void): Signed {
  let r: JsonValue;
  try {
    r = toJson(input); // step 1
    receiptStructure(r); // step 2
  } catch (e) {
    if (e instanceof DatumeshError) stop(e.code, e.detail, e.path);
    throw e;
  }
  const receipt = r as JsonObject;
  const payload = jcsBytes(withoutSig(receipt));
  const hash = sha256Hex(payload);
  setHash(hash);
  try {
    receiptCanonicalAndConsistent(receipt); // steps 3-4
  } catch (e) {
    if (e instanceof DatumeshError) stop(e.code, e.detail, e.path);
    throw e;
  }
  // Step 5.
  const ref = receipt.computed_by as string;
  const hashAt = ref.indexOf('#');
  const host = ref.slice(0, hashAt);
  const id = ref.slice(hashAt + 1);
  const found = lookupKey(sources, host, id, receipt.issued as string);
  if (!found.ok) stop(found.code, found.detail, found.code === 'E_KEY_NOT_VALID' ? '$.issued' : '$.computed_by');
  // Step 6.
  if (!verifyEd25519Strict(fromHex(receipt.sig as string), payload, fromHex(found.key.public))) {
    stop('E_SIGNATURE', 'Ed25519 verification failed', '$.sig');
  }
  return { receipt, hash };
}

/** Step 7. Throws Stop; returns false when 7.6 could not run (no value: E_EVAL_UNAVAILABLE). */
function recompute(receipt: JsonObject, rc: Recompute, sources: Sources): boolean {
  const cell = receipt.cell as JsonObject;
  const cellArgs = cell.args as JsonObject;
  // 7.1 Descriptor. Only obtaining nothing is unavailability; null is a descriptor offered (D35).
  if (rc.descriptor === undefined) stop('E_FN_UNAVAILABLE', `no descriptor for ${cell.fn_hash as string}`, '$.cell.fn_hash');
  let desc: JsonObject;
  try {
    const d = toJson(rc.descriptor);
    if (sha256Hex(jcsBytes(d)) !== cell.fn_hash) stop('E_FN_HASH_MISMATCH', 'descriptor does not hash to cell.fn_hash', '$.cell.fn_hash');
    validate(d, 'function', 'descriptor');
    desc = d as JsonObject;
  } catch (e) {
    if (e instanceof DatumeshError) stop(e.code, `descriptor: ${e.detail}`, e.path);
    throw e;
  }
  const sig = desc.signature as JsonObject;
  const declared = sig.args as JsonObject;
  // 7.2 Arguments: unknown, then missing, then types.
  for (const k of sortedKeys(cellArgs)) {
    if (!has(declared, k)) stop('E_ARG_UNKNOWN', `function declares no argument ${JSON.stringify(k)}`, `$.cell.args.${k}`);
  }
  for (const k of sortedKeys(declared)) {
    if (!has(cellArgs, k)) stop('E_ARG_MISSING', `argument ${JSON.stringify(k)} is not bound`, '$.cell.args');
  }
  for (const k of sortedKeys(cellArgs)) {
    const want = (declared[k] as JsonObject).type;
    if ((cellArgs[k] as JsonObject).type !== want) stop('E_ARG_TYPE', `${k} is declared ${String(want)}`, `$.cell.args.${k}`);
  }
  // 7.3 valid holds exactly the declared valid-time arguments.
  const validNames = sortedKeys(receipt.valid as JsonObject);
  const declaredValid = sortedKeys(declared).filter((k) => (declared[k] as JsonObject).valid === true);
  if (validNames.join('\u0000') !== declaredValid.join('\u0000')) {
    stop('E_VALID_MISMATCH', 'valid must echo exactly the declared valid-time arguments', '$.valid');
  }
  // 7.4 Return type: `returns`, or its `type` member when it is an object.
  const rt = returnType(sig);
  if (receipt.type !== rt) stop('E_RETURN_TYPE', `function returns ${rt}`, '$.type');
  // 7.5 Inputs.
  const declaredInputs = desc.inputs as string[];
  const supplied = rc.inputs ?? {};
  let latestTx: string | null = null;
  for (const h of receipt.inputs as string[]) {
    if (!Object.prototype.hasOwnProperty.call(supplied, h)) stop('E_INPUT_UNAVAILABLE', `input receipt ${h} not available`, '$.inputs');
    let inner: Signed;
    try {
      inner = verifySigned(supplied[h], sources, () => undefined);
    } catch (e) {
      if (e instanceof Stop) stop('E_INPUT_INVALID', `input ${h}: ${e.code}: ${e.detail}`, '$.inputs');
      throw e;
    }
    if (inner.hash !== h) stop('E_INPUT_UNAVAILABLE', `supplied receipt does not hash to ${h}`, '$.inputs');
    const ic = inner.receipt.cell as JsonObject;
    if (!declaredInputs.includes(`${ic.ns as string}/${ic.fn as string}`)) {
      stop('E_INPUT_UNDECLARED', `input ${h} is a cell of an undeclared function`, '$.inputs');
    }
    // At or before the receipt's asof (D17, revised in spec-0.3.0); instants are fixed width, so
    // string order is time order (SPEC 3.3).
    if (!((inner.receipt.asof as string) <= (receipt.asof as string))) stop('E_TIME_ORDER', `input ${h} has asof ${inner.receipt.asof as string}, after the receipt's asof`, '$.inputs');
    const itx = inner.receipt.tx as string;
    if (latestTx === null || itx > latestTx) latestTx = itx;
  }
  if (latestTx !== null && receipt.tx !== latestTx) stop('E_TIME_ORDER', 'tx must be the latest input tx', '$.tx');
  // 7.6 Value. No value: the function could not be evaluated (E_EVAL_UNAVAILABLE, not a failure).
  const v = rc.value;
  if (v === undefined) return false;
  if (v.type !== receipt.type || v.value !== receipt.value) stop('E_VALUE_MISMATCH', 'recomputed value differs from the receipt', '$.value');
  return true;
}

/**
 * Step 7.7: content is only for a blob value (E_SCHEMA otherwise); it has exactly `length`
 * bytes, then a SHA-256 equal to the blob's hash (E_BLOB_MISMATCH).
 */
function checkContent(receipt: JsonObject, content: Uint8Array): void {
  if (receipt.type !== 'blob') stop('E_SCHEMA', `content was supplied, but the value is a ${String(receipt.type)}, not a blob`, '$.type');
  const blob = checkBlob(receipt.value as string, '$.value'); // already checked in step 3
  if (content.length !== blob.length) stop('E_BLOB_MISMATCH', `content is ${content.length} bytes, the blob says ${blob.length}`, '$.value');
  if (sha256Hex(content) !== blob.sha256) stop('E_BLOB_MISMATCH', "the content's SHA-256 is not the blob's hash", '$.value');
}

function checkBlobArg(b: unknown): Uint8Array | null {
  if (b === undefined || b === null) return null;
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  throw new TypeError('blob must be the content bytes (Uint8Array or ArrayBuffer)');
}

function checkRecomputeArg(rc: unknown): Recompute | null {
  if (rc === undefined || rc === null) return null;
  if (typeof rc !== 'object' || Array.isArray(rc)) throw new TypeError('recompute must be an object {descriptor, inputs, value}');
  const r = rc as Recompute;
  if (r.value !== undefined && (!r.value || typeof r.value !== 'object' || typeof r.value.type !== 'string' || (typeof r.value.value !== 'string' && typeof r.value.value !== 'boolean'))) {
    throw new TypeError('recompute.value must be the evaluated typed scalar {type, value}, or absent when the function could not be evaluated');
  }
  if (r.inputs !== undefined && (typeof r.inputs !== 'object' || r.inputs === null || Array.isArray(r.inputs))) {
    throw new TypeError('recompute.inputs must be an object mapping receipt hash to receipt JSON');
  }
  return r;
}

/**
 * Verify a receipt (SPEC 10.1). `receipt` is JSON text, UTF-8 bytes or a parsed object (only
 * text and bytes allow duplicate-member detection). `keys` is a key document, a KeysResult, a
 * {keyId: publicKeyHex} map, or an array of these. With `recompute`, step 7 runs too; without
 * its `value`, steps 7.1-7.5 run and the result is success at level "signed" with code
 * E_EVAL_UNAVAILABLE (path "$.value") unless they fail. With
 * `blob`, the content of a blob value, step 7.7 runs last (after step 7 when recomputing,
 * otherwise right after step 6): E_SCHEMA if the value is not a blob, E_BLOB_MISMATCH if the
 * content does not match. It does not change `level`; `blobChecked` reports it.
 *
 * Never throws for an invalid receipt or bad key material; throws TypeError only when an
 * argument is of the wrong kind altogether.
 */
export function verify(receipt: unknown, keys: unknown, recomputeArg?: Recompute | null, blob?: Uint8Array | ArrayBuffer | null): VerifyResult {
  const sources = collectSources(keys);
  const rc = checkRecomputeArg(recomputeArg);
  const content = checkBlobArg(blob);
  let hash: string | null = null;
  try {
    const { receipt: r } = verifySigned(receipt, sources, (h) => (hash = h));
    const evaluated = rc ? recompute(r, rc, sources) : false;
    const checked = content !== null;
    if (checked) checkContent(r, content); // 7.7 also after E_EVAL_UNAVAILABLE; its failure replaces the code
    const unavailable = rc !== null && !evaluated;
    const what = evaluated
      ? 'fully verified: signature valid and value recomputed'
      : unavailable
        ? `signature-valid: signed by ${r.computed_by as string}; descriptor, arguments and inputs check out, but the function could not be evaluated, so the value was not recomputed`
        : `signature-valid: signed by ${r.computed_by as string}`;
    return {
      ok: true,
      code: unavailable ? 'E_EVAL_UNAVAILABLE' : 'OK',
      level: evaluated ? 'recomputed' : 'signed',
      hash,
      key: r.computed_by as string,
      detail: checked ? `${what}; blob content matches` : what,
      path: unavailable ? '$.value' : null,
      blobChecked: checked,
    };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, code: e.code, level: null, hash, key: null, detail: e.detail, path: e.path, blobChecked: false };
    throw e; // a bug in this library, not a property of the receipt
  }
}

/** Steps 1-6 for an already-parsed receipt (used by checkEnvelope). Throws a Stop. */
export function verifyEmbedded(receipt: JsonValue, sources: Sources): { receipt: JsonObject; hash: string } {
  return verifySigned(receipt, sources, () => undefined);
}

export { Stop };
