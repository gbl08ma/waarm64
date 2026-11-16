#!/usr/bin/env python3
# Per arm: the range of each round's median, the change of the medians of those medians, and whether ranges overlap.
#   python3 summary.py <dir> <prefix> <armA> <armB>, e.g. summary.py bench/boot/results/perf32 mac-cw base pacedcw
import json, sys, glob, statistics, re
d, prefix, A, B = sys.argv[1:5]
data = {}
for f in glob.glob(f'{d}/{prefix}-r*-*.json'):
    m = re.search(r'-r(\d+)-([a-z0-9]+)-(smp_\w+)\.json$', f)
    r, arm = int(m[1]), m[2]
    for res in json.load(open(f))['results']:
        data.setdefault(res['name'], {}).setdefault(arm, []).append((r, statistics.median(res['samples'])))
for name in sorted(data):
    a = [v for _, v in sorted(data[name].get(A, []))]
    b = [v for _, v in sorted(data[name].get(B, []))]
    if not a or not b:
        continue
    ma, mb = statistics.median(a), statistics.median(b)
    ov = 'overlap' if min(b) <= max(a) and min(a) <= max(b) else 'NO overlap'
    print(f'{name:34} {A} {min(a):7.0f}-{max(a):7.0f}  {B} {min(b):7.0f}-{max(b):7.0f}  {100*(mb-ma)/ma:+5.1f}%  {ov}  (n={len(a)},{len(b)})')
