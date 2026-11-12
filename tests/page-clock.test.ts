// The guest's clock across snapshots with the clock catch-up on (`?clocksync=1`, the Preferences' "Suspend the guest
// before taking a snapshot", on by default; the page tests turn it off; docs/frontend.md "The guest's clock"), on Debian: Save snapshot first presses the guest's
// sleep key, so Debian suspends itself (PSCI SYSTEM_SUSPEND) and the file says it slept; the running machine wakes
// with its clock on time, and so does the file loaded minutes later in a fresh profile, and a suspended machine
// resumed after a while. A guest that suspends itself wakes on a key. Off (tests/page-debian.test.ts), a snapshot is a
// pause the guest's clock doesn't see, as before.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { t } from '../web/i18n.ts';
import { words } from './words.ts';
import { openSnapshot } from '../web/snapshot-file.ts';
import { lzCodec } from '../web/lz.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';

const debian = (process.env.WEBPC_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const CORE = new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-debian.sh --platform runs it (WEBPC_DISTROS=debian)' : (!existsSync(IMAGE) || !existsSync(FIRMWARE)) && 'SKIPPED: run images/build.sh debian edk2';
/** The guest's clock may be this far from the host's (s): the reading's own latency, a terminal round trip. */
const SLACK = 3;

let browser: Browser;
let base: string;
let close: () => void;
let dir: string;
before(async () => {
  if (skip) return;
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  dir = mkdtempSync(join(tmpdir(), 'webpc-clock-'));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); if (dir) rmSync(dir, { recursive: true }); });

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const shows = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
const message = (page: Page) => page.evaluate(() => document.getElementById('message-text')?.textContent ?? '');
async function onSerial(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 10 });
}
async function running(page: Page, ms = 300_000) {
  await page.waitForFunction(() => ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), null, { timeout: ms, polling: 250 });
  assert.equal(await page.evaluate(() => document.body.dataset.state), 'running', await message(page));
}
/** The guest's clock minus the host's, in seconds (the guest's `date` read on the serial terminal). */
let readings = 0;
async function offset(page: Page) {
  const tag = `clk${readings++}x`;
  await onSerial(page, `clear; echo ${tag}$(date +%s.%N)end\n`);
  await shows(page, new RegExp(`${tag}\\d+\\.\\d+end`));
  const host = Date.now() / 1000;
  return Number(new RegExp(`${tag}(\\d+\\.\\d+)end`).exec((await terminal(page)).replace(/\s+/g, ''))![1]) - host;
}
/** Waits for the guest to finish waking (its last suspend's exit on the console): keys typed while it resumes are lost. */
const awake = (page: Page) => shows(page, /suspend entry \(deep\)(?![^]*suspend entry)[^]*suspend exit/, 60_000);
const near = async (page: Page, what: string) => {
  const d = await offset(page);
  console.log(`# clock: ${what}: the guest is ${d.toFixed(2)} s from the host`);
  assert.ok(Math.abs(d) < SLACK, `${what}: the guest's clock is ${d.toFixed(1)} s off`);
};

test('with the clock catch-up, the guest sleeps for a snapshot or a suspend and wakes with its clock on time; a guest asleep by itself wakes on a key', { skip, timeout: 25 * 60_000 }, () => withDebianLock(async () => {
  // With the USB controller: Linux's xHCI suspend and resume (CSS, its registers written again, CRS) go through each
  // sleep; a controller that started its event ring over left the guest stuck in an interrupt storm (docs/usb.md).
  const query = `ncpus=2&view=both&usb=1&clocksync=1&${unattendedQuery()}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => { (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}${query}`);
  await running(page);
  await shows(page, /login: /);
  await onSerial(page, 'root\n');
  await shows(page, /root@\S+:~# /);
  await near(page, 'booted');
  // The clock device (virtio-rtc, a transient machine's by default) is there; Debian 13's 6.12 has no driver for it.
  await onSerial(page, 'clear; grep -l 0x0011 /sys/bus/virtio/devices/*/device | wc -l; echo li""sted\n');
  await shows(page, /^\s*1\s*listed/);

  // Save snapshot: the guest sleeps for it (its sleep key, then systemd-logind), and the running machine wakes on time.
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 180_000 }), page.locator('#save-snapshot').click()]);
  const file = join(dir, 'debian.webpcsnap');
  await download.saveAs(file);
  await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('message-text')?.textContent ?? ''), words('snapshots:snapshot-actions.saved', {}, { start: true }).source, { timeout: 60_000 });
  assert.match(await message(page), words('snapshots:snapshot-actions.saved.slept', {}, { start: true }));
  const lz = await lzCodec(readFileSync(CORE));
  assert.equal((await openSnapshot(new Blob([readFileSync(file)]), { codecs: [lz] })).header.slept, true);
  await near(page, 'after its snapshot');
  await onSerial(page, 'clear; journalctl -b -o cat | grep -c "suspend entry (deep)"; echo co""unted\n');
  await shows(page, /^\s*1\s*counted/); // `clear` took the command line

  // A guest that suspends itself sleeps until a key (its clock runs on meanwhile: the counter doesn't stop).
  await onSerial(page, 'systemctl suspend\n');
  await page.waitForFunction((said) => (document.getElementById('message-text')?.textContent ?? '') === said, t('machine:worker-messages.asleep'), { timeout: 60_000 });
  await page.waitForTimeout(5000);
  await onSerial(page, '\n');
  await onSerial(page, 'clear; echo aw""ake-$((6*7))\n');
  await shows(page, /awake-42/);
  await near(page, 'woken by a key');

  // Suspend: the machine stops asleep; resumed a while later, it wakes on time.
  await page.locator('#suspend').click();
  await page.waitForFunction(() => document.body.dataset.state === 'suspended', null, { timeout: 120_000 });
  await page.waitForTimeout(20_000);
  await page.reload();
  await running(page, 180_000);
  assert.match(await message(page), words('machine:worker.resumed', {}, { start: true }));
  await awake(page);
  await near(page, 'resumed 20 s after its suspend');
  assert.deepEqual(errors, []);
  await context.close();

  // The snapshot, minutes later, in a fresh profile.
  const fresh = await browser.newContext();
  const p2 = await fresh.newPage();
  await answerAsks(p2);
  await p2.goto(`${base}/web/app/?${PAGE_QUERY}${query}`);
  await p2.setInputFiles('#load-snapshot-input', file);
  await p2.waitForFunction((src) => new RegExp(src).test(document.getElementById('boot-title')!.textContent!), words('machine:runner.boot.loading', {}, { start: true }).source, { timeout: 30_000 });
  await running(p2, 180_000);
  await awake(p2);
  await near(p2, 'its snapshot loaded minutes later');
  // Nothing in the guest minded: no failed unit, no RCU stall, no watchdog.
  await onSerial(p2, 'clear; systemctl --failed --no-legend | wc -l; dmesg | grep -ciE "rcu.*stall|soft lockup|watchdog"; echo che""cked\n');
  await shows(p2, /^\s*0\s*0\s*checked/);
  await fresh.close();
}));
