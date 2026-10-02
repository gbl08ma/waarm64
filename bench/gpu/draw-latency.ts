// The page's screen on a virtio-gpu (M8 graphics G1 loop 4): how long a flush waits for its draw in the
// device worker, idle and while the guest reads its disk (blk's synchronous XHRs block that worker: a
// flush is served and drawn only between them). Boots Debian on the page (needs `npm start`'s images),
// logs in on the serial terminal, makes tty1 change every ~30 ms and reads the display's own
// `draw-stats` (flush-to-draw ms, median and max per second; the page's ?displaystats).
//   node bench/gpu/draw-latency.ts [out.json]
import { writeFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { unattendedQuery } from '../../tests/debian-unattended.ts';

const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const page: Page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
await page.goto(`${base}/web/app/?ncpus=2&view=both&displaystats&${unattendedQuery()}`);
await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 240_000, polling: 250 });
const shows = (re: RegExp) => page.waitForFunction((s) => new RegExp(s).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: 60_000, polling: 100 });
const type = async (t: string) => { await page.locator('.xterm').click(); await page.keyboard.type(t, { delay: 10 }); };
await type('root\n');
await shows(/root@\S+:~# /);
const samples = async (ms: number) => {
  await page.evaluate(() => { (window as never as { __drawStats: unknown[] }).__drawStats = []; });
  await page.waitForTimeout(ms);
  return page.evaluate(() => (window as never as { __drawStats: { n: number; median: number; max: number }[] }).__drawStats);
};
await type('while :; do echo $RANDOM > /dev/tty1; sleep 0.03; done &\n');
await page.waitForTimeout(3000);
const idle = await samples(10_000);
await type('(echo 3 > /proc/sys/vm/drop_caches; while :; do dd if=/dev/vda of=/dev/null bs=1M skip=$((RANDOM%400)) count=16 2>/dev/null; done) &\n');
await page.waitForTimeout(3000);
const loaded = await samples(15_000);
const sum = (xs: { n: number; median: number; max: number }[]) => ({
  seconds: xs.length, draws: xs.reduce((a, x) => a + x.n, 0),
  medianOfMedians: xs.map((x) => x.median).sort((a, b) => a - b)[xs.length >> 1], max: Math.max(...xs.map((x) => x.max)),
});
const out = { chromium: browser.version(), idle: sum(idle), disk: sum(loaded), raw: { idle, loaded } };
console.log(JSON.stringify({ idle: out.idle, disk: out.disk }));
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out, null, 1) + '\n');
await browser.close();
server.close();
