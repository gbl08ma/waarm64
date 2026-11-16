# SNAPZ loop 5: the rounds' loads (the disk's blocks: `disk`) and saves (their disk blocks read: `disk`) by guest,
# profile (persistent, off the record), operation and arm, and the browser's memory before and during each save
# (bench/snapz/memwatch.ts's 50 ms samples; persistent rounds only).
#   python3 summary.py [summary.json]
import json, sys, re, glob, os, statistics, gzip, pathlib
d = str(pathlib.Path(__file__).parent / 'rounds') + '/'
out = {}
LOADS = ('load', 'keptStart', 'resume')
SAVES = ('kept', 'file', 'picked', 'suspend')
for jf in sorted(glob.glob(d + '*-*-[0-9]*.json')):
    tag = os.path.basename(jf)[:-5]
    m = re.match(r'(desktop|debian)-(persistent|off)-(base|new)-(\d+)$', tag)
    if not m: continue
    g, prof, arm, _ = m.groups()
    r = json.load(open(jf))['rounds'][0]
    mf = d + tag + '.mem.jsonl.gz'
    mem = [json.loads(l) for l in gzip.open(mf, 'rt')] if os.path.exists(mf) else []
    ev = {}
    for l in open(d + tag + '.log'):
        mm = re.match(r'(\d+) round \d+ (\w+) ', l)
        if mm: ev[mm.group(2)] = int(mm.group(1))
    for k in LOADS + SAVES:
        if k not in r: continue
        s = r[k]; o = out.setdefault((g, prof, k, arm), {})
        add = lambda key, v: o.setdefault(key, []).append(v)
        add('wall', s['wallMs'])
        if k in LOADS:
            p = s['phases']
            for f in ('total', 'check', 'ram', 'disk', 'start'):
                add(f, p[f])
            continue
        add('paused', s['pausedMs'])
        p = s['phases']
        add('disk', p['disk']); add('ram', p['ram']); add('sink', p['sink'])
        add('MB', round(s['bytes'] / 1e6))
        if mem and k in ev:
            start = ev[k] - s['wallMs']
            before = [x for x in mem if x['at'] < start]
            win = [x for x in mem if start <= x['at'] <= ev[k] + 500]
            if before and win:
                b = before[-1]; pk = max(win, key=lambda x: x['sum'])
                add('memAdded', (pk['sum'] - b['sum']) // 1024)
                ren = lambda x: x['types'].get('renderer', [0])[0]
                bro = lambda x: x['types'].get('browser', [0])[0]
                add('rendAdded', (max(ren(x) for x in win) - ren(b)) // 1024)
                add('browserAdded', (max(bro(x) for x in win) - bro(b)) // 1024)
def md(v):
    v = sorted(v); return f"{int(statistics.median(v)):,} ({v[0]:,}-{v[-1]:,})" if v else '-'
res = {}
for key in sorted(out):
    o = out[key]
    print(f"{key[0]:8s} {key[1]:10s} {key[2]:10s} {key[3]:5s} n={len(o['wall'])} " + ' '.join(f"{f} {md(v)}" for f, v in o.items()))
    res['/'.join(key)] = o
if len(sys.argv) > 1: json.dump(res, open(sys.argv[1], 'w'), indent=1)
