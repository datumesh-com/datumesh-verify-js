// Response envelopes (SPEC.md 5.5): the unsigned JSON body a mesh returns around a receipt.
// Synchronous, offline; the embedded receipt is verified through step 6 with the given keys.
import { DatumeshError, ERROR_CODES, type ErrorCode } from './errors.js';
import { has, isObject, memberPath, sortedKeys, toJson, type JsonObject, type JsonValue } from './json.js';
import { LIMITS, URL_RE, checkDnsName, checkNumber, checkString, isHex, isInstant } from './lexical.js';
import { sha256Hex } from './hash.js';
import { jcsBytes } from './jcs.js';
import { collectSources } from './keys.js';
import { isCurrency } from './units.js';
import { Stop, verifyEmbedded } from './verify.js';

export type Outcome = 'ok' | 'stale' | 'not_covered' | 'unlicensed' | 'payment_required' | 'rate_limited' | 'error' | 'bad_request' | 'pending';

/**
 * What the client asked for (SPEC 5.5 step 5): the requested cell's id, and `asof` if the request
 * had one. Since spec-0.4.1, `job` when the body answers `GET` of that job's `poll` URL: the
 * cell id and `asof` are then still those of the original request (a job's result is bound to
 * it), a `pending` answer must carry that job, and only then may a `bad_request` carry
 * `E_JOB_UNKNOWN`.
 */
export interface EnvelopeRequest {
  cell_id: string;
  asof?: string;
  job?: string;
}

/** Since spec-0.4.1: what a `pending` envelope (HTTP 202) says about its job. */
export interface Pending {
  /** The job id, 32 to 64 lowercase hex digits; a capability, not to be logged or shared. */
  job: string;
  /** The URL to poll (`.../jobs/<job>`). Send it only to the host that was asked (SPEC 5.5). */
  poll: string;
  /** The mesh's estimate of the seconds until the result is ready; a hint. */
  estimateSeconds: number;
}
export type Trust = 'primary' | 'verified' | 'unverified';

/** SPEC 5.5, 15.11 (since spec-0.4.0): the formula evaluation faults a `not_covered` envelope may carry. */
export type Fault = 'E_FORMULA_DIV_ZERO' | 'E_FORMULA_DOMAIN' | 'E_FORMULA_RANGE' | 'E_FORMULA_EMPTY' | 'E_FORMULA_ABSENT' | 'E_FORMULA_FUTURE';
export const FAULTS: readonly Fault[] = ['E_FORMULA_DIV_ZERO', 'E_FORMULA_DOMAIN', 'E_FORMULA_RANGE', 'E_FORMULA_EMPTY', 'E_FORMULA_ABSENT', 'E_FORMULA_FUTURE'];

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
  /**
   * Since spec-0.4.0: the formula evaluation fault of a `not_covered` envelope when ok and it
   * carries one (the cell is a computed cell whose evaluation faulted: it has no value,
   * deterministically, and this is not missing data), else null.
   */
  fault: Fault | null;
  /** Since spec-0.4.1: the job of a `pending` envelope when ok, else null. */
  pending: Pending | null;
}

/** SPEC 5.5: required and optional members per outcome (besides `outcome`). */
const MEMBERS: Record<Outcome, { required: string[]; optional: string[] }> = {
  ok: { required: ['receipt', 'trust'], optional: ['superseded_by', 'reason'] },
  stale: { required: ['receipt', 'trust', 'age_seconds'], optional: ['superseded_by', 'reason'] },
  not_covered: { required: [], optional: ['fault'] },
  unlicensed: { required: [], optional: [] },
  payment_required: { required: ['quote'], optional: [] },
  rate_limited: { required: ['retry_after_seconds'], optional: [] },
  error: { required: ['error'], optional: [] },
  bad_request: { required: ['error'], optional: [] },
  pending: { required: ['estimate_seconds', 'job', 'poll', 'request'], optional: [] },
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
  pending: (s) => s === 202,
};
/** SPEC 5.5: the codes `parse` can raise (5.4), the only ones a bad_request carries. */
const PARSE_CODES: readonly string[] = ['E_PARSE_URI', 'E_CANON_NAME', 'E_CANON_ARG_NAME', 'E_CANON_ARG_DUPLICATE', 'E_CANON_ARG_ORDER', 'E_CANON_PERCENT', 'E_CANON_TYPE', 'E_CANON_NUMBER', 'E_CANON_DATE', 'E_CANON_INSTANT', 'E_CANON_STRING', 'E_CANON_BLOB', 'E_CANON_LIMIT', 'E_ARG_UNKNOWN', 'E_ARG_MISSING'];
const TRUST: readonly string[] = ['primary', 'verified', 'unverified'];
const JOB_RE = /^[0-9a-f]{32,64}$/;
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
      case 'estimate_seconds':
      case 'retry_after_seconds':
        seconds(v, numbers.get(p), k, p);
        break;
      case 'error':
        if (outcome === 'bad_request') {
          // E_JOB_UNKNOWN only at a job URL: checked against the request in step 5.
          if (typeof v !== 'string' || !(PARSE_CODES.includes(v) || v === 'E_JOB_UNKNOWN')) bad('a bad_request carries a code that parsing a cell URI raises (SPEC 5.4), or E_JOB_UNKNOWN at a job URL', p);
        } else if (typeof v !== 'string' || v === 'E_ENVELOPE' || v === 'E_JOB_UNKNOWN' || !(ERROR_CODES as readonly string[]).includes(v)) {
          bad('error is a code from SPEC.md 10.2 other than E_ENVELOPE and E_JOB_UNKNOWN', p);
        }
        break;
      case 'job':
        if (typeof v !== 'string' || !JOB_RE.test(v)) bad('job is 32 to 64 lowercase hex digits', p);
        break;
      case 'poll':
        // SPEC 5.5: https:// and printable ASCII, at most 512 characters, ending /jobs/<job>; the text
        // between https:// and the next / is a DNS name (2.1). That it is the host asked is the
        // client's HTTP layer's check (MUST), which an envelope cannot make.
        if (typeof v !== 'string' || !URL_RE.test(v) || v.length > LIMITS.licence_url || !v.endsWith(`/jobs/${String(o.job)}`)) bad("poll is the job's https URL, at most 512 characters, ending /jobs/<job>", p);
        if (!isDnsName(v.slice('https://'.length).split('/')[0])) bad("poll's host (between https:// and the next /) is a DNS name: no port, userinfo, IP address, uppercase or query", p);
        break;
      case 'request': {
        const ok =
          isObject(v) &&
          has(v, 'cell_id') &&
          Object.keys(v).every((k) => k === 'cell_id' || k === 'asof') &&
          typeof v.cell_id === 'string' &&
          isHex(v.cell_id, 64) &&
          (!has(v, 'asof') || (typeof v.asof === 'string' && isInstant(v.asof)));
        if (!ok) bad('request is the original request echoed: {cell_id: <64 lowercase hex>, asof?: <instant>}', p);
        break;
      }
      case 'fault':
        if (typeof v !== 'string' || !(FAULTS as readonly string[]).includes(v)) bad(`fault is one of the formula evaluation faults ${FAULTS.join(', ')} (SPEC 5.5)`, p);
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
    Object.keys(request).every((k) => k === 'cell_id' || k === 'asof' || k === 'job') &&
    (!has(request, 'asof') || (typeof request.asof === 'string' && isInstant(request.asof))) &&
    (!has(request, 'job') || (typeof request.job === 'string' && JOB_RE.test(request.job)));
  if (!ok) throw new TypeError('request must be {cell_id: <64 lowercase hex>, asof?: <instant>, job?: <32-64 lowercase hex>}: the cell id of the original request (resolved to the fn_hash used), its asof if it had one, and the job polled when the body answers a job URL');
}

function isDnsName(s: string): boolean {
  try {
    checkDnsName(s, '$');
    return true;
  } catch (e) {
    if (e instanceof DatumeshError) return false;
    throw e;
  }
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
 * and `superseded_by` against its hash (E_ENVELOPE). Since spec-0.4.1: a `pending` envelope (202)
 * must echo exactly the request made and, when `request.job` is given (the body answers that
 * job's `poll` URL), carry that job; a job's final envelope is checked against the original
 * request's `cell_id` and `asof` like a `/cell` answer; `E_JOB_UNKNOWN` only with `request.job`.
 *
 * Never throws for an invalid body or bad key material; throws TypeError only when `status` is
 * not an integer, `request` is malformed, or `keys` is not a key source at all.
 */
export function checkEnvelope(status: number, body: unknown, keys: unknown, request: EnvelopeRequest): EnvelopeResult {
  if (typeof status !== 'number' || !Number.isInteger(status)) throw new TypeError('status must be the HTTP status as an integer');
  checkRequest(request);
  const sources = collectSources(keys);
  const fail = (code: ErrorCode, detail: string, path: string | null, receiptHash: string | null = null): EnvelopeResult => ({ ok: false, code, outcome: null, trust: null, receiptHash, detail, path, fault: null, pending: null });
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
  if (!has(env, 'receipt')) {
    // Step 5 for outcomes without a receipt (since spec-0.4.1).
    if (outcome === 'bad_request' && env.error === 'E_JOB_UNKNOWN' && request.job === undefined) {
      return fail('E_ENVELOPE', 'E_JOB_UNKNOWN answers a job URL only, and this request was not one', '$.error');
    }
    let pending: Pending | null = null;
    if (outcome === 'pending') {
      const echoed = env.request as JsonObject;
      const same = echoed.cell_id === request.cell_id && has(echoed, 'asof') === (request.asof !== undefined) && (request.asof === undefined || echoed.asof === request.asof);
      if (!same) return fail('E_ENVELOPE', 'the pending envelope echoes another request than the one made', '$.request');
      if (request.job !== undefined && env.job !== request.job) return fail('E_ENVELOPE', `the pending envelope is for job ${String(env.job)}, not the job polled`, '$.job');
      pending = { job: env.job as string, poll: env.poll as string, estimateSeconds: env.estimate_seconds as number };
    }
    const fault = has(env, 'fault') ? (env.fault as Fault) : null;
    const detail = fault ? `outcome ${outcome}, fault ${fault}` : pending ? `outcome pending, job ${pending.job}, estimate ${pending.estimateSeconds} s` : `outcome ${outcome}`;
    return { ok: true, code: 'OK', outcome, trust: null, receiptHash: null, detail, path: null, fault, pending };
  }
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
  return { ok: true, code: 'OK', outcome, trust, receiptHash: r.hash, detail: `outcome ${outcome}, trust ${trust}, receipt signed by ${r.receipt.computed_by as string}`, path: null, fault: null, pending: null };
}
