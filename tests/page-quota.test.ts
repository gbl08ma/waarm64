// The browser's storage full while a machine runs (docs/machines.md "Storage"), on Debian: the origin's quota is
// lowered through the DevTools protocol (`Storage.overrideQuotaForOrigin`, which OPFS's sync handles obey: they throw
// `QuotaExceededError` or come back short), the guest writes past it, its writes fail (I/O errors), and the page says
// the storage is full, once, while the machine runs on. Whether the guest's writes land again once there's room isn't
// checked here: a refused write of its own (journald's) aborts ext4's journal at times, and the root filesystem then
// fails everything not cached (EIO) until a restart; tests/devices.test.ts checks the telling again. `estimate()`
// doesn't report the override (it still says the profile's quota), so only the words are checked, not the numbers. The remote
// disk's block cache is off (`diskcache=0`): the quota is the overlay's. Opt-in with WAARM64_DISTROS=debian
// (scripts/ci-machines.sh); one Debian boot.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { words } from './words.ts';

const debian = (process.env.WAARM64_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-machines.sh runs it (WAARM64_DISTROS=debian)' : (!existsSync(IMAGE) || !existsSync(FIRMWARE)) && 'SKIPPED: run images/build.sh debian edk2';
const BOOT_MS = 420_000;
/** The origin's quota: room for a boot's writes (and the variable store), not for the guest's 1 GiB file. */
const QUOTA = 512 << 20;

let base: string;
let close: () => void;
let dir: string;
before(async () => {
  if (skip) return;
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  dir = mkdtempSync(join(tmpdir(), 'waarm64-quota-'));
});
after(() => { close?.(); if (dir) rmSync(dir, { recursive: true }); });

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const message = (page: Page) => page.evaluate(() => document.getElementById('message-text')?.textContent ?? '');
const shows = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });

async function type(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 5 });
}
let tag = 0;
/** Runs `cmd` in the guest's shell; what it printed (on one line) and its exit status. */
async function sh(page: Page, cmd: string, ms = 120_000): Promise<{ out: string; status: number }> {
  const t = ++tag;
  await type(page, `o=$( { ${cmd} ; } 2>&1 ); s=$?; echo "<$((${t}*1))<"$o">$s>${t}>"\n`);
  const re = new RegExp(`<${t}<(.*?)>(\\d+)>${t}>`);
  await shows(page, re, ms);
  const m = re.exec(await terminal(page))!;
  return { out: m[1].trim(), status: Number(m[2]) };
}

test('the storage full under a running guest: its writes fail, and the page says so once while the machine runs on', { skip, timeout: 20 * 60_000 }, () => withDebianLock(async () => {
  // An on-disk profile, as a user's (an off-the-record one keeps OPFS in memory, with limits of its own).
  const context = await chromium.launchPersistentContext(mkdtempSync(join(dir, 'profile-')), { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // Every message the page shows, as it shows it (a notice goes back to the page's note after a while).
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { messages: string[] }).messages = seen;
      new MutationObserver(() => {
        const t = document.getElementById('message-text')?.textContent ?? '';
        if (t && seen.at(-1) !== t) seen.push(t);
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    await page.goto(`${base}/tests/browser/core.html`);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Storage.overrideQuotaForOrigin', { origin: base, quotaSize: QUOTA });
    await page.goto(`${base}/web/app/?${PAGE_QUERY}view=terminal&display=simple&diskcache=0&${unattendedQuery()}`);
    await page.waitForFunction(() => ['running', 'failed', 'crashed'].includes(document.body.dataset.state!), null, { timeout: BOOT_MS, polling: 250 });
    assert.equal(await page.evaluate(() => document.body.dataset.state), 'running', await message(page));
    await shows(page, /login: /, BOOT_MS);
    await type(page, 'root\n');
    await shows(page, /root@\S+:~# /);

    // Past the quota: dd's direct writes fail with I/O errors (not ENOSPC: the guest's filesystem has room).
    const fill = await sh(page, 'dd if=/dev/urandom of=/root/fill bs=1M count=1024 oflag=direct conv=fsync', 300_000);
    assert.notEqual(fill.status, 0, `dd: ${fill.out}`);
    assert.match(fill.out, /Input\/output error/);
    // The storage-full message, with its numbers or without.
    const fullSrc = ['disks:devices.storageFull', 'disks:devices.storageFull.numbers'].map((k) => `(?:${words(k).source})`).join('|');
    const full = () => page.evaluate((src) => (window as unknown as { messages: string[] }).messages.filter((m) => new RegExp(src).test(m)), fullSrc);
    await page.waitForFunction((src) => (window as unknown as { messages: string[] }).messages.some((m) => new RegExp(src).test(m)), fullSrc, { timeout: 10_000 });
    const said = await full();
    assert.equal(said.length, 1, `said once: ${said.join(' | ')}`);
    assert.match(said[0], words('disks:devices.storageFull.numbers', {}, { start: true }));
    assert.equal(await page.evaluate(() => document.body.dataset.state), 'running', 'the machine runs on');

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}));
