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

let browser: Browser;
let page: Page;
let base: string;
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

type VideoReplay = { hashes: string[]; stats: { frames: number; decoded: number; dropped: number; errors: number }; ahead: number; maxWaitMs: number; hardware: number[]; log: string[]; ms: number; orig: { hashes: string[]; errors: string[] } | null };
async function replayVideo(name: string, orig?: string): Promise<VideoReplay> {
  const ref = videoRef();
  return page.evaluate(([t, w, h, o]) => (window as unknown as { virgl: { replayVideo64(t: string, w: number, h: number, o?: string): Promise<VideoReplay> } }).virgl.replayVideo64(t, w, h, o),
    [Buffer.from(fixture(name)).toString('base64'), ref.width, ref.height, orig && Buffer.from(fixture(orig)).toString('base64')] as const);
}
/** FFmpeg's frames of the original files (bench/video/fixture.ts): SHA-256 of each visible I420, in display order. */
const videoRef = () => JSON.parse(readFileSync(new URL('virgl/video.json', import.meta.url), 'utf8')) as { width: number; height: number; pictures: number; h264: string[]; vp9: string[] };

test('video on WebGL2: VP9 pictures through the device and WebCodecs into their planes, each FFmpeg\'s frame', async () => {
  const ref = videoRef();
  const r = await replayVideo('video-vp9.vglt.gz');
  assert.deepEqual(r.log, []);
  assert.deepEqual(r.stats, { ...r.stats, frames: ref.pictures, decoded: ref.pictures, dropped: 0, errors: 0 });
  // Shown in decode order (none hidden in these): each picture the original's frame, exactly.
  const wrong = r.hashes.flatMap((h, k) => (h === ref.vp9[k] ? [] : [k]));
  assert.equal(wrong.length, 0, `pictures ${wrong.join(' ')} differ from FFmpeg's`);
});

test('video on WebGL2: H.264 pictures through the device and WebCodecs into their planes, as the original decodes', async () => {
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
