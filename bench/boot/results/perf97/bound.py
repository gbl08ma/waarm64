# bound.py: PERF loop 97's bound, of busy time, of what a per-ASID stash of nG entries would save: each served data
# refill at a data miss's 260-290 ns (a walk and the helper that runs the access's group: PERF loop 72), each served
# instruction refill at a walk's 68 ns (PERF loop 54's profile), nothing for its own costs. Busy time: the gates and
# smp-user4 their Node runs' wall (x4 vCPUs for smp-user4), node and smp their Chromium runs' median (x4 for smp),
# the pages session its steps at its busy MIPS (453). Writes bound.txt.
import gzip, json
rows = []
pc = json.load(open('preempt-counts.json'))
runs = pc['runs']
for r in runs:
    rows.append((r['name'], r['t'][80:120], r['ms'] / 1e3 * r['ncpus']))
ab = json.load(open('counts/ab.json'))
for w, n in (('node', 1), ('smp', 4)):
    rs = [r for r in ab['rows'] if r['workload'] == w and 'stats' in r['s']]
    ms = sorted(r['s']['ms'] for r in rs)
    rows.append((w, rs[0]['s']['stats']['jit']['diag'][80:120], ms[len(ms) // 2] / 1e3 * n))
last = json.loads(gzip.open('pages-diag/jit.jsonl.gz', 'rt').read().strip().split('\n')[-1])
rows.append(('pages', last['jit']['diag'][80:120], last['jit']['steps'] / 453e6))
out = ['workload  busy s  nG fills  generous: data / exec served  bound  strict: data / exec served  bound  restored a switch  ASIDE1-other refills  bound']
for name, t, busy in rows:
    fills = sum(t[6:10])
    def b(d, x): return (d * 260e-9 / busy * 100, d * 290e-9 / busy * 100 + x * 68e-9 / busy * 100 - 0)
    g = (t[10] + t[11] + t[13], t[12]); s = (t[26] + t[27] + t[29], t[28])
    lo = lambda d, x: (d * 260e-9 + x * 68e-9) / busy * 100
    hi = lambda d, x: (d * 290e-9 + x * 68e-9) / busy * 100
    out.append(f'{name:<9} {busy:7.1f} {fills:>10,}  {g[0]:>10,} / {g[1]:>10,}  {lo(*g):.2f}-{hi(*g):.2f}%  {s[0]:>10,} / {s[1]:>10,}  {lo(*s):.2f}-{hi(*s):.2f}%'
               f'  {t[30] / max(t[0], 1):6.1f}  {t[33]:>10,}  {t[33] * 68e-9 / busy * 100:.2f}-{t[33] * 290e-9 / busy * 100:.2f}%')
open('bound.txt', 'w').write('\n'.join(out) + '\n')
print('\n'.join(out))
