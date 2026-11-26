# PERF loop 85's marks for its new start (temporary; applies to the loop's tree): python3 diag-new.py, UNDO=1 takes them out.
import os
UNDO=os.environ.get('UNDO')
OPS=[]
def sub(path, old, new): OPS.append((path, old, new))
def _sub(path, old, new):
    if UNDO: old, new = new, old
    s=open(path).read(); assert old in s, (path, old); s=s.replace(old,new,1); open(path,'w').write(s)
T="(performance.timeOrigin + performance.now()).toFixed(1)"
L=lambda tag: "console.error(`[d85] %s ${%s}`);" % (tag, T)
p='web/app/run/runner.ts'
sub(p,"    const { machine: m, screen, net, audio } = this.d;\n    this.again = undefined;\n", "    "+L('page.start')+"\n    const { machine: m, screen, net, audio } = this.d;\n    this.again = undefined;\n")
sub(p,"    if (ch.nets.length) void net.autoconnect();\n  }\n", "    if (ch.nets.length) void net.autoconnect();\n    "+L('page.startReturned')+"\n    setTimeout(() => { "+L('page.nextTask')+" });\n  }\n")
sub(p,"    const ready = (caps: Uint8Array) => {\n      three.caps = caps;\n", "    const ready = (caps: Uint8Array) => {\n      "+L('page.gpuReady')+"\n      three.caps = caps;\n")
sub(p,"    if (!(await this.own(() => r.live()))) return false;\n", "    "+L('page.begin')+"\n    if (!(await this.own(() => r.live()))) return false;\n    "+L('page.owned')+"\n")
sub(p,"    if (!opened) return false;\n", "    if (!opened) return false;\n    "+L('page.opened')+"\n")
sub(p,"    r.worker.postMessage(\n      ...startMessage(", "    "+L('page.postStart')+"\n    r.worker.postMessage(\n      ...startMessage(")
p='web/gpu-worker.ts'
sub(p,"  if (e.data?.type !== 'init') return;\n", "  if (e.data?.type !== 'init') return;\n  "+L('gpu.init')+"\n")
sub(p,"  post({ type: 'ready', caps, renderer: info.renderer });", "  "+L('gpu.ready')+"\n  post({ type: 'ready', caps, renderer: info.renderer });")
p='web/app/worker.ts'
sub(p,"    case 'caps':\n      return gotCaps(m.caps);", "    case 'caps':\n      "+L('mw.caps')+"\n      return gotCaps(m.caps);")
sub(p,"async function start(m: StartMessage, note?: unknown): Promise<void> {\n  const t0 = performance.now();\n", "async function start(m: StartMessage, note?: unknown): Promise<void> {\n  const t0 = performance.now();\n  "+L('mw.start')+"\n")
sub(p,"    const caps = await startCaps(m, laterCaps);\n", "    "+L('mw.capsWait')+"\n    const caps = await startCaps(m, laterCaps);\n    "+L('mw.capsHave')+"\n")
for op in (reversed(OPS) if UNDO else OPS):
    _sub(*op)
