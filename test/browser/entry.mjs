// Browser test entry, bundled by scripts/browser-test.sh with esbuild (platform=browser, so any
// Node built-in reachable from the library would fail the bundle) and run in headless Chrome.
// Runs every spec vector through the same runner logic as the Node conformance test, with
// WebCrypto for the independent SHA-256, plus URI round trips, the Ed25519 edge cases and the
// full bit-flip sweeps of one receipt and of the blob receipt's content. Writes a JSON summary
// into <pre id="result">.
import * as lib from '../../dist/esm/index.js';
import { verifyEd25519Strict } from '../../dist/esm/ed25519.js';
import { makeRunner, compare, hexToBytes, receiptKeys } from '../../tools/vector-runner.mjs';
import vectors from '../../.browser-test/vectors.json';
import edCases from '../fixtures/ed25519-cases.json';

const sha256 = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');

async function main() {
  const run = makeRunner(lib, sha256);
  const summary = { userAgent: navigator.userAgent, hasNodeProcess: typeof process !== 'undefined', vectors: { pass: 0, fail: 0, failures: [] }, byKind: {}, uriRoundTrips: 0, ed25519: { pass: 0, fail: 0 }, bitFlips: 0, bitFlipFailures: 0 };
  for (const v of vectors) {
    const got = await run(v);
    const ok = compare(v, got).length === 0;
    const key = `${v.kind}/${v.valid ? 'valid' : 'invalid'}`;
    summary.byKind[key] ??= { pass: 0, fail: 0 };
    summary.byKind[key][ok ? 'pass' : 'fail']++;
    summary.vectors[ok ? 'pass' : 'fail']++;
    if (!ok) summary.vectors.failures.push({ id: v.id, got });
    if (v.kind === 'uri' && v.valid && lib.formatUri(lib.parseUri(v.input, v.signature)) === v.input) summary.uriRoundTrips++;
  }
  for (const c of edCases) {
    const r = verifyEd25519Strict(hexToBytes(c.sig), hexToBytes(c.msg), hexToBytes(c.pub));
    summary.ed25519[r === c.libsodium ? 'pass' : 'fail']++;
  }
  const v = vectors.find((x) => x.id === 'receipt/stored-number');
  const keys = receiptKeys(lib, v);
  const bytes = lib.canonicalize(v.input, 'receipt');
  summary.unflippedOk = lib.verify(bytes, keys).ok;
  for (let i = 0; i < bytes.length * 8; i++) {
    const b = bytes.slice();
    b[i >> 3] ^= 1 << (i & 7);
    summary.bitFlips++;
    if (lib.verify(b, keys).ok) summary.bitFlipFailures++;
  }
  // Step 7.7 in the browser: the library's own SHA-256 checks blob content (no WebCrypto, no
  // network). The unmodified content passes; every single-bit flip fails with E_BLOB_MISMATCH.
  const bv = vectors.find((x) => x.id === 'receipt/blob-value');
  const bkeys = receiptKeys(lib, bv);
  const content = hexToBytes(bv.blob_hex);
  summary.blobOk = lib.verify(bv.input, bkeys, null, content).ok;
  summary.blobFlips = 0;
  summary.blobFlipFailures = 0;
  for (let i = 0; i < content.length * 8; i++) {
    const c = content.slice();
    c[i >> 3] ^= 1 << (i & 7);
    summary.blobFlips++;
    if (lib.verify(bv.input, bkeys, null, c).code !== 'E_BLOB_MISMATCH') summary.blobFlipFailures++;
  }
  return summary;
}

main()
  .then((s) => (document.getElementById('result').textContent = JSON.stringify(s)))
  .catch((e) => (document.getElementById('result').textContent = JSON.stringify({ error: String(e && e.stack ? e.stack : e) })));
