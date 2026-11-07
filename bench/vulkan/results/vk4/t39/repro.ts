// T39: a multisampled RGBA8 texture cleared to 0, then to a colour, resolved (loadOp load + resolveTarget) into one layer
// of an 8-layer texture: texel (255, 255) read back. Variants by argv.
import { chromium } from 'playwright-core';
import { startServer } from '../../../../../tools/serve.ts';
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
const page = await browser.newPage();
await page.goto(`${base}/tests/browser/venus-driver.html`);
const out = await page.evaluate(async () => {
  const adapter = (await navigator.gpu.requestAdapter())!;
  const d = await adapter.requestDevice();
  const res: Record<string, unknown> = {};
  // T39's sRGB twins: a 4-sample texture of one, drawn (cleared) through a view of the other, resolved into a texture of the view's format.
  for (const [own, view, layers] of [['rgba8unorm-srgb', 'rgba8unorm', 1], ['bgra8unorm-srgb', 'bgra8unorm', 1], ['rgba8unorm', 'rgba8unorm-srgb', 1], ['rgba8unorm-srgb', 'rgba8unorm', 0]] as [GPUTextureFormat, GPUTextureFormat, number][]) {
    const size = 16;
    const ms = d.createTexture({ size: [size, size], sampleCount: 4, format: (layers ? own : view) as GPUTextureFormat, usage: 0x17, viewFormats: (layers ? [view] : []) as GPUTextureFormat[] } as GPUTextureDescriptor);
    const dst = d.createTexture({ size: [size, size], format: view, usage: 0x17 });
    const enc = d.createCommandEncoder();
    enc.beginRenderPass({ colorAttachments: [{ view: ms.createView({ format: view }), resolveTarget: dst.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0.5, 0.5, 0.5, 1] }] }).end();
    const buf = d.createBuffer({ size: 256 * size, usage: 9 });
    enc.copyTextureToBuffer({ texture: dst }, { buffer: buf, bytesPerRow: 256 }, [size, size, 1]);
    d.queue.submit([enc.finish()]);
    await buf.mapAsync(1);
    const u = new Uint8Array(buf.getMappedRange());
    res[`${String(layers ? own : view)} as ${String(view)} -> ${String(view)}`] = [...u.subarray(0, 4)].join(',');
  }
  return res;
});
console.log(out);
await browser.close(); server.close();
