// The block map and the floating window (web/app/ui/BlockGrid.svelte, FloatingWindow.svelte; docs/plans/surface.md
// §3) in Chromium with made-up data, no guest (tests/browser/block-grid.html): the looks drawn where they should be in
// the tokens' colours, flashes fading and then no frame drawn, the room counted and changed by the grip, hover and
// pick on the right cell (the last row's too), the keyboard's cursor; the window moved, kept in the browser's window,
// remembered across a reload, and the focus left where it was. ~15 s.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { insetOf, lineOf } from '../web/app/ui/block-draw.ts';
import { cellAt, CORE, gridLayout, RIM, stepCursor } from '../web/app/ui/block-grid.ts';
import { t } from '../web/i18n.ts';

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

const GRID = '#grid-window [role=application]';

/** The demo page in a new context (`query`: its knobs), with requestAnimationFrame's calls counted. */
async function open(query = '', options: BrowserContextOptions = {}) {
  const context = await browser.newContext({ viewport: { width: 900, height: 640 }, ...options });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    const w = window as unknown as { __frames: number };
    w.__frames = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (f) => { w.__frames++; return raf(f); };
  });
  await load(page, query);
  return { context, page, errors };
}
async function load(page: Page, query = '') {
  await page.goto(`${base}/tests/browser/block-grid.html?${query}`);
  await page.locator(GRID).waitFor();
  await page.waitForFunction(() => window.__grid.rooms.some((n) => n > 0));
}

/** The grid's layout in CSS pixels (its data attributes) and its box. */
async function shape(page: Page) {
  return page.locator(GRID).evaluate((g: HTMLElement) => {
    const d = g.dataset;
    const r = g.getBoundingClientRect();
    return { cells: Number(d.cells), cols: Number(d.cols), pitch: Number(d.pitch), size: Number(d.size), pad: Number(d.pad), x: r.x, y: r.y, w: r.width, h: r.height };
  });
}
/** Cell `i`'s centre in the page (CSS pixels). */
async function centre(page: Page, i: number) {
  const s = await shape(page);
  return { x: s.x + s.pad + (i % s.cols) * s.pitch + s.size / 2, y: s.y + s.pad + Math.floor(i / s.cols) * s.pitch + s.size / 2 };
}

/** Every cell's samples (its rim near a corner, its centre, its core's edge, its outline) and the tokens' colours, as RGBA. */
async function samples(page: Page) {
  const s = await shape(page);
  const dpr = await page.evaluate(() => devicePixelRatio);
  const size = Math.round(s.size * dpr);
  const at = { line: lineOf(size) - 1, inset: insetOf(size), mid: Math.floor(size / 2) };
  return page.locator(GRID).evaluate((g: HTMLElement, { s, dpr, at }) => {
    const canvas = g.querySelector('canvas')!;
    const img = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    const px = (x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
    const [pitch, pad] = [Math.round(s.pitch * dpr), Math.round(s.pad * dpr)];
    const cells = [];
    for (let i = 0; i < s.cells; i++) {
      const [x, y] = [pad + (i % s.cols) * pitch, pad + Math.floor(i / s.cols) * pitch];
      cells.push({ corner: px(x + 2, y + 2), centre: px(x + at.mid, y + at.mid), coreEdge: px(x + at.inset, y + at.mid), outline: px(x + at.line, y + at.mid) });
    }
    const one = new OffscreenCanvas(1, 1).getContext('2d')!;
    const style = getComputedStyle(g);
    const colour = (name: string) => {
      one.clearRect(0, 0, 1, 1);
      one.fillStyle = style.getPropertyValue(`--${name}`).trim();
      one.fillRect(0, 0, 1, 1);
      return Array.from(one.getImageData(0, 0, 1, 1).data);
    };
    const names = ['map-empty', 'map-absent', 'map-opaque', 'map-hollow', 'map-end', 'map-pin', 'map-read', 'map-write', 'map-rim-1', 'map-rim-2', 'map-rim-3', 'map-rim-4', 'map-core-1', 'map-core-2', 'map-core-3', 'map-core-4'];
    return { cells, dpr, pitch, size: Math.round(s.size * dpr), pad, cols: s.cols, tokens: Object.fromEntries(names.map((n) => [n, colour(n)])) };
  }, { s, dpr, at });
}
/** The canvas's pixel at cell `i`'s top middle (CSS pixels from the cell's corner: `dx`, `dy`), RGBA. */
const pixel = (page: Page, i: number, dx?: number, dy = 2) => page.locator(GRID).evaluate((g: HTMLElement, { i, dx, dy }) => {
  const d = g.dataset;
  const dpr = devicePixelRatio;
  const [cols, pitch, size, pad] = [Number(d.cols), Number(d.pitch), Number(d.size), Number(d.pad)];
  const [x, y] = [pad + (i % cols) * pitch + (dx ?? size / 2), pad + Math.floor(i / cols) * pitch + dy];
  return Array.from(g.querySelector('canvas')!.getContext('2d')!.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data);
}, { i, dx, dy });
const near = (a: number[], b: number[], tol = 2) => a.length === b.length && a.every((v, k) => Math.abs(v - b[k]) <= tol);

test('the layout: the room at the smallest cells, cells as large as fit, smaller only past the room', () => {
  const room = Math.floor(1001 / 11) * Math.floor(501 / 11);
  assert.equal(gridLayout(1000, 500, 1, 0).room, room);
  const few = gridLayout(1000, 500, 1, 100);
  assert.ok(few.size >= 14 && few.size <= 19 && few.cols * few.pitch - 1 <= 1000, `few cells, large: ${JSON.stringify(few)}`);
  const full = gridLayout(1000, 500, 1, room);
  assert.ok(full.size >= 10 && full.rows * full.pitch - 1 <= 500, `as many as the room: ${JSON.stringify(full)}`);
  const over = gridLayout(1000, 500, 1, room * 3);
  assert.ok(over.size < 10 && over.rows * over.pitch - 1 <= 500, `more than the room, smaller: ${JSON.stringify(over)}`);
  const hi = gridLayout(2000, 1000, 2, 0);
  assert.equal(hi.room, room, 'device pixels: the same room at twice the scale');
  const l = { cols: 10, rows: 3, size: 10, pitch: 11, room: 30 };
  assert.equal(cellAt(l, 25, 10.5, 0), 0, 'a gap goes with the cell before it');
  assert.equal(cellAt(l, 25, 11 * 4 + 1, 22 + 1), 24);
  assert.equal(cellAt(l, 25, 11 * 5 + 1, 22 + 1), undefined, 'past the last cell in its row');
  assert.equal(cellAt(l, 25, 11 * 10 + 1, 0), undefined, 'past the columns');
  assert.equal(stepCursor('ArrowDown', 18, 10, 25), 24, 'down past the last row: the last cell');
  assert.equal(stepCursor('ArrowUp', 3, 10, 25), 0);
  assert.equal(stepCursor('End', 3, 10, 25), 24);
  assert.equal(stepCursor('a', 3, 10, 25), undefined);
});

test('the looks: rims, cores and the outline in the tokens\' colours, the end of the disk marked', async () => {
  const { context, page, errors } = await open('cells=300&flash=0', { deviceScaleFactor: 2 });
  const { rim, core, mark } = await page.evaluate(() => ({ rim: Array.from(window.__grid.rim), core: Array.from(window.__grid.core), mark: window.__grid.mark }));
  const s = await samples(page);
  assert.equal(s.dpr, 2);
  assert.ok(s.size >= 20, `cells at least 10 CSS pixels: ${s.size}`);
  const tok = s.tokens;
  const RIM_TOKEN: Record<number, string> = { [RIM.empty]: 'map-empty', [RIM.opaque]: 'map-opaque', [RIM.step(1)]: 'map-rim-1', [RIM.step(2)]: 'map-rim-2', [RIM.step(3)]: 'map-rim-3', [RIM.step(4)]: 'map-rim-4' };
  const CORE_TOKEN: Record<number, string> = { [CORE.step(1)]: 'map-core-1', [CORE.step(2)]: 'map-core-2', [CORE.step(3)]: 'map-core-3', [CORE.step(4)]: 'map-core-4' };
  const bad: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < s.cells.length; i++) {
    const c = s.cells[i];
    const want = (what: string, got: number[], token: string) => {
      seen.add(token);
      if (!near(got, tok[token])) bad.push(`${i} ${what}: ${got} not ${token} ${tok[token]}`);
    };
    if (rim[i] === RIM.absent) {
      want('outline', c.outline, 'map-absent');
      if (core[i] === CORE.none && c.centre[3] !== 0) bad.push(`${i}: an outline's inside drawn`);
    } else want('rim', c.corner, RIM_TOKEN[rim[i]]);
    if (core[i] === CORE.hollow) {
      want('hollow core', c.coreEdge, 'map-hollow');
      want('hollow inside', c.centre, 'map-empty');
    } else if (core[i] !== CORE.none) want('core', c.centre, CORE_TOKEN[core[i]]);
    else if (rim[i] !== RIM.absent && rim[i] !== RIM.opaque) want('no core', c.centre, RIM_TOKEN[rim[i]]);
  }
  assert.deepEqual(bad.slice(0, 10), []);
  for (const k of [...Object.values(RIM_TOKEN), ...Object.values(CORE_TOKEN), 'map-absent', 'map-hollow']) assert.ok(seen.has(k), `the made-up surface shows ${k}`);
  // The disk's end: a line in the gap after cell `mark`, down its right side.
  const endAt = await page.locator(GRID).evaluate((g: HTMLElement, [mark, s]) => {
    const canvas = g.querySelector('canvas')!;
    const [x, y] = [s.pad + ((mark % s.cols) + 1) * s.pitch - 1, s.pad + Math.floor(mark / s.cols) * s.pitch + s.size / 2];
    return Array.from(canvas.getContext('2d')!.getImageData(x, y, 1, 1).data);
  }, [mark, { pad: s.pad, cols: s.cols, pitch: s.pitch, size: s.size }] as const);
  assert.ok(near(endAt, tok['map-end']), `the end's line: ${endAt}`);
  // The tokens tell the layers and the flashes apart by lightness too, not hue alone.
  const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  assert.ok(Math.abs(lum(tok['map-read']) - lum(tok['map-write'])) > 40, 'read and write flashes differ in lightness');
  assert.ok(lum(tok['map-rim-1']) < lum(tok['map-rim-4']) && lum(tok['map-core-1']) < lum(tok['map-core-4']), 'steps go light as full');
  assert.deepEqual(errors, []);
  await context.close();
});

test('flashes fade, then no frame is drawn; with reduced motion a flash stays until the next', async () => {
  const { context, page, errors } = await open('cells=200&flash=0');
  const before = await pixel(page, 20);
  await page.evaluate(() => window.__grid.flash([], [20]));
  const lit = await pixel(page, 20);
  assert.ok(!near(lit, before, 8), `written: ${lit} over ${before}`);
  await page.waitForTimeout(800);
  assert.ok(near(await pixel(page, 20), before), 'faded');
  const frames = await page.evaluate(() => (window as unknown as { __frames: number }).__frames);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => (window as unknown as { __frames: number }).__frames), frames, 'no frames once nothing fades');
  await context.close();

  const reduced = await open('cells=200&flash=0', { reducedMotion: 'reduce' });
  const p2 = reduced.page;
  const base2 = await pixel(p2, 20);
  await p2.evaluate(() => window.__grid.flash([], [20]));
  await p2.waitForTimeout(800);
  assert.ok(!near(await pixel(p2, 20), base2, 8), 'a still mark with reduced motion');
  await p2.evaluate(() => window.__grid.flash([], []));
  assert.ok(near(await pixel(p2, 20), base2), 'cleared by the next flash array');
  assert.deepEqual([...errors, ...reduced.errors], []);
  await reduced.context.close();
});

test('hover and pick find the cell, the last row\'s too; the keyboard moves and picks; the screen keeps the focus', async () => {
  const { context, page, errors } = await open('cells=250&flash=0');
  const s = await shape(page);
  assert.ok(250 % s.cols !== 0, `the last row is partial: ${s.cols} columns`);
  await page.locator('#screen').focus();
  const hovers = () => page.evaluate(() => window.__grid.hovers.at(-1));
  const picks = () => page.evaluate(() => window.__grid.picks.at(-1));
  for (const i of [0, s.cols + 3, 249]) {
    const c = await centre(page, i);
    await page.mouse.move(c.x, c.y);
    assert.equal(await hovers(), i);
    await page.mouse.click(c.x, c.y);
    assert.equal(await picks(), i);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'screen', 'a click on the grid leaves the focus');
  }
  // Past the last cell, in its row: no cell.
  const last = await centre(page, 249);
  await page.mouse.move(last.x + s.pitch, last.y);
  assert.equal(await hovers(), undefined);
  // The pinned cell is ringed.
  const ring = await pixel(page, 249, -0.5, 4);
  const pin = await page.evaluate(() => { const c = new OffscreenCanvas(1, 1).getContext('2d')!; c.fillStyle = getComputedStyle(document.body).getPropertyValue('--map-pin'); c.fillRect(0, 0, 1, 1); return Array.from(c.getImageData(0, 0, 1, 1).data); });
  assert.ok(near(ring, pin), `the pinned cell's ring: ${ring}`);

  // The title bar and the close button's surroundings leave the focus too; a select in it takes it, as it must.
  const bar = (await page.locator('#grid-window .bar').boundingBox())!;
  await page.mouse.click(bar.x + 30, bar.y + bar.height / 2);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'screen');
  await page.locator('#grid-window [data-field=layer]').click();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SELECT');
  await page.keyboard.press('Escape');

  // The keyboard: Tab-reached, the arrows move the cursor (reported as hovered), Enter and Space pick, End and Home.
  await page.locator(GRID).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  // From the last pick (the last cell), right and down stay on it; the cursor is reported as hovered.
  assert.equal(await page.locator(GRID).evaluate((g: HTMLElement) => Number(g.dataset.cursor)), 249);
  assert.equal(await hovers(), 249);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await picks(), 1 + s.cols);
  await page.keyboard.press('End');
  await page.keyboard.press(' ');
  assert.equal(await picks(), 249);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the window: moved, resized by its grip (the room with it), kept in the browser\'s window, remembered, closed', async () => {
  const { context, page, errors } = await open('flash=0');
  const win = page.locator('#grid-window');
  const box = async () => (await win.boundingBox())!;
  const room = () => page.evaluate(() => window.__grid.rooms.at(-1)!);
  const before = await box();
  const room0 = await room();
  const s0 = await shape(page);
  const atMin = (w: number, h: number) => Math.floor((w - 2 * s0.pad + 1) / 11) * Math.floor((h - 2 * s0.pad + 1) / 11);
  assert.equal(room0, atMin(s0.w, s0.h), 'the room: cells of 10 px and a gap of 1 in its box');
  assert.equal(s0.cells, room0, 'the demo shows as many cells as there is room for');

  // Moved by its title bar.
  const drag = async (from: { x: number; y: number }, dx: number, dy: number) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 5 });
    await page.mouse.up();
  };
  const bar = (await page.locator('#grid-window .bar').boundingBox())!;
  await drag({ x: bar.x + 40, y: bar.y + bar.height / 2 }, -100, -60);
  const moved = await box();
  assert.ok(Math.abs(moved.x - (before.x - 100)) < 2 && Math.abs(moved.y - (before.y - 60)) < 2, `moved: ${JSON.stringify([before, moved])}`);
  assert.equal(await room(), room0, 'moving changes no room');

  // Resized by its grip, both ways: more room.
  const grip = (await page.locator('#grid-window .grip').boundingBox())!;
  await drag({ x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 }, 120, 80);
  const grown = await box();
  assert.ok(Math.abs(grown.width - (before.width + 120)) < 2 && Math.abs(grown.height - (before.height + 80)) < 2, `resized: ${JSON.stringify([moved, grown])}`);
  await page.waitForFunction((r) => window.__grid.rooms.at(-1)! > r, room0);
  const s1 = await shape(page);
  assert.equal(await room(), atMin(s1.w, s1.h));

  // Dragged far past the edge: kept in the window.
  const bar2 = (await page.locator('#grid-window .bar').boundingBox())!;
  await drag({ x: bar2.x + 40, y: bar2.y + 10 }, 2000, 2000);
  const kept = await box();
  assert.ok(kept.x + kept.width <= 900 + 0.5 && kept.y + kept.height <= 640 + 0.5 && kept.x >= 0 && kept.y >= 0, `in the window: ${JSON.stringify(kept)}`);

  // Remembered across a reload.
  await load(page, 'flash=0');
  const again = await box();
  assert.ok(Math.abs(again.x - kept.x) < 1 && Math.abs(again.y - kept.y) < 1 && Math.abs(again.width - kept.width) < 1 && Math.abs(again.height - kept.height) < 1, `remembered: ${JSON.stringify([kept, again])}`);

  // The browser's window shrinks: it stays in it, its room shrinks.
  await page.setViewportSize({ width: 500, height: 360 });
  await page.waitForFunction(() => { const r = document.getElementById('grid-window')!.getBoundingClientRect(); return r.right <= 500.5 && r.bottom <= 360.5 && r.x >= 0 && r.y >= 0; });
  await page.waitForFunction((r) => window.__grid.rooms.at(-1)! < r, room0);

  // Close.
  await page.locator(`#grid-window [aria-label="${t('common:FloatingWindow.close')}"]`).click();
  await win.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await context.close();
});
