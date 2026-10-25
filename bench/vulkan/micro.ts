// VK0's C, E and F suite (bench/vulkan/micro/suite.ts) without Vite: the page from bench/vulkan/server.ts, the result
// summarized as bench/run.ts does (bench/stats.ts). The NVIDIA desktop's script runs it; on the dev VM and the Mac
// bench/run.ts --page bench/vulkan/micro/index.html does the same.
//   node bench/vulkan/micro.ts <out.json> [--only <bench>] [--quick]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { summarize } from '../stats.ts';
import { serve } from './server.ts';

const { values: opts, positionals } = parseArgs({ allowPositionals: true, options: { only: { type: 'string' }, quick: { type: 'boolean' } } });
const out = positionals[0];
if (!out) throw new Error('usage: micro.ts <out.json> [--only bench] [--quick]');
const defaultArgs = process.platform === 'darwin' ? '--enable-unsafe-webgpu' : '--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=swiftshader --use-gl=angle';
const chromiumArgs = (process.env.CHROMIUM_ARGS ?? defaultArgs).split(' ').filter(Boolean);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const server = await serve(ROOT, process.env.TARGET ?? join(ROOT, 'target'));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: chromiumArgs });
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.error(`[page] ${m.text()}`));
  const qs = new URLSearchParams();
  if (opts.only) qs.set('only', opts.only);
  if (opts.quick) qs.set('quick', '');
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/bench/vulkan/micro/index.html?${qs}`);
  const h = await page.waitForFunction(() => (window as unknown as { benchResult?: unknown }).benchResult, null, { timeout: 30 * 60_000, polling: 250 });
  const data = (await h.jsonValue()) as { error?: string; results: { name: string; unit: string; params?: object; samples: number[] }[]; userAgent: string };
  if (data.error) throw new Error(data.error);
  const report = { schema: 1, page: 'bench/vulkan/micro/index.html', date: new Date().toISOString(), chromiumArgs: chromiumArgs.join(' '), browser: browser.version(),
    userAgent: data.userAgent, platform: process.platform, arch: process.arch, results: data.results.map((r) => ({ ...r, ...summarize(r.samples) })) };
  writeFileSync(out, JSON.stringify(report, null, 1) + '\n');
  for (const r of report.results) console.log(`${r.name.padEnd(18)} ${JSON.stringify(r.params ?? {}).slice(0, 100).padEnd(100)} ${r.median.toFixed(3)} ±${r.iqr.toFixed(3)} ${r.unit}`);
} finally {
  await browser.close();
  server.close();
}
