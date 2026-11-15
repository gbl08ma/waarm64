// The floating window's frame (web/app/ui/FloatingWindow.svelte, floating-frame.svelte.ts) where its height follows
// its width (`aspect`, the on-screen keyboard's), in Chromium on a test page (tests/browser/floating-window.html): the
// grip in the bar resizes the width alone, the height following, the left edge kept and the window pushed back in when
// it grows past the edge; the smallest width; a size per shape (`sizeKey`), remembered with the place; kept in a
// smaller browser window by its height too; where it opens (`at`); a tool window's focus (none, not even a field's) and
// context menu. The free window (corner grip) is tests/block-grid.test.ts's. ~5 s.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';

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

const WIN = '#aspect-window';
async function open(query = '') {
  const context = await browser.newContext({ viewport: { width: 900, height: 640 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await load(page, query);
  return { context, page, errors };
}
async function load(page: Page, query = '') {
  await page.goto(`${base}/tests/browser/floating-window.html?${query}`);
  await page.locator(WIN).waitFor();
}
const box = async (page: Page) => (await page.locator(WIN).boundingBox())!;
async function drag(page: Page, sel: string, dx: number, dy: number) {
  const b = (await page.locator(sel).boundingBox())!;
  const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up();
}
const near = (a: number, b: number) => Math.abs(a - b) < 1.5;
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('waarm64.settings') ?? '{}').windows?.['aspect-demo']);

test('a window whose height follows its width: the bar\'s grip, the smallest width, kept in, a size per shape, remembered', async () => {
  const { context, page, errors } = await open();
  let b = await box(page);
  assert.ok(near(b.width, 400) && near(b.height, 230) && near(b.x, 20) && near(b.y + b.height, 620), `opens where \`at\` says: ${JSON.stringify(b)}`);
  assert.equal(await page.locator(`${WIN} .grip.corner`).count(), 0, 'no corner grip');
  assert.equal(await page.locator(`${WIN} .bar .grip`).count(), 1, 'the grip is in the bar');

  // Sideways: the width, the height following, the left edge kept; up and down change nothing.
  await drag(page, `${WIN} .bar .grip`, 100, 0);
  b = await box(page);
  assert.ok(near(b.width, 500) && near(b.height, 280) && near(b.x, 20), `grown: ${JSON.stringify(b)}`);
  await drag(page, `${WIN} .bar .grip`, 0, -100);
  const same = await box(page);
  assert.ok(near(same.width, b.width) && near(same.height, b.height), `a vertical drag: ${JSON.stringify(same)}`);
  // Narrower than its smallest width: kept at it.
  await drag(page, `${WIN} .bar .grip`, -1000, 0);
  b = await box(page);
  assert.ok(near(b.width, 200) && near(b.height, 130), `the smallest: ${JSON.stringify(b)}`);
  // Grown past the window's edge: as wide as the window, pushed back in.
  await drag(page, `${WIN} .bar .grip`, 1200, 0);
  b = await box(page);
  assert.ok(near(b.width, 900) && near(b.height, 480) && near(b.x, 0) && b.y + b.height <= 640.5, `grown past the edge: ${JSON.stringify(b)}`);
  // A size per shape: the other shape its first size, the first one's kept for it.
  await drag(page, `${WIN} .bar .grip`, -500, 0);
  const wide = await box(page);
  await page.locator(`${WIN} [data-action=shape]`).click();
  b = await box(page);
  assert.equal(await page.locator(WIN).getAttribute('data-shape'), 'tall');
  assert.ok(near(b.width, 240) && near(b.height, 270), `the other shape: ${JSON.stringify(b)}`);
  await drag(page, `${WIN} .bar .grip`, 60, 0);
  const tall = await box(page);
  assert.ok(near(tall.width, 300) && near(tall.height, 330), `the other shape resized: ${JSON.stringify(tall)}`);
  await page.locator(`${WIN} [data-action=shape]`).click();
  b = await box(page);
  assert.ok(near(b.width, wide.width) && near(b.height, wide.height), `the first shape's size kept: ${JSON.stringify([wide, b])}`);
  const place = await saved(page);
  assert.ok(near(place.sizes.wide.w, wide.width) && near(place.sizes.tall.w, 300), `remembered per shape: ${JSON.stringify(place)}`);

  // Remembered across a reload (it opens in its first shape).
  await load(page);
  b = await box(page);
  assert.ok(near(b.x, wide.x) && near(b.y, wide.y) && near(b.width, wide.width), `remembered: ${JSON.stringify([wide, b])}`);

  // A smaller browser window: kept in by its height too (the widest whose height fits).
  await page.setViewportSize({ width: 900, height: 200 });
  await page.waitForFunction(() => { const r = document.querySelector('#aspect-window')!.getBoundingClientRect(); return r.bottom <= 200.5 && r.y >= 0; });
  b = await box(page);
  assert.ok(near(b.height, 200) && near(b.width, 340), `kept in by its height: ${JSON.stringify(b)}`);

  // The window's own element names its shape; its children were given its size.
  const given = await page.locator(`${WIN} .inside`).evaluate((e: HTMLElement) => [Number(e.dataset.w), Number(e.dataset.h)]);
  assert.ok(near(given[0], b.width) && near(given[1], b.height), `the size given: ${JSON.stringify(given)}`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('focus: a field in a window takes it when clicked, nothing in a tool window does; a tool window has no context menu', async () => {
  const focused = (page: Page) => page.evaluate(() => document.activeElement?.id);
  const plain = await open();
  await plain.page.locator('#outside').focus();
  await plain.page.locator(`${WIN} .bar .title`).click();
  assert.equal(await focused(plain.page), 'outside', 'the bar leaves it');
  await plain.page.locator('#inside').click();
  assert.equal(await focused(plain.page), 'inside', 'a form control takes it');
  await plain.context.close();

  const tool = await open('tool=1');
  const { page } = tool;
  await page.locator('#outside').focus();
  for (const sel of [`${WIN} .bar .title`, `${WIN} [data-action=shape]`, `${WIN} [data-action=close]`, '#inside']) {
    if (sel.endsWith('close]')) {
      // Pressed but not let go: the window stays.
      const b = (await page.locator(sel).boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      assert.equal(await focused(page), 'outside', sel);
      await page.mouse.move(0, 0);
      await page.mouse.up();
    } else {
      await page.locator(sel).click();
      assert.equal(await focused(page), 'outside', sel);
    }
  }
  const prevented = await page.locator(`${WIN} .bar`).evaluate((e) => !e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  assert.ok(prevented, 'no context menu');
  assert.deepEqual(tool.errors, []);
  await tool.context.close();
});
