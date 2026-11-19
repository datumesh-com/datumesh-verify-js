// Test 1: every vector in spec/vectors/ through the conformance runner (tools/run-vectors.mjs),
// once with the ESM build and once with the CommonJS build. Valid vectors must reproduce every
// output field exactly; invalid ones must give exactly the stated code. The formula-evaluator
// kinds (formula, formula-eval, excel, decimal, call) are not for a verifier library: the runner skips
// them (CONTRACT-0.4.0-libs.md item 9) and they are counted separately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAll } from '../tools/check-vectors.mjs';
import { SKIPPED_KINDS } from '../tools/vector-runner.mjs';
import { loadVectors } from './helpers.mjs';

const vectors = loadVectors();
const applicable = vectors.filter((v) => !SKIPPED_KINDS.includes(v.kind));

test('the vector set is complete (1564 vectors at spec-0.6.0 640898c: 897 for verifier libraries, 667 formula-evaluator vectors; 1474, 818 and 656 at c8896ad)', () => {
  assert.equal(vectors.length, 1564);
  const kinds = new Set(vectors.map((v) => v.kind));
  assert.deepEqual([...kinds].sort(), ['batch', 'call', 'cell', 'class', 'decimal', 'define', 'describe', 'entitlement', 'envelope', 'excel', 'formula', 'formula-eval', 'function', 'jcs', 'key', 'keyid', 'keys', 'licence', 'mesh', 'normalisation', 'receipt', 'ref', 'scalar', 'slice', 'unit', 'uri']);
  assert.deepEqual([...SKIPPED_KINDS].sort(), ['call', 'decimal', 'excel', 'formula', 'formula-eval']);
  assert.equal(applicable.length, 897); // spec-0.6.0: + 79 (16 receipt, 36 envelope, 22 describe, 5 mesh); the 11 new call vectors are skipped
  const count = (k, valid) => vectors.filter((v) => v.kind === k && v.valid === valid).length;
  // SPEC 14 spec-0.4.1: the kind mesh, 3 valid and 17 invalid, and 10 more (2 valid) at 3f79313.
  assert.deepEqual([count('mesh', true), count('mesh', false)], [13, 34]); // spec-0.6.0: + 2 valid (whatif, whatif-required-only), 3 invalid; spec-0.4.2: + versions (1, 1); spec-0.4.3: + keydoc-declarations; spec-0.5.0: + 4 valid (3 unrooted loopback, describe endpoint), 5 invalid
  // SPEC 14 spec-0.4.3: 90 new: licence 50 and entitlement 11 (all valid), 7 envelope (2, 5) for
  // E_FOREIGN_UNAVAILABLE, 17 keys (2, 15) for declarations, 2 receipt, 1 mesh, 1 cell, 1 invalid receipt.
  // spec-0.5.0: licence has 3 invalid (grammar of the arguments, 8.5), entitlement 6 (R and its inputs, 10.3).
  assert.deepEqual([count('licence', true), count('licence', false), count('entitlement', true), count('entitlement', false)], [50, 3, 11, 6]);
  // SPEC 14 spec-0.5.0, the new kinds (SPEC 11): class (12, 33), normalisation (9, 15), key (7, 10), describe (6, 18), define (3, 4); counts as of c8896ad.
  assert.deepEqual([count('class', true), count('class', false), count('normalisation', true), count('normalisation', false), count('key', true), count('key', false), count('describe', true), count('describe', false), count('define', true), count('define', false)], [12, 33, 9, 15, 7, 10, 12, 34, 3, 4]); // spec-0.6.0: describe + 6 valid, 16 invalid
  assert.deepEqual([count('call', true), count('call', false)], [28, 34]); // skipped kind; spec-0.6.0: + 8 valid, 3 invalid; 6 new invalid at c8896ad
  assert.deepEqual([count('envelope', true), count('envelope', false)], [73, 131]); // spec-0.6.0: + 9 valid, 27 invalid; c8896ad: + 2 valid bad_request (key codes), 4 invalid
  assert.deepEqual([count('keys', true), count('keys', false)], [3, 28]); // unchanged at spec-0.5.0
  assert.equal(vectors.filter((v) => /foreign-unavailable/.test(v.id)).length, 7);
  for (const v of vectors.filter((x) => x.kind === 'keys' && x.valid)) assert.equal(v.declarations !== undefined, /declarations/.test(v.id), v.id);
  // SPEC 14 spec-0.4.2: the kinds batch (5, 6) and call (10, 17).
  assert.deepEqual([count('batch', true), count('batch', false)], [5, 6]); // call: 10, 17 at spec-0.4.2, 20, 25 at spec-0.5.0 (above)
  // Since 3f79313 the valid mesh vectors carry their outputs.
  for (const v of vectors.filter((x) => x.kind === 'mesh' && x.valid)) assert.ok(v.bindings !== undefined && v.endpoints !== undefined, v.id);
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
  assert.deepEqual([...kinds].sort(), ['call', 'decimal', 'excel', 'formula', 'formula-eval']);
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
