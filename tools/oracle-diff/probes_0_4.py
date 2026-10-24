# Probes for the spec-0.4.0 additions (slice objects, manifests, descriptor order/extent, slice
# entries, step 7.5 for slices, E_INPUT_SUPERSEDED), judged by the reference tool as a black box:
# every probe is written as an invalid vector with error E_PROBE into a scratch spec directory
# (/w/spec: canon.py and its sibling files copied unread, the schemas and units.md), and one
# `canon.py check` run prints the code each probe actually got. The reference tool's source is
# never read. Receipts are signed here with PyNaCl: the top receipt with the seed published in a
# vector, members and lineage receipts with a probe key for the host probe.example.org.
#
#   docker run --rm -v <scratch>/w:/w -v <repo>/spec:/spec:ro -v <repo>/tools/oracle-diff:/p:ro \
#     datumesh-test python /p/probes_0_4.py [/out/probes.jsonl]
#
# Prints "<name> <verdict>" per probe; with an output path also writes {vector, oracle} lines for
# fuzz_cmp.mjs-style comparison with this library.
import copy, hashlib, json, os, re, shutil, subprocess, sys
from nacl.signing import SigningKey

S = '/w'
VEC = '/spec/vectors'
def load(p): return json.load(open(os.path.join(VEC, p), encoding='utf-8'))
def jcs(o): return json.dumps(o, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
def sha(o): return hashlib.sha256(jcs(o)).hexdigest()
def rhash(r): return sha({k: v for k, v in r.items() if k != 'sig'})

PROBE_SK = SigningKey(bytes.fromhex('11' * 32))
PROBE_PUB = PROBE_SK.verify_key.encode().hex()
PROBE_KID = hashlib.sha256(bytes.fromhex(PROBE_PUB)).hexdigest()[:16]
PROBE_HOST = 'probe.example.org'
PROBE_ENV = {'https': {'status': 200, 'body': json.dumps({'host': PROBE_HOST, 'keys': [{'alg': 'ed25519', 'id': PROBE_KID, 'public': PROBE_PUB, 'valid_from': '2000-01-01T00:00:00.000000Z'}], 'proto': 'datumesh/1'})}}

def sign_with(r, sk):
    r = {k: v for k, v in r.items() if k != 'sig'}
    r['sig'] = sk.sign(jcs(r)).signature.hex()
    return r
def probe_sign(r):
    r = dict(r); r['computed_by'] = f'{PROBE_HOST}#{PROBE_KID}'
    return sign_with(r, PROBE_SK)

probes = {}
def add(name, v): probes[name] = v
def kindvec(kind, obj): return {'kind': kind, 'input': obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)}

# ------------------------------------------------------------------ slice objects
H = 'e18ab921761089909a83eacfd7e88b71a580da2d35610769557f035fdb2b8169'
def ms(args, ns='data.example.org', fn='daily'): return {'args': args, 'fn': fn, 'fn_hash': H, 'ns': ns}
D1 = {'type': 'date', 'value': '2026-03-01'}
add('sl-noopen-badns', kindvec('slice', ms({'date': D1}, ns='Bad')))
add('sl-noopen-badfn', kindvec('slice', ms({'date': D1}, fn='Bad')))
add('sl-noopen-badarg', kindvec('slice', ms({'date': {'type': 'date', 'value': '2026-02-30'}})))
add('sl-empty-args', kindvec('slice', ms({})))
add('sl-noopen-longname', kindvec('slice', ms({'date': D1}, ns='a' * 60 + '.' + '.'.join(['b' * 60] * 3) + '/x' * 0, fn='f' * 64)))
add('sl-noopen-name-limit', kindvec('slice', ms({'date': D1}, ns='data.example.org' + ('/' + 'a' * 60) * 9)))
add('sl-open-name-limit', kindvec('slice', ms({'date': '*'}, ns='data.example.org' + ('/' + 'a' * 60) * 9)))
add('sl-noopen-33args', kindvec('slice', ms({f'a{i}': D1 for i in range(33)})))
add('sl-33args-open', kindvec('slice', ms({f'a{i}': '*' for i in range(33)})))
add('sl-range-hi-limit-lo-bad', kindvec('slice', ms({'n': {'type': 'number', 'hi': '1' * 129, 'lo': '01'}})))
add('sl-range-hi-bad-lo-limit', kindvec('slice', ms({'n': {'type': 'number', 'hi': '01', 'lo': '1' * 129}})))
add('sl-range-type-bool-badhi', kindvec('slice', ms({'n': {'type': 'boolean', 'hi': 'x', 'lo': 'y'}})))
add('sl-range-type-blob', kindvec('slice', ms({'n': {'type': 'blob', 'hi': 'x', 'lo': 'y'}})))
add('sl-range-type-unknown', kindvec('slice', ms({'n': {'type': 'foo', 'hi': 'x', 'lo': 'y'}})))
add('sl-range-type-nonstring', kindvec('slice', ms({'n': {'type': 5, 'hi': 'x', 'lo': 'y'}})))
add('sl-range-hi-nonstring', kindvec('slice', ms({'n': {'type': 'number', 'hi': 5, 'lo': '1'}})))
add('sl-range-string-nfc', kindvec('slice', ms({'s': {'type': 'string', 'hi': 'e\u0301', 'lo': 'a'}})))
add('sl-range-string-empty', kindvec('slice', ms({'s': {'type': 'string', 'hi': '', 'lo': ''}})))
add('sl-range-badname-first', kindvec('slice', ms({'Bad': '*', 'date': {'type': 'date', 'hi': 'x', 'lo': 'y'}})))
add('sl-range-and-scalar-bad', kindvec('slice', ms({'a': {'type': 'date', 'hi': 'x', 'lo': '2026-01-01'}, 'b': {'type': 'date', 'value': 'zz'}})))
add('sl-range-instant-reversed', kindvec('slice', ms({'t': {'type': 'instant', 'hi': '2026-01-01T00:00:00.000000Z', 'lo': '2026-02-01T00:00:00.000000Z'}})))
add('sl-scalar-extra', kindvec('slice', ms({'d': {'type': 'date', 'value': '2026-01-01', 'lo': 'x'}, 'e': '*'})))
add('sl-arg-number-json', kindvec('slice', ms({'d': 5, 'e': '*'})))
add('sl-arg-star-other', kindvec('slice', ms({'d': '**'})))
add('sl-empty-object', kindvec('slice', {}))
add('sl-array', kindvec('slice', []))
add('sl-asof', kindvec('slice', {**ms({'d': '*'}), 'asof': '2026-01-01T00:00:00.000000Z'}))
add('sl-mixed-version-cell', kindvec('slice', {**ms({'d': '*'}), 'from': '2026-01-01T00:00:00.000000Z'}))
CELL = {'args': {'item': {'type': 'string', 'value': 'bolt'}}, 'fn': 'price', 'fn_hash': H, 'ns': 'data.example.org'}
def vs(cell=CELL, f='2026-01-01T00:00:00.000000Z', t='2026-05-01T00:00:00.000000Z'): return {'cell': cell, 'from': f, 'to': t}
add('vs-marker-name-limit', kindvec('slice', vs(cell={**CELL, 'args': {'item': '*'}, 'ns': 'data.example.org' + ('/' + 'a' * 60) * 9})))
add('vs-from-after-to', kindvec('slice', vs(f='2026-06-01T00:00:00.000000Z')))
add('vs-marker-badfrom', kindvec('slice', vs(cell={**CELL, 'args': {'item': '*'}}, f='x')))
add('vs-marker-badns', kindvec('slice', vs(cell={**CELL, 'args': {'item': '*'}, 'ns': 'Bad'})))
add('vs-range-in-cell', kindvec('slice', vs(cell={**CELL, 'args': {'item': {'type': 'string', 'hi': 'b', 'lo': 'a'}}})))
add('vs-cell-badns-badfrom', kindvec('slice', vs(cell={**CELL, 'ns': 'Bad'}, f='x')))
add('vs-badfrom-badto', kindvec('slice', vs(f='x', t='2026-13-01T00:00:00.000000Z')))
add('vs-missing-to', kindvec('slice', {'cell': CELL, 'from': '2026-01-01T00:00:00.000000Z'}))
add('vs-extra', kindvec('slice', {**vs(), 'x': 1}))
add('vs-cell-extra', kindvec('slice', vs(cell={**CELL, 'asof': '2026-01-01T00:00:00.000000Z'})))
add('vs-cell-noargs', kindvec('slice', vs(cell={**CELL, 'args': {}})))
add('vs-equal', kindvec('slice', vs(f='2026-01-01T00:00:00.000000Z', t='2026-01-01T00:00:00.000000Z')))

# ------------------------------------------------------------------ manifests
R = ms({'date': {'type': 'date', 'hi': '2026-03-05', 'lo': '2026-03-01'}})
HX = ['%064x' % i for i in range(1, 4)]
def man(members, sl=R): return {'members': members, 'slice': sl}
add('mf-members-notarray', kindvec('slice', man('x')))
add('mf-members-nonstring', kindvec('slice', man([1])))
add('mf-badhex-badslice', kindvec('slice', man(['X' * 64], sl=ms({'date': D1}))))
add('mf-unsorted-badslice', kindvec('slice', man([HX[1], HX[0]], sl=ms({'date': D1}))))
add('mf-badhex-schema-slice', kindvec('slice', man(['X' * 64], sl={'x': 1})))
add('mf-unsorted-badhex-later', kindvec('slice', man([HX[1], HX[0], 'X'])))
add('mf-missing-slice', kindvec('slice', {'members': []}))
add('mf-missing-members', kindvec('slice', {'slice': R}))
add('mf-extra', kindvec('slice', {**man([]), 'x': 1}))
add('mf-slice-is-cell', kindvec('slice', man([], sl=ms({'date': D1}))))
add('mf-version', kindvec('slice', man(HX, sl=vs())))
add('mf-hex-prefix', kindvec('slice', man(['slice:' + HX[0] + ':' + HX[1]])))

# ------------------------------------------------------------------ descriptors
FX = json.loads(load('function/order.json')['input'])
def fx(mut):
    d = copy.deepcopy(FX); mut(d); return kindvec('function', d)
def setx(arg, ext, typ=None, unit=None):
    def m(d):
        a = d['signature']['args'].setdefault(arg, {'type': typ or 'string', 'valid': False})
        if typ: a['type'] = typ
        if unit is not None: a['unit'] = unit
        a['extent'] = ext
        if arg not in d['signature']['order']: d['signature']['order'].append(arg)
    return m
add('fx-extent-nonstring', fx(setx('base', [1])))
add('fx-extent-number', fx(setx('base', 5)))
add('fx-extent-int-limit', fx(setx('n', {'hi': '1' * 129, 'lo': '1'}, 'number', '1')))
add('fx-extent-int-neg0', fx(setx('n', {'hi': '-0', 'lo': '-1'}, 'number', '1')))
add('fx-extent-int-negative', fx(setx('n', {'hi': '-1', 'lo': '-5'}, 'number', '1')))
add('fx-extent-range-lohi-bad', fx(setx('n', {'hi': '1.5', 'lo': 'x'}, 'number', '1')))
add('fx-extent-range-reversed-badlo', fx(setx('date', {'hi': '2026-01-01', 'lo': '2026-13-01'})))
add('fx-extent-num-lexical-order', fx(setx('n', ['1', '01'], 'number', '1')))
add('fx-extent-num-1.50', fx(setx('n', ['1.50'], 'number', '1')))
add('fx-extent-unsorted-then-bad', fx(setx('base', ['b', 'a', 'e\u0301'])))
add('fx-extent-dup', fx(setx('base', ['a', 'a'])))
add('fx-extent-empty', fx(setx('base', [])))
add('fx-extent-bool-empty', fx(setx('f', [], 'boolean')))
add('fx-extent-blob-range', fx(setx('f', {'hi': '1', 'lo': '0'}, 'blob')))
add('fx-extent-instant-range', fx(setx('t', {'hi': '2026-01-01T00:00:00.000000Z', 'lo': '2025-01-01T00:00:00.000000Z'}, 'instant')))
add('fx-extent-instant-values', fx(setx('t', ['2025-01-01T00:00:00.000000Z', '2026-01-01T00:00:00.000000Z'], 'instant')))
add('fx-extent-instant-unsorted', fx(setx('t', ['2026-01-01T00:00:00.000000Z', '2025-01-01T00:00:00.000000Z'], 'instant')))
add('fx-extent-string-codepoint', fx(setx('base', ['\uffff', '\U00010000'])))
add('fx-extent-string-codepoint-rev', fx(setx('base', ['\U00010000', '\uffff'])))
add('fx-extent-num-neg-order', fx(setx('n', ['-10', '-9', '-1.5', '0', '0.25'], 'number', '1')))
add('fx-extent-num-neg-order-bad', fx(setx('n', ['-9', '-10'], 'number', '1')))
add('fx-extent-4097', fx(setx('base', [f's{i:05d}' for i in range(4097)])))
add('fx-extent-4097-unsorted', fx(setx('base', [f's{i:05d}' for i in range(4097)][::-1])))
add('fx-extent-4096', fx(setx('base', [f's{i:05d}' for i in range(4096)])))
add('fx-extent-string-long', fx(setx('base', ['x' * 1025])))
add('fx-extent-nounit', fx(setx('n', ['x'], 'number')))
add('fx-extent-unknowntype', fx(setx('n', {'a': 1}, 'foo')))
add('fx-extent-boolean-shape', fx(setx('f', {'hi': 'x'}, 'boolean')))
add('fx-extent-range-extra-date', fx(setx('date', {'hi': '2026-01-01', 'lo': '2025-01-01', 'x': '1'})))
add('fx-extent-valid-number', fx(lambda d: d['signature']['args'].update({'n': {'type': 'number', 'unit': '1', 'valid': True, 'extent': ['x']}}) or d['signature']['order'].append('n')))
def ordm(o): return fx(lambda d: d['signature'].__setitem__('order', o))
add('fx-order-nonstring', ordm(['base', 'quote', 5]))
add('fx-order-empty-with-args', ordm([]))
add('fx-order-badname', ordm(['base', 'quote', 'Date']))
add('fx-order-and-returns-bad', fx(lambda d: (d['signature'].__setitem__('order', ['x']), d['signature'].__setitem__('returns', 'number'))))
add('fx-order-and-extent-bad', fx(lambda d: (d['signature'].__setitem__('order', ['x']), d['signature']['args']['base'].__setitem__('extent', ['b', 'a']))))
add('fx-order-and-inputs-bad', fx(lambda d: (d['signature'].__setitem__('order', ['x']), d.__setitem__('inputs', ['b/x', 'a.org/y']))))
add('fx-order-33', ordm(['base'] * 33))
add('fx-order-null', ordm(None))
add('fx-order-schema-vs-canon', fx(lambda d: (d['signature'].__setitem__('order', ['x']), d['signature']['args']['base'].__setitem__('extent', 5))))
add('fx-noargs-order-empty', kindvec('function', {'code': {'body': '', 'lang': 'stored'}, 'inputs': [], 'signature': {'args': {}, 'order': [], 'returns': 'boolean'}}))

# ------------------------------------------------------------------ receipt inputs (step 3)
BASEV = load('receipt/slice-mixed-inputs.json')
def rvec(r, recompute=None, keys=None):
    v = {'kind': 'receipt', 'input': json.dumps(r, ensure_ascii=False), 'keys': keys if keys is not None else BASEV['keys']}
    if 'keypair' in BASEV: v['keypair'] = BASEV['keypair']
    if recompute is not None: v['recompute'] = recompute
    return v
TOP_SK = SigningKey(bytes.fromhex(BASEV['keypair']['seed']))
base_r = json.loads(BASEV['input'])
def topsign(r): return sign_with(r, TOP_SK)
def with_inputs(ins): r = dict(base_r); r['inputs'] = ins; return topsign(r)
add('in-slice-short-right', rvec(with_inputs(['slice:' + HX[0] + ':' + HX[1][:63]])))
add('in-slice-colon-only', rvec(with_inputs(['slice:' + HX[0] + HX[1]])))
add('in-slice-and-hex-dup', rvec(with_inputs([HX[0], HX[0]])))
add('in-4097-slices', rvec(with_inputs(sorted('slice:%064x:%064x' % (i, i) for i in range(4097)))))
add('in-4096-slices', rvec(with_inputs(sorted('slice:%064x:%064x' % (i, i) for i in range(4096)))))
add('in-slice-unsorted-badhex', rvec(with_inputs(['slice:' + HX[1] + ':' + HX[0], 'slice:' + HX[0] + ':' + HX[0], 'x'])))

out_path = sys.argv[1] if len(sys.argv) > 1 else None

# ------------------------------------------------------------------ step 7.5 / 7.6 (signed)
exec(open('/p/probes_0_4_verify.py', encoding='utf-8').read()) if os.path.exists('/p/probes_0_4_verify.py') else None

# ------------------------------------------------------------------ run
d = S + '/spec/vectors'
shutil.rmtree(d, ignore_errors=True)
os.makedirs(d + '/invalid')
for name, v in probes.items():
    p = dict(v); p.update({'id': 'invalid/' + name, 'description': 'probe', 'valid': False, 'error': 'E_PROBE'})
    if p['kind'] == 'receipt' and PROBE_HOST not in p.get('keys', {}):
        p['keys'] = {**p.get('keys', {}), PROBE_HOST: PROBE_ENV}
    probes[name] = p
    with open(f'{d}/invalid/{name}.json', 'w', encoding='utf-8') as f: json.dump(p, f, ensure_ascii=False)
res = subprocess.run([sys.executable, S + '/spec/tools/canon.py', 'check'], capture_output=True, text=True, cwd=S)
txt = res.stdout + res.stderr
got = {m.group(1): m.group(2) for m in re.finditer(r'FAIL vectors/invalid/(\S+)\.json\n\s+expected E_PROBE, got (.*)', txt)}
for name in probes:
    print(f'{name:36s} {got.get(name, "?? " + txt[-300:] if name not in got else "")[:150]}')
if out_path:
    with open(out_path, 'w', encoding='utf-8') as f:
        for name, v in probes.items():
            g = got.get(name, '??').split(' ')[0]
            f.write(json.dumps({'vector': v, 'oracle': g}, ensure_ascii=False) + '\n')
