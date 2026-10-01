// Snapshot file (M8 snapshots loop 4; docs/plans/snapshots.md "The file"): the container a saved
// machine is written to and read back from, streamed both ways (RAM is up to GiBs). Pure platform
// APIs (CompressionStream, ReadableStream, Blob), so it runs in Node and in a worker. It knows
// nothing of the core: CORE is opaque bytes, DEVS is JSON the caller makes, RAM and DISK are cut
// here.
//
//   File  = "WEBPCSNP"  u32 version (1)  u32 headerLen  header (JSON)  u32 crc32(header)  Frame*  END
//   Frame = u32 tag  u32 codec  u64 index  u32 rawLen  u32 storedLen  u32 crc  u32 reserved (0), then
//           the stored bytes. Little-endian. The CRC covers the first 24 header bytes (tag to
//           storedLen: so a flipped index or length is caught) and then the stored bytes. END's
//           CRC is 0: its index is the number of frames before it.
//
// Tags: CORE and DEVS (chunked in 1 MiB frames, joined in index order), "RAM " (guest RAM in 1 MiB
// chunks: a 32-byte bitmap of the present 4 KiB pages, then those pages; a zero page is absent, a
// chunk without pages has no frame), DISK (a run of 1 to 256 consecutive overlay blocks, index =
// the first block), "END ". Codec 0 is stored, 1 is deflate-raw; each frame is compressed alone, and
// stored when compressing doesn't shrink it. Codecs plug in by id.

/** What the file says about itself; `machine` and the rest are the caller's (opaque here). */
export type SnapshotHeader = { format: 1; coreVersion: number; abi: number; created: string; [key: string]: unknown };
/** Appends bytes to the output, in order. */
export type Sink = (bytes: Uint8Array) => void | Promise<void>;
/** A frame codec: id as in the frame header. Pluggable so another codec (an LZ in the core, id 2) can be added later. */
export type Codec = { id: number; compress(raw: Uint8Array): Promise<Uint8Array>; decompress(stored: Uint8Array, rawLen: number): Promise<Uint8Array> };

const MAGIC = new TextEncoder().encode('WEBPCSNP');
const VERSION = 1;
const FRAME_HEADER = 32;
const MAX_HEADER = 1 << 20;
const CHUNK = 1 << 20; // raw bytes of a CORE or DEVS frame, and of the guest RAM in a RAM frame
const PAGE = 4096;
const BITMAP = 32;
const MAX_RAW = CHUNK + BITMAP;
const MAX_RUN = 256; // blocks in a DISK frame
const TAGS = new Set(['CORE', 'DEVS', 'RAM ', 'DISK', 'END ']);

/** Why a file was refused: `not-snapshot`, `newer-format`, `truncated` or `corrupt`; the message says what to do. */
export class SnapshotError extends Error {
  problem: 'not-snapshot' | 'newer-format' | 'truncated' | 'corrupt';
  constructor(problem: SnapshotError['problem'], message: string) {
    super(message);
    this.name = 'SnapshotError';
    this.problem = problem;
  }
}

const corrupt = (what: string) => new SnapshotError('corrupt', `This snapshot is damaged (${what}). Download or copy it again; if it keeps failing, save a new one.`);
const truncated = () => new SnapshotError('truncated', 'This snapshot is incomplete: the file ends before its end marker, so it was cut short while it was written or copied. Download or copy it again.');

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

// ---- codecs ----

/** Reads a stream to its end (at most `limit` bytes: more is a refusal, so a bomb can't fill memory). */
async function collect(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      reader.cancel().catch(() => {});
      throw corrupt('a compressed frame expands past its stated size');
    }
    parts.push(value);
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Codec 1: raw deflate through the platform's `CompressionStream` (available in Node and in every worker). */
export const deflateCodec: Codec = {
  id: 1,
  compress: (raw) => collect(new Blob([new Uint8Array(raw)]).stream().pipeThrough(new CompressionStream('deflate-raw')), Infinity),
  decompress: (stored, rawLen) => collect(new Blob([new Uint8Array(stored)]).stream().pipeThrough(new DecompressionStream('deflate-raw')), rawLen),
};

// ---- RAM and DISK frames ----

/** Whether the 4 KiB page at byte `off` of `w` (a Uint32Array over a 4-aligned view) is all zeros. */
function zeroPage(w: Uint32Array, off: number) {
  for (let i = off >> 2, end = i + 1024; i < end; i += 8) {
    if ((w[i] | w[i + 1] | w[i + 2] | w[i + 3] | w[i + 4] | w[i + 5] | w[i + 6] | w[i + 7]) !== 0) return false;
  }
  return true;
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
  if (data.length < BITMAP + PAGE || (data.length - BITMAP) % PAGE !== 0) throw corrupt('a memory block has an impossible size');
  const pages = popcount(data.subarray(0, BITMAP));
  if (pages * PAGE !== data.length - BITMAP) throw corrupt("a memory block's page map and its length disagree");
  return pages;
}

/** Writes a RAM frame's pages into `ram` (a view of guest RAM, possibly shared), which starts zeroed. */
export function applyRam(ram: Uint8Array, index: number, data: Uint8Array): void {
  const pages = checkRam(data);
  const first = index * (CHUNK / PAGE);
  const have = Math.floor(ram.length / PAGE);
  if (!Number.isSafeInteger(first) || first >= have) throw corrupt('a memory block is past the end of RAM: this snapshot is of a machine with more memory');
  let at = BITMAP;
  let seen = 0;
  for (let p = 0; p < 256 && seen < pages; p++) {
    if (!(data[p >> 3] & (1 << (p & 7)))) continue;
    seen++;
    if (first + p >= have) throw corrupt('a memory block is past the end of RAM: this snapshot is of a machine with more memory');
    ram.set(data.subarray(at, at + PAGE), (first + p) * PAGE);
    at += PAGE;
  }
}

/** A DISK frame's blocks (4 KiB each, as views of `data`). */
export function* diskBlocks(index: number, data: Uint8Array): Generator<{ block: number; data: Uint8Array }> {
  if (data.length === 0 || data.length % PAGE !== 0 || data.length > MAX_RUN * PAGE) throw corrupt('a disk block run has an impossible size');
  for (let i = 0; i < data.length / PAGE; i++) yield { block: index + i, data: data.subarray(i * PAGE, (i + 1) * PAGE) };
}

// ---- writer ----

/** The frame's CRC: its first 24 header bytes, then the stored bytes. */
function frameCrc(head: Uint8Array, stored: Uint8Array) {
  return crc32(stored, crc32(head.subarray(0, 24)));
}

/** Writes a snapshot to a sink, a frame at a time: CORE and DEVS first, then RAM, DISK, and `end()`. */
export class SnapshotWriter {
  #sink: Sink;
  #codec: Codec;
  #concurrency: number;
  #inflight: Promise<void>[] = [];
  #tail: Promise<void> = Promise.resolve();
  #bytes = 0;
  #frames = 0;
  #ended = false;
  #failed: unknown = undefined;
  #hasFailed = false;
  #index = new Map<string, number>();

  /** `concurrency` frames may be compressed at once (default 4), each at most 1 MiB; they are written in order. */
  constructor(sink: Sink, header: SnapshotHeader, opts: { codec?: Codec; concurrency?: number } = {}) {
    this.#sink = sink;
    this.#codec = opts.codec ?? deflateCodec;
    this.#concurrency = Math.max(1, Math.floor(opts.concurrency ?? 4));
    const json = new TextEncoder().encode(JSON.stringify(header));
    const out = new Uint8Array(8 + 4 + 4 + json.length + 4);
    const v = new DataView(out.buffer);
    out.set(MAGIC, 0);
    v.setUint32(8, VERSION, true);
    v.setUint32(12, json.length, true);
    out.set(json, 16);
    v.setUint32(16 + json.length, crc32(json), true);
    this.#push(Promise.resolve(out));
  }

  /** Queues `bytes` (a promise: its compression) behind what is queued, and waits while too many are in flight. */
  #push(bytes: Promise<Uint8Array>) {
    const written = this.#tail.then(() => bytes).then(async (b) => {
      this.#bytes += b.length;
      await this.#sink(b);
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
      if (codec.id !== 0) {
        const packed = await codec.compress(raw);
        if (packed.length < raw.length) { id = codec.id; stored = packed; }
      }
      return encodeFrame(tag, id, index, raw.length, stored);
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

  /**
   * Guest RAM, a 1 MiB chunk at a time (all-zero pages left out, all-zero chunks skipped). `ram` may
   * be a view of shared memory. Its length is a multiple of 4096.
   */
  async ram(ram: Uint8Array, progress?: (done: number, total: number) => void): Promise<{ pages: number; frames: number }> {
    if (ram.length % PAGE !== 0) throw new RangeError('RAM is a whole number of 4 KiB pages');
    // Scanned where it lies when 4-aligned (the usual case); otherwise a chunk is copied first.
    const aligned = ram.byteOffset % 4 === 0 ? new Uint32Array(ram.buffer, ram.byteOffset, ram.length >> 2) : null;
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
      const bitmap = new Uint8Array(BITMAP);
      let present = 0;
      for (let p = 0; p < len / PAGE; p++) {
        if (!zeroPage(words, off + p * PAGE)) { bitmap[p >> 3] |= 1 << (p & 7); present++; }
      }
      if (present) {
        const raw = new Uint8Array(BITMAP + present * PAGE);
        raw.set(bitmap, 0);
        let at = BITMAP;
        for (let p = 0; p < len / PAGE; p++) {
          if (!(bitmap[p >> 3] & (1 << (p & 7)))) continue;
          raw.set(src.subarray(off + p * PAGE, off + (p + 1) * PAGE), at);
          at += PAGE;
        }
        pages += present;
        frames++;
        await this.#frame('RAM ', base / CHUNK, raw);
      }
      progress?.(base + len, ram.length);
    }
    return { pages, frames };
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
    this.#push(Promise.resolve(encodeFrame('END ', 0, this.#frames, 0, new Uint8Array(0), true)));
    await this.#drain(0);
    await this.#tail;
    return { bytes: this.#bytes, frames: this.#frames };
  }
}

function encodeFrame(tag: string, codec: number, index: number, rawLen: number, stored: Uint8Array, end = false) {
  const out = new Uint8Array(FRAME_HEADER + stored.length);
  const v = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = tag.charCodeAt(i);
  v.setUint32(4, codec, true);
  v.setUint32(8, index % 2 ** 32, true);
  v.setUint32(12, Math.floor(index / 2 ** 32), true);
  v.setUint32(16, rawLen, true);
  v.setUint32(20, stored.length, true);
  out.set(stored, FRAME_HEADER);
  v.setUint32(24, end ? 0 : frameCrc(out, stored), true);
  return out;
}

// ---- reader ----

/** Pulls exact byte counts out of a stream whose chunks come in any size. */
class Input {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #chunks: Uint8Array[] = [];
  #ci = 0;
  #off = 0;
  #avail = 0;
  #done = false;
  constructor(stream: ReadableStream<Uint8Array>) { this.#reader = stream.getReader(); }

  async #more() {
    const { done, value } = await this.#reader.read();
    if (done) { this.#done = true; return; }
    if (!(value instanceof Uint8Array)) throw corrupt('the file is not made of bytes');
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

  close() { this.#reader.cancel().catch(() => {}); }
}

/**
 * Opens a snapshot for reading: checks its magic, version and header (throws a `SnapshotError`
 * before anything else is read), then `frames()` yields each frame, CRC-verified and decompressed,
 * as it arrives. A stream shorter than the magic is `not-snapshot`; a file that ends later without
 * its end marker is `truncated`. `frames()` reads the stream once; the end of the file is checked
 * when it finishes.
 */
export async function openSnapshot(
  source: ReadableStream<Uint8Array> | Blob,
  opts: { codecs?: Codec[] } = {},
): Promise<{ header: SnapshotHeader; frames(): AsyncGenerator<{ tag: string; index: number; data: Uint8Array }> }> {
  const codecs = new Map<number, Codec>([[1, deflateCodec]]);
  for (const c of opts.codecs ?? []) codecs.set(c.id, c);
  const input = new Input(source instanceof Blob ? source.stream() : source);
  try {
    const magic = await input.take(8);
    if (!magic || MAGIC.some((b, i) => magic[i] !== b)) {
      throw new SnapshotError('not-snapshot', "This file isn't a snapshot (it doesn't start with the snapshot signature). To start a machine from a disk image, use Open disk…; to load saved changes, use Load changes….");
    }
    const fixed = await input.take(8);
    if (!fixed) throw truncated();
    const fv = new DataView(fixed.buffer, fixed.byteOffset, 8);
    const version = fv.getUint32(0, true);
    if (version > VERSION) {
      throw new SnapshotError('newer-format', `This snapshot was made by a newer version of this page (snapshot format ${version}; this one reads format ${VERSION}). Reload the page to get the latest version, or open the snapshot in the page that made it.`);
    }
    if (version < VERSION) throw corrupt('its format number is not valid');
    const headerLen = fv.getUint32(4, true);
    if (headerLen > MAX_HEADER) throw corrupt('its header is too long');
    const json = await input.take(headerLen);
    const crcBytes = json && (await input.take(4));
    if (!json || !crcBytes) throw truncated();
    if (new DataView(crcBytes.buffer, crcBytes.byteOffset, 4).getUint32(0, true) !== crc32(json)) throw corrupt('its header fails its checksum');
    let header: SnapshotHeader;
    try {
      header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
    } catch {
      throw corrupt('its header is not readable');
    }
    if (typeof header !== 'object' || header === null || Array.isArray(header) || header.format !== 1) throw corrupt('its header is not one this page knows');

    async function* frames() {
      try {
        let count = 0;
        for (;;) {
          const h = await input.take(FRAME_HEADER);
          if (!h) throw truncated();
          const v = new DataView(h.buffer, h.byteOffset, FRAME_HEADER);
          const tag = String.fromCharCode(h[0], h[1], h[2], h[3]);
          const codec = v.getUint32(4, true);
          const hi = v.getUint32(12, true);
          const index = hi * 2 ** 32 + v.getUint32(8, true);
          const rawLen = v.getUint32(16, true);
          const storedLen = v.getUint32(20, true);
          const crc = v.getUint32(24, true);
          if (!TAGS.has(tag)) throw corrupt('a part of it has an unknown kind');
          if (v.getUint32(28, true) !== 0 || hi >= 2 ** 21) throw corrupt('a frame header has impossible fields');
          if (tag === 'END ') {
            if (rawLen !== 0 || storedLen !== 0 || crc !== 0 || codec !== 0) throw corrupt('its end marker is malformed');
            if (index !== count) throw corrupt(`its end marker counts ${index} frames but ${count} came before it`);
            if (await input.more()) throw corrupt('there are bytes after its end marker');
            return;
          }
          if (rawLen === 0 || rawLen > MAX_RAW || storedLen > rawLen) throw corrupt('a frame has an impossible size');
          if (codec === 0 ? storedLen !== rawLen : !codecs.has(codec)) {
            throw corrupt(codec === 0 ? 'a frame has an impossible size' : `a frame is compressed with codec ${codec}, which this page can't read; open it in the page that made it`);
          }
          if (tag === 'CORE' || tag === 'DEVS' ? rawLen > CHUNK : tag === 'DISK' ? rawLen % PAGE !== 0 || rawLen > MAX_RUN * PAGE : false) {
            throw corrupt('a frame has an impossible size');
          }
          const headBytes = h.slice(0, 24); // `h` is a view of the input's buffer, which the next take may reuse
          const stored = await input.take(storedLen);
          if (!stored) throw truncated();
          if (frameCrc(headBytes, stored) !== crc) throw corrupt('a checksum fails');
          let data: Uint8Array;
          if (codec === 0) data = stored.slice();
          else {
            try {
              data = await codecs.get(codec)!.decompress(stored, rawLen);
            } catch (e) {
              if (e instanceof SnapshotError) throw e;
              throw corrupt('a compressed frame does not unpack');
            }
            if (data.length !== rawLen) throw corrupt('a compressed frame unpacks to the wrong size');
          }
          if (tag === 'RAM ') checkRam(data);
          count++;
          yield { tag, index, data };
        }
      } finally {
        input.close();
      }
    }

    return { header, frames };
  } catch (e) {
    input.close();
    throw e;
  }
}
