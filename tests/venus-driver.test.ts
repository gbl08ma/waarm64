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
  mkdirSync(join(out, 't44'), { recursive: true });
  mkdirSync(join(out, 't46'), { recursive: true });
  for (const [src, name] of [['tests/venus/driver.vert', 'driver.vert'], ['tests/venus/driver.frag', 'driver.frag'], ['tests/venus/driver.comp', 'driver.comp'], ['bench/vulkan/costs/costs.frag', 'costs.frag'], ['tests/venus/flat.vert', 'flat.vert'], ['tests/venus/flat.frag', 'flat.frag'], ['tests/venus/xfb.vert', 'xfb.vert'], ['tests/venus/xfb-many.vert', 'xfb-many.vert'], ['tests/venus/draw-params.vert', 'draw-params.vert'], ['tests/venus/vertex-pull.vert', 'vertex-pull.vert'], ['tests/venus/vertex-pull-fixed.vert', 'vertex-pull-fixed.vert'], ['tests/venus/vertex-pull.frag', 'vertex-pull.frag'], ['tests/venus/vertex-pull0.frag', 'vertex-pull0.frag'], ['tests/venus/l7b/angle-ubo.vert', 'angle-ubo.vert'], ['tests/venus/l7b/angle-ubo.frag', 'angle-ubo.frag'], ['tests/venus/t40/xfb-four.vert', 'xfb-four.vert'], ['tests/venus/t44/four-sets.frag', 't44/four-sets.frag'], ['tests/venus/t46/angle-pull.vert', 't46/angle-pull.vert']]) {
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
  // With `premake` (VK4 T17, off on the page) its render pipeline was made at vkCreateGraphicsPipelines, and the draw
  // set that one: no other made.
  assert.deepEqual([stats.premade, stats.premadeUsed, stats.pipelines], [1, 1, 2], 'premade, used, pipelines');
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
  // The image took resource 7's own texture (VK4 T16): made once, its bytes written once at the bind and once at the picture.
  assert.equal((r.stats as { made: number }).made, 1);
  // At the bind: the resource's bytes read back; after a picture: the picture's.
  assert.deepEqual(first.bytes, Array.from({ length: 16 }, (_, i) => 10 + i));
  assert.deepEqual(second.bytes, Array.from({ length: 16 }, (_, i) => 200 + i));
});

test('a submit\'s fence comes back without waiting for the browser\'s slow look at the GPU (the pump nudges it), with the pump\'s turns its own or a ticker\'s', { skip, timeout: 120_000 }, async (t) => {
  // After the first test, which compiled the shaders.
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log(`page: ${m.text().slice(0, 2000)}`); });
  await page.goto(`${base}/tests/browser/venus-driver.html`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  type R = { median: number; nudges: number; empty: number; idlePolls: number; stuck: boolean; stoppedUnderTurn: boolean; ticks: number; idleTicks: number; ticker: string; adapter: string; skipped?: string; error?: string };
  const run = (poll: string, tickerUrl?: string) => page.evaluate(([poll, tickerUrl]) => (window as unknown as { venus: { runFences(s: object, poll: string, n: number, tickerUrl?: string): Promise<R> } }).venus.runFences({
    vert: '/target/vk/test/driver.vert.spv', frag: '/target/vk/test/driver.frag.spv', comp: '/target/vk/test/driver.comp.spv', costs: '/target/vk/test/costs.frag.spv' }, poll, 20, tickerUrl), [poll, tickerUrl] as const);
  const old = await run('timeout'), pump = await run('pump'), ticker = await run('ticker');
  // A ticker that fails to load, and one whose worker can't be made (another origin's): the pump alone, fences back.
  const unloaded = await run('ticker', '/web/no-such-ticker.ts'), unmade = await run('ticker', 'https://example.invalid/ticker.js');
  await page.close();
  if (old.skipped) return t.skip(`SKIPPED: ${old.skipped}`);
  for (const r of [old, pump, ticker, unloaded, unmade]) assert.equal(r.error, undefined, String(r.error));
  // The times are logged, not asserted (they follow the machine's load: under CI's both were 5-6 ms); on a quiet
  // SwiftShader the old way's fence is ~3 ms and the pump's ~1 ms (bench/vulkan/costs.ts, REPORT.md "VK3 L2").
  console.log(JSON.stringify({ adapter: old.adapter, timeout: old.median, pump: pump.median, ticker: ticker.median, nudges: pump.nudges, empty: pump.empty, tickerNudges: ticker.nudges }));
  assert.equal(old.empty, 0, 'the old poller sends no empty submits');
  // While a submit is in flight, at most one a ms (a fence back within a turn, as on Metal, may need none).
  assert.ok(pump.empty > 0, 'the pump sent no empty submit');
  assert.equal(pump.empty, pump.nudges, 'every nudge reached the queue');
  // The ticker (web/venus-ticker.ts, VK4 T13) times the same pump's turns: it nudges too, and stops when idle.
  assert.ok(ticker.empty > 0, 'the ticker\'s pump sent no empty submit');
  assert.equal(ticker.empty, ticker.nudges, 'every nudge of the ticker\'s reached the queue');
  for (const [name, r] of [['pump', pump], ['ticker', ticker]] as const) {
    assert.equal(r.idlePolls, 0, `${name}: polled while idle`);
    assert.equal(r.stuck, false, `${name}: a scheduled turn never came`);
    assert.equal(r.stoppedUnderTurn, false, `${name}: the ticker stopped while a turn waited on it`);
  }
  // The ticker ticked while the fences came back (its turns, not the fallback's), and stopped once idle.
  assert.ok(ticker.ticks > 0, 'the ticker never ticked');
  assert.equal(ticker.idleTicks, 0, 'the ticker ticked while idle');
  assert.equal(ticker.ticker, 'ticker');
  assert.equal(pump.ticks, 0);
  assert.deepEqual([unloaded.ticker, unmade.ticker], ['pump', 'pump'], 'a ticker that failed left its pump waiting on it');
});

// VK3 L4c-A (the static review's finding 1 and its odd-sized memories): two devices on one window, as two Venus contexts.
for (const [scenario, what] of [
  ['watch', 'a page one device wrote reaches its GPU buffer though another device submitted first'],
  ['serials', 'two devices\' submits with the same count behind them each complete their own'],
  ['odd', 'every byte of an odd-sized host-visible memory is uploaded, whole and by page'],
] as const) {
  test(`two devices: ${what}`, { skip, timeout: 60_000 }, async (t) => {
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log(`page: ${m.text().slice(0, 2000)}`); });
    await page.goto(`${base}/tests/browser/venus-driver.html`);
    await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
    const r = await page.evaluate((s) => (window as unknown as { venus: { runTwo(s: string): Promise<Record<string, unknown>> } }).venus.runTwo(s), scenario);
    await page.close();
    if (r.skipped) return t.skip(`SKIPPED: ${r.skipped}`);
    assert.equal(r.error, undefined, `${String(r.error)} ${JSON.stringify(r.checks)}`);
    assert.deepEqual(r.errors, [], 'WebGPU errors');
    // Each check: the first byte read back that differs from what was written (-1: none).
    const checks = r.checks as Record<string, number>;
    assert.ok(Object.keys(checks).length > 0);
    for (const [k, at] of Object.entries(checks)) assert.equal(at, -1, `${k}: the bytes read back differ from byte ${at}`);
    assert.equal(r.warnings, 0, 'the worker warned');
  });
}

// VK3 L4c-B (the static review's finding 2): GPU writes to host-visible memory in flight against the guest's writes.
for (const [scenario, what] of [
  ['upload', 'a page uploaded while a copy into it is in flight keeps the copy\'s bytes on the GPU'],
  ['since', 'a completion keeps what the guest wrote since its submit inside the range it reads back'],
] as const) {
  test(`in flight: ${what}`, { skip, timeout: 60_000 }, async (t) => {
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log(`page: ${m.text().slice(0, 2000)}`); });
    await page.goto(`${base}/tests/browser/venus-driver.html`);
    await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
    const r = await page.evaluate((s) => (window as unknown as { venus: { runInFlight(s: string): Promise<Record<string, unknown>> } }).venus.runInFlight(s), scenario);
    await page.close();
    if (r.skipped) return t.skip(`SKIPPED: ${r.skipped}`);
    assert.equal(r.error, undefined, `${String(r.error)} ${JSON.stringify(r.checks)}`);
    assert.deepEqual(r.errors, [], 'WebGPU errors');
    const checks = r.checks as Record<string, number>;
    assert.ok(Object.keys(checks).length > 1);
    for (const [k, at] of Object.entries(checks)) assert.equal(at, -1, `${k}: the bytes differ from byte ${at}`);
    assert.equal(r.warnings, 0, 'the worker warned');
  });
}

// VK3 L4c-D (the static review's findings 4 and 6, and "suspended and resumed passes"): what a pass keeps.
const blue = [0, 0, 255, 255], red = [255, 0, 0, 255], green = [0, 255, 0, 255], yellow = [255, 255, 0, 255];
for (const [scenario, what, want] of [
  // The scene's quad (texture: red over green) in front of the yellow band only if the draw kept its fragment shader.
  ['link', 'a draw whose stages came with different programs keeps its fragment shader', { topLeft: red, bottomLeft: green, topRight: blue, bottomRight: blue }],
  ['none', 'LOAD_OP_NONE keeps the attachment\'s contents', { topLeft: blue, bottomLeft: blue, topRight: blue, bottomRight: blue }],
  ['partial', 'DONT_CARE over part of the attachment keeps what\'s outside the render area', { topRight: blue, bottomRight: blue }],
  ['resume', 'a resumed pass doesn\'t clear again, and a suspended one stores whatever its store op', { topLeft: red, bottomLeft: red, topRight: green, bottomRight: green }],
  ['resumePartial', 'a resumed pass over part of the attachment doesn\'t clear its area again', { topLeft: red, bottomLeft: blue, topRight: green, bottomRight: blue }],
  // The out-of-context review of the driver (findings 1, 6, 11): pipelines WebGPU must take.
  ['strip', 'an indexed triangle strip without primitive restart draws', { topLeft: red, bottomLeft: green, topRight: blue, bottomRight: blue }],
  ['vertexOnly', 'a pipeline without a fragment shader in a pass with a colour attachment', { topLeft: blue, bottomLeft: blue, topRight: blue, bottomRight: blue }],
  ['lineBias', 'lines drawn with depth bias on', { topRight: blue, bottomRight: blue }],
  // L4f (the driver review's finding 2): a depth attachment in a read-only layout, sampled in its pass.
  ['readOnlyDepth', 'a depth attachment in a read-only layout sampled by the pass\'s draw', { topLeft: [191, 0, 0, 255], bottomLeft: [191, 0, 0, 255], topRight: blue, bottomRight: blue }],
  // L6c (the review of L5-L6a: finding 4): the worker's clear draws aren't counted by occlusion queries.
  ['clearQuery', 'occlusion queries count draws, not vkCmdClearAttachments', { topLeft: red, bottomLeft: red }],
  // VK4 T46: queries cut by many clears, past slot 4,096, and timestamps on the GPU, copied with their availability.
  ['manyQueries', 'occlusion queries cut by 100 clears and past slot 4,096 count, and timestamps come from the GPU', { topLeft: red, bottomLeft: red }],
  // L6c (the review of L5-L6a: finding 7): a draw split by face only where its faces' stencil state conflicts.
  ['facesUnused', 'faces whose stencil references differ but go unused draw once', { topLeft: red, bottomLeft: green, topRight: blue, bottomRight: blue }],
  ['facesSplit', 'faces whose stencil references both compare draw as two, front faces passing', { topLeft: red, bottomLeft: green, topRight: blue, bottomRight: blue }],
  // L7.4: the provoking vertex (each triangle's flat colour, the quad's vertices' uv: its triangles (0, 1, 2) top left, (0, 2, 3) bottom left).
  ['flatLast', 'an indexed triangle list whose last vertex provokes', { topLeft: yellow, bottomLeft: green, topRight: blue, bottomRight: blue }],
  ['flatFanLast', 'a fan whose last vertex provokes', { topLeft: yellow, bottomLeft: green, topRight: blue, bottomRight: blue }],
  ['flatFanFirst', 'a fan whose first vertex provokes (Vulkan\'s: each triangle\'s second vertex of the fan)', { topLeft: red, bottomLeft: yellow, topRight: blue, bottomRight: blue }],
  // L7b (the review of L7.4-L7.5: finding 1): 16-bit index buffers whose size isn't a multiple of 4, used to their end.
  ['flatFanOdd', 'an indexed fan of 5 16-bit indices in a 10-byte buffer', { topLeft: red, bottomLeft: yellow, topRight: blue, bottomRight: blue }],
  ['flatListOdd', 'a triangle list of 3 16-bit indices in a 6-byte buffer, its last vertex provoking', { topLeft: yellow, bottomLeft: blue, topRight: blue, bottomRight: blue }],
  // L7b (the review's finding 7): a restarted strip's walk in parts, its runs across them.
  ['flatRestart', 'an indexed strip with primitive restart whose last vertex provokes', { topLeft: yellow, bottomLeft: green, topRight: blue, bottomRight: blue }],
  // L7b (the review's finding 9): ANGLE's ES3 uniform buffers, 13 a stage, each stage's its own, a default block dynamic.
  ['angleUniforms', 'ANGLE\'s layout of 13 uniform buffers in each of two stages', { topLeft: [178, 200, 0, 255], bottomLeft: [178, 200, 0, 255], topRight: [178, 200, 0, 255], bottomRight: [178, 200, 0, 255] }],
  // The review of VK4 T44 to T46 (finding 3): the pull's uniform buffer past the vertex stage's, refused by the driver.
  ['angleUniformsPulled', 'ANGLE\'s layout with a vertex input pulled, refused by the driver, not by WebGPU', { topLeft: blue, bottomLeft: blue, topRight: blue, bottomRight: blue }],
  // L7.5: draw parameters (each quad's base vertex, base instance, 200 + its draw's index; indirect first instances
  // 0 where the adapter has none: checked below).
  ['drawParams', 'the base vertex, base instance and draw index of direct, indexed and indirect draws in one pass', { topLeft: [10, 20, 200, 255], bottomLeft: [30, 40, 200, 255] }],
  // VK4 T5: vertex layouts WebGPU's vertex buffers refuse, pulled from a storage binding.
  ['pullLayouts', 'strides and offsets that aren\'t multiples of 4, direct, indexed, indirect, beside an ordinary binding', { topLeft: [255, 0, 0, 255], topRight: [0, 255, 0, 255], bottomLeft: [255, 255, 0, 255], bottomRight: [128, 0, 0, 255] }],
  ['pullDrawParams', 'a pulled stage that reads draw parameters, two draws apart by those alone', { topLeft: [255, 0, 7, 255], topRight: [255, 0, 9, 255] }],
  ['pullGroups', 'a pulled draw between draws of a pipeline with a set where its group went', { topLeft: [0, 255, 0, 255], topRight: [255, 0, 0, 255], bottomLeft: [0, 255, 0, 255], bottomRight: [0, 0, 255, 255] }],
  ['pullOffsets', 'one layout bound at four offsets', { topLeft: [255, 0, 0, 255], topRight: [0, 255, 0, 255], bottomLeft: [255, 255, 0, 255], bottomRight: [255, 255, 255, 255] }],
  // VK4 T37: draws reading past their bindings' ends, pulled (zeros past them).
  ['pullPastEnd', 'draws reading their vertex and instance bindings past the buffer\'s end', { topLeft: [0, 255, 0, 255], topRight: [0, 0, 0, 255], bottomLeft: blue, bottomRight: blue }],
  // VK4 T44: pulled vertices in a program of four groups (group 3 shared), and divisors (records 5, 5, 3 and 0).
  ['pullFourSets', 'pulled draws beside an ordinary one in a layout of four sets', { topLeft: [0, 255, 0, 255], topRight: [255, 0, 0, 255], bottomLeft: [0, 255, 0, 255], bottomRight: [0, 0, 255, 255] }],
  ['pullDivisors', 'instance bindings with divisors of 2 and 0, direct and indirect, from first instances past 0', { topLeft: [255, 0, 0, 255], topRight: [255, 0, 0, 255], bottomLeft: [128, 0, 0, 255], bottomRight: [200, 0, 0, 255] }],
] as const) {
  test(`passes: ${what}`, { skip, timeout: 60_000 }, async (t) => {
    // After the first test, which compiled the shaders.
    const page = await browser.newPage();
    const logs: string[] = [];
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') { logs.push(m.text()); console.log(`page: ${m.text().slice(0, 2000)}`); } });
    await page.goto(`${base}/tests/browser/venus-driver.html`);
    await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
    const r = await page.evaluate((s) => (window as unknown as { venus: { runPass(spirv: object, s: string): Promise<Record<string, unknown>> } }).venus.runPass({
      vert: '/target/vk/test/driver.vert.spv', frag: '/target/vk/test/driver.frag.spv', comp: '/target/vk/test/driver.comp.spv' }, s), scenario);
    await page.close();
    if (r.skipped) return t.skip(`SKIPPED: ${r.skipped}`);
    assert.equal(r.error, undefined, String(r.error));
    assert.deepEqual(r.errors, [], 'WebGPU errors');
    const pixels = r.pixels as Record<string, number[]>;
    for (const [k, v] of Object.entries(want)) assert.deepEqual(pixels[k], v, `${k}: ${JSON.stringify(pixels)}`);
    if (scenario === 'drawParams') {
      const fi = r.firstInstance as boolean;
      assert.deepEqual(pixels.topRight, [50, fi ? 60 : 0, 200, 255], `topRight: ${JSON.stringify(pixels)}`);
      assert.deepEqual(pixels.bottomRight, [70, fi ? 80 : 0, 200, 255], `bottomRight: ${JSON.stringify(pixels)}`);
    }
    if (scenario === 'angleUniformsPulled') assert.ok(logs.some((l) => /refused: its pulled vertex bindings/.test(l)), `not refused: ${JSON.stringify(logs)}`);
    if (scenario === 'facesUnused' || scenario === 'facesSplit') assert.equal(r.draws, scenario === 'facesUnused' ? 1 : 2, 'the quad\'s draws');
    if (scenario === 'clearQuery') {
      const [clear, both, quad] = r.query as number[];
      assert.ok(quad > 0, `the quad's query: ${quad}`);
      assert.deepEqual([clear, both], [0, quad], 'a clear alone, and clears around the quad');
    }
    if (scenario === 'manyQueries') {
      const { wide, narrow } = r.query as { wide: string[]; narrow: number[] };
      const [q1, a1, q2, a2, q4500, a4500, q4999, a4999, t0, ta0, t1, ta1, t2, ta2] = wide.map(BigInt);
      // The quad covers the right half: 32 × 64 samples (WebGPU's count is exact on SwiftShader and the M4).
      assert.ok(q1 > 1n, `query 1 counted, not reported passing: ${wide}`);
      assert.deepEqual([q4500, q4999], [q1, q1], `queries past slot 4,096 count as query 1: ${wide}`);
      assert.deepEqual([a1, a4500, a4999, ta0, ta1, ta2], [1n, 1n, 1n, 1n, 1n, 1n], `available: ${wide}`);
      assert.deepEqual([q2, a2], [0xeeeeeeeeeeeeeeeen, 0n], `an unavailable query's value untouched: ${wide}`);
      assert.deepEqual(narrow, [Number(q1), 1], 'query 1 in 32 bits with its availability');
      assert.ok(t0 > 0n && t0 <= t1 && t1 <= t2, `timestamps in order: ${t0}, ${t1}, ${t2}`);
      t.diagnostic(`timestamps ${t0}, ${t1}, ${t2}`);
      if (r.timestampQuery) assert.ok((r.timestamps as number) > 0, 'timestamps written on the GPU');
    }
  });
}

// L7.4: transform feedback (the vertex stage run as compute at the render pass's end; wg_test.c's wgt_xfb).
for (const [scenario, what] of [
  ['xfbList', 'a triangle list\'s vertices captured, its counter written'],
  ['xfbOverflow', 'a capture past its buffer keeps whole primitives only'],
  ['xfbStrip', 'a triangle strip captured in Vulkan\'s order of each triangle\'s vertices'],
  ['xfbResume', 'a capture ended and begun again resumes from its counter'],
  // L7a (the binding review's finding 1): more vertex bindings and buffers than WebGPU's storage buffers a stage.
  ['xfbMany', 'four buffers captured from six vertex bindings'],
  // L7b (the review of L7.4-L7.5: findings 2, 6, 4).
  ['xfbIndirect', 'an indirect draw captured'],
  ['xfbIndexedIndirect', 'an indexed indirect draw captured'],
  ['xfbNullColors', 'a capture in a pass of eight colour attachments, all null'],
  ['xfbPasses', 'captures in 17 passes without attachments, each of its own size, in one command buffer'],
  // VK4 T5.
  ['xfbPulled', 'a capture of vertices bound at an offset WebGPU\'s vertex buffers refuse'],
  // VK4 T40.
  ['xfbFourGroups', 'a capture of a vertex stage of four bind groups (a draw parameter: the push buffer in group 3)'],
  // VK4 T45.
  ['xfbByteCount', 'a draw by a capture\'s byte count, in a later pass, captured'],
  ['xfbByteCountInPass', 'a draw by a capture\'s byte count, in the same pass, captured'],
  ['xfbQuery', 'a transform feedback query of a capture past its buffer, in the pass'],
  ['xfbQueryOutside', 'a transform feedback query begun before the pass and ended after it, around two captures'],
  // The review of VK4 T44 to T46 (finding 4).
  ['xfbTimestamp', 'a timestamp right after a pass with a capture follows the capture'],
] as const) {
  test(`transform feedback: ${what}`, { skip, timeout: 60_000 }, async (t) => {
    // After the first test, which compiled the shaders.
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log(`page: ${m.text().slice(0, 2000)}`); });
    await page.goto(`${base}/tests/browser/venus-driver.html`);
    await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
    const r = await page.evaluate((s) => (window as unknown as { venus: { runPass(spirv: object, s: string): Promise<Record<string, unknown>> } }).venus.runPass({
      vert: '/target/vk/test/driver.vert.spv', frag: '/target/vk/test/driver.frag.spv', comp: '/target/vk/test/driver.comp.spv' }, s), scenario);
    await page.close();
    if (r.skipped) return t.skip(`SKIPPED: ${r.skipped}`);
    assert.equal(r.error, undefined, String(r.error));
    assert.deepEqual(r.errors, [], 'WebGPU errors');
    assert.equal(r.differs, -1, `the capture differs from byte ${r.differs}: ${JSON.stringify(r.got)}, counter ${r.counter}`);
    assert.equal(r.warnings, 0, 'the worker warned');
    if (scenario === 'xfbTimestamp') {
      assert.ok(BigInt(r.stamp as string) > 0n, `the timestamp written: ${r.stamp}`);
      // The pass's end write and a write of its own after the capture (the pass's alone before, which the worker's
      // capture, run at the pass's end, follows).
      if (r.timestampQuery) assert.equal(r.timestamps, 2, 'the timestamp a write of its own');
    }
  });
}

// VK4 T3: usage scopes in a render pass (wg_test.c's wgt_scope): its scope is the whole pass, and each memory one
// GPUBuffer, so a draw writing storage of a memory beside any read of it was refused with the pass's submit.
for (const [mask, what] of [
  [1, 'a vertex buffer'],
  [2, 'an index buffer'],
  [4, 'a uniform buffer'],
  [8, 'a storage buffer the vertex stage reads'],
  [16, 'indirect arguments'],
  [31, 'all of them'],
  [32, 'what an earlier draw of the pass reads'],
  [4 | 64, 'a uniform buffer, with a compute set bound inside the pass dispatched after it'],
  [4 | 32 | 128, 'a uniform buffer written by an earlier draw of the pass, a barrier between them'],
  // VK4 T33: a vertex stage that writes storage, run as compute in a cut of the pass, a pass-through drawing its outputs.
  [256, 'a storage buffer the vertex stage writes'],
  [256 | 8 | 1, 'a storage buffer the vertex stage writes, beside the vertex buffer and the fragment stage\'s write'],
  [256 | 512, 'a storage buffer the vertex stage writes, the rasterizer discarding'],
  [256 | 1024, 'a storage buffer the vertex stage writes, not indexed'],
] as const) {
  test(`usage scopes: a render pass writing storage of the memory of ${what}`, { skip, timeout: 60_000 }, async (t) => {
    // After the first test, which compiled the scene's shaders.
    const out = join(root, 'target/vk/test');
    for (const name of ['scope.vert', 'scope.frag', 'ubo-ssbo.comp', 't33/store.vert']) {
      const c = spawnSync('glslc', ['--target-env=vulkan1.2', '-o', join(out, `${name.replace(/.*\//, '')}.spv`), join(root, `tests/venus/${name}`)], { encoding: 'utf8' });
      assert.equal(c.status, 0, c.stderr);
    }
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log(`page: ${m.text().slice(0, 2000)}`); });
    await page.goto(`${base}/tests/browser/venus-driver.html`);
    await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
    const r = await page.evaluate((m) => (window as unknown as { venus: { runScope(spirv: object, mask: number): Promise<Record<string, unknown>> } }).venus.runScope({
      vert: '/target/vk/test/driver.vert.spv', frag: '/target/vk/test/driver.frag.spv', comp: '/target/vk/test/driver.comp.spv' }, m), mask);
    await page.close();
    if (r.skipped) return t.skip(`SKIPPED: ${r.skipped}`);
    assert.equal(r.error, undefined, String(r.error));
    assert.deepEqual(r.errors, [], 'WebGPU errors');
    assert.deepEqual(r.got, { m: mask & 512 ? 0 : mask & 128 ? 2430 : 1230, n: mask & 32 && !(mask & 128) ? 1230 : 0, ...(mask & 64 ? { dispatched: 231 } : {}),
      ...(mask & 256 ? { stored: [200, 1000, 1001, 1002, 3] } : {}) });
  });
}

// VK3 L4c-F (the static review's "other real defects"): transfers and pushes WebGPU has no direct form for.
// Each misc scenario's compute shader (tests/venus/<name>.comp), push.comp where it isn't named.
const source = { rwImage: 't11-rw-view', rwImageWide: 't11-rw-wide', mutableViews: 'mutable-view', freedModule: 'depth-read', storageAliased: 'ssbo-copy', texelBuffer: 'texel-buffer', bindGroupsShared: 'spec-add', uniformBeside: 'ubo-ssbo', indirectBeside: 'ubo-ssbo', ycbcr: 'ycbcr', manyUniforms: 'many-ubo', texelStorage: 'texel-many', dynamicUniforms: 'dyn-ubo', writtenShared: 'spec-mode', immutableSampler: 'sampled', bigUniform: 'sampled', sharedSampler: 'sampled', immutableCopied: 'sampled', uniformWritten: 'ubo-ssbo', indirectWritten: 'ubo-ssbo', readInPlace: 'ubo-ssbo', addresses: 'address', addressesUniform: 'address-ubo', twoReads: 'two-reads', sameRange: 'two-writes', overlappingRanges: 'two-writes', threeSame: 'three-writes', oddRange: 'two-writes', inlineBlocks: 'inline', packedFeedback: 'feedback.frag', feedbackLayer: 'feedback.frag', depthLess: 'r5/depthless.frag', depthAndCompare: 'r5/depth-and-compare.frag', intGather: 'r5/int-gather.frag', cubeSized: 'r5/cube-sized.frag', cubeGather: 'r5/cube-gather.frag', depthEight: 'r5/depth-eight.frag', inlineLong: 'r6/inline-long', immutableFreed: 'sampled', sixteenBindings: 'r7/sixteen.frag', sixteenThenOne: 'r7/sixteen.frag', cubePlain: 'r5/cube-plain.frag', vertexCompares: 'r7/vs-compare.frag', fourSets: 'r7/four-sets.frag', bc1Blit: 'r7/sixteen.frag', readOnlyImages: 'g4/read-only', g4Views: 'g4/views', texturesFull: 'g4/textures-full', sizeOnly: 'g4/size-only', formatless: 'g5/formatless', declaredOther: 'g7/declared', arrayAsFlat: 'g4/views', texelUniforms: 'texel-uniforms', rgb9e5Words: 't23-rgb9e5', t32Reads: 't32/dst.frag', t32Loop: 't32/loop.frag', t32Ms: 't32/dst.frag', t34Mutable: 't34/mutable', t37Flat: 't37/flat-storage', t37ReadWritten: 't37/read-written', t37WordsPast: 't37/words-past', t37Mismatched: 't37/mismatched', t37UniformTail: 't37/uniform-tail', t37AtomicAlias: 't37/atomic-alias', t38Stores: 't38/stores', t40Shared: 't40/shared', t40Dynamic: 't40/dynamic', t41Regions: 't41/regions', t41Beside: 't41/beside', t43Wrapped: 't43/wrapped.frag', t43MappedCoverage: 't43/a2c-mapped.frag', t43MappedDual: 't43/dual-mapped.frag', t41BesidePast: 't41/beside-past', t41Full: 't41/full', t43Layered: 't43/layered.frag', t43PushLayers: 't43/points.frag', t44FanPast: 't44/fan-past.frag', t46SlotsPast: 't32/dst.frag', t46SlotsBetween: 't32/dst.frag' } as const;
for (const [scenario, what] of [
  ['copy', 'buffer copies at offsets and sizes that aren\'t 4-aligned, from host-visible, device-local and GPU-written memory'],
  ['clear', 'a clear of a format WebGPU can\'t render to, and of every slice of a 3D image'],
  ['blit', 'a blit from a 3D image samples its slice'],
  ['push', 'thousands of push-constant changes in one submit each keep their own'],
  // The out-of-context review of the driver (findings 3, 4, 5).
  ['pushGrown', 'a submit that grows the push buffer after one that bound it'],
  ['freedImage', 'a submit after a linear image\'s memory was freed leaves other memory alone'],
  ['dynamicStorage', 'a host-visible storage buffer\'s writes come back at its dynamic offset'],
  ['oddStorage', 'a storage buffer of an odd size bound whole'],
  // L4f (the driver review's finding 7).
  ['freedModule', 'a compute program\'s variant made after the shader that made the program was destroyed'],
  // L4f (the reviews' depth and stencil resolves: the translator's 10, the driver's 9).
  ['depthResolve', 'a multisampled depth and stencil attachment resolved at the pass\'s end'],
  // L5b (the out-of-context review of L4f: findings 1, 5, 2).
  ['depthResolveDiscard', 'a depth and stencil resolve of an attachment whose store op is DONT_CARE'],
  ['depthResolveArea', 'a depth and stencil resolve over part of the attachment'],
  ['storageAliased', 'a storage buffer read and one written, bound from one memory, in one dispatch'],
  // L6a (the driver review's finding 8).
  ['waitBeforeSignal', 'a submit that waits on a timeline value the host signals after it runs after the signal'],
  // L6b: texel buffers.
  ['texelBuffer', 'uniform texel buffers of four layouts read and a storage texel buffer written'],
  ['bindGroupsShared', 'six pipelines of equal set layouts in turn share a set\'s bind group'],
  ['depthCopies', 'depth copies WebGPU won\'t make: into depth, out of depth24plus, part of a subresource'],
  // L6c (the out-of-context review of L5-L6a: finding 2, vkQuake's first frame).
  ['uniformBeside', 'a uniform buffer and a read-only storage buffer of one memory in one dispatch'],
  ['indirectBeside', 'a dispatch whose arguments share a memory with a read-only storage buffer it reads'],
  // L6c (the review of L5-L6a: finding 1).
  ['emptyAfterHeld', 'a submit of a fence alone behind a held submit signals after it'],
  ['queryAfterDispatch', 'an occlusion query begun and ended outside a render pass around dispatches'],
  ['poolFreed', 'a query pool destroyed while its submit is pending isn\'t written by its completion'],
  // L7.2: YCbCr conversions (`?gpu=vkycbcr`).
  ['ycbcr', 'a disjoint NV12 image uploaded plane by plane and sampled through a YCbCr conversion'],
  // L7.4: ANGLE's ES3 row.
  ['manyUniforms', '13 uniform buffers and push constants past the immediates in one stage'],
  // L7a (the reviews after L7: the binding model's limits and identities).
  ['texelStorage', 'storage buffers and texel buffers of several buffers past WebGPU\'s storage buffers are refused, not submitted'],
  // VK4 T21 (dEQP-VK's descriptorset_random.sets4): a group's texel buffers' parameters are one uniform binding.
  ['texelUniforms', 'nine uniform texel buffers beside four uniform buffers in one stage'],
  // VK4 T40 (descriptorset_random.sets4 again): the words of one buffer's texel buffers and folded uniform buffers share a binding.
  ['t40Dynamic', 'WebGPU\'s dynamic uniform and storage buffers beside push constants past the immediates, at two offsets'],
  ['t40Shared', '12 uniform texel buffers of two buffers, 13 uniform buffers and 4 inline uniform blocks in one stage, past WebGPU\'s storage buffers apart'],
  // VK4 T22: a compute-only queue family, its queues the WebGPU queue's.
  ['queuesTimeline', 'a held submit of the graphics queue runs once the compute queue signals what it waits for'],
  ['queuesBinary', 'the compute queue\'s wait on a binary semaphore a held submit signals waits for it'],
  ['dynamicUniforms', 'as many dynamic uniform buffers as advertised beside the push buffer'],
  ['writtenShared', 'a pipeline\'s writes come back after another\'s widened variant bound the same set'],
  ['immutableSampler', 'a combined image sampler written with another sampler keeps its immutable one'],
  ['bigUniform', 'uniform blocks declared past their memory and past maxUniformBufferRange'],
  ['sharedSampler', 'a sampler that samples a depth view and a texture filters the texture'],
  // L8a (the track-end review: findings 1 and 4).
  ['sameMemoryCopy', 'buffer copies between two buffers of one memory, within one buffer, and within the result itself'],
  ['sameImageCopy', 'a copy and a blit within one subresource of an image'],
  ['immutableCopied', 'a combined image sampler copied over one with an immutable sampler keeps the immutable one'],
  // VK4 T3: usage scopes (one GPUBuffer a memory): a dispatch that reads what shares a memory with storage it writes.
  ['uniformWritten', 'a dispatch whose uniform buffer shares a memory with storage it writes'],
  ['indirectWritten', 'a dispatch whose indirect arguments share a memory with storage it writes'],
  ['readInPlace', 'a dispatch whose read-only storage buffer is the range it writes through another binding'],
  // VK4 T10: what no dEQP-VK case of the direct set runs.
  ['resolve3d', 'a resolve of a multisampled image into a slice of a 3D image'],
  ['msCopyWithin', 'multisampled copies of part of an image, into another and within itself'],
  // VK4 T4: a smaller case than any of image.mutable's: two levels, one written and one read through views of another
  // format, between work in the image's own.
  ['mutableViews', 'an image stored to and read through views of another format, between clears and copies in its own'],
  // VK4 T7: what no dEQP-VK case runs.
  ['inlineBlocks', 'inline uniform blocks written by a template update and a copy that run on into the next binding'],
  ['addresses', 'pointers and a writable descriptor of one memory in a dispatch, after the address buffer grew'],
  // VK4 R2: usage scopes' shapes no dEQP-VK case runs.
  ['addressesUniform', 'pointers, a writable descriptor and a uniform buffer of one memory in a dispatch'],
  ['twoReads', 'two read-only storage buffers of one range beside a writable one of their memory'],
  ['sameRange', 'two writable storage buffers of one range: what one writes the other reads'],
  ['overlappingRanges', 'two writable storage buffers that overlap: what one writes the other reads'],
  ['threeSame', 'three writable storage buffers of one range'],
  ['oddRange', 'two writable storage buffers of one range that isn\'t whole words'],
  // VK4 R3: the render passes' replay.
  ['attachmentSizes', 'attachments of different sizes in a pass over the smallest'],
  ['loadNone', 'a pass with load op NONE on a view of another format leaves the image as it was'],
  ['manyLayers', 'a layered pass of 40 layers reaches them all'],
  ['packedFeedback', 'a draw reading a packed-format attachment of its pass, wider than 64 texels'],
  ['feedbackLayer', 'a draw of a layered pass reading another layer of its attachment'],
  // VK4 R4: transfers.
  ['oneRow', 'one row of an image to and from a buffer whose images are taller'],
  ['resolveTwin', 'a drawn resolve into an sRGB view of a UNORM image'],
  ['msLayers', 'a multisampled copy of two layers'],
  ['msLayersSrgb', 'a multisampled sRGB copy between two layers of an image'],
  ['msLayersPacked', 'a multisampled packed copy between two layers of an image'],
  ['msTwins', 'a multisampled copy between sRGB and UNORM twins moves bits'],
  ['msPacked', 'a multisampled copy between packed layouts moves bits'],
  ['msFormats', 'a multisampled copy between formats of a block\'s size moves bits'],
  // VK4 T11: no dEQP-VK case loads and stores one image of a format WebGPU gives one way.
  ['rwImage', 'an image of a format WebGPU only gives one way, loaded and stored by a shader between clears and copies'],
  ['rwImageWide', 'such an image of 8 bytes a texel, its rows past what 4 bytes a texel would take'],
  // The review of VK4 R5 to R7.
  ['sixteenThenOne', 'pipelines that don\'t pull a binding after those that do, in a pass and the next'],
  ['cubePlain', 'a shadow cube of one level sampled plainly too'],
  ['vertexCompares', 'a texture the vertex stage compares and the fragment stage samples'],
  ['fourSets', 'sixteen vertex bindings pulled in the group 3 of a program of four groups'],
  ['bc1Blit', 'BC1\'s RGB format blitted keeps alpha 1'],
  // GD G4.
  ['readOnlyImages', 'ten storage images a stage only reads, past WebGPU\'s storage textures, beside one it writes'],
  ['g4Views', 'a one-layer 2D array view where the shader declares 2D, and an R4G4B4A4 view of an R16_UINT image'],
  ['texturesFull', '16 textures and a storage image the stage only reads, within WebGPU\'s limits'],
  ['sizeOnly', 'a storage image without a format only asked its size answers the bound view\'s'],
  // GD G5.
  ['formatless', 'storage images without a format, written and loaded, each the bound view\'s'],
  // GD G7.
  ['declaredOther', 'a storage image written through a view of another format than the shader declares: the view\'s'],
  ['arrayAsFlat', 'a 2D array view of two layers bound where the shader declares 2D reads its base layer'],
  // VK4 R7.
  ['sixteenBindings', '16 vertex bindings, those past WebGPU\'s 8 pulled from storage'],
  // VK4 R6 (the review's O findings).
  ['inlineLong', 'an inline uniform block its shader declares past its set\'s buffer'],
  ['immutableFreed', 'an immutable sampler destroyed once its layout is made'],
  // VK4 R5 (the review's C findings).
  ['depthLess', 'a variant of a stage writing depth, without an attachment for it, has a module of its own'],
  ['depthAndCompare', 'a depth texture sampled with and without comparison, its plain sampler filtering a float texture'],
  ['intGather', 'a sampler gathering an integer texture still filters a float one'],
  ['cubeSized', 'a shadow cube from its faces: each sampler by its own state, and sized in another stage'],
  ['depthEight', 'a stage writing depth beside every colour location, without an attachment for it'],
  ['cubeGather', 'a shadow cube bound as its faces is gathered from their fetches, its comparisons 1 (VK4 T42: refused before)'],
  // VK4 T24 (maintenance8): no dEQP-VK case runs them through the tests' guest's Venus (Mesa 26.2).
  ['m8Copies', 'depth and stencil copied with colour images of their size, and blits between layers and slices'],
  // VK4 T30.
  ['t30Formats', 'packed formats WebGPU hasn\'t (R4G4, A4R4G4B4, A1B5G5R5, A2R10G10B10) and D16S8 keep their texels\' bits'],
  // VK4 T31.
  ['t31Formats', 'formats WebGPU has no texture of (RGB8, RGB16, RGB32, scaled, BGRA integers, R8 sRGB, 10-bit signed) keep their texels through wider textures'],
  // VK4 T32.
  ['t32Reads', 'draws reading the attachments they write: a logic op, an advanced blend, the depth bounds test failing and passing'],
  ['t32Ms', 'a single-sampled attachment rendered at 4 samples: loaded into each sample, resolved at the end'],
  ['t32Loop', 'a feedback loop: a draw sampling the image it writes, through a view of more layers, renewed after a barrier'],
  // VK4 T34.
  ['t34Mutable', 'mutable descriptors read as the type last written to them, written over another type and copied'],
  // VK4 T37: commands WebGPU refused (their submits dropped), made valid.
  ['t37ReadWritten', 'subresources read as textures and written as storage in one dispatch, of a 2D image and a 3D image\'s level'],
  ['t37BigPacked', 'a packed format\'s 3D image past 128 MiB unpacked, uploaded whole'],
  ['t37WordsPast', 'a dispatch reaching a storage image as words past maxStorageBufferBindingSize refused, its submit kept'],
  ['t37Mismatched', 'storage images declared in another format than their views\', read and written'],
  ['t37UniformTail', 'a uniform block declared past its range at the end of a memory whose GPUBuffer has no room past it'],
  ['t37AtomicAlias', 'writable storage buffers of one range, one of atomics and one not, refused with their submit kept'],
  ['t37Flat', 'a 2D array view of one layer bound where the shader declares a 2D storage image, stored and read as a texture; a merged program of stages that disagree refused'],
  // VK4 T38: formats and features a line or a fetch away.
  ['t38Formats', 'the depth comparison bit, sub-word storage texel buffers, sRGB and packed storage images, A8 and 10-bit SNORM advertised; 10-bit SNORM texels kept through a half-float texture, its clears clamped'],
  ['t38Stores', 'neighbouring sub-word texel buffer stores, sRGB and R5G6B5 storage stores by words, A8 sampled, a 3D image\'s slices through 2D views fetched and stored'],
  // VK4 T39.
  ['t39MsBits', 'multisampled copies between a packed format and a plain one, and rgb10a2 and another of 4 bytes, move bits'],
  ['t39Resolves', 'resolves into RGBA8 images of 8 layers, by vkCmdResolveImage and at a pass\'s end, reach every texel'],
  // VK4 T41: device addresses at a program's scale.
  ['t41Regions', 'pointers into three regions of an address buffer past one storage binding, an image\'s memory taking no room, one memory at its captured address'],
  ['t41Beside', 'a writable descriptor beside pointers into its memory in one dispatch: each sees what the other wrote, nothing written back over the pointers\''],
  // The review of VK4 T41 to T43.
  ['t41BesidePast', 'a writable descriptor beside pointers into its memory stores and loads past its range: kept in it (robustBufferAccess)'],
  ['t41Full', 'as many storage buffers as advertised beside a pointer, the address buffer in regions of 1 MiB'],
  ['t43Wrapped', 'a stage reading gl_FrontFacing wrapped for a D24 depth bias, alone and with the depth bounds test'],
  ['t43MappedCoverage', 'alpha to coverage and alpha to one with the outputs\' locations swapped: location 0\'s alpha covers'],
  ['t43MappedDual', 'dual-source outputs that a map of locations moves, with a D24 depth bias, refused: the stage can\'t be printed for the map'],
  ['t43Layered', 'draws writing gl_Layer = 1 in a layered pass: a logic op, an indexed fan, an occlusion query and an input attachment, each of layer 1'],
  ['t43PushLayers', 'a thousand draws writing gl_Layer, each with its push constants, in a layered pass of six layers'],
  // VK4 T44.
  ['t44FanPast', 'an indirect fan refused for a storage image past its binding\'s limit, then an indexed fan of the pass drawn through its own indices'],
  // The review of VK4 T44 to T46 (findings 1 and 2).
  ['t46SlotsPast', 'a timestamp after a render pass of 300 parts, the submit\'s first, within the device\'s 256 slots'],
  ['t46SlotsBetween', 'timestamps around and in a render pass that begins at the device set\'s last slot, in order'],
] as const) {
  test(`misc: ${what}`, { skip, timeout: 60_000 }, async (t) => {
    // After the first test, which made target/vk/test.
    const out = join(root, 'target/vk/test');
    mkdirSync(out, { recursive: true });
    const name: string = source[scenario as keyof typeof source] ?? 'push';
    const src = name.includes('.') ? name : `${name}.comp`;
    mkdirSync(join(out, 'r5'), { recursive: true });
    mkdirSync(join(out, 'r6'), { recursive: true });
    mkdirSync(join(out, 'r7'), { recursive: true });
    mkdirSync(join(out, 'g4'), { recursive: true });
    mkdirSync(join(out, 'g5'), { recursive: true });
    mkdirSync(join(out, 'g7'), { recursive: true });
    mkdirSync(join(out, 't32'), { recursive: true });
    mkdirSync(join(out, 't34'), { recursive: true });
    mkdirSync(join(out, 't37'), { recursive: true });
    mkdirSync(join(out, 't38'), { recursive: true });
    mkdirSync(join(out, 't40'), { recursive: true });
    mkdirSync(join(out, 't41'), { recursive: true });
    mkdirSync(join(out, 't43'), { recursive: true });
    mkdirSync(join(out, 't44'), { recursive: true });
    for (const f of [src, ...(src.endsWith('.frag') ? ['feedback.vert', 'r5/cube-sized.vert', 'r7/sixteen.vert', 'r7/vs-compare.vert', 't43/layer.vert', 't43/points.vert', 't44/fan.vert'] : [])]) {
      const c = spawnSync('glslc', ['--target-env=vulkan1.2', '-o', join(out, `${f}.spv`), join(root, `tests/venus/${f}`)], { encoding: 'utf8' });
      assert.equal(c.status, 0, c.stderr);
    }
    const page = await browser.newPage();
    const logs: string[] = [];
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') { logs.push(m.text()); console.log(`page: ${m.text().slice(0, 2000)}`); } });
    await page.goto(`${base}/tests/browser/venus-driver.html`);
    await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
    const r = await page.evaluate((s) => (window as unknown as { venus: { runMisc(s: string, push: string): Promise<Record<string, unknown>> } }).venus.runMisc(s.scenario, `/target/vk/test/${s.src}.spv`), { scenario, src });
    await page.close();
    if (r.skipped) return t.skip(`SKIPPED: ${r.skipped}`);
    assert.equal(r.error, undefined, `${String(r.error)} ${JSON.stringify(r.checks)}`);
    assert.deepEqual(r.errors, [], 'WebGPU errors');
    const checks = r.checks as Record<string, number>;
    if (scenario === 'texelStorage') {
      // Refused, saying why (nothing dispatched), or, on an adapter with room, run.
      const refused = logs.some((l) => /(didn't translate|refused): .*storage buffers/.test(l));
      assert.equal(refused ? checks.untouched : checks.ran, -1, `${refused ? 'refused, but written' : 'not refused, nor run'} (${JSON.stringify(r.got)})`);
      delete checks.untouched;
      delete checks.ran;
    }
    for (const [k, at] of Object.entries(checks)) assert.equal(at, -1, `${k}: the bytes differ from byte ${at} (${JSON.stringify(r.got)})`);
    if (scenario === 't37WordsPast' || scenario === 't44FanPast' || scenario === 't37AtomicAlias' || scenario === 't43MappedDual') assert.ok(logs.some((l) => /refused/.test(l)), `not refused: ${JSON.stringify(logs)}`);
    if (scenario === 't46SlotsPast' || scenario === 't46SlotsBetween') {
      const stamps = (r.stamps as string[]).map(BigInt);
      assert.ok(stamps.every((x) => x > 0n), `timestamps written: ${stamps.filter((x) => x === 0n).length} of ${stamps.length} are 0`);
      const back = stamps.findIndex((x, i) => i > 0 && x < stamps[i - 1]);
      assert.equal(back, -1, `timestamps in order: ${stamps[back - 1]} then ${stamps[back]} at ${back}`);
      t.diagnostic(`timestamps on the GPU: ${r.timestampQuery}, the last ${stamps.slice(-3).join(', ')}`);
    }
    if (scenario === 't43PushLayers') assert.ok(!logs.some((l) => /overflow/.test(l)), `the push buffer overflowed: ${JSON.stringify(logs)}`);
    assert.equal(r.warnings, 0, 'the worker warned');
    // The fill's and the six pipelines' one: not one a dispatch (a set keeps groups for 4 layouts).
    if (scenario === 'bindGroupsShared') assert.ok((r.bindGroups as number) <= 2, `${r.bindGroups} bind groups made`);
  });
}

// L8a (the track-end review's finding 3): a pass without attachments rasterizes at its pipelines' sample count.
test('samples: passes without attachments at 4 samples, drawn in the pass and by a secondary command buffer', { skip, timeout: 60_000 }, async (t) => {
  const out = join(root, 'target/vk/test');
  mkdirSync(out, { recursive: true });
  for (const f of ['samples.vert', 'samples.frag']) {
    const c = spawnSync('glslc', ['--target-env=vulkan1.2', '-o', join(out, `${f}.spv`), join(root, `tests/venus/l8a/${f}`)], { encoding: 'utf8' });
    assert.equal(c.status, 0, c.stderr);
  }
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log(`page: ${m.text().slice(0, 2000)}`); });
  await page.goto(`${base}/tests/browser/venus-driver.html`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  const r = await page.evaluate(() => (window as unknown as { venus: { runSamples(v: string, f: string): Promise<Record<string, unknown>> } }).venus.runSamples('/target/vk/test/samples.vert.spv', '/target/vk/test/samples.frag.spv'));
  await page.close();
  if (r.skipped) return t.skip(`SKIPPED: ${r.skipped}`);
  assert.equal(r.error, undefined, String(r.error));
  assert.deepEqual(r.errors, [], 'WebGPU errors');
  // Every sample's bit, and 16 pixels' 4 samples each.
  assert.deepEqual(r.pass, [0xf, 64], 'drawn in the pass');
  assert.deepEqual(r.secondary, [0xf, 64], 'drawn by the secondary');
  assert.equal(r.warnings, 0, 'the worker warned');
});

// L7a (the binding review's finding 6): pipelines past WebGPU's limits by what the device advertises, made but not
// drawn: refused at their creation, saying why, with no WebGPU error.
for (const [scenario, frag, what, why] of [
  ['inputAttachments', 'input-many.frag', '16 sampled images and an input attachment, 17 textures', /didn't translate: the fragment stage binds 17 textures, past WebGPU's 16 \(of them: 1 input attachments\)/],
] as const) {
  test(`fits: ${what}`, { skip, timeout: 60_000 }, async (t) => {
    const out = join(root, 'target/vk/test');
    mkdirSync(out, { recursive: true });
    for (const f of ['fits.vert', frag]) {
      const c = spawnSync('glslc', ['--target-env=vulkan1.2', '-o', join(out, `${f}.spv`), join(root, `tests/venus/l7a/${f}`)], { encoding: 'utf8' });
      assert.equal(c.status, 0, c.stderr);
    }
    const page = await browser.newPage();
    const logs: string[] = [];
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') { logs.push(m.text()); console.log(`page: ${m.text().slice(0, 2000)}`); } });
    await page.goto(`${base}/tests/browser/venus-driver.html`);
    await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
    const r = await page.evaluate((s) => (window as unknown as { venus: { runFits(s: string, v: string, f: string): Promise<Record<string, unknown>> } }).venus.runFits(s.scenario, '/target/vk/test/fits.vert.spv', `/target/vk/test/${s.frag}.spv`), { scenario, frag });
    await page.close();
    if (r.skipped) return t.skip(`SKIPPED: ${r.skipped}`);
    assert.equal(r.error, undefined, String(r.error));
    assert.deepEqual(r.errors, [], 'WebGPU errors');
    assert.ok(logs.some((l) => why.test(l)), `not refused: ${JSON.stringify(logs)}`);
  });
}

// VK4 T23: what the emulated paths did (web/venus-host.ts `emul`), counted where each meets its path, and `skip`'s
// paths left out: no copy, no WebGPU error, the scenario's bytes then wrong (what it checks needs the copies).
for (const [scenario, counts, skips] of [
  ['mutableViews', ['viewCopies', 'viewBytes'], ['views']],
  ['rwImage', ['wordsCopies', 'wordsBytes'], ['words']],
  ['packedFeedback', ['feedbackCopies', 'feedbackBytes'], ['feedback']],
  ['t32Loop', ['feedbackCopies', 'feedbackBytes'], ['feedback']],
  ['twoReads', ['shadowCopies', 'shadowBytes'], []],
  ['blit', ['blits'], ['meta']],
  ['msFormats', ['drawnResolves'], []],
  ['depthLess', ['variants', 'keyedDraws'], []],
  // VK4 T23: an E5B9G9R9 view of an R32_UINT image sampled from its own texture (keyed: its words decoded), nothing copied.
  ['rgb9e5Words', ['keyedDraws'], []],
] as const) {
  test(`emulated paths: ${scenario} counts ${counts.join(', ')}${skips.length ? `, and vkskip=${skips.join(',')} leaves them out` : ''}`, { skip, timeout: 60_000 }, async (t) => {
    const out = join(root, 'target/vk/test');
    const name: string = source[scenario as keyof typeof source] ?? 'push';
    const src = name.includes('.') ? name : `${name}.comp`;
    for (const f of [src, ...(src.endsWith('.frag') ? ['feedback.vert'] : [])]) {
      const c = spawnSync('glslc', ['--target-env=vulkan1.2', '-o', join(out, `${f}.spv`), join(root, `tests/venus/${f}`)], { encoding: 'utf8' });
      assert.equal(c.status, 0, c.stderr);
    }
    const run = async (skipped: readonly string[]) => {
      const page = await browser.newPage();
      await page.goto(`${base}/tests/browser/venus-driver.html`);
      await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
      const r = await page.evaluate((s) => (window as unknown as { venus: { runMisc(s: string, push: string, skip: string[]): Promise<Record<string, unknown>> } }).venus.runMisc(s.scenario, `/target/vk/test/${s.src}.spv`, s.skipped), { scenario, src, skipped: [...skipped] });
      await page.close();
      return r;
    };
    const r = await run([]);
    if (r.skipped) return t.skip(`SKIPPED: ${r.skipped}`);
    assert.equal(r.error, undefined, String(r.error));
    const emul = r.emul as Record<string, number>;
    console.log(scenario, JSON.stringify(Object.fromEntries(Object.entries(emul).filter(([, n]) => n))));
    for (const k of counts) assert.ok(emul[k] > 0, `${k}: ${emul[k]}`);
    if (scenario === 'rgb9e5Words') {
      assert.equal(emul.viewCopies, 0, 'copies into a texture of the view\'s format');
      for (const [k, at] of Object.entries(r.checks as Record<string, number>)) assert.equal(at, -1, `${k}: the bytes differ from byte ${at} (${JSON.stringify(r.got)})`);
    }
    if (!skips.length) return;
    const s = await run(skips);
    assert.equal(s.error, undefined, String(s.error));
    assert.deepEqual(s.errors, [], 'WebGPU errors with the path left out');
    const left = s.emul as Record<string, number>;
    for (const k of counts) assert.equal(left[k], 0, `${k} with vkskip=${skips.join(',')}`);
    assert.ok(Object.values(s.checks as Record<string, number>).some((at) => at !== -1), 'the bytes right without the copies: the scenario doesn\'t need them');
  });
}
