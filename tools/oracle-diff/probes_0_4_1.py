# Probes for the spec-0.4.1 additions (the `pending` envelope outcome and job binding, the mesh
# document and cross-mesh resolution of SPEC 9.6), judged by the reference tool as a black box,
# as in probes_0_4.py: each probe is written as an invalid vector with error E_PROBE into a scratch
# spec directory (/w/spec: canon.py and its sibling files copied unread, the schemas, units.md),
# and one `canon.py check` run prints the code each probe actually got ("success" when accepted).
#
#   docker run --rm -v <scratch>/w:/w -v <repo>/spec:/spec:ro -v <repo>/tools/oracle-diff:/p:ro \
#     datumesh-test python /p/probes_0_4_1.py [/out/probes-0.4.1.jsonl]
import copy, json, os, re, shutil, subprocess, sys

S = '/w'
VEC = '/spec/vectors'
def load(p): return json.load(open(os.path.join(VEC, p), encoding='utf-8'))
probes = {}
def add(name, v): probes[name] = v

# ------------------------------------------------------------------ mesh documents
FULL = load('mesh/full.json')
KEYDOC = json.loads(FULL['env']['keys']['https']['body'])
MESHDOC = json.loads(FULL['env']['mesh']['https']['body'])
HOST = FULL['host']
def env(body, status=200):
    h = {'status': status}
    if body is not None: h['body'] = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
    return {'https': h}
def mesh(keys=KEYDOC, doc=MESHDOC, kstatus=200, mstatus=200, host=HOST, drop=()):
    e = {'keys': env(keys, kstatus), 'mesh': env(doc, mstatus)}
    for d in drop: e.pop(d)
    return {'kind': 'mesh', 'host': host, 'env': e}
def md(**kw):
    d = copy.deepcopy(MESHDOC)
    for k, v in kw.items():
        if v is None: d.pop(k, None)
        else: d[k] = v
    return d
def ep(**kw):
    e = copy.deepcopy(MESHDOC['endpoints'])
    for k, v in kw.items():
        if v is None: e.pop(k, None)
        else: e[k] = v
    return md(endpoints=e)
def kd(**kw):
    d = copy.deepcopy(KEYDOC)
    for k, v in kw.items():
        if v is None: d.pop(k, None)
        else: d[k] = v
    return d
U = 'https://mesh.example.org'
add('m-ok', mesh())
add('m-keys-array', mesh(keys=[]))
add('m-keys-string', mesh(keys='"x"'))
add('m-keys-no-proto', mesh(keys=kd(proto=None)))
add('m-keys-no-host', mesh(keys=kd(host=None)))
add('m-keys-host-number', mesh(keys=kd(host=5)))
add('m-keys-proto-number', mesh(keys=kd(proto=1)))
add('m-both-proto-2', mesh(keys=kd(proto='datumesh/2'), doc=md(proto='datumesh/2')))
add('m-keys-bad-keys', mesh(keys=kd(keys=[])))
add('m-keys-extra', mesh(keys=kd(x=1)))
add('m-keys-200-nobody', mesh(keys=None))
add('m-mesh-200-nobody', mesh(doc=None))
add('m-mesh-status-string', mesh(mstatus='200'))
add('m-mesh-status-error', mesh(mstatus='error'))
add('m-keys-status-string', mesh(kstatus='200'))
add('m-both-404', mesh(kstatus=404, mstatus=404))
add('m-mesh-absent', mesh(drop=('mesh',)))
add('m-keys-absent', mesh(drop=('keys',)))
add('m-both-malformed', mesh(keys='{', doc='{'))
add('m-mesh-malformed-keys-other-host', mesh(keys=kd(host='other.example.org'), doc='{'))
add('m-keys-malformed-mesh-other-host', mesh(keys='{', doc=md(host='other.example.org')))
add('m-mesh-host-number', mesh(doc=md(host=5)))
add('m-mesh-no-host', mesh(doc=md(host=None)))
add('m-mesh-no-proto', mesh(doc=md(proto=None)))
add('m-mesh-host-upper', mesh(doc=md(host='MESH.example.org')))
add('m-fetched-upper', mesh(host='MESH.example.org'))
add('m-fetched-not-dns', mesh(host='mesh', keys=kd(host='mesh'), doc=md(host='mesh')))
add('m-mesh-keydoc-bad-and-endpoint-bad', mesh(keys=kd(keys=[]), doc=ep(cell='x')))
add('m-bindings-missing', mesh(doc=md(bindings=None)))
add('m-bindings-number', mesh(doc=md(bindings=5)))
add('m-bindings-nopath', mesh(doc=md(bindings=U)))
add('m-bindings-slash', mesh(doc=md(bindings=U + '/')))
add('m-bindings-query', mesh(doc=md(bindings=U + '?x=1')))
add('m-bindings-brace', mesh(doc=md(bindings=U + '/b/{x}')))
add('m-bindings-port', mesh(doc=md(bindings='https://mesh.example.org:443/b')))
add('m-bindings-userinfo', mesh(doc=md(bindings='https://u@mesh.example.org/b')))
add('m-bindings-513', mesh(doc=md(bindings=U + '/' + 'a' * (512 - len(U)))))
add('m-bindings-512', mesh(doc=md(bindings=U + '/' + 'a' * (511 - len(U)))))
add('m-bindings-space', mesh(doc=md(bindings=U + '/a b')))
add('m-bindings-bad-and-endpoints-missing', mesh(doc=md(bindings=5, endpoints=None)))
add('m-endpoints-array', mesh(doc=md(endpoints=[])))
add('m-endpoint-number', mesh(doc=ep(blob=5)))
add('m-endpoint-unknown-number', mesh(doc=ep(x_a=5)))
add('m-endpoint-unknown-other-host', mesh(doc=ep(x_a='https://other.example.org/x')))
add('m-endpoint-dup-placeholder', mesh(doc=ep(receipt=U + '/receipt/{hash}/{hash}')))
add('m-endpoint-other-placeholder', mesh(doc=ep(cells=U + '/cells/{cell}')))
add('m-endpoint-extra-close', mesh(doc=ep(cells=U + '/cells}')))
add('m-endpoint-lone-open', mesh(doc=ep(cells=U + '/cells{')))
add('m-endpoint-close-in-placeholder-url', mesh(doc=ep(receipt=U + '/receipt/{hash}}')))
add('m-endpoint-unknown-braces', mesh(doc=ep(x_b=U + '/{{}')))
add('m-endpoint-brace-pair', mesh(doc=ep(cells=U + '/cells{}')))
add('m-endpoint-placeholder-in-query', mesh(doc=ep(cell=U + '/cell?c={cell}')))
add('m-endpoint-placeholder-in-host', mesh(doc=ep(cell='https://{cell}.mesh.example.org/c')))
add('m-endpoint-nopath', mesh(doc=ep(cells=U)))
add('m-endpoint-port', mesh(doc=ep(cells='https://mesh.example.org:8443/cells')))
add('m-required-missing-and-bad-known', mesh(doc=ep(jobs=None, blob=5)))
add('m-two-bad-order', mesh(doc=ep(blob=5, cell='x')))
add('m-manifest-one-placeholder', mesh(doc=ep(manifest=U + '/manifest/{slice_id}')))
add('m-unknown-top-number', mesh(doc=md(x_n=5, bindings2=[1])))
add('m-mesh-dupkey', mesh(doc=json.dumps(MESHDOC)[:-1] + ', "host": "mesh.example.org"}'))
add('m-keys-nobody-mesh-404', mesh(keys=None, mstatus=404))
add('m-keys-malformed-mesh-404', mesh(keys='{', mstatus=404))
add('m-keys-bad-keys-mesh-malformed', mesh(keys=kd(keys=[]), doc='{'))
add('m-keys-array-mesh-other-host', mesh(keys=[], doc=md(host='other.example.org')))
add('m-keys-array-mesh-proto2', mesh(keys=[], doc=md(proto='datumesh/2')))
add('m-keys-nohost-mesh-proto2', mesh(keys=kd(host=None), doc=md(proto='datumesh/2')))
add('m-keys-null', mesh(keys='null'))
add('m-mesh-array', mesh(doc=[]))
add('m-keys-other-host-only', mesh(keys=kd(host='other.example.org')))
add('m-mesh-bom', mesh(doc='\ufeff' + json.dumps(MESHDOC)))

# ------------------------------------------------------------------ pending envelopes
P = load('envelope/pending.json')
PB = json.loads(P['input'])
J = PB['job']
def penv(body=None, status=202, vreq=None, **kw):
    b = copy.deepcopy(PB) if body is None else body
    for k, v in kw.items():
        if v is None: b.pop(k, None)
        else: b[k] = v
    v = {k: P[k] for k in ('kind', 'keys') if k in P}
    v['input'] = json.dumps(b) if not isinstance(b, str) else b
    v['status'] = status
    v['request'] = vreq if vreq is not None else P['request']
    return v
REQ = P['request']
add('p-ok', penv())
add('p-estimate-float', penv(body=json.dumps(PB).replace('"estimate_seconds": 5', '"estimate_seconds": 5.0')))
add('p-estimate-neg', penv(estimate_seconds=-1))
add('p-estimate-big', penv(body=json.dumps(PB).replace('"estimate_seconds": 5', '"estimate_seconds": 9007199254740992')))
add('p-estimate-string', penv(estimate_seconds='5'))
add('p-job-65', penv(job='a' * 65, poll='https://mesh.example/jobs/' + 'a' * 65))
add('p-job-64', penv(job='a' * 64, poll='https://mesh.example/jobs/' + 'a' * 64))
add('p-job-32', penv(job='a' * 32, poll='https://mesh.example/jobs/' + 'a' * 32))
add('p-job-number', penv(job=5))
add('p-poll-513', penv(poll='https://mesh.example/' + 'a' * (512 - len('https://mesh.example/') - len('/jobs/' + J) + 1) + '/jobs/' + J))
add('p-poll-512', penv(poll='https://mesh.example/' + 'a' * (512 - len('https://mesh.example/') - len('/jobs/' + J)) + '/jobs/' + J))
add('p-poll-query', penv(poll='https://mesh.example/jobs/' + J + '?x'))
add('p-poll-suffix-only', penv(poll='https://mesh.example/x/jobs/' + J))
add('p-poll-no-slash', penv(poll='https://mesh.example/xjobs/' + J))
add('p-poll-just-host', penv(poll='https:///jobs/' + J))
add('p-poll-other-host', penv(poll='https://elsewhere.example/jobs/' + J))
add('p-poll-ip', penv(poll='https://192.0.2.1/jobs/' + J))
add('p-poll-upper', penv(poll='https://Mesh.example/jobs/' + J))
add('p-poll-userinfo', penv(poll='https://u@mesh.example/jobs/' + J))
add('p-poll-port', penv(poll='https://mesh.example:443/jobs/' + J))
add('p-poll-query-host', penv(poll='https://mesh.example?x/jobs/' + J))
add('p-poll-single-label', penv(poll='https://mesh/jobs/' + J))
add('p-poll-trailing-dot', penv(poll='https://mesh.example./jobs/' + J))
add('p-poll-space', penv(poll='https://mesh.example/a b/jobs/' + J))
add('p-request-asof-null', penv(**{'request': {'cell_id': REQ['cell_id'], 'asof': None}}))
add('p-request-asof-bad', penv(**{'request': {'cell_id': REQ['cell_id'], 'asof': '2024-03-16'}}))
add('p-request-cellid-upper', penv(**{'request': {'cell_id': REQ['cell_id'].upper(), 'asof': REQ['asof']}}))
add('p-request-not-object', penv(**{'request': REQ['cell_id']}))
add('p-request-job-member', penv(**{'request': {**REQ, 'job': J}}))
add('p-request-asof-other', penv(**{'request': {'cell_id': REQ['cell_id'], 'asof': '2024-03-16T09:00:00.000001Z'}}))
add('p-with-reason', penv(reason='x'))
add('p-with-age', penv(age_seconds=1))
add('p-status-200-other-outcome', penv(status=404))
add('p-job-given-same', penv(vreq={**REQ, 'job': J}))
add('p-job-given-no-asof', penv(vreq={'cell_id': REQ['cell_id'], 'job': J}, **{'request': {'cell_id': REQ['cell_id']}}))
BR = load('envelope/job-unknown.json')
def benv(body, status=400, request=None):
    return {'kind': 'envelope', 'input': json.dumps(body), 'status': status, 'request': request or BR['request'], 'keys': BR.get('keys', {})}
add('b-job-unknown-ok', benv({'outcome': 'bad_request', 'error': 'E_JOB_UNKNOWN'}))
add('b-job-unknown-nojob', benv({'outcome': 'bad_request', 'error': 'E_JOB_UNKNOWN'}, request={'cell_id': REQ['cell_id']}))
add('b-parse-code-with-job', benv({'outcome': 'bad_request', 'error': 'E_PARSE_URI'}))
add('b-error-job-unknown', benv({'outcome': 'error', 'error': 'E_JOB_UNKNOWN'}, status=500))
add('b-error-mesh-doc', benv({'outcome': 'error', 'error': 'E_MESH_DOC'}, status=500))
add('b-error-mesh-doc-nojob', benv({'outcome': 'error', 'error': 'E_MESH_DOC'}, status=500, request={'cell_id': REQ['cell_id']}))
add('b-not-covered-with-job', benv({'outcome': 'not_covered'}, status=404))
add('b-bad-request-mesh-doc', benv({'outcome': 'bad_request', 'error': 'E_MESH_DOC'}))
add('b-bad-request-job-unknown-bad-status', benv({'outcome': 'bad_request', 'error': 'E_JOB_UNKNOWN'}, status=404))
OKV = load('envelope/job-result-ok.json')
okb = json.loads(OKV['input'])
def oenv(request):
    v = copy.deepcopy(OKV)
    for k in ('id', 'description', 'valid', 'outcome', 'trust', 'receipt_hash'): v.pop(k, None)
    v['request'] = request
    return v
add('o-job-result-other-job', oenv({**OKV['request'], 'job': 'b' * 32}))
add('o-job-result-nojob', oenv({k: v for k, v in OKV['request'].items() if k != 'job'}))
add('o-job-result-no-asof', oenv({'cell_id': OKV['request']['cell_id'], 'job': J}))

out_path = sys.argv[1] if len(sys.argv) > 1 else None

# ------------------------------------------------------------------ run
d = S + '/spec/vectors'
shutil.rmtree(d, ignore_errors=True)
os.makedirs(d + '/invalid')
for name, v in probes.items():
    p = dict(v); p.update({'id': 'invalid/' + name, 'description': 'probe', 'valid': False, 'error': 'E_PROBE'})
    probes[name] = p
    with open(f'{d}/invalid/{name}.json', 'w', encoding='utf-8') as f: json.dump(p, f, ensure_ascii=False)
res = subprocess.run([sys.executable, S + '/spec/tools/canon.py', 'check'], capture_output=True, text=True, cwd=S)
txt = res.stdout + res.stderr
got = {m.group(1): m.group(2) for m in re.finditer(r'FAIL vectors/invalid/(\S+)\.json\n\s+expected E_PROBE, got (.*)', txt)}
for name in probes:
    print(f'{name:40s} {got.get(name, "?? " + txt[-300:] if name not in got else "")[:150]}')
if out_path:
    with open(out_path, 'w', encoding='utf-8') as f:
        for name, v in probes.items():
            g = got.get(name, '??').split(' ')[0]
            f.write(json.dumps({'vector': v, 'oracle': g}, ensure_ascii=False) + '\n')
