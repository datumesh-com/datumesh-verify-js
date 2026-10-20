#!/usr/bin/env bash
# Browser compatibility test: bundle test/browser/entry.mjs (which imports dist/esm) for the
# browser with esbuild, then run it in headless Chrome (zenika/alpine-chrome:124) and check the
# summary it writes into the page. Requires `npm run build` and Docker.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
OUT="$ROOT/.browser-test"
mkdir -p "$OUT"
NODE_IMAGE="${NODE_IMAGE:-node:22-slim}"
CHROME_IMAGE="${CHROME_IMAGE:-zenika/alpine-chrome:124}"

docker run --rm -v "$ROOT":/w -w /w "$NODE_IMAGE" sh -ec '
  node -e "
    const fs = require(\"fs\"), path = require(\"path\");
    const dir = \"spec/vectors\"; const vs = [];
    for (const g of fs.readdirSync(dir).sort()) for (const f of fs.readdirSync(path.join(dir, g)).sort()) vs.push(JSON.parse(fs.readFileSync(path.join(dir, g, f), \"utf8\")));
    fs.writeFileSync(\".browser-test/vectors.json\", JSON.stringify(vs));"
  npx --no-install esbuild test/browser/entry.mjs --bundle --platform=browser --format=iife --target=chrome100 --outfile=.browser-test/bundle.js --log-level=warning
  node -e "
    const fs = require(\"fs\");
    const js = fs.readFileSync(\".browser-test/bundle.js\", \"utf8\").replace(/<\/script/g, \"<\\\\/script\");
    fs.writeFileSync(\".browser-test/index.html\", \"<!doctype html><meta charset=utf-8><pre id=result>pending</pre><script>\" + js + \"</script>\");"'

echo "== bundle: $(wc -c < "$OUT/bundle.js") bytes; running in $CHROME_IMAGE"
docker run --rm -v "$OUT":/t:ro "$CHROME_IMAGE" --no-sandbox --headless --disable-gpu --disable-dev-shm-usage \
  --virtual-time-budget=600000 --run-all-compositor-stages-before-draw --dump-dom file:///t/index.html 2>/dev/null > "$OUT/dom.html"

python3 - "$OUT/dom.html" <<'PY'
import html, json, re, sys
dom = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r'<pre id="result">(.*?)</pre>', dom, re.S)
assert m, "no result element in the dumped DOM"
s = json.loads(html.unescape(m.group(1)))
print(json.dumps(s, indent=1))
assert "error" not in s, s.get("error")
assert s["vectors"] == {"pass": 338, "fail": 0, "failures": []}, s["vectors"]
assert s["uriRoundTrips"] == 11 and s["ed25519"]["fail"] == 0 and s["ed25519"]["pass"] > 0
assert s["unflippedOk"] is True and s["bitFlips"] > 5000 and s["bitFlipFailures"] == 0
assert s["blobOk"] is True and s["blobFlips"] == 368 and s["blobFlipFailures"] == 0
assert s["hasNodeProcess"] is False
print("BROWSER TEST PASSED")
PY
