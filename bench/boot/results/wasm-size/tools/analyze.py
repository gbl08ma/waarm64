# Ad hoc: where the JIT's wasm bytes go, from modules with the `webpc.diag` section.
#   python3 -I analyze.py <dir of m*.wasm> [report]
import bisect, collections, glob, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wasmdis import decode, module

KIND = {0: 'inline', 10: 'inline(lead)', 11: 'inline(follow)', 1: 'helper', 2: 'chain', 3: 'tail', 4: 'prologue', 5: 'commit'}

d = sys.argv[1]
files = sorted(glob.glob(f'{d}/m*.wasm'), key=lambda f: int(os.path.basename(f)[1:-5]))
total = 0
code_total = 0
by_kind = collections.Counter()
by_op = collections.Counter()
n_op = collections.Counter()
ops_in = collections.defaultdict(collections.Counter)   # opcode histogram per kind
gram = collections.Counter()
funcs = 0
insts = []  # (op name, kind, decoded list)
for f in files:
    b = open(f, 'rb').read()
    total += len(b)
    nimp, bodies, diag = module(b)
    for fi, (cs, ce) in bodies.items():
        funcs += 1
        code_total += ce - cs
        dis = list(decode(b, cs, ce))
        offs = [x[0] - cs for x in dis]
        es = diag.get(fi, [])
        # Map each instruction offset (relative) to its piece.
        for (w, s0, s1, k, nm) in es:
            if k >= 20: continue  # nested marks: nested.py
            seg = dis[bisect.bisect_left(offs, s0):bisect.bisect_left(offs, s1)]
            kk = KIND[k]
            ln = s1 - s0
            by_kind[kk] += ln
            if k in (0, 10, 11, 1):
                key = nm + ('' if k in (0, 1) else ' ' + kk) + (' [helper]' if k == 1 else '')
                by_op[key] += ln
                n_op[key] += 1
            for x in seg:
                ops_in[kk][x[1]] += x[3]
            if k in (0, 10, 11):
                insts.append((nm, w, [(x[1], x[2]) for x in seg]))
print(f'{len(files)} modules, {funcs} functions, {total} bytes, code bodies {code_total} ({100 * code_total / total:.1f}%)')
print('\nby piece:')
for k, v in by_kind.most_common():
    print(f'  {k:16} {v:12} {100 * v / code_total:5.1f}%')
print('\nby op (bytes, count, avg):')
for k, v in by_op.most_common(80):
    print(f'  {k:40} {v:12} {100 * v / code_total:5.1f}% {n_op[k]:9} {v / n_op[k]:7.1f}')
for kk in ('inline', 'tail', 'chain', 'prologue', 'helper', 'commit', 'inline(lead)', 'inline(follow)'):
    c = ops_in[kk]
    s = sum(c.values())
    if not s:
        continue
    print(f'\nopcode bytes in {kk} ({s}):')
    for k, v in c.most_common(25):
        print(f'  {k:24} {v:12} {100 * v / s:5.1f}%')
import pickle
pickle.dump(insts, open(f'{d}/insts.pkl', 'wb'))
