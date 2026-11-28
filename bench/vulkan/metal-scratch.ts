// metal-scratch.ts: what a compute shader reads back of a local array of words (VK4 T50, bench/vulkan/REPORT.md "VK4
// T50"): 16 constant words stored from word `base` of an array of `size` u32s, then four adjacent words read from a
// dynamic offset (base + 4k, k = 0..2 from a uniform), as the translator's scratch was (array<u32, n>, word w at [w])
// and is (array<vec4<u32>, n/4>, word w at [w >> 2][w & 3]); and a workgroup array of words. Apple's Metal compiler
// (Chrome for Testing 158 on the M4) read the wrong words of a thread array of 33 to 255 u32s from a base not a
// multiple of four. Prints and writes each shape's verdict.
//   CHROMIUM=<browser> node bench/vulkan/metal-scratch.ts [out.json]   (on the Mac: from ~/waarm64-gpu-bench.noindex
//   with CHROMIUM set as bench/mac-chrome.sh's $MAC_CHROME; EXTRA=<Chromium switches>, e.g.
//   --enable-dawn-features=disable_robustness)
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const ONE = 0x3f800000;
const VALUES = [ONE, ONE, ONE, ONE, 0, 0, ONE, ONE, 0, ONE, 0, ONE, 0, ONE, ONE, ONE];
type Layout = 'words' | 'vec4s' | 'workgroup';

function shader(layout: Layout, base: number, size: number): string {
  const at = (w: string) => (layout === 'vec4s' ? `a[(${w}) >> 2u][(${w}) & 3u]` : `a[${w}]`);
  const decl =
    layout === 'vec4s' ? `var a: array<vec4<u32>, ${Math.ceil(size / 4)}>;` : layout === 'words' ? `var a: array<u32, ${size}>;` : '';
  return `@group(0) @binding(0) var<uniform> pc: array<vec4<u32>, 17>;
@group(0) @binding(1) var<storage, read_write> out: array<vec4<u32>, 3>;
${layout === 'workgroup' ? `var<workgroup> a: array<u32, ${size}>;` : ''}
@compute @workgroup_size(1) fn main() {
  let k = pc[16u][2u];
  ${decl}
${VALUES.map((v, j) => `  ${at(`${base + j}u`)} = ${v}u;`).join('\n')}
  ${layout === 'workgroup' ? 'workgroupBarrier();' : ''}
  let b = ${base}u + (k << 2u);
  out[min(k, 2u)] = vec4<u32>(${[0, 1, 2, 3].map((i) => at(`b + ${i}u`)).join(', ')});
}
`;
}

const shapes: { layout: Layout; base: number; size: number }[] = [];
for (const layout of ['words', 'vec4s', 'workgroup'] as Layout[])
  for (const base of [0, 2, 10])
    for (const size of [26, 32, 33, 34, 40, 48, 64, 96, 128, 192, 240, 255, 256, 512, 2048])
      if (base + 16 <= size) shapes.push({ layout, base, size });

const server = createServer((_q, r) => r.end('<!doctype html>')).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM,
  args: ['--enable-unsafe-webgpu', ...(process.env.EXTRA ?? '').split(' ').filter(Boolean)],
});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
  const codes = shapes.map((s) => shader(s.layout, s.base, s.size));
  const r = await page.evaluate(async (codes) => {
    const a = await navigator.gpu.requestAdapter();
    if (!a) return { adapter: 'none', got: [] as number[][] };
    const d = await a.requestDevice();
    const got: number[][] = [];
    for (const code of codes) {
      const p = d.createComputePipeline({ layout: 'auto', compute: { module: d.createShaderModule({ code }), entryPoint: 'main' } });
      const ub = d.createBuffer({ size: 1536, usage: 0x40 | 0x8 /* UNIFORM | COPY_DST */ });
      const u = new Uint32Array(384);
      for (let k = 0; k < 3; k++) u[(512 * k + 256) / 4 + 2] = k;
      d.queue.writeBuffer(ub, 0, u);
      const ob = d.createBuffer({ size: 48, usage: 0x80 | 0x4 /* STORAGE | COPY_SRC */ });
      const rb = d.createBuffer({ size: 48, usage: 0x8 | 0x1 /* COPY_DST | MAP_READ */ });
      const e = d.createCommandEncoder();
      const c = e.beginComputePass();
      c.setPipeline(p);
      for (let k = 0; k < 3; k++) {
        c.setBindGroup(0, d.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: ub, offset: 512 * k, size: 272 } }, { binding: 1, resource: { buffer: ob } }] }));
        c.dispatchWorkgroups(1);
      }
      c.end();
      e.copyBufferToBuffer(ob, 0, rb, 0, 48);
      d.queue.submit([e.finish()]);
      await rb.mapAsync(1 /* GPUMapMode.READ */);
      got.push([...new Uint32Array(rb.getMappedRange())]);
      rb.unmap();
    }
    const info = a.info as unknown as { vendor: string; architecture: string };
    return { adapter: `${info.vendor} ${info.architecture}`, got };
  }, codes);
  const want = VALUES.slice(0, 12);
  const results = shapes.map((s, i) => ({ ...s, right: r.got[i]?.every((v, j) => v === want[j]) ?? false, got: r.got[i] }));
  const out = { browser: browser.version(), adapter: r.adapter, extra: process.env.EXTRA ?? '', results };
  for (const layout of ['words', 'vec4s', 'workgroup'])
    for (const base of [0, 2, 10]) {
      const row = results.filter((x) => x.layout === layout && x.base === base);
      console.log(`${layout} from word ${base}: wrong at sizes ${row.filter((x) => !x.right).map((x) => x.size).join(' ') || 'none'} (of ${row.length})`);
    }
  console.log(`${out.browser}, ${out.adapter}`);
  if (process.argv[2]) writeFileSync(process.argv[2], `${JSON.stringify(out, null, 1)}\n`);
} finally {
  await browser.close();
  server.close();
}
