# Ad hoc: disassembles marks of one diag kind: showk.py <dir> <kind> [n] [skip]
import bisect, glob, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wasmdis import decode, module
d, kind = sys.argv[1], int(sys.argv[2]); n = int(sys.argv[3]) if len(sys.argv) > 3 else 3; skip = int(sys.argv[4]) if len(sys.argv) > 4 else 0
for f in sorted(glob.glob(f'{d}/m*.wasm'), key=lambda f: int(os.path.basename(f)[1:-5])):
    b = open(f, 'rb').read()
    nimp, bodies, diag = module(b)
    for fi, (cs, ce) in bodies.items():
        dis = None
        for (w, s0, s1, k, nm) in diag.get(fi, []):
            if k != kind: continue
            skip -= 1
            if skip >= 0: continue
            if dis is None:
                dis = list(decode(b, cs, ce)); offs = [x[0] - cs for x in dis]
            seg = dis[bisect.bisect_left(offs, s0):bisect.bisect_left(offs, s1)]
            print(f'--- {os.path.basename(f)} f{fi} {nm} {s1 - s0} B')
            print('  ' + '; '.join(o + ('' if im is None else ' ' + (im.hex() if isinstance(im, (bytes, bytearray)) else str(im))) for _, o, im, _ in seg))
            n -= 1
            if n == 0: sys.exit()
