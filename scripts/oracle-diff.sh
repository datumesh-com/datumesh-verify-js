#!/usr/bin/env bash
# Differential fuzz of this library against the spec's reference tool (spec/tools/canon.py), run
# strictly as a black box in the datumesh-test image (Python 3.13 + PyNaCl). For each MODE it
# generates N mutated vectors, records the code the reference tool reports, then compares with
# this library's conformance runner. Requires `npm run build` and Docker.
#
#   N=4000 SEED=1 bash scripts/oracle-diff.sh            # modes: random semantic bytes
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/w/spec/tools" "$WORK/w/spec/vectors" "$WORK/out"
cp spec/tools/canon.py spec/tools/unicode-15.1-assigned.txt "$WORK/w/spec/tools/"
cp -r spec/schemas "$WORK/w/spec/"
for MODE in ${MODES:-random semantic bytes}; do
  echo "== mode $MODE"
  docker run --rm -e MODE="$MODE" -e N="${N:-3000}" -e SEED="${SEED:-1}" -v "$WORK/w":/w -v "$WORK/out":/out \
    -v "$ROOT/tools/oracle-diff":/p:ro -v "$ROOT/spec":/spec:ro datumesh-test python /p/fuzz_gen.py | tail -1
  docker run --rm -v "$ROOT":/w:ro -v "$WORK/out":/out -w /w node:22-slim node tools/oracle-diff/fuzz_cmp.mjs
done
