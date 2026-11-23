// The Home page, in Chromium without a guest: Merge into the disk on a blank disk's overlays (web/app/merge.ts,
// docs/machines.md §4.4), from the Overlays dialog through the disk worker: one nothing was written to (a resize on a
// machine made it) grows the blank disk, one written to makes it a stored disk; and a kept snapshot that can never be
// restored (a disk written in place moved on: §5.1 "Unrestorable") shown as orphaned on the Snapshots tab with its
// reason, without Restore or Create a machine like it, deleted with the orphaned ones. The logic is
// tests/merge.test.ts's and tests/unrestorable.test.ts's.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { t } from '../web/i18n.ts';
import { answerAsks, type Question } from './page-ask.ts';
import { openHome } from './page-home.ts';

const MiB = 2 ** 20;
const SHOTS = new URL('../bench/results/local/qa-storage/', import.meta.url).pathname;
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

const modal = (page: Page) => page.locator('.machines');
/** Saves a screenshot for a look, when asked (`SHOTS=1`). */
const shot = async (page: Page, name: string) => {
  if (!process.env.SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}${name}.png` });
};

/** Sets overlay or stored disk `path`'s generation from a worker, as a machine's run that wrote it would leave it. */
const setGen = (page: Page, path: string, generation: number) => page.evaluate(async ({ path, generation }) => {
  const w = new Worker('/tests/browser/overlay-worker.ts', { type: 'module' });
  await new Promise<void>((resolve) => { w.onmessage = () => resolve(); w.postMessage({ type: 'meta', name: path, generation }); });
  w.terminate();
}, { path, generation });

test("Merge into the disk on a blank disk's overlays: one nothing was written to grows the disk, one written to makes it a stored disk", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const asked: Question[] = [];
  await answerAsks(page, (q) => void asked.push(q));
  await page.goto(`${base}/web/app/?autostart=1`);
  // A blank disk of 8 MiB on machine A, resized there to 16 MiB (an overlay "Changes" made at that size).
  const ids = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { attach, createDisk, createMachine } = await import('/web/app/machines.ts' as string);
    const { resize } = await import('/web/app/resize.ts' as string);
    const store = await Store.open();
    const a = await createMachine(store, { name: 'Machine A' });
    const d = await createDisk(store, { kind: 'blank', size: 8 << 20, name: 'Scratch' });
    const at = await attach(store, a, d);
    await resize(store, { machine: a.id, attachment: at.id }, 16 << 20, { grow: true });
    const o = (await store.get('machines', a.id)).attachments[0].overlay as string;
    store.close();
    return { a: a.id as string, d: d.id as string, o };
  });
  const disk = async () => page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const d = await store.get('disks', id);
    const overlays = (await store.overlaysOf(id)).map((o: { id: string }) => o.id);
    store.close();
    return { kind: d.kind as string, size: d.size as number, identity: d.identity.kind as string, overlays };
  }, ids.d);

  await openHome(page);
  await modal(page).locator('nav [data-machine=disks]').click();
  const card = modal(page).locator(`section[data-selected=disks] [data-disk="${ids.d}"]`);
  await card.locator('[data-action=disk-overlays]').click();
  const row = (id: string) => page.locator(`#overlays [data-overlay="${id}"]`);
  const merge = row(ids.o).locator('[data-action=merge-overlay]');
  assert.equal(await merge.getAttribute('title'), t('disks:Overlays.mergeButton.title.blank'));
  await shot(page, 'blank-overlays');
  await merge.click();
  await row(ids.o).waitFor({ state: 'detached' });
  assert.equal(asked[0]?.text, t('disks:Overlays.merge.confirm.grow', { overlay: t('disks:page-disks.overlayName'), disk: 'Scratch', size: 16 * MiB, snapshots: undefined }));
  assert.deepEqual(await disk(), { kind: 'blank', size: 16 * MiB, identity: 'blank', overlays: [] });

  // An overlay written to (its generation moved, as a run's would): the disk becomes a stored disk, at its size.
  const o2 = await page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { createOverlay } = await import('/web/app/disks.ts' as string);
    const store = await Store.open();
    const o = await createOverlay(store, await store.get('disks', id), 'Work', undefined, 32 << 20);
    store.close();
    return o.id as string;
  }, ids.d);
  await setGen(page, `overlays/${o2}`, 1);
  await row(o2).waitFor();
  await row(o2).locator('[data-action=merge-overlay]').click();
  await row(o2).waitFor({ state: 'detached' });
  assert.equal(asked[1]?.text, t('disks:Overlays.merge.confirm.blank', { overlay: 'Work', disk: 'Scratch', size: 32 * MiB, others: undefined, snapshots: undefined }));
  // The row goes with the overlay's record; the disk's record follows the worker's copy.
  for (let i = 0; i < 100 && (await disk()).kind !== 'stored'; i++) await page.waitForTimeout(50);
  assert.deepEqual(await disk(), { kind: 'stored', size: 32 * MiB, identity: 'stored', overlays: [] });
  // The Disks pane says what it is now: a stored disk's card offers Resize… on the disk itself.
  await page.locator('#overlays [data-action=close-overlays]').click();
  await card.locator('[data-action=resize-disk]').waitFor();
  await shot(page, 'blank-merged');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a kept snapshot of a disk written in place that moved on shows as orphaned, with why, and goes with the orphaned ones', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?autostart=1`);
  const ids = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { attach, createMachine } = await import('/web/app/machines.ts' as string);
    const { importStored } = await import('/web/app/disks.ts' as string);
    const store = await Store.open();
    const m = await createMachine(store, { name: 'In place' });
    const file = new File([await (await fetch('/tests/qcow2/data.raw')).arrayBuffer()], 'data.raw');
    const s = await importStored(store, file, () => {});
    const a = await attach(store, m, s);
    const rec = await store.get('machines', m.id);
    rec.attachments.find((x: { id: string }) => x.id === a.id).inPlace = true;
    await store.put('machines', rec);
    const pin = { slot: 0, overlay: `disks/${s.id}`, generation: s.generation, blocks: 0 };
    await store.put('snapshots', { id: 'eeeeeeeeeee2', machine: m.id, name: 'Before', created: 0, bytes: 1 << 20, shape: { disks: [] }, shapeHash: '', pins: [pin], coreVersion: 6 });
    store.close();
    return { m: m.id as string, s: s.id as string, generation: s.generation as number };
  });
  // The guest wrote the disk since (its run moved the generation on; the page read it into the record at the stop).
  await setGen(page, `disks/${ids.s}`, ids.generation + 1);
  await page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { refreshStored } = await import('/web/app/disks.ts' as string);
    const store = await Store.open();
    await refreshStored(store, id);
    store.close();
  }, ids.s);

  await openHome(page);
  await modal(page).locator('.pick', { hasText: 'In place' }).click();
  await modal(page).locator('[data-tab=snapshots]').click();
  const card = modal(page).locator('[data-snapshot=eeeeeeeeeee2]');
  // Its shape (none the page reads) orphans it at once, with that reason; the disk's reason replaces it once the tab has
  // read the disks' generations from their files (watchGenerations), which under load comes later.
  const orphaned = t('snapshots:Snapshots.orphaned', { why: t('snapshots:snapshots.unrestorable.inPlace', { disk: 'data.raw' }) });
  await card.locator('.orphan', { hasText: orphaned }).waitFor({ timeout: 10_000 })
    .catch(async (e) => { throw new Error(`${e}; it says: ${await card.locator('.orphan').textContent()}`); });
  assert.equal(await card.locator('.orphan').textContent(), orphaned);
  assert.equal(await card.locator('[data-action=restore]').count(), 0, 'nothing restores it');
  assert.equal(await card.getByRole('button', { name: t('snapshots:Snapshots.like') }).count(), 0, 'a machine like it would have the same disk');
  await shot(page, 'unrestorable-snapshot');
  await modal(page).locator('[data-action=delete-orphaned]').click();
  await card.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await context.close();
});

/** The machine worker as a stand-in (tests/page-restore.test.ts's): a start is answered "off", a stop "stopped". */
const standIn = (page: Page) => page.addInitScript(() => {
  const Real = window.Worker;
  window.Worker = class extends Real {
    #fake: boolean;
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.#fake = /\/app\/worker\.ts/.test(String(url));
    }
    postMessage(m: unknown, t?: unknown) {
      if (!this.#fake) return super.postMessage(m as never, t as never);
      const answer = (data: unknown) => setTimeout(() => this.onmessage?.(new MessageEvent('message', { data })));
      const type = (m as { type?: string }).type;
      if (type === 'start') answer({ type: 'state', state: 'off' });
      if (type === 'stop') answer({ type: 'stopped' });
    }
  };
});

test('a kept snapshot of a disk written in place shows as unrestorable while a machine writes the disk (its record not refreshed yet), in the Snapshots tab and the Load snapshot menu, before any restore', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await standIn(page);
  await answerAsks(page);
  await page.goto(`${base}/web/app/?autostart=1`);
  const ids = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { attach, createMachine } = await import('/web/app/machines.ts' as string);
    const { importStored, identityOf } = await import('/web/app/disks.ts' as string);
    const store = await Store.open();
    const m = await createMachine(store, { name: 'In place' });
    const file = new File([await (await fetch('/tests/qcow2/data.raw')).arrayBuffer()], 'data.raw');
    const s = await importStored(store, file, () => {});
    const a = await attach(store, m, s);
    const rec = await store.get('machines', m.id);
    rec.attachments.find((x: { id: string }) => x.id === a.id).inPlace = true;
    await store.put('machines', rec);
    store.close();
    return { m: m.id as string, s: s.id as string, generation: s.generation as number, identity: identityOf(s) as string, size: s.size as number };
  });
  await page.goto(`${base}/web/app/?autostart=1&m=${ids.m}`);
  await page.waitForFunction(() => document.body.dataset.state === 'off', null, { timeout: 30_000, polling: 50 });
  // Kept at the machine's shape now, pinning the disk in place at its generation (a kept snapshot hasn't the whole disk).
  const sid = await page.evaluate(async ({ m, s, generation }) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { page: p } = await import('/web/app/page.ts' as string);
    const { SNAPSHOT_VERSION } = await import('/web/snapshot-file.ts' as string);
    const store = await Store.open();
    const rec = await store.get('machines', m);
    const disks = new Map((await store.all('disks')).map((d: { id: string }) => [d.id, d]));
    const { shape, hash } = await p.shapeNow(rec, disks, await store.all('overlays'));
    const pins = [{ slot: shape.disks[0].slot, overlay: `disks/${s}`, generation, blocks: 0 }];
    await store.put('snapshots', { id: 'eeeeeeeeeee3', machine: m, name: 'Kept', created: Date.now(), bytes: 1 << 20, shape, shapeHash: hash, pins, coreVersion: SNAPSHOT_VERSION });
    store.close();
    return 'eeeeeeeeeee3';
  }, ids);
  const item = page.locator(`#load-snapshot [data-snapshot="${sid}"]`);
  await page.locator('#load-snapshot summary').click();
  await item.waitFor();
  assert.equal(await item.isDisabled(), false, 'the disk as pinned: it restores');
  await page.locator('#load-snapshot summary').click(); // closed

  // A machine (in another tab, or this page's guest) writes the disk in place and holds it open: its files moved on,
  // its record is refreshed only at that run's stop.
  const w = await page.evaluateHandle(() => new Worker('/tests/browser/overlay-worker.ts', { type: 'module' }));
  const written = await w.evaluate((w, a) => new Promise<{ type: string; generation?: number; message?: string }>((resolve) => {
    w.onmessage = (e) => resolve(e.data);
    w.postMessage({ type: 'inPlace', name: `disks/${a.s}`, identity: a.identity, size: a.size });
  }), ids);
  assert.equal(written.type, 'written', written.message ?? '');
  assert.equal(written.generation, ids.generation + 1);
  const recorded = await page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const d = await store.get('disks', id);
    store.close();
    return d.generation as number;
  }, ids.s);
  assert.equal(recorded, ids.generation, "the disk's record lags its files while the machine writes it");

  const why = t('snapshots:snapshots.unrestorable.inPlace', { disk: 'data.raw' });
  await page.locator('#load-snapshot summary').click();
  await item.waitFor();
  await page.waitForFunction((sid) => (document.querySelector(`#load-snapshot [data-snapshot="${sid}"]`) as HTMLButtonElement | null)?.disabled === true, sid, { timeout: 10_000, polling: 50 })
    .catch(async (e) => { throw new Error(`${e}; its tooltip: ${await item.getAttribute('title')}`); });
  assert.equal(await item.getAttribute('title'), t('toolbar:LoadSnapshotMenu.load.unrestorable.title', { why }));
  await page.locator('#load-snapshot summary').click(); // closed

  await openHome(page);
  await modal(page).locator('[data-tab=snapshots]').click();
  const card = modal(page).locator(`[data-snapshot=${sid}]`);
  await card.locator('.orphan').waitFor({ timeout: 10_000 });
  assert.equal(await card.locator('.orphan').textContent(), t('snapshots:Snapshots.orphaned', { why }));
  assert.equal(await card.locator('[data-action=restore]').count(), 0, 'nothing restores it');
  await shot(page, 'unrestorable-while-written');
  await w.evaluate((w) => new Promise<void>((resolve) => { w.onmessage = () => resolve(); w.postMessage({ type: 'close' }); }));
  assert.deepEqual(errors, []);
  await context.close();
});
