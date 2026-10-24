// Test 1: every vector in spec/vectors/ through the conformance runner (tools/run-vectors.mjs),
// once with the ESM build and once with the CommonJS build. Valid vectors must reproduce every
// output field exactly; invalid ones must give exactly the stated code. The formula-evaluator
// kinds (formula, formula-eval, excel, decimal) are not for a verifier library: the runner skips
// them (CONTRACT-0.4.0-libs.md item 9) and they are counted separately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAll } from '../tools/check-vectors.mjs';
import { SKIPPED_KINDS } from '../tools/vector-runner.mjs';
import { loadVectors } from './helpers.mjs';

const vectors = loadVectors();
const applicable = vectors.filter((v) => !SKIPPED_KINDS.includes(v.kind));

test('the vector set is complete (978 vectors at spec-0.4.0: 432 for verifier libraries, 546 formula-evaluator vectors)', () => {
  assert.equal(vectors.length, 978);
  const kinds = new Set(vectors.map((v) => v.kind));
  assert.deepEqual([...kinds].sort(), ['cell', 'decimal', 'envelope', 'excel', 'formula', 'formula-eval', 'function', 'jcs', 'keyid', 'keys', 'receipt', 'ref', 'scalar', 'slice', 'unit', 'uri']);
  assert.deepEqual([...SKIPPED_KINDS].sort(), ['decimal', 'excel', 'formula', 'formula-eval']);
  assert.equal(applicable.length, 432);
  const count = (k, valid) => vectors.filter((v) => v.kind === k && v.valid === valid).length;
  // SPEC 14 spec-0.4.0: 18 slice vectors (11 valid, 7 invalid), 30 slice-lineage receipts (13, 17).
  assert.deepEqual([count('slice', true), count('slice', false)], [11, 7]);
  assert.equal(vectors.filter((v) => v.kind === 'receipt' && /^(receipt\/slice-|invalid\/receipt-slice-)/.test(v.id)).length, 30); // not invalid/receipt-slice (spec-0.1.1)
});

test('a skipped vector\'s line is exactly {"id", "error": null, "skipped": "<kind>"} (SPEC 11, crosscheck/README.md)', () => {
  const results = runAll({ DATUMESH_BUILD: 'esm' });
  const kinds = new Set();
  for (const { v, got } of results) {
    if (!SKIPPED_KINDS.includes(v.kind)) {
      assert.equal(Object.prototype.hasOwnProperty.call(got, 'skipped'), false, v.id);
      continue;
    }
    assert.deepEqual(got, { id: v.id, error: null, skipped: v.kind }, v.id);
    kinds.add(v.kind);
  }
  assert.deepEqual([...kinds].sort(), ['decimal', 'excel', 'formula', 'formula-eval']);
});

for (const build of ['esm', 'cjs']) {
  test(`conformance via tools/run-vectors.mjs (${build} build)`, async (t) => {
    const results = runAll({ DATUMESH_BUILD: build });
    assert.equal(results.length, vectors.length);
    const summary = {};
    let skipped = 0;
    for (const { v, problems } of results) {
      if (SKIPPED_KINDS.includes(v.kind)) {
        assert.deepEqual(problems, [], `${v.id} must be reported as skipped`);
        skipped++;
        continue;
      }
      const k = `${v.kind}/${v.valid ? 'valid' : 'invalid'}`;
      summary[k] ??= { pass: 0, fail: 0 };
      summary[k][problems.length ? 'fail' : 'pass']++;
      await t.test(`${v.id} [${v.kind}]`, () => assert.deepEqual(problems, []));
    }
    const line = Object.keys(summary).sort().map((k) => `${k} ${summary[k].pass}/${summary[k].pass + summary[k].fail}`).join(', ');
    const passed = results.filter((r) => !SKIPPED_KINDS.includes(r.v.kind) && !r.problems.length).length;
    assert.equal(skipped, vectors.length - applicable.length);
    console.log(`DIAG: ${build}: ${passed}/${applicable.length} applicable vectors pass, ${skipped} formula-evaluator vectors skipped (${line})`);
  });
}
