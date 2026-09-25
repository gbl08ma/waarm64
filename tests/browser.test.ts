// Chromium end-to-end smoke tests (CHROMIUM env var overrides the binary).
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
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); });

async function result(path: string, global: string) {
  const page = await browser.newPage();
  await page.goto(base + path);
  const h = await page.waitForFunction((g) => (window as never)[g], global, { timeout: 120_000 });
  const v = await h.jsonValue();
  await page.close();
  return v as Record<string, unknown>;
}

test('core wasm runs in a cross-origin isolated worker', async () => {
  assert.deepEqual(await result('/tests/browser/core.html', 'result'), { crossOriginIsolated: true, abi: 4, counter: 2 });
});

test('spike page runs', async () => {
  const r = await result('/bench/spike/index.html?quick&only=simd', 'benchResult');
  assert.equal(r.error, undefined);
  assert.equal(r.crossOriginIsolated, true);
  assert.ok((r.results as unknown[]).length > 0);
});
