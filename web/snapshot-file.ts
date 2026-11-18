// Snapshot file (docs/platform.md "The snapshot file"): the container a saved
// machine is written to and read back from, streamed both ways (RAM is up to GiBs). Platform APIs
// only (ReadableStream, Blob), so it runs in Node and in a worker. It knows nothing of the core but
// through its codec: CORE is opaque bytes, DEVS is JSON the caller makes, RAM and DISK are cut here.
//
//   File  = "WAARMSNP"  u32 version (1, or 2 with BLOB frames)  u32 headerLen  header (JSON)  u32 crc32(header)  Frame*  END
//   Frame = u32 tag  u32 codec  u64 index  u32 rawLen  u32 storedLen  u32 crc  u32 reserved (0), then
//           the stored bytes. Little-endian. The CRC covers the first 24 header bytes (tag to
//           storedLen: so a flipped index or length is caught) and then the stored bytes. END's
//           CRC is 0: its index is the number of frames before it.
//
// Tags: CORE and DEVS (chunked in 1 MiB frames, joined in index order), "RAM " (guest RAM in 1 MiB
// chunks: a 32-byte bitmap of the present 4 KiB pages, then those pages; a zero page is absent, a
// chunk without pages has no frame; a machine with spill memories numbers their chunks on from memory
// 0's, each memory starting at a whole chunk: web/snapshot.ts `ramStarts`), DISK (a run of 1 to 256 consecutive overlay blocks, index =
// the first block), BLOB (binary parts of DEVS: blob n's 1 MiB chunk k, index = n × 2^24 + k; a
// file with them is version 2, which an older reader refuses as newer), "END ". Codec 0 is stored, 2 the LZ4 block format
// (web/lz.ts: the core's lz4_flex); each frame is compressed alone, and stored when compressing doesn't shrink it. The
// writer and the reader are given their codec, whose CRC-32 (the core's crc32fast) takes the frames' checksums; the
// header's is this file's own (`crc32`: read before there is a codec). A frame of another codec is refused.
import { msg, MsgError, type Msg, type Params } from './msg.ts';
import { isZero } from './qcow2-write.ts';

/**
 * The machine state's format the core reads and writes (core/src/snapshot.rs `VERSION`, its `snapshot_version`), known
 * to the page without the core: a kept snapshot of another format shows as unrestorable (docs/machines.md §5.1).
 * tests/snapshot-plan.test.ts pins it to the core's.
 */
export const SNAPSHOT_VERSION = 6;

/** What the file says about itself; `machine` and the rest are the caller's (opaque here). */
export type SnapshotHeader = { format: 1; coreVersion: number; abi: number; created: string; [key: string]: unknown };
/**
 * The snapshot in `file` with its header's `template` set (or, `on` false, dropped): a template is a snapshot every
 * visitor restores the same (a demo image's), whose restore has the guest's agent renew its identity (docs/devices.md
 * "A template's identity"). Only the header changes (its length and CRC with it); the frames are the file's own.
 */
export async function asTemplate(file: Blob, on = true): Promise<Blob> {
  const fixed = new DataView(await file.slice(0, 16).arrayBuffer());
  const magic = new Uint8Array(fixed.buffer, 0, Math.min(8, fixed.byteLength));
  if (fixed.byteLength < 16 || MAGIC.some((b, i) => magic[i] !== b)) throw new SnapshotError('snapshots:snapshot-file.notSnapshot', {}, 'not-snapshot');
  const len = fixed.getUint32(12, true);
  const json = new Uint8Array(await file.slice(16, 16 + len).arrayBuffer());
  const crc = new DataView(await file.slice(16 + len, 20 + len).arrayBuffer());
  if (json.length !== len || crc.byteLength !== 4 || crc.getUint32(0, true) !== crc32(json)) throw corrupt(msg('snapshots:snapshot-file.damage.headerChecksum'));
  const header = JSON.parse(new TextDecoder().decode(json)) as Record<string, unknown>;
  if (on) header.template = true;
  else delete header.template;
  const out = new TextEncoder().encode(JSON.stringify(header));
  const head = new Uint8Array(20 + out.length);
  const v = new DataView(head.buffer);
  head.set(new Uint8Array(fixed.buffer, 0, 12));
  v.setUint32(12, out.length, true);
  head.set(out, 16);
  v.setUint32(16 + out.length, crc32(out), true);
  return new Blob([head, file.slice(20 + len)]);
}

/**
 * Appends bytes to the output, in order. The bytes are the sink's only until it returns (or its promise resolves): a
 * sink copies what it keeps (a pool's frame buffer goes back to its worker then: web/snapshot-pool.ts).
 */
export type Sink = (bytes: Uint8Array) => void | Promise<void>;
/**
 * A frame codec: id as in the frame header (web/lz.ts is id 2), and the IEEE CRC-32 as {@link crc32}'s (the core's:
 * web/lz.ts), which takes the frames' checksums in the writer and the reader.
 */
export type Codec = {
  id: number; compress(raw: Uint8Array): Promise<Uint8Array>; decompress(stored: Uint8Array, rawLen: number): Promise<Uint8Array>;
  crc32(bytes: Uint8Array, seed?: number): number;
  /**
   * The pool's workers (web/snapshot-pool-worker.ts) write and read this codec's frames: the core's lz4_flex and
   * crc32fast (web/lz.ts `lzCodec`). Only such a codec's RAM goes through a pool; another, even of the same id, is done
   * on this thread.
   */
  pooled?: boolean;
};
/** A CRC-32 as {@link crc32}'s. */
type Crc = (bytes: Uint8Array, seed?: number) => number;

/**
 * Where a write's time went, in ms summed over its frames (tools read it: web/snapshot.ts `SavePhases`): RAM's zero-page
 * scan and gather (`scan`), the codec (`compress`), the frame's encoding and CRC (`crc`), and the waits on the sink (`sink`).
 */
export type WriteTimes = { scan: number; compress: number; crc: number; sink: number };
/**
 * Where a read's time went, in ms summed over its frames: the input's reads, the CRCs, the codec (`unpack`), RAM's
 * pages placed (`apply`); with a pool, its workers' sums.
 */
export type ReadTimes = { read: number; crc: number; unpack: number; apply: number };

const MAGIC = new TextEncoder().encode('WAARMSNP');
const VERSION = 2;
/** A BLOB frame's index: the blob times this, plus the chunk. */
export const BLOB_CHUNKS = 2 ** 24;
const FRAME_HEADER = 32;
const MAX_HEADER = 1 << 20;
export const CHUNK = 1 << 20; // raw bytes of a CORE or DEVS frame, and of the guest RAM in a RAM frame
const PAGE = 4096;
const BITMAP = 32;
const MAX_RAW = CHUNK + BITMAP;
const MAX_RUN = 256; // blocks in a DISK frame
const TAGS = new Set(['CORE', 'DEVS', 'BLOB', 'RAM ', 'DISK', 'END ']);

/** Why a snapshot was refused (`SnapshotError.problem`). */
export type SnapshotProblem = 'not-snapshot' | 'newer-format' | 'truncated' | 'corrupt' | 'other-version' | 'other-machine' | 'other-disk';

/**
 * Why a snapshot was refused: `not-snapshot`, `newer-format`, `truncated` or `corrupt` (the file),
 * `other-version`, `other-machine` or `other-disk` (what it holds isn't for this core, this machine
 * or the disk on it: web/vm.ts, web/snapshot.ts); its message (`msg`, a key of the `snapshots` catalog) says what to do.
 */
export class SnapshotError extends MsgError {
  readonly problem: SnapshotProblem;
  constructor(key: string, params: Params | undefined, problem: SnapshotProblem, options?: { cause?: unknown }) {
    super(key, params, options);
    this.name = 'SnapshotError';
    this.problem = problem;
  }
}

/** A damaged file: `what` says what of it is wrong (a message of its own, placed in the headline). */
export const corrupt = (what: Msg) => new SnapshotError('snapshots:snapshot-file.corrupt', { what }, 'corrupt');
export const truncated = () => new SnapshotError('snapshots:snapshot-file.truncated', {}, 'truncated');

// ---- CRC-32 (IEEE, as zlib's) ----

// Slicing-by-8: eight tables of 256 entries, table k advances a byte through k further zero bytes.
const TABLE = (() => {
  const t = new Int32Array(8 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    for (let k = 1; k < 8; k++) {
      const p = t[(k - 1) * 256 + n];
      t[k * 256 + n] = (p >>> 8) ^ t[p & 255];
    }
  }
  return t;
})();

/** IEEE CRC-32 of `bytes`; `seed` is the CRC of what came before (0 to start), as in zlib's `crc32`. */
export function crc32(bytes: Uint8Array, seed = 0): number {
  const t = TABLE;
  const n = bytes.length;
  let c = ~seed;
  let i = 0;
  for (; i + 8 <= n; i += 8) {
    const a = c ^ (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24));
    c =
      t[1792 + (a & 255)] ^ t[1536 + ((a >>> 8) & 255)] ^ t[1280 + ((a >>> 16) & 255)] ^ t[1024 + (a >>> 24)] ^
      t[768 + bytes[i + 4]] ^ t[512 + bytes[i + 5]] ^ t[256 + bytes[i + 6]] ^ t[bytes[i + 7]];
  }
  for (; i < n; i++) c = (c >>> 8) ^ t[(c ^ bytes[i]) & 255];
  return ~c >>> 0;
}

// ---- RAM and DISK frames ----

/** Whether the 4 KiB page at byte `off` of `w` (a Uint32Array over a 4-aligned view) is all zeros. */
function zeroPage(w: Uint32Array, off: number) {
  for (let i = off >>> 2, end = i + 1024; i < end; i += 8) {
    if ((w[i] | w[i + 1] | w[i + 2] | w[i + 3] | w[i + 4] | w[i + 5] | w[i + 6] | w[i + 7]) !== 0) return false;
  }
  return true;
}

/**
 * RAM's zero-page scan of the `len` bytes at byte `off` of `w` (a Uint32Array over a 4-aligned view; `len` at most a
 * chunk, a multiple of 4 KiB): sets each non-zero page's bit in `bitmap` (32 bytes, zeroed) and returns their count.
 */
export function scanChunk(w: Uint32Array, off: number, len: number, bitmap: Uint8Array): number {
  let present = 0;
  for (let p = 0; p < len / PAGE; p++) {
    if (!zeroPage(w, off + p * PAGE)) { bitmap[p >> 3] |= 1 << (p & 7); present++; }
  }
  return present;
}

/** Copies the pages `bitmap` marks, of the `len` bytes at `off` of `src`, one after another into `dst` from `at`. */
export function gatherPages(src: Uint8Array, off: number, len: number, bitmap: Uint8Array, dst: Uint8Array, at: number): void {
  for (let p = 0; p < len / PAGE; p++) {
    if (!(bitmap[p >> 3] & (1 << (p & 7)))) continue;
    dst.set(src.subarray(off + p * PAGE, off + (p + 1) * PAGE), at);
    at += PAGE;
  }
}

function popcount(bitmap: Uint8Array) {
  let n = 0;
  for (let i = 0; i < BITMAP; i++) {
    let b = bitmap[i];
    while (b) { n++; b &= b - 1; }
  }
  return n;
}

/** Checks a RAM frame's payload is a bitmap and exactly as many pages as it has bits set; returns the page count. */
function checkRam(data: Uint8Array) {
  if (data.length < BITMAP + PAGE || (data.length - BITMAP) % PAGE !== 0) throw corrupt(msg('snapshots:snapshot-file.damage.memoryBlockSize'));
  const pages = popcount(data.subarray(0, BITMAP));
  if (pages * PAGE !== data.length - BITMAP) throw corrupt(msg('snapshots:snapshot-file.damage.pageMap'));
  return pages;
}

/** Writes a RAM frame's pages into `ram` (a view of guest RAM, possibly shared), which starts zeroed. */
export function applyRam(ram: Uint8Array, index: number, data: Uint8Array): void {
  const pages = checkRam(data);
  const first = index * (CHUNK / PAGE);
  const have = Math.floor(ram.length / PAGE);
  if (!Number.isSafeInteger(first) || first >= have) throw corrupt(msg('snapshots:snapshot-file.damage.pastRam'));
  let at = BITMAP;
  let seen = 0;
  for (let p = 0; p < 256 && seen < pages; p++) {
    if (!(data[p >> 3] & (1 << (p & 7)))) continue;
    seen++;
    if (first + p >= have) throw corrupt(msg('snapshots:snapshot-file.damage.pastRam'));
    ram.set(data.subarray(at, at + PAGE), (first + p) * PAGE);
    at += PAGE;
  }
}

/** A DISK frame's blocks (4 KiB each, as views of `data`). */
export function* diskBlocks(index: number, data: Uint8Array): Generator<{ block: number; data: Uint8Array }> {
  if (data.length === 0 || data.length % PAGE !== 0 || data.length > MAX_RUN * PAGE) throw corrupt(msg('snapshots:snapshot-file.damage.diskRunSize'));
  for (let i = 0; i < data.length / PAGE; i++) yield { block: index + i, data: data.subarray(i * PAGE, (i + 1) * PAGE) };
}

/**
 * A DISK frame's blocks as runs: consecutive blocks that are all zeros (`zero`) or all not, `count` of them from
 * `block`, their bytes a view of `data`. A restore writes a run in one overlay call (web/snapshot.ts).
 */
export function* diskRuns(index: number, data: Uint8Array): Generator<{ block: number; count: number; zero: boolean; data: Uint8Array }> {
  const n = data.length / PAGE;
  if (data.length === 0 || !Number.isInteger(n) || n > MAX_RUN) throw corrupt(msg('snapshots:snapshot-file.damage.diskRunSize'));
  const zero = (i: number) => isZero(data.subarray(i * PAGE, (i + 1) * PAGE));
  for (let i = 0, z = zero(0); i < n;) {
    let j = i + 1;
    let zj = false;
    while (j < n && (zj = zero(j)) === z) j++;
    yield { block: index + i, count: j - i, zero: z, data: data.subarray(i * PAGE, j * PAGE) };
    [i, z] = [j, zj];
  }
}

// ---- writer ----

/** The frame's CRC: its first 24 header bytes, then the stored bytes. */
function frameCrc(head: Uint8Array, stored: Uint8Array, crc: Crc) {
  return crc(stored, crc(head.subarray(0, 24)));
}

/** What a pool worker made of a RAM chunk (web/snapshot-pool.ts): the frame, or null for a chunk of zero pages. */
export type RamFrame = { frame: Uint8Array | null; pages: number; scan: number; compress: number; crc: number };
/**
 * Workers that make RAM's frames from guest RAM where it lies (shared memory; web/snapshot-pool.ts): `ram` is chunk
 * `index`'s frame from the `len` bytes at `off` of `buffer`, encoded whole as this writer encodes one (its codec, the
 * same CRC: the file's bytes don't depend on who made a frame); `size` workers, each taking a chunk at a time.
 * `recycle`, where the pool has it, takes chunk `index`'s frame back once the sink has written it (its buffer goes to
 * the worker's next frame: a save's frames don't wait for a GC, SNAPZ loop 2b).
 */
export type RamPool = {
  size: number;
  ram(buffer: SharedArrayBuffer, off: number, len: number, index: number): Promise<RamFrame>;
  recycle?(frame: Uint8Array, index: number): void;
};

/** A load's pool's work's times, ms (`ReadTimes`'). */
export type FrameTimes = { crc: number; unpack: number; apply: number };
/**
 * A frame in a piece of the file a load's pool is given: its 32-byte header at `at`, then its `len` stored bytes. Its
 * CRC is checked; with `place`, it is a RAM frame, unpacked and its pages put into guest RAM as `applyRam` does: chunk
 * `chunk` of the `len` bytes at `off` of `ram` (shared memory); with `unpack` (a check pass's DISK frame), it is
 * unpacked to its size and dropped.
 */
export type FrameJob = { at: number; len: number; unpack?: true; place?: { ram: SharedArrayBuffer; off: number; len: number; chunk: number } };
/**
 * Workers that check and unpack a reader's frames (web/snapshot-pool.ts): `frames` gives one of them a piece of the
 * file (transferred) and its frames' jobs, and resolves to the jobs it failed (their positions in `jobs`), which the
 * reader does itself, read again from the file (and refuses as one thread would); a rejection fails them all.
 */
export type LoadPool = {
  size: number;
  frames(piece: ArrayBuffer, jobs: FrameJob[]): Promise<{ failed: number[] } & FrameTimes>;
};

/** Writes a snapshot to a sink, a frame at a time: CORE and DEVS first, then RAM, DISK, and `end()`. */
export class SnapshotWriter {
  #sink: Sink;
  #codec: Codec;
  #crc: Crc;
  #concurrency: number;
  #inflight: Promise<void>[] = [];
  #tail: Promise<void> = Promise.resolve();
  #bytes = 0;
  #frames = 0;
  #ended = false;
  #failed: unknown = undefined;
  #hasFailed = false;
  #index = new Map<string, number>();
  /** Where the time went so far (`WriteTimes`). */
  readonly times: WriteTimes = { scan: 0, compress: 0, crc: 0, sink: 0 };
  /** The workers of the pool RAM's frames last went through (`ram()`'s `pool`), 0 for none. */
  pooled = 0;

  /**
   * `codec` makes the frames; `concurrency` of them may be compressed at once (default 4), each at most 1 MiB; they are
   * written in order. `blobs`: the file will have BLOB frames (version 2; without, version 1).
   */
  constructor(sink: Sink, header: SnapshotHeader, opts: { codec: Codec; concurrency?: number; blobs?: boolean }) {
    this.#sink = sink;
    this.#codec = opts.codec;
    this.#crc = this.#codec.crc32.bind(this.#codec);
    this.#concurrency = Math.max(1, Math.floor(opts.concurrency ?? 4));
    const json = new TextEncoder().encode(JSON.stringify(header));
    const out = new Uint8Array(8 + 4 + 4 + json.length + 4);
    const v = new DataView(out.buffer);
    out.set(MAGIC, 0);
    v.setUint32(8, opts.blobs ? 2 : 1, true);
    v.setUint32(12, json.length, true);
    out.set(json, 16);
    v.setUint32(16 + json.length, crc32(json), true);
    this.#push(Promise.resolve(out));
  }

  /**
   * Queues `bytes` (a promise: its compression; null writes nothing) behind what is queued; `then` runs once they are
   * written, in order.
   */
  #push(bytes: Promise<Uint8Array | null>, then?: (b: Uint8Array | null) => void) {
    const written = this.#tail.then(() => bytes).then(async (b) => {
      if (b) {
        this.#bytes += b.length;
        const t = performance.now();
        await this.#sink(b);
        this.times.sink += performance.now() - t;
      }
      then?.(b);
    });
    this.#tail = written;
    written.catch((e) => { if (!this.#hasFailed) { this.#hasFailed = true; this.#failed = e; } });
    this.#inflight.push(written);
  }

  async #drain(limit: number) {
    if (this.#hasFailed) throw this.#failed;
    while (this.#inflight.length > limit) await this.#inflight.shift();
  }

  async #frame(tag: string, index: number, raw: Uint8Array) {
    if (this.#ended) throw new Error('the snapshot is already ended');
    await this.#drain(this.#concurrency - 1);
    this.#frames++;
    const codec = this.#codec;
    this.#push((async () => {
      let id = 0;
      let stored = raw;
      let t = performance.now();
      if (codec.id !== 0) {
        const packed = await codec.compress(raw);
        if (packed.length < raw.length) { id = codec.id; stored = packed; }
        this.times.compress += performance.now() - t;
        t = performance.now();
      }
      const frame = encodeFrame(tag, id, index, raw.length, stored, this.#crc);
      this.times.crc += performance.now() - t;
      return frame;
    })());
    await this.#drain(this.#concurrency);
  }

  /** CORE or DEVS bytes, in frames of at most 1 MiB (call again to continue: the frames follow on). */
  async bytes(tag: 'CORE' | 'DEVS', data: Uint8Array): Promise<void> {
    for (let off = 0; off < data.length; off += CHUNK) {
      const index = this.#index.get(tag) ?? 0;
      this.#index.set(tag, index + 1);
      // A copy: the caller may reuse the buffer (or it may be shared memory, which streams refuse).
      await this.#frame(tag, index, data.slice(off, Math.min(off + CHUNK, data.length)));
    }
  }

  /** Blob `n` (after DEVS, before RAM), in frames of at most 1 MiB; an empty blob has none. */
  async blob(n: number, data: Uint8Array): Promise<void> {
    if (!Number.isInteger(n) || n < 0 || n >= 2 ** 29 || data.length > BLOB_CHUNKS * CHUNK) throw new RangeError('a blob out of range');
    for (let k = 0; k * CHUNK < data.length; k++) await this.#frame('BLOB', n * BLOB_CHUNKS + k, data.slice(k * CHUNK, Math.min((k + 1) * CHUNK, data.length)));
  }

  /**
   * Guest RAM, a 1 MiB chunk at a time (all-zero pages left out, all-zero chunks skipped). `ram` may
   * be a view of shared memory. Its length is a multiple of 4096. `first`: its first chunk's index (a
   * spill memory's, after memory 0's chunks).
   */
  async ram(ram: Uint8Array, progress?: (done: number, total: number) => void, first = 0, pool?: RamPool): Promise<{ pages: number; frames: number }> {
    if (ram.length % PAGE !== 0) throw new RangeError('RAM is a whole number of 4 KiB pages');
    // The pool's frames are the core's codec's (web/snapshot-pool-worker.ts): only a writer of that codec takes them.
    if (pool?.size && this.#codec.pooled && ram.buffer instanceof SharedArrayBuffer && ram.byteOffset % 4 === 0) return this.#poolRam(ram, pool, progress, first);
    // Scanned where it lies when 4-aligned (the usual case); otherwise a chunk is copied first.
    const aligned = ram.byteOffset % 4 === 0 ? new Uint32Array(ram.buffer, ram.byteOffset, ram.length >>> 2) : null;
    let pages = 0;
    let frames = 0;
    for (let base = 0; base < ram.length; base += CHUNK) {
      const len = Math.min(CHUNK, ram.length - base);
      let words = aligned;
      let off = base;
      let src = ram;
      if (!words) {
        src = ram.slice(base, base + len);
        words = new Uint32Array(src.buffer, 0, len >> 2);
        off = 0;
      }
      const t = performance.now();
      const bitmap = new Uint8Array(BITMAP);
      const present = scanChunk(words, off, len, bitmap);
      const raw = present ? new Uint8Array(BITMAP + present * PAGE) : undefined;
      if (raw) {
        raw.set(bitmap, 0);
        gatherPages(src, off, len, bitmap, raw, BITMAP);
      }
      this.times.scan += performance.now() - t;
      if (raw) {
        pages += present;
        frames++;
        await this.#frame('RAM ', first + base / CHUNK, raw);
      }
      progress?.(base + len, ram.length);
    }
    return { pages, frames };
  }

  /**
   * `ram()` through a pool: chunk c to a worker (the pool deals them: c mod its size), three in flight a worker, the
   * frames written in order as they come back. A chunk whose worker failed is made here (RAM doesn't move while it is
   * written), so a failed worker costs time, not the file. `times` sums the workers' scan, codec and CRC (CPU time, not
   * the wall's).
   */
  async #poolRam(ram: Uint8Array<ArrayBufferLike>, pool: RamPool, progress: ((done: number, total: number) => void) | undefined, first: number) {
    if (this.#ended) throw new Error('the snapshot is already ended');
    const buffer = ram.buffer as SharedArrayBuffer;
    const limit = pool.size * 3;
    this.pooled = pool.size;
    const counts = { pages: 0, frames: 0 };
    const words = new Uint32Array(buffer, ram.byteOffset, ram.length >>> 2);
    for (let base = 0; base < ram.length; base += CHUNK) {
      const len = Math.min(CHUNK, ram.length - base);
      const index = first + base / CHUNK;
      await this.#drain(limit - 1);
      // Once the write has failed (the sink), a chunk is not made here: RAM may be running again by then.
      const made = pool.ram(buffer, ram.byteOffset + base, len, index).catch(() =>
        this.#hasFailed ? { frame: null, pages: 0, scan: 0, compress: 0, crc: 0 } : this.#ramHere(ram, words, base, len, index));
      this.#push(made.then((r) => {
        this.times.scan += r.scan;
        this.times.compress += r.compress;
        this.times.crc += r.crc;
        return r.frame;
      }), (frame) => {
        if (frame) {
          this.#frames++;
          counts.frames++;
          pool.recycle?.(frame, index);
        }
        progress?.(base + len, ram.length);
      });
      made.then((r) => { counts.pages += r.pages; }, () => {});
    }
    await this.#drain(0);
    return counts;
  }

  /** RAM chunk `index`'s frame made on this thread (`#poolRam`'s, for a chunk its worker didn't make). */
  async #ramHere(ram: Uint8Array, words: Uint32Array, base: number, len: number, index: number): Promise<RamFrame> {
    let t = performance.now();
    const bitmap = new Uint8Array(BITMAP);
    const pages = scanChunk(words, base, len, bitmap);
    if (!pages) return { frame: null, pages, scan: performance.now() - t, compress: 0, crc: 0 };
    const raw = new Uint8Array(BITMAP + pages * PAGE);
    raw.set(bitmap, 0);
    gatherPages(ram, base, len, bitmap, raw, BITMAP);
    const scan = performance.now() - t;
    t = performance.now();
    let id = 0;
    let stored: Uint8Array = raw;
    if (this.#codec.id !== 0) {
      const packed = await this.#codec.compress(raw);
      if (packed.length < raw.length) { id = this.#codec.id; stored = packed; }
    }
    const compress = performance.now() - t;
    t = performance.now();
    const frame = encodeFrame('RAM ', id, index, raw.length, stored, this.#crc);
    return { frame, pages, scan, compress, crc: performance.now() - t };
  }

  /** The overlay's blocks (4 KiB each) in ascending block order; consecutive blocks share frames of up to 256. */
  async disk(blocks: AsyncIterable<{ block: number; data: Uint8Array }> | Iterable<{ block: number; data: Uint8Array }>): Promise<{ blocks: number }> {
    let n = 0;
    let first = 0;
    let run: Uint8Array[] = [];
    const flush = async () => {
      if (!run.length) return;
      const raw = new Uint8Array(run.length * PAGE);
      run.forEach((b, i) => raw.set(b, i * PAGE));
      const at = first;
      run = [];
      await this.#frame('DISK', at, raw);
    };
    let next = -1;
    for await (const { block, data } of blocks) {
      if (data.length !== PAGE) throw new RangeError('an overlay block is 4096 bytes');
      if (block < next || !Number.isSafeInteger(block)) throw new RangeError('overlay blocks must come in ascending order');
      if (run.length && (block !== next || run.length >= MAX_RUN)) await flush();
      if (!run.length) first = block;
      run.push(data.slice()); // a copy: the caller may reuse the buffer
      next = block + 1;
      n++;
    }
    await flush();
    return { blocks: n };
  }

  /** Writes the end marker and waits for everything to reach the sink. */
  async end(): Promise<{ bytes: number; frames: number }> {
    if (this.#ended) throw new Error('the snapshot is already ended');
    await this.#drain(this.#concurrency - 1);
    this.#ended = true;
    this.#push(Promise.resolve(encodeFrame('END ', 0, this.#frames, 0, new Uint8Array(0), crc32, true)));
    await this.#drain(0);
    await this.#tail;
    return { bytes: this.#bytes, frames: this.#frames };
  }
}

/**
 * The most bytes a file of these parts can take (a staging file's room is checked against it: docs/frontend.md
 * "Snapshots"): the header at its largest, each CORE, DEVS and BLOB part stored whole in frames of {@link CHUNK}, every
 * RAM chunk stored whole with its bitmap (`ram`: each memory's bytes), every disk block a frame of its own, and the end.
 * A frame is never stored larger than its raw bytes (the writer's rule), so no file of these parts is larger.
 */
export function snapshotBound(p: { core: number; devs: number; blobs: number[]; ram: number[]; blocks: number }): number {
  const frames = (n: number) => n + FRAME_HEADER * Math.ceil(n / CHUNK);
  const ram = p.ram.reduce((t, n) => t + n + (FRAME_HEADER + BITMAP) * Math.ceil(n / CHUNK), 0);
  return 20 + MAX_HEADER + frames(p.core) + frames(p.devs) + p.blobs.reduce((t, n) => t + frames(n), 0) + ram + p.blocks * (PAGE + FRAME_HEADER) + FRAME_HEADER;
}

/** A frame's 32-byte header, its CRC (bytes 24 to 28) left 0 for the caller. */
export function frameHeader(tag: string, codec: number, index: number, rawLen: number, storedLen: number): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER);
  const v = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = tag.charCodeAt(i);
  v.setUint32(4, codec, true);
  v.setUint32(8, index % 2 ** 32, true);
  v.setUint32(12, Math.floor(index / 2 ** 32), true);
  v.setUint32(16, rawLen, true);
  v.setUint32(20, storedLen, true);
  return out;
}

function encodeFrame(tag: string, codec: number, index: number, rawLen: number, stored: Uint8Array, crc: Crc, end = false) {
  const out = new Uint8Array(FRAME_HEADER + stored.length);
  out.set(frameHeader(tag, codec, index, rawLen, stored.length));
  out.set(stored, FRAME_HEADER);
  new DataView(out.buffer).setUint32(24, end ? 0 : frameCrc(out, stored, crc), true);
  return out;
}

// ---- reader ----

/** Pulls exact byte counts out of a stream whose chunks come in any size. */
/**
 * A Blob's bytes are read in pieces of this size, this many ahead: Chromium reads a picked file's stream at ~1.1 GB/s
 * in 64 KiB chunks, and four 4 MiB slices in flight at ~3.2 GB/s (bench/boot/REPORT.md "SNAPZ loop 3").
 */
const PIECE = 4 << 20;
const AHEAD = 4;

class Input {
  #reader?: ReadableStreamDefaultReader<Uint8Array>;
  #blob?: Blob;
  /** A Blob's next piece to read, and the pieces being read. */
  #at = 0;
  #ahead: Promise<Uint8Array>[] = [];
  #chunks: Uint8Array[] = [];
  #ci = 0;
  #off = 0;
  #avail = 0;
  #done = false;
  /** A stream, or a Blob (read in slices: {@link PIECE}). */
  constructor(source: ReadableStream<Uint8Array> | Blob) {
    if (source instanceof Blob) this.#blob = source;
    else this.#reader = source.getReader();
  }

  async #more() {
    if (this.#blob) {
      const b = this.#blob;
      while (this.#ahead.length < AHEAD && this.#at < b.size) {
        const at = this.#at;
        this.#at = Math.min(at + PIECE, b.size);
        const p = b.slice(at, this.#at).arrayBuffer().then((x) => new Uint8Array(x));
        p.catch(() => {}); // a failed read is thrown when its piece is taken (and not as unhandled if it never is)
        this.#ahead.push(p);
      }
      const p = this.#ahead.shift();
      if (!p) { this.#done = true; return; }
      const value = await p;
      if (value.length) { this.#chunks.push(value); this.#avail += value.length; }
      return;
    }
    const { done, value } = await this.#reader!.read();
    if (done) { this.#done = true; return; }
    if (!(value instanceof Uint8Array)) throw corrupt(msg('snapshots:snapshot-file.damage.notBytes'));
    if (value.length) { this.#chunks.push(value); this.#avail += value.length; }
  }

  /** The next `n` bytes (valid until the next call), or null when the stream ends first. */
  async take(n: number): Promise<Uint8Array | null> {
    while (this.#avail < n) {
      if (this.#done) return null;
      await this.#more();
    }
    let out: Uint8Array;
    const head = this.#chunks[this.#ci];
    if (n === 0) return new Uint8Array(0);
    if (head.length - this.#off >= n) {
      out = head.subarray(this.#off, this.#off + n);
      this.#off += n;
      if (this.#off === head.length) { this.#ci++; this.#off = 0; }
    } else {
      out = new Uint8Array(n);
      let at = 0;
      while (at < n) {
        const c = this.#chunks[this.#ci];
        const k = Math.min(c.length - this.#off, n - at);
        out.set(c.subarray(this.#off, this.#off + k), at);
        at += k;
        this.#off += k;
        if (this.#off === c.length) { this.#ci++; this.#off = 0; }
      }
    }
    this.#avail -= n;
    // Consumed chunks go at once: the file is up to GiBs, and a read rarely ends where a chunk does.
    if (this.#ci > 0) { this.#chunks.splice(0, this.#ci); this.#ci = 0; }
    return out;
  }

  /** Whether any byte is left. */
  async more() {
    while (this.#avail === 0 && !this.#done) await this.#more();
    return this.#avail > 0;
  }

  close() {
    this.#reader?.cancel().catch(() => {});
    this.#ahead = [];
    this.#blob = undefined;
    this.#done = true;
  }
}

/** Reads the magic, the version and the header off `input` (a `SnapshotError` for a file that isn't one this reads). */
async function header(input: Input): Promise<{ header: SnapshotHeader; version: number; size: number }> {
  const magic = await input.take(8);
  if (!magic || MAGIC.some((b, i) => magic[i] !== b)) {
    throw new SnapshotError('snapshots:snapshot-file.notSnapshot', {}, 'not-snapshot');
  }
  const fixed = await input.take(8);
  if (!fixed) throw truncated();
  const fv = new DataView(fixed.buffer, fixed.byteOffset, 8);
  const version = fv.getUint32(0, true);
  if (version > VERSION) {
    throw new SnapshotError('snapshots:snapshot-file.newerFormat', { format: version, reads: VERSION }, 'newer-format');
  }
  if (version < 1) throw corrupt(msg('snapshots:snapshot-file.damage.formatNumber'));
  const headerLen = fv.getUint32(4, true);
  if (headerLen > MAX_HEADER) throw corrupt(msg('snapshots:snapshot-file.damage.headerLong'));
  const json = await input.take(headerLen);
  const crcBytes = json && (await input.take(4));
  if (!json || !crcBytes) throw truncated();
  if (new DataView(crcBytes.buffer, crcBytes.byteOffset, 4).getUint32(0, true) !== crc32(json)) throw corrupt(msg('snapshots:snapshot-file.damage.headerChecksum'));
  let h: SnapshotHeader;
  try {
    h = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
  } catch {
    throw corrupt(msg('snapshots:snapshot-file.damage.headerUnreadable'));
  }
  if (typeof h !== 'object' || h === null || Array.isArray(h) || h.format !== 1) throw corrupt(msg('snapshots:snapshot-file.damage.headerUnknown'));
  return { header: h, version, size: 20 + headerLen };
}

/**
 * A snapshot's header, without its frames (what a list of kept snapshots shows, what a restore checks first): the
 * magic, the version and the header's CRC checked as {@link openSnapshot} checks them; nothing else is read.
 */
export async function readHeader(source: ReadableStream<Uint8Array> | Blob): Promise<SnapshotHeader> {
  const input = new Input(source instanceof Blob ? source.slice(0, 16 + MAX_HEADER + 4) : source);
  try {
    return (await header(input)).header;
  } finally {
    input.close();
  }
}


/**
 * A frame as the reader yields it. A RAM frame's `place` puts its pages into `ram`, a view of guest RAM, as chunk
 * `chunk` (`applyRam`'s), called before the next frame is asked for; through a pool its `data` is empty and the pool's
 * workers do it: `placed()` then waits for every frame placed so far (and throws the first one's refusal).
 */
export type ReadFrame = { tag: string; index: number; data: Uint8Array; size?: number; place?: (ram: Uint8Array, chunk: number) => void };

/** A frame header's fields. */
type Head = { tag: string; id: number; index: number; rawLen: number; storedLen: number; want: number };

/**
 * The fields of a frame header (`h`, its 32 bytes), checked as far as the header alone tells, in a file of format
 * `version` read with codec `codec`: END's own fields too, but not its count or what follows it (the reader's).
 */
function frameHead(h: Uint8Array, version: number, codec: number): Head {
  const v = new DataView(h.buffer, h.byteOffset, FRAME_HEADER);
  const tag = String.fromCharCode(h[0], h[1], h[2], h[3]);
  const id = v.getUint32(4, true);
  const hi = v.getUint32(12, true);
  const index = hi * 2 ** 32 + v.getUint32(8, true);
  const rawLen = v.getUint32(16, true);
  const storedLen = v.getUint32(20, true);
  const want = v.getUint32(24, true);
  if (!TAGS.has(tag) || (tag === 'BLOB' && version < 2)) throw corrupt(msg('snapshots:snapshot-file.damage.unknownKind'));
  if (v.getUint32(28, true) !== 0 || hi >= 2 ** 21) throw corrupt(msg('snapshots:snapshot-file.damage.frameFields'));
  if (tag === 'END ') {
    if (rawLen !== 0 || storedLen !== 0 || want !== 0 || id !== 0) throw corrupt(msg('snapshots:snapshot-file.damage.endMalformed'));
    return { tag, id, index, rawLen, storedLen, want };
  }
  if (rawLen === 0 || rawLen > MAX_RAW || storedLen > rawLen) throw corrupt(msg('snapshots:snapshot-file.damage.frameSize'));
  if (id === 0 ? storedLen !== rawLen : id !== codec) {
    throw corrupt(id === 0 ? msg('snapshots:snapshot-file.damage.frameSize') : msg('snapshots:snapshot-file.damage.codec', { codec: id }));
  }
  if (tag === 'CORE' || tag === 'DEVS' || tag === 'BLOB' ? rawLen > CHUNK : tag === 'DISK' ? rawLen % PAGE !== 0 || rawLen > MAX_RUN * PAGE : false) {
    throw corrupt(msg('snapshots:snapshot-file.damage.frameSize'));
  }
  return { tag, id, index, rawLen, storedLen, want };
}

/**
 * Opens a snapshot for reading: checks its magic, version and header (throws a `SnapshotError`
 * before anything else is read), then `frames()` yields each frame, CRC-verified (through `codec`'s
 * CRC-32) and decompressed (by `codec`, or stored), as it arrives. A stream shorter than the magic
 * is `not-snapshot`; a file that ends later without its end marker is `truncated`. `frames()` reads
 * the stream once; the end of the file is checked when it finishes. With `check`, frames come
 * without their data but with their raw `size`: their checksums and the file's structure are verified, and DISK frames
 * are unpacked (and dropped), so that a restore's disk phase finds none it refuses (web/snapshot.ts `readSnapshot`).
 * `times`: where the reading's time went so far (`ReadTimes`).
 *
 * `pool`, for a Blob (docs/platform.md "A load's pool"): the file is read in pieces, each given whole to a worker with
 * the jobs of the frames in it (a frame across two pieces is copied out and given alone): the check pass's CRCs, and
 * the restore pass's RAM frames' CRCs, unpacking and placing; the structure is still checked here, in file order, and
 * the other frames are read here. A check pass ends once every CRC is in, and a refusal is the first failing frame's,
 * as on one thread. A frame a worker fails is read again and done here. `pooled`: the pool's size when it is used.
 * `piece`: the pieces' size ({@link PIECE}; tests make it small, so that frames and their headers span pieces).
 */
export async function openSnapshot(
  source: ReadableStream<Uint8Array> | Blob,
  opts: { codec: Codec; check?: boolean; pool?: LoadPool; piece?: number },
): Promise<{ header: SnapshotHeader; frames(): AsyncGenerator<ReadFrame>; placed(): Promise<void>; times: ReadTimes; pooled: number }> {
  const { codec } = opts;
  const crc: Crc = codec.crc32.bind(codec);
  const pool = opts.pool?.size && codec.pooled && source instanceof Blob ? opts.pool : undefined;
  // Through a pool the header is read on its own (the frames are read in pieces).
  const input = new Input(pool ? (source as Blob).slice(0, 20 + MAX_HEADER) : source);
  const times: ReadTimes = { read: 0, crc: 0, unpack: 0, apply: 0 };
  // The pool's work in file order: each resolves to its first refusal (or undefined) and none rejects, so none goes
  // unhandled while earlier ones are awaited.
  const jobs: Promise<unknown>[] = [];
  const settle = (p: Promise<unknown>) => { jobs.push(p.then(() => undefined, (e: unknown) => e ?? new Error('a frame failed'))); };
  /** The refusal `settleOne` threw: the oldest work's, earlier in the file than any still queued. */
  let jobRefusal: unknown;
  /** The oldest work settled; its refusal thrown. */
  const settleOne = async () => {
    const e = await jobs.shift();
    if (e) throw (jobRefusal = e);
  };
  /** The pool's frames of the piece in hand given to a worker now (a copy of the piece: the reader isn't done with it). */
  let flush = async () => {};
  const placed = async () => {
    await flush();
    while (jobs.length) await settleOne();
  };
  try {
    const { header: head, version, size } = await header(input);

    /** The CRC of `frame` (its header, then its stored bytes) checked here. */
    const checkHere = (frame: Uint8Array, want: number) => {
      const t = performance.now();
      const ok = frameCrc(frame, frame.subarray(FRAME_HEADER), crc) === want;
      times.crc += performance.now() - t;
      if (!ok) throw corrupt(msg('snapshots:snapshot-file.damage.checksum'));
    };
    /** `stored` unpacked here to its `rawLen` bytes (codec `id`; a copy). */
    const unpack = async (id: number, stored: Uint8Array, rawLen: number) => {
      if (id === 0) return stored.slice();
      let data: Uint8Array;
      try {
        const t = performance.now();
        data = await codec.decompress(stored, rawLen);
        times.unpack += performance.now() - t;
      } catch (e) {
        if (e instanceof SnapshotError) throw e;
        throw corrupt(msg('snapshots:snapshot-file.damage.unpack'));
      }
      if (data.length !== rawLen) throw corrupt(msg('snapshots:snapshot-file.damage.unpackSize'));
      return data;
    };
    /** RAM's pages put into `ram` as chunk `chunk`. */
    const apply = (ram: Uint8Array, chunk: number, data: Uint8Array) => {
      const t = performance.now();
      applyRam(ram, chunk, data);
      times.apply += performance.now() - t;
    };
    /** RAM frame `frame` (its header `h`, then its stored bytes) checked, unpacked and placed here. */
    const placeHere = async (frame: Uint8Array, h: Head, ram: Uint8Array, chunk: number) => {
      checkHere(frame, h.want);
      apply(ram, chunk, await unpack(h.id, frame.subarray(FRAME_HEADER), h.rawLen));
    };

    async function* oneThread(): AsyncGenerator<ReadFrame> {
      let count = 0;
      for (;;) {
        const th = performance.now();
        const hb = await input.take(FRAME_HEADER);
        times.read += performance.now() - th;
        if (!hb) throw truncated();
        const h = frameHead(hb, version, codec.id);
        if (h.tag === 'END ') {
          if (h.index !== count) throw corrupt(msg('snapshots:snapshot-file.damage.endCount', { counted: h.index, came: count }));
          if (await input.more()) throw corrupt(msg('snapshots:snapshot-file.damage.afterEnd'));
          return;
        }
        const headBytes = hb.slice(0, 24); // `hb` is a view of the input's buffer, which the next take may reuse
        let t = performance.now();
        const stored = await input.take(h.storedLen);
        times.read += performance.now() - t;
        if (!stored) throw truncated();
        t = performance.now();
        const crcOk = frameCrc(headBytes, stored, crc) === h.want;
        times.crc += performance.now() - t;
        if (!crcOk) throw corrupt(msg('snapshots:snapshot-file.damage.checksum'));
        count++;
        // Checked, not unpacked (but DISK's): a pass over a file before a restore touches anything.
        if (opts.check) {
          if (h.tag === 'DISK') await unpack(h.id, stored, h.rawLen);
          yield { tag: h.tag, index: h.index, data: new Uint8Array(0), size: h.rawLen };
        }
        else if (h.tag === 'RAM ') {
          const data = await unpack(h.id, stored, h.rawLen);
          checkRam(data);
          yield { tag: h.tag, index: h.index, data, place: (ram, chunk) => apply(ram, chunk, data) };
        } else yield { tag: h.tag, index: h.index, data: await unpack(h.id, stored, h.rawLen) };
      }
    }

    /** A frame for the pool: its job, its header, where it is in the file, and (placed) its RAM here. */
    type Job = { job: FrameJob; head: Head; at: number; ram?: Uint8Array; chunk?: number };

    async function* pooled(b: Blob, p: LoadPool): AsyncGenerator<ReadFrame> {
      // Pieces given to the workers and not yet done: two each.
      const limit = p.size * 2;
      const ahead: { at: number; piece: Promise<Uint8Array<ArrayBuffer>> }[] = [];
      let next = size;
      const readAhead = () => {
        while (ahead.length < AHEAD && next < b.size) {
          const at = next;
          next = Math.min(at + (opts.piece ?? PIECE), b.size);
          const piece = b.slice(at, next).arrayBuffer().then((x) => new Uint8Array(x));
          piece.catch(() => {}); // thrown when its piece is taken (and not as unhandled if it never is)
          ahead.push({ at, piece });
        }
      };
      /** The piece in hand and where it is in the file. */
      let cur = new Uint8Array(0);
      let curAt = size;
      const end = () => curAt + cur.length;
      /** The jobs of the frames in the piece in hand. */
      let batch: Job[] = [];
      /** Frames `mine` failed by their worker (`failed`, positions in it) read again and done here, in order. */
      const redo = async (mine: Job[], failed: number[]) => {
        for (const k of failed) {
          const j = mine[k];
          const frame = new Uint8Array(await b.slice(j.at, j.at + FRAME_HEADER + j.job.len).arrayBuffer());
          if (frame.length !== FRAME_HEADER + j.job.len) throw truncated();
          if (j.ram) await placeHere(frame, j.head, j.ram, j.chunk!);
          else {
            checkHere(frame, j.head.want);
            if (j.job.unpack) await unpack(j.head.id, frame.subarray(FRAME_HEADER), j.head.rawLen);
          }
        }
      };
      /** `mine`, frames of `piece`, given to a worker (waiting while `limit` pieces are with them). */
      const give = async (piece: ArrayBuffer, mine: Job[]) => {
        if (!mine.length) return;
        while (jobs.length >= limit) await settleOne();
        settle(p.frames(piece, mine.map((j) => j.job)).then(
          (r) => {
            times.crc += r.crc;
            times.unpack += r.unpack;
            times.apply += r.apply;
            return redo(mine, r.failed);
          },
          () => redo(mine, mine.map((_, k) => k)),
        ));
      };
      /** The next piece in hand, the one before given away with its jobs (dropped without); false at the file's end. */
      const advance = async () => {
        const [piece, mine] = [cur.buffer as ArrayBuffer, batch];
        [batch, curAt, cur] = [[], end(), new Uint8Array(0)];
        await give(piece, mine);
        readAhead();
        const a = ahead.shift();
        if (!a) return false;
        const t = performance.now();
        cur = await a.piece;
        times.read += performance.now() - t;
        curAt = a.at;
        readAhead();
        return true;
      };
      /** The file's `n` bytes at `at` (in hand or after) copied into `out` from `o`, through the pieces; false at the end. */
      const copy = async (at: number, n: number, out: Uint8Array, o: number) => {
        while (n > 0) {
          while (at >= end()) if (!(await advance())) return false;
          const k = Math.min(n, end() - at);
          out.set(cur.subarray(at - curAt, at - curAt + k), o);
          [at, o, n] = [at + k, o + k, n - k];
        }
        return true;
      };

      flush = async () => {
        const mine = batch;
        batch = [];
        if (mine.length) await give(cur.slice().buffer, mine);
      };
      let pos = size;
      let count = 0;
      for (;;) {
        while (pos >= end()) if (!(await advance())) throw truncated();
        // The frame's header, in the piece in hand or across two.
        let hv = cur.subarray(pos - curAt, pos - curAt + FRAME_HEADER);
        if (pos + FRAME_HEADER > end()) {
          hv = new Uint8Array(FRAME_HEADER);
          if (!(await copy(pos, FRAME_HEADER, hv, 0))) throw truncated();
        }
        const h = frameHead(hv, version, codec.id);
        if (h.tag === 'END ') {
          if (h.index !== count) throw corrupt(msg('snapshots:snapshot-file.damage.endCount', { counted: h.index, came: count }));
          if (pos + FRAME_HEADER < b.size) throw corrupt(msg('snapshots:snapshot-file.damage.afterEnd'));
          await give(cur.buffer as ArrayBuffer, batch);
          batch = [];
          await placed(); // the check pass is over once every frame's CRC is in
          return;
        }
        // The frame whole: in the piece in hand, or copied out of the pieces it spans (its own, given alone).
        const at = pos;
        const len = FRAME_HEADER + h.storedLen;
        const inPiece = at >= curAt && at + len <= end();
        let frame: Uint8Array;
        if (inPiece) frame = cur.subarray(at - curAt, at - curAt + len);
        else {
          frame = new Uint8Array(len);
          frame.set(hv);
          if (!(await copy(at + FRAME_HEADER, h.storedLen, frame, FRAME_HEADER))) throw truncated();
        }
        pos += len;
        count++;
        const j: Job = { job: { at: inPiece ? at - curAt : 0, len: h.storedLen }, head: h, at };
        if (opts.check) {
          if (h.tag === 'DISK') j.job.unpack = true;
          if (inPiece) batch.push(j);
          else await give(frame.buffer as ArrayBuffer, [j]);
          yield { tag: h.tag, index: h.index, data: new Uint8Array(0), size: h.rawLen };
          continue;
        }
        if (h.tag !== 'RAM ') {
          // Read here (CORE, DEVS, BLOB and DISK: a copy, the piece goes on to a worker).
          checkHere(frame, h.want);
          yield { tag: h.tag, index: h.index, data: await unpack(h.id, frame.subarray(FRAME_HEADER), h.rawLen) };
          continue;
        }
        let lent = false;
        const place = (ram: Uint8Array, chunk: number) => {
          if (lent) throw new Error('a frame is placed once');
          lent = true;
          // RAM that isn't shared memory is placed here, from a copy (the piece goes on to a worker).
          if (!(ram.buffer instanceof SharedArrayBuffer)) return settle(placeHere(frame.slice(), h, ram, chunk));
          Object.assign(j, { ram, chunk });
          j.job.place = { ram: ram.buffer, off: ram.byteOffset, len: ram.length, chunk };
          if (inPiece) batch.push(j);
        };
        yield { tag: h.tag, index: h.index, data: new Uint8Array(0), place };
        if (!inPiece && j.job.place) await give(frame.buffer as ArrayBuffer, [j]);
      }
    }

    async function* frames(): AsyncGenerator<ReadFrame> {
      try {
        yield* pool ? pooled(source as Blob, pool) : oneThread();
      } catch (e) {
        // An earlier frame's refusal comes first, as it would on one thread: a job's is (the jobs still queued are later
        // frames'); a refusal of the structure here is after the frames queued before it, those of the piece in hand
        // not yet given to a worker too.
        if (e !== jobRefusal) {
          await flush();
          for (const j of jobs.splice(0)) {
            const f = await j;
            if (f) throw f;
          }
        }
        throw e;
      } finally {
        input.close();
      }
    }

    if (pool) input.close();
    return { header: head, frames, placed, times, pooled: pool?.size ?? 0 };
  } catch (e) {
    input.close();
    throw e;
  }
}
