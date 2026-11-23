// Resize… on the Home page (web/app/ResizeDisk.svelte, docs/machines.md §4.5) in Chromium, without a guest but for
// the last case's (a URL disk that runs the firmware): from the browser's Disks pane (a stored disk's card, an overlay's
// row in Overlays…, a ramdisk's card) and from a machine's Disks tab (its overlay, one made where it has none yet, its stored disk written
// in place, its ramdisk; none on a read-only disk); what the overlays and stored disks hold of their sizes, where the page shows them. The size now, the box on by default (none for a ramdisk), the refusals as the size is typed (not larger, past
// `MAX_RESIZE`, a machine running), the machines and the orphaned snapshots in the confirmation, the machine on this page
// powered off from the dialog, and the records' sizes and grow marks after. The resize itself is tests/resize.test.ts's.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { t } from '../web/i18n.ts';
import { bytesText } from '../web/app/bytes.ts';
import { MAX_RESIZE } from '../web/app/resize.ts';
import { answerAsks } from './page-ask.ts';
import { words } from './words.ts';
import { openHome } from './page-home.ts';
import { existsSync } from 'node:fs';

// A guest boots on the default kernel: skipped without it (a clone without images, GitHub Actions).
const kernel = !existsSync(new URL('../target/images/linux/Image', import.meta.url)) && 'SKIPPED: run images/build.sh linux';

const MiB = 2 ** 20;
const GiB = 2 ** 30;
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
const dialog = (page: Page) => page.locator('#resize-disk');

/** The records' sizes and grow marks, by id (disks and overlays). */
const records = (page: Page) => page.evaluate(async () => {
  const { Store } = await import('/web/app/store.ts' as string);
  const store = await Store.open();
  const out: Record<string, { size?: number; grow?: { from: number; to: number } | null }> = {};
  for (const r of [...await store.all('disks'), ...await store.all('overlays')]) out[r.id] = { size: r.size, grow: r.grow ?? null };
  store.close();
  return out;
});

/** Types a size into the open dialog (and its unit), and waits for what it says of it: a refusal, or the confirmation. */
async function typeSize(page: Page, amount: string, unit: 'MiB' | 'GiB', expect: 'refusal' | 'new') {
  await dialog(page).locator('[data-field=resize-unit]').selectOption(unit);
  await dialog(page).locator('[data-field=resize-size]').fill(amount);
  await dialog(page).locator(expect === 'refusal' ? '[data-refusal]' : '[data-new]').waitFor();
  return (await dialog(page).locator(expect === 'refusal' ? '[data-refusal]' : '[data-new]').textContent())!;
}

test("Resize… in the browser's Disks pane: a stored disk, an overlay's row, a ramdisk; the box, the refusals as typed, the machines and orphaned snapshots, the records after", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?autostart=1`);
  // A URL disk U (overlays O1, chosen by A, and O2), a stored disk S (192 KiB, on A and B), a ramdisk R (4 MiB, on B);
  // a snapshot of A kept at the sizes now.
  const ids = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { attach, createDisk, createMachine } = await import('/web/app/machines.ts' as string);
    const { createOverlay, importStored, switchOverlay } = await import('/web/app/disks.ts' as string);
    const { shapeOf } = await import('/web/app/shape.ts' as string);
    const store = await Store.open();
    const a = await createMachine(store, { name: 'Machine A' });
    const b = await createMachine(store, { name: 'Machine B' });
    const u = await createDisk(store, { kind: 'url', url: '/tests/qcow2/deflate.qcow2', size: 1 << 20, bytes: 1 << 20, name: 'Disk U' });
    const file = new File([await (await fetch('/tests/qcow2/data.raw')).arrayBuffer()], 'data.raw');
    const s = await importStored(store, file, () => {});
    const r = await createDisk(store, { kind: 'ramdisk', size: 4 << 20, name: 'Disk R' });
    const o1 = await createOverlay(store, u, 'First');
    const o2 = await createOverlay(store, u, 'Second');
    const ua = await attach(store, a, u);
    await switchOverlay(store, a, ua.id, o1.id);
    await attach(store, a, s);
    await attach(store, b, s);
    await attach(store, b, r);
    const am = await store.get('machines', a.id);
    const ds = new Map((await store.all('disks')).map((d: { id: string }) => [d.id, d]));
    const os = new Map((await store.all('overlays')).map((o: { id: string }) => [o.id, o]));
    const shape = shapeOf(am, (i: string) => ds.get(i), { overlays: (i: string) => os.get(i) });
    await store.put('snapshots', { id: 'eeeeeeeeeee1', machine: a.id, name: 'Before', created: 0, bytes: 0, shape, shapeHash: '', pins: [] });
    store.close();
    return { a: a.id as string, b: b.id as string, u: u.id as string, s: s.id as string, r: r.id as string, o1: o1.id as string, o2: o2.id as string, sSize: s.size as number, sBytes: s.bytes as number };
  });
  assert.equal(ids.sSize, 196608);
  assert.ok(ids.sBytes > 0, 'the import says what the stored disk holds');
  // A stored disk's record from before it said so: the page reads it from its files when it opens.
  await page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const { bytes: _, ...d } = await store.get('disks', id);
    await store.put('disks', d);
    store.close();
  }, ids.s);
  await page.reload();
  await openHome(page);
  await modal(page).locator('nav [data-machine=disks]').click();
  const pane = modal(page).locator('section[data-selected=disks]');
  const card = (id: string) => pane.locator(`[data-disk="${id}"]`);
  await card(ids.s).waitFor();
  // On the stored disk and the ramdisk; not on the URL disk itself (its overlays grow).
  assert.equal(await card(ids.s).locator('[data-action=resize-disk]').count(), 1);
  assert.equal(await card(ids.r).locator('[data-action=resize-disk]').count(), 1);
  assert.equal(await card(ids.u).locator('[data-action=resize-disk]').count(), 0);
  // The stored disk's line: what it holds of its size.
  const heldLine = words('disks:DiskInfo.meta.held', { held: bytesText(ids.sBytes), size: bytesText(196608) });
  await page.waitForFunction(([sel, re]) => new RegExp(re).test(document.querySelector(sel)?.textContent ?? ''), [`[data-disk="${ids.s}"]`, heldLine.source] as const);

  // B runs (its Web Lock held, as another tab's run holds it).
  await page.evaluate((name) => new Promise<void>((held) => {
    void navigator.locks.request(name, () => new Promise<void>((release) => {
      (window as unknown as { releaseB: () => void }).releaseB = release;
      held();
    }));
  }), `waarm64-machine:${ids.b}`);

  // The stored disk: its size now, 256 MiB offered (the next step past it), the box on, both machines, B running (no
  // Power off here: it isn't this page's), A's snapshot orphaned.
  await card(ids.s).locator('[data-action=resize-disk]').click();
  const d = dialog(page);
  await d.locator('[data-running]').waitFor();
  assert.equal(await d.locator('h2').textContent(), t('disks:ResizeDisk.title', { name: 'data.raw' }));
  assert.equal(await d.locator('[data-now]').textContent(), t('disks:ResizeDisk.nowHeld', { size: 196608, held: ids.sBytes }));
  assert.equal(await d.locator('[data-field=resize-size]').inputValue(), '256');
  assert.equal(await d.locator('[data-field=resize-unit]').inputValue(), 'MiB');
  assert.equal(await d.locator('[data-field=resize-grow]').isChecked(), true);
  assert.equal(await d.locator('[data-new]').textContent(), t('disks:ResizeDisk.newSize', { size: 256 * MiB }));
  assert.equal(await d.locator('[data-machines]').textContent(), t('disks:ResizeDisk.machines', { machines: ['Machine A', 'Machine B'] }));
  assert.equal(await d.locator('[data-running]').textContent(), t('machines:resize.running', { machines: ['Machine B'], count: 1 }));
  assert.equal(await d.locator('[data-action=resize-power-off]').count(), 0);
  assert.equal(await d.locator('[data-snapshots]').textContent(), t('disks:ResizeDisk.snapshots', { count: 1, list: [t('disks:ResizeDisk.snapshot', { name: 'Before', machine: 'Machine A' })] }));
  assert.ok(await d.locator('[data-action=resize-ok]').isDisabled());
  // Past the cap: refused as typed, with the limit.
  const big = 300_000;
  assert.equal(await typeSize(page, String(big), 'GiB', 'refusal'), t('machines:resize.tooLarge', { size: big * GiB, max: MAX_RESIZE }));
  assert.ok(await d.locator('[data-action=resize-ok]').isDisabled());
  // B off: 1.5 GiB, rounded to whole MiB, resizes it with the mark.
  await page.evaluate(() => (window as unknown as { releaseB: () => void }).releaseB());
  assert.equal(await typeSize(page, '1.5', 'GiB', 'new'), t('disks:ResizeDisk.newSize', { size: 1536 * MiB }));
  await d.locator('[data-action=resize-ok]:not([disabled])').click();
  await d.waitFor({ state: 'detached' });
  assert.deepEqual((await records(page))[ids.s], { size: 1536 * MiB, grow: { from: 196608, to: 1536 * MiB } });

  // An overlay's row: smaller refused, the box turned off, 2 GiB; only A (which has it chosen); the other overlay as it was.
  await card(ids.u).locator('[data-action=disk-overlays]').click();
  await page.locator(`#overlays [data-overlay="${ids.o1}"] [data-action=resize-overlay]`).click();
  await d.locator('[data-new]').waitFor();
  assert.equal(await d.locator('h2').textContent(), t('disks:ResizeDisk.title', { name: 'First' }));
  assert.equal(await d.locator('[data-now]').textContent(), t('disks:ResizeDisk.nowHeld', { size: MiB, held: 0 }));
  assert.equal(await d.locator('[data-machines]').textContent(), t('disks:ResizeDisk.machines', { machines: ['Machine A'] }));
  assert.equal(await typeSize(page, '1', 'MiB', 'refusal'), t('machines:resize.notLarger', { size: MiB, now: MiB }));
  await d.locator('[data-field=resize-grow]').uncheck();
  await typeSize(page, '2', 'GiB', 'new');
  await d.locator('[data-action=resize-ok]:not([disabled])').click();
  await d.waitFor({ state: 'detached' });
  // Its row says what it holds of the size it grew to; the other's, of the disk's.
  const row = (id: string) => page.locator(`#overlays [data-overlay="${id}"]`);
  await page.waitForFunction(([sel, s]) => (document.querySelector(sel)?.textContent ?? '').includes(s), [`#overlays [data-overlay="${ids.o1}"]`, bytesText(2 * GiB)] as const);
  assert.match((await row(ids.o1).textContent())!, words('disks:Overlays.meta', { held: bytesText(0), size: bytesText(2 * GiB) }));
  assert.match((await row(ids.o2).textContent())!, words('disks:Overlays.meta', { held: bytesText(0), size: bytesText(MiB) }));
  await page.locator('#overlays [data-action=close-overlays]').click();
  await page.locator('#overlays').waitFor({ state: 'detached' });
  const after1 = await records(page);
  assert.deepEqual(after1[ids.o1], { size: 2 * GiB, grow: null });
  assert.deepEqual(after1[ids.o2], { size: undefined, grow: null });

  // The ramdisk: no box (it's empty at every start), no mark.
  await card(ids.r).locator('[data-action=resize-disk]').click();
  await d.locator('[data-new]').waitFor();
  assert.equal(await d.locator('[data-field=resize-grow]').count(), 0);
  assert.equal(await d.locator('[data-machines]').textContent(), t('disks:ResizeDisk.machines', { machines: ['Machine B'] }));
  assert.equal(await d.locator('[data-snapshots]').count(), 0);
  assert.equal(await typeSize(page, '2', 'MiB', 'refusal'), t('machines:resize.notLarger', { size: 2 * MiB, now: 4 * MiB }));
  await typeSize(page, '64', 'MiB', 'new');
  await d.locator('[data-action=resize-ok]:not([disabled])').click();
  await d.waitFor({ state: 'detached' });
  assert.deepEqual((await records(page))[ids.r], { size: 64 * MiB, grow: null });
  assert.deepEqual(errors, []);
  await context.close();
});

test("Resize… on a machine's Disks tab: its overlay, its stored disk written in place, an overlay made where none is chosen, its ramdisk, none on a read-only disk; the machine on this page powered off from the dialog", { skip: kernel }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  const asked: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page, (q) => { asked.push(q.text); });
  await page.goto(`${base}/web/app/?autostart=1`);
  // M: a URL disk through overlay W, the same image read-only, a ramdisk.
  const ids = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { attach, createDisk, createMachine } = await import('/web/app/machines.ts' as string);
    const { createOverlay, importStored, switchOverlay } = await import('/web/app/disks.ts' as string);
    const { makeDisk } = await import('/web/app/add-disk.ts' as string);
    const store = await Store.open();
    const m = await createMachine(store, { name: 'Machine M' });
    // N: a stored disk written in place (its Resize… grows the disk itself).
    const n = await createMachine(store, { name: 'Machine N' });
    const s = await importStored(store, new File([await (await fetch('/tests/qcow2/data.raw')).arrayBuffer()], 'data.raw'), () => {});
    const sa = await attach(store, n, s);
    // And a URL disk F with no overlay chosen yet (its first start would make one).
    const f = await createDisk(store, { kind: 'url', url: '/tests/qcow2/deflate.qcow2', size: 1 << 20, bytes: 1 << 20, name: 'Disk F' });
    const fa = await attach(store, n, f);
    await store.put('machines', { ...(await store.get('machines', n.id)), attachments: [{ ...sa, inPlace: true }, fa] });
    const url = (path: string) => makeDisk(store, m, { source: 'url', url: path, size: 0 }, () => {}, () => {});
    const u = await url('/tests/qcow2/deflate.qcow2');
    const ro = await url('/tests/qcow2/data.raw');
    const r = await createDisk(store, { kind: 'ramdisk', size: 4 << 20, name: 'Disk R' });
    const w = await createOverlay(store, u, 'Work');
    const ua = await attach(store, m, u);
    await switchOverlay(store, m, ua.id, w.id);
    const roa = await attach(store, m, ro, { readOnly: true });
    const ra = await attach(store, m, r);
    store.close();
    return { m: m.id as string, w: w.id as string, r: r.id as string, ua: ua.id as string, roa: roa.id as string, ra: ra.id as string, size: u.size as number, n: n.id as string, s: s.id as string, sa: sa.id as string, sSize: s.size as number, sBytes: s.bytes as number, fa: fa.id as string };
  });
  await openHome(page);
  await modal(page).locator(`nav [data-machine="${ids.m}"]`).click();
  const m = modal(page).locator(`section.machine[data-selected="${ids.m}"]`);
  await m.locator('[data-tab=disks]').click();
  const att = (id: string) => m.locator(`[data-attachment="${id}"]`);
  await att(ids.ua).waitFor();
  assert.equal(await att(ids.ua).locator('[data-action=resize-attachment]').count(), 1);
  assert.equal(await att(ids.ra).locator('[data-action=resize-attachment]').count(), 1);
  assert.equal(await att(ids.roa).locator('[data-action=resize-attachment]').count(), 0);

  // Its overlay: the dialog names it; after it, the tab says the size the guest sees.
  await att(ids.ua).locator('[data-action=resize-attachment]').click();
  const d = dialog(page);
  await d.locator('[data-new]').waitFor();
  assert.equal(await d.locator('h2').textContent(), t('disks:ResizeDisk.title', { name: 'Work' }));
  assert.equal(await d.locator('[data-field=resize-grow]').isChecked(), true);
  assert.equal(await d.locator('[data-machines]').textContent(), t('disks:ResizeDisk.machines', { machines: ['Machine M'] }));
  await typeSize(page, '1', 'GiB', 'new');
  await d.locator('[data-action=resize-ok]:not([disabled])').click();
  await d.waitFor({ state: 'detached' });
  assert.deepEqual((await records(page))[ids.w], { size: GiB, grow: { from: ids.size, to: GiB } });
  await page.waitForFunction(([sel, s]) => (document.querySelector(sel)?.textContent ?? '').includes(s), [`[data-attachment="${ids.ua}"] .meta`, bytesText(GiB)] as const);
  assert.match((await att(ids.ua).locator('.meta').textContent())!, words('disks:disk-lines.meta', { size: bytesText(GiB) }));
  assert.equal(
    await att(ids.ua).locator(`[data-field=overlay] option[value="${ids.w}"]`).textContent(),
    t('disks:disk-lines.option', { name: 'Work', held: bytesText(0), size: bytesText(GiB) }),
    'the overlay in the list: what it holds of the size its guest sees',
  );

  // N's stored disk written in place: the shortcut grows the disk itself (its record and mark), as the Disks pane's card does.
  await modal(page).locator(`nav [data-machine="${ids.n}"]`).click();
  const n = modal(page).locator(`section.machine[data-selected="${ids.n}"]`);
  await n.locator('[data-tab=disks]').click();
  await n.locator(`[data-attachment="${ids.sa}"] [data-action=resize-attachment]`).click();
  await d.locator('[data-new]').waitFor();
  assert.equal(await d.locator('h2').textContent(), t('disks:ResizeDisk.title', { name: 'data.raw' }));
  assert.equal(await d.locator('[data-now]').textContent(), t('disks:ResizeDisk.nowHeld', { size: ids.sSize, held: ids.sBytes }));
  assert.equal(await d.locator('[data-field=resize-grow]').isChecked(), true);
  assert.equal(await d.locator('[data-machines]').textContent(), t('disks:ResizeDisk.machines', { machines: ['Machine N'] }));
  await typeSize(page, '512', 'MiB', 'new');
  await d.locator('[data-action=resize-ok]:not([disabled])').click();
  await d.waitFor({ state: 'detached' });
  assert.deepEqual((await records(page))[ids.s], { size: 512 * MiB, grow: { from: ids.sSize, to: 512 * MiB } });
  // In place, the row says what the disk holds of its size.
  const sRow = n.locator(`[data-attachment="${ids.sa}"] .meta`);
  await page.waitForFunction(([sel, s]) => (document.querySelector(sel)?.textContent ?? '').includes(s), [`[data-attachment="${ids.sa}"] .meta`, bytesText(512 * MiB)] as const);
  assert.match((await sRow.textContent())!, words('disks:disk-lines.meta.held', { held: bytesText(ids.sBytes), size: bytesText(512 * MiB) }));

  // F, with no overlay chosen: Resize… makes one ("Changes", as a start would), at the new size, marked, and chooses it.
  const fRow = n.locator(`[data-attachment="${ids.fa}"]`);
  await fRow.locator('[data-action=resize-attachment]').click();
  await d.locator('[data-new]').waitFor();
  assert.equal(await d.locator('h2').textContent(), t('disks:ResizeDisk.title', { name: 'Disk F' }));
  assert.equal(await d.locator('[data-now]').textContent(), t('disks:ResizeDisk.nowHeld', { size: MiB, held: 0 }));
  assert.equal(await d.locator('[data-new-overlay]').textContent(), t('disks:ResizeDisk.newOverlay', { name: t('disks:page-disks.overlayName'), machine: 'Machine N' }));
  assert.equal(await d.locator('[data-machines]').textContent(), t('disks:ResizeDisk.machines', { machines: ['Machine N'] }));
  await typeSize(page, '64', 'MiB', 'new');
  await d.locator('[data-action=resize-ok]:not([disabled])').click();
  await d.waitFor({ state: 'detached' });
  const made = await page.evaluate(async ([mid, aid]) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const a = (await store.get('machines', mid)).attachments.find((x: { id: string }) => x.id === aid);
    const o = a.overlay ? await store.get('overlays', a.overlay) : undefined;
    store.close();
    return o && { id: o.id as string, name: o.name as string, size: o.size as number, grow: o.grow };
  }, [ids.n, ids.fa] as const);
  assert.ok(made, 'the attachment has an overlay');
  assert.deepEqual({ ...made, id: undefined }, { id: undefined, name: t('disks:page-disks.overlayName'), size: 64 * MiB, grow: { from: MiB, to: 64 * MiB } });
  await fRow.locator(`[data-field=overlay] option[value="${made.id}"]`).waitFor({ state: 'attached' });
  assert.equal(await fRow.locator('[data-field=overlay]').inputValue(), made.id);
  await modal(page).locator(`nav [data-machine="${ids.m}"]`).click();
  await m.locator('[data-tab=disks]').click();

  // M runs on this page: the ramdisk's Resize says so and offers to power it off (asking first), then resizes.
  await m.locator('[data-action=open]').click();
  await page.waitForFunction(() => ['loading', 'booting', 'running'].includes(document.body.dataset.state!), null, { timeout: 30_000 });
  await openHome(page);
  await m.locator('[data-tab=disks]').click();
  await page.waitForFunction((s) => (document.querySelector('.machines .head .meta')?.textContent ?? '').includes(s), t('machines:MachinesPage.state.running'), { timeout: 10_000 });
  await att(ids.ra).locator('[data-action=resize-attachment]').click();
  await d.locator('[data-running]').waitFor();
  assert.equal(await d.locator('[data-running]').textContent(), t('machines:resize.running', { machines: ['Machine M'], count: 1 }));
  assert.ok(await d.locator('[data-action=resize-ok]').isDisabled());
  await d.locator('[data-action=resize-power-off]').click();
  await d.locator('[data-action=resize-ok]:not([disabled])').waitFor({ timeout: 15_000 });
  assert.match(asked.at(-1)!, words('machines:MachinesPage.powerOff.confirm', {}, { start: true }));
  assert.equal(await d.locator('[data-running]').count(), 0);
  await d.locator('[data-action=resize-ok]').click();
  await d.waitFor({ state: 'detached' });
  assert.deepEqual((await records(page))[ids.r], { size: 256 * MiB, grow: null });
  assert.deepEqual(errors, []);
  await context.close();
});
