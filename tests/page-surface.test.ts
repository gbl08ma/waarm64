// The disk surface window (web/app/SurfaceWindow.svelte, docs/frontend.md "A disk's surface") on the page in Chromium,
// without a guest: a stored disk imported from a raw image with known regions and overlays of it written by a test
// worker (tests/browser/overlay-writer.ts), as the files a machine leaves. The "visualize" link in the Disks pane opens
// the disk alone, in a machine's Disks tab its attachment's overlay; held squares where the data is; an overlay grown
// past the disk (squares without the disk, its end marked, the overlay's changes and zeroings); the overlay picker; a
// pinned square's blocks, runs and Check contents; the window over the machine once the Machines page is closed; a
// ramdisk with nothing to show while its machine is off; a file disk without a handle to read, not examined, said why
// (and its blocks not checked); the window's reading of the files not taken for a machine's by delete, resize and merge
// (the merge with the window open on an overlay it deletes); the pointed square's words spoken once per square.
// The live map is tests/page-surface-debian.test.ts's.
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
/** The pinned square's window, beside the map's. */
const pin = (page: Page) => page.locator('#surface-square');
const rangeWords = (page: Page) => pin(page).locator('[data-field=surface-range-words]').textContent();

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
  // In a window of its own beside the map's: the map keeps its room and its squares their size.
  const layout = () => win(page).locator('.map [role=application]').evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { ...(e as HTMLElement).dataset, w: r.width, h: r.height };
  });
  const mapBefore = await layout();
  await clickAt(page, 0);
  await pin(page).locator('section.details[data-range="0"][data-loaded]').waitFor();
  assert.deepEqual(await layout(), mapBefore, 'the map as it was');
  const [mapBox, pinBox] = [(await win(page).boundingBox())!, (await pin(page).boundingBox())!];
  assert.ok(pinBox.x >= mapBox.x + mapBox.width || pinBox.x + pinBox.width <= mapBox.x, 'beside the map');
  assert.ok(await pin(page).evaluate((e) => [e, ...e.querySelectorAll('*')].every((x) => x.scrollWidth <= x.clientWidth && x.scrollHeight <= x.clientHeight)), 'nothing in it scrolls');
  assert.match((await rangeWords(page))!, words('disks:surface-look.range.diskRuns', { blocks: 256, count: 1 }));
  await pin(page).locator('[data-action=surface-check]').click();
  await page.waitForFunction((re) => new RegExp(re).test(document.querySelector('[data-field=surface-range-words]')?.textContent ?? ''), words('disks:surface-look.range.content', { count: 256, zeros: 0 }).source);
  assert.equal((await view(page)).pinned, 0);
  // Another square shows in the same window; its Close unpins it.
  await clickAt(page, 3);
  await pin(page).locator('section.details[data-range="3"][data-loaded]').waitFor();
  assert.equal(await pin(page).count(), 1);
  await pin(page).locator('[data-action=close]').click();
  await pin(page).waitFor({ state: 'detached' });
  assert.equal((await view(page)).pinned, undefined, 'its Close unpins it');
  assert.equal(await win(page).count(), 1, 'the map stays');

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
  await pin(page).locator('section.details[data-range="1"][data-loaded]').waitFor();
  assert.match((await rangeWords(page))!, words('disks:surface-look.range.overlayRuns', { blocks: 3, count: 1 }));
  assert.match((await rangeWords(page))!, words('disks:surface-look.range.diskEmpty'));
  await pin(page).locator('[data-action=surface-check]').click();
  await page.waitForFunction((re) => new RegExp(re).test(document.querySelector('[data-field=surface-range-words]')?.textContent ?? ''), words('disks:surface-look.range.content', { count: 3, zeros: 1 }).source);
  // The details' own map: the overlay's three blocks first.
  const blockMap = pin(page).locator('section.details [role=application]');
  assert.equal(await blockMap.getAttribute('data-cells'), '1024');
  assert.equal(await blockMap.getAttribute('data-cols'), '32');

  // The picker: the disk alone, then another overlay (nothing changed in it), then back.
  await win(page).locator('[data-field=surface-overlay]').selectOption('');
  v = await view(page, (x) => x.overlay === undefined && x.size === 32 * MiB);
  assert.deepEqual([v.size, v.layers.length, v.mark], [32 * MiB, 1, undefined]);
  assert.equal(v.pinned, undefined, 'another view: the pin goes');
  // Until the other overlay's first answer, the disk alone's picture is dimmed and the line says it's reading.
  await page.evaluate(() => {
    const w = window as unknown as { __stale: string[] };
    w.__stale = [];
    const map = document.querySelector('#surface-window .map')!;
    new MutationObserver(() => {
      if (map.hasAttribute('data-stale')) w.__stale.push(document.querySelector('#surface-window [data-field=surface-line]')?.textContent ?? '');
    }).observe(map, { attributes: true, attributeFilter: ['data-stale'] });
  });
  await win(page).locator('[data-field=surface-overlay]').selectOption(ids.other);
  v = await view(page, (x) => x.overlay === ids.other && x.layers.length === 2 && x.size === 32 * MiB);
  assert.deepEqual(v.core, [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(await page.evaluate(() => (window as unknown as { __stale: string[] }).__stale.slice(0, 1)), [t('disks:SurfaceWindow.reading')], 'the picture before, dimmed while the new one is read');
  assert.equal(await win(page).locator('.map[data-stale]').count(), 0, 'not once it came');
  assert.equal(await page.evaluate(() => window.__surface?.stale), false);
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

test('the disk surface window over a file disk without a handle to read: not examined, said why', { timeout: 60_000 }, async () => {
  // A handle whose read permission is granted (an OPFS file's) can't be kept in a record here: Chromium's headless
  // page goes away as one is stored. The file's tables read for its clusters are tests/surface-image.test.ts's.
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?view=terminal`);
  const size = 12 * MiB;
  const id = await page.evaluate(async (size) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { newId } = await import('/web/app/shape.ts' as string);
    const store = await Store.open();
    const now = Date.now();
    const name = 'gone.qcow2';
    const d = { id: newId(), kind: 'file', name, size, format: 'qcow2', identity: { kind: 'file', name, bytes: size, modified: now }, created: now };
    await store.put('disks', d);
    store.close();
    return d.id as string;
  }, size);
  await page.reload();
  await page.click('#machines-open');
  await modal(page).locator('nav [data-machine=disks]').click();
  await modal(page).locator(`section[data-selected=disks] [data-disk="${id}"] [data-action=surface-open]`).click();
  const o = await view(page, (x) => x.source === 'offline');
  assert.deepEqual(o.rim, [RIM.opaque, RIM.opaque, RIM.opaque]);
  assert.equal(await win(page).locator('[data-legend]').getAttribute('data-legend'), 'opaque');
  assert.equal((await win(page).locator('[data-field=surface-line]').textContent())!.trim(), plain(t('disks:surface-look.why.permission')));
  // A square's blocks: the image's, which no check reads: said so, no Check contents.
  await clickAt(page, 0);
  await pin(page).locator('section.details[data-range="0"][data-loaded]').waitFor();
  assert.equal(await pin(page).locator('[data-action=surface-check]').count(), 0);
  assert.equal(await pin(page).locator('[data-field=surface-uncheckable]').textContent(), t('disks:surface-look.range.uncheckable'));
  assert.deepEqual(errors, []);
  await context.close();
});

/** Stored disk S (16 MiB, data in its first MiB) with overlays X1 (a change at 8 MiB), X2 and X3 (a change each), made in the page. */
async function setUpOverlays(page: Page) {
  return page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { createOverlay, importStored } = await import('/web/app/disks.ts' as string);
    const MiB = 2 ** 20;
    const raw = new Uint8Array(16 * MiB);
    raw.fill(1, 0, MiB);
    const store = await Store.open();
    const s = await importStored(store, new File([raw], 'merged.raw'), () => {});
    const [x1, x2, x3] = [await createOverlay(store, s, 'X1'), await createOverlay(store, s, 'X2'), await createOverlay(store, s, 'X3')];
    store.close();
    const write = async (dir: string, at: number) => {
      const worker = new Worker('/tests/browser/overlay-writer.ts', { type: 'module' });
      const done = await new Promise<string>((resolve) => {
        worker.onmessage = (e) => resolve(String(e.data));
        worker.postMessage({ dir, size: 16 * MiB, writes: [{ at, len: 8192, fill: 4 }], zeros: [] });
      });
      worker.terminate();
      if (done !== 'done') throw new Error(done);
    };
    await write(`overlays/${x1.id}`, 8 * MiB);
    await write(`overlays/${x2.id}`, 4 * MiB);
    await write(`overlays/${x3.id}`, 12 * MiB);
    return { s: s.id as string, x1: x1.id as string, x2: x2.id as string, x3: x3.id as string };
  });
}

test("the window's reading of the files isn't a machine's: delete, resize and merge go on while it shows the disk", { timeout: 120_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?view=terminal`);
  const ids = await setUpOverlays(page);
  await page.reload();
  await page.click('#machines-open');
  await modal(page).locator('nav [data-machine=disks]').click();
  await modal(page).locator(`section[data-selected=disks] [data-disk="${ids.s}"] [data-action=surface-open]`).click();
  await win(page).locator('[data-field=surface-overlay]').selectOption(ids.x2);
  await view(page, (x) => x.overlay === ids.x2 && x.layers.length === 2);

  // A job caught holding the disk's lock (shared) while it waits for X2's (held here, as another tab's machine would):
  // the disk isn't in use for the page's checks, and a resize of it waits for the job instead of being refused.
  await page.evaluate((x2) => {
    const w = window as unknown as { __release?: () => void };
    void navigator.locks.request(`waarm64-overlay:overlays/${x2}`, () => new Promise<void>((r) => (w.__release = r)));
  }, ids.x2);
  await page.waitForFunction(() => !!(window as unknown as { __release?: () => void }).__release);
  const checks = await page.evaluate(async (x) => {
    const { inUse } = await import('/web/app/disks.ts' as string);
    const { Store } = await import('/web/app/store.ts' as string);
    const { resize } = await import('/web/app/resize.ts' as string);
    const store = await Store.open();
    document.querySelector<HTMLButtonElement>('[data-action=surface-refresh]')!.click();
    // The job is in the files' locks: the disk's held, X2's asked for (it waits a second for it, then gives up).
    for (const t0 = performance.now(); ; await new Promise((r) => setTimeout(r, 5))) {
      const q = await navigator.locks.query();
      if ((q.held ?? []).some((l) => l.name === `waarm64-overlay:disks/${x.s}` && l.mode === 'shared') && (q.pending ?? []).some((l) => l.name === `waarm64-overlay:overlays/${x.x2}`)) break;
      if (performance.now() - t0 > 10_000) throw new Error('the job never waited for X2');
    }
    const disk = await inUse(`disks/${x.s}`);
    const overlay = await inUse(`overlays/${x.x2}`); // held here: in use
    const resized = await resize(store, { disk: x.s }, 20 * 2 ** 20).then(
      () => 'resized',
      (e: unknown) => String((e as { cause?: { msg?: { key?: string } } }).cause?.msg?.key ?? e),
    );
    store.close();
    (window as unknown as { __release: () => void }).__release();
    return { disk, overlay, resized };
  }, ids);
  assert.deepEqual(checks, { disk: false, overlay: true, resized: 'resized' });

  // Delete and resize an overlay right after the window asked for it, then merge X1 with the window on X3 (the merge
  // deletes X2 and X3; each deletion rereads the records, which asks the files again).
  await win(page).locator('[data-field=surface-overlay]').selectOption(ids.x3);
  await view(page, (x) => x.overlay === ids.x3 && x.size === 20 * MiB);
  const actions = await page.evaluate(async (x) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { mergeIntoDisk } = await import('/web/app/disks.ts' as string);
    const { resize } = await import('/web/app/resize.ts' as string);
    type E = { msg?: { key?: string }; cause?: { msg?: { key?: string } } };
    const why = (e: unknown) => String((e as E).cause?.msg?.key ?? (e as E).msg?.key ?? e);
    const refresh = () => document.querySelector<HTMLButtonElement>('[data-action=surface-refresh]')?.click();
    const store = await Store.open();
    const out: string[] = [];
    for (let k = 0; k < 3; k++) {
      refresh();
      await new Promise((r) => setTimeout(r, 30 * k));
      out.push(await resize(store, { overlay: x.x3 }, (24 + k) * 2 ** 20).then(() => 'resized', why));
    }
    refresh();
    out.push(await mergeIntoDisk(store, x.x1).then(() => 'merged', why));
    store.close();
    return out;
  }, ids);
  assert.deepEqual(actions, ['resized', 'resized', 'resized', 'merged']);
  // X3 went with the merge: said so; the disk alone shows X1's change in it.
  await win(page).locator('[data-field=surface-why]').waitFor();
  assert.equal((await win(page).locator('[data-field=surface-why]').textContent())!.trim(), t('disks:surface-source.overlayGone'));
  await win(page).locator('[data-field=surface-overlay]').selectOption('');
  const v = await view(page, (x) => x.overlay === undefined && x.layers.length === 1);
  assert.deepEqual(v.layers[0].held.slice(0, 4), [256, 0, 2, 0], "the disk with X1's change merged");
  // A Delete while the window asks for that overlay.
  const deleted = await page.evaluate(async (x) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { createOverlay, deleteOverlay } = await import('/web/app/disks.ts' as string);
    const store = await Store.open();
    const o = await createOverlay(store, await store.get('disks', x.s), 'X4');
    const select = document.querySelector<HTMLSelectElement>('[data-field=surface-overlay]')!;
    await new Promise((r) => setTimeout(r, 200)); // the picker has it
    select.value = o.id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    const r = await deleteOverlay(store, o.id).then(() => 'deleted', (e: unknown) => String((e as { msg?: { key?: string } }).msg?.key ?? e));
    store.close();
    return r;
  }, ids);
  assert.equal(deleted, 'deleted');
  assert.deepEqual(errors, []);
  await context.close();
});

test("the pointed square's words: spoken when the square changes, not when its numbers do; the keyboard's square goes on blur", { timeout: 120_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?view=terminal`);
  const ids = await setUpOverlays(page);
  await page.reload();
  await page.click('#machines-open');
  await modal(page).locator('nav [data-machine=disks]').click();
  await modal(page).locator(`section[data-selected=disks] [data-disk="${ids.s}"] [data-action=surface-open]`).click();
  await win(page).locator('[data-field=surface-overlay]').selectOption(ids.x2);
  await view(page, (x) => x.overlay === ids.x2 && x.layers.length === 2);
  const shown = () => win(page).locator('[data-field=surface-line]').textContent();
  const spoken = () => win(page).locator('[aria-live]').textContent();
  await pointAt(page, 1);
  await page.waitForFunction(() => document.querySelector('[data-field=surface-line]')?.textContent?.includes('4 MiB'));
  const [shown1, spoken1] = [await shown(), await spoken()];
  assert.equal(spoken1, shown1, 'a new square: its words spoken');
  // More changes in X2 at 4 MiB, read again (as a live poll's new numbers): shown, not spoken again.
  const before = (await view(page)).answers;
  await page.evaluate(async (dir) => {
    const worker = new Worker('/tests/browser/overlay-writer.ts', { type: 'module' });
    await new Promise<string>((resolve) => {
      worker.onmessage = (e) => resolve(String(e.data));
      worker.postMessage({ dir, size: 16 * 2 ** 20, writes: [{ at: 4 * 2 ** 20 + 65536, len: 4096 * 5, fill: 6 }], zeros: [] });
    });
    worker.terminate();
  }, `overlays/${ids.x2}`);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-action=surface-refresh]')!.click()); // the pointer stays
  await view(page, (x) => x.answers > before);
  await page.waitForFunction((was) => document.querySelector('[data-field=surface-line]')?.textContent !== was, shown1);
  assert.match((await shown())!, words('disks:surface-look.overlay.changed', { count: 7 }));
  assert.notEqual(await shown(), shown1, 'the numbers shown are the new ones');
  assert.equal(await spoken(), spoken1, 'and not spoken again');
  await pointAt(page, 2);
  await page.waitForFunction(() => document.querySelector('[data-field=surface-line]')?.textContent?.includes('8 MiB'));
  assert.equal(await spoken(), await shown(), 'another square: spoken');
  // The keyboard's cursor points too, until the map loses the focus.
  await page.mouse.move(5, 5);
  const grid = win(page).locator('.map [role=application]');
  await grid.focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('[data-field=surface-line]')?.textContent?.includes('4 MiB'));
  await win(page).locator('[data-field=surface-overlay]').focus();
  await page.waitForFunction(() => !document.querySelector('[data-field=surface-line]')?.textContent?.includes('4 MiB'));
  assert.equal(await shown(), t('disks:surface-look.hint'), 'the hint again, once the map lost the focus');
  assert.deepEqual(errors, []);
  await context.close();
});
