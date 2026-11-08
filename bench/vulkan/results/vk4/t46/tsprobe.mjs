// VK4 T46: which timestamp-query shapes Chrome's WebGPU takes on this host (each variant on a device of its own).
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage();
await page.goto('file://' + process.cwd() + '/tsprobe.mjs');
const out = await page.evaluate(async () => {
  const res = {};
  const adapter = await navigator.gpu.requestAdapter();
  res.features = adapter.features.has('timestamp-query');
  const variants = {
    empty16: { count: 16, empty: true }, empty256: { count: 256, empty: true }, empty4096: { count: 4096, empty: true },
    render16: { count: 16, render: true }, render256: { count: 256, render: true },
    unwritten256: { count: 256, empty: true, resolveAll: true },
    twoSets: { count: 256, empty: true, sets: 2 },
    manyEmpty: { count: 256, empty: true, n: 200 },
    dispatch: { count: 256, dispatch: true },
    renderOcclusion: { count: 256, render: true, occlusion: true },
    renderDepth: { count: 256, render: true, depth: true, occlusion: true },
    mixed: { count: 256, render: true, dispatch: true, n: 20 },
  };
  for (const [name, v] of Object.entries(variants)) {
    const d = await (await navigator.gpu.requestAdapter()).requestDevice({ requiredFeatures: ['timestamp-query'] });
    const errs = [];
    d.addEventListener('uncapturederror', (e) => errs.push(e.error.message));
    let lost = null;
    d.lost.then((i) => { lost = i.message; });
    try {
      const sets = Array.from({ length: v.sets ?? 1 }, () => d.createQuerySet({ type: 'timestamp', count: v.count }));
      const rb = d.createBuffer({ size: v.count * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      const st = d.createBuffer({ size: v.count * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = d.createCommandEncoder();
      const n = v.n ?? 3;
      for (let i = 0; i < n; i++) {
        if (v.empty) enc.beginComputePass({ timestampWrites: { querySet: sets[0], endOfPassWriteIndex: i } }).end();
        if (v.render) {
          const t = d.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT });
          const desc = { colorAttachments: [{ view: t.createView(), loadOp: 'clear', storeOp: 'store' }], timestampWrites: { querySet: sets[0], endOfPassWriteIndex: v.dispatch ? 2 * i : i } };
          if (v.occlusion) desc.occlusionQuerySet = d.createQuerySet({ type: 'occlusion', count: 4096 });
          if (v.depth) desc.depthStencilAttachment = { view: d.createTexture({ size: [4, 4], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT }).createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 };
          const rp = enc.beginRenderPass(desc);
          if (v.occlusion) { rp.beginOcclusionQuery(0); rp.endOcclusionQuery(); }
          rp.end();
        }
        if (v.dispatch) {
          const m = d.createShaderModule({ code: '@compute @workgroup_size(1) fn main() {}' });
          const pl = d.createComputePipeline({ layout: 'auto', compute: { module: m, entryPoint: 'main' } });
          const cp = enc.beginComputePass({ timestampWrites: { querySet: sets[0], endOfPassWriteIndex: v.render ? 2 * i + 1 : i } });
          cp.setPipeline(pl); cp.dispatchWorkgroups(1); cp.end();
        }
      }
      enc.resolveQuerySet(sets[0], 0, v.resolveAll ? v.count : n, rb, 0);
      enc.copyBufferToBuffer(rb, 0, st, 0, v.count * 8);
      d.queue.submit([enc.finish()]);
      await st.mapAsync(GPUMapMode.READ);
      const t = new BigUint64Array(st.getMappedRange().slice(0, 24));
      res[name] = { ts: [...t].map(String), errs, lost };
    } catch (e) { res[name] = { error: String(e), errs, lost }; }
    await new Promise((r) => setTimeout(r, 100));
    res[name].lost = lost;
    d.destroy();
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
