# PERF loop 101's A/B (ab/, ab2/, ab3/: base 5dc048d0's web/, new the loop's web.patch): medians (ranges) per guest and arm, ms. python3 summary.py > summary.json
import json, glob, statistics as st, collections, os
here = os.path.dirname(os.path.abspath(__file__))
out = {}
for name, sub, guest in (('desktop', 'ab', 'desktop'), ('desktop2', 'ab2', 'desktop'), ('desktop3', 'ab3', 'desktop')):
    d = collections.defaultdict(lambda: collections.defaultdict(list))
    for f in sorted(glob.glob(f'{here}/{sub}/{guest}-*-[0-9].json')):
        arm = f.split('/')[-1].split('-')[1]
        r = json.load(open(f))['rounds'][0]
        L = r['load']; P = L['phases']
        d[arm]['loadWall'].append(L['wallMs']); d[arm]['loadTotal'].append(P['total'])
        d[arm]['pass'].append(P['check'] + P['state'] + P['ram']); d[arm]['disk'].append(P['disk'])
        K = r.get('kept')
        if K:
            d[arm]['paused'].append(K['pausedMs']); d[arm]['blobs'].append(K['phases']['blobs']); d[arm]['saveDisk'].append(K['phases']['disk'])
            m = K.get('memory')
            if m: d[arm]['saveMemAddedMiB'].append(m['peak']['rssMiB'] - m['before']['rssMiB'])
    out[name] = {a: {k: {'median': st.median(v), 'min': min(v), 'max': max(v), 'n': len(v)} for k, v in m.items()} for a, m in d.items()}
print(json.dumps(out, indent=1))
