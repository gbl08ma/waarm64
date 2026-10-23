// Disk images for the read-only block backends (web/devices.ts): raw, or qcow2
// v2/v3 read through its L1/L2 tables (M4 step 4). Written from the format
// spec, QEMU's docs/interop/qcow2.txt (no QEMU code). Refcounts are ignored
// (read-only); unallocated and zero-flag clusters read as zeros; compressed
// clusters are raw deflate. Refused at open: encryption, backing files (a changes
// file is read by `readChanges`, not booted), external data files, extended L2
// entries, zstd, unknown incompatible features. core/tests/common/qcow2.rs is the
// native twin.

/** Reads exactly `len` bytes of the image file at `off`, or undefined (error, past the end). */
export type ReadAt = (off: number, len: number) => Uint8Array | undefined;
/** `ReadAt` without blocking: a remote disk's (`fetch`), so a request's reads and other requests' run at once. */
export type ReadAtAsync = (off: number, len: number) => Promise<Uint8Array | undefined>;

/**
 * Inflates compressed clusters, each to exactly `size` bytes (undefined where one doesn't unpack), in
 * the order given. `openDisk` hands it every cluster a request needs at once: `inflateEach` on the
 * reading thread, or web/inflate-pool.ts on other threads too.
 */
export type Inflater = (inputs: Uint8Array[], size: number) => Promise<(Uint8Array | undefined)[]>;

/**
 * The clusters one after another on this thread: streams side by side on one thread don't run any
 * faster (deflate's, 64 or 512 at once, were slower than one at a time: docs/frontend.md "Your own disk").
 */
export const inflateEach: Inflater = async (inputs, size) => {
  const out: (Uint8Array | undefined)[] = [];
  for (const input of inputs) out.push(await inflate(input, size));
  return out;
};

export type Disk = {
  /** Virtual size in bytes. */
  size: number;
  format: 'raw' | 'qcow2';
  /** Exactly `len` bytes at `off`, or undefined past the end or on a read error. */
  read(off: number, len: number): Promise<Uint8Array | undefined>;
};

const MAGIC = 0x514649fb; // "QFI\xfb"
const HEADER = 112; // enough for every field we read
const OFFSET_MASK = 0x00ff_ffff_ffff_fe00n; // bits 9-55: L1/L2 table and standard cluster offsets
const COMPRESSED = 1n << 62n;
const ZERO = 1n; // v3: the cluster reads as zeros
/** Host ranges of one request this close together are one read, of at most MERGE_MAX bytes (`merged`). */
const MERGE_GAP = 64 * 1024;
const MERGE_MAX = 8 << 20;
const KNOWN_INCOMPATIBLE = 1n << 0n | 1n << 1n | 1n << 3n; // dirty, corrupt (both only matter to writers), compression type

/** Whether the first bytes of a file are a qcow2 header. */
export const isQcow2 = (head: Uint8Array) => head.length >= 4 && new DataView(head.buffer, head.byteOffset).getUint32(0) === MAGIC;

/** The virtual size from a qcow2 header (its first 32 bytes). */
export const qcow2Size = (head: Uint8Array) => Number(new DataView(head.buffer, head.byteOffset).getBigUint64(24));

/**
 * Opens an image of `fileSize` bytes: qcow2 by its magic, raw otherwise. Throws on what qcow2 we don't support.
 * `inflater` unpacks a request's compressed clusters. With `readAsync`, requests read the file through it (the
 * header and L1 table at the opening still through `readAt`): a request's L2 tables and its merged reads at once.
 */
export function openDisk(readAt: ReadAt, fileSize: number, inflater: Inflater = inflateEach, readAsync?: ReadAtAsync): Disk {
  const head = fileSize >= HEADER ? readAt(0, HEADER) : undefined;
  if (!head || !isQcow2(head)) {
    return { size: fileSize, format: 'raw', read: async (off, len) => (off + len > fileSize ? undefined : readAsync ? readAsync(off, len) : readAt(off, len)) };
  }
  const h = new DataView(head.buffer, head.byteOffset, HEADER);
  const fail = (why: string): never => { throw new Error(`qcow2: ${why}`); };
  const version = h.getUint32(4);
  if (version !== 2 && version !== 3) fail(`version ${version}`);
  if (h.getBigUint64(8) !== 0n) fail('backing files are not supported: this is a changes file over another image, load it with "Load changes…" over that image, it is not a disk to boot');
  const clusterBits = h.getUint32(20);
  if (clusterBits < 9 || clusterBits > 21) fail(`cluster_bits ${clusterBits}`);
  const size = Number(h.getBigUint64(24));
  if (h.getUint32(32) !== 0) fail('encrypted images are not supported');
  const l1Size = h.getUint32(36);
  const l1Offset = Number(h.getBigUint64(40));
  if (version === 3) {
    const incompatible = h.getBigUint64(72);
    if (incompatible & 1n << 2n) fail('external data files are not supported');
    if (incompatible & 1n << 4n) fail('extended L2 entries are not supported');
    if (incompatible & ~KNOWN_INCOMPATIBLE) fail(`unknown incompatible features 0x${incompatible.toString(16)}`);
    if (incompatible & 1n << 3n && h.getUint32(100) > 104 && h.getUint8(104) !== 0) fail('zstd compression is not supported');
  }
  const cs = 2 ** clusterBits;
  const l2Entries = cs / 8;
  if (l1Size * l2Entries * cs < size) fail('L1 table too small for the virtual size');
  const l1b = readAt(l1Offset, l1Size * 8) ?? fail('L1 table past the end of the file');
  const l1 = new DataView(l1b.buffer, l1b.byteOffset, l1b.byteLength);

  // L2 tables, kept once read (1/8192 of the virtual size at 64 KiB clusters).
  const l2s = new Map<number, DataView>();
  /** L2 tables being read without blocking (`readAsync`), so two requests read one once. */
  const loading = new Map<number, Promise<boolean>>();
  /** Reads L2 table `i` with `readAsync` if it isn't kept yet; false if that fails. */
  const loadL2 = (i: number): Promise<boolean> | boolean => {
    if (l2s.has(i)) return true;
    const off = Number(l1.getBigUint64(i * 8) & OFFSET_MASK);
    if (off === 0) return true; // unallocated: `l2` makes it
    let p = loading.get(i);
    if (!p) {
      p = readAsync!(off, cs).then((b) => {
        loading.delete(i);
        if (b) l2s.set(i, new DataView(b.buffer, b.byteOffset, cs));
        return !!b;
      });
      loading.set(i, p);
    }
    return p;
  };
  const l2 = (i: number) => {
    let t = l2s.get(i);
    if (!t) {
      const off = Number(l1.getBigUint64(i * 8) & OFFSET_MASK);
      const b = off === 0 ? new Uint8Array(cs) : readAt(off, cs); // unallocated: every entry 0
      if (!b) return undefined;
      l2s.set(i, (t = new DataView(b.buffer, b.byteOffset, cs)));
    }
    return t;
  };

  // Compressed clusters (bits 0..x-1 the host offset, x..61 the number of 512-byte
  // sectors after the first, x = 62 - (cluster_bits - 8)), kept decompressed for the
  // few most recent (a guest reads a 64 KiB cluster a page at a time).
  const x = BigInt(62 - (clusterBits - 8));
  /** Where a compressed cluster's bytes are in the file: they run to a sector boundary (or the file's end). */
  const extent = (e: bigint): [number, number] => {
    const off = Number(e & ((1n << x) - 1n));
    const sectors = Number((e & ((1n << 62n) - 1n)) >> x) + 1;
    return [off, Math.min(sectors * 512 - (off & 511), fileSize - off)];
  };
  const recent = new Map<bigint, Uint8Array>();

  /**
   * A reader of the file for one request: the host ranges it needs (`ranges`: [start, end)) that
   * lie close together are read at once (an image's clusters mostly follow each other in the
   * file, compressed ones end to end), so a request over many clusters is a few host reads (HTTP
   * requests), not one per cluster. A failed merged read leaves its ranges to their own reads.
   */
  const merged = (ranges: [number, number][]): ReadAt => {
    if (ranges.length < 2) return readAt;
    ranges.sort((p, q) => p[0] - q[0]);
    const windows: { at: number; bytes: Uint8Array }[] = [];
    for (let i = 0; i < ranges.length;) {
      let [start, end] = ranges[i];
      let j = i + 1;
      for (; j < ranges.length && ranges[j][0] - end <= MERGE_GAP && Math.max(end, ranges[j][1]) - start <= MERGE_MAX; j++) end = Math.max(end, ranges[j][1]);
      if (j - i > 1) {
        const bytes = readAt(start, end - start);
        if (bytes) windows.push({ at: start, bytes });
      }
      i = j;
    }
    return (off, len) => {
      for (const w of windows) if (off >= w.at && off + len <= w.at + w.bytes.length) return w.bytes.subarray(off - w.at, off - w.at + len);
      return readAt(off, len);
    };
  };
  /**
   * `merged` with `readAsync`: every group of close ranges (one range alone too) read at once; a group whose read
   * fails leaves its ranges to their own reads, also at once. The reader it returns has them all.
   */
  const mergedAsync = async (ranges: [number, number][]): Promise<ReadAt> => {
    ranges.sort((p, q) => p[0] - q[0]);
    const windows: { at: number; bytes: Uint8Array }[] = [];
    const reads: Promise<void>[] = [];
    const window = (start: number, end: number) => readAsync!(start, end - start).then((bytes) => { if (bytes) windows.push({ at: start, bytes }); return !!bytes; });
    for (let i = 0; i < ranges.length;) {
      let [start, end] = ranges[i];
      let j = i + 1;
      for (; j < ranges.length && ranges[j][0] - end <= MERGE_GAP && Math.max(end, ranges[j][1]) - start <= MERGE_MAX; j++) end = Math.max(end, ranges[j][1]);
      const group = ranges.slice(i, j);
      reads.push(window(start, end).then(async (ok) => { if (!ok && group.length > 1) await Promise.all(group.map(([a, b]) => window(a, b))); }));
      i = j;
    }
    await Promise.all(reads);
    return (off, len) => {
      for (const w of windows) if (off >= w.at && off + len <= w.at + w.bytes.length) return w.bytes.subarray(off - w.at, off - w.at + len);
      return undefined;
    };
  };

  const read = async (off: number, len: number) => {
    if (off < 0 || off + len > size) return undefined;
    if (readAsync && len > 0) {
      // The request's L2 tables first, all at once.
      const tables: (Promise<boolean> | boolean)[] = [];
      for (let t = Math.floor(off / cs / l2Entries); t <= Math.floor((off + len - 1) / cs / l2Entries); t++) tables.push(loadL2(t));
      if ((await Promise.all(tables)).includes(false)) return undefined;
    }
    const out = new Uint8Array(len);
    // The request's clusters: what each needs from the file, then the reads, then the bytes.
    const pieces: { k: number; o: number; n: number; e: bigint }[] = [];
    const ranges: [number, number][] = [];
    const clusters = new Map<bigint, Uint8Array>(); // the compressed ones, inflated (from `recent`, or below)
    const wanted = new Set<bigint>();
    for (let k = 0; k < len;) {
      const pos = off + k;
      const c = Math.floor(pos / cs);
      const o = pos % cs;
      const n = Math.min(cs - o, len - k);
      const t = l2(Math.floor(c / l2Entries));
      if (!t) return undefined;
      const e = t.getBigUint64((c % l2Entries) * 8);
      if (e & COMPRESSED) {
        const [at, bytes] = extent(e);
        const kept = recent.get(e);
        if (kept) clusters.set(e, kept);
        else if (!wanted.has(e) && bytes > 0) { wanted.add(e); ranges.push([at, at + bytes]); }
        pieces.push({ k, o, n, e });
      } else if (!(version === 3 && e & ZERO) && (e & OFFSET_MASK) !== 0n) {
        ranges.push([Number(e & OFFSET_MASK) + o, Number(e & OFFSET_MASK) + o + n]);
        pieces.push({ k, o, n, e });
      } // else unallocated or zero: out is already zeros
      k += n;
    }
    const from = readAsync ? await mergedAsync(ranges) : merged(ranges);
    // The compressed clusters all at once, not one after another (a 1 MiB read of 64 KiB clusters is 16).
    if (wanted.size) {
      const packed = [...wanted];
      const inputs: Uint8Array[] = [];
      for (const e of packed) {
        const input = from(...extent(e));
        if (!input) return undefined;
        inputs.push(input);
      }
      const unpacked = await inflater(inputs, cs);
      for (const [i, e] of packed.entries()) {
        const data = unpacked[i];
        if (!data) return undefined;
        clusters.set(e, data);
        recent.set(e, data);
        if (recent.size > 16) recent.delete(recent.keys().next().value!);
      }
    }
    for (const { k, o, n, e } of pieces) {
      const data = e & COMPRESSED ? clusters.get(e)?.subarray(o, o + n) : from(Number(e & OFFSET_MASK) + o, n);
      if (!data) return undefined;
      out.set(data, k);
    }
    return out;
  };
  return { size, format: 'qcow2', read };
}

/** The cluster of the compressed L2 entry `e`, or undefined (a failed read, or bytes that don't unpack to a cluster). */
async function compressedCluster(readAt: ReadAt, fileSize: number, e: bigint, clusterBits: number) {
  const x = BigInt(62 - (clusterBits - 8));
  const off = Number(e & ((1n << x) - 1n));
  const sectors = Number((e & ((1n << 62n) - 1n)) >> x) + 1;
  const len = Math.min(sectors * 512 - (off & 511), fileSize - off);
  const input = len > 0 ? readAt(off, len) : undefined;
  return input && inflate(input, 2 ** clusterBits);
}

/**
 * Raw deflate of one cluster: exactly `size` bytes out, or undefined. The input
 * runs to a sector boundary, so it usually ends with the next cluster's bytes,
 * which the stream reports as junk after its end. Chromium hands over the output
 * first; Firefox drops what the write holding the junk produced. So when one
 * write comes up short, the last sector (where the stream ends) goes in a byte a
 * write: the write that ends the stream then delivers before the junk arrives
 * (~3 ms a 64 KiB cluster instead of ~0.4: Firefox only).
 */
export async function inflate(input: Uint8Array, size: number) {
  const cut = Math.max(0, input.length - 512);
  return await inflateParts([input], size)
    ?? (input.length > 1 ? inflateParts([input.subarray(0, cut), ...Array.from({ length: input.length - cut }, (_, i) => input.subarray(cut + i, cut + i + 1))], size) : undefined);
}

/** `parts` written in turn to one raw-deflate stream, stopping at the first failed write: exactly `size` bytes out, or undefined. */
async function inflateParts(parts: Uint8Array[], size: number) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  const r = ds.readable.getReader();
  const out = new Uint8Array(size);
  let n = 0;
  const reading = (async () => {
    for (;;) {
      const { done, value } = await r.read();
      if (done) return;
      if (n + value.length > size) return void r.cancel().catch(() => {}); // fails the writes still to come
      out.set(value, n);
      n += value.length;
    }
  })().catch(() => {}); // junk after the end
  try {
    for (const p of parts) if (p.length) await w.write(p as Uint8Array<ArrayBuffer>);
    await w.close();
  } catch { /* junk after the end, or a cancelled read */ }
  await reading;
  r.cancel().catch(() => {});
  return n === size ? out : undefined;
}

/** What a changes file says about itself (web/qcow2-write.ts writes it): the base image's file name and hash (web/changes.ts `hashSource`). */
export type ChangesHeader = { backingName: string; hash?: string };

const EXT_BASE_HASH = 0x57504332; // "WPC2" (web/qcow2-write.ts)

/**
 * The backing file's name and our hash extension from a qcow2's first bytes (its first cluster:
 * 64 KiB cover every cluster size), or undefined when it isn't a qcow2 with a backing file.
 */
export function changesHeader(head: Uint8Array): ChangesHeader | undefined {
  if (head.length < HEADER || !isQcow2(head)) return undefined;
  const h = new DataView(head.buffer, head.byteOffset, head.length);
  const nameAt = Number(h.getBigUint64(8));
  const nameLen = h.getUint32(16);
  if (nameAt === 0 || nameAt + nameLen > head.length) return undefined;
  const dec = new TextDecoder();
  let hash: string | undefined;
  for (let at = h.getUint32(4) === 2 ? 72 : h.getUint32(100); at + 8 <= head.length;) {
    const type = h.getUint32(at);
    const len = h.getUint32(at + 4);
    if (type === 0 || at + 8 + len > head.length) break;
    if (type === EXT_BASE_HASH) hash = dec.decode(head.subarray(at + 8, at + 8 + len));
    at += 8 + Math.ceil(len / 8) * 8;
  }
  return { backingName: dec.decode(head.subarray(nameAt, nameAt + nameLen)), hash };
}

/** One 4 KiB block of the disk that a changes file holds (the overlay's block size). */
export type ChangedBlock = { block: number; data: Uint8Array };

/**
 * A changes file: a qcow2 over a base image, read for what it overrides rather than merged with
 * the base. `blocks` yields every 4 KiB block the file holds, in disk order (a zero cluster as
 * zeros: it overrides the base), the last one possibly shorter than 4 KiB at the virtual size's end.
 * Compressed clusters are raw deflate, as in `openDisk`. Undefined when the file has no backing
 * file; throws on what we can't read (zstd, clusters under 4 KiB, the features `openDisk` refuses).
 */
export function readChanges(readAt: ReadAt, fileSize: number): (ChangesHeader & { size: number; blocks(): AsyncGenerator<ChangedBlock> }) | undefined {
  const head = readAt(0, Math.min(fileSize, 1 << 16)) ?? readAt(0, Math.min(fileSize, HEADER));
  const info = head && changesHeader(head);
  if (!head || !info) return undefined;
  const h = new DataView(head.buffer, head.byteOffset, head.length);
  const fail = (why: string): never => { throw new Error(`qcow2: ${why}`); };
  const version = h.getUint32(4);
  if (version !== 2 && version !== 3) fail(`version ${version}`);
  const clusterBits = h.getUint32(20);
  if (clusterBits < 12 || clusterBits > 21) fail(`cluster_bits ${clusterBits} (the changes need clusters of at least 4 KiB)`);
  if (h.getUint32(32) !== 0) fail('encrypted images are not supported');
  if (version === 3) {
    const incompatible = h.getBigUint64(72);
    if (incompatible & ~KNOWN_INCOMPATIBLE) fail(`unsupported incompatible features 0x${incompatible.toString(16)}`);
    if (incompatible & 1n << 3n) fail('compressed (zstd) clusters are not supported');
  }
  const size = Number(h.getBigUint64(24));
  const l1Size = h.getUint32(36);
  const l1Offset = Number(h.getBigUint64(40));
  const cs = 2 ** clusterBits;
  const l2Entries = cs / 8;
  const perCluster = cs / 4096;
  async function* blocks(): AsyncGenerator<ChangedBlock> {
    const l1b = readAt(l1Offset, l1Size * 8) ?? fail('L1 table past the end of the file');
    const l1 = new DataView(l1b.buffer, l1b.byteOffset, l1b.byteLength);
    for (let i = 0; i < l1Size; i++) {
      const l2Off = Number(l1.getBigUint64(i * 8) & OFFSET_MASK);
      if (l2Off === 0) continue;
      const t = readAt(l2Off, cs) ?? fail('L2 table past the end of the file');
      const l2 = new DataView(t.buffer, t.byteOffset, cs);
      for (let k = 0; k < l2Entries; k++) {
        const e = l2.getBigUint64(k * 8);
        const packed = (e & COMPRESSED) !== 0n;
        const off = Number(e & OFFSET_MASK);
        const zero = !packed && version === 3 && (e & ZERO) !== 0n;
        if (!packed && off === 0 && !zero) continue; // unallocated: the base shows through
        const first = (i * l2Entries + k) * cs;
        if (first >= size) continue;
        const data = packed ? await compressedCluster(readAt, fileSize, e, clusterBits) ?? fail('a compressed cluster does not unpack')
          : zero ? new Uint8Array(cs) : readAt(off, cs) ?? fail('a data cluster is past the end of the file');
        for (let b = 0; b < perCluster && first + b * 4096 < size; b++) {
          const n = Math.min(4096, size - (first + b * 4096));
          yield { block: first / 4096 + b, data: data.subarray(b * 4096, b * 4096 + n) };
        }
      }
    }
  }
  return { ...info, size, blocks };
}
