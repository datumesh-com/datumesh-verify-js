# Probe harness: writes probe vectors into a scratch copy of the spec (/w/spec, holding only
# tools/canon.py, its data file and the schemas) and runs the reference tool's `check` command as
# a black box: every probe is marked invalid with error E_PROBE, so `check` prints the code it
# actually got. The reference tool's source is never read. Receipts are signed here with PyNaCl
# using the seeds published in the vectors.
import json, sys, os, subprocess, re, copy, hashlib
from nacl.signing import SigningKey
S = '/w'
VEC = '/spec/vectors'
def load(p): return json.load(open(os.path.join(VEC, p)))
def jcs(o): return json.dumps(o, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
SEEDS = {}
for f in ['receipt/stored-number.json', 'receipt/rotated-key.json', 'receipt/computed-with-lineage.json']:
    d = load(f); SEEDS[d['keypair']['key_id']] = d['keypair']['seed']
BASE = load('receipt/stored-number.json')
def sign(r, kid=None):
    r = {k: v for k, v in r.items() if k != 'sig'}
    kid = kid or r['computed_by'].split('#')[-1]
    sk = SigningKey(bytes.fromhex(SEEDS.get(kid, list(SEEDS.values())[0])))
    r['sig'] = sk.sign(jcs(r)).signature.hex()
    return r
def receipt_vec(r, keys=None, recompute=None, text=None):
    v = {'kind': 'receipt', 'input': text if text is not None else json.dumps(r, ensure_ascii=False),
         'keypair': BASE['keypair'], 'keys': keys if keys is not None else BASE['keys']}
    if recompute is not None: v['recompute'] = recompute
    return v
def run(probes):
    os.makedirs(S + '/spec/vectors/invalid', exist_ok=True)
    for name, v in probes.items():
        for f in os.listdir(S + '/spec/vectors/invalid'): os.remove(S + '/spec/vectors/invalid/' + f)
        v = dict(v); v.update({'id': 'invalid/' + name, 'description': 'probe', 'valid': False, 'error': 'E_PROBE'})
        json.dump(v, open(S + '/spec/vectors/invalid/' + name + '.json', 'w'), ensure_ascii=False)
        out = subprocess.run([sys.executable, S + '/spec/tools/canon.py', 'check'], capture_output=True, text=True, cwd=S)
        txt = out.stdout + out.stderr
        m = re.search(r'expected E_PROBE, (.*)', txt)
        r = m.group(1) if m else ('CRASH: ' + txt.strip().splitlines()[-1] if txt.strip() else 'no output')
        print(f'{name:40s} {r[:200]}', flush=True)
