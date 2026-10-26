// VK2 L4: what sharing a WebGPU texture with WebGL2 costs a frame (bench/vulkan/share/worker.ts has the arms), in
// headless Chromium: at WIDTHxHEIGHT (1920x1080), FRAMES frames a round (120), ROUNDS rounds (5) alternating the arms, the app's image FORMAT (bgra8unorm; or
// rgba16float, vkcube's choice).
// Writes <out>/results.json: each arm's byte check, its rounds, and their medians and IQRs.
//   node bench/vulkan/share.ts [outdir]   (bench/gpu/sway-mac.sh runs it on the Mac: SCRIPT=../vulkan/share.ts, mode `-`)
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import type { ShareRequest, ShareResult } from './share/worker.ts';

const out = process.argv.slice(2).at(-1) ?? new URL('../results/local/vk2/share/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const req: ShareRequest = {
  width: Number(process.env.WIDTH ?? 1920), height: Number(process.env.HEIGHT ?? 1080),
  frames: Number(process.env.FRAMES ?? 120), rounds: Number(process.env.ROUNDS ?? 5),
  arms: (process.env.ARMS ?? 'none,canvas,bitmap,readback').split(','),
  format: process.env.FORMAT === 'rgba16float' ? 'rgba16float' : 'bgra8unorm',
};
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
  args: ['--enable-unsafe-webgpu', ...(process.env.CHROMIUM_ARGS ?? '').split(' ').filter(Boolean)] });
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log(`page: ${m.text().slice(0, 500)}`));
  await page.goto(`${base}/bench/vulkan/share/index.html`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  const r = await page.evaluate((q) => (window as unknown as { share(q: ShareRequest): Promise<ShareResult> }).share(q), req);
  const stat = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b), q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
    return { median: q(0.5), iqr: q(0.75) - q(0.25) };
  };
  const summary = Object.fromEntries(Object.entries(r.rounds ?? {}).map(([arm, rs]) => [arm, { msPerFrame: stat(rs.map((x) => x.msPerFrame)), refreshMs: stat(rs.map((x) => x.refreshMs)) }]));
  const result = { chromium: browser.version(), host: process.platform + ' ' + process.arch, request: req, ...r, summary };
  writeFileSync(`${out}/results.json`, JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ adapter: r.adapter, gl: r.gl, checks: r.checks, error: r.error, summary }, null, 1));
} finally {
  await browser.close();
  server.close();
}
