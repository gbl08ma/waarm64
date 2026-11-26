# PERF loop 79's A/B summary: python3 ab.py '<dir glob>' (e.g. 'bench/gpu/results/perf79/gtk-b-*'): per phase and arm
# (a directory's name ends <arm>-<round>), each round's renderer and GPU process numbers.
import json,sys,glob
rows={}
for f in sorted(glob.glob(sys.argv[1] + '/results.json')):
    arm=f.split('/')[-2].split('-')[-2]; rnd=f.split('/')[-2].split('-')[-1]
    d=json.load(open(f))
    for ph,v in d.items():
        if not isinstance(v,dict) or 'display' not in v or 'renderer' not in v['display']: continue
        dp=v['display']; r=dp['renderer']; dt=r.get('drawTimes',{}); n=dt.get('n') or 1; h=dp.get('host',{})
        rows.setdefault(ph,{}).setdefault(arm,[]).append(dict(rnd=rnd,busy=r['busyMs'],draws=r['glDraws'],bpd=r['busyMs']/max(r['glDraws'],1e-9)*1000,
          pre=dt.get('pre',0)/n*1000,state=dt.get('state',0)/n*1000,gpuMs=h.get('gpuMs'),gpuMc=h.get('gpuMcycles'),rendMs=h.get('rendererMs'),flushes=dp.get('flushes'),fps=v.get('medianFps')))
for ph,arms in rows.items():
    print(ph)
    for arm in sorted(arms):
        xs=arms.get(arm,[])
        if not xs: continue
        f=lambda k: ' '.join(f"{x[k]:.1f}" if isinstance(x[k],(int,float)) else '-' for x in xs)
        print(f"  {arm:4s} busy/s {f('busy')} | draws/s {f('draws')} | busy/draw us {f('bpd')} | pre {f('pre')} state {f('state')} | gpuMs/s {f('gpuMs')} gpuMcyc/s {f('gpuMc')} | rendMs/s {f('rendMs')} | flushes {f('flushes')} fps {f('fps')}")
