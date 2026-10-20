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
  receipt: ['canonical', 'sha256', 'sig', 'level'],
};

const text = (bytes) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

export function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function inputOf(v) {
  return v.input_hex !== undefined ? hexToBytes(v.input_hex) : v.input;
}

/** env {"https": {"status": 200|<int>|"error", "body"?: text}} -> KeysResult */
export function keysFromEnv(lib, host, env) {
  const h = (env && env.https) || { status: 'error' };
  return lib.keysFromResponse(host, typeof h.status === 'number' ? h.status : null, h.body);
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
          const res = lib.verify(inputOf(v), receiptKeys(lib, v), v.recompute ?? null);
          if (!res.ok) return { id: v.id, error: res.code };
          out.canonical = text(lib.receiptPayload(inputOf(v)));
          out.sha256 = res.hash;
          out.sig = JSON.parse(text(lib.canonicalize(inputOf(v), 'receipt'))).sig;
          out.level = res.level;
          break;
        }
        default:
          throw new Error(`unknown kind ${v.kind}`);
      }
    } catch (e) {
      if (e instanceof lib.DatumeshError) return { id: v.id, error: e.code };
      throw e;
    }
    return out;
  };
}
