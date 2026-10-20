#!/usr/bin/env node
// Conformance runner (CONTRACT.md): reads one SPEC.md section 11 vector object per line on stdin
// and writes one JSON line per input: {"id", "error": <code or null>, ...outputs}, where the
// outputs are exactly the section 11 output fields for the vector's kind.
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  canonicalize,
  DatumeshError,
  httpsUrl,
  keyId,
  keysFromResponse,
  parseUri,
  receiptPayload,
  verify,
} from '../dist/esm/index.js';

const MESH = 'mesh.example';
const text = (bytes) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function inputOf(v) {
  return v.input_hex !== undefined ? Uint8Array.from(Buffer.from(v.input_hex, 'hex')) : v.input;
}

/** env {"https": {"status": 200|<int>|"error", "body"?: text}} -> KeysResult */
function fromEnv(host, env) {
  const h = (env && env.https) || { status: 'error' };
  return keysFromResponse(host, typeof h.status === 'number' ? h.status : null, h.body);
}

async function run(v) {
  const out = { id: v.id, error: null };
  try {
    switch (v.kind) {
      case 'jcs':
      case 'scalar':
      case 'cell':
      case 'ref':
      case 'function': {
        const c = canonicalize(inputOf(v), v.kind);
        out.canonical = text(c);
        out.sha256 = sha256(c);
        break;
      }
      case 'uri': {
        const ref = parseUri(v.input, v.signature);
        const c = canonicalize(ref, 'ref');
        out.object = ref;
        out.canonical = text(c);
        out.sha256 = sha256(c);
        out.https = httpsUrl(v.input, MESH);
        break;
      }
      case 'keyid':
        out.key_id = keyId(v.input);
        break;
      case 'keys': {
        const r = fromEnv(v.host, v.env);
        if (!r.ok) return { id: v.id, error: r.code };
        out.key_ids = r.keys.map((k) => k.id);
        break;
      }
      case 'receipt': {
        const keys = Object.entries(v.keys || {}).map(([host, env]) => fromEnv(host, env));
        const res = verify(inputOf(v), keys, v.recompute ?? null);
        if (!res.ok) return { id: v.id, error: res.code };
        const payload = receiptPayload(inputOf(v));
        out.canonical = text(payload);
        out.sha256 = res.hash;
        out.sig = JSON.parse(text(canonicalize(inputOf(v), 'receipt'))).sig;
        out.level = res.level;
        break;
      }
      default:
        throw new Error(`unknown kind ${v.kind}`);
    }
  } catch (e) {
    if (e instanceof DatumeshError) return { id: v.id, error: e.code };
    throw e;
  }
  return out;
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const v = JSON.parse(line);
  process.stdout.write(JSON.stringify(await run(v)) + '\n');
}
