// Test 4: key handling. Expired key, not-yet-valid key, unknown key id, malformed key document,
// network failure and 404 each give their code, through verify and through keysFromResponse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify, keysFromResponse, keysFromDocument, fetchKeys } from '../dist/esm/index.js';
import { vector } from './helpers.mjs';

const stored = vector('receipt/stored-number');
const docText = stored.keys['rates.example.org'].https.body;
const doc = JSON.parse(docText);
const calcDoc = JSON.parse(stored.keys['calc.example.net'].https.body);
const H = 'rates.example.org';

const cases = [
  ['expired key', 'invalid/receipt-key-expired', 'E_KEY_NOT_VALID'],
  ['not-yet-valid key', 'invalid/receipt-key-not-yet-valid', 'E_KEY_NOT_VALID'],
  ['unknown key id', 'invalid/receipt-unknown-key', 'E_KEY_UNKNOWN'],
];
for (const [name, id, code] of cases) {
  test(`${name}: ${code} via keysFromResponse, a parsed key document and a list`, () => {
    const v = vector(id);
    assert.equal(v.error, code);
    const fromResponse = keysFromResponse(H, 200, docText);
    assert.equal(fromResponse.ok, true);
    assert.equal(fromResponse.code, 'OK');
    assert.equal(verify(v.input, fromResponse).code, code);
    assert.equal(verify(v.input, doc).code, code);
    assert.equal(verify(v.input, [keysFromResponse('calc.example.net', 200, JSON.stringify(calcDoc)), doc]).code, code);
  });
}

const retrieval = [
  ['malformed key document', () => keysFromResponse(H, 200, '<html>Not here</html>'), 'E_KEY_DOC'],
  ['key document for another host', () => keysFromResponse(H, 200, docText.replace('"rates.example.org"', '"other.example.org"')), 'E_KEY_DOC'],
  ['key id not derived from the key', () => keysFromResponse(H, 200, docText.replace('d712b32a2cc5cb7c', '0000000000000000')), 'E_KEY_DOC'],
  ['duplicate member in the key document', () => keysFromResponse(H, 200, docText.replace('"proto"', '"host": "rates.example.org", "proto"')), 'E_KEY_DOC'],
  ['200 without a body', () => keysFromResponse(H, 200), 'E_KEY_DOC'],
  ['network failure', () => keysFromResponse(H, null), 'E_KEY_UNAVAILABLE'],
  ['404', () => keysFromResponse(H, 404, 'not found'), 'E_KEY_UNAVAILABLE'],
  ['redirect', () => keysFromResponse(H, 301), 'E_KEY_UNAVAILABLE'],
  ['server error', () => keysFromResponse(H, 503), 'E_KEY_UNAVAILABLE'],
];
for (const [name, make, code] of retrieval) {
  test(`${name}: ${code} from keysFromResponse and from verify`, () => {
    const r = make();
    assert.equal(r.ok, false);
    assert.equal(r.code, code);
    assert.equal(r.host, H);
    assert.equal(typeof r.detail, 'string');
    const res = verify(stored.input, r);
    assert.equal(res.ok, false);
    assert.equal(res.code, code);
    assert.equal(res.hash, stored.sha256, 'the hash is known even when keys are not');
  });
}

test('keysFromResponse never throws, whatever it is given', () => {
  for (const args of [[H, 200, new Uint8Array([0xff])], [H, 200, '\u{FEFF}' + docText], [H, '200', docText], [H, undefined], [undefined, 200, docText], [H, 200, '{"a":1}'], [H, 200, 12]]) {
    const r = keysFromResponse(...args);
    assert.equal(r.ok, false, JSON.stringify(args));
  }
  assert.equal(keysFromResponse(H, 200, new TextEncoder().encode(docText)).ok, true);
});

test('a host with no key source is E_KEY_UNAVAILABLE', () => {
  assert.equal(verify(stored.input, keysFromResponse('calc.example.net', 200, JSON.stringify(calcDoc))).code, 'E_KEY_UNAVAILABLE');
  assert.equal(verify(stored.input, []).code, 'E_KEY_UNAVAILABLE');
});

test('a {keyId: publicKey} map works for any host and has no validity windows', () => {
  const map = { d712b32a2cc5cb7c: '843baeb22bfd0364fb1b7262b367fb3202e7886c69a070fecf8e343fedb1eabf' };
  const ok = verify(stored.input, map);
  assert.equal(ok.ok, true);
  assert.equal(ok.level, 'signed');
  assert.equal(ok.key, 'rates.example.org#d712b32a2cc5cb7c');
  // No windows: a key the document has retired still verifies through a bare map.
  assert.equal(verify(vector('invalid/receipt-key-expired').input, map).ok, true);
  assert.equal(verify(stored.input, { '0000000000000000': map.d712b32a2cc5cb7c }).code, 'E_KEY_DOC');
  assert.equal(verify(stored.input, {}).code, 'E_KEY_UNKNOWN');
  // A host-specific source takes precedence over a map.
  assert.equal(verify(stored.input, [map, keysFromResponse(H, 404)]).code, 'E_KEY_UNAVAILABLE');
});

test('keysFromDocument validates a parsed document', () => {
  assert.equal(keysFromDocument(doc).ok, true);
  assert.deepEqual(keysFromDocument(doc).keys.map((k) => k.id), ['d712b32a2cc5cb7c', 'd9a2df65559c4444']);
  assert.equal(keysFromDocument({ ...doc, keys: [] }).code, 'E_KEY_DOC');
  assert.equal(verify(stored.input, { ...doc, extra: 1 }).code, 'E_KEY_DOC');
});

test('verify throws TypeError only for keys that are not key sources at all', () => {
  for (const bad of [null, undefined, 5, 'text', true]) assert.throws(() => verify(stored.input, bad), TypeError);
});

// fetchKeys with a stubbed global fetch.
async function withFetch(stub, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}
const response = (status, body, type = 'basic') => ({ status, type, arrayBuffer: async () => new TextEncoder().encode(body ?? '').buffer });

test('fetchKeys: one GET of /.well-known/datumesh.json, redirect manual, with a timeout signal', async () => {
  const calls = [];
  const r = await withFetch(async (url, init) => (calls.push([url, init]), response(200, docText)), () => fetchKeys(H));
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://rates.example.org/.well-known/datumesh.json');
  assert.equal(calls[0][1].redirect, 'manual');
  assert.equal(calls[0][1].method, 'GET');
  assert.ok(calls[0][1].signal instanceof AbortSignal);
});

test('fetchKeys: 404, 3xx, opaque redirect, network error and timeout are E_KEY_UNAVAILABLE', async () => {
  for (const stub of [
    async () => response(404, 'nope'),
    async () => response(301, ''),
    async () => response(0, '', 'opaqueredirect'),
    async () => {
      throw new TypeError('fetch failed');
    },
  ]) {
    const r = await withFetch(stub, () => fetchKeys(H));
    assert.equal(r.code, 'E_KEY_UNAVAILABLE');
  }
  const keepAlive = setTimeout(() => {}, 5000); // AbortSignal.timeout's timer does not hold the event loop
  const timedOut = await withFetch(
    (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
    () => fetchKeys(H, 50),
  );
  clearTimeout(keepAlive);
  assert.equal(timedOut.code, 'E_KEY_UNAVAILABLE');
  assert.match(timedOut.detail, /retrieval failed/);
});

test('fetchKeys: malformed document is E_KEY_DOC; an invalid host is never fetched', async () => {
  assert.equal((await withFetch(async () => response(200, '{}'), () => fetchKeys(H))).code, 'E_KEY_DOC');
  let called = false;
  const r = await withFetch(async () => ((called = true), response(200, docText)), () => fetchKeys('evil.example/x?'));
  assert.equal(r.code, 'E_KEY_UNAVAILABLE');
  assert.equal(called, false);
});

test('9.3: keys only for DNS names: a response for another host is E_KEY_DOC, no fetch is E_KEY_UNAVAILABLE', async () => {
  for (const host of ['Rates.Example.org', 'rates.example.org.', '192.0.2.1', 'localhost', 'rates.example.org:443', 'u@rates.example.org', '']) {
    const own = docText.replace('"rates.example.org"', JSON.stringify(host));
    assert.equal(keysFromResponse(host, 200, own).code, 'E_KEY_DOC', host);
    assert.equal(keysFromResponse(host, 404).code, 'E_KEY_UNAVAILABLE', host);
    assert.equal(keysFromResponse(host, null).code, 'E_KEY_UNAVAILABLE', host);
    assert.equal(keysFromDocument(JSON.parse(own)).code, 'E_KEY_DOC', host);
    let called = false;
    const r = await withFetch(async () => ((called = true), response(200, own)), () => fetchKeys(host));
    assert.equal(r.code, 'E_KEY_UNAVAILABLE', host);
    assert.equal(called, false, host);
  }
});

test('9.3: fetchKeys bounds the document to 256 KiB (abandoned: E_KEY_UNAVAILABLE)', async () => {
  const big = docText + ' '.repeat(256 * 1024);
  const r = await withFetch(async () => response(200, big), () => fetchKeys(H));
  assert.equal(r.code, 'E_KEY_UNAVAILABLE');
  assert.match(r.detail, /256 KiB/);
  const exact = docText + ' '.repeat(256 * 1024 - new TextEncoder().encode(docText).length);
  assert.equal((await withFetch(async () => response(200, exact), () => fetchKeys(H))).code, 'OK');
  // A streamed body is cut off as soon as it passes the bound.
  let pulled = 0;
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  const stream = { getReader: () => ({ read: async () => (pulled++ < 100 ? { done: false, value: chunk } : { done: true }), cancel: async () => {} }) };
  const s = await withFetch(async () => ({ status: 200, type: 'basic', body: stream, arrayBuffer: async () => assert.fail('must stream') }), () => fetchKeys(H));
  assert.equal(s.code, 'E_KEY_UNAVAILABLE');
  assert.ok(pulled <= 6, `read ${pulled} chunks`);
});

test('4.5 / 9.2: more than 64 keys is E_KEY_DOC, not E_CANON_LIMIT', () => {
  const k = doc.keys[0];
  assert.equal(keysFromResponse(H, 200, JSON.stringify({ ...doc, keys: Array.from({ length: 65 }, () => k) })).code, 'E_KEY_DOC');
});
