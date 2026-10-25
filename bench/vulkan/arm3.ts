// VK0's arm 3 in headless Chromium (bench/vulkan/REPORT.md): bench/vulkan/translate/index.html replays a converted
// capture (convert.ts, shaders.ts) through the prototype translator, with the CPU of Chromium's processes over the
// timed frames as bench/vulkan/webgpu.ts measures them.
//   node bench/vulkan/arm3.ts <out dir> <label> <trace...>         (traces: directories under target/, e.g. vulkan/captures/fish1000-trace)
//   node bench/vulkan/arm3.ts --dump FRAME:out.ppm <trace>
// WARMUP, SAMPLES, FRAMES, IN_FLIGHT, CHROMIUM, CHROMIUM_ARGS, TARGET as webgpu.ts's; NO_IMMEDIATES=1 sends every
// pipeline's push constants through the uniform ring.
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { serve } from './server.ts';

const { values: opts, positionals } = parseArgs({ allowPositionals: true, options: { dump: { type: 'string' } } });
const env = (k: string, d: string) => process.env[k] ?? d;
const defaultArgs = process.platform === 'darwin' ? '--enable-unsafe-webgpu' : '--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=swiftshader --use-gl=angle';
const chromiumArgs = env('CHROMIUM_ARGS', defaultArgs).split(' ').filter(Boolean);
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
const iqr = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const n = s.length; return n ? s[Math.floor((3 * n) / 4)] - s[Math.floor(n / 4)] : 0; };

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const server = await serve(ROOT, process.env.TARGET ?? join(ROOT, 'target'));
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: chromiumArgs, headless: !process.env.HEADED });
const cdp = await browser.newBrowserCDPSession();
type Proc = { type: string; id: number; cpuTime: number };
const procs = async () => ((await cdp.send('SystemInfo.getProcessInfo')) as unknown as { processInfo: Proc[] }).processInfo;
type Vk0 = { vk0: { init(u: string, noImmediates?: boolean): Promise<unknown>; run(s: unknown): Promise<Record<string, any>>; dump(s: unknown, f: number, i: number): Promise<{ b64: string; width: number; height: number }> } }; // eslint-disable-line @typescript-eslint/no-explicit-any
const o = { warmup: Number(env('WARMUP', '60')), samples: Number(env('SAMPLES', '10')), frames: Number(env('FRAMES', '60')), inFlight: Number(env('IN_FLIGHT', '2')), gpuFrames: 0 };
try {
  const traces = opts.dump ? positionals : positionals.slice(2);
  for (const trace of traces) {
    let marks: Record<string, Promise<Proc[]>> = {};
    const page = await browser.newPage();
    page.on('console', (m) => { const t = m.text(); if (t.startsWith('@')) marks[t.slice(1)] = procs(); else console.error(`[page] ${t}`); });
    page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
    await page.goto(`http://127.0.0.1:${port}/bench/vulkan/translate/index.html`);
    const adapter = await page.evaluate(([u, n]) => (window as unknown as Vk0).vk0.init(u as string, n as boolean), [`/target/${trace}`, !!process.env.NO_IMMEDIATES] as const);
    if (opts.dump) {
      const [frame, file] = [Number(opts.dump.split(':')[0]), opts.dump.slice(opts.dump.indexOf(':') + 1)];
      const r = await page.evaluate(([s, f]) => (window as unknown as Vk0).vk0.dump(s, f as number, -1), [o, frame] as const);
      const rgba = Buffer.from(r.b64, 'base64'), rgb = Buffer.alloc(r.width * r.height * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]; }
      writeFileSync(file, Buffer.concat([Buffer.from(`P6\n${r.width} ${r.height}\n255\n`), rgb]));
      console.error(`frame ${frame} -> ${file}`);
      await page.close();
      continue;
    }
    const [out, label] = positionals;
    mkdirSync(out, { recursive: true });
    marks = {};
    const r = await page.evaluate((s) => (window as unknown as Vk0).vk0.run(s), o);
    const [p0, p1] = await Promise.all([marks.start, marks.end]);
    const frames = o.samples * o.frames;
    const cpu: Record<string, number> = {};
    for (const a of p1 ?? []) { const b = p0?.find((x) => x.id === a.id); if (b && a.cpuTime > b.cpuTime) cpu[a.type] = (cpu[a.type] ?? 0) + ((a.cpuTime - b.cpuTime) * 1000) / frames; }
    const name = basename(trace);
    const result = { arm: 'translated', label, trace, browser: browser.version(), chromiumArgs: chromiumArgs.join(' '), platform: process.platform, adapter, ...o,
      pipelineMs: r.pipelineMs, drawsPerFrame: r.drawsPerFrame, uploadBytesPerFrame: r.uploadBytesPerFrame, bindGroupsCreatedWhileTimed: r.bindGroupsCreated,
      immediateDrawsPerFrame: r.immediateDraws, ringDrawsPerFrame: r.ringDraws,
      frameMs: { median: median(r.frameMs), iqr: iqr(r.frameMs) }, jsMs: { median: median(r.jsMs), iqr: iqr(r.jsMs) }, processCpuMsPerFrame: cpu,
      frameSamples: r.frameMs, jsSamples: r.jsMs };
    writeFileSync(join(out, `${name}.json`), JSON.stringify(result, null, 1) + '\n');
    console.log(`${label} ${name}: ${result.frameMs.median.toFixed(3)} ms a frame (IQR ${result.frameMs.iqr.toFixed(3)}), worker ${result.jsMs.median.toFixed(3)} ms; renderer ${(cpu.renderer ?? 0).toFixed(2)}, GPU ${(cpu.GPU ?? 0).toFixed(2)} ms CPU a frame; ${r.drawsPerFrame.toFixed(0)} draws, ${r.immediateDraws.toFixed(0)} by immediates, ${r.ringDraws.toFixed(0)} by the ring`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
