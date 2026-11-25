#!/usr/bin/env python3
# The blk device's stage timers (bench/io `io_stats`) of each run given, a table per run: per workload the requests'
# count and time, and each OPFS stage's calls, ms and µs a call.  python3 stats.py <io_stats JSON>...
import json, sys

for path in sys.argv[1:]:
    d = json.load(open(path))
    print(f"== {path}: {d.get('profile', 'off the record')}, {d['browser']['version']}, {d['host']['platform']}")
    for r in d['results']:
        st = r['params']['stages']
        req = st.get('request', {'n': 0, 'ms': 0})
        parts = []
        for k in sorted(st):
            if k == 'request':
                continue
            s = st[k]
            parts.append(f"{k} {s['n']}/{s['ms']:.1f}ms/{1000 * s['ms'] / max(s['n'], 1):.0f}us")
        print(f"{r['params']['only']:32} req {req['n']:6} {req['ms']:8.1f} ms ({1000 * req['ms'] / max(req['n'], 1):6.0f} us)  " + ', '.join(parts))
