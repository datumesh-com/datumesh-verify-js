# Implementation notes for spec-0.5.0 (@datumesh/verify 0.5.0)

For the agent that writes the implementation commit. The tests-first commit is done: the spec
submodule is at `7bed002`, the runner and tests are written and fail. Make them pass without
changing them. If a test seems wrong, stop and report it; do not edit a test to fit code. Read the
spec text for each item (sections below), not the reference tool's source (`spec/tools/canon.py`
may be run as a black box only: `tools/oracle-diff/` shows how). Do not push, tag or publish.

## What exists already

- `src/classes.ts`: **throwing stubs** with the signatures and doc comments of the new API.
  Replace each body. It is exported from `src/index.ts` already.
- `src/index.ts`, `src/errors.ts`, `package.json`, `package-lock.json`: version strings are
  already `0.5.0` and `spec-0.5.0`. `ERROR_CODES` is not yet extended.
- `tools/vector-runner.mjs`: runs the new kinds `class`, `normalisation`, `key`, `describe`,
  `define` (calls the API below). `SKIPPED_KINDS` is unchanged (`formula`, `formula-eval`,
  `excel`, `decimal`, `call`).
- `test/spec-0.5.0.test.mjs` (new), `test/conformance.test.mjs` (counts: 1426 vectors, 778 run,
  648 skipped), `test/fixtures/oracle-probes-0.5.0.jsonl.gz` (838 probes with the reference tool's
  verdicts, from `tools/oracle-diff/probes_0_5_0.py`).
- Old tests edited only where spec-0.5.0 changes what they assert (see "Old tests touched").

## Run

```
npm test                                  # builds, then every test/*.test.mjs
node scripts/run-tests.mjs spec-0.5.0     # one file
npm run conformance                       # tools/check-vectors.mjs: 778/778 expected, 648 skipped
```

## Public API to add (all exported from `src/index.ts`; ESM and CJS builds as now)

Existing style: synchronous, offline; input may be JSON text, UTF-8 bytes or a parsed value;
rule breaks throw `DatumeshError` with a 10.2 code; a caller's misuse (a wrong argument type) throws
`TypeError`, not an `E_` code.

```ts
// src/classes.ts (new file, stubs exist)
KEY_NORMALISATIONS: ['none','upper_ascii','nfc_strict','arabic_skeleton','hebrew_consonantal','greek_unaccented']
defineClass(descriptor, name, env: {definer: string, functions: unknown[], classes: unknown[]})
    : { flattened: string /* canonical bytes as UTF-8 text */, classHash: string }
classHash(flattened): string                       // SHA-256 of canonical bytes; checks it as 16.1 does
checkKeyNormalisation(rule: string, text: string): void   // throws E_KEY_NORMALISATION
parseObjectKey(encoding: string): DecodedObject    // {class, keys:{name: TypedScalar | DecodedObject}}; E_KEY_ENCODING
formatObjectKey(object: DecodedObject): string     // the one canonical encoding, keys sorted by name
objectJson(object): Uint8Array                     // canonical bytes of {class, class_hash, keys}
objectId(object): string                           // SHA-256 hex of objectJson
shortId(id: string): string                        // first 12 hex digits; id must be 64 lowercase hex (E_CANON_HEX)
checkDescribe(answer, classes: {[name]: flattenedDescriptor}): { kind: 'class' | 'object' }  // E_DESCRIBE
checkDefine(descriptor, name): { canonical: Uint8Array, hash: string }   // E_CANON_NAME, descriptor codes, E_UNROOTED_INPUT
```

Also:

- `ERROR_CODES` (src/errors.ts): append, after `E_FOREIGN_UNAVAILABLE`, in this order (63 in all):
  `E_UNROOTED_INPUT, E_NAMESPACE_SUSPENDED, E_CLASS_MEMBER, E_CLASS_PARENT, E_CLASS_INHERIT,
  E_CLASS_OVERRIDE, E_CLASS_FINAL, E_CLASS_METHOD, E_CLASS_INTERFACE, E_CLASS_OWNER,
  E_KEY_NORMALISATION, E_KEY_ENCODING, E_SHORT_ID_AMBIGUOUS, E_DESCRIBE`. The `E_FORMULA_*` codes
  are not in 10.2; they stay out of `ERROR_CODES`.
- `src/envelope.ts`: export `FAULTS` from `src/index.ts` and add `E_FORMULA_KEY` and
  `E_FORMULA_DISPATCH_KEY` to it (and to the `Fault` type). `EnvelopeResult` gains
  `resolved: Resolved | null`, `shadows: Shadows | null` (the parsed members when ok and present, else
  null) and `error: ErrorCode | null` (the `error` member when ok, for `not_covered`, `bad_request`
  and `error`; else null). Set them in `failed()` and every success return, `checkSlicePage` too.
- `Resolved = {call: string, resolutions: {from, kind, to, asof?}[], aliases_tx?: string}`;
  `Shadows = {class: string, reference: string}`.
- `src/mesh.ts`, `src/envelope.ts`: loopback URLs (below).
- `src/validate.ts`: `classes`, `default`, `key_normalisation` on argument declarations and
  `classes` on `returns` (below).
- README and CHANGELOG (spec-0.5.0 compatibility paragraph of SPEC 14 that applies to verifier
  libraries; a client on 0.4.3 rejects a loopback mesh document with `E_MESH_DOC`, a loopback `poll`
  or `next` with `E_ENVELOPE`, and a descriptor with the new members with `E_SCHEMA`), `DEFECTS.md`,
  `scripts/browser-test.sh` need no code change beyond that; the browser entry runs the new kinds
  through the same runner.

## Test-to-item map (contract items; `test/spec-0.5.0.test.mjs`)

| Item | Tests (name starts) | SPEC sections | Vectors / probes |
|---|---|---|---|
| 1 loopback URLs | `item 1: ...` (7 tests) | 9.6 (Loopback URLs), 5.5 (`poll`, step 3a, step 5), 5.6 (`next`, step 2), 9.8, 2.5 | `mesh/unrooted-loopback-*`, `invalid/mesh-*`, `envelope/*-loopback-*`, `invalid/envelope-*loopback*`; probes item 1 (52) |
| 2 codes | `item 2: ...` (4) | 10.2, 5.5, 15.11 | all invalid vectors' codes |
| 3 envelopes | `item 3: ...` (10) | 5.5, 9.9, 16.7, 16.8, 16.9 | 19 new `envelope/*` and `invalid/envelope-*`; probes item 3 (126) |
| 4 function descriptors | `item 4: ...` (7) | 7 (arguments, `classes`, `default`, `key_normalisation`, check order), 10.1 step 7.1 | `function/argument-key-normalisation`, `invalid/function-key-normalisation-*`; probes item 4 (85) |
| 5 classes | `item 5: ...` (11) | 16.1, 16.2, 6.2 | 44 `class` vectors; probes item 5 (137) |
| 6 key normalisation | `item 6: ...` (4) | 16.4, 3.5 | 17 `normalisation` vectors; probes item 6 (118) |
| 7 object keys | `item 7: ...` (5) | 16.5, 16.8 (short ids), 3.1-3.5 | 11 `key` vectors; `describe/object` for ids; probes item 7 (78) |
| 8 describe | `item 8: ...` (6) | 16.8, `schemas/describe-class.schema.json`, `schemas/describe-object.schema.json` | 8 `describe` vectors; probes item 8 (116) |
| 9 define | `item 9: ...` (4) | 2.5, 2.3, 7 | 7 `define` vectors; probes item 9 (126) |
| 10 runner | `item 10: ...` (4), `conformance.test.mjs` | 11 | all 1426 |

The probes are the reference tool's verdicts on small mutations of the vectors. Where a probe
disagrees with your reading of the text, the vectors and the text win and the case is a spec defect
to report (DEFECTS.md); do not special-case it.

## What the tests need beyond the vectors (read the spec section; these are the traps)

1. **Loopback (9.6).** For an unrooted host (last label `invalid`; `isUnrooted` exists), every URL
   of its mesh document (`bindings` included) is either on `https://<host>` or on one loopback
   origin: `http://` + exactly `127.0.0.1`, `[::1]` or `localhost` (lowercase) + optional `:port`
   (1-65535, no leading zeros) + `/` + printable ASCII, at most 512 characters in all. One origin for
   the whole document (same name and port). A rooted host: any loopback URL is `E_MESH_DOC`. Any
   `http://` on another address is `E_MESH_DOC` for every host. The key document is never loopback
   (nothing to change: `keysFromResponse` takes no URL). `poll` (5.5) and `next` (5.6): a loopback
   URL passes only when the request names a `mesh` that is unrooted, and only then; with no `mesh`
   given, only a DNS-name host passes as before; a `https://<unrooted host>/...` poll or next still
   passes. The path rules are unchanged (`/jobs/<job>` with this envelope's job, a query right after
   the host stays `E_ENVELOPE`).
2. **Envelope members (5.5).** `resolved` and `shadows` are optional on `ok`, `stale`,
   `not_covered`, `unlicensed`, `payment_required`, `error` only (the table). `resolved`: exactly
   `call` (non-empty string), `resolutions` (array, may be empty), optionally `aliases_tx` (an
   instant); a resolution has exactly `from`, `kind`, `to` (strings), `kind` in `alias`, `default`,
   `method`, `lookup`; a `lookup` resolution also has `asof` (an instant) and no other kind may.
   `shadows`: exactly `class` (a class name, 2.3) and `reference` (64 lowercase hex).
   `not_covered` may carry `error` `E_NAME_UNBOUND` or `E_NAMESPACE_SUSPENDED` only, never with
   `fault`. `fault` may now be `E_FORMULA_KEY` or `E_FORMULA_DISPATCH_KEY`.
3. **`error` outcome codes.** The reference tool and the vectors agree: an `error` envelope carries
   any code of 10.2 except `E_ENVELOPE`, `E_JOB_UNKNOWN`, `E_SLICE_AT_CELL`, `E_NAME_UNBOUND`,
   `E_UNROOTED_INPUT`, `E_NAMESPACE_SUSPENDED`, the eight `E_CLASS_*` codes, `E_SHORT_ID_AMBIGUOUS`
   and `E_DESCRIBE` (and `E_FOREIGN_UNAVAILABLE` needs 502 and `detail`, as since 0.4.3). So
   `E_KEY_NORMALISATION` and `E_KEY_ENCODING` are accepted. SPEC 5.5's sentence names only the first
   two new exclusions; the tests follow the reference tool (see "Unclear in the spec").
   `bad_request` accepts, besides the parse codes, `E_CANON_HEX` and `E_SLICE_AT_CELL`,
   `E_SHORT_ID_AMBIGUOUS`.
4. **Descriptor members (7).** `key_normalisation` on a `string` argument without `classes`: one of
   the five rules (not `none`). Absent member = none, so a written `"none"` is `E_SCHEMA`, and so is
   any string, or a non-string, that is not a rule (checked in the structure pass, before types).
   On a non-string argument, or a string with `classes`, it is `E_CANON_TYPE` (when it is a valid
   rule). `classes` (string arguments and `returns`): non-empty array of class names (`E_CANON_NAME`
   per name, then `E_CANON_SET` for empty, unsorted or duplicate; a non-array or non-string entry is
   `E_SCHEMA`); on another type `E_CANON_TYPE`; on `returns` with another type `E_CANON_TYPE`, with a
   `unit` `E_CANON_UNIT`. `default`: only `"asof"` (else `E_SCHEMA`), only on `date` or `instant`
   arguments with `valid: true` (else `E_CANON_TYPE`). Within an argument the order is `type`, `unit`,
   `valid`, `classes`, `default`, `key_normalisation`, `extent`. No existing descriptor's hash
   changes; step 7.1 of `verify` accepts the members (a receipt test signs one with the vector's
   key).
5. **Classes (16.1, 16.2).** Follow the check order literally: define: name (`E_CANON_NAME`), owner
   (`E_CLASS_OWNER`: the definer's namespace is the class name's), descriptor structure over the whole
   (`E_SCHEMA`), then keys (count `E_CANON_LIMIT`, each key in JCS order: name `E_CANON_ARG_NAME`,
   declaration; a `{"class"}` declaration has no other member), `order` (`E_CANON_SET`), `methods`
   (names `E_CANON_NAME`, hashes `E_CANON_HEX`), `steward`, `parent`, `open`, `maps`, `inverse`,
   `lookup`, `extent`, `implements` (the 16.1 member rules, `E_CLASS_MEMBER`); then 16.2 step 3
   (parent known: `E_CLASS_PARENT`; no redeclared key: `E_CLASS_INHERIT`; flatten), 4 (overrides:
   `E_CLASS_FINAL`, `E_CLASS_OVERRIDE`), 5 (the flattened descriptor checked again), 6 (methods in JCS
   order: the function descriptor is in `env.functions` found by hash, has `order`, first arguments are
   the keys in class order with the same type and unit and, for a string key, exactly the key's
   `key_normalisation` with absent = none; a class-typed key is a `string` argument with
   `"classes": [<that class>]`; `same_as` and `by_<attribute>` returns; `E_CLASS_METHOD`; the `lookup`
   method is exempt and has its own signature check), 7 (`extent`), 8 (interfaces,
   `E_CLASS_INTERFACE`). A `lookup` naming no method is `E_CLASS_MEMBER`; one naming a method that takes the class keys
   (instead of one `label`) is `E_CLASS_METHOD` (the method check of step 6 comes first); the vectors
   `invalid/class-lookup-*` and `class/lookup` and the probes pin the rest. `env.classes` holds
   flattened descriptors, found by class hash. Flattening: keys = parent's then own, `order` = parent's
   then own, `methods` = parent's overlaid by own, `implements` = union, other members the class's own,
   `parent` kept, no empty or false optional members. The class hash is the hash of the canonical bytes
   of the flattened descriptor; the name is not in it. `flattened` is that canonical text.
6. **Key normalisation (16.4).** Pure check by code point, table in 16.4. Every rule but `none`
   rejects the empty string and a non-NFC value. `nfc_strict`: "no space other than U+0020" means
   Unicode White_Space too: tab and line feed are rejected (the reference tool does; probes pin it);
   NUL (Cc, not Cf, not a space) is accepted. `upper_ascii`: U+0021-U+007E, no `a`-`z`. Unicode data:
   the library has `src/unicode-data.ts` (15.1) and `src/unicode.ts`; reuse them for Cf, NFC and NFD.
   An unknown rule throws (any error; the reference says `E_CLASS_MEMBER`).
7. **Object keys (16.5).** Grammar in 16.5; every deviation `E_KEY_ENCODING`. Class name: a full
   name (2.3; may have a path: `a.example.org/k/m` is accepted). Key names: argument names (2.4; so
   `asof` and uppercase are refused), strictly ascending, no spaces. Values: a string in quotes with
   `""` doubled (3.5, at most 1024 bytes, NFC, no controls), a number (3.1 lexical form: `1.50`, `01`,
   `+1`, `-0`, `.5`, `1e3` refused), a date, an instant (exact 3.3 forms), `true`/`false`, or a
   nested encoding (unquoted). A quoted nested encoding is a string. `decoded` has `{type, value}`
   scalars (number `value` a string, boolean a JSON boolean) and nested `{class, keys}`.
   `objectJson`: the object `{"class","class_hash","keys"}` with scalar keys as `{type,value}`; throw
   `DatumeshError` for a malformed object (the code is yours; the tests accept any).
8. **Describe (16.8).** Schemas in `spec/schemas/describe-*.schema.json`. Class answer: exactly
   `kind`, `class`, `class_hash`, `descriptor`, `methods`; `descriptor` is a valid flattened class
   descriptor; `class_hash` its hash; `methods` has exactly the descriptor's method names, each exactly
   `fn` (`<class>/<method>`), `fn_hash` (the descriptor's hash for it), `args`, `returns`, optionally
   `description` (string, at most 1024 UTF-8 bytes). Object answer: exactly `kind`, `object`,
   `object_id`, `short_id`, `call`, `methods`, optionally `same_as` (non-empty array of key encodings);
   `object_id` = objectId(`object`), `short_id` its first 12 digits, `call` = class name + keys labelled
   in ascending order `name: <literal>` with `, ` between (the vector shows the exact form: strings
   quoted, numbers bare), `methods` ascending and unique. A held class (found by the object's
   `class_hash` in `classes`) also checks the object's keys (names, types) and `methods` against it; an
   unheld class is checked on its own only. The reference does not check `args` and `returns` against
   anything, nor `same_as` order or duplicates.
9. **Define (2.5).** `checkDefine(descriptor, name)`: name first (`E_CANON_NAME`: a full function
   name, 2.3), then the descriptor as `canonicalize(d, 'function')` does (every one of its codes), then,
   for a name whose host is rooted (last label not `invalid`), the first input in `inputs` order whose
   host is unrooted: `E_UNROOTED_INPUT`. An unrooted function reads anything. `canonicalize` and
   `verify` do not check it. Formula bodies are not checked.

## Old tests touched (spec-0.5.0 changes what they assert)

- `test/api.test.mjs`, `test/spec-0.4.0.test.mjs`: `ERROR_CODES.length` no longer pinned to 49
  (>= 49; the new test pins 63). `SPEC_VERSION` and `VERSION` are `spec-0.5.0` / `0.5.0`.
- `test/spec-0.4.2.test.mjs`, `test/spec-0.4.3.test.mjs`: the position of the last code of those
  revisions is looked up, not taken from the end of the list. The 0.4.3 version-strings test moved to
  `spec-0.5.0.test.mjs`.
- `test/envelope.test.mjs`: counts (162 envelope vectors, 141 outside the slice endpoint); the `error`
  and `bad_request` code loops know the new codes (`NOT_IN_ERROR_ENVELOPE`; `E_SHORT_ID_AMBIGUOUS` is
  a `bad_request` code).
- `test/conformance.test.mjs`: 1426 vectors, kinds, counts.
- `scripts/package-test.sh`: the submodule commit `7bed002`, `"spec": "spec-0.5.0"`.
- The frozen probe fixtures of earlier revisions (`oracle-probes-0.4.*.jsonl.gz`) hold the reference
  tool's verdicts of the time. If an old probe's verdict changes under spec-0.5.0 (a loopback `poll`
  was `E_ENVELOPE`), the old test fails: report which, do not edit the fixture without a note.

## Unclear in the spec (for DEFECTS.md)

1. **5.5, `error` codes.** The text excludes only `E_ENVELOPE`, the three request codes and the
   define and write codes `E_UNROOTED_INPUT` and `E_NAMESPACE_SUSPENDED`. The reference tool and
   `invalid/envelope-short-id-in-error` also refuse `E_SHORT_ID_AMBIGUOUS`, `E_DESCRIBE` and the eight
   `E_CLASS_*` codes in an `error` envelope. The tests follow the tool.
2. **16.4, `nfc_strict`.** "No space other than U+0020": the reference rejects tab and newline too (a
   space is any White_Space character). Say so.
3. **16.4, a rule outside the closed list** given to the pure check: not said. The reference reports
   `E_CLASS_MEMBER`.
4. **16.8, `checkDescribe` and held classes.** The reference finds a held class by the object's
   `class_hash`, not by name, and checks an object answer's `call` even for an unheld class. Not stated.
5. **16.5, `objectJson` and nested keys.** The object JSON has "each key a typed scalar" but a
   class-typed key is a nested object in the `key` vectors' `decoded` and a string (its encoding) as a
   cell argument; the form of a class-typed key inside the object JSON (and so the object id of a
   nested object) is not given. The tests cover scalar keys only.
6. **16.2 step 6 and D93.** A `lookup` that names a method whose function takes the keys is reported by
   the reference as `E_CLASS_METHOD` (the method check), although 16.1 says `E_CLASS_MEMBER` for a
   lookup signature; the vector `invalid/class-lookup-signature` (one string argument `label` missing)
   gives `E_CLASS_MEMBER`.

## Re-pin to c8896ad

The spec submodule moved from `7bed002` to `c8896ad` (`6d5633e` plus 8 formula-evaluator vectors; no
existing vector changed). 1474 vectors: **818** for a verifier library (was 778), **656** skipped (was
648). New for a library: 40 vectors (`describe` 4 valid and 12 invalid, `envelope` 2 and 2, `key` 2 and
4, `normalisation` 1 and 6, `function` 4 invalid, `class` 1 invalid); the other 8 are `call`/`formula`/
`formula-eval`, skipped. Read SPEC 14 "Library findings (verifier libraries, spec-0.5.0)", 16.4, 16.5 and
16.8 again; the tests below are derived from that text. Do not edit a test to fit code: report it.

Tests are in `test/spec-0.5.0.test.mjs` (section "Re-pin to spec c8896ad", names start `re-pin N:`).
"Fails now" is the state at the tests-first commit.

| Point | Test (`re-pin N: ...`) | SPEC | Fails now |
|---|---|---|---|
| 1 key codes are `bad_request` | `1: the four key-code envelope vectors`; `1: the key codes are bad_request codes at 400, and in no other outcome`; `1: bad_request carries exactly the parse codes, ... and the two key codes` | 5.5, 5.8, 10.2 | yes: `checkEnvelope` refuses them in `bad_request`, accepts them in `error` |
| 2 exact list refused in `error` | `2: an error envelope carries every code of 10.2 except exactly the 18 listed`; `2: the invalid error-envelope vectors of the list` | 5.5, 10.2 | yes: the two key codes pass in `error` (E_FOREIGN_UNAVAILABLE stays allowed, status 502 and `detail`) |
| 3 string value first (16.4) | `3: the normalisation vectors of c8896ad`; `3: under every rule a key value is first a string value (3.5)`; `3: ... over 1024 bytes is E_CANON_LIMIT`; `3: none accepts every string valid by 3.5, the empty string included`; `3: nfc_strict refuses each Unicode 15.1 White_Space character but U+0020` | 16.4, 3.5 | yes: `none` accepts tab, NUL, NFD and 1025 bytes; a control character under `nfc_strict` is `E_KEY_NORMALISATION`, not `E_CANON_STRING` |
| 4 unknown rule, empty `classes` | `4: the four function vectors and the class-lookup vector`; `4: on a function argument an unknown rule is E_SCHEMA ...`; `4: an empty classes ... is E_CANON_SET`; `4: in a class key an unknown rule is E_CLASS_MEMBER; none is a rule there` | 16.1, 7 | no: pins what the library does already |
| 5 describe check, six steps | `5: all 24 describe vectors`; `5: step 1, parse`; `5: step 4, the held class is found by class_hash`; `5: step 4, a client holding no class stops after step 3`; `5: step 5, an object answer against the held class`; `5: step 5 and 6, args and returns ... only ... the method functions the client holds`; `5: step 2, a description is 1 to 1024 bytes`; `5: step 2, same_as is ascending and unique`; `5: a class-typed key in an object answer ...` | 16.8, 16.5 | yes, except steps 1 and 4 (already so). `checkDescribe(answer, classes, functions?)` takes the method functions as an optional third argument (an array of function descriptors, as a `describe` vector's `functions`); `args` and `returns` are compared only for a method whose descriptor is held (found by `fn_hash`); `description` empty is `E_DESCRIBE`; `same_as` unsorted or duplicated is `E_DESCRIBE`; an object answer's keys are checked against the held class (names, types, normalisations); a class-typed key is a string scalar |
| 6 class-typed key in the object JSON | `6: the key vectors given class_hash have object and object_id ...`; `6: the object JSON holds a class-typed key as the typed string scalar of its encoding`; `6: a nested object's id` | 16.5 | yes: `objectJson` raises `E_SCHEMA` on a nested key. The tests call `objectJson` / `objectId` with a **decoded key plus `class_hash`**, `{...parseObjectKey(enc), class_hash}`, nested objects allowed, each nested key written as `{"type": "string", "value": <formatObjectKey(nested)>}`; the runner (`tools/vector-runner.mjs`, kind `key` with `class_hash`) does the same and outputs `object` and `object_id`. The JSON form (typed scalars only) keeps working |
| 7 encoding at most 1024 bytes | `7: the key vectors of c8896ad`; `7: an encoding is one string value: 1024 bytes as a whole ...`; `7: every failure to decode is E_KEY_ENCODING` | 16.5 | yes for the whole-length bound and the 4 invalid vectors (a string in an encoding that is NFD or holds a control character, a calendar-invalid date, over-length); the rest passes already |
| 8 `shortId` of a malformed id | `8: shortId of a string that is not 64 lowercase hex digits is E_CANON_HEX` | 16.8 | no: pins what the library does already |

Old tests changed (they asserted the 6d5633e-era behaviour or the old counts):
- `test/conformance.test.mjs`: 1474 vectors, 818 run, 656 skipped; `class` (12, 33), `normalisation`
  (9, 15), `key` (7, 10), `describe` (6, 18), `call` (20, 31), `envelope` (64, 104).
- `test/envelope.test.mjs`: counts (168 envelope vectors, 147 outside the slice endpoint); the two key
  codes are `bad_request` codes and in `NOT_IN_ERROR_ENVELOPE`.
- `test/spec-0.5.0.test.mjs`: the commit and count (`c8896ad`, 1474); the vector counts in the item 5-8
  titles; the item 3 `error`/`bad_request` code lists; item 6 `each rule of the closed list`: a control
  character or a non-NFC string is `E_CANON_STRING` under every rule (3.5 first), and U+05C8 (unassigned
  in Unicode 15.1) is no longer a valid `hebrew_consonantal` value; item 10: `OUTPUTS.key` is
  `decoded`, `object`, `object_id`.
- `tools/vector-runner.mjs`: `describe` passes `v.functions` as the third argument; `key` with
  `class_hash` outputs `object` and `object_id` (`OUTPUTS.key` lists all three; a vector without them
  compares undefined with undefined).
- `scripts/package-test.sh`: the submodule commit `c8896ad`.

Open points of the spec, not decided by the tests (listed in the report):
- A rule outside the closed list given to the pure `checkKeyNormalisation(rule, text)`: 16.4 says
  `E_CLASS_MEMBER` in a class key and `E_SCHEMA` on a function argument, not for the bare check. The
  tests only require an error (`item 6: the check is pure`).
- The API shapes for the third argument of `checkDescribe` and for `objectJson`/`objectId` of a decoded
  key (above) are the tests' choice; the text gives the vectors' fields, not the signatures.
- 16.8 step 5 does not say whether the answer's `class` name is compared with a held class's name; the
  tests do not look at it (the held class is found by hash).
