# Differential fuzz against the reference tool (black box). MODE=random (structural mutations of
# every kind), MODE=semantic (re-signed receipts and recomputation inputs with valid-looking
# changes, exercising SPEC 10.1 steps 4-7) or MODE=bytes (bit flips and JSON-text splices,
# exercising strict parsing). Records the reference tool's verdict for each generated vector in
# /out/fuzz.jsonl as {vector, oracle}; fuzz_cmp.mjs then compares this library against it.
import sys, os, json, random, copy, re, subprocess, hashlib
sys.path.insert(0, '/p')
from probe import load, jcs, SEEDS, sign, BASE
random.seed(int(os.environ.get('SEED', '1')))
N = int(os.environ.get('N', '3000'))
BS = chr(92)
POOL = ['', '*', 'x', 'EUR', 'A', 'a b', 'a__b', '_x', 'x_', 'fx_rate', 'asof', 'dm_x', 'a' * 64, 'a' * 65,
        '0', '-0', '1.50', '1.5', '007', '+1', '1e5', '.5', '5.', '-0.5', '1' * 129, '9' * 128,
        '2024-03-15', '2024-02-30', '0000-01-01', '2024-3-15', '2024-03-15T16:00:00.000000Z', '2024-03-15T16:00:00Z',
        '2024-03-15T24:00:00.000000Z', '2016-12-31T23:59:60.000000Z', '2024-03-15t16:00:00.000000z',
        'rates.example.org', 'Rates.example.org', 'example.org/x', 'example.org/X', '1.2.3.4', 'a.b-', 'xn--bcher-kva.example',
        'ecb', 'example.org/' + 'a' * 65, 'a' * 64 + '.org',
        'rates.example.org#d712b32a2cc5cb7c', 'rates.example.org#D712B32A2CC5CB7C', 'd712b32a2cc5cb7c', 'x#y',
        'a' * 64, 'A' * 64, 'f' * 64, '0' * 64, 'g' * 64, 'a' * 128, 'A' * 128, '0' * 63,
        'CC-BY-4.0', 'CC BY', 'https://example.org/l', 'http://x', 'https://', 'https://a b', 'A' * 65,
        'Z' + 'u' + chr(0x308) + 'rich', 'Z' + chr(0xfc) + 'rich', 'a' + chr(7), 'a' + chr(0x85), chr(0x378), chr(0xffff), chr(0x1c89),
        chr(0x2ebf0), chr(0xe000), 'q' + chr(0x1e08f) + chr(0x323), 'e' * 1025, chr(0xe9) * 513, chr(0x1f600) * 257,
        'datumesh/1', 'datumesh/2', 'number', 'string', 'date', 'instant', 'boolean', 'decimal', 'stored', 'expr',
        'a.example/b', 'z.example/a', 'ecb/fx_rate', 'rates.example.org/fx_rate']
TYPES = [None, True, False, 0, 1.5, [], {}, 'x']
def leaves(o, path=()):
    if isinstance(o, dict):
        yield path, o
        for k, v in o.items(): yield from leaves(v, path + (k,))
    elif isinstance(o, list):
        yield path, o
        for i, v in enumerate(o): yield from leaves(v, path + (i,))
    else:
        yield path, o
def get(o, path):
    for p in path: o = o[p]
    return o
def setp(o, path, v):
    if not path: return v
    get(o, path[:-1])[path[-1]] = v; return o
def mutate(o):
    o = copy.deepcopy(o)
    paths = list(leaves(o))
    path, val = random.choice(paths)
    r = random.random()
    if isinstance(val, dict) and r < 0.35:
        if val and random.random() < 0.5:
            del val[random.choice(list(val))]
        else:
            val[random.choice(POOL[:12] + ['type', 'value', 'args', 'fn', 'zz', 'x' * 3])] = random.choice(POOL + [{'type': 'string', 'value': 'x'}, {'type': 'date', 'value': '2024-03-15'}])
        return o
    if isinstance(val, dict) and r < 0.5 and val:
        k = random.choice(list(val)); nk = random.choice(POOL[:14] + ['b', 'zz', 'aa', 'base', 'date', 'quote'])
        val[nk] = val.pop(k); return o
    if isinstance(val, list) and r < 0.5:
        if val and random.random() < 0.5: val.pop(random.randrange(len(val)))
        elif val and random.random() < 0.5: val.append(random.choice(val))
        else: val.insert(random.randrange(len(val) + 1), random.choice(POOL))
        return o
    if random.random() < 0.15:
        return setp(o, path, random.choice(TYPES)) if path else o
    return setp(o, path, random.choice(POOL)) if path else o
def mut_n(o):
    for _ in range(random.choice([1, 1, 1, 2, 2, 3])): o = mutate(o)
    return o
MODE = os.environ.get('MODE', 'random')
if MODE == 'random':
    vecs = []
    def add(v): v['id'] = 'invalid/f%05d' % len(vecs); vecs.append(v)
    bases = {k: [json.loads(load(f)['input']) for f in fs] for k, fs in {
        'scalar': ['scalar/string-nfc.json', 'scalar/number-negative.json', 'scalar/boolean-true.json', 'scalar/instant-epoch.json', 'scalar/date-leap-day.json'],
        'cell': ['cell/fx-rate.json', 'cell/namespace-path.json', 'cell/slice.json'],
        'ref': ['ref/fx-rate-asof.json'],
        'function': ['function/computed-convert.json', 'function/stored-fx-rate.json'],
    }.items()}
    receipts = [load('receipt/' + f) for f in sorted(os.listdir('/spec/vectors/receipt'))]
    uris = [load('uri/' + f) for f in sorted(os.listdir('/spec/vectors/uri'))]
    kd = load('keys/https-document.json')
    CW = load('receipt/computed-with-lineage.json')
    for i in range(N):
        kind = random.choice(['scalar', 'cell', 'ref', 'function', 'receipt', 'receipt', 'receipt', 'uri', 'uri', 'keys', 'recompute'])
        if kind in bases:
            add({'kind': kind, 'input': json.dumps(mut_n(random.choice(bases[kind])), ensure_ascii=False)})
        elif kind == 'receipt':
            rv = random.choice(receipts); r = mut_n(json.loads(rv['input']))
            if isinstance(r, dict) and random.random() < 0.6 and isinstance(r.get('computed_by'), str):
                try: r = sign(r, r['computed_by'].split('#')[-1] if r['computed_by'].split('#')[-1] in SEEDS else None)
                except Exception: pass
            add({'kind': 'receipt', 'input': json.dumps(r, ensure_ascii=False), 'keypair': rv['keypair'], 'keys': rv['keys']})
        elif kind == 'recompute':
            rc = copy.deepcopy(CW['recompute']); r = json.loads(CW['input'])
            which = random.random()
            if which < 0.4: rc['descriptor'] = mut_n(rc['descriptor'])
            elif which < 0.7:
                h = list(rc['inputs'])[0]; inner = mut_n(json.loads(rc['inputs'][h]))
                if isinstance(inner, dict) and random.random() < 0.6:
                    try: inner = sign(inner, 'd712b32a2cc5cb7c')
                    except Exception: pass
                rc['inputs'] = {h: json.dumps(inner, ensure_ascii=False)}
            else:
                r = mut_n(r)
            if isinstance(r, dict) and random.random() < 0.7:
                try: r = sign(r, 'f7ec60a92abf4774')
                except Exception: pass
            if 'value' not in rc: rc['value'] = {'type': 'number', 'value': '1'}
            add({'kind': 'receipt', 'input': json.dumps(r, ensure_ascii=False), 'keypair': CW['keypair'], 'keys': CW['keys'], 'recompute': rc})
        elif kind == 'uri':
            u = random.choice(uris); s = u['input']
            for _ in range(random.choice([1, 1, 2, 3])):
                op = random.random(); pos = random.randrange(len(s) + 1)
                ins = random.choice(['%', '%2', '%2A', '%41', '%c3', '%C3%BC', '%FF', '=', '&', '?', '#', '*', 'A', ':', '/', chr(0xfc), ' ', '+', 'asof=2024-01-01T00:00:00.000000Z', '&zz=1', '&aa=1', 'dm_', '.', '-', '~'])
                if op < 0.4: s = s[:pos] + ins + s[pos:]
                elif op < 0.7 and len(s) > 8: s = s[:pos] + s[pos + 1:]
                else:
                    q = s.split('?', 1)
                    if len(q) == 2:
                        ps = q[1].split('&'); random.shuffle(ps) if random.random() < 0.5 else ps.append(random.choice(ps)); s = q[0] + '?' + '&'.join(ps)
            add({'kind': 'uri', 'input': s, 'signature': u['signature']})
        else:
            d = json.loads(kd['env']['https']['body']); d = mut_n(d)
            add({'kind': 'keys', 'host': 'rates.example.org', 'env': {'https': {'status': random.choice([200] * 8 + [404, 301]), 'body': json.dumps(d, ensure_ascii=False)}}})

elif MODE == 'semantic':
    vecs = []
    def add(v): v['id'] = 'invalid/f%05d' % len(vecs); vecs.append(v)
    receipts = [load('receipt/' + f) for f in sorted(os.listdir('/spec/vectors/receipt'))]
    CW = load('receipt/computed-with-lineage.json'); SN = load('receipt/stored-number.json'); SN2 = load('receipt/stored-number-second.json')
    INST = ['2024-03-15T16:00:00.000000Z', '2024-03-16T09:00:00.000000Z', '2024-03-16T09:00:01.250000Z', '2024-03-17T00:00:00.000000Z', '2019-12-31T23:59:59.999999Z', '2024-06-01T00:00:00.000000Z', '2024-05-31T23:59:59.999999Z', '2020-01-01T00:00:00.000000Z', '2030-01-01T00:00:00.000000Z']
    KEYREFS = ['rates.example.org#d712b32a2cc5cb7c', 'rates.example.org#d9a2df65559c4444', 'calc.example.net#f7ec60a92abf4774', 'other.example.org#d712b32a2cc5cb7c', 'rates.example.org#0000000000000000']
    NS = ['rates.example.org', 'calc.example.net', 'example.org/a', 'other.example.org']
    SCAL = [{'type': 'string', 'value': 'EUR'}, {'type': 'date', 'value': '2024-03-15'}, {'type': 'date', 'value': '2024-03-14'}, {'type': 'number', 'value': '100'}, {'type': 'instant', 'value': '2024-03-15T16:00:00.000000Z'}, {'type': 'boolean', 'value': True}, '*']
    def sem(r):
        r = copy.deepcopy(r)
        for _ in range(random.choice([1, 1, 2, 2, 3])):
            k = random.choice(['tx', 'asof', 'issued', 'publisher', 'computed_by', 'valid', 'args', 'typeval', 'inputs', 'ns', 'fn'])
            if k in ('tx', 'asof', 'issued'): r[k] = random.choice(INST)
            elif k == 'publisher': r['publisher'] = random.choice(NS)
            elif k == 'ns': r['cell']['ns'] = random.choice(NS)
            elif k == 'fn': r['cell']['fn'] = random.choice(['fx_rate', 'convert', 'other'])
            elif k == 'computed_by': r['computed_by'] = random.choice(KEYREFS)
            elif k == 'valid':
                n = random.choice(['date', 'base', 'amount', 'quote', 'zz'])
                if random.random() < 0.3: r['valid'].pop(n, None)
                else: r['valid'][n] = random.choice(SCAL)
            elif k == 'args':
                n = random.choice(['date', 'base', 'amount', 'quote', 'zz'])
                if random.random() < 0.3: r['cell']['args'].pop(n, None)
                else: r['cell']['args'][n] = random.choice(SCAL)
            elif k == 'typeval':
                r['type'], r['value'] = random.choice([('number', '1.0892'), ('number', '108.92'), ('string', '1.0892'), ('boolean', True), ('date', '2024-03-15')])
            elif k == 'inputs':
                r['inputs'] = random.choice([[], [SN['sha256']], sorted([SN['sha256'], SN2['sha256']]), [SN2['sha256']]])
        return r
    def signed(r):
        kid = r['computed_by'].split('#')[-1]
        return sign(r, kid if kid in SEEDS else None)
    for i in range(N):
        if random.random() < 0.5:
            rv = random.choice(receipts)
            r = signed(sem(json.loads(rv['input'])))
            add({'kind': 'receipt', 'input': json.dumps(r, ensure_ascii=False), 'keypair': rv['keypair'], 'keys': rv['keys']})
            continue
        base = random.choice([CW, SN])
        rc = copy.deepcopy(base['recompute']); r = json.loads(base['input'])
        if random.random() < 0.5:
            d = rc['descriptor']; sig = d['signature']
            for _ in range(random.choice([1, 2])):
                op = random.random()
                if op < 0.25:
                    n = random.choice(list(sig['args']) + ['zz', 'rounding'])
                    sig['args'][n] = {'type': random.choice(['string', 'date', 'number', 'instant']), 'valid': random.random() < 0.3}
                    if sig['args'][n]['valid'] and sig['args'][n]['type'] == 'number': sig['args'][n]['valid'] = False
                elif op < 0.45 and sig['args']: sig['args'].pop(random.choice(list(sig['args'])))
                elif op < 0.6: sig['returns'] = random.choice(['number', 'string', 'date'])
                elif op < 0.8: d['inputs'] = random.choice([[], ['rates.example.org/fx_rate'], ['rates.example.org/other'], ['a.example/x', 'rates.example.org/fx_rate']])
                else:
                    n = random.choice(list(sig['args']) or ['x']);
                    if n in sig['args']: sig['args'][n]['valid'] = not sig['args'][n]['valid'] if sig['args'][n]['type'] != 'number' else False
            if random.random() < 0.85: r['cell']['fn_hash'] = hashlib.sha256(jcs(d)).hexdigest()
        if random.random() < 0.4 and rc['inputs']:
            h = list(rc['inputs'])[0]; inner = json.loads(rc['inputs'][h])
            inner = sem(inner) if random.random() < 0.7 else inner
            inner = signed(inner) if random.random() < 0.8 else inner
            rc['inputs'] = {h: json.dumps(inner, ensure_ascii=False)} if random.random() < 0.9 else {}
            if random.random() < 0.5:
                nh = hashlib.sha256(jcs({k: v for k, v in inner.items() if k != 'sig'})).hexdigest()
                rc['inputs'] = {nh: json.dumps(inner, ensure_ascii=False)}; r['inputs'] = [nh]
        if random.random() < 0.4: r = sem(r)
        if random.random() < 0.3: rc['value'] = random.choice([{'type': 'number', 'value': '108.92'}, {'type': 'number', 'value': '1.0892'}, {'type': 'string', 'value': '108.92'}])
        r = signed(r)
        add({'kind': 'receipt', 'input': json.dumps(r, ensure_ascii=False), 'keypair': base['keypair'], 'keys': base['keys'], 'recompute': rc})

else:
    vecs = []
    def add(v): v['id'] = 'invalid/f%05d' % len(vecs); vecs.append(v)
    srcs = []
    for g in ['scalar', 'cell', 'function', 'ref', 'receipt']:
        for f in sorted(os.listdir('/spec/vectors/' + g)):
            v = load(g + '/' + f)
            if 'input' in v: srcs.append(v)
    BS = chr(92); Q = chr(34)
    SNIPS = [BS + 'ud800', BS + 'udc00', BS + 'ud83d' + BS + 'ude00', BS + 'u0061', BS + 'x', BS, Q, ',', ':', '{', '}', '[', ']', 'NaN', '1e400', '-0', '01', chr(0xfeff), chr(1), chr(0x7f), ' ', chr(0xb), 'true', 'null', ',' + Q + 'type' + Q + ':' + Q + 'x' + Q, ',' + Q + 'value' + Q + ':1', ',' + Q + 'args' + Q + ':{}', ',' + Q + 'ns' + Q + ':' + Q + 'a.b' + Q, ',' + Q + 'sig' + Q + ':' + Q + 'x' + Q]
    for i in range(N):
        v = random.choice(srcs)
        t = v['input']
        if random.random() < 0.5:
            b = bytearray(t.encode('utf-8'))
            for _ in range(random.choice([1, 1, 2])):
                j = random.randrange(len(b)); b[j] ^= 1 << random.randrange(8)
            if v['kind'] != 'receipt':
                w = {'kind': v['kind'], 'input_hex': bytes(b).hex()}
            else:
                try: w = {'kind': 'receipt', 'input': bytes(b).decode('utf-8'), 'keypair': v['keypair'], 'keys': v['keys']}
                except UnicodeDecodeError: continue
        else:
            for _ in range(random.choice([1, 1, 2])):
                j = random.randrange(len(t) + 1)
                t = t[:j] + random.choice(SNIPS) + t[j + random.choice([0, 0, 1]):]
            w = {'kind': v['kind'], 'input': t}
            if v['kind'] == 'receipt': w.update(keypair=v['keypair'], keys=v['keys'])
        add(w)

# Run the reference tool in batches.
S = '/w'; os.makedirs(S + '/spec/vectors/invalid', exist_ok=True)
def run_batch(batch):
    for f in os.listdir(S + '/spec/vectors/invalid'): os.remove(S + '/spec/vectors/invalid/' + f)
    for v in batch:
        w = dict(v, description='fuzz', valid=False, error='E_PROBE')
        json.dump(w, open(S + '/spec/vectors/invalid/' + v['id'].split('/')[1] + '.json', 'w'), ensure_ascii=False)
    out = subprocess.run([sys.executable, S + '/spec/tools/canon.py', 'check'], capture_output=True, text=True, cwd=S)
    res = {}; cur = None
    for line in out.stdout.splitlines():
        m = re.match(r'FAIL vectors/invalid/(f\d+)\.json', line)
        if m: cur = 'invalid/' + m.group(1); continue
        m = re.search(r'expected E_PROBE, got (success|E_[A-Z_]+)', line)
        if m and cur: res[cur] = m.group(1); cur = None
    return res, out.returncode, out.stderr
results = {}
B = 400
for i in range(0, len(vecs), B):
    batch = vecs[i:i + B]
    res, rc, err = run_batch(batch)
    if len(res) != len(batch):
        for v in batch:
            r1, _, e1 = run_batch([v])
            results[v['id']] = r1.get(v['id'], 'CRASH: ' + (e1.strip().splitlines() or ['?'])[-1])
    else: results.update(res)
with open('/out/fuzz.jsonl', 'w') as f:
    for v in vecs: f.write(json.dumps({'vector': v, 'oracle': results[v['id']]}, ensure_ascii=False) + '\n')
from collections import Counter
print(len(vecs), 'vectors;', Counter(results.values()).most_common(40))
