// Disk images for the read-only block backends (web/devices.ts): raw, or qcow2
// v2/v3 read through its L1/L2 tables (M4 step 4). Written from the format
// spec, QEMU's docs/interop/qcow2.txt (no QEMU code). Refcounts are ignored
// (read-only); unallocated and zero-flag clusters read as zeros; compressed
// clusters are raw deflate (inflated by the core's miniz_oxide: web/deflate.ts). Refused at open: encryption, backing files (a changes
// file is read by `readChanges`, not booted), external data files, extended L2
// entries, zstd, unknown incompatible features. core/tests/common/qcow2.rs is the
// native twin.
import { threadDeflate } from './deflate.ts';
import { MsgError } from './msg.ts';

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
 * The clusters one after another on this thread, through its codec (web/deflate.ts: the core's miniz_oxide,
 * synchronous, ~160 µs a 64 KiB cluster in Chromium).
 */
export const inflateEach: Inflater = async (inputs, size) => {
  const z = await threadDeflate();
  return inputs.map((input) => z.inflate(input, size));
};

export type Disk = {
  /** Virtual size in bytes. */
  size: number;
  format: 'raw' | 'qcow2';
  /** Exactly `len` bytes at `off`, or undefined past the end or on a read error. */
  read(off: number, len: number): Promise<Uint8Array | undefined>;
  /**
   * A qcow2's clusters (the disk surface visualizer, web/surface.ts; never on a request's path): over the L2 tables
   * read so far, the ones not read yet read with `load` first (it returns undefined where it can't without fetching: a
   * remote image's not held in this browser), none of them when they'd be more than `ALLOCATION_MAX` bytes. The same
   * object each time: it follows the tables as they are read (`known`, `missing`).
   */
  allocation?(load?: ReadAt): Allocation;
};

/**
 * What a qcow2's clusters hold: its cluster size, and per cluster whether it has data (a data or compressed cluster;
 * not an unallocated or zero one) and where its bytes are in the file. Per L2 table (`perTable` clusters each), whether
 * its entries are known: a table not read yet isn't (its clusters read as unallocated here until it is).
 */
export type Allocation = {
  clusterBytes: number;
  size: number;
  allocated(c: number): boolean;
  /** The clusters one L2 table covers. */
  perTable: number;
  /** Whether table `t`'s entries are known: read, or none to read (an L1 entry without a table: unallocated). */
  known(t: number): boolean;
  /** How many tables aren't known yet (0: the allocation is whole). */
  missing(): number;
  /** Where cluster `c`'s bytes are in the file ([offset, bytes]: a data cluster's, a compressed one's packed bytes), if it has data. */
  host(c: number): [number, number] | undefined;
};

/** The most bytes of L2 tables `allocation` reads (an image of 256 GiB at 64 KiB clusters). */
export const ALLOCATION_MAX = 32 << 20;

/** Whether L2 entry `k` (its index) of table `t` has data: compressed, or a standard cluster with an offset and (v3) no zero flag. */
function hasData(t: DataView, k: number, version: number) {
  const hi = t.getUint32(k * 8);
  const lo = t.getUint32(k * 8 + 4);
  if (hi & 0x4000_0000) return true; // bit 62: compressed
  if (version === 3 && lo & 1) return false; // bit 0: reads as zeros
  return (hi & 0x00ff_ffff) !== 0 || (lo & ~0x1ff) !== 0; // bits 9-55: the offset
}

/**
 * An allocation over L2 tables `l2s` (by their index; one not there is unallocated), of an image whose L1 entries name
 * a table where `hasTable` says, `fileSize` bytes long (a compressed cluster's bytes run at most to its end).
 */
function allocationOver(
  l2s: Map<number, DataView>,
  cs: number,
  size: number,
  version: number,
  l1Size: number,
  hasTable: (t: number) => boolean,
  fileSize: number,
): Allocation {
  const per = cs / 8;
  const bits = Math.log2(cs);
  return {
    clusterBytes: cs,
    size,
    perTable: per,
    allocated(c) {
      const t = l2s.get(Math.floor(c / per));
      return !!t && hasData(t, c % per, version);
    },
    known: (t) => !hasTable(t) || l2s.has(t),
    missing() {
      let n = 0;
      for (let t = 0; t < l1Size; t++) if (hasTable(t) && !l2s.has(t)) n++;
      return n;
    },
    host(c) {
      const t = l2s.get(Math.floor(c / per));
      if (!t || !hasData(t, c % per, version)) return undefined;
      const e = t.getBigUint64((c % per) * 8);
      return e & COMPRESSED ? compressedExtent(e, bits, fileSize) : [Number(e & OFFSET_MASK), cs];
    },
  };
}

/**
 * A qcow2's allocation read whole without blocking (an image file the disk surface's job worker opens: web/app/surface-job.ts):
 * its header, L1 and every L2 table, at most `ALLOCATION_MAX` bytes of them; undefined for a raw image, one this reader
 * refuses, or one whose tables are larger or can't be read. `partial` (a remote image's tables, from the blocks this
 * browser keeps): a table that can't be read, or past `ALLOCATION_MAX` bytes of those read, is left not known instead.
 */
export async function readAllocation(
  read: ReadAtAsync,
  fileSize: number,
  partial = false,
): Promise<Allocation | undefined> {
  const head = fileSize >= HEADER ? await read(0, HEADER) : undefined;
  if (!head || !isQcow2(head)) return undefined;
  const { version, backing, clusterBits, size, encrypted, l1Size, l1Offset, incompatible } = qcow2Header(head);
  if (
    (version !== 2 && version !== 3) ||
    backing !== 0 ||
    clusterBits < 9 ||
    clusterBits > 21 ||
    encrypted ||
    incompatible & ~KNOWN_INCOMPATIBLE
  )
    return undefined;
  const cs = 2 ** clusterBits;
  const l1b = await read(l1Offset, l1Size * 8);
  if (!l1b) return undefined;
  const l1 = new DataView(l1b.buffer, l1b.byteOffset, l1b.byteLength);
  const offs: [number, number][] = [];
  for (let i = 0; i < l1Size; i++) {
    const off = Number(l1.getBigUint64(i * 8) & OFFSET_MASK);
    if (off) offs.push([i, off]);
  }
  if (!partial && offs.length * cs > ALLOCATION_MAX) return undefined;
  const l2s = new Map<number, DataView>();
  for (const [i, off] of offs) {
    if ((l2s.size + 1) * cs > ALLOCATION_MAX) break; // partial: the rest not known
    const b = await read(off, cs);
    if (!b) {
      if (partial) continue;
      return undefined;
    }
    l2s.set(i, new DataView(b.buffer, b.byteOffset, cs));
  }
  const named = new Set(offs.map(([i]) => i)); // an L1 entry names a table (one not read: not known)
  return allocationOver(l2s, cs, size, version, l1Size, (t) => named.has(t), fileSize);
}

const MAGIC = 0x514649fb; // "QFI\xfb"
const HEADER = 112; // enough for every field we read
const OFFSET_MASK = 0x00ff_ffff_ffff_fe00n; // bits 9-55: L1/L2 table and standard cluster offsets
const COMPRESSED = 1n << 62n;
const ZERO = 1n; // v3: the cluster reads as zeros
/** Host ranges of one request this close together are one read, of at most MERGE_MAX bytes (`merged`). */
const MERGE_GAP = 64 * 1024;
const MERGE_MAX = 8 << 20;
const KNOWN_INCOMPATIBLE = (1n << 0n) | (1n << 1n) | (1n << 3n); // dirty, corrupt (both only matter to writers), compression type

/** A qcow2 header's fields (its first `HEADER` bytes), as they are: each reader refuses what it doesn't support. */
export type Qcow2Header = {
  version: number;
  /** The backing file name's offset (0: none). */
  backing: number;
  clusterBits: number;
  size: number;
  encrypted: boolean;
  l1Size: number;
  l1Offset: number;
  /** v3's incompatible feature bits (0 in v2). */
  incompatible: bigint;
  /** v3's compression type (0: deflate), where the header is long enough to have one. */
  compression: number;
};

/** The header of a file whose first bytes `head` (at least `HEADER` of them) are a qcow2's (`isQcow2`). */
export function qcow2Header(head: Uint8Array): Qcow2Header {
  const h = new DataView(head.buffer, head.byteOffset, HEADER);
  const version = h.getUint32(4);
  const v3 = version === 3;
  return {
    version,
    backing: Number(h.getBigUint64(8)),
    clusterBits: h.getUint32(20),
    size: Number(h.getBigUint64(24)),
    encrypted: h.getUint32(32) !== 0,
    l1Size: h.getUint32(36),
    l1Offset: Number(h.getBigUint64(40)),
    incompatible: v3 ? h.getBigUint64(72) : 0n,
    compression: v3 && h.getUint32(100) > 104 ? h.getUint8(104) : 0,
  };
}

/** Where compressed L2 entry `e`'s bytes are in a file of `fileSize` bytes ([offset, bytes]): to a sector boundary. */
function compressedExtent(e: bigint, clusterBits: number, fileSize: number): [number, number] {
  const x = BigInt(62 - (clusterBits - 8));
  const off = Number(e & ((1n << x) - 1n));
  const sectors = Number((e & ((1n << 62n) - 1n)) >> x) + 1;
  return [off, Math.max(0, Math.min(sectors * 512 - (off & 511), fileSize - off))];
}

/** Whether the first bytes of a file are a qcow2 header. */
export const isQcow2 = (head: Uint8Array) =>
  head.length >= 4 && new DataView(head.buffer, head.byteOffset).getUint32(0) === MAGIC;

/** The virtual size from a qcow2 header (its first 32 bytes). */
export const qcow2Size = (head: Uint8Array) => Number(new DataView(head.buffer, head.byteOffset).getBigUint64(24));

/**
 * Opens an image of `fileSize` bytes: qcow2 by its magic, raw otherwise. Throws on what qcow2 we don't support.
 * `inflater` unpacks a request's compressed clusters. With `readAsync`, requests read the file through it (the
 * header and L1 table at the opening still through `readAt`): a request's L2 tables and its merged reads at once.
 */
export function openDisk(
  readAt: ReadAt,
  fileSize: number,
  inflater: Inflater = inflateEach,
  readAsync?: ReadAtAsync,
): Disk {
  const head = fileSize >= HEADER ? readAt(0, HEADER) : undefined;
  if (!head || !isQcow2(head)) {
    return {
      size: fileSize,
      format: 'raw',
      read: async (off, len) => (off + len > fileSize ? undefined : readAsync ? readAsync(off, len) : readAt(off, len)),
    };
  }
  // What the user's image has that this reader refuses is a `MsgError` (the page says it); a malformed structure, a developer's error.
  const fail = (why: string): never => {
    throw new Error(`qcow2: ${why}`);
  };
  const { version, backing, clusterBits, size, encrypted, l1Size, l1Offset, incompatible, compression } =
    qcow2Header(head);
  if (version !== 2 && version !== 3) throw new MsgError('disks:qcow2.version', { version });
  if (backing !== 0) throw new MsgError('disks:qcow2.backing');
  if (clusterBits < 9 || clusterBits > 21) fail(`cluster_bits ${clusterBits}`);
  if (encrypted) throw new MsgError('disks:qcow2.encrypted');
  if (incompatible & (1n << 2n)) throw new MsgError('disks:qcow2.externalData');
  if (incompatible & (1n << 4n)) throw new MsgError('disks:qcow2.extendedL2');
  if (incompatible & ~KNOWN_INCOMPATIBLE)
    throw new MsgError('disks:qcow2.unknownFeatures', { features: incompatible.toString(16) });
  if (incompatible & (1n << 3n) && compression !== 0) throw new MsgError('disks:qcow2.zstd');
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
  /** An unallocated table's entries (all 0): one for every such table, never kept (a 1 TiB disk read across has 2048). */
  let unallocated: DataView | undefined;
  const l2 = (i: number) => {
    let t = l2s.get(i);
    if (!t) {
      const off = Number(l1.getBigUint64(i * 8) & OFFSET_MASK);
      if (off === 0) return (unallocated ??= new DataView(new ArrayBuffer(cs)));
      const b = readAt(off, cs);
      if (!b) return undefined;
      l2s.set(i, (t = new DataView(b.buffer, b.byteOffset, cs)));
    }
    return t;
  };

  // Compressed clusters (bits 0..x-1 the host offset, x..61 the number of 512-byte
  // sectors after the first, x = 62 - (cluster_bits - 8)), kept decompressed for the
  // few most recent (a guest reads a 64 KiB cluster a page at a time).
  /** Where a compressed cluster's bytes are in the file: they run to a sector boundary (or the file's end). */
  const extent = (e: bigint) => compressedExtent(e, clusterBits, fileSize);
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
      for (
        ;
        j < ranges.length && ranges[j][0] - end <= MERGE_GAP && Math.max(end, ranges[j][1]) - start <= MERGE_MAX;
        j++
      )
        end = Math.max(end, ranges[j][1]);
      if (j - i > 1) {
        const bytes = readAt(start, end - start);
        if (bytes) windows.push({ at: start, bytes });
      }
      i = j;
    }
    return (off, len) => {
      for (const w of windows)
        if (off >= w.at && off + len <= w.at + w.bytes.length) return w.bytes.subarray(off - w.at, off - w.at + len);
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
    const window = (start: number, end: number) =>
      readAsync!(start, end - start).then((bytes) => {
        if (bytes) windows.push({ at: start, bytes });
        return !!bytes;
      });
    for (let i = 0; i < ranges.length;) {
      let [start, end] = ranges[i];
      let j = i + 1;
      for (
        ;
        j < ranges.length && ranges[j][0] - end <= MERGE_GAP && Math.max(end, ranges[j][1]) - start <= MERGE_MAX;
        j++
      )
        end = Math.max(end, ranges[j][1]);
      const group = ranges.slice(i, j);
      reads.push(
        window(start, end).then(async (ok) => {
          if (!ok && group.length > 1) await Promise.all(group.map(([a, b]) => window(a, b)));
        }),
      );
      i = j;
    }
    await Promise.all(reads);
    return (off, len) => {
      for (const w of windows)
        if (off >= w.at && off + len <= w.at + w.bytes.length) return w.bytes.subarray(off - w.at, off - w.at + len);
      return undefined;
    };
  };

  const read = async (off: number, len: number) => {
    if (off < 0 || off + len > size) return undefined;
    if (readAsync && len > 0) {
      // The request's L2 tables first, all at once.
      const tables: (Promise<boolean> | boolean)[] = [];
      for (let t = Math.floor(off / cs / l2Entries); t <= Math.floor((off + len - 1) / cs / l2Entries); t++)
        tables.push(loadL2(t));
      if ((await Promise.all(tables)).includes(false)) return undefined;
    }
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
        else if (!wanted.has(e) && bytes > 0) {
          wanted.add(e);
          ranges.push([at, at + bytes]);
        }
        pieces.push({ k, o, n, e });
      } else if (!(version === 3 && e & ZERO) && (e & OFFSET_MASK) !== 0n) {
        ranges.push([Number(e & OFFSET_MASK) + o, Number(e & OFFSET_MASK) + o + n]);
        pieces.push({ k, o, n, e });
      } // else unallocated or zero: `out` is zeros there
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
    // One data cluster's bytes, the whole request (a guest's read inside a cluster): the file's bytes as read.
    const [only] = pieces;
    if (pieces.length === 1 && only.n === len && !(only.e & COMPRESSED))
      return from(Number(only.e & OFFSET_MASK) + only.o, len);
    const out = new Uint8Array(len);
    for (const { k, o, n, e } of pieces) {
      const data = e & COMPRESSED ? clusters.get(e)?.subarray(o, o + n) : from(Number(e & OFFSET_MASK) + o, n);
      if (!data) return undefined;
      out.set(data, k);
    }
    return out;
  };
  /** Where L1 entry `i` names a table (0: none, unallocated). */
  const l2Offset = (i: number) => Number(l1.getBigUint64(i * 8) & OFFSET_MASK);
  let tables = 0;
  for (let i = 0; i < l1Size; i++) if (l2Offset(i)) tables++;
  /** The allocation over the tables read (they don't change while the image is open: it follows them as they come). */
  const over = allocationOver(l2s, cs, size, version, l1Size, (t) => t < l1Size && l2Offset(t) !== 0, fileSize);
  const allocation = (load?: ReadAt) => {
    if (!load || tables * cs > ALLOCATION_MAX) return over;
    for (let i = 0; i < l1Size; i++) {
      const off = l2Offset(i);
      if (off === 0 || l2s.has(i)) continue;
      const b = load(off, cs);
      // Kept as a request's read would keep it (it helps the guest's next read there).
      if (b?.length === cs) l2s.set(i, new DataView(b.buffer, b.byteOffset, cs));
    }
    return over;
  };
  return { size, format: 'qcow2', read, allocation };
}

/**
 * A qcow2's clusters that hold data (standard and compressed; zero-flagged ones not), in virtual bytes: what it takes
 * as a stored disk at most (web/stored.ts `storedEstimate`). Its header was checked (`openDisk`).
 */
export function qcow2Allocated(readAt: ReadAt) {
  const { version, clusterBits, l1Size, l1Offset } = qcow2Header(readAt(0, HEADER)!);
  const cs = 2 ** clusterBits;
  const l1b = readAt(l1Offset, l1Size * 8)!;
  const l1 = new DataView(l1b.buffer, l1b.byteOffset, l1b.byteLength);
  let n = 0;
  for (let i = 0; i < l1Size; i++) {
    const off = Number(l1.getBigUint64(i * 8) & OFFSET_MASK);
    const b = off ? readAt(off, cs) : undefined;
    if (!b) continue;
    const t = new DataView(b.buffer, b.byteOffset, cs);
    for (let k = 0; k < cs / 8; k++) if (hasData(t, k, version)) n++;
  }
  return n * cs;
}

/** The cluster of the compressed L2 entry `e`, or undefined (a failed read, or bytes that don't unpack to a cluster). */
async function compressedCluster(readAt: ReadAt, fileSize: number, e: bigint, clusterBits: number) {
  const [off, len] = compressedExtent(e, clusterBits, fileSize);
  const input = len > 0 ? readAt(off, len) : undefined;
  return input && inflate(input, 2 ** clusterBits);
}

/**
 * Raw deflate of one cluster: exactly `size` bytes out, or undefined. The input runs to a sector boundary, so it
 * usually ends with the next cluster's bytes, which the inflater ignores after the stream's end.
 */
export async function inflate(input: Uint8Array, size: number) {
  return (await threadDeflate()).inflate(input, size);
}

/** What a changes file says about itself (web/qcow2-write.ts writes it): the base image's file name and hash (web/changes.ts `hashSource`). */
/** `size`: the virtual size of the disk the changes are of (a grown overlay's may be past its base's). */
export type ChangesHeader = { backingName: string; hash?: string; size: number };

const EXT_BASE_HASH = 0x57414d32; // "WAM2" (web/qcow2-write.ts)

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
  return { backingName: dec.decode(head.subarray(nameAt, nameAt + nameLen)), hash, size: Number(h.getBigUint64(24)) };
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
export function readChanges(
  readAt: ReadAt,
  fileSize: number,
): (ChangesHeader & { size: number; blocks(): AsyncGenerator<ChangedBlock> }) | undefined {
  const head = readAt(0, Math.min(fileSize, 1 << 16)) ?? readAt(0, Math.min(fileSize, HEADER));
  const info = head && changesHeader(head);
  if (!head || !info) return undefined;
  const fail = (why: string): never => {
    throw new Error(`qcow2: ${why}`);
  };
  const { version, clusterBits, size, encrypted, l1Size, l1Offset, incompatible } = qcow2Header(head);
  if (version !== 2 && version !== 3) throw new MsgError('disks:qcow2.version', { version });
  if (clusterBits < 12 || clusterBits > 21) throw new MsgError('disks:qcow2.changesClusterBits', { bits: clusterBits });
  if (encrypted) throw new MsgError('disks:qcow2.encrypted');
  if (incompatible & ~KNOWN_INCOMPATIBLE)
    throw new MsgError('disks:qcow2.unsupportedFeatures', { features: incompatible.toString(16) });
  if (incompatible & (1n << 3n)) throw new MsgError('disks:qcow2.zstdClusters');
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
        const data = packed
          ? ((await compressedCluster(readAt, fileSize, e, clusterBits)) ??
            fail('a compressed cluster does not unpack'))
          : zero
            ? new Uint8Array(cs)
            : (readAt(off, cs) ?? fail('a data cluster is past the end of the file'));
        for (let b = 0; b < perCluster && first + b * 4096 < size; b++) {
          const n = Math.min(4096, size - (first + b * 4096));
          yield { block: first / 4096 + b, data: data.subarray(b * 4096, b * 4096 + n) };
        }
      }
    }
  }
  return { ...info, size, blocks };
}
