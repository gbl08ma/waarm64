// Off the record (Playwright's `newContext`, as an Incognito window), on Debian: OPFS lives in memory there, where
// Chromium's sync handles refuse writes at ~0.8 GB in all while `estimate()` reports ~3.2 GB, and the remote disks'
// block cache (web/diskcache.ts) sizes its budget from that estimate. A machine on a URL disk (served by the test
// server: no file handle in IndexedDB, which Chromium 153 crashes reading back off the record) reads its disk until
// the cache holds what it may; then a kept snapshot, a Restore and a Suspend still find room: their writers give the
// cache's room back and try again (docs/remote-disks.md "Off the record"). WAARM64_INCOGNITO_QUOTA=<MiB> lowers the
// origin's quota on top (`Storage.overrideQuotaForOrigin`) to find the case on a profile with more room. Opt-in with
// WAARM64_DISTROS=debian (scripts/ci-machines.sh); from a booted-Debian fixture (tests/debian-fixture.ts `storedFixture`).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { putStored, replacesFixture, STORED, STORED_QUERY, storedFixture } from './debian-fixture.ts';
import { loadSnapshotFile } from '../bench/snapshot-start.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';
import { t } from '../web/i18n.ts';
import { words } from './words.ts';

const debian = (process.env.WAARM64_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-machines.sh runs it (WAARM64_DISTROS=debian)' : (!existsSync(IMAGE) || !existsSync(FIRMWARE)) && 'SKIPPED: run images/build.sh debian edk2';
const BOOT_MS = 420_000;

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

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const said = (page: Page) => page.evaluate(() => `${document.getElementById('message-text')?.textContent ?? ''} | ${document.getElementById('message-details')?.textContent ?? ''}`);
const shows = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
const stateIs = (page: Page, ...states: string[]) => page.waitForFunction((s) => s.includes(document.body.dataset.state!), states, { timeout: BOOT_MS, polling: 200 })
  .catch(async (e) => { throw new Error(`${e}; the page is ${await page.evaluate(() => document.body.dataset.state)}: ${await said(page)}`); });
async function type(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 5 });
}
let tag = 0;
/** Runs `cmd` in the guest's shell; its output on one line (tests/page-snapshots.test.ts's). */
async function ok(page: Page, cmd: string, ms = 120_000) {
  const t = ++tag;
  await type(page, `clear; o=$( { ${cmd} ; } 2>&1 ); s=$?; echo "<$((${t}*1))<"$o">$s>${t}>"\n`);
  const re = new RegExp(`<${t}<(.*?)>(\\d+)>${t}>`);
  await shows(page, re, ms);
  const m = re.exec(await terminal(page))!;
  assert.equal(m[2], '0', `${cmd}: ${m[1]}`);
  return m[1].trim();
}
const mib = (n: number) => Math.round(n / 2 ** 20);
/** What the remote disks' cache and the origin hold, and what `estimate()` says. */
const storage = (page: Page) => page.evaluate(async () => {
  const { cacheBytes } = await import('/web/diskcache.ts' as string);
  const e = await navigator.storage.estimate();
  return { cache: await cacheBytes() as number, usage: e.usage ?? 0, quota: e.quota ?? 0 };
});

test('off the record, a URL disk\'s block cache leaves room for a kept snapshot, a Restore and a Suspend', { skip, timeout: 30 * 60_000 }, async () => {
  // From a booted-Debian fixture (tests/debian-fixture.ts): the cache fills from the guest's reads of the whole disk.
  const fixture = await storedFixture(browser, base, STORED.net(), STORED_QUERY);
  await withDebianLock(async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await answerAsks(page, (q) => !replacesFixture(q));
      await page.goto(`${base}/web/app/?${PAGE_QUERY}view=terminal`);
      if (process.env.WAARM64_INCOGNITO_QUOTA) await (await context.newCDPSession(page)).send('Storage.overrideQuotaForOrigin', { origin: base, quotaSize: Number(process.env.WAARM64_INCOGNITO_QUOTA) << 20 });
      const r = STORED.net();
      await putStored(page, r);
      const url = `${base}/web/app/?${STORED_QUERY}&m=${r.machine.id}`;
      await page.goto(url);
      if (fixture) await loadSnapshotFile(page, fixture);
      await stateIs(page, 'running');
      await shows(page, /login: /);
      await type(page, 'root\n');
      await shows(page, /root@\S+:~# /);
      // The whole disk read: every block of the image the cache may keep is fetched (and kept, up to its budget).
      await ok(page, 'dd if=/dev/vda of=/dev/null bs=4M iflag=direct', 600_000);
      const filled = await storage(page);
      console.log(`# off the record: the cache holds ${mib(filled.cache)} MiB; the origin ${mib(filled.usage)} MiB of ${mib(filled.quota)} MiB`);
      // Memory the guest has written (not zeros), so the snapshot isn't small.
      await ok(page, 'head -c 250M /dev/urandom > /dev/shm/fill && echo kept-state > /root/f && sync');

      // Kept: the toolbar's Snapshot.
      await page.locator('#save-snapshot').click();
      const kept = words('snapshots:snapshot-actions.kept', {}, { start: true }).source;
      const failed = words('snapshots:worker-snapshot.notSaved', {}, { start: true }).source;
      await page.waitForFunction(([a, b]) => [a, b].some((src) => new RegExp(src).test(document.getElementById('message-text')?.textContent ?? '')), [kept, failed], { timeout: 300_000 });
      assert.match(await page.evaluate(() => document.getElementById('message-text')?.textContent ?? '') ?? '', new RegExp(kept), await said(page));
      const after = await storage(page);
      console.log(`# after the snapshot: the cache holds ${mib(after.cache)} MiB; the origin ${mib(after.usage)} MiB`);

      // Restored (the overlay moved on since: a fork takes the snapshot's blocks).
      await ok(page, 'echo later > /root/f && sync');
      await page.click('#machines-open');
      await page.locator('.machines [data-tab=snapshots]').click();
      await page.locator('.machines [data-snapshot]').first().getByRole('button', { name: t('snapshots:Snapshots.restore') }).click();
      await page.waitForFunction(() => document.body.dataset.state !== 'running', null, { timeout: 30_000, polling: 50 });
      await stateIs(page, 'running', 'crashed', 'failed');
      assert.equal(await page.evaluate(() => document.body.dataset.state), 'running', await said(page));
      assert.equal(await ok(page, 'cat /root/f'), 'kept-state');

      // Suspended, and resumed by the next load.
      await page.locator('#suspend').click();
      const notSuspended = words('machine:worker-snapshot.suspend.failed', {}, { start: true }).source;
      await page.waitForFunction((src) => document.body.dataset.state === 'suspended' || new RegExp(src).test(document.getElementById('message-text')?.textContent ?? ''), notSuspended, { timeout: 300_000, polling: 200 });
      assert.equal(await page.evaluate(() => document.body.dataset.state), 'suspended', await said(page));
      await page.goto(url);
      await stateIs(page, 'running');
      assert.match(await page.evaluate(() => document.getElementById('message-text')?.textContent ?? '') ?? '', words('machine:worker.resumed'));
      assert.equal(await ok(page, 'cat /root/f'), 'kept-state');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});
