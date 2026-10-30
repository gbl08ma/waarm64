# Ad hoc: counts local peephole patterns over every function body.
import collections, glob, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wasmdis import decode, module
d = sys.argv[1]
c = collections.Counter(); save = collections.Counter()
code = 0
for f in glob.glob(f'{d}/m*.wasm'):
    b = open(f, 'rb').read()
    nimp, bodies, diag = module(b)
    for fi, (cs, ce) in bodies.items():
        code += ce - cs
        dis = list(decode(b, cs, ce))
        for i in range(len(dis) - 1):
            a, n = dis[i], dis[i + 1]
            if a[1] == 'local.set' and n[1] == 'local.get' and a[2] == n[2]:
                c['set;get same'] += 1; save['set;get same'] += n[3]
            if a[1] in ('i64.const', 'i32.const') and a[2] == 0 and n[1] in ('i64.add', 'i32.add', 'i64.or', 'i32.or', 'i64.sub', 'i32.sub', 'i64.xor', 'i32.xor'):
                c['const0;add'] += 1; save['const0;add'] += a[3] + n[3]
            if a[1] == 'i64.extend_i32_u' and n[1] == 'i32.wrap_i64':
                c['ext;wrap'] += 1; save['ext;wrap'] += 2
            if a[1] == 'local.get' and n[1] == 'local.set':
                c['get;set (copy)'] += 1
            if a[1] == 'local.tee' and n[1] == 'local.set':
                c['tee;set'] += 1
            if a[1] == 'i32.wrap_i64' and n[1] == 'i64.extend_i32_u':
                c['wrap;ext'] += 1
        for i in range(len(dis) - 2):
            a, m, n = dis[i], dis[i + 1], dis[i + 2]
            if a[1] == 'i64.extend_i32_u' and m[1] in ('local.set', 'local.tee'):
                pass
            if a[1] == 'local.get' and m[1] == 'local.set' and n[1] == 'local.get' and m[2] == n[2]:
                c['get A;set B;get B'] += 1
print('code', code)
for k, v in c.most_common():
    print(f'{k:22} {v:9}  saves {save[k]:9} B  {100 * save[k] / code:.2f}%')
