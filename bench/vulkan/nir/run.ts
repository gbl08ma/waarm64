// VK1 step 1 (bench/vulkan/REPORT.md "VK1"): route (b)'s shader path over VK0's stages, natively, in Node and in
// Chromium, with the module's download size. Each arm runs every stage once (cold), then --reps rounds (warm: a
// stage's median); the MSL each arm emits is hashed and checked against the native build's.
//   node bench/vulkan/nir/run.ts <out.json> [--arm native,node,chromium] [--reps 5] [--spirv target/vk1/spirv]
//     [--wasm target/vk1/wasi/spike.wasm] [--native target/vk1/native/spike]
// The stages: bench/vulkan/translate/programs.sh with SPIRV_DIR (<dir>/<program>/0x<hash>.<stage>.spv).
// CHROMIUM and CHROMIUM_ARGS as bench/vulkan/micro.ts takes them; TARGET when target/ is elsewhere (the Mac's copy).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { brotliCompressSync, constants, gzipSync, zstdCompressSync } from 'node:zlib';
import { loadSpike, nirHashes, runAll, type Pass } from './spike.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TARGET = process.env.TARGET ?? join(ROOT, 'target');
const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  arm: { type: 'string', default: 'native,node,chromium' }, reps: { type: 'string', default: '5' },
  spirv: { type: 'string', default: join(TARGET, 'vk1/spirv') }, wasm: { type: 'string', default: join(TARGET, 'vk1/wasi/spike.wasm') },
  native: { type: 'string', default: join(TARGET, 'vk1/native/spike') } } });
const out = positionals[0];
if (!out) throw new Error('usage: run.ts <out.json> [--arm native,node,chromium] [--reps n]');
const reps = Number(o.reps);
const spirv = resolve(o.spirv!);
const files = readdirSync(spirv, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().flatMap((p) => readdirSync(join(spirv, p)).filter((f) => f.endsWith('.spv')).sort().map((f) => `${p}/${f}`));
const stages = files.map((name) => ({ name, words: new Uint8Array(readFileSync(join(spirv, name))) }));

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length & 1 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const quantile = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

interface Row { name: string; rc: number; coldMs: number; ms: number[]; totalMs: number; outLen: number; hash: number; error?: string }
function rows(passes: Pass[]): Row[] {
  return passes.map((p) => {
    const warm = p.results.slice(1);
    return { name: p.name, rc: p.results[0].rc, coldMs: p.results[0].totalMs,
      ms: [0, 1, 2].map((i) => median(warm.map((r) => r.ms[i]))), totalMs: median(warm.map((r) => r.totalMs)),
      outLen: p.results[0].outLen, hash: p.results[0].hash, error: p.results[0].error };
  });
}
function summary(rs: Row[]) {
  const ok = rs.filter((r) => r.rc === 0);
  const toNir = ok.map((r) => r.ms[0] + r.ms[1]);
  const total = ok.map((r) => r.totalMs);
  const byProgram: Record<string, { stages: number; ok: number; medianMs: number }> = {};
  for (const r of rs) {
    const p = r.name.split('/')[0];
    byProgram[p] ??= { stages: 0, ok: 0, medianMs: 0 };
    byProgram[p].stages++;
    if (r.rc === 0) byProgram[p].ok++;
  }
  for (const p of Object.keys(byProgram)) byProgram[p].medianMs = median(ok.filter((r) => r.name.startsWith(`${p}/`)).map((r) => r.totalMs));
  return { stages: rs.length, ok: ok.length,
    medianMs: median(total), p90Ms: quantile(total, 0.9), maxMs: Math.max(...total),
    toNirMedianMs: median(toNir), toNirP90Ms: quantile(toNir, 0.9),
    phaseMedianMs: [0, 1, 2].map((i) => median(ok.map((r) => r.ms[i]))),
    coldSumMs: ok.reduce((s, r) => s + r.coldMs, 0), warmSumMs: total.reduce((s, x) => s + x, 0), byProgram };
}

const report: Record<string, unknown> = { schema: 1, date: new Date().toISOString(), platform: process.platform, arch: process.arch,
  node: process.version, reps, spirv: relative(ROOT, spirv), arms: {} };
const arms = report.arms as Record<string, unknown>;
const wasmBytes = readFileSync(o.wasm!);
report.wasm = { path: relative(ROOT, o.wasm!), bytes: wasmBytes.length, gzip9: gzipSync(wasmBytes, { level: 9 }).length,
  brotli11: brotliCompressSync(wasmBytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: wasmBytes.length } }).length,
  zstd19: zstdCompressSync(wasmBytes, { params: { [constants.ZSTD_c_compressionLevel]: 19 } }).length };
console.log(`spike.wasm: ${wasmBytes.length} bytes, gzip -9 ${(report.wasm as { gzip9: number }).gzip9}, brotli ${(report.wasm as { brotli11: number }).brotli11}`);
let reference: Map<string, number> | undefined;
let nirReference: number[] | undefined;

for (const arm of o.arm!.split(',')) {
  let rs: Row[];
  let extra: Record<string, unknown> = {};
  if (arm === 'native') {
    // One process over every stage reps+1 times (its lines in order), so warm runs are warm.
    const args = Array.from({ length: reps + 1 }, () => files.map((f) => join(spirv, f))).flat();
    const lines = execFileSync(o.native!, args, { maxBuffer: 1 << 26, timeout: 300_000 }).toString().trim().split('\n').map((l) => JSON.parse(l));
    const passes: Pass[] = files.map((name, i) => ({ name, stage: 0, results: Array.from({ length: reps + 1 }, (_, r) => {
      const l = lines[r * files.length + i];
      const ms = (l.ns as number[]).map((v) => v / 1e6);
      return { rc: l.rc, ms, totalMs: ms[0] + ms[1] + ms[2], outLen: l.out, hash: l.hash };
    }) }));
    rs = rows(passes);
    reference = new Map(rs.map((r) => [r.name, r.hash]));
    nirReference = execFileSync(o.native!, files.map((f) => join(spirv, f)), { env: { ...process.env, SPIKE_NIR: '1' }, maxBuffer: 1 << 26, timeout: 300_000 })
      .toString().trim().split('\n').map((l) => JSON.parse(l).hash as number);
    extra = { nir: nirReference };
  } else if (arm === 'node') {
    const t0 = performance.now();
    const module = await WebAssembly.compile(wasmBytes);
    const t1 = performance.now();
    const spike = await loadSpike(module);
    extra = { compileMs: t1 - t0, instantiateMs: performance.now() - t1 };
    rs = rows(runAll(spike, stages, reps));
    extra.nir = nirHashes(spike, stages);
    extra.memoryBytes = spike.memoryBytes();
  } else if (arm === 'chromium') {
    const { chromium } = await import('playwright-core');
    const { serve } = await import('../server.ts');
    const server = await serve(ROOT, TARGET);
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: (process.env.CHROMIUM_ARGS ?? '').split(' ').filter(Boolean) });
    try {
      const page = await browser.newPage();
      page.on('console', (m) => console.error(`[page] ${m.text()}`));
      await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/bench/vulkan/nir/index.html`);
      const wasmUrl = `/target/${relative(TARGET, o.wasm!)}`;
      const urls = files.map((f) => `/target/${relative(TARGET, join(spirv, f))}`);
      const r = await page.evaluate(([w, u, n]) => (window as unknown as { vk1: (w: string, u: string[], n: number) => Promise<unknown> }).vk1(w, u, n),
        [wasmUrl, urls, reps] as [string, string[], number]) as { passes: Pass[] } & Record<string, unknown>;
      r.passes.forEach((p, i) => { p.name = files[i]; });
      rs = rows(r.passes);
      const { passes: _, ...rest } = r;
      extra = { ...rest, browser: browser.version() };
    } finally {
      await browser.close();
      server.close();
    }
  } else throw new Error(`unknown arm ${arm}`);
  const mismatched = reference && arm !== 'native' ? rs.filter((r) => r.rc === 0 && reference!.get(r.name) !== r.hash).map((r) => r.name) : [];
  const nirMismatched = nirReference && arm !== 'native' ? files.filter((_, i) => (extra.nir as number[])[i] !== nirReference![i]) : [];
  const s = summary(rs);
  arms[arm] = { ...extra, summary: s, mismatched, nirMismatched, stages: rs };
  console.log(`${arm.padEnd(8)} ${s.ok}/${s.stages} ok, a stage ${s.medianMs.toFixed(2)} ms median, p90 ${s.p90Ms.toFixed(2)}, max ${s.maxMs.toFixed(1)}; ` +
    `to NIR ${s.toNirMedianMs.toFixed(2)} (p90 ${s.toNirP90Ms.toFixed(2)}); phases ${s.phaseMedianMs.map((x) => x.toFixed(2)).join(' / ')}; ` +
    `cold total ${s.coldSumMs.toFixed(0)} ms, warm ${s.warmSumMs.toFixed(0)}` + (mismatched.length ? `; MSL of ${mismatched.length} differs from native` : '') + (nirMismatched.length ? `; NIR of ${nirMismatched.length} differs` : ''));
  for (const r of rs.filter((x) => x.rc)) console.log(`  ${r.name}: rc ${r.rc} ${r.error?.slice(0, 120)}`);
}
writeFileSync(out, JSON.stringify(report) + '\n');
