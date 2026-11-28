// A snapshot pool's worker (web/snapshot-pool.ts; docs/platform.md "The snapshot file"), on a core instance of its own
// (web/lz.ts `codecCore`). For a save: RAM chunks made into frames where guest RAM lies (shared memory), each scanned
// for its zero pages, its pages gathered into the instance, compressed by the core's lz4_flex and its frame's CRC-32
// taken by the core's crc32fast where the codec left the bytes; the frame goes back whole, as web/snapshot-file.ts's
// writer encodes one, in a buffer of the frames' largest size: the coordinator gives each buffer back with a later job
// once the frame is written, so a save's frames are a few buffers a worker, not a file's worth of garbage waiting for a
// GC (SNAPZ loop 2b); a save's BLOB and DISK bytes (a copy, transferred) made into their frames alike. For a load: a
// piece of the file (transferred) and its frames' jobs, each frame's CRC checked and a RAM frame's unpacked and its
// pages put straight into guest RAM, a one pass's BLOB frame unpacked and its bytes posted back (transferred), nothing
// else posted back but the frames it failed and the times.
import { codecCore, DEFLATE, MAX } from './lz.ts';
import {
  applyRam,
  frameHeader,
  gatherPages,
  scanChunk,
  type FrameJob,
  type FrameTimes,
  type RamFrame,
} from './snapshot-file.ts';

/**
 * Coordinator → worker: the core first, then RAM chunks (`id` is the coordinator's), each with the frames' buffers
 * written since (`give`, transferred: this worker's own, to make frames in again).
 */
export type PoolInit = { type: 'init'; module: WebAssembly.Module };
export type PoolJob =
  | { type: 'ram'; id: number; buffer: SharedArrayBuffer; off: number; len: number; index: number; give: ArrayBuffer[] }
  | {
      type: 'bytes';
      id: number;
      tag: 'BLOB' | 'DISK';
      index: number;
      /** The bytes, the first `len` of a buffer that goes back with the frame (`spent`), for the next bytes job. */
      raw: ArrayBuffer;
      len: number;
      give: ArrayBuffer[];
    }
  | { type: 'frames'; id: number; piece: ArrayBuffer; jobs: FrameJob[] };
/**
 * Worker → coordinator: ready (or why not; `frame`: the size of its frames' buffers), and each job's frame (or why
 * not), with how many buffers the worker has made so far (`buffers`).
 */
export type PoolReply =
  | { type: 'ready'; frame: number }
  | { type: 'failed'; message: string }
  | ({ type: 'done'; id: number; buffers: number; spent?: ArrayBuffer } & RamFrame)
  | ({ type: 'loaded'; id: number; failed: number[]; data: (ArrayBuffer | null)[] } & FrameTimes)
  | { type: 'error'; id: number; message: string };

const BITMAP = 32;
const PAGE = 4096;

type Core = Awaited<ReturnType<typeof codecCore>> & {
  src: number;
  dst: number;
  cap: number;
  free: ArrayBuffer[];
  made: number;
};

async function init(module: WebAssembly.Module): Promise<Core> {
  const core = await codecCore(module);
  const cap = core.ex.lz_bound(MAX) >>> 0;
  // `dst` has the frame's header before the stored bytes, so the CRC runs over the frame as it lies.
  const [src, dst] = [core.ex.thread_alloc(MAX, 16) >>> 0, core.ex.thread_alloc(cap + 32, 16) >>> 0];
  if (!cap || !src || !dst) throw new Error('no memory for the snapshot codec');
  return { ...core, src, dst, cap, free: [], made: 0 };
}

/** Chunk `index`'s frame (null: zero pages only) from the `len` bytes at `off` of `buffer`. */
function ram(c: Core, buffer: SharedArrayBuffer, off: number, len: number, index: number): RamFrame {
  const t = performance.now();
  const bitmap = new Uint8Array(BITMAP);
  const pages = scanChunk(new Uint32Array(buffer, off, len >>> 2), 0, len, bitmap);
  if (!pages) return { frame: null, pages, scan: performance.now() - t, compress: 0, crc: 0 };
  const mem = new Uint8Array(c.memory.buffer);
  mem.set(bitmap, c.src);
  gatherPages(new Uint8Array(buffer, off, len), 0, len, bitmap, mem, c.src + BITMAP);
  const scan = performance.now() - t;
  return { ...encode(c, 'RAM ', index, BITMAP + pages * PAGE), pages, scan };
}

/** Frame `tag` `index` of the `rawLen` bytes at `c.src` (the writer's rule: stored when packing doesn't shrink them). */
function encode(c: Core, tag: string, index: number, rawLen: number) {
  let t = performance.now();
  const mem = new Uint8Array(c.memory.buffer);
  const n = c.ex.lz_compress(c.src, rawLen, c.dst + 32, c.cap) >>> 0;
  if (!n) throw new Error('lz_compress failed');
  const compress = performance.now() - t;
  t = performance.now();
  const packed = n < rawLen;
  const stored = packed ? n : rawLen;
  if (!packed) mem.copyWithin(c.dst + 32, c.src, c.src + rawLen);
  const head = frameHeader(tag, packed ? 2 : 0, index, rawLen, stored);
  mem.set(head.subarray(0, 24), c.dst);
  const crc = c.ex.crc32(c.ex.crc32(0, c.dst, 24), c.dst + 32, stored) >>> 0;
  // In a buffer given back (all are the largest frame's size), else a new one.
  const frame = new Uint8Array(c.free.pop() ?? (c.made++, new ArrayBuffer(c.cap + 32)), 0, 32 + stored);
  frame.set(mem.subarray(c.dst, c.dst + 32 + stored));
  frame.set(head.subarray(24), 24);
  new DataView(frame.buffer).setUint32(24, crc, true);
  return { frame, compress, crc: performance.now() - t };
}

/** The frame of the BLOB or DISK bytes in `raw`'s first `len` (at most `MAX`). */
function bytes(c: Core, tag: string, index: number, raw: ArrayBuffer, len: number): RamFrame {
  const t = performance.now();
  if (len > MAX || len === 0 || len > raw.byteLength) throw new Error('a frame of another size');
  new Uint8Array(c.memory.buffer).set(new Uint8Array(raw, 0, len), c.src);
  const scan = performance.now() - t;
  return { ...encode(c, tag, index, len), pages: 0, scan };
}

/**
 * Job `j`'s frame in `piece` checked (its CRC), with `unpack` unpacked (and dropped; with `back`, returned in a buffer
 * of its own), with `place` unpacked and its pages put into guest RAM; the times added to `t`. Throws for a frame that
 * fails (the reader does it again, and refuses it as one thread would).
 */
function frame(c: Core, piece: ArrayBuffer, j: FrameJob, t: FrameTimes): ArrayBuffer | null {
  let t0 = performance.now();
  if (j.len > c.cap || j.at + 32 + j.len > piece.byteLength) throw new Error('a frame past its piece');
  const mem = new Uint8Array(c.memory.buffer);
  mem.set(new Uint8Array(piece, j.at, 32 + j.len), c.dst);
  const head = new DataView(piece, j.at, 32);
  if (c.ex.crc32(c.ex.crc32(0, c.dst, 24), c.dst + 32, j.len) >>> 0 !== head.getUint32(24, true))
    throw new Error("the frame's checksum fails");
  t.crc += performance.now() - t0;
  if (!j.place && !j.unpack) return null;
  t0 = performance.now();
  const [id, rawLen] = [head.getUint32(4, true), head.getUint32(16, true)];
  let at = c.dst + 32;
  if (id === 2 || id === DEFLATE) {
    const n =
      rawLen > MAX
        ? -1
        : (id === 2
            ? c.ex.lz_decompress(c.dst + 32, j.len, c.src, rawLen)
            : c.ex.inflate_raw(c.dst + 32, j.len, c.src, rawLen)) >>> 0;
    if (n !== rawLen) throw new Error('the frame does not unpack to its size');
    at = c.src;
  } else if (id !== 0 || j.len !== rawLen) throw new Error('a frame of another codec');
  if (j.back) {
    const out = new Uint8Array(new Uint8Array(c.memory.buffer, at, rawLen));
    t.unpack += performance.now() - t0;
    return out.buffer;
  }
  t.unpack += performance.now() - t0;
  if (!j.place) return null; // a check pass's: unpacked and dropped
  t0 = performance.now();
  const { ram, off, len, chunk } = j.place;
  applyRam(new Uint8Array(ram, off, len), chunk, new Uint8Array(c.memory.buffer, at, rawLen));
  t.apply += performance.now() - t0;
  return null;
}

/** A piece's jobs done: the ones that failed (their positions), the bytes of those with `back`, and the times. */
function frames(c: Core, piece: ArrayBuffer, jobs: FrameJob[]) {
  const t: FrameTimes = { crc: 0, unpack: 0, apply: 0 };
  const failed: number[] = [];
  const data: (ArrayBuffer | null)[] = jobs.map(() => null);
  for (const [k, j] of jobs.entries()) {
    try {
      data[k] = frame(c, piece, j, t);
    } catch {
      failed.push(k);
    }
  }
  return { failed, data, ...t };
}

function serve(
  post: (m: PoolReply, transfer?: ArrayBuffer[]) => void,
  listen: (on: (m: PoolInit | PoolJob) => void) => void,
) {
  let core: Promise<Core> | undefined;
  listen((m) => {
    if (m.type === 'init') {
      core = init(m.module);
      core.then(
        (c) => post({ type: 'ready', frame: c.cap + 32 }),
        (e: unknown) => post({ type: 'failed', message: String((e as Error)?.message ?? e) }),
      );
      return;
    }
    const { id } = m;
    if (!core) return post({ type: 'error', id, message: 'a job before the core' }); // i18n-ignore: never shown (the writer makes a failed chunk itself)
    core
      .then((c) => {
        if (m.type === 'frames') {
          const r = frames(c, m.piece, m.jobs);
          return post(
            { type: 'loaded', id, ...r },
            r.data.filter((d) => d !== null),
          );
        }
        for (const b of m.give ?? []) if (b.byteLength === c.cap + 32) c.free.push(b);
        const r = m.type === 'bytes' ? bytes(c, m.tag, m.index, m.raw, m.len) : ram(c, m.buffer, m.off, m.len, m.index);
        const spent = m.type === 'bytes' ? m.raw : undefined; // back to the pool, for its next bytes job
        const transfer = [...(r.frame ? [r.frame.buffer as ArrayBuffer] : []), ...(spent ? [spent] : [])];
        post({ type: 'done', id, ...r, buffers: c.made, spent }, transfer);
      })
      .catch((e: unknown) => post({ type: 'error', id, message: String((e as Error)?.message ?? e) }));
  });
}

if ('WorkerGlobalScope' in globalThis) {
  const self = globalThis as unknown as {
    onmessage: (e: MessageEvent<PoolInit | PoolJob>) => void;
    postMessage(m: unknown, t?: Transferable[]): void;
  };
  serve(
    (m, t) => self.postMessage(m, t ?? []),
    (on) => {
      self.onmessage = (e) => on(e.data);
    },
  );
} else {
  const { parentPort } = await import('node:worker_threads');
  serve(
    (m, t) => parentPort!.postMessage(m, t ?? []),
    (on) => parentPort!.on('message', on),
  );
}
