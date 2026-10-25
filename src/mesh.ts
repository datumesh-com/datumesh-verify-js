// Cross-mesh resolution (SPEC.md 9.6, since spec-0.4.1): a host's key document and mesh document,
// checked together. Separate from verification: a verifier never needs it. Offline: it
// interprets responses the caller retrieved, like keysFromResponse.
import { DatumeshError } from './errors.js';
import { isObject, sortedKeys, toJson, type JsonObject, type JsonValue } from './json.js';
import { keysFromResponse, type KeyEntry } from './keys.js';
import { LIMITS, URL_RE } from './lexical.js';

/** An HTTPS response for one document: the integer status (null: network failure) and the body. */
export interface DocumentResponse {
  status: unknown;
  body?: string | Uint8Array | null;
}

/** The outcome of resolving a host across meshes (SPEC 9.6). */
export interface MeshResult {
  ok: boolean;
  /** "OK", or the code of the first failure in 9.6's order. */
  code: 'OK' | 'E_KEY_UNAVAILABLE' | 'E_KEY_DOC' | 'E_MESH_DOC';
  host: string;
  /** Human-readable explanation. */
  detail: string;
  /** Where in the failing document the failure was found (`$.endpoints.cell`), or null. */
  path: string | null;
  /** The bindings URL (9.7) when ok, else null. */
  bindings: string | null;
  /** The known endpoint templates by name when ok (unknown members dropped), else null. */
  endpoints: Record<string, string> | null;
  /** The host's validated keys (as keysFromResponse gives them) when ok, else null. */
  keys: KeyEntry[] | null;
}

/** SPEC 9.6: the endpoints, their placeholders, and whether they are required. */
export const MESH_ENDPOINTS: Readonly<Record<string, { placeholders: readonly string[]; required: boolean }>> = {
  blob: { placeholders: ['sha256'], required: false },
  cell: { placeholders: ['cell'], required: true },
  cells: { placeholders: [], required: false },
  descriptor: { placeholders: ['hash'], required: true },
  explain: { placeholders: ['cell'], required: false },
  find: { placeholders: [], required: false },
  jobs: { placeholders: ['job'], required: true },
  manifest: { placeholders: ['slice_id', 'members_hash'], required: true },
  receipt: { placeholders: ['hash'], required: true },
  slice: { placeholders: ['cell'], required: false },
  verify: { placeholders: [], required: false },
};

class MeshFail extends Error {
  constructor(
    readonly code: 'E_KEY_UNAVAILABLE' | 'E_KEY_DOC' | 'E_MESH_DOC',
    readonly detail: string,
    readonly path: string | null,
  ) {
    super(detail);
  }
}
function no(code: MeshFail['code'], detail: string, path: string | null = '$'): never {
  throw new MeshFail(code, detail, path);
}

const hasBody = (b: unknown): b is string | Uint8Array => typeof b === 'string' || b instanceof Uint8Array;

function parse(body: string | Uint8Array): JsonValue | undefined {
  try {
    return toJson(body);
  } catch (e) {
    if (e instanceof DatumeshError) return undefined;
    throw e;
  }
}

/** A URL by the licence URL rule, on this host: `https://<host>/...`, at most 512 characters. */
function onHost(v: unknown, host: string, what: string, path: string): string {
  if (typeof v !== 'string' || !URL_RE.test(v) || v.length > LIMITS.licence_url) no('E_MESH_DOC', `${what} is an https URL of at most 512 printable ASCII characters`, path);
  if (!v.startsWith(`https://${host}/`)) no('E_MESH_DOC', `${what} is a URL on this host (${host}), followed by a path`, path);
  return v;
}

/**
 * Resolve `host` across meshes (SPEC 9.6) from the responses the caller retrieved for
 * `https://<host>/.well-known/datumesh.json` (`keys`) and
 * `https://<host>/.well-known/datumesh-mesh.json` (`mesh`), each `{status, body}` (status null for
 * a network, DNS, TLS or timeout failure; an absent response is a failed retrieval). In 9.6's
 * order: the key document's retrieval (E_KEY_UNAVAILABLE; a 200 without a body is E_KEY_DOC), the
 * mesh document's (E_MESH_DOC), strict parsing (E_KEY_DOC, E_MESH_DOC), the two describing the
 * same mesh (E_MESH_DOC), the key document by 9.2 (E_KEY_DOC), then the mesh document's members
 * (E_MESH_DOC). Returns the bindings URL, the known endpoints and the keys. No network; never
 * throws for bad responses (TypeError only when called without a host or the responses object).
 */
export function resolveMesh(host: string, responses: { keys?: DocumentResponse; mesh?: DocumentResponse }): MeshResult {
  if (typeof host !== 'string') throw new TypeError('host must be a string');
  if (!responses || typeof responses !== 'object') throw new TypeError('resolveMesh(host, {keys, mesh}) needs the two responses');
  const k = responses.keys ?? { status: null };
  const m = responses.mesh ?? { status: null };
  try {
    // 1. The key document's retrieval, as in 9.3.
    const keys = keysFromResponse(host, k.status, k.body);
    if (keys.code === 'E_KEY_UNAVAILABLE') no('E_KEY_UNAVAILABLE', keys.detail);
    if (!hasBody(k.body)) no('E_KEY_DOC', '200 response without a key document');
    // 2. The mesh document's: anything but the integer 200 with a body.
    if (m.status !== 200 || !hasBody(m.body)) no('E_MESH_DOC', `no mesh document (HTTP status ${m.status === null ? 'none: network failure' : JSON.stringify(m.status)}${m.status === 200 ? ', no body' : ''})`);
    // 3. Strict JSON (6.1).
    const kd = parse(k.body);
    if (kd === undefined) no('E_KEY_DOC', 'the key document is not strict JSON');
    const md = parse(m.body);
    if (md === undefined) no('E_MESH_DOC', 'the mesh document is not strict JSON');
    if (!isObject(md)) no('E_MESH_DOC', 'the mesh document is not a JSON object');
    // 4. The two documents describe the same mesh: the mesh document's host and proto; the key
    // document's host and proto only where each is a string in an object (anything else is the
    // key document's own failure, E_KEY_DOC in step 5).
    if (md.host !== host) no('E_MESH_DOC', `the mesh document names another host than ${host}`, '$.host');
    if (md.proto !== 'datumesh/1') no('E_MESH_DOC', 'the mesh document\'s proto is not "datumesh/1"', '$.proto');
    if (isObject(kd) && typeof kd.host === 'string' && kd.host !== host) no('E_MESH_DOC', `the key document names another host than ${host}`, '$.host');
    if (isObject(kd) && typeof kd.proto === 'string' && kd.proto !== 'datumesh/1') no('E_MESH_DOC', 'the key document names another protocol than the mesh document', '$.proto');
    // 5. The key document by 9.2.
    if (!keys.ok || !keys.keys) no('E_KEY_DOC', keys.detail);
    // 6. The mesh document's members: bindings, endpoints (every required one), then each known
    // endpoint in ascending name order. Unknown members are ignored and dropped.
    const bindings = onHost(md.bindings, host, 'bindings', '$.bindings');
    if (!isObject(md.endpoints)) no('E_MESH_DOC', 'endpoints is an object', '$.endpoints');
    const eps = md.endpoints as JsonObject;
    for (const name of Object.keys(MESH_ENDPOINTS).sort()) {
      if (MESH_ENDPOINTS[name].required && !Object.prototype.hasOwnProperty.call(eps, name)) no('E_MESH_DOC', `the endpoint ${name} is required`, `$.endpoints.${name}`);
    }
    const endpoints: Record<string, string> = {};
    for (const name of sortedKeys(eps)) {
      const spec = MESH_ENDPOINTS[name];
      if (!spec || !Object.prototype.hasOwnProperty.call(MESH_ENDPOINTS, name)) continue;
      const p = `$.endpoints.${name}`;
      const url = onHost(eps[name], host, name, p);
      // Each listed placeholder exactly once, and every { and } belongs to one of them.
      let rest = url;
      const once = spec.placeholders.every((ph) => {
        const parts = rest.split(`{${ph}}`);
        rest = parts.join('');
        return parts.length === 2;
      });
      if (!once || rest.includes('{') || rest.includes('}')) {
        no('E_MESH_DOC', `${name} has exactly the placeholders ${spec.placeholders.map((x) => `{${x}}`).join(', ') || '(none)'}, each once, and no other brace`, p);
      }
      endpoints[name] = url;
    }
    return { ok: true, code: 'OK', host, detail: `${host}: key document and mesh document agree; ${Object.keys(endpoints).length} endpoints`, path: null, bindings, endpoints, keys: keys.keys };
  } catch (e) {
    if (e instanceof MeshFail) return { ok: false, code: e.code, host, detail: e.detail, path: e.path, bindings: null, endpoints: null, keys: null };
    throw e;
  }
}
