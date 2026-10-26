// Response envelopes (SPEC.md 5.5): the unsigned JSON body a mesh returns around a receipt.
// Synchronous, offline; the embedded receipt is verified through step 6 with the given keys.
import { DatumeshError, ERROR_CODES, type ErrorCode } from './errors.js';
import { has, isObject, memberPath, sortedKeys, toJson, type JsonObject, type JsonValue } from './json.js';
import { LIMITS, URL_RE, checkDnsName, checkNumber, checkString, compareCodePoints, compareValues, isHex, isInstant } from './lexical.js';
import { sha256Hex } from './hash.js';
import { jcsBytes } from './jcs.js';
import { collectSources, type Sources } from './keys.js';
import { isCurrency } from './units.js';
import { Stop, memberOf, verifyEmbedded } from './verify.js';
import { isVersionSlice, validate } from './validate.js';

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
  /** Since spec-0.4.2: the pin, when the request was pinned (`fn_hash=`, 5.1); the answer must echo it. */
  fn_hash?: string;
  /**
   * Since spec-0.4.2: the host the request was sent to (a DNS name). With it, `trust` `computed`
   * is checked against the receipt's signer and `poll` against the host; without it, comparing
   * them with the host asked is the caller's own check (SPEC 5.5).
   */
  mesh?: string;
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
/** `computed` since spec-0.4.2: the mesh asked evaluated and signed the cell itself (5.5). */
export type Trust = 'primary' | 'computed' | 'verified' | 'unverified';

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
  /** Since spec-0.4.2: the envelope's `fn_hash` (the function the answer is of) when ok and present, else null. */
  fnHash: string | null;
}

/** SPEC 5.5: required and optional members per outcome (besides `outcome`). */
const MEMBERS: Record<Outcome, { required: string[]; optional: string[] }> = {
  ok: { required: ['receipt', 'trust'], optional: ['superseded_by', 'reason', 'fn_hash'] },
  stale: { required: ['receipt', 'trust', 'age_seconds'], optional: ['superseded_by', 'reason', 'fn_hash'] },
  not_covered: { required: [], optional: ['fault', 'error', 'fn_hash'] },
  unlicensed: { required: [], optional: ['fn_hash'] },
  payment_required: { required: ['quote'], optional: ['fn_hash'] },
  rate_limited: { required: ['retry_after_seconds'], optional: ['fn_hash'] },
  error: { required: ['error'], optional: ['fn_hash'] },
  bad_request: { required: ['error'], optional: ['fn_hash'] },
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
/** Since spec-0.4.2 a bad_request also carries E_CANON_HEX (a pin) and E_SLICE_AT_CELL; E_JOB_UNKNOWN only at a job URL. */
const BAD_REQUEST_CODES: readonly string[] = [...PARSE_CODES, 'E_CANON_HEX', 'E_SLICE_AT_CELL', 'E_JOB_UNKNOWN'];
/** SPEC 5.5: an error envelope carries any 10.2 code but the client's and the three request codes. */
const NOT_ERROR_CODES: readonly string[] = ['E_ENVELOPE', 'E_JOB_UNKNOWN', 'E_SLICE_AT_CELL', 'E_NAME_UNBOUND'];
const TRUST: readonly string[] = ['primary', 'computed', 'verified', 'unverified'];
const HEX64 = /^[0-9a-f]{64}$/;
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
  if (outcome === 'not_covered' && has(o, 'fault') && has(o, 'error')) bad('not_covered carries fault or error, not both', '$.error');
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
          if (typeof v !== 'string' || !BAD_REQUEST_CODES.includes(v)) bad('a bad_request carries a code that parsing a cell URI raises (SPEC 5.4), E_CANON_HEX, E_SLICE_AT_CELL, or E_JOB_UNKNOWN at a job URL', p);
        } else if (outcome === 'not_covered') {
          if (v !== 'E_NAME_UNBOUND') bad('not_covered carries only E_NAME_UNBOUND in error', p);
        } else if (typeof v !== 'string' || NOT_ERROR_CODES.includes(v) || !(ERROR_CODES as readonly string[]).includes(v)) {
          bad('error is a code from SPEC.md 10.2 other than E_ENVELOPE, E_JOB_UNKNOWN, E_SLICE_AT_CELL and E_NAME_UNBOUND', p);
        }
        break;
      case 'fn_hash':
        if (typeof v !== 'string' || !HEX64.test(v)) bad('fn_hash is a function hash: 64 lowercase hex digits', p);
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
          Object.keys(v).every((k) => k === 'cell_id' || k === 'asof' || k === 'fn_hash') &&
          typeof v.cell_id === 'string' &&
          isHex(v.cell_id, 64) &&
          (!has(v, 'asof') || (typeof v.asof === 'string' && isInstant(v.asof))) &&
          (!has(v, 'fn_hash') || (typeof v.fn_hash === 'string' && HEX64.test(v.fn_hash)));
        if (!ok) bad('request is the original request echoed: {cell_id: <64 lowercase hex>, asof?: <instant>, fn_hash?: <64 lowercase hex>}', p);
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
        if (typeof v !== 'string' || !TRUST.includes(v)) bad('trust is one of primary, computed, verified, unverified', p);
        break;
    }
  }
  return outcome;
}

const isDnsName = (s: string): boolean => {
  try {
    checkDnsName(s, '$');
    return true;
  } catch (e) {
    if (e instanceof DatumeshError) return false;
    throw e;
  }
};

const isTypedScalar = (v: unknown): boolean => isObject(v) && sortedKeys(v).join(',') === 'type,value' && typeof v.type === 'string' && (typeof v.value === 'string' || typeof v.value === 'boolean');

/** The request members every request description may carry (SPEC 5.5, 5.6). */
function checkCommon(request: JsonObject): boolean {
  return (
    (!has(request, 'asof') || (typeof request.asof === 'string' && isInstant(request.asof))) &&
    // The pin and the host asked are compared as given (DEFECTS.md 52): a malformed pin is never
    // echoed, a malformed mesh never names a signer or a poll host.
    (!has(request, 'fn_hash') || typeof request.fn_hash === 'string') &&
    (!has(request, 'mesh') || typeof request.mesh === 'string')
  );
}

function checkRequest(request: unknown): void {
  const ok =
    isObject(request) &&
    typeof request.cell_id === 'string' &&
    isHex(request.cell_id, 64) &&
    Object.keys(request).every((k) => ['cell_id', 'asof', 'job', 'fn_hash', 'mesh'].includes(k)) &&
    checkCommon(request) &&
    (!has(request, 'job') || (typeof request.job === 'string' && JOB_RE.test(request.job)));
  if (!ok) {
    throw new TypeError(
      'request must be {cell_id: <64 lowercase hex>, asof?: <instant>, job?: <32-64 lowercase hex>, fn_hash?: <the pin>, mesh?: <the host asked>}: the cell id of the original request (resolved to the fn_hash used), its asof if it had one, the job polled when the body answers a job URL, the pin when it was pinned, and the host asked',
    );
  }
}

/** A slice request description (SPEC 5.6): `{slice_id, asof?, fn_hash?, mesh?, after?}`. */
function checkSliceRequest(request: unknown): void {
  const ok =
    isObject(request) &&
    typeof request.slice_id === 'string' &&
    isHex(request.slice_id, 64) &&
    Object.keys(request).every((k) => ['slice_id', 'asof', 'fn_hash', 'mesh', 'after'].includes(k)) &&
    checkCommon(request) &&
    (!has(request, 'after') || (isObject(request.after) && Object.values(request.after).every(isTypedScalar)));
  if (!ok) {
    throw new TypeError('a slice request must be {slice_id: <64 lowercase hex>, asof?: <instant>, fn_hash?: <the pin>, mesh?: <the host asked>, after?: {<open argument>: <typed scalar>}}');
  }
}

const hostOf = (s: string, sep: string) => {
  const i = s.indexOf(sep);
  return i < 0 ? s : s.slice(0, i);
};

/** The host of an https URL: the text between https:// and the next /. */
const urlHost = (u: string) => u.slice('https://'.length).split('/')[0];

/** The number texts under `prefix`, re-rooted at `$` (for an envelope nested in a batch or page). */
function subNumbers(numbers: Map<string, string>, prefix: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of numbers) {
    if (k === prefix || k.startsWith(`${prefix}.`) || k.startsWith(`${prefix}[`)) out.set(`$${k.slice(prefix.length)}`, v);
  }
  return out;
}

const atPath = (prefix: string, p: string | null) => (p === null ? prefix : p.replace(/^\$/, prefix));

type Req = { cell_id?: string; asof?: string; job?: string; fn_hash?: string; mesh?: string };
const failed = (code: ErrorCode, detail: string, path: string | null, receiptHash: string | null = null): EnvelopeResult => ({ ok: false, code, outcome: null, trust: null, receiptHash, detail, path, fault: null, pending: null, fnHash: null });

/**
 * SPEC 5.5 step 6 for a verified receipt: `primary` exactly when its condition holds; with the
 * host asked known, `computed` exactly when that host signed a receipt that is not primary.
 * Returns a failure detail, or null.
 */
function trustProblem(trust: Trust, receipt: JsonObject, mesh: string | undefined): string | null {
  const cell = receipt.cell as JsonObject;
  const signer = hostOf(receipt.computed_by as string, '#');
  const primary = signer === hostOf(cell.ns as string, '/') && (receipt.inputs as string[]).length === 0;
  if ((trust === 'primary') !== primary) return primary ? 'the receipt is primary (signed by its namespace host, no inputs): trust must be primary' : 'trust primary needs a receipt signed by the host of cell.ns with no inputs';
  if (!primary && mesh !== undefined && (trust === 'computed') !== (signer === mesh)) {
    return trust === 'computed' ? `trust computed needs a receipt signed by the mesh asked (${mesh}), not ${signer}` : `the mesh asked (${mesh}) signed this receipt: its trust is computed, not ${trust}`;
  }
  return null;
}

/**
 * Steps 2-6 of SPEC 5.5 for a parsed envelope `o` with its number texts. `request` null: nothing
 * to bind (a batch refused whole). Without `cell_id` (an answer of the slice endpoint that is not a
 * page) there is no receipt to bind either.
 */
function checkParsed(status: number, o: JsonValue, numbers: Map<string, string>, sources: Sources, request: Req | null): EnvelopeResult {
  let outcome: Outcome;
  try {
    outcome = members(o, numbers); // step 2
    if (!STATUS[outcome](status)) bad(`status ${status} does not match outcome ${outcome}`, '$.outcome'); // step 3
  } catch (e) {
    if (e instanceof Bad) return failed('E_ENVELOPE', e.detail, e.path);
    throw e;
  }
  const env = o as JsonObject;
  const echo = has(env, 'fn_hash') ? (env.fn_hash as string) : null;
  // The echo of a pin (since spec-0.4.2): required and equal, except rate_limited and bad_request
  // (equal when present) and pending (whose request echoes it).
  const pin = request?.fn_hash;
  if (pin !== undefined && outcome !== 'pending') {
    if (echo === null && outcome !== 'rate_limited' && outcome !== 'bad_request') return failed('E_ENVELOPE', 'an envelope answering a pinned request echoes its fn_hash', '$.fn_hash');
    if (echo !== null && echo !== pin) return failed('E_ENVELOPE', 'fn_hash echoes another function than the one pinned', '$.fn_hash');
  }
  if (!has(env, 'receipt')) {
    // Step 5 for outcomes without a receipt (since spec-0.4.1).
    if (outcome === 'bad_request' && env.error === 'E_JOB_UNKNOWN' && request?.job === undefined) {
      return failed('E_ENVELOPE', 'E_JOB_UNKNOWN answers a job URL only, and this request was not one', '$.error');
    }
    let pending: Pending | null = null;
    if (outcome === 'pending') {
      if (request === null || request.cell_id === undefined) return failed('E_ENVELOPE', 'pending does not answer this request', '$.outcome');
      const echoed = env.request as JsonObject;
      const same =
        echoed.cell_id === request.cell_id &&
        has(echoed, 'asof') === (request.asof !== undefined) &&
        (request.asof === undefined || echoed.asof === request.asof) &&
        has(echoed, 'fn_hash') === (request.fn_hash !== undefined) &&
        (request.fn_hash === undefined || echoed.fn_hash === request.fn_hash);
      if (!same) return failed('E_ENVELOPE', 'the pending envelope echoes another request than the one made', '$.request');
      if (request.job !== undefined && env.job !== request.job) return failed('E_ENVELOPE', `the pending envelope is for job ${String(env.job)}, not the job polled`, '$.job');
      if (request.mesh !== undefined && urlHost(env.poll as string) !== request.mesh) return failed('E_ENVELOPE', `poll names another host than the mesh asked (${request.mesh})`, '$.poll');
      pending = { job: env.job as string, poll: env.poll as string, estimateSeconds: env.estimate_seconds as number };
    }
    const fault = has(env, 'fault') ? (env.fault as Fault) : null;
    const detail = fault ? `outcome ${outcome}, fault ${fault}` : pending ? `outcome pending, job ${pending.job}, estimate ${pending.estimateSeconds} s` : has(env, 'error') ? `outcome ${outcome}, ${String(env.error)}` : `outcome ${outcome}`;
    return { ok: true, code: 'OK', outcome, trust: null, receiptHash: null, detail, path: null, fault, pending, fnHash: echo };
  }
  // Step 4.
  let r: { receipt: JsonObject; hash: string };
  try {
    r = verifyEmbedded(env.receipt, sources);
  } catch (e) {
    if (e instanceof Stop) return failed(e.code, `receipt: ${e.detail}`, atPath('$.receipt', e.path));
    throw e;
  }
  const cell = r.receipt.cell as JsonObject;
  // Step 5: the receipt answers the request.
  if (request !== null && request.cell_id !== undefined) {
    const cellId = sha256Hex(jcsBytes(cell));
    if (cellId !== request.cell_id) return failed('E_ENVELOPE', `the receipt is for cell ${cellId}, not the requested ${request.cell_id}`, '$.receipt.cell', r.hash);
  }
  // With a requested asof: at or before it, for ok and stale alike (D31, revised in spec-0.3.0).
  // Instants are fixed width, so string order is time order (SPEC 3.3).
  const asof = r.receipt.asof as string;
  if (request?.asof !== undefined && !(asof <= request.asof)) {
    return failed('E_ENVELOPE', `the receipt answers asof ${asof}, later than the requested ${request.asof}`, '$.receipt.asof', r.hash);
  }
  if (echo !== null && echo !== cell.fn_hash) return failed('E_ENVELOPE', "fn_hash echoes another function than the receipt's", '$.fn_hash', r.hash);
  // Step 6.
  const trust = env.trust as Trust;
  const problem = trustProblem(trust, r.receipt, request?.mesh);
  if (problem !== null) return failed('E_ENVELOPE', problem, '$.trust', r.hash);
  if (env.superseded_by === r.hash) return failed('E_ENVELOPE', 'superseded_by is the receipt itself', '$.superseded_by', r.hash);
  return { ok: true, code: 'OK', outcome, trust, receiptHash: r.hash, detail: `outcome ${outcome}, trust ${trust}, receipt signed by ${r.receipt.computed_by as string}`, path: null, fault: null, pending: null, fnHash: echo };
}

function checkStatus(status: unknown): asserts status is number {
  if (typeof status !== 'number' || !Number.isInteger(status)) throw new TypeError('status must be the HTTP status as an integer');
}

/**
 * Check a mesh response (SPEC 5.5): `status` is the HTTP status, `body` the response body as
 * JSON text or bytes (a parsed object is accepted too, without duplicate-member detection), and
 * `keys` any key source `verify` accepts, used to verify an embedded receipt through step 6.
 * `request` is what the client asked for: `{cell_id, asof?, job?, fn_hash?, mesh?}`, the id
 * (SPEC 4.4) of the requested cell resolved to the fn_hash the client used, the requested asof if
 * there was one, the job polled (spec-0.4.1), the pin and the host asked (spec-0.4.2).
 * Steps: strict parse; members (E_ENVELOPE); status against outcome (E_ENVELOPE); the echo of a
 * pin (E_ENVELOPE); the receipt (its own codes); the receipt answers the request (E_ENVELOPE),
 * `fn_hash` equal to the receipt's; then `trust` against the receipt (and, with `mesh`, `computed`
 * against the signer) and `superseded_by` against its hash (E_ENVELOPE). A `pending` envelope (202)
 * must echo exactly the request made (cell id, asof, pin), carry the job polled when `job` is given,
 * and, with `mesh`, a `poll` on that host; `E_JOB_UNKNOWN` only with `request.job`.
 *
 * Never throws for an invalid body or bad key material; throws TypeError only when `status` is
 * not an integer, `request` is malformed, or `keys` is not a key source at all.
 */
export function checkEnvelope(status: number, body: unknown, keys: unknown, request: EnvelopeRequest): EnvelopeResult {
  checkStatus(status);
  checkRequest(request);
  const sources = collectSources(keys);
  const numbers = new Map<string, string>();
  let o: JsonValue;
  try {
    o = toJson(body, numbers); // step 1
  } catch (e) {
    if (e instanceof DatumeshError) return failed(e.code, e.detail, e.path);
    throw e;
  }
  return checkParsed(status, o, numbers, sources, request as Req);
}

// ---------------------------------------------------------------- slice pages (5.6)

/** A slice request description (SPEC 5.6). */
export interface SliceRequest {
  /** The id (SHA-256 of the canonical bytes, 4.4) of the slice object the client resolved. */
  slice_id: string;
  asof?: string;
  /** The pin, when the slice was requested pinned. */
  fn_hash?: string;
  /** The host asked: then `next` must be on it, and `computed` is checked against signers. */
  mesh?: string;
  /** For a following page: the key of the last member already received, by open argument. */
  after?: Record<string, { type: string; value: string | boolean }>;
}

/** One member of a page (SPEC 5.6), checked as an `ok` or `stale` envelope bound to its cell. */
export interface SliceMember {
  outcome: 'ok' | 'stale';
  trust: Trust;
  receiptHash: string;
  /** The member's own `fn_hash` echo, or null. */
  fnHash: string | null;
  /** The member's cell (its receipt's `cell`). */
  cell: JsonObject;
}

export interface SlicePage {
  /** The slice object the page is of (it hashes to the requested slice id). */
  slice: JsonObject;
  members: SliceMember[];
  /** The URL of the following page, or null on the last page. */
  next: string | null;
}

/** An answer of the slice endpoint: an envelope result, with `page` when it is an `ok` page. */
export interface SlicePageResult extends EnvelopeResult {
  page: SlicePage | null;
}

const asPage = (r: EnvelopeResult, page: SlicePage | null = null): SlicePageResult => ({ ...r, page });

/** Compare two typed scalars of one key position in the member's type order (DEFECTS.md 51). */
function compareKeyValue(m: JsonObject, x: JsonObject): number {
  const t = m.type as string;
  if (t === 'boolean') return Number(m.value === true) - Number(x.value === true);
  const a = String(m.value);
  const b = String(x.value);
  if (x.type === t) return compareValues(t, a, b);
  return compareCodePoints(a, b);
}

function compareKeys(names: string[], a: JsonObject, b: JsonObject): number {
  for (const n of names) {
    const c = compareKeyValue(a[n] as JsonObject, b[n] as JsonObject);
    if (c !== 0) return c;
  }
  return 0;
}

const NEXT_RE = /^https:\/\/[^/]+\/[!-~]*$/;

function checkPage(status: number, o: JsonObject, numbers: Map<string, string>, sources: Sources, request: SliceRequest): SlicePageResult {
  const fail = (detail: string, path: string) => asPage(failed('E_ENVELOPE', detail, path));
  // 1. The page's members and their rules.
  const allowed = ['fn_hash', 'members', 'next', 'outcome', 'slice'];
  for (const k of ['members', 'slice']) if (!has(o, k)) return fail(`a page has ${k}`, '$');
  for (const k of sortedKeys(o)) if (!allowed.includes(k)) return fail(`member ${JSON.stringify(k)} is not allowed in a page`, memberPath('$', k));
  if (!Array.isArray(o.members)) return fail('members is an array of envelopes', '$.members');
  if (has(o, 'next')) {
    const n = o.next;
    if (typeof n !== 'string' || !URL_RE.test(n) || n.length > LIMITS.licence_url) return fail('next is an https URL of at most 512 printable ASCII characters', '$.next');
    if (!isDnsName(urlHost(n)) || !NEXT_RE.test(n)) return fail("next names a DNS name as its host, then a path", '$.next');
  }
  if (has(o, 'fn_hash') && (typeof o.fn_hash !== 'string' || !HEX64.test(o.fn_hash))) return fail('fn_hash is a function hash: 64 lowercase hex digits', '$.fn_hash');
  if (!isObject(o.slice)) return fail('slice is a slice object', '$.slice');
  if (status !== 200) return fail(`status ${status} does not match outcome ok`, '$.outcome');
  // 2. The slice requested, the pin's echo, next on the host asked.
  const slice = o.slice as JsonObject;
  const echo = has(o, 'fn_hash') ? (o.fn_hash as string) : null;
  if (request.fn_hash !== undefined && echo === null) return fail('an envelope answering a pinned request echoes its fn_hash', '$.fn_hash');
  if (request.fn_hash !== undefined && echo !== request.fn_hash) return fail('fn_hash echoes another function than the one pinned', '$.fn_hash');
  if (echo !== null && echo !== slice.fn_hash) return fail("fn_hash echoes another function than the slice's", '$.fn_hash');
  if (sha256Hex(jcsBytes(slice)) !== request.slice_id) return fail('the page is of another slice than the one requested', '$.slice');
  try {
    validate(slice, 'slice', '$.slice');
  } catch (e) {
    if (e instanceof DatumeshError) return fail(`the slice is not a slice object: ${e.code}: ${e.detail}`, '$.slice');
    throw e;
  }
  if (isVersionSlice(slice)) return fail('the slice endpoint serves membership slices', '$.slice');
  if (request.mesh !== undefined && has(o, 'next') && urlHost(o.next as string) !== request.mesh) return fail(`next names another host than the mesh asked (${request.mesh})`, '$.next');
  const sargs = slice.args as JsonObject;
  const open = sortedKeys(sargs).filter((k) => sargs[k] === '*' || (isObject(sargs[k]) && !has(sargs[k] as JsonObject, 'value')));
  if (request.after !== undefined && sortedKeys(request.after).join(',') !== open.join(',')) return fail("after is a key: the slice's open arguments, as typed scalars", 'request.after');
  // 3. Each member, in order.
  const out: SliceMember[] = [];
  let prev: JsonObject | null = request.after ? (request.after as unknown as JsonObject) : null;
  for (let i = 0; i < (o.members as JsonValue[]).length; i++) {
    const at = `$.members[${i}]`;
    const m = (o.members as JsonValue[])[i];
    if (!isObject(m) || (m.outcome !== 'ok' && m.outcome !== 'stale')) return fail('a slice member is an ok or stale envelope', at);
    try {
      members(m, subNumbers(numbers, at));
    } catch (e) {
      if (e instanceof Bad) return fail(e.detail, atPath(at, e.path));
      throw e;
    }
    let r: { receipt: JsonObject; hash: string };
    try {
      r = verifyEmbedded(m.receipt, sources);
    } catch (e) {
      if (e instanceof Stop) return asPage(failed(e.code, `member ${i}: receipt: ${e.detail}`, atPath(`${at}.receipt`, e.path)));
      throw e;
    }
    const cell = r.receipt.cell as JsonObject;
    const mecho = has(m, 'fn_hash') ? (m.fn_hash as string) : null;
    if (mecho !== null && mecho !== cell.fn_hash) return fail("fn_hash echoes another function than the receipt's", `${at}.fn_hash`);
    if (!memberOf(slice, false, r.receipt)) return fail('the receipt is not of a cell of the slice', `${at}.receipt.cell`);
    if (request.asof !== undefined && !((r.receipt.asof as string) <= request.asof)) return fail("the receipt's asof is after the one requested", `${at}.receipt.asof`);
    const problem = trustProblem(m.trust as Trust, r.receipt, request.mesh);
    if (problem !== null) return fail(problem, `${at}.trust`);
    if (m.superseded_by === r.hash) return fail('superseded_by is the receipt itself', `${at}.superseded_by`);
    const key = cell.args as JsonObject;
    if (prev !== null && compareKeys(open, key, prev) <= 0) return fail('members are in strictly ascending key order, after the cursor', at);
    prev = key;
    out.push({ outcome: m.outcome as 'ok' | 'stale', trust: m.trust as Trust, receiptHash: r.hash, fnHash: mecho, cell });
  }
  const page: SlicePage = { slice, members: out, next: has(o, 'next') ? (o.next as string) : null };
  return { ok: true, code: 'OK', outcome: 'ok', trust: null, receiptHash: null, detail: `a page of ${out.length} members${page.next ? ', and a next page' : ''}`, path: null, fault: null, pending: null, fnHash: echo, page };
}

function slicePage(status: number, o: JsonValue, numbers: Map<string, string>, sources: Sources, request: SliceRequest): SlicePageResult {
  if (isObject(o) && o.outcome === 'ok') return checkPage(status, o, numbers, sources, request);
  if (isObject(o) && (o.outcome === 'stale' || o.outcome === 'pending')) return asPage(failed('E_ENVELOPE', `${String(o.outcome)} is not an answer of the slice endpoint`, '$.outcome'));
  // Any other outcome keeps its meaning and members (a name unbound is not_covered with
  // E_NAME_UNBOUND); there is no cell to bind, and no job.
  return asPage(checkParsed(status, o, numbers, sources, { asof: request.asof, fn_hash: request.fn_hash, mesh: request.mesh }));
}

/**
 * Check an answer of the slice endpoint (SPEC 5.6) against its request description
 * `{slice_id, asof?, fn_hash?, mesh?, after?}`. An `ok` answer is a page: its members (each an `ok`
 * or `stale` envelope, its receipt verified through step 6 with 10.1's codes, a cell of the
 * slice, at or before the requested `asof`, `trust` as in 5.5 step 6, keys strictly ascending
 * and after `after`), `slice` hashing to `slice_id`, the pin's echo, and `next` (with `mesh`, on
 * that host). `stale` and `pending` are not answers here; any other outcome is checked as an
 * envelope with nothing to bind. Never throws for an invalid body; TypeError for a malformed
 * request description, status or key source.
 */
export function checkSlicePage(status: number, body: unknown, keys: unknown, request: SliceRequest): SlicePageResult {
  checkStatus(status);
  checkSliceRequest(request);
  const sources = collectSources(keys);
  const numbers = new Map<string, string>();
  let o: JsonValue;
  try {
    o = toJson(body, numbers);
  } catch (e) {
    if (e instanceof DatumeshError) return asPage(failed(e.code, e.detail, e.path));
    throw e;
  }
  return slicePage(status, o, numbers, sources, request);
}

// ---------------------------------------------------------------- batches (5.7)

/** The answer of a batch (SPEC 5.7). */
export interface BatchResult {
  /** True when the batch is well formed as a whole: a 200 array of items, or a valid refusal. Items may still fail. */
  ok: boolean;
  /** "OK", or the code of the whole batch's failure (a parse code or E_ENVELOPE). */
  code: 'OK' | ErrorCode;
  /** For a refusal (any status but 200), its outcome when ok; else null. */
  outcome: Outcome | null;
  detail: string;
  path: string | null;
  /** For a 200 batch, each item's result in request order (a failing item in its place); else null. */
  items: (EnvelopeResult | SlicePageResult)[] | null;
  /** For a refusal, its envelope result; else null. */
  refusal: EnvelopeResult | null;
}

const REFUSALS: readonly string[] = ['unlicensed', 'payment_required', 'rate_limited', 'bad_request', 'error'];

/**
 * Check a `/cells` response (SPEC 5.7): `status` and `body` as received, `requests` one request
 * description per request, in order (each as for checkEnvelope, or for checkSlicePage when it has
 * `slice_id`). A 200 answer is an array with exactly one `{envelope, status}` item per request,
 * `status` an integer 100-599 (E_ENVELOPE for the whole batch otherwise); then each item is
 * checked as an envelope with its own status against its own request, and a failing item is
 * reported in its place without failing the others. Any other status is one envelope of a refusal
 * outcome (unlicensed, payment_required, rate_limited, bad_request, error), with nothing to bind.
 */
export function checkBatch(status: number, body: unknown, keys: unknown, requests: readonly (EnvelopeRequest | SliceRequest)[]): BatchResult {
  checkStatus(status);
  if (!Array.isArray(requests)) throw new TypeError('requests must be an array of request descriptions, one per request of the batch');
  for (const r of requests) {
    if (isObject(r) && has(r, 'slice_id')) checkSliceRequest(r);
    else checkRequest(r);
  }
  const sources = collectSources(keys);
  const whole = (code: ErrorCode, detail: string, path: string | null): BatchResult => ({ ok: false, code, outcome: null, detail, path, items: null, refusal: null });
  const numbers = new Map<string, string>();
  let o: JsonValue;
  try {
    o = toJson(body, numbers);
  } catch (e) {
    if (e instanceof DatumeshError) return whole(e.code, e.detail, e.path);
    throw e;
  }
  if (status !== 200) {
    if (!isObject(o) || typeof o.outcome !== 'string' || !REFUSALS.includes(o.outcome)) return whole('E_ENVELOPE', 'a batch is refused whole only by a refusal outcome', '$.outcome');
    const r = checkParsed(status, o, numbers, sources, null);
    if (!r.ok) return whole(r.code as ErrorCode, r.detail, r.path);
    return { ok: true, code: 'OK', outcome: r.outcome, detail: `the batch was refused: ${r.detail}`, path: null, items: null, refusal: r };
  }
  if (!Array.isArray(o) || o.length !== requests.length) return whole('E_ENVELOPE', 'a batch response is an array with one item per request', '$');
  for (let i = 0; i < o.length; i++) {
    const it = o[i];
    const at = `$[${i}]`;
    if (!isObject(it) || sortedKeys(it).join(',') !== 'envelope,status') return whole('E_ENVELOPE', 'an item is {envelope, status}', at);
    const s = it.status;
    const text = numbers.get(`${at}.status`);
    if (typeof s !== 'number' || (text !== undefined ? !/^[1-9][0-9]*$/.test(text) : !Number.isSafeInteger(s)) || s < 100 || s > 599) return whole('E_ENVELOPE', "an item's status is an HTTP status code, an integer 100-599", `${at}.status`);
  }
  const items = (o as JsonObject[]).map((it, i) => {
    const at = `$[${i}].envelope`;
    const req = requests[i] as unknown as JsonObject;
    const sub = subNumbers(numbers, at);
    const r = has(req, 'slice_id') ? slicePage(it.status as number, it.envelope, sub, sources, req as unknown as SliceRequest) : checkParsed(it.status as number, it.envelope, sub, sources, req as Req);
    return r.ok ? r : { ...r, path: atPath(at, r.path) };
  });
  const bad = items.filter((r) => !r.ok).length;
  return { ok: true, code: 'OK', outcome: null, detail: `${items.length} items, ${bad} failing`, path: null, items, refusal: null };
}
