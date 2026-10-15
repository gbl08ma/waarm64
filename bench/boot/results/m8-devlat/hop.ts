// node bench/boot/results/m8-devlat/hop.ts: hop.html (doorbell round trips between workers, by how each side waits) in headless Chromium.
import { chromium } from 'playwright-core';
import { startServer } from '../../../../tools/serve.ts';
const server = await startServer();
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const page = await browser.newPage();
page.on('console', (m) => console.error(`[page] ${m.text()}`));
await page.goto(`http://127.0.0.1:${port}/bench/boot/results/m8-devlat/${process.argv[2] ?? 'hop.html'}`);
let seen = 0;
const poll = setInterval(async () => { const l = ((await page.locator('#log').textContent().catch(() => '')) ?? '').split('\n').filter(Boolean); for (; seen < l.length; seen++) console.log(l[seen]); }, 500);
await page.waitForFunction(() => (window as any).benchResult, null, { timeout: 300_000, polling: 250 });
clearInterval(poll);
const l = ((await page.locator('#log').textContent()) ?? '').split('\n').filter(Boolean); for (; seen < l.length; seen++) console.log(l[seen]);
await browser.close(); server.close();
