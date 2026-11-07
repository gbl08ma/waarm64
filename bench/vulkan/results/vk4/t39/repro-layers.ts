// T39: a multisampled RGBA8 texture cleared to 0, then to a colour, resolved (loadOp load + resolveTarget) into one layer
// of an 8-layer texture: texel (255, 255) read back. Variants by argv.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
const server = createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end('<!doctype html><title>t39</title>'); });
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage();
await page.goto(`${base}/`);
const out = await page.evaluate(async () => {
  const adapter = (await navigator.gpu.requestAdapter())!;
  const d = await adapter.requestDevice();
  const res: Record<string, unknown> = {};
  const bpts: Record<string, number> = { rgba8unorm: 4, bgra8unorm: 4, 'rgba8unorm-srgb': 4, r8unorm: 1, rg8unorm: 2, rgb10a2unorm: 4, rgba16float: 8, rg16float: 4, r16float: 2, r32float: 4 };
  for (const fmt of ['rgba8unorm', 'bgra8unorm'] as GPUTextureFormat[]) for (const size of [16, 64, 100, 256]) for (const layers of [4, 5, 6, 7, 16]) for (const load of [false]) {
    if (fmt === 'r32float') continue;
    const ms = d.createTexture({ size: [size, size], sampleCount: 4, format: fmt, usage: 0x17 });
    const dst = d.createTexture({ size: [size, size, layers], format: fmt, usage: 0x17 });
    const enc = d.createCommandEncoder();
    const v = ms.createView({ dimension: '2d' });
    const layer = 1;
    const rt = dst.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1 });
    if (load) {
      enc.beginRenderPass({ colorAttachments: [{ view: v, loadOp: 'clear', storeOp: 'store', clearValue: [0.1, 0.5, 0.3, 0.9] }] }).end();
      enc.beginRenderPass({ colorAttachments: [{ view: v, resolveTarget: rt, loadOp: 'load', storeOp: 'store' }] }).end();
    } else enc.beginRenderPass({ colorAttachments: [{ view: v, resolveTarget: rt, loadOp: 'clear', storeOp: 'store', clearValue: [0.1, 0.5, 0.3, 0.9] }] }).end();
    const bpt = bpts[fmt];
    const bpr = Math.ceil(size * bpt / 256) * 256;
    const buf = d.createBuffer({ size: bpr * size, usage: 9 /* MAP_READ | COPY_DST */ });
    enc.copyTextureToBuffer({ texture: dst, origin: { x: 0, y: 0, z: layer } }, { buffer: buf, bytesPerRow: bpr }, [size, size, 1]);
    d.queue.submit([enc.finish()]);
    await buf.mapAsync(1);
    const u = new Uint8Array(buf.getMappedRange());
    let zero = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { let z = true; for (let k = 0; k < bpt; k++) if (u[y * bpr + x * bpt + k]) z = false; if (z) zero++; }
    if (zero) res[`${fmt} ${size} layers ${layers} ${load ? 'load' : 'clear'}`] = zero;
  }
  res.adapter = `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}`;
  return res;
});
console.log(out);
await browser.close(); server.close();
