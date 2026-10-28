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
const OUTSIDE = /16-bit values|16-bit float arithmetic without|outside the layout \(set [4-9]|dynamically indexed|^image atomics$|^a texture offset that isn't a constant$/;

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
  wgsl_test_result(): number; venus_alloc(n: number): number; venus_free(p: number): void;
};

/** What a stage is translated for: the device's WGSL features, its subgroups' size, and (VK3 L7.2) a binding sampled
 * through a YCbCr conversion (VkFormat, VkSamplerYcbcrModelConversion, VkSamplerYcbcrRange, VkChromaLocation x and y,
 * the chroma VkFilter), as an immutable sampler in its set layout. */
type Device = { features?: number; subgroupSize?: number; ycbcr?: { set: number; binding: number; format: number; model: number; range: number; x: number; y: number; filter: number } };

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
const WGSL = { TIER2: 1, DUAL_SOURCE: 2, SUBGROUPS: 4, F16: 8 };
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
    for (const [format, name] of [['rgba8', 'rgba8unorm'], ['rg16f', 'rg16float'], ['rg32f', 'rg32float']]) {
      const r = stage(format);
      assert.equal(r.rc, 3, `${format} translated: ${r.text.slice(0, 200)}`);
      assert.equal(r.text, `a read_write storage image of format ${name}`);
    }
    // With texture-formats-tier2 (VK3 L5): tier2's formats read_write, the others still refused.
    const t2: string[] = [];
    for (const [format, name] of [['rgba8', 'rgba8unorm'], ['r16f', 'r16float'], ['rgba16f', 'rgba16float'], ['r8', 'r8unorm'], ['rgba32f', 'rgba32float']]) {
      const r = stage(format, WGSL.TIER2);
      assert.equal(r.rc, 0, `${format}: ${r.text.slice(0, 200)}`);
      assert.match(r.text, new RegExp(`texture_storage_2d<${name}, read_write>`));
      t2.push(r.text);
    }
    for (const [format, name] of [['rg16f', 'rg16float'], ['rg32f', 'rg32float'], ['rgba8_snorm', 'rgba8snorm']]) {
      const r = stage(format, WGSL.TIER2);
      assert.equal(r.text, `a read_write storage image of format ${name}`);
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
    assert.match(demote, /= wg_helper;/);
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

test('subgroup operations are WGSL\'s where the device has subgroups of one size, and run right (VK3 L5)', { skip: noGlslc, timeout: 120_000 }, async (t) => {
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
    // Without the device's subgroups (or with sizes that vary), subgroups of one: the basic operations, no more.
    const one = glslStage(translate, tmp, 'tests/venus/l5/subgroups.comp');
    assert.equal(one.rc, 3, one.text.slice(0, 200));
    assert.match(one.text, /^the subgroup operation \w+ without the device's subgroups$/);
    const errors = await compile([all.text]);
    if (!errors) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    if (!/subgroups/.test(errors[0])) assert.equal(errors[0], '', 'WGSL Chromium rejected');

    // Run: each invocation's results against its subgroup's (members by their first invocation, in their order).
    const run = async (size: number) => {
      const r = glslStage(translate, tmp, 'tests/venus/l5/subgroups-run.comp', { features: WGSL.SUBGROUPS, subgroupSize: size });
      assert.equal(r.rc, 0, r.text);
      return runCompute(r.text, [{ binding: 0, size: 64 * 16 * 4 }], ['subgroups']);
    };
    let res = await run(4);
    if (!res) return t.skip('SKIPPED: the adapter has no subgroups');
    if (res.min !== res.max) return t.skip(`SKIPPED: the adapter's subgroups vary in size (${res.min}-${res.max})`);
    if (res.min !== 4) res = (await run(res.min))!;
    assert.deepEqual(res.errors, []);
    const o = new Uint32Array(res.out[0].buffer);
    const at = (n: number, k: number) => o[n * 16 + k];
    const groups = new Map<number, number[]>();
    for (let n = 0; n < 64; n++) groups.set(at(n, 2), [...(groups.get(at(n, 2)) ?? []), n]);
    const bad: string[] = [];
    for (let n = 0; n < 64; n++) {
      const g = groups.get(at(n, 2))!.sort((a, b) => at(a, 0) - at(b, 0));
      const inv = at(n, 0), size = at(n, 1), lane = (i: number) => g.find((m) => at(m, 0) === i)!;
      const want = [inv, res.min, g[0], g.reduce((a, b) => a + b, 0), g.filter((m) => at(m, 0) <= inv).reduce((a, b) => a + b, 0),
        g.filter((m) => at(m, 0) < inv).reduce((a, m) => Math.max(a, m * 7 % 5), 0), g.filter((m) => m & 1).length,
        lane(inv ^ 1), inv >= 1 ? lane(inv - 1) : undefined, lane(inv & ~1) + lane(inv | 1), lane(inv ^ 1), lane((inv & ~3) | 3),
        (Math.min(...g) - 40) >>> 0, inv, 1 + (inv === 0 ? 2 : 0), lane(size - 1 - inv)];
      want.forEach((w, k) => { if (w !== undefined && at(n, k) !== w) bad.push(`invocation ${n} result ${k}: ${at(n, k)}, not ${w}`); });
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
 * its bytes at its WGSL binding, a sampler (`filter`) at `sampler`, a storage buffer of `size` bytes at `out`, read back.
 */
async function runSampled(code: string, textures: { binding: number; format: string; w: number; h: number; data: number[] }[], sampler: { binding: number; filter: string }, out: { binding: number; size: number }) {
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
        const tex = device.createTexture({ size: [t.w, t.h], format: t.format as GPUTextureFormat, usage: 0x2 | 0x4 /* COPY_DST | TEXTURE_BINDING */ });
        const bpp = t.data.length / (t.w * t.h);
        device.queue.writeTexture({ texture: tex }, new Uint8Array(t.data), { bytesPerRow: t.w * bpp }, [t.w, t.h]);
        return { binding: t.binding, resource: tex.createView() };
      });
      entries.push({ binding: sampler.binding, resource: device.createSampler({ magFilter: sampler.filter as GPUFilterMode, minFilter: sampler.filter as GPUFilterMode }) });
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
