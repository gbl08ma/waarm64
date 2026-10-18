# Synthetic photo-like test images (gradients, shapes, blurred noise) in each format.
import random, sys
from PIL import Image, ImageDraw, ImageFilter
W, H, N = 1024, 683, 24
out = sys.argv[1]
for i in range(N):
    r = random.Random(i)
    base = Image.linear_gradient('L').resize((W, H)).rotate(r.randint(0, 359), expand=False)
    img = Image.merge('RGB', [base.point(lambda v, k=k: (v * (k + 1) * r.randint(1, 3) + r.randint(0, 255)) % 256) for k in range(3)])
    d = ImageDraw.Draw(img)
    for _ in range(60):
        x, y = r.randint(0, W), r.randint(0, H); s = r.randint(10, 200)
        d.ellipse([x, y, x + s, y + s], fill=tuple(r.randint(0, 255) for _ in range(3)))
    img = img.filter(ImageFilter.GaussianBlur(3))
    noise = Image.effect_noise((W, H), 40).convert('RGB')
    img = Image.blend(img, noise, 0.15)
    img.save(f'{out}/{i}.jpg', quality=85, subsampling=2)
    img.save(f'{out}/{i}p.jpg', quality=85, subsampling=2, progressive=True)
    img.save(f'{out}/{i}.png', optimize=False)
    img.save(f'{out}/{i}.webp', quality=80)
    img.save(f'{out}/{i}.avif', quality=60, speed=8)
