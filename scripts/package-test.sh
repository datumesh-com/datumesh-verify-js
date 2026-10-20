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
    grep -qx "true OK signed 501f744d910c585859a5be4f3b62385ed0d6803db53dbbf95dff5097a68bee0d" esm.out
    grep -qx "OK" cjs.out
    # The exports map resolves both conditions and ships types for both.
    node -e "const p=require(\"@datumesh/verify/package.json\"); console.log(p.name, p.version, \"spec\", p.datumesh.spec)"
    ls node_modules/@datumesh/verify/dist/esm/index.d.ts node_modules/@datumesh/verify/dist/cjs/index.d.ts >/dev/null
    echo "-- installed dependency tree:"; npm ls --all --omit=dev'
done
echo "PACKAGE TEST PASSED"
