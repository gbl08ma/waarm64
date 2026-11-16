# SNAPZ's end: the A/B's rounds (rounds/<guest>-<arm>-<n>.{json,log,mem.jsonl.gz}; each guest's rounds 1 and 2, the
# arms' first in a fresh profile, are warm-ups and left out) by guest, operation and arm: the loads' phases (a load, a
# kept snapshot's start, the resume) and the saves' pauses (kept, a download, a picked file, a suspend), and the
# browser's memory before and at the peak of each (bench/snapz/memwatch.ts's 50 ms samples, MiB).
#   python3 summary.py [summary.json]
import json, sys, re, glob, os, statistics, gzip, pathlib
d = str(pathlib.Path(__file__).parent / 'rounds') + '/'
out = {}
LOADS = ('load', 'keptStart', 'resume')
SAVES = ('kept', 'file', 'picked', 'suspend')
for jf in sorted(glob.glob(d + '*-*-[0-9]*.json')):
    tag = os.path.basename(jf)[:-5]
    m = re.match(r'(desktop|debian)-(base|new)-(\d+)$', tag)
    if not m or int(m.group(3)) <= 2: continue
    g, arm, _ = m.groups()
    r = json.load(open(jf))['rounds'][0]
    mf = d + tag + '.mem.jsonl.gz'
    mem = [json.loads(l) for l in gzip.open(mf, 'rt')] if os.path.exists(mf) else []
    ev = {}
    for l in open(d + tag + '.log'):
        mm = re.match(r'(\d+) round \d+ (\w+) ', l)
        if mm: ev[mm.group(2)] = int(mm.group(1))
    for k in LOADS + SAVES:
        if k not in r: continue
        s = r[k]; o = out.setdefault((g, k, arm), {})
        add = lambda key, v: o.setdefault(key, []).append(round(v))
        add('wall', s['wallMs'])
        p = s['phases']
        if k in LOADS:
            for f in ('total', 'prepare', 'check', 'state', 'ram', 'disk', 'start'):
                if f in p: add(f, p[f])
        else:
            add('paused', s['pausedMs'])
            add('MB', s['bytes'] / 1e6)
            if 'copy' in p: add('copy', p['copy'])
        if mem and k in ev:
            start = ev[k] - s['wallMs']
            before = [x for x in mem if x['at'] < start]
            win = [x for x in mem if start <= x['at'] <= ev[k] + 500]
            if before and win:
                b = before[-1]; pk = max(win, key=lambda x: x['sum'])
                add('memBefore', b['sum'] // 1024)
                add('memPeak', pk['sum'] // 1024)
                add('memAdded', (pk['sum'] - b['sum']) // 1024)
def md(v):
    v = sorted(v); return f"{int(statistics.median(v)):,} ({v[0]:,}-{v[-1]:,})" if v else '-'
res = {}
for key in sorted(out):
    o = out[key]
    print(f"{key[0]:8s} {key[1]:10s} {key[2]:5s} n={len(o['wall'])} " + ' '.join(f"{f} {md(v)}" for f, v in o.items()))
    res['/'.join(key)] = {f: {'median': statistics.median(v), 'min': min(v), 'max': max(v), 'all': v} for f, v in o.items()}
if len(sys.argv) > 1: json.dump(res, open(sys.argv[1], 'w'), indent=1)
