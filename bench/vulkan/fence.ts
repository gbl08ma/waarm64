// VK3 L2: what a worker's turn and WebGPU's "done" cost on this host's Chromium (bench/vulkan/fence/worker.ts), the
// pieces of a Venus fence's round trip (bench/vulkan/REPORT.md "VK3 L2").
//   node bench/vulkan/fence.ts [out.json]   (N, default 60; CHROMIUM, CHROMIUM_ARGS as the tests take them)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';

const root = new URL('../..', import.meta.url).pathname;
const out = process.argv[2] ?? join(root, 'bench/results/local/vk3-fence.json');
const N = Number(process.env.N ?? 60);
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: !process.env.HEADED,
  args: (process.env.CHROMIUM_ARGS ?? (process.platform === 'darwin' ? '--enable-unsafe-webgpu' : '--enable-unsafe-webgpu --enable-features=Vulkan')).split(' ').filter(Boolean) });
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.error(`page: ${m.text().slice(0, 500)}`); });
  await page.goto(`${base}/bench/vulkan/fence/index.html`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  const r = await page.evaluate((n) => (window as unknown as { rtt: { run(n: number): Promise<unknown> } }).rtt.run(n), N);
  const res = { date: new Date().toISOString(), chromium: browser.version(), platform: process.platform, n: N, ...(r as object) };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(res, null, 1) + '\n');
  console.log(JSON.stringify(res, null, 1));
} finally {
  await browser.close();
  server.close();
}
