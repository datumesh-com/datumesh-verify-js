// The core must run in browsers: the built modules import only each other, @noble/curves,
// @noble/hashes and canonicalize, and use no Node built-ins or Node-only globals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './helpers.mjs';

const ALLOWED = new Set(['@noble/curves/ed25519', '@noble/hashes/sha2', 'canonicalize']);

// `process` counts only as a free identifier: spec-0.5.0's class descriptor has a
// `steward.process` member, so `.process` and `'process'` as a key are legitimate.
// Access through a global object is caught separately.
const NODE_GLOBALS = /\b(?:Buffer|__dirname|__filename|setImmediate)\b/;
const FREE_PROCESS = /(?<![.'"\w$])process\b(?!['"]|\s*:)/;
const GLOBAL_PROCESS = /\b(?:globalThis|global|window|self)\s*(?:\.\s*process\b|\[\s*['"]process['"]\s*\])/;
const usesNodeGlobal = (src) => NODE_GLOBALS.test(src) || FREE_PROCESS.test(src) || GLOBAL_PROCESS.test(src);

test('the process checks catch real uses and pass property and key spellings', () => {
  for (const s of ['process.env.HOME', 'globalThis.process.env', 'globalThis["process"]', "self['process']"]) {
    assert.ok(usesNodeGlobal(s), s);
  }
  for (const s of ['steward.process', "{ 'process': 1 }", '{ "process": 1 }', '{ process: 1 }']) {
    assert.ok(!usesNodeGlobal(s), s);
  }
});

for (const build of ['esm', 'cjs']) {
  test(`dist/${build} imports nothing but allowed packages and its own modules`, () => {
    const dir = join(root, 'dist', build);
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const s of specs) assert.ok(s.startsWith('./') || ALLOWED.has(s), `${f} imports ${s}`);
      assert.doesNotMatch(src, NODE_GLOBALS, f);
      assert.doesNotMatch(src, FREE_PROCESS, f);
      assert.doesNotMatch(src, GLOBAL_PROCESS, f);
      assert.doesNotMatch(src, /node:/, f);
    }
  });
}

test('runtime dependencies are pinned exactly', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@noble/curves', '@noble/hashes', 'canonicalize']);
  for (const v of Object.values(pkg.dependencies)) assert.match(v, /^\d+\.\d+\.\d+$/);
});
