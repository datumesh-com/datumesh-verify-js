// Shared logic of the conformance runner: turn one SPEC.md section 11 vector into
// {"id", "error": <code or null>, ...outputs}. `lib` is the library module (ESM or CJS build);
// `sha256Hex(bytes)` is an independent SHA-256 (Node's crypto, or WebCrypto in a browser), so
// output hashes are not computed by the library under test. No Node imports: this file also
// runs in the browser test.

export const MESH = 'mesh.example';

/** Output fields of a valid vector, per kind (SPEC.md section 11). */
export const OUTPUTS = {
  jcs: ['canonical', 'sha256'],
  scalar: ['canonical', 'sha256'],
  cell: ['canonical', 'sha256'],
  ref: ['canonical', 'sha256'],
  function: ['canonical', 'sha256'],
  uri: ['object', 'canonical', 'sha256', 'https'],
  keyid: ['key_id'],
  keys: ['key_ids'],
  receipt: ['canonical', 'sha256', 'sig', 'level', 'blob_checked', 'code'], // blob_checked only with blob_hex; code only with success at level signed and E_EVAL_UNAVAILABLE
  unit: ['unit'],
  envelope: ['outcome', 'trust', 'receipt_hash'], // trust and receipt_hash only with a receipt
};

const canonicalJson = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));

export function compare(v, got) {
  const problems = [];
  if (got.id !== v.id) problems.push(`id ${got.id}`);
  if (!v.valid) {
    if (got.error !== v.error) problems.push(`expected ${v.error}, got ${got.error}`);
    const extra = Object.keys(got).filter((k) => k !== 'id' && k !== 'error');
    if (extra.length) problems.push(`unexpected outputs ${extra}`);
    return problems;
  }
  if (got.error !== null) return [`expected success, got ${got.error}`];
  // Section 11: a receipt vector with blob_hex outputs blob_checked. The vector files carry it
  // since spec 1400247 (at 2a77580 they did not, DEFECTS.md 33); a file without it must not get
  // one unless it has blob_hex.
  if (v.kind === 'receipt' && v.blob_checked === undefined) {
    const want = v.blob_hex !== undefined ? true : undefined;
    if (got.blob_checked !== want) problems.push(`blob_checked: expected ${want}, got ${got.blob_checked}`);
  }
  for (const k of OUTPUTS[v.kind]) if (!(v.kind === 'receipt' && k === 'blob_checked' && v.blob_checked === undefined)) if (canonicalJson(got[k]) !== canonicalJson(v[k])) problems.push(`${k}: expected ${JSON.stringify(v[k]).slice(0, 200)}, got ${JSON.stringify(got[k]).slice(0, 200)}`);
  const extra = Object.keys(got).filter((k) => k !== 'id' && k !== 'error' && !OUTPUTS[v.kind].includes(k));
  if (extra.length) problems.push(`unexpected outputs ${extra}`);
  return problems;
}

const text = (bytes) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

export function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function inputOf(v) {
  return v.input_hex !== undefined ? hexToBytes(v.input_hex) : v.input;
}

/**
 * env {"https": {"status": 200|<int>|"error", "body"?: text}} -> KeysResult. "error" (a network
 * failure) is null; any other status is passed as given, so a string "200" or a missing status
 * reaches the library as such (SPEC 9.3, 11: only the integer 200 is a retrieved document).
 */
export function keysFromEnv(lib, host, env) {
  const h = (env && env.https) || { status: 'error' };
  return lib.keysFromResponse(host, h.status === 'error' ? null : h.status, h.body);
}

/**
 * A vector's `recompute` for the library. Section 11: `descriptor` is a JSON value, never text,
 * and only an absent member means unavailable. The library takes a JS string as JSON text to
 * parse, so the value is handed over as its JSON text: a string value stays a string value, and
 * null stays null (both fail the hash check, 10.1 step 7.1).
 */
export function recomputeOf(v) {
  if (v.recompute === undefined || v.recompute === null) return null;
  const rc = { ...v.recompute };
  if (Object.prototype.hasOwnProperty.call(rc, 'descriptor')) rc.descriptor = JSON.stringify(rc.descriptor);
  return rc;
}

/** Keys for a receipt vector: one KeysResult per host in `keys` (absent hosts: no source). */
export function receiptKeys(lib, v) {
  return Object.entries(v.keys || {}).map(([host, env]) => keysFromEnv(lib, host, env));
}

export function makeRunner(lib, sha256) {
  return async function run(v) {
    const out = { id: v.id, error: null };
    try {
      switch (v.kind) {
        case 'jcs':
        case 'scalar':
        case 'cell':
        case 'ref':
        case 'function': {
          const c = lib.canonicalize(inputOf(v), v.kind);
          out.canonical = text(c);
          out.sha256 = await sha256(c);
          break;
        }
        case 'uri': {
          const ref = lib.parseUri(v.input, v.signature);
          const c = lib.canonicalize(ref, 'ref');
          out.object = ref;
          out.canonical = text(c);
          out.sha256 = await sha256(c);
          out.https = lib.httpsUrl(v.input, MESH);
          break;
        }
        case 'keyid':
          out.key_id = lib.keyId(v.input);
          break;
        case 'keys': {
          const r = keysFromEnv(lib, v.host, v.env);
          if (!r.ok) return { id: v.id, error: r.code };
          out.key_ids = r.keys.map((k) => k.id);
          break;
        }
        case 'receipt': {
          const blob = v.blob_hex !== undefined ? hexToBytes(v.blob_hex) : null;
          const res = lib.verify(inputOf(v), receiptKeys(lib, v), recomputeOf(v), blob);
          if (!res.ok) return { id: v.id, error: res.code };
          out.canonical = text(lib.receiptPayload(inputOf(v)));
          out.sha256 = res.hash;
          out.sig = JSON.parse(text(lib.canonicalize(inputOf(v), 'receipt'))).sig;
          out.level = res.level;
          if (blob !== null) out.blob_checked = res.blobChecked;
          // The one code reported with success (10.1 step 7.6); absent otherwise.
          if (res.code !== 'OK') out.code = res.code;
          break;
        }
        case 'unit': {
          // The input is JSON text of {"cell", "descriptor"}. Parse it strictly (SPEC 6.1) with
          // the library, check the wrapper, and hand both members to resolvedUnit.
          const w = JSON.parse(text(lib.canonicalize(inputOf(v), 'jcs')));
          if (w === null || typeof w !== 'object' || Array.isArray(w)) return { id: v.id, error: 'E_SCHEMA' };
          const names = Object.keys(w).sort();
          if (names.join() !== 'cell,descriptor') return { id: v.id, error: 'E_SCHEMA' };
          out.unit = lib.resolvedUnit(w.descriptor, w.cell);
          break;
        }
        case 'envelope': {
          const res = lib.checkEnvelope(v.status, inputOf(v), receiptKeys(lib, v), v.request);
          if (!res.ok) return { id: v.id, error: res.code };
          out.outcome = res.outcome;
          if (res.receiptHash !== null) {
            out.trust = res.trust;
            out.receipt_hash = res.receiptHash;
          }
          break;
        }
        default:
          throw new Error(`unknown kind ${v.kind}`);
      }
    } catch (e) {
      if (e instanceof lib.DatumeshError) return { id: v.id, error: e.code };
      // Anything else is a bug (or a programmer error the vector provokes). Report it as this
      // vector's result, so one vector cannot stop the runner and hide the vectors after it.
      return { id: v.id, error: `THREW ${e && e.name}: ${e && e.message}` };
    }
    return out;
  };
}
