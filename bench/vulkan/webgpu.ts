// VK0's WebGPU arms in headless Chromium (bench/vulkan/REPORT.md): serves the repository, opens
// bench/vulkan/webgpu/index.html and runs the scene at every setting, one JSON a setting like the native sweep's
// (bench/vulkan/sweep.sh), with the CPU time of Chromium's processes over the timed frames (CDP's
// SystemInfo.getProcessInfo: the renderer, which runs the page's worker, and the GPU process).
// The page is served by bench/vulkan/server.ts (no Vite: the NVIDIA desktop's script runs it from a copy).
//   node bench/vulkan/webgpu.ts <out dir> [label]
//   node bench/vulkan/webgpu.ts --probe     (the adapter this Chromium gets, as JSON on stdout)
//   node bench/vulkan/webgpu.ts --dump FRAME:out.ppm [--fish N | --toolkit N] [--mode storage|dynamic|immediates]
// FISH, TOOLKIT, MSAA, MODES (space-separated lists), WARMUP, SAMPLES, FRAMES, IN_FLIGHT, GPU_FRAMES override;
// CHROMIUM picks the browser and CHROMIUM_ARGS its switches (default: the dev VM's SwiftShader switches on Linux,
// --enable-unsafe-webgpu on macOS; HEADED=1 opens a window).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { serve } from './server.ts';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: { probe: { type: 'boolean' }, dump: { type: 'string' }, fish: { type: 'string' }, toolkit: { type: 'string' }, mode: { type: 'string' }, msaa: { type: 'string' } },
});
const env = (k: string, d: string) => process.env[k] ?? d;
const list = (k: string, d: string) => env(k, d).split(/\s+/).filter(Boolean);
const defaultArgs = process.platform === 'darwin' ? '--enable-unsafe-webgpu' : '--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=swiftshader --use-gl=angle';
const chromiumArgs = env('CHROMIUM_ARGS', defaultArgs).split(' ').filter(Boolean);

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
const iqr = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const n = s.length; return n ? s[Math.floor((3 * n) / 4)] - s[Math.floor(n / 4)] : 0; };

// The pages from this checkout (or a copy: the NVIDIA script's), the pack and the wasm from target/ (TARGET overrides).
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const server = await serve(ROOT, process.env.TARGET ?? join(ROOT, 'target'));
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: chromiumArgs, headless: !process.env.HEADED });
const cdp = await browser.newBrowserCDPSession();
type Proc = { type: string; id: number; cpuTime: number };
const procs = async () => ((await cdp.send('SystemInfo.getProcessInfo')) as unknown as { processInfo: Proc[] }).processInfo;
let marks: Record<string, Promise<Proc[]>> = {};
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('@')) marks[t.slice(1)] = procs();
    else console.error(`[page] ${t}`);
  });
  page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/bench/vulkan/webgpu/index.html`);
  const adapter = await page.evaluate(() => (window as unknown as { vk0: { init(p: string, w: string): Promise<unknown> } }).vk0.init('/target/vulkan/aquarium.pack', '/target/vulkan/scene.wasm'));
  const isolated = await page.evaluate(() => (window as unknown as { crossOriginIsolatedPage: boolean }).crossOriginIsolatedPage);
  if (!isolated) throw new Error('the page is not cross-origin isolated');
  console.error(`adapter: ${JSON.stringify(adapter)}`);
  if (opts.probe) console.log(JSON.stringify(adapter));
  const base = { width: 1920, height: 1080, warmup: Number(env('WARMUP', '60')), samples: Number(env('SAMPLES', '10')), frames: Number(env('FRAMES', '60')),
    inFlight: Number(env('IN_FLIGHT', '2')), gpuFrames: Number(env('GPU_FRAMES', '20')) };

  if (opts.probe) {
    // --probe: the adapter only (printed above).
  } else if (opts.dump) {
    const [frame, file] = [Number(opts.dump.split(':')[0]), opts.dump.slice(opts.dump.indexOf(':') + 1)];
    const s = { ...base, fish: Number(opts.fish ?? (opts.toolkit ? 0 : 1000)), toolkit: Number(opts.toolkit ?? 0), msaa: Number(opts.msaa ?? 1), fishMode: opts.mode ?? 'storage' };
    const b64 = await page.evaluate(([s, f]) => (window as unknown as { vk0: { dump(s: unknown, f: number): Promise<string> } }).vk0.dump(s, f as number), [s, frame] as const);
    const rgba = Buffer.from(b64, 'base64');
    const rgb = Buffer.alloc(s.width * s.height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]; }
    writeFileSync(file, Buffer.concat([Buffer.from(`P6\n${s.width} ${s.height}\n255\n`), rgb]));
    console.error(`frame ${frame} -> ${file}`);
  } else {
    const out = positionals[0];
    if (!out) throw new Error('usage: webgpu.ts <out dir> [label]');
    mkdirSync(out, { recursive: true });
    const label = positionals[1] ?? '';
    const settings: { name: string; fish: number; toolkit: number; msaa: number; fishMode: string }[] = [];
    for (const msaa of list('MSAA', '1 4').map(Number)) {
      for (const mode of list('MODES', 'storage')) {
        for (const n of list('FISH', '1 100 1000 10000 30000').map(Number)) settings.push({ name: `fish-${n}-msaa${msaa}-${mode}`, fish: n, toolkit: 0, msaa, fishMode: mode });
      }
      for (const q of list('TOOLKIT', '2000 8000').map(Number)) settings.push({ name: `toolkit-${q}-msaa${msaa}`, fish: 0, toolkit: q, msaa, fishMode: 'storage' });
    }
    for (const st of settings) {
      const s = { ...base, ...st };
      marks = {};
      let r: { frameMs: number[]; jsMs: number[]; gpuMs: number[]; drawsPerFrame: number; uploadBytesPerFrame: number; pipelineMs: number; adapter: Record<string, unknown> };
      try {
        r = await page.evaluate((s) => (window as unknown as { vk0: { run(s: unknown): Promise<typeof r> } }).vk0.run(s), s);
      } catch (e) {
        console.error(`${st.name}: ${(e as Error).message.split('\n')[0]}`);
        continue;
      }
      const [p0, p1] = await Promise.all([marks.start, marks.end]);
      const frames = s.samples * s.frames;
      const cpu: Record<string, number> = {};
      for (const a of p1 ?? []) {
        const b = p0?.find((x) => x.id === a.id);
        if (b) cpu[a.type] = (cpu[a.type] ?? 0) + ((a.cpuTime - b.cpuTime) * 1000) / frames;
      }
      const result = {
        arm: 'webgpu', label, browser: browser.version(), chromiumArgs: chromiumArgs.join(' '), platform: process.platform, arch: process.arch,
        adapter: r.adapter, scene: s.toolkit ? 'toolkit' : 'aquarium', fish: s.fish, quads: s.toolkit, width: s.width, height: s.height,
        msaa: s.msaa, fishMode: s.fishMode, inFlight: s.inFlight, warmup: s.warmup, frames: s.frames, pipelineMs: r.pipelineMs,
        drawsPerFrame: r.drawsPerFrame, uploadBytesPerFrame: r.uploadBytesPerFrame,
        frameMs: { median: median(r.frameMs), iqr: iqr(r.frameMs) }, jsMs: { median: median(r.jsMs), iqr: iqr(r.jsMs) },
        gpuMs: { median: median(r.gpuMs), iqr: iqr(r.gpuMs) }, processCpuMsPerFrame: cpu,
        frameSamples: r.frameMs, jsSamples: r.jsMs, gpuSamples: r.gpuMs,
      };
      writeFileSync(join(out, `${st.name}.json`), JSON.stringify(result, null, 1) + '\n');
      const c = Object.entries(cpu).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ');
      console.log(`${label} ${st.name}: ${result.frameMs.median.toFixed(3)} ms a frame (IQR ${result.frameMs.iqr.toFixed(3)}), worker ${result.jsMs.median.toFixed(3)} ms, GPU ${result.gpuMs.median.toFixed(3)} ms; CPU ms a frame: ${c}`);
    }
  }
} finally {
  await browser.close();
  server.close();
}
