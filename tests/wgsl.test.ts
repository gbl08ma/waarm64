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

/** Why a stage may not translate: what the direct set doesn't offer. */
const OUTSIDE = /16-bit values|outside the layout \(set [4-9]|texel buffers|dynamically indexed/;

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
  wgsl_test_result(): number; venus_alloc(n: number): number; venus_free(p: number): void;
};

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
  return (s: Stage) => {
    const p = ex.venus_alloc(s.words.byteLength) >>> 0;
    new Uint8Array(memory.buffer, p, s.words.byteLength).set(new Uint8Array(s.words.buffer, s.words.byteOffset, s.words.byteLength));
    const t0 = performance.now();
    const rc = ex.wgsl_test_translate(p, s.words.length, s.stage);
    const ms = performance.now() - t0;
    ex.venus_free(p);
    return { rc, text: text(ex.wgsl_test_result() >>> 0), ms };
  };
}

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
      const want = ['clip-distances', 'dual-source-blending', 'shader-f16'].filter((f) => adapter.features.has(f)) as GPUFeatureName[];
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
    const stage = (format: string) => {
      const spv = join(tmp, `${format}.spv`);
      const r = spawnSync('glslc', ['--target-env=vulkan1.2', `-DSTORAGE_RW_FORMAT=${format}`, '-fshader-stage=comp', '-o', spv, join(root, 'tests/venus/storage-rw.comp')], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const b = readFileSync(spv);
      return translate({ name: format, stage: 5, words: new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)) });
    };
    const ok = stage('r32f');
    assert.equal(ok.rc, 0, ok.text);
    assert.match(ok.text, /texture_storage_2d<r32float, read_write>/);
    for (const [format, name] of [['rgba8', 'rgba8unorm'], ['rg16f', 'rg16float'], ['rg32f', 'rg32float']]) {
      const r = stage(format);
      assert.equal(r.rc, 3, `${format} translated: ${r.text.slice(0, 200)}`);
      assert.equal(r.text, `a read_write storage image of format ${name}`);
    }
    const errors = await compile([ok.text]);
    if (!errors) return t.skip('SKIPPED: Chromium has no WebGPU adapter here');
    assert.deepEqual(errors, [''], 'WGSL Chromium rejected');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
