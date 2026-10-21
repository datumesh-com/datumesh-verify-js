#!/usr/bin/env bash
# Packaging test: build the npm tarball, install it into a FRESH container, and run the README
# example verbatim, once as an ES module (import) and once as CommonJS (require).
#
#   bash scripts/package-test.sh            # node:18-slim (default)
#   IMAGES="node:18-slim node:22-slim" bash scripts/package-test.sh
#
# Needs Docker. Nothing is published.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
IMAGES="${IMAGES:-node:18-slim}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The package records spec-0.2.1; the spec submodule must be that revision: the commit the
# spec-0.2.1 tag points to (CI checkouts do not fetch the submodule's tags, so check the commit).
SPEC_HEAD="$(git -C spec rev-parse HEAD)"
case "$SPEC_HEAD" in
  710dabb*) echo "== spec submodule at $SPEC_HEAD (spec-0.2.1)" ;;
  *) echo "spec submodule at $SPEC_HEAD, not spec-0.2.1 (710dabb)"; exit 1 ;;
esac
grep -q '"spec": "spec-0.2.1"' package.json

echo "== npm pack (in node:18-slim)"
docker run --rm -v "$ROOT":/src:ro -v "$WORK":/out node:18-slim sh -ec '
  cp -r /src /build && cd /build && rm -rf node_modules dist
  npm ci --no-audit --no-fund --loglevel=error
  npm pack --pack-destination /out --loglevel=error >/dev/null
  tar -tzf /out/*.tgz | sort'

# Extract the README code blocks verbatim: the ```js block that uses import, and the one that
# uses require.
python3 - "$ROOT/README.md" "$WORK" <<'PY'
import re, sys
readme, out = sys.argv[1], sys.argv[2]
blocks = re.findall(r"```js\n(.*?)```", open(readme, encoding="utf-8").read(), re.S)
esm = [b for b in blocks if re.search(r"^import ", b, re.M)]
cjs = [b for b in blocks if "require(" in b]
assert len(esm) == 1 and len(cjs) == 1, (len(esm), len(cjs))
open(f"{out}/example.mjs", "w", encoding="utf-8").write(esm[0])
open(f"{out}/example.cjs", "w", encoding="utf-8").write(cjs[0])
code = [l for l in esm[0].splitlines() if l.strip() and not l.strip().startswith("//")]
print(f"README ESM example: {len(code)} lines of code (+1 install line)")
PY
cp "$ROOT/spec/vectors/receipt/stored-number.json" "$WORK/stored-number.json"

for IMAGE in $IMAGES; do
  echo "== fresh $IMAGE: npm install the tarball, run the README examples"
  docker run --rm -v "$WORK":/pkg:ro "$IMAGE" sh -ec '
    mkdir /app && cd /app
    npm init -y >/dev/null
    npm install --no-audit --no-fund --loglevel=error /pkg/*.tgz
    cp /pkg/stored-number.json /pkg/example.mjs /pkg/example.cjs .
    echo "node $(node --version)"
    echo "-- import:";  node example.mjs | tee esm.out
    echo "-- require:"; node example.cjs | tee cjs.out
    grep -qx "true OK signed 19a5fe3a744c5792f747fb4c286ce396ab44b95922de4f07937502fe595b6f81" esm.out
    grep -qx "OK" cjs.out
    # The exports map resolves both conditions and ships types for both.
    node -e "const p=require(\"@datumesh/verify/package.json\"); console.log(p.name, p.version, \"spec\", p.datumesh.spec)"
    ls node_modules/@datumesh/verify/dist/esm/index.d.ts node_modules/@datumesh/verify/dist/cjs/index.d.ts >/dev/null
    echo "-- installed dependency tree:"; npm ls --all --omit=dev'
done

echo "== TypeScript consumer type-checks against the shipped declarations (ESM and CJS resolution)"
docker run --rm -v "$WORK":/pkg:ro node:18-slim sh -ec '
  mkdir /app && cd /app && npm init -y >/dev/null
  npm install --no-audit --no-fund --loglevel=error /pkg/*.tgz typescript@5.9.3
  cat > esm.mts <<TS
import { verify, keysFromResponse, parseUri, checkEnvelope, resolvedUnit, DatumeshError, SPEC_VERSION, type VerifyResult, type KeysResult, type EnvelopeResult } from "@datumesh/verify";
const k: KeysResult = keysFromResponse("rates.example.org", 404);
const r: VerifyResult = verify("{}", k, null, new Uint8Array([1]));
const code: string = r.code;
const ref = parseUri("cell://math.example/pi", { args: {}, returns: { type: "number", unit: "1" } });
const env: EnvelopeResult = checkEnvelope(404, "{\"outcome\":\"not_covered\"}", k, { cell_id: "00".repeat(32) });
const checked: boolean = r.blobChecked;
const unit: string | null = env.ok ? null : resolvedUnit("{}", "{}");
const e: DatumeshError | null = null;
console.log(SPEC_VERSION, code, ref.fn, env.outcome, unit, checked, e);
TS
  cat > cjs.cts <<TS
import lib = require("@datumesh/verify");
const r: lib.VerifyResult = lib.verify("{}", { d712b32a2cc5cb7c: "843baeb22bfd0364fb1b7262b367fb3202e7886c69a070fecf8e343fedb1eabf" });
console.log(r.ok);
TS
  npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext esm.mts cjs.cts
  echo "types OK"'

echo "PACKAGE TEST PASSED"
