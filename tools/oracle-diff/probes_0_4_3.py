# Probes for the spec-0.4.3 additions (declarations in the key document, licence inheritance, the
# entitlement check, E_FOREIGN_UNAVAILABLE with detail), judged by the reference tool as a black
# box, as in probes_0_4_2.py: each probe is a vector in a scratch spec directory (/w/spec: canon.py
# and its sibling files copied unread, the schemas, units.md); one `canon.py check` run prints what
# each got. Vectors of the kinds that end in an error code (keys, envelope, batch) are invalid
# vectors with error E_PROBE, so the reference prints the code it gives ("success" when accepted).
# Licence and entitlement vectors are always valid (SPEC 11): their probes expect the sentinel
# PROBE, so the reference prints the licence, reason and entitled it gives instead.
#
#   docker run --rm -v <scratch>/w:/w -v <repo>/spec:/spec:ro -v <repo>/tools/oracle-diff:/p:ro \
#     datumesh-test python /p/probes_0_4_3.py [/out/probes-0.4.3.jsonl]
import copy, json, os, random, re, shutil, subprocess, sys

S = '/w'
VEC = '/spec/vectors'
def load(p): return json.load(open(os.path.join(VEC, p), encoding='utf-8'))
probes = {}
def add(name, v): probes[name] = v

# ---- key documents with declarations (kind keys)
KD = load('keys/declarations.json')
HOST = KD['host']
kdoc = json.loads(KD['env']['https']['body'])
E = {'licence': 'https://rates.example.org/licences/restricted', 'valid_from': '2020-01-01T00:00:00.000000Z'}
def kp(decl=None, drop=False, **doc):
    d = copy.deepcopy(kdoc)
    if drop: d.pop('declarations', None)
    elif decl is not None: d['declarations'] = decl
    d.update(doc)
    return {'kind': 'keys', 'host': HOST, 'env': {'https': {'status': 200, 'body': json.dumps(d)}}}
N = HOST + '/f'
add('k-path-namespace', kp({HOST + '/a/b/f': [E]}))
add('k-subdomain', kp({'sub.' + HOST + '/f': [E]}))
add('k-parent', kp({'example.org/f': [E]}))
add('k-other-host', kp({'calc.example.net/f': [E]}))
add('k-bare-host', kp({HOST: [E]}))
add('k-upper-fn', kp({HOST + '/F': [E]}))
add('k-upper-host', kp({'Rates.example.org/f': [E]}))
add('k-trailing-slash', kp({N + '/': [E]}))
add('k-dot-fn', kp({HOST + '/f.g': [E]}))
add('k-fn-65', kp({HOST + '/' + 'f' * 65: [E]}))
add('k-fn-64', kp({HOST + '/' + 'f' * 64: [E]}))
add('k-name-513', kp({HOST + '/' + '/'.join(['a' * 60] * 8) + '/fffffff': [E]}))
add('k-name-512', kp({HOST + '/' + '/'.join(['a' * 60] * 8) + '/ffffff': [E]}))
add('k-dm-fn', kp({HOST + '/dm_x': [E]}))
add('k-asof-fn', kp({HOST + '/asof': [E]}))
add('k-unicode-fn', kp({HOST + '/f\u00e9': [E]}))
add('k-empty-array', kp({N: []}))
add('k-not-array', kp({N: E}))
add('k-decl-null', kp(None, declarations=None))
add('k-decl-array', kp([]))
add('k-decl-string', kp('x'))
add('k-decl-empty', kp({}))
add('k-entry-string', kp({N: ['x']}))
add('k-entry-null', kp({N: [None]}))
add('k-missing-licence', kp({N: [{'valid_from': E['valid_from']}]}))
add('k-missing-from', kp({N: [{'licence': E['licence']}]}))
add('k-extra', kp({N: [dict(E, note='x')]}))
add('k-licence-number', kp({N: [dict(E, licence=5)]}))
add('k-licence-space', kp({N: [dict(E, licence='MIT License')]}))
add('k-licence-empty', kp({N: [dict(E, licence='')]}))
add('k-licence-lower', kp({N: [dict(E, licence='cc-by-nc-4.0')]}))
add('k-licence-open', kp({N: [dict(E, licence='MIT')]}))
add('k-licence-url-512', kp({N: [dict(E, licence='https://' + 'a' * 504)]}))
add('k-licence-url-513', kp({N: [dict(E, licence='https://' + 'a' * 505)]}))
add('k-licence-url-space', kp({N: [dict(E, licence='https://a b')]}))
add('k-licence-http', kp({N: [dict(E, licence='http://example.org/l')]}))
add('k-spdx-64', kp({N: [dict(E, licence='A' * 64)]}))
add('k-spdx-65', kp({N: [dict(E, licence='A' * 65)]}))
add('k-bad-instant', kp({N: [dict(E, valid_from='2020-01-01T00:00:00Z')]}))
add('k-from-number', kp({N: [dict(E, valid_from=5)]}))
add('k-to-null', kp({N: [dict(E, valid_to=None)]}))
add('k-to-equal', kp({N: [dict(E, valid_to=E['valid_from'])]}))
add('k-to-before', kp({N: [dict(E, valid_to='2019-12-31T23:59:59.999999Z')]}))
add('k-to-after', kp({N: [dict(E, valid_to='2020-01-01T00:00:00.000001Z')]}))
add('k-to-bad', kp({N: [dict(E, valid_to='2021-02-30T00:00:00.000000Z')]}))
add('k-16', kp({N: [E] * 16}))
add('k-17', kp({N: [E] * 17}))
add('k-64', kp({f'{HOST}/f{i}': [E] for i in range(64)}))
add('k-65', kp({f'{HOST}/f{i}': [E] for i in range(65)}))
add('k-duplicate-entries', kp({N: [E, E]}))
add('k-valid-decl-bad-key', kp({N: [E]}, keys=[dict(kdoc['keys'][0], alg='rsa')]))
add('k-no-declarations', kp(drop=True))
add('k-declaration-member', kp(drop=True, declaration={}))

# ---- E_FOREIGN_UNAVAILABLE (kind envelope, batch)
EF = load('envelope/error-foreign-unavailable.json')
REQ = EF['request']
PIN = '7b58ecb8fd23b644c87951d0bd609790ff547cbb23fed27186c669ce2ce0aa80'
def ep(body, status=502, request=None):
    return {'kind': 'envelope', 'input': json.dumps(body), 'status': status, 'request': REQ if request is None else request, 'keys': {}}
F = {'outcome': 'error', 'error': 'E_FOREIGN_UNAVAILABLE'}
for d in ['offline', 'network', 'dns', 'tls', 'timeout', 'refused']: add('e-detail-' + d, ep(dict(F, detail=d)))
add('e-no-detail', ep(F))
add('e-detail-upper', ep(dict(F, detail='DNS')))
add('e-detail-number', ep(dict(F, detail=5)))
add('e-detail-null', ep(dict(F, detail=None)))
add('e-detail-empty', ep(dict(F, detail='')))
add('e-detail-other', ep(dict(F, detail='unreachable')))
for s in [500, 501, 503, 504, 599, 200, 400, 404]: add(f'e-status-{s}', ep(dict(F, detail='dns'), s))
add('e-other-code-detail', ep({'outcome': 'error', 'error': 'E_EVAL_UNAVAILABLE', 'detail': 'dns'}))
add('e-other-code-502', ep({'outcome': 'error', 'error': 'E_EVAL_UNAVAILABLE'}))
add('e-mesh-doc-detail', ep({'outcome': 'error', 'error': 'E_MESH_DOC', 'detail': 'dns'}))
add('e-not-covered', ep({'outcome': 'not_covered', 'error': 'E_FOREIGN_UNAVAILABLE', 'detail': 'dns'}, 404))
add('e-not-covered-502', ep({'outcome': 'not_covered', 'error': 'E_FOREIGN_UNAVAILABLE', 'detail': 'dns'}))
add('e-bad-request', ep({'outcome': 'bad_request', 'error': 'E_FOREIGN_UNAVAILABLE', 'detail': 'dns'}, 400))
add('e-unlicensed-detail', ep({'outcome': 'unlicensed', 'detail': 'dns'}, 403))
add('e-not-covered-detail', ep({'outcome': 'not_covered', 'detail': 'dns'}, 404))
add('e-rate-limited-detail', ep({'outcome': 'rate_limited', 'retry_after_seconds': 1, 'detail': 'dns'}, 429))
add('e-unpinned-fn-hash', ep(dict(F, detail='dns', fn_hash=PIN)))
add('e-pinned-no-echo', ep(dict(F, detail='dns'), request=dict(REQ, fn_hash=PIN)))
add('e-pinned-echo', ep(dict(F, detail='dns', fn_hash=PIN), request=dict(REQ, fn_hash=PIN)))
add('e-pinned-other-echo', ep(dict(F, detail='dns', fn_hash='0' * 64), request=dict(REQ, fn_hash=PIN)))
add('e-job-url', ep(dict(F, detail='tls'), request=dict(REQ, job='a' * 32)))
add('e-extra-member', ep(dict(F, detail='dns', note='x')))
SREQ = {'slice_id': 'a' * 64}
add('e-slice-endpoint', ep(dict(F, detail='dns'), request=SREQ))
add('e-slice-endpoint-500', ep(dict(F, detail='dns'), 500, request=SREQ))
def bp(body, status=200, n=1):
    return {'kind': 'batch', 'input': json.dumps(body), 'status': status, 'requests': [REQ] * n, 'keys': {}}
IT = {'envelope': dict(F, detail='refused'), 'status': 502}
add('b-item-502', bp([IT]))
add('b-item-500', bp([dict(IT, status=500)]))
add('b-item-no-detail', bp([{'envelope': F, 'status': 502}]))
add('b-refusal-502', bp(dict(F, detail='offline'), 502))
add('b-refusal-500', bp(dict(F, detail='offline'), 500))

# ---- licence inheritance (kind licence): valid vectors expecting the sentinel PROBE
FN = 'calc.example.net/convert'
ISSUED = '2024-03-16T09:00:00.000000Z'
U1, U2 = 'https://rates.example.org/licences/restricted', 'https://other.example.org/licence'
POOL = ['CC0-1.0', 'PDDL-1.0', 'MIT', 'Apache-2.0', 'CC-BY-4.0', 'OGL-UK-3.0', 'CC-BY-SA-4.0', 'ODbL-1.0', 'CC-BY-NC-4.0', 'cc0-1.0', 'Mit', U1, U2]
RESTRICTED = ['CC-BY-NC-4.0', 'cc0-1.0', 'Mit', U1, U2]
TIMES = ['2020-01-01T00:00:00.000000Z', '2024-03-16T08:59:59.999999Z', ISSUED, '2024-03-16T09:00:00.000001Z', '2025-01-01T00:00:00.000000Z']
def lp(licences, decl=None, mesh='CC-BY-4.0', fn=FN, issued=ISSUED):
    return {'kind': 'licence', 'licences': licences, 'declarations': decl or {}, 'fn': fn, 'issued': issued, 'mesh_licence': mesh}
def entry(rng, lic):
    i = rng.randrange(len(TIMES))
    e = {'licence': lic, 'valid_from': TIMES[i]}
    if rng.random() < 0.5 and i + 1 < len(TIMES): e['valid_to'] = TIMES[rng.randrange(i + 1, len(TIMES))]
    return e
rng = random.Random(43)
for i in range(60):
    L = [rng.choice(POOL) for _ in range(rng.randrange(0, 5))]
    decl = {}
    for _ in range(rng.randrange(0, 3)):
        name = FN if rng.random() < 0.8 else 'calc.example.net/other'
        decl.setdefault(name, []).append(entry(rng, rng.choice(RESTRICTED + ['MIT'])))
    add(f'l-random-{i:02d}', lp(L, decl, mesh=rng.choice(POOL)))
add('l-to-at-issued', lp([U1], {FN: [{'licence': U1, 'valid_from': TIMES[0], 'valid_to': ISSUED}]}))
add('l-from-at-issued', lp([U1], {FN: [{'licence': U1, 'valid_from': ISSUED}]}))
add('l-sa-restricted-declared', lp(['ODbL-1.0', U1], {FN: [{'licence': U1, 'valid_from': TIMES[0]}]}))
add('l-sa-two-restricted', lp(['ODbL-1.0', U1, U2]))
add('l-two-restricted-declared', lp([U1, U2], {FN: [{'licence': U1, 'valid_from': TIMES[0]}, {'licence': U2, 'valid_from': TIMES[0]}]}))
add('l-restricted-closed-and-open', lp([U1], {FN: [{'licence': U1, 'valid_from': TIMES[0], 'valid_to': TIMES[1]}, {'licence': U1, 'valid_from': TIMES[1]}]}))
add('l-declared-open-licence', lp(['MIT'], {FN: [{'licence': 'MIT', 'valid_from': TIMES[0]}]}))
add('l-no-inputs-declared', lp([], {FN: [{'licence': U1, 'valid_from': TIMES[0]}]}, mesh=U2))
add('l-path-fn', lp([U1], {'calc.example.net/a/convert': [{'licence': U1, 'valid_from': TIMES[0]}]}, fn='calc.example.net/a/convert'))
add('l-decl-other-host-name', lp([U1], {'rates.example.org/convert': [{'licence': U1, 'valid_from': TIMES[0]}]}))

# ---- entitlement (kind entitlement): valid vectors expecting the sentinel PROBE
def entp(base, decl_mod=None, drop_receipts=False, drop_manifests=False):
    v = copy.deepcopy(load(base))
    for k in ['id', 'description', 'valid', 'entitled', 'reason']: v.pop(k, None)
    if decl_mod is not None:
        body = json.loads(v['keys']['calc.example.net']['https']['body'])
        decl_mod(body)
        if body.get('declarations') == {}: body.pop('declarations')
        v['keys']['calc.example.net']['https']['body'] = json.dumps(body)
    if drop_receipts: v['receipts'] = {}
    if drop_manifests: v['manifests'] = {}
    return v
RD = 'entitlement/restricted-declared.json'
def close_at(t):
    def f(b):
        for es in b['declarations'].values():
            for e in es: e['valid_to'] = t
    return f
def open_at(t):
    def f(b):
        for es in b['declarations'].values():
            for e in es: e['valid_from'] = t; e.pop('valid_to', None)
    return f
def rename(b): b['declarations'] = {'calc.example.net/other': next(iter(b['declarations'].values()))}
def nodecl(b): b.pop('declarations', None)
r_issued = json.loads(load(RD)['input'])['issued']
add('n-closed-at-issued', entp(RD, close_at(r_issued)))
add('n-opens-at-issued', entp(RD, open_at(r_issued)))
add('n-other-function', entp(RD, rename))
add('n-no-declarations', entp(RD, nodecl))
add('n-open-with-declarations', entp('entitlement/open-inherited.json', lambda b: b.update(declarations={'calc.example.net/convert': [{'licence': 'CC-BY-4.0', 'valid_from': '2020-01-01T00:00:00.000000Z'}]})))
# (A missing input receipt or manifest is not probed: the reference raises ValueError for it,
# where this library raises E_INPUT_UNAVAILABLE, DEFECTS.md 57.)

out_path = sys.argv[1] if len(sys.argv) > 1 else None
d = S + '/spec/vectors'
shutil.rmtree(d, ignore_errors=True)
for g in ['invalid', 'licence', 'entitlement']: os.makedirs(f'{d}/{g}')
VALID_KINDS = {'licence': ('licence', {'licence': 'PROBE', 'reason': 'PROBE'}), 'entitlement': ('entitlement', {'entitled': 'PROBE', 'reason': 'PROBE'})}
for name, v in probes.items():
    p = dict(v)
    if v['kind'] in VALID_KINDS:
        g, sentinel = VALID_KINDS[v['kind']]
        p.update({'id': f'{g}/{name}', 'description': 'probe', 'valid': True}, **sentinel)
    else:
        g = 'invalid'
        p.update({'id': 'invalid/' + name, 'description': 'probe', 'valid': False, 'error': 'E_PROBE'})
    probes[name] = p
    with open(f'{d}/{g}/{name}.json', 'w', encoding='utf-8') as f: json.dump(p, f, ensure_ascii=False)
res = subprocess.run([sys.executable, S + '/spec/tools/canon.py', 'check'], capture_output=True, text=True, cwd=S)
txt = res.stdout + res.stderr
# Blocks: "FAIL vectors/<g>/<name>.json" followed by indented lines.
blocks = {}
for m in re.finditer(r'^FAIL vectors/(\w+)/(\S+)\.json\n((?:[ \t]+.*\n?)*)', txt, re.M):
    blocks[m.group(2)] = m.group(3)
def verdict(name, p):
    b = blocks.get(name)
    if b is None: return '??'
    if p['kind'] in VALID_KINDS:
        m = re.search(r'expected success, got (\S+)', b) or re.search(r"(?:error|got) (E_[A-Z_]+)", b)
        fields = dict(re.findall(r"(\w+): expected 'PROBE', got (.*)", b))
        if not fields and m: return m.group(1)
        if not fields: return '?? ' + b.strip()[:200]
        conv = lambda s: None if s == 'None' else True if s == 'True' else False if s == 'False' else s.strip("'")
        if p['kind'] == 'licence': return json.dumps({'licence': conv(fields['licence']), 'reason': conv(fields['reason'])})
        return json.dumps({'entitled': conv(fields['entitled']), 'reason': conv(fields['reason'])})
    m = re.search(r'expected E_PROBE, got (.*)', b)
    return m.group(1).split(' ')[0] if m else '?? ' + b.strip()[:200]
for name, p in probes.items():
    print(f'{name:32s} {verdict(name, p)[:160]}')
if out_path:
    with open(out_path, 'w', encoding='utf-8') as f:
        for name, p in probes.items():
            f.write(json.dumps({'vector': p, 'oracle': verdict(name, p)}, ensure_ascii=False) + '\n')
