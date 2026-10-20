# Places where SPEC.md was insufficient

Two sections: `spec-0.2.0` (entries 19-34, this release) and `spec-0.1.1` (entries 1-18). Entries
that a later spec commit resolved say so in their heading; their text is kept as written.

Found while implementing `@datumesh/verify` from SPEC.md and `vectors/` only. The source of
`tools/canon.py`, `tools/gen_vectors.py` and `tests/` was never read. Where the text left a
question open, I ran `tools/canon.py check` as a black box (probe vectors marked invalid with a
dummy code, so it prints the code it actually produces). `scripts/oracle-diff.sh` repeats this
at scale. Each entry gives the section, what was missing, how I resolved it, and proposed
wording.

**Rule I applied:** where SPEC.md states something explicitly, I follow SPEC.md even when the
reference tool differs (entries 1 and 2: the library and the reference tool disagree there).
Where SPEC.md is silent or ambiguous, I follow the reference tool. Every vector passes either way.

Each entry is marked as a **conflict** (prose and reference tool disagree, or prose and a vector
disagree), a **gap** (the prose does not decide the question), or **underspecified** (the rule
exists but its exact form had to be inferred).

---

# spec-0.2.0

Found while bringing the library from `spec-0.1.1` to `spec-0.2.0` (spec commit `0c7accc`), from
SPEC.md, `units.md`, the schemas and the 290 vectors only. As before, `tools/canon.py`,
`tools/gen_vectors.py` and `tests/` (including `tests/data/`) were not read, and no diff of them
was looked at. The reference tool was run as a black box: batches of probe vectors, plus
`MODES=cases bash scripts/oracle-diff.sh` (`tools/oracle-diff/cases-0.2.mjs`: about 6,000-8,500
hand-written and mutated unit, descriptor, blob and envelope cases per run). In the last runs the
library and the reference tool agreed on every one of them. The same rule applies as for
`spec-0.1.1`: follow the prose where it is explicit, and the reference tool where it is silent.
Entries 1-18 below were re-checked against `0c7accc` and still apply. Entries 1 and 2 are still
the only places where the library and the reference tool disagree (12 of 2,000 random URI
mutations in the last run).

Every vector could be reproduced from the spec text plus the vectors. The entries below list what
had to be inferred.

## Status at spec commits `2a77580` and `240a830`

The spec moved to `2a77580`, which took up most of the entries below, then to `1400247` and
`240a830` (the target now). Re-checked against the `240a830` text, 319 vectors and the reference tool (all four modes of `scripts/oracle-diff.sh` now agree on
every case, URIs included):

| Entry | Status at `2a77580` | Where the new text differs from what I had inferred |
|---|---|---|
| 1, 2 | Resolved (5.1, 5.4 step 1); the tool now agrees with the library | — |
| 3 | Resolved (10.1 step 7.5) | — |
| 8 | Partly: 5.5 now spells out the licence URL rule for `authorise`; 8.1 itself still has no grammar | — |
| 19 | Resolved (units.md 3) | The cell is checked before the descriptor's structure, not after: `resolvedUnit(5, cell)` is now `E_FN_HASH_MISMATCH`, not `E_SCHEMA`. Library changed. |
| 20, 21, 22, 30, 31 | Resolved | — |
| 23 | Resolved (units.md 2.4: year `0000`, and the 64-character limit is `E_CANON_UNIT`) | — |
| 24 | Resolved (5.5, schema `enum`) | `E_ENVELOPE` may no longer be sent in `error`; `bad_request` carries only URI parse codes. Library changed. |
| 25, 27 | Resolved (5.5 step 2) | — |
| 26 | Resolved (5.5 "Integer members") | The text decides: `30.0`, `3e1`, `-0` are now `E_ENVELOPE`. The strict parser now keeps each number's source text so the envelope check can see it. Library changed. |
| 28 | Resolved (10.1 step 7.7) | Content for a non-blob value is now `E_SCHEMA` instead of being ignored, and results gain `blob_checked` (`VerifyResult.blobChecked`). Library changed. |
| 29 | Resolved (5.4): `parse` does not validate the signature | Library changed to match: see entry 34 for what is left open. |
| 32 | Open (note only) | — |

New at `2a77580`: entries 33 and 34. At `1400247` the blob receipt vectors gained
`blob_checked` (entry 33 resolved), and 5.5 now says a malformed request description is the
caller's error, which is what the library already did (`TypeError`). At `240a830` a `stale`
receipt's `asof` must be at or before the requested `asof` instead of equal to it (D31); library
changed, with tests for both sides of the boundary.

## 33. Conflict: `blob_checked` is in section 11 but not in the vectors (11) [resolved at 1400247]

- **Problem.** Section 11 says a receipt vector with `blob_hex` outputs `blob_checked` (true),
  and `schemas/vector.schema.json` defines the field. But none of the 317 vector files carries
  it: `receipt/blob-value` and `receipt/blob-value-recomputed` have `blob_hex` and no
  `blob_checked`. A conformance runner that compares "exactly the section 11 fields" with the
  files therefore cannot pass both ways.
- **Resolution.** The runner outputs `blob_checked` for every receipt vector that has `blob_hex`
  (section 11). `tools/check-vectors.mjs` compares it with the file when the file has the field,
  and otherwise requires `true` exactly when `blob_hex` is given.
- **Proposed fix.** Add `"blob_checked": true` to the valid receipt vectors with `blob_hex`.

## 34. Gap: what `parse` does with a signature that is not a signature (5.4)

- **Problem.** 5.4 now says the signature "is taken as given" and not checked. It does not say
  what happens when it cannot be used: a declaration without `type`, with a non-string `type`,
  with an unknown type name, or not an object. The reference tool reports an unknown type name
  as `E_CANON_TYPE` and a non-string `type` as `E_SCHEMA`, both only when a value is read for
  that argument (a slice `*` passes), after its percent-decoding. On a declaration without
  `type`, or one that is not an object, it crashes (a Python `KeyError`/`TypeError` traceback;
  that traceback is the only part of the tool's source I saw, and only as crash output).
- **Resolution.** As the tool where it answers. Where it crashes, the library reports `E_SCHEMA`
  (the declaration has no string `type`), also only when a value is read. A signature that is not
  an object with an `args` object is a programmer error (`TypeError`). These cases are left out of
  `tools/oracle-diff/cases-0.2.mjs`, because the tool crashes on them.
- **Proposed wording (5.4).** "Only the declared types of the arguments in the URI are used,
  when their values are read: a declaration whose `type` is missing or not a string is `E_SCHEMA`,
  an unknown type name `E_CANON_TYPE`. Nothing else in the signature is examined."

## 19. Gap: resolving a unit checks the descriptor against `cell.fn_hash` (7.1, units.md 3, 10.2) [resolved at 2a77580]

- **Problem.** Neither 7.1 ("Resolution") nor units.md section 3 says that the descriptor used to
  resolve a unit must be the cell's function. Yet `vectors/invalid/unit-fn-hash-mismatch.json`
  expects `E_FN_HASH_MISMATCH`, a code that 10.2 lists only for step 7. Nothing says in which
  order the descriptor and the cell are checked either.
- **Resolution (vector, then reference tool).** `resolvedUnit(descriptor, cell)` checks, in
  order: the descriptor's structure (step 2 rules for a descriptor), the cell's structure, the
  cell's canonical form, `SHA-256(JCS(descriptor)) == cell.fn_hash` (`E_FN_HASH_MISMATCH`), the
  descriptor's canonical form, then resolves. So a cell with a bad `ns` and a descriptor that is
  not an object gives `E_SCHEMA`, while a cell with a bad `ns` and a non-canonical, mismatching
  descriptor gives `E_CANON_NAME`. The cell may be a slice (4.4); it may not be a reference
  (no `fn_hash`) or carry `asof` (`E_SCHEMA`).
- **Proposed wording (units.md 3, first paragraph).** "The descriptor must be the cell's
  function: its function hash equals `cell.fn_hash` (`E_FN_HASH_MISMATCH`). The descriptor's
  structure is checked first, then the cell (structure, then canonical form), then the hash,
  then the descriptor's canonical form." And add "unit" to the Step column of
  `E_FN_HASH_MISMATCH`, `E_ARG_MISSING`, `E_ARG_TYPE` and `E_SLICE` in 10.2 (see entry 20).

## 20. Gap: which cell arguments unit resolution looks at, and with which codes (7.1, units.md 3) [resolved at 2a77580]

- **Problem.** units.md 3 says a referenced argument "resolves to that argument's value in the
  cell" and that a slice cannot be resolved (`E_SLICE`), but not what happens when the referenced
  argument is missing or has another type than `string`, nor whether the cell's other arguments
  must match the signature (exactly the declared ones, with the declared types, as in 10.1 steps
  7.2). It also does not say in which order the two sides of a rate are resolved.
- **Resolution (reference tool).** Only referenced arguments are looked at. A cell with an
  argument missing, an undeclared argument, a wrongly typed argument or a slice that the unit
  does not reference still resolves (fx_rate with `date` missing gives `USD/EUR`). For each
  reference, `of` before `per`: a missing argument is `E_ARG_MISSING`, a slice `E_SLICE`, a
  typed scalar whose type is not `string` `E_ARG_TYPE`, and a value that is not a literal unit
  (on a rate side: not a currency code) `E_CANON_UNIT`. So `quote: "*"` with `base: "kg"` is
  `E_SLICE`, and `quote: "kg"` with `base: "*"` is `E_CANON_UNIT`. A plain reference may resolve
  to any literal unit, an index unit included; `"USD/EUR"` as an argument value is not a unit.
  A function that does not return a number gives null whatever its cell holds.
- **Proposed wording (units.md 3).** "Only the arguments the return unit references are used,
  in the order `of`, `per`. For each: not bound, `E_ARG_MISSING`; a slice marker, `E_SLICE`; not
  of type `string`, `E_ARG_TYPE`; a value that is not a literal unit of section 2 (on a rate side,
  not a currency code of 2.1), `E_CANON_UNIT`. Other arguments of the cell are not checked."

## 21. Underspecified: which unit rules belong to step 2 and which to step 3 (7, 7.1, 10.1) [resolved at 2a77580]

- **Problem.** Section 7 lists the unit failures (`E_CANON_UNIT`) and the shape failures
  (`E_SCHEMA`) side by side, and 10.1 orders steps 2 and 3 only for receipts. For a descriptor
  with both kinds of failure in different places it is not said which is reported. It is also
  not said whether "a `returns` object whose type is not `number`" is checked before or after the
  type name itself (`{"type": "bogus", "unit": "1"}`), nor that the "within a declaration"
  order applies to `returns`.
- **Resolution (reference tool).** As for the other kinds (entry 5), the whole descriptor is
  checked for structure (step 2, `E_SCHEMA`) before anything else. Step 2 now covers: a
  declaration has `type` and `valid` and optionally `unit` (nothing else; `type` a string,
  `valid` a boolean); `returns` is a string or an object with `type` (a string) and optionally
  `unit`, nothing else; and every `unit` has one of the shapes of units.md 1, a rate side being a
  string or `{"arg": <string>}` (a nested rate, a number or `{"arg": 5}` is `E_SCHEMA`). So a
  descriptor with `unit: "usd"` on an argument and `unit: 1` on its return gives `E_SCHEMA`. In
  step 3, per argument in JCS order: the name, `type` (`E_CANON_TYPE`), `unit` (`E_CANON_UNIT`),
  `valid` (`E_CANON_TYPE`); then `returns`: a bare string is a type name (`E_CANON_TYPE`) and not
  `number` (`E_CANON_UNIT`); an object's `type` is a type name (`E_CANON_TYPE`), is `number`
  (`E_CANON_UNIT`, also for `{"type": "blob"}`), and has a valid `unit` (`E_CANON_UNIT`).
- **Proposed wording (7, after the unit bullet).** "Shapes are checked with the structure of the
  descriptor, before any other rule: a declaration with members other than `type`, `unit`,
  `valid`, a `returns` object with members other than `type` and `unit` or without `type`, and a
  unit of any other shape than in units.md 1 are `E_SCHEMA`. Then, per argument: `type`, `unit`,
  `valid`; then `returns`: `type`, then that it is `number`, then `unit`."

## 22. Underspecified: argument references to names that are not argument names (7.1, schemas) [resolved at 2a77580]

- **Problem.** 7.1 says a reference names "an argument of the same signature of type `string`";
  `schemas/defs.schema.json` makes `arg` an `argName`. Whether `{"arg": "Bad"}` or
  `{"arg": "asof"}` is `E_CANON_ARG_NAME`, `E_SCHEMA` or `E_CANON_UNIT` is not said. Nor is what
  happens when the referenced argument's own declaration is invalid.
- **Resolution (reference tool).** `arg` must be a JSON string (else `E_SCHEMA`); its content is
  only looked up. A name that is not an argument of the signature, whatever its spelling, is
  `E_CANON_UNIT`. The reference looks only at the named declaration's `type`: if `a` (a number
  argument with `unit: {"arg": "b"}`) sorts before `b` (declared `"type": "bogus"`), the result
  is `E_CANON_UNIT` at `a`, not `E_CANON_TYPE` at `b`. A `valid: true` string argument may be
  referenced. The schema and the reference tool disagree here only on which failure is reported.
- **Proposed wording (7.1).** "A reference whose `arg` is not the name of a `string` argument of
  the same signature, including a name that is not a valid argument name, is `E_CANON_UNIT`."

## 23. Underspecified: index units (units.md 2.4, Appendix A) [resolved at 2a77580]

- **Problem.** units.md gives the index grammar and "at most 64 characters", but no error code
  for a too-long index unit (4.5 would suggest `E_CANON_LIMIT`), and does not say that year `0000`
  is excluded (it refers to 3.2, which does say so).
- **Resolution (reference tool; consistent with `unitLiteral` in the schema).** Every failure
  of an index unit, the 64-character limit included, is `E_CANON_UNIT` (`index:2015=` followed
  by 54 digits is 65 characters and fails; 53 digits pass). The period is a real year, month or
  day from `0001` to `9999` (`index:2016-02-29=100` passes, `index:2015-02-29=100` and
  `index:0000=100` fail). The value is a canonical number greater than zero (`0.5` passes; `0`,
  `-1`, `100.0`, `0100`, `.5` fail).
- **Proposed wording (units.md 2.4).** "Every failure, including the length limit, is
  `E_CANON_UNIT`."

## 24. Conflict: envelope `error` codes (5.5, `schemas/envelope.schema.json`) [resolved at 2a77580]

- **Problem.** 5.5 says `error` is "a code from 10.2", and `invalid/envelope-error-unknown-code`
  expects `E_ENVELOPE` for `E_TEAPOT`. The schema accepts any string matching `^E_[A-Z_]+$`, so
  a schema-validating client accepts `E_TEAPOT`. It is also unclear whether `E_ENVELOPE` itself,
  or a code that only a client can produce (`E_KEY_UNAVAILABLE`, `E_PARSE_URI`), may be sent.
- **Resolution (vector, then reference tool).** Exactly the 41 codes of the 10.2 table, all of
  them, `E_ENVELOPE` included. `OK`, the empty string and anything else is `E_ENVELOPE`.
- **Proposed wording (5.5).** "`error`: one of the codes of the table in 10.2." And make the
  schema an `enum` of those codes.

## 25. Gap: what "a receipt object" means in step 2 of the envelope check (5.5) [resolved at 2a77580]

- **Problem.** Step 2 checks members "against the table and the rules above (`E_ENVELOPE`)",
  and the rule for `receipt` is "a receipt object (section 8)". Step 4 then verifies "with that
  procedure's codes". So a receipt that is missing a member could be `E_ENVELOPE` (step 2) or
  `E_SCHEMA` (step 4). The only vector, `envelope-tampered-receipt`, has a well-formed receipt.
- **Resolution (reference tool).** Step 2 checks only that `receipt` is a JSON object. Everything
  else about it, structure included, is step 4 with the receipt's own codes (`E_SCHEMA`,
  `E_CANON_NAME`, `E_KEY_UNAVAILABLE`, ...). Because step 3 comes first, an envelope with a broken
  receipt and the wrong status is `E_ENVELOPE`.
- **Proposed wording (5.5, step 2).** "...`receipt` must be a JSON object; it is checked as a
  receipt only in step 4."

## 26. Underspecified: integral JSON numbers in envelopes (5.5, 6.1) [resolved at 2a77580]

- **Problem.** `age_seconds` and `retry_after_seconds` are "JSON numbers with integral values".
  It is not said whether `1.0`, `1e2` or `-0` qualify (they have integral values), nor whether
  "integral" refers to the text or to the parsed double. A parsed double cannot tell: under 6.1
  the text `9007199254740990.6` parses to the integer 9007199254740991, and `1e-400` underflows
  to 0.
- **Resolution (reference tool).** The parsed value counts: `1.0`, `1e2`, `1.5e1`, `-0`,
  `9007199254740990.6` and `1e-400` are accepted; `1.5`, `true`, `"5"`, `null`, `-1` and
  `9007199254740992` are `E_ENVELOPE`; `1e400` is `E_PARSE_JSON`. This library does the same
  (`Number.isInteger` on the strictly parsed double).
- **Proposed wording (5.5).** Either "a JSON number written as `0` or a non-zero digit followed
  by digits, at most 2^53 - 1 (`E_ENVELOPE` for any other spelling)", which is unambiguous, or
  state that the value after parsing as an IEEE 754 double (6.1) is what must be integral.

## 27. Underspecified: the rules `reason`, `superseded_by` and `quote` refer to (5.5, 8.1) [resolved at 2a77580]

- **Problem.** `reason` "follows the string rules (3.5) with the `summary` limit", `superseded_by`
  is a receipt hash (6.3, `E_CANON_HEX`), `quote.amount` "a number in the form of 3.1", and
  `quote.authorise` "an `https://` URL in the form of a licence URL (8.1)", for which 8.1 gives no
  grammar (entry 8). Since those sections carry their own codes (`E_CANON_STRING`,
  `E_CANON_LIMIT`, `E_CANON_HEX`, `E_CANON_NUMBER`), it is not obvious that the code is
  `E_ENVELOPE` (D30 says so only in the rationale).
- **Resolution (reference tool).** Every such failure is `E_ENVELOPE`; the library puts the
  inner code into `detail`. `authorise` is `https://` followed by at least one character in
  `!`..`~`, at most 512 characters in total (the receipt schema's licence URL rule). `amount` is
  a canonical number, at most 128 characters, not negative and not `0`. `currency` is one of the
  189 codes of units.md 2.1, withdrawn codes included (`GRD` passes; `XXX` fails). `reason` must
  be non-empty and pass 3.5 with a 1024-byte limit.
- **Proposed wording (5.5).** "A member that breaks any rule here, including a rule borrowed
  from another section, is `E_ENVELOPE`." And give the licence URL a grammar (entry 8).

## 28. Gap: verification level when blob content was checked (10.1 step 7.7, 11) [resolved at 2a77580]

- **Problem.** 7.7 is a sub-step of step 7 ("makes the receipt fully verified"), but "MAY run
  directly after step 6, without 7.1-7.6". Section 11 has only `signed` and `recomputed`. Whether
  a receipt whose content passed 7.7, without recomputation, is "signed" or something more is
  not said.
- **Resolution (vector `receipt/blob-value`, level `signed`).** The content check does not
  change the level: `signed` without recomputation, `recomputed` with it. The library says in
  `detail` that the content matched. When both are given, 7.7 runs after 7.1-7.6 (CONTRACT).
- **Proposed wording (10.1 step 7.7).** "...Checking content alone does not make a receipt fully
  verified; a receipt whose content passed this check without recomputation is still
  signature-valid only."

## 29. Gap: is a cell URI's `signature` validated? (5.4) [resolved at 2a77580]

- **Problem.** `parse(uri, signature)` takes the descriptor's signature for the argument types.
  5.4 does not say whether the signature itself must be valid. With units this matters: every
  `spec-0.1.1` signature with a number return (`"returns": "number"`) is invalid now.
- **Resolution.** The library validates the signature first, with the descriptor rules of 7 and
  7.1 (codes as for a descriptor, path `signature...`), so a `spec-0.1.1`-style signature is
  `E_CANON_UNIT`. **The library and the reference tool differ here:** the reference tool does
  not validate the signature. It accepts `"returns": "number"`, `"returns": "decimal"`, a
  `string` argument with a unit, `valid: "x"` and extra members, and only fails when an
  argument's type is used (an unknown argument type gives `E_CANON_TYPE` when building the
  cell). No vector has an invalid signature, so every vector passes either way.
- **Proposed wording (5.4).** "The signature must be valid (section 7); an invalid signature is
  reported with its descriptor code before the URI is examined." Or, if the tool is right, "The
  signature is trusted as given; only the types of the named arguments are used."

## 30. Gap: the `unit` vector's wrapper (11) [resolved at 2a77580]

- **Problem.** A `unit` vector's input is "JSON text of `{"cell", "descriptor"}`". Section 11
  does not say what the expected error is when the wrapper itself is wrong (not an object, a
  member missing or extra, a duplicate member).
- **Resolution (reference tool).** Strict parsing applies to the whole text (6.1: a duplicate
  `cell` is `E_PARSE_DUPLICATE_KEY`). A wrapper that is not an object, or does not have exactly
  `cell` and `descriptor`, is `E_SCHEMA`. The conformance runner does this before calling
  `resolvedUnit`.
- **Proposed wording (11, `unit` row).** "...a wrapper that is not exactly `{"cell",
  "descriptor"}` is `E_SCHEMA`."

## 31. Editorial: raw control characters in the schemas (`schemas/defs.schema.json`, `schemas/function.schema.json`) [resolved at 2a77580]

- **Problem.** At `spec-0.1.1` the string patterns were written with escapes
  (`"^[^\u0000-\u001f\u007f-\u009f]*$"`). At `0c7accc` the files were re-serialised and the
  pattern contains the raw characters U+007F-U+009F (bytes `7F`, `C2 80`..`C2 9F`), which are
  invisible in most editors and terminals (`git diff` renders the line as
  `"^[^\u0000-\u001f-]*$"`). The JSON is equivalent, but a reader cannot see that the C1 range is
  still excluded.
- **Resolution.** None needed; the library does not use the schemas at run time.
- **Proposed fix.** Serialise the schemas with `ensure_ascii=True` (or escape C0/C1 controls).

## 32. Note: blob media types and RFC 6838 (3.7)

- **Observation (not a defect in the rules).** RFC 6838 limits each restricted name to 127
  characters; 3.7 limits the whole media type to 128, which implies at most 126 per name. The
  reference tool and this library accept `a/` followed by 126 characters and reject 127. 3.7
  could say "at most 128 characters in total" to make clear that no per-name limit applies.

---

# spec-0.1.1

## 1. Conflict: userinfo and port in a cell URI (5.1, 10.2) [resolved at 2a77580]

- **Problem.** 5.1 says: "A cell URI has no fragment, no userinfo, no port and no empty query.
  Failures of this outer grammar are `E_PARSE_URI`." The reference tool reports
  `cell://u@rates.example.org/...` and `cell://rates.example.org:443/...` as `E_CANON_NAME`
  ("bad DNS label 'org:443'"). The 10.2 table entry for `E_PARSE_URI` does not mention userinfo
  or port either. No vector covers this.
- **Resolution.** I follow 5.1: an `@` or `:` in the authority (before the first `/` after
  `cell://`) is `E_PARSE_URI`. **The library and the reference tool disagree here.**
- **Proposed wording (10.2, `E_PARSE_URI`).** "Not `cell://<path>[?<query>]`; has userinfo
  (`@`) or a port (`:`) before the first `/`, a fragment, an empty query, or a parameter without
  `=`." If `E_CANON_NAME` is what was intended, change 5.1 instead. Either way, add a vector.

## 2. Conflict: a parameter without `=` versus an invalid name (5.4 steps 1-2) [resolved at 2a77580]

- **Problem.** 5.4 checks "1. the outer grammar; 2. the namespace and function names", and 10.2
  puts "a parameter without `=`" under `E_PARSE_URI`, which is outer grammar. When a URI has both
  a bad name and a parameter without `=`, the reference tool reports `E_CANON_NAME`, so it checks
  names first. Two examples are `cell://rates.example.o:rg/fx_rate?...` and
  `cell://Bad.example/fn?x&y=1`.
- **Resolution.** I follow the 5.4 order: `E_PARSE_URI`. **The library and the reference tool
  disagree here.** This entry and entry 1 account for every difference that the differential
  fuzz found (14 of 4,000 random URI/object mutations in the last run).
- **Proposed wording (5.4).** Either keep the text and fix the reference tool, or say: "1. the
  scheme, fragment and empty query; 2. the namespace and function names; 3. the split of the
  query into `name=value` parameters (`E_PARSE_URI`); 4. ...".

## 3. Conflict: order of hash check and verification for input receipts (10.1 step 7.5) [resolved at 2a77580]

- **Problem.** 7.5 lists "obtain the input receipt (`E_INPUT_UNAVAILABLE`), which must hash to
  the listed hash", then "verify it through step 6 (`E_INPUT_INVALID`)". In
  `vectors/invalid/receipt-input-invalid.json`, the supplied input has `value` changed to `"2"`.
  Its hash is therefore no longer the listed `501f744d...`, so the order as written gives
  `E_INPUT_UNAVAILABLE`. The vector expects `E_INPUT_INVALID`.
- **Resolution.** For each listed hash: missing → `E_INPUT_UNAVAILABLE`; verify through step 6
  (anything that fails to parse or verify is `E_INPUT_INVALID`); only then compare the hash
  (`E_INPUT_UNAVAILABLE`); then the declared-function check (`E_INPUT_UNDECLARED`); then `asof`
  (`E_TIME_ORDER`). The reference tool agrees: a valid receipt with another hash gives
  `E_INPUT_UNAVAILABLE`, and unparseable text gives `E_INPUT_INVALID`.
- **Proposed wording (7.5).** "obtain the input receipt (`E_INPUT_UNAVAILABLE` if none is
  found); verify it through step 6 (`E_INPUT_INVALID`); check that its receipt hash is the
  listed hash (`E_INPUT_UNAVAILABLE`); ..."

## 4. Gap: order of checks on a name (2.2, 2.4, 4.5)

- **Problem.** A name can fail its grammar (`E_CANON_NAME` / `E_CANON_ARG_NAME`), its 64-character
  limit (`E_CANON_LIMIT`), or the reserved-name rule (`asof`, `dm_*`; `E_CANON_ARG_NAME`). The
  spec does not order these. `cell-arg-name-too-long` only shows that a grammatical 65-character
  name gives `E_CANON_LIMIT`.
- **Resolution (reference tool).** Grammar first, then length, then reserved. A 65-character
  uppercase name gives `E_CANON_NAME`/`E_CANON_ARG_NAME`; `dm_` plus 62 letters gives
  `E_CANON_LIMIT`. Namespace path segments follow the same rule (65 characters gives
  `E_CANON_LIMIT`); DNS labels and names stay `E_CANON_NAME` as 4.5 says.
- **Proposed wording (2.2).** "A string that does not match `name` fails with `E_CANON_NAME`
  (`E_CANON_ARG_NAME` for argument names); a matching name longer than 64 characters fails with
  `E_CANON_LIMIT`; only then are reserved argument names (2.4) rejected."

## 5. Gap: when counts and sets are checked (4.5, 7, 8.1, 10.1 step 3)

- **Problem.** "Members are examined in canonical order, depth first" does not say whether a
  container's own rules (count limit, ascending order) are checked before or after its elements.
  The reference tool is not uniform:
  - argument maps (`args`, `valid`, `signature.args`): the 32-argument limit is checked first,
    before any argument name or value (but after the structural checks of step 2);
  - `inputs` (receipt hashes, or descriptor function names): every element first (`E_CANON_HEX` /
    `E_CANON_NAME` / `E_CANON_LIMIT`), then strictly ascending (`E_CANON_SET`), then the
    4096 limit (`E_CANON_LIMIT`). Unsorted and too long gives `E_CANON_SET`.
- **Resolution.** As the reference tool does.
- **Proposed wording (10.1, after "Within a step...").** "For an argument map, the argument
  count is checked before its members. For an `inputs` array, its elements are checked first,
  then that they are strictly ascending, then their number."

## 6. Underspecified: length of the fully qualified name in cells, references and URIs (2.3, 4.5)

- **Problem.** 2.3 limits `function-name` to 512 characters, but cells and references carry
  `ns` and `fn` separately, and nothing says whether `ns + "/" + fn` is limited there.
- **Resolution (reference tool).** The limit applies to cells, references and URI paths
  (`E_CANON_LIMIT` at the object, or at `uri.path`), and it is checked after all members (a bad
  `fn_hash` or argument wins) and, for URIs, right after the path names.
- **Proposed wording (4.4).** "`ns`, `/` and `fn` together are at most 512 characters
  (`E_CANON_LIMIT`, checked after the members)."

## 7. Underspecified: JSON type errors in typed scalars (3, 4.1, 10.1 steps 2-3)

- **Problem.** Section 3 says "A value whose JSON type does not match its declared type fails
  with `E_CANON_TYPE`". But `scalar-number-json-number` (`"value": 1.5` for a number) expects
  `E_SCHEMA`, while `scalar-boolean-as-string` and `receipt-value-type-mismatch` expect
  `E_CANON_TYPE`.
- **Resolution (from the vectors, confirmed with the reference tool).** In step 2, `type` must be
  a JSON string and `value` a JSON string or boolean, else `E_SCHEMA` (null, numbers, arrays and
  objects included). In step 3, a `type` outside the five is `E_CANON_TYPE`, and a string where
  a boolean is declared (or the reverse) is `E_CANON_TYPE`.
- **Proposed wording (3).** "`value` must be a JSON string or boolean (`E_SCHEMA` otherwise). A
  string for a `boolean`, or a boolean for any other type, fails with `E_CANON_TYPE`."

## 8. Underspecified: the licence grammar (8.1)

- **Problem.** "An SPDX licence identifier (`CC-BY-4.0`) or an `https://` URL" has no grammar
  in SPEC.md. It is unclear whether the identifier must be on the SPDX list, whether expressions
  or `LicenseRef-` are allowed, and what a URL may contain.
- **Resolution (schemas/receipt.schema.json, confirmed with the reference tool).** An
  identifier matches `[A-Za-z0-9][A-Za-z0-9.+-]*`, at most 64 characters, and is not checked
  against the SPDX list (`LicenseRef-x` and `GPL-2.0+` are accepted; `MIT OR Apache-2.0` is
  not). A URL is `https://` followed by at least one character in `!`..`~`, at most 512
  characters. Grammar comes before length: `A ` repeated past 64 characters gives
  `E_CANON_LICENCE`, not `E_CANON_LIMIT`.
- **Proposed wording (Appendix A).**
  `licence = spdx-id / https-url ; spdx-id = (ALPHA / DIGIT) *(ALPHA / DIGIT / "." / "+" / "-") ; https-url = "https://" 1*%x21-7E`.
  Then: "not matching: `E_CANON_LICENCE`; then the limits of 4.5: `E_CANON_LIMIT`."

## 9. Underspecified: error codes inside a key reference (8.1, 9.1, 10.2)

- **Problem.** `E_CANON_NAME` covers "key reference" and `E_CANON_HEX` covers "key id". For
  `rates.example.org#D712B32A2CC5CB7C` either could apply.
- **Resolution (reference tool; `receipt-computed-by-bare-key-id` gives `E_CANON_NAME`).** The
  host is checked first (`E_CANON_NAME`, including a missing `#`), then the part after the first
  `#` must be 16 lowercase hex digits (`E_CANON_HEX`). So `host#id#id` is `E_CANON_HEX`.
- **Proposed wording (9.1).** "A key reference whose host is not a DNS name, or that has no `#`,
  fails with `E_CANON_NAME`; a key id that is not 16 lowercase hex digits fails with
  `E_CANON_HEX`."

## 10. Gap: order of the step 4 checks (10.1 step 4)

- **Problem.** "Within a step, members are examined in canonical (JCS) order". In JCS order,
  `asof` (time order) comes before `publisher` and `valid`. But the reference tool follows the
  order of the bullets: a receipt with both a `valid` mismatch and `tx > asof` gives
  `E_VALID_MISMATCH`.
- **Resolution.** The bullet order: slices (in `cell.args`, then `valid`), `publisher`, `valid`
  (for each member in JCS order: echo, then valid-time type), then time order.
- **Proposed wording (10.1 step 4).** "These checks run in the order listed."

## 11. Gap: precedence among strict-parsing failures, and what "outside the double range" means (6.1)

- **Problem.** Step 1 has two codes, so a text with both a duplicate member and another fault
  needs an order. The spec also does not say whether underflow (`1e-400`) is "outside the IEEE
  754 double range", and gives no nesting limit.
- **Resolution (reference tool).** BOM, then UTF-8 validity, then parsing in document order.
  Syntax errors, `NaN`/`Infinity` and overflow are reported where they occur. A duplicate member
  is reported when its object closes (so `{"a":1,"a":2` is `E_PARSE_JSON`, while
  `[{"a":1,"a":1}, NaN]` is `E_PARSE_DUPLICATE_KEY`). Escaped lone surrogates are reported only
  after the whole text has parsed. Underflow is accepted and rounds to 0 (or a subnormal). The
  reference tool crashes (Python `RecursionError`) on about 1,000 levels of nesting. This library
  rejects nesting deeper than 1,000 with `E_PARSE_JSON` as an implementation limit.
- **Proposed wording (6.1).** "Failures are reported in this order: byte order mark, invalid
  UTF-8, then the first of: a syntax error, `NaN`/`Infinity`, a number whose magnitude exceeds
  the largest double (underflow is not an error), or a duplicate member (detected when its
  object ends); then a lone surrogate. Nesting deeper than 64 levels is `E_PARSE_JSON`." (64 is
  ample: Datumesh objects nest at most five deep. Any fixed limit would do, but there should be
  one.)

## 12. Gap: duplicates and order in URI parameters, and where `asof` belongs (5.2, 5.4 step 3)

- **Problem.** 5.4 says names are checked "left to right (grammar, reserved names, duplicates,
  order)", without saying whether "duplicate" means "equal to the previous parameter" or "seen
  anywhere before". Nor does it say what to report when `asof` is both repeated and not last.
- **Resolution (reference tool, consistent across every probe and fuzz case).**
  - Ordinary parameters are compared only with the previous one: equal is
    `E_CANON_ARG_DUPLICATE`, smaller is `E_CANON_ARG_ORDER`. So `base, date, base` is
    `E_CANON_ARG_ORDER`.
  - If the last parameter is `asof`, it is the `asof` parameter, and any earlier `asof` is
    `E_CANON_ARG_DUPLICATE`. If the last parameter is not `asof`, any `asof` is
    `E_CANON_ARG_ORDER`, reported when it is reached, before later names are checked. So
    `asof=..&Base=1` is `E_CANON_ARG_ORDER`, and `base=..&asof=..&quote=..&asof=..` is
    `E_CANON_ARG_DUPLICATE`.
- **Proposed wording (5.4 step 3).** Spell out both rules as above.

## 13. Gap: percent-encoding in `asof`, and an empty or missing path (5.1, 5.4)

- **Problem.** The grammar has `asof-param = "asof=" instant`, so a percent-encoded or `*` asof
  could be an outer-grammar failure (`E_PARSE_URI`), a percent failure, or an instant failure.
  It is also unclear whether a missing `/name` (`cell://rates.example.org`) or an empty segment
  (`cell://a.example//fn`) is outer grammar or a name failure.
- **Resolution (reference tool).** The `asof` value goes through the same percent-decoding as
  argument values: `%3A` gives `E_CANON_PERCENT` ("must not be percent-encoded"), and `*` gives
  `E_CANON_PERCENT`. Then it must be an instant; `asof=` gives `E_CANON_INSTANT`. A missing
  function name or an empty segment is `E_CANON_NAME`.
- **Proposed wording (5.2).** "The `asof` value is percent-decoded like an argument value and
  must then be an instant."

## 14. Gap: a non-canonical descriptor that hashes correctly (10.1 step 7.1)

- **Problem.** 7.1 says the descriptor "must hash to `cell.fn_hash` (`E_FN_HASH_MISMATCH`) and
  be canonical (sections 6-7)", but gives no code or order for the second condition.
- **Resolution (reference tool).** The hash is checked first. Then the descriptor is validated as
  a function descriptor, and its own code is reported (for example `E_CANON_NAME` at
  `descriptor.inputs[0]`).
- **Proposed wording (7.1).** "...must hash to `cell.fn_hash` (`E_FN_HASH_MISMATCH`); it must
  then be a canonical descriptor, failing with the code that canonicalising it on its own would
  give."

## 15. Gap: key documents (9.2, 9.3)

- **Problem.** 9.2 does not say whether `public` must decode to a valid curve point, whether
  "no key may appear twice" means a repeated `id` or a repeated `public`, how the body is parsed,
  or what a 200 response without a body is.
- **Resolution.** The body is parsed strictly (6.1); any parse failure, schema failure (extra or
  missing members, `alg` other than `ed25519`, uppercase hex, a non-instant
  `valid_from`/`valid_to`, `valid_to` not later than `valid_from`, fewer than 1 or more than 64
  keys), id mismatch or repetition (of `id` or `public`) is `E_KEY_DOC`. As in the reference
  tool, `public` is not checked as a curve point, so a small-order or non-point key is accepted
  and its receipts fail with `E_SIGNATURE`. A 200 response without a body is `E_KEY_DOC` (the
  reference tool crashes with `KeyError: 'body'`).
- **Proposed wording (9.2).** "The document is strict JSON (6.1) and matches
  `schemas/keydoc.schema.json`. No two keys share an `id` or a `public`. `public` is not
  required to be a valid point; a key that is not one verifies nothing."

## 16. Underspecified: what step 6 requires exactly, and no vectors for it (10.1 step 6, 11)

- **Problem.** Step 6 says "as libsodium does", but there are no vectors for `S >= L`,
  small-order `R` or `A`, non-canonical encodings, or mixed-order `A`. The text does not say
  that mixed-order (not small-order) public keys are accepted, which is what libsodium does, nor
  how "non-canonical" is defined.
- **Resolution.** Checked against libsodium (PyNaCl `crypto_sign_open`) on 74 constructed cases
  (`test/fixtures/gen_ed25519_cases.py`). `S >= L` is rejected. `R` and `A` must encode
  `y < p`, and x = 0 with the sign bit set is rejected. Small-order `R` and `A` (all 8 torsion
  points) are rejected. Mixed-order `A` is accepted exactly when the cofactorless equation
  holds. `@noble/curves` with `zip215: false` accepts small-order `R` and checks the cofactored
  equation, so it alone does not meet step 6; this library adds the missing checks.
- **Proposed wording (10.1 step 6).** "Reject if `S >= L`; if the `y` coordinate of `A` or `R`
  is `>= p`, or `x = 0` with the sign bit set; if `A` or `R` has order dividing 8. Otherwise
  accept exactly when the encoding of `[S]B - [k]A` equals the 32 bytes of `R`. (Mixed-order `A`
  is not rejected.)" Add vectors for each rule.

## 17. Underspecified: conventions for `stored` functions (7)

- **Problem.** "`stored` means the function is a table of recorded values; by convention its
  body is empty and it declares no inputs." It is unclear whether this is a rule.
- **Resolution (reference tool).** It is not enforced: a `stored` descriptor with a body or with
  inputs is accepted.
- **Proposed wording (7).** Either "A `stored` descriptor has an empty body and no inputs
  (`E_SCHEMA`)" or "...by convention, not enforced".

## 18. Note: engines' Unicode tables cannot be trusted for 3.5 (3.5)

- **Observation (not a defect in the rules).** Node 18.0.0 ships Unicode 14.0. Its
  `String.prototype.normalize` treats U+1E08F (assigned in 15.0, combining class 230) as
  unassigned (class 0), so it considers `q` + U+1E08F + U+0323 to be NFC. Under Unicode 15.1 that
  string is not NFC. An implementation relying on the engine accepts a string the spec rejects.
  This library ships Unicode 15.1 tables generated from the UCD.
- **Proposed wording (3.5, rationale).** "Implementations must use Unicode 15.1 (or later)
  normalisation data, not whatever their platform provides."
