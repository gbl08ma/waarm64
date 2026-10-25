# A PPM (P6) to a PNG, optionally halved: python3 -I ppm2png.py in.ppm out.png [half]
import struct, sys, zlib
d = open(sys.argv[1], 'rb').read()
magic, dims, maxv, px = d.split(b'\n', 3)
w, h = map(int, dims.split())
half = len(sys.argv) > 3
if half:
    rows = []
    for y in range(0, h - 1, 2):
        r = px[y * w * 3:(y + 1) * w * 3]
        rows.append(bytes(b for x in range(0, w - 1, 2) for b in r[x * 3:x * 3 + 3]))
    w, h = w // 2, h // 2
else:
    rows = [px[y * w * 3:(y + 1) * w * 3] for y in range(h)]
raw = b''.join(b'\0' + r for r in rows)
c = lambda t, b: struct.pack('>I', len(b)) + t + b + struct.pack('>I', zlib.crc32(t + b) & 0xffffffff)
open(sys.argv[2], 'wb').write(b'\x89PNG\r\n\x1a\n' + c(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + c(b'IDAT', zlib.compress(raw, 6)) + c(b'IEND', b''))
