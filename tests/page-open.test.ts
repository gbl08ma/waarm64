// Opening a machine on the page, without a guest to boot (docs/machines.md §1, §2):
// - a stored machine opened in a second tab while it runs in another: the page takes the machine's Web Lock before it
//   opens the disks, and when another tab holds it says so at once, without waiting out the overlay's lock
//   (`OVERLAY_WAIT_MS`). The "other tab" is another page of the profile holding the lock, as a running machine's does;
// - Open disk… (the first-run message's, the Machines page's From a disk image…) through the browser's file picker,
//   so the machine's file disk keeps its handle. Headless Chromium's picker can't be answered (Playwright aborts it),
//   so the page's `showOpenFilePicker` gives a file in OPFS, as a picked file's handle.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { PAGE_QUERY } from './page-query.ts';
import { t } from '../web/i18n.ts';
import { answerAsks } from './page-ask.ts';
import { words } from './words.ts';

let browser: Browser;
let base: string;
let close: () => void;
let dir: string;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'webpc-open-'));
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); if (dir) rmSync(dir, { recursive: true }); });

const message = (page: import('playwright-core').Page) => page.evaluate(() => document.getElementById('message-text')?.textContent ?? '');

test('a machine running in another tab: a second tab says so at once, and starts it once that tab lets it go', { timeout: 120_000 }, async () => {
  const context = await browser.newContext();
  try {
    const holder = await context.newPage();
    await holder.goto(`${base}/tests/browser/core.html`);
    const id = await holder.evaluate(async () => {
      const { Store } = await import('/web/app/store.ts' as string);
      const { createDisk, createMachine, attach } = await import('/web/app/machines.ts' as string);
      const store = await Store.open();
      const m = await createMachine(store, { name: 'Elsewhere', ncpus: 1, ramMiB: 512, display: '2d', network: false });
      await attach(store, m, await createDisk(store, { kind: 'url', url: '/tests/qcow2/deflate.qcow2', size: 1 << 20, bytes: 106496 }));
      store.close();
      return m.id as string;
    });
    // The lock a page running the machine holds, held until told.
    await holder.evaluate((id) => {
      navigator.locks.request(`webpc-machine:${id}`, () => new Promise<void>((resolve) => { (window as unknown as { release: () => void }).release = resolve; }));
    }, id);

    const page = await context.newPage();
    const t0 = Date.now();
    await page.goto(`${base}/web/app/?${PAGE_QUERY}m=${id}`);
    await page.waitForFunction(() => document.body.dataset.state === 'failed', null, { timeout: 30_000 })
      .catch(async (e) => { throw new Error(`${e}; the page is ${await page.evaluate(() => document.body.dataset.state)}: ${await message(page)}`); });
    const waited = Date.now() - t0;
    assert.match(await message(page), words('machine:main.runsElsewhere', { name: 'Elsewhere' }));
    assert.ok(waited < 8_000, `said after ${waited} ms (the overlay's wait is 10 s)`);
    // The page didn't queue for the lock behind the other tab: only the holder has it, and no one waits.
    const locks = await holder.evaluate(async (id) => {
      const q = await navigator.locks.query();
      const name = `webpc-machine:${id}`;
      return { held: (q.held ?? []).filter((l) => l.name === name).length, pending: (q.pending ?? []).filter((l) => l.name === name).length };
    }, id);
    assert.deepEqual(locks, { held: 1, pending: 0 });

    // The other tab lets it go: Retry starts it here (the page holds the lock while it's starting).
    await holder.evaluate(() => (window as unknown as { release: () => void }).release());
    await page.locator('#message-actions button', { hasText: t('machine:main.retry') }).click();
    await page.waitForFunction((src) => !new RegExp(src).test(document.getElementById('message-text')?.textContent ?? '') && document.body.dataset.state !== 'failed', words('machine:main.runsElsewhere', { name: 'Elsewhere' }).source, { timeout: 30_000 })
      .catch(async (e) => { throw new Error(`${e}; the page is ${await page.evaluate(() => document.body.dataset.state)}: ${await message(page)}`); });
  } finally {
    await context.close();
  }
});

test('Open disk… and From a disk image… pick through the file picker: the machine keeps the file\'s handle', { timeout: 120_000 }, async () => {
  // An on-disk profile: Chromium 153 crashes reading a file handle back from IndexedDB off the record (docs/backlog.md).
  const context = await chromium.launchPersistentContext(mkdtempSync(join(dir, 'profile-')), { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    // The picker: the next name in `window.pick` as a file in OPFS (its bytes the fixture's), or a cancel when there's none.
    await page.addInitScript(() => {
      const w = window as unknown as { pick: string[]; picked: number; showOpenFilePicker: () => Promise<FileSystemFileHandle[]> };
      w.pick = [];
      w.picked = 0;
      w.showOpenFilePicker = async () => {
        w.picked++;
        const name = w.pick.shift();
        if (!name) throw new DOMException('The user aborted a request.', 'AbortError');
        const h = await (await navigator.storage.getDirectory()).getFileHandle(name, { create: true });
        const out = await h.createWritable();
        await out.write(await (await fetch('/tests/qcow2/data.raw')).arrayBuffer());
        await out.close();
        return [h];
      };
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await answerAsks(page); // "Open the other machine? This one stops…"
    await page.goto(`${base}/web/app/?${PAGE_QUERY}`);
    await page.waitForFunction((src) => document.body.dataset.state === 'idle' && new RegExp(src).test(document.getElementById('message-text')?.textContent ?? ''), words('machine:main.openDisk.prompt').source, { timeout: 30_000 });
    const openDisk = page.locator('#message-actions button', { hasText: t('machine:main.openDisk') });

    // Cancelled: nothing happens.
    await openDisk.click();
    await page.waitForFunction(() => (window as unknown as { picked: number }).picked === 1);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.body.dataset.state), 'idle');
    assert.equal(await page.locator('#machine').textContent(), t('machine:main.title.noDisk', { machine: t('machines:machine.uefi') }));

    // Picked: a machine named after the file, its disk with the handle.
    await page.evaluate(() => { (window as unknown as { pick: string[] }).pick.push('first.raw'); });
    await openDisk.click();
    await page.waitForFunction(() => (document.getElementById('machine')?.textContent ?? '') === 'first', null, { timeout: 10_000 });

    // The Machines page's From a disk image…: the same.
    await page.evaluate(() => { (window as unknown as { pick: string[] }).pick.push('second.raw'); });
    await page.locator('#machines-open').click();
    await page.locator('.machines button', { hasText: t('machines:MachinesPage.fromImage') }).click();
    await page.waitForFunction(() => (document.getElementById('machine')?.textContent ?? '') === 'second', null, { timeout: 10_000 });

    const disks = await page.evaluate(async () => {
      const { Store } = await import('/web/app/store.ts' as string);
      const store = await Store.open();
      const out = (await store.all('disks')).map((d: { name: string; kind: string; handle?: unknown }) => ({ name: d.name, kind: d.kind, handle: d.handle instanceof FileSystemFileHandle }));
      store.close();
      return out.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
    });
    assert.deepEqual(disks, [{ name: 'first.raw', kind: 'file', handle: true }, { name: 'second.raw', kind: 'file', handle: true }]);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
