# Changelog

Releases of `@datumesh/verify`. Earlier releases are described in the commit log and, for the
specification side, in SPEC.md section 14.

## 0.6.1 — spec-0.6.1

Conforms to the Datumesh specification revision `spec-0.6.1` (spec commit `42979b5`). The vector
set is 1711 vectors: the 1024 this library runs pass (the 902 of spec-0.6.0 and the 122 new ones:
define 28, cell 24, uri 25, describe 19, envelope 9, receipt 7, class 5, function 4, jcs 1), and
the 687 formula-dialect vectors (the 17 new `formula` and 3 new `formula-eval` included) are
skipped as before.

**Compatibility.** A mesh that serves a name with a DNS name in a later segment (for example `datumesh.com/relay/ecb.europa.eu/fx_reference`) is unreadable by clients on @datumesh/verify < 0.6.1: such a name is refused with `E_CANON_NAME` in a cell URI, a cell, a receipt, a descriptor and a describe answer. Every name valid before is valid after, and every receipt signed before verifies unchanged.

- **DNS names in later segments** (SPEC 2.3, 5.1, 4.5). A segment after the host is a `name` (64 characters) or a DNS name (253 characters, 2.1); the whole function name keeps 512. The last segment, a class name's last segment and a method name stay `name`. A later DNS name is a label only: the host alone publishes the keys, decides whether a namespace is unrooted (`isUnrooted`, 2.5) and is a cell's publisher.
- **Describe publisher** (SPEC 16.8). An optional `publisher` of a class or function answer must be the host of its name, a DNS name, else `E_DESCRIBE`. `checkDescribe` returns it: `publisher` is a member of the class and function results, `null` when the answer has none. An answer without it passes as before.
- **Test cells** (SPEC 7.3). `<host>/test_case` cells are ordinary stored cells: the envelope and receipt checks need no change, and the vectors for them pass.
- **Unchanged API.** No function is removed or changed in signature; the result objects of `checkDescribe` gain `publisher`.

## 0.6.0 — spec-0.6.0

Conforms to the Datumesh specification revision `spec-0.6.0` (spec commit `941d9b5`). The vector
set is 1569 vectors: the 902 this library runs pass (818 of spec-0.5.0 and the 84 new ones: 16
receipt, 41 envelope, 22 describe, 5 mesh), and the 667 formula-dialect vectors, the 11 new `call`
vectors included, are skipped as before.

**Compatibility.** A mesh that serves receipts with `source` is unverifiable by clients on core < 0.3.9 or datumesh < 0.6.0 (@datumesh/verify < 0.6.0); such receipts are new, and every receipt signed before them verifies unchanged.

- **Receipts with `source`** (SPEC 8.1, 10.1). `verify` returns the receipt's `source` (`SourceInfo`, a copy, or `null`). `source` is part of the signed payload; its shape and rules are checked in steps 2-4, and `retrieved` is at or before `issued` (`E_TIME_ORDER`). Verification does not fetch `url`.
- **Trust `relayed`** (SPEC 5.5). A receipt signed by the host of `cell.ns`, with no inputs and a `source`, is `relayed`; `primary` now needs that there is no `source`. Neither depends on the mesh asked.
- **Scenarios** (SPEC 5.9). `checkEnvelope` takes `overrides` and `solve` in the request. A `scenario` answer is its own result kind (`kind: 'scenario'`, the `Scenario` type): it has no receipt, no receipt hash and no trust, and is refused unless the request carried overrides. Its binding (cell, asof, overrides, solved) is checked as step 5 requires.
- **Cycles** (SPEC 5.5, 15.12). An `error` envelope with `E_EVAL_UNAVAILABLE` may carry `cycle` (`{path, fixes}`), exposed as `EnvelopeResult.cycle`.
- **Codes** (SPEC 10.2). `E_WHATIF_UNSUPPORTED` (a `bad_request` at a whatif request) and `E_WHATIF_NO_SOLUTION` (the fault of a `not_covered` answer to a whatif request with `solve`, in `FAULTS`). Neither is a verification result.
- **Describe** (SPEC 16.8). A method or function may carry `tests` and `source`, checked as `E_DESCRIBE`. A function answer (`kind: 'function'`) is checked against its held descriptor, and `checkDescribe` returns `{kind: 'function', fn, fnHash, tests, source}`.
- **Mesh document** (SPEC 9.6). The optional `whatif` endpoint, with no placeholders, is in `MESH_ENDPOINTS` and in `resolveMesh`'s endpoints.
- **Public API.** `EnvelopeResult` is a discriminated union on `kind`: `ReceiptEnvelope`, `ScenarioEnvelope` and `OtherEnvelope`. `Trust` gains `relayed`. The types `Scenario`, `ScenarioOverride`, `Cycle`, `CycleFix`, `SourceInfo` and `DescribeSource`/`DescribeTests` are exported.

## 0.5.1 — spec-0.5.0

The first published release for `spec-0.5.0`; the library is 0.5.0's. The tag `v0.5.0` was
pushed, but its release run stopped before publishing: the headless-browser test still expected
spec-0.4.3's 651 vectors, where Chrome ran all 818 and passed. Tags are not moved, so the fix
ships as 0.5.1, and 0.5.0 was never on npm.

## 0.5.0 — spec-0.5.0 (tagged, not published)

Conforms to the Datumesh specification revision `spec-0.5.0` (spec commit `c8896ad`): all 818 of its
vectors this library runs pass (the new kinds `class`, `normalisation`, `key`, `describe` and
`define`, the envelope, mesh, function, licence and entitlement vectors included); the 656 vectors
of the formula dialect, the `call`, `excel` and `decimal` kinds are skipped, as they belong to
formula evaluators and the http crate. Verification of receipts is unchanged: no hash of an existing
descriptor, receipt or cell changes.

**Compatibility.** A client on a library before its spec-0.5.0 release rejects a loopback mesh
document of an unrooted host (`E_MESH_DOC`), a loopback `poll` or `next` (`E_ENVELOPE`), a descriptor
with `classes`, `default` or `key_normalisation` (`E_SCHEMA`), an envelope with `resolved` or
`shadows`, with `E_SHORT_ID_AMBIGUOUS`, or with the faults `E_FORMULA_KEY` and
`E_FORMULA_DISPATCH_KEY` (`E_ENVELOPE`), and it does not know the codes `E_UNROOTED_INPUT` and
`E_NAMESPACE_SUSPENDED`, nor the class vector kinds. Publishers should wait for their consumers to
upgrade before serving a loopback mesh document or a function descriptor with the new members.

- **Loopback URLs for unrooted hosts** (SPEC 9.6, 5.5, 5.6, 2.5). An unrooted host's mesh document
  may use `http://` on exactly `127.0.0.1`, `[::1]` or `localhost`, with an optional port, all its
  URLs on one origin and no https URL beside them; a loopback `poll` or `next` passes only when the
  request names the unrooted mesh asked (`mesh`). Rooted hosts stay https-only. The key document of an
  unrooted host is still supplied out of band.
- **Envelopes** (SPEC 5.5). `EnvelopeResult` gains `resolved` (what a short call resolved: `call`,
  `resolutions` with kinds `alias`, `default`, `method` and `lookup`, `aliases_tx`), `shadows` (a
  class name and its reference class hash) and `error` (the `error` member of `not_covered`,
  `bad_request` and `error` answers). `not_covered` may carry `E_NAMESPACE_SUSPENDED` in `error`.
  `bad_request` may carry `E_SHORT_ID_AMBIGUOUS`. The faults `E_FORMULA_KEY` and
  `E_FORMULA_DISPATCH_KEY` are in `FAULTS`.
- **Codes** (SPEC 10.2). `ERROR_CODES` has 63 entries: `E_UNROOTED_INPUT`, `E_NAMESPACE_SUSPENDED`,
  the eight `E_CLASS_*` codes, `E_KEY_NORMALISATION`, `E_KEY_ENCODING`, `E_SHORT_ID_AMBIGUOUS` and
  `E_DESCRIBE`, in the order of 10.2. None of them is a verification result.
- **Function descriptors** (SPEC 7). A `string` argument may declare `classes` (object keys of those
  classes) and `key_normalisation` (one rule of 16.4; absent means `none`); a valid-time `date` or
  `instant` argument may declare `default: "asof"`; `returns` may be `{"type": "string", "classes": [...]}`.
  Checked in the order 7 gives; no existing function hash changes.
- **Classes** (SPEC 16). `defineClass(descriptor, name, { definer, functions, classes })` checks a class
  descriptor, flattens it onto its parent, checks its methods and interfaces, and returns
  `{ flattened, classHash }`; `classHash(flattened)`; `checkKeyNormalisation(rule, text)` with the
  closed list `KEY_NORMALISATIONS`; `parseObjectKey(encoding)` and `formatObjectKey(object)` (the one
  canonical key encoding); `objectJson(object)`, `objectId(object)` and `shortId(id)`;
  `checkDescribe(answer, classes)` for class and object answers (`E_DESCRIBE`); and
  `checkDefine(descriptor, name)`, the define-time check of a function, with `E_UNROOTED_INPUT` for
  a rooted function that reads an unrooted one (SPEC 2.5). Caller misuse throws `TypeError`.
- Conformance runner: the kinds `class`, `normalisation`, `key`, `describe` and `define`.

## 0.4.3 — spec-0.4.3

Conforms to the Datumesh specification revision `spec-0.4.3` (spec commit `99123b2`): every one of
its 651 verification vectors passes; the 585 formula-evaluator vectors are skipped, as before.
Additions only: no existing function's result changes for anything spec-0.4.2 allowed.

**A mesh that serves `declarations` is unverifiable by clients on core < 0.3.7 or datumesh < 0.4.3; publishers should wait for their consumers to upgrade before declaring.** The same holds for @datumesh/verify < 0.4.3.

Envelopes carrying `E_FOREIGN_UNAVAILABLE` (or its `detail` member) are rejected (`E_ENVELOPE`) by libraries that check the closed code and member lists of `spec-0.4.2`: core < 0.3.7, datumesh < 0.4.3 and @datumesh/verify < 0.4.3.

- **Declarations in the key document** (SPEC 9.2, 4.5). The optional `declarations` member is
  checked in full (names are full function names under the document's own host, a subdomain being
  another host; 1-64 names; 1-16 entries per name; entries of exactly `licence`, `valid_from` and
  optionally a later `valid_to`; `{}` and `[]` rejected); anything malformed rejects the document
  with `E_KEY_DOC`. New: `KeysResult.declarations`, the types `Declarations` and
  `DeclarationEntry`. Verification is unchanged by them.
- **Licence inheritance** (SPEC 8.5): `inheritLicence(licences, declarations, fn, issued,
  meshLicence)` → `{ licence, reason }`, the five steps in order, share-alike conflicts first;
  `licenceTier(licence)` and `LICENCE_TIERS`.
- **Entitlement** (SPEC 10.3): `checkEntitlement(receipt, inputLicences, keyDocument)` →
  `{ entitled, reason, licence }` with the eight reasons; a key document of another host than the
  receipt's `cell.ns` is a `TypeError`. `inputLicences(receipt, receipts, manifests?, keys?)`
  follows the receipt's `inputs` through the receipts and manifests supplied, slice members
  included.
- **`E_FOREIGN_UNAVAILABLE`** (SPEC 5.5, 10.2): appended to `ERROR_CODES`; an `error` envelope
  carrying it must have HTTP 502 and a `detail` (`FOREIGN_DETAILS`), which no other envelope may
  carry; `EnvelopeResult.foreignDetail`. Never a verification result.
- **Unrooted namespaces** (SPEC 2.5): `isUnrooted(namespace)`. No grammar change.
- Conformance runner: the kinds `licence` and `entitlement`, the `keys` output `declarations`.
