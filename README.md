# @datumesh/verify

Verify [Datumesh](https://datumesh.com) receipts in JavaScript: signed answers for addressable data cells, checked offline against strict RFC 8785 canonical JSON and Ed25519, following the [Datumesh specification](https://github.com/datumesh-com/datumesh-spec) revision `spec-0.6.1` and passing all of its verification test vectors (the formula-dialect vectors are for formula evaluators; this library evaluates no functions).

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

- `verify(receipt, keys, recompute?, blob?)` runs the verification procedure of SPEC.md 10.1 and returns `{ ok, code, level, hash, key, detail, path, blobChecked, source }` (`source` is the receipt's `source`, since 0.6.0, or `null`). It is synchronous, never touches the network and never throws for a bad receipt or bad key material; failures come back as the spec's error codes (`E_SIGNATURE`, `E_KEY_NOT_VALID`, ...). `level` is `"signed"`, or `"recomputed"` when you pass the descriptor, the input receipts and the value you obtained by evaluating the function (the library checks lineage and compares; it does not evaluate functions). If you could not evaluate it, leave out the value: when the descriptor, arguments and inputs check out, the result is `ok` at level `"signed"` with `code` `"E_EVAL_UNAVAILABLE"`. Inputs that are slices (`slice:<slice id>:<members hash>` entries) are checked through their manifests (`recompute.manifests`, by entry) and member receipts (in `recompute.inputs`): hashes, declared functions, membership (`E_SLICE_MEMBER`) and times. If the value you obtained differs and you pass the evaluation's lineage (`recompute.lineage`), a receipt whose input was since superseded by a later version, or whose slice gained other members, is `ok` at level `"signed"` with `code` `"E_INPUT_SUPERSEDED"`: historical, not wrong. These two are the only codes reported with success. For a receipt whose value is a `blob`, pass the content bytes as `blob` to check their length and SHA-256 (`E_BLOB_MISMATCH`; `blobChecked` is then true).
- `keys` is a key document, the result of `keysFromResponse` / `fetchKeys`, a `{ keyId: publicKeyHex }` map, or an array of these (one per host for lineage).
- `fetchKeys(host)` is the only function that uses the network: one `GET https://<host>/.well-known/datumesh.json`, no redirects, 10 s timeout, using the platform's `fetch` and TLS verification.
- `checkEnvelope(status, body, keys, request)` checks a mesh's response envelope (SPEC.md 5.5) against its HTTP status, verifies the embedded receipt through the signature, and checks that it answers your request (`request` is `{ cell_id, asof? }`: the id of the cell you asked for and the `asof` you asked with, if any), returning `{ ok, code, outcome, trust, receiptHash, detail, path, fault }` (`fault` is the formula evaluation fault a `not_covered` answer may carry, such as `"E_FORMULA_DIV_ZERO"`, else `null`). A mesh still computing answers `pending` (202): `pending` is then `{ job, poll, estimateSeconds }`. Poll the `poll` URL only if it names the host you asked (the envelope check requires a DNS name there but cannot know which host you asked) and check each answer with `checkEnvelope(status, body, keys, { cell_id, asof?, job })`: the original request's cell id and `asof`, plus the job polled. The final envelope is bound to that original request, and `E_JOB_UNKNOWN` (ask again) is accepted only at a job URL. The receipt's `asof` must be at or before the requested one, for `ok` as for `stale`. The envelope itself is unsigned: that an `ok` receipt is the latest version, `stale`, `superseded_by` and `verified` remain the mesh's claims.
- Since spec-0.4.2 a request may be **pinned** to a function (`fn_hash=` in the cell URI, `fn_hash` in a reference; `parseUri`/`formatUri` handle it): pass the pin as `fn_hash` in the request description, and the envelope must echo it (`EnvelopeResult.fnHash`). Pass the host you asked as `mesh` and `trust` `computed` (the mesh evaluated and signed the cell itself) is checked against the receipt's signer, and `poll` against that host; without `mesh` that comparison is yours to make.
- `checkSlicePage(status, body, keys, { slice_id, asof?, fn_hash?, mesh?, after? })` checks an answer of the slice endpoint: for a page, every member envelope (receipt verified, a cell of the slice, key order, `trust`), the slice and `next`; `page.members` lists `{ outcome, trust, receiptHash }`. A page states that each member is a cell of the slice, not that the page is complete.
- `checkBatch(status, body, keys, requests)` checks a `/cells` response: the whole batch (one `{ envelope, status }` item per request), then each item against its own request, a failing item reported in its place (`items`); or a refusal of the whole batch (`outcome`).
- `resolveMesh(host, { keys, mesh })` resolves a host across meshes (SPEC.md 9.6) from the responses you retrieved for its key document and its mesh document (`/.well-known/datumesh-mesh.json`), each `{ status, body }`: it checks that both describe the same mesh and returns `{ ok, code, bindings, endpoints, keys }`, or `E_KEY_UNAVAILABLE`, `E_KEY_DOC` or `E_MESH_DOC`. Like `keysFromResponse` it does no networking. Verification never needs it.
- Since spec-0.4.3 a key document may carry **`declarations`**: per function name under its own host, dated licence entries. They are checked with the rest of the document (anything malformed is `E_KEY_DOC`), exposed as `KeysResult.declarations`, and change nothing in verification. A mesh that serves `declarations` is unverifiable by @datumesh/verify < 0.4.3.
- **Licences** (SPEC.md 8.5, 10.3). `inheritLicence(licences, declarations, fn, issued, meshLicence)` is the inheritance rule as a pure function: the licence a computed receipt must carry, or `licence: null` when the mesh may not compute the cell, with the step's `reason` (`no_inputs`, `open`, `declared`, `share_alike_conflict`, `restricted_conflict`, `not_declared`, `declaration_not_open`). `checkEntitlement(receipt, inputLicences, keyDocument)` answers `{ entitled, reason, licence }` for a receipt, the licences of its input receipts and the key document of its publisher's host (the host of `cell.ns`; a document of another host is a `TypeError`); `inputLicences(receipt, receipts, manifests?, keys?)` collects those licences through the receipts and manifests you hold, slice members included. Entitlement is a policy check, separate from verification: a not entitled receipt is still signature-valid. `licenceTier(licence)` gives a licence's tier (1 public domain to 4 restricted).
- `isUnrooted(namespace)` tells an unrooted namespace (its host under `.invalid`, such as `local.invalid`) from a rooted one (SPEC.md 2.5). Unrooted receipts verify only with the signer's key document supplied out of band.
- An `error` envelope with `E_FOREIGN_UNAVAILABLE` (HTTP 502) says the cell belongs to another mesh that could not be reached; `EnvelopeResult.foreignDetail` is its `detail` (`offline`, `network`, `dns`, `tls`, `timeout` or `refused`, `FOREIGN_DETAILS`). It is never a verification result.
- **Relayed receipts and scenarios** (since spec-0.6.0, SPEC.md 5.5, 5.9, 8.1, 16.8). `verify` returns a receipt's `source` (`SourceInfo`, a copy, or `null`); a receipt signed by the host of `cell.ns` with a `source` is trust `relayed`. `checkEnvelope` takes `overrides` and `solve` in the request and returns a `scenario` answer as `kind: 'scenario'`, with `scenario` (a `Scenario`, never a receipt: no `receiptHash`, no `trust`); `EnvelopeResult` is a discriminated union on `kind`. An `error` envelope with `E_EVAL_UNAVAILABLE` exposes its `cycle`. `checkDescribe` checks function answers (`kind: 'function'`, with `tests` and `source`). Versions before 0.6.0 reject a receipt with `source` (`E_SCHEMA`) and a `relayed` trust, as the CHANGELOG states.
- **DNS names in later segments** (since spec-0.6.1, SPEC.md 2.3, 5.1). A segment after the host may be a DNS name, as in `datumesh.com/relay/ecb.europa.eu/fx_reference`; `parseUri`, cells, descriptors and receipts accept it. The host alone decides the publisher and whether a namespace is unrooted (`isUnrooted`); a later DNS name is a label only. The function and a method name stay names.
- **Describe publisher** (since spec-0.6.1, SPEC.md 16.8). `checkDescribe` checks an optional `publisher` (the host of the class or function name, exactly) and returns it as `publisher` (`null` when the answer has none) in its class and function results.
- **Loopback mesh URLs** (since spec-0.5.0, SPEC.md 9.6). An unrooted host's mesh document, and its `poll` and `next` URLs, may be `http://` on `127.0.0.1`, `[::1]` or `localhost` (optional port, one origin per document). `resolveMesh` accepts them for an unrooted host only; `checkEnvelope` and `checkSlicePage` accept a loopback `poll` or `next` only when `request.mesh` names that unrooted mesh. Rooted hosts stay https-only.
- **Short calls and envelopes** (since spec-0.5.0, SPEC.md 5.5, 16.7, 16.9). `EnvelopeResult.resolved` says what a short call resolved (`{call, resolutions, aliases_tx?}`, the resolution kinds `alias`, `default`, `method` and `lookup`); `EnvelopeResult.shadows` names a class the mesh binds to another hash than its reference class (`{class, reference}`); `EnvelopeResult.error` is the `error` member of a `not_covered`, `bad_request` or `error` answer. `FAULTS` lists the formula faults a `not_covered` answer may carry, now including `E_FORMULA_KEY` and `E_FORMULA_DISPATCH_KEY`.
- **Classes** (since spec-0.5.0, SPEC.md 16). `defineClass(descriptor, name, { definer, functions, classes })` checks a class descriptor under the definer's namespace, flattens it onto its parent (`classes`, found by class hash), checks its methods (`functions`, found by function hash) and interfaces, and returns `{ flattened, classHash }`, the flattened descriptor's canonical text and its SHA-256. `classHash(flattened)` hashes a flattened descriptor after checking it. `checkKeyNormalisation(rule, text)` checks a key value under one of the `KEY_NORMALISATIONS` (throws `E_KEY_NORMALISATION`). `parseObjectKey(encoding)` and `formatObjectKey(object)` read and write the one canonical object key, `Class(key:value,...)` (`E_KEY_ENCODING`); `objectJson(object)`, `objectId(object)` and `shortId(id)` give an object's canonical bytes, its SHA-256 id and its 12-digit short id. `checkDescribe(answer, classes)` checks a describe answer for a class or an object against the classes you hold (`E_DESCRIBE`), and returns `{ kind }`. `checkDefine(descriptor, name)` is the define-time check of a function: its name and descriptor, and `E_UNROOTED_INPUT` for a rooted function that reads an unrooted one (SPEC.md 2.5); it returns `{ canonical, hash }`. These do no networking; a caller's misuse, such as a non-string name, throws `TypeError`.
- **Function descriptors** (since spec-0.5.0, SPEC.md 7). `canonicalize(descriptor, 'function')` and `functionHash` accept the members `classes` and `default` on arguments, `key_normalisation` on a `string` argument, and `returns` as `{"type": "string", "classes": [...]}`, with their checks. A descriptor that has any of them is `E_SCHEMA` to a library before spec-0.5.0.
- `resolvedUnit(descriptor, cell)` gives the unit of a cell's value from its function's declared units (`"USD/EUR"`, `"degC"`, or `null` for a non-number), using the closed list of `units.md` shipped with the package. The library never converts or checks values against units.
- `canonicalize(obj, kind)`, `cellHash`, `receiptHash`, `functionHash`, `sliceId`, `membersHash`, `sliceEntry(manifest)`, `parseUri(uri, signature)`, `formatUri(ref)` and `keyId` expose canonical forms, hashes, slice entries and cell URIs. These and `resolvedUnit` throw `DatumeshError` (with `.code` and `.path`).

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
