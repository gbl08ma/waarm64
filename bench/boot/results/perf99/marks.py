# PERF loop 99's start marks (temporary; applies to the loop's base tree, 9553399d): python3 marks.py, UNDO=1 takes them out.
# Each is a console line `[m99] <name> <ms since the epoch>` (performance.timeOrigin + now: comparable across workers).
import os
UNDO=os.environ.get('UNDO')
OPS=[]
def sub(path, old, new): OPS.append((path, old, new))
def _sub(path, old, new):
    if UNDO: old, new = new, old
    s=open(path).read(); assert s.count(old)==1, (path, old); s=s.replace(old,new,1); open(path,'w').write(s)
T="(performance.timeOrigin + performance.now()).toFixed(1)"
L=lambda tag: "console.error(`[m99] %s ${%s}`);" % (tag, T)
p='web/app/run/runner.ts'
sub(p,"    const { machine: m, screen, net, audio } = this.d;\n    this.again = undefined;\n", "    "+L('page.start')+"\n    const { machine: m, screen, net, audio } = this.d;\n    this.again = undefined;\n")
sub(p,"    const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });\n", "    "+L('page.newWorker')+"\n    const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });\n")
p='web/app/worker.ts'
sub(p,"self.onmessage = (e: MessageEvent<ToWorker>) => {\n", L('mw.eval')+"\nself.onmessage = (e: MessageEvent<ToWorker>) => {\n")
sub(p,"async function start(m: StartMessage, note?: unknown): Promise<void> {\n  const t0 = performance.now();\n", "async function start(m: StartMessage, note?: unknown): Promise<void> {\n  const t0 = performance.now();\n  "+L('mw.start')+"\n")
sub(p,"  if (restored && !stopped()) await postLoaded(loadPhases(t0, prepared, restored));\n", "  "+L('mw.booted')+"\n  if (restored && !stopped()) await postLoaded(loadPhases(t0, prepared, restored));\n  "+L('mw.answered')+"\n")
sub(p,"  const parts = await fetchParts(m, machine, snapshot, stopped);\n  if (stopped()) return undefined;\n  const wasm = await compileCore(parts.wasm);\n", "  const parts = await fetchParts(m, machine, snapshot, stopped);\n  "+L('mw.fetched')+"\n  if (stopped()) return undefined;\n  const wasm = await compileCore(parts.wasm);\n  "+L('mw.compiled')+"\n")
p='web/warm-workers.ts'
sub(p,"  if (which === 'vcpu') return new Worker(", "  if (which === 'vcpu') "+L('vcpu.new')+"\n  if (which === 'vcpu') return new Worker(")
p='web/vcpu-worker.ts'
sub(p,"/** Steps per `vm_run_cpu` call: it returns early on anything the worker handles. */\n", L('vcpu.eval')+"\n/** Steps per `vm_run_cpu` call: it returns early on anything the worker handles. */\n")
sub(p,"  for (let v; (v = Atomics.load(ready, 0)) < j.ncpus;) Atomics.wait(ready, 0, v, 1000);\n", "  "+L('vcpu.instantiated')+"\n  for (let v; (v = Atomics.load(ready, 0)) < j.ncpus;) Atomics.wait(ready, 0, v, 1000);\n  "+L('vcpu.go')+"\n")
for op in (reversed(OPS) if UNDO else OPS):
    _sub(*op)
