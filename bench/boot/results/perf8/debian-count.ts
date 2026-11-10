// Diagnostic: the JIT's helper calls (all vCPUs, the diag core's M: lines) over Debian's boot on the page and
// page-ab.ts's workload. Needs the DIAG patches in web/vm.ts and web/app/worker.ts and the diag core in target/.
//   node bench/results/local/perf8/debian-count.ts [query] > out.json
import { chromium, type Page } from 'playwright-core';
import { unattendedQuery } from '../../../../tests/debian-unattended.ts';
import { startServer } from '../../../../tools/serve.ts';
const WORKLOAD = 'clear; s=$(date +%s%N); for i in $(seq 300); do /bin/true; done; m=$(date +%s%N); '
  + 'dd if=/dev/zero of=/dev/null bs=64 count=300000 2>/dev/null; e=$(date +%s%N); echo "==fork-$(( (m-s)/1000000 )) dd-$(( (e-m)/1000000 ))=="\n';
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const status = (page: Page) => page.evaluate(() => { const s = (window as any).__status; return { steps: s?.steps, helpers: s?.helpers }; });
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${base}/web/app/?ncpus=2&view=both&displaystats&${unattendedQuery()}&${process.argv[2] ?? ''}`);
  const t0 = Date.now();
  while (Date.now() - t0 < 200_000 && !/login: *$/.test(await terminal(page))) await page.waitForTimeout(200);
  await page.waitForTimeout(1500);
  const login = { s: (Date.now() - t0) / 1000, ...(await status(page)) };
  await page.locator('.xterm').click();
  await page.keyboard.type('root\n', { delay: 10 });
  await page.waitForFunction(() => /root@\S+:~# /.test(document.querySelector('.xterm-rows')?.textContent ?? ''), null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const before = { s: (Date.now() - t0) / 1000, ...(await status(page)) };
  await page.keyboard.type(WORKLOAD, { delay: 10 });
  await page.waitForFunction(() => /==fork-\d+ dd-\d+==/.test(document.querySelector('.xterm-rows')?.textContent ?? ''), null, { timeout: 120_000 });
  const res = (await terminal(page)).match(/==fork-\d+ dd-\d+==/)![0];
  await page.waitForTimeout(1500);
  const after = { s: (Date.now() - t0) / 1000, ...(await status(page)) };
  console.log(JSON.stringify({ res, marks: [{ name: 'begin', ms: 0, steps: 0, report: [] }, { name: 'login', ms: login.s * 1000, steps: login.steps, report: login.helpers }, { name: 'shell', ms: before.s * 1000, steps: before.steps, report: before.helpers }, { name: 'workload', ms: after.s * 1000, steps: after.steps, report: after.helpers }] }));
  await context.close();
} finally {
  await browser.close();
  server.close();
}
