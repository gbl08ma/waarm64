# PERF loop 79's GL call counts (the diagnostic build: diag.patch): python3 counts.py <results.json>...: per phase, a
# draw's calls before its program (phase 1), its state setting (2), its draw calls (3) and the rest (0), by kind and name
# (all / repeats a draw), with the draw's times by part.
import json,sys
KIND={}
def kind(n):
    if n.startswith('uniform'): return 'uniforms'
    if n in('activeTexture','bindTexture','texParameteri','bindSampler','samplerParameteri','samplerParameterf'): return 'textures'
    if n in('bindBufferRange','bindBufferBase'): return 'ubos'
    if 'VertexAttrib' in n or n.startswith('vertexAttrib') or n=='bindVertexArray' or n=='bindBuffer' or n=='bufferData' or n=='bufferSubData': return 'vertex'
    if n.startswith('blend') or n.startswith('colorMask') or n in('enableiOES','disableiOES'): return 'blend'
    if n.startswith('stencil') or n.startswith('depth'): return 'depth/stencil'
    if n.startswith('framebuffer') or n in('bindFramebuffer','drawBuffers'): return 'framebuffer'
    if n.startswith('draw'): return 'draw'
    if n in ('useProgram',): return 'program'
    return 'raster/other'
def walk(o,path,out):
    if isinstance(o,dict):
        if 'glTotals' in o: out.append((path,o)); return
        for k,v in o.items(): walk(v,path+'/'+k,out)
for f in sys.argv[1:]:
    d=json.load(open(f)); out=[]; walk(d,'',out)
    for path,r in out:
        g=r['glTotals']; dt=r['drawTimes']; n=dt['n'] or 1
        draws=sum(v[0] for k,v in g.get('3',{}).items() if k.startswith('draw'))
        print(f"== {f} {path}: secs {r['seconds']} drawN {dt['n']} glDraws(calls) {draws} busyMs/s {r['busyMs']:.1f} submitMs/s {r['submitMs']:.1f} draws/s {r['glDraws']:.0f} uploadKB/s {r['uploadKB']:.0f}")
        print(f"   per draw us: pre {dt['pre']/n*1000:.1f} state {dt['state']/n*1000:.1f} call {dt['call']/n*1000:.1f}; busy/draw {r['busyMs']/max(r['glDraws'],1e-9)*1000:.1f}")
        for ph in ['1','2','3','0']:
            t=g.get(ph,{}); tot=sum(v[0] for v in t.values()); rep=sum(v[1] for v in t.values())
            print(f"   phase {ph}: {tot/n:.1f} calls/draw, repeats {rep/n:.1f} ({rep/max(tot,1)*100:.0f}%)")
            ks={}
            for k,v in t.items():
                a=ks.setdefault(kind(k),[0,0]); a[0]+=v[0]; a[1]+=v[1]
            print('     by kind:', ', '.join(f"{k} {v[0]/n:.1f}/{v[1]/n:.1f}" for k,v in sorted(ks.items(),key=lambda x:-x[1][0])))
            top=sorted(t.items(),key=lambda x:-x[1][0])[:14]
            print('     top:', ', '.join(f"{k} {v[0]/n:.2f}/{v[1]/n:.2f}" for k,v in top))
