# Applies SNAPZ loop 7's timing marks (temporary) to the tree: python3 marks.py
import os
UNDO=os.environ.get('UNDO')
OPS=[]
def sub(path, old, new): OPS.append(('s', path, old, new))
def pre(path, text): OPS.append(('p', path, text))
def _sub(path, old, new):
    if UNDO: old, new = new, old
    s=open(path).read(); assert old in s, (path, old); s=s.replace(old,new,1); open(path,'w').write(s)
def _pre(path, text):
    s=open(path).read()
    if UNDO: assert s.startswith(text); open(path,'w').write(s[len(text):])
    else: open(path,'w').write(text+s)
M="((globalThis as any).__lm ??= []).push(['%s', performance.timeOrigin + performance.now()]);"
p='web/app/worker.ts'
sub(p,"  const parts = await fetchParts(m, machine, snapshot, stopped);\n", "  "+M%'prepare0'+"\n  const parts = await fetchParts(m, machine, snapshot, stopped);\n  "+M%'fetched'+"\n")
sub(p,"  core = wasm;\n", "  core = wasm;\n  "+M%'compiled'+"\n")
sub(p,"  const r = await openRestore(snapshot, m, machine, resume, await codec(), () => (warm ??= warmFor(m)));\n", "  const lzc = await codec();\n  "+M%'codec'+"\n  const r = await openRestore(snapshot, m, machine, resume, lzc, () => (warm ??= warmFor(m)));\n  "+M%'restoreOpened'+"\n")
sub(p,"    booting = bootVm(", "    "+M%'bootVm0'+"\n    booting = bootVm(")
sub(p,"  const { devices, v } = made;\n  await booted(", "  const { devices, v } = made;\n  "+M%'bootVm1'+"\n  await booted(")
sub(p,"  if (restored) post({ type: 'loaded', phases: loadPhases(t0, prepared, restored) });", "  "+M%'booted'+"\n  if (restored) post({ type: 'loaded', phases: { ...loadPhases(t0, prepared, restored), marks: (globalThis as any).__lm } as any });")
sub(p,"  const t0 = performance.now();\n  const machine: Machine", "  const t0 = performance.now();\n  "+M%'start'+"\n  const machine: Machine")
p='web/app/worker-fetch.ts'
sub(p,"  const responses = await Promise.all(urls.map((url) => get(url, machine)));\n", "  const responses = await Promise.all(urls.map((url) => get(url, machine)));\n  "+M%'responses'+"\n")
p='web/app/worker-start.ts'
sub(p,"  await disks;\n  return { wasm", "  "+M%'bodies'+"\n  await disks;\n  "+M%'disksHead'+"\n  return { wasm")
sub(p,"  const header = await readHeader(snapshot);\n", "  const header = await readHeader(snapshot);\n  "+M%'header'+"\n")
sub(p,"    pool: await pool,\n  });", "    pool: await pool,\n  });\n  "+M%'readSnapshot')
p='web/vm.ts'
sub(p,"  let instance = await WebAssembly.instantiate(first, imports);\n", "  "+M%'vm.instantiate0'+"\n  let instance = await WebAssembly.instantiate(first, imports);\n  "+M%'vm.instantiated'+"\n")
sub(p,"    await o.restore.fill(new Uint8Array(memory.buffer, ram, o.ramSize), spillRam());\n", "    "+M%'vm.fill0'+"\n    await o.restore.fill(new Uint8Array(memory.buffer, ram, o.ramSize), spillRam());\n    "+M%'vm.filled'+"\n")
sub(p,"  const devices = await deviceHost(", "  "+M%'vm.deviceHost0'+"\n  const devices = await deviceHost(")
sub(p,"  if (o.restore) await devices.quiesce();\n", "  "+M%'vm.deviceHost1'+"\n  if (o.restore) await devices.quiesce();\n  "+M%'vm.quiesced'+"\n")
sub(p,"      if (e.data.type === 'ready') resolve();", "      if (e.data.type === 'ready') { ((globalThis as any).__lm ??= []).push(...((e.data as any).t ?? [])); resolve(); }")
sub(p,"    const made = Array.from({ length: c.ncpus }, async (_, cpu) => {", "    console.error(`[lm] vm.vcpuSpawn ${performance.timeOrigin + performance.now()}`);\n    const made = Array.from({ length: c.ncpus }, async (_, cpu) => {")
p='web/device-worker.ts'
pre(p,"(self as any).__dwLoaded = performance.timeOrigin + performance.now();\n")
sub(p,"async function start(init: Init) {\n  devices = await Devices.open(", "async function start(init: Init) {\n  const __t0 = performance.timeOrigin + performance.now();\n  devices = await Devices.open(")
sub(p,"  self.postMessage({ type: 'ready' } satisfies FromDeviceWorker);", "  self.postMessage({ type: 'ready', t: [['dw.loaded', (self as any).__dwLoaded], ['dw.open0', __t0], ['dw.opened', performance.timeOrigin + performance.now()]] } as any);")
p='web/gpu-worker.ts'
sub(p,"    const dt = performance.now() - t0;\n    busyMs += dt;", "    const dt = performance.now() - t0;\n    if (c.t === 'load') { console.error(`[lm] gpu.load ${performance.timeOrigin + t0} ${dt.toFixed(1)}`); (globalThis as any).__lmFirst = true; }\n    busyMs += dt;")
p='web/virgl-screen.ts'
sub(p,"    this.presentAt?.push(performance.timeOrigin + this.lastDraw);\n", "    this.presentAt?.push(performance.timeOrigin + this.lastDraw);\n    if ((globalThis as any).__lmFirst) { (globalThis as any).__lmFirst = false; console.error(`[lm] gpu.firstPresent ${performance.timeOrigin + this.lastDraw}`); }\n")
p='web/vcpu-worker.ts'
pre(p,"const __vl = performance.timeOrigin + performance.now();\n")
sub(p,"  for (let v; (v = Atomics.load(ready, 0)) < j.ncpus;) Atomics.wait(ready, 0, v, 1000);\n", "  const __ti = performance.timeOrigin + performance.now();\n  for (let v; (v = Atomics.load(ready, 0)) < j.ncpus;) Atomics.wait(ready, 0, v, 1000);\n  console.error(`[lm] vcpu${j.cpu} loaded ${__vl} job ${(globalThis as any).__vj} instantiated ${__ti} go ${performance.timeOrigin + performance.now()}`);\n")
sub(p,"    job = m;\n", "    job = m;\n    (globalThis as any).__vj = performance.timeOrigin + performance.now();\n")
p='web/app/run/runner.ts'
sub(p,"    const { machine: m, screen, net, audio } = this.d;\n    const size = m.hasGpu", "    console.error(`[lm] page.start ${performance.timeOrigin + performance.now()}`);\n    const { machine: m, screen, net, audio } = this.d;\n    const size = m.hasGpu")
sub(p,"    r.worker.postMessage(\n      ...startMessage(", "    console.error(`[lm] page.postStart ${performance.timeOrigin + performance.now()}`);\n    r.worker.postMessage(\n      ...startMessage(")

for op in (reversed(OPS) if UNDO else OPS):
    (_sub if op[0]=='s' else _pre)(*op[1:])
