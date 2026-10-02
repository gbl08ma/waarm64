// The page's size reaches the guest (M8 graphics G1 loop 5): Debian on virtio-gpu, in headless
// Chromium. The start size is the screen box's (the console is born at it, no event); a bigger
// window makes the guest's connector list the new preferred mode; a smaller one is followed by
// the guest but not by fbcon's buffer (graphics.md §9): the display asks for the whole buffer
// again, so the canvas keeps the console's size and nothing is cropped. scripts/ci-gfx.sh runs it
// (WEBPC_GFX_TESTS=1 with WEBPC_DISTROS=debian). ~1.5 min.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';

const debian = (process.env.WEBPC_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = process.env.WEBPC_GFX_TESTS !== '1' ? 'SKIPPED: scripts/ci-gfx.sh runs it (WEBPC_GFX_TESTS=1)'
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

const BOOT_MS = 240_000;
const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const shows = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
async function onSerial(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 10 });
}
/** The screen box as the page measures it, and the canvas's pixels (the guest's scanout). */
const geometry = (page: Page) => page.evaluate(() => {
  const box = document.getElementById('screen-view')!;
  const c = document.querySelector<HTMLCanvasElement>('#screen')!;
  return { want: [Math.floor(box.clientWidth / 8) * 8, box.clientHeight], canvas: [c.width, c.height] };
});
/** The first mode the guest's connector lists (the preferred one), read on the serial console. */
async function preferred(page: Page, tag: string): Promise<[number, number]> {
  await onSerial(page, `clear; echo ==${tag[0]}""${tag.slice(1)} $(head -qn1 /sys/class/drm/card*-Virtual-1/modes)\n`);
  const re = new RegExp(`==${tag}\\s+(\\d+)x(\\d+)`);
  await shows(page, re);
  const m = re.exec(await terminal(page))!;
  return [Number(m[1]), Number(m[2])];
}

/** The connector's `enabled` (a console with no mode to show is `disabled`). */
async function state(page: Page, tag: string) {
  await onSerial(page, `clear; echo ==${tag[0]}""${tag.slice(1)} $(cat /sys/class/drm/card*-Virtual-1/enabled)\n`);
  const re = new RegExp(`==${tag}\\s+(enabled|disabled)`);
  await shows(page, re);
  return re.exec(await terminal(page))![1];
}

test("the page's size reaches the guest: the console is born at it, a bigger window is a new preferred mode, a smaller one never crops the console", { skip, timeout: 15 * 60_000 }, () => withDebianLock(async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/web/app/?ncpus=2&view=both&${unattendedQuery()}`);
  await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: BOOT_MS, polling: 250 });
  await onSerial(page, 'root\n');
  await shows(page, /root@\S+:~# /);

  // Born at the page's size: the guest's preferred mode and the canvas are the screen box's (width down to 8).
  const g0 = await geometry(page);
  const born = await preferred(page, 'born');
  assert.deepEqual(born, g0.want, 'the preferred mode at the boot is the screen box');
  assert.deepEqual(g0.canvas, g0.want, 'the console took it');

  // A bigger window: fbcon's buffer is the old size, so it refuses the new preferred mode (DRM's VIRTUAL_X) and takes the born size
  // from the EDID's extra modes; without it the console went blank. The new preferred mode is what a fresh probe lists.
  await page.setViewportSize({ width: 1700, height: 1000 });
  await page.waitForFunction(([w, h]) => { const b = document.getElementById('screen-view')!; return b.clientWidth > w && b.clientHeight > h; }, g0.want, { timeout: 10_000 });
  const g1 = await geometry(page);
  await page.waitForTimeout(2500); // the debounce, the display event, the guest's probe
  assert.equal(await state(page, 'grown'), 'enabled', 'the console survives a bigger window');
  await onSerial(page, 'echo detect >/sys/class/drm/card0-Virtual-1/status; sleep 1\n');
  assert.deepEqual(await preferred(page, 'listed'), g1.want, 'a probe lists the new preferred mode');
  assert.deepEqual((await geometry(page)).canvas, g0.canvas, 'the console keeps its buffer');

  // A smaller one: the guest takes it, fbcon would crop its buffer, and the display asks for the whole buffer again.
  await page.setViewportSize({ width: 1200, height: 800 });
  // The guest crops for a moment, then the display gives it its whole buffer back: settled when the canvas is the born size again, and it stays.
  await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('#screen')!.width !== 0, null, { timeout: 5000 });
  await page.waitForTimeout(4000);
  await page.waitForFunction(([w, h]) => { const c = document.querySelector<HTMLCanvasElement>('#screen')!; return c.width === w && c.height === h; }, g0.canvas, { timeout: 30_000 });
  await page.waitForTimeout(2500);
  assert.equal(await state(page, 'shrunk'), 'enabled');
  assert.deepEqual((await geometry(page)).canvas, g0.canvas, 'the console is not cropped');

  assert.deepEqual(errors, []);
  await context.close();
}));
