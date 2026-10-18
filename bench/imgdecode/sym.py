# Symbolizes a profile.ts result: user PCs (path + file offset) -> function (where debug info exists) and the
# instruction at the PC. usage: python3 sym.py <bin dir> out/<case>.json [top]
import json, os, re, subprocess, sys, collections
bindir, path = sys.argv[1], sys.argv[2]
top = int(sys.argv[3]) if len(sys.argv) > 3 else 25
res = json.load(open(path))
segs = {}
def seg(f):
    if f not in segs:
        out = subprocess.run(['llvm-readelf', '-lW', f], capture_output=True, text=True).stdout
        segs[f] = [(int(m[1], 16), int(m[2], 16), int(m[3], 16)) for m in re.finditer(r'LOAD\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+0x[0-9a-f]+\s+(0x[0-9a-f]+)', out)]
    return segs[f]
def vaddr(f, off):
    for o, v, sz in seg(f):
        if o <= off < o + sz: return off - o + v
    return off
hot = collections.defaultdict(list)
libs = []
for l in res['attrib'].split('\n'):
    p = l.split(' ')
    if p[0] == 'LIB': libs.append((int(p[1]), p[2]))
    elif p[0] == 'PC': hot[p[2]].append((int(p[1]), int(p[3], 16)))
u = res['user']
print(f"{res['case']}: {res['total']} samples, kernel {100*res['kernel']/res['total']:.1f}%, user {100*u/res['total']:.1f}%")
print('helpers (calls in the window):', ', '.join(f'{o} {n/1e6:.2f}M' for o, n in res['helpers'][:16]))
for n, l in libs[:6]: print(f'  {100*n/res["total"]:5.1f}%  {l}')
for lib, pcs in hot.items():
    base = os.path.basename(lib)
    f = os.path.join(bindir, base)
    if not os.path.exists(f): continue
    dbg = os.path.join(bindir, base.split('.so')[0] + '.debug')
    addrs = [vaddr(f, off) for _, off in pcs]
    names = ['?'] * len(addrs)
    if os.path.exists(dbg):
        out = subprocess.run(['llvm-symbolizer', '--obj', dbg, '--no-inlines', '--functions=linkage', '-C'] + [hex(a) for a in addrs], capture_output=True, text=True).stdout.strip().split('\n\n')
        names = [o.split('\n')[0][:90] for o in out]
    fn = collections.Counter()
    ins = collections.Counter()
    for (n, _), a, name in zip(pcs, addrs, names): fn[name] += n
    for (n, _), a, name in list(zip(pcs, addrs, names))[:150]:
        d = subprocess.run(['llvm-objdump', '-d', '--no-show-raw-insn', f'--start-address={hex(a)}', f'--stop-address={hex(a + 4)}', f], capture_output=True, text=True).stdout
        m = re.findall(r'^\s*[0-9a-f]+:\s+(\S+)', d, re.M)
        ins[m[-1] if m else '?'] += n
    tot = sum(n for n, _ in pcs)
    print(f'-- {base}: {len(pcs)} PCs = {100*tot/res["total"]:.1f}% of all samples')
    if os.path.exists(dbg):
        for name, n in fn.most_common(top): print(f'  {100*n/res["total"]:5.1f}%  {name}')
    print('  sampled instructions (top 150 PCs):', ', '.join(f'{k} {100*n/res["total"]:.1f}%' for k, n in ins.most_common(14)))
