# Ad hoc: chain() marks by shape: exclusive bytes, and whether they hold a jc/xc fallback.
import collections, glob, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wasmdis import module
d = sys.argv[1]
shape = collections.Counter(); byt = collections.Counter(); code = 0
for f in glob.glob(f'{d}/m*.wasm'):
    b = open(f, 'rb').read()
    nimp, bodies, diag = module(b)
    for fi, (cs, ce) in bodies.items():
        code += ce - cs
        es = diag.get(fi, [])
        nest = [(s0, s1, k) for (w, s0, s1, k, nm) in es if k in (24, 25)]
        for (w, s0, s1, k, nm) in es:
            if k != 23: continue
            inner = [(a, z, kk) for (a, z, kk) in nest if s0 <= a and z <= s1]
            ex = (s1 - s0) - sum(z - a for a, z, _ in inner)
            direct = ex > 30  # a direct call with its maps_to check (or not)
            key = ('direct' if ex >= 20 else 'none') + ('+guard' if ex > 30 else '') + ''.join('+' + {24: 'jc', 25: 'xc'}[kk] for _, _, kk in inner)
            shape[key] += 1; byt[key] += s1 - s0
for k, v in shape.most_common():
    print(f'{k:22} n={v:7} bytes {byt[k]:9} ({100*byt[k]/code:4.1f}%) avg {byt[k]/v:6.1f}')
