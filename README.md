# @datumesh/verify

Verify [Datumesh](https://datumesh.com) receipts in JavaScript: signed answers for addressable data cells, checked offline against strict RFC 8785 canonical JSON and Ed25519, exactly as the [Datumesh specification](https://github.com/datumesh-com/datumesh-spec) (revision `spec-0.1.1`) defines.

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
// true OK signed 501f744d910c585859a5be4f3b62385ed0d6803db53dbbf95dff5097a68bee0d
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

- `verify(receipt, keys, recompute?)` runs the verification procedure of SPEC.md 10.1 and returns `{ ok, code, level, hash, key, detail, path }`. It is synchronous, never touches the network and never throws for a bad receipt or bad key material; failures come back as the spec's error codes (`E_SIGNATURE`, `E_KEY_NOT_VALID`, ...). `level` is `"signed"`, or `"recomputed"` when you pass the descriptor, the input receipts and the value you obtained by evaluating the function (the library checks lineage and compares; it does not evaluate functions).
- `keys` is a key document, the result of `keysFromResponse` / `fetchKeys`, a `{ keyId: publicKeyHex }` map, or an array of these (one per host for lineage).
- `fetchKeys(host)` is the only function that uses the network: one `GET https://<host>/.well-known/datumesh.json`, no redirects, 10 s timeout, using the platform's `fetch` and TLS verification.
- `canonicalize(obj, kind)`, `cellHash`, `receiptHash`, `functionHash`, `parseUri(uri, signature)`, `formatUri(ref)` and `keyId` expose canonical forms, hashes and cell URIs. They throw `DatumeshError` (with `.code` and `.path`).

Strings are checked against Unicode 15.1 tables shipped with the package, so results do not depend on the JavaScript engine's Unicode version. Ed25519 verification is libsodium-strict, as the spec requires. ESM and CommonJS builds with TypeScript types; Node 18+ and browsers.

A valid signature means only that the holder of the key named in `computed_by` stated the value. Whom to trust is your policy.

## Links

- Datumesh: https://datumesh.com
- Specification and test vectors: https://github.com/datumesh-com/datumesh-spec

Licensed under the Apache License 2.0.
