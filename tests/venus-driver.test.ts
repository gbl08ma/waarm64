// The Vulkan driver on WebGPU (vk/README.md "The driver"): its own test program (vk/driver/wg_test.c), run in the
// renderer module on headless Chromium's WebGPU (SwiftShader in the dev VM), checks a scene's pixels, a compute pass's
// output, a fill of host-visible memory (all read back before the submit's fence signals) and a pipeline cache's data; and an
// image on memory imported from a dma-buf (web/venus-import.ts: VK2 L6). Skipped without the
// module, glslc or a WebGPU adapter.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';

const root = new URL('..', import.meta.url).pathname;
const skip = !existsSync(join(root, 'target/vk/venus.wasm')) ? 'SKIPPED: run vk/build.sh'
  : spawnSync('glslc', ['--version']).status !== 0 ? 'SKIPPED: no glslc' : false;

let browser: Browser;
let base: string;
let close: () => void;

before(async () => {
  if (skip) return;
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
    args: (process.env.CHROMIUM_ARGS ?? '--enable-unsafe-webgpu --enable-features=Vulkan').split(' ').filter(Boolean) });
});
after(async () => { await browser?.close(); close?.(); });

test('the driver draws a scene, runs a compute pass and fills host-visible memory, read back before its fence', { skip, timeout: 120_000 }, async (t) => {
  const out = join(root, 'target/vk/test');
  mkdirSync(out, { recursive: true });
  for (const s of ['vert', 'frag', 'comp']) {
    const r = spawnSync('glslc', ['--target-env=vulkan1.2', '-o', join(out, `driver.${s}.spv`), join(root, `tests/venus/driver.${s}`)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log(`page: ${m.text().slice(0, 2000)}`); });
  await page.goto(`${base}/tests/browser/venus-driver.html`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  const r = await page.evaluate(() => (window as unknown as { venus: { run(s: object): Promise<Record<string, unknown>> } }).venus.run({
    vert: '/target/vk/test/driver.vert.spv', frag: '/target/vk/test/driver.frag.spv', comp: '/target/vk/test/driver.comp.spv' }));
  await page.close();
  if (r.skipped) return t.skip(`SKIPPED: ${r.skipped}`);
  console.log(JSON.stringify({ stats: r.stats, ms: r.ms }));
  assert.equal(r.error, undefined, String(r.error));
  assert.deepEqual(r.errors, [], 'WebGPU errors');
  assert.deepEqual(r.pixels, { topLeft: [255, 0, 0, 255], bottomLeft: [0, 255, 0, 255], topRight: [255, 255, 0, 255], bottomRight: [0, 0, 255, 255] });
  const storage = r.storage as number[];
  assert.deepEqual([storage[0], storage[1], storage[100], storage[255]], [7, 10, 307, 772]);
  const filled = r.filled as number[];
  assert.deepEqual(filled.slice(3, 13).map((x) => x.toString(16)), ['0', ...Array(8).fill('deadbeef'), '0']);
});

test('an image bound to imported dma-buf memory has its resource\'s bytes, and a picture written into it after', { skip, timeout: 60_000 }, async (t) => {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log(`page: ${m.text().slice(0, 2000)}`); });
  await page.goto(`${base}/tests/browser/venus-driver.html`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  const r = await page.evaluate(() => (window as unknown as { venus: { runImport(): Promise<Record<string, unknown>> } }).venus.runImport());
  await page.close();
  if (r.skipped) return t.skip(`SKIPPED: ${r.skipped}`);
  const first = r.first as { bytes?: number[]; error?: string }, second = r.second as { bytes?: number[]; error?: string };
  assert.equal(first.error, undefined, String(first.error));
  assert.equal(second.error, undefined, String(second.error));
  assert.deepEqual(r.errors, [], 'WebGPU errors');
  assert.deepEqual(r.binds, [7]);
  // At the bind: the resource's bytes read back; after a picture: the picture's.
  assert.deepEqual(first.bytes, Array.from({ length: 16 }, (_, i) => 10 + i));
  assert.deepEqual(second.bytes, Array.from({ length: 16 }, (_, i) => 200 + i));
});
