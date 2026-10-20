// Key documents (SPEC.md 9.2), their retrieval (9.3) and the key sources `verify` accepts.
import { DatumeshError, type ErrorCode } from './errors.js';
import { fromHex, keyIdOf } from './hash.js';
import { has, isObject, memberPath, sortedKeys, toJson, type JsonValue } from './json.js';
import { LIMITS, checkDnsName, isHex, isInstant } from './lexical.js';

function isDnsName(s: string): boolean {
  try {
    checkDnsName(s, '$');
    return true;
  } catch {
    return false;
  }
}

/** One validated key from a key document. */
export interface KeyEntry {
  alg: 'ed25519';
  id: string;
  public: string;
  valid_from: string;
  valid_to?: string;
}

/** The outcome of resolving one host's keys (SPEC 9.3). */
export interface KeysResult {
  ok: boolean;
  /** "OK", "E_KEY_UNAVAILABLE" or "E_KEY_DOC". */
  code: 'OK' | 'E_KEY_UNAVAILABLE' | 'E_KEY_DOC';
  host: string;
  detail: string;
  /** The validated keys, in document order, when ok. */
  keys?: KeyEntry[];
}

/** A mapping of key id to 64-hex public key: usable for any host, with no validity windows. */
export type KeyMap = Record<string, string>;

/** Anything `verify` accepts as keys. */
export type KeySource = KeysResult | KeyMap | Record<string, unknown> | KeySource[];

class KeyDocError extends Error {
  constructor(
    msg: string,
    readonly path: string,
  ) {
    super(msg);
  }
}

function bad(msg: string, path: string): never {
  throw new KeyDocError(msg, path);
}

/** Validate a parsed key document for `host` (SPEC 9.2). Throws KeyDocError. */
function validateKeyDocument(doc: JsonValue, host: string): KeyEntry[] {
  if (!isObject(doc)) bad('expected an object', '$');
  for (const k of sortedKeys(doc)) if (!['host', 'keys', 'proto'].includes(k)) bad(`unexpected member ${JSON.stringify(k)}`, '$');
  for (const k of ['host', 'keys', 'proto']) if (!has(doc, k)) bad(`missing member ${JSON.stringify(k)}`, '$');
  if (doc.proto !== 'datumesh/1') bad("proto must be 'datumesh/1'", '$.proto');
  // 9.2 / 9.3: `host` is a DNS name (2.1); a document for any other host cannot satisfy 9.2.
  if (typeof doc.host !== 'string' || !isDnsName(doc.host)) bad('host must be a DNS name (SPEC 2.1); keys are resolved only for DNS names', '$.host');
  if (doc.host !== host) bad(`host must be ${JSON.stringify(host)}`, '$.host');
  const keys = doc.keys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > LIMITS.keys) bad(`keys must be an array of 1 to ${LIMITS.keys} keys`, '$.keys');
  const out: KeyEntry[] = [];
  const seenIds = new Set<string>();
  const seenPublic = new Set<string>();
  keys.forEach((k, i) => {
    const p = `$.keys[${i}]`;
    if (!isObject(k)) bad('expected an object', p);
    for (const m of sortedKeys(k)) if (!['alg', 'id', 'public', 'valid_from', 'valid_to'].includes(m)) bad(`unexpected member ${JSON.stringify(m)}`, p);
    for (const m of ['alg', 'id', 'public', 'valid_from']) if (!has(k, m)) bad(`missing member ${JSON.stringify(m)}`, p);
    if (k.alg !== 'ed25519') bad('alg must be ed25519', memberPath(p, 'alg'));
    if (typeof k.id !== 'string' || !isHex(k.id, 16)) bad('id must be 16 lowercase hex digits', memberPath(p, 'id'));
    if (typeof k.public !== 'string' || !isHex(k.public, 64)) bad('public must be 64 lowercase hex digits', memberPath(p, 'public'));
    if (typeof k.valid_from !== 'string' || !isInstant(k.valid_from)) bad('valid_from must be an instant', memberPath(p, 'valid_from'));
    if (has(k, 'valid_to')) {
      if (typeof k.valid_to !== 'string' || !isInstant(k.valid_to)) bad('valid_to must be an instant', memberPath(p, 'valid_to'));
      if (!(k.valid_to > k.valid_from)) bad('valid_to must be later than valid_from', p);
    }
    if (keyIdOf(fromHex(k.public)) !== k.id) bad('id is not the key id of public', memberPath(p, 'id'));
    if (seenIds.has(k.id) || seenPublic.has(k.public)) bad('key appears twice', p);
    seenIds.add(k.id);
    seenPublic.add(k.public);
    const e: KeyEntry = { alg: 'ed25519', id: k.id, public: k.public, valid_from: k.valid_from };
    if (has(k, 'valid_to')) e.valid_to = k.valid_to as string;
    out.push(e);
  });
  return out;
}

function docResult(host: string, parse: () => JsonValue): KeysResult {
  let doc: JsonValue;
  try {
    doc = parse();
  } catch (e) {
    const d = e instanceof DatumeshError ? `${e.code}: ${e.detail}` : String(e);
    return { ok: false, code: 'E_KEY_DOC', host, detail: `key document is not strict JSON (${d})` };
  }
  try {
    const keys = validateKeyDocument(doc, host);
    return { ok: true, code: 'OK', host, detail: `${keys.length} key(s) for ${host}`, keys };
  } catch (e) {
    if (e instanceof KeyDocError) return { ok: false, code: 'E_KEY_DOC', host, detail: `${e.message} at ${e.path}` };
    throw e;
  }
}

/**
 * Interpret the HTTPS response for https://<host>/.well-known/datumesh.json (SPEC 9.3).
 * `status` is the HTTP status, or null for a network, DNS, TLS or timeout failure. `body` is the
 * response body as text or bytes. Never throws.
 */
export function keysFromResponse(host: string, status: number | null, body?: string | Uint8Array | null): KeysResult {
  const h = typeof host === 'string' ? host : String(host);
  try {
    if (status === null || status === undefined) {
      return { ok: false, code: 'E_KEY_UNAVAILABLE', host: h, detail: 'network, DNS, TLS or timeout failure' };
    }
    if (status !== 200) {
      return { ok: false, code: 'E_KEY_UNAVAILABLE', host: h, detail: `HTTP status ${String(status)} (only 200 is accepted; redirects are not followed)` };
    }
    if (typeof body !== 'string' && !(body instanceof Uint8Array)) {
      return { ok: false, code: 'E_KEY_DOC', host: h, detail: '200 response without a body' };
    }
    return docResult(h, () => toJson(body));
  } catch (e) {
    return { ok: false, code: 'E_KEY_UNAVAILABLE', host: h, detail: `could not interpret the response: ${String(e)}` };
  }
}

/**
 * Validate an already-parsed key document (its `host` member names the host it covers).
 * Never throws.
 */
export function keysFromDocument(doc: unknown): KeysResult {
  const host = isObject(doc) && typeof (doc as Record<string, unknown>).host === 'string' ? ((doc as Record<string, unknown>).host as string) : '';
  try {
    return docResult(host, () => toJson(doc));
  } catch (e) {
    return { ok: false, code: 'E_KEY_DOC', host, detail: String(e) };
  }
}

/** Default timeout of fetchKeys, in milliseconds. */
export const FETCH_TIMEOUT_MS = 10_000;

/** fetchKeys abandons a key document larger than this (SPEC 9.3: SHOULD bound retrieval). */
export const FETCH_MAX_BYTES = 256 * 1024;

class TooLarge extends Error {}

/** Read a response body, abandoning it once it exceeds FETCH_MAX_BYTES. */
async function readBounded(res: Response): Promise<Uint8Array> {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const b = new Uint8Array(await res.arrayBuffer());
    if (b.length > FETCH_MAX_BYTES) throw new TooLarge();
    return b;
  }
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > FETCH_MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // abandoned anyway
      }
      throw new TooLarge();
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Fetch https://<host>/.well-known/datumesh.json once, with TLS verified by the platform, no
 * redirects followed and a timeout, then interpret it with keysFromResponse. The only function
 * in this library that touches the network. Never throws.
 */
export async function fetchKeys(host: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<KeysResult> {
  try {
    checkDnsName(host, '$');
  } catch {
    return { ok: false, code: 'E_KEY_UNAVAILABLE', host: String(host), detail: 'host is not a lowercase DNS name (SPEC 2.1); nothing was fetched' };
  }
  const f = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof f !== 'function') return { ok: false, code: 'E_KEY_UNAVAILABLE', host, detail: 'no global fetch in this runtime' };
  let status: number;
  let body: Uint8Array;
  try {
    const res = await f(`https://${host}/.well-known/datumesh.json`, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    // A redirect under redirect:"manual" is a 3xx (Node) or an opaque-redirect response with
    // status 0 (browsers); either way it is not 200.
    if (res.type === 'opaqueredirect') status = 0;
    if (status !== 200) return keysFromResponse(host, status);
    body = await readBounded(res as Response);
  } catch (e) {
    if (e instanceof TooLarge) return { ok: false, code: 'E_KEY_UNAVAILABLE', host, detail: `key document larger than 256 KiB; retrieval abandoned` };
    return { ok: false, code: 'E_KEY_UNAVAILABLE', host, detail: `retrieval failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return keysFromResponse(host, status, body);
}

// ---------------------------------------------------------------- key sources for verify

interface HostSource {
  host: string;
  result: KeysResult;
}
interface AnySource {
  ok: boolean;
  code: ErrorCode | 'OK';
  detail: string;
  keys: KeyEntry[];
}
export interface Sources {
  hosts: HostSource[];
  any: AnySource[];
}

function isKeysResult(v: Record<string, unknown>): boolean {
  return typeof v.ok === 'boolean' && typeof v.code === 'string' && typeof v.host === 'string';
}

function fromMap(m: Record<string, unknown>): AnySource {
  const keys: KeyEntry[] = [];
  for (const id of Object.keys(m)) {
    const pub = m[id];
    if (!isHex(id, 16) || typeof pub !== 'string' || !isHex(pub, 64) || keyIdOf(fromHex(pub)) !== id) {
      return { ok: false, code: 'E_KEY_DOC', detail: `key map entry ${JSON.stringify(id)} is not <key id>: <64-hex public key> with a matching id`, keys: [] };
    }
    keys.push({ alg: 'ed25519', id, public: pub, valid_from: '0001-01-01T00:00:00.000000Z' });
  }
  return { ok: true, code: 'OK', detail: 'key map (any host, no validity windows)', keys };
}

/**
 * Normalise the `keys` argument of verify. Throws TypeError only for arguments that are not key
 * sources at all (programmer errors); malformed key material becomes an error source.
 */
export function collectSources(keys: unknown, into: Sources = { hosts: [], any: [] }, depth = 0): Sources {
  if (Array.isArray(keys)) {
    if (depth > 8) throw new TypeError('keys: arrays nested too deeply');
    for (const k of keys) collectSources(k, into, depth + 1);
    return into;
  }
  if (typeof keys !== 'object' || keys === null) {
    throw new TypeError('keys must be a key document, a KeysResult, a {keyId: publicKeyHex} map, or an array of these');
  }
  const o = keys as Record<string, unknown>;
  if (isKeysResult(o)) {
    const r = o as unknown as KeysResult;
    if (r.ok) {
      // Re-check what a caller may have built by hand.
      const ok = Array.isArray(r.keys) && r.keys.every((k) => k && isHex(k.id, 16) && isHex(k.public, 64) && isInstant(k.valid_from) && (k.valid_to === undefined || isInstant(k.valid_to)));
      into.hosts.push({ host: r.host, result: ok ? r : { ok: false, code: 'E_KEY_DOC', host: r.host, detail: 'KeysResult has malformed keys' } });
    } else {
      const code = r.code === 'E_KEY_DOC' ? 'E_KEY_DOC' : 'E_KEY_UNAVAILABLE';
      into.hosts.push({ host: r.host, result: { ok: false, code, host: r.host, detail: String(r.detail ?? '') } });
    }
    return into;
  }
  if ('keys' in o || 'host' in o || 'proto' in o) {
    const r = keysFromDocument(o);
    if (r.host) into.hosts.push({ host: r.host, result: r });
    else into.any.push({ ok: false, code: 'E_KEY_DOC', detail: `key document without a host: ${r.detail}`, keys: [] });
    return into;
  }
  into.any.push(fromMap(o));
  return into;
}

export type KeyLookup =
  | { ok: true; key: KeyEntry; windows: boolean }
  | { ok: false; code: ErrorCode; detail: string };

/** SPEC 10.1 step 5 for key reference host#id at time `issued`. */
export function lookupKey(sources: Sources, host: string, id: string, issued: string): KeyLookup {
  const h = sources.hosts.find((s) => s.host === host);
  let keys: KeyEntry[];
  let windows: boolean;
  if (h) {
    if (!h.result.ok) return { ok: false, code: h.result.code as ErrorCode, detail: `${host}: ${h.result.detail}` };
    keys = h.result.keys ?? [];
    windows = true;
  } else if (sources.any.length) {
    const a = sources.any[0];
    if (!a.ok) return { ok: false, code: a.code as ErrorCode, detail: a.detail };
    keys = a.keys;
    windows = false;
  } else {
    return { ok: false, code: 'E_KEY_UNAVAILABLE', detail: `no key source covers ${host}` };
  }
  const key = keys.find((k) => k.id === id);
  if (!key) return { ok: false, code: 'E_KEY_UNKNOWN', detail: `${host} publishes no key ${id}` };
  if (windows && !(key.valid_from <= issued && (key.valid_to === undefined || issued < key.valid_to))) {
    return { ok: false, code: 'E_KEY_NOT_VALID', detail: `issued ${issued} is outside the window of key ${id}` };
  }
  return { ok: true, key, windows };
}

