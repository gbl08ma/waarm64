// imm-probe.ts: what a compute shader reads of its immediates, by direct and indirect dispatch, with and without
// @builtin(num_workgroups) (GD G4, bench/vulkan/REPORT.md "GD G4"): the 12 words as read, num_workgroups, and the
// iterations of a loop bounded by word 5 (capped at 100,001, so a wrong bound can't hang the GPU). Chrome for Testing
// 153.0.8010.12 on the M4 read the first six words of an indirect dispatch clobbered; 153.0.8010.52 and later don't.
//   CHROMIUM=<browser> [SANDBOX=1] node bench/vulkan/imm-probe.ts   (on the Mac: copy it to ~/waarm64-gpu-bench.noindex, run it
//   there with CHROMIUM set as bench/mac-chrome.sh's $MAC_CHROME; SANDBOX=1: Chrome's sandbox on, Playwright's
//   automation switches left out)
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';

const server = createServer((_q, r) => r.end('<!doctype html>')).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
// SANDBOX=1: Chrome's sandbox on, and Playwright's own switches that change behavior left out.
const sandbox = process.env.SANDBOX === '1';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: (process.env.CHROMIUM_ARGS ?? '').split(' ').filter(Boolean),
  chromiumSandbox: sandbox, ignoreDefaultArgs: sandbox ? ['--enable-automation', '--disable-field-trial-config', '--disable-background-networking', '--disable-features', '--disable-gpu', '--no-sandbox'] : undefined });
console.log('browser', browser.version(), 'sandbox', sandbox);
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log(`page: ${m.text()}`));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
  const cdp = await page.context().newCDPSession(page);
  const cmd = (await cdp.send('Browser.getBrowserCommandLine').catch(() => ({ arguments: ['?'] }))) as { arguments: string[] };
  console.log('switches', cmd.arguments.filter((a) => a.startsWith('--')).join(' ').slice(0, 1500));
  const r = await page.evaluate(async () => {
    const a = await navigator.gpu.requestAdapter();
    if (!a) return { error: 'no adapter' };
    const lim = (a.limits as unknown as Record<string, number>).maxImmediateSize ?? 0;
    const d = await a.requestDevice({ requiredLimits: { maxImmediateSize: Math.min(128, lim) } as Record<string, number> });
    const errors: string[] = [];
    d.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
    const imm = new Uint32Array([0x43000000, 0x43000000, 0x43000000, 4, 0, 1, 0, 1, 0x11, 0x3f000000, 0x3fc00000, 0]);
    const out: Record<string, unknown> = { adapter: a.info.description || a.info.vendor + ' ' + a.info.architecture, maxImmediateSize: lim };
    for (const nwg of [false, true]) for (const indirect of [false, true]) {
      const code = `requires immediate_address_space;
struct Immediates { v0: vec4<u32>, v1: vec4<u32>, v2: vec4<u32>, }
var<immediate> immediates: Immediates;
@group(0) @binding(0) var<storage, read_write> o: array<u32>;
@compute @workgroup_size(64, 1, 1) fn main(@builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wid: vec3<u32>${nwg ? ', @builtin(num_workgroups) nwg: vec3<u32>' : ''}) {
  if (li != 0u || wid.x != 0u) { return; }
  let pc = array<vec4<u32>, 3>(immediates.v0, immediates.v1, immediates.v2);
  for (var w = 0u; w < 12u; w++) { o[w] = pc[w >> 2u][w & 3u]; }
  ${nwg ? 'o[12] = nwg.x; o[13] = nwg.y; o[14] = nwg.z;' : ''}
  var i = 0u;
  var n = 0u;
  loop {
    let t787: u32 = pc[(((0x14u + 0u) >> 2u) + 0u) >> 2u][(((0x14u + 0u) >> 2u) + 0u) & 3u];
    if (i >= t787) { break; }
    i = i + 1u;
    n = n + 1u;
    if (n > 100000u) { break; }
  }
  o[15] = n;
}`;
      const m = d.createShaderModule({ code });
      const info = await m.getCompilationInfo();
      const cerr = info.messages.filter((x) => x.type === 'error').map((x) => x.message);
      if (cerr.length) { out[`nwg=${nwg} indirect=${indirect}`] = { compile: cerr }; continue; }
      const bgl = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }] });
      const pl = d.createPipelineLayout({ bindGroupLayouts: [bgl], immediateSize: 48 } as GPUPipelineLayoutDescriptor);
      const p = d.createComputePipeline({ layout: pl, compute: { module: m, entryPoint: 'main' } });
      const ob = d.createBuffer({ size: 64, usage: 0x80 | 0x4 | 0x8 });
      d.queue.writeBuffer(ob, 0, new Uint32Array(16).fill(0xdeadbeef));
      const args = d.createBuffer({ size: 512 + 12, usage: 0x100 | 0x8 });
      d.queue.writeBuffer(args, 512, new Uint32Array([59, 1, 1]));
      const rb = d.createBuffer({ size: 64, usage: 0x1 | 0x8 });
      const enc = d.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(p);
      pass.setBindGroup(0, d.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: ob } }] }));
      (pass as unknown as { setImmediates(o: number, d: Uint8Array): void }).setImmediates(0, new Uint8Array(imm.buffer));
      if (indirect) pass.dispatchWorkgroupsIndirect(args, 512);
      else pass.dispatchWorkgroups(59, 1, 1);
      pass.end();
      enc.copyBufferToBuffer(ob, 0, rb, 0, 64);
      d.queue.submit([enc.finish()]);
      await rb.mapAsync(1);
      const w = [...new Uint32Array(rb.getMappedRange())].map((x) => x.toString(16));
      out[`nwg=${nwg} indirect=${indirect}`] = { imm: w.slice(0, 12).join(' '), nwg: w.slice(12, 15).join(' '), iterations: parseInt(w[15], 16) };
    }
    out.errors = errors;
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
} finally {
  await browser.close();
  server.close();
}
