#!/usr/bin/env python3
# io_bulk's runs (ab-bulk.sh): per operation, each run's median of its 3 rounds by arm, and the medians' ratio.
#   python3 bulk.py <prefix: vm-bulk-profile | vm-bulk-off | mac-bulk-profile>
import glob, json, statistics, sys

prefix = sys.argv[1]
here = __file__.rsplit('/', 1)[0]
arms = {}
for path in sorted(glob.glob(f'{here}/{prefix}-*-*.json')):
    arm = path[:-5].rsplit('-', 2)[-2]
    d = json.load(open(path))
    arms.setdefault(arm, []).append(d)
    print(f"# {path.rsplit('/', 1)[1]}: {d['profile']}, Chromium {d['browser']['version']}, {d['host']['platform']}, rounds {[round(x) for r in d['results'] for x in r['samples']]}")
names = [r['name'] for r in next(iter(arms.values()))[0]['results']]
for n in names:
    meds = {a: [next(r['median'] for r in d['results'] if r['name'] == n) for d in runs] for a, runs in arms.items()}
    line = f"{n:20} " + '  '.join(f"{a}: {' '.join(f'{x:.0f}' for x in v)} ms" for a, v in sorted(meds.items()))
    if 'base' in meds and 'new' in meds:
        line += f"   new/base {statistics.median(meds['new']) / statistics.median(meds['base']):.3f}"
    print(line)
