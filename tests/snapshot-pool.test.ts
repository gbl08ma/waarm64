// A snapshot's pool when its workers fail (web/snapshot-pool.ts; docs/platform.md "A save's pool", "A load's pool"):
// a worker's error is handled where the pool is (not passed on to the machine worker's parent), a lost reply or a
// worker that stops answering fails the pool instead of hanging the save, one worker's failure ends every worker, the
// workers made are ended when one can't be; and what the writer and the reader make of it: a refusal is the first
// failing frame's, a codec the workers don't write isn't given to them. The rest of the pool's tests (the file
// byte-identical for any size, RAM placed as on one thread): tests/snapshot.test.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { lzCodec } from '../web/lz.ts';
import { applyRam, openSnapshot, SnapshotError, SnapshotWriter, type SnapshotHeader } from '../web/snapshot-file.ts';
import { poolWorker, startPool, type Spawn } from '../web/snapshot-pool.ts';
import type { PoolInit, PoolJob, PoolReply } from '../web/snapshot-pool-worker.ts';
import { deflateCodec } from './snapshot-codecs.ts';
import { compileCore } from '../web/vm.ts';

const WASM = await compileCore(readFileSync(new URL('../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url)));
const HEADER: SnapshotHeader = { format: 1, coreVersion: 6, abi: 69, created: '2026-11-15T00:00:00Z', machine: 'pool' };

/** RAM on shared memory: `chunks` MiB of compressible pages, some zero. */
function ram(chunks: number) {
  const r = new Uint8Array(new SharedArrayBuffer(chunks << 20));
  for (let p = 0; p < chunks * 256; p++) if (p % 3) r.subarray(p * 4096, p * 4096 + 2000).fill(p & 255);
  return r;
}

/** A file of `view` (CORE, RAM, END) written through `pool` (or this thread) with `codec`. */
async function fileOf(view: Uint8Array, codec: Awaited<ReturnType<typeof lzCodec>> | typeof deflateCodec, pool?: Parameters<SnapshotWriter['ram']>[3]) {
  const parts: Uint8Array[] = [];
  const w = new SnapshotWriter((b) => { parts.push(b.slice()); }, HEADER, { codec, concurrency: 1 });
  await w.bytes('CORE', new Uint8Array(3000).fill(9));
  await w.ram(view, undefined, 0, pool);
  await w.end();
  return { file: Buffer.concat(parts), pooled: w.pooled };
}

/** Fake workers: each answers `init` as ready and records the jobs it is given, answering none; `terminated` counts. */
function fakes(o: { failOn?: number } = {}) {
  const made: { jobs: PoolJob[]; terminated: boolean; failed: (e: Error) => void }[] = [];
  const spawn: Spawn = async (heard, failed) => {
    if (made.length + 1 === o.failOn) {
      made.push({ jobs: [], terminated: false, failed });
      throw new Error('planted: no worker');
    }
    const w = { jobs: [] as PoolJob[], terminated: false, failed };
    made.push(w);
    return {
      post: (m: PoolInit | PoolJob) => {
        if (m.type === 'init') queueMicrotask(() => heard({ type: 'ready', frame: 1 << 20 } satisfies PoolReply));
        else w.jobs.push(m);
      },
      terminate: () => { w.terminated = true; },
    };
  };
  return { made, spawn };
}

/** `p` settled within `ms`, or a failure saying `what` hung. */
async function within<T>(p: Promise<T>, ms: number, what: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: still waiting after ${ms} ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

test('a pool worker\'s error is handled by the pool (cancelled: it doesn\'t go on to the machine worker\'s parent)', async () => {
  // The browser's path (a Worker): an error event the pool doesn't cancel is reported in the parent's scope again.
  const events: { prevented: boolean }[] = [];
  class FakeWorker {
    onmessage: ((e: { data: PoolReply }) => void) | null = null;
    onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    postMessage(m: PoolInit | PoolJob) {
      if (m.type === 'init') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready', frame: 1 << 20 } }));
      else {
        const e = { message: 'planted', prevented: false, preventDefault() { this.prevented = true; } };
        events.push(e);
        queueMicrotask(() => this.onerror?.(e));
      }
    }
    terminate() {}
  }
  const was = (globalThis as { Worker?: unknown }).Worker;
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  try {
    const pool = await startPool(WASM, 1);
    assert.ok(pool, 'the pool starts');
    await assert.rejects(pool.ram(new SharedArrayBuffer(4096), 0, 4096, 0), /a snapshot pool worker failed/);
    assert.equal(events.length, 1);
    assert.equal(events[0].prevented, true, 'the error event is cancelled');
    pool.close();
  } finally {
    (globalThis as { Worker?: unknown }).Worker = was;
  }
});

test('a pool that stops answering fails (the save goes on on this thread) instead of hanging', async () => {
  const f = fakes();
  const pool = await startPool(WASM, 2, { spawn: f.spawn, stallMs: 200 });
  assert.ok(pool);
  const t0 = performance.now();
  await assert.rejects(within(pool.ram(new SharedArrayBuffer(4096), 0, 4096, 0), 3000, 'a job no worker answers'), /stopped answering/);
  assert.ok(performance.now() - t0 < 2000, 'failed after about stallMs');
  assert.ok(f.made.every((w) => w.terminated), 'its workers are ended');
  // Real workers, one reply lost: the save finishes, the same file as on one thread.
  const codec = await lzCodec(WASM);
  const view = ram(12);
  const one = await fileOf(view, codec);
  let dropped = false;
  const lossy: Spawn = (heard, failed) => poolWorker((m) => {
    if (m.type === 'done' && !dropped) { dropped = true; return; }
    heard(m);
  }, failed);
  const p = await startPool(WASM, 2, { spawn: lossy, stallMs: 300 });
  assert.ok(p);
  try {
    const r = await within(fileOf(view, codec, p), 10_000, 'a save with a lost reply');
    assert.ok(dropped);
    assert.ok(Buffer.compare(r.file, one.file) === 0, 'the same file');
  } finally {
    p.close();
  }
});

test('one worker\'s failure ends every worker and fails every job in flight', async () => {
  const f = fakes();
  const pool = await startPool(WASM, 3, { spawn: f.spawn });
  assert.ok(pool);
  const jobs = [0, 1, 2].map((i) => pool.ram(new SharedArrayBuffer(4096), 0, 4096, i));
  assert.deepEqual(f.made.map((w) => w.jobs.length), [1, 1, 1]);
  f.made[1].failed(new Error('planted'));
  for (const j of jobs) await assert.rejects(j, /planted/);
  assert.deepEqual(f.made.map((w) => w.terminated), [true, true, true], 'every worker is ended at once, not only at close');
  await assert.rejects(pool.ram(new SharedArrayBuffer(4096), 0, 4096, 3), /planted/, 'a later job fails at once');
  pool.close();
});

test('a pool whose third worker can\'t be made ends the two that were', async () => {
  const f = fakes({ failOn: 3 });
  assert.equal(await startPool(WASM, 4, { spawn: f.spawn }), undefined);
  assert.equal(f.made.length, 4);
  assert.deepEqual(f.made.filter((_, k) => k !== 2).map((w) => w.terminated), [true, true, true], 'the workers made are ended');
});

test('a codec the pool\'s workers don\'t write (another id 2) is written on this thread', async () => {
  const view = ram(6);
  const p = await startPool(WASM, 2);
  assert.ok(p);
  try {
    const r = await fileOf(view, deflateCodec, p);
    assert.equal(r.pooled, 0, 'not through the pool');
    const back = new Uint8Array(view.length);
    for await (const f of (await openSnapshot(new Blob([r.file]), { codec: deflateCodec })).frames()) if (f.tag === 'RAM ') applyRam(back, f.index, f.data);
    assert.ok(Buffer.compare(back, view) === 0, 'the file reads back with its codec');
  } finally {
    p.close();
  }
});

test('a restore through the pool refuses the first damaged frame, not a later one', async () => {
  const codec = await lzCodec(WASM);
  const view = ram(12);
  const file = Buffer.from((await fileOf(view, codec)).file);
  /** The RAM frames: where each header is. */
  const rams: number[] = [];
  for (let at = 20 + file.readUInt32LE(12); at < file.length; at += 32 + file.readUInt32LE(at + 20)) if (file.toString('latin1', at, at + 4) === 'RAM ') rams.push(at);
  assert.ok(rams.length >= 8);
  // An earlier frame that doesn't unpack to its size (its CRC made again: it reads, then fails), a later one whose
  // checksum fails.
  const [a, b] = [rams[3], rams[4]];
  assert.equal(file.readUInt32LE(a + 4), 2, 'a compressed frame');
  file.writeUInt32LE(file.readUInt32LE(a + 16) - 4096, a + 16);
  const stored = file.readUInt32LE(a + 20);
  file.writeUInt32LE(zlibCrc32(Buffer.concat([file.subarray(a, a + 24), file.subarray(a + 32, a + 32 + stored)])), a + 24);
  file[b + 32 + 100] ^= 1;
  const pool = await startPool(WASM, 1);
  assert.ok(pool);
  try {
    const s = await openSnapshot(new Blob([file]), { codec, pool, piece: 4099 });
    const into = new Uint8Array(new SharedArrayBuffer(view.length));
    await assert.rejects(async () => {
      for await (const f of s.frames()) if (f.tag === 'RAM ') f.place!(into, f.index);
      await s.placed();
    }, (e: unknown) => {
      assert.ok(e instanceof SnapshotError, String(e));
      assert.equal((e.msg.params?.what as { key?: string })?.key, 'snapshots:snapshot-file.damage.unpack', 'the earlier frame\'s refusal');
      return true;
    });
  } finally {
    pool.close();
  }
});
