// The qcow2 reader (web/qcow2.ts) against qemu-img's fixtures (tests/qcow2/make.sh).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { constants, inflateRawSync } from 'node:zlib';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { inflateEach, openDisk, type Inflater } from '../web/qcow2.ts';

const file = (name: string) => readFileSync(new URL(`./qcow2/${name}`, import.meta.url));
const open = (name: string) => {
  const b = file(name);
  return openDisk((off, len) => (off + len <= b.length ? new Uint8Array(b.buffer, b.byteOffset + off, len) : undefined), b.length);
};
const data = file('data.raw');

for (const [name, format] of [['v2.qcow2', 'qcow2'], ['v3.qcow2', 'qcow2'], ['deflate.qcow2', 'qcow2'], ['data.raw', 'raw']] as const) {
  test(`${name} reads as data.raw`, async () => {
    const d = open(name);
    assert.deepEqual([d.format, d.size], [format, data.length]);
    assert.deepEqual(await d.read(0, data.length), new Uint8Array(data));
    // Unaligned reads across cluster boundaries and through every kind of cluster.
    for (let off = 0; off < data.length; off += 3001) {
      const len = Math.min(9000, data.length - off);
      assert.deepEqual(await d.read(off, len), new Uint8Array(data.subarray(off, off + len)), `at ${off}`);
    }
    assert.equal(await d.read(data.length - 512, 1024), undefined);
  });
}

for (const [name, why] of [
  ['reject-backing.qcow2', /backing files/],
  ['reject-zstd.qcow2', /zstd/],
  ['reject-extl2.qcow2', /extended L2/],
  ['reject-datafile.qcow2', /external data/],
  ['reject-luks.qcow2', /encrypted/],
] as const) {
  test(`${name} is refused at open`, () => assert.throws(() => open(name), why));
}

// A request over many clusters reads the file in a few pieces, not one per cluster (the page's
// disk is read with one HTTP request per piece), and gives the same bytes as cluster by cluster.
for (const name of ['v3.qcow2', 'deflate.qcow2'] as const) {
  test(`${name}: a read over the whole disk merges its host reads, and a failed merged read falls back`, async () => {
    const b = file(name);
    let reads: number[] = [];
    let refuse = Infinity; // reads of this many bytes or more fail
    const d = openDisk((off, len) => {
      reads.push(len);
      return off + len <= b.length && len < refuse ? new Uint8Array(b.buffer, b.byteOffset + off, len) : undefined;
    }, b.length);
    // Sector by sector first: every cluster on its own.
    const each = new Uint8Array(data.length);
    for (let off = 0; off < data.length; off += 512) each.set((await d.read(off, 512))!, off);
    assert.ok(Buffer.compare(each, data) === 0);
    const single = reads.length;
    reads = [];
    const all = await openDisk((off, len) => { reads.push(len); return new Uint8Array(b.buffer, b.byteOffset + off, len); }, b.length).read(0, data.length);
    assert.ok(all && Buffer.compare(all, data) === 0);
    assert.ok(reads.length <= 10 && reads.length < single / 4, `${reads.length} host reads for the whole disk, ${single} sector by sector`);
    // The merged read fails (a server that refuses long ranges): each range is read on its own.
    refuse = Math.max(...reads);
    const again = openDisk((off, len) => (off + len <= b.length && len < refuse ? new Uint8Array(b.buffer, b.byteOffset + off, len) : undefined), b.length);
    const slow = await again.read(0, data.length);
    assert.ok(slow && Buffer.compare(slow, data) === 0);
  });
}

/**
 * A raw-deflate DecompressionStream that behaves as Firefox's does: a write holding bytes past the
 * stream's end errors the stream and loses the output that write produced (Chromium's hands it over
 * first). Built on zlib, which says how much of its input the stream used.
 */
class FirefoxDecompressionStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor() {
    let input = Buffer.alloc(0);
    let sent = 0;
    super({
      transform(chunk, c) {
        input = Buffer.concat([input, chunk]);
        const r = inflateRawSync(input, { finishFlush: constants.Z_SYNC_FLUSH, info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        if (r.engine.bytesWritten < input.length) throw new TypeError('Unexpected input after the end of stream');
        c.enqueue(new Uint8Array(r.buffer.subarray(sent)));
        sent = r.buffer.length;
      },
    });
  }
}

test('deflate.qcow2 reads as data.raw where the stream drops the output of a write with junk (Firefox)', async () => {
  const real = globalThis.DecompressionStream;
  globalThis.DecompressionStream = FirefoxDecompressionStream as unknown as typeof DecompressionStream;
  try {
    const all = await open('deflate.qcow2').read(0, data.length);
    assert.ok(all && Buffer.compare(all, data) === 0, 'deflate.qcow2 under Firefox\'s stream differs from data.raw');
  } finally {
    globalThis.DecompressionStream = real;
  }
});

// A request's compressed clusters go to the inflater together, once (web/inflate-pool.ts spreads
// them over threads), and one that doesn't unpack fails the request.
test('deflate.qcow2: a request inflates its compressed clusters in one batch', async () => {
  const b = file('deflate.qcow2');
  const batches: number[] = [];
  let spoil = false; // the inflater loses the last cluster of a batch
  const inflater: Inflater = async (inputs, size) => {
    batches.push(inputs.length);
    const out = await inflateEach(inputs, size);
    if (spoil) out[out.length - 1] = undefined;
    return out;
  };
  const d = openDisk((off, len) => (off + len <= b.length ? new Uint8Array(b.buffer, b.byteOffset + off, len) : undefined), b.length, inflater);
  const all = await d.read(0, data.length);
  assert.ok(all && Buffer.compare(all, data) === 0, 'deflate.qcow2 read in one request differs from data.raw');
  assert.deepEqual(batches, [16]); // clusters 24-39, the compressible text
  // Cached: the last 16 aren't inflated again.
  const again = await d.read(24 * 4096, 16 * 4096);
  assert.ok(again && Buffer.compare(again, data.subarray(24 * 4096, 40 * 4096)) === 0);
  assert.deepEqual(batches, [16]);
  spoil = true;
  const fresh = openDisk((off, len) => new Uint8Array(b.buffer, b.byteOffset + off, len), b.length, inflater);
  assert.equal(await fresh.read(0, data.length), undefined);
});

let browser: Browser | undefined;
let base = '';
let close = () => {};
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close(); });

test('deflate.qcow2 through the inflate pool in Chromium: workers take shares, and a closed pool inflates on its own thread', async () => {
  const page = await browser!.newPage();
  await page.goto(`${base}/tests/browser/core.html`);
  const r = await page.evaluate(async () => {
    const { openDisk } = await import('/web/qcow2.ts' as string);
    const { inflatePool } = await import('/web/inflate-pool.ts' as string);
    const bytes = async (u: string) => new Uint8Array(await (await fetch(u)).arrayBuffer());
    const [img, raw] = [await bytes('/tests/qcow2/deflate.qcow2'), await bytes('/tests/qcow2/data.raw')];
    const same = (a?: Uint8Array) => !!a && a.length === raw.length && a.every((x, k) => x === raw[k]);
    const at = (off: number, len: number) => (off + len <= img.length ? img.subarray(off, off + len) : undefined);
    const pool = inflatePool(3);
    const pooled = same(await openDisk(at, img.length, pool).read(0, raw.length));
    const sent = pool.sent;
    pool.close();
    const closed = same(await openDisk(at, img.length, pool).read(0, raw.length));
    return { pooled, sent, closed, after: pool.sent };
  });
  await page.close();
  // 16 clusters over this thread and three workers: 4 each.
  assert.deepEqual(r, { pooled: true, sent: 12, closed: true, after: 12 });
});

test('a qcow2 read through `readAsync` (several requests at once, answers in any order) reads as data.raw', async () => {
  let seed = 11;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
  for (const name of ['v2.qcow2', 'v3.qcow2', 'deflate.qcow2', 'data.raw']) {
    const b = file(name);
    const at = (off: number, len: number) => (off + len <= b.length ? new Uint8Array(b.buffer, b.byteOffset + off, len) : undefined);
    let reads = 0;
    const d = openDisk(at, b.length, inflateEach, async (off, len) => {
      reads++;
      await new Promise((r) => setTimeout(r, rnd(3)));
      return at(off, len);
    });
    const jobs = Array.from({ length: 60 }, () => {
      const off = rnd(data.length);
      const len = Math.min(data.length - off, rnd(40_000) + 1);
      return d.read(off, len).then((got) => assert.ok(got && Buffer.compare(got, data.subarray(off, off + len)) === 0, `${name} at ${off}+${len}`));
    });
    await Promise.all(jobs);
    assert.ok(reads > 0, `${name}: read through readAsync`);
  }
});
