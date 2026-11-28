#!/usr/bin/env python3
# PERF loop 98: diag.patch's idle tallies (66 words, summed over the vCPUs; web/vcpu-worker.ts `diagIdle`), per second.
#   python3 rules.py <counts.ts lines (.txt)> | <a pages session's jit.jsonl.gz>
import gzip, json, sys

KS = [1, 2, 4, 8, 16, 32, 64]
TS = [1, 10, 100]
RULES = [f'streak<{k}' for k in KS] + [f'hit<{t}ms' for t in TS]
WB = ['<5', '5-10', '10-20', '20-50', '50-200', '200-1000', '>=1000']
DB = ['<0.1', '0.1-1', '1-4', '4-16', '>=16', 'off']


def show(label, w, secs):
    r = [x / secs for x in w]
    idles = r[0]
    print(f'== {label} ({secs:.1f} s)')
    print(f'  idles {idles:.0f}/s: poll hits {r[1]:.0f} ({100 * r[1] / max(idles, 1e-9):.1f}%), woken later {r[2]:.0f}, '
          f'timed out {r[3]:.0f}; off {r[5]:.0f}, short (< poll + tail) {r[6]:.0f}; polling {r[4] / 10:.2f}% of a core '
          f'({1e3 * r[4] / max(idles, 1e-9):.1f} µs each)')
    print('  woken after (µs): ' + ', '.join(f'{b} {r[7 + i]:.0f}' for i, b in enumerate(WB)))
    print('  by deadline (ms): ' + ', '.join(f'{b} {r[14 + i]:.0f} (hits {r[20 + i]:.0f})' for i, b in enumerate(DB)))
    hits = sum(r[26 + 2:26 + 4])  # rule 0's caught + slowed = all eligible hits
    print(f"  rules (the eligible idles' hits {hits:.0f}/s):")
    for i, n in enumerate(RULES):
        polls, pms, caught, slowed = r[26 + 4 * i: 30 + 4 * i]
        saved = r[4] - pms  # poll ms a second not spent (short idles' polls kept)
        print(f'    {n:>11}: polls {polls:7.0f}/s, poll {pms / 10:5.2f}% of a core (saves {saved / 10:5.2f}%), '
              f'hits caught {caught:6.0f}, slowed {slowed:5.0f}/s ({100 * slowed / max(hits, 1e-9):4.1f}% of hits)')


for f in sys.argv[1:]:
    if 'jsonl' in f:
        op = gzip.open if f.endswith('.gz') else open
        rows = [json.loads(l) for l in op(f, 'rt') if l.strip()]
        rows = [x for x in rows if 'idle98' in x.get('jit', {})]
        a, b = rows[0], rows[-1]
        show(f, [y - x for x, y in zip(a['jit']['idle98'], b['jit']['idle98'])], (b['t'] - a['t']) / 1000)
    else:
        for line in open(f):
            i = line.find('{')
            if i < 0:
                continue
            d = json.loads(line[i:])
            show(f"{f} {d['what']} spin {d.get('spin')} " + ' '.join(f'{k} {d[k]}' for k in ('lseS', 'llscS') if k in d),
                 d['idle98'], d['secs'])
