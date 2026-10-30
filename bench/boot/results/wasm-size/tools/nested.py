# Ad hoc: bytes of the nested diag marks (kinds 20-30) by the top-level piece they sit in.
import bisect, collections, glob, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wasmdis import module
TOP = {0: 'inline', 10: 'inline', 11: 'inline', 1: 'helper', 2: 'chain', 3: 'tail', 4: 'prologue', 5: 'commit'}
SUB = {20: 'nzcv store', 21: 'reg store', 22: 'pc store', 23: 'chain() direct/jc', 24: 'via_jc', 25: 'indirect/xc', 26: 'edge', 27: 'slow arm', 28: 'tlb probe', 29: 'ret', 30: 'reg reload'}
d = sys.argv[1]
agg = collections.Counter(); cnt = collections.Counter(); tops = collections.Counter(); code = 0
for f in glob.glob(f'{d}/m*.wasm'):
    b = open(f, 'rb').read()
    nimp, bodies, diag = module(b)
    for fi, (cs, ce) in bodies.items():
        code += ce - cs
        es = diag.get(fi, [])
        top = sorted((s0, s1, k) for (w, s0, s1, k, nm) in es if k < 20)
        starts = [t[0] for t in top]
        for t in top: tops[TOP[t[2]]] += t[1] - t[0]
        for (w, s0, s1, k, nm) in es:
            if k < 20: continue
            i = bisect.bisect_right(starts, s0) - 1
            p = TOP[top[i][2]] if i >= 0 and top[i][1] >= s1 else '?'
            agg[(p, SUB[k])] += s1 - s0; cnt[(p, SUB[k])] += 1
print('code', code)
for k, v in tops.most_common(): print(f'{k:10} {v:10} {100*v/code:5.1f}%')
for (p, s), v in sorted(agg.items(), key=lambda x: -x[1]):
    print(f'{p:10} {s:20} {v:10} {100*v/code:5.1f}% n={cnt[(p,s)]:8} avg {v/cnt[(p,s)]:6.1f}')
