#!/usr/bin/env python3
# gsum.py <dir>: per bench total, per core name, the medians of each round, the wasm bytes and the change of the median of the rounds' medians against the first name.
import json, glob, os, sys, statistics, re, collections
d = sys.argv[1]
rows = collections.defaultdict(lambda: collections.defaultdict(list))
order = []
for f in sorted(glob.glob(os.path.join(d, '*.json'))):
    m = re.match(r'(smp_\w+?)-(\w+)-(\d+)\.json', os.path.basename(f))
    if not m: continue
    bench, name, rnd = m.groups()
    if name not in order: order.append(name)
    for r in json.load(open(f))['results']:
        if r['name'].endswith('_total'):
            c = r['params'].get('counters', {}).get('jit', {})
            rows[r['name']][name].append((int(rnd), r['median'], r['iqr'], r['n'], c.get('bytes', 0), c.get('modules', 0)))
for b, by in rows.items():
    print(b)
    base = None
    for name in order:
        v = sorted(by.get(name, []))
        if not v: continue
        med = statistics.median([x[1] for x in v])
        if base is None: base = med
        print(f"  {name:8s} " + ' · '.join(f"{x[1]:,.0f} (IQR {x[2]:.0f}, n={x[3]})" for x in v) + f"  wasm {statistics.median([x[4] for x in v])/1e6:.2f} MB  {100*(med/base-1):+.1f}%")
