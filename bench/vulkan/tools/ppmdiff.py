# Compares two PPMs (P6, same size; rows top first unless "flipB"): the share of pixels whose largest channel
# difference exceeds 8, 32 and 64, and the mean absolute difference. python3 -I ppmdiff.py a.ppm b.ppm [flipB]
import sys
def load(p):
    d = open(p, 'rb').read()
    m, dims, mx, px = d.split(b'\n', 3)
    w, h = map(int, dims.split())
    return w, h, px
w, h, a = load(sys.argv[1])
w2, h2, b = load(sys.argv[2])
assert (w, h) == (w2, h2), 'sizes differ'
if len(sys.argv) > 3:
    b = b''.join(b[(h - 1 - y) * w * 3:(h - y) * w * 3] for y in range(h))
over = [0, 0, 0]
total = 0
for i in range(0, w * h * 3, 3):
    d = max(abs(a[i] - b[i]), abs(a[i + 1] - b[i + 1]), abs(a[i + 2] - b[i + 2]))
    total += d
    for k, t in enumerate((8, 32, 64)):
        if d > t: over[k] += 1
n = w * h
print(f'pixels over 8: {100 * over[0] / n:.2f}%, over 32: {100 * over[1] / n:.2f}%, over 64: {100 * over[2] / n:.2f}%, mean |d| {total / n:.2f}')
