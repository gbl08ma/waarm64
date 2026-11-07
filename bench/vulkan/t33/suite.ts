// VK4 T33's cost of a draw whose vertex stage writes storage (bench/vulkan/REPORT.md "VK4 T33"): the driver's
// `vs_prepass` (vk/driver/wg_cmd.c) ends the WebGPU render pass before such a draw, runs the vertex stage as compute for
// the draw's vertices writing their outputs (web/venus-gpu.ts `vsPrepass`), begins the pass again loading it and draws
// those outputs through a pass-through vertex stage reading them as a vertex buffer (`vsDraw`). This times that work in
// plain WebGPU against the same draws with an ordinary vertex stage (which can't store: the work a store adds is the
// pre-pass's to carry, the atomic each vertex does being the compute's only extra): `vertices` a draw (a triangle list
// covering the target), `draws` of them on an rgba8unorm target, ms a draw (wall, back to back), median of 10 samples.
//   node bench/run.ts --page bench/vulkan/t33/index.html --chromium-args='<the VM's WebGPU switches>' --out bench/results/local/t33/cost.json
import type { Options, Sample } from '../../spike/benchmarks.ts';

const SIZES: [number, number][] = [[256, 256], [1920, 1080]];
const VERTICES = [3, 3000];
// Vertex k's position: triangles over the target, each covering it (the shape matters less than the count).
const POS = 'fn pos(k: u32) -> vec4<f32> { let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)); return vec4<f32>(p[k % 3u], f32(k) * 1e-6, 1.0); }';
const FS = '@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(0.1, 0.2, 0.3, 1.0); }';
const PLAIN = `${POS} @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> { return pos(i); } ${FS}`;
// As the worker's pre-pass: an invocation a vertex writing its record (4 words: the position), and the stage's store.
const PRE = `${POS} @group(0) @binding(0) var<storage, read_write> r: array<u32>; @group(0) @binding(1) var<storage, read_write> c: atomic<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3<u32>, @builtin(num_workgroups) n: vec3<u32>) {
  let t = g.x + g.y * n.x * 64u; if (t >= arrayLength(&r) / 4u) { return; }
  atomicAdd(&c, 1u); let x = bitcast<vec4<u32>>(pos(t)); r[4u * t] = x.x; r[4u * t + 1u] = x.y; r[4u * t + 2u] = x.z; r[4u * t + 3u] = x.w; }`;
const THROUGH = `@vertex fn vs(@location(0) w: vec4<u32>) -> @builtin(position) vec4<f32> { return bitcast<vec4<f32>>(w); } ${FS}`;

async function stores(o: Options): Promise<Sample[]> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('no WebGPU adapter');
  const device = await adapter.requestDevice();
  const out: Sample[] = [];
  const samples = o.quick ? 3 : 10, draws = 100;
  const format: GPUTextureFormat = 'rgba8unorm';
  const render = (code: string, buffers: GPUVertexBufferLayout[]) => device.createRenderPipeline({
    layout: 'auto', vertex: { module: device.createShaderModule({ code }), entryPoint: 'vs', buffers },
    fragment: { module: device.createShaderModule({ code }), entryPoint: 'fs', targets: [{ format }] } });
  const plain = render(PLAIN, []);
  const through = render(THROUGH, [{ arrayStride: 16, attributes: [{ format: 'uint32x4', offset: 0, shaderLocation: 0 }] }]);
  const pre = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: PRE }), entryPoint: 'main' } });
  const counter = device.createBuffer({ size: 4, usage: 128 /* STORAGE */ });
  for (const [w, h] of SIZES) {
    const target = device.createTexture({ size: [w, h], format, usage: 16 | 1 /* RENDER_ATTACHMENT | COPY_SRC */ });
    const att = (load: GPULoadOp): GPURenderPassDescriptor => ({ colorAttachments: [{ view: target.createView(), loadOp: load, storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    for (const vertices of VERTICES) {
      for (const arm of ['plain', 'prepass'] as const) {
        const frame = () => {
          const e = device.createCommandEncoder();
          const temps: GPUBuffer[] = [];
          let pass = e.beginRenderPass(att('clear'));
          for (let k = 0; k < draws; k++) {
            if (arm === 'prepass') {
              // A buffer of records a draw, as the worker makes one (STORAGE | VERTEX | INDEX).
              const rec = device.createBuffer({ size: vertices * 16, usage: 128 | 32 | 16 });
              temps.push(rec);
              pass.end();
              const c = e.beginComputePass();
              c.setPipeline(pre);
              c.setBindGroup(0, device.createBindGroup({ layout: pre.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: rec } }, { binding: 1, resource: { buffer: counter } }] }));
              c.dispatchWorkgroups(Math.ceil(vertices / 64));
              c.end();
              pass = e.beginRenderPass(att('load'));
              pass.setPipeline(through);
              pass.setVertexBuffer(0, rec);
            } else if (k === 0) {
              pass.setPipeline(plain);
            }
            pass.draw(vertices);
          }
          pass.end();
          device.queue.submit([e.finish()]);
          for (const t of temps) t.destroy();
          return device.queue.onSubmittedWorkDone();
        };
        const ms: number[] = [];
        for (let s = -1; s < samples; s++) {
          const t = performance.now();
          await frame();
          if (s >= 0) ms.push((performance.now() - t) / draws);
        }
        out.push({ name: 'stores', unit: 'ms', params: { arm, size: `${w}x${h}`, vertices, draws }, samples: ms });
        o.log?.(`${arm} ${w}x${h} ${vertices}: ${ms.map((x) => x.toFixed(4)).join(' ')}`);
      }
    }
    target.destroy();
  }
  counter.destroy();
  device.destroy();
  return out;
}

export const suite = { stores };
export async function runAll(o: Options): Promise<Sample[]> {
  return stores(o);
}
