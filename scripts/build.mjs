// Builds dist/esm (ES modules) and dist/cjs (CommonJS) with TypeScript declarations for both.
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { stdio: 'inherit' });
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--module', 'commonjs', '--outDir', 'dist/cjs'], { stdio: 'inherit' });
// The package is "type": "module"; mark the CommonJS tree as such.
writeFileSync('dist/cjs/package.json', '{\n  "type": "commonjs"\n}\n');
writeFileSync('dist/esm/package.json', '{\n  "type": "module"\n}\n');
