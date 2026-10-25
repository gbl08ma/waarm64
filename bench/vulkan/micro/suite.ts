// VK0's WebGPU questions C, E and F (bench/vulkan/REPORT.md; docs/plans/graphics.md §5), a bench/run.ts suite run in a
// worker as the GPU worker would run the translator:
//   c_split        one render pass split into N with store and load (colour and depth; 4x MSAA's colour stored and
//                  reloaded too, resolved in the last pass), 200 draws spread over it, 1080p and 1440p
//   c_prepass      50 objects, each a compute dispatch writing its vertices (a geometry pattern) then its draw: the
//                  compute interleaved between draws (a pass break each) against hoisted before one render pass
//   c_transient    whether the browser has transient attachments (GPUTextureUsage.TRANSIENT_ATTACHMENT), and c_split's
//                  MSAA case with them
//   c_geometry     geometry and tessellation in compute (libpoly's way): 100,000 points expanded to quads, 1,000
//                  patches tessellated at 16x16, each written by a compute pass then drawn, against the same
//                  primitives drawn from static buffers
//   e_draws        10,000 draws a frame and what feeds each: one bind group, a cached group switched per draw, a group
//                  made per draw, a dynamic offset per draw, immediates per draw, a render bundle, and the draw loop
//                  driven from wasm through imports (a translator in wasm calling WebGPU)
//   f_upload       queue.writeBuffer from a SharedArrayBuffer and from an ArrayBuffer, 256 B to 8 MiB, and 1,000
//                  writes of 1 KiB against one of 1 MiB
// Samples are ms a frame (wall, frames back to back with two in flight), with "encode" the worker's ms to record and
// submit; per draw where it says so.
//   node bench/run.ts --page bench/vulkan/micro/index.html [--only e_draws] --chromium-args='<the VM's WebGPU switches>'
import type { Options, Sample } from '../../spike/benchmarks.ts';
import { GPUBufferUsage, GPUShaderStage, GPUTextureUsage } from '../webgpu/flags.ts';

const now = () => performance.now();

let shared: Promise<{ adapter: GPUAdapter; device: GPUDevice }> | undefined;
function gpu() {
  return shared ??= (async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    const limits = adapter.limits as unknown as Record<string, number>;
    const requiredLimits: Record<string, number> = { maxStorageBuffersInVertexStage: Math.min(4, limits.maxStorageBuffersInVertexStage ?? 0) };
    if ('maxImmediateSize' in limits) requiredLimits.maxImmediateSize = Math.min(64, limits.maxImmediateSize);
    for (const k of Object.keys(requiredLimits)) if (!(k in limits) || !requiredLimits[k]) delete requiredLimits[k];
    const device = await adapter.requestDevice({ requiredLimits });
    device.addEventListener('uncapturederror', (e) => console.error('webgpu:', (e as GPUUncapturedErrorEvent).error.message));
    return { adapter, device };
  })();
}

/** Frames back to back, two in flight: `samples` samples of `frames` frames, the wall ms and the encode ms a frame. */
async function run(device: GPUDevice, o: Options, frame: () => void, frames = 30): Promise<{ wall: number[]; encode: number[] }> {
  const samples = o.quick ? 3 : 10;
  const pending: Promise<void>[] = [];
  const settle = async (n: number) => { while (pending.length > n) await pending.shift(); };
  for (let i = 0; i < 10; i++) { frame(); pending.push(device.queue.onSubmittedWorkDone()); await settle(1); }
  await settle(0);
  const wall: number[] = [], encode: number[] = [];
  for (let s = 0; s < samples; s++) {
    let enc = 0;
    const t = now();
    for (let f = 0; f < frames; f++) {
      const a = now();
      frame();
      enc += now() - a;
      pending.push(device.queue.onSubmittedWorkDone());
      await settle(1);
    }
    await settle(0);
    wall.push((now() - t) / frames);
    encode.push(enc / frames);
  }
  return { wall, encode };
}

function out(name: string, params: Record<string, unknown>, r: { wall: number[]; encode: number[] }, per = 1): Sample[] {
  return [
    { name, unit: per === 1 ? 'ms' : 'us', params: { ...params, phase: 'frame' }, samples: r.wall.map((x) => (per === 1 ? x : (x * 1000) / per)) },
    { name, unit: per === 1 ? 'ms' : 'us', params: { ...params, phase: 'encode' }, samples: r.encode.map((x) => (per === 1 ? x : (x * 1000) / per)) },
  ];
}

// A quad's vertices from its instance: position and size in clip space, a colour; depth from the instance.
const QUADS = /* wgsl */ `
struct Q { pos: vec2f, size: f32, depth: f32, color: vec4f }
@group(0) @binding(0) var<storage, read> quads: array<Q>;
struct V { @builtin(position) p: vec4f, @location(0) c: vec4f }
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> V {
  let corner = array(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(1, 1))[vi];
  let q = quads[ii];
  return V(vec4f(q.pos + corner * q.size, q.depth, 1), q.color);
}
@fragment fn fs(v: V) -> @location(0) vec4f { return v.c; }
`;

function quadData(n: number, seed = 1) {
  const d = new Float32Array(n * 8);
  let s = seed;
  const r = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) d.set([r() * 2 - 1, r() * 2 - 1, 0.05 + r() * 0.3, r(), r(), r(), r(), 0.6], i * 8);
  return d;
}

async function cSplit(o: Options): Promise<Sample[]> {
  const { device: d } = await gpu();
  const res: Sample[] = [];
  const transient = (globalThis as unknown as { GPUTextureUsage?: Record<string, number> }).GPUTextureUsage?.TRANSIENT_ATTACHMENT;
  const sizes: [string, number, number][] = [['1080p', 1920, 1080], ['1440p', 2560, 1440]];
  const module = d.createShaderModule({ code: QUADS });
  const draws = 200;
  const buf = d.createBuffer({ size: draws * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  d.queue.writeBuffer(buf, 0, quadData(draws));
  for (const msaa of [1, 4]) {
    const pipe = d.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm', blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } }] },
      primitive: { topology: 'triangle-strip' }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' }, multisample: { count: msaa } });
    const group = d.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
    for (const [label, w, h] of sizes) {
      for (const useTransient of msaa === 4 && transient ? [false, true] : [false]) {
        const color = d.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT });
        // Transient: the multisampled colour and the depth never leave the tile (one pass, both discarded).
        const tu = useTransient ? transient! : 0;
        const ms = msaa === 4 ? d.createTexture({ size: [w, h], format: 'rgba8unorm', sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT | tu }) : null;
        const depth = d.createTexture({ size: [w, h], format: 'depth32float', sampleCount: msaa, usage: GPUTextureUsage.RENDER_ATTACHMENT | tu });
        for (const splits of useTransient ? [1] : [1, 2, 4, 8, 16, 32]) {
          const r = await run(d, o, () => {
            const enc = d.createCommandEncoder();
            for (let p = 0; p < splits; p++) {
              const first = p === 0, last = p === splits - 1;
              const pass = enc.beginRenderPass({
                colorAttachments: [{ view: (ms ?? color).createView(), resolveTarget: ms && last ? color.createView() : undefined, clearValue: [0, 0.3, 0.6, 1],
                  loadOp: first ? 'clear' : 'load', storeOp: last && ms ? 'discard' : 'store' }],
                depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: first ? 'clear' : 'load', depthStoreOp: last ? 'discard' : 'store' },
              });
              pass.setPipeline(pipe);
              pass.setBindGroup(0, group);
              const a = Math.floor((p * draws) / splits), b = Math.floor(((p + 1) * draws) / splits);
              for (let i = a; i < b; i++) pass.draw(4, 1, 0, i);
              pass.end();
            }
            d.queue.submit([enc.finish()]);
          });
          res.push(...out(useTransient ? 'c_transient' : 'c_split', { size: label, msaa, passes: splits, transient: useTransient }, r));
        }
        color.destroy(); ms?.destroy(); depth.destroy();
      }
    }
  }
  return res;
}

// A mesh of `verts` vertices bent by time in compute: the vertices a geometry or transform-feedback pre-pass writes.
const DEFORM = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> out: array<vec4f>;
@group(0) @binding(1) var<uniform> u: vec4f;   // object index, time, verts
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = u32(u.z);
  if (id.x >= n) { return; }
  let i = f32(id.x);
  let ring = floor(i / 64.0);
  let a = (i % 64.0) / 64.0 * 6.2831853;
  let r = 0.02 + 0.01 * sin(ring * 0.3 + u.y);
  let cx = (u.x % 10.0) / 5.0 - 0.9;
  let cy = floor(u.x / 10.0) / 2.5 - 0.9;
  out[id.x] = vec4f(cx + cos(a) * r + ring * 0.0004, cy + sin(a) * r, 0.5, 1);
}
`;
const DRAW_POINTS = /* wgsl */ `
@group(0) @binding(0) var<storage, read> pos: array<vec4f>;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f { return pos[vi]; }
@fragment fn fs() -> @location(0) vec4f { return vec4f(1, 0.5, 0.2, 1); }
`;

async function cPrepass(o: Options): Promise<Sample[]> {
  const { device: d } = await gpu();
  const res: Sample[] = [];
  const objects = 50, verts = 6000;
  const cm = d.createShaderModule({ code: DEFORM }), dm = d.createShaderModule({ code: DRAW_POINTS });
  const comp = d.createComputePipeline({ layout: 'auto', compute: { module: cm, entryPoint: 'main' } });
  for (const msaa of [1, 4]) {
    const draw = d.createRenderPipeline({ layout: 'auto', vertex: { module: dm, entryPoint: 'vs' }, fragment: { module: dm, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' }, multisample: { count: msaa } });
    const bufs = Array.from({ length: objects }, () => d.createBuffer({ size: verts * 16, usage: GPUBufferUsage.STORAGE }));
    const unis = Array.from({ length: objects }, (_, i) => { const b = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); d.queue.writeBuffer(b, 0, new Float32Array([i, 0, verts, 0])); return b; });
    const cg = bufs.map((b, i) => d.createBindGroup({ layout: comp.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: b } }, { binding: 1, resource: { buffer: unis[i] } }] }));
    const dg = bufs.map((b) => d.createBindGroup({ layout: draw.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: b } }] }));
    const color = d.createTexture({ size: [1920, 1080], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const ms = msaa === 4 ? d.createTexture({ size: [1920, 1080], format: 'rgba8unorm', sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT }) : null;
    const depth = d.createTexture({ size: [1920, 1080], format: 'depth32float', sampleCount: msaa, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const passDesc = (first: boolean, last: boolean): GPURenderPassDescriptor => ({
      colorAttachments: [{ view: (ms ?? color).createView(), resolveTarget: ms && last ? color.createView() : undefined, clearValue: [0, 0, 0, 1], loadOp: first ? 'clear' : 'load', storeOp: last && ms ? 'discard' : 'store' }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: first ? 'clear' : 'load', depthStoreOp: last ? 'discard' : 'store' } });
    // Breaks: how many objects share a compute pass and a render pass (1: every object breaks the pass).
    for (const group of [1, 5, 10, 50, 0]) {
      const r = await run(d, o, () => {
        const enc = d.createCommandEncoder();
        if (group === 0) {
          // No pre-pass at all: the cost of the draws alone.
          const pass = enc.beginRenderPass(passDesc(true, true));
          pass.setPipeline(draw);
          for (let i = 0; i < objects; i++) { pass.setBindGroup(0, dg[i]); pass.draw(verts); }
          pass.end();
        } else {
          for (let g0 = 0; g0 < objects; g0 += group) {
            const cp = enc.beginComputePass();
            cp.setPipeline(comp);
            for (let i = g0; i < g0 + group; i++) { cp.setBindGroup(0, cg[i]); cp.dispatchWorkgroups(Math.ceil(verts / 64)); }
            cp.end();
            const pass = enc.beginRenderPass(passDesc(g0 === 0, g0 + group >= objects));
            pass.setPipeline(draw);
            for (let i = g0; i < g0 + group; i++) { pass.setBindGroup(0, dg[i]); pass.draw(verts); }
            pass.end();
          }
        }
        d.queue.submit([enc.finish()]);
      });
      res.push(...out('c_prepass', { msaa, objects, objectsPerPass: group || 'none', renderPasses: group ? objects / group : 1, prepass: group ? (group === objects ? 'hoisted' : 'interleaved') : 'none' }, r));
    }
    color.destroy(); ms?.destroy(); depth.destroy();
    for (const b of [...bufs, ...unis]) b.destroy();
  }
  return res;
}

const EXPAND = /* wgsl */ `
struct P { pos: vec2f, size: f32, pad: f32 }
@group(0) @binding(0) var<storage, read> points: array<P>;
@group(0) @binding(1) var<storage, read_write> verts: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> idx: array<u32>;
@group(0) @binding(3) var<uniform> u: vec4f;
@compute @workgroup_size(64) fn points_to_quads(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&points)) { return; }
  let p = points[id.x];
  let s = p.size * (1.0 + 0.1 * sin(u.x));
  for (var c = 0u; c < 4u; c++) {
    let corner = vec2f(f32(c & 1u) * 2.0 - 1.0, f32(c >> 1u) * 2.0 - 1.0);
    verts[id.x * 4u + c] = vec4f(p.pos + corner * s, 0.5, 1);
  }
  let b = id.x * 4u;
  idx[id.x * 6u] = b; idx[id.x * 6u + 1u] = b + 1u; idx[id.x * 6u + 2u] = b + 2u;
  idx[id.x * 6u + 3u] = b + 2u; idx[id.x * 6u + 4u] = b + 1u; idx[id.x * 6u + 5u] = b + 3u;
}
// A bicubic-ish patch evaluated at 17x17 points (16x16 quads): a tessellation evaluation stage in compute.
@compute @workgroup_size(64) fn tessellate(@builtin(global_invocation_id) id: vec3u) {
  let per = 17u * 17u;
  let pi = id.x / per;
  if (pi >= arrayLength(&points)) { return; }
  let k = id.x % per;
  let uv = vec2f(f32(k % 17u), f32(k / 17u)) / 16.0;
  let p = points[pi];
  let h = sin(uv.x * 3.14159) * sin(uv.y * 3.14159) * 0.02 * sin(u.x + f32(pi));
  verts[id.x] = vec4f(p.pos + (uv * 2.0 - 1.0) * p.size + vec2f(h, h), 0.5, 1);
}
`;
const DRAW_VERTS = /* wgsl */ `
@group(0) @binding(0) var<storage, read> v: array<vec4f>;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f { return v[vi]; }
@fragment fn fs() -> @location(0) vec4f { return vec4f(0.3, 0.8, 0.4, 1); }
`;

async function cGeometry(o: Options): Promise<Sample[]> {
  const { device: d } = await gpu();
  const res: Sample[] = [];
  const em = d.createShaderModule({ code: EXPAND }), vm = d.createShaderModule({ code: DRAW_VERTS });
  const draw = d.createRenderPipeline({ layout: 'auto', vertex: { module: vm, entryPoint: 'vs' }, fragment: { module: vm, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' } });
  const color = d.createTexture({ size: [1920, 1080], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const cases: { name: string; entry: string; n: number; vertsPer: number; indices: (n: number) => Uint32Array; spec: (i: number) => [number, number, number] }[] = [
    { name: 'points_to_quads', entry: 'points_to_quads', n: 100000, vertsPer: 4, indices: (n) => { const x = new Uint32Array(n * 6); for (let i = 0; i < n; i++) x.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6); return x; }, spec: () => [Math.random() * 2 - 1, Math.random() * 2 - 1, 0.002] },
    { name: 'tessellation_16', entry: 'tessellate', n: 1000, vertsPer: 289, indices: (n) => { const x: number[] = []; for (let p = 0; p < n; p++) for (let y = 0; y < 16; y++) for (let xx = 0; xx < 16; xx++) { const b = p * 289 + y * 17 + xx; x.push(b, b + 1, b + 17, b + 17, b + 1, b + 18); } return Uint32Array.from(x); }, spec: () => [Math.random() * 2 - 1, Math.random() * 2 - 1, 0.02] },
  ];
  for (const c of cases) {
    const comp = d.createComputePipeline({ layout: 'auto', compute: { module: em, entryPoint: c.entry } });
    const pts = new Float32Array(c.n * 4);
    for (let i = 0; i < c.n; i++) pts.set([...c.spec(i), 0], i * 4);
    const pointBuf = d.createBuffer({ size: pts.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(pointBuf, 0, pts);
    const nv = c.n * c.vertsPer;
    const vbuf = d.createBuffer({ size: nv * 16, usage: GPUBufferUsage.STORAGE });
    const idx = c.indices(c.n);
    const ibuf = d.createBuffer({ size: Math.max(idx.byteLength, c.n * 24), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(ibuf, 0, idx);
    const ubuf = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: pointBuf } }, { binding: 1, resource: { buffer: vbuf } }, { binding: 3, resource: { buffer: ubuf } }];
    if (c.entry === 'points_to_quads') entries.push({ binding: 2, resource: { buffer: ibuf } });
    const cg = d.createBindGroup({ layout: comp.getBindGroupLayout(0), entries });
    const dg = d.createBindGroup({ layout: draw.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: vbuf } }] });
    let t = 0;
    for (const mode of ['prepass', 'static']) {
      const r = await run(d, o, () => {
        d.queue.writeBuffer(ubuf, 0, new Float32Array([(t += 0.016), 0, 0, 0]));
        const enc = d.createCommandEncoder();
        if (mode === 'prepass') {
          const cp = enc.beginComputePass();
          cp.setPipeline(comp);
          cp.setBindGroup(0, cg);
          cp.dispatchWorkgroups(Math.ceil((c.entry === 'tessellate' ? nv : c.n) / 64));
          cp.end();
        }
        const pass = enc.beginRenderPass({ colorAttachments: [{ view: color.createView(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }] });
        pass.setPipeline(draw);
        pass.setBindGroup(0, dg);
        pass.setIndexBuffer(ibuf, 'uint32');
        pass.drawIndexed(idx.length);
        pass.end();
        d.queue.submit([enc.finish()]);
      });
      res.push(...out('c_geometry', { case: c.name, primitives: c.n, mode }, r));
    }
    for (const b of [pointBuf, vbuf, ibuf, ubuf]) b.destroy();
  }
  color.destroy();
  return res;
}

const TRI = /* wgsl */ `
struct U { offset: vec4f }
@group(0) @binding(0) var<uniform> u: U;
struct V { @builtin(position) p: vec4f, @location(0) c: vec4f }
@vertex fn vs(@builtin(vertex_index) vi: u32) -> V {
  let p = array(vec2f(0, 0.01), vec2f(-0.01, -0.01), vec2f(0.01, -0.01))[vi];
  return V(vec4f(p + u.offset.xy, 0.5, 1), vec4f(u.offset.zw, 1, 1));
}
@fragment fn fs(v: V) -> @location(0) vec4f { return v.c; }
`;
const TRI_IMM = /* wgsl */ `
requires immediate_address_space;
struct U { offset: vec4f }
var<immediate> u: U;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = array(vec2f(0, 0.01), vec2f(-0.01, -0.01), vec2f(0.01, -0.01))[vi];
  return vec4f(p + u.offset.xy, 0.5, 1);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(1); }
`;

/** A wasm module whose `loop(n)` calls the imported `draw(i)` n times: a translator in wasm driving WebGPU through
 * JS glue, one call per command (hand-assembled: type (i32)->(), import env.draw, func loop(i32) with a loop). */
function wasmLoop(draw: (i: number) => void): (n: number) => void {
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x01, 0x7f, 0x00,                                      // type 0: (i32) -> ()
    0x02, 0x0c, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x04, 0x64, 0x72, 0x61, 0x77, 0x00, 0x00, // import env.draw: type 0
    0x03, 0x02, 0x01, 0x00,                                                         // func 1: type 0
    0x07, 0x08, 0x01, 0x04, 0x6c, 0x6f, 0x6f, 0x70, 0x00, 0x01,                     // export "loop" = func 1
    0x0a, 0x20, 0x01, 0x1e, 0x01, 0x01, 0x7f,                                       // code: 1 body of 30 bytes, 1 local i32
    0x02, 0x40, 0x03, 0x40,                                                         // block, loop
    0x20, 0x01, 0x20, 0x00, 0x4e, 0x0d, 0x01,                                       // local1 >= local0 -> br 1
    0x20, 0x01, 0x10, 0x00,                                                         // call draw(local1)
    0x20, 0x01, 0x41, 0x01, 0x6a, 0x21, 0x01,                                       // local1 += 1
    0x0c, 0x00, 0x0b, 0x0b, 0x0b,                                                   // br 0; end loop; end block; end
  ]);
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { draw } });
  return inst.exports.loop as (n: number) => void;
}

async function eDraws(o: Options): Promise<Sample[]> {
  const { device: d } = await gpu();
  const res: Sample[] = [];
  const n = 10000;
  const module = d.createShaderModule({ code: TRI });
  const layout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }] });
  const dynLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform', hasDynamicOffset: true } }] });
  const pipe = (l: GPUBindGroupLayout) => d.createRenderPipeline({ layout: d.createPipelineLayout({ bindGroupLayouts: [l] }), vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] } });
  const plain = pipe(layout), dyn = pipe(dynLayout);
  const ubuf = d.createBuffer({ size: n * 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const data = new Float32Array(n * 64);
  for (let i = 0; i < n; i++) data.set([(i % 100) / 50 - 0.99, Math.floor(i / 100) / 50 - 0.99, (i % 7) / 7, (i % 5) / 5], i * 64);
  d.queue.writeBuffer(ubuf, 0, data);
  const groups = Array.from({ length: 16 }, (_, i) => d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: ubuf, offset: i * 256, size: 16 } }] }));
  const dynGroup = d.createBindGroup({ layout: dynLayout, entries: [{ binding: 0, resource: { buffer: ubuf, size: 16 } }] });
  const color = d.createTexture({ size: [1920, 1080], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  const view = color.createView();
  const begin = (enc: GPUCommandEncoder) => enc.beginRenderPass({ colorAttachments: [{ view, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }] });
  const hasImm = typeof (GPURenderPassEncoder.prototype as unknown as { setImmediates?: unknown }).setImmediates === 'function' &&
    (d.limits as unknown as Record<string, number>).maxImmediateSize >= 16;
  const imm = hasImm ? (() => {
    const m = d.createShaderModule({ code: TRI_IMM });
    return d.createRenderPipeline({ layout: d.createPipelineLayout({ bindGroupLayouts: [], immediateSize: 16 } as GPUPipelineLayoutDescriptor), vertex: { module: m, entryPoint: 'vs' },
      fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] } });
  })() : null;
  const bundleEnc = d.createRenderBundleEncoder({ colorFormats: ['rgba8unorm'] });
  bundleEnc.setPipeline(dyn);
  for (let i = 0; i < n; i++) { bundleEnc.setBindGroup(0, dynGroup, [i * 256]); bundleEnc.draw(3); }
  const bundle = bundleEnc.finish();
  let pass: GPURenderPassEncoder;
  const wasmDraw = wasmLoop((i) => { pass.setBindGroup(0, dynGroup, [i * 256]); pass.draw(3); });
  const variants: Record<string, (p: GPURenderPassEncoder) => void> = {
    same_group: (p) => { p.setPipeline(plain); p.setBindGroup(0, groups[0]); for (let i = 0; i < n; i++) p.draw(3); },
    switch_cached_group: (p) => { p.setPipeline(plain); for (let i = 0; i < n; i++) { p.setBindGroup(0, groups[i & 15]); p.draw(3); } },
    create_group_per_draw: (p) => { p.setPipeline(plain); for (let i = 0; i < n; i++) { p.setBindGroup(0, d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: ubuf, offset: (i & 1023) * 256, size: 16 } }] })); p.draw(3); } },
    dynamic_offset: (p) => { p.setPipeline(dyn); for (let i = 0; i < n; i++) { p.setBindGroup(0, dynGroup, [i * 256]); p.draw(3); } },
    render_bundle: (p) => { p.executeBundles([bundle]); },
    wasm_driven_dynamic: (p) => { p.setPipeline(dyn); pass = p; wasmDraw(n); },
  };
  if (imm) {
    const v = new Float32Array(4);
    variants.immediates = (p) => {
      p.setPipeline(imm);
      const pi = p as unknown as { setImmediates(o: number, d: Float32Array): void };
      for (let i = 0; i < n; i++) { v[0] = (i % 100) / 50 - 0.99; v[1] = Math.floor(i / 100) / 50 - 0.99; pi.setImmediates(0, v); p.draw(3); }
    };
  }
  for (const [name, fill] of Object.entries(variants)) {
    const r = await run(d, o, () => {
      const enc = d.createCommandEncoder();
      const p = begin(enc);
      fill(p);
      p.end();
      d.queue.submit([enc.finish()]);
    }, 10);
    res.push(...out('e_draws', { variant: name, draws: n }, r, n));
  }
  color.destroy(); ubuf.destroy();
  return res;
}

async function fUpload(o: Options): Promise<Sample[]> {
  const { device: d } = await gpu();
  const res: Sample[] = [];
  const max = 8 << 20;
  const buf = d.createBuffer({ size: max, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM });
  const sab = new Uint8Array(new SharedArrayBuffer(max)), plain = new Uint8Array(max);
  for (let i = 0; i < max; i += 4096) { sab[i] = i; plain[i] = i; }
  for (const size of [256, 4096, 65536, 1 << 20, 8 << 20]) {
    for (const [src, data] of [['shared', sab], ['plain', plain]] as const) {
      const r = await run(d, o, () => { d.queue.writeBuffer(buf, 0, data, 0, size); d.queue.submit([]); });
      res.push(...out('f_upload', { bytes: size, source: src }, r));
    }
  }
  // Many small ranges against one: what uploading only the written pages costs against uploading the whole range.
  for (const [ranges, each] of [[1000, 1024], [1, 1 << 20], [256, 4096], [1, 1 << 20]] as const) {
    const r = await run(d, o, () => {
      for (let i = 0; i < ranges; i++) d.queue.writeBuffer(buf, i * each, sab, i * each, each);
      d.queue.submit([]);
    });
    res.push(...out('f_upload_ranges', { ranges, bytesEach: each, total: ranges * each }, r));
  }
  buf.destroy();
  return res;
}

async function adapter(_o: Options): Promise<Sample[]> {
  const { adapter: a, device: d } = await gpu();
  const t = (globalThis as unknown as { GPUTextureUsage?: Record<string, number> }).GPUTextureUsage ?? {};
  return [{ name: 'adapter', unit: 'n', params: { vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description,
    features: [...a.features].sort(), transientAttachments: 'TRANSIENT_ATTACHMENT' in t,
    immediates: typeof (GPURenderPassEncoder.prototype as unknown as { setImmediates?: unknown }).setImmediates === 'function',
    maxImmediateSize: (d.limits as unknown as Record<string, number>).maxImmediateSize }, samples: [1] }];
}

export const suite = { adapter, c_split: cSplit, c_prepass: cPrepass, c_geometry: cGeometry, e_draws: eDraws, f_upload: fUpload };

export async function runAll(o: Options): Promise<Sample[]> {
  const res: Sample[] = [];
  for (const [name, fn] of Object.entries(suite)) {
    o.log?.(name);
    try { res.push(...(await fn(o))); } catch (e) { res.push({ name, unit: 'ms', params: { error: String(e) }, samples: [0] }); }
  }
  return res;
}
