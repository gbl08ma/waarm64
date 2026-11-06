// VK4 T32's cost of a draw that reads the attachment it writes (bench/vulkan/REPORT.md "VK4 T32"): the driver's
// `dst_copies` (vk/driver/wg_cmd.c) ends the WebGPU render pass before such a draw, copies the attachment into its twin
// and begins the pass again loading it, so that the fragment stage reads the twin (depth bounds, logic ops, advanced
// blends). This times that work in plain WebGPU against the same draws blended by WebGPU: a fullscreen triangle a draw,
// `draws` of them on an rgba8unorm target, ms a draw (wall, back to back), median of 10 samples.
//   node bench/run.ts --page bench/vulkan/t32/index.html --chromium-args='<the VM's WebGPU switches>' --out bench/results/local/t32/cost.json
import type { Options, Sample } from '../../spike/benchmarks.ts';

const SIZES: [number, number][] = [[256, 256], [1920, 1080]];
const VS = '@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {' +
  ' let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)); return vec4<f32>(p[i], 0.0, 1.0); }';
const PLAIN = `${VS} @fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(0.1, 0.2, 0.3, 0.5); }`;
// As wg_shader.c `dst_text` prints it: the attachment's texel at the fragment, a blend by the stage.
const READS = `${VS} @group(0) @binding(0) var t: texture_2d<f32>;
@fragment fn fs(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  let d = textureLoad(t, vec2<i32>(p.xy), 0); let s = vec4<f32>(0.1, 0.2, 0.3, 0.5);
  return s + d * (1.0 - s.a); }`;

async function reads(o: Options): Promise<Sample[]> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('no WebGPU adapter');
  const device = await adapter.requestDevice();
  const out: Sample[] = [];
  const samples = o.quick ? 3 : 10, draws = 100;
  const format: GPUTextureFormat = 'rgba8unorm';
  const pipeline = (code: string, blend: boolean) => device.createRenderPipeline({
    layout: 'auto', vertex: { module: device.createShaderModule({ code }), entryPoint: 'vs' },
    fragment: { module: device.createShaderModule({ code }), entryPoint: 'fs', targets: [{ format, ...(blend ? {
      blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } } : {}) }] } });
  const plain = pipeline(PLAIN, true), read = pipeline(READS, false);
  for (const [w, h] of SIZES) {
    const target = device.createTexture({ size: [w, h], format, usage: 16 | 1 /* RENDER_ATTACHMENT | COPY_SRC */ });
    const twin = device.createTexture({ size: [w, h], format, usage: 4 | 2 /* TEXTURE_BINDING | COPY_DST */ });
    const group = device.createBindGroup({ layout: read.getBindGroupLayout(0), entries: [{ binding: 0, resource: twin.createView() }] });
    const att = (load: GPULoadOp): GPURenderPassDescriptor => ({ colorAttachments: [{ view: target.createView(), loadOp: load, storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    for (const arm of ['plain', 'reads'] as const) {
      const frame = () => {
        const e = device.createCommandEncoder();
        let pass = e.beginRenderPass(att('clear'));
        for (let k = 0; k < draws; k++) {
          if (arm === 'reads') {
            pass.end();
            e.copyTextureToTexture({ texture: target }, { texture: twin }, [w, h]);
            pass = e.beginRenderPass(att('load'));
            pass.setPipeline(read);
            pass.setBindGroup(0, group);
          } else if (k === 0) {
            pass.setPipeline(plain);
          }
          pass.draw(3);
        }
        pass.end();
        device.queue.submit([e.finish()]);
        return device.queue.onSubmittedWorkDone();
      };
      const ms: number[] = [];
      for (let s = -1; s < samples; s++) {
        const t = performance.now();
        await frame();
        if (s >= 0) ms.push((performance.now() - t) / draws);
      }
      out.push({ name: 'reads', unit: 'ms', params: { arm, size: `${w}x${h}`, draws }, samples: ms });
      o.log?.(`${arm} ${w}x${h}: ${ms.map((x) => x.toFixed(4)).join(' ')}`);
    }
    target.destroy();
    twin.destroy();
  }
  device.destroy();
  return out;
}

export const suite = { reads };
export async function runAll(o: Options): Promise<Sample[]> {
  return reads(o);
}
