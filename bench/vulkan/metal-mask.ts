// metal-mask.ts: what a pipeline's sample mask keeps of a 4-sample depth-stencil attachment (VK4 T50, bench/vulkan/
// REPORT.md "VK4 T50"), by fragment stage: none, an empty one, one writing `frag_depth`, one writing `sample_mask`
// (all ones; with `frag_depth` too, all ones or the mask), and one writing `frag_depth` that discards the samples the
// mask leaves out at the sample rate (the driver's stand-in). Stencil: four passes, pass i's mask 1 << i, REPLACE with
// reference 1 (samples 0, 1) or 255 (2, 3), each sample read back (1 1 255 255 is right). Depth: one pass of mask 1
// into a depth cleared to 1 (the stage's depth 0.5, else the vertices' 0.25; only sample 0 written is right).
//   CHROMIUM=<browser> node bench/vulkan/metal-mask.ts [out.json]   (on the Mac: from ~/waarm64-gpu-bench.noindex with
//   CHROMIUM set as bench/mac-chrome.sh's $MAC_CHROME)
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const server = createServer((_q, r) => r.end('<!doctype html>')).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--enable-unsafe-webgpu'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
  const r = await page.evaluate(async () => {
    const a = await navigator.gpu.requestAdapter();
    if (!a) return { adapter: 'none', rows: [] as { aspect: string; format: string; stage: string; samples: number[]; right: boolean }[] };
    const d = await a.requestDevice({ requiredFeatures: a.features.has('depth32float-stencil8') ? ['depth32float-stencil8'] : [] });
    const STAGES: Record<string, string | null> = {
      none: null,
      empty: '@fragment fn main() {}',
      depth: '@fragment fn main() -> @builtin(frag_depth) f32 { return 0.5; }',
      mask: '@fragment fn main() -> @builtin(sample_mask) u32 { return 0xffffffffu; }',
      'depth+mask': 'struct O { @builtin(frag_depth) d: f32, @builtin(sample_mask) m: u32 }\n@fragment fn main() -> O { return O(0.5, 0xffffffffu); }',
      'depth+own mask': 'override pm: u32 = 0xffffffffu;\nstruct O { @builtin(frag_depth) d: f32, @builtin(sample_mask) m: u32 }\n@fragment fn main() -> O { return O(0.5, pm); }',
      'depth+discard': 'override pm: u32 = 0xffffffffu;\n@fragment fn main(@builtin(sample_index) s: u32) -> @builtin(frag_depth) f32 {\n  if (((pm >> s) & 1u) == 0u) { discard; }\n  return 0.5;\n}',
    };
    const vs = d.createShaderModule({ code: `@vertex fn main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
      return vec4f(select(-1.0, 3.0, i == 1u), select(-1.0, 3.0, i == 2u), 0.25, 1.0); }` });
    const read = async (e: GPUCommandEncoder, tex: GPUTexture, stencil: boolean) => {
      const code = stencil
        ? `@group(0) @binding(0) var t: texture_multisampled_2d<u32>;\n@group(0) @binding(1) var<storage, read_write> o: array<f32, 4>;
@compute @workgroup_size(1) fn main() { for (var s = 0; s < 4; s++) { o[s] = f32(textureLoad(t, vec2i(1, 1), s).r); } }`
        : `@group(0) @binding(0) var t: texture_depth_multisampled_2d;\n@group(0) @binding(1) var<storage, read_write> o: array<f32, 4>;
@compute @workgroup_size(1) fn main() { for (var s = 0; s < 4; s++) { o[s] = textureLoad(t, vec2i(1, 1), s); } }`;
      const cp = d.createComputePipeline({ layout: 'auto', compute: { module: d.createShaderModule({ code }), entryPoint: 'main' } });
      const ob = d.createBuffer({ size: 16, usage: 0x80 | 0x4 /* STORAGE | COPY_SRC */ });
      const rb = d.createBuffer({ size: 16, usage: 0x8 | 0x1 /* COPY_DST | MAP_READ */ });
      const c = e.beginComputePass();
      c.setPipeline(cp);
      c.setBindGroup(0, d.createBindGroup({ layout: cp.getBindGroupLayout(0), entries: [
        { binding: 0, resource: tex.createView({ aspect: stencil ? 'stencil-only' : 'depth-only' }) }, { binding: 1, resource: { buffer: ob } }] }));
      c.dispatchWorkgroups(1);
      c.end();
      e.copyBufferToBuffer(ob, 0, rb, 0, 16);
      d.queue.submit([e.finish()]);
      await rb.mapAsync(1);
      const v = [...new Float32Array(rb.getMappedRange())];
      rb.unmap();
      return v;
    };
    const pipeline = (format: GPUTextureFormat, stage: string, mask: number, stencil: boolean) => {
      const fs = STAGES[stage];
      return d.createRenderPipeline({
        layout: 'auto',
        vertex: { module: vs, entryPoint: 'main' },
        fragment: fs ? { module: d.createShaderModule({ code: fs }), entryPoint: 'main', targets: [], constants: fs.includes('override pm') ? { pm: mask } : undefined } : undefined,
        depthStencil: { format, depthWriteEnabled: true, depthCompare: 'always',
          ...(stencil ? { stencilFront: { compare: 'always', passOp: 'replace', failOp: 'replace', depthFailOp: 'replace' },
            stencilBack: { compare: 'always', passOp: 'replace', failOp: 'replace', depthFailOp: 'replace' } } : {}) },
        multisample: { count: 4, mask },
      });
    };
    const rows = [];
    const formats: GPUTextureFormat[] = ['depth24plus-stencil8', ...(d.features.has('depth32float-stencil8') ? ['depth32float-stencil8' as GPUTextureFormat] : [])];
    for (const format of formats)
      for (const stage of Object.keys(STAGES)) {
        const tex = d.createTexture({ size: [4, 4], format, sampleCount: 4, usage: 0x10 | 0x4 /* RENDER_ATTACHMENT | TEXTURE_BINDING */ });
        const e = d.createCommandEncoder();
        for (let i = 0; i < 4; i++) {
          const pass = e.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: tex.createView(),
            depthLoadOp: i ? 'load' : 'clear', depthStoreOp: 'store', depthClearValue: 1, stencilLoadOp: i ? 'load' : 'clear', stencilStoreOp: 'store', stencilClearValue: 0 } });
          pass.setPipeline(pipeline(format, stage, 1 << i, true));
          pass.setStencilReference(i < 2 ? 1 : 255);
          pass.draw(3);
          pass.end();
        }
        const s = await read(e, tex, true);
        rows.push({ aspect: 'stencil', format, stage, samples: s, right: s.join() === '1,1,255,255' });
      }
    for (const format of ['depth24plus', 'depth32float', ...formats] as GPUTextureFormat[])
      for (const stage of Object.keys(STAGES)) {
        const tex = d.createTexture({ size: [4, 4], format, sampleCount: 4, usage: 0x10 | 0x4 });
        const e = d.createCommandEncoder();
        const pass = e.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: tex.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1,
          ...(format.includes('stencil') ? { stencilLoadOp: 'clear', stencilStoreOp: 'store' } : {}) } });
        pass.setPipeline(pipeline(format, stage, 1, false));
        pass.draw(3);
        pass.end();
        const s = (await read(e, tex, false)).map((x) => Math.round(x * 100) / 100);
        rows.push({ aspect: 'depth', format, stage, samples: s, right: s[0] !== 1 && s.slice(1).every((x) => x === 1) });
      }
    const info = a.info as unknown as { vendor: string; architecture: string };
    return { adapter: `${info.vendor} ${info.architecture}`, rows };
  });
  for (const row of r.rows) console.log(`${row.aspect} ${row.format} stage ${row.stage}: ${row.samples.join(' ')}${row.right ? '' : '  WRONG'}`);
  const out = { browser: browser.version(), adapter: r.adapter, rows: r.rows };
  console.log(`${out.browser}, ${out.adapter}`);
  if (process.argv[2]) writeFileSync(process.argv[2], `${JSON.stringify(out, null, 1)}\n`);
} finally {
  await browser.close();
  server.close();
}
