import json, sys, math, statistics as st
# pool.py <arm> <ab.json>...: the pairs' wall and cycle ratios of <arm> over each run's base, pooled across runs
# (PERF loop 68): the mean, a 99% t interval (plain, no sequential correction), the pairs.
arm = sys.argv[1]
w, c = [], []
for f in sys.argv[2:]:
    d = json.load(open(f)); base = d['arms'][0]['name']
    by = {}
    for r in d['rows']:
        if r.get('warm'): continue
        by.setdefault(r['block'], {})[r['arm']] = r['s']
    for b in by.values():
        if arm in b and base in b:
            w.append(math.log(b[arm]['ms'] / b[base]['ms'])); c.append(math.log(b[arm]['proc']['cycles'] / b[base]['proc']['cycles']))
for name, x in (('wall', w), ('cycles', c)):
    m, s = st.mean(x), st.stdev(x) / math.sqrt(len(x))
    t = 2.83 if len(x) > 20 else 3.1
    print('%s %s: %+.2f%% [%+.2f, %+.2f] over %d pairs' % (arm, name, 100 * (math.exp(m) - 1), 100 * (math.exp(m - t * s) - 1), 100 * (math.exp(m + t * s) - 1), len(x)))
