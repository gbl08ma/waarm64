#!/usr/bin/env python3
# bench/io's suite on a persistent profile, `ORDERED` on and off (ab.sh): each run's median per job, both arms' ranges
# and the medians' ratio.  python3 summary.py <prefix: vm-io-profile | mac-io-profile>
import glob, json, statistics, sys

prefix = sys.argv[1]
here = __file__.rsplit('/', 1)[0]
arms = {}
for path in sorted(glob.glob(f'{here}/{prefix}-*-*.json')):
    arm, rnd = path[:-5].rsplit('-', 2)[-2:]
    d = json.load(open(path))
    arms.setdefault(arm, []).append((rnd, d))
    print(f"# {path.rsplit('/', 1)[1]}: {d['profile']}, Chromium {d['browser']['version']}, {d['host']['platform']}/{d['host']['arch']}, {d['date']}")
jobs = [r['name'] for r in arms['on'][0][1]['results'] if r['name'].endswith(('_bw', '_lat')) or 'dd_' in r['name']]
print(f"{'job':40} {'on (median of each run)':36} {'off':36} off/on")
for j in jobs:
    meds = {a: [next(r['median'] for r in d['results'] if r['name'] == j) for _, d in runs] for a, runs in arms.items()}
    f = lambda v: ' '.join(f'{x:.0f}' if x >= 100 else f'{x:.1f}' for x in v)
    ratio = statistics.median(meds['off']) / statistics.median(meds['on']) - 1
    apart = min(meds['off']) > max(meds['on']) or max(meds['off']) < min(meds['on'])
    print(f"{j:40} {f(meds['on']):36} {f(meds['off']):36} {ratio * 100:+.1f}%{' (apart)' if apart else ''}")
