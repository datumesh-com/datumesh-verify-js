#!/usr/bin/env bash
# Differential fuzz of this library against the spec's reference tool (spec/tools/canon.py), run
# strictly as a black box in the datumesh-test image (Python 3.13 + PyNaCl). For each MODE it
# generates N mutated vectors, records the code the reference tool reports, then compares with
# this library's conformance runner. Requires `npm run build` and Docker.
#
#   N=4000 SEED=1 bash scripts/oracle-diff.sh            # modes: random semantic bytes cases
#   MODES=cases bash scripts/oracle-diff.sh                # spec-0.2.0 additions only
#
# Mode `cases` (tools/oracle-diff/cases-0.2.mjs) covers units, blobs and envelopes: edge cases
# plus mutations of the spec's vectors, all judged by the reference tool in one batch run.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/w/spec/tools" "$WORK/w/spec/vectors" "$WORK/out"
cp spec/tools/canon.py spec/tools/unicode-15.1-assigned.txt "$WORK/w/spec/tools/"
cp -r spec/schemas spec/units.md "$WORK/w/spec/"
for MODE in ${MODES:-random semantic bytes cases}; do
  echo "== mode $MODE"
  if [ "$MODE" = cases ]; then
    docker run --rm -v "$ROOT":/w:ro -v "$WORK/out":/out -w /w node:22-slim node tools/oracle-diff/cases-0.2.mjs spec /out/cases.jsonl "${N:-3000}" "${SEED:-1}"
    docker run --rm -v "$WORK/w":/w -v "$WORK/out":/out -v "$ROOT/tools/oracle-diff":/p:ro datumesh-test python /p/oracle_batch.py | tail -3
    docker run --rm -v "$ROOT":/w:ro -v "$WORK/out":/out -w /w node:22-slim node tools/oracle-diff/fuzz_cmp.mjs
    continue
  fi
  docker run --rm -e MODE="$MODE" -e N="${N:-3000}" -e SEED="${SEED:-1}" -v "$WORK/w":/w -v "$WORK/out":/out \
    -v "$ROOT/tools/oracle-diff":/p:ro -v "$ROOT/spec":/spec:ro datumesh-test python /p/fuzz_gen.py | tail -1
  docker run --rm -v "$ROOT":/w:ro -v "$WORK/out":/out -w /w node:22-slim node tools/oracle-diff/fuzz_cmp.mjs
done
