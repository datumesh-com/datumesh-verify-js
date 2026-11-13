# Generates the spec-0.5.0 probes: vectors (SPEC 11) derived from the spec's own vectors by small
# mutations, each tagged with the contract item it exercises (`item`, 1-9). Writes
# /out/cases.jsonl for oracle_batch.py, which asks the reference tool (spec/tools/canon.py, a
# black box) for its verdict; the verdicts are kept as test/fixtures/oracle-probes-0.5.0.jsonl.gz
# and test/spec-0.5.0.test.mjs requires the library to give the same code.
# Usage: python probes_0_5_0.py [vectors dir] [out file]
import copy, glob, json, sys

VD = sys.argv[1] if len(sys.argv) > 1 else 'spec/vectors'
OUT = sys.argv[2] if len(sys.argv) > 2 else '/out/cases.jsonl'
V = {}
for f in glob.glob(VD + '/*/*.json'):
    d = json.load(open(f, encoding='utf-8'))
    V[d['id']] = d
cases = []


class Repl:
    """A mutation returns Repl(x) to replace the whole parsed value by x."""
    def __init__(self, v):
        self.v = v


def fin(d, r):
    return r.v if isinstance(r, Repl) else d


def add(item, base, **over):
    v = copy.deepcopy(V[base]) if base else {}
    v.update(over)
    v['id'] = 'invalid/c%03d' % (len(cases) + 1)
    v['item'] = item
    cases.append(v)
    return v


def jmut(base, field, fn):
    """The base vector's JSON-text `field` with fn applied to its parsed value."""
    d = json.loads(V[base][field])
    r = fn(d)
    return json.dumps(fin(d, r), indent=2, ensure_ascii=False)


# ---- item 1: loopback URLs (9.6, 5.5, 5.6) ------------------------------------------------
def mesh_with(origin, host='local.invalid'):
    b = copy.deepcopy(V['mesh/unrooted-loopback-port'])
    s = json.dumps(b).replace('http://127.0.0.1:8471', origin)
    v = json.loads(s)
    return v, host


ORIGINS = ['http://127.0.0.1', 'http://[::1]:8080', 'http://localhost:65535', 'http://localhost:1', 'http://localhost:65536', 'http://localhost:0',
           'http://localhost:08080', 'http://localhost:', 'http://LOCALHOST:80', 'http://127.0.0.2:80', 'http://127.1', 'http://[0:0:0:0:0:0:0:1]',
           'http://localhost.', 'http://u@localhost', 'https://127.0.0.1', 'https://localhost', 'http://0.0.0.0', 'http://[::1]', 'http://localhost:80808',
           'http://127.0.0.1:8471#', 'http://[::1', 'http://127.0.0.1:8471:1']
for o in ORIGINS:
    v, h = mesh_with(o)
    add(1, None, kind='mesh', description='probe', host=h, env=v['env'], valid=False)
for o in ['http://127.0.0.1:8471', 'http://localhost', 'http://[::1]:1']:
    v, h = mesh_with(o)
    add(1, None, kind='mesh', description='probe', host='mesh.example.org', env={'keys': json.loads(json.dumps(V['mesh/describe-endpoint']['env']['keys'])), 'mesh': v['env']['mesh']}, valid=False)
# one URL on another loopback port, one on https, a URL longer than 512 characters
b = V['mesh/unrooted-loopback-port']
mb = json.loads(b['env']['mesh']['https']['body'])
def with_mesh_doc(fn):
    d = copy.deepcopy(mb)
    fn(d)
    e = copy.deepcopy(b['env'])
    e['mesh']['https']['body'] = json.dumps(d, indent=2)
    return e
add(1, 'mesh/unrooted-loopback-port', env=with_mesh_doc(lambda d: d['endpoints'].__setitem__('cell', 'http://127.0.0.1:8472/cell/{cell}')))
add(1, 'mesh/unrooted-loopback-port', env=with_mesh_doc(lambda d: d['endpoints'].__setitem__('cell', 'http://localhost:8471/cell/{cell}')))
add(1, 'mesh/unrooted-loopback-port', env=with_mesh_doc(lambda d: d.__setitem__('bindings', 'https://local.invalid/bindings')))
add(1, 'mesh/unrooted-loopback-port', env=with_mesh_doc(lambda d: d.__setitem__('bindings', 'http://127.0.0.1:8472/bindings')))
add(1, 'mesh/unrooted-loopback-port', env=with_mesh_doc(lambda d: d['endpoints'].__setitem__('cell', 'http://127.0.0.1:8471/cell/' + 'a' * 500 + '/{cell}')))
add(1, 'mesh/unrooted-loopback-port', env=with_mesh_doc(lambda d: d['endpoints'].__setitem__('cell', 'http://127.0.0.1:8471/cell/ {cell}')))

POLL = 'http://127.0.0.1:8471/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01'
for poll, mesh in [(POLL, 'local.invalid'), ('http://localhost/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01', 'local.invalid'), ('http://[::1]:65535/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01', 'a.b.invalid'),
                   ('http://127.0.0.1:0/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01', 'local.invalid'), ('http://LOCALHOST/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01', 'local.invalid'),
                   ('https://127.0.0.1/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01', 'local.invalid'), ('https://local.invalid/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01', 'local.invalid'),
                   ('http://local.invalid/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01', 'local.invalid'), ('http://127.0.0.1:8471/jobs/ffffffffffffffffffffffffffffffff', 'local.invalid'),
                   ('http://127.0.0.1:8471/cell/4f9c2a7e1b3d5f60817a9c2e4b6d8f01', 'local.invalid'), (POLL, 'mesh.example.org'),
                   ('http://127.0.0.1:8471/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01', 'my.invalid.example.org'), ('http://localhost:8471/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01?x=1', 'local.invalid')]:
    base = V['envelope/pending-poll-loopback-unrooted']
    body = json.loads(base['input']); body['poll'] = poll
    req = dict(base['request']); req['mesh'] = mesh
    add(1, 'envelope/pending-poll-loopback-unrooted', input=json.dumps(body, indent=2), request=req, valid=False)
# a loopback poll with no mesh named is rejected, a https poll on the host asked still passes
base = V['envelope/pending-poll-loopback-unrooted']
body = json.loads(base['input']); body['poll'] = 'https://local.invalid/jobs/4f9c2a7e1b3d5f60817a9c2e4b6d8f01'
req = dict(base['request']); del req['mesh']
add(1, 'envelope/pending-poll-loopback-unrooted', input=json.dumps(body, indent=2), request=req, valid=False)
for nxt, mesh in [('http://localhost:8471/slice/rates.example.org/fx_rate?base=EUR&date=2024-03-15&quote=*&after=JPY', 'local.invalid'),
                  ('http://[::1]/slice/rates.example.org/fx_rate?base=EUR&date=2024-03-15&quote=*&after=JPY', 'local.invalid'),
                  ('http://127.0.0.1:99999/slice/rates.example.org/fx_rate?base=EUR&date=2024-03-15&quote=*&after=JPY', 'local.invalid'),
                  ('http://127.0.0.1:8471/slice/rates.example.org/fx_rate?base=EUR&date=2024-03-15&quote=*&after=JPY', 'mesh.example.org'),
                  ('http://example.org/slice/rates.example.org/fx_rate?base=EUR&date=2024-03-15&quote=*&after=JPY', 'local.invalid'),
                  ('https://local.invalid/slice/rates.example.org/fx_rate?base=EUR&date=2024-03-15&quote=*&after=JPY', 'local.invalid')]:
    base = V['envelope/slice-next-loopback-unrooted']
    body = json.loads(base['input']); body['next'] = nxt
    req = dict(base['request']); req['mesh'] = mesh
    add(1, 'envelope/slice-next-loopback-unrooted', input=json.dumps(body, indent=2), request=req, valid=False)
base = V['envelope/slice-next-loopback-unrooted']
req = dict(base['request']); del req['mesh']
add(1, 'envelope/slice-next-loopback-unrooted', request=req, valid=False)

# ---- item 3: envelopes (5.5) ---------------------------------------------------------------
def env(base, fn, status=None, **over):
    b = V[base]
    body = json.loads(b['input']); r = fn(body)
    body = fin(body, r)
    kw = dict(input=json.dumps(body, indent=2), valid=False)
    if status is not None: kw['status'] = status
    kw.update(over)
    return add(3, base, **kw)

RES = 'envelope/resolved-short-call'
LKP = 'envelope/resolved-lookup'
def setres(**kw):
    def f(b):
        b['resolved'].update(kw)
    return f
env(RES, lambda b: None)
env(LKP, lambda b: None)
env(RES, setres(call=''))
env(RES, setres(call=5))
env(RES, setres(resolutions=[]))
env(RES, setres(resolutions={}))
env(RES, setres(aliases_tx='2026-05-01'))
env(RES, lambda b: b['resolved'].pop('aliases_tx'))
env(RES, lambda b: b['resolved'].pop('call'))
env(RES, lambda b: b['resolved'].pop('resolutions'))
env(RES, setres(resolutions=[{'from': 'a', 'kind': 'alias'}]))
env(RES, setres(resolutions=[{'from': 'a', 'kind': 'alias', 'to': 'b', 'asof': '2026-06-01T00:00:00.000000Z'}]))
env(RES, setres(resolutions=[{'from': 'a', 'kind': 'alias', 'to': 'b', 'x': 'y'}]))
env(RES, setres(resolutions=[{'from': 1, 'kind': 'alias', 'to': 'b'}]))
for k in ['alias', 'default', 'method', 'lookup', 'label', 'Alias', '']:
    env(RES, setres(resolutions=[{'from': 'a', 'kind': k, 'to': 'b'}]))
env(LKP, lambda b: b['resolved']['resolutions'][0].__setitem__('asof', '2026-06-01'))
env(LKP, lambda b: b['resolved']['resolutions'][0].pop('asof'))
env(LKP, lambda b: b['resolved']['resolutions'][0].__setitem__('asof', 5))
env(RES, lambda b: b.__setitem__('resolved', 'x'))
env(RES, lambda b: b.__setitem__('resolved', None))
env(RES, lambda b: b.__setitem__('resolved', []))
for st, oc, extra in [(200, 'ok', None), (404, 'not_covered', None), (403, 'unlicensed', None), (402, 'payment_required', None), (500, 'error', 'E_INPUT_UNAVAILABLE'), (400, 'bad_request', 'E_PARSE_URI'), (429, 'rate_limited', None), (202, 'pending', None)]:
    pass
# resolved and shadows on each outcome (the optional-member columns of the table)
SH = {'class': 'rates.example.org/fx_pair', 'reference': 'ab' * 32}
for base in ['envelope/served-stale', 'envelope/job-result-ok', 'envelope/unlicensed', 'envelope/payment-required', 'envelope/error-500', 'envelope/bad-request-argument', 'envelope/rate-limited', 'envelope/pending-no-asof', 'envelope/not-covered-fault', 'envelope/slice-not-covered']:
    if 'slice_id' in V[base]['request']: continue
    env(base, lambda b: b.__setitem__('shadows', SH))
    env(base, lambda b: b.__setitem__('resolved', json.loads(V[RES]['input'])['resolved']))
NC = 'envelope/shadows-reference-class'
env(NC, lambda b: b['shadows'].update(reference='AB' * 32))
env(NC, lambda b: b['shadows'].update(reference='ab' * 31))
env(NC, lambda b: b['shadows'].update(**{'class': 'fx_pair'}))
env(NC, lambda b: b['shadows'].update(**{'class': 'Rates.example.org/fx_pair'}))
env(NC, lambda b: b['shadows'].update(extra=1))
env(NC, lambda b: b['shadows'].pop('class'))
env(NC, lambda b: b['shadows'].pop('reference'))
env(NC, lambda b: b.__setitem__('shadows', [b['shadows']]))
env(NC, lambda b: b.__setitem__('shadows', None))
env(NC, lambda b: b.__setitem__('fault', 'E_FORMULA_DIV_ZERO'))
for fault in ['E_FORMULA_KEY', 'E_FORMULA_DISPATCH_KEY', 'E_FORMULA_DISPATCH', 'E_FORMULA_TYPE', 'E_FORMULA_DIV_ZERO', 'e_formula_key', 'E_KEY_NORMALISATION']:
    env(NC, lambda b: b.__setitem__('fault', fault))
for code in ['E_NAMESPACE_SUSPENDED', 'E_NAME_UNBOUND', 'E_SHORT_ID_AMBIGUOUS', 'E_UNROOTED_INPUT', 'E_DESCRIBE', 'E_KEY_NORMALISATION', 'E_FORMULA_KEY']:
    env(NC, lambda b: b.__setitem__('error', code))
env(NC, lambda b: b.update(error='E_NAMESPACE_SUSPENDED', fault='E_FORMULA_KEY'))
env(NC, lambda b: b.update(error='E_NAMESPACE_SUSPENDED', fn_hash='7b58ecb8fd23b644c87951d0bd609790ff547cbb23fed27186c669ce2ce0aa80'))
for base, st in [('envelope/error-500', 500), ('envelope/unlicensed', 403), ('envelope/payment-required', 402), ('envelope/bad-request-argument', 400), ('envelope/not-covered-fault', 404)]:
    for code in ['E_NAMESPACE_SUSPENDED', 'E_SHORT_ID_AMBIGUOUS', 'E_UNROOTED_INPUT', 'E_DESCRIBE', 'E_KEY_ENCODING', 'E_CLASS_MEMBER', 'E_FORMULA_KEY']:
        env(base, lambda b: b.__setitem__('error', code))
env('envelope/error-500', lambda b: b.__setitem__('error', 'E_DESCRIBE'))
env('envelope/error-500', lambda b: b.__setitem__('error', 'E_KEY_NORMALISATION'))
env('envelope/error-500', lambda b: b.__setitem__('error', 'E_CLASS_OVERRIDE'))
for s in [200, 400, 404, 500]:
    env('envelope/bad-request-short-id-ambiguous', lambda b: None, status=s)
env('envelope/bad-request-short-id-ambiguous', lambda b: b.__setitem__('fn_hash', '7b58ecb8fd23b644c87951d0bd609790ff547cbb23fed27186c669ce2ce0aa80'))
env('envelope/bad-request-short-id-ambiguous', lambda b: b.__setitem__('detail', 'x'))
for s in [200, 400, 500]:
    env('envelope/not-covered-namespace-suspended', lambda b: None, status=s)
for s in [200, 404, 500]:
    env('envelope/not-covered-fault-key', lambda b: None, status=s)
    env('envelope/not-covered-fault-dispatch-key', lambda b: None, status=s)
env('envelope/job-result-ok', lambda b: b.__setitem__('fault', 'E_FORMULA_KEY'))
env('envelope/not-covered-fault-key', lambda b: b.__setitem__('error', 'E_FORMULA_KEY'))

# ---- item 4: function descriptors (7) -------------------------------------------------------
FB = 'function/argument-key-normalisation'
def fn(mut, **over):
    d = json.loads(V[FB]['input']); r = mut(d)
    d = fin(d, r)
    return add(4, FB, input=json.dumps(d, indent=2), valid=False, kind='function')
isin = lambda d: d['signature']['args']['isin']
date = lambda d: d['signature']['args']['date']
for rule in ['none', 'upper_ascii', 'nfc_strict', 'arabic_skeleton', 'hebrew_consonantal', 'greek_unaccented', 'NFC_STRICT', 'upper-ascii', '', 'lower_ascii', ' upper_ascii', 5, None, ['upper_ascii'], True]:
    fn(lambda d: isin(d).__setitem__('key_normalisation', rule))
for rule in ['upper_ascii', 'none', 'bogus']:
    fn(lambda d: date(d).__setitem__('key_normalisation', rule))
    fn(lambda d: d['signature']['args'].__setitem__('n', {'type': 'number', 'unit': '1', 'valid': False, 'key_normalisation': rule}) or d['signature']['order'].append('n'))
    fn(lambda d: d['signature']['args'].__setitem__('n', {'type': 'boolean', 'valid': False, 'key_normalisation': rule}) or d['signature']['order'].append('n'))
    fn(lambda d: d['signature']['args'].__setitem__('n', {'type': 'blob', 'valid': False, 'key_normalisation': rule}) or d['signature']['order'].append('n'))
    fn(lambda d: isin(d).update(classes=['a.example.org/k'], key_normalisation=rule))
fn(lambda d: isin(d).pop('key_normalisation'))
fn(lambda d: isin(d).update(classes=['a.example.org/k']) or isin(d).pop('key_normalisation'))
for cl in [['a.example.org/k'], ['a.example.org/a', 'b.example.org/b'], ['b.example.org/b', 'a.example.org/a'], ['a.example.org/a', 'a.example.org/a'], [], ['k'], ['A.example.org/k'], 'a.example.org/k', [5], ['a.example.org/k', 'bad'], ['bad', 'a.example.org/b', 'a.example.org/a']]:
    fn(lambda d: (isin(d).pop('key_normalisation'), isin(d).__setitem__('classes', cl)))
for cl in [['a.example.org/k']]:
    fn(lambda d: date(d).__setitem__('classes', cl))
    fn(lambda d: d['signature']['args'].__setitem__('n', {'type': 'number', 'unit': '1', 'valid': False, 'classes': cl}) or d['signature']['order'].append('n'))
    fn(lambda d: d['signature']['args'].__setitem__('n', {'type': 'boolean', 'valid': False, 'classes': cl}) or d['signature']['order'].append('n'))
    fn(lambda d: d['signature']['args'].__setitem__('n', {'type': 'blob', 'valid': False, 'classes': cl}) or d['signature']['order'].append('n'))
    fn(lambda d: isin(d).pop('key_normalisation') and None or isin(d).update(classes=cl, valid=True))
# returns
R = lambda d: d['signature']['returns']
for ret in [{'type': 'string', 'classes': ['a.example.org/k']}, {'type': 'string', 'classes': ['b.example.org/b', 'a.example.org/a']}, {'type': 'string', 'classes': ['a.example.org/k'], 'unit': '1'},
            {'type': 'number', 'classes': ['a.example.org/k'], 'unit': '1'}, {'type': 'date', 'classes': ['a.example.org/k']}, {'type': 'string', 'classes': []}, {'type': 'string', 'classes': ['bad']},
            {'type': 'string', 'classes': ['a.example.org/k', 'a.example.org/k']}, {'type': 'string'}, {'type': 'boolean', 'classes': ['a.example.org/k']}, {'type': 'string', 'classes': ['a.example.org/k'], 'key_normalisation': 'upper_ascii'},
            {'type': 'number', 'unit': '1', 'default': 'asof'}]:
    fn(lambda d: d['signature'].__setitem__('returns', ret))
# default
for typ, valid in [('date', True), ('instant', True), ('date', False), ('instant', False), ('string', False), ('string', True), ('number', True), ('boolean', True)]:
    for val in ['asof', 'now', '', 5, None, 'ASOF']:
        def mut(d, typ=typ, valid=valid, val=val):
            a = {'type': typ, 'valid': valid, 'default': val}
            if typ == 'number': a['unit'] = '1'
            d['signature']['args']['d2'] = a
            d['signature']['order'].append('d2')
        if val == 'asof' or (typ in ('date', 'instant') and valid):
            fn(mut)
fn(lambda d: date(d).__setitem__('default', 'asof'))
fn(lambda d: date(d).update(default='asof', classes=['a.example.org/k']))
fn(lambda d: isin(d).__setitem__('default', 'asof'))
# check order within an argument: type, unit, valid, then classes, default, key_normalisation, then extent
fn(lambda d: date(d).update(default='asof', key_normalisation='upper_ascii'))
fn(lambda d: isin(d).update(key_normalisation='bogus', default='now'))
fn(lambda d: isin(d).update(classes=['bad'], key_normalisation='upper_ascii'))
fn(lambda d: date(d).update(default='now', extent=[]))

# ---- item 5: classes (16.1, 16.2) -----------------------------------------------------------
CB = 'class/fx-pair'
def cl(mut, base=CB, name=None, definer=None, **over):
    b = V[base]
    d = json.loads(b['input']); r = mut(d)
    d = fin(d, r)
    kw = dict(input=json.dumps(d, indent=2), valid=False)
    if name: kw['name'] = name
    if definer:
        e = copy.deepcopy(b['env']); e['definer'] = definer; kw['env'] = e
    kw.update(over)
    return add(5, base, **kw)
cl(lambda d: None)
cl(lambda d: None, name='fx_pair')
cl(lambda d: None, name='Rates.example.org/fx_pair')
cl(lambda d: None, name='rates.example.org/Fx_Pair')
cl(lambda d: None, name='rates.example.org/fx_pair', definer='other.example.org')
cl(lambda d: None, name='other.example.org/fx_pair')
cl(lambda d: None, name='rates.example.org/fx_pair/extra')
cl(lambda d: d.update(x=1), name='other.example.org/fx_pair')
cl(lambda d: d.update(x=1), name='fx_pair')
cl(lambda d: d.update(x=1), definer='other.example.org')
cl(lambda d: d.pop('steward'), definer='other.example.org')
cl(lambda d: d.update(steward={'namespace': 'rates.example.org'}), name='other.example.org/fx')
cl(lambda d: d['keys'].update({str(i): {'type': 'boolean'} for i in range(40)}))
cl(lambda d: (d['keys'].update({'k%02d' % i: {'type': 'boolean'} for i in range(31)}), d['order'].extend(['k%02d' % i for i in range(31)])) and None)
cl(lambda d: (d['keys'].update({'k%02d' % i: {'type': 'boolean'} for i in range(30)}), d['order'].extend(['k%02d' % i for i in range(30)])) and None)
cl(lambda d: d['keys']['base'].update(type='number', unit='1') or d['keys']['base'].pop('key_normalisation'))
cl(lambda d: d['keys']['base'].update(type='date'))
cl(lambda d: d['keys']['base'].update(type='boolean') or d['keys']['base'].pop('key_normalisation'))
cl(lambda d: d['keys']['base'].update(type='instant'))
cl(lambda d: d['keys']['base'].pop('type') or d['keys']['base'].update({'class': 'iso.example.org/currency'}))
cl(lambda d: d['keys'].update(base={'class': 'iso.example.org/currency', 'key_normalisation': 'upper_ascii'}))
cl(lambda d: d['keys'].update(base={'class': 'currency'}))
cl(lambda d: d['keys'].update(base={'class': 'iso.example.org/currency', 'type': 'string'}))
cl(lambda d: d['keys'].update(base={'type': 'string'}))
cl(lambda d: d['keys'].update(base={'type': 'string', 'key_normalisation': 'none'}))
cl(lambda d: d['keys'].update(base={'type': 'string', 'key_normalisation': 5}))
cl(lambda d: d['keys'].update(base={'type': 'quux', 'key_normalisation': 'none'}))
cl(lambda d: d['keys'].update(base={'type': 'blob'}))
cl(lambda d: d['keys'].update(Base=d['keys'].pop('base')))
cl(lambda d: d.__setitem__('order', ['base']))
cl(lambda d: d.__setitem__('order', ['base', 'base', 'quote']))
cl(lambda d: d.__setitem__('order', ['quote', 'base']))
cl(lambda d: d.__setitem__('order', ['base', 'quote', 'x']))
cl(lambda d: d.__setitem__('order', []))
cl(lambda d: d['methods'].update({'Rate': d['methods'].pop('rate')}))
cl(lambda d: d['methods'].update({'rate': 'AB' * 32}))
cl(lambda d: d['methods'].update({'rate': 'ab' * 31}))
cl(lambda d: d.__setitem__('methods', {}))
cl(lambda d: d.__setitem__('methods', []))
cl(lambda d: d['steward'].update(process='http://rates.example.org/classes/change'))
cl(lambda d: d['steward'].update(process='https://rates.example.org/x y'))
cl(lambda d: d['steward'].update(namespace='Rates'))
cl(lambda d: d['steward'].update(extra=1))
cl(lambda d: d.update(parent='ab' * 32))
cl(lambda d: d.update(parent='AB'))
cl(lambda d: d.update(parent=5))
cl(lambda d: d.update(final=False))
cl(lambda d: d.update(final=True))
cl(lambda d: d.update(final=True, open=['rate']))
cl(lambda d: d.update(final=True, open=['rate', 'rate']))
cl(lambda d: d.update(final=True, open=['zzz']))
cl(lambda d: d.update(final=True, open=[]))
cl(lambda d: d.update(open=['rate']))
cl(lambda d: d.update(maps=['http://example.org/a']))
cl(lambda d: d.update(maps=['b:c', 'a:b']))
cl(lambda d: d.update(maps=[]))
cl(lambda d: d.update(maps=['nocolon']))
cl(lambda d: d.update(maps=['a:' + 'x' * 600]))
cl(lambda d: d.update(inverse=['isin']))
cl(lambda d: d.update(inverse=['b', 'a']))
cl(lambda d: d.update(inverse=[]))
cl(lambda d: d.update(lookup='rate'))
cl(lambda d: d.update(lookup='nonesuch'))
cl(lambda d: d.update(lookup=5))
cl(lambda d: d.update(extent={}))
cl(lambda d: d.update(extent={'exists': 'ab' * 32}))
cl(lambda d: d.update(extent={'exists': 'zz'}))
cl(lambda d: d.update(extent={'other': 'ab' * 32}))
cl(lambda d: d.update(implements=['ab' * 32]))
cl(lambda d: d.update(implements=[]))
cl(lambda d: d.update(implements=['ab' * 32, 'aa' * 32]))
cl(lambda d: d.update(extra=1))
cl(lambda d: Repl([]))
cl(lambda d: Repl('x'))
# check order (16.1): structure first, then keys, order, methods, steward, parent, ...
cl(lambda d: (d.update(extra=1), d['keys']['base'].update(type='blob')))
cl(lambda d: (d['keys']['base'].update(type='blob'), d.__setitem__('order', ['base'])))
cl(lambda d: (d.__setitem__('order', ['base']), d['methods'].update({'Rate': d['methods'].pop('rate')})))
cl(lambda d: (d['methods'].update({'Rate': d['methods'].pop('rate')}), d['steward'].update(process='http://x.example.org/')))
cl(lambda d: (d['steward'].update(process='http://x.example.org/'), d.update(parent='ab' * 32)))
cl(lambda d: (d.update(parent='ab' * 32), d.update(open=['rate'])))
cl(lambda d: (d.update(open=['rate']), d.update(maps=['nocolon'])))
cl(lambda d: (d.update(maps=['nocolon']), d.update(inverse=['isin'])))
cl(lambda d: (d['keys']['base'].update(type='number'), d['keys']['quote'].update(type='blob')))
cl(lambda d: (d['keys']['quote'].update(type='blob'), d['keys']['base'].update(type='number', unit='1'), d['keys']['base'].pop('key_normalisation')))
# the parent check: unknown parent comes before the method checks
cl(lambda d: (d.update(parent='ab' * 32), d['methods'].update(rate='cd' * 32)))
cl(lambda d: d['methods'].update(rate='cd' * 32))
cl(lambda d: d['methods'].update(cross='cd' * 32))
# method/key normalisation match (E_CLASS_METHOD)
for rule in ['none', 'nfc_strict', 'arabic_skeleton']:
    cl(lambda d: d['keys']['base'].update(key_normalisation=rule))
    cl(lambda d: d['keys']['quote'].update(key_normalisation=rule))
cl(lambda d: [d['keys'][k].update(key_normalisation='none') for k in ('base', 'quote')] and None, base='class/keyed-none-ruleless-methods')
cl(lambda d: [d['keys'][k].update(key_normalisation='upper_ascii') for k in ('base', 'quote')] and None, base='class/keyed-none-ruleless-methods')
cl(lambda d: d['keys']['base'].update(key_normalisation='upper_ascii'), base='class/keyed-none-ruleless-methods')
cl(lambda d: d['keys']['base'].update(key_normalisation='nfc_strict'), base='class/keyed-none-ruleless-methods')
# lookup (D93)
cl(lambda d: None, base='class/lookup')
cl(lambda d: d.update(lookup='rate'), base='class/lookup')
cl(lambda d: d.pop('lookup'), base='class/lookup')
cl(lambda d: d['methods'].update(named='ab' * 32), base='class/lookup')
# subclass / flattening / owner (16.2)
for b in ['class/subclass-flattened', 'class/subclass-override', 'class/subclass-of-final-adds', 'class/subclass-of-final-overrides-open']:
    cl(lambda d: None, base=b)
    cl(lambda d: None, base=b, definer='other.example.org')
    cl(lambda d: d.pop('parent') if 'parent' in d else None, base=b)
    cl(lambda d: d.update(parent='ab' * 32), base=b)
    cl(lambda d: d.update(final=True), base=b)
    cl(lambda d: d.update(final=True, open=sorted(d['methods'])[:1]), base=b)
    cl(lambda d: d['keys'].update(base={'type': 'string', 'key_normalisation': 'upper_ascii'}), base=b)
    cl(lambda d: d.update(order=['base']), base=b)
    cl(lambda d: d.update(parent=d.get('parent', 'ab' * 32), x=1), base=b)

# ---- item 6: key normalisation (16.4) --------------------------------------------------------
NB = 'normalisation/upper-ascii'
def nm(rule, text):
    add(6, NB, rule=rule, text=text, valid=False)
TEXTS = {
    'none': ['', 'x y', 'é', '‍', 'Λόγος', ' ', '\t', 'a\nb', '﻿', 'é'],
    'upper_ascii': ['EUR', '1M', 'XAMS:ASML', '~!', 'A.B-C_D', '', 'eur', 'EUr', 'EUR ', ' EUR', 'E UR', 'É', 'EUR\n', '\x7f', '\x1f', 'Á', 'Ａ', 'a', 'z', '`', '{', '@', '[', '0'],
    'nfc_strict': ['a b', 'a  b', ' a', 'a ', '', 'a b', 'a b', 'a b', 'a‍b', 'a​b', 'é', 'é', 'a\tb', 'a\nb', 'a　b', 'a b', '﻿', '­', 'a\x00b', '가', '가', 'Λόγος', 'x'],
    'arabic_skeleton': ['بسم ٱلله', '', 'بَ', 'ـ', 'بـس', 'ٰ', 'ؐ', 'ؚ', '؛', 'ً', 'ٟ', '٠', 'ۖ', 'ۜ', '۝', '۞', '۟', 'ۨ', '۩', '۪', 'ۭ', 'ۮ', 'abc', 'é'],
    'hebrew_consonantal': ['בראשית', '', 'את־השמים', 'בְ', 'ב֑', '֑', 'ֽ', '־', 'ֿ', '׀', 'ׁ', 'ׂ', '׃', 'ׄ', 'ׅ', '׆', 'ׇ', '׈', 'א ב', 'abc'],
    'greek_unaccented': ['λογος', '', 'λόγος', 'λόγος', 'ά', 'Ϊ', 'ϊ', 'ΐ', 'ᾳ', 'ἀ', 'ͅ', '̀', 'ͯ', 'Ͱ', 'abc', 'Ω', 'ῶ'],
    # (A rule outside the closed list is not a vector's case: the reference reports E_CLASS_MEMBER, which SPEC 16.4 does not say.)
}
for rule, ts in TEXTS.items():
    for t in ts: nm(rule, t)

# ---- item 7: object keys (16.5) --------------------------------------------------------------
KB = 'key/currency'
def ky(text, valid=False):
    add(7, KB, input=text, valid=False)
for t in ['a.example.org/k()', 'a.example.org/k(a:true)', 'a.example.org/k(a:false,b:true)', 'a.example.org/k(a:"x""y")', 'a.example.org/k(a:"")', 'a.example.org/k(a:2024-03-15)', 'a.example.org/k(a:2024-03-15T09:00:00.000000Z)',
          'a.example.org/k(a:1)', 'a.example.org/k(a:-1.5)', 'a.example.org/k(a:0)', 'a.example.org/k(a:1.50)', 'a.example.org/k(a:01)', 'a.example.org/k(a:+1)', 'a.example.org/k(a:1.)', 'a.example.org/k(a:.5)', 'a.example.org/k(a:1e3)', 'a.example.org/k(a:-0)',
          'a.example.org/k(a:2024-3-15)', 'a.example.org/k(a:2024-03-15T09:00:00Z)', 'a.example.org/k(a:2024-03-15T09:00:00.000000+00:00)', 'a.example.org/k(a:True)', 'a.example.org/k(a:TRUE)', "a.example.org/k(a:'x')", 'a.example.org/k(a:x)',
          'a.example.org/k(a:"x)', 'a.example.org/k(a:"x" )', 'a.example.org/k(a: 1)', 'a.example.org/k(a:1, b:2)', 'a.example.org/k(a:1,b:2)', 'a.example.org/k(b:2,a:1)', 'a.example.org/k(a:1,a:2)', 'a.example.org/k(a:1,)', 'a.example.org/k(,)', 'a.example.org/k(a)',
          'a.example.org/k(a:)', 'a.example.org/k(:1)', 'a.example.org/k(A:1)', 'a.example.org/k(a-b:1)', 'a.example.org/k(a_b:1)', 'a.example.org/k(asof:1)', 'a.example.org/k(a:1)x', ' a.example.org/k()', 'a.example.org/k() ', 'a.example.org/k', 'a.example.org/k(', 'a.example.org/k)',
          'A.example.org/k()', 'a.example.org/K()', 'k()', 'a.example.org()', 'a.example.org/k/m()', 'a.example.org/k.m()', 'a/k()', 'a.example.org/k(a:b.example.org/c())', 'a.example.org/k(a:b.example.org/c(x:1))', 'a.example.org/k(a:b.example.org/c(x:1),z:2)',
          'a.example.org/k(a:"b.example.org/c()")', 'a.example.org/k(a:b.example.org/C())', 'a.example.org/k(a:b.example.org/c(x:2,x:1))', 'a.example.org/k(a:b.example.org/c(x:1)', 'a.example.org/k(a:"café")', 'a.example.org/k(a:"café")', 'a.example.org/k(a:"é")',
          'a.example.org/k(a:"line\nbreak")', 'a.example.org/k(a:"\u0000")', 'a.example.org/k(a:"\\n")', 'a.example.org/k(a:"a\\"b")', 'a.example.org/k(a:"%41")', 'a.example.org/k(a:1)\n', 'a.example.org/ké()', 'xn--e1afmkfd.example.org/k()', 'a.example.org/k(é:1)',
          'a.example.org/k(a:' + '"' + 'x' * 1030 + '")', 'a.example.org/k(a:9007199254740993)', 'a.example.org/k(a:1.0)', 'a.example.org/k(a:0.5)', 'a.example.org/k(a:-0.5)', 'a.example.org/k(a:00.5)']:
    ky(t)

# ---- item 8: describe (16.8) -----------------------------------------------------------------
DC, DO = 'describe/class', 'describe/object'
def dc(mut, base=DC, **over):
    d = json.loads(V[base]['input']); r = mut(d)
    d = fin(d, r)
    kw = dict(input=json.dumps(d, indent=2), valid=False)
    kw.update(over)
    return add(8, base, **kw)
dc(lambda d: None)
dc(lambda d: None, base=DO)
dc(lambda d: d.update(x=1))
dc(lambda d: d.update(x=1), base=DO)
for k in ['kind', 'class', 'class_hash', 'descriptor', 'methods']:
    dc(lambda d: d.pop(k))
for k in ['kind', 'object', 'object_id', 'short_id', 'call', 'methods']:
    dc(lambda d: d.pop(k), base=DO)
dc(lambda d: d.pop('same_as'), base=DO)
dc(lambda d: d.update(same_as=[]), base=DO)
dc(lambda d: d.update(same_as=['x']), base=DO)
dc(lambda d: d.update(same_as=[5]), base=DO)
dc(lambda d: d.update(same_as=d['same_as'] * 2), base=DO)
dc(lambda d: d.update(same_as=['bible.example.org/passage(osis:"Gen.1.1")', 'bible.example.org/passage(osis:"Gen.1.1")']), base=DO)
dc(lambda d: d.update(same_as=['bible.example.org/passage(osis:"Gen.1.2")', 'bible.example.org/passage(osis:"Gen.1.1")']), base=DO)
dc(lambda d: d.update(same_as='bible.example.org/passage(osis:"Gen.1.1")'), base=DO)
dc(lambda d: d.update(kind='Class'))
dc(lambda d: d.update(kind='object'))
dc(lambda d: d.update(kind='class'), base=DO)
dc(lambda d: d.update(kind=5))
dc(lambda d: d.update(**{'class': 'rates.example.org/other'}))
dc(lambda d: d.update(**{'class': 'Bad'}))
dc(lambda d: d.update(class_hash='ab' * 32))
dc(lambda d: d.update(class_hash=d['class_hash'].upper()))
dc(lambda d: d.update(class_hash=d['class_hash'][:-1]))
dc(lambda d: d['descriptor'].update(x=1))
dc(lambda d: d['descriptor']['steward'].update(process='https://rates.example.org/other'))
dc(lambda d: d['descriptor']['keys']['base'].update(key_normalisation='none'))
dc(lambda d: d['methods'].pop(sorted(d['methods'])[0]))
dc(lambda d: d['methods'].update(extra=copy.deepcopy(d['methods'][sorted(d['methods'])[0]])))
for m in ['rate', 'spot']:
    for f in ['fn', 'fn_hash', 'args', 'returns']:
        dc(lambda d: d['methods'][m].pop(f))
    dc(lambda d: d['methods'][m].update(fn='rates.example.org/fx_pair/other'))
    dc(lambda d: d['methods'][m].update(fn_hash='ab' * 32))
    dc(lambda d: d['methods'][m].update(fn_hash=d['methods'][m]['fn_hash'].upper()))
    dc(lambda d: d['methods'][m].update(args={}))
    dc(lambda d: d['methods'][m].update(args={'date': {'type': 'string', 'valid': False}}))
    dc(lambda d: d['methods'][m].update(args={'base': {'type': 'string', 'valid': False, 'key_normalisation': 'upper_ascii'}, **d['methods'][m]['args']}))
    dc(lambda d: d['methods'][m].update(returns={'type': 'string'}))
    dc(lambda d: d['methods'][m].update(returns={'type': 'number', 'unit': '1'}))
    dc(lambda d: d['methods'][m].update(description='x'))
    dc(lambda d: d['methods'][m].update(description=''))
    dc(lambda d: d['methods'][m].update(description='x' * 1024))
    dc(lambda d: d['methods'][m].update(description='x' * 1025))
    dc(lambda d: d['methods'][m].update(description='é' * 513))
    dc(lambda d: d['methods'][m].update(description='é' * 512))
    dc(lambda d: d['methods'][m].update(description=5))
    dc(lambda d: d['methods'][m].update(extra=1))
dc(lambda d: d.update(object_id='ab' * 32), base=DO)
dc(lambda d: d.update(object_id=d['object_id'].upper()), base=DO)
dc(lambda d: d.update(short_id=d['object_id'][:12].upper()), base=DO)
dc(lambda d: d.update(short_id=d['object_id'][:13]), base=DO)
dc(lambda d: d.update(short_id=d['object_id'][1:13]), base=DO)
dc(lambda d: d.update(short_id=''), base=DO)
dc(lambda d: d['object'].update(class_hash='ab' * 32), base=DO)
dc(lambda d: d['object']['keys'].pop('verse'), base=DO)
dc(lambda d: d['object']['keys'].update(extra={'type': 'string', 'value': 'x'}), base=DO)
dc(lambda d: d['object']['keys'].update(verse={'type': 'number', 'value': '2'}), base=DO)
dc(lambda d: d['object']['keys'].update(book={'type': 'number', 'value': '1'}), base=DO)
dc(lambda d: d['object'].update(**{'class': 'rates.example.org/fx_pair'}), base=DO)
dc(lambda d: d['object'].update(**{'class': 'scripture.example.org/nonesuch'}), base=DO)
dc(lambda d: d.update(call='scripture.example.org/verse(verse: 1, book: "Gen", chapter: 1, corpus: "tanakh")'), base=DO)
dc(lambda d: d.update(call='scripture.example.org/verse(book: "Gen", chapter: 1, corpus: "tanakh", verse: 2)'), base=DO)
dc(lambda d: d.update(call='scripture.example.org/verse(book: "Gen", chapter: "1", corpus: "tanakh", verse: 1)'), base=DO)
dc(lambda d: d.update(call='scripture.example.org/verse(book:"Gen",chapter:1,corpus:"tanakh",verse:1)'), base=DO)
dc(lambda d: d.update(call='scripture.example.org/other(book: "Gen", chapter: 1, corpus: "tanakh", verse: 1)'), base=DO)
dc(lambda d: d.update(methods=['consonantal', 'text']), base=DO)
dc(lambda d: d.update(methods=['consonantal', 'next', 'text', 'zzz']), base=DO)
dc(lambda d: d.update(methods=['text', 'next', 'consonantal']), base=DO)
dc(lambda d: d.update(methods=['consonantal', 'consonantal', 'next', 'text']), base=DO)
dc(lambda d: d.update(methods=[]), base=DO)
dc(lambda d: d.update(methods={}), base=DO)
dc(lambda d: d.update(object={'class': 'a.example.org/k'}), base=DO)
# an object answer whose class the caller does not hold, and a class answer held under another name
dc(lambda d: None, base=DO, classes={})
dc(lambda d: None, base=DO, classes={'rates.example.org/fx_pair': V[DO]['classes']['rates.example.org/fx_pair']})
dc(lambda d: None, base=DC, classes={})
dc(lambda d: None, base=DC, classes={'rates.example.org/fx_pair': V[DO]['classes']['rates.example.org/fx_pair']})
dc(lambda d: None, base=DC, classes={'rates.example.org/fx_pair': V[DO]['classes']['scripture.example.org/verse']})
dc(lambda d: None, base=DO, classes={'scripture.example.org/verse': V[DO]['classes']['rates.example.org/fx_pair']})
dc(lambda d: d.update(methods=['text']), base=DO, classes={})
dc(lambda d: d.update(call='scripture.example.org/verse(corpus: "x")'), base=DO, classes={})
dc(lambda d: d.update(methods=['text']), base=DO, classes={'scripture.example.org/verse': V[DO]['classes']['scripture.example.org/verse']})
dc(lambda d: None, base=DC, classes={'scripture.example.org/verse': V[DO]['classes']['scripture.example.org/verse']})
dc(lambda d: Repl([]), base=DC)
dc(lambda d: Repl('x'), base=DC)
dc(lambda d: None, base=DC, input='not json')
dc(lambda d: None, base=DC, input='{"kind":"class","kind":"class"}')

# ---- item 9: define (2.5) --------------------------------------------------------------------
DB = 'invalid/define-rooted-reads-unrooted'
def df(name, inputs=None, mut=None):
    d = json.loads(V[DB]['input'])
    if inputs is not None: d['inputs'] = inputs
    if mut: mut(d)
    return add(9, DB, name=name, input=json.dumps(d, indent=2), valid=False)
R1, U1 = 'rates.example.org/fx_rate', 'local.invalid/fx'
for name in ['calc.example.net/total', 'local.invalid/total', 'x.local.invalid/total', 'a.b.invalid/total', 'my.invalid.example.org/total', 'invalid.example.org/total', 'localinvalid.com/total', 'local.invalid.com/total', 'invalid/total', 'LOCAL.INVALID/total',
             'local.Invalid/total', 'total', 'calc.example.net/', '/total', 'calc.example.net/Total', 'calc.example.net/a/b', 'calc.example.net/total@x', 'local.invalid', 'calc.example.net', '']:
    for inputs in [[R1], [U1], [R1, U1], [U1, R1], []]:
        df(name, inputs)
for inputs in [['invalid/fx'], ['LOCAL.INVALID/fx'], ['local.invalid'], ['x.local.invalid/a/b'], ['local.invalid/fx', 'local.invalid/fx'], ['rates.example.org/fx_rate', 'local.invalid/fx'][::-1], ['a.invalid/x', 'b.example.org/y'],
               ['b.example.org/y', 'a.invalid/x'], ['local.invalid/fx', 'a.example.org/y']]:
    df('calc.example.net/total', inputs)
    df('local.invalid/total', inputs)
df('calc.example.net/total', [U1], lambda d: d['signature'].update(order=['x']))
df('calc.example.net/total', [U1], lambda d: d.update(extra=1))
df('calc.example.net/total', [U1], lambda d: d.pop('code'))
df('total', [U1], lambda d: d.update(extra=1))
df('Total', [U1], lambda d: d.update(extra=1))
df('calc.example.net/total', [U1], lambda d: d['signature']['returns'].update(unit='bogus'))
df('calc.example.net/total', ['local.invalid/fx', 'a.example.org/y', 'b'], None)
df('calc.example.net/total', ['b', 'local.invalid/fx'], None)

with open(OUT, 'w', encoding='utf-8') as f:
    for v in cases:
        f.write(json.dumps(v, ensure_ascii=False) + '\n')
print(len(cases), 'probes')
