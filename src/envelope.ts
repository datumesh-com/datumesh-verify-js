// Response envelopes (SPEC.md 5.5): the unsigned JSON body a mesh returns around a receipt.
// Synchronous, offline; the embedded receipt is verified through step 6 with the given keys.
import { DatumeshError, ERROR_CODES, type ErrorCode } from './errors.js';
import { has, isObject, memberPath, normalizeValue, sortedKeys, toJson, type JsonObject, type JsonValue } from './json.js';
import { LIMITS, URL_RE, checkDnsName, checkFunctionName, checkNumber, checkString, compareValues, isHex, isInstant, loopbackOrigin } from './lexical.js';
import { sha256Hex } from './hash.js';
import { jcsBytes, jcsText } from './jcs.js';
import { collectSources, type Sources } from './keys.js';
import { isUnrooted } from './licence.js';
import { isCurrency } from './units.js';
import { Stop, memberOf, verifyEmbedded } from './verify.js';
import { isVersionSlice, validate } from './validate.js';

/** Since spec-0.6.0 `scenario`: the answer to a whatif request (5.9). */
export type Outcome = 'ok' | 'stale' | 'not_covered' | 'unlicensed' | 'payment_required' | 'rate_limited' | 'error' | 'bad_request' | 'pending' | 'scenario';

/** A typed scalar (4.1) as the wire carries it: a string, or a boolean for a boolean value. */
export interface TypedValue {
  type: string;
  value: string | boolean;
}

/** A cell (4.4) as an override or a scenario names it. */
export interface ScenarioCell {
  args: Record<string, TypedValue>;
  fn: string;
  fn_hash: string;
  ns: string;
}

/** Since spec-0.6.0 (5.9): a value override, a cell's value replaced for the read. */
export interface ScenarioValueOverride {
  cell: ScenarioCell;
  value: TypedValue;
}

/** Since spec-0.6.0 (5.9): a slice override, members of a stored slice added and removed (sorted by id). */
export interface ScenarioSliceOverride {
  slice: Record<string, unknown>;
  add: { cell: ScenarioCell; value: TypedValue }[];
  remove: ScenarioCell[];
}

export type ScenarioOverride = ScenarioValueOverride | ScenarioSliceOverride;

/**
 * Since spec-0.6.0 (5.9): a checked scenario, the value a cell would have under the request's
 * overrides. It is never a fact: not signed, stored or served as the cell's value, so it has no
 * receipt and no trust. `value` is the lexical form of `type` (a boolean value is `true` or
 * `false`); `solved` is the value found by `solve`, present exactly when the request had one.
 */
export interface Scenario {
  cell: ScenarioCell;
  type: string;
  value: string;
  asof: string;
  overrides: ScenarioOverride[];
  solved: { vary: ScenarioCell; value: TypedValue } | null;
}

/** Since spec-0.6.0 (C6, 5.5): the fixes a cycle admits, in this order. */
export type CycleFix = 'asof' | 'lag' | 'step' | 'solver';

/** Since spec-0.6.0 (C6, 15.12): a cycle on an `error` envelope (E_EVAL_UNAVAILABLE): its path of calls and its fixes. */
export interface Cycle {
  path: string[];
  fixes: CycleFix[];
}

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
  /**
   * Since spec-0.6.0 (5.9): the overrides of a whatif request, the canonical array (a value
   * override or a slice override each), at most 64; present for a whatif request, possibly empty
   * when `solve` is given. Malformed: a TypeError (the caller's error).
   */
  overrides?: ScenarioOverride[];
  /** Since spec-0.6.0 (5.9): the vary cell's id (64 lowercase hex digits) of a whatif request with `solve`. */
  solve?: string;
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
/** `computed` since spec-0.4.2: the mesh asked evaluated and signed the cell itself (5.5). `relayed` since spec-0.6.0: the publisher signed a value taken from another party (a receipt with `source`). */
export type Trust = 'primary' | 'computed' | 'verified' | 'unverified' | 'relayed';

/** SPEC 5.5, 15.11 (since spec-0.4.0): the formula evaluation faults a `not_covered` envelope may carry. */
/** Since spec-0.6.0, E_WHATIF_NO_SOLUTION is a request fault (5.9): a whatif `solve` found no value, not a formula fault. */
export type Fault = 'E_FORMULA_DIV_ZERO' | 'E_FORMULA_DOMAIN' | 'E_FORMULA_RANGE' | 'E_FORMULA_EMPTY' | 'E_FORMULA_ABSENT' | 'E_FORMULA_FUTURE' | 'E_FORMULA_KEY' | 'E_FORMULA_DISPATCH_KEY' | 'E_WHATIF_NO_SOLUTION';
export const FAULTS: readonly Fault[] = ['E_FORMULA_DIV_ZERO', 'E_FORMULA_DOMAIN', 'E_FORMULA_RANGE', 'E_FORMULA_EMPTY', 'E_FORMULA_ABSENT', 'E_FORMULA_FUTURE', 'E_FORMULA_KEY', 'E_FORMULA_DISPATCH_KEY', 'E_WHATIF_NO_SOLUTION'];

/**
 * Since spec-0.4.3: what failed in reaching a foreign mesh, the `detail` of an `error` envelope
 * carrying E_FOREIGN_UNAVAILABLE (SPEC 5.5).
 */
export type ForeignDetail = 'offline' | 'network' | 'dns' | 'tls' | 'timeout' | 'refused';
export const FOREIGN_DETAILS: readonly ForeignDetail[] = ['offline', 'network', 'dns', 'tls', 'timeout', 'refused'];

/** The members every envelope result has (SPEC 5.5). */
interface EnvelopeCommon {
  /** "OK", E_ENVELOPE, a parse code, or the code of the embedded receipt's verification. */
  code: 'OK' | ErrorCode;
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
  /**
   * Since spec-0.4.3: when ok and the envelope is an `error` with E_FOREIGN_UNAVAILABLE (the cell
   * belongs to another mesh, which could not be reached; HTTP 502), its `detail`; else null.
   */
  foreignDetail: ForeignDetail | null;
  /** Since spec-0.5.0: the `resolved` member when ok and present (5.5, 16.7): what a short call resolved, as the mesh says it; else null. */
  resolved: Resolved | null;
  /** Since spec-0.5.0: the `shadows` member when ok and present (5.5, 16.9); else null. */
  shadows: Shadows | null;
  /** Since spec-0.5.0: the `error` member when ok and the outcome carries one (not_covered, bad_request, error); else null. */
  error: ErrorCode | null;
  /** Since spec-0.6.0 (5.5, 15.12): the `cycle` of an `error` envelope when ok and present, else null. */
  cycle: Cycle | null;
}

/**
 * A checked envelope with a receipt (SPEC 5.5, outcomes `ok` and `stale`): the receipt verified
 * through step 6, with its trust, and `kind` `receipt`.
 */
export interface ReceiptEnvelope extends EnvelopeCommon {
  ok: true;
  kind: 'receipt';
  outcome: 'ok' | 'stale';
  /** The trust label, checked against the receipt (5.5 step 6). */
  trust: Trust;
  /** The embedded receipt's hash (SPEC 8.3), verified through step 6. */
  receiptHash: string;
  scenario: null;
}

/**
 * Since spec-0.6.0 (5.9): a checked scenario. It is its own result kind, never a receipt: it has
 * no receipt hash and no trust, and nothing a verifier holds can make it one.
 */
export interface ScenarioEnvelope extends EnvelopeCommon {
  ok: true;
  kind: 'scenario';
  outcome: 'scenario';
  trust: null;
  receiptHash: null;
  scenario: Scenario;
}

/**
 * Every other result: an envelope without a receipt (not_covered, unlicensed, payment_required,
 * rate_limited, error, bad_request, pending), or a failed check (`ok` false), whose `receiptHash`
 * is the hash of an embedded receipt that verified through step 6, else null. `kind` is null.
 */
export interface OtherEnvelope extends EnvelopeCommon {
  ok: boolean;
  kind: null;
  /** The envelope's outcome when ok, else null. */
  outcome: Outcome | null;
  trust: null;
  receiptHash: string | null;
  scenario: null;
}

/** The result of checkEnvelope: a receipt, a scenario, or any other checked envelope (or a failure). */
export type EnvelopeResult = ReceiptEnvelope | ScenarioEnvelope | OtherEnvelope;

/** Since spec-0.5.0 (5.5): a resolution of a short call (16.7). `lookup` carries its `asof`. */
export interface Resolution {
  from: string;
  kind: 'alias' | 'default' | 'method' | 'lookup';
  to: string;
  asof?: string;
}

/** Since spec-0.5.0 (5.5): `resolved`, the full canonical call and what it resolved, optionally the alias snapshot instant. */
export interface Resolved {
  call: string;
  resolutions: Resolution[];
  aliases_tx?: string;
}

/** Since spec-0.5.0 (5.5, 16.9): a class name that a mesh binds to another hash than its reference class. */
export interface Shadows {
  class: string;
  reference: string;
}

/** SPEC 5.5: required and optional members per outcome (besides `outcome`). */
const MEMBERS: Record<Outcome, { required: string[]; optional: string[] }> = {
  ok: { required: ['receipt', 'trust'], optional: ['superseded_by', 'reason', 'fn_hash', 'resolved', 'shadows'] },
  stale: { required: ['receipt', 'trust', 'age_seconds'], optional: ['superseded_by', 'reason', 'fn_hash', 'resolved', 'shadows'] },
  not_covered: { required: [], optional: ['fault', 'error', 'fn_hash', 'resolved', 'shadows'] },
  unlicensed: { required: [], optional: ['fn_hash', 'resolved', 'shadows'] },
  payment_required: { required: ['quote'], optional: ['fn_hash', 'resolved', 'shadows'] },
  rate_limited: { required: ['retry_after_seconds'], optional: ['fn_hash'] },
  error: { required: ['error'], optional: ['cycle', 'detail', 'fn_hash', 'resolved', 'shadows'] }, // detail since spec-0.4.3; cycle since spec-0.6.0
  bad_request: { required: ['error'], optional: ['fn_hash'] },
  pending: { required: ['estimate_seconds', 'job', 'poll', 'request'], optional: [] },
  scenario: { required: ['scenario'], optional: ['fn_hash', 'resolved'] }, // since spec-0.6.0 (5.9)
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
  scenario: (s) => s === 200,
};
/** SPEC 5.5: the codes `parse` can raise (5.4), the only ones a bad_request carries. */
const PARSE_CODES: readonly string[] = ['E_PARSE_URI', 'E_CANON_NAME', 'E_CANON_ARG_NAME', 'E_CANON_ARG_DUPLICATE', 'E_CANON_ARG_ORDER', 'E_CANON_PERCENT', 'E_CANON_TYPE', 'E_CANON_NUMBER', 'E_CANON_DATE', 'E_CANON_INSTANT', 'E_CANON_STRING', 'E_CANON_BLOB', 'E_CANON_LIMIT', 'E_ARG_UNKNOWN', 'E_ARG_MISSING'];
/** Since spec-0.4.2 a bad_request also carries E_CANON_HEX (a pin) and E_SLICE_AT_CELL; E_JOB_UNKNOWN only at a job URL. Since spec-0.5.0, E_SHORT_ID_AMBIGUOUS (16.8) and a call's E_KEY_NORMALISATION and E_KEY_ENCODING (5.5, 5.8). */
const BAD_REQUEST_CODES: readonly string[] = [...PARSE_CODES, 'E_CANON_HEX', 'E_SLICE_AT_CELL', 'E_JOB_UNKNOWN', 'E_SHORT_ID_AMBIGUOUS', 'E_KEY_NORMALISATION', 'E_KEY_ENCODING', 'E_WHATIF_UNSUPPORTED', 'E_SLICE_MEMBER'];

/** SPEC 5.5, 10.2 (since spec-0.5.0): the codes no error envelope carries: the client's E_ENVELOPE and E_DESCRIBE, the request codes, the key codes, the define and write codes and the eight class codes; since spec-0.6.0 E_WHATIF_UNSUPPORTED, a bad_request code. */
const NOT_ERROR_CODES: readonly string[] = ['E_ENVELOPE', 'E_DESCRIBE', 'E_JOB_UNKNOWN', 'E_SLICE_AT_CELL', 'E_NAME_UNBOUND', 'E_SHORT_ID_AMBIGUOUS', 'E_KEY_NORMALISATION', 'E_KEY_ENCODING', 'E_UNROOTED_INPUT', 'E_NAMESPACE_SUSPENDED', 'E_CLASS_MEMBER', 'E_CLASS_PARENT', 'E_CLASS_INHERIT', 'E_CLASS_OVERRIDE', 'E_CLASS_FINAL', 'E_CLASS_METHOD', 'E_CLASS_INTERFACE', 'E_CLASS_OWNER', 'E_WHATIF_UNSUPPORTED', 'E_WHATIF_NO_SOLUTION'];
/** SPEC 5.5 (since spec-0.5.0): the codes a not_covered envelope carries in `error`. */
const NOT_COVERED_CODES: readonly string[] = ['E_NAME_UNBOUND', 'E_NAMESPACE_SUSPENDED'];
/** SPEC 5.5 (since spec-0.5.0): the arguments of `resolved` resolutions. */
const RESOLUTION_KINDS: readonly string[] = ['alias', 'default', 'method', 'lookup'];
const TRUST: readonly string[] = ['primary', 'computed', 'verified', 'unverified', 'relayed'];
const HEX64 = /^[0-9a-f]{64}$/;
const JOB_RE = /^[0-9a-f]{32,64}$/;
const HTTP_URL_RE = /^http:\/\/[!-~]+$/;
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
  // Since spec-0.4.3: detail is present exactly when error is E_FOREIGN_UNAVAILABLE (only an
  // error envelope may carry either: the table above and the code lists below).
  if (outcome === 'error' && (o.error === 'E_FOREIGN_UNAVAILABLE') !== has(o, 'detail')) bad('detail is present exactly when error is E_FOREIGN_UNAVAILABLE', has(o, 'detail') ? '$.detail' : '$');
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
          if (typeof v !== 'string' || !BAD_REQUEST_CODES.includes(v)) bad('a bad_request carries a code that parsing a cell URI raises (SPEC 5.4), E_CANON_HEX, E_SLICE_AT_CELL, E_JOB_UNKNOWN at a job URL, or (since spec-0.5.0) E_SHORT_ID_AMBIGUOUS, E_KEY_NORMALISATION or E_KEY_ENCODING', p);
        } else if (outcome === 'not_covered') {
          if (typeof v !== 'string' || !NOT_COVERED_CODES.includes(v)) bad('not_covered carries only E_NAME_UNBOUND or E_NAMESPACE_SUSPENDED in error (since spec-0.5.0)', p);
        } else if (typeof v !== 'string' || NOT_ERROR_CODES.includes(v) || !(ERROR_CODES as readonly string[]).includes(v)) {
          bad('error is a code from SPEC.md 10.2 other than the codes of 5.5 that no error envelope carries', p);
        }
        break;
      case 'detail':
        if (typeof v !== 'string' || !(FOREIGN_DETAILS as readonly string[]).includes(v)) bad(`detail is one of ${FOREIGN_DETAILS.join(', ')} (SPEC 5.5)`, p);
        break;
      case 'fn_hash':
        if (typeof v !== 'string' || !HEX64.test(v)) bad('fn_hash is a function hash: 64 lowercase hex digits', p);
        break;
      case 'job':
        if (typeof v !== 'string' || !JOB_RE.test(v)) bad('job is 32 to 64 lowercase hex digits', p);
        break;
      case 'poll':
        // SPEC 5.5: https:// and printable ASCII, at most 512 characters, ending /jobs/<job>; the text
        // between https:// and the next / is a DNS name (2.1). Since spec-0.5.0 an http:// loopback
        // URL (9.6), which step 3a allows only for the unrooted mesh asked. That it is the host
        // asked is the client's HTTP layer's check (MUST), which an envelope cannot make.
        if (typeof v !== 'string' || v.length > LIMITS.licence_url || !v.endsWith(`/jobs/${String(o.job)}`)) bad("poll is the job's URL, at most 512 characters, ending /jobs/<job>", p);
        if (v.startsWith('http://')) {
          if (!HTTP_URL_RE.test(v) || loopbackOrigin(v) === null) bad('poll is https://, or http:// on a loopback address (9.6)', p);
        } else {
          if (!URL_RE.test(v)) bad("poll is the job's https URL, printable ASCII", p);
          if (!isDnsName(v.slice('https://'.length).split('/')[0])) bad("poll's host (between https:// and the next /) is a DNS name: no port, userinfo, IP address, uppercase or query", p);
        }
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
      case 'resolved':
        resolvedMember(v, p);
        break;
      case 'shadows':
        shadowsMember(v, p);
        break;
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
        if (typeof v !== 'string' || !TRUST.includes(v)) bad('trust is one of primary, computed, verified, unverified, relayed', p);
        break;
      case 'cycle':
        // Since spec-0.6.0 (C6, 5.5): only with E_EVAL_UNAVAILABLE (the cycle is evaluation's failure).
        if (o.error !== 'E_EVAL_UNAVAILABLE') bad('cycle is carried by an error envelope with E_EVAL_UNAVAILABLE only', p);
        cycleMember(v, p);
        break;
      case 'scenario':
        scenarioMember(v, p);
        break;
    }
  }
  return outcome;
}

/** SPEC 15.12 (since spec-0.6.0): `cycle`, exactly path and fixes, with the rules of 5.5. */
function cycleMember(v: JsonValue, path: string): void {
  if (!isObject(v)) bad('cycle is an object {path, fixes}', path);
  for (const k of ['fixes', 'path']) if (!has(v, k)) bad(`cycle has no ${k}`, path);
  for (const k of sortedKeys(v)) if (k !== 'fixes' && k !== 'path') bad(`cycle has an unexpected member ${JSON.stringify(k)}`, memberPath(path, k));
  const path_ = v.path;
  const pp = memberPath(path, 'path');
  if (!Array.isArray(path_) || path_.length < 2 || path_.some((c) => typeof c !== 'string' || c === '')) bad('cycle.path is an array of at least two non-empty call strings', pp);
  const calls = path_ as string[];
  if (calls[0] !== calls[calls.length - 1]) bad('cycle.path starts and ends with the same call (the cell that reappeared)', pp);
  const fixes = v.fixes;
  const fp = memberPath(path, 'fixes');
  if (!Array.isArray(fixes) || fixes.length === 0) bad('cycle.fixes is a non-empty array', fp);
  const order = ['asof', 'lag', 'step', 'solver'];
  let last = -1;
  for (const f of fixes as JsonValue[]) {
    const i = typeof f === 'string' ? order.indexOf(f) : -1;
    if (i < 0) bad('cycle.fixes holds only asof, lag, step and solver', fp);
    if (i <= last) bad('cycle.fixes is distinct and in the order asof, lag, step, solver', fp);
    last = i;
  }
}

/** SPEC 5.9 (since spec-0.6.0): the members of a scenario, its cell, its value and its overrides checked by their rules. */
function scenarioMember(v: JsonValue, path: string): void {
  if (!isObject(v)) bad('scenario is an object', path);
  const required = ['asof', 'cell', 'overrides', 'type', 'value'];
  for (const k of required) if (!has(v, k)) bad(`scenario has no ${k}`, path);
  for (const k of sortedKeys(v)) if (!required.includes(k) && k !== 'solved') bad(`scenario has an unexpected member ${JSON.stringify(k)}`, memberPath(path, k));
  if (typeof v.asof !== 'string' || !isInstant(v.asof)) bad('scenario.asof is an instant', memberPath(path, 'asof'));
  inner(() => validate(v.cell as JsonValue, 'cell', memberPath(path, 'cell')), memberPath(path, 'cell'));
  inner(() => validate({ type: v.type, value: v.value } as JsonObject, 'scalar', memberPath(path, 'value')), memberPath(path, 'value'));
  const problem = overrideProblem(v.overrides as JsonValue);
  if (problem !== null) bad(problem, memberPath(path, 'overrides'));
  if (has(v, 'solved')) {
    const sv = v.solved;
    const sp = memberPath(path, 'solved');
    if (!isObject(sv) || sortedKeys(sv).join() !== 'value,vary') bad('scenario.solved is {value, vary}', sp);
    inner(() => validate(sv.vary as JsonValue, 'cell', memberPath(sp, 'vary')), memberPath(sp, 'vary'));
    inner(() => validate(sv.value as JsonValue, 'scalar', memberPath(sp, 'value')), memberPath(sp, 'value'));
    if ((sv.value as JsonObject).type !== 'number') bad('scenario.solved.value is a number', memberPath(sp, 'value'));
  }
}

/**
 * SPEC 5.9 (since spec-0.6.0): the overrides array of a whatif request, checked by the rules of
 * its members: at most 64; a value override {cell, value}, or a slice override {slice, add, remove}
 * with each added member {cell, value} and each removed cell. Returns the problem, or null.
 */
function overrideProblem(v: JsonValue): string | null {
  if (!Array.isArray(v)) return 'overrides is an array of overrides';
  if (v.length > 64) return 'overrides holds at most 64 overrides';
  for (let i = 0; i < v.length; i++) {
    const o = v[i];
    const p = `$.overrides[${i}]`;
    if (!isObject(o)) return `${p} is an override object`;
    const names = sortedKeys(o).join();
    try {
      if (names === 'cell,value') {
        validate(o.cell as JsonValue, 'cell', `${p}.cell`);
        validate(o.value as JsonValue, 'scalar', `${p}.value`);
      } else if (names === 'add,remove,slice') {
        validate(o.slice as JsonValue, 'slice', `${p}.slice`);
        if (!Array.isArray(o.add)) return `${p}.add is an array`;
        for (const a of o.add as JsonValue[]) {
          if (!isObject(a) || sortedKeys(a).join() !== 'cell,value') return `${p}.add holds {cell, value} members`;
          validate(a.cell as JsonValue, 'cell', `${p}.add.cell`);
          validate(a.value as JsonValue, 'scalar', `${p}.add.value`);
        }
        if (!Array.isArray(o.remove)) return `${p}.remove is an array`;
        for (const c of o.remove as JsonValue[]) validate(c, 'cell', `${p}.remove`);
      } else {
        return `${p} is a value override {cell, value} or a slice override {slice, add, remove}`;
      }
    } catch (e) {
      if (e instanceof DatumeshError) return `${p}: ${e.code}: ${e.detail}`;
      throw e;
    }
  }
  return null;
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

/** Since spec-0.5.0 (5.5): `resolved`, exactly call, resolutions and optionally aliases_tx (an instant). */
function resolvedMember(v: JsonValue, path: string): void {
  if (!isObject(v)) bad('resolved is an object', path);
  for (const k of ['call', 'resolutions']) if (!has(v, k)) bad(`resolved has no ${k}`, path);
  for (const k of sortedKeys(v)) if (!['call', 'resolutions', 'aliases_tx'].includes(k)) bad(`resolved has an unexpected member ${JSON.stringify(k)}`, memberPath(path, k));
  if (typeof v.call !== 'string' || v.call === '') bad('resolved.call is a non-empty string', memberPath(path, 'call'));
  if (!Array.isArray(v.resolutions)) bad('resolved.resolutions is an array', memberPath(path, 'resolutions'));
  (v.resolutions as JsonValue[]).forEach((r, i) => {
    const rp = memberPath(memberPath(path, 'resolutions'), `[${i}]`);
    if (!isObject(r)) bad('a resolution is an object', rp);
    const lookup = (r as JsonObject).kind === 'lookup';
    const want = lookup ? ['asof', 'from', 'kind', 'to'] : ['from', 'kind', 'to'];
    if (sortedKeys(r as JsonObject).join() !== want.join()) bad(lookup ? 'a lookup resolution is {from, kind, to, asof}' : 'a resolution is {from, kind, to}', rp);
    const ro = r as JsonObject;
    if (typeof ro.from !== 'string' || typeof ro.to !== 'string') bad('a resolution has string from and to', rp);
    if (typeof ro.kind !== 'string' || !RESOLUTION_KINDS.includes(ro.kind)) bad(`a resolution kind is one of ${RESOLUTION_KINDS.join(', ')}`, memberPath(rp, 'kind'));
    if (lookup && (typeof ro.asof !== 'string' || !isInstant(ro.asof))) bad('a lookup resolution has its asof, an instant', memberPath(rp, 'asof'));
  });
  if (has(v, 'aliases_tx') && (typeof v.aliases_tx !== 'string' || !isInstant(v.aliases_tx))) bad('aliases_tx is an instant', memberPath(path, 'aliases_tx'));
}

/** Since spec-0.5.0 (5.5, 16.9): `shadows`, exactly class (a class name) and reference (a class hash). */
function shadowsMember(v: JsonValue, path: string): void {
  if (!isObject(v)) bad('shadows is an object', path);
  if (sortedKeys(v).join() !== 'class,reference') bad('shadows is {class, reference}', path);
  if (typeof v.class !== 'string') bad('shadows.class is a class name', memberPath(path, 'class'));
  inner(() => checkFunctionName(v.class as string, memberPath(path, 'class')), memberPath(path, 'class'));
  if (typeof v.reference !== 'string' || !HEX64.test(v.reference)) bad('shadows.reference is a class hash: 64 lowercase hex digits', memberPath(path, 'reference'));
}

/** A plain copy of a parsed value (for the result: plain objects, as the input was). */
const plain = <T>(v: JsonValue): T => JSON.parse(jcsText(v)) as T;

/** The members the result exposes (5.5, since spec-0.5.0): resolved, shadows and the error of the outcome. */
function exposed(env: JsonObject, outcome: Outcome): Pick<EnvelopeCommon, 'resolved' | 'shadows' | 'error' | 'cycle'> {
  return {
    resolved: has(env, 'resolved') ? plain<Resolved>(env.resolved as JsonValue) : null,
    shadows: has(env, 'shadows') ? plain<Shadows>(env.shadows as JsonValue) : null,
    error: (outcome === 'not_covered' || outcome === 'bad_request' || outcome === 'error') && has(env, 'error') ? (env.error as ErrorCode) : null,
    cycle: has(env, 'cycle') ? plain<Cycle>(env.cycle as JsonValue) : null,
  };
}

/** A typed scalar by 4.1 and section 3 (its type known, its value in that type's lexical form). */
const isTypedScalar = (v: unknown): boolean => {
  try {
    validate(normalizeValue(v, '$'), 'scalar');
    return true;
  } catch {
    return false;
  }
};

/** The request members every request description may carry (SPEC 5.5, 5.6). */
function checkCommon(request: JsonObject): boolean {
  return (
    (!has(request, 'asof') || (typeof request.asof === 'string' && isInstant(request.asof))) &&
    // Since fc870ab a malformed pin or mesh is the caller's error, never compared as given (5.5).
    (!has(request, 'fn_hash') || (typeof request.fn_hash === 'string' && HEX64.test(request.fn_hash))) &&
    (!has(request, 'mesh') || (typeof request.mesh === 'string' && isDnsName(request.mesh)))
  );
}

/**
 * Check a cell request description (SPEC 5.5, 5.9) and return it as checked: its overrides, when
 * it has them, in their canonical form (the echo a scenario is compared with). Malformed: a TypeError.
 */
function checkRequest(request: unknown): Req {
  const ok =
    isObject(request) &&
    typeof request.cell_id === 'string' &&
    isHex(request.cell_id, 64) &&
    Object.keys(request).every((k) => ['cell_id', 'asof', 'job', 'fn_hash', 'mesh', 'overrides', 'solve'].includes(k)) &&
    checkCommon(request) &&
    (!has(request, 'job') || (typeof request.job === 'string' && JOB_RE.test(request.job))) &&
    (!has(request, 'solve') || (typeof request.solve === 'string' && HEX64.test(request.solve)));
  const badOverrides = 'overrides is an array of at most 64 overrides, each a value override {cell, value} or a slice override {slice, add, remove}, sorted by cell or slice id with none repeated, and non-empty unless solve is given (SPEC 5.9)';
  let overrides: JsonValue[] | undefined;
  if (ok && has(request, 'solve') && !has(request, 'overrides')) throw new TypeError('solve is a member of a whatif request, which has overrides (SPEC 5.9)');
  if (ok && has(request, 'overrides')) {
    if (!Array.isArray(request.overrides)) throw new TypeError(badOverrides);
    let parsed: JsonValue;
    try {
      parsed = toJson(JSON.stringify(request.overrides));
    } catch {
      throw new TypeError(badOverrides);
    }
    if (overrideProblem(parsed) !== null) throw new TypeError(badOverrides);
    const list = parsed as JsonObject[];
    if (list.length === 0 && !has(request, 'solve')) throw new TypeError(badOverrides);
    // Sorted by cell or slice id, strictly (so none is repeated).
    const ids = list.map((o) => sha256Hex(jcsBytes((has(o, 'slice') ? o.slice : o.cell) as JsonValue)));
    for (let i = 1; i < ids.length; i++) if (!(ids[i - 1] < ids[i])) throw new TypeError(badOverrides);
    overrides = list;
  }
  if (!ok) {
    throw new TypeError(
      'request must be {cell_id: <64 lowercase hex>, asof?: <instant>, job?: <32-64 lowercase hex>, fn_hash?: <64 lowercase hex>, mesh?: <DNS name>, overrides?: <canonical override array>, solve?: <64 lowercase hex>}: the cell id of the original request (resolved to the fn_hash used), its asof if it had one, the job polled when the body answers a job URL, the pin when it was pinned, the host asked, and the overrides and vary cell of a whatif request (SPEC 5.5, 5.9)',
    );
  }
  const r: Req = { ...(request as Req) };
  if (overrides !== undefined) {
    r.overrides = overrides;
    r.overridesText = jcsText(overrides as unknown as JsonValue);
  }
  return r;
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
    throw new TypeError('a slice request must be {slice_id: <64 lowercase hex>, asof?: <instant>, fn_hash?: <64 lowercase hex>, mesh?: <DNS name>, after?: {<open argument>: <typed scalar>}}: a malformed member is the caller\'s error (SPEC 5.5)');
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

/**
 * The request as checked (SPEC 5.5, 5.9): its members, and since spec-0.6.0 the overrides in
 * their canonical text, which the scenario's echo is compared with, and `solve`.
 */
type Req = { cell_id?: string; asof?: string; job?: string; fn_hash?: string; mesh?: string; overrides?: JsonValue[]; overridesText?: string; solve?: string };
const failed = (code: ErrorCode, detail: string, path: string | null, receiptHash: string | null = null): EnvelopeResult => ({ ok: false, kind: null, code, outcome: null, trust: null, receiptHash, scenario: null, detail, path, fault: null, pending: null, fnHash: null, foreignDetail: null, resolved: null, shadows: null, error: null, cycle: null });

/**
 * SPEC 5.5 step 6 for a verified receipt: `primary` exactly when its condition holds; with the
 * host asked known, `computed` exactly when that host signed a receipt that is not primary.
 * Returns a failure detail, or null.
 */
function trustProblem(trust: Trust, receipt: JsonObject, mesh: string | undefined): string | null {
  const cell = receipt.cell as JsonObject;
  const signer = hostOf(receipt.computed_by as string, '#');
  // Since spec-0.6.0 (5.5): both primary and relayed need no inputs and the signer the host of
  // cell.ns; primary has no source, relayed has one. Neither depends on the mesh asked.
  const own = signer === hostOf(cell.ns as string, '/') && (receipt.inputs as string[]).length === 0;
  const primary = own && !has(receipt, 'source');
  const relayed = own && has(receipt, 'source');
  if ((trust === 'primary') !== primary) return primary ? 'the receipt is primary (signed by its namespace host, no inputs, no source): trust must be primary' : 'trust primary needs a receipt signed by the host of cell.ns with no inputs and no source (one with a source is trust relayed)';
  if ((trust === 'relayed') !== relayed) return relayed ? 'the receipt is relayed (signed by its namespace host, no inputs, with a source): trust must be relayed' : 'trust relayed needs a receipt signed by the host of cell.ns with no inputs and a source';
  if (!primary && !relayed && mesh !== undefined && (trust === 'computed') !== (signer === mesh)) {
    return trust === 'computed' ? `trust computed needs a receipt signed by the mesh asked (${mesh}), not ${signer}` : `the mesh asked (${mesh}) signed this receipt: its trust is computed, not ${trust}`;
  }
  return null;
}

/**
 * SPEC 5.9 step 5 (since spec-0.6.0): a scenario is bound to the request. Its cell has the
 * requested cell id; its asof is the requested one when one was sent; its overrides are the
 * request's, byte for byte in canonical JSON; `solved` is present exactly when `solve` was sent,
 * and its vary has the requested id. Every failure is E_ENVELOPE.
 */
function scenarioResult(env: JsonObject, request: Req, echo: string | null): EnvelopeResult {
  const s = env.scenario as JsonObject;
  const fail = (detail: string, path: string) => failed('E_ENVELOPE', detail, path);
  if (sha256Hex(jcsBytes(s.cell as JsonValue)) !== request.cell_id) return fail(`the scenario is for another cell than the requested ${String(request.cell_id)}`, '$.scenario.cell');
  if (request.asof !== undefined && s.asof !== request.asof) return fail('the scenario is as of another asof than the one requested', '$.scenario.asof');
  if (jcsText(s.overrides as JsonValue) !== request.overridesText) return fail("the scenario's overrides are not the request's overrides, in canonical form", '$.scenario.overrides');
  if (request.solve !== undefined) {
    const solved = s.solved as JsonObject | undefined;
    if (solved === undefined) return fail('solve was requested: the scenario states the value found (solved)', '$.scenario');
    if (sha256Hex(jcsBytes(solved.vary as JsonValue)) !== request.solve) return fail("solved's vary is not the requested vary cell", '$.scenario.solved.vary');
  } else if (has(s, 'solved')) {
    return fail('solved is present only when the request had solve', '$.scenario.solved');
  }
  // The scenario's value as its lexical form: a boolean is true or false (3.x).
  const value = String(s.value);
  const scenario: Scenario = {
    cell: plain<ScenarioCell>(s.cell as JsonValue),
    type: s.type as string,
    value,
    asof: s.asof as string,
    overrides: plain<ScenarioOverride[]>(s.overrides as JsonValue),
    solved: has(s, 'solved') ? plain<{ vary: ScenarioCell; value: TypedValue }>(s.solved as JsonValue) : null,
  };
  return { ok: true, kind: 'scenario', code: 'OK', outcome: 'scenario', trust: null, receiptHash: null, scenario, detail: `a scenario of ${scenario.type} ${value}, as of ${scenario.asof}: not a fact, no receipt`, path: null, fault: null, pending: null, fnHash: echo, foreignDetail: null, ...exposed(env, 'scenario') };
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
    // Step 3 since spec-0.4.3: E_FOREIGN_UNAVAILABLE is answered with 502 exactly.
    if ((o as JsonObject).error === 'E_FOREIGN_UNAVAILABLE' && status !== 502) bad(`E_FOREIGN_UNAVAILABLE is answered with HTTP 502, not ${status}`, '$.error');
  } catch (e) {
    if (e instanceof Bad) return failed('E_ENVELOPE', e.detail, e.path);
    throw e;
  }
  const env = o as JsonObject;
  const echo = has(env, 'fn_hash') ? (env.fn_hash as string) : null;
  // The echo of a pin (since spec-0.4.2): required and equal, except rate_limited and bad_request
  // (equal when present) and pending (whose request echoes it).
  // Step 3a (spec-0.4.2): what the request decides without the receipt, in this order:
  // E_JOB_UNKNOWN only at a job URL; the pin echo; the pending echo, job and poll host.
  if (outcome === 'bad_request' && env.error === 'E_JOB_UNKNOWN' && request?.job === undefined) {
    return failed('E_ENVELOPE', 'E_JOB_UNKNOWN answers a job URL only, and this request was not one', '$.error');
  }
  // Since spec-0.6.0 (5.5, 5.9): at a whatif request (one with overrides) ok, stale and pending are not
  // answers; a scenario is an answer only to one; the whatif bad_request codes and E_WHATIF_NO_SOLUTION
  // are only at one (E_WHATIF_NO_SOLUTION only with solve).
  const whatif = request?.overrides !== undefined;
  if (whatif && (outcome === 'ok' || outcome === 'stale' || outcome === 'pending')) return failed('E_ENVELOPE', `${outcome} is not an answer to a whatif request`, '$.outcome');
  if (outcome === 'scenario' && !whatif) return failed('E_ENVELOPE', 'a scenario answers a whatif request (with overrides), and this request had none', '$.outcome');
  // Coordinator decision (round 2): E_WHATIF_UNSUPPORTED only with solve; E_SLICE_MEMBER only with overrides.
  if (outcome === 'bad_request' && env.error === 'E_WHATIF_UNSUPPORTED' && request?.solve === undefined) return failed('E_ENVELOPE', 'E_WHATIF_UNSUPPORTED is the code of a whatif request with solve only', '$.error');
  if (outcome === 'bad_request' && env.error === 'E_SLICE_MEMBER' && !whatif) return failed('E_ENVELOPE', 'E_SLICE_MEMBER is a code of a whatif request (with overrides) only', '$.error');
  if (env.fault === 'E_WHATIF_NO_SOLUTION' && request?.solve === undefined) return failed('E_ENVELOPE', 'E_WHATIF_NO_SOLUTION is the fault of a whatif request with solve', '$.fault');
  const pin = request?.fn_hash;
  if (pin !== undefined && outcome !== 'pending') {
    if (echo === null && outcome !== 'rate_limited' && outcome !== 'bad_request') return failed('E_ENVELOPE', 'an envelope answering a pinned request echoes its fn_hash', '$.fn_hash');
    if (echo !== null && echo !== pin) return failed('E_ENVELOPE', 'fn_hash echoes another function than the one pinned', '$.fn_hash');
  }
  if (outcome === 'scenario') return scenarioResult(env, request as Req, echo);
  if (!has(env, 'receipt')) {
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
      // Since spec-0.5.0 (5.5, 9.6): a loopback poll passes only for the unrooted mesh asked; any other
      // poll is on the host asked.
      if (isHttpUrl(env.poll as string)) {
        if (!(request.mesh !== undefined && isUnrooted(request.mesh))) return failed('E_ENVELOPE', 'a loopback poll is answered to the unrooted mesh asked only', '$.poll');
      } else if (request.mesh !== undefined && urlHost(env.poll as string) !== request.mesh) return failed('E_ENVELOPE', `poll names another host than the mesh asked (${request.mesh})`, '$.poll');
      pending = { job: env.job as string, poll: env.poll as string, estimateSeconds: env.estimate_seconds as number };
    }
    const fault = has(env, 'fault') ? (env.fault as Fault) : null;
    const detail = fault ? `outcome ${outcome}, fault ${fault}` : pending ? `outcome pending, job ${pending.job}, estimate ${pending.estimateSeconds} s` : has(env, 'error') ? `outcome ${outcome}, ${String(env.error)}` : `outcome ${outcome}`;
    const foreignDetail = has(env, 'detail') ? (env.detail as ForeignDetail) : null;
    return { ok: true, kind: null, code: 'OK', outcome, trust: null, receiptHash: null, scenario: null, detail: foreignDetail ? `${detail} (${foreignDetail})` : detail, path: null, fault, pending, fnHash: echo, foreignDetail, ...exposed(env, outcome) };
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
  // Step 6: trust; then the echo against the receipt's cell.fn_hash; then superseded_by.
  const trust = env.trust as Trust;
  const problem = trustProblem(trust, r.receipt, request?.mesh);
  if (problem !== null) return failed('E_ENVELOPE', problem, '$.trust', r.hash);
  if (echo !== null && echo !== cell.fn_hash) return failed('E_ENVELOPE', "fn_hash echoes another function than the receipt's", '$.fn_hash', r.hash);
  if (env.superseded_by === r.hash) return failed('E_ENVELOPE', 'superseded_by is the receipt itself', '$.superseded_by', r.hash);
  return { ok: true, kind: 'receipt', code: 'OK', outcome: outcome as 'ok' | 'stale', trust, receiptHash: r.hash, scenario: null, detail: `outcome ${outcome}, trust ${trust}, receipt signed by ${r.receipt.computed_by as string}`, path: null, fault: null, pending: null, fnHash: echo, foreignDetail: null, ...exposed(env, outcome) };
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
  const req = checkRequest(request);
  const sources = collectSources(keys);
  const numbers = new Map<string, string>();
  let o: JsonValue;
  try {
    o = toJson(body, numbers); // step 1
  } catch (e) {
    if (e instanceof DatumeshError) return failed(e.code, e.detail, e.path);
    throw e;
  }
  return checkParsed(status, o, numbers, sources, req);
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
export type SlicePageResult = EnvelopeResult & {
  page: SlicePage | null;
};

const asPage = (r: EnvelopeResult, page: SlicePage | null = null): SlicePageResult => ({ ...r, page });

/**
 * Compare two keys on the slice's open arguments, each in its type's order (15.13). Null when a
 * position's types differ: such keys cannot be ordered (SPEC 5.6, since a468606: E_ENVELOPE).
 */
function compareKeys(names: string[], a: JsonObject, b: JsonObject): number | null {
  for (const n of names) {
    const x = a[n] as JsonObject;
    const y = b[n] as JsonObject;
    if (x.type !== y.type) return null;
    const t = x.type as string;
    const c = t === 'boolean' ? Number(x.value === true) - Number(y.value === true) : compareValues(t, String(x.value), String(y.value));
    if (c !== 0) return c;
  }
  return 0;
}

const NEXT_RE = /^https:\/\/[^/]+\/[!-~]*$/;
const HTTP_NEXT_RE = /^http:\/\/[^/]+\/[!-~]*$/;

/** Since spec-0.5.0: an http:// URL (a loopback one, 9.6). */
const isHttpUrl = (u: string): boolean => u.startsWith('http://');

/**
 * Since spec-0.5.0 (5.5, 5.6, 9.6): the problem with a URL the mesh gave (`poll` or `next`) for the
 * request's mesh, or null. A loopback URL is for the unrooted mesh asked; any other is on the host
 * asked when one is named.
 */
function urlProblem(u: string, mesh: string | undefined): string | null {
  if (isHttpUrl(u)) {
    return mesh !== undefined && isUnrooted(mesh) ? null : 'a loopback URL is for the unrooted mesh asked only';
  }
  return mesh !== undefined && urlHost(u) !== mesh ? `names another host than the mesh asked (${mesh})` : null;
}

function checkPage(status: number, o: JsonObject, numbers: Map<string, string>, sources: Sources, request: SliceRequest): SlicePageResult {
  const fail = (detail: string, path: string) => asPage(failed('E_ENVELOPE', detail, path));
  // 1. The page's members and their rules.
  const allowed = ['fn_hash', 'members', 'next', 'outcome', 'slice'];
  for (const k of ['members', 'slice']) if (!has(o, k)) return fail(`a page has ${k}`, '$');
  for (const k of sortedKeys(o)) if (!allowed.includes(k)) return fail(`member ${JSON.stringify(k)} is not allowed in a page`, memberPath('$', k));
  if (!Array.isArray(o.members)) return fail('members is an array of envelopes', '$.members');
  if (has(o, 'next')) {
    const n = o.next;
    if (typeof n !== 'string' || n.length > LIMITS.licence_url) return fail('next is an https URL of at most 512 printable ASCII characters', '$.next');
    if (isHttpUrl(n)) {
      // Since spec-0.5.0 (9.6): http:// only on a loopback address.
      if (!HTTP_NEXT_RE.test(n) || loopbackOrigin(n) === null) return fail('next is https://, or http:// on a loopback address (9.6)', '$.next');
    } else {
      if (!URL_RE.test(n)) return fail('next is an https URL of at most 512 printable ASCII characters', '$.next');
      if (!isDnsName(urlHost(n)) || !NEXT_RE.test(n)) return fail("next names a DNS name as its host, then a path", '$.next');
    }
  }
  if (has(o, 'fn_hash') && (typeof o.fn_hash !== 'string' || !HEX64.test(o.fn_hash))) return fail('fn_hash is a function hash: 64 lowercase hex digits', '$.fn_hash');
  if (!isObject(o.slice)) return fail('slice is a slice object', '$.slice');
  if (status !== 200) return fail(`status ${status} does not match outcome ok`, '$.outcome');
  // 2. The slice requested, the pin's echo, next on the host asked.
  const slice = o.slice as JsonObject;
  const echo = has(o, 'fn_hash') ? (o.fn_hash as string) : null;
  if (request.fn_hash !== undefined && echo === null) return fail('an envelope answering a pinned request echoes its fn_hash', '$.fn_hash');
  if (request.fn_hash !== undefined && echo !== request.fn_hash) return fail('fn_hash echoes another function than the one pinned', '$.fn_hash');
  if (sha256Hex(jcsBytes(slice)) !== request.slice_id) return fail('the page is of another slice than the one requested', '$.slice');
  if (echo !== null && echo !== slice.fn_hash) return fail("the page's fn_hash MUST equal its slice's", '$.fn_hash');
  try {
    validate(slice, 'slice', '$.slice');
  } catch (e) {
    if (e instanceof DatumeshError) return fail(`the slice is not a slice object: ${e.code}: ${e.detail}`, '$.slice');
    throw e;
  }
  if (isVersionSlice(slice)) return fail('the slice endpoint serves membership slices', '$.slice');
  if (has(o, 'next')) {
    const problem = urlProblem(o.next as string, request.mesh);
    if (problem !== null) return fail(`next ${problem}`, '$.next');
  }
  const sargs = slice.args as JsonObject;
  const open = sortedKeys(sargs).filter((k) => sargs[k] === '*' || (isObject(sargs[k]) && !has(sargs[k] as JsonObject, 'value')));
  // The cursor is compared on the open arguments only; its other names are ignored (a468606).
  const missing = request.after === undefined ? undefined : open.find((n) => !Object.prototype.hasOwnProperty.call(request.after, n));
  if (missing !== undefined) return fail(`the cursor lacks the open argument ${JSON.stringify(missing)}`, 'request.after');
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
    if (!memberOf(slice, false, r.receipt)) return fail('the receipt is not of a cell of the slice', `${at}.receipt.cell`);
    if (request.asof !== undefined && !((r.receipt.asof as string) <= request.asof)) return fail("the receipt's asof is after the one requested", `${at}.receipt.asof`);
    // trust as in 5.5 step 6: trust, then the member's fn_hash against its receipt, then superseded_by.
    const problem = trustProblem(m.trust as Trust, r.receipt, request.mesh);
    if (problem !== null) return fail(problem, `${at}.trust`);
    if (mecho !== null && mecho !== cell.fn_hash) return fail("fn_hash echoes another function than the receipt's", `${at}.fn_hash`);
    if (m.superseded_by === r.hash) return fail('superseded_by is the receipt itself', `${at}.superseded_by`);
    const key = cell.args as JsonObject;
    if (prev !== null) {
      const c = compareKeys(open, key, prev);
      if (c === null) return fail(i === 0 || prev === request.after ? 'the cursor has another key type than the members' : "the members' keys differ in type", at);
      if (c <= 0) return fail('members are in strictly ascending key order, after the cursor', at);
    }
    prev = key;
    out.push({ outcome: m.outcome as 'ok' | 'stale', trust: m.trust as Trust, receiptHash: r.hash, fnHash: mecho, cell });
  }
  const page: SlicePage = { slice, members: out, next: has(o, 'next') ? (o.next as string) : null };
  return { ok: true, kind: null, code: 'OK', outcome: 'ok', trust: null, receiptHash: null, scenario: null, cycle: null, detail: `a page of ${out.length} members${page.next ? ', and a next page' : ''}`, path: null, fault: null, pending: null, fnHash: echo, foreignDetail: null, resolved: null, shadows: null, error: null, page };
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
  const checked = requests.map((r) => (isObject(r) && has(r, 'slice_id') ? (checkSliceRequest(r), r) : checkRequest(r)));
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
    const req = checked[i] as unknown as JsonObject;
    const sub = subNumbers(numbers, at);
    const r = has(req, 'slice_id') ? slicePage(it.status as number, it.envelope, sub, sources, req as unknown as SliceRequest) : checkParsed(it.status as number, it.envelope, sub, sources, req as Req);
    return r.ok ? r : { ...r, path: atPath(at, r.path) };
  });
  const bad = items.filter((r) => !r.ok).length;
  return { ok: true, code: 'OK', outcome: null, detail: `${items.length} items, ${bad} failing`, path: null, items, refusal: null };
}
