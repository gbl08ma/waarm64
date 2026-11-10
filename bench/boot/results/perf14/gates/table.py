# table.py <prefix> arm...: each round's median per result and the median of rounds, and jit.bytes
import json, sys, glob, statistics, re
pre, arms = sys.argv[1], sys.argv[2:]
names = ['alpine_jit_total', 'alpine_user_jit_total', 'alpine_user_jit_compress', 'alpine_user_jit_lua', 'alpine_user_jit_churn', 'alpine_user_jit_sqlite']
base = {}
for a in arms:
    rows = {}
    byts = {}
    for f in sorted(glob.glob(f'bench/boot/results/perf14/gates/{pre}-r*-{a}-*.json')):
        d = json.load(open(f))
        for r in d['results']:
            if r['name'] in names: rows.setdefault(r['name'], []).append(r['median'])
            j = r.get('params', {}).get('counters', {}).get('jit')
            if j and r['name'].endswith('cold') is False: byts.setdefault(f.split('-')[-1][:-5], j['bytes'])
    out = []
    for n in names:
        v = rows.get(n, [])
        if not v: continue
        m = statistics.median(v)
        base.setdefault(n, m)
        out.append(f"{n.replace('alpine_','')}: {' · '.join(f'{x:,.0f}' for x in v)}; {m:,.0f} ({100*(m/base[n]-1):+.1f}%)")
    print(a, byts); print('  ' + '\n  '.join(out))
