# PERF loop 85's timing marks (temporary; applies to bc6852bf): python3 diag.py, UNDO=1 takes them out.
# `[d85]` lines on the console (the probe prints the page's console errors): the page's start to its start message
# (the GPU worker's start, the lock, the disks' opening, the folders and layout), the device worker's sync HEADs, and
# the 3D read-back of a snapshot's save split into readPixels and the packing copy, by whether the level is one a
# straight read could take (`direct`: a packed box of a format whose packer is a plain copy).
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
sub(p,"    const ready = (caps: Uint8Array) =>\n      void this.#begin(", "    const ready = (caps: Uint8Array) =>\n      void ("+L('page.gpuReady').rstrip(';')+", this.#begin(")
sub(p,"three: { renderer: channel.port2, caps } });\n", "three: { renderer: channel.port2, caps } }));\n")
sub(p,"    if (!(await this.own(() => r.live()))) return;\n    const opened", "    "+L('page.begin')+"\n    if (!(await this.own(() => r.live()))) return;\n    "+L('page.owned')+"\n    const opened")
sub(p,"    if (!opened) return;\n    const ready = await this.#prepare(r, ch);\n", "    if (!opened) return;\n    "+L('page.opened')+"\n    const ready = await this.#prepare(r, ch);\n    "+L('page.prepared')+"\n")
sub(p,"    r.worker.postMessage(\n      ...startMessage(", "    "+L('page.postStart')+"\n    r.worker.postMessage(\n      ...startMessage(")
p='web/gpu-worker.ts'
sub(p,"  if (e.data?.type !== 'init') return;\n", "  if (e.data?.type !== 'init') return;\n  "+L('gpu.init')+"\n")
sub(p,"  post({ type: 'ready', caps, renderer: info.renderer });", "  "+L('gpu.ready')+"\n  post({ type: 'ready', caps, renderer: info.renderer });")
sub(p,"          a = saveRenderer(renderer);\n", "          const __t = performance.now();\n          (globalThis as any).__d85 = { rp: 0, pack: 0, direct: 0, other: 0, n: 0, by: {} };\n          a = saveRenderer(renderer);\n          { const d = (globalThis as any).__d85; console.error(`[d85] gpu.save ms ${(performance.now() - __t).toFixed(1)} readPixels ${d.rp.toFixed(1)} pack ${d.pack.toFixed(1)} directBytes ${d.direct} otherBytes ${d.other} levels ${d.n}`); for (const [k, e] of Object.entries(d.by) as any) console.error(`[d85] fmt ${k} n ${e.n} rp ${e.rp.toFixed(1)} pack ${e.pack.toFixed(1)} bytes ${e.bytes}`); }\n")
p='web/virgl-renderer.ts'
sub(p,"      gl.readPixels(box.x, box.y, box.w, box.h, reader.format, reader.type, view);\n      for (let y = 0; y < box.h; y++)\n        reader.pack(\n          tmp.subarray(y * box.w * reader.bytes, (y + 1) * box.w * reader.bytes),\n          out.subarray(z * layerStride + y * stride, z * layerStride + y * stride + rowBytes),\n          box.w,\n        );\n",
"      const __d = (globalThis as any).__d85, __t0 = performance.now();\n      gl.readPixels(box.x, box.y, box.w, box.h, reader.format, reader.type, view);\n      const __t1 = performance.now();\n      for (let y = 0; y < box.h; y++)\n        reader.pack(\n          tmp.subarray(y * box.w * reader.bytes, (y + 1) * box.w * reader.bytes),\n          out.subarray(z * layerStride + y * stride, z * layerStride + y * stride + rowBytes),\n          box.w,\n        );\n      if (__d) { const __t2 = performance.now(); __d.rp += __t1 - __t0; __d.pack += __t2 - __t1; __d.n++; if (reader.bytes === f.bpp && stride === rowBytes && /d\\.set\\(s\\.subarray\\(0, w \\* [48]\\)\\)/.test(String(reader.pack)) && !String(reader.pack).includes('comps')) __d.direct += tmp.length; else __d.other += tmp.length; const k = `${f.name} ${box.w}x${box.h}`; const e = (__d.by[k] ??= { n: 0, rp: 0, pack: 0, bytes: 0 }); e.n++; e.rp += __t1 - __t0; e.pack += __t2 - __t1; e.bytes += rowBytes * box.h; }\n")
p='web/disk-sources.ts'
sub(p,"  const head = syncXhr('HEAD', url);\n", "  const __h = performance.now();\n  const head = syncXhr('HEAD', url);\n  console.error(`[d85] dw.head ${(performance.now() - __h).toFixed(1)} ms ${url}`);\n")
p='web/app/worker-fetch.ts'
sub(p,"    urls.map((url) =>\n      fetch(url, { method: 'HEAD' }).then((r) => {\n", "    urls.map((url) =>\n      fetch(url, { method: 'HEAD' }).then((r, __h = (globalThis as any).__h0) => {\n        console.error(`[d85] mw.head ${(performance.now() - __h).toFixed(1)} ms ${url}`);\n")
sub(p,"export const checkDisks = (urls: string[], machine: Machine) =>\n  Promise.all(", "export const checkDisks = (urls: string[], machine: Machine) =>\n  void ((globalThis as any).__h0 = performance.now()) || Promise.all(")
p='web/chunked.ts'
sub(p,"  const mx = get(url);\n", "  const __m = performance.now();\n  const mx = get(url);\n  console.error(`[d85] dw.manifest ${(performance.now() - __m).toFixed(1)} ms ${url}`);\n")
p='web/app/demo-open.ts'
sub(p,"      await fetchText(d.url, { demo: true, gone: gone(d.url) });\n", "      const __g = performance.now();\n      await fetchText(d.url, { demo: true, gone: gone(d.url) });\n      console.error(`[d85] page.manifest ${(performance.now() - __g).toFixed(1)} ms ${d.url}`);\n")
for op in (reversed(OPS) if UNDO else OPS):
    _sub(*op)
