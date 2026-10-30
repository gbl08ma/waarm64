import collections, glob, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wasmdis import module
h = collections.Counter()
for f in glob.glob(f'{sys.argv[1]}/m*.wasm'):
    b = open(f, 'rb').read()
    _, bodies, diag = module(b)
    for es in diag.values():
        for (w, s0, s1, k, nm) in es:
            if k == 20: h[s1 - s0] += 1
tot = sum(h.values())
for s, n in sorted(h.items(), key=lambda x: -x[1])[:12]: print(s, n, f'{100*n/tot:.1f}%')
