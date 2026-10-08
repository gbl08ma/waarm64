// Keys typed on the screen reach GRUB (M8 graphics G1 loop 4): its menu is on the virtio-gpu screen and EDK2 has no
// keyboard driver but the serial console's, so until the guest has a driver on virtio-input the page sends the
// screen's keys to the serial console. Pressing `c` (GRUB's command line) on the screen during the menu's 5 s
// countdown must stop the boot: no "Linux version" on the serial terminal. Debian on the page, ~30 s;
// scripts/ci-debian.sh runs it (WEBPC_GFX_TESTS=1 with WEBPC_DISTROS=debian).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';

const debian = (process.env.WEBPC_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = process.env.WEBPC_GFX_TESTS !== '1' ? 'SKIPPED: scripts/ci-debian.sh runs it (WEBPC_GFX_TESTS=1)'
  : !debian ? 'SKIPPED: set WEBPC_DISTROS=debian' : (!existsSync(IMAGE) || !existsSync(FIRMWARE)) && 'SKIPPED: run npm start (or images/build.sh debian edk2)';

let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  if (skip) return;
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); });

test("a key typed on the screen reaches GRUB's menu: `c` stops the countdown, the kernel never starts", { skip, timeout: 25 * 60_000 }, () => withDebianLock(async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${base}/web/app/?ncpus=2&view=both&${unattendedQuery()}`);
  const serial = () => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
  await page.waitForFunction(() => /BdsDxe: starting/.test(document.querySelector('.xterm-rows')?.textContent ?? ''), null, { timeout: 120_000, polling: 100 });
  // GRUB's menu counts 5 s from when it starts (~5 s after the boot manager did): press until it is stopped.
  await page.locator('#screen').click();
  const t0 = performance.now();
  while (performance.now() - t0 < 25_000) {
    await page.keyboard.press('c');
    await page.waitForTimeout(400);
  }
  assert.doesNotMatch(await serial(), /Linux version/, 'GRUB booted: the screen\'s key never reached it');
  await context.close();
}));
