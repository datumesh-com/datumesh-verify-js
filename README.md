# @datumesh/verify

Verify [Datumesh](https://datumesh.com) receipts in JavaScript: signed answers for addressable data cells, checked offline against strict RFC 8785 canonical JSON and Ed25519, following the [Datumesh specification](https://github.com/datumesh-com/datumesh-spec) revision `spec-0.2.0` and passing all of its test vectors.

```sh
npm install @datumesh/verify
```

```js
import { readFileSync } from 'node:fs';
import { verify, keysFromResponse } from '@datumesh/verify';

// vectors/receipt/stored-number.json from https://github.com/datumesh-com/datumesh-spec
const vector = JSON.parse(readFileSync('stored-number.json', 'utf8'));
const keys = keysFromResponse('rates.example.org', 200, vector.keys['rates.example.org'].https.body);
const result = verify(vector.input, keys);
console.log(result.ok, result.code, result.level, result.hash);
// true OK signed 19a5fe3a744c5792f747fb4c286ce396ab44b95922de4f07937502fe595b6f81
```

The same with CommonJS:

```js
const { readFileSync } = require('node:fs');
const { verify, keysFromResponse } = require('@datumesh/verify');

const vector = JSON.parse(readFileSync('stored-number.json', 'utf8'));
const keys = keysFromResponse('rates.example.org', 200, vector.keys['rates.example.org'].https.body);
console.log(verify(vector.input, keys).code); // OK
```

## What it does

- `verify(receipt, keys, recompute?, blob?)` runs the verification procedure of SPEC.md 10.1 and returns `{ ok, code, level, hash, key, detail, path }`. It is synchronous, never touches the network and never throws for a bad receipt or bad key material; failures come back as the spec's error codes (`E_SIGNATURE`, `E_KEY_NOT_VALID`, ...). `level` is `"signed"`, or `"recomputed"` when you pass the descriptor, the input receipts and the value you obtained by evaluating the function (the library checks lineage and compares; it does not evaluate functions). For a receipt whose value is a `blob`, pass the content bytes as `blob` to check their length and SHA-256 (`E_BLOB_MISMATCH`).
- `keys` is a key document, the result of `keysFromResponse` / `fetchKeys`, a `{ keyId: publicKeyHex }` map, or an array of these (one per host for lineage).
- `fetchKeys(host)` is the only function that uses the network: one `GET https://<host>/.well-known/datumesh.json`, no redirects, 10 s timeout, using the platform's `fetch` and TLS verification.
- `checkEnvelope(status, body, keys)` checks a mesh's response envelope (SPEC.md 5.5) against its HTTP status and verifies the embedded receipt through the signature, returning `{ ok, code, outcome, trust, receiptHash, detail, path }`. The envelope itself is unsigned: `stale`, `superseded_by` and `verified` remain the mesh's claims.
- `resolvedUnit(descriptor, cell)` gives the unit of a cell's value from its function's declared units (`"USD/EUR"`, `"degC"`, or `null` for a non-number), using the closed list of `units.md` shipped with the package. The library never converts or checks values against units.
- `canonicalize(obj, kind)`, `cellHash`, `receiptHash`, `functionHash`, `parseUri(uri, signature)`, `formatUri(ref)` and `keyId` expose canonical forms, hashes and cell URIs. These and `resolvedUnit` throw `DatumeshError` (with `.code` and `.path`).

SHA-256 and Ed25519 come from the `@noble` libraries (pure JavaScript), so blob checks work the same in Node 18.0 and in browsers. Strings are checked against Unicode 15.1 tables shipped with the package, so results do not depend on the JavaScript engine's Unicode version. Ed25519 verification is libsodium-strict, as the spec requires. ESM and CommonJS builds with TypeScript types, for Node 18+ and for browsers through a bundler (the core uses no Node built-ins). Where the specification left a question open, the choices made are listed in [DEFECTS.md](https://github.com/datumesh-com/datumesh-verify-js/blob/main/DEFECTS.md).

A valid signature means only that the holder of the key named in `computed_by` stated the value. Whom to trust is your policy.

## Development

```sh
git clone --recurse-submodules https://github.com/datumesh-com/datumesh-verify-js && cd datumesh-verify-js
npm ci && npm test                 # all tests; scripts/browser-test.sh and scripts/package-test.sh need Docker
```

## Links

- Datumesh: https://datumesh.com
- Specification and test vectors: https://github.com/datumesh-com/datumesh-spec

Licensed under the Apache License 2.0.
