// The Machine menu (docs/frontend.md "Machine"): the vCPU count and the RAM chosen on the page apply
// by a restart, show in the status line and are remembered by the browser; `?ncpus=` and `?ram=` win.
// On Buildroot (seconds).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { PAGE_QUERY } from './page-query.ts';

const IMAGES = new URL('../target/images/', import.meta.url);
const skip = !(existsSync(new URL('buildroot/rootfs.ext4', IMAGES)) && existsSync(new URL('linux/Image', IMAGES))) && 'SKIPPED: run images/build.sh';

let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); });

const status = (page: Page) => page.evaluate(() => document.getElementById('status')!.textContent!);
const statusShows = (page: Page, re: RegExp) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('status')!.textContent ?? ''), re.source, { timeout: 120_000, polling: 200 })
  .catch(async (e) => { throw new Error(`${e}; the status shows: ${await status(page)}`); });

test('the Machine menu sets the vCPUs and the RAM, applies them by a restart and is remembered', { skip }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${base}/web/app/?${PAGE_QUERY}machine=buildroot&ncpus=1`);
  await statusShows(page, /1 vCPU\b.*256 MiB/);

  // The menu starts at what runs; applying the same size does nothing.
  assert.equal(await page.locator('#machine-cpus').inputValue(), '1');
  assert.equal(await page.locator('#machine-ram').inputValue(), '256');
  await page.locator('#machine-menu summary').click();
  await page.selectOption('#machine-cpus', '2');
  await page.selectOption('#machine-ram', '512');
  await page.click('#machine-apply');
  await statusShows(page, /2 vCPUs.*512 MiB/);

  // Remembered: a reload without the query starts the same size; the query wins over it.
  await page.goto(`${base}/web/app/?${PAGE_QUERY}machine=buildroot`);
  await statusShows(page, /2 vCPUs.*512 MiB/);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}machine=buildroot&ncpus=1&ram=1024`);
  await statusShows(page, /1 vCPU\b.*1024 MiB/);
  assert.deepEqual(errors, []);
  await context.close();
});
