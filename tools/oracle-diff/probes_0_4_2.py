# Probes for the spec-0.4.2 additions (pins in URIs, references and requests, the fn_hash echo,
# trust computed and the request's mesh, E_NAME_UNBOUND / E_SLICE_AT_CELL, slice pages, batches,
# the versions endpoint), judged by the reference tool as a black box, as in probes_0_4.py: each
# probe is an invalid vector with error E_PROBE in a scratch spec directory (/w/spec: canon.py and
# its sibling files copied unread, the schemas, units.md); one `canon.py check` run prints the code
# each got ("success" when accepted).
#
#   docker run --rm -v <scratch>/w:/w -v <repo>/spec:/spec:ro -v <repo>/tools/oracle-diff:/p:ro \
#     datumesh-test python /p/probes_0_4_2.py [/out/probes-0.4.2.jsonl]
import copy, json, os, re, shutil, subprocess, sys

S = '/w'
VEC = '/spec/vectors'
def load(p): return json.load(open(os.path.join(VEC, p), encoding='utf-8'))
probes = {}
def add(name, v): probes[name] = v
H0 = '0' * 64
PIN = '7b58ecb8fd23b644c87951d0bd609790ff547cbb23fed27186c669ce2ce0aa80'

def env_probe(base, body=None, status=None, vreq=None, **kw):
    v = load(base)
    b = json.loads(v['input']) if body is None else body
    for k, x in kw.items():
        if x is None: b.pop(k, None)
        else: b[k] = x
    out = {'kind': 'envelope', 'input': b if isinstance(b, str) else json.dumps(b), 'status': v['status'] if status is None else status,
           'request': v['request'] if vreq is None else vreq, 'keys': v['keys']}
    return out

# ---- the fn_hash echo
OKP = 'envelope/ok-pinned.json'
okp = load(OKP)
REQP = okp['request']
REQ = {k: x for k, x in REQP.items() if k != 'fn_hash'}
add('e-pinned-rate-limited-noecho', env_probe('envelope/rate-limited.json', vreq=REQP))
add('e-pinned-rate-limited-other', env_probe('envelope/rate-limited.json', vreq=REQP, fn_hash=H0))
add('e-pinned-rate-limited-same', env_probe('envelope/rate-limited.json', vreq=REQP, fn_hash=PIN))
add('e-pinned-bad-request-other', env_probe('envelope/bad-request.json', vreq=REQP, fn_hash=H0))
add('e-pinned-bad-request-noecho', env_probe('envelope/bad-request.json', vreq=REQP))
add('e-pinned-unlicensed-noecho', env_probe('envelope/unlicensed.json', vreq=REQP))
add('e-pinned-error-noecho', env_probe('envelope/error.json', vreq=REQP))
add('e-pinned-payment-noecho', env_probe('envelope/payment-required.json', vreq=REQP))
add('e-pinned-not-covered-unbound-noecho', env_probe('envelope/not-covered-name-unbound.json', vreq=REQP))
add('e-pending-with-fn-hash', env_probe('envelope/pending.json', fn_hash=PIN))
add('e-unpinned-not-covered-any', env_probe('envelope/not-covered.json', fn_hash=H0))
add('e-fn-hash-upper', env_probe(OKP, fn_hash=PIN.upper()))
add('e-fn-hash-number', env_probe(OKP, fn_hash=5))
add('e-echo-mismatch-badsig', env_probe(OKP, fn_hash=H0, receipt={**json.loads(okp['input'])['receipt'], 'sig': '0' * 128}))
add('e-echo-mismatch-other-cell', env_probe(OKP, fn_hash=H0, vreq={**REQP, 'cell_id': '1' * 64}))
add('e-echo-pin-wrong-receipt-ok', env_probe(OKP, vreq={**REQP, 'fn_hash': H0}))
add('e-pending-request-fn-hash-unpinned', env_probe('envelope/pending.json', vreq=REQ, **{'request': {**json.loads(load('envelope/pending.json')['input'])['request'], 'fn_hash': PIN}}))
add('e-pending-request-fn-hash-upper', env_probe('envelope/pending-pinned.json', **{'request': {**json.loads(load('envelope/pending-pinned.json')['input'])['request'], 'fn_hash': PIN.upper()}}))
UNP = {k: x for k, x in okp['request'].items() if k != 'fn_hash'}
add('e-unpinned-echo-other-badsig', env_probe(OKP, vreq=UNP, fn_hash=H0, receipt={**json.loads(okp['input'])['receipt'], 'sig': '0' * 128}))
add('e-unpinned-echo-other-wrongcell', env_probe(OKP, vreq={**UNP, 'cell_id': '1' * 64}, fn_hash=H0))
add('e-unpinned-echo-other-wrongstatus', env_probe(OKP, vreq=UNP, fn_hash=H0, status=404))
add('e-pinned-noecho-wrongstatus', env_probe(OKP, vreq=REQP, fn_hash=None, status=404))
# ---- not_covered error, bad_request codes, error codes
add('e-not-covered-error-number', env_probe('envelope/not-covered.json', error=5))
add('e-bad-request-name-unbound', env_probe('envelope/bad-request.json', error='E_NAME_UNBOUND'))
add('e-bad-request-canon-hex', env_probe('envelope/bad-request.json', error='E_CANON_HEX'))
add('e-error-canon-hex', env_probe('envelope/error.json', error='E_CANON_HEX'))
add('e-error-slice-member', env_probe('envelope/error.json', error='E_SLICE_MEMBER'))
add('e-unlicensed-error', env_probe('envelope/unlicensed.json', error='E_NAME_UNBOUND'))
add('e-fault-with-unpinned-echo', env_probe('envelope/not-covered-fault.json', fn_hash=H0))
# ---- malformed request descriptions
add('q-pin-upper', env_probe(OKP, vreq={**REQP, 'fn_hash': PIN.upper()}, fn_hash=PIN.upper()))
add('q-pin-short-unechoed', env_probe('envelope/not-covered.json', vreq={**UNP, 'fn_hash': 'abc'}))
add('q-mesh-port', env_probe('envelope/ok-computed-mesh.json', vreq={**load('envelope/ok-computed-mesh.json')['request'], 'mesh': 'calc.example.net:443'}))
add('q-mesh-empty-primary', env_probe('envelope/ok-primary.json', vreq={**load('envelope/ok-primary.json')['request'], 'mesh': ''}))
# ---- trust and mesh
OC = 'envelope/ok-computed.json'
ocr = load(OC)['request']
add('e-computed-mesh-upper', env_probe(OC, vreq={**ocr, 'mesh': 'CALC.example.net'}))
add('e-computed-mesh-ns-path', env_probe(OC, vreq={**ocr, 'mesh': 'calc.example.net'}))
add('e-unverified-no-mesh', env_probe(OC, trust='unverified'))
add('e-verified-no-mesh', env_probe(OC, trust='verified'))
add('e-primary-with-mesh-other', env_probe('envelope/ok-primary.json', vreq={**load('envelope/ok-primary.json')['request'], 'mesh': 'other.example.net'}))
add('e-primary-with-mesh-same', env_probe('envelope/ok-primary.json', vreq={**load('envelope/ok-primary.json')['request'], 'mesh': 'rates.example.org'}))
add('e-poll-on-mesh', env_probe('envelope/pending.json', vreq={**load('envelope/pending.json')['request'], 'mesh': 'mesh.example'}))
add('e-stale-computed-other-mesh', env_probe('envelope/stale-computed.json', vreq={**load('envelope/stale-computed.json')['request'], 'mesh': 'other.example.net'}))
# ---- slice pages
SP = 'envelope/slice-page.json'
spv = load(SP)
spb = json.loads(spv['input'])
SREQ = spv['request']
def sp(body=None, request=None, status=200, **kw):
    b = copy.deepcopy(spb) if body is None else body
    for k, x in kw.items():
        if x is None: b.pop(k, None)
        else: b[k] = x
    return {'kind': 'envelope', 'input': json.dumps(b), 'status': status, 'request': request or SREQ, 'keys': spv['keys']}
m0, m1 = spb['members']
add('s-ok', sp())
add('s-status-206', sp(status=206))
add('s-stale-page', sp(outcome='stale'))
add('s-pending-at-slice', {'kind': 'envelope', 'input': load('envelope/pending.json')['input'], 'status': 202, 'request': SREQ, 'keys': spv['keys']})
add('s-next-http', sp(next='http://mesh.example/slice/x'))
add('s-next-nopath', sp(next='https://mesh.example'))
add('s-next-port', sp(next='https://mesh.example:443/x'))
add('s-next-513', sp(next='https://mesh.example/' + 'a' * 492))
add('s-next-number', sp(next=5))
add('s-next-other-no-mesh', sp(next='https://other.example.net/slice/x'))
add('s-next-on-mesh', sp(request={**SREQ, 'mesh': 'mesh.example'}))
add('s-extra-member', sp(trust='primary'))
add('s-members-not-array', sp(members={}))
add('s-member-extra', sp(members=[{**m0, 'x': 1}, m1]))
add('s-member-status', sp(members=[{**m0, 'status': 200}, m1]))
add('s-member-fn-hash-other', sp(members=[{**m0, 'fn_hash': H0}, m1]))
add('s-member-fn-hash-same', sp(members=[{**m0, 'fn_hash': m0['receipt']['cell']['fn_hash']}, m1]))
add('s-member-trust-computed', sp(members=[{**m0, 'trust': 'computed'}, m1]))
add('s-member-badsig', sp(members=[{**m0, 'receipt': {**m0['receipt'], 'sig': '0' * 128}}, m1]))
add('s-member-badsig-second-unordered', sp(members=[m1, {**m0, 'receipt': {**m0['receipt'], 'sig': '0' * 128}}]))
add('s-member-superseded-self', sp(members=[{**m0, 'superseded_by': '0' * 64}, m1]))
add('s-member-fn-hash-other-badsig', sp(members=[{**m0, 'fn_hash': H0, 'receipt': {**m0['receipt'], 'sig': '0' * 128}}, m1]))
add('s-member-stale-no-age', sp(members=[{**m0, 'outcome': 'stale'}, m1]))
add('s-member-badsig-and-later-shape', sp(members=[{**m0, 'receipt': {**m0['receipt'], 'sig': '0' * 128}}, {**m1, 'x': 1}]))
add('s-member-not-object', sp(members=[5, m1]))
add('s-slice-other-and-member-badsig', sp(slice={**spb['slice'], 'fn': 'other'}, members=[{**m0, 'receipt': {**m0['receipt'], 'sig': '0' * 128}}, m1]))
add('s-next-other-mesh-and-member-badsig', sp(request={**SREQ, 'mesh': 'mesh.example'}, next='https://other.example/x', members=[{**m0, 'receipt': {**m0['receipt'], 'sig': '0' * 128}}, m1]))
add('s-page-fn-hash-other-and-member-badsig', sp(fn_hash=H0, members=[{**m0, 'receipt': {**m0['receipt'], 'sig': '0' * 128}}, m1]))
add('s-page-fn-hash-same', sp(fn_hash=spb['slice']['fn_hash']))
add('s-page-fn-hash-other', sp(fn_hash=H0))
add('s-pinned-no-echo', sp(request={**SREQ, 'fn_hash': spb['slice']['fn_hash']}))
add('s-pinned-echo', sp(request={**SREQ, 'fn_hash': spb['slice']['fn_hash']}, fn_hash=spb['slice']['fn_hash']))
add('s-pinned-other', sp(request={**SREQ, 'fn_hash': H0}, fn_hash=H0))
add('s-no-asof', sp(request={'slice_id': SREQ['slice_id']}))
add('s-asof-early', sp(request={**SREQ, 'asof': '2000-01-01T00:00:00.000000Z'}))
add('s-after-first', sp(request={**SREQ, 'after': {'quote': m0['receipt']['cell']['args']['quote']}}))
add('s-after-other-name', sp(request={**SREQ, 'after': {'base': {'type': 'string', 'value': 'A'}}}))
add('s-after-wrong-type', sp(request={**SREQ, 'after': {'quote': {'type': 'date', 'value': '2024-01-01'}}}))
add('s-after-empty', sp(request={**SREQ, 'after': {}}))
add('s-slice-not-slice', sp(slice={**spb['slice'], 'args': {k: (x if x != '*' else {'type': 'string', 'value': 'USD'}) for k, x in spb['slice']['args'].items()}}))
add('s-slice-missing', sp(slice=None))
add('s-not-covered-fault', {'kind': 'envelope', 'input': json.dumps({'outcome': 'not_covered', 'fault': 'E_FORMULA_DIV_ZERO'}), 'status': 404, 'request': SREQ, 'keys': spv['keys']})
add('s-error-page', {'kind': 'envelope', 'input': json.dumps({'outcome': 'error', 'error': 'E_EVAL_UNAVAILABLE'}), 'status': 503, 'request': SREQ, 'keys': spv['keys']})
add('s-job-unknown', {'kind': 'envelope', 'input': json.dumps({'outcome': 'bad_request', 'error': 'E_JOB_UNKNOWN'}), 'status': 400, 'request': SREQ, 'keys': spv['keys']})
add('s-not-covered-pinned-noecho', {'kind': 'envelope', 'input': json.dumps({'outcome': 'not_covered'}), 'status': 404, 'request': {**SREQ, 'fn_hash': PIN}, 'keys': spv['keys']})
# ---- batches
BI = load('batch/in-order.json')
bb = json.loads(BI['input'])
def bp(body=None, status=200, requests=None):
    return {'kind': 'batch', 'input': body if isinstance(body, str) else json.dumps(bb if body is None else body), 'status': status, 'requests': requests or BI['requests'], 'keys': BI['keys']}
add('b-ok', bp())
add('b-long', bp(bb + [bb[0]]))
add('b-empty-requests', bp([], requests=[]))
add('b-item-status-99', bp([{**bb[0], 'status': 99}] + bb[1:]))
add('b-item-status-600', bp([{**bb[0], 'status': 600}] + bb[1:]))
add('b-item-status-mismatch', bp([{**bb[0], 'status': 404}] + bb[1:]))
add('b-item-not-object', bp([5] + bb[1:]))
add('b-item-missing-status', bp([{'envelope': bb[0]['envelope']}] + bb[1:]))
add('b-item-envelope-not-object', bp([{'status': 200, 'envelope': 5}] + bb[1:]))
add('b-item-status-exp', bp(json.dumps(bb).replace('"status": 200', '"status": 2e2', 1)))
add('b-item-bad-and-later-shape', bp([{**bb[0], 'status': 404}, bb[1], {'envelope': bb[2]['envelope']}]))
add('b-item-age-float', bp(json.dumps([{'status': 200, 'envelope': {**bb[0]['envelope'], 'outcome': 'stale', 'age_seconds': 1}}] + bb[1:]).replace('"age_seconds": 1', '"age_seconds": 1.0')))
add('b-dupkey-item', bp(json.dumps(bb).replace('"status": 200', '"status": 200, "status": 200', 1)))
add('b-refused-not-covered', bp({'outcome': 'not_covered'}, status=404))
add('b-refused-error', bp({'outcome': 'error', 'error': 'E_EVAL_UNAVAILABLE'}, status=503))
add('b-refused-unlicensed', bp({'outcome': 'unlicensed'}, status=403))
add('b-refused-payment', bp(json.loads(load('envelope/payment-required.json')['input']), status=402))
add('b-refused-pending', bp(json.loads(load('envelope/pending.json')['input']), status=202))
add('b-refused-stale', bp(json.loads(load('envelope/stale.json')['input']), status=200))
add('b-refused-status-mismatch', bp({'outcome': 'rate_limited', 'retry_after_seconds': 1}, status=503))
add('b-refused-job-unknown', bp({'outcome': 'bad_request', 'error': 'E_JOB_UNKNOWN'}, status=400))
add('b-refused-slice-at-cell', bp({'outcome': 'bad_request', 'error': 'E_SLICE_AT_CELL'}, status=400))
add('b-refused-fn-hash', bp({'outcome': 'rate_limited', 'retry_after_seconds': 1, 'fn_hash': H0}, status=429))
add('b-200-array-status-201', bp(status=201))
add('b-not-json', bp('[', status=200))
add('b-not-json-refusal', bp('{', status=429))
# ---- URIs
UV = load('uri/pinned.json')
def up(uri, sig=None): return {'kind': 'uri', 'input': uri, 'signature': sig or UV['signature']}
B = 'cell://rates.example.org/fx_rate?base=EUR&date=2024-03-15&quote=USD'
A = '&asof=2024-03-16T09:00:00.000000Z'
add('u-pin-percent', up(B + '&fn_hash=%37' + PIN[1:]))
add('u-pin-twice-asof', up(B + '&fn_hash=' + PIN + '&fn_hash=' + PIN + A))
add('u-pin-asof-pin', up(B + '&fn_hash=' + PIN + A + '&fn_hash=' + PIN))
add('u-pin-empty', up(B + '&fn_hash='))
add('u-pin-and-bad-asof', up(B + '&fn_hash=X&asof=x'))
add('u-pin-and-bad-value', up('cell://rates.example.org/fx_rate?base=EUR&date=2024-02-30&quote=USD&fn_hash=X'))
add('u-pin-first-only', up('cell://math.example.net/pi?fn_hash=' + PIN + A, {'args': {}, 'returns': {'type': 'number', 'unit': '1'}}))
add('u-asof-then-pin-only', up('cell://math.example.net/pi?asof=2024-03-16T09:00:00.000000Z&fn_hash=' + PIN, {'args': {}, 'returns': {'type': 'number', 'unit': '1'}}))
add('u-pin-and-unknown-arg', up(B + '&zz=1&fn_hash=X'))
add('u-pin-and-bad-argname', up('cell://rates.example.org/fx_rate?Base=EUR&fn_hash=' + PIN))
add('r-cell-fn-hash-arg', {'kind': 'cell', 'input': json.dumps({'args': {'fn_hash': {'type': 'string', 'value': 'x'}}, 'fn': 'f', 'fn_hash': PIN, 'ns': 'a.example.org'})})
add('r-ref-pin-and-asof', {'kind': 'ref', 'input': json.dumps({'args': {}, 'asof': '2024-03-16T09:00:00.000000Z', 'fn': 'f', 'fn_hash': PIN, 'ns': 'a.example.org'})})
add('r-ref-pin-and-bad-ns', {'kind': 'ref', 'input': json.dumps({'args': {}, 'fn': 'f', 'fn_hash': 'X', 'ns': 'A'})})
# ---- mesh versions
MV = load('mesh/versions.json')
mdoc = json.loads(MV['env']['mesh']['https']['body'])
def mv(**e):
    d = copy.deepcopy(mdoc); d['endpoints'].update(e)
    v = {'kind': 'mesh', 'host': MV['host'], 'env': {'keys': MV['env']['keys'], 'mesh': {'https': {'status': 200, 'body': json.dumps(d)}}}}
    return v
add('m-versions-extra-placeholder', mv(versions='https://mesh.example.org/versions/{cell}/{hash}'))
add('m-versions-other-host', mv(versions='https://other.example.org/versions/{cell}'))
add('m-versions-number', mv(versions=5))

out_path = sys.argv[1] if len(sys.argv) > 1 else None
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
    print(f'{name:40s} {got.get(name, "?? " + txt[-300:] if name not in got else "")[:160]}')
if out_path:
    with open(out_path, 'w', encoding='utf-8') as f:
        for name, v in probes.items():
            g = got.get(name, '??').split(' ')[0]
            f.write(json.dumps({'vector': v, 'oracle': g}, ensure_ascii=False) + '\n')
