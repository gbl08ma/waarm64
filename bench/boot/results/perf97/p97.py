import gzip, json, sys
# p97.py <jit.jsonl.gz | ab.json>: PERF loop 97's per-ASID stash model (core/src/mmu.rs `P97`, diag.patch), its counts.
NAMES = ['switches', 'to a stashed ASID', 'entries stashed', 'restorable', 'peak entries', 'peak ASIDs',
         'nG fills EL0 r', 'nG fills EL0 w', 'nG fills EL0 x', 'nG fills EL1', 'served EL0 r', 'served EL0 w',
         'served EL0 x', 'served EL1', 'stale', 'VA drops', 'VA dropped', 'ASIDE', 'ASIDE other', 'ASIDE other live',
         'ASIDE dropped', 'flush all', 'nG unknown', 'all dropped', 'sibling of stashed', 'all primary fills',
         'strict EL0 r', 'strict EL0 w', 'strict EL0 x', 'strict EL1', 'strict restored', 'restore on global', 'restore on other', 'ASIDE lost refilled']
def show(name, steps, d):
    t = d[80:80 + len(NAMES)]
    print(f'== {name}: {steps/1e9:.2f} G steps')
    for n, v in zip(NAMES, t):
        print(f'  {n:<20} {v:>14,}')
    fills, served = sum(t[6:10]), sum(t[10:14])
    print(f'  nG fills {fills:,} ({100*fills/max(t[25],1):.1f}% of primary fills); served {served:,} ({100*served/max(fills,1):.1f}%);'
          f' switches {1e6*t[0]/steps:.1f} a M steps, {t[2]/max(t[0],1):.1f} entries stashed a switch, {t[3]/max(t[0],1):.1f} restorable,'
          f' {served/max(t[0],1):.2f} served a switch')
    s2 = sum(t[26:30]) if len(t) > 26 else 0
    print(f'  strict: served {s2:,} ({100*s2/max(fills,1):.1f}%), data {t[26]+t[27]:,}, exec {t[28]:,}; restored {t[30]:,} ({t[30]/max(t[0],1):.1f} a switch), onto a global {t[31]:,}, onto another {t[32]:,}')
    print(f'  ASIDE1 of another ASID: {t[18]:,} of {t[17]:,}, dropping {t[19]:,} live nG entries, {t[33]:,} refilled')
a = sys.argv[1]
if a.endswith('.gz'):
    last = json.loads(gzip.open(a, 'rt').read().strip().split('\n')[-1])
    show('pages', last['jit']['steps'], last['jit']['diag'])
else:
    d = json.load(open(a)); seen = set()
    for r in d['rows']:
        if r.get('warm') or 'stats' not in r['s'] or r['workload'] in seen: continue
        seen.add(r['workload']); st = r['s']['stats']
        show(r['workload'], st['steps'], st['jit']['diag'])
