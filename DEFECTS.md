# Places where SPEC.md (spec-0.1.1) was insufficient

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

## 1. Conflict: userinfo and port in a cell URI (5.1, 10.2)

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

## 2. Conflict: a parameter without `=` versus an invalid name (5.4 steps 1-2)

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

## 3. Conflict: order of hash check and verification for input receipts (10.1 step 7.5)

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
