// The snapshot file container (web/snapshot-file.ts): CRC-32 against zlib's, round trips of every
// frame kind (CORE and DEVS past 1 MiB, RAM with zero, random and compressible pages and a partial
// last chunk from a shared-memory view, DISK runs and gaps), the reader fed 1-byte, random-sized and
// Blob input, every refusal, truncation at every prefix and a flipped bit at every byte of a small
// file, the stored codec for incompressible data, and a pluggable codec. Node only, no core.
import assert from 'node:assert/strict';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { test } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { readSnapshot, writeSnapshot } from '../web/snapshot.ts';
import type { Vm } from '../web/vm.ts';
import {
  applyRam, crc32, deflateCodec, diskBlocks, openSnapshot, SnapshotError, SnapshotWriter,
  type Codec, type SnapshotHeader,
} from '../web/snapshot-file.ts';

const MiB = 1 << 20;
const HEADER: SnapshotHeader = { format: 1, coreVersion: 3, abi: 30, created: '2026-10-01T00:00:00Z', machine: { ram: 1 } };

/** xorshift32: fast, seeded random bytes. */
function random(n: number, seed: number) {
  const out = new Uint8Array(n);
  let s = seed | 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    out[i] = s & 255;
  }
  return out;
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

type Frame = { tag: string; index: number; data: Uint8Array };
type Content = { core?: Uint8Array; devs?: Uint8Array; ram?: Uint8Array; disk?: { block: number; data: Uint8Array }[] };

async function write(c: Content, opts: { codec?: Codec; concurrency?: number } = {}) {
  const parts: Uint8Array[] = [];
  const w = new SnapshotWriter((b) => { parts.push(b.slice()); }, HEADER, opts);
  if (c.core) await w.bytes('CORE', c.core);
  if (c.devs) await w.bytes('DEVS', c.devs);
  const ram = c.ram ? await w.ram(c.ram) : undefined;
  const disk = c.disk ? await w.disk(c.disk) : undefined;
  const end = await w.end();
  const file = concat(parts);
  assert.equal(end.bytes, file.length);
  return { file, end, ram, disk };
}

function streamOf(file: Uint8Array, sizes: (i: number) => number) {
  let at = 0;
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (at >= file.length) return ctl.close();
      const n = Math.max(1, sizes(i++));
      ctl.enqueue(file.slice(at, at + n));
      at += n;
    },
  });
}
const whole = (f: Uint8Array) => streamOf(f, () => f.length);

async function readAll(src: ReadableStream<Uint8Array> | Blob, opts?: { codecs?: Codec[] }) {
  const s = await openSnapshot(src, opts);
  const frames: Frame[] = [];
  for await (const f of s.frames()) frames.push(f);
  return { header: s.header, frames };
}

/** Restores what a file holds into fresh buffers. */
async function restore(src: ReadableStream<Uint8Array> | Blob, ramSize: number, opts?: { codecs?: Codec[] }) {
  const { header, frames } = await readAll(src, opts);
  const core: Uint8Array[] = [];
  const devs: Uint8Array[] = [];
  const ram = new Uint8Array(ramSize);
  const disk = new Map<number, Uint8Array>();
  for (const f of frames) {
    if (f.tag === 'CORE') core.push(f.data);
    else if (f.tag === 'DEVS') devs.push(f.data);
    else if (f.tag === 'RAM ') applyRam(ram, f.index, f.data);
    else if (f.tag === 'DISK') for (const b of diskBlocks(f.index, f.data)) disk.set(b.block, b.data.slice());
  }
  return { header, core: concat(core), devs: concat(devs), ram, disk, frames };
}

/** Byte equality that fails small: the first differing offset, never a diff of two big arrays (assert.deepEqual on RAM-sized buffers builds one and can exhaust memory). */
function sameBytes(actual: Uint8Array, expected: Uint8Array, what: string) {
  if (actual.length !== expected.length) assert.fail(`${what}: length ${actual.length}, expected ${expected.length}`);
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) assert.fail(`${what}: byte ${i} is ${actual[i]}, expected ${expected[i]}`);
  }
}

async function refused(p: Promise<unknown>, problem: SnapshotError['problem'], msg?: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof SnapshotError, `not a SnapshotError: ${e}`);
    assert.equal(e.problem, problem, e.message);
    if (msg) assert.match(e.message, msg);
    return true;
  });
}

/** A mixed RAM image: zero pages, random, compressible, an all-zero chunk, a partial last chunk. */
function makeRam(size: number) {
  const ram = new Uint8Array(size);
  for (let p = 0; p < size / 4096; p++) {
    const chunk = Math.floor(p / 256);
    if (chunk === 1) continue; // an all-zero chunk
    const kind = (p * 7 + chunk) % 5;
    const page = ram.subarray(p * 4096, (p + 1) * 4096);
    if (kind === 1) page.set(random(4096, p + 1));
    else if (kind === 2) page.fill(p & 255 || 1);
    else if (kind === 3) page[4095] = 1; // zero but for the last byte
    else if (kind === 4) page[(p * 13) % 4096] = 0xff;
  }
  return ram;
}

test('crc32 matches zlib and the check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  for (const n of [1, 7, 8, 9, 15, 16, 17, 1000, 65537]) {
    const b = random(n, n);
    assert.equal(crc32(b), zlibCrc32(b), `length ${n}`);
    assert.equal(crc32(b.subarray(1)), zlibCrc32(b.subarray(1)), `unaligned ${n}`);
    const k = n >> 1;
    assert.equal(crc32(b.subarray(k), crc32(b.subarray(0, k))), zlibCrc32(b), `seeded ${n}`);
  }
});

test('round trip: header, CORE and DEVS past 1 MiB, RAM, DISK', async () => {
  const core = random(2 * MiB + 12345, 1);
  const devs = new TextEncoder().encode(JSON.stringify({ rng: 'x'.repeat(MiB + 5) }));
  const size = 5 * MiB + 64 * 1024; // a partial last chunk (16 pages)
  const backing = new SharedArrayBuffer(size + 8192);
  const view = new Uint8Array(backing, 4096, size); // a view at a non-zero offset
  view.set(makeRam(size));
  const disk: { block: number; data: Uint8Array }[] = [];
  for (let b = 10; b < 10 + 600; b++) disk.push({ block: b, data: random(4096, b) }); // longer than 256, a run of 3 frames
  for (const b of [700, 701, 703, 1_000_000]) disk.push({ block: b, data: new Uint8Array(4096).fill(b & 255) });
  const { file, ram, disk: d } = await write({ core, devs, ram: view, disk });
  assert.equal(d!.blocks, 604);
  assert.ok(ram!.pages > 0);
  assert.equal(Math.max(...(await readAll(whole(file))).frames.filter((f) => f.tag === 'DISK').map((f) => f.data.length)), 256 * 4096);
  const r = await restore(whole(file), size);
  assert.deepEqual(r.header, HEADER);
  sameBytes(r.core, core, 'core');
  sameBytes(r.devs, devs, 'devs');
  sameBytes(r.ram, new Uint8Array(view), 'ram'); // the copy of the shared view
  assert.equal(r.disk.size, 604);
  for (const x of disk) sameBytes(r.disk.get(x.block)!, x.data, `block ${x.block}`);
  assert.equal(r.frames.filter((f) => f.tag === 'RAM ' && f.index === 1).length, 0, 'the all-zero chunk has no frame');
  assert.equal(r.frames.filter((f) => f.tag === 'CORE').length, 3);
  assert.equal(r.frames.filter((f) => f.tag === 'DISK').map((f) => f.index).join(), '10,266,522,700,703,1000000');
});

test('RAM at an unaligned view offset, and all-zero RAM, round trip', async () => {
  const size = 3 * 65536;
  const raw = new Uint8Array(size + 3);
  const view = raw.subarray(3);
  view.set(makeRam(size));
  const { file } = await write({ ram: view });
  sameBytes((await restore(whole(file), size)).ram, view.slice(), 'ram');
  const zero = await write({ ram: new Uint8Array(2 * MiB) });
  assert.equal((await readAll(whole(zero.file))).frames.length, 0);
  assert.equal(zero.end.frames, 0);
});

test('RAM past 2 GiB: its pages are seen (byte offsets past 2^31)', async () => {
  // Untouched pages of a fresh buffer cost no memory: only the two written ones do.
  const ram = new Uint8Array(2 * 1024 * MiB + MiB);
  ram[5] = 1;
  ram[ram.length - 4096 + 7] = 2;
  const { file, ram: r } = await write({ ram });
  assert.equal(r!.pages, 2);
  const frames = (await readAll(whole(file))).frames.filter((f) => f.tag === 'RAM ');
  assert.deepEqual(frames.map((f) => f.index), [0, 2048]);
});

test('the reader takes any chunking: 1 byte, random sizes, a Blob', async () => {
  const core = random(300_000, 3);
  const size = 2 * MiB + 4096 * 5;
  const ram = makeRam(size);
  const { file } = await write({ core, ram, disk: [{ block: 4, data: random(4096, 4) }] });
  const want = await restore(whole(file), size);
  const check = async (src: ReadableStream<Uint8Array> | Blob) => {
    const r = await restore(src, size);
    sameBytes(r.core, core, 'core');
    sameBytes(r.ram, want.ram, 'ram');
    assert.deepEqual([...r.disk.keys()], [...want.disk.keys()]);
    for (const [k, v] of want.disk) sameBytes(r.disk.get(k)!, v, `block ${k}`);
  };
  // 1-byte chunks over a whole 2 MiB file are slow: use a smaller one for them.
  const small = await write({ core: random(5000, 9), ram: makeRam(65536), disk: [{ block: 1, data: random(4096, 1) }] });
  const r1 = await restore(streamOf(small.file, () => 1), 65536);
  sameBytes(r1.core, random(5000, 9), 'core');
  sameBytes(r1.ram, makeRam(65536), 'ram');
  let s = 12345;
  await check(streamOf(file, () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return 1 + (s % 70000); }));
  await check(streamOf(file, () => 33 * MiB));
  await check(new Blob([file]));
});

test('the writer bounds what is in flight and keeps frames in order', async () => {
  let active = 0;
  let peak = 0;
  const slow: Codec = {
    id: 2,
    async compress(raw) { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5 - Math.min(4, raw.length >> 18))); active--; return raw.subarray(0, raw.length >> 1); },
    async decompress(stored, n) { const out = new Uint8Array(n); out.set(stored); return out; },
  };
  const core = new Uint8Array(20 * MiB);
  const { file } = await write({ core }, { codec: slow, concurrency: 3 });
  assert.ok(peak <= 3 && peak >= 2, `peak ${peak}`);
  const frames = (await readAll(whole(file), { codecs: [slow] })).frames;
  assert.deepEqual(frames.map((f) => f.index), Array.from({ length: 20 }, (_, i) => i));
});

test('incompressible data is stored (codec 0), compressible is deflated', async () => {
  const { file } = await write({ core: random(1000, 5) });
  const codecOf = (f: Uint8Array) => new DataView(f.buffer, f.byteOffset).getUint32(16 + JSON.stringify(HEADER).length + 4 + 4, true);
  assert.equal(codecOf(file), 0);
  const z = await write({ core: new Uint8Array(1000) });
  assert.equal(codecOf(z.file), 1);
  assert.ok(z.file.length < file.length);
});

test('a pluggable codec (id 2) round trips, and an unknown one is refused', async () => {
  // A toy run codec: bytes as-is but each byte doubled-free: just reverse, which shrinks nothing, so shrink by dropping a zero tail.
  const tail: Codec = {
    id: 2,
    async compress(raw) { let n = raw.length; while (n && raw[n - 1] === 0) n--; return raw.slice(0, n); },
    async decompress(stored, rawLen) { const out = new Uint8Array(rawLen); out.set(stored); return out; },
  };
  const core = new Uint8Array(5000); core.set([1, 2, 3]);
  const { file } = await write({ core }, { codec: tail });
  const r = await restore(whole(file), 65536, { codecs: [tail] });
  sameBytes(r.core, core, 'core');
  assert.ok(file.length < 400);
  await refused(readAll(whole(file)), 'corrupt', /codec 2/);
});

test('refusals: not a snapshot, a newer format, truncated, corrupt', async () => {
  const { file } = await write({ core: random(3000, 1), ram: makeRam(65536), disk: [{ block: 2, data: random(4096, 2) }] });
  const dv = (f: Uint8Array) => new DataView(f.buffer, f.byteOffset, f.length);
  await refused(openSnapshot(whole(new TextEncoder().encode('SQLite format 3\0 and a long tail of text'))), 'not-snapshot');
  await refused(openSnapshot(whole(new Uint8Array(0))), 'not-snapshot');
  await refused(openSnapshot(whole(file.slice(0, 5))), 'not-snapshot');
  const newer = file.slice(); dv(newer).setUint32(8, 3, true);
  await refused(openSnapshot(whole(newer)), 'newer-format', /newer version/);
  const old = file.slice(); dv(old).setUint32(8, 0, true);
  await refused(openSnapshot(whole(old)), 'corrupt');
  const hl = dv(file).getUint32(12, true);
  const frames0 = 16 + hl + 4;
  const trunc = file.slice(0, file.length - 10);
  await refused(readAll(whole(trunc)), 'truncated', /incomplete.*again/s);
  await refused(readAll(whole(file.slice(0, file.length - 32))), 'truncated', /incomplete/); // no END
  await refused(readAll(whole(concat([file, new Uint8Array(1)]))), 'corrupt', /after its end marker/);
  const badHeaderCrc = file.slice(); badHeaderCrc[16] ^= 1;
  await refused(openSnapshot(whole(badHeaderCrc)), 'corrupt', /header/);
  const hugeHeader = file.slice(); dv(hugeHeader).setUint32(12, 0x7fffffff, true);
  await refused(openSnapshot(whole(hugeHeader)), 'corrupt');
  const badCrc = file.slice(); badCrc[frames0 + 32 + 5] ^= 1; // a stored byte
  await refused(readAll(whole(badCrc)), 'corrupt', /checksum/);
  // The END's count: patch the last 32 bytes.
  const badCount = file.slice(); dv(badCount).setUint32(file.length - 32 + 8, 99, true);
  await refused(readAll(whole(badCount)), 'corrupt', /end marker/);
  const reserved = file.slice(); reserved[frames0 + 28] = 1;
  await refused(readAll(whole(reserved)), 'corrupt');
});

/** Builds a file by hand: header, then the frames given (with right CRCs unless told). */
function handFile(frames: Uint8Array[]) {
  const json = new TextEncoder().encode(JSON.stringify(HEADER));
  const head = new Uint8Array(16 + json.length + 4);
  const v = new DataView(head.buffer);
  head.set(new TextEncoder().encode('WEBPCSNP'));
  v.setUint32(8, 1, true); v.setUint32(12, json.length, true); head.set(json, 16); v.setUint32(16 + json.length, crc32(json), true);
  return concat([head, ...frames]);
}
function hand(tag: string, codec: number, index: number, raw: number, stored: Uint8Array, storedLen = stored.length) {
  const f = new Uint8Array(32 + stored.length);
  const v = new DataView(f.buffer);
  for (let i = 0; i < 4; i++) f[i] = tag.charCodeAt(i);
  v.setUint32(4, codec, true); v.setUint32(8, index, true); v.setUint32(16, raw, true); v.setUint32(20, storedLen, true);
  f.set(stored, 32);
  v.setUint32(24, tag === 'END ' ? 0 : crc32(stored, crc32(f.subarray(0, 24))), true);
  return f;
}
const END = (n: number) => hand('END ', 0, n, 0, new Uint8Array(0));

test('refusals: well-formed frames that say impossible things', async () => {
  const page = random(4096, 1);
  const ok = (extra: Uint8Array[]) => readAll(whole(handFile(extra)));
  await ok([END(0)]); // the empty snapshot is fine
  await refused(ok([hand('NOPE', 0, 0, 3, new Uint8Array(3)), END(1)]), 'corrupt');
  await refused(ok([hand('CORE', 0, 0, MiB + 33, new Uint8Array(MiB + 33)), END(1)]), 'corrupt');
  await refused(ok([hand('CORE', 0, 0, MiB + 1, new Uint8Array(MiB + 1)), END(1)]), 'corrupt'); // CORE is at most 1 MiB
  await refused(ok([hand('CORE', 1, 0, 4, new Uint8Array(9)), END(1)]), 'corrupt'); // stored > raw
  await refused(ok([hand('CORE', 0, 0, 9, new Uint8Array(4)), END(1)]), 'corrupt'); // codec 0 with other lengths
  await refused(ok([hand('CORE', 1, 0, 100, new Uint8Array([1, 2, 3])), END(1)]), 'corrupt'); // not deflate
  await refused(ok([hand('CORE', 7, 0, 3, new Uint8Array(3)), END(1)]), 'corrupt', /codec 7/);
  await refused(ok([hand('CORE', 0, 0, 3, new Uint8Array(3))]), 'truncated');
  await refused(ok([hand('DISK', 0, 0, 4095, new Uint8Array(4095)), END(1)]), 'corrupt');
  await refused(ok([hand('DISK', 0, 0, 257 * 4096, new Uint8Array(257 * 4096)), END(1)]), 'corrupt');
  // RAM: bitmap and length disagree; no pages; bits past the end of RAM.
  const bm = (bits: number[]) => { const b = new Uint8Array(32); for (const p of bits) b[p >> 3] |= 1 << (p & 7); return b; };
  const ramFrame = (bits: number[], pages: number) => hand('RAM ', 0, 0, 32 + pages * 4096, concat([bm(bits), new Uint8Array(pages * 4096).fill(7)]));
  await refused(ok([ramFrame([0, 1], 1), END(1)]), 'corrupt', /page map/);
  await refused(ok([ramFrame([0], 2), END(1)]), 'corrupt', /page map/);
  await refused(ok([ramFrame([], 0), END(1)]), 'corrupt');
  // 32 bytes short of a page multiple.
  await refused(ok([hand('RAM ', 0, 0, 100, new Uint8Array(100)), END(1)]), 'corrupt');
  const good = await readAll(whole(handFile([ramFrame([3, 5], 2), END(1)])));
  const ram = new Uint8Array(65536); // 16 pages
  applyRam(ram, 0, good.frames[0].data);
  assert.equal(ram[3 * 4096], 7);
  assert.throws(() => applyRam(new Uint8Array(4 * 4096), 0, good.frames[0].data), (e) => e instanceof SnapshotError && e.problem === 'corrupt'); // page 5 of 4
  assert.throws(() => applyRam(ram, 1, good.frames[0].data), (e) => e instanceof SnapshotError && e.problem === 'corrupt'); // chunk 1 of a 64 KiB RAM
  assert.throws(() => applyRam(ram, 0, good.frames[0].data.subarray(0, 100)), (e) => e instanceof SnapshotError);
  assert.throws(() => [...diskBlocks(0, new Uint8Array(100))], (e) => e instanceof SnapshotError && e.problem === 'corrupt');
  assert.throws(() => [...diskBlocks(0, new Uint8Array(0))], (e) => e instanceof SnapshotError);
  assert.deepEqual([...diskBlocks(7, concat([page, page]))].map((b) => b.block), [7, 8]);
  // A deflate bomb: valid deflate that expands far past its stated size.
  const bomb = await deflateCodec.compress(new Uint8Array(20 * MiB));
  await refused(ok([hand('CORE', 1, 0, 1000, bomb), END(1)]), 'corrupt');
});

test('a small file: every prefix is refused as truncated (or not-snapshot below the magic), every flipped bit is refused', async () => {
  const { file } = await write({ core: random(200, 1), devs: new TextEncoder().encode('{"a":1}'), ram: makeRam(65536 * 1).subarray(0, 4 * 4096), disk: [{ block: 3, data: new Uint8Array(4096).fill(9) }] });
  const everything = async (bytes: Uint8Array) => {
    const r = await restore(whole(bytes), 4 * 4096);
    return r;
  };
  await everything(file); // the intact one is fine
  assert.ok(file.length < 6000);
  for (let n = 0; n < file.length; n++) {
    await refused(everything(file.slice(0, n)), n < 8 ? 'not-snapshot' : 'truncated');
  }
  // Prefixes also with 1-byte chunks, for a few cut points.
  for (const n of [8, 20, 100, file.length - 33, file.length - 1]) await refused(restore(streamOf(file.slice(0, n), () => 1), 4 * 4096), 'truncated');
  for (let i = 0; i < file.length; i++) {
    for (let bit = 0; bit < 8; bit++) {
      const f = file.slice();
      f[i] ^= 1 << bit;
      await assert.rejects(everything(f), (e: unknown) => e instanceof SnapshotError, `a flip at byte ${i} bit ${bit} was accepted`);
    }
  }
});

test('the writer reports sink failures', async () => {
  const w = new SnapshotWriter(() => { throw new Error('disk full'); }, HEADER, { concurrency: 2 });
  await assert.rejects(async () => { await w.bytes('CORE', random(100, 1)); await w.bytes('CORE', random(100, 1)); await w.end(); }, /disk full/);
});

test('throughput on 256 MiB of RAM (informational)', async (t) => {
  const size = 256 * MiB;
  const zero = new Uint8Array(size);
  let t0 = performance.now();
  const sink = () => {};
  let w = new SnapshotWriter(sink, HEADER);
  await w.ram(zero);
  const zeroMs = performance.now() - t0;
  const ram = new Uint8Array(size);
  for (let c = 0; c < 64; c++) ram.set(random(4096, c + 1), c * 4 * MiB); // a few random pages
  for (let p = 0; p < size / 4096; p += 3) ram[p * 4096 + 100] = p & 255 || 1; // a third of the pages touched
  const parts: Uint8Array[] = [];
  t0 = performance.now();
  w = new SnapshotWriter((b) => { parts.push(b.slice()); }, HEADER, { concurrency: 4 });
  await w.ram(ram);
  const { bytes } = await w.end();
  const saveMs = performance.now() - t0;
  const file = concat(parts);
  t0 = performance.now();
  const out = new Uint8Array(size);
  const s = await openSnapshot(whole(file));
  for await (const f of s.frames()) applyRam(out, f.index, f.data);
  const loadMs = performance.now() - t0;
  sameBytes(out, ram, 'restored ram');
  t.diagnostic(`zero scan ${(256 / (zeroMs / 1000)).toFixed(0)} MB/s; save ${(256 / (saveMs / 1000)).toFixed(0)} MB/s (${(bytes / MiB).toFixed(1)} MiB out); restore ${(256 / (loadMs / 1000)).toFixed(0)} MB/s`);
});

test('the reader lets go of the chunks of the stream as it consumes them', async () => {
  // A snapshot is up to GiBs: the reader must not keep the file. 24 MiB of stored frames arrive in
  // 60,000-byte chunks (which never end where a frame does); at two thirds, the first third's
  // chunks are garbage.
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const ram = random(24 * MiB, 5);
  const { file } = await write({ ram }, { codec: { id: 0, compress: async (b) => b, decompress: async (b) => b } });
  const refs: WeakRef<Uint8Array>[] = [];
  let at = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (at >= file.length) return ctl.close();
      const chunk = file.slice(at, at + 60_000);
      refs.push(new WeakRef(chunk));
      ctl.enqueue(chunk);
      at += chunk.length;
    },
  }, { highWaterMark: 0 });
  const s = await openSnapshot(stream);
  let frames = 0;
  let checked = false;
  for await (const f of s.frames()) {
    assert.equal(f.tag, 'RAM ');
    if (++frames !== 16) continue;
    await new Promise((r) => setTimeout(r, 0));
    gc();
    const early = refs.slice(0, Math.floor(refs.length / 3));
    const alive = early.filter((r) => r.deref()).length;
    assert.ok(early.length > 50 && alive <= 2, `${alive} of the first ${early.length} chunks are still held`);
    checked = true;
  }
  assert.ok(checked && frames === 24);
});

test('a state\'s Uint8Arrays (the display\'s 3D contents) travel as BLOB frames, in a version 2 file; a version 1 file has none', async () => {
  const big = random(3 * MiB + 5, 2), small = random(10, 3);
  const vmWith = (devices: unknown[]) => ({
    snapshot: async () => ({ version: 7, core: random(100, 1), host: { devices, input: [1, 2] } }),
    disks: async () => [], diskBlocks: async () => new Uint8Array(0),
    ramSize: 65536, memory: { buffer: new ArrayBuffer(65536) }, ram: 0,
  }) as unknown as Vm;
  const save = async (devices: unknown[]) => {
    const parts: Uint8Array[] = [];
    const out = await writeSnapshot(vmWith(devices), (b) => { parts.push(b.slice()); }, { machine: 'test' }, deflateCodec);
    return { file: concat(parts), out };
  };
  const { file, out } = await save([{ gpu: { levels: [{ data: big }, { data: small }, { data: new Uint8Array(0) }] } }, null]);
  assert.equal(out.blobBytes, big.length + small.length);
  assert.equal(new DataView(file.buffer).getUint32(8, true), 2);
  const blobs = (await readAll(whole(file))).frames.filter((f) => f.tag === 'BLOB');
  assert.deepEqual(blobs.map((f) => f.index), [0, 1, 2, 3, 2 ** 24], 'blob 0 in four chunks, blob 1 in one, the empty blob 2 in none');
  const { restore } = await readSnapshot(whole(file), deflateCodec, 7);
  const back = restore.host.devices as [{ gpu: { levels: { data: Uint8Array }[] } }, null];
  sameBytes(back[0].gpu.levels[0].data, big, 'blob 0');
  sameBytes(back[0].gpu.levels[1].data, small, 'blob 1');
  assert.equal(back[0].gpu.levels[2].data.length, 0);
  assert.deepEqual([back[1], restore.host.input], [null, [1, 2]]);
  // Without Uint8Arrays: version 1, which every reader takes.
  assert.equal(new DataView((await save([{ a: 1 }])).file.buffer).getUint32(8, true), 1);
  // BLOB frames in a version 1 file: refused.
  const v1 = file.slice(); new DataView(v1.buffer).setUint32(8, 1, true);
  await refused(readAll(whole(v1)), 'corrupt');
  // DEVS naming a blob longer, or shorter, than its frames: refused.
  const made = async (length: number, bytes: number) => {
    const parts: Uint8Array[] = [];
    const w = new SnapshotWriter((b) => { parts.push(b.slice()); }, { ...HEADER, coreVersion: 7, ramSize: 65536, disks: [] }, { blobs: true });
    await w.bytes('CORE', random(10, 1));
    await w.bytes('DEVS', new TextEncoder().encode(JSON.stringify({ devices: [{ d: { $blob: 0, length } }], input: [] })));
    await w.blob(0, random(bytes, 5));
    await w.end();
    return concat(parts);
  };
  await readSnapshot(whole(await made(20, 20)), deflateCodec, 7);
  await refused(readSnapshot(whole(await made(30, 20)), deflateCodec, 7), 'corrupt', /missing parts/);
  await refused(readSnapshot(whole(await made(10, 20)), deflateCodec, 7), 'corrupt', /doesn't fit/);
});
