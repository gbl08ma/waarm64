// PERF loop 85: a demo's start from disks.waarm64.com with the diag marks (the remote disk's requests). Dev-only.
import { rmSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from '../../../../../tools/serve.ts';
import { chromiumEnv } from '../../../../../tools/nosme.ts';
import { answerAsks } from '../../../../../tests/page-ask.ts';
const dir = 'target/perf85-demo-profile';
if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true });
const server = await startServer(8231);
const ctx = await chromium.launchPersistentContext(dir, { executablePath: '/usr/bin/chromium', headless: true, env: chromiumEnv(), viewport: { width: 1400, height: 1000 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await answerAsks(page, () => true);
const t0 = performance.now();
page.on('console', (m) => { if (m.text().includes('[d85]') || m.type() === 'error') console.log(`${(performance.now() - t0).toFixed(0)} ${m.text().slice(0, 300)}`); });
const until = (s: string[]) => page.waitForFunction((s) => s.includes(document.body.dataset.state!), s, { timeout: 180_000, polling: 50 });
await page.goto(`http://127.0.0.1:8231/web/app/?autostart=1#demos?id=${process.env.DEMO ?? 'alpine-term'}`);
await page.locator('[data-action="start-demo"]:not([disabled])').waitFor({ timeout: 60_000 });
await page.locator('[data-action="start-demo"]').click();
await until(['running']);
console.log('running (restore)', (performance.now() - t0).toFixed(0));
for (let k = 0; k < Number(process.env.RELOADS ?? 2); k++) {
  await new Promise((r) => setTimeout(r, 5000));
  const tr = performance.now();
  await page.reload();
  await until(['booting', 'running']);
  console.log('started (reload)', (performance.now() - tr).toFixed(0));
}
await new Promise((r) => setTimeout(r, 3000));
await page.goto('about:blank');
await ctx.close(); server.close();
process.exit(0);
