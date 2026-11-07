// The shader translator's units (vk/README.md "The shader path"): SPIR-V stages through the renderer module's
// spirv_to_nir, NIR passes and NIR → WGSL backend (vk/compiler/; venus.wasm's `wgsl_test_*` exports) in Node, then
// every WGSL module compiled by Chromium's WebGPU (Tint), which must report no error. The stages: VK0's scene's (ours,
// bench/vulkan/scene/, compiled with glslc when it's installed) and, where they were dumped, VK1 step 1's 108 from
// the direct set's programs (target/vk1/spirv: `SPIRV_DIR=target/vk1/spirv bench/vulkan/translate/programs.sh`;
// not committed, the programs' licences being theirs). A stage that doesn't translate must fail for a reason outside
// the direct set. Skipped without the module, without stages, or where Chromium has no WebGPU adapter.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

const root = new URL('..', import.meta.url).pathname;
const MODULE = join(root, 'target/vk/venus.wasm');

/** Why a stage may not translate: what the direct set doesn't offer, and the translator's known gaps (docs/backlog.md
 * "The Vulkan driver's gaps": vkQuake's variants for 16-bit floats, translated since VK3 L5, reach these). */
const OUTSIDE = /16-bit values|16-bit float arithmetic without|outside the layout \(set [4-9]|dynamically indexed|^image atomics on /;

type Stage = { name: string; stage: number; words: Uint32Array };

function stageOf(name: string) {
  return /\.vert(\.|$)/.test(name) ? 0 : /\.frag(\.|$)/.test(name) ? 4 : /\.comp(\.|$)/.test(name) ? 5 : -1;
}

function stages(tmp: string): Stage[] {
  const out: Stage[] = [];
  const add = (file: string, name: string) => {
    const b = readFileSync(file);
    out.push({ name, stage: stageOf(name), words: new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)) });
  };
  const scene = join(root, 'bench/vulkan/scene/shaders');
  if (existsSync(scene) && spawnSync('glslc', ['--version']).status === 0) {
    for (const f of readdirSync(scene).filter((f) => /\.(vert|frag|comp)$/.test(f))) {
      const spv = join(tmp, `${f}.spv`);
      const r = spawnSync('glslc', ['--target-env=vulkan1.2', '-o', spv, join(scene, f)], { encoding: 'utf8' });
      assert.equal(r.status, 0, `glslc ${f}: ${r.stderr}`);
      add(spv, `scene/${f}`);
    }
  }
  const dumped = join(root, 'target/vk1/spirv');
  if (existsSync(dumped)) {
    for (const prog of readdirSync(dumped, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name))
      for (const f of readdirSync(join(dumped, prog)).filter((f) => f.endsWith('.spv'))) add(join(dumped, prog, f), `${prog}/${f}`);
  }
  return out.filter((s) => s.stage >= 0);
}

type Exports = {
  _initialize(): void; wgsl_test_init(): void; wgsl_test_translate(words: number, n: number, stage: number): number;
  wgsl_test_device(features: number, subgroupSize: number): void;
  wgsl_test_ycbcr(set: number, binding: number, format: number, model: number, range: number, x: number, y: number, filter: number): void;
  wgsl_test_sampler(u: number, v: number, w: number, flags: number, compare: number, levels: number, bias: number, min: number, max: number, b0: number, b1: number, b2: number, b3: number, sx: number, sy: number): void;
  wgsl_test_result(): number; venus_alloc(n: number): number; venus_free(p: number): void;
};

/** What a stage is translated for: the device's WGSL features, its subgroups' size, and (VK3 L7.2) a binding sampled
 * through a YCbCr conversion (VkFormat, VkSamplerYcbcrModelConversion, VkSamplerYcbcrRange, VkChromaLocation x and y,
 * the chroma VkFilter), as an immutable sampler in its set layout. */
type Device = { features?: number; subgroupSize?: number; sampler?: { u: number; v: number; w: number; flags: number; compare: number; levels: number; bias: number; min: number; max: number; border: number[]; size?: number[] }; ycbcr?: { set: number; binding: number; format: number; model: number; range: number; x: number; y: number; filter: number } };

/** The module's translator, on a memory like the VM's memory 0 (its arena at the top). */
async function translator() {
  const memory = new WebAssembly.Memory({ initial: 65536, maximum: 65536, shared: true });
  const dv = () => new DataView(memory.buffer);
  const stub = () => 52;
  const wasi = new Proxy({
    clock_time_get: (_id: number, _p: bigint, out: number) => { dv().setBigUint64(out >>> 0, BigInt(Math.round(performance.now() * 1e6)), true); return 0; },
    fd_write: (_fd: number, iovs: number, n: number, written: number) => {
      iovs >>>= 0;
      written >>>= 0;
      let len = 0;
      for (let i = 0; i < n; i++) len += dv().getUint32(iovs + i * 8 + 4, true);
      dv().setUint32(written, len, true);
      return 0;
    },
    environ_get: () => 0,
    environ_sizes_get: (c: number, s: number) => { dv().setUint32(c >>> 0, 0, true); dv().setUint32(s >>> 0, 0, true); return 0; },
    proc_exit: (code: number) => { throw new Error(`proc_exit(${code})`); },
  } as Record<string, WebAssembly.ImportValue>, { get: (t, k: string) => t[k] ?? stub });
  // The driver's WebGPU calls (vk/driver/wg_gpu.h) aren't made: only the translator runs.
  const wg = new Proxy({}, { get: () => () => 0 });
  const imports = { env: { memory, venus_retire: () => {}, venus_submitted: () => {} }, wg, wasi_snapshot_preview1: wasi, wasi: { 'thread-spawn': () => -1 } };
  const { instance } = await WebAssembly.instantiate(readFileSync(MODULE), imports);
  const ex = instance.exports as unknown as Exports;
  ex._initialize();
  ex.wgsl_test_init();
  const text = (p: number) => {
    const u8 = new Uint8Array(memory.buffer);
    let end = p;
    while (u8[end]) end++;
    return new TextDecoder().decode(u8.slice(p, end));
  };
  // The device translated for (vk/compiler/wgsl.h's WGSL_* features; the subgroups' size): dual-source-blending and
  // subgroups of one unless a stage says otherwise.
  return (s: Stage, device: Device = {}) => {
    ex.wgsl_test_device(device.features ?? WGSL.DUAL_SOURCE, device.subgroupSize ?? 1);
    const y = device.ycbcr;
    ex.wgsl_test_ycbcr(y ? y.set : -1, y?.binding ?? 0, y?.format ?? 0, y?.model ?? 0, y?.range ?? 0, y?.x ?? 0, y?.y ?? 0, y?.filter ?? 0);
    const k = device.sampler;
    ex.wgsl_test_sampler(k?.u ?? 0, k?.v ?? 0, k?.w ?? 0, k?.flags ?? 0, k?.compare ?? 0, k?.levels ?? 0, k?.bias ?? 0, k?.min ?? 0, k?.max ?? 0, k?.border[0] ?? 0, k?.border[1] ?? 0, k?.border[2] ?? 0, k?.border[3] ?? 0, k?.size?.[0] ?? 0, k?.size?.[1] ?? 0);
    const p = ex.venus_alloc(s.words.byteLength) >>> 0;
    new Uint8Array(memory.buffer, p, s.words.byteLength).set(new Uint8Array(s.words.buffer, s.words.byteOffset, s.words.byteLength));
    const t0 = performance.now();
    const rc = ex.wgsl_test_translate(p, s.words.length, s.stage);
    const ms = performance.now() - t0;
    ex.venus_free(p);
    return { rc, text: text(ex.wgsl_test_result() >>> 0), ms };
  };
}

/** vk/compiler/wgsl.h's features. */
const WGSL = { TIER2: 1, DUAL_SOURCE: 2, SUBGROUPS: 4, F16: 8, TIER1: 16 };
/** vk/compiler/wgsl_test.c's flag: the fragment stage of a pipeline with sampleShadingEnable. */
const TEST_SAMPLE_SHADING = 1 << 16;

/** Compiles WGSL modules in headless Chromium's WebGPU: each module's errors (empty: none), or undefined without an adapter. */
async function compile(modules: string[]) {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>wgsl</title>'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
    args: (process.env.CHROMIUM_ARGS ?? '--enable-unsafe-webgpu --enable-features=Vulkan').split(' ').filter(Boolean) });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    return await page.evaluate(async (modules) => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return undefined;
      const want = ['clip-distances', 'dual-source-blending', 'shader-f16', 'subgroups', 'texture-formats-tier1', 'texture-formats-tier2'].filter((f) => adapter.features.has(f)) as GPUFeatureName[];
      const device = await adapter.requestDevice({ requiredFeatures: want, requiredLimits: { maxImmediateSize: Math.min(64, (adapter.limits as unknown as Record<string, number>).maxImmediateSize ?? 0) } as Record<string, number> });
      const out: string[] = [];
      for (const code of modules) {
        const m = device.createShaderModule({ code });
        const info = await m.getCompilationInfo();
        out.push(info.messages.filter((x) => x.type === 'error').map((x) => `${x.lineNum}:${x.linePos} ${x.message}`).join('\n'));
      }
      return out;
    }, modules);
  } finally {
    await browser.close();
    server.close();
  }
}

/**
 * Runs a translated compute shader (one workgroup) in headless Chromium's WebGPU: its storage buffers by WGSL binding,
 * each made of `init`'s bytes or `size` zeros, read back after the dispatch. Undefined without an adapter, or without
 * the features `need` names (the adapter's, and its subgroups' sizes, returned too).
 */
async function runCompute(code: string, buffers: { binding: number; init?: Uint8Array; size?: number }[], need: string[] = []) {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>wgsl</title>'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
    args: (process.env.CHROMIUM_ARGS ?? '--enable-unsafe-webgpu --enable-features=Vulkan').split(' ').filter(Boolean) });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    const r = await page.evaluate(async ({ code, buffers, need }) => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter || need.some((f) => !adapter.features.has(f))) return undefined;
      const device = await adapter.requestDevice({ requiredFeatures: need as GPUFeatureName[] });
      const module = device.createShaderModule({ code });
      const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
      if (errors.length) return { errors, out: [] as number[][], min: 0, max: 0 };
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const made = buffers.map((b) => {
        const size = b.init ? b.init.length : b.size!;
        const buffer = device.createBuffer({ size, usage: 0x80 | 0x40 | 0x4 | 0x8 /* STORAGE | UNIFORM | COPY_SRC | COPY_DST */ });
        if (b.init) device.queue.writeBuffer(buffer, 0, new Uint8Array(b.init));
        return { buffer, size };
      });
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: buffers.map((b, i) => ({ binding: b.binding, resource: { buffer: made[i].buffer } })) });
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      const reads = made.map((m) => {
        const read = device.createBuffer({ size: m.size, usage: 0x1 | 0x8 /* MAP_READ | COPY_DST */ });
        enc.copyBufferToBuffer(m.buffer, 0, read, 0, m.size);
        return read;
      });
      device.queue.submit([enc.finish()]);
      const out: number[][] = [];
      for (const read of reads) {
        await read.mapAsync(1 /* GPUMapMode.READ */);
        out.push([...new Uint8Array(read.getMappedRange())]);
      }
      const info = adapter.info as unknown as { subgroupMinSize?: number; subgroupMaxSize?: number };
      return { errors, out, min: info.subgroupMinSize ?? 0, max: info.subgroupMaxSize ?? 0 };
    }, { code, buffers: buffers.map((b) => ({ binding: b.binding, init: b.init && [...b.init], size: b.size })) as unknown as { binding: number; init?: Uint8Array; size?: number }[], need });
    return r && { ...r, out: r.out.map((o) => new Uint8Array(o)) };
  } finally {
    await browser.close();
    server.close();
  }
}

/**
 * Draws a translated fragment shader over a 4×4 rgba8unorm target cleared to blue in headless Chromium's WebGPU, its
 * location 0 input (vec4) the pixel centre's (u, v, 0, 1) with v down; the target's bytes, or undefined without an adapter.
 */
async function runFragment(code: string) {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>wgsl</title>'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
    args: (process.env.CHROMIUM_ARGS ?? '--enable-unsafe-webgpu --enable-features=Vulkan').split(' ').filter(Boolean) });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    const r = await page.evaluate(async (code) => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return undefined;
      const device = await adapter.requestDevice();
      const errors: string[] = [];
      device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
      const fs = device.createShaderModule({ code });
      errors.push(...(await fs.getCompilationInfo()).messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`));
      const vs = device.createShaderModule({ code: `struct V { @builtin(position) p: vec4<f32>, @location(0) c: vec4<f32> }
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let q = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return V(vec4<f32>(q.x * 2.0 - 1.0, 1.0 - q.y * 2.0, 0.0, 1.0), vec4<f32>(q, 0.0, 1.0));
}` });
      const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: vs, entryPoint: 'vs' },
        fragment: { module: fs, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] }, primitive: { topology: 'triangle-list' } });
      const target = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x10 | 0x1 /* RENDER_ATTACHMENT | COPY_SRC */ });
      const read = device.createBuffer({ size: 256 * 4, usage: 0x1 | 0x8 /* MAP_READ | COPY_DST */ });
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 1, 1] }] });
      pass.setPipeline(pipeline);
      pass.draw(3);
      pass.end();
      enc.copyTextureToBuffer({ texture: target }, { buffer: read, bytesPerRow: 256 }, [4, 4]);
      device.queue.submit([enc.finish()]);
      await read.mapAsync(1 /* GPUMapMode.READ */);
      const rows = new Uint8Array(read.getMappedRange());
      const pixels: number[][] = [];
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) pixels.push([...rows.subarray(y * 256 + x * 4, y * 256 + x * 4 + 4)]);
      return { errors, pixels };
    }, code);
    return r;
  } finally {
    await browser.close();
    server.close();
  }
}

/** An IEEE half's bits as a number, and a number to a half's bits rounded to the nearest even. */
function fromHalf(h: number) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
  return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
}
function toHalf(x: number) {
  if (Number.isNaN(x)) return 0x7e00;
  const sign = x < 0 || Object.is(x, -0) ? 0x8000 : 0, a = Math.abs(x);
  // The largest finite half at most `a` (the positive halves' values grow with their bits), then the nearer of it and
  // the next (Infinity counting as 65536 there), a tie to the even one.
  let lo = 0, hi = 0x7bff;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fromHalf(mid) <= a) lo = mid; else hi = mid - 1; }
  const below = fromHalf(lo), above = lo === 0x7bff ? 65536 : fromHalf(lo + 1);
  const up = a - below > above - a || (a - below === above - a && (lo & 1) === 1);
  return sign | (up ? lo + 1 : lo);
}

const missing = !existsSync(MODULE) ? 'SKIPPED: run vk/build.sh' : false;

test('every stage translates to WGSL that Chromium compiles, or fails for a reason outside the direct set', { skip: missing, timeout: 10 * 60_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const all = stages(tmp);
    if (!all.length) return t.skip('SKIPPED: no stages (glslc for the scene\'s, or target/vk1/spirv)');
    const translate = await translator();
    const done = all.map((s) => ({ s, ...translate(s) }));
    const bad = done.filter((d) => d.rc && !OUTSIDE.test(d.text));
    assert.deepEqual(bad.map((d) => `${d.s.name}: ${d.text}`), [], 'stages that failed to translate');
    const ok = done.filter((d) => !d.rc);
    const errors = await compile(ok.map((d) => d.text));
    if (!errors) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    const failed = ok.map((d, i) => ({ d, e: errors[i] })).filter((x) => x.e);
    const ms = ok.map((d) => d.ms).sort((a, b) => a - b);
    console.log(`${ok.length} of ${all.length} stages translated (median ${ms[ms.length >> 1].toFixed(2)} ms, max ${ms[ms.length - 1].toFixed(1)}), ${ok.length - failed.length} compiled`);
    for (const d of done.filter((d) => d.rc)) console.log(`  not translated, outside the direct set: ${basename(d.s.name)}: ${d.text}`);
    assert.deepEqual(failed.map((x) => `${x.d.s.name}: ${x.e.split('\n')[0]}`), [], 'WGSL Chromium rejected');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a storage image loaded and stored is read_write where WebGPU allows it, and refused where it doesn\'t (VK3 L4c-F)', { skip: missing || (spawnSync('glslc', ['--version']).status !== 0 && 'SKIPPED: no glslc'), timeout: 120_000 }, async (t) => {
  // The review's "storage access WebGPU refuses": rg16float or rgba8unorm printed read_write made an invalid module.
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const stage = (format: string, features?: number) => {
      const spv = join(tmp, `${format}.spv`);
      const r = spawnSync('glslc', ['--target-env=vulkan1.2', `-DSTORAGE_RW_FORMAT=${format}`, '-fshader-stage=comp', '-o', spv, join(root, 'tests/venus/storage-rw.comp')], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const b = readFileSync(spv);
      return translate({ name: format, stage: 5, words: new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)) }, { features });
    };
    const ok = stage('r32f');
    assert.equal(ok.rc, 0, ok.text);
    assert.match(ok.text, /texture_storage_2d<r32float, read_write>/);
    // What WebGPU gives no read-write texture of goes by the image's words (VK4 T11).
    for (const format of ['rgba8', 'rg16f', 'rg32f']) {
      const r = stage(format);
      assert.equal(r.rc, 0, `${format}: ${r.text.slice(0, 200)}`);
      assert.match(r.text, /var<storage, read_write> r0_0: array<atomic<u32>>/);
      assert.doesNotMatch(r.text, /texture_storage/);
    }
    // With texture-formats-tier2 (VK3 L5): tier2's formats read_write, the others still words.
    const t2: string[] = [];
    for (const [format, name] of [['rgba8', 'rgba8unorm'], ['r16f', 'r16float'], ['rgba16f', 'rgba16float'], ['r8', 'r8unorm'], ['rgba32f', 'rgba32float']]) {
      const r = stage(format, WGSL.TIER2);
      assert.equal(r.rc, 0, `${format}: ${r.text.slice(0, 200)}`);
      assert.match(r.text, new RegExp(`texture_storage_2d<${name}, read_write>`));
      t2.push(r.text);
    }
    for (const format of ['rg16f', 'rg32f', 'rgba8_snorm']) {
      const r = stage(format, WGSL.TIER2);
      assert.equal(r.rc, 0, `${format}: ${r.text.slice(0, 200)}`);
      assert.doesNotMatch(r.text, /texture_storage/);
    }
    const errors = await compile([ok.text, ...t2]);
    if (!errors) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(errors[0], '', 'WGSL Chromium rejected');
    // Tier2's compile where the adapter has it (the Mac's; SwiftShader refuses read_write of those formats).
    for (const e of errors.slice(1)) if (!/read_write|access|storage/.test(e)) assert.equal(e, '', 'WGSL Chromium rejected');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('built-ins WGSL has translate to its own, and a compare-exchange is strong (the review of the translator)', { skip: missing || (spawnSync('glslc', ['--version']).status !== 0 && 'SKIPPED: no glslc'), timeout: 120_000 }, async (t) => {
  // Findings 1 and 6: packHalf2x16 and unpackHalf2x16 went through 16-bit values (ldexp, which NIR lowers to bits,
  // translated already); atomicCompSwap was WGSL's weak exchange, which may fail spuriously.
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const spv = join(tmp, 'builtins.spv');
    const c = spawnSync('glslc', ['--target-env=vulkan1.2', '-o', spv, join(root, 'tests/venus/builtins.comp')], { encoding: 'utf8' });
    assert.equal(c.status, 0, c.stderr);
    const b = readFileSync(spv);
    const r = translate({ name: 'builtins', stage: 5, words: new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)) });
    assert.equal(r.rc, 0, r.text);
    for (const re of [/pack2x16float\(/, /unpack2x16float\(/, /loop \{\s*let wg_cas = atomicCompareExchangeWeak/]) assert.match(r.text, re);
    const errors = await compile([r.text]);
    if (!errors) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(errors, [''], 'WGSL Chromium rejected');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the out-of-context review of the translator: what L4f fixed (VK3)', { skip: missing || (spawnSync('glslc', ['--version']).status !== 0 && 'SKIPPED: no glslc'), timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const stage = (file: string, env = 'vulkan1.2') => {
      const spv = join(tmp, `${basename(file)}.spv`);
      const r = spawnSync('glslc', [`--target-env=${env}`, '-o', spv, join(root, file)], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const b = readFileSync(spv);
      return translate({ name: file, stage: stageOf(file), words: new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)) });
    };
    const ok = (file: string, env?: string) => {
      const r = stage(file, env);
      assert.equal(r.rc, 0, `${file}: ${r.text}`);
      return r.text;
    };
    const dir = 'tests/venus/l4f';
    // 3: dual-source blending as WGSL's @blend_src.
    const dual = ok(`${dir}/dual.frag`);
    assert.match(dual, /enable dual_source_blending;/);
    assert.match(dual, /@location\(0\) @blend_src\(0\) f0: vec4<f32>,\s*@location\(0\) @blend_src\(1\) f0b: vec4<f32>,/);
    // 4: a buffer the fragment stage only reads is read-only there, though the stage writes another.
    const ssbo = ok(`${dir}/ssbo-read.frag`);
    assert.match(ssbo, /@group\(0\) @binding\(0\) var<storage, read> r0_0/);
    assert.match(ssbo, /texture_storage_2d<r32uint, write>/);
    // 5: signed shared atomics on atomic<i32>; signed and unsigned ones on shared memory refused.
    assert.match(ok(`${dir}/shared-signed.comp`), /var<workgroup> shm: array<atomic<i32>, 1>;/);
    const mixed = stage(`${dir}/shared-mixed.comp`);
    assert.equal(mixed.rc, 3, mixed.text.slice(0, 200));
    assert.equal(mixed.text, 'signed and unsigned atomic min or max on one array');
    // 11: a terminate (SPIR-V 1.6's discard) leaves the shader; a demoted invocation is a helper.
    const term = ok(`${dir}/terminate.frag`, 'vulkan1.3');
    assert.match(term, /discard; return( o)?;/);
    const demote = ok(`${dir}/demote.frag`, 'vulkan1.3');
    assert.match(demote, /discard; wg_helper = true;/);
    assert.match(demote, /= wg_helper \|\| smask == 0u;/);
    // 12: one workgroup variable for every uniform condition.
    const conds = ok(`${dir}/uniform-conds.comp`);
    assert.equal(conds.match(/var<workgroup> wg_uc/g)?.length, 1, conds);
    assert.equal(conds.match(/workgroupUniformLoad\(&wg_uc\)/g)?.length, 2);
    // 2: a cube array's size in cubes.
    assert.match(ok(`${dir}/cube-array.comp`), /textureNumLayers\(r0_0\) \/ 6u\)/);
    // 8: texture and sampler indexed apart: each of the 4 textures with each of the 2 samplers.
    const sep = ok(`${dir}/separate.frag`);
    assert.equal(sep.match(/textureSample\(/g)?.length, 8, sep);
    // The inverted depth range's override in every vertex shader (the driver review's 12).
    const vert = ok('tests/venus/driver.vert');
    assert.match(vert, /override wg_flip_z: bool = false;/);
    assert.match(vert, /if \(wg_flip_z\) \{ o\.pos\.z = o\.pos\.w - o\.pos\.z; \}/);
    const modules = [ssbo, ok(`${dir}/shared-signed.comp`), term, demote, conds, ok(`${dir}/cube-array.comp`), sep, vert];
    const errors = await compile(modules);
    if (!errors) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(errors, modules.map(() => ''), 'WGSL Chromium rejected');
    // @blend_src compiles where the adapter has dual-source-blending (the Mac's, not SwiftShader's).
    const [dualErrors] = (await compile([dual]))!;
    if (!/dual_source_blending/.test(dualErrors)) assert.equal(dualErrors, '', 'WGSL Chromium rejected');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/** A GLSL stage of tests/venus/ compiled with glslc and translated for `device`. */
function glslStage(translate: Awaited<ReturnType<typeof translator>>, tmp: string, file: string, device: Device = {}, env = 'vulkan1.2', defines: string[] = []) {
  const spv = join(tmp, `${basename(file)}.spv`);
  const r = spawnSync('glslc', [`--target-env=${env}`, ...defines.map((d) => `-D${d}`), '-o', spv, join(root, file)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const b = readFileSync(spv);
  return translate({ name: file, stage: stageOf(file), words: new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)) }, device);
}

const noGlslc = missing || (spawnSync('glslc', ['--version']).status !== 0 && 'SKIPPED: no glslc');

test('subgroup operations are WGSL\'s where the device has subgroups of one size, of one invocation otherwise, and run right (VK3 L5, GD G1)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    // Every family the device advertises, each of WGSL's built-ins where WGSL has one.
    const all = glslStage(translate, tmp, 'tests/venus/l5/subgroups.comp', { features: WGSL.DUAL_SOURCE | WGSL.SUBGROUPS, subgroupSize: 4 });
    assert.equal(all.rc, 0, all.text);
    assert.match(all.text, /enable subgroups;\ndiagnostic\(off, subgroup_uniformity\);/);
    assert.match(all.text, /@builtin\(subgroup_invocation_id\) sg_inv: u32/);
    // Subgroup ids as runs of local_invocation_index.
    assert.match(all.text, /= lidx \/ sg_size;/);
    assert.match(all.text, /= \(64u \+ sg_size - 1u\) \/ sg_size;/);
    for (const f of ['subgroupBallot', 'subgroupAll', 'subgroupAny', 'subgroupElect', 'subgroupBroadcastFirst', 'subgroupAdd', 'subgroupMul', 'subgroupMin', 'subgroupMax',
      'subgroupAnd', 'subgroupOr', 'subgroupXor', 'subgroupInclusiveAdd', 'subgroupExclusiveMul', 'subgroupShuffle', 'subgroupShuffleXor', 'subgroupShuffleUp',
      'subgroupShuffleDown', 'quadBroadcast', 'quadSwapX', 'quadSwapY', 'quadSwapDiagonal']) assert.match(all.text, new RegExp(`\\b${f}\\(`), f);
    // WGSL's subgroupBroadcast wants a constant lane: a read of one invocation is a shuffle.
    assert.doesNotMatch(all.text, /subgroupBroadcast\(/);
    // Without the device's subgroups (or with sizes that vary), subgroups of one: the device advertises the basic
    // operations, but every family translates, each its value on a subgroup of one invocation (GD G1: Godot's Forward+
    // uses `subgroupBroadcastFirst(subgroupMin(…))` whatever the device advertises), and none of WGSL's built-ins.
    const one = glslStage(translate, tmp, 'tests/venus/l5/subgroups.comp');
    assert.equal(one.rc, 0, one.text.slice(0, 200));
    assert.doesNotMatch(one.text, /enable subgroups|\bsubgroup[A-Z]\w*\(|\bquad[A-Z]\w*\(/);
    const errors = await compile([all.text, one.text]);
    if (!errors) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    if (!/subgroups/.test(errors[0])) assert.equal(errors[0], '', 'WGSL Chromium rejected');
    assert.equal(errors[1], '', 'WGSL Chromium rejected (subgroups of one)');

    // Run: each invocation's results against its subgroup's (members by their first invocation, in their order).
    const run = async (size: number) => {
      const r = glslStage(translate, tmp, 'tests/venus/l5/subgroups-run.comp', { features: WGSL.SUBGROUPS, subgroupSize: size });
      assert.equal(r.rc, 0, r.text);
      return runCompute(r.text, [{ binding: 0, size: 64 * 16 * 4 }], ['subgroups']);
    };
    // Each invocation's results against its subgroup's of `sgSize` (1: every invocation its own).
    const check = (r: NonNullable<Awaited<ReturnType<typeof runCompute>>>, sgSize: number, what: string) => {
      assert.deepEqual(r.errors, [], what);
      const o = new Uint32Array(r.out[0].buffer);
      const at = (n: number, k: number) => o[n * 16 + k];
      const groups = new Map<number, number[]>();
      for (let n = 0; n < 64; n++) groups.set(at(n, 2), [...(groups.get(at(n, 2)) ?? []), n]);
      const bad: string[] = [];
      for (let n = 0; n < 64; n++) {
        const g = groups.get(at(n, 2))!.sort((a, b) => at(a, 0) - at(b, 0));
        const inv = at(n, 0), size = at(n, 1), lane = (i: number) => g.find((m) => at(m, 0) === i)!;
        const want = [inv, sgSize, g[0], g.reduce((a, b) => a + b, 0), g.filter((m) => at(m, 0) <= inv).reduce((a, b) => a + b, 0),
          g.filter((m) => at(m, 0) < inv).reduce((a, m) => Math.max(a, m * 7 % 5), 0), g.filter((m) => m & 1).length,
          lane(inv ^ 1), inv >= 1 ? lane(inv - 1) : undefined, lane(inv & ~1) + lane(inv | 1), lane(inv ^ 1), lane((inv & ~3) | 3),
          (Math.min(...g) - 40) >>> 0, inv, 1 + (inv === 0 ? 2 : 0), lane(size - 1 - inv)];
        // A lane past the subgroup (a cluster or quad wider than it: undefined in Vulkan) is no expectation.
        want.forEach((w, k) => { if (w !== undefined && !Number.isNaN(w) && at(n, k) !== w) bad.push(`invocation ${n} result ${k}: ${at(n, k)}, not ${w}`); });
      }
      assert.deepEqual(bad.slice(0, 8), [], `${what}: of ${bad.length}`);
    };
    // Subgroups of one, on any adapter (no WGSL subgroups).
    const r1 = glslStage(translate, tmp, 'tests/venus/l5/subgroups-run.comp');
    assert.equal(r1.rc, 0, r1.text);
    check((await runCompute(r1.text, [{ binding: 0, size: 64 * 16 * 4 }]))!, 1, 'subgroups of one');
    let res = await run(4);
    if (!res) return t.skip('SKIPPED: the adapter has no subgroups');
    if (res.min !== res.max) return t.skip(`SKIPPED: the adapter's subgroups vary in size (${res.min}-${res.max})`);
    if (res.min !== 4) res = (await run(res.min))!;
    check(res, res.min, `subgroups of ${res.min}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('values are lets where their uses allow, vars where they leave their scope or a loop carries them (GD G2)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const r = glslStage(translate, tmp, 'tests/venus/g2/values.comp');
    assert.equal(r.rc, 0, r.text);
    // Few vars (Tint's uniformity analysis visits each in scope at every loop, break and if), no run-once loop (pick's
    // early returns), floats as f32 values.
    const vars = r.text.match(/\bvar t\d+/g)?.length ?? 0, lets = r.text.match(/\blet t\d+/g)?.length ?? 0;
    assert.ok(lets > 4 * vars, `${lets} lets, ${vars} vars`);
    assert.equal(r.text.match(/\bloop \{/g)?.length, 5, 'the program\'s five loops (no loop that runs once)');
    assert.match(r.text, /let t\d+: f32 = /);
    // `last`, which its loop carries from an undefined first value (no store before the loop), declared outside the
    // loop: inside, each iteration would start it at 0 (WGSL's zero value; SwiftShader's path happens to keep it).
    const lines = r.text.split('\n'), indent = (l: string) => l.length - l.trimStart().length;
    const tag = lines.find((l) => /= 0x1234u;$/.test(l))?.match(/t\d+/)?.[0];
    const sum = tag && lines.find((l) => new RegExp(`^ *let (t\\d+): u32 = \\((t\\d+ \\+ ${tag}|${tag} \\+ t\\d+)\\);$`).test(l))?.match(/let (t\d+)/)?.[1];
    const store = sum ? lines.findIndex((l) => new RegExp(`^ *t\\d+ = ${sum};$`).test(l)) : -1;
    assert.ok(store > 0, 'last\'s store');
    const reg = lines[store].trim().split(' ')[0];
    const head = lines.slice(0, store).findLastIndex((l) => l.trim() === 'loop {' && indent(l) < indent(lines[store]));
    const decl = lines.findIndex((l) => l.trim() === `var ${reg}: u32;`);
    assert.ok(decl >= 0 && decl < head && indent(lines[decl]) <= indent(lines[head]), `${reg} declared outside its loop`);
    const res = await runCompute(r.text, [{ binding: 0, size: 64 * 9 * 4 }]);
    if (!res) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(res.errors, []);
    const o = new Uint32Array(res.out[0].buffer);
    const pick = (n: number) => n % 3 === 0 ? Math.imul(n, 5) >>> 0 : n % 3 === 1 ? (n + 7 > 40 ? n + 7 : (n + 7) * 2) : (n ^ 0x55) >>> 0;
    const bits = (x: number) => new Uint32Array(new Float32Array([x]).buffer)[0];
    const bad: string[] = [];
    for (let n = 0; n < 64; n++) {
      let sum = 0, last = 0;
      for (let i = 0; i < (n & 7) + 2; i++) {
        if (i > 0) sum = (sum + Math.imul(last, i)) >>> 0;
        last = (i * n + 4660) >>> 0;
      }
      let found = 0, at = 0;
      for (let i = 0; i < 32; i++) {
        at = i * 3 + n;
        if ((at & 15) === 9) { found = 1; break; }
      }
      let total = 0;
      for (let i = 0; i < 4; i++) {
        let inner = i;
        for (let j = 0; j <= (n + i) % 5; j++) inner += j * 2;
        total = (Math.imul(total, 3) + inner) >>> 0;
      }
      const f = Math.fround(n * 0.5 + 1), g = Math.fround(Math.fround(f * f) - (n & 3));
      const want = [(pick(n) + pick(n + 1)) >>> 0, sum, at + found * 1000, total, bits(Math.fround(g / 2)), (n * -3 + 7) >>> 0,
        (n - 30 < 0 ? 1 : 0) + (n * 2 === 40 ? 2 : 0), n < 32 ? pick(n * 2) : Math.trunc(f)];
      let x = n, y = 1;
      for (let i = 0; i < (n & 3) + 3; i++) [x, y] = [y + i, x];
      want.push(x * 100 + y);
      want.forEach((w, k) => { if (o[n * 9 + k] !== w) bad.push(`invocation ${n} result ${k}: ${o[n * 9 + k]}, not ${w}`); });
    }
    assert.deepEqual(bad.slice(0, 8), [], `of ${bad.length}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('16-bit storage on every adapter, 16-bit floats with shader-f16, and scratch arrays (VK3 L5)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    // 16-bit storage: halves of words, a buffer with 16-bit stores atomic (two invocations store a word's halves),
    // conversions without f16.
    const st = glslStage(translate, tmp, 'tests/venus/l5/storage16.comp');
    assert.equal(st.rc, 0, st.text);
    assert.doesNotMatch(st.text, /enable f16|f16/);
    assert.match(st.text, /var<storage, read_write> r0_2: array<atomic<u32>>;/);
    assert.match(st.text, /unpack2x16float\(/);
    // 16-bit floats only with shader-f16, as f16 views of a word's low half.
    const f16 = glslStage(translate, tmp, 'tests/venus/l5/f16.comp', { features: WGSL.DUAL_SOURCE | WGSL.F16 });
    assert.equal(f16.rc, 0, f16.text);
    assert.match(f16.text, /enable f16;/);
    assert.match(f16.text, /bitcast<vec2<f16>>\(t\d+\)\.x/);
    const no16 = glslStage(translate, tmp, 'tests/venus/l5/f16.comp');
    assert.equal(no16.rc, 3, no16.text.slice(0, 200));
    assert.equal(no16.text, '16-bit float arithmetic without the device\'s shader-f16');

    // Run 16-bit storage: In { float16_t h[64]; f16vec2 h2[64]; uint16_t s[64]; int16_t si[64]; },
    // Out { float16_t h[64]; float f[64]; uint u[64]; int16_t si[64]; }.
    const input = new DataView(new ArrayBuffer(640));
    const halves = (n: number) => [toHalf(Math.fround((n - 30) * 1.37)), toHalf(n * 1e-6), toHalf(65000 - n * 50 + 0.25)];
    for (let n = 0; n < 64; n++) {
      const [a, b, c] = halves(n);
      input.setUint16(2 * n, a, true);
      input.setUint16(128 + 4 * n, b, true);
      input.setUint16(128 + 4 * n + 2, c, true);
      input.setUint16(384 + 2 * n, 65535 - n * 1000 % 65536, true);
      input.setInt16(512 + 2 * n, -32768 + n * 1031, true);
    }
    const res = await runCompute(st.text, [{ binding: 0, init: new Uint8Array(input.buffer) }, { binding: 2, size: 768 }]);
    if (!res) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(res.errors, []);
    const out = new DataView(res.out[1].buffer);
    const bad: string[] = [];
    for (let n = 0; n < 64; n++) {
      const [a, , c] = halves(n);
      const x = Math.fround(Math.fround(fromHalf(a) * 2) + fromHalf(c));
      const si = input.getInt16(512 + 2 * n, true);
      const want: [string, number, number][] = [['h', out.getUint16(2 * n, true), toHalf(x)], ['f', out.getFloat32(128 + 4 * n, true), x],
        ['u', out.getUint32(384 + 4 * n, true), (input.getUint16(384 + 2 * n, true) + si) >>> 0], ['si', out.getInt16(640 + 2 * n, true), (si * 3) << 16 >> 16]];
      for (const [k, got, w] of want) if (got !== w && !(Number.isNaN(got) && Number.isNaN(w))) bad.push(`${k}[${n}]: ${got}, not ${w}`);
    }
    assert.deepEqual(bad.slice(0, 8), [], `of ${bad.length}`);
    // A function-scope array in scratch: its offset is the whole address (scratch has no base: the printer read the
    // alignment there, and the last element's last word went past the array).
    const sc = glslStage(translate, tmp, 'tests/venus/l5/scratch.comp');
    assert.equal(sc.rc, 0, sc.text);
    const scr = (await runCompute(sc.text, [{ binding: 0, size: 64 * 16 }]))!;
    assert.deepEqual(scr.errors, []);
    const so = new Uint32Array(scr.out[0].buffer);
    const wrong = [...so].map((v, k) => [k, v, (k >> 2) * 16 + (((k >> 2) + 3) & 3) * 4 + (k & 3)]).filter(([, v, w]) => v !== w);
    assert.deepEqual(wrong.slice(0, 4), [], `of ${wrong.length}`);
    // 16-bit floats compile where the adapter has shader-f16 (the Mac's, not SwiftShader's).
    const [errors] = (await compile([f16.text]))!;
    if (!/f16/.test(errors)) assert.equal(errors, '', 'WGSL Chromium rejected');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('8-bit storage and 8- and 16-bit integer arithmetic at 32 bits, bytes of words (VK4 T29)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const r = glslStage(translate, tmp, 'tests/venus/t29/int8.comp');
    assert.equal(r.rc, 0, r.text);
    // Byte stores to a buffer whose words other invocations share: atomics on the word.
    assert.match(r.text, /var<storage, read_write> r0_4: array<atomic<u32>>;/);
    // In { uint8_t u[64]; int8_t s[64]; i8vec4 v[64]; }, U { uint8_t k; int8_t ks; } (std140),
    // Out { uint8_t u[64]; int8_t s[64]; int w[64]; uint x[64]; int16_t h[64]; float f[64]; }.
    const input = new DataView(new ArrayBuffer(384));
    for (let n = 0; n < 64; n++) {
      input.setUint8(n, (n * 37 + 11) & 255);
      input.setInt8(64 + n, ((n * 53) & 255) - 128);
      for (let k = 0; k < 4; k++) input.setInt8(128 + 4 * n + k, ((n * 29 + k * 71) & 255) - 128);
    }
    const ubo = new Uint8Array(16);
    ubo[0] = 200;
    ubo[1] = 0x85; // -123
    const res = await runCompute(r.text, [{ binding: 0, init: new Uint8Array(input.buffer) }, { binding: 2, init: ubo }, { binding: 4, size: 1024 }]);
    if (!res) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(res.errors, []);
    const out = new DataView(res.out[2].buffer);
    const bad: string[] = [];
    for (let n = 0; n < 64; n++) {
      const a = input.getUint8(n), b = (n * 7) & 255, c = input.getInt8(64 + n);
      const v = [0, 1, 2, 3].map((k) => input.getInt8(128 + 4 * n + k));
      const h = ((c * 300 + a) << 16) >> 16;
      const want: [string, number, number][] = [
        ['u', out.getUint8(n), (a * b + 200) & 255],
        ['s', out.getInt8(64 + n), ((Math.trunc(c / 3) - (c >> 1) - 123) << 24) >> 24],
        ['w', out.getInt32(128 + 4 * n, true), v[0] + v[1] * 2 + v[2] * 4 + v[3] * 8],
        ['x', out.getUint32(384 + 4 * n, true), Math.max(a, b) | (c & 255) << 8],
        ['h', out.getInt16(640 + 2 * n, true), ((Math.trunc(h / 7) + (h & 0xffff) % 5) << 16) >> 16],
        ['f', out.getFloat32(768 + 4 * n, true), c + a * 0.5]];
      for (const [k, got, w] of want) if (got !== w) bad.push(`${k}[${n}]: ${got}, not ${w}`);
    }
    assert.deepEqual(bad.slice(0, 8), [], `of ${bad.length}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('64-bit subgroup reductions and scans are shuffles of words, WGSL\'s built-ins taking none (VK4 T29)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const run = async (size: number) => {
      const r = glslStage(translate, tmp, 'tests/venus/t29/subgroup64.comp', { features: WGSL.SUBGROUPS, subgroupSize: size });
      assert.equal(r.rc, 0, r.text);
      return runCompute(r.text, [{ binding: 0, size: 64 * 32 }], ['subgroups']);
    };
    let res = await run(4);
    if (!res) return t.skip('SKIPPED: the adapter has no subgroups');
    if (res.min !== res.max) return t.skip(`SKIPPED: the adapter's subgroups vary in size (${res.min}-${res.max})`);
    if (res.min !== 4) res = (await run(res.min))!;
    assert.deepEqual(res.errors, []);
    // Subgroups as runs of local_invocation_index (as on SwiftShader and Metal: the subgroup test's).
    const M = (1n << 64n) - 1n, size = res.min;
    const value = (n: number) => (BigInt(Math.imul(n, 2654435761) >>> 0) << 32n) | BigInt(n ^ 0x5a);
    const out = new DataView(res.out[0].buffer);
    const bad: string[] = [];
    for (let n = 0; n < 64; n++) {
      const g = Array.from({ length: size }, (_, i) => (n - n % size) + i).map(value), mine = g.slice(0, n % size + 1);
      const want = [g.reduce((a, b) => (a > b ? a : b)), g.reduce((a, b) => (a < b ? a : b)), g.reduce((a, b) => (a * (b | 1n)) & M, 1n), mine.reduce((a, b) => (a + b) & M, 0n)];
      want.forEach((w, k) => { const got = out.getBigUint64(32 * n + 8 * k, true); if (got !== w) bad.push(`invocation ${n} result ${k}: ${got}, not ${w}`); });
    }
    assert.deepEqual(bad.slice(0, 8), [], `of ${bad.length}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('floats convert to 32-bit integers saturating exactly, a half\'s infinity too (VK4 T29)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const r = glslStage(translate, tmp, 'tests/venus/t29/fconvert.comp');
    assert.equal(r.rc, 0, r.text);
    // In { float f[16]; float16_t h[16]; }, Out { int fi[16]; uint fu[16]; int hi[16]; uint hu[16]; }: in range, at and
    // past the bounds, infinities (negative values to uint are undefined in Vulkan: only 0 and up are checked there).
    const fs = [0, 1.5, -1.5, 2147483520, 2147483648, 3.4e38, Infinity, -Infinity, -2147483648, -3e9, 4294967040, 4294967296, 1e20, 65504, 100.75, 7];
    const hs = [0, 1.5, -1.5, 65504, -65504, Infinity, -Infinity, 1000, 2, 3, 4, 5, 6, 7, 8, 9];
    const input = new DataView(new ArrayBuffer(96));
    fs.forEach((f, n) => input.setFloat32(4 * n, f, true));
    hs.forEach((h, n) => input.setUint16(64 + 2 * n, toHalf(h), true));
    const res = await runCompute(r.text, [{ binding: 0, init: new Uint8Array(input.buffer) }, { binding: 2, size: 256 }]);
    if (!res) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(res.errors, []);
    const out = new DataView(res.out[1].buffer);
    const sat = (x: number, lo: number, hi: number) => Math.trunc(Math.min(hi, Math.max(lo, x)));
    const bad: string[] = [];
    for (let n = 0; n < 16; n++) {
      const f = Math.fround(fs[n]), h = hs[n];
      const want: [string, number, number | undefined][] = [
        ['fi', out.getInt32(4 * n, true), sat(f, -2147483648, 2147483647)],
        ['fu', out.getUint32(64 + 4 * n, true), f >= 0 ? sat(f, 0, 4294967295) : undefined],
        ['hi', out.getInt32(128 + 4 * n, true), sat(h, -2147483648, 2147483647)],
        ['hu', out.getUint32(192 + 4 * n, true), h >= 0 ? sat(h, 0, 4294967295) : undefined]];
      for (const [k, got, w] of want) if (w !== undefined && got !== w) bad.push(`${k}[${n}] of ${k[0] === 'f' ? f : h}: ${got}, not ${w}`);
    }
    assert.deepEqual(bad, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/** A 64-bit integer's nearest f32 (ties to even), as Vulkan's conversion rounds it. */
function f32OfBig(x: bigint) {
  const neg = x < 0n, m = neg ? -x : x;
  const bits = m.toString(2).length;
  if (bits <= 24) return Math.fround(Number(x));
  const drop = BigInt(bits - 24), keep = m >> drop, rest = m & ((1n << drop) - 1n), half = 1n << (drop - 1n);
  const r = rest > half || (rest === half && (keep & 1n) === 1n) ? keep + 1n : keep;
  return (neg ? -1 : 1) * Number(r) * 2 ** Number(drop);
}

test('64-bit integers as pairs of words: arithmetic, comparisons, conversions, loads and stores (VK4 T29)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const r = glslStage(translate, tmp, 'tests/venus/t29/int64.comp');
    assert.equal(r.rc, 0, r.text);
    // In { uint64_t a[64]; int64_t b[64]; u64vec2 v[64]; },
    // Out { uint64_t sum[64], mul[64]; int64_t div[64]; uint64_t shl[64], shr[64]; uint lt[64]; float f[64]; int64_t conv[64]; u64vec2 v[64]; }.
    const M = (1n << 64n) - 1n;
    let seed = 0x9e3779b97f4a7c15n;
    const next = () => (seed = (seed * 6364136223846793005n + 1442695040888963407n) & M);
    const input = new DataView(new ArrayBuffer(2048));
    for (let n = 0; n < 64; n++) {
      // Small, near a word's edge and anything, of either sign.
      const a = n % 4 === 0 ? BigInt(n) : n % 4 === 1 ? 0xffffffffn + BigInt(n) : next();
      const b = n % 3 === 0 ? -BigInt(n * 1000 + 1) : n % 3 === 1 ? BigInt.asIntN(64, next()) : BigInt(n) << 40n;
      input.setBigUint64(8 * n, a, true);
      input.setBigInt64(512 + 8 * n, b, true);
      input.setBigUint64(1024 + 16 * n, next(), true);
      input.setBigUint64(1024 + 16 * n + 8, next(), true);
    }
    const res = await runCompute(r.text, [{ binding: 0, init: new Uint8Array(input.buffer) }, { binding: 2, size: 4608 }]);
    if (!res) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(res.errors, []);
    const out = new DataView(res.out[1].buffer);
    const bad: string[] = [];
    for (let n = 0; n < 64; n++) {
      const a = input.getBigUint64(8 * n, true), b = input.getBigInt64(512 + 8 * n, true);
      const v = [input.getBigUint64(1024 + 16 * n, true), input.getBigUint64(1024 + 16 * n + 8, true)];
      const s = BigInt(n % 64);
      const want: [string, bigint | number, bigint | number][] = [
        ['sum', out.getBigUint64(8 * n, true), (a + BigInt.asUintN(64, b) - 1n) & M],
        ['mul', out.getBigUint64(512 + 8 * n, true), (a * 0x100000001n + BigInt(n)) & M],
        ['div', out.getBigInt64(1024 + 8 * n, true), BigInt.asIntN(64, b / BigInt(n + 1) + BigInt.asUintN(64, b) % 7n)],
        ['shl', out.getBigUint64(1536 + 8 * n, true), (a << s) & M],
        ['shr', out.getBigUint64(2048 + 8 * n, true), BigInt.asUintN(64, b >> s) ^ (a >> 3n)],
        ['lt', out.getUint32(2560 + 4 * n, true), (a < BigInt.asUintN(64, b) ? 1 : 0) | (b < 0n ? 2 : 0) | (BigInt.asIntN(64, a) > b ? 4 : 0)],
        ['f', out.getFloat32(2816 + 4 * n, true), f32OfBig(b)],
        ['conv', out.getBigInt64(3072 + 8 * n, true), BigInt.asIntN(64, BigInt(n - 32) * (a & 0xffffffffn))],
        ['v.x', out.getBigUint64(3584 + 16 * n, true), n % 2 === 0 ? v[1] : (v[0] + a) & M],
        ['v.y', out.getBigUint64(3584 + 16 * n + 8, true), n % 2 === 0 ? v[0] : (v[1] + a) & M]];
      for (const [k, got, w] of want) if (got !== w) bad.push(`${k}[${n}]: ${got}, not ${w}`);
    }
    assert.deepEqual(bad.slice(0, 8), [], `of ${bad.length}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('16-bit inputs and outputs are 32-bit ones, converted where loaded and stored (VK4 T29)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const vs = glslStage(translate, tmp, 'tests/venus/t29/io16.vert');
    const fs = glslStage(translate, tmp, 'tests/venus/t29/io16.frag');
    assert.equal(vs.rc, 0, vs.text);
    assert.equal(fs.rc, 0, fs.text);
    const compiled = await compile([vs.text, fs.text]);
    if (!compiled) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(compiled, ['', ''], 'WGSL Chromium rejected');
    // Run: the pixel centre's (u, v) through a 16-bit input and output, swapped and halved at 32 bits (a varying's
    // bits taken as a half's, as before, read nonsense).
    const run = glslStage(translate, tmp, 'tests/venus/t29/io16-run.frag');
    assert.equal(run.rc, 0, run.text);
    const res = await runFragment(run.text);
    if (!res) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(res.errors, []);
    const want = Array.from({ length: 16 }, (_, i) => [Math.round(((i >> 2) + 0.5) / 8 * 255), Math.round(((i & 3) + 0.5) / 8 * 255), 0, 255]);
    assert.deepEqual(res.pixels, want);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('shared memory of atomics filling the workgroup\'s storage, with a barrier under a uniform condition (VK3 L6c)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  // The out-of-context review of L5-L6a's finding 6: maxComputeSharedMemorySize is WebGPU's whole, and this stage
  // failed to translate (the condition's word had nowhere to go). It borrows shared memory's first word through atomics.
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const r = glslStage(await translator(), tmp, 'tests/venus/l6c/shared-atomic-full.comp', {});
    assert.equal(r.rc, 0, r.text);
    assert.match(r.text, /var<workgroup> shm: array<atomic<u32>, 4096>;/);
    assert.doesNotMatch(r.text, /wg_uc/);
    const res = await runCompute(r.text, [{ binding: 0, size: 67 * 4 }]);
    if (!res) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(res.errors, []);
    const v = new Uint32Array(res.out[0].buffer);
    const bad = [...Array(64).keys()].filter((k) => v[1 + k] !== (4095 - k * 64) * 3 + 5);
    assert.deepEqual(bad.slice(0, 8), [], `${bad.length} wrong, v[1] = ${v[1]}`);
    assert.deepEqual([v[65], v[66]], [5, 1 * 3 + 5 + 64], 's[0] restored, s[1] counted');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the out-of-context review of L4f: a compute stage\'s readonly storage buffers read-only, the uniform conditions\' word in the workgroup\'s storage, terminate and demote run (VK3 L5b)', { skip: noGlslc, timeout: 180_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const ok = (file: string, env?: string) => {
      const r = glslStage(translate, tmp, file, {}, env);
      assert.equal(r.rc, 0, `${file}: ${r.text}`);
      return r.text;
    };
    // 2: a compute stage's buffer it declares readonly is read-only (VK3 L6c: the driver binds it as writable storage,
    // in a module of the program's variant, only where a dispatch writes its memory through another binding;
    // tests/venus-driver.test.ts's misc storageAliased, uniformBeside).
    const copy = ok('tests/venus/ssbo-copy.comp');
    assert.match(copy, /@group\(0\) @binding\(0\) var<storage, read> r0_0/);
    assert.match(copy, /@group\(0\) @binding\(2\) var<storage, read_write> r0_2/);
    // A fragment stage's buffers it only reads stay read-only, readonly or not (its scope is the render pass, where
    // vertex stages read storage read-only: dEQP-VK's memory.pipeline_barrier.graphics.host_write_storage_buffer).
    const frag = ok('tests/venus/l5b/storage-frag.frag');
    assert.match(frag, /@group\(0\) @binding\(0\) var<storage, read> r0_0/);
    assert.match(frag, /@group\(0\) @binding\(2\) var<storage, read> r0_2/);
    assert.match(frag, /@group\(0\) @binding\(4\) var<storage, read_write> r0_4/);
    // 4: the uniform condition's word where shared memory fills the workgroup's storage: shared memory's spare word, or
    // its first word saved and restored; then each runs right within WebGPU's default 16384 bytes.
    const slack = ok('tests/venus/l5b/shared-slack.comp');
    assert.match(slack, /var<workgroup> shm: array<u32, 4096>;/);
    assert.match(slack, /workgroupUniformLoad\(&shm\[4095\]\)/);
    assert.doesNotMatch(slack, /wg_uc/);
    const full = ok('tests/venus/l5b/shared-full.comp');
    assert.match(full, /var<workgroup> shm: array<u32, 4096>;/);
    assert.match(full, /let ucs0 = shm\[0\];/);
    assert.doesNotMatch(full, /wg_uc/);
    for (const [code, top] of [[slack, 4094], [full, 4095]] as const) {
      const res = await runCompute(code, [{ binding: 0, size: 66 * 4 }]);
      if (!res) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
      assert.deepEqual(res.errors, []);
      const v = new Uint32Array(res.out[0].buffer);
      const bad = [...Array(64).keys()].filter((k) => v[1 + k] !== (top - k * 64) * 3 + 5);
      assert.deepEqual(bad.slice(0, 8), [], `${bad.length} wrong, v[1] = ${v[1]}`);
      // Shared memory's first word after the condition borrowed it (shared-full.comp's): restored (VK3 L6c, the
      // L5-L6a review's finding 5: the test read only from word 63 up, and the word held 0).
      assert.equal(v[65], 5, 's[0] after the uniform condition');
    }
    // 6: a terminated invocation writes nothing and leaves its loop (else the draw never ends); a demoted one writes
    // nothing, and the others aren't helpers.
    const blue = [0, 0, 255, 255];
    const term = await runFragment(ok('tests/venus/l5b/terminate-run.frag', 'vulkan1.3'));
    assert.ok(term);
    assert.deepEqual(term.errors, []);
    for (let i = 0; i < 16; i++) {
      const x = i & 3, y = i >> 2, px: number[] = term.pixels[i];
      if (x >= 2) assert.deepEqual(px, blue, `terminate: pixel ${x},${y}`);
      else assert.ok(Math.abs(px[0] - ((x + 0.5) / 4) * 255) <= 1 && Math.abs(px[1] - ((y + 0.5) / 4) * 255) <= 1 && px[2] === 0 && px[3] === 255, `terminate: pixel ${x},${y}: ${px}`);
    }
    const demote = await runFragment(ok('tests/venus/l4f/demote.frag', 'vulkan1.3'));
    assert.ok(demote);
    assert.deepEqual(demote.errors, []);
    for (let i = 0; i < 16; i++) assert.deepEqual(demote.pixels[i], i >> 2 >= 2 ? blue : [0, 0, 0, 0], `demote: pixel ${i & 3},${i >> 2}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('arrays of uniform and storage buffers and of storage images indexed dynamically are chosen from, and run right (VK3 L7.1)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const buf = glslStage(translate, tmp, 'tests/venus/l7/dyn-buffers.comp');
    assert.equal(buf.rc, 0, buf.text);
    // Each element a binding of its own (slots: sel 0, d 1-3, outs 4-5, u 6-7).
    for (const b of [2, 4, 6]) assert.match(buf.text, new RegExp(`@group\\(0\\) @binding\\(${b}\\) var<storage, read> r0_${b}:`));
    for (const b of [8, 10]) assert.match(buf.text, new RegExp(`@group\\(0\\) @binding\\(${b}\\) var<storage, read_write> r0_${b}:`));
    for (const b of [12, 14]) assert.match(buf.text, new RegExp(`@group\\(0\\) @binding\\(${b}\\) var<uniform> r0_${b}:`));
    const img = glslStage(translate, tmp, 'tests/venus/l7/dyn-images.comp');
    assert.equal(img.rc, 0, img.text);
    for (const b of [2, 4, 6]) assert.match(img.text, new RegExp(`@group\\(0\\) @binding\\(${b}\\) var r0_${b}: texture_storage_2d<r32uint, read_write>;`));
    const errors = await compile([buf.text, img.text]);
    if (!errors) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(errors, ['', ''], 'WGSL Chromium rejected');

    // Run the buffers': each invocation's elements by its data, the runtime array's length of the chosen one.
    const sel = new Uint32Array(64).map((_, i) => (i * 7 + (i >> 3)) % 3);
    const words = (n: number, f: (i: number) => number) => new Uint8Array(new Uint32Array(n).map((_, i) => f(i)).buffer);
    const uni = (m: number) => words(16, (w) => (w & 3) === 0 ? 100 * m + (w >> 2) : 0xdead);
    const res = await runCompute(buf.text, [{ binding: 0, init: new Uint8Array(sel.buffer) },
      ...[0, 1, 2].map((k) => ({ binding: 2 + 2 * k, init: words(64 + 16 * k, (i) => k * 1000 + i) })),
      { binding: 8, size: 65 * 4 }, { binding: 10, size: 65 * 4 }, { binding: 12, init: uni(0) }, { binding: 14, init: uni(1) }]);
    assert.ok(res);
    assert.deepEqual(res.errors, []);
    const outs = [res.out[4], res.out[5]].map((o) => new Uint32Array(o.buffer));
    const bad: string[] = [];
    const cnt = [0, 0];
    for (let i = 0; i < 64; i++) {
      const k = sel[i], j = i & 1;
      cnt[j] += k + 1;
      const want = (k * 1000 + i) * 10 + 64 + 16 * k + 100 * (k & 1) + (i & 3);
      if (outs[j][1 + i] !== want) bad.push(`o[${j}][${i}]: ${outs[j][1 + i]}, not ${want}`);
    }
    assert.deepEqual(bad.slice(0, 8), [], `of ${bad.length}`);
    assert.deepEqual([outs[0][0], outs[1][0]], cnt, 'the atomics');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a fragment stage at the sample rate reads its inputs at their sample and WGSL\'s sample_index (VK3 L7.1)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const file = 'tests/venus/l7/sample-shading.frag';
    const at = (text: string, loc: number) => text.match(new RegExp(`@location\\(${loc}\\) (@interpolate\\([^)]*\\))`))?.[1];
    const per = (text: string) => [at(text, 0), at(text, 1), at(text, 2), at(text, 3), /@builtin\(sample_index\) sid: u32/.test(text)];
    const want = ['@interpolate(perspective, sample)', '@interpolate(perspective, centroid)', '@interpolate(flat)', '@interpolate(linear, sample)', true];
    // Per pixel by default.
    const pixel = glslStage(translate, tmp, file);
    assert.equal(pixel.rc, 0, pixel.text);
    assert.deepEqual(per(pixel.text), ['@interpolate(perspective, center)', '@interpolate(perspective, centroid)', '@interpolate(flat)', '@interpolate(linear, center)', false]);
    // The pipeline's sample shading, and a read of gl_SampleID (Vulkan: the minimum at 1).
    const shading = glslStage(translate, tmp, file, { features: WGSL.DUAL_SOURCE | TEST_SAMPLE_SHADING });
    assert.equal(shading.rc, 0, shading.text);
    assert.deepEqual(per(shading.text), want);
    const id = glslStage(translate, tmp, file, {}, 'vulkan1.2', ['SAMPLE_ID']);
    assert.equal(id.rc, 0, id.text);
    assert.deepEqual(per(id.text), want);
    const errors = await compile([shading.text, id.text]);
    if (!errors) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(errors, ['', ''], 'WGSL Chromium rejected');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('interpolateAtOffset and interpolateAtSample move the input along its derivatives (VK3 L7b)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  // The review of L6b-L7.3 (finding 1): sampleRateShading is advertised, and with it SPIR-V's InterpolationFunction;
  // the translator refused both.
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const file = 'tests/venus/l7b/interpolate-at.frag';
    const pixel = glslStage(translate, tmp, file);
    assert.equal(pixel.rc, 0, pixel.text);
    const shading = glslStage(translate, tmp, file, { features: WGSL.DUAL_SOURCE | TEST_SAMPLE_SHADING });
    assert.equal(shading.rc, 0, shading.text);
    for (const r of [pixel, shading]) {
      assert.match(r.text, /dpdxFine\(i\.v0\)/);
      assert.match(r.text, /wg_sample_pos\(/);
      // The flat input as it is.
      assert.doesNotMatch(r.text, /dpdxFine\(i\.v2\)/);
    }
    // At the sample rate, from the sample the input is at.
    assert.match(shading.text, /- wg_sample_pos\(sid\)/);
    assert.doesNotMatch(pixel.text, /\bsid\b/);
    const errors = await compile([pixel.text, shading.text]);
    if (!errors) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(errors, ['', ''], 'WGSL Chromium rejected');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/**
 * Runs a translated compute shader (one workgroup) over textures in headless Chromium's WebGPU: each texture made of
 * its bytes at its WGSL binding (`mips`: its further levels' bytes), a sampler (`filter`) at `sampler` (none: no
 * sampler), a storage buffer of `size` bytes at `out`, read back.
 */
async function runSampled(code: string, textures: { binding: number; format: string; w: number; h: number; layers?: number; data: number[]; mips?: number[][] }[], sampler: { binding: number; filter: string; address?: string; lodMinClamp?: number; compare?: string } | undefined, out: { binding: number; size: number }) {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>wgsl</title>'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
    args: (process.env.CHROMIUM_ARGS ?? '--enable-unsafe-webgpu --enable-features=Vulkan').split(' ').filter(Boolean) });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    const r = await page.evaluate(async ({ code, textures, sampler, out }) => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return undefined;
      const device = await adapter.requestDevice();
      const errors: string[] = [];
      device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
      const module = device.createShaderModule({ code });
      errors.push(...(await module.getCompilationInfo()).messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`));
      if (errors.length) return { errors, out: [] as number[] };
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const entries: GPUBindGroupEntry[] = textures.map((t) => {
        const levels = [t.data, ...(t.mips ?? [])];
        const layers = t.layers ?? 1;
        const tex = device.createTexture({ size: [t.w, t.h, layers], format: t.format as GPUTextureFormat, mipLevelCount: levels.length, usage: 0x2 | 0x4 /* COPY_DST | TEXTURE_BINDING */ });
        const bpp = t.data.length / (t.w * t.h * layers);
        levels.forEach((data, mip) => {
          const w = Math.max(t.w >> mip, 1), h = Math.max(t.h >> mip, 1);
          device.queue.writeTexture({ texture: tex, mipLevel: mip }, new Uint8Array(data), { bytesPerRow: w * bpp, rowsPerImage: h }, [w, h, layers]);
        });
        return { binding: t.binding, resource: tex.createView(layers > 1 ? { dimension: '2d-array' } : {}) };
      });
      if (sampler) entries.push({ binding: sampler.binding, resource: device.createSampler({ ...(sampler.compare ? { compare: sampler.compare as GPUCompareFunction } : {}), lodMinClamp: sampler.lodMinClamp ?? 0, mipmapFilter: sampler.lodMinClamp ? 'linear' : 'nearest', magFilter: sampler.filter as GPUFilterMode, minFilter: sampler.filter as GPUFilterMode, addressModeU: (sampler.address ?? 'clamp-to-edge') as GPUAddressMode }) });
      const buffer = device.createBuffer({ size: out.size, usage: 0x80 | 0x4 /* STORAGE | COPY_SRC */ });
      entries.push({ binding: out.binding, resource: { buffer } });
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      const read = device.createBuffer({ size: out.size, usage: 0x1 | 0x8 /* MAP_READ | COPY_DST */ });
      enc.copyBufferToBuffer(buffer, 0, read, 0, out.size);
      device.queue.submit([enc.finish()]);
      await read.mapAsync(1 /* GPUMapMode.READ */);
      return { errors, out: [...new Uint8Array(read.getMappedRange())] };
    }, { code, textures, sampler, out });
    return r && { ...r, out: new Float32Array(new Uint8Array(r.out).buffer) };
  } finally {
    await browser.close();
    server.close();
  }
}

test('a combined image-sampler with a YCbCr conversion samples each plane and converts (VK3 L7.2)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    // VK_FORMAT_G8_B8R8_2PLANE_420_UNORM (NV12), BT.709, narrow range; chroma at the midpoint, nearest, or cosited
    // horizontally, linear.
    const NV12 = 1000156003, YCBCR_709 = 2, NARROW = 1, COSITED = 0, MIDPOINT = 1, NEAREST = 0, LINEAR = 1;
    const file = 'tests/venus/ycbcr.comp';
    const ycbcr = { set: 0, binding: 0, format: NV12, model: YCBCR_709, range: NARROW };
    const mid = glslStage(translate, tmp, file, { ycbcr: { ...ycbcr, x: MIDPOINT, y: MIDPOINT, filter: NEAREST } });
    assert.equal(mid.rc, 0, mid.text);
    // Slots: img 0 (its texture binding 0, its sampler 1), the buffer 1 (binding 2), img's second plane 2 (binding 4).
    assert.match(mid.text, /@group\(0\) @binding\(0\) var r0_0: texture_2d<f32>;/);
    assert.match(mid.text, /@group\(0\) @binding\(4\) var r0_4: texture_2d<f32>;/);
    const cosited = glslStage(translate, tmp, file, { ycbcr: { ...ycbcr, x: COSITED, y: MIDPOINT, filter: LINEAR } });
    assert.equal(cosited.rc, 0, cosited.text);
    // Without the conversion: one texture.
    const plain = glslStage(translate, tmp, file);
    assert.equal(plain.rc, 0, plain.text);
    assert.doesNotMatch(plain.text, /@binding\(4\)/);

    // Luma 4×4, chroma (Cb, Cr) 2×2.
    const Y = Array.from({ length: 16 }, (_, i) => 16 + i * 13);
    const C = [[60, 200], [128, 128], [200, 60], [90, 170]];
    const run = (code: string, filter: string) => runSampled(code, [{ binding: 0, format: 'r8unorm', w: 4, h: 4, data: Y },
      { binding: 4, format: 'rg8unorm', w: 2, h: 2, data: C.flat() }], { binding: 1, filter }, { binding: 2, size: 256 });
    // BT.709 narrow range of 8-bit values (the spec's "Narrow range" and "BT.709" sections).
    const rgb = (y: number, cb: number, cr: number) => {
      const yy = (y - 16) / 219, pb = (cb - 128) / 224, pr = (cr - 128) / 224;
      return [yy + 1.5748 * pr, yy - 0.13397432 / 0.7152 * pb - 0.33480248 / 0.7152 * pr, yy + 1.8556 * pb, 1];
    };
    const lerp = (a: number[], b: number[], f: number) => a.map((v, k) => v + (b[k] - v) * f);
    const check = (got: Float32Array, want: (x: number, y: number) => number[], what: string) => {
      const bad: string[] = [];
      for (let i = 0; i < 16; i++) {
        const w = want(i & 3, i >> 2), g = [...got.subarray(4 * i, 4 * i + 4)];
        if (g.some((v, k) => !(Math.abs(v - w[k]) < 0.02))) bad.push(`(${i & 3}, ${i >> 2}): ${g.map((v) => v.toFixed(3))}, not ${w.map((v) => v.toFixed(3))}`);
      }
      assert.deepEqual(bad.slice(0, 4), [], `${what}: ${bad.length} of 16 wrong`);
    };
    const a = await run(mid.text, 'nearest');
    if (!a) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(a.errors, []);
    check(a.out, (x, y) => { const c = C[(y >> 1) * 2 + (x >> 1)]; return rgb(Y[y * 4 + x], c[0], c[1]); }, 'midpoint, nearest');
    // Cosited horizontally: an even column's chroma is its texel's, an odd one's halfway to the next (clamped).
    const b = await run(cosited.text, 'linear');
    assert.ok(b);
    assert.deepEqual(b.errors, []);
    check(b.out, (x, y) => {
      const row = (y >> 1) * 2, c0 = C[row + (x >> 1)], c1 = C[row + Math.min((x >> 1) + (x & 1), 1)];
      // Vertically at the midpoint, linear: rows 0 and 3 at their chroma row; 1 and 2 a quarter towards the other.
      const r2 = y === 1 ? 2 : y === 2 ? 0 : row, f = y === 1 || y === 2 ? 0.25 : 0;
      const d0 = C[r2 + (x >> 1)], d1 = C[r2 + Math.min((x >> 1) + (x & 1), 1)];
      const c = lerp(lerp(c0, c1, (x & 1) * 0.5), lerp(d0, d1, (x & 1) * 0.5), f);
      return rgb(Y[y * 4 + x], c[0], c[1]);
    }, 'cosited, linear');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a vertex stage captured by transform feedback copies each output into its record, a matrix\'s columns and an array\'s elements at their offsets (VK3 L7.4)', { skip: noGlslc, timeout: 120_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const r = glslStage(translate, tmp, 'tests/venus/l7/xfb-block.vert');
    assert.equal(r.rc, 0, r.text);
    assert.match(r.text, /var<private> wg_xo: array<u32, 12>;/);
    // The body a function of its own, which the driver's transform feedback pass calls.
    assert.match(r.text, /fn wg_vs\(vid: u32, iid: u32, i: In\) \{/);
    const words = [...r.text.matchAll(/wg_xo\[(\d+)u\] = /g)].map((m) => Number(m[1]));
    assert.deepEqual(words.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5], 'the record\'s words written');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a vertex stage that writes storage is printed without its entry point, its body run as compute by the driver (VK4 T33)', { skip: noGlslc, timeout: 120_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    // A buffer's stores and an atomic, an image's store: WebGPU refuses a vertex entry point that reaches either.
    for (const file of ['tests/venus/t33/store.vert', 'tests/venus/t33/image.vert']) {
      const r = glslStage(translate, tmp, file);
      assert.equal(r.rc, 0, r.text);
      assert.doesNotMatch(r.text, /@vertex/, file);
      assert.match(r.text, /\nfn wg_vs\(vid: u32, iid: u32(, i: In)?\) \{/, file);
      assert.match(r.text, /\nstruct Out \{\n  @builtin\(position\) pos: vec4<f32>,/, `${file}: the outputs the pass-through reads`);
    }
    // Reading storage only, it keeps its entry point.
    const r = glslStage(translate, tmp, 'tests/venus/scope.vert');
    assert.equal(r.rc, 0, r.text);
    assert.match(r.text, /@vertex fn main\(/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a vertex stage\'s draw parameters are read from the push buffer past the push constants, which go there with them (VK3 L7.5)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const r = glslStage(translate, tmp, 'tests/venus/l7/draw-params.vert');
    assert.equal(r.rc, 0, r.text);
    // The push buffer (16 bytes of push constants would be immediates without them), 144 bytes: the parameters at
    // byte 128 (wgsl.h's WGSL_DRAW_PARAMS), the base vertex, the base instance and the draw's index.
    assert.match(r.text, /@group\(3\) @binding\(998\)/);
    assert.doesNotMatch(r.text, /var<immediate>/);
    for (const c of [0, 1, 2]) assert.match(r.text, new RegExp(`= pc\\[8u\\]\\[${c}u\\];`), `the parameter in word ${32 + c}`);
    const errors = await compile([r.text]);
    if (!errors) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(errors, [''], 'WGSL Chromium rejected');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('texture-sampler pairs past what the translator records fail the stage, saying so (VK3 L7a)', { skip: noGlslc, timeout: 120_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    // 72 pairs are recorded (the cap was 64, the rest dropped without a word: their samplers never non-filtering).
    const r72 = glslStage(translate, tmp, 'tests/venus/l7a/pairs-72.frag');
    assert.equal(r72.rc, 0, r72.text);
    const r = glslStage(translate, tmp, 'tests/venus/l7a/pairs.frag');
    assert.notEqual(r.rc, 0, 'translated with pairs dropped');
    assert.match(r.text, /texture-sampler pairs/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('an integer texture sampled at an explicit LOD is fetched from the level Vulkan selects, within the image\'s levels (VK3 L9b)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const r = glslStage(translate, tmp, 'tests/venus/l9b/int-lod.comp');
    assert.equal(r.rc, 0, r.text);
    // A 4×4 r32sint image of three levels: level 0's texels 100 + y·4 + x, level 1's 200 + y·2 + x, level 2's 300.
    const word = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24];
    const level = (n: number, base: number) => Array.from({ length: n * n }, (_, i) => word(base + i)).flat();
    // The sampler's binding is the texture's + 1; a fetch doesn't use it.
    const sampled = r.text.includes('@binding(1) var') ? { binding: 1, filter: 'nearest' } : undefined;
    const res = await runSampled(r.text, [{ binding: 0, format: 'r32sint', w: 4, h: 4, data: level(4, 100), mips: [level(2, 200), level(1, 300)] }], sampled, { binding: 2, size: 16 * 16 });
    if (!res) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(res.errors, []);
    const got = [...new Int32Array(res.out.buffer)].filter((_, i) => i % 4 === 0);
    // The LODs -1, 0.3, 1.2, 1.7, 2, 5, 9, -0.3: levels 0, 0, 1, 2, 2, 2, 2, 0 (nearest, clamped to 0-2); (0.6, 0.6)
    // is texel (2, 2) of level 0, (1, 1) of level 1, (0, 0) of level 2; offset (-1, 1): (1, 3), (0, 1) clamped, (0, 0).
    const at = [110, 203, 300], off = [113, 202, 300], levels = [0, 0, 1, 2, 2, 2, 2, 0];
    assert.deepEqual(got, [...levels.map((l) => at[l]), ...levels.map((l) => off[l])]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// VK4 T8: wgsl_sampler.c, printed from the NIR kept, as a variant's stage is (wgsl_test_sampler).
const ADDRESS = { repeat: 0, mirror: 1, edge: 2, border: 3, once: 4 };
const key = (u: number, o: Partial<NonNullable<Device['sampler']>> = {}): NonNullable<Device['sampler']> => ({ u, v: ADDRESS.edge, w: ADDRESS.edge, flags: 16, compare: 7, levels: 1, bias: 0, min: 0, max: 1000, border: [0, 0, 0, 0], ...o });

test('an integer texture is fetched as its sampler\'s address modes say (VK4 T8)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const word = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24];
    // A 4×4 r32sint image, a row of 100 + x.
    const data = Array.from({ length: 16 }, (_, i) => word(100 + i % 4)).flat();
    const texels = async (sampler?: Device['sampler']) => {
      const r = glslStage(translate, tmp, 'tests/venus/t8/int-sampler.comp', { sampler });
      assert.equal(r.rc, 0, r.text);
      const res = await runSampled(r.text, [{ binding: 0, format: 'r32sint', w: 4, h: 4, data }], undefined, { binding: 2, size: 8 * 16 });
      if (!res) return undefined;
      assert.deepEqual(res.errors, []);
      return [...new Int32Array(res.out.buffer)].filter((_, i) => i % 4 === 0);
    };
    // x -1.1, -0.3, 0.1, 0.6, 1.1, 1.3, 2.1, -2.3 are texels -5, -2, 0, 2, 4, 5, 8, -10 of 4.
    const edge = await texels();
    if (!edge) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(edge, [100, 100, 100, 102, 103, 103, 103, 100], 'no key: clamp-to-edge');
    assert.deepEqual(await texels(key(ADDRESS.repeat)), [103, 102, 100, 102, 100, 101, 100, 102]);
    assert.deepEqual(await texels(key(ADDRESS.mirror)), [103, 101, 100, 102, 103, 102, 100, 101]);
    assert.deepEqual(await texels(key(ADDRESS.once)), [103, 101, 100, 102, 103, 103, 103, 103]);
    assert.deepEqual(await texels(key(ADDRESS.border, { border: [7, 8, 9, 1] })), [7, 7, 100, 102, 7, 7, 7, 7]);
    // Unnormalized: coordinates are texels (x 2.1 is texel 2, 0.6 is 0).
    assert.deepEqual(await texels(key(ADDRESS.edge, { flags: 16 | 8 })), [100, 100, 100, 100, 101, 101, 102, 100]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('an integer texture\'s level comes from its sampler\'s bias and LOD clamps (VK4 T8)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const word = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24];
    const level = (n: number, v: number) => Array.from({ length: n * n }, () => word(v)).flat();
    const levelOf = async (sampler: Device['sampler']) => {
      const r = glslStage(translate, tmp, 'tests/venus/t8/int-sampler.comp', { sampler });
      assert.equal(r.rc, 0, r.text);
      const res = await runSampled(r.text, [{ binding: 0, format: 'r32sint', w: 4, h: 4, data: level(4, 10), mips: [level(2, 20), level(1, 30)] }], undefined, { binding: 2, size: 8 * 16 });
      if (!res) return undefined;
      assert.deepEqual(res.errors, []);
      return new Int32Array(res.out.buffer)[0];
    };
    const plain = await levelOf(key(ADDRESS.edge, { levels: 3 }));
    if (plain === undefined) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.equal(plain, 10);
    assert.equal(await levelOf(key(ADDRESS.edge, { levels: 3, bias: 1.2 })), 20);
    assert.equal(await levelOf(key(ADDRESS.edge, { levels: 3, bias: 9 })), 30, 'past the view\'s levels: its last');
    assert.equal(await levelOf(key(ADDRESS.edge, { levels: 3, min: 2 })), 30);
    assert.equal(await levelOf(key(ADDRESS.edge, { levels: 3, bias: 9, max: 1 })), 20);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a float texture blends towards the border and mirrors once, as WebGPU\'s samplers can\'t (VK4 T8)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    // A 2×2 image: the first column's red 1, the second's 0.
    const one = [255, 0, 0, 255], zero = [0, 0, 0, 255];
    const data = [...one, ...zero, ...one, ...zero];
    const reds = async (sampler: Device['sampler'], filter: string, address: string, image = data) => {
      const r = glslStage(translate, tmp, 'tests/venus/t8/float-sampler.comp', { sampler });
      assert.equal(r.rc, 0, r.text);
      const res = await runSampled(r.text, [{ binding: 0, format: 'rgba8unorm', w: 2, h: 2, data: image }], { binding: 1, filter, address }, { binding: 2, size: 8 * 16 });
      if (!res) return undefined;
      assert.deepEqual(res.errors, []);
      return [...res.out].filter((_, i) => i % 4 === 0).map((v) => Math.round(v * 1000) / 1000);
    };
    const WHITE = 0x3f800000;
    // Nearest: x -1, -0.125, 0.125, 0.5, 0.875, 1.125, 2, -0.75.
    const border = await reds(key(ADDRESS.border, { border: [WHITE, 0, 0, WHITE] }), 'nearest', 'clamp-to-edge');
    if (!border) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(border, [1, 1, 1, 0, 0, 1, 1, 1], 'nearest border');
    // Linear, towards a black border: the part of the two texels' footprint past the edge is the border's.
    assert.deepEqual(await reds(key(ADDRESS.border, { flags: 16 | 1 | 2 }), 'linear', 'clamp-to-edge'), [0, 0.25, 0.75, 0.5, 0, 0, 0, 0], 'linear border');
    // Both edges, on a red image: x 0.875 and 1.125 are 0.25 of a texel inside and past the far one.
    const red = [...one, ...one, ...one, ...one];
    assert.deepEqual(await reds(key(ADDRESS.border, { flags: 16 | 1 | 2 }), 'linear', 'clamp-to-edge', red), [0, 0.25, 0.75, 1, 0.75, 0.25, 0, 0], 'linear border, both edges');
    // Mirror-once through the sampler's mirror-repeat: -0.75 reads as 0.75, past 1 the far edge.
    assert.deepEqual(await reds(key(ADDRESS.once), 'nearest', 'mirror-repeat'), [0, 1, 1, 0, 0, 0, 0, 0], 'mirror-once');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('an integer cube is fetched from its faces as a 2D array, its size and levels asked of them (VK4 T8)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const r = glslStage(translate, tmp, 'tests/venus/t8/int-cube.comp');
    assert.equal(r.rc, 0, r.text);
    assert.match(r.text, /texture_2d_array<i32>/);
    const word = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24];
    // Each face's texels 10·face + y·2 + x.
    const data = Array.from({ length: 6 }, (_, f) => [0, 1, 2, 3].map((i) => word(10 * f + i)).flat()).flat();
    const res = await runSampled(r.text, [{ binding: 0, format: 'r32sint', w: 2, h: 2, layers: 6, data }], undefined, { binding: 2, size: 7 * 16 });
    if (!res) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(res.errors, []);
    const o = new Int32Array(res.out.buffer);
    // Each direction lands on its face at (s, t) = 0.5(sc/|ma| + 1): 0.25 or 0.75, Vulkan's table.
    assert.deepEqual([0, 1, 2, 3, 4, 5].map((f) => o[f * 4]), [0, 11, 23, 31, 41, 50]);
    assert.deepEqual([...o.slice(6 * 4, 6 * 4 + 3)], [2, 2, 1]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('an integer texture only asked its size is declared integer, so that its view binds (VK4 T8)', { skip: noGlslc, timeout: 120_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const r = glslStage(await translator(), tmp, 'tests/venus/t8/size-only.frag');
    assert.equal(r.rc, 0, r.text);
    assert.match(r.text, /texture_2d<u32>/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// VK4 T18: a padded image: a key's smaller size on a plain texture stands for a compressed one's blocks.
test('an image that is a corner of its texture is wrapped and filtered at its own size (VK4 T18)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    // 4×4, a row's reds 0, 80, 160, 240: only the first three are the image's.
    const data = Array.from({ length: 16 }, (_, i) => [(i % 4) * 80, 0, 0, 255]).flat();
    const reds = async (sampler: Device['sampler']) => {
      const r = glslStage(translate, tmp, 'tests/venus/t8/padded.comp', { sampler });
      assert.equal(r.rc, 0, r.text);
      const res = await runSampled(r.text, [{ binding: 0, format: 'rgba8unorm', w: 4, h: 4, data, mips: [Array(16).fill(0)] }], undefined, { binding: 2, size: 8 * 16 });
      if (!res) return undefined;
      assert.deepEqual(res.errors, []);
      return { red: [...res.out].filter((_, i) => i % 4 === 0).slice(0, 7).map((v) => Math.round(v * 255)), size: [...res.out.slice(7 * 4, 7 * 4 + 4)] };
    };
    const padded = { flags: 16 | 32, size: [3, 3], levels: 2 };
    const clamp = await reds(key(ADDRESS.edge, padded));
    if (!clamp) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    // x·3: 0.3, 1.5, 2.7, 3.3, -0.3, 1.02, 1.5. Never texel 3, whose 240 is past the image.
    assert.deepEqual(clamp.red, [0, 80, 160, 160, 0, 80, 80], 'clamp-to-edge stops at the image');
    assert.deepEqual(clamp.size, [3, 3, 1, 1], 'its size is the image\'s, each level\'s');
    assert.deepEqual((await reds(key(ADDRESS.repeat, padded)))!.red, [0, 80, 160, 0, 160, 80, 80], 'repeat wraps at the image');
    // Linear, x·3 - 0.5: -0.2, 1.0, 2.2, 2.8: 0.1 reads texels 2 (wrapped, 0.2) and 0, 1.1 likewise.
    assert.deepEqual((await reds(key(ADDRESS.repeat, { ...padded, flags: padded.flags | 1 | 2 })))!.red.slice(0, 4), [32, 80, 128, 32], 'linear repeat at the image');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a min or max reduction takes the footprint\'s texels with non-zero weights, in a level and across two (VK4 T25)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    // 4×4, red 60 a column and 10 a row; level 1 all 200.
    const data = Array.from({ length: 16 }, (_, i) => [(i % 4) * 60 + (i >> 2) * 10, 0, 0, 255]).flat();
    const reds = async (sampler: Device['sampler'], webgpu?: Parameters<typeof runSampled>[2]) => {
      const r = glslStage(translate, tmp, 'tests/venus/t25/minmax.comp', { sampler });
      assert.equal(r.rc, 0, r.text);
      const res = await runSampled(r.text, [{ binding: 0, format: 'rgba8unorm', w: 4, h: 4, data, mips: [Array(4).fill([200, 0, 0, 255]).flat()] }], webgpu, { binding: 2, size: 8 * 16 });
      if (!res) return undefined;
      assert.deepEqual(res.errors, []);
      return [...res.out].filter((_, i) => i % 4 === 0).slice(0, 6).map((v) => Math.round(v * 255));
    };
    const linear = { flags: 16 | 1 | 2 | 4, levels: 2 };
    // x·4 - 0.5: 0 (texel 0 alone: its neighbour's weight is 0), 0.5, 1.5, 3.1 (the edge's twice); the fifth at LOD 0.5
    // with level 1; the sixth between rows 0 and 1 too.
    const average = await reds(key(ADDRESS.edge, linear), { binding: 1, filter: 'linear' });
    if (!average) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual([0, 1, 2, 3, 5].map((i) => average[i]), [0, 30, 90, 180, 35], 'the weighted average (WebGPU\'s)');
    assert.deepEqual(await reds(key(ADDRESS.edge, { ...linear, flags: linear.flags | 256 })), [0, 0, 60, 180, 60, 0], 'min');
    assert.deepEqual(await reds(key(ADDRESS.edge, { ...linear, flags: linear.flags | 512 })), [0, 60, 120, 180, 200, 70], 'max');
    // Nearest: the texel, whatever the reduction.
    assert.deepEqual(await reds(key(ADDRESS.edge, { levels: 2, flags: 16 | 512 })), [0, 60, 120, 180, 120, 70]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a padded cube filters across its faces (VK4 T18)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const r = glslStage(translate, tmp, 'tests/venus/t8/padded-cube.comp', { sampler: key(ADDRESS.edge, { flags: 16 | 32 | 64 | 1 | 2, size: [2, 2], levels: 1 }) });
    assert.equal(r.rc, 0, r.text);
    assert.match(r.text, /texture_2d_array<f32>/);
    // Faces' reds 0, 40, 80, 120, 160, 200, in a texture wider than the image.
    const data = Array.from({ length: 6 }, (_, f) => Array.from({ length: 16 }, () => [f * 40, 0, 0, 255]).flat()).flat();
    const res = await runSampled(r.text, [{ binding: 0, format: 'rgba8unorm', w: 4, h: 4, layers: 6, data }], undefined, { binding: 2, size: 2 * 16 });
    if (!res) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(res.errors, []);
    assert.equal(Math.round(res.out[0] * 255), 0, 'within +X');
    // (1, 0, 0.99) is 0.01 of a texel from +X's edge with +Z: 0.51 of +X's 0, 0.49 of +Z's 160.
    assert.ok(Math.abs(res.out[4] * 255 - 78.4) < 1.5, `across the edge: ${res.out[4] * 255}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a non-seamless cube filters within the face, wrapped by its address modes (VK4 T28)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    // Faces' reds 0, 40, 80, 120, 160, 200, 4×4 each; (1, 0, 0.99) is 0.02 of a texel from +X's edge with +Z: a linear filter reads 0.48 past it.
    const data = Array.from({ length: 6 }, (_, f) => Array.from({ length: 16 }, () => [f * 40, 0, 0, 255]).flat()).flat();
    const edge = async (sampler: Device['sampler']) => {
      const r = glslStage(translate, tmp, 'tests/venus/t8/padded-cube.comp', { sampler });
      assert.equal(r.rc, 0, r.text);
      assert.match(r.text, /texture_2d_array<f32>/);
      const res = await runSampled(r.text, [{ binding: 0, format: 'rgba8unorm', w: 4, h: 4, layers: 6, data }], undefined, { binding: 2, size: 2 * 16 });
      if (!res) return undefined;
      assert.deepEqual(res.errors, []);
      assert.equal(Math.round(res.out[0] * 255), 0, 'within +X');
      return res.out[4] * 255;
    };
    const seamless = await edge(key(ADDRESS.edge, { flags: 16 | 64 | 1 | 2 }));
    if (seamless === undefined) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.ok(Math.abs(seamless - 76.8) < 1.5, `seamless: across the edge, 0.48 of +Z's 160: ${seamless}`);
    assert.equal(Math.round((await edge(key(ADDRESS.edge, { flags: 16 | 64 | 1024 | 1 | 2 })))!), 0, 'non-seamless, clamped to the edge: +X only');
    const white = 0x3f800000;
    const border = await edge(key(ADDRESS.border, { v: ADDRESS.border, flags: 16 | 64 | 1024 | 1 | 2, border: [white, white, white, white] }));
    assert.ok(Math.abs(border! - 122.4) < 1.5, `non-seamless at a border: 0.48 of the border's 255: ${border}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// VK4 T11: what a format's words hold, against bytes worked out by hand (Vulkan's formats, section "Fixed-Point Data
// Conversions"): an image of two rows, whatever is past the texels left alone. Each entry: the GLSL qualifier, the
// image's type, a texel's bytes, four values stored and the bytes they make, then what those bytes load as.
const f = 'image2D', u = 'uimage2D', s = 'iimage2D';
const N8 = (v: number) => v / 255, S8 = (v: number) => v / 127, N16 = (v: number) => v / 65535, S16 = (v: number) => v / 32767, N10 = (v: number) => v / 1023;
const IMAGE_FORMATS: [string, string, number, number[][], string, number[][]][] = [
  ['rgba8', f, 4, [[1, 0.5, 0, -1], [2, 0.2, 0.25, 1], [0, 0, 0, 0], [1, 1, 1, 1]], 'ff800000 ff3340ff 00000000 ffffffff', [[1, N8(128), 0, 0], [1, N8(51), N8(64), 1], [0, 0, 0, 0], [1, 1, 1, 1]]],
  ['rgba8_snorm', f, 4, [[1, -1, 0.5, -2], [0, 0.25, -0.25, 2], [-0.5, 0, 1, 0], [0, 0, 0, 0]], '7f8140 81 00 20 e0 7f c1 00 7f 00 00000000', [[1, -1, S8(64), -1], [0, S8(32), S8(-32), 1], [S8(-63), 0, 1, 0], [0, 0, 0, 0]]],
  ['rgba8ui', u, 4, [[1, 2, 3, 255], [0, 0, 0, 0], [128, 64, 32, 16], [9, 8, 7, 6]], '010203ff 00000000 80402010 09080706', [[1, 2, 3, 255], [0, 0, 0, 0], [128, 64, 32, 16], [9, 8, 7, 6]]],
  ['rgba8i', s, 4, [[-1, 2, -128, 127], [0, 0, 0, 0], [-2, -3, 4, 5], [1, 1, 1, 1]], 'ff02807f 00000000 fefd0405 01010101', [[-1, 2, -128, 127], [0, 0, 0, 0], [-2, -3, 4, 5], [1, 1, 1, 1]]],
  ['r8', f, 1, [[1, 0, 0, 0], [0.5, 0, 0, 0], [0, 0, 0, 0], [-1, 0, 0, 0]], 'ff 80 00 00', [[1, 0, 0, 1], [N8(128), 0, 0, 1], [0, 0, 0, 1], [0, 0, 0, 1]]],
  ['r8_snorm', f, 1, [[1, 0, 0, 0], [-1, 0, 0, 0], [0.5, 0, 0, 0], [-0.5, 0, 0, 0]], '7f 81 40 c1', [[1, 0, 0, 1], [-1, 0, 0, 1], [S8(64), 0, 0, 1], [S8(-63), 0, 0, 1]]],
  ['r8ui', u, 1, [[1, 0, 0, 0], [255, 0, 0, 0], [7, 0, 0, 0], [128, 0, 0, 0]], '01 ff 07 80', [[1, 0, 0, 1], [255, 0, 0, 1], [7, 0, 0, 1], [128, 0, 0, 1]]],
  ['r8i', s, 1, [[1, 0, 0, 0], [-1, 0, 0, 0], [-128, 0, 0, 0], [127, 0, 0, 0]], '01 ff 80 7f', [[1, 0, 0, 1], [-1, 0, 0, 1], [-128, 0, 0, 1], [127, 0, 0, 1]]],
  ['rg8', f, 2, [[1, 0.5, 0, 0], [0, 1, 0, 0], [0.2, 0.2, 0, 0], [-1, 2, 0, 0]], 'ff80 00ff 3333 00ff', [[1, N8(128), 0, 1], [0, 1, 0, 1], [N8(51), N8(51), 0, 1], [0, 1, 0, 1]]],
  ['rg8ui', u, 2, [[1, 2, 0, 0], [255, 254, 0, 0], [0, 0, 0, 0], [3, 4, 0, 0]], '0102 fffe 0000 0304', [[1, 2, 0, 1], [255, 254, 0, 1], [0, 0, 0, 1], [3, 4, 0, 1]]],
  ['rg8i', s, 2, [[-1, 2, 0, 0], [-128, 127, 0, 0], [0, 0, 0, 0], [3, -4, 0, 0]], 'ff02 807f 0000 03fc', [[-1, 2, 0, 1], [-128, 127, 0, 1], [0, 0, 0, 1], [3, -4, 0, 1]]],
  ['rg8_snorm', f, 2, [[1, -1, 0, 0], [0.5, -0.5, 0, 0], [0, 0, 0, 0], [2, -2, 0, 0]], '7f81 40c1 0000 7f81', [[1, -1, 0, 1], [S8(64), S8(-63), 0, 1], [0, 0, 0, 1], [1, -1, 0, 1]]],
  ['r16f', f, 2, [[1, 0, 0, 0], [-2, 0, 0, 0], [0.5, 0, 0, 0], [65536, 0, 0, 0]], '003c 00c0 0038 007c', [[1, 0, 0, 1], [-2, 0, 0, 1], [0.5, 0, 0, 1], [Infinity, 0, 0, 1]]],
  // What's past the range: NaN keeps being NaN, a value too large is infinity, one too small 0.
  ['r16f', f, 2, [[NaN, 0, 0, 0], [1e6, 0, 0, 0], [-1e6, 0, 0, 0], [1e-9, 0, 0, 0]], '007e 007c 00fc 0000', [[NaN, 0, 0, 1], [Infinity, 0, 0, 1], [-Infinity, 0, 0, 1], [0, 0, 0, 1]]],
  // Ties to even, a subnormal's too (VK4 R5, the review's C7).
  ['r16f', f, 2, [[1 + 2 ** -11, 0, 0, 0], [1 + 3 * 2 ** -11, 0, 0, 0], [1.5 * 2 ** -24, 0, 0, 0], [2 ** -25, 0, 0, 0]], '003c 023c 0200 0000', [[1, 0, 0, 1], [1 + 2 ** -9, 0, 0, 1], [2 ** -23, 0, 0, 1], [0, 0, 0, 1]]],
  // Ufloats have no sign, and a finite value too large is the largest finite (Vulkan's "Unsigned 11-Bit Floating-Point
  // Numbers"); infinity stays one; a value just under a tie isn't rounded twice.
  ['r11f_g11f_b10f', f, 4, [[NaN, 1e6, 0, 0], [1e-9, 0, 0, 0], [65535, 0, 0, 0], [0, 0, 1e6, 0]], 'ffff3d00 00000000 bf070000 0000c0f7', [[NaN, 65024, 0, 1], [0, 0, 0, 1], [65024, 0, 0, 1], [0, 0, 64512, 1]]],
  ['r11f_g11f_b10f', f, 4, [[1.0078125 - 2 ** -12, 0, 0, 0], [Infinity, 0, 0, 0], [0, 0, Infinity, 0], [-Infinity, 0, 0, 0]], 'c0030000 c0070000 000000f8 00000000', [[1, 0, 0, 1], [Infinity, 0, 0, 1], [0, 0, Infinity, 1], [0, 0, 0, 1]]],
  ['r16ui', u, 2, [[1, 0, 0, 0], [65535, 0, 0, 0], [258, 0, 0, 0], [0, 0, 0, 0]], '0100 ffff 0201 0000', [[1, 0, 0, 1], [65535, 0, 0, 1], [258, 0, 0, 1], [0, 0, 0, 1]]],
  ['r16i', s, 2, [[-1, 0, 0, 0], [-32768, 0, 0, 0], [32767, 0, 0, 0], [2, 0, 0, 0]], 'ffff 0080 ff7f 0200', [[-1, 0, 0, 1], [-32768, 0, 0, 1], [32767, 0, 0, 1], [2, 0, 0, 1]]],
  ['r16', f, 2, [[1, 0, 0, 0], [0.5, 0, 0, 0], [0, 0, 0, 0], [-1, 0, 0, 0]], 'ffff 0080 0000 0000', [[1, 0, 0, 1], [N16(32768), 0, 0, 1], [0, 0, 0, 1], [0, 0, 0, 1]]],
  ['r16_snorm', f, 2, [[1, 0, 0, 0], [-1, 0, 0, 0], [0.5, 0, 0, 0], [0, 0, 0, 0]], 'ff7f 0180 0040 0000', [[1, 0, 0, 1], [-1, 0, 0, 1], [S16(16384), 0, 0, 1], [0, 0, 0, 1]]],
  ['rg16f', f, 4, [[1, -2, 0, 0], [0.5, 0, 0, 0], [0.000061035156, 0.0000305175781, 0, 0], [0, 1024, 0, 0]], '003c 00c0 0038 0000 0004 0002 0000 0064', [[1, -2, 0, 1], [0.5, 0, 0, 1], [0.000061035156, 0.0000305175781, 0, 1], [0, 1024, 0, 1]]],
  ['rg16', f, 4, [[1, 0, 0, 0], [0.5, 1, 0, 0], [0, 0, 0, 0], [2, -1, 0, 0]], 'ffff0000 0080ffff 00000000 ffff0000', [[1, 0, 0, 1], [N16(32768), 1, 0, 1], [0, 0, 0, 1], [1, 0, 0, 1]]],
  ['rg16_snorm', f, 4, [[1, -1, 0, 0], [0.5, 0, 0, 0], [0, 0, 0, 0], [-2, 2, 0, 0]], 'ff7f0180 00400000 00000000 0180ff7f', [[1, -1, 0, 1], [S16(16384), 0, 0, 1], [0, 0, 0, 1], [-1, 1, 0, 1]]],
  ['rg16ui', u, 4, [[1, 2, 0, 0], [65535, 0, 0, 0], [0, 0, 0, 0], [258, 772, 0, 0]], '01000200 ffff0000 00000000 02010403', [[1, 2, 0, 1], [65535, 0, 0, 1], [0, 0, 0, 1], [258, 772, 0, 1]]],
  ['rg16i', s, 4, [[-1, 2, 0, 0], [-32768, 32767, 0, 0], [0, 0, 0, 0], [-2, -3, 0, 0]], 'ffff0200 0080ff7f 00000000 feff fdff', [[-1, 2, 0, 1], [-32768, 32767, 0, 1], [0, 0, 0, 1], [-2, -3, 0, 1]]],
  ['rgb10_a2', f, 4, [[1, 0, 0, 1], [0, 1, 0, 0], [0, 0, 1, 0.34], [0.5, 0, 0, 0]], 'ff0300c0 00fc0f00 0000f07f 00020000', [[1, 0, 0, 1], [0, 1, 0, 0], [0, 0, 1, 1 / 3], [N10(512), 0, 0, 0]]],
  ['rgb10_a2ui', u, 4, [[1023, 0, 0, 3], [0, 1023, 0, 0], [0, 0, 1023, 1], [1, 2, 3, 0]], 'ff0300c0 00fc0f00 0000f07f 01083000', [[1023, 0, 0, 3], [0, 1023, 0, 0], [0, 0, 1023, 1], [1, 2, 3, 0]]],
  ['r11f_g11f_b10f', f, 4, [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [-1, 0.5, 2, 0]], 'c0030000 00001e00 00000078 00001c80', [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1], [0, 0.5, 2, 1]]],
  ['rgba16', f, 8, [[1, 0.5, 0, 2], [0, 0, 0, 0], [1, 1, 1, 1], [0, 1, 0, 1]], 'ffff0080 0000ffff 00000000 00000000 ffffffff ffffffff 0000ffff 0000ffff', [[1, N16(32768), 0, 1], [0, 0, 0, 0], [1, 1, 1, 1], [0, 1, 0, 1]]],
  ['rgba16_snorm', f, 8, [[1, -1, 0.5, 0], [0, 0, 0, 0], [2, -2, 0, 1], [-1, 1, -1, 1]], 'ff7f0180 00400000 00000000 00000000 ff7f0180 0000ff7f 0180ff7f 0180ff7f', [[1, -1, S16(16384), 0], [0, 0, 0, 0], [1, -1, 0, 1], [-1, 1, -1, 1]]],
  ['rgba16f', f, 8, [[1, -2, 0.5, 0], [0, 0, 0, 0], [1, 1, 1, 1], [2, 2, 2, 2]], '003c00c0 00380000 00000000 00000000 003c003c 003c003c 00400040 00400040', [[1, -2, 0.5, 0], [0, 0, 0, 0], [1, 1, 1, 1], [2, 2, 2, 2]]],
  ['rgba16ui', u, 8, [[1, 2, 3, 4], [0, 0, 0, 0], [65535, 0, 0, 1], [5, 6, 7, 8]], '01000200 03000400 00000000 00000000 ffff0000 00000100 05000600 07000800', [[1, 2, 3, 4], [0, 0, 0, 0], [65535, 0, 0, 1], [5, 6, 7, 8]]],
  ['rgba16i', s, 8, [[-1, 2, -3, 4], [0, 0, 0, 0], [-32768, 0, 0, 1], [5, 6, 7, 8]], 'ffff0200 fdff0400 00000000 00000000 00800000 00000100 05000600 07000800', [[-1, 2, -3, 4], [0, 0, 0, 0], [-32768, 0, 0, 1], [5, 6, 7, 8]]],
  ['rg32f', f, 8, [[1, -2, 0, 0], [0, 0, 0, 0], [0.5, 0.25, 0, 0], [2, 4, 0, 0]], '0000803f 000000c0 00000000 00000000 0000003f 0000803e 00000040 00008040', [[1, -2, 0, 1], [0, 0, 0, 1], [0.5, 0.25, 0, 1], [2, 4, 0, 1]]],
  ['rg32ui', u, 8, [[1, 4294967295, 0, 0], [0, 0, 0, 0], [2, 3, 0, 0], [4, 5, 0, 0]], '01000000 ffffffff 00000000 00000000 02000000 03000000 04000000 05000000', [[1, 4294967295, 0, 1], [0, 0, 0, 1], [2, 3, 0, 1], [4, 5, 0, 1]]],
  ['rg32i', s, 8, [[-1, 2, 0, 0], [0, 0, 0, 0], [-2, -3, 0, 0], [4, 5, 0, 0]], 'ffffffff 02000000 00000000 00000000 feffffff fdffffff 04000000 05000000', [[-1, 2, 0, 1], [0, 0, 0, 1], [-2, -3, 0, 1], [4, 5, 0, 1]]],
  ['rgba32f', f, 16, [[1, 2, 4, 8], [0, 0, 0, 0], [-1, -2, 0.5, 0], [1, 1, 1, 1]], '0000803f 00000040 00008040 00000041 00000000 00000000 00000000 00000000 000080bf 000000c0 0000003f 00000000 0000803f 0000803f 0000803f 0000803f', [[1, 2, 4, 8], [0, 0, 0, 0], [-1, -2, 0.5, 0], [1, 1, 1, 1]]],
  ['rgba32ui', u, 16, [[1, 2, 3, 4], [0, 0, 0, 0], [5, 6, 7, 8], [9, 10, 11, 12]], '01000000 02000000 03000000 04000000 00000000 00000000 00000000 00000000 05000000 06000000 07000000 08000000 09000000 0a000000 0b000000 0c000000', [[1, 2, 3, 4], [0, 0, 0, 0], [5, 6, 7, 8], [9, 10, 11, 12]]],
  ['rgba32i', s, 16, [[-1, 2, 3, 4], [0, 0, 0, 0], [5, -6, 7, 8], [9, 10, -11, 12]], 'ffffffff 02000000 03000000 04000000 00000000 00000000 00000000 00000000 05000000 faffffff 07000000 08000000 09000000 0a000000 f5ffffff 0c000000', [[-1, 2, 3, 4], [0, 0, 0, 0], [5, -6, 7, 8], [9, 10, -11, 12]]],
];

test('an image loaded and stored by one stage holds each format\'s bytes in its words, and reads them back (VK4 T11)', { skip: noGlslc, timeout: 300_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    for (const [format, image, bytes, values, enc, dec] of IMAGE_FORMATS) {
      const vec = image === f ? 'vec4' : image === u ? 'uvec4' : 'ivec4';
      const spv = join(tmp, 'rw.spv');
      const c = spawnSync('glslc', ['--target-env=vulkan1.2', `-DFORMAT=${format}`, `-DIMAGE=${image}`, `-DVEC=${vec}`, '-fshader-stage=comp', '-o', spv, join(root, 'tests/venus/t11-image-rw.comp')], { encoding: 'utf8' });
      assert.equal(c.status, 0, c.stderr);
      const b = readFileSync(spv);
      const r = translate({ name: format, stage: 5, words: new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)) });
      assert.equal(r.rc, 0, `${format}: ${r.text}`);
      const golden = Buffer.from(enc.replaceAll(' ', ''), 'hex');
      assert.equal(golden.length, 4 * bytes, `${format}: the table's bytes`);
      // A view of 4x2, rows 16 words apart as wg_cmd.c's view_words. Row 0 and the bytes past the texels are 0xa5 (a sub-word
      // store keeps its neighbours), row 1 the bytes to load.
      const row = 64, img = new Uint8Array(row * 2).fill(0xa5);
      img.set(golden, row);
      const params = new Uint8Array(new Uint32Array([4, 2, 1, row / 4, row * 2 / 4, 0, 0, 0]).buffer);
      const input = new (image === f ? Float32Array : image === u ? Uint32Array : Int32Array)(values.flat());
      // The view's parameters in the group's table (VK4 T21), at its binding's place.
      const res = await runCompute(r.text, [{ binding: 0, init: img }, { binding: 994, init: params }, { binding: 2, init: new Uint8Array(input.buffer) }, { binding: 4, size: 64 }]);
      if (!res) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
      assert.deepEqual(res.errors, [], `${format}: ${r.text}`);
      const stored = res.out[0];
      assert.equal(Buffer.from(stored.subarray(0, 4 * bytes)).toString('hex'), golden.toString('hex'), `${format}: the bytes stored`);
      assert.ok(stored.subarray(4 * bytes, row).every((v) => v === 0xa5), `${format}: bytes past the texels`);
      const got = res.out[3];
      const out = new (image === f ? Float32Array : image === u ? Uint32Array : Int32Array)(got.buffer, got.byteOffset, 16);
      dec.flat().forEach((v, i) => {
        // Float results within 2 ULP of a 16-bit fraction's; integers exact.
        if (image === f && Number.isFinite(v)) assert.ok(Math.abs(out[i] - v) < 1e-6, `${format}: component ${i} read ${out[i]}, wanted ${v}`);
        else assert.ok(Object.is(out[i], v), `${format}: component ${i} read ${out[i]}, wanted ${v}`);
      });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('atomics reach a storage image through its words, its loads, stores and sizes with them, and a texel buffer\'s words directly (VK4 T7)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const r = glslStage(translate, tmp, 'tests/venus/t7/image-atomics.comp');
    assert.equal(r.rc, 0, r.text);
    assert.match(r.text, /@binding\(0\) var<storage, read_write> r0_0: array<atomic<u32>>/);
    assert.match(r.text, /@binding\(2\) var<storage, read_write> r0_2: array<atomic<i32>>/);
    // Both resources' parameters in the group's table (VK4 T21): the image's at 0 and 1, the texel buffer's at 2 and 3.
    assert.match(r.text, /@binding\(994\) var<uniform> r0_994: array<vec4<u32>, 4>/);
    assert.doesNotMatch(r.text, /@binding\([13]\) /);
    const words = (n: number, f: (i: number) => number) => new Uint8Array(new Uint32Array(n).map((_, i) => f(i)).buffer);
    // A view of 16x4x3, rows 32 words apart, slices 128 (as wg_cmd.c's view_words), its words offset by nothing.
    const params = words(8, (i) => [16, 4, 3, 32, 128, 0, 0, 0][i]);
    const image = words(32 * 4 * 3, () => 0);
    // An r32i texel buffer's parameters, as wg_texel_buffer_layout's: sint, 4 bytes, identity with 0 and 1 past it;
    // starting one texel in; 8 texels (a ninth word stands past them).
    const SWIZ = 0 | (4 << 3) | (4 << 6) | (5 << 9);
    const tp = words(8, (i) => [3 | (4 << 8) | (SWIZ << 16), 4, 8, 0, 32, 0, 0, 0][i]);
    const tb = words(10, () => 5);
    const table = new Uint8Array(64);
    table.set(params, 0);
    table.set(tp, 32);
    const res = await runCompute(r.text, [{ binding: 0, init: image }, { binding: 994, init: table }, { binding: 2, init: tb }, { binding: 4, size: 29 * 4 }]);
    if (!res) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(res.errors, []);
    const img = new Uint32Array(res.out[0].buffer), o = new Uint32Array(res.out[3].buffer), tw = new Int32Array(res.out[2].buffer);
    assert.deepEqual([...o.slice(0, 3)], [16, 4, 3], 'imageSize');
    // Each of texels 0-3 of row 1, slice 1 took two invocations' bits.
    const at = (x: number, y: number, z: number) => img[x + y * 32 + z * 128];
    assert.deepEqual([0, 1, 2, 3].map((x) => at(x, 1, 1)), [0, 1, 2, 3].map((x) => (1 << x) | (1 << (x + 4))));
    // Stored, then swapped from what was stored.
    assert.deepEqual([...o.slice(11, 19)], [...Array(8).keys()].map((i) => 100 + i), 'the swaps\' old values');
    assert.deepEqual([...Array(8).keys()].map((i) => at(i, 0, 0)), [...Array(8).keys()].map((i) => 200 + i));
    // The texel buffer's texels start one word in; signed minima; nothing written past it.
    assert.deepEqual([...tw.slice(0, 10)], [5, ...[0, -1, -2, -3, -4, -5, -6, -7], 5]);
    assert.deepEqual([...o.slice(19, 27)], Array(8).fill(5), 'the minima\'s old values');
    assert.deepEqual([o[27], o[28]], [0, 0], 'reads past the views');
    assert.equal(img.reduce((a, b) => a + (b ? 1 : 0), 0), 12, 'written past the view');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('gl_ViewIndex is an override, declared only by a stage that reads it (VK4 T7)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const r = glslStage(translate, tmp, 'tests/venus/t7/view-index.vert');
    assert.equal(r.rc, 0, r.text);
    assert.match(r.text, /override wg_view: u32 = 0;/);
    assert.match(r.text, /= wg_view;/);
    assert.doesNotMatch(glslStage(translate, tmp, 'tests/venus/driver.vert').text, /wg_view/);
    const errors = await compile([r.text]);
    if (!errors) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(errors, [''], 'WGSL Chromium rejected');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('constant texture offsets are literals, whatever scalarizing made of them (VK4 T9)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const r = glslStage(translate, tmp, 'tests/venus/t9/offset.frag');
    assert.equal(r.rc, 0, r.text);
    assert.match(r.text, /textureSample\(.*vec2<i32>\(-8, 7\)\)/);
    assert.match(r.text, /textureLoad\(.*\+ vec2<i32>\(1, 2\)\)/);
    // Past a mirror-once reflection only the shader can apply it: before the wrap, texel -1 + 1 of a red and black row.
    const one = [255, 0, 0, 255], zero = [0, 0, 0, 255];
    const once = glslStage(translate, tmp, 'tests/venus/t9/offset.comp', { sampler: key(ADDRESS.once) });
    assert.equal(once.rc, 0, once.text);
    const res = await runSampled(once.text, [{ binding: 0, format: 'rgba8unorm', w: 2, h: 2, data: [...one, ...zero, ...one, ...zero] }], undefined, { binding: 2, size: 8 * 16 });
    if (!res) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(res.errors, []);
    assert.equal(res.out[0], 1, 'the first texel');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('offsets that aren\'t constants move fetches, and samples come from fetches at the level read (VK4 T24: maintenance8)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const r = glslStage(translate, tmp, 'tests/venus/t24/offset.comp', { sampler: key(ADDRESS.edge, { levels: 3 }) });
    assert.equal(r.rc, 0, r.text);
    // A 4×4 rgba8unorm image whose red is the texel's number: level 0's x + 4y, level 1's 100 + x + 2y, level 2's 200.
    const texel = (v: number) => [v, 0, 0, 255];
    const level = (n: number, base: number, row: number) => Array.from({ length: n * n }, (_, i) => texel(base + i % n + row * Math.floor(i / n))).flat();
    const sampled = r.text.includes('@binding(1) var') ? { binding: 1, filter: 'nearest' } : undefined;
    const res = await runSampled(r.text, [{ binding: 0, format: 'rgba8unorm', w: 4, h: 4, data: level(4, 0, 4), mips: [level(2, 100, 2), level(1, 200, 1)] }], sampled, { binding: 2, size: 8 * 16 });
    if (!res) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(res.errors, []);
    const red = (i: number) => Math.round(res.out[i * 4] * 255);
    assert.equal(red(0), 2, 'fetch: (1, 1) + (1, -1) of level 0');
    assert.equal(red(1), 102, 'LOD 1: texel (1, 0) + (-1, 1) of level 1, not a level-0-sized step');
    assert.equal(red(2), 6, 'gradients of 0: (0, 0) + (2, 1) of level 0');
    // The gather's texels (i0 j1, i1 j1, i1 j0, i0 j0) around (1, 1), moved one right: (1, 1), (2, 1), (2, 0), (1, 0).
    assert.deepEqual([12, 13, 14, 15].map((i) => Math.round(res.out[i] * 255)), [5, 6, 2, 1]);
    // Without a key (the stage's own module, whose bindings make the program's layout) a shadow sample keeps its texture.
    const shadow = glslStage(translate, tmp, 'tests/venus/t24/shadow.frag');
    assert.equal(shadow.rc, 0, shadow.text);
    assert.match(shadow.text, /@group\(0\) @binding\(0\) var r0_0: texture_depth_2d;/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a shadow sample past level 0 compares each texel of its level and filters the results (VK4 T9)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    // depth16unorm 4×4: level 0 all 0.25; level 1 a column of 0.25, a column of 0.75. Against 0.5, LESS: 0, and 0, 1.
    const u16 = (v: number) => [v & 255, v >> 8];
    const a = u16(16384), b = u16(49152);
    const level0 = Array.from({ length: 16 }, () => a).flat(), level1 = [...a, ...b, ...a, ...b];
    const values = async (sampler: Device['sampler']) => {
      const r = glslStage(translate, tmp, 'tests/venus/t9/shadow.comp', { sampler });
      assert.equal(r.rc, 0, r.text);
      assert.doesNotMatch(r.text, /textureSampleCompareLevel\(.*0\.75/);
      const res = await runSampled(r.text, [{ binding: 0, format: 'depth16unorm', w: 4, h: 4, data: level0, mips: [level1] }], undefined, { binding: 2, size: 8 * 16 });
      if (!res) return undefined;
      assert.deepEqual(res.errors, []);
      return [...res.out].filter((_, i) => i % 4 === 0).slice(0, 5).map((v) => Math.round(v * 1000) / 1000);
    };
    const LESS = 1, LEQUAL = 3;
    const nearest = await values(key(ADDRESS.edge, { levels: 2, compare: LESS }));
    if (!nearest) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    // LOD 0, 1, 0.25, 1 by gradients (half the image: 2 texels), and x 0.3 of level 1, its first column. x 0.5 is the
    // second column's by nearest.
    assert.deepEqual(nearest, [0, 1, 0, 1, 0], 'nearest');
    // Linear: 0.5 is the columns' edge, and the mip's 0.25 a quarter of that.
    const linear = await values(key(ADDRESS.edge, { levels: 2, compare: LESS, flags: 16 | 1 | 2 | 4 }));
    assert.deepEqual(linear, [0, 0.5, 0.125, 0.5, 0.1], 'linear');
    // A fixed-point format clamps the reference: 1.5 is 1, at or below a texel of 1.
    const clamped = glslStage(translate, tmp, 'tests/venus/t9/shadow-clamp.comp', { sampler: key(ADDRESS.edge, { levels: 2, compare: LEQUAL, flags: 16 | 128 }) });
    assert.equal(clamped.rc, 0, clamped.text);
    const full = Array.from({ length: 16 }, () => u16(65535)).flat(), half = Array.from({ length: 4 }, () => u16(65535)).flat();
    const res = await runSampled(clamped.text, [{ binding: 0, format: 'depth16unorm', w: 4, h: 4, data: full, mips: [half] }], undefined, { binding: 2, size: 8 * 16 });
    assert.deepEqual(res?.errors, []);
    assert.equal(res?.out[0], 1, 'the reference clamped: 1 <= 1');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a depth texture sampled with and without comparison prints, from its first module to a key of a bias (VK4 R5)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const texts = [glslStage(translate, tmp, 'tests/venus/r5/depth-and-compare.frag'), glslStage(translate, tmp, 'tests/venus/r5/depth-and-compare.frag', { sampler: key(ADDRESS.edge, { bias: 1 }) })];
    for (const r of texts) assert.equal(r.rc, 0, r.text);
    const errors = await compile(texts.map((r) => r.text));
    if (!errors) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(errors, ['', '']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a gather of a texture the stage compares goes by its sampler (the review of VK4 R5 to R7)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const r = glslStage(translate, tmp, 'tests/venus/r5/gather-depth.comp', { sampler: key(ADDRESS.repeat, { v: ADDRESS.repeat }) });
    assert.equal(r.rc, 0, r.text);
    // Two columns, 0 and 1: at u 0 a gather reads across the repeat: i0 is the last column.
    const u16 = (v: number) => [v & 255, v >> 8];
    const data = [...u16(0), ...u16(65535), ...u16(0), ...u16(65535)];
    const res = await runSampled(r.text, [{ binding: 0, format: 'depth16unorm', w: 2, h: 2, data }], { binding: 5, filter: 'nearest', compare: 'greater' }, { binding: 6, size: 8 * 16 });
    if (!res) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(res.errors, []);
    assert.deepEqual([...res.out.slice(0, 4)], [1, 0, 0, 1], 'i0 j1, i1 j1, i1 j0, i0 j0');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a border across levels is each level\'s, whatever clamps WebGPU\'s sampler has (VK4 R5)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const r = glslStage(await translator(), tmp, 'tests/venus/r5/border-levels.comp', { sampler: key(ADDRESS.border, { flags: 16 | 1 | 2 | 4, levels: 2, min: 0.5 }) });
    assert.equal(r.rc, 0, r.text);
    const sampled = /var r0_1: sampler/.test(r.text) ? { binding: 1, filter: 'linear', lodMinClamp: 0.5 } : undefined;
    const res = await runSampled(r.text, [{ binding: 0, format: 'rgba8unorm', w: 2, h: 2, data: Array(4).fill([255, 0, 0, 255]).flat(), mips: [[0, 0, 0, 255]] }], sampled, { binding: 2, size: 8 * 16 });
    if (!res) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(res.errors, []);
    assert.ok(Math.abs(res.out[0] - 0.5) < 0.01, `red ${res.out[0]}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('inter-stage variables past WebGPU\'s with a clip distance fail the stage, saying so (VK4 R5)', { skip: noGlslc, timeout: 120_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const r = glslStage(await translator(), tmp, 'tests/venus/r5/clip-many.vert');
    assert.notEqual(r.rc, 0, r.text);
    assert.match(r.text, /inter-stage variables/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a shadow sample WGSL can do stays WGSL\'s, without a key or at one level (VK4 T9)', { skip: noGlslc, timeout: 120_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    for (const sampler of [undefined, key(ADDRESS.edge, { levels: 1, compare: 1 })]) {
      const r = glslStage(translate, tmp, 'tests/venus/t9/shadow.comp', { sampler });
      assert.equal(r.rc, 0, r.text);
      assert.match(r.text, /textureSampleCompareLevel/);
      assert.doesNotMatch(r.text, /textureLoad/);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('textureQueryLod is worked out in the shader, an array\'s coordinate without its layer (VK4 T9)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const text = (file: string, sampler?: Device['sampler']) => {
      const r = glslStage(translate, tmp, file, { sampler });
      assert.equal(r.rc, 0, r.text);
      assert.doesNotMatch(r.text, /undefined/);
      return r.text;
    };
    const one = text('tests/venus/t9/query.frag');
    assert.match(one, /var r0_0: texture_2d<i32>/, 'the texture only asked, declared by its type');
    const keyed = text('tests/venus/t9/query.frag', key(ADDRESS.edge, { levels: 9, min: 5, max: 1000 }));
    // 5.0, as a constant's bits or (only floats reading it) as an f32 literal (GD G2).
    assert.match(keyed, /0x40a00000u|0x1\.4p\+2f/, 'the sampler\'s minLod');
    const errors = await compile([one, keyed, text('tests/venus/t9/query-array.frag'), text('tests/venus/t9/query-array.frag', key(ADDRESS.edge, { levels: 4 }))]);
    if (!errors) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.equal(errors.join(''), '');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('gl_HelperInvocation is an invocation that covers no sample, or demoted (VK4 T9)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const r = glslStage(translate, tmp, 'tests/venus/t9/helper.frag');
    assert.equal(r.rc, 0, r.text);
    assert.match(r.text, /@builtin\(sample_mask\) smask: u32/);
    assert.match(r.text, /wg_helper \|\| smask == 0u/);
    const run = await runFragment(r.text);
    if (!run) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(run.errors, []);
    assert.deepEqual(run.pixels[0], [0, 0, 0, 0], 'a covered pixel is no helper');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('workgroup and global ids take a dispatch\'s base from overrides, declared only where read (VK4 T9)', { skip: noGlslc, timeout: 120_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const r = glslStage(translate, tmp, 'tests/venus/t9/base.comp');
    assert.equal(r.rc, 0, r.text);
    assert.match(r.text, /override wg_base_x: u32 = 0u;/);
    assert.match(r.text, /wid \+ vec3<u32>\(wg_base_x, wg_base_y, wg_base_z\)/);
    assert.match(r.text, /gid \+ vec3<u32>\(wg_base_x, wg_base_y, wg_base_z\) \* vec3<u32>\(2u, 3u, 1u\)/);
    const none = glslStage(translate, tmp, 'tests/venus/t9/lid.comp');
    assert.equal(none.rc, 0, none.text);
    assert.doesNotMatch(none.text, /wg_base_x/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('gl_ClipDistance read by a fragment stage comes in at a free location, by its vec4 slot (VK4 T9)', { skip: noGlslc, timeout: 120_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-wgsl-'));
  try {
    const translate = await translator();
    const r = glslStage(translate, tmp, 'tests/venus/t9/clip-read.frag');
    assert.equal(r.rc, 0, r.text);
    // Location 0 is the program's own; slots 0 and 1 (distances 0-3, 4-7) take the next ones.
    assert.match(r.text, /@location\(1\) @interpolate\(perspective, center\) v1: vec4<f32>/);
    assert.match(r.text, /@location\(2\) @interpolate\(perspective, center\) v2: vec4<f32>/);
    assert.match(r.text, /i\.v1\.y/);
    assert.match(r.text, /i\.v2\.x/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
