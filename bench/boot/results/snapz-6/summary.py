#!/usr/bin/env python3
# SNAPZ loop 6's A/B summary (run-ab.sh's rounds/): per arm, the median and range over the rounds of each measure.
import glob, json, os, statistics
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rounds')
ARMS = ['base', 'new', 'nopool']
rows = {}
def put(arm, key, v):
    rows.setdefault(key, {}).setdefault(arm, []).append(v)
for arm in ARMS:
    for f in sorted(glob.glob(f'{D}/page-{arm}-*.json')):
        d = json.loads(open(f).read().strip().splitlines()[-1])
        put(arm, 'boot to login, s', d['boot_ms'] / 1000)
        put(arm, 'import, s', d['import_ms'] / 1000)
        put(arm, 'export (qcow2), s', d['export_ms'] / 1000)
        put(arm, 'export (compressed), s', d['export_c_ms']['ms'] / 1000)
        put(arm, 'export (compressed), MB', d['export_c_ms']['bytes'] / 1e6)
        r = d['reads']
        put(arm, 'reader: 1 MiB read, one thread, ms', r['each_1MiB_ms'])
        put(arm, 'reader: 1 MiB read, pool of 4, ms', r['pool4_1MiB_ms'])
        put(arm, 'inflate a 64 KiB cluster, us', r['inflate_us'])
        put(arm, 'deflate a 4 KiB cluster, us', r['deflate_us'])
        put(arm, 'deflate ratio', r['deflate_ratio'])
        put(arm, 'page run: browser RSS peak, MiB', int(open(f[:-5] + '.rss').read()) / 1024)
    for f in sorted(glob.glob(f'{D}/io-{arm}-*.json')):
        d = json.load(open(f))
        for x in d['results']:
            if x['name'].endswith('_bw'):
                put(arm, f"fio {x['name'][8:-3]}, MiB/s", x['median'] / 1024)
        put(arm, 'fio run: browser RSS peak, MiB', int(open(f[:-5] + '.rss').read()) / 1024)
out = {}
w = max(len(k) for k in rows)
lines = [f"{'':{w}}  " + '  '.join(f'{a:>24}' for a in ARMS)]
for k, by in rows.items():
    cells = []
    for a in ARMS:
        v = by.get(a, [])
        out.setdefault(k, {})[a] = {'median': statistics.median(v) if v else None, 'min': min(v, default=None), 'max': max(v, default=None), 'n': len(v)}
        cells.append(f'{statistics.median(v):8.3f} ({min(v):.3f}-{max(v):.3f})' if v else '-')
    lines.append(f'{k:{w}}  ' + '  '.join(f'{c:>24}' for c in cells))
open(os.path.join(os.path.dirname(D), 'summary.txt'), 'w').write('\n'.join(lines) + '\n')
json.dump(out, open(os.path.join(os.path.dirname(D), 'summary.json'), 'w'), indent=1)
print('\n'.join(lines))
