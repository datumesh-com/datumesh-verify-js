# Changelog

Releases of `@datumesh/verify`. Earlier releases are described in the commit log and, for the
specification side, in SPEC.md section 14.

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
