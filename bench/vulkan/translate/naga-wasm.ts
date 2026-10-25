// Question D's wasm timing (bench/vulkan/REPORT.md): naga's SPIR-V to WGSL in wasm, as the translator would run it in
// the GPU worker. naga's CLI built for wasm32-wasip1 (`cargo +stable install --locked naga-cli --target wasm32-wasip1
// --root target/vulkan-tools/naga-wasm`) runs under Node's WASI on each of a trace's pipeline stages (prepared as
// shaders.ts does: specialization frozen, samplers split, bindings renumbered), the module compiled once and an
// instance a translation; the native CLI timed beside it (its process start included, and measured alone).
//   node bench/vulkan/translate/naga-wasm.ts <trace dir> [naga.wasm] [out.json]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WASI } from 'node:wasi';
import { renumberBindings } from './shaders.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const [dir, wasmPath = 'target/vulkan-tools/naga-wasm/bin/naga.wasm', outPath] = process.argv.slice(2);
if (!dir) throw new Error('usage: naga-wasm.ts <trace dir> [naga.wasm] [out.json]');
const setup = JSON.parse(readFileSync(join(dir, 'setup.json'), 'utf8')) as Json;
const tmp = mkdtempSync(join(tmpdir(), 'vk0-naga-'));
const native = join(process.env.HOME ?? '', '.cargo/bin/naga');
const t0 = performance.now();
const module = await WebAssembly.compile(readFileSync(wasmPath));
const compileMs = performance.now() - t0;
const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];
const rows: Json[] = [];
const seen = new Set<string>();
try {
  // The native CLI's own start: --version, to subtract.
  const startMs = median(Array.from({ length: 5 }, () => { const a = performance.now(); spawnSync(native, ['--version']); return performance.now() - a; }));
  for (const p of Object.values(setup.pipelines as Record<string, Json>)) {
    for (const st of p.stages as Json[]) {
      const key = `${setup.shaders[st.module].hash}:${(st.spec as Json[]).map((s) => `${s.id}=${s.value}`).join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const spec = (st.spec as Json[]).map((s) => `${s.id}:${s.value}`).join(' ');
      const optF = join(tmp, 'opt.spv');
      spawnSync('spirv-opt', [...(spec ? ['--set-spec-const-default-value', spec] : []), '--freeze-spec-const', '--fold-spec-const-op-composite',
        '--split-combined-image-sampler', join(dir, setup.shaders[st.module].spv), '-o', optF]);
      writeFileSync(optF, renumberBindings(new Uint8Array(readFileSync(optF))));
      const wasmRuns: number[] = [], nativeRuns: number[] = [];
      for (let i = 0; i < 5; i++) {
        const wasi = new WASI({ version: 'preview1', args: ['naga', '--keep-coordinate-space', '/w/opt.spv', `/w/out${i}.wgsl`], preopens: { '/w': tmp }, returnOnExit: true });
        const a = performance.now();
        const inst = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport } as WebAssembly.Imports);
        const code = wasi.start(inst);
        wasmRuns.push(performance.now() - a);
        if (code !== 0) throw new Error(`naga.wasm exited ${code} on ${key}`);
        const b = performance.now();
        spawnSync(native, ['--keep-coordinate-space', optF, join(tmp, 'n.wgsl')]);
        nativeRuns.push(performance.now() - b - startMs);
      }
      const same = readFileSync(join(tmp, 'out0.wgsl'), 'utf8') === readFileSync(join(tmp, 'n.wgsl'), 'utf8');
      rows.push({ key, stage: st.stage, spvBytes: readFileSync(optF).length, wasmMs: median(wasmRuns), nativeMs: Math.max(0, median(nativeRuns)), sameOutput: same });
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
const sum = (k: string) => rows.reduce((s, r) => s + r[k], 0);
const report = { trace: dir, compileMs, stages: rows.length, wasmMsTotal: sum('wasmMs'), nativeMsTotal: sum('nativeMs'), rows };
if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 1) + '\n');
console.log(`naga.wasm compiled in ${compileMs.toFixed(0)} ms; ${rows.length} stages: ${report.wasmMsTotal.toFixed(1)} ms in wasm (instance included), ${report.nativeMsTotal.toFixed(1)} ms native (process start subtracted); same output: ${rows.every((r) => r.sameOutput)}`);
for (const r of rows) console.log(`  ${r.key.padEnd(30)} ${String(r.spvBytes).padStart(6)} B  wasm ${r.wasmMs.toFixed(2)} ms  native ${r.nativeMs.toFixed(2)} ms`);
