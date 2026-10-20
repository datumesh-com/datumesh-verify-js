// Runs every test/*.test.mjs file with node:test, one process per file. (`node --test` is not
// available on Node 18.0.0, the oldest supported runtime, and its directory handling differs
// between Node versions.) Exits non-zero if any file fails.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test');
const only = process.argv.slice(2);
const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs') && (!only.length || only.some((o) => f.includes(o)))).sort();
const summary = [];
let failed = 0;
console.log(`node ${process.version} (unicode ${process.versions.unicode}, icu ${process.versions.icu})`);
for (const f of files) {
  const r = spawnSync(process.execPath, [join(dir, f)], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = `${r.stdout}${r.stderr}`;
  const num = (k) => Number((out.match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [])[1] ?? NaN);
  const line = { file: f, tests: num('tests'), pass: num('pass'), fail: num('fail'), exit: r.status };
  summary.push(line);
  for (const m of out.matchAll(/DIAG: (.*)$/gm)) console.log(`  ${f}: ${m[1]}`);
  if (r.status !== 0 || !(line.fail === 0)) {
    failed++;
    console.log(out.split('\n').filter((l) => /not ok|Error|expected|actual|at /.test(l)).slice(0, 60).join('\n'));
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${f}: ${line.pass}/${line.tests} passed`);
}
const total = summary.reduce((a, s) => ({ tests: a.tests + (s.tests || 0), pass: a.pass + (s.pass || 0) }), { tests: 0, pass: 0 });
console.log(`${failed ? 'FAILED' : 'OK'}: ${total.pass}/${total.tests} tests passed in ${files.length} files`);
process.exit(failed ? 1 : 0);
