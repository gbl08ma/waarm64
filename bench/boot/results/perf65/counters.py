import json, sys, statistics as st
# counters.py <ab.json>: per workload, the measured samples' median JIT counters, footprint, instructions and cycles,
# each arm against the first (bench/ab.ts's ab.json; PERF loop 65).
d = json.load(open(sys.argv[1]))
keys = ['blocks', 'modules', 'bytes', 'regionBlocks', 'tierUps', 'decSteps', 'locks', 'emitNs', 'planNs', 'compileNs', 'dispatches']
arms = [a['name'] for a in d['arms']]
base = arms[0]


def table(by):
    def med(a, f):
        v = [f(s) for s in by[a]]
        return st.median(v) if v else float('nan')

    def row(name, f, absolute=False):
        b = med(base, f)
        cells = []
        for a in arms:
            m = med(a, f)
            cells.append('%.0f' % (m / 2**20 if absolute else m) if a == base or absolute else '%+.2f%%' % (100 * (m / b - 1)))
        print('%-12s' % name + ''.join('%14s' % c for c in cells))

    print('n', {a: len(by[a]) for a in arms})
    print('%-12s' % '' + ''.join('%14s' % a for a in arms))
    for k in keys:
        row(k, lambda s, k=k: s['stats']['jit'][k])
    row('footMiB', lambda s: s['footprint'], absolute=True)
    for k in ['instructions', 'cycles']:
        row(k, lambda s, k=k: s['proc'][k])


for w in sorted({r['workload'] for r in d['rows']}):
    print('workload', w)
    by = {a: [] for a in arms}
    for r in d['rows']:
        if r.get('warm') or r['workload'] != w or 'stats' not in r['s']:
            continue
        by[r['arm']].append(r['s'])
    table(by)
