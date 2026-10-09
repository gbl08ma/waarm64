// The virgl renderer on Chromium's WebGL2 (headless: SwiftShader; docs/testing.md "virgl"): every program the
// translator makes from the TGSI corpus compiles and links; glcomp's trace draws what llvmpipe drew (within a
// tolerance: filtering and blending round differently); sway's trace draws its desktop as it did when it was
// recorded (a regression reference made by this renderer, tests/virgl/sway-640.scanout.gz). And a guest end to end
// on a 3D machine as the page makes one: alpine-virgl's glcomp with the renderer in the GPU worker, its frame read
// back by the guest through the renderer.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';

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
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
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
