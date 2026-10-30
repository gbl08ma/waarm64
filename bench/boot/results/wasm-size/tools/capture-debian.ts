// Ad hoc: boots the page's Debian (2 vCPUs, unattended), logs in, runs a userspace workload, and writes every JIT
// module the compile worker sees to <out>/m<n>.wasm (needs the diagnostic hook in web/jit-compile-worker.ts).
//   node bench/boot/results/wasm-size/tools/capture-debian.ts <out>
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright-core';
import { unattendedQuery } from '../../../../../tests/debian-unattended.ts';
import { startServer } from '../../../../../tools/serve.ts';

const out = process.argv[2];
mkdirSync(out, { recursive: true });
const WORKLOAD = process.env.WORKLOAD ?? 'ls -lR /usr > /dev/null; apt-cache dump > /dev/null; tar cf - /usr/bin 2>/dev/null | gzip -1 | wc -c; sha256sum /usr/bin/* > /dev/null; find / -xdev -name "*.so*" | wc -l; journalctl --no-pager | wc -l; perl -e \'my %h; for (1..200000) { $h{$_ % 977} .= "x" } print scalar(keys %h), "\\n"\'; echo ==$((40+2))done==\n';
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
let n = 0, total = 0;
const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.route('**/__jitdump', async (r) => {
    const b = r.request().postDataBuffer();
    if (b) { writeFileSync(`${out}/m${n++}.wasm`, b); total += b.length; }
    await r.fulfill({ status: 204 });
  });
  const page = await context.newPage();
  await page.goto(`${base}/web/app/?ncpus=2&view=both&${unattendedQuery()}`);
  const t0 = Date.now();
  while (!/login: *$/.test(await terminal(page))) {
    if (Date.now() - t0 > 400_000) throw new Error('no login');
    await page.waitForTimeout(500);
  }
  console.log(`login after ${(Date.now() - t0) / 1000} s, ${n} modules, ${total} bytes`);
  await page.locator('.xterm').click();
  await page.keyboard.type('root\n', { delay: 10 });
  await page.waitForFunction(() => /root@\S+:~# /.test(document.querySelector('.xterm-rows')?.textContent ?? ''), null, { timeout: 60_000 });
  await page.keyboard.type(WORKLOAD, { delay: 5 });
  await page.waitForFunction(() => /==42done==/.test(document.querySelector('.xterm-rows')?.textContent ?? ''), null, { timeout: 400_000, polling: 1000 });
  await page.waitForTimeout(5000);
  console.log(`done after ${(Date.now() - t0) / 1000} s, ${n} modules, ${total} bytes`);
} finally {
  await browser.close();
  server.close();
}
