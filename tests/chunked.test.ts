// Chunked images (web/chunked.ts, tools/chunk-image.ts): an image cut into content-addressed pieces reads back as the
// file, from a host with byte ranges and from one that answers a range with the whole piece (Cloudflare Pages), under
// the block cache too; the manifest's id follows the content. In Chromium, Buildroot boots with its root on a chunked
// image in the whole file's exact steps, and the URL check takes a manifest.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { cachedSource } from '../web/blockcache.ts';
import { chunkedSource, type Manifest, type SyncGet } from '../web/chunked.ts';
import { STEPS } from './steps.ts';

const MiB = 1 << 20;
const TOOL = new URL('../tools/chunk-image.ts', import.meta.url).pathname;
const cut = (image: string, out: string, mib = 1) => execFileSync(process.execPath, [TOOL, image, out, String(mib)], { stdio: 'pipe' });

/** A host serving `dir` at http://h/: ranges answered with 206, or (`ranges` false) every GET with the whole file. */
const host = (dir: string, ranges: boolean) => {
  const gets: { path: string; range?: string }[] = [];
  const get: SyncGet = (url, range) => {
    const path = new URL(url).pathname;
    gets.push({ path, range });
    const file = join(dir, path);
    if (!existsSync(file)) return { status: 404 };
    const b = new Uint8Array(readFileSync(file));
    const m = ranges && range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
    return m ? { status: 206, body: b.slice(+m[1], +m[2] + 1) } : { status: 200, body: b };
  };
  return { get, gets };
};

let tmp: string;
/** 4.5 MiB: pseudo-random, but its second and fourth MiB zeros (one piece file for both). */
let image: Uint8Array;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'chunked-'));
  image = new Uint8Array(4.5 * MiB);
  let x = 1;
  for (let i = 0; i < image.length; i++) image[i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24;
  image.fill(0, MiB, 2 * MiB).fill(0, 3 * MiB, 4 * MiB);
  writeFileSync(join(tmp, 'disk.img'), image);
  cut(join(tmp, 'disk.img'), join(tmp, 'out'));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const same = (a: Uint8Array | undefined, off: number, len: number, what: string) =>
  assert.ok(a && Buffer.compare(a, image.subarray(off, off + len)) === 0, `${what}: ${off}+${len} differs`);

test('the tool cuts content-addressed pieces and a manifest', () => {
  const m = JSON.parse(readFileSync(join(tmp, 'out/manifest.json'), 'utf8')) as Manifest;
  assert.deepEqual([m.size, m.piece, m.hashes.length], [image.length, MiB, 5]);
  assert.equal(m.hashes[1], m.hashes[3]); // the zero pieces
  assert.equal(readdirSync(join(tmp, 'out/pieces')).length, 4);
  // The id follows the content: one byte changed, another id; the same bytes cut again, the same id.
  cut(join(tmp, 'disk.img'), join(tmp, 'again'));
  assert.equal((JSON.parse(readFileSync(join(tmp, 'again/manifest.json'), 'utf8')) as Manifest).id, m.id);
  const changed = image.slice();
  changed[3 * MiB + 5] = 1;
  writeFileSync(join(tmp, 'changed.img'), changed);
  cut(join(tmp, 'changed.img'), join(tmp, 'changed'));
  assert.notEqual((JSON.parse(readFileSync(join(tmp, 'changed/manifest.json'), 'utf8')) as Manifest).id, m.id);
  // The name the page shows: the image's file name, or `--name`'s (the id doesn't change).
  assert.equal(m.name, 'disk.img');
  execFileSync(process.execPath, [TOOL, join(tmp, 'disk.img'), join(tmp, 'named'), '1', '--name', 'Desktop Demo'], { stdio: 'pipe' });
  const named = JSON.parse(readFileSync(join(tmp, 'named/manifest.json'), 'utf8')) as Manifest;
  assert.deepEqual([named.name, named.id], ['Desktop Demo', m.id]);
});

for (const ranges of [true, false]) {
  test(`a chunked image reads as its file, from a host ${ranges ? 'with' : 'without'} byte ranges`, () => {
    const h = host(join(tmp, 'out'), ranges);
    const src = chunkedSource('http://h/manifest.json', h.get);
    assert.equal(src.size, image.length);
    let seed = 3;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
    for (let i = 0; i < 300; i++) {
      const off = rnd(image.length);
      const len = Math.min(image.length - off, rnd(1.5 * MiB) + 1); // across pieces too
      same(src.read(off, len), off, len, 'direct');
    }
    same(src.read(0, image.length), 0, image.length, 'the whole file');
    assert.equal(src.read(image.length - 10, 20), undefined);
    assert.equal(src.ranges(), ranges);
  });
}

test('without ranges, the block cache above takes whole pieces: each fetched once', () => {
  const h = host(join(tmp, 'out'), false);
  const c = cachedSource(chunkedSource('http://h/manifest.json', h.get), { block: MiB / 4, bytes: 8 * MiB });
  let seed = 5;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
  for (let i = 0; i < 300; i++) {
    const off = rnd(image.length);
    const len = Math.min(image.length - off, rnd(MiB) + 1);
    same(c.read(off, len), off, len, 'cached, no ranges');
  }
  const pieces = h.gets.filter((g) => g.path.endsWith('.bin'));
  assert.ok(pieces.length <= 6, `${pieces.length} piece fetches`); // five pieces, and the first read's, before the host was known
});

test('the block cache over a chunked image', () => {
  const h = host(join(tmp, 'out'), true);
  const c = cachedSource(chunkedSource('http://h/manifest.json', h.get), { block: MiB / 4, bytes: 2 * MiB });
  for (let off = 0; off + 70_000 <= image.length; off += 33_333) same(c.read(off, 70_000), off, 70_000, 'cached');
  assert.equal(c.stats.fetched, image.length - 0); // every block once: the reads go forward
});

test('tools/disk-trace.ts: a run\'s reads, up to a mark, as 1 MiB blocks in first-read order, the id unchanged', () => {
  // t (ms), offset, length, ms: reads at 3.5 MiB, 0, 3.9 MiB (over two blocks), 0 again, then after the mark.
  const run = { marks: { login: 50, painted: 100 }, io: { trace: [1, 3.5 * MiB, 100, 1, 2, 0, 512, 1, 3, 3.9 * MiB, 0.2 * MiB, 1, 4, 10, 10, 1, 120, 2 * MiB, 10, 1] } };
  writeFileSync(join(tmp, 'run.json'), JSON.stringify(run));
  const tool = new URL('../tools/disk-trace.ts', import.meta.url).pathname;
  execFileSync(process.execPath, [tool, join(tmp, 'run.json'), join(tmp, 'out/manifest.json'), join(tmp, 'out/prefetch.json')], { stdio: 'pipe' });
  const m = JSON.parse(readFileSync(join(tmp, 'out/manifest.json'), 'utf8')) as Manifest;
  const p = JSON.parse(readFileSync(join(tmp, 'out/prefetch.json'), 'utf8')) as Manifest;
  assert.deepEqual([p.id, p.prefetch], [m.id, { block: MiB, blocks: [3, 0, 4] }]);
  execFileSync(process.execPath, [tool, join(tmp, 'run.json'), join(tmp, 'out/manifest.json'), join(tmp, 'out/early.json'), '--until', 'login'], { stdio: 'pipe' });
  assert.deepEqual((JSON.parse(readFileSync(join(tmp, 'out/early.json'), 'utf8')) as Manifest).prefetch!.blocks, [3, 0, 4]);
  // Past the mark: the read at 120 ms (block 2) is left out either way; with no `--until`, the last mark (100) bounds it.
});

test('a malformed manifest or a missing piece is refused', () => {
  const h = host(join(tmp, 'out'), true);
  writeFileSync(join(tmp, 'out/bad.json'), JSON.stringify({ format: 'webpc-chunked-1', size: 10, piece: MiB, pieces: 'x', hashes: [] }));
  assert.throws(() => chunkedSource('http://h/bad.json', h.get), /malformed/);
  writeFileSync(join(tmp, 'out/other.json'), JSON.stringify({ format: 'something' }));
  assert.throws(() => chunkedSource('http://h/other.json', h.get), /not a chunked image/);
  const m = JSON.parse(readFileSync(join(tmp, 'out/manifest.json'), 'utf8')) as Manifest;
  writeFileSync(join(tmp, 'out/gone.json'), JSON.stringify({ ...m, hashes: m.hashes.map((x, i) => (i === 2 ? '0'.repeat(64) : x)) }));
  const src = chunkedSource('http://h/gone.json', h.get);
  assert.equal(src.read(2 * MiB + 10, 100), undefined);
  same(src.read(10, 100), 10, 100, 'a piece that is there');
});

// Chromium: a deterministic boot with its root on the chunked Buildroot rootfs, and the URL check of a manifest.
const ROOTFS = new URL('../target/images/buildroot/rootfs.ext4', import.meta.url).pathname;
const CHUNKED = new URL('../target/images/chunked-buildroot/', import.meta.url).pathname;
let browser: Browser | undefined;
let base = '';
let close = () => {};
after(async () => { await browser?.close(); close(); });
const chromiumReady = async () => {
  if (browser) return;
  rmSync(CHUNKED, { recursive: true, force: true });
  cut(ROOTFS, CHUNKED);
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
};

test('Linux boots with its root on a chunked image, in the whole file\'s steps (JIT, deterministic)', { skip: !existsSync(ROOTFS) && 'SKIPPED: run images/build.sh' }, async () => {
  await chromiumReady();
  const page = await browser!.newPage();
  await page.goto(`${base}/tests/browser/boot.html?jit=1&disk=chunked-buildroot/manifest.json`);
  const h = await page.waitForFunction(() => (window as never)['result'], null, { timeout: 10 * 60_000, polling: 1000 });
  const r = (await h.jsonValue()) as { error?: string; kind: number; x0: string; steps: number; console: string };
  await page.close();
  assert.equal(r.error, undefined);
  assert.deepEqual([r.kind, r.x0, r.steps], [1, '0x84000008', STEPS.buildroot], r.console);
  assert.match(r.console.replaceAll('\r\n', '\n'), /vda magic: 53ef\nwebpc: test ok\n/);
});

test('the URL check takes a chunked image\'s manifest, with its id as the identity', { skip: !existsSync(ROOTFS) && 'SKIPPED: run images/build.sh' }, async () => {
  await chromiumReady();
  const page = await browser!.newPage();
  await page.goto(`${base}/tests/browser/core.html`);
  const r = await page.evaluate(async (url) => {
    const { checkUrl } = await import('/web/app/urlcheck.ts' as string);
    const c = await checkUrl(url);
    return { ok: c.ok, problems: c.problems, bytes: c.bytes, etag: c.etag, head: c.head?.length };
  }, `${base}/target/images/chunked-buildroot/manifest.json`);
  const m = JSON.parse(readFileSync(join(CHUNKED, 'manifest.json'), 'utf8')) as Manifest;
  assert.deepEqual(r, { ok: true, problems: [], bytes: m.size, etag: m.id, head: 512 });
  await page.close();
});
