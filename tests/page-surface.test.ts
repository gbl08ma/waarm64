// The disk surface window (web/app/SurfaceWindow.svelte, docs/frontend.md "A disk's surface") on the page in Chromium,
// without a guest: a stored disk imported from a raw image with known regions and overlays of it written by a test
// worker (tests/browser/overlay-writer.ts), as the files a machine leaves. The "visualize" link in the Disks pane opens
// the disk alone, in a machine's Disks tab its attachment's overlay; held squares where the data is; an overlay grown
// past the disk (squares without the disk, its end marked, the overlay's changes and zeroings); the overlay picker; a
// pinned square's blocks, runs and Check contents; the window over the machine once the Machines page is closed; a
// ramdisk with nothing to show while its machine is off. The live map is tests/page-surface-debian.test.ts's.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { plain, t } from '../web/i18n.ts';
import { CORE, RIM } from '../web/app/ui/block-grid.ts';
import { answerAsks } from './page-ask.ts';
import { words } from './words.ts';

const MiB = 2 ** 20;
const BLOCK = 4096;
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

const win = (page: Page) => page.locator('#surface-window');
const modal = (page: Page) => page.locator('.machines');
/** The window's view once an answer of `want` came (its arrays as plain arrays). */
async function view(page: Page, want: (v: { source: string; overlay?: string; size: number; cellBytes: number; answers: number; layers: unknown[] }) => boolean = () => true) {
  const read = () => page.evaluate(() => {
    const s = window.__surface;
    if (!s?.surface || !s.look) return undefined;
    return {
      source: s.source, overlay: s.overlay, live: s.live, pinned: s.pinned, answers: s.answers(),
      size: s.surface.size, cellBytes: s.surface.cellBytes,
      rim: [...s.look.rim], core: [...s.look.core], mark: s.look.mark,
      layers: s.surface.layers.map((l) => ({ id: l.id, size: l.size, held: [...l.held], zero: [...l.zero] })),
    };
  });
  const t0 = Date.now();
  for (;;) {
    const v = await read();
    if (v && want(v)) return v;
    if (Date.now() - t0 > 20_000) throw new Error(`no such view: ${JSON.stringify(v)}`);
    await page.waitForTimeout(100);
  }
}
/** The page coordinates of square `i` of the window's map (its data-* layout hooks). */
async function square(page: Page, i: number, grid = win(page).locator('.map [role=application]')) {
  const box = (await grid.boundingBox())!;
  const [cols, pitch, size, pad] = await grid.evaluate((e) => ['cols', 'pitch', 'size', 'pad'].map((k) => Number((e as HTMLElement).dataset[k])));
  return { x: box.x + pad + (i % cols) * pitch + size / 2, y: box.y + pad + Math.floor(i / cols) * pitch + size / 2 };
}
const pointAt = async (page: Page, i: number) => { const p = await square(page, i); await page.mouse.move(p.x, p.y); };
const clickAt = async (page: Page, i: number) => { const p = await square(page, i); await page.mouse.click(p.x, p.y); };
const rangeWords = (page: Page) => win(page).locator('[data-field=surface-range-words]').textContent();

/** A stored disk S (32 MiB: data in its first MiB and 64 KiB at 12 MiB), machine A with S through overlay W (grown to 48 MiB, with changes), a ramdisk R on A too. */
async function setUp(page: Page) {
  return page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { attach, createDisk, createMachine } = await import('/web/app/machines.ts' as string);
    const { createOverlay, importStored, switchOverlay } = await import('/web/app/disks.ts' as string);
    const MiB = 2 ** 20;
    const raw = new Uint8Array(32 * MiB);
    raw.fill(1, 0, MiB);
    raw.fill(2, 12 * MiB, 12 * MiB + 64 * 1024);
    const store = await Store.open();
    const s = await importStored(store, new File([raw], 'surface.raw'), () => {});
    const r = await createDisk(store, { kind: 'ramdisk', size: 8 * MiB, name: 'Scratch', identity: null });
    const a = await createMachine(store, { name: 'Machine A' });
    const w = await createOverlay(store, s, 'Work', undefined, 48 * MiB);
    const other = await createOverlay(store, s, 'Other');
    const sa = await attach(store, a, s);
    await switchOverlay(store, a, sa.id, w.id);
    await attach(store, a, r);
    store.close();
    // W's changes: 2 blocks at 4 MiB and a block of zeros after them, a block zeroed at 0, 4 blocks at 40 MiB (past the disk).
    const worker = new Worker('/tests/browser/overlay-writer.ts', { type: 'module' });
    const done = await new Promise<string>((resolve) => {
      worker.onmessage = (e) => resolve(String(e.data));
      worker.postMessage({
        dir: `overlays/${w.id}`,
        size: 32 * MiB,
        writes: [{ at: 4 * MiB, len: 8192, fill: 3 }, { at: 4 * MiB + 8192, len: 4096, fill: 0 }, { at: 40 * MiB, len: 4 * 4096, fill: 5 }],
        zeros: [{ at: 0, len: 4096 }],
      });
    });
    worker.terminate();
    if (done !== 'done') throw new Error(done);
    return { s: s.id as string, r: r.id as string, a: a.id as string, w: w.id as string, other: other.id as string, sa: sa.id as string };
  });
}

test('the disk surface window: from the Disks pane and a machine\'s Disks tab, a stored disk and an overlay grown past it, the picker, a pinned square, Check contents, over the machine; a ramdisk off', { timeout: 120_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?view=terminal`);
  const ids = await setUp(page);
  await page.reload();
  await page.click('#machines-open');

  // The Disks pane: the link ends the disk's line; the window opens on the disk alone, from its files.
  await modal(page).locator('nav [data-machine=disks]').click();
  const card = modal(page).locator(`section[data-selected=disks] [data-disk="${ids.s}"]`);
  await card.locator('[data-action=surface-open]').waitFor();
  assert.ok((await card.locator('.meta').textContent())!.endsWith(plain(t('disks:VisualizeLine.line', { line: '' }))), 'the line ends with the link');
  await card.locator('[data-action=surface-open]').click();
  await win(page).waitFor();
  assert.equal(await win(page).locator('.title').textContent(), 'surface.raw');
  assert.equal(await win(page).locator('[data-field=surface-overlay]').inputValue(), '');
  let v = await view(page, (x) => x.source === 'offline');
  assert.equal(v.size, 32 * MiB);
  assert.equal(v.cellBytes, 4 * MiB, 'the window has room for every range: a square is 4 MiB');
  assert.deepEqual(v.rim, [RIM.step(1), 0, 0, RIM.step(1), 0, 0, 0, 0], 'held where the data is');
  assert.deepEqual(v.layers.map((l) => l.id), ['disk']);
  assert.deepEqual(v.layers[0].held, [256, 0, 0, 16, 0, 0, 0, 0]);
  assert.equal(v.mark, undefined);
  assert.equal(await win(page).locator('[data-legend]').getAttribute('data-legend'), 'empty some full');
  assert.equal(await win(page).locator('[data-field=surface-scale]').textContent(), t('disks:SurfaceWindow.scale', { size: '4 MiB' }));
  assert.equal(await win(page).locator('[data-action=surface-refresh]').count(), 1, 'not live: Refresh');
  // Pointed at: the square's numbers.
  await pointAt(page, 3);
  await page.waitForFunction(() => document.querySelector('[data-field=surface-line]')?.textContent?.includes('12 MiB'));
  const line = (await win(page).locator('[data-field=surface-line]').textContent())!;
  assert.match(line, words('disks:surface-look.at', { from: '12 MiB', to: '16 MiB' }));
  assert.match(line, words('disks:surface-look.disk.held', { held: 16, count: 1024 }));
  // Pinned: the range's blocks, its runs, and the content check (the import left zero blocks out: none read is all zeros).
  await clickAt(page, 0);
  await win(page).locator('section.details[data-range="0"][data-loaded]').waitFor();
  assert.match((await rangeWords(page))!, words('disks:surface-look.range.diskRuns', { blocks: 256, count: 1 }));
  await win(page).locator('[data-action=surface-check]').click();
  await page.waitForFunction((re) => new RegExp(re).test(document.querySelector('[data-field=surface-range-words]')?.textContent ?? ''), words('disks:surface-look.range.content', { count: 256, zeros: 0 }).source);
  assert.equal((await view(page)).pinned, 0);

  // A machine's Disks tab: the window (moved aside by its title bar) starts again, on the attachment's overlay, grown
  // past the disk.
  const bar = (await win(page).locator('.title').boundingBox())!;
  await page.mouse.move(bar.x + 10, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + 10 + 600, bar.y + bar.height / 2 + 600, { steps: 5 });
  await page.mouse.up();
  await modal(page).locator(`nav [data-machine="${ids.a}"]`).click();
  const m = modal(page).locator(`section.machine[data-selected="${ids.a}"]`);
  await m.locator('[data-tab=disks]').click();
  await m.locator(`[data-attachment="${ids.sa}"] [data-action=surface-open]`).click();
  await page.waitForFunction((w) => (document.querySelector('[data-field=surface-overlay]') as HTMLSelectElement | null)?.value === w, ids.w);
  v = await view(page, (x) => x.overlay === ids.w && x.size === 48 * MiB);
  assert.equal(v.pinned, undefined, 'a new window: nothing pinned');
  assert.deepEqual(v.layers.map((l) => [l.id, l.size]), [['disk', 32 * MiB], ['overlay', 48 * MiB]]);
  assert.deepEqual(v.rim, [RIM.step(1), 0, 0, RIM.step(1), 0, 0, 0, 0, RIM.absent, RIM.absent, RIM.absent, RIM.absent], 'no disk past its end');
  assert.equal(v.mark, 7, "the disk's end marked after its last square");
  assert.deepEqual(v.core, [CORE.hollow, CORE.step(1), 0, 0, 0, 0, 0, 0, 0, 0, CORE.step(1), 0], 'changed, zeroed only (hollow), and past the disk');
  assert.equal(await win(page).locator('[data-legend]').getAttribute('data-legend'), 'empty some full absent changed zeroed');
  await clickAt(page, 1);
  await win(page).locator('section.details[data-range="1"][data-loaded]').waitFor();
  assert.match((await rangeWords(page))!, words('disks:surface-look.range.overlayRuns', { blocks: 3, count: 1 }));
  assert.match((await rangeWords(page))!, words('disks:surface-look.range.diskEmpty'));
  await win(page).locator('[data-action=surface-check]').click();
  await page.waitForFunction((re) => new RegExp(re).test(document.querySelector('[data-field=surface-range-words]')?.textContent ?? ''), words('disks:surface-look.range.content', { count: 3, zeros: 1 }).source);
  // The details' own map: the overlay's three blocks first.
  const blockMap = win(page).locator('section.details [role=application]');
  assert.equal(await blockMap.getAttribute('data-cells'), '1024');
  assert.equal(await blockMap.getAttribute('data-cols'), '32');

  // The picker: the disk alone, then another overlay (nothing changed in it), then back.
  await win(page).locator('[data-field=surface-overlay]').selectOption('');
  v = await view(page, (x) => x.overlay === undefined && x.size === 32 * MiB);
  assert.deepEqual([v.size, v.layers.length, v.mark], [32 * MiB, 1, undefined]);
  assert.equal(v.pinned, undefined, 'another view: the pin goes');
  await win(page).locator('[data-field=surface-overlay]').selectOption(ids.other);
  v = await view(page, (x) => x.overlay === ids.other && x.layers.length === 2 && x.size === 32 * MiB);
  assert.deepEqual(v.core, [0, 0, 0, 0, 0, 0, 0, 0]);
  await win(page).locator('[data-field=surface-overlay]').selectOption(ids.w);
  await view(page, (x) => x.overlay === ids.w && x.size === 48 * MiB);

  // The Machines page closed: the window stays, over the machine, and the screen's focus isn't taken by a click on it.
  await modal(page).locator('[data-action=back]').click();
  await page.waitForFunction(() => document.body.dataset.page === 'machine');
  assert.ok(await win(page).isVisible());
  await page.locator('#terminal .xterm-helper-textarea').focus().catch(() => undefined);
  const focused = await page.evaluate(() => document.activeElement?.className ?? '');
  await pointAt(page, 2);
  await page.mouse.down();
  await page.mouse.up();
  assert.equal(await page.evaluate(() => document.activeElement?.className ?? ''), focused, 'the focus stays where it was');
  // Refresh asks the files again.
  const before = (await view(page)).answers;
  await win(page).locator('[data-action=surface-refresh]').click();
  await view(page, (x) => x.answers > before);
  await win(page).locator('[data-action=close]').click();
  assert.equal(await win(page).count(), 0);

  // A ramdisk, its machine off: nothing to show, said in words.
  await page.click('#machines-open');
  await modal(page).locator('nav [data-machine=disks]').click();
  await modal(page).locator(`section[data-selected=disks] [data-disk="${ids.r}"] [data-action=surface-open]`).click();
  await win(page).locator('[data-field=surface-why]').waitFor();
  assert.equal((await win(page).locator('[data-field=surface-why]').textContent())!.trim(), t('disks:surface-source.ramdisk'));
  assert.equal(await win(page).locator('[data-action=surface-refresh]').count(), 0);
  assert.equal(await win(page).locator('[data-legend]').count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
