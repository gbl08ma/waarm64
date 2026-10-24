// Ad hoc (the build-system change, 2026-10-24): the page's load and Buildroot's start on it, served three ways,
// alternated: the old server (../webpc-base at a67b658: type stripping, hundreds of modules), Vite's dev server (mode
// test, as the tests run it) and the build (Vite's preview server over a copy, Buildroot's images linked in).
//   node bench/boot/results/m8-vite/vite-ab.ts [rounds]   -> bench/results/local/vite-ab.json (../webpc-base at a67b658)
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { chromium } from 'playwright-core';
import { writeDist } from '../../../../tools/dist.ts';
import { ROOT, startServer } from '../../../../tools/serve.ts';

const rounds = Number(process.argv[2] ?? 5);
const OLD: string = '../../../../../webpc-base/tools/serve.ts'; // the side checkout, not type-checked
const old = (await import(OLD)) as { startServer: (port?: number) => Promise<Server> };
const out = mkdtempSync(join(tmpdir(), 'webpc-ab-'));
await writeDist(out);
mkdirSync(join(out, 'target/images'), { recursive: true });
for (const d of ['linux', 'buildroot']) symlinkSync(join(ROOT, 'target/images', d), join(out, 'target/images', d));

const servers: Record<string, { server: Server; path: string }> = {
  old: { server: await old.startServer(0), path: '/web/app/' },
  dev: { server: await startServer(0), path: '/web/app/' },
  build: { server: await startServer(0, '127.0.0.1', out), path: '/' },
};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const results: Record<string, { idle: number[]; running: number[]; requests: number[]; bytes: number[] }> = {};
for (let r = 0; r < rounds; r++) {
  const order = r % 2 ? Object.entries(servers).reverse() : Object.entries(servers);
  for (const [arm, { server, path }] of order) {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    let requests = 0;
    let bytes = 0;
    page.on('requestfinished', async (q) => { requests++; bytes += (await q.sizes().catch(() => ({ responseBodySize: 0 }))).responseBodySize; });
    const t0 = performance.now();
    await page.goto(`${base}${path}`);
    await page.waitForFunction(() => document.body.dataset.state === 'idle', null, { timeout: 30_000, polling: 20 });
    const idle = performance.now() - t0;
    const loads = [requests, bytes];
    const t1 = performance.now();
    await page.goto(`${base}${path}?machine=buildroot&ncpus=1&view=terminal`);
    await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 60_000, polling: 20 });
    const running = performance.now() - t1;
    await ctx.close();
    const a = (results[arm] ??= { idle: [], running: [], requests: [], bytes: [] });
    a.idle.push(idle); a.running.push(running); a.requests.push(loads[0]); a.bytes.push(loads[1]);
    console.log(`round ${r} ${arm}: idle ${idle.toFixed(0)} ms (${loads[0]} requests, ${(loads[1] / 2 ** 20).toFixed(2)} MiB), running ${running.toFixed(0)} ms`);
  }
}
await browser.close();
for (const { server } of Object.values(servers)) server.close();
rmSync(out, { recursive: true, force: true });
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
for (const [arm, a] of Object.entries(results)) console.log(`${arm}: idle median ${median(a.idle).toFixed(0)} ms [${Math.min(...a.idle).toFixed(0)}–${Math.max(...a.idle).toFixed(0)}], running median ${median(a.running).toFixed(0)} ms [${Math.min(...a.running).toFixed(0)}–${Math.max(...a.running).toFixed(0)}], ${median(a.requests)} requests`);
writeFileSync(join(ROOT, 'bench/results/local/vite-ab.json'), JSON.stringify({ date: new Date().toISOString(), rounds, results }, null, 1));
