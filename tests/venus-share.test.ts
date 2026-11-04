// Vulkan's frames into virgl's textures (web/venus-share.ts; vk/README.md "Presentation"): in Chromium, a WebGPU
// texture imported by a virgl context reaches the virgl renderer byte for byte, every way (the bitmap and canvas ways
// where the page doesn't render in software: not SwiftShader's, so the dev VM runs the readback way only), and a GPU
// way's first copies are checked: one that copies wrong is dropped for the next, down to the readback way, before the
// frame shows (on SwiftShader too: the broken ways make no WebGPU canvas); a prime blit's buffer (X11's WSI) the same.
// Skipped without a WebGPU adapter. And the
// check's verdicts themselves, in Node.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { compareTexels } from '../web/venus-share.ts';
import { startServer } from '../tools/serve.ts';

let browser: Browser;
let base: string;
let close: () => void;

before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--enable-unsafe-webgpu'] });
});
after(async () => { await browser?.close(); close?.(); });

test('a Venus image reaches the virgl renderer\'s texture byte for byte, once each time it is written', { timeout: 60_000 }, async (t) => {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log(`page: ${m.text().slice(0, 500)}`); });
  await page.goto(`${base}/tests/browser/venus-share.html`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  const r = await page.evaluate(() => (window as unknown as { share: { run(m: string[]): Promise<Record<string, unknown>> } }).share.run(['readback', 'bitmap', 'canvas']));
  await page.close();
  if (r.skipped) return t.skip(`SKIPPED: ${r.skipped}`);
  console.log(JSON.stringify(r));
  assert.deepEqual(r.errors, [], 'WebGPU errors');
  for (const mode of ['readback', 'bitmap', 'canvas']) {
    const m = r[mode] as Record<string, string> | string;
    if (typeof m === 'string') { assert.notEqual(mode, 'readback', m); continue; }
    for (const k of ['first', 'x', 'rgba', 'float', 'unwritten', 'written', 'blit', 'blitRows', 'blitUnwritten', 'blitWritten']) assert.equal(m[k], 'same', `${mode}: ${k}: ${m[k]}`);
    assert.equal(m.log, 'none', `${mode}: the renderer's errors`);
    assert.equal(m.check, 'kept', `${mode}: the check`);
  }
});

test('a GPU way that copies wrong is dropped for the next, down to the readback way, before the frame shows', { timeout: 60_000 }, async (t) => {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log(`page: ${m.text().slice(0, 500)}`); });
  await page.goto(`${base}/tests/browser/venus-share.html`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  const r = await page.evaluate(() => (window as unknown as { share: { fallback(): Promise<Record<string, Record<string, unknown>>> } }).share.fallback());
  await page.close();
  if (r.skipped) return t.skip(`SKIPPED: ${r.skipped}`);
  console.log(JSON.stringify(r));
  assert.deepEqual(r.errors, [], 'WebGPU errors');
  // A dark frame decides nothing: the (broken) bitmap way kept, the frame shown dark as it is (its colour).
  assert.deepEqual(r.dark, { way: 'bitmap', unclear: 1, wrong: 0, shown: 'same' });
  // The first lit frame: both GPU ways wrong, the readback way's copy shown before the submit ran.
  assert.deepEqual(r.lit, { way: 'readback', state: 'reference', dropped: ['bitmap', 'canvas'], wrong: 2, shown: 'same' });
  assert.deepEqual(r.next, { way: 'readback', readbacks: 2, shown: 'same' });
  assert.equal(r.log, 'none', "the renderer's errors");
  // Forced: checked, said to be wrong, kept.
  assert.deepEqual(r.forced, { way: 'bitmap', wrong: 1, dropped: 0 });
});

test("the check's verdicts: right, wrong, a dark image unclear, an X format's alpha and a translucent texel's colour ignored", () => {
  const px = (...t: number[][]) => new Float32Array(t.flat().map((v) => v / 255));
  assert.equal(compareTexels(px([200, 10, 30, 255], [0, 0, 0, 255]), px([201, 10, 30, 255], [0, 0, 0, 255]), false).verdict, 'right');
  assert.equal(compareTexels(px([200, 10, 30, 255]), px([0, 0, 0, 255]), false).verdict, 'wrong');
  assert.equal(compareTexels(px([200, 10, 30, 255]), px([0, 0, 0, 0]), false).verdict, 'wrong');
  assert.equal(compareTexels(px([2, 3, 4, 255], [0, 0, 0, 255]), px([0, 0, 0, 255], [0, 0, 0, 255]), false).verdict, 'unclear');
  assert.equal(compareTexels(px([200, 10, 30, 0]), px([200, 10, 30, 255]), true).verdict, 'right');
  assert.equal(compareTexels(px([200, 10, 30, 255], [90, 90, 90, 128]), px([200, 10, 30, 255], [45, 45, 45, 128]), false).verdict, 'right');
  assert.equal(compareTexels(px([200, 10, 30, 255], [90, 90, 90, 128]), px([200, 10, 30, 255], [90, 90, 90, 255]), false).verdict, 'wrong');
});
