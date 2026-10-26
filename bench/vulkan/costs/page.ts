// VK2's costs (bench/vulkan/costs.ts): the driver's test program (vk/driver/wg_test.c) in the renderer module on this
// page's WebGPU device, its scene set up by wgt_run, then submits of one draw (`wgt_draw`): with its pipeline (a
// submit's cost) or with a pipeline made anew each time from a fragment shader specialized to a new value (a pipeline's
// cost: translated to WGSL, the shader module and render pipeline made, and the GPU's compile before its draw runs).
// For each: the ms in the call (the module records, translates, and replays the submit into WebGPU) and the ms until
// its fence signalled (the GPU's work, and for a new pipeline its compile, done and read back).
import { deviceRequest } from '../../../web/venus-gpu.ts';
import { VenusRenderer, type VenusPoll } from '../../../web/venus-host.ts';

type Test = {
  wgt_run(vs: number, vn: number, fs: number, fn: number, cs: number, cn: number): number;
  wgt_done(): number; wgt_error(): number; venus_alloc(n: number): number;
  wgt_draw(fs: number, fn: number, variant: number): number; wgt_draw_done(): number;
};

/** Yields to the event loop without setTimeout's clamp, so a fence is seen as soon as the worker's callbacks ran. */
const tick = () => new Promise<void>((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

export async function run(spirv: { vert: string; frag: string; comp: string; costs: string }, n: number, fixedSeed?: number, poll?: VenusPoll) {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return { skipped: 'no WebGPU adapter' };
  const device = await adapter.requestDevice(deviceRequest(adapter));
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  const memory = new WebAssembly.Memory({ initial: 65536, maximum: 65536, shared: true });
  const module = await WebAssembly.compileStreaming(fetch('/target/vk/venus.wasm'));
  const v = await VenusRenderer.create(module, memory, { at: 0x1000_0000, bytes: 1 << 20, watch: 0 }, device, device, poll);
  const ex = v.raw as unknown as Test;
  const words = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());
  const put = (b: Uint8Array) => { const p = ex.venus_alloc(b.length) >>> 0; new Uint8Array(memory.buffer, p, b.length).set(b); return [p, b.length / 4]; };
  const [vs, vn] = put(await words(spirv.vert)), [fs, fn] = put(await words(spirv.frag)), [cs, cn] = put(await words(spirv.comp));
  const [ks, kn] = put(await words(spirv.costs));
  const text = (p: number) => { const u8 = new Uint8Array(memory.buffer); let e = p; while (u8[e]) e++; return new TextDecoder().decode(u8.slice(p, e)); };
  if (ex.wgt_run(vs, vn, fs, fn, cs, cn)) return { error: text(ex.wgt_error() >>> 0) };
  const wait = async (done: () => number) => { const t = performance.now(); while (!done()) { if (performance.now() - t > 20_000) throw new Error('a fence never signalled'); await tick(); } };
  await wait(() => ex.wgt_done());
  // New to the GPU's compiler every run (Metal keeps compiled shaders across runs on disk: a repeated value is a cache hit).
  const seed = fixedSeed ?? 1 + Math.floor(Math.random() * 4_000_000);
  let variant = seed;
  const draw = async (fresh: boolean) => {
    const t0 = performance.now();
    if (ex.wgt_draw(ks, kn, fresh ? variant++ : 0)) throw new Error(text(ex.wgt_error() >>> 0));
    const call = performance.now() - t0;
    await wait(() => ex.wgt_draw_done());
    return { call, total: performance.now() - t0 };
  };
  // Warm: the first of each kind pays for what's made once (the draw shader's module, the command pool, Tint's first use).
  for (let i = 0; i < 3; i++) { await draw(true); await draw(false); }
  const submit: { call: number; total: number }[] = [], pipeline: { call: number; total: number }[] = [];
  // Alternated, so both see the same state of the GPU process.
  for (let i = 0; i < n; i++) { submit.push(await draw(false)); pipeline.push(await draw(true)); }
  // The browser's share: the same kind of pipeline (a textured quad into the same targets) written by hand in WGSL, its
  // constant varied likewise, made with createRenderPipelineAsync and drawn once: Tint's and the GPU driver's compile
  // and the draw, without the translation or its WGSL's style.
  const color = device.createTexture({ size: [64, 64], format: 'rgba8unorm', usage: 16 });
  const depth = device.createTexture({ size: [64, 64], format: 'depth32float', usage: 16 });
  const tex = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 4 });
  const ubuf = device.createBuffer({ size: 16, usage: 64 });
  const vbuf = device.createBuffer({ size: 4 * 20, usage: 32 });
  const smp = device.createSampler();
  const hand: number[] = [];
  for (let i = 0; i < 3 + n; i++) {
    const k = `(1.0 - ${seed + 5_000_000 + i}.0 * 1e-7)`;
    const t0 = performance.now();
    const module = device.createShaderModule({ code: `
struct U { tint: vec4f }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@location(0) p: vec3f, @location(1) uv: vec2f) -> V { return V(vec4f(p + vec3f(0.5, 0.0, 0.0), 1.0), uv); }
@fragment fn fs(i: V) -> @location(0) vec4f { return mix(textureSample(tex, smp, i.uv), vec4f(u.tint.rgb, 1.0), u.tint.a) * ${k}; }` });
    const pipeline = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 20, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x2' }] }] },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'cw' } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: tex.createView() }, { binding: 2, resource: smp }] });
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: color.createView(), loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthClearValue: 1, depthStoreOp: 'discard' } });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.setVertexBuffer(0, vbuf);
    pass.draw(4);
    pass.end();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    if (i >= 3) hand.push(performance.now() - t0);
  }
  const pl = v.gpu.stats;
  return { hand, adapter: `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}`.trim(), submit, pipeline, errors, stats: pl };
}
