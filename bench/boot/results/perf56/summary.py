import json,glob,sys,re,collections
# sum.py <dir> <prefix> <base> <new>: per result, each arm's per-round medians (range), the medians' change, overlap.
d,pre,a,b=sys.argv[1:5]
R=collections.defaultdict(lambda: collections.defaultdict(list))
for f in sorted(glob.glob(f"{d}/{pre}-*.json")):
    m=re.match(rf".*/{pre}-(\w+)-r(\d+)-",f)
    if not m: continue
    for r in json.load(open(f))['results']: R[r['name']][m.group(1)].append(r['median'])
med=lambda x: sorted(x)[len(x)//2]
for n,arms in R.items():
    if a not in arms or b not in arms: continue
    x,y=arms[a],arms[b]; ch=(med(y)/med(x)-1)*100
    ov='no overlap' if max(y)<min(x) or min(y)>max(x) else 'overlap'
    print(f"{n:32} {a} {min(x):.0f}-{max(x):.0f}  {b} {min(y):.0f}-{max(y):.0f}  {ch:+.1f}% {ov}")
