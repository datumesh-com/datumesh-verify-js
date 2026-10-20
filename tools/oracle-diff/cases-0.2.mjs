// Generates probe vectors for the spec-0.2.0 additions (units, blobs, envelopes) into
// /out/cases.jsonl: hand-written edge cases plus random mutations of the spec's own unit,
// function, scalar, envelope and blob-receipt vectors. oracle_batch.py then records the
// reference tool's verdict for each (black box) and fuzz_cmp.mjs compares this library with it.
//   node tools/oracle-diff/cases-0.2.mjs <spec dir> <out file> [N] [SEED]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [specDir, outFile, nArg, seedArg] = process.argv.slice(2);
const N = Number(nArg ?? 3000);
let seed = Number(seedArg ?? 1);
const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
const pick = (a) => a[rand(a.length)];
const clone = (o) => JSON.parse(JSON.stringify(o));
const vdir = join(specDir, 'vectors');
const all = [];
for (const g of readdirSync(vdir)) for (const f of readdirSync(join(vdir, g))) all.push(JSON.parse(readFileSync(join(vdir, g, f), 'utf8')));
const byId = Object.fromEntries(all.map((v) => [v.id, v]));
const units = readFileSync(join(specDir, 'units.md'), 'utf8');
const literals = [...units.matchAll(/^```units-[a-z]+\n([\s\S]*?)^```/gm)].flatMap((m) => m[1].split(/\s+/).filter(Boolean));

const out = [];
const add = (v) => out.push(v);
const H = '9dc30a40021f1f79d8dd9437ec9014ce134138326b72fcb9696485ab3d69330a';

// ---- descriptors
const desc = (args, returns) => ({ code: { body: '', lang: 'stored' }, inputs: [], signature: { args, returns } });
const fnv = (d) => add({ kind: 'function', input: JSON.stringify(d) });
const UNIT_POOL = [...literals, ...literals.map((u) => u.toLowerCase()), ...literals.map((u) => ` ${u}`), '°C', 'USD/EUR', '', 'index:2015=100', 'index:2015=0', 'index:0000=1', 'index:2016-02-29=1', 'index:2015-02-29=1', 'index:2015=1.50', 'index:2015=.5', 'index:2015=0.5', `index:2015=${'1'.repeat(54)}`, `index:2015=${'1'.repeat(53)}`, 'index:2015-1=1', 'index:2015=+1', 'index:2015=1e2', 1, true, null, [], {}, { arg: 'c' }, { arg: 'n' }, { arg: 'd' }, { arg: 'zz' }, { arg: 5 }, { arg: 'c', x: 1 }, { of: 'USD', per: 'EUR' }, { of: { arg: 'c' }, per: 'EUR' }, { of: 'kg', per: 'EUR' }, { of: 'USD' }, { of: 'USD', per: 5 }, { of: { of: 'USD', per: 'EUR' }, per: 'EUR' }, { of: 'index:2015=100', per: 'EUR' }, { of: { arg: 'd' }, per: { arg: 'c' } }];
const ARGS = { c: { type: 'string', valid: false }, d: { type: 'date', valid: true }, n: { type: 'number', unit: '1', valid: false } };
for (const u of UNIT_POOL) {
  fnv(desc(ARGS, { type: 'number', unit: u }));
  fnv(desc({ ...ARGS, x: { type: 'number', unit: u, valid: false } }, 'boolean'));
}
for (const t of ['number', 'string', 'boolean', 'date', 'instant', 'blob', 'bogus', 5]) {
  for (const unit of [undefined, '1', 5]) {
    for (const valid of [false, true, 'x', undefined]) {
      const d = { type: t };
      if (unit !== undefined) d.unit = unit;
      if (valid !== undefined) d.valid = valid;
      fnv(desc({ a: d }, 'boolean'));
    }
    const r = { type: t };
    if (unit !== undefined) r.unit = unit;
    fnv(desc({}, r));
    fnv(desc({}, t));
  }
}
// random mutations of the function vectors and of unit-bearing descriptors
const fnBases = all.filter((v) => v.kind === 'function').map((v) => JSON.parse(v.input));
const MUT_POOL = ['number', 'string', 'blob', 'boolean', 'bogus', 'EUR', 'eur', 'degC', 'quote', 'base', 'c', '*', true, false, 1, null, [], {}, { arg: 'quote' }, { arg: 'base' }, { of: 'USD', per: 'EUR' }, { of: { arg: 'quote' }, per: { arg: 'base' } }, 'index:2015=100', 'unit', 'type', 'valid'];
function leaves(o, path = [], acc = []) {
  acc.push(path);
  if (o && typeof o === 'object') for (const k of Object.keys(o)) leaves(o[k], [...path, k], acc);
  return acc;
}
function mutate(o) {
  o = clone(o);
  const paths = leaves(o).filter((p) => p.length);
  const p = pick(paths);
  let parent = o;
  for (const k of p.slice(0, -1)) parent = parent[k];
  const last = p[p.length - 1];
  const r = rand(4);
  if (r === 0 && !Array.isArray(parent)) delete parent[last];
  else if (r === 1 && parent[last] && typeof parent[last] === 'object' && !Array.isArray(parent[last])) parent[last][pick(['unit', 'type', 'valid', 'arg', 'of', 'per', 'x'])] = pick(MUT_POOL);
  else parent[last] = clone(pick(MUT_POOL));
  return o;
}
for (let i = 0; i < N; i++) fnv(mutate(mutate(pick(fnBases))));

// ---- blobs
for (const value of [`${H}:17:text/plain`, `${H}::text/plain`, `${H}:017:text/plain`, `${H}:9007199254740991:a/b`, `${H}:9007199254740992:a/b`, `${H}:99999999999999999:a/b`, `${H}:17:a/${'b'.repeat(126)}`, `${H}:17:a/${'b'.repeat(127)}`, `${H}:17:text/*`, `${H}:17:a/b!#$&-^_.+`, `${H}:17:-a/b`, `${H}:17:a/-b`, `${H}:17:a/b c`, `${H}:17:a/b;c=d`, `${H}:17:A/b`, `${H.toUpperCase()}:17:a/b`, `${H}:17:a/b:c`, `${H}:17`, `${H}`, '', `${H}:17:a//b`, `${H}:1e1:a/b`, `${H}:0:a/b`, `${H}:00:a/b`, `${H}:17:ä/b`]) {
  add({ kind: 'scalar', input: JSON.stringify({ type: 'blob', value }) });
  add({ kind: 'uri', input: `cell://files.example.org/describe?file=${value.replace(/[^A-Za-z0-9\-._~:]/g, (c) => [...new TextEncoder().encode(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join(''))}`, signature: { args: { file: { type: 'blob', valid: false } }, returns: 'string' } });
}
// URIs with signatures that are not valid descriptors (SPEC 5.4: taken as given)
// (Declarations without a type are left out: the reference tool crashes on them, DEFECTS.md 34.)
for (const decl of [{ type: 'decimal', valid: false }, { type: 'string' }, { type: 5 }, { type: true, valid: false }, { type: 'number', valid: false }, { type: 'string', unit: 'EUR', valid: 'x' }, { type: 'blob', valid: true }]) {
  for (const value of ['EUR', '*', '1', '%2A', 'Bad%ZZ', '']) {
    add({ kind: 'uri', input: `cell://a.example/f?base=${value}`, signature: { args: { base: decl }, returns: pick(['number', 'decimal', { type: 'number' }, 'string']) } });
  }
}
for (const uri of ['cell://u@a.example/f?base=x', 'cell://a.example:443/f?base=x', 'cell://a.example:/f', 'cell://a.example:x/f', 'cell://A.example/f?base', 'cell://a.example/F?base&x=1', 'cell://a.example/f?', 'cell://a.example/f#x', 'cell://a.example/f?base=x&&']) {
  add({ kind: 'uri', input: uri, signature: { args: { base: { type: 'string', valid: false } }, returns: 'string' } });
}
const bv = byId['receipt/blob-value'];
const content = Buffer.from(bv.blob_hex, 'hex');
const receiptVec = (blobHex, extra = {}) => ({ kind: 'receipt', input: bv.input, keypair: bv.keypair, keys: bv.keys, ...(blobHex === null ? {} : { blob_hex: blobHex }), ...extra });
add(receiptVec(bv.blob_hex));
add(receiptVec(''));
add(receiptVec(null));
for (let i = 0; i < 40; i++) {
  const b = Buffer.from(content);
  b[rand(b.length)] ^= 1 << rand(8);
  add(receiptVec(b.toString('hex')));
}
add(receiptVec(content.subarray(1).toString('hex')));
add(receiptVec(Buffer.concat([content, Buffer.from([0])]).toString('hex')));
const sn = byId['receipt/stored-number'];
add({ kind: 'receipt', input: sn.input, keypair: sn.keypair, keys: sn.keys, blob_hex: '00' });
add({ kind: 'receipt', input: sn.input, keypair: sn.keypair, keys: sn.keys, blob_hex: '' });
add({ kind: 'receipt', input: sn.input, keypair: sn.keypair, keys: sn.keys, recompute: sn.recompute, blob_hex: '00' });
const bvr = byId['receipt/blob-value-recomputed'];
add({ kind: 'receipt', input: bvr.input, keypair: bvr.keypair, keys: bvr.keys, recompute: bvr.recompute, blob_hex: '00' });
add({ kind: 'receipt', input: bvr.input, keypair: bvr.keypair, keys: bvr.keys, recompute: { ...bvr.recompute, value: { type: 'blob', value: `${H}:17:text/plain` } }, blob_hex: '00' });

// ---- unit resolution
const unitBases = all.filter((v) => v.kind === 'unit').map((v) => JSON.parse(v.input));
const ARG_POOL = ['*', { type: 'string', value: 'USD' }, { type: 'string', value: 'usd' }, { type: 'string', value: 'kg' }, { type: 'string', value: 'index:2015=100' }, { type: 'string', value: 'USD/EUR' }, { type: 'date', value: '2024-03-15' }, { type: 'number', value: '1' }, { type: 'string', value: 'count' }];
for (let i = 0; i < N / 3; i++) {
  const b = clone(pick(unitBases));
  const names = Object.keys(b.cell.args);
  for (let j = 0; j < 1 + rand(2); j++) {
    const r = rand(10);
    if (r === 0) delete b.cell.args[pick(names)];
    else if (r === 1) b.cell.args.zz = pick(ARG_POOL);
    else if (r === 2) b.descriptor = mutate(b.descriptor);
    else b.cell.args[pick(names)] = clone(pick(ARG_POOL));
  }
  add({ kind: 'unit', input: JSON.stringify(b) });
}

// ---- envelopes
const envBases = all.filter((v) => v.kind === 'envelope');
const ENV_POOL = ['ok', 'stale', 'error', 'bad_request', 'E_PARSE_URI', 'E_ENVELOPE', 'E_ARG_MISSING', 'E_KEY_DOC', 'primary', 'verified', 'unverified', 'trusted', 0, -1, 1.5, 9007199254740991, 9007199254740992, true, null, '', 'x', 'E_SIGNATURE', 'E_TEAPOT', 'f'.repeat(64), 'F'.repeat(64), { amount: '1', authorise: 'https://a.example/', currency: 'EUR' }, { amount: '0', authorise: 'https://a.example/', currency: 'EUR' }, { amount: '1', authorise: 'http://a.example/', currency: 'EUR' }, { amount: '1', authorise: 'https://a.example/', currency: 'XXX' }, 'Zürich', 'a\u0007'];
const MEMBERS = ['outcome', 'receipt', 'trust', 'age_seconds', 'superseded_by', 'reason', 'quote', 'retry_after_seconds', 'error'];
const STATUSES = [200, 402, 403, 404, 429, 500, 503, 599, 600, 400, 401];
for (let i = 0; i < N; i++) {
  const v = pick(envBases);
  const body = JSON.parse(v.input);
  let status = v.status;
  for (let j = 0; j < 1 + rand(2); j++) {
    const r = rand(10);
    if (r === 0) status = pick(STATUSES);
    else if (r === 1) delete body[pick(Object.keys(body))];
    else if (r === 2 && body.receipt) body.receipt = mutate(body.receipt);
    else if (r === 3) {
      const donor = JSON.parse(pick(envBases).input);
      const k = pick(Object.keys(donor));
      body[k] = donor[k];
    } else body[pick(MEMBERS)] = clone(pick(ENV_POOL));
  }
  let request = v.request;
  const q = rand(12);
  if (q === 0) request = { cell_id: 'e920bb15287699a37973578621cd346a7411270ad08cf1cbd3cbaaa5096aa608' };
  else if (q === 1) request = { cell_id: v.request.cell_id, asof: '2024-03-17T09:00:00.000000Z' };
  else if (q === 2) request = { cell_id: v.request.cell_id };
  add({ kind: 'envelope', input: JSON.stringify(body), status, keys: v.keys, request });
}
for (const v of envBases) {
  const body = JSON.parse(v.input);
  for (const n of ['1.0', '1e2', '-0', '1.5', 'true', '"1"', '1e400', '0', '30', '9007199254740991', '9007199254740992', '3E1', '0.0']) {
    if ('age_seconds' in body) add({ kind: 'envelope', input: v.input.replace(/"age_seconds": [0-9]+/, `"age_seconds": ${n}`), status: v.status, keys: v.keys, request: v.request });
    if ('retry_after_seconds' in body) add({ kind: 'envelope', input: v.input.replace(/"retry_after_seconds": [0-9]+/, `"retry_after_seconds": ${n}`), status: v.status, keys: v.keys, request: v.request });
  }
}

out.forEach((v, i) => (v.id = `invalid/c${String(i).padStart(5, '0')}`));
writeFileSync(outFile, out.map((v) => JSON.stringify(v)).join('\n') + '\n');
console.log(`${out.length} cases`);
