# Per-function cost of the same decodes in the guest and natively (README.md "On the desktop guest"): each side's
# perf data (desktop.ts PERF=1 in the guest; perf record of Mozilla's Firefox on the dev VM, desktop.html?auto=), its
# sampling rate and the images it decoded; prints ms of CPU per image for each libxul leaf function and their ratio.
#   python3 bench/imgdecode/compare.py <guest.perf.data> <guest kallsyms> <guest Hz> <guest images> <native.perf.data> <native Hz> <native images> [top]
import sys
from perfsym import profile
g = profile(sys.argv[1], sys.argv[2]); gh, gi = float(sys.argv[3]), float(sys.argv[4])
n = profile(sys.argv[5], '/proc/kallsyms'); nh, ni = float(sys.argv[6]), float(sys.argv[7])
top = int(sys.argv[8]) if len(sys.argv) > 8 else 40
gms = lambda f: 1000 * g['leaf'][f] / gh / gi
nms = lambda f: 1000 * n['leaf'][f] / nh / ni
fns = [f for f, _ in g['leaf'].most_common(400) if f.startswith('xul ')]
print(f'{"guest ms/img":>12} {"native":>8} {"ratio":>6}  function')
tg = tn = 0.0
for f in fns[:top]:
    a, b = gms(f), nms(f)
    tg += a; tn += b
    print(f'{a:12.3f} {b:8.3f} {a / b if b else float("inf"):6.1f}  {f[4:]}')
print(f'{tg:12.3f} {tn:8.3f} {tg / tn if tn else 0:6.1f}  (these)')
for th in ('TaskCon~ller', 'dav1d-worker'):
    a, b = 1000 * g['by_comm'][th] / gh / gi, 1000 * n['by_comm'][th] / nh / ni
    if a or b: print(f'{a:12.3f} {b:8.3f} {a / b if b else 0:6.1f}  thread {th}')
