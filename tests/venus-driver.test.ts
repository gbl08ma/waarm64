// The Vulkan driver on WebGPU (vk/README.md "The driver"): its own test program (vk/driver/wg_test.c), run in the
// renderer module on headless Chromium's WebGPU (SwiftShader in the dev VM), checks a scene's pixels, a compute pass's
// output, a fill of host-visible memory (all read back before the submit's fence signals) and a pipeline cache's data; and an
// image on memory imported from a dma-buf (web/venus-import.ts: VK2 L6); and a submit's fence coming back without the
// browser's slow look at its GPU (web/venus-host.ts's pump and its nudges: VK3 L2). Skipped without the
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
  for (const [src, name] of [['tests/venus/driver.vert', 'driver.vert'], ['tests/venus/driver.frag', 'driver.frag'], ['tests/venus/driver.comp', 'driver.comp'], ['bench/vulkan/costs/costs.frag', 'costs.frag']]) {
    const r = spawnSync('glslc', ['--target-env=vulkan1.2', '-o', join(out, `${name}.spv`), join(root, src)], { encoding: 'utf8' });
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
  // Its pipelines were made asynchronously (VK3 L3): none had to be made at once by a submit.
  const stats = r.stats as Record<string, number>;
  assert.equal(stats.syncPipelines, 0, 'pipelines made at once');
  assert.ok(stats.pipelinesReady >= 2, `pipelines ready: ${stats.pipelinesReady}`);
});

test('a second run translates nothing the first did: its shaders come from the store, and it draws the same', { skip, timeout: 120_000 }, async (t) => {
  // After the first test, which compiled the SPIR-V.
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log(`page: ${m.text().slice(0, 2000)}`); });
  await page.goto(`${base}/tests/browser/venus-driver.html`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  const r = await page.evaluate(() => (window as unknown as { venus: { runTwice(s: object): Promise<Record<string, unknown>> } }).venus.runTwice({
    vert: '/target/vk/test/driver.vert.spv', frag: '/target/vk/test/driver.frag.spv', comp: '/target/vk/test/driver.comp.spv' }));
  await page.close();
  const first = r.first as Record<string, unknown>, second = r.second as Record<string, unknown>;
  if (first.skipped) return t.skip(`SKIPPED: ${first.skipped}`);
  assert.equal(first.error, undefined, String(first.error));
  assert.equal(second.error, undefined, String(second.error));
  const a = first.stats as Record<string, number>, b = second.stats as Record<string, number>;
  console.log(JSON.stringify({ first: a, second: b, stored: r.stored }));
  // The first stores what it translated (stages' NIR and shaders); the second finds all of it (no lookup misses) and
  // adds no entry (it puts again only the pipeline cache's data the program loads, under the same keys).
  assert.ok((r.storedFirst as number) > 0, 'the first run stored nothing');
  assert.ok(a.cacheMisses > 0);
  assert.equal(b.cacheMisses, 0, 'the second run missed');
  assert.equal(r.stored, r.storedFirst, 'the second run stored something new');
  assert.ok(b.cacheHits > 0, 'the second run found nothing');
  assert.deepEqual(second.pixels, first.pixels);
  assert.deepEqual(second.storage, first.storage);
  assert.deepEqual(second.errors, []);
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

test('a submit\'s fence comes back without waiting for the browser\'s slow look at the GPU (the pump nudges it)', { skip, timeout: 120_000 }, async (t) => {
  // After the first test, which compiled the shaders.
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log(`page: ${m.text().slice(0, 2000)}`); });
  await page.goto(`${base}/tests/browser/venus-driver.html`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  type R = { median: number; nudges: number; empty: number; adapter: string; skipped?: string; error?: string };
  const run = (poll: string) => page.evaluate((poll) => (window as unknown as { venus: { runFences(s: object, poll: string, n: number): Promise<R> } }).venus.runFences({
    vert: '/target/vk/test/driver.vert.spv', frag: '/target/vk/test/driver.frag.spv', comp: '/target/vk/test/driver.comp.spv', costs: '/target/vk/test/costs.frag.spv' }, poll, 20), poll);
  const old = await run('timeout'), pump = await run('pump');
  await page.close();
  if (old.skipped) return t.skip(`SKIPPED: ${old.skipped}`);
  for (const r of [old, pump]) assert.equal(r.error, undefined, String(r.error));
  // The times are logged, not asserted (they follow the machine's load: under CI's both were 5-6 ms); on a quiet
  // SwiftShader the old way's fence is ~3 ms and the pump's ~1 ms (bench/vulkan/costs.ts, REPORT.md "VK3 L2").
  console.log(JSON.stringify({ adapter: old.adapter, timeout: old.median, pump: pump.median, nudges: pump.nudges, empty: pump.empty }));
  assert.equal(old.empty, 0, 'the old poller sends no empty submits');
  // While a submit is in flight, at most one a ms (a fence back within a turn, as on Metal, may need none).
  assert.ok(pump.empty > 0, 'the pump sent no empty submit');
  assert.equal(pump.empty, pump.nudges, 'every nudge reached the queue');
});
