// GD G2: what Dawn's createShaderModule costs on each of a corpus of WGSL modules (the translator's output for a
// program's stages: bench/vulkan/REPORT.md "GD G2"). Each module on a device of its own (no module cache between
// them), timed from createShaderModule to getCompilationInfo's answer, which waits for Tint's parse and resolve (the
// uniformity analysis among them); a module past TIMEOUT_S relaunches the browser and counts as a timeout.
//   node bench/vulkan/tint-time.ts <out.json> <file.wgsl | dir>...   (TIMEOUT_S, default 60; REPEAT, runs a module,
//   default 1, the median kept; CHROMIUM, CHROMIUM_ARGS as the tests take them; on the Mac through
//   bench/vulkan/mac-tint-time.sh)
// The GPU process keeps what it parsed by the module's text (a second run of the same text takes ~5 ms), so each run
// of a module ends with a comment of its own.
// Prints the slowest modules and the sum; the JSON has every module's ms, bytes and first errors.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

const [out, ...inputs] = process.argv.slice(2);
if (!out || !inputs.length) throw new Error('usage: tint-time.ts <out.json> <file.wgsl | dir>...');
const TIMEOUT_S = Number(process.env.TIMEOUT_S ?? 60), REPEAT = Number(process.env.REPEAT ?? 1);
const salt = `${process.pid}-${Date.now()}`;
const files = inputs.flatMap((p) => statSync(p).isDirectory()
  ? readdirSync(p).filter((f) => f.endsWith('.wgsl')).sort().map((f) => join(p, f)) : [p]);

const server = createServer((_q, r) => r.end('<!doctype html>')).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
const args = (process.env.CHROMIUM_ARGS ?? (process.platform === 'darwin' ? '--enable-unsafe-webgpu' : '--enable-unsafe-webgpu --enable-features=Vulkan')).split(' ').filter(Boolean);
let browser: Browser | undefined, page: Page | undefined;
const open = async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args });
  page = await browser.newPage();
  await page.goto(url);
};

type Row = { file: string; bytes: number; ms: number | null; runs?: number[]; errors: string[] };
const rows: Row[] = [];
let adapter: unknown;
try {
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (text.length === 0) continue;
    const runs: number[] = [];
    let errors: string[] = [];
    let timedOut = false;
    for (let k = 0; k < REPEAT && !timedOut; k++) {
      if (!page) await open();
      const code = `${text}\n// ${salt}-${k}\n`;
      const run = page!.evaluate(async (code) => {
        const a = await navigator.gpu.requestAdapter();
        if (!a) return { ms: -1, errors: ['no adapter'], adapter: null };
        // What the renderer asks for (web/venus-gpu.ts): the features its WGSL enables, the limits it binds up to.
        const want = ['shader-f16', 'dual-source-blending', 'subgroups', 'clip-distances'];
        const feats = [...a.features].filter((x) => want.includes(x)) as GPUFeatureName[];
        const l = a.limits;
        const d = await a.requestDevice({ requiredFeatures: feats, requiredLimits: {
          maxSampledTexturesPerShaderStage: l.maxSampledTexturesPerShaderStage, maxStorageBuffersPerShaderStage: l.maxStorageBuffersPerShaderStage,
          maxStorageTexturesPerShaderStage: l.maxStorageTexturesPerShaderStage, maxSamplersPerShaderStage: l.maxSamplersPerShaderStage,
          maxUniformBuffersPerShaderStage: l.maxUniformBuffersPerShaderStage, maxComputeWorkgroupStorageSize: l.maxComputeWorkgroupStorageSize,
          maxBindGroups: l.maxBindGroups } });
        const t0 = performance.now();
        const m = d.createShaderModule({ code });
        const info = await m.getCompilationInfo();
        const ms = performance.now() - t0;
        d.destroy();
        return { ms, errors: info.messages.filter((x) => x.type === 'error').map((x) => `${x.lineNum}: ${x.message.slice(0, 200)}`).slice(0, 2),
          adapter: { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device, description: a.info.description, features: feats } };
      }, code);
      const r = await Promise.race([run, new Promise<null>((res) => setTimeout(() => res(null), TIMEOUT_S * 1000))]);
      if (!r) {
        timedOut = true;
        run.catch(() => {});
        await browser!.close().catch(() => {});
        browser = page = undefined;
      } else {
        adapter ??= r.adapter;
        runs.push(+r.ms.toFixed(2));
        errors = r.errors;
      }
    }
    const median = runs.length ? [...runs].sort((a, b) => a - b)[Math.floor(runs.length / 2)] : null;
    rows.push(timedOut ? { file: basename(f), bytes: text.length, ms: null, errors: [`timeout ${TIMEOUT_S} s`] }
      : { file: basename(f), bytes: text.length, ms: median, ...(REPEAT > 1 ? { runs } : {}), errors });
    const x = rows[rows.length - 1];
    if (x.ms === null || x.ms > 100 || x.errors.length)
      console.log(`${x.ms === null ? 'timeout' : `${x.ms.toFixed(0)} ms`}  ${(x.bytes / 1024).toFixed(0)} KiB  ${x.file}  ${x.errors.join(' | ')}`);
  }
} finally {
  const version = browser?.version();
  await browser?.close().catch(() => {});
  server.close();
  const timed = rows.filter((r) => r.ms !== null);
  const sorted = [...timed].sort((a, b) => b.ms! - a.ms!);
  const res = { date: new Date().toISOString(), chromium: version, platform: process.platform, adapter, timeoutS: TIMEOUT_S, repeat: REPEAT, modules: rows.length,
    timeouts: rows.length - timed.length, errors: rows.filter((r) => r.errors.length && r.ms !== null).length,
    sumMs: +timed.reduce((s, r) => s + r.ms!, 0).toFixed(1), maxMs: sorted[0]?.ms ?? null, over100: timed.filter((r) => r.ms! > 100).length, rows };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(res, null, 1) + '\n');
  const { rows: _r, ...summary } = res;
  console.log(JSON.stringify(summary));
}
