// Chromium end-to-end smoke tests (CHROMIUM env var overrides the binary).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
  assert.deepEqual(await result('/tests/browser/core.html', 'result'), { crossOriginIsolated: true, abi: 7, counter: 2 });
});

test('spike page runs', async () => {
  const r = await result('/bench/spike/index.html?quick&only=simd', 'benchResult');
  assert.equal(r.error, undefined);
  assert.equal(r.crossOriginIsolated, true);
  assert.ok((r.results as unknown[]).length > 0);
});

const IMAGES = new URL('../target/images/linux/Image', import.meta.url);
for (const mode of ['deterministic', 'realtime']) {
  test(`Linux boots in a worker with virtio devices (root on virtio-blk over HTTP), ${mode} mode`, { skip: !existsSync(IMAGES) && 'SKIPPED: run images/build.sh' }, async () => {
    const page = await browser.newPage();
    await page.goto(base + '/tests/browser/boot.html' + (mode === 'realtime' ? '?realtime' : ''));
    const h = await page.waitForFunction(() => (window as never)['result'], null, { timeout: 30 * 60_000, polling: 1000 });
    const r = (await h.jsonValue()) as { error?: string; kind: number; x0: string; steps: number; ms: number; console: string; hvc: string };
    await page.close();
    assert.equal(r.error, undefined);
    console.log(`# chromium boot (${mode}): ${r.steps} steps in ${(r.ms / 1000).toFixed(1)} s (${(r.steps / r.ms / 1000).toFixed(1)} MIPS)`);
    assert.deepEqual([r.kind, r.x0], [1, '0x84000008'], r.console);
    const out = r.console.replaceAll('\r\n', '\n');
    assert.match(out, /answer: 42\n[^]*hwrng: [0-9a-f]{32}\n[^]*\/dev\/root \/ ext4 ro,[^]*vda magic: 53ef\nwebpc: test ok\nwebpc: test exit 0\n/);
    assert.equal(r.hvc.replaceAll('\r\n', '\n'), 'webpc: hvc0 ok\n');
  });
}
