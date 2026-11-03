// The browser's storage full outside a guest's own disk writes (docs/machines.md "Storage"), in Chromium without a
// guest: the origin's quota lowered through the DevTools protocol (`Storage.overrideQuotaForOrigin`), in a fresh
// off-the-record context each (OPFS in memory; the override holds there, and counts the remote disks' Storage Bucket).
// A kept snapshot's or a suspended machine's writer (web/overlay.ts `fileWriter`) gets the remote disks' kept blocks
// out of the way and lands; still refused, it says the storage is full with `estimate()`'s numbers, as a stored disk's
// import does; an overlay whose creation was refused is made by the next opening. `estimate()` doesn't report the
// override (its quota is still the profile's), so the numbers are checked against what `estimate()` says, not the
// override. tests/page-quota.test.ts is the guest's side, tests/page-incognito.test.ts a kept snapshot's with a
// URL disk on Debian.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { t } from '../web/i18n.ts';
import { words } from './words.ts';

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

/** A fresh off-the-record page on the origin, its quota `mib` MiB. */
async function quota(mib: number) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/tests/browser/core.html`);
  await (await context.newCDPSession(page)).send('Storage.overrideQuotaForOrigin', { origin: base, quotaSize: mib << 20 });
  return { context, page };
}

/** Runs module `src` in a dedicated worker of the page (sync access handles); what it posts. Imports name `ORIGIN`. */
const inWorker = <T>(page: Page, src: string) => page.evaluate(async (src) => {
  const w = new Worker(URL.createObjectURL(new Blob([src.replaceAll('ORIGIN', location.origin)], { type: 'text/javascript' })), { type: 'module' });
  return await new Promise((resolve, reject) => { w.onmessage = (e) => resolve(e.data); w.onerror = (e) => reject(new Error(e.message)); });
}, src) as Promise<T>;

type Said = { key?: string; params?: Record<string, number>; quota?: number; error?: string };
/** In the worker: what error `e` says (its message's key and parameters), with `estimate()`'s quota then. */
const SAID = `
  import { msgOf } from 'ORIGIN/web/msg.ts';
  const said = async (e) => { const m = msgOf(e); return { key: m?.key, params: m?.params, quota: (await navigator.storage.estimate()).quota, error: m ? undefined : String(e) }; };`;

test("a kept snapshot's writer finds the storage full: the remote disks' kept blocks give way and it lands; still full, it says so with estimate()'s numbers", async () => {
  const { context, page } = await quota(32);
  try {
    const r = await inWorker<{ landed: boolean; gaveUp: boolean; full: Said }>(page, `${SAID}
      import { fileWriter } from 'ORIGIN/web/overlay.ts';
      import { cacheKey, makeRoom, openBlockStore } from 'ORIGIN/web/diskcache.ts';
      const MiB = 1 << 20;
      // The remote disks' cache holds 20 MiB of the 32.
      const store = await openBlockStore(await cacheKey('an image'), 64 * MiB, MiB);
      for (let b = 0; b < 20; b++) store.put(b, new Uint8Array(MiB).fill(b + 1));
      const fill = async (path, mib) => {
        const w = await fileWriter(path, makeRoom);
        try {
          for (let i = 0; i < mib; i++) await w.write(new Uint8Array(MiB).fill(i));
          w.close();
          return true;
        } catch (e) {
          await w.abort();
          throw e;
        }
      };
      // 16 MiB: past the room the cache leaves, within the quota once it's gone.
      const landed = await fill('machines/m/snapshots/a', 16);
      const gaveUp = store.stats().gaveUp;
      // 64 MiB: past the quota whatever gives way.
      const full = await fill('machines/m/snapshots/b', 64).then(() => ({}), said);
      postMessage({ landed, gaveUp, full });`);
    assert.deepEqual([r.landed, r.gaveUp], [true, true], 'the kept blocks gave way, and the file landed');
    assert.equal(r.full.key, 'disks:overlay.storageFull.numbers', r.full.error ?? r.full.key ?? '');
    // estimate()'s quota (usage and what's available) moves a little between two calls.
    assert.ok(Math.abs(r.full.params!.quota - r.full.quota!) < r.full.quota! / 100, `estimate()'s quota: ${r.full.params!.quota} for ${r.full.quota}`);
    assert.ok(r.full.params!.used > 0);
  } finally {
    await context.close();
  }
});

test("a disk imported into the browser finds the storage full: the error says so with estimate()'s numbers", async () => {
  const { context, page } = await quota(16);
  try {
    const r = await page.evaluate(async () => {
      const { Store } = await import('/web/app/store.ts' as string);
      const { importStored } = await import('/web/app/disks.ts' as string);
      const { describe } = await import('/web/i18n.ts' as string);
      const store = await Store.open();
      // 32 MiB that isn't zeros (zero blocks aren't stored).
      const file = new File([Uint8Array.from({ length: 32 << 20 }, (_, i) => (i * 2654435761) >>> 24 | 1)], 'big.img');
      try {
        await importStored(store, file);
        return { imported: true };
      } catch (e) {
        return { said: describe(e), quota: (await navigator.storage.estimate()).quota, disks: (await store.all('disks')).length };
      } finally {
        store.close();
      }
    }) as { imported?: boolean; said?: { headline: string; details: string[] }; quota?: number; disks?: number };
    assert.equal(r.imported, undefined, 'refused');
    assert.equal(r.said!.headline, t('disks:stored.writeFailed'));
    assert.match(r.said!.details[0] ?? '', words('disks:overlay.storageFull.numbers', {}, { start: true }), r.said!.details.join(' | '));
    const quota = Number(r.said!.details[0].match(/([\d.]+) GiB\)/)?.[1]) * 2 ** 30;
    assert.ok(Math.abs(quota - r.quota!) < r.quota! / 50, `estimate()'s quota: ${r.said!.details[0]} for ${r.quota}`);
    assert.equal(r.disks, 0, 'no record');
  } finally {
    await context.close();
  }
});

test('an overlay whose creation finds the storage full says so, and the next opening makes it', async () => {
  const { context, page } = await quota(8);
  try {
    const r = await inWorker<{ first: Said; second: string }>(page, `${SAID}
      import { openOverlay } from 'ORIGIN/web/overlay.ts';
      // A file takes all the room there is, to the byte.
      const dir = await navigator.storage.getDirectory();
      const h = await (await dir.getFileHandle('filler', { create: true })).createSyncAccessHandle();
      let at = 0;
      for (const step of [1 << 20, 1 << 12, 1 << 6, 1]) {
        for (;;) {
          let n = 0;
          try { n = h.write(new Uint8Array(step), { at }); } catch {}
          if (n !== step) break;
          at += step;
        }
      }
      h.truncate(at);
      const identity = JSON.stringify({ path: '/an/image.qcow2', bytes: 123456789, etag: '"abc"' });
      const first = await openOverlay('overlays/new', identity).then((f) => (f.close(), {}), said);
      h.truncate(0);
      h.close();
      const second = await openOverlay('overlays/new', identity).then((f) => (f.close(), 'opened'), (e) => String(e));
      postMessage({ first, second });`);
    assert.match(r.first.key ?? '', /^disks:overlay\.storageFull(\.numbers)?$/, r.first.error ?? '');
    assert.equal(r.second, 'opened');
  } finally {
    await context.close();
  }
});
