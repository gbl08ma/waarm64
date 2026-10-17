// The guest's cursor on the page (M8 graphics G1 loop 6): a cursor message from the display port becomes the canvas's CSS
// cursor (drawn at the canvas's scale, hotspot scaled with it), `none` when the guest hides it, the page's own pointer when
// it never set one. The message is injected into the page's display port: what the guest sends is the gpu guest's
// (tests/gpu.test.ts) and the presenter's (tests/gpu-present.test.ts) to check. Debian's page machine, stopped within a second
// (nothing boots, so it takes no Debian lock and needs only the images: scripts/ci.sh runs it). ~10 s.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
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

test("the guest's cursor is the canvas's CSS cursor, scaled with it, hidden when the guest hides it", { skip, timeout: 120_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
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
  await page.goto(`${base}/web/app/?${PAGE_QUERY}ncpus=2&view=both&${unattendedQuery()}`);
  await page.waitForFunction(() => (window as unknown as { __channels: MessageChannel[] }).__channels.some((c) => String(c.port1.onmessage).includes("'cursor'")), null, { timeout: 30_000 });
  // The machine boots in the background and its own resets would send cursor messages too: stop it, the page keeps its state.
  await page.evaluate(() => (window as unknown as { __workers: Worker[] }).__workers.forEach((w) => w.terminate()));
  await page.waitForTimeout(500); // what the worker had sent
  const send = (image: 'red' | null | undefined, hotX = 0, hotY = 0) => page.evaluate(([image, hotX, hotY]) => {
    const ch = (window as unknown as { __channels: MessageChannel[] }).__channels.find((c) => String(c.port1.onmessage).includes("'cursor'"))!;
    let data: ArrayBuffer | null | undefined = image === 'red' ? new Uint8Array(64 * 64 * 4).fill(0).map((_, i) => (i % 4 === 0 || i % 4 === 3 ? 255 : 0)).buffer : image as null | undefined;
    ch.port1.dispatchEvent(new MessageEvent('message', { data: { type: 'cursor', image: data, hotX, hotY } }));
    return null;
  }, [image, hotX, hotY] as const);
  const cursor = (page2 = page) => page2.evaluate(() => document.querySelector<HTMLCanvasElement>('#screen')!.style.cursor);

  assert.equal(await cursor(), '', 'no guest cursor yet: the page\'s own pointer');
  await send('red', 3, 4);
  await page.waitForFunction(() => /^image-set\(url\("?blob:[^)]*"?\) 1x\) \d+ \d+(, image-set\(url\("?blob:[^)]*"?\) 1x\) \d+ \d+)?, none$/.test(document.querySelector<HTMLCanvasElement>('#screen')!.style.cursor), null, { timeout: 5000 });
  const { style, scale } = await page.evaluate(() => { const c = document.querySelector<HTMLCanvasElement>('#screen')!; return { style: c.style.cursor, scale: Number(c.dataset.scale) }; });
  const size = Math.min(128, Math.round(64 * scale));
  const [hx, hy] = [Math.round((3 * size) / 64), Math.round((4 * size) / 64)];
  assert.ok(style.includes(`) ${hx} ${hy}`), `the hotspot is scaled with the cursor: ${style}`);
  // A cursor over 32 CSS pixels has a 32-pixel one after it: Chromium falls back to it where the big one would reach past the page's edge.
  const dpr = await page.evaluate(() => devicePixelRatio);
  assert.equal(style.split('image-set(').length - 1, size > Math.floor(32 * dpr) ? 2 : 1, `the fallback cursor: ${style}`);
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
