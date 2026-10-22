// Response envelopes (SPEC.md 5.5): the unsigned JSON body a mesh returns around a receipt.
// Synchronous, offline; the embedded receipt is verified through step 6 with the given keys.
import { DatumeshError, ERROR_CODES, type ErrorCode } from './errors.js';
import { has, isObject, memberPath, sortedKeys, toJson, type JsonObject, type JsonValue } from './json.js';
import { LIMITS, URL_RE, checkNumber, checkString, isHex, isInstant } from './lexical.js';
import { sha256Hex } from './hash.js';
import { jcsBytes } from './jcs.js';
import { collectSources } from './keys.js';
import { isCurrency } from './units.js';
import { Stop, verifyEmbedded } from './verify.js';

export type Outcome = 'ok' | 'stale' | 'not_covered' | 'unlicensed' | 'payment_required' | 'rate_limited' | 'error' | 'bad_request';

/** What the client asked for (SPEC 5.5 step 5): the requested cell's id, and `asof` if the request had one. */
export interface EnvelopeRequest {
  cell_id: string;
  asof?: string;
}
export type Trust = 'primary' | 'verified' | 'unverified';

export interface EnvelopeResult {
  /** True when the envelope is well formed, matches the status, and its receipt (if any) is signature-valid. */
  ok: boolean;
  /** "OK", E_ENVELOPE, a parse code, or the code of the embedded receipt's verification. */
  code: 'OK' | ErrorCode;
  /** The envelope's outcome when ok, else null. */
  outcome: Outcome | null;
  /** The trust label when ok and the envelope carries a receipt, else null. */
  trust: Trust | null;
  /** The embedded receipt's hash once it has been verified (SPEC 10.1 steps 1-6), else null. */
  receiptHash: string | null;
  /** Human-readable explanation. */
  detail: string;
  /** Where the failure was found (a JSON path such as `$.quote.amount`), or null. */
  path: string | null;
}

/** SPEC 5.5: required and optional members per outcome (besides `outcome`). */
const MEMBERS: Record<Outcome, { required: string[]; optional: string[] }> = {
  ok: { required: ['receipt', 'trust'], optional: ['superseded_by', 'reason'] },
  stale: { required: ['receipt', 'trust', 'age_seconds'], optional: ['superseded_by', 'reason'] },
  not_covered: { required: [], optional: [] },
  unlicensed: { required: [], optional: [] },
  payment_required: { required: ['quote'], optional: [] },
  rate_limited: { required: ['retry_after_seconds'], optional: [] },
  error: { required: ['error'], optional: [] },
  bad_request: { required: ['error'], optional: [] },
};
const STATUS: Record<Outcome, (s: number) => boolean> = {
  ok: (s) => s === 200,
  stale: (s) => s === 200,
  not_covered: (s) => s === 404,
  unlicensed: (s) => s === 403,
  payment_required: (s) => s === 402,
  rate_limited: (s) => s === 429,
  error: (s) => s >= 500 && s <= 599,
  bad_request: (s) => s === 400,
};
/** SPEC 5.5: the codes `parse` can raise (5.4), the only ones a bad_request carries. */
const PARSE_CODES: readonly string[] = ['E_PARSE_URI', 'E_CANON_NAME', 'E_CANON_ARG_NAME', 'E_CANON_ARG_DUPLICATE', 'E_CANON_ARG_ORDER', 'E_CANON_PERCENT', 'E_CANON_TYPE', 'E_CANON_NUMBER', 'E_CANON_DATE', 'E_CANON_INSTANT', 'E_CANON_STRING', 'E_CANON_BLOB', 'E_CANON_LIMIT', 'E_ARG_UNKNOWN', 'E_ARG_MISSING'];
const TRUST: readonly string[] = ['primary', 'verified', 'unverified'];
const MAX_SECONDS = 9007199254740991;

class Bad extends Error {
  constructor(
    readonly detail: string,
    readonly path: string,
  ) {
    super(detail);
  }
}
function bad(detail: string, path: string): never {
  throw new Bad(detail, path);
}

/** A rule of 3.x checked inside an envelope: its own code becomes part of the E_ENVELOPE detail. */
function inner(f: () => void, path: string): void {
  try {
    f();
  } catch (e) {
    if (e instanceof DatumeshError) bad(`${e.code}: ${e.detail}`, path);
    throw e;
  }
}

/**
 * SPEC 5.5 integer members: written 0 or [1-9][0-9]*, at most 2^53 - 1. The source text decides
 * (`30.0`, `3e1` and `-0` are rejected); for an already-parsed body, whose text is gone, the
 * value must be a non-negative safe integer other than -0.
 */
function seconds(v: JsonValue, text: string | undefined, name: string, path: string): void {
  const why = `${name} is written 0 or [1-9][0-9]*, at most 2^53 - 1`;
  if (typeof v !== 'number') bad(why, path);
  if (text !== undefined ? !/^(0|[1-9][0-9]*)$/.test(text) : !Number.isSafeInteger(v) || Object.is(v, -0)) bad(why, path);
  if (v < 0 || v > MAX_SECONDS) bad(why, path);
}

function quote(v: JsonValue, path: string): void {
  if (!isObject(v)) bad('quote is an object {amount, authorise, currency}', path);
  for (const k of ['amount', 'authorise', 'currency']) if (!has(v, k)) bad(`quote has no ${k}`, path);
  for (const k of sortedKeys(v)) if (!['amount', 'authorise', 'currency'].includes(k)) bad(`quote has an unexpected member ${JSON.stringify(k)}`, path);
  const amount = v.amount;
  const ap = memberPath(path, 'amount');
  if (typeof amount !== 'string') bad('amount is a decimal string (SPEC 3.1)', ap);
  inner(() => checkNumber(amount, ap), ap);
  if (amount.startsWith('-') || amount === '0') bad('amount is greater than zero', ap);
  const url = v.authorise;
  const up = memberPath(path, 'authorise');
  if (typeof url !== 'string' || !URL_RE.test(url) || url.length > LIMITS.licence_url) bad('authorise is an https:// URL in the form of a licence URL (SPEC 8.1)', up);
  if (!isCurrency(v.currency)) bad('currency is a currency code from units.md', memberPath(path, 'currency'));
}

/** Step 2: members against the table and their rules. Returns the outcome. */
function members(o: JsonValue, numbers: Map<string, string>): Outcome {
  if (!isObject(o) || typeof o.outcome !== 'string') bad('an envelope is an object with a string outcome', '$');
  const outcome = o.outcome as Outcome;
  if (!Object.prototype.hasOwnProperty.call(MEMBERS, outcome)) bad(`unknown outcome ${JSON.stringify(outcome)}`, '$.outcome');
  const { required, optional } = MEMBERS[outcome];
  for (const k of required) if (!has(o, k)) bad(`outcome ${outcome} requires ${k}`, '$');
  for (const k of sortedKeys(o)) if (k !== 'outcome' && !required.includes(k) && !optional.includes(k)) bad(`member ${JSON.stringify(k)} is not allowed with outcome ${outcome}`, memberPath('$', k));
  if (has(o, 'reason') && !has(o, 'superseded_by')) bad('reason is only present with superseded_by', '$.reason');
  for (const k of sortedKeys(o)) {
    const v = o[k];
    const p = memberPath('$', k);
    switch (k) {
      case 'age_seconds':
      case 'retry_after_seconds':
        seconds(v, numbers.get(p), k, p);
        break;
      case 'error':
        if (outcome === 'bad_request') {
          if (typeof v !== 'string' || !PARSE_CODES.includes(v)) bad('a bad_request carries a code that parsing a cell URI raises (SPEC 5.4)', p);
        } else if (typeof v !== 'string' || v === 'E_ENVELOPE' || !(ERROR_CODES as readonly string[]).includes(v)) {
          bad('error is a code from SPEC.md 10.2 other than E_ENVELOPE', p);
        }
        break;
      case 'quote':
        quote(v, p);
        break;
      case 'reason':
        if (typeof v !== 'string') bad('reason is a string', p);
        if (v === '') bad('reason must not be empty', p);
        inner(() => checkString(v, p, { limit: LIMITS.summary }), p);
        break;
      case 'receipt':
        if (!isObject(v)) bad('receipt is a receipt object', p);
        break;
      case 'superseded_by':
        if (typeof v !== 'string' || !isHex(v, 64)) bad('superseded_by is a receipt hash: 64 lowercase hex digits', p);
        break;
      case 'trust':
        if (typeof v !== 'string' || !TRUST.includes(v)) bad('trust is one of primary, verified, unverified', p);
        break;
    }
  }
  return outcome;
}

function checkRequest(request: unknown): void {
  const ok =
    isObject(request) &&
    typeof request.cell_id === 'string' &&
    isHex(request.cell_id, 64) &&
    Object.keys(request).every((k) => k === 'cell_id' || k === 'asof') &&
    (!has(request, 'asof') || (typeof request.asof === 'string' && isInstant(request.asof)));
  if (!ok) throw new TypeError('request must be {cell_id: <64 lowercase hex>, asof?: <instant>}: the cell id of the requested cell (resolved to the fn_hash used) and its asof, if the request had one');
}

const hostOf = (s: string, sep: string) => {
  const i = s.indexOf(sep);
  return i < 0 ? s : s.slice(0, i);
};

/**
 * Check a mesh response (SPEC 5.5): `status` is the HTTP status, `body` the response body as
 * JSON text or bytes (a parsed object is accepted too, without duplicate-member detection), and
 * `keys` any key source `verify` accepts, used to verify an embedded receipt through step 6.
 * `request` is what the client asked for: `{cell_id, asof?}`, the id (SPEC 4.4) of the requested
 * cell resolved to the fn_hash the client used, and the requested asof if there was one.
 * Steps: strict parse; members (E_ENVELOPE); status against outcome (E_ENVELOPE); the receipt
 * (its own codes); the receipt answers the request (E_ENVELOPE); then `trust` against the receipt
 * and `superseded_by` against its hash (E_ENVELOPE).
 *
 * Never throws for an invalid body or bad key material; throws TypeError only when `status` is
 * not an integer, `request` is malformed, or `keys` is not a key source at all.
 */
export function checkEnvelope(status: number, body: unknown, keys: unknown, request: EnvelopeRequest): EnvelopeResult {
  if (typeof status !== 'number' || !Number.isInteger(status)) throw new TypeError('status must be the HTTP status as an integer');
  checkRequest(request);
  const sources = collectSources(keys);
  const fail = (code: ErrorCode, detail: string, path: string | null, receiptHash: string | null = null): EnvelopeResult => ({ ok: false, code, outcome: null, trust: null, receiptHash, detail, path });
  let o: JsonValue;
  const numbers = new Map<string, string>();
  try {
    o = toJson(body, numbers); // step 1
  } catch (e) {
    if (e instanceof DatumeshError) return fail(e.code, e.detail, e.path);
    throw e;
  }
  let outcome: Outcome;
  try {
    outcome = members(o, numbers); // step 2
    if (!STATUS[outcome](status)) bad(`status ${status} does not match outcome ${outcome}`, '$.outcome'); // step 3
  } catch (e) {
    if (e instanceof Bad) return fail('E_ENVELOPE', e.detail, e.path);
    throw e;
  }
  const env = o as JsonObject;
  if (!has(env, 'receipt')) return { ok: true, code: 'OK', outcome, trust: null, receiptHash: null, detail: `outcome ${outcome}`, path: null };
  // Step 4.
  let r: { receipt: JsonObject; hash: string };
  try {
    r = verifyEmbedded(env.receipt, sources);
  } catch (e) {
    if (e instanceof Stop) return fail(e.code, `receipt: ${e.detail}`, e.path === null ? '$.receipt' : e.path.replace(/^\$/, '$.receipt'));
    throw e;
  }
  // Step 5: the receipt answers the request.
  const cellId = sha256Hex(jcsBytes(r.receipt.cell as JsonObject));
  if (cellId !== request.cell_id) return fail('E_ENVELOPE', `the receipt is for cell ${cellId}, not the requested ${request.cell_id}`, '$.receipt.cell', r.hash);
  // With a requested asof: at or before it, for ok and stale alike (D31, revised in spec-0.3.0). Instants are fixed
  // width, so string order is time order (SPEC 3.3).
  const asof = r.receipt.asof as string;
  if (request.asof !== undefined && !(asof <= request.asof)) {
    return fail('E_ENVELOPE', `the receipt answers asof ${asof}, later than the requested ${request.asof}`, '$.receipt.asof', r.hash);
  }
  // Step 6.
  const trust = env.trust as Trust;
  const cell = r.receipt.cell as JsonObject;
  const primary = hostOf(r.receipt.computed_by as string, '#') === hostOf(cell.ns as string, '/') && (r.receipt.inputs as string[]).length === 0;
  if ((trust === 'primary') !== primary) {
    return fail('E_ENVELOPE', primary ? 'the receipt is primary (signed by its namespace host, no inputs): trust must be primary' : 'trust primary needs a receipt signed by the host of cell.ns with no inputs', '$.trust', r.hash);
  }
  if (env.superseded_by === r.hash) return fail('E_ENVELOPE', 'superseded_by is the receipt itself', '$.superseded_by', r.hash);
  return { ok: true, code: 'OK', outcome, trust, receiptHash: r.hash, detail: `outcome ${outcome}, trust ${trust}, receipt signed by ${r.receipt.computed_by as string}`, path: null };
}
