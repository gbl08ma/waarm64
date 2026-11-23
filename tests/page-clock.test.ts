// The guest's clock set by the guest agent (`?clocksync=1`, Preferences' "Set the guest's clock after a restore", on
// by default; the page tests turn it off; docs/frontend.md "The guest's clock"), on Debian: the agent connects over vsock
// and the page sends TIME at its HELLO, after a save's pause, and at a restore (the restored agent connects again). The
// guest's clock is set back first each time, so only the agent puts it right: after Save snapshot, after Suspend and a
// resume 20 s on, and after the file loaded minutes later in a fresh profile. A guest that suspends itself still sleeps
// and wakes on a key. Off (tests/page-debian.test.ts), a snapshot is a pause the guest's clock doesn't see, as before.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { t } from '../web/i18n.ts';
import { words } from './words.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { pageFixture } from './debian-fixture.ts';
import { loadSnapshotFile } from '../bench/snapshot-start.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';

const debian = (process.env.WAARM64_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const AGENT = new URL('../target/images/agent/waarm64-agent', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-debian.sh --platform runs it (WAARM64_DISTROS=debian)' : (!existsSync(IMAGE) || !existsSync(FIRMWARE) || !existsSync(AGENT)) && 'SKIPPED: run images/build.sh debian edk2 agent';
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
  dir = mkdtempSync(join(tmpdir(), 'waarm64-clock-'));
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

/** The guest's clock set back two minutes (on the serial terminal), so that only the agent's TIME puts it right. */
async function setBack(page: Page) {
  await onSerial(page, 'clear; date -s "@$(( $(date +%s) - 120 ))" >/dev/null; echo se""tback\n');
  await shows(page, /setback/);
  const d = await offset(page);
  assert.ok(d < -100, `the guest's clock set back: ${d.toFixed(1)} s`);
}
/** Until the guest agent has said HELLO on this page (after a restore: once it connected again). */
const agentUp = (page: Page) =>
  page.waitForFunction(() => !!(window as unknown as { __agent?: { agent?: unknown } }).__agent?.agent, null, { timeout: 120_000, polling: 200 });

test('the guest agent sets the clock after a snapshot, a resume and a load; a guest asleep by itself wakes on a key', { skip, timeout: 25 * 60_000 }, async () => {
  // With the USB controller: Linux's xHCI suspend and resume (CSS, its registers written again, CRS) go through the
  // guest's own sleep; a controller that started its event ring over left the guest stuck in an interrupt storm (docs/usb.md).
  const query = `ncpus=2&view=both&usb=1&clocksync=1&agent=1&${unattendedQuery()}`;
  // From a booted-Debian fixture (tests/debian-fixture.ts): the agent sets the clock after its load as after the test's.
  const fixture = await pageFixture(browser, base, `${PAGE_QUERY}${query}`);
  await withDebianLock(async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => { (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await answerAsks(page);
    await page.goto(`${base}/web/app/?autostart=1&${PAGE_QUERY}${query}`);
    if (fixture) await loadSnapshotFile(page, fixture);
    await running(page);
    await shows(page, /login: /);
    await onSerial(page, 'root\n');
    await shows(page, /root@\S+:~# /);
    await agentUp(page);
    await near(page, 'booted');
    // The clock device (virtio-rtc, a transient machine's by default) is there; Debian 13's 6.12 has no driver for it.
    await onSerial(page, 'clear; grep -l 0x0011 /sys/bus/virtio/devices/*/device | wc -l; echo li""sted\n');
    await shows(page, /^\s*1\s*listed/);

    // Save snapshot: after its pause, the agent sets the clock.
    await setBack(page);
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 180_000 }), page.locator('#save-snapshot').click()]);
    const file = join(dir, 'debian.waarm64snap');
    await download.saveAs(file);
    await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('message-text')?.textContent ?? ''), words('snapshots:snapshot-actions.saved', {}, { start: true }).source, { timeout: 60_000 });
    await near(page, 'after its snapshot');
    await onSerial(page, 'clear; journalctl -b -u waarm64-agent -o cat | grep -c "clock set"; echo co""unted\n');
    await shows(page, /^\s*[1-9]\d*\s*counted/); // the agent's log says so (`clear` took the command line)

    // A guest that suspends itself sleeps until a key (its clock runs on meanwhile: the counter doesn't stop).
    await onSerial(page, 'systemctl suspend\n');
    await page.waitForFunction((said) => (document.getElementById('message-text')?.textContent ?? '') === said, t('machine:worker-messages.asleep'), { timeout: 60_000 });
    await page.waitForTimeout(5000);
    await onSerial(page, '\n');
    await awake(page);
    await onSerial(page, 'clear; echo aw""ake-$((6*7))\n');
    await shows(page, /awake-42/);
    await near(page, 'woken by a key');

    // Suspend: resumed a while later, the agent connects again and sets the clock.
    await page.locator('#suspend').click();
    await page.waitForFunction(() => document.body.dataset.state === 'suspended', null, { timeout: 120_000 });
    await page.waitForTimeout(20_000);
    await page.reload();
    await running(page, 180_000);
    assert.match(await message(page), words('machine:worker.resumed', {}, { start: true }));
    await agentUp(page);
    await near(page, 'resumed 20 s after its suspend');
    assert.deepEqual(errors, []);
    await context.close();

    // The snapshot, minutes later, in a fresh profile.
    const fresh = await browser.newContext();
    const p2 = await fresh.newPage();
    await answerAsks(p2);
    await p2.goto(`${base}/web/app/?autostart=1&${PAGE_QUERY}${query}`);
    await p2.setInputFiles('#load-snapshot-input', file);
    await p2.waitForFunction((src) => new RegExp(src).test(document.getElementById('boot-title')!.textContent!), words('machine:runner.boot.loading', {}, { start: true }).source, { timeout: 30_000 });
    await running(p2, 180_000);
    await agentUp(p2);
    await near(p2, 'its snapshot loaded minutes later');
    // Nothing in the guest minded: no failed unit, no RCU stall, no watchdog.
    await onSerial(p2, 'clear; systemctl --failed --no-legend | wc -l; dmesg | grep -ciE "rcu.*stall|soft lockup|watchdog"; echo che""cked\n');
    await shows(p2, /^\s*0\s*0\s*checked/);
    await fresh.close();
  });
});
