import json,glob,collections,sys
# tallies.py [dir]: per result of `?tallies` (timer line late in WFI and running, µs; WFI wake-ups), each arm's median
# over its boots [range] and the boots counted. Files: p60t-<bench>-<arm>-<round>.json.
d=sys.argv[1] if len(sys.argv)>1 else 'tallies'
R=collections.defaultdict(lambda: collections.defaultdict(list))
for f in sorted(glob.glob(f'{d}/p60t-*.json')):
    arm='-'.join(f.split('/')[-1][:-5].split('-')[2:-1])
    for r in json.load(open(f))['results']:
        if '_late' in r['name'] or 'wakes' in r['name']: R[r['name']][arm]+=r['samples']
med=lambda x: sorted(x)[len(x)//2]
for n,a in R.items():
    print(f"{n:34}", '  '.join(f"{k}: {med(v):.1f} [{min(v):.1f}-{max(v):.1f}] n{len(v)}" for k,v in sorted(a.items())))
