// The virgl renderer on Chromium's WebGL2 (headless: SwiftShader; docs/testing.md "virgl"): every program the
// translator makes from the TGSI corpus compiles and links; glcomp's trace draws what llvmpipe drew (within a
// tolerance: filtering and blending round differently); sway's trace draws its desktop as it did when it was
// recorded (a regression reference made by this renderer, tests/virgl/sway-640.scanout.gz); a guest's video
// pictures (FFmpeg through VA-API, tests/virgl/video-*) decoded with WebCodecs into their planes, as the original
// streams decode. And a guest end to end on a 3D machine as the page makes one: alpine-virgl's glcomp with the
// renderer in the GPU worker, its frame read back by the guest through the renderer.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { chromium, type Browser, type Page } from 'playwright-core';
import { chromiumEnv } from '../tools/nosme.ts';
import { startServer } from '../tools/serve.ts';
import { PROFILE } from '../web/virgl-video.ts';
import type { ChunkFault } from './browser/virgl-page.ts';

let browser: Browser;
let page: Page;
let base: string;
let h264 = true;
let close: () => void;
const fixture = (name: string) => {
  const b = readFileSync(new URL(`virgl/${name}`, import.meta.url));
  return new Uint8Array(name.endsWith('.gz') ? gunzipSync(b) : b);
};

before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // The video test reads decoded frames: SME hidden where the CPU needs it (tools/nosme.ts).
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', env: chromiumEnv() });
  page = await browser.newPage();
  await page.goto(`${base}/tests/browser/virgl.html`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready, null, { timeout: 30_000 });
  // Chromium builds without proprietary codecs (Playwright's, in a cloud session) decode no H.264 at all.
  h264 = await page.evaluate(async () => !!(await VideoDecoder.isConfigSupported({ codec: 'avc1.640033', codedWidth: 1920, codedHeight: 1080 })).supported);
});
after(async () => { await browser?.close(); close?.(); });

type Replay = { stats: { errors: number; draws: number }; log: string[]; replies: number[]; pixels64: string | null; width: number; height: number; glError: number };
async function replayOn(trace: Uint8Array, read: number) {
  const r = await page.evaluate(([t, n]) => (window as unknown as { virgl: { replayTrace64(t: string, n: number): Replay } }).virgl.replayTrace64(t, n), [Buffer.from(trace).toString('base64'), read] as const);
  return { ...r, pixels: r.pixels64 ? new Uint8Array(Buffer.from(r.pixels64, 'base64')) : null };
}

/** The largest byte difference, the mean, and the share of bytes more than `tol` apart. */
function compare(a: Uint8Array, b: Uint8Array, tol: number) {
  assert.equal(a.length, b.length, 'sizes');
  let max = 0, sum = 0, off = 0;
  for (let k = 0; k < a.length; k++) {
    const d = Math.abs(a[k] - b[k]);
    max = Math.max(max, d);
    sum += d;
    if (d > tol) off++;
  }
  return { max, mean: sum / a.length, off: off / a.length };
}

test('virgl on WebGL2: every program of the TGSI corpus compiles and links', async () => {
  const r = await page.evaluate((c) => (window as unknown as { virgl: { compileCorpus(c: string): { programs: number; failures: { name: string; error: string }[] } } }).virgl.compileCorpus(c), readFileSync(new URL('virgl/tgsi-corpus.txt', import.meta.url), 'utf8'));
  assert.deepEqual(r.failures.map((f) => `${f.name}: ${f.error}`), []);
  assert.ok(r.programs >= 35);
});

type VideoReplay = { hashes: string[]; stats: { frames: number; decoded: number; dropped: number; errors: number }; ahead: number; maxWaitMs: number; timedOut: { drains: number; giveUps: number }; hardware: number[]; log: string[]; ms: number; orig: { hashes: string[]; errors: string[] } | null };
async function replayVideo(name: string, orig?: string, fault?: ChunkFault): Promise<VideoReplay> {
  const ref = videoRef();
  return page.evaluate(([t, w, h, o, f]) => (window as unknown as { virgl: { replayVideo64(t: string, w: number, h: number, o?: string, f?: ChunkFault): Promise<VideoReplay> } }).virgl.replayVideo64(t, w, h, o, f),
    [Buffer.from(fixture(name)).toString('base64'), ref.width, ref.height, orig && Buffer.from(fixture(orig)).toString('base64'), fault] as const);
}
/** FFmpeg's frames of the original files (bench/video/fixture.ts): SHA-256 of each visible I420, in display order. */
const videoRef = () => JSON.parse(readFileSync(new URL('virgl/video.json', import.meta.url), 'utf8')) as { width: number; height: number; pictures: number; h264: string[]; vp9: string[]; 'av1-aom': string[]; 'av1-svt': string[]; 'av1-tools': string[] };

test('video on WebGL2: VP9 pictures through the device and WebCodecs into their planes, each FFmpeg\'s frame', { timeout: 180_000 }, async () => {
  const ref = videoRef();
  const r = await replayVideo('video-vp9.vglt.gz');
  assert.deepEqual(r.log, []);
  assert.deepEqual(r.stats, { ...r.stats, frames: ref.pictures, decoded: ref.pictures, dropped: 0, errors: 0 });
  // Shown in decode order (none hidden in these): each picture the original's frame, exactly.
  const wrong = r.hashes.flatMap((h, k) => (h === ref.vp9[k] ? [] : [k]));
  assert.equal(wrong.length, 0, `pictures ${wrong.join(' ')} differ from FFmpeg's`);
});

test('video on WebGL2: H.264 pictures through the device and WebCodecs into their planes, as the original decodes', { timeout: 180_000 }, async (t) => {
  if (!h264) return t.skip('this Chromium decodes no H.264');
  const ref = videoRef();
  const r = await replayVideo('video-h264.vglt.gz', 'video-h264-orig.h264.gz');
  const hw = r.hardware.includes(PROFILE.AVC_HIGH);
  assert.deepEqual(r.log, []);
  assert.deepEqual(r.orig!.errors, []);
  assert.equal(r.orig!.hashes.length, ref.pictures);
  // Every picture comes out (software FFmpeg may drop one while it learns the reorder depth: web/video-h264.ts
  // buildSps), and each is a frame of the browser's own decode of the original stream: this browser's software
  // decoder may not be FFmpeg's (the dev VM's Chromium decodes H.264 with OpenH264, not bit-exact with FFmpeg).
  assert.equal(r.stats.frames, ref.pictures);
  assert.equal(r.stats.decoded + r.stats.dropped, ref.pictures);
  assert.ok(r.stats.decoded >= ref.pictures - (hw ? 0 : 1), `${r.stats.decoded} of ${ref.pictures} pictures written`);
  const browser = new Set(r.orig!.hashes), ffmpeg = new Set(ref.h264);
  const wrong = r.hashes.flatMap((h, k) => (browser.has(h) ? [] : [k]));
  assert.equal(wrong.length, 0, `written pictures ${wrong.join(' ')} aren't frames of the original`);
  // Where the decoder is FFmpeg's or the hardware's, they are FFmpeg's frames too.
  const exact = r.hashes.filter((h) => ffmpeg.has(h)).length;
  if (hw) assert.equal(exact, r.hashes.length);
  console.log(`H.264: ${r.stats.decoded} pictures in ${hw ? 'hardware' : 'software'}, ${exact} FFmpeg's exactly, ${r.ms.toFixed(0)} ms; ${r.ahead} calls ran ahead, the longest wait ${r.maxWaitMs.toFixed(0)} ms`);
});

test('video on WebGL2: AV1 frames through the device and WebCodecs into their planes, each FFmpeg\'s frame', { timeout: 180_000 }, async () => {
  const ref = videoRef();
  // libaom (eight distinct references: frames stored nowhere and decoded again, hidden frames never shown), SVT-AV1
  // (hidden frames shown later), and libaom with more tools on (segmentation, 2x2 tiles, 128x128 superblocks,
  // quantizer matrices, rotzoom global motion, delta q and lf, loop restoration, film grain decoded into the shown
  // surface by webpc-va): the temporal units rebuilt by web/video-av1.ts.
  for (const name of ['av1-aom', 'av1-svt', 'av1-tools'] as const) {
    const r = await replayVideo(`video-${name}.vglt.gz`);
    assert.deepEqual(r.log, [], name);
    assert.deepEqual({ frames: r.stats.frames, dropped: r.stats.dropped, errors: r.stats.errors }, { frames: ref.pictures, dropped: 0, errors: 0 }, name);
    // A frame per picture the guest shows (a hidden frame it shows later comes out at its decode): each FFmpeg's frame.
    assert.ok(r.stats.decoded >= ref.pictures - 5, `${name}: ${r.stats.decoded} written`);
    assert.equal(r.hashes.length, r.stats.decoded);
    const frames = new Set(ref[name]);
    const wrong = r.hashes.flatMap((h, k) => (frames.has(h) ? [] : [k]));
    assert.equal(wrong.length, 0, `${name}: written pictures ${wrong.join(' ')} aren't FFmpeg's frames`);
    console.log(`${name}: ${r.stats.decoded} of ${ref.pictures} frames written, ${r.ms.toFixed(0)} ms`);
  }
});

// Skipped in a Claude Code cloud session: Playwright's x86_64 Chromium writes 5 of VP9's 10 pictures before the error,
// every run, against this test's 8 to 10 (docs/cloud.md).
const cloud = !!process.env.CLAUDE_CODE_REMOTE && 'a cloud session\'s Chromium writes 5 pictures before the error (docs/cloud.md)';
test('video on WebGL2: a damaged chunk is a decoder error that ends its codec\'s pictures, and nothing waits for them', { timeout: 180_000, skip: cloud }, async () => {
  const ref = videoRef();
  for (const [name, hashes] of [['video-vp9.vglt.gz', ref.vp9], ['video-h264.vglt.gz', null]] as const) {
    if (name === 'video-h264.vglt.gz' && !h264) { console.log('# H.264 not checked: this Chromium decodes no H.264'); continue; }
    // The 11th picture's bytes garbled: WebCodecs reports it (no decoder here conceals it), the decoder is closed and
    // the codec's later pictures, all deltas, are dropped until a key picture (the fixture has none).
    const r = await replayVideo(name, undefined, { picture: 10, how: 'garble' });
    assert.equal(r.log.length, 1, r.log.join('\n'));
    assert.match(r.log[0], /video: codec \d+: .*Decoding error/);
    assert.equal(r.stats.errors, 1);
    assert.equal(r.stats.frames, ref.pictures);
    assert.equal(r.stats.decoded + r.stats.dropped, ref.pictures);
    // What came out before it is written (a software H.264 decoder may have held one or two for reordering: lost).
    assert.ok(r.stats.decoded <= 10 && r.stats.decoded >= 8, `${r.stats.decoded} written`);
    if (hashes) assert.deepEqual(r.hashes, hashes.slice(0, r.hashes.length));
    // Nothing waited for the dropped pictures: the error freed the guest, not the queue's drain or give-up (held off
    // for 10 and 20 s here, so a host slowed by load doesn't fire them on a slow decode: replayVideo64).
    assert.deepEqual(r.timedOut, { drains: 0, giveUps: 0 }, `the longest wait ${r.maxWaitMs.toFixed(0)} ms`);
  }
});

test('virgl on WebGL2: glcomp draws what llvmpipe drew', async () => {
  // The render target is resource 3 (glcomp makes it first).
  const r = await replayOn(fixture('glcomp-128x96.vglt'), 3);
  assert.deepEqual(r.log, []);
  assert.equal(r.stats.errors, 0);
  assert.equal(r.stats.draws, 18);
  assert.equal(r.glError, 0);
  const c = compare(r.pixels!, fixture('glcomp-128x96.llvmpipe.rgba'), 2);
  console.log(`# glcomp against llvmpipe: max ${c.max}, mean ${c.mean.toFixed(3)}, ${(c.off * 100).toFixed(1)}% of bytes more than 2 apart`);
  assert.ok(c.max <= 8 && c.mean < 1.5, JSON.stringify(c));
});

test('virgl on WebGL2: sway draws its desktop (foot, a command\'s output) as recorded', async () => {
  const r = await replayOn(fixture('sway-640.vglt.gz'), -1);
  assert.equal(r.stats.errors, 0);
  assert.equal(r.glError, 0);
  assert.deepEqual([r.width, r.height], [640, 480]);
  const c = compare(r.pixels!, fixture('sway-640.scanout.gz'), 2);
  assert.ok(c.max <= 8 && c.off < 0.001, JSON.stringify(c));
});

type Saved = { errors: number; log: string[]; saves: { bytes: number; resources: number; lost: string[]; differ: string[] }[]; submits: number; glError: number; width: number; height: number; pixels64: string | null };
async function replaySaved(trace: Uint8Array, read: number, at: number[]) {
  const r = await page.evaluate(([t, n, a]) => (window as unknown as { virgl: { replaySaved64(t: string, n: number, a: number[]): Saved } }).virgl.replaySaved64(t, n, a), [Buffer.from(trace).toString('base64'), read, at] as const);
  return { ...r, pixels: r.pixels64 ? new Uint8Array(Buffer.from(r.pixels64, 'base64')) : null };
}

for (const [name, file, read, at] of [['glcomp', 'glcomp-128x96.vglt', 3, [1, 3, 5]], ['sway', 'sway-640.vglt.gz', -1, [2, 10, 40, 100]]] as const) {
  test(`virgl snapshots on WebGL2: ${name} saved mid-trace and loaded into fresh renderers draws what it drew without, and saves again the same`, { timeout: 120_000 }, async () => {
    const plain = await replayOn(fixture(file), read);
    const r = await replaySaved(fixture(file), read, [...at]);
    console.log(`# ${name}: ${r.submits} submits, saves at ${at.join(', ')}: ${r.saves.map((s) => `${s.resources} resources, ${(s.bytes / 1024).toFixed(0)} KiB`).join('; ')}`);
    assert.equal(r.saves.length, at.length, `the trace has ${r.submits} submits`);
    assert.deepEqual(r.log, []);
    assert.equal(r.errors, 0);
    assert.equal(r.glError, 0);
    for (const s of r.saves) assert.deepEqual([s.lost, s.differ], [[], []]);
    assert.deepEqual([r.width, r.height], [plain.width, plain.height]);
    assert.ok(r.pixels && plain.pixels && Buffer.compare(r.pixels, plain.pixels) === 0, 'the same pixels as the replay without snapshots');
  });
}

test('virgl snapshots on WebGL2: every format\'s contents, as each kind of resource, are saved as they were loaded', { timeout: 120_000 }, async () => {
  const r = await page.evaluate(() => (window as unknown as { virgl: { snapshotFormats(): { checked: number; differ: string[]; lost: string[]; log: string[]; glError: number } } }).virgl.snapshotFormats());
  console.log(`# ${r.checked} resources; lost: ${r.lost.join('; ') || 'none'}`);
  assert.deepEqual(r.differ, []);
  assert.deepEqual(r.log, []);
  assert.equal(r.glError, 0);
});

test('virgl snapshots through the GPU worker: saved across its port, loaded into another, read back there', { timeout: 60_000 }, async () => {
  const r = await page.evaluate(() => (window as unknown as { virgl: { workerSnapshot(): Promise<{ read: (number[] | null)[]; want: number[][]; shape: unknown; again: unknown }> } }).virgl.workerSnapshot());
  assert.deepEqual(r.shape, { resources: [[5, [64], [{ off: 0, len: 64, mem: 0 }]], [6, [64], [{ off: 64, len: 64, mem: 0 }]]], objects: [[[['blend'], 0]]] });
  assert.deepEqual(r.read, r.want);
  assert.equal(r.again, 1);
});

test('virgl on WebGL2: a 2D scanout is drawn from the guest\'s bytes through its format\'s swizzle', async () => {
  // The guest's bytes of a pixel whose R, G, B are 30, 60, 90, in each of the eight formats' memory orders.
  const cases: [number, number[]][] = [[1, [90, 60, 30, 0]], [2, [90, 60, 30, 0]], [3, [0, 30, 60, 90]], [4, [0, 30, 60, 90]], [67, [30, 60, 90, 0]], [68, [0, 90, 60, 30]], [121, [0, 90, 60, 30]], [134, [30, 60, 90, 0]]];
  for (const [format, px] of cases) {
    const rgb = await page.evaluate(([f, p]) => (window as unknown as { virgl: { screen2d(f: number, p: number[]): Promise<number[]> } }).virgl.screen2d(f, p), [format, px] as const);
    assert.deepEqual(rgb, [30, 60, 90], `format ${format}`);
  }
});

test('a 2D machine\'s screen: WebGL2 gets the guest\'s bytes and swizzles them, the canvas 2D one RGBA; a lost context comes back drawn', async () => {
  const cases: [number, number[]][] = [[1, [90, 60, 30, 0]], [2, [90, 60, 30, 0]], [3, [0, 30, 60, 90]], [4, [0, 30, 60, 90]], [67, [30, 60, 90, 0]], [68, [0, 90, 60, 30]], [121, [0, 90, 60, 30]], [134, [30, 60, 90, 0]]];
  type Shown = { raw: boolean; first: number[]; restored?: number[] };
  for (const canvas2d of [false, true]) {
    for (const [format, px] of cases) {
      const r = await page.evaluate(([f, p, c]) => (window as unknown as { virgl: { presenter2d(f: number, p: number[], c: boolean, l: boolean): Promise<Shown> } }).virgl.presenter2d(f, p, c, false), [format, px, canvas2d] as const);
      assert.deepEqual(r, { raw: !canvas2d, first: [30, 60, 90] }, `format ${format}${canvas2d ? ', canvas 2D' : ''}`);
    }
  }
  const r = await page.evaluate(() => (window as unknown as { virgl: { presenter2d(f: number, p: number[], c: boolean, l: boolean): Promise<Shown> } }).virgl.presenter2d(1, [90, 60, 30, 0], false, true));
  assert.deepEqual(r, { raw: true, first: [30, 60, 90], restored: [30, 60, 90] });
});

test('virgl on WebGL2: occlusion queries open at once in two contexts, and in two sub-contexts, count their own draws, hold no fence and read back their states', async () => {
  // WebGL has one query active per target: a second begun fails, the next end ends the first, and the second's
  // result never comes, so every later fence was held for good (a KDE desktop's tasks hung in virtio_gpu_queue_ctrl_sgs).
  type Q = { state: number; result: number };
  const r = await page.evaluate(() => (window as unknown as { virgl: { overlappingQueries(): Promise<{ answered: string[]; contexts: Q[]; subs: Q[]; readBack: Q[]; log: string[]; glError: number }> } }).virgl.overlappingQueries());
  assert.deepEqual(r.answered, ['after'], `the fence after the queries is answered (${JSON.stringify(r)})`);
  assert.deepEqual(r.contexts, [{ state: 1, result: 0 }, { state: 1, result: 1 }], 'context 1 drew off its target, context 2 on it');
  assert.deepEqual(r.subs, [{ state: 1, result: 0 }, { state: 1, result: 1 }], 'sub-context 0 drew off the target, 1 on it');
  // Read back from the host, the states stay (a copy without them overwrote them: a GL_QUERY_RESULT wait spun for good).
  assert.deepEqual(r.readBack, [...r.contexts, ...r.subs], 'a transfer from the host keeps the states');
  assert.deepEqual(r.log, []);
  assert.equal(r.glError, 0);
});

test('virgl on WebGL2: a draw that samples what it draws into samples a copy (WebGL refuses the feedback loop GL draws)', async () => {
  type F = { level0: number[]; level1: number[]; layer0: number[]; layer1: number[]; copies: number; glError: number; log: string[] };
  const r = await page.evaluate(() => (window as unknown as { virgl: { feedbackDraws(): F } }).virgl.feedbackDraws());
  assert.equal(r.glError, 0, 'no draw refused');
  assert.deepEqual(r.log, []);
  assert.deepEqual(r.level0, [0, 0, 255, 255], 'level 0 drawn from its texels before the draw (red through BGRA: blue)');
  assert.deepEqual(r.level1, [0, 255, 0, 255], 'level 1 untouched');
  assert.deepEqual(r.layer0, [0, 255, 0, 255], 'layer 0 drawn from layer 1');
  assert.deepEqual(r.layer1, [0, 255, 0, 255]);
  assert.equal(r.copies, 2);
});

test('virgl on WebGL2: stream output captures interleaved, separate and mixed, appends, stops at a full buffer, counts what it wrote', async () => {
  const r = await page.evaluate(() => (window as unknown as { virgl: { streamOut(): { appended: number[]; emitted: number; overflowed: number[]; separate: number[][]; mixed: number[][]; log: string[]; glError: number } } }).virgl.streamOut());
  assert.deepEqual([r.log, r.glError], [[], 0]);
  // Vertex k is (4k+1, 4k+2, 4k+3, 4k+4); captured: its position, then its generic's .yz (twice the input's).
  const pos = (k: number) => [4 * k + 1, 4 * k + 2, 4 * k + 3, 4 * k + 4];
  const gen = (k: number) => [2 * (4 * k + 2), 2 * (4 * k + 3)];
  const vertices = (ks: number[]) => ks.flatMap((k) => [...pos(k), ...gen(k)]);
  const pad = (a: number[], n: number) => [...a, ...new Array(n - a.length).fill(0)];
  assert.deepEqual(r.appended, pad(vertices([0, 1, 2, 3, 4, 5, 6, 7]), 60), '3 points, 2 appended, a triangle');
  assert.equal(r.emitted, 6, 'PRIMITIVES_EMITTED');
  assert.deepEqual(r.overflowed, vertices([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 'rebound: written from the start, 10 of 12 fit');
  assert.deepEqual(r.separate, [pad([...pos(1), ...pos(2)], 16), pad([...gen(1), ...gen(2)], 16)]);
  // dEQP's layouts: two outputs in one buffer, the words between and after them untouched (-1).
  const w = (k: number) => [-1, ...gen(k), 2 * (4 * k + 4), -1];
  assert.deepEqual(r.mixed, [pad([...pos(1), ...pos(2)], 16), [...w(1), ...w(2), ...new Array(10).fill(-1)]]);
});

const ALPINE_VIRGL = new URL('../target/images/alpine-virgl/rootfs-virgl.ext4', import.meta.url);
test('virgl on WebGL2: glcomp in a guest, rendered in the GPU worker, reads back what llvmpipe drew', { skip: !existsSync(ALPINE_VIRGL) && 'images/build.sh alpine-gl alpine-virgl' }, async () => {
  const p = await browser.newPage();
  await p.goto(`${base}/tests/browser/virgl-boot.html?dump`);
  const r = await (await p.waitForFunction(() => (window as unknown as { result?: unknown }).result, null, { timeout: 240_000, polling: 250 })).jsonValue() as { error?: string; console: string };
  await p.close();
  assert.equal(r.error, undefined);
  assert.match(r.console, /glcomp: virgl \(webpc\), OpenGL ES 3\.0/);
  const rows = [...r.console.matchAll(/glcomp: px (\d+) ([0-9a-f]+)/g)];
  assert.equal(rows.length, 96);
  const c = compare(new Uint8Array(Buffer.concat(rows.map((m) => Buffer.from(m[2], 'hex')))), fixture('glcomp-128x96.llvmpipe.rgba'), 2);
  assert.ok(c.max <= 8 && c.mean < 1.5, JSON.stringify(c));
});
