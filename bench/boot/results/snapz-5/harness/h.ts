// Ad-hoc driver: node h.ts <arm,arm,...> <file url> [rounds]; PROFILE=<dir> persistent, else off the record.
import { chromium } from 'playwright-core';
import { startServer } from '../../../../../tools/serve.ts';
const [arms, file, rounds = '3'] = process.argv.slice(2);
const server = await startServer(Number(process.env.PORT ?? 8198));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const exe = '/usr/bin/chromium';
const ctx = process.env.PROFILE ? await chromium.launchPersistentContext(process.env.PROFILE, { executablePath: exe, headless: true }) : await (await chromium.launch({ executablePath: exe, headless: true })).newContext();
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('console', (m) => console.log('[page]', m.text()));
await page.goto(`${base}/bench/boot/results/snapz-5/harness/h.html`);
await page.waitForFunction(() => (globalThis as any).ready);
for (let r = 0; r < Number(rounds); r++) for (const arm of arms.split(',')) {
  const res = await page.evaluate((m) => (globalThis as any).job(m), { arm, file });
  console.log(JSON.stringify({ round: r, profile: process.env.PROFILE ? 'persistent' : 'off', ...(res.ok ? Object.fromEntries(Object.entries(res.out).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 10) / 10 : v])) : { error: res.error }) }));
}
await ctx.close();
server.close();
process.exit(0);
