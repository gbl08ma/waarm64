# The harness's rounds (harness.jsonl: h.ts's lines, by file, profile, arm): median (range) of the disk phase's write
# and its parts, ms. python3 summary.py
import json, statistics, collections
rows = collections.defaultdict(list)
for l in open('harness.jsonl'):
    d = json.loads(l); rows[(d['file'], d['profile'], d['arm'])].append(d)
def md(v):
    v = sorted(v); return f"{statistics.median(v):,.0f} ({v[0]:,.0f}-{v[-1]:,.0f})"
for k, rs in rows.items():
    f = lambda key: md([r.get(key, 0) for r in rs])
    print(f"{k[0]:10s} {k[1]:10s} {k[2]:5s} calls {rs[0]['calls']:5d} write {f('write')} | data.flush {f('data.flush.ms')} data.write {f('data.write.ms')} map.write {f('map.write.ms')} getSize {f('data.getSize.ms')} decode {f('decode')} isZero {f('isZero')} | read each {f('readEach')} read in runs {f('readRuns')}")
