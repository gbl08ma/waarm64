// VK3 L3: what N new render pipelines cost made one by one (createRenderPipeline) or all at once
// (createRenderPipelineAsync), and whether WebGL round trips stall meanwhile (bench/vulkan/pipelines/).
//   node bench/vulkan/pipelines.ts [out.json]   (N pipelines, default 16; SIZE, operations a shader, default 300;
//   ROUNDS, alternated, default 3; CHROMIUM, CHROMIUM_ARGS as the tests take them)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';

const root = new URL('../..', import.meta.url).pathname;
const out = process.argv[2] ?? join(root, 'bench/results/local/vk3-pipelines.json');
const N = Number(process.env.N ?? 16), SIZE = Number(process.env.SIZE ?? 300), ROUNDS = Number(process.env.ROUNDS ?? 3);
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: !process.env.HEADED,
  args: (process.env.CHROMIUM_ARGS ?? (process.platform === 'darwin' ? '--enable-unsafe-webgpu' : '--enable-unsafe-webgpu --enable-features=Vulkan')).split(' ').filter(Boolean) });
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.error(`page: ${m.text().slice(0, 500)}`); });
  await page.goto(`${base}/bench/vulkan/pipelines/index.html`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  const runs: unknown[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    for (const mode of r % 2 ? ['async', 'sync'] : ['sync', 'async']) {
      // A seed of its own each run: no cache (Metal's on disk, Dawn's) has its shaders.
      const seed = Math.floor(Math.random() * 1e9);
      const x = await page.evaluate(([m, n, s, z]) => (window as unknown as { pipes: { run(...a: unknown[]): Promise<unknown> } }).pipes.run(m, n, s, z), [mode, N, seed, SIZE] as const);
      console.log(JSON.stringify(x));
      runs.push(x);
    }
  }
  const res = { date: new Date().toISOString(), chromium: browser.version(), platform: process.platform, n: N, size: SIZE, runs };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(res, null, 1) + '\n');
} finally {
  await browser.close();
  server.close();
}
