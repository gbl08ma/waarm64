// The Machine menu (docs/frontend.md "Machine"): the vCPU count and the RAM chosen on the page apply
// by a restart, show in the status line and are remembered by the browser; `?ncpus=` and `?ram=` win.
// On Buildroot (seconds); the graphics choice on Debian (scripts/ci-graphics.sh).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { PAGE_QUERY } from './page-query.ts';
import { withDebianLock } from './debian-lock.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { answerAsks } from './page-ask.ts';
import { words } from './words.ts';
import { t } from '../web/i18n.ts';

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

const status = (page: Page) => page.evaluate(() => (document.getElementById('status')?.textContent ?? ''));
const statusShows = (page: Page, re: RegExp) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('status')?.textContent ?? ''), re.source, { timeout: 120_000, polling: 200 })
  .catch(async (e) => { throw new Error(`${e}; the status shows: ${await status(page)}`); });
/** The status bar's vCPUs element, then its RAM's (`<n> MiB`, a size and its unit). */
const sized = (ncpus: number, mib: number) => new RegExp(`${words('statusbar:statusbar-render.vcpus', { count: ncpus }).source}\\b.*${mib} MiB`);

test('the Machine menu sets the vCPUs and the RAM, applies them by a restart and is remembered', { skip }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?autostart=1&${PAGE_QUERY}machine=buildroot&ncpus=1`);
  await statusShows(page, sized(1, 256));

  // The menu starts at what runs; applying the same size does nothing.
  assert.equal(await page.locator('#machine-cpus').inputValue(), '1');
  assert.equal(await page.locator('#machine-ram').inputValue(), '256');
  await page.locator('#machine-menu summary').click();
  await page.fill('#machine-cpus', '2');
  await page.fill('#machine-ram', '512');
  await page.click('#machine-apply');
  await statusShows(page, sized(2, 512));

  // Remembered: a reload without the query starts the same size; the query wins over it.
  await page.goto(`${base}/web/app/?autostart=1&${PAGE_QUERY}machine=buildroot`);
  await statusShows(page, sized(2, 512));
  await page.goto(`${base}/web/app/?autostart=1&${PAGE_QUERY}machine=buildroot&ncpus=1&ram=1024`);
  await statusShows(page, sized(1, 1024));
  assert.deepEqual(errors, []);
  await context.close();
});

// Graphics (virtio-gpu machines: Debian): 3D where WebGL2 is, 2D from the menu, remembered; the query over it. The
// machine only starts (the choice shows in `data-graphics` before the guest boots). In scripts/ci-graphics.sh.
const debian = (process.env.WAARM64_DISTROS ?? '').split(',').includes('debian');
const skipDebian = !debian ? 'SKIPPED: scripts/ci-graphics.sh runs it (WAARM64_DISTROS=debian)'
  : !(existsSync(new URL('debian/disk.qcow2', IMAGES)) && existsSync(new URL('edk2/QEMU_EFI.fd', IMAGES))) && 'SKIPPED: run images/build.sh debian edk2';
test('the Machine menu chooses 3D or 2D graphics, remembered, with the query over it', { skip: skipDebian }, () => withDebianLock(async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  const graphics = (want: string) => page.waitForFunction((g) => document.body.dataset.graphics === g, want, { timeout: 60_000, polling: 100 });
  await page.goto(`${base}/web/app/?autostart=1&machine=debian`);
  await graphics('3d');
  assert.equal(await page.locator('#machine-gpu').inputValue(), '3d');
  assert.equal(await page.locator('#machine-gpu-label').isVisible(), false); // in the closed menu
  await page.locator('#machine-menu summary').click();
  await page.selectOption('#machine-gpu', '2d');
  await page.click('#machine-apply');
  await graphics('2d');
  await page.reload();
  await graphics('2d');
  assert.equal(await page.locator('#machine-gpu').inputValue(), '2d');
  await page.goto(`${base}/web/app/?autostart=1&machine=debian&gpu=virgl`);
  await graphics('3d');
  assert.equal(await page.locator('#machine-gpu').isDisabled(), true);
  assert.deepEqual(errors, []);
  await context.close();
}));

// A lost WebGL context (the GPU process gone, a device reset; here WEBGL_lose_context through the test hook) stops 3D,
// not the machine (docs/graphics.md "3D"): the page says so, the guest runs on (its uptime moves), the device turns 3D
// off (web/gpu.ts `hostLost`), and nothing throws.
test('a lost 3D context stops 3D, not the machine: the page says so and the guest runs on', { skip: skipDebian }, () => withDebianLock(async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  const logs: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => logs.push(m.text()));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?autostart=1&${PAGE_QUERY}hooks&gpu=virgl&${unattendedQuery()}`);
  // Running once the guest is at its login prompt (~35 s alone on 2 vCPUs, twice that under load).
  await page.waitForFunction(() => document.body.dataset.graphics === '3d' && document.body.dataset.state === 'running', null, { timeout: 240_000, polling: 200 })
    .catch(async (e) => { throw new Error(`${e}; the page is ${await page.evaluate(() => `${document.body.dataset.graphics} ${document.body.dataset.state}: ${document.getElementById("message-text")?.textContent}; the terminal shows: ${document.querySelector(".xterm-rows")?.textContent?.slice(-1500)}`)} (${await status(page)})`); });
  // The firmware and the kernel have drawn through the GPU worker by then; a while more on 3D.
  await page.waitForTimeout(10_000);
  await page.evaluate(() => window.__waarm64LoseGpu!());
  const said = t('display:worker-messages.webglLost');
  await page.waitForFunction((s) => document.body.innerText.includes(s), said, { timeout: 15_000, polling: 100 });
  const before = await status(page);
  await page.waitForTimeout(5_000);
  assert.equal(await page.evaluate(() => document.body.dataset.state), 'running');
  assert.notEqual(await status(page), before, 'the status (its uptime) moves on');
  assert.ok(logs.some((l) => l.includes('virtio-gpu: 3D is off: the browser lost its 3D context')), logs.filter((l) => l.includes('virtio-gpu')).join('\n'));
  assert.deepEqual(errors, []);
  await context.close();
}));
