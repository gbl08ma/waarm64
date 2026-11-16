# SNAPZ loop 2b: the rounds' pauses and memory (the probe's, and bench/snapz/memwatch.ts's by process) by guest, save and arm.
#   python3 summary.py [summary.json]
import json,sys,re,glob,os,statistics,gzip
import pathlib
d=str(pathlib.Path(__file__).parent/'rounds')+'/'
out={}
for jf in sorted(glob.glob(d+'*-*-[0-9]*.json')):
    tag=os.path.basename(jf)[:-5]
    m=re.match(r'(desktop|debian)-(base|new|wblob)-(\d+)$',tag)
    if not m: continue
    g,arm,_=m.groups()
    j=json.load(open(jf)); r=j['rounds'][0]
    mem=[json.loads(l) for l in gzip.open(d+tag+'.mem.jsonl.gz','rt')] if os.path.exists(d+tag+'.mem.jsonl.gz') else []
    ev={}
    for l in open(d+tag+'.log'):
        mm=re.match(r'(\d+) round \d+ (kept|file|suspend) ',l)
        if mm: ev[mm.group(2)]=int(mm.group(1))
    for k in ('kept','file','suspend'):
        s=r[k]; key=(g,k,arm); o=out.setdefault(key,{'paused':[],'ram':[],'probe':[],'mw':[],'rend':[],'brow':[],'wall':[]})
        o['paused'].append(s['pausedMs']); o['ram'].append(s['phases']['ram']); o['wall'].append(s['wallMs'])
        o['probe'].append(s['memory']['peak']['rssMiB']-s['memory']['before']['rssMiB'])
        if mem and k in ev:
            start=ev[k]-s['wallMs']; b=[x for x in mem if x['at']<start][-1]
            win=[x for x in mem if start<=x['at']<=ev[k]+1500]; pk=max(win,key=lambda x:x['sum'])
            o['mw'].append((pk['sum']-b['sum'])//1024)
            f=lambda x,t:x['types'].get(t,[0])[0]
            o['rend'].append((max(f(x,'renderer') for x in win)-f(b,'renderer'))//1024)
            o['brow'].append((max(f(x,'browser') for x in win)-f(b,'browser'))//1024)
def md(v): 
    v=sorted(v); return f"{int(statistics.median(v)):,} ({v[0]:,}-{v[-1]:,})" if v else '-'
res={}
for key in sorted(out):
    o=out[key]; print(f"{key[0]:8s} {key[1]:8s} {key[2]:6s} n={len(o['paused'])} paused {md(o['paused']):22s} ram {md(o['ram']):20s} probe +{md(o['probe']):22s} mw-sum +{md(o['mw']):22s} renderer +{md(o['rend']):20s} browser +{md(o['brow'])}")
    res['/'.join(key)]=o
if len(sys.argv)>1: json.dump(res,open(sys.argv[1],'w'),indent=1)
