#!/usr/bin/env python3
# locals.py <dir>: per JIT function of the modules in <dir>, its declared locals (beyond the 3 params): count,
# bytes as Liftoff's stack slots (8, v128 16), whether Liftoff zero-fills them (more than 12 locals, or any not
# i32/i64), and the zero-fill loop's iterations (bytes / 4 when over 12 slots). Prints the distribution.
import os, sys, collections

def uleb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7f) << s; s += 7
        if x < 0x80: return r, i

def funcs(path):
    b = open(path, 'rb').read()
    i = 8
    while i < len(b):
        sid = b[i]; i += 1
        size, i = uleb(b, i)
        end = i + size
        if sid == 10:
            n, j = uleb(b, i)
            for _ in range(n):
                fsize, j = uleb(b, j)
                fend = j + fsize
                nd, k = uleb(b, j)
                decl = []
                for _ in range(nd):
                    cnt, k = uleb(b, k)
                    decl.append((cnt, b[k])); k += 1
                yield decl, fsize
                j = fend
        i = end

d = sys.argv[1]
stats = collections.Counter()
hist = collections.Counter()
nf = 0; tot_iters = 0; tot_locals = 0; zeroed = 0; tot_bytes = 0; vfuncs = 0
for f in os.listdir(d):
    if not f.endswith('.wasm'): continue
    for decl, fsize in funcs(os.path.join(d, f)):
        nf += 1
        cnt = sum(c for c, _ in decl)
        by = sum(c * (16 if t == 0x7b else 8) for c, t in decl)
        ints = all(t in (0x7f, 0x7e) for _, t in decl)
        if any(t == 0x7b for _, t in decl): vfuncs += 1
        z = cnt > 12 or not ints
        tot_locals += cnt
        if z:
            zeroed += 1
            tot_bytes += by
            if by > 96: tot_iters += by // 4
        hist[min(cnt // 5 * 5, 60)] += 1
print(f'{nf} functions, {tot_locals / nf:.1f} locals each, {zeroed} zero-filled ({100 * zeroed / nf:.0f}%), {vfuncs} with v128 locals')
print(f'zero-filled bytes {tot_bytes / max(zeroed, 1):.0f} a function; loop iterations {tot_iters / nf:.1f} a function')
print('locals histogram (bucket of 5):', dict(sorted(hist.items())))
