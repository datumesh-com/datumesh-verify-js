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
  keys: ['key_ids', 'declarations'], // declarations (since spec-0.4.3) only when the document has them
  receipt: ['canonical', 'sha256', 'sig', 'level', 'blob_checked', 'code'], // blob_checked only with blob_hex; code only with success at level signed (E_EVAL_UNAVAILABLE or E_INPUT_SUPERSEDED)
  unit: ['unit'],
  envelope: ['outcome', 'trust', 'receipt_hash', 'results'], // trust and receipt_hash only with a receipt; results for a slice page (5.6)
  batch: ['results', 'outcome'], // results for a 200 batch, outcome for a refusal (5.7)
  slice: ['canonical', 'sha256', 'slice_id', 'members_hash', 'entry'], // members_hash and entry only for a manifest
  mesh: ['bindings', 'endpoints'],
  licence: ['licence', 'reason'], // since spec-0.4.3: licence inheritance (8.5)
  entitlement: ['entitled', 'reason'], // since spec-0.4.3: the entitlement check (10.3)
};

/** The endpoints SPEC 9.6 defines; a resolved mesh keeps only these. */
export const MESH_ENDPOINTS = ['blob', 'cell', 'cells', 'descriptor', 'explain', 'find', 'jobs', 'manifest', 'receipt', 'slice', 'verify'];

/**
 * The expected outputs of a valid vector: the file's own. (At 0dac072 the valid `mesh` vectors
 * lacked `bindings` and `endpoints` and this derived them, DEFECTS.md 47; since 3f79313 they carry
 * them.)
 */
export function expected(v) {
  return v;
}

/**
 * Vector kinds this runner does not run (CONTRACT-0.4.0-libs.md item 9; SPEC 11): `formula`,
 * `formula-eval`, `excel`, `decimal` and (since spec-0.4.2) `call` are for formula evaluators, and a verifier library has
 * none (SPEC 10.1: evaluation comes from the resolver). For such a vector the runner writes
 * exactly `{"id", "error": null, "skipped": "<kind>"}` (SPEC 11, crosscheck/README.md) and the
 * conformance check counts it as skipped.
 */
export const SKIPPED_KINDS = ['formula', 'formula-eval', 'excel', 'decimal', 'call'];

const canonicalJson = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));

export function compare(v, got) {
  const problems = [];
  if (got.id !== v.id) problems.push(`id ${got.id}`);
  if (SKIPPED_KINDS.includes(v.kind)) {
    if (Object.keys(got).sort().join() !== 'error,id,skipped' || got.error !== null || got.skipped !== v.kind) problems.push(`expected a skipped ${v.kind} vector, got ${JSON.stringify(got).slice(0, 200)}`);
    return problems;
  }
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
  const want = expected(v);
  for (const k of OUTPUTS[v.kind]) if (!(v.kind === 'receipt' && k === 'blob_checked' && v.blob_checked === undefined)) if (canonicalJson(got[k]) !== canonicalJson(want[k])) problems.push(`${k}: expected ${JSON.stringify(want[k]).slice(0, 200)}, got ${JSON.stringify(got[k]).slice(0, 200)}`);
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
/**
 * A `mesh` vector's env member ({"https": {"status", "body"?}}, absent: a failed retrieval) as
 * the response resolveMesh takes: {status, body}, with "error" (a network failure) as null.
 */
export function responseOf(env) {
  const h = (env && env.https) || { status: 'error' };
  return { status: h.status === 'error' ? null : h.status, body: h.body };
}

export function receiptKeys(lib, v) {
  return Object.entries(v.keys || {}).map(([host, env]) => keysFromEnv(lib, host, env));
}

export function makeRunner(lib, sha256) {
  return async function run(v) {
    const out = { id: v.id, error: null };
    if (SKIPPED_KINDS.includes(v.kind)) return { ...out, skipped: v.kind };
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
          // Since spec-0.4.3: the document's declarations, as given, when it has them (SPEC 11).
          if (r.declarations !== undefined) out.declarations = r.declarations;
          break;
        }
        case 'licence': {
          // SPEC 8.5 as a pure function; `declarations` {} (or absent) is none.
          const r = lib.inheritLicence(v.licences, v.declarations ?? null, v.fn, v.issued, v.mesh_licence);
          out.licence = r.licence;
          out.reason = r.reason;
          break;
        }
        case 'entitlement': {
          // SPEC 11: verify R first (through step 6), take L by following R's inputs through
          // `receipts` and `manifests` (each input receipt verified through step 6 as well), and K
          // from the env of the host of R's cell.ns; then the check of 10.3.
          const keys = receiptKeys(lib, v);
          const res = lib.verify(inputOf(v), keys);
          if (!res.ok) return { id: v.id, error: res.code };
          const L = lib.inputLicences(inputOf(v), v.receipts || {}, v.manifests || {}, keys);
          const ns = JSON.parse(text(lib.canonicalize(inputOf(v), 'receipt'))).cell.ns;
          const host = ns.split('/')[0];
          const K = keysFromEnv(lib, host, (v.keys || {})[host]);
          if (!K.ok) return { id: v.id, error: K.code };
          const e = lib.checkEntitlement(inputOf(v), L, K);
          out.entitled = e.entitled;
          out.reason = e.reason;
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
          // A code reported with success (10.1 step 7.6: E_EVAL_UNAVAILABLE, E_INPUT_SUPERSEDED); absent otherwise.
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
          if (v.request && Object.prototype.hasOwnProperty.call(v.request, 'slice_id')) {
            // A page of the slice endpoint (5.6), or another answer there.
            const res = lib.checkSlicePage(v.status, inputOf(v), receiptKeys(lib, v), v.request);
            if (!res.ok) return { id: v.id, error: res.code };
            out.outcome = res.outcome;
            if (res.page) out.results = res.page.members.map((m) => ({ outcome: m.outcome, receipt_hash: m.receiptHash, trust: m.trust }));
            break;
          }
          const res = lib.checkEnvelope(v.status, inputOf(v), receiptKeys(lib, v), v.request);
          if (!res.ok) return { id: v.id, error: res.code };
          out.outcome = res.outcome;
          if (res.receiptHash !== null) {
            out.trust = res.trust;
            out.receipt_hash = res.receiptHash;
          }
          break;
        }
        case 'mesh': {
          const env = v.env || {};
          const r = lib.resolveMesh(v.host, { keys: responseOf(env.keys), mesh: responseOf(env.mesh) });
          if (!r.ok) return { id: v.id, error: r.code };
          out.bindings = r.bindings;
          out.endpoints = r.endpoints;
          break;
        }
        case 'batch': {
          // A /cells response (5.7): per-item results for a 200 batch, or a refusal's outcome.
          const res = lib.checkBatch(v.status, inputOf(v), receiptKeys(lib, v), v.requests);
          if (!res.ok) return { id: v.id, error: res.code };
          if (res.items) {
            out.results = res.items.map((it) => {
              if (!it.ok) return { error: it.code };
              const r = { outcome: it.outcome };
              if (it.receiptHash !== null) Object.assign(r, { receipt_hash: it.receiptHash, trust: it.trust });
              return r;
            });
          } else out.outcome = res.outcome;
          break;
        }
        case 'slice': {
          // The input is JSON text of a slice object (4.4) or a manifest (15.13). Parse it strictly
          // (6.1); an object with a `members` member is taken as a manifest, anything else as a
          // slice object (SPEC 11; DEFECTS.md 41).
          const parsed = JSON.parse(text(lib.canonicalize(inputOf(v), 'jcs')));
          const manifest = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'members');
          const c = lib.canonicalize(inputOf(v), manifest ? 'manifest' : 'slice');
          out.canonical = text(c);
          out.sha256 = await sha256(c);
          if (manifest) {
            const m = JSON.parse(out.canonical);
            out.slice_id = lib.sliceId(m.slice);
            out.members_hash = lib.membersHash(m.members);
            out.entry = lib.sliceEntry(inputOf(v));
          } else {
            out.slice_id = lib.sliceId(inputOf(v));
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
