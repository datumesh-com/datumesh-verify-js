// The core must run in browsers: the built modules import only each other, @noble/curves,
// @noble/hashes and canonicalize, and use no Node built-ins or Node-only globals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './helpers.mjs';

const ALLOWED = new Set(['@noble/curves/ed25519', '@noble/hashes/sha2', 'canonicalize']);

for (const build of ['esm', 'cjs']) {
  test(`dist/${build} imports nothing but allowed packages and its own modules`, () => {
    const dir = join(root, 'dist', build);
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const s of specs) assert.ok(s.startsWith('./') || ALLOWED.has(s), `${f} imports ${s}`);
      assert.doesNotMatch(src, /\b(?:process|Buffer|__dirname|__filename|setImmediate)\b/, f);
      assert.doesNotMatch(src, /node:/, f);
    }
  });
}

test('runtime dependencies are pinned exactly', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@noble/curves', '@noble/hashes', 'canonicalize']);
  for (const v of Object.values(pkg.dependencies)) assert.match(v, /^\d+\.\d+\.\d+$/);
});
