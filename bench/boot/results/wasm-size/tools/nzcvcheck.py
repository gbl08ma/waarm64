# Ad hoc: the compact SUBS NZCV (C = x >=u y, r = x - y, V = sign((x^y)&(x^r))) against AddWithCarry(x, ~y, 1).
import random
def awc(x, y, c, w):
    m = (1 << w) - 1
    u = x + y + c; r = u & m
    sx = lambda v: v - (1 << w) if v >> (w - 1) else v
    s = sx(x) + sx(y) + c
    return (r >> (w - 1)) << 3 | (r == 0) << 2 | (u > m) << 1 | (sx(r) != s)
def compact(x, y, w):
    m = (1 << w) - 1; r = (x - y) & m
    return (r >> (w - 1)) << 3 | (r == 0) << 2 | (x >= y) << 1 | (((x ^ y) & (x ^ r)) >> (w - 1))
for w in (32, 64):
    m = (1 << w) - 1
    edge = [0, 1, m, m >> 1, (m >> 1) + 1, 2, m - 1]
    vals = edge + [random.getrandbits(w) for _ in range(300)]
    for x in vals:
        for y in vals:
            assert awc(x, ~y & m, 1, w) == compact(x, y, w), (w, x, y)
print('ok')
