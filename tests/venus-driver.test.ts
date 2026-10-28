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
  for (const [src, name] of [['tests/venus/driver.vert', 'driver.vert'], ['tests/venus/driver.frag', 'driver.frag'], ['tests/venus/driver.comp', 'driver.comp'], ['bench/vulkan/costs/costs.frag', 'costs.frag'], ['tests/venus/flat.vert', 'flat.vert'], ['tests/venus/flat.frag', 'flat.frag'], ['tests/venus/xfb.vert', 'xfb.vert'], ['tests/venus/draw-params.vert', 'draw-params.vert']]) {
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
  // L6c (the review of L5-L6a: finding 7): a draw split by face only where its faces' stencil state conflicts.
  ['facesUnused', 'faces whose stencil references differ but go unused draw once', { topLeft: red, bottomLeft: green, topRight: blue, bottomRight: blue }],
  ['facesSplit', 'faces whose stencil references both compare draw as two, front faces passing', { topLeft: red, bottomLeft: green, topRight: blue, bottomRight: blue }],
  // L7.4: the provoking vertex (each triangle's flat colour, the quad's vertices' uv: its triangles (0, 1, 2) top left, (0, 2, 3) bottom left).
  ['flatLast', 'an indexed triangle list whose last vertex provokes', { topLeft: yellow, bottomLeft: green, topRight: blue, bottomRight: blue }],
  ['flatFanLast', 'a fan whose last vertex provokes', { topLeft: yellow, bottomLeft: green, topRight: blue, bottomRight: blue }],
  ['flatFanFirst', 'a fan whose first vertex provokes (Vulkan\'s: each triangle\'s second vertex of the fan)', { topLeft: red, bottomLeft: yellow, topRight: blue, bottomRight: blue }],
  // L7.5: draw parameters (each quad's base vertex, base instance, 200 + its draw's index; indirect first instances
  // 0 where the adapter has none: checked below).
  ['drawParams', 'the base vertex, base instance and draw index of direct, indexed and indirect draws in one pass', { topLeft: [10, 20, 200, 255], bottomLeft: [30, 40, 200, 255] }],
] as const) {
  test(`passes: ${what}`, { skip, timeout: 60_000 }, async (t) => {
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
    const pixels = r.pixels as Record<string, number[]>;
    for (const [k, v] of Object.entries(want)) assert.deepEqual(pixels[k], v, `${k}: ${JSON.stringify(pixels)}`);
    if (scenario === 'drawParams') {
      const fi = r.firstInstance as boolean;
      assert.deepEqual(pixels.topRight, [50, fi ? 60 : 0, 200, 255], `topRight: ${JSON.stringify(pixels)}`);
      assert.deepEqual(pixels.bottomRight, [70, fi ? 80 : 0, 200, 255], `bottomRight: ${JSON.stringify(pixels)}`);
    }
    if (scenario === 'facesUnused' || scenario === 'facesSplit') assert.equal(r.draws, scenario === 'facesUnused' ? 1 : 2, 'the quad\'s draws');
    if (scenario === 'clearQuery') {
      const [clear, both, quad] = r.query as number[];
      assert.ok(quad > 0, `the quad's query: ${quad}`);
      assert.deepEqual([clear, both], [0, quad], 'a clear alone, and clears around the quad');
    }
  });
}

// L7.4: transform feedback (the vertex stage run as compute at the render pass's end; wg_test.c's wgt_xfb).
for (const [scenario, what] of [
  ['xfbList', 'a triangle list\'s vertices captured, its counter written'],
  ['xfbOverflow', 'a capture past its buffer keeps whole primitives only'],
  ['xfbStrip', 'a triangle strip captured in Vulkan\'s order of each triangle\'s vertices'],
  ['xfbResume', 'a capture ended and begun again resumes from its counter'],
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
  });
}

// VK3 L4c-F (the static review's "other real defects"): transfers and pushes WebGPU has no direct form for.
// Each misc scenario's compute shader (tests/venus/<name>.comp), push.comp where it isn't named.
const source = { freedModule: 'depth-read', storageAliased: 'ssbo-copy', texelBuffer: 'texel-buffer', bindGroupsShared: 'spec-add', uniformBeside: 'ubo-ssbo', indirectBeside: 'ubo-ssbo', ycbcr: 'ycbcr', manyUniforms: 'many-ubo' } as const;
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
] as const) {
  test(`misc: ${what}`, { skip, timeout: 60_000 }, async (t) => {
    // After the first test, which made target/vk/test.
    const out = join(root, 'target/vk/test');
    mkdirSync(out, { recursive: true });
    const src = `${source[scenario as keyof typeof source] ?? 'push'}.comp`;
    const c = spawnSync('glslc', ['--target-env=vulkan1.2', '-o', join(out, `${src}.spv`), join(root, `tests/venus/${src}`)], { encoding: 'utf8' });
    assert.equal(c.status, 0, c.stderr);
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log(`page: ${m.text().slice(0, 2000)}`); });
    await page.goto(`${base}/tests/browser/venus-driver.html`);
    await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
    const r = await page.evaluate((s) => (window as unknown as { venus: { runMisc(s: string, push: string): Promise<Record<string, unknown>> } }).venus.runMisc(s.scenario, `/target/vk/test/${s.src}.spv`), { scenario, src });
    await page.close();
    if (r.skipped) return t.skip(`SKIPPED: ${r.skipped}`);
    assert.equal(r.error, undefined, `${String(r.error)} ${JSON.stringify(r.checks)}`);
    assert.deepEqual(r.errors, [], 'WebGPU errors');
    const checks = r.checks as Record<string, number>;
    for (const [k, at] of Object.entries(checks)) assert.equal(at, -1, `${k}: the bytes differ from byte ${at} (${JSON.stringify(r.got)})`);
    assert.equal(r.warnings, 0, 'the worker warned');
    // The fill's and the six pipelines' one: not one a dispatch (a set keeps groups for 4 layouts).
    if (scenario === 'bindGroupsShared') assert.ok((r.bindGroups as number) <= 2, `${r.bindGroups} bind groups made`);
  });
}
