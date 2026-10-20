// Response envelopes (SPEC.md 5.5): the unsigned JSON body a mesh returns around a receipt.
// Synchronous, offline; the embedded receipt is verified through step 6 with the given keys.
import { DatumeshError, ERROR_CODES, type ErrorCode } from './errors.js';
import { has, isObject, memberPath, sortedKeys, toJson, type JsonObject, type JsonValue } from './json.js';
import { LIMITS, URL_RE, checkNumber, checkString, isHex } from './lexical.js';
import { collectSources } from './keys.js';
import { isCurrency } from './units.js';
import { Stop, verifyEmbedded } from './verify.js';

export type Outcome = 'ok' | 'stale' | 'not_covered' | 'unlicensed' | 'payment_required' | 'rate_limited' | 'error';
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
};
const STATUS: Record<Outcome, (s: number) => boolean> = {
  ok: (s) => s === 200,
  stale: (s) => s === 200,
  not_covered: (s) => s === 404,
  unlicensed: (s) => s === 403,
  payment_required: (s) => s === 402,
  rate_limited: (s) => s === 429,
  error: (s) => s >= 500 && s <= 599,
};
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

function seconds(v: JsonValue, name: string, path: string): void {
  // JSON numbers with integral values (SPEC 5.5); 1.0 and 1e2 are integral values too.
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_SECONDS) bad(`${name} is an integer from 0 to 2^53 - 1`, path);
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
function members(o: JsonValue): Outcome {
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
        seconds(v, k, p);
        break;
      case 'error':
        if (typeof v !== 'string' || !(ERROR_CODES as readonly string[]).includes(v)) bad('error is a code from SPEC.md 10.2', p);
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

const hostOf = (s: string, sep: string) => {
  const i = s.indexOf(sep);
  return i < 0 ? s : s.slice(0, i);
};

/**
 * Check a mesh response (SPEC 5.5): `status` is the HTTP status, `body` the response body as
 * JSON text or bytes (a parsed object is accepted too, without duplicate-member detection), and
 * `keys` any key source `verify` accepts, used to verify an embedded receipt through step 6.
 * Steps: strict parse; members (E_ENVELOPE); status against outcome (E_ENVELOPE); the receipt
 * (its own codes), then `trust` against it and `superseded_by` against its hash (E_ENVELOPE).
 *
 * Never throws for an invalid body or bad key material; throws TypeError only when `status` is
 * not an integer or `keys` is not a key source at all.
 */
export function checkEnvelope(status: number, body: unknown, keys: unknown): EnvelopeResult {
  if (typeof status !== 'number' || !Number.isInteger(status)) throw new TypeError('status must be the HTTP status as an integer');
  const sources = collectSources(keys);
  const fail = (code: ErrorCode, detail: string, path: string | null, receiptHash: string | null = null): EnvelopeResult => ({ ok: false, code, outcome: null, trust: null, receiptHash, detail, path });
  let o: JsonValue;
  try {
    o = toJson(body); // step 1
  } catch (e) {
    if (e instanceof DatumeshError) return fail(e.code, e.detail, e.path);
    throw e;
  }
  let outcome: Outcome;
  try {
    outcome = members(o); // step 2
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
  const trust = env.trust as Trust;
  const cell = r.receipt.cell as JsonObject;
  const primary = hostOf(r.receipt.computed_by as string, '#') === hostOf(cell.ns as string, '/') && (r.receipt.inputs as string[]).length === 0;
  if ((trust === 'primary') !== primary) {
    return fail('E_ENVELOPE', primary ? 'the receipt is primary (signed by its namespace host, no inputs): trust must be primary' : 'trust primary needs a receipt signed by the host of cell.ns with no inputs', '$.trust', r.hash);
  }
  if (env.superseded_by === r.hash) return fail('E_ENVELOPE', 'superseded_by is the receipt itself', '$.superseded_by', r.hash);
  return { ok: true, code: 'OK', outcome, trust, receiptHash: r.hash, detail: `outcome ${outcome}, trust ${trust}, receipt signed by ${r.receipt.computed_by as string}`, path: null };
}
