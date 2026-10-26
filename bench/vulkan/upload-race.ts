// VK3 L4: orderings WebGPU must keep that libplacebo's advanced path leans on, checked on this host's browser
// (bench/vulkan/REPORT.md "VK3 L4": mpv's VA-API chroma read as zeros on the M4 with it on). By default, a storage
// texture (rg32float) written by one dispatch and sampled by the next, in one compute pass or two, fresh or kept (its
// separated scalers). ALL=1 adds: a fresh rg8unorm texture like an imported plane, written with `queue.writeTexture` and
// read in the same task by a compute pass (`textureLoad`) or a render pass, with or without an empty submit between;
// and the same compute read with the GPU busy (8 rounds in flight, each behind a long compute pass). Counts the rounds
// with any texel wrong and with every texel zero.
//   node bench/vulkan/upload-race.ts [out.json]   (N rounds a variant, default 300; CHROMIUM, CHROMIUM_ARGS as fence.ts;
//   on the Mac: SCRIPT=upload-race.ts bench/vulkan/mac-costs.sh <name>)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';

const root = new URL('../..', import.meta.url).pathname;
const out = process.argv[2] ?? join(root, 'bench/results/local/vk3-upload-race.json');
const N = Number(process.env.N ?? 300);
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: !process.env.HEADED,
  args: (process.env.CHROMIUM_ARGS ?? (process.platform === 'darwin' ? '--enable-unsafe-webgpu' : '--enable-unsafe-webgpu --enable-features=Vulkan')).split(' ').filter(Boolean) });
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.error(`page: ${m.text().slice(0, 500)}`); });
  await page.goto(`${base}/bench/vulkan/fence/index.html`);
  const r = await page.evaluate(async ([n, all]) => {
    const adapter = (await navigator.gpu.requestAdapter())!;
    const d = await adapter.requestDevice();
    d.addEventListener('uncapturederror', (ev) => console.warn(`uncaptured: ${(ev as GPUUncapturedErrorEvent).error.message}`));
    const W = 427, H = 240, BPR = 432 * 2;
    const data = new Uint8Array(BPR * H);
    for (let i = 0; i < data.length; i++) data[i] = 1 + (i % 251);
    const out = d.createBuffer({ size: W * H * 4, usage: 0x80 | 0x4 | 0x8 });
    const read = d.createBuffer({ size: W * H * 4, usage: 0x1 | 0x8 });
    const compute = d.createComputePipeline({ layout: 'auto', compute: { module: d.createShaderModule({ code: `
      @group(0) @binding(0) var t: texture_2d<f32>;
      @group(0) @binding(1) var<storage, read_write> o: array<u32>;
      @compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
        if (g.x >= ${W}u || g.y >= ${H}u) { return; }
        let v = textureLoad(t, vec2i(g.xy), 0);
        o[g.y * ${W}u + g.x] = u32(v.r * 255.0 + 0.5) | (u32(v.g * 255.0 + 0.5) << 8u);
      }` }), entryPoint: 'main' } });
    const render = d.createRenderPipeline({ layout: 'auto',
      vertex: { module: d.createShaderModule({ code: `@vertex fn v(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
        let p = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }` }), entryPoint: 'v' },
      fragment: { module: d.createShaderModule({ code: `
        @group(0) @binding(0) var t: texture_2d<f32>;
        @group(0) @binding(1) var<storage, read_write> o: array<u32>;
        @fragment fn f(@builtin(position) p: vec4f) -> @location(0) vec4f {
          let c = vec2u(p.xy);
          let v = textureLoad(t, vec2i(c), 0);
          o[c.y * ${W}u + c.x] = u32(v.r * 255.0 + 0.5) | (u32(v.g * 255.0 + 0.5) << 8u);
          return v;
        }` }), entryPoint: 'f', targets: [{ format: 'rgba8unorm' }] } });
    const target = d.createTexture({ size: [W, H], format: 'rgba8unorm', usage: 0x10 });
    // `busy`: 8 rounds in flight at once, each after a long compute pass of its own (the GPU busy, as under mpv).
    const spin = d.createComputePipeline({ layout: 'auto', compute: { module: d.createShaderModule({ code: `
      @group(0) @binding(0) var<storage, read_write> s: array<u32>;
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
        var x = g.x; for (var i = 0u; i < 20000u; i++) { x = x * 1664525u + 1013904223u; } s[g.x] = x; }` }), entryPoint: 'main' } });
    const spinBuf = d.createBuffer({ size: 64 * 64 * 4, usage: 0x80 });
    const spinGroup = d.createBindGroup({ layout: spin.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: spinBuf } }] });
    const busy = async (fix: 'none' | 'empty-submit') => {
      let bad = 0, zero = 0;
      for (let k = 0; k < n; k += 8) {
        const rounds = [];
        for (let j = 0; j < 8; j++) {
          const o2 = d.createBuffer({ size: W * H * 4, usage: 0x80 | 0x4 | 0x8 });
          const r2 = d.createBuffer({ size: W * H * 4, usage: 0x1 | 0x8 });
          const tex = d.createTexture({ size: [W, H], format: 'rg8unorm', usage: 0x1 | 0x2 | 0x4 });
          const e0 = d.createCommandEncoder();
          const sp = e0.beginComputePass(); sp.setPipeline(spin); sp.setBindGroup(0, spinGroup); sp.dispatchWorkgroups(64); sp.end();
          d.queue.submit([e0.finish()]);
          const e = d.createCommandEncoder();
          d.queue.writeTexture({ texture: tex }, data, { bytesPerRow: BPR, rowsPerImage: H }, [W, H]);
          if (fix === 'empty-submit') d.queue.submit([]);
          const group = d.createBindGroup({ layout: compute.getBindGroupLayout(0), entries: [{ binding: 0, resource: tex.createView() }, { binding: 1, resource: { buffer: o2 } }] });
          const p = e.beginComputePass(); p.setPipeline(compute); p.setBindGroup(0, group); p.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8)); p.end();
          e.copyBufferToBuffer(o2, 0, r2, 0, W * H * 4);
          d.queue.submit([e.finish()]);
          tex.destroy();
          rounds.push(r2.mapAsync(1).then(() => {
            const o = new Uint32Array(r2.getMappedRange());
            let z = 0, wrong = 0;
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
              const v = o[y * W + x], want = data[y * BPR + 2 * x] | (data[y * BPR + 2 * x + 1] << 8);
              if (v === 0) z++;
              if (v !== want) wrong++;
            }
            if (wrong) bad++;
            if (z === W * H) zero++;
            r2.destroy(); o2.destroy();
          }));
        }
        await Promise.all(rounds);
      }
      return { rounds: n, wrong: bad, allZero: zero };
    };
    // A storage texture written by one dispatch and sampled by the next (libplacebo's separated scalers: the first
    // half into an FBO by compute, the second half sampling it), in one compute pass or in two.
    const writer = d.createComputePipeline({ layout: 'auto', compute: { module: d.createShaderModule({ code: `
      @group(0) @binding(0) var s: texture_storage_2d<FMT, write>;
      @compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
        if (g.x >= ${W}u || g.y >= ${H}u) { return; }
        textureStore(s, vec2i(g.xy), vec4f(f32(g.x % 200u + 1u) / 256.0, f32(g.y % 200u + 1u) / 256.0, 0.5, 1.0));
      }`.replace('FMT', 'rg32float') }), entryPoint: 'main' } });
    const reader = d.createComputePipeline({ layout: 'auto', compute: { module: d.createShaderModule({ code: `
      @group(0) @binding(0) var t: texture_2d<f32>;
      @group(0) @binding(1) var<storage, read_write> o: array<u32>;
      @compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
        if (g.x >= ${W}u || g.y >= ${H}u) { return; }
        let v = textureLoad(t, vec2i(g.xy), 0);
        o[g.y * ${W}u + g.x] = u32(v.r * 256.0 + 0.5) | (u32(v.g * 256.0 + 0.5) << 8u);
      }` }), entryPoint: 'main' } });
    const chain = async (passes: 1 | 2, fresh: boolean) => {
      let bad = 0, zero = 0;
      let S: GPUTexture | undefined;
      for (let k = 0; k < n; k++) {
        if (fresh || !S) { S?.destroy(); S = d.createTexture({ size: [W, H], format: 'rg32float', usage: 0x1 | 0x4 | 0x8 | 0x10 }); }
        const e = d.createCommandEncoder();
        e.clearBuffer(out);
        const g1 = d.createBindGroup({ layout: writer.getBindGroupLayout(0), entries: [{ binding: 0, resource: S.createView() }] });
        const g2 = d.createBindGroup({ layout: reader.getBindGroupLayout(0), entries: [{ binding: 0, resource: S.createView() }, { binding: 1, resource: { buffer: out } }] });
        let p = e.beginComputePass();
        p.setPipeline(writer); p.setBindGroup(0, g1); p.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
        if (passes === 2) { p.end(); p = e.beginComputePass(); }
        p.setPipeline(reader); p.setBindGroup(0, g2); p.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8)); p.end();
        e.copyBufferToBuffer(out, 0, read, 0, W * H * 4);
        d.queue.submit([e.finish()]);
        await read.mapAsync(1);
        const o = new Uint32Array(read.getMappedRange());
        let z = 0, wrong = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const v = o[y * W + x], want = (x % 200 + 1) | ((y % 200 + 1) << 8);
          if (v === 0) z++;
          if (v !== want) wrong++;
        }
        read.unmap();
        if (wrong) bad++;
        if (z === W * H) zero++;
      }
      S?.destroy();
      return { rounds: n, wrong: bad, allZero: zero };
    };
    const run = async (kind: 'compute' | 'render', fix: 'none' | 'empty-submit') => {
      let bad = 0, zero = 0;
      for (let k = 0; k < n; k++) {
        const tex = d.createTexture({ size: [W, H], format: 'rg8unorm', usage: 0x1 | 0x2 | 0x4 });
        const e = d.createCommandEncoder();
        d.queue.writeTexture({ texture: tex }, data, { bytesPerRow: BPR, rowsPerImage: H }, [W, H]);
        if (fix === 'empty-submit') d.queue.submit([]);
        e.clearBuffer(out);
        const pipe = kind === 'compute' ? compute : render;
        const group = d.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: tex.createView() }, { binding: 1, resource: { buffer: out } }] });
        if (kind === 'compute') {
          const p = e.beginComputePass();
          p.setPipeline(compute); p.setBindGroup(0, group); p.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8)); p.end();
        } else {
          const p = e.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
          p.setPipeline(render); p.setBindGroup(0, group); p.draw(3); p.end();
        }
        e.copyBufferToBuffer(out, 0, read, 0, W * H * 4);
        d.queue.submit([e.finish()]);
        await read.mapAsync(1);
        const o = new Uint32Array(read.getMappedRange());
        let z = 0, wrong = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const v = o[y * W + x], want = data[y * BPR + 2 * x] | (data[y * BPR + 2 * x + 1] << 8);
          if (v === 0) z++;
          if (v !== want) wrong++;
        }
        read.unmap();
        tex.destroy();
        if (wrong) bad++;
        if (z === W * H) zero++;
      }
      return { rounds: n, wrong: bad, allZero: zero };
    };
    const res: Record<string, unknown> = { adapter: `${adapter.info.vendor} ${adapter.info.architecture}` };
    for (const passes of [1, 2] as const) for (const fresh of [true, false]) res[`storage then sampled, ${passes} pass(es), ${fresh ? 'fresh' : 'kept'} texture`] = await chain(passes, fresh);
    if (all) {
      for (const kind of ['compute', 'render'] as const) for (const fix of ['none', 'empty-submit'] as const) res[`${kind} ${fix}`] = await run(kind, fix);
      for (const fix of ['none', 'empty-submit'] as const) res[`busy compute ${fix}`] = await busy(fix);
    }
    return res;
  }, [N, !!process.env.ALL] as const);
  const res = { date: new Date().toISOString(), chromium: browser.version(), platform: process.platform, ...(r as object) };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(res, null, 1) + '\n');
  console.log(JSON.stringify(res, null, 1));
} finally {
  await browser.close();
  server.close();
}
