// EXPERIMENT (lazy NZCV at loop heads): the diagnostic core's tallies over Debian's boot on the page in Chromium
// (?machine=debian, 1 vCPU), to its login prompt. Needs the diagnostic core at the default path and
// tools/worker-heap-diag.patch applied (the heap's answer carrying the tallies): not a committed state of the page.
//   node bench/boot/results/flagx/tools/debian-page.mjs [query] [out.json]
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from '../../../../../tools/serve.ts';

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
const query = process.argv[2] ?? 'ncpus=1';
await page.goto(`${base}/web/app/?machine=debian&view=both&${query}`);
const t0 = Date.now();
let text = '';
const read = async () => {
  await page.evaluate(() => { window.__heap = undefined; window.__waarm64Heap(); });
  await page.waitForFunction(() => window.__heap, undefined, { timeout: 20_000 });
  return page.evaluate(() => ({ steps: window.__heap.steps, diag: window.__heap.diag }));
};
const marks = [];
const seen = new Set();
while (Date.now() - t0 < 520_000) {
  await page.waitForTimeout(500);
  text = (await page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '')) || text;
  for (const [k, re] of [['stub', /EFI stub: Booting/], ['ready', /Press any key to proceed|login: ?$/m]])
    if (!seen.has(k) && re.test(text)) { seen.add(k); marks.push({ mark: k, s: (Date.now() - t0) / 1000, ...(await read()) }); console.log(k, JSON.stringify(marks.at(-1))); }
  if (seen.has('ready')) break;
}
if (!seen.has('ready')) console.log('timed out; the terminal:', JSON.stringify(text.slice(-400)));
const names = ['back-edge', 'forward edge', 'transfer cache hit', 'miss function', 'jump cache hit', 'chain back', 'chain fwd', 'jc back', 'jc fwd', 'by-VA back', 'by-VA fwd', 'host call', 'host return', 'poll', 'edge storing NZCV for a cold path only', 'edge storing NZCV otherwise'];
const last = marks.at(-1);
if (last?.diag) {
  const sum = names.map((_, i) => last.diag.reduce((s, d) => s + d[i], 0));
  console.log(`${query}: ${(last.steps / 1e6).toFixed(0)}M steps to ${last.mark}; per 1000 steps:`);
  names.forEach((n, i) => console.log(`  ${n.padEnd(42)} ${((1000 * sum[i]) / last.steps).toFixed(3)}`));
}
if (process.argv[3]) writeFileSync(process.argv[3], `${JSON.stringify({ date: new Date().toISOString(), chromium: browser.version(), query, names, marks }, null, 1)}\n`);
await browser.close();
server.close();
process.exit(0);
