# Photos for desktop.html (README.md "On the desktop guest"): every image in <src dir> (any format Pillow reads; the
# largest first), cropped to 16:9 and saved at each width in SIZES in each format as <out>/<width>/<i>.<fmt>.
#   python3 bench/imgdecode/photos.py <src dir> <out dir> [n]
import os, sys
from PIL import Image
SIZES = [320, 480, 1024]
src, out = sys.argv[1], sys.argv[2]
n = int(sys.argv[3]) if len(sys.argv) > 3 else 16
files = sorted((os.path.join(src, f) for f in os.listdir(src)), key=os.path.getsize, reverse=True)[:n]
for i, f in enumerate(files):
    im = Image.open(f).convert('RGB')
    w, h = im.size
    ch = min(h, w * 9 // 16)
    im = im.crop((0, (h - ch) // 2, w, (h - ch) // 2 + ch))
    for s in SIZES:
        d = os.path.join(out, str(s))
        os.makedirs(d, exist_ok=True)
        r = im.resize((s, s * 9 // 16), Image.LANCZOS)
        r.save(f'{d}/{i}.jpg', quality=85, subsampling=2)
        r.save(f'{d}/{i}.webp', quality=80)
        r.save(f'{d}/{i}.png', optimize=False)
        r.save(f'{d}/{i}.avif', quality=60, speed=8)
