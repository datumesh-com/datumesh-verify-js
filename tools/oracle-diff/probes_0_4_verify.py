# Step 7.5 (slice entries) and 7.6 (E_INPUT_SUPERSEDED) probes; exec'd by probes_0_4.py, whose
# helpers (add, rvec, topsign, probe_sign, rhash, sha, jcs, load, H) it uses.

SR = load('receipt/slice-range.json')
SR_TOP = json.loads(SR['input'])
SR_DESC = SR['recompute']['descriptor']
T0 = '2026-03-01T18:00:00.000000Z'

def mem(args, fn='daily', ns='data.example.org', fn_hash=H, tx=T0, asof=None, value='10', sign=True):
    r = {'asof': asof or tx, 'cell': {'args': args, 'fn': fn, 'fn_hash': fn_hash, 'ns': ns}, 'computed_by': 'x', 'inputs': [],
         'issued': max(asof or tx, tx), 'licence': 'CC0-1.0', 'proto': 'datumesh/1', 'publisher': ns, 'summary': 'probe member',
         'tx': tx, 'type': 'number', 'valid': {}, 'value': value}
    return probe_sign(r) if sign else r

def dt(d): return {'type': 'date', 'value': d}

def scenario(slices, singles=(), desc_inputs=None, tx=None, asof=None, value='57', lineage=None, extra_inputs=(),
             man_text=None, drop_inputs=(), drop_manifests=(), extra_manifests=None, top_mut=None, no_value=False):
    """slices: list of (slice object, [member receipts]); singles: input receipts."""
    desc = copy.deepcopy(SR_DESC)
    if desc_inputs is not None: desc['inputs'] = desc_inputs
    entries, manifests, inputs = [], {}, {}
    alltx, allasof = [], []
    for sl, ms_ in slices:
        hs = sorted({rhash(m) for m in ms_})
        e = f'slice:{sha(sl)}:{sha(hs)}'
        entries.append(e)
        manifests[e] = json.dumps({'members': hs, 'slice': sl}, ensure_ascii=False)
        for m in ms_:
            inputs[rhash(m)] = json.dumps(m, ensure_ascii=False); alltx.append(m['tx']); allasof.append(m['asof'])
    for s in singles:
        h = rhash(s); entries.append(h); inputs[h] = json.dumps(s, ensure_ascii=False); alltx.append(s['tx']); allasof.append(s['asof'])
    for s in extra_inputs: inputs[rhash(s)] = json.dumps(s, ensure_ascii=False)
    if man_text: manifests.update(man_text(entries, manifests))
    if extra_manifests: manifests.update(extra_manifests)
    for e in drop_manifests: manifests.pop(entries[e], None)
    for h in drop_inputs: inputs.pop(h, None)
    top = dict(SR_TOP)
    top['cell'] = {**SR_TOP['cell'], 'fn_hash': sha(desc)}
    top['inputs'] = sorted(set(entries))
    top['tx'] = tx or (max(alltx) if alltx else '2026-03-05T18:00:00.000000Z')
    top['asof'] = asof or max([top['tx']] + allasof)
    top['issued'] = top['asof']
    top['value'] = value
    if top_mut: top_mut(top)
    top = topsign(top)
    rc = {'descriptor': desc, 'inputs': inputs, 'manifests': manifests}
    if not no_value: rc['value'] = {'type': 'number', 'value': '57'}
    if lineage is not None: rc['lineage'] = lineage(top['inputs'], entries) if callable(lineage) else lineage
    return rvec(top, rc)

def msl(args, fn='daily', ns='data.example.org'): return {'args': args, 'fn': fn, 'fn_hash': H, 'ns': ns}
DR = msl({'date': {'type': 'date', 'hi': '2026-03-05', 'lo': '2026-03-01'}})
M1, M2 = mem({'date': dt('2026-03-01')}), mem({'date': dt('2026-03-02')}, tx='2026-03-02T18:00:00.000000Z')

add('v-ok', scenario([(DR, [M1, M2])]))
add('v-member-extra-arg', scenario([(DR, [M1, mem({'date': dt('2026-03-02'), 'x': dt('2026-03-02')})])]))
add('v-member-missing-arg', scenario([(msl({'date': '*', 's': '*'}), [mem({'date': dt('2026-03-02')})])]))
add('v-member-range-type', scenario([(DR, [mem({'date': {'type': 'string', 'value': '2026-03-02'}})])]))
NR = msl({'n': {'type': 'number', 'hi': '11', 'lo': '9'}})
def nm(v, **k): return mem({'n': {'type': 'number', 'value': v}}, **k)
add('v-number-range-10', scenario([(NR, [nm('10')])]))
add('v-number-range-9.5', scenario([(NR, [nm('9.5')])]))
add('v-number-range-11.01', scenario([(NR, [nm('11.01')])]))
add('v-number-range-ends', scenario([(NR, [nm('9'), nm('11', tx='2026-03-02T18:00:00.000000Z')])]))
NR2 = msl({'n': {'type': 'number', 'hi': '-0.5', 'lo': '-2'}})
add('v-number-range-neg', scenario([(NR2, [nm('-1'), nm('-0.5', tx='2026-03-02T18:00:00.000000Z'), nm('-2', tx='2026-03-03T18:00:00.000000Z')])]))
add('v-number-range-neg-out', scenario([(NR2, [nm('-0.4')])]))
add('v-number-range-neg-out2', scenario([(NR2, [nm('-10')])]))
add('v-number-range-0', scenario([(msl({'n': {'type': 'number', 'hi': '0.5', 'lo': '-0.5'}}), [nm('0')])]))
SRg = msl({'s': {'type': 'string', 'hi': '�', 'lo': 'a'}})
add('v-string-codepoint-astral', scenario([(SRg, [mem({'s': {'type': 'string', 'value': '\U00010000'}})])]))
add('v-string-codepoint-bmp', scenario([(SRg, [mem({'s': {'type': 'string', 'value': ''}})])]))
add('v-string-range-prefix', scenario([(msl({'s': {'type': 'string', 'hi': 'ab', 'lo': 'a'}}), [mem({'s': {'type': 'string', 'value': 'abc'}})])]))
add('v-reversed-range', scenario([(msl({'date': {'type': 'date', 'hi': '2026-03-01', 'lo': '2026-03-05'}}), [M1])]))
IR = msl({'t': {'type': 'instant', 'hi': '2026-03-01T10:05:00.000000Z', 'lo': '2026-03-01T09:55:00.000000Z'}})
add('v-instant-in', scenario([(IR, [mem({'t': {'type': 'instant', 'value': '2026-03-01T10:05:00.000000Z'}})])]))
add('v-instant-out', scenario([(IR, [mem({'t': {'type': 'instant', 'value': '2026-03-01T10:05:00.000001Z'}})])]))
BS = msl({'date': '*', 'st': {'type': 'string', 'value': 'kew'}})
add('v-bound-mismatch', scenario([(BS, [mem({'date': dt('2026-03-01'), 'st': {'type': 'string', 'value': 'lhr'}})])]))
add('v-bound-type-mismatch', scenario([(BS, [mem({'date': dt('2026-03-01'), 'st': {'type': 'date', 'value': '2026-03-01'}})])]))
add('v-open-any-type', scenario([(BS, [mem({'date': {'type': 'boolean', 'value': True}, 'st': {'type': 'string', 'value': 'kew'}})])]))
add('v-other-ns', scenario([(DR, [mem({'date': dt('2026-03-02')}, ns='other.example.org')])], desc_inputs=['data.example.org/daily', 'other.example.org/daily']))
add('v-other-fn', scenario([(DR, [mem({'date': dt('2026-03-02')}, fn='weekly')])], desc_inputs=['data.example.org/daily', 'data.example.org/weekly']))
add('v-other-fnhash', scenario([(DR, [mem({'date': dt('2026-03-02')}, fn_hash='0' * 64)])]))
add('v-dup-cell', scenario([(DR, [M1, mem({'date': dt('2026-03-01')}, tx='2026-03-02T18:00:00.000000Z', value='11')])]))
add('v-same-member-two-slices', scenario([(DR, [M1]), (msl({'date': '*'}), [M1])]))
add('v-member-also-single', scenario([(DR, [M1])], singles=[M1]))
CELLp = {'args': {'item': {'type': 'string', 'value': 'bolt'}}, 'fn': 'daily', 'fn_hash': H, 'ns': 'data.example.org'}
VS = {'cell': CELLp, 'from': '2026-01-01T00:00:00.000000Z', 'to': '2026-05-01T00:00:00.000000Z'}
def vm(tx, **k): return mem(CELLp['args'], tx=tx, **k)
add('v-version-ok-ends', scenario([(VS, [vm('2026-01-01T00:00:00.000000Z'), vm('2026-05-01T00:00:00.000000Z', value='11')])]))
add('v-version-before', scenario([(VS, [vm('2025-12-31T23:59:59.999999Z')])]))
add('v-version-othercell', scenario([(VS, [mem({'item': {'type': 'string', 'value': 'nut'}}, tx='2026-02-01T00:00:00.000000Z')])]))
add('v-version-undeclared', scenario([(VS, [vm('2026-02-01T00:00:00.000000Z')])], desc_inputs=['data.example.org/other']))
add('v-version-asof-later-than-tx', scenario([(VS, [vm('2026-02-01T00:00:00.000000Z', asof='2026-06-01T00:00:00.000000Z')])]))
add('v-version-empty-range', scenario([({**VS, 'from': '2026-06-01T00:00:00.000000Z'}, [vm('2026-05-01T00:00:00.000000Z')])]))
bad = dict(M2); bad['sig'] = '0' * 128
add('v-invalid-and-outside', scenario([(DR, [mem({'date': dt('2026-04-01')}, tx='2026-03-01T18:00:00.000000Z')])] , top_mut=None) )
def sigbad(m): m = dict(m); m['sig'] = ('1' if m['sig'][0] == '0' else '0') + m['sig'][1:]; return m
add('v-member-badsig-outside', scenario([(DR, [sigbad(mem({'date': dt('2026-04-01')}))])]))
add('v-outside-later-asof', scenario([(DR, [mem({'date': dt('2026-04-01')})])], asof='2026-03-01T18:00:00.000000Z', tx='2026-03-01T18:00:00.000000Z', top_mut=lambda t: t.update({'asof': '2026-03-01T18:00:00.000000Z', 'tx': '2026-03-01T17:00:00.000000Z', 'issued': '2026-03-01T18:00:00.000000Z'})))
add('v-later-asof-only', scenario([(DR, [mem({'date': dt('2026-03-02')}, asof='2026-03-09T00:00:00.000000Z')])], asof='2026-03-05T18:00:00.000000Z', tx='2026-03-01T18:00:00.000000Z'))
add('v-empty-only-free-tx', scenario([(DR, [])], tx='2026-03-04T00:00:00.000000Z', asof='2026-03-05T00:00:00.000000Z'))
add('v-empty-plus-single-tx', scenario([(DR, [])], singles=[mem({'date': dt('2026-03-01')}, fn='other')], desc_inputs=['data.example.org/daily', 'data.example.org/other'], tx='2026-03-04T00:00:00.000000Z', asof='2026-03-05T00:00:00.000000Z'))
add('v-tx-not-latest-member', scenario([(DR, [M1, M2])], tx=T0))
add('v-manifest-badjson', scenario([(DR, [M1])], man_text=lambda es, ms_: {es[0]: '{"members": ['}))
add('v-manifest-dupkey', scenario([(DR, [M1])], man_text=lambda es, ms_: {es[0]: ms_[es[0]][:-1] + ', "members": []}'}))
add('v-manifest-noopen', scenario([(DR, [M1])], man_text=lambda es, ms_: {es[0]: json.dumps({'members': json.loads(ms_[es[0]])['members'], 'slice': msl({'date': dt('2026-03-01')})})}))
add('v-manifest-members-mismatch', scenario([(DR, [M1])], man_text=lambda es, ms_: {es[0]: json.dumps({'members': [], 'slice': DR})}))
add('v-manifest-slice-mismatch', scenario([(DR, [M1])], man_text=lambda es, ms_: {es[0]: json.dumps({'members': json.loads(ms_[es[0]])['members'], 'slice': msl({'date': '*'})})}))
add('v-manifest-both-mismatch-undeclared', scenario([(DR, [M1])], desc_inputs=['data.example.org/x'], man_text=lambda es, ms_: {es[0]: json.dumps({'members': [], 'slice': DR})}))
add('v-undeclared-then-member-missing', scenario([(DR, [M1])], desc_inputs=['data.example.org/x'], drop_inputs=[rhash(M1)]))
add('v-second-manifest-missing-first-member-missing', scenario([(DR, [M1]), (msl({'date': '*'}), [M2])], drop_inputs=[rhash(M1)], drop_manifests=[1]))
add('v-hash-input-missing-vs-manifest', scenario([(DR, [M1])], singles=[mem({'date': dt('2026-03-01')}, fn='other')], desc_inputs=['data.example.org/daily', 'data.example.org/other'], drop_manifests=[0], drop_inputs=[rhash(mem({'date': dt('2026-03-01')}, fn='other'))]))
add('v-manifest-not-string', None)
del probes['v-manifest-not-string']

# ---- E_INPUT_SUPERSEDED
SS = load('receipt/slice-superseded.json')
def ss(mut_rc=None, mut_top=None, value=None):
    v = copy.deepcopy(SS)
    for k in ('id', 'description', 'valid', 'level', 'code', 'canonical', 'sha256', 'sig'): v.pop(k, None)
    if mut_top:
        top = json.loads(v['input']); mut_top(top); v['input'] = json.dumps(topsign(top))
    if mut_rc: mut_rc(v['recompute'])
    return v
OLD = 'caf1ceaeb53ffd4d5135743931c4b5ed4a2f16fda859192e633696c9ec36fa81'
NEW = '61b97e51bf1411ad6c4ad11c157609905b341c4e9f81709e2def6d66fc2e7fc9'
TAX = 'eebf2854f5cf787bb758be37ed644a90cac5f7ce504069468e98697558edc81a'
add('s-base', ss())
add('s-lineage-has-own-and-new', ss(lambda rc: rc.__setitem__('lineage', sorted([OLD, NEW, TAX]))))
add('s-new-receipt-missing', ss(lambda rc: rc['inputs'].pop(NEW)))
def corrupt_new(rc):
    x = json.loads(rc['inputs'][NEW]); x['sig'] = ('1' if x['sig'][0] == '0' else '0') + x['sig'][1:]; rc['inputs'][NEW] = json.dumps(x)
add('s-new-badsig', ss(corrupt_new))
oldr = json.loads(SS['recompute']['inputs'][OLD])
def put_lineage_receipt(r):
    def m(rc):
        h = rhash(r); rc['inputs'][h] = json.dumps(r); rc['lineage'] = sorted([h, TAX])
    return m
def variant(**kw):
    r = {k: v for k, v in oldr.items() if k != 'sig'}; r.update(kw); return probe_sign(r)
add('s-earlier-tx', ss(put_lineage_receipt(variant(tx='2026-03-01T08:00:00.000000Z', asof='2026-03-01T08:00:00.000000Z', issued='2026-03-01T08:00:00.000000Z', value='99'))))
add('s-equal-tx', ss(put_lineage_receipt(variant(value='99'))))
add('s-later-tx-probe-key', ss(put_lineage_receipt(variant(tx='2026-03-01T10:00:00.000000Z', asof='2026-03-01T10:00:00.000000Z', issued='2026-03-01T10:00:00.000000Z', value='101'))))
add('s-later-tx-asof-after-receipt', ss(put_lineage_receipt(variant(tx='2026-03-01T10:00:00.000000Z', asof='2026-03-09T10:00:00.000000Z', issued='2026-03-09T10:00:00.000000Z', value='101'))))
add('s-later-tx-tx-after-receipt', ss(put_lineage_receipt(variant(tx='2026-03-05T10:00:00.000000Z', asof='2026-03-05T10:00:00.000000Z', issued='2026-03-05T10:00:00.000000Z', value='101'))))
add('s-later-tx-other-fnhash', ss(put_lineage_receipt(variant(tx='2026-03-01T10:00:00.000000Z', asof='2026-03-01T10:00:00.000000Z', issued='2026-03-01T10:00:00.000000Z', cell={**oldr['cell'], 'fn_hash': '0' * 64}))))
add('s-later-tx-other-arg', ss(put_lineage_receipt(variant(tx='2026-03-01T10:00:00.000000Z', asof='2026-03-01T10:00:00.000000Z', issued='2026-03-01T10:00:00.000000Z', cell={**oldr['cell'], 'args': {'item': {'type': 'string', 'value': 'nut'}}}))))
add('s-later-tx-unknown-key', ss(put_lineage_receipt(sign_with({**{k: v for k, v in variant(tx='2026-03-01T10:00:00.000000Z', asof='2026-03-01T10:00:00.000000Z', issued='2026-03-01T10:00:00.000000Z').items()}, 'computed_by': 'nokeys.example.org#0123456789abcdef'}, PROBE_SK))))
add('s-value-equal', ss(lambda rc: rc.__setitem__('value', {'type': 'number', 'value': '120'})))
add('s-no-value', ss(lambda rc: rc.pop('value')))
add('s-lineage-garbage', ss(lambda rc: rc.__setitem__('lineage', ['zz'])))
add('s-lineage-empty', ss(lambda rc: rc.__setitem__('lineage', [])))
add('s-lineage-same', ss(lambda rc: rc.__setitem__('lineage', [OLD, TAX])))
add('s-lineage-new-in-wrong-slot', ss(lambda rc: rc.__setitem__('lineage', [TAX, NEW])))
def hashmismatch(rc):
    rc['inputs']['f' * 64] = rc['inputs'][NEW]; rc['lineage'] = ['f' * 64, TAX]
add('s-lineage-hash-mismatch', ss(hashmismatch))
SM = load('receipt/slice-superseded-member.json')
def sm(mut):
    v = copy.deepcopy(SM)
    for k in ('id', 'description', 'valid', 'level', 'code', 'canonical', 'sha256', 'sig'): v.pop(k, None)
    mut(v['recompute']); return v
OWN = json.loads(SM['input'])['inputs'][0]
LIN = SM['recompute']['lineage'][0]
add('m-base', sm(lambda rc: None))
add('m-no-lineage-manifest', sm(lambda rc: rc['manifests'].pop(LIN)))
add('m-lineage-manifest-garbage', sm(lambda rc: rc['manifests'].__setitem__(LIN, '{}')))
add('m-lineage-own-and-other', sm(lambda rc: rc.__setitem__('lineage', sorted([OWN, LIN]))))
add('m-lineage-own', sm(lambda rc: rc.__setitem__('lineage', [OWN])))
add('m-lineage-other-slice', sm(lambda rc: rc.__setitem__('lineage', ['slice:' + '1' * 64 + ':' + LIN[-64:]])))
add('m-lineage-bad-entry', sm(lambda rc: rc.__setitem__('lineage', ['slice:' + LIN[6:70] + ':' + 'X' * 64])))
def both_in_receipt(top):
    top['inputs'] = sorted([OLD, NEW, TAX])
add('s-new-also-in-receipt', ss(None, both_in_receipt))
add('m-lineage-member-version', sm(lambda rc: rc.__setitem__('lineage', ['d904d683b133868682e1479769513047aed02fc2e0ce95ac8d98996ddcf9c33f'])))
add('m-lineage-slice-prefix-only', sm(lambda rc: rc.__setitem__('lineage', [LIN[:71]])))
add('m-lineage-slice-noprefix', sm(lambda rc: rc.__setitem__('lineage', [LIN[6:]])))
