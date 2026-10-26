// Vulkan's frames into virgl's textures (web/venus-share.ts; vk/README.md "Presentation"): in Chromium, a WebGPU
// texture imported by a virgl context reaches the virgl renderer byte for byte, both ways (the bitmap way where the
// page doesn't render in software: not SwiftShader's, so the dev VM runs the readback way only). Skipped without a
// WebGPU adapter.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
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
  const r = await page.evaluate(() => (window as unknown as { share: { run(m: string[]): Promise<Record<string, unknown>> } }).share.run(['readback', 'bitmap']));
  await page.close();
  if (r.skipped) return t.skip(`SKIPPED: ${r.skipped}`);
  console.log(JSON.stringify(r));
  assert.deepEqual(r.errors, [], 'WebGPU errors');
  for (const mode of ['readback', 'bitmap']) {
    const m = r[mode] as Record<string, string> | string;
    if (typeof m === 'string') { assert.equal(mode, 'bitmap', m); continue; }
    for (const k of ['first', 'x', 'rgba', 'float', 'unwritten', 'written']) assert.equal(m[k], 'same', `${mode}: ${k}: ${m[k]}`);
    assert.equal(m.log, 'none', `${mode}: the renderer's errors`);
  }
});
