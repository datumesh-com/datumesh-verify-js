# Runs the reference tool (spec/tools/canon.py, as a black box: its source is never read) over
# the probe vectors in /out/cases.jsonl in one `check` run: each vector is written as invalid with
# error E_PROBE, so `check` prints the code it actually got ("success" when it accepts it).
# Writes /out/fuzz.jsonl as {vector, oracle} lines for fuzz_cmp.mjs.
import json, os, re, shutil, subprocess, sys
S = '/w'
cases = [json.loads(l) for l in open('/out/cases.jsonl', encoding='utf-8') if l.strip()]
d = S + '/spec/vectors'
shutil.rmtree(d, ignore_errors=True)
os.makedirs(d + '/invalid')
for v in cases:
    p = dict(v)
    p.update({'description': 'probe', 'valid': False, 'error': 'E_PROBE'})
    with open(f"{S}/spec/{'vectors/' + p['id']}.json", 'w', encoding='utf-8') as f:
        json.dump(p, f, ensure_ascii=False)
out = subprocess.run([sys.executable, S + '/spec/tools/canon.py', 'check'], capture_output=True, text=True, cwd=S)
txt = out.stdout + out.stderr
got = {}
for m in re.finditer(r'FAIL vectors/(invalid/c\d+)\.json\n\s+expected E_PROBE, got (\S+)', txt):
    got[m.group(1)] = m.group(2)
missing = [v['id'] for v in cases if v['id'] not in got]
if missing:
    print('no verdict for', len(missing), 'cases, e.g.', missing[:3], txt[-2000:])
with open('/out/fuzz.jsonl', 'w', encoding='utf-8') as f:
    for v in cases:
        if v['id'] in got:
            f.write(json.dumps({'vector': v, 'oracle': got[v['id']]}, ensure_ascii=False) + '\n')
print(f'{len(got)}/{len(cases)} verdicts')
