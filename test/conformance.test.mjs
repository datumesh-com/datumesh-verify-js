// Test 1: every vector in spec/vectors/ through the conformance runner (tools/run-vectors.mjs),
// once with the ESM build and once with the CommonJS build. Valid vectors must reproduce every
// output field exactly; invalid ones must give exactly the stated code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAll } from '../tools/check-vectors.mjs';
import { loadVectors } from './helpers.mjs';

const vectors = loadVectors();

test('the vector set is complete (365 vectors at spec-0.3.0, every kind)', () => {
  assert.equal(vectors.length, 365);
  const kinds = new Set(vectors.map((v) => v.kind));
  assert.deepEqual([...kinds].sort(), ['cell', 'envelope', 'function', 'jcs', 'keyid', 'keys', 'receipt', 'ref', 'scalar', 'unit', 'uri']);
});

for (const build of ['esm', 'cjs']) {
  test(`conformance via tools/run-vectors.mjs (${build} build)`, async (t) => {
    const results = runAll({ DATUMESH_BUILD: build });
    assert.equal(results.length, vectors.length);
    const summary = {};
    for (const { v, problems } of results) {
      const k = `${v.kind}/${v.valid ? 'valid' : 'invalid'}`;
      summary[k] ??= { pass: 0, fail: 0 };
      summary[k][problems.length ? 'fail' : 'pass']++;
      await t.test(`${v.id} [${v.kind}]`, () => assert.deepEqual(problems, []));
    }
    const line = Object.keys(summary).sort().map((k) => `${k} ${summary[k].pass}/${summary[k].pass + summary[k].fail}`).join(', ');
    console.log(`DIAG: ${build}: ${results.filter((r) => !r.problems.length).length}/${results.length} vectors pass (${line})`);
  });
}
