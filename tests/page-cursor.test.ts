// The guest's cursor on the page (M8 graphics G1 loop 6): a cursor message from the display port becomes the canvas's CSS
// cursor (drawn at the canvas's scale, hotspot scaled with it), `none` when the guest hides it, the page's own pointer when
// it never set one. The message is injected into the page's display port: what the guest sends is the gpu guest's
// (tests/gpu.test.ts) and the presenter's (tests/gpu-present.test.ts) to check. Debian's page machine, stopped within a second
// (nothing boots, so it takes no Debian lock and needs only the images: scripts/ci.sh runs it). ~10 s.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { PAGE_QUERY } from './page-query.ts';

const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = (!existsSync(IMAGE) || !existsSync(FIRMWARE)) && 'SKIPPED: run images/build.sh debian edk2';

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

// The page with its machine stopped, and a way to send it the guest's cursor as the display port would: 'red' is a 64×64
// red square.
const RED = Array.from({ length: 64 * 64 * 4 }, (_, i) => (i % 4 === 0 || i % 4 === 3 ? 255 : 0));
async function openPage(context: BrowserContext, view = 'both') {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    const Real = window.MessageChannel;
    const all: MessageChannel[] = [];
    (window as unknown as { __channels: MessageChannel[] }).__channels = all;
    window.MessageChannel = class extends Real { constructor() { super(); all.push(this); } };
    const RealWorker = window.Worker;
    const workers: Worker[] = [];
    (window as unknown as { __workers: Worker[] }).__workers = workers;
    window.Worker = class extends RealWorker { constructor(...a: ConstructorParameters<typeof Worker>) { super(...a); workers.push(this); } };
  });
  await page.goto(`${base}/web/app/?autostart=1&${PAGE_QUERY}ncpus=2&view=${view}&${unattendedQuery()}`);
  await page.waitForFunction(() => (window as unknown as { __channels: MessageChannel[] }).__channels.some((c) => /dispatch\(display\b/.test(String(c.port1.onmessage))), null, { timeout: 30_000 });
  // The machine boots in the background and its own resets would send cursor messages too: stop it, the page keeps its state.
  await page.evaluate(() => (window as unknown as { __workers: Worker[] }).__workers.forEach((w) => w.terminate()));
  await page.waitForTimeout(500); // what the worker had sent
  const post = (data: unknown) => page.evaluate((data) => {
    if (data && typeof data === 'object' && 'image' in data && Array.isArray(data.image)) data.image = new Uint8Array(data.image).buffer;
    const ch = (window as unknown as { __channels: MessageChannel[] }).__channels.find((c) => /dispatch\(display\b/.test(String(c.port1.onmessage)))!;
    ch.port1.dispatchEvent(new MessageEvent('message', { data }));
    return null;
  }, data);
  const send = (image: 'red' | null | undefined, hotX = 0, hotY = 0) =>
    post({ type: 'cursor', image: image === 'red' ? RED : image, hotX, hotY });
  return { page, errors, send, post };
}

test("the guest's cursor is the canvas's CSS cursor, scaled with it, hidden when the guest hides it", { skip, timeout: 120_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const { page, errors, send } = await openPage(context);
  const cursor = (page2 = page) => page2.evaluate(() => document.querySelector<HTMLCanvasElement>('#screen')!.style.cursor);

  assert.equal(await cursor(), '', 'no guest cursor yet: the page\'s own pointer');
  await send('red', 3, 4);
  await page.waitForFunction(() => /^image-set\(url\("?blob:[^)]*"?\) 1x\) \d+ \d+(, image-set\(url\("?blob:[^)]*"?\) 1x\) \d+ \d+)?, none$/.test(document.querySelector<HTMLCanvasElement>('#screen')!.style.cursor), null, { timeout: 5000 });
  const { style, scale } = await page.evaluate(() => { const c = document.querySelector<HTMLCanvasElement>('#screen')!; return { style: c.style.cursor, scale: Number(c.dataset.scale) }; });
  const size = Math.min(128, Math.round(64 * scale));
  const [hx, hy] = [Math.round((3 * size) / 64), Math.round((4 * size) / 64)];
  assert.ok(style.includes(`) ${hx} ${hy}`), `the hotspot is scaled with the cursor: ${style}`);
  // The pointer nowhere near an edge: the cursor whole, alone (its cuts by the edges: the next test).
  assert.equal(style.split('image-set(').length - 1, 1, `one image: ${style}`);
  // The image is the guest's, at that size, with its alpha.
  const url = /url\("?(blob:[^")]+)/.exec(style)![1];
  const px = await page.evaluate(async (u) => {
    const bmp = await createImageBitmap(await (await fetch(u)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const x = c.getContext('2d')!;
    x.drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, p: [...x.getImageData(0, 0, 1, 1).data] };
  }, url);
  assert.deepEqual([px.w, px.h, ...px.p], [size, size, 255, 0, 0, 255]);

  await send(null);
  await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('#screen')!.style.cursor === 'none', null, { timeout: 5000 });
  await send(undefined);
  await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('#screen')!.style.cursor === '', null, { timeout: 5000 });
  assert.deepEqual(errors, []);
  await context.close();
});

// Chromium shows an image cursor only while it lies inside the page's view (web/app/areas/cursor-fit.ts; from Chromium
// 156 at any size, before it only over 32 CSS pixels): the page cuts the cursor by the edge. Checked two ways at each
// pixel up to the right edge: the canvas's list has an image Chromium 156's rule shows there (the property, whatever
// Chromium runs the test), and the cursor Chromium sends the browser is an image all the way (Chromium's own pick, seen
// as the size of WidgetHost.SetCursor's mojo message in a trace: an image's bitmap travels with it, a built-in cursor
// is a few dozen bytes). At 1x; the fractional densities are tests/cursor-fit.test.ts's.
test("the guest's cursor stays shown up to the page's right edge", { skip, timeout: 120_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const { page, errors, send, post } = await openPage(context, 'screen');
  // The guest's screen as wide as its box: the canvas ends at the page's right edge.
  const box = await page.evaluate(() => document.querySelector('#screen-view')!.getBoundingClientRect().toJSON() as DOMRect);
  await post({ type: 'mode', width: Math.floor(box.width), height: Math.floor(box.height) - 40 });
  await send('red', 3, 4);
  const r = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 200));
    return { canvas: document.querySelector('#screen')!.getBoundingClientRect().toJSON() as DOMRect, width: visualViewport!.width, dpr: devicePixelRatio };
  });
  assert.equal(r.dpr, 1);
  assert.ok(Math.abs(r.canvas.right - r.width) < 1, `the canvas reaches the page's right edge: ${JSON.stringify(r)}`);
  const y = Math.round(r.canvas.top + r.canvas.height / 2);
  await page.mouse.move(Math.round(r.canvas.left + r.canvas.width / 2), y);
  await page.waitForTimeout(200);

  const cdp = await context.newCDPSession(page);
  const { categories } = await cdp.send('Tracing.getCategories');
  const events: { name: string; args?: { chrome_mojo_event_info?: { mojo_interface_tag?: string; payload_size?: number } } }[] = [];
  cdp.on('Tracing.dataCollected', (e) => events.push(...(e.value as unknown as typeof events)));
  const traced = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: categories.filter((c) => /mojom/.test(c)) }, transferMode: 'ReportEvents' });
  const lost: string[] = [];
  for (let x = Math.ceil(r.width) - 80; x < r.width; x++) {
    await page.mouse.move(x, y);
    await page.waitForTimeout(40); // Chromium's pick after a style change (20 ms) and the cuts' images
    const shown = await page.evaluate(async ([x, y]) => {
      const list = [...document.querySelector<HTMLCanvasElement>('#screen')!.style.cursor.matchAll(/url\("?(blob:[^")]+)"?\) 1x\) (\d+) (\d+)/g)];
      for (const [, url, hx, hy] of list) {
        const bmp = await createImageBitmap(await (await fetch(url)).blob());
        const [left, top] = [x - Number(hx), y - Number(hy)];
        if (left >= 0 && top >= 0 && left + bmp.width <= visualViewport!.width && top + bmp.height <= visualViewport!.height) return true;
      }
      return list.length;
    }, [x, y] as const);
    if (shown !== true) lost.push(`${x} (${shown} images)`);
  }
  await cdp.send('Tracing.end');
  await traced;
  const picks = events
    .filter((e) => e.name === 'Receive mojo message' && e.args?.chrome_mojo_event_info?.mojo_interface_tag === 'blink.mojom.WidgetHost')
    .map((e) => e.args!.chrome_mojo_event_info!.payload_size ?? 0);
  assert.deepEqual(lost, [], 'pointer x where no image of the list lies inside the page');
  assert.ok(picks.length > 0, 'the cut cursors reach the browser (no WidgetHost message traced: has the trace changed?)');
  assert.deepEqual(picks.filter((n) => n < 300), [], `Chromium's picks, by message size (a built-in cursor is small): ${picks}`);
  assert.deepEqual(errors, []);
  await context.close();
});
