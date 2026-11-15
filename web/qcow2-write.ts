// A qcow2 writer for the disk-out exports (M8 phase B loop 5; docs/frontend.md "Your own disk"):
// the changes over a base image (a qcow2 with the base as its backing file, named in the header
// with the base's hash in an extension of ours) or the whole disk (zero clusters left out),
// streamed through a sink, with 4 KiB clusters (the overlay's block size, web/overlay.ts),
// compressed (raw deflate, cluster by cluster) when asked.
// Written from the format spec, QEMU's docs/interop/qcow2.txt (no QEMU code); `qemu-img check`
// and `qemu-img compare` are the oracle (tests/qcow2-write.test.ts).
//
// Layout: the header cluster, the data clusters in the order given, then the L2 tables, the L1
// table, the refcount blocks and the refcount table: the metadata depends on how many clusters
// there are, so the stream goes data first and the header (cluster 0) is written last, with
// `sink(bytes, 0)`. Compressed clusters are packed end to end where they fall among the others;
// one that isn't compressed starts at the next cluster boundary.
import { MsgError } from './msg.ts';
import type { WritableDisk } from './overlay.ts';
import type { Disk } from './qcow2.ts';

export const CLUSTER = 4096;
const L2_ENTRIES = CLUSTER / 8;
const REFS_PER_BLOCK = CLUSTER / 2; // 16-bit refcounts
const COPIED = 1n << 63n;
const COMPRESSED = 1n << 62n;
const ZERO_FLAG = 1n; // a standard cluster's bit 0 (version 3): it reads as zeros
const CSIZE_SHIFT = 58n; // 62 - (cluster_bits - 8): a compressed cluster's sector count, above its host offset
const CHUNK = 1 << 20;
const ZEROS = new Uint8Array(CLUSTER);
const HEADER_LENGTH = 112;
/**
 * Header extension types: QEMU's backing file format name, and ours: the base image's hash (web/changes.ts
 * `hashSource`; hex, ASCII). "WAM1" was the SHA-256 of the whole file, which nothing reads any more.
 */
const EXT_BACKING_FORMAT = 0xe2792aca;
export const EXT_BASE_HASH = 0x57414d32; // "WAM2"

/** Where the stream goes: appended in order, or (the header only) at `at`. */
export type Sink = (chunk: Uint8Array, at?: number) => void | Promise<void>;

/**
 * A cluster the file holds: its index in the virtual disk and its CLUSTER bytes (the last one padded
 * with zeros), or `zero`: it reads as zeros and takes no room in the file (an L2 entry with the zero
 * flag: over a backing file, that is what keeps the backing file's bytes out).
 */
export type DataCluster = { index: number; data: Uint8Array; zero?: undefined } | { index: number; zero: true };

/**
 * Compresses clusters for `writeQcow2`: `pack` gets whole clusters end to end (the writer's
 * buffer: it copies what it sends elsewhere) and resolves to each one's raw deflate, or undefined for one that
 * doesn't shrink; `atOnce` calls run at a time (the clusters are stored in order whatever order
 * they finish in). The disk-out worker's is a pool of workers (web/app/export-worker.ts).
 */
export type Packer = { pack(clusters: Uint8Array): Promise<(Uint8Array | undefined)[]>; atOnce: number };

/** The clusters one `pack` call gets. */
const PACK_CLUSTERS = 256;

export type Backing = { name: string; format: 'qcow2' | 'raw'; hash: string };

/**
 * Writes a qcow2 of virtual size `size` holding `clusters` (ascending by index, none twice) to
 * `sink`; everything else reads as zeros (or, with `backing`, as the backing file's bytes).
 * With `compress`, a cluster that deflates to less than itself is stored compressed (below):
 * `true` deflates on this thread, a `Packer` wherever it does. The file is the same either way.
 * Resolves to the clusters stored and the file's size.
 */
export async function writeQcow2(o: { size: number; clusters: AsyncIterable<DataCluster>; backing?: Backing; compress?: boolean | Packer; sink: Sink }) {
  const { size, sink } = o;
  await sink(new Uint8Array(CLUSTER)); // the header's place
  // The data goes out in pieces of CHUNK (a compressed cluster is a small write of its own otherwise).
  let chunk = new Uint8Array(CHUNK);
  let fill = 0;
  let pos = CLUSTER; // where the next byte goes in the file
  const emit = async (bytes: Uint8Array) => {
    for (let at = 0; at < bytes.length;) {
      const k = Math.min(bytes.length - at, CHUNK - fill);
      chunk.set(bytes.subarray(at, at + k), fill);
      fill += k;
      at += k;
      if (fill === CHUNK) { await sink(chunk); chunk = new Uint8Array(CHUNK); fill = 0; } // a new buffer: the sink may keep the old one
    }
    pos += bytes.length;
  };
  const align = () => emit(ZEROS.subarray(0, (CLUSTER - pos % CLUSTER) % CLUSTER));

  let indices = new Uint32Array(1024);
  let entries = new BigUint64Array(1024); // their L2 entries
  let refs = new Uint16Array(1024).fill(1, 0, 1); // the refcounts of the header and the data's host clusters
  let n = 0;
  const ref = (host: number) => {
    if (host >= refs.length) { const g = new Uint16Array(2 * Math.max(host, refs.length)); g.set(refs); refs = g; }
    refs[host]++;
  };
  const store = async (c: DataCluster, packed?: Uint8Array) => {
    if (n === indices.length) {
      const g = new Uint32Array(2 * n); g.set(indices); indices = g;
      const e = new BigUint64Array(2 * n); e.set(entries); entries = e;
    }
    indices[n] = c.index;
    if (c.zero) {
      entries[n] = ZERO_FLAG;
    } else if (packed) {
      // A compressed cluster starts where the last one ended; its entry counts the 512-byte sectors after the first
      // (bits 58 on, with 4 KiB clusters), and every host cluster it touches counts it once.
      const last = pos + packed.length - 1;
      entries[n] = COMPRESSED | BigInt(Math.floor(last / 512) - Math.floor(pos / 512)) << CSIZE_SHIFT | BigInt(pos);
      for (let host = Math.floor(pos / CLUSTER); host <= Math.floor(last / CLUSTER); host++) ref(host);
      await emit(packed);
    } else {
      await align();
      entries[n] = BigInt(pos) | COPIED;
      ref(pos / CLUSTER);
      await emit(c.data);
    }
    n++;
  };
  // Compressed: the clusters go to the packer in batches (copies: the caller's buffers are its own again once
  // it is asked for the next cluster), a few batches at a time, and are stored in the order they came.
  const packer = o.compress === true ? { pack: deflateEach, atOnce: 1 } : o.compress || undefined;
  type Batch = { clusters: { index: number; zero?: true }[]; bytes: Uint8Array; data: number };
  const fresh = (): Batch => ({ clusters: [], bytes: new Uint8Array(PACK_CLUSTERS * CLUSTER), data: 0 });
  const packing: Promise<{ batch: Batch; packed: (Uint8Array | undefined)[] }>[] = [];
  let batch = fresh();
  const send = () => {
    const mine = batch;
    batch = fresh();
    const run = packer!.pack(mine.bytes.subarray(0, mine.data * CLUSTER)).then((packed) => ({ batch: mine, packed }));
    run.catch(() => {}); // awaited in order below: a failure must not go unhandled until then
    packing.push(run);
  };
  const settle = async () => {
    const { batch, packed } = await packing.shift()!;
    if (packed.length !== batch.data) throw new Error('the compressor lost clusters');
    let k = 0;
    for (const c of batch.clusters) {
      if (c.zero) await store({ index: c.index, zero: true });
      else { await store({ index: c.index, data: batch.bytes.subarray(k * CLUSTER, (k + 1) * CLUSTER) }, packed[k]); k++; }
    }
  };
  let last = -1;
  for await (const c of o.clusters) {
    if (!c.zero && c.data.length !== CLUSTER) throw new Error(`cluster ${c.index} is ${c.data.length} bytes`);
    if (c.index <= last) throw new Error(`cluster ${c.index} out of order`);
    last = c.index;
    if (!packer) { await store(c); continue; }
    if (c.zero) batch.clusters.push({ index: c.index, zero: true });
    else { batch.clusters.push({ index: c.index }); batch.bytes.set(c.data, batch.data++ * CLUSTER); }
    if (batch.clusters.length === PACK_CLUSTERS) {
      send();
      if (packing.length === packer.atOnce) await settle();
    }
  }
  if (batch.clusters.length) send();
  while (packing.length) await settle();
  await align();
  if (fill) await sink(chunk.subarray(0, fill));

  // The metadata's clusters, after the data: L2 tables, L1, refcount blocks, refcount table.
  const dataEnd = pos / CLUSTER;
  const l1Size = Math.ceil(size / (CLUSTER * L2_ENTRIES));
  const l1Clusters = Math.ceil((l1Size * 8) / CLUSTER);
  let l2Tables = 0;
  for (let i = 0, last = -1; i < n; i++) {
    const t = Math.floor(indices[i] / L2_ENTRIES);
    if (t !== last) { l2Tables++; last = t; }
  }
  const fixed = dataEnd + l2Tables + l1Clusters;
  let blocks = 1;
  let tableClusters = 1;
  for (;;) { // the refcount structures count themselves
    const b = Math.ceil((fixed + blocks + tableClusters) / REFS_PER_BLOCK);
    const t = Math.ceil((b * 8) / CLUSTER);
    if (b === blocks && t === tableClusters) break;
    [blocks, tableClusters] = [b, t];
  }
  const total = fixed + blocks + tableClusters;
  const l2At = dataEnd;
  const l1At = l2At + l2Tables;
  const blocksAt = l1At + l1Clusters;
  const tableAt = blocksAt + blocks;

  // L2 tables, and the L1 entries that point to them.
  const l1 = new DataView(new ArrayBuffer(l1Clusters * CLUSTER));
  for (let i = 0, t = 0; i < n; t++) {
    const l1Index = Math.floor(indices[i] / L2_ENTRIES);
    const l2 = new DataView(new ArrayBuffer(CLUSTER));
    for (; i < n && Math.floor(indices[i] / L2_ENTRIES) === l1Index; i++) {
      l2.setBigUint64((indices[i] % L2_ENTRIES) * 8, entries[i]);
    }
    l1.setBigUint64(l1Index * 8, BigInt((l2At + t) * CLUSTER) | COPIED);
    await sink(new Uint8Array(l2.buffer));
  }
  await sink(new Uint8Array(l1.buffer));
  // The metadata's clusters are used once each; the data's as counted.
  for (let b = 0; b < blocks; b++) {
    const out = new DataView(new ArrayBuffer(CLUSTER));
    for (let k = 0, c = b * REFS_PER_BLOCK; k < REFS_PER_BLOCK && c < total; k++, c++) out.setUint16(k * 2, c < dataEnd ? refs[c] : 1);
    await sink(new Uint8Array(out.buffer));
  }
  const table = new DataView(new ArrayBuffer(tableClusters * CLUSTER));
  for (let b = 0; b < blocks; b++) table.setBigUint64(b * 8, BigInt((blocksAt + b) * CLUSTER));
  await sink(new Uint8Array(table.buffer));

  await sink(header(size, l1Size, l1At, tableAt, tableClusters, o.backing), 0);
  return { clusters: n, bytes: total * CLUSTER };
}

/**
 * Raw deflate of one cluster through the platform's `CompressionStream`, or undefined when it doesn't
 * shrink (the cluster is stored as it is). QEMU inflates with a 4 KiB window whatever the cluster
 * size, and `CompressionStream` has no window setting: a 4 KiB cluster can't reach further back.
 */
export async function deflate(data: Uint8Array) {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
  w.close().catch(() => {});
  const r = cs.readable.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    parts.push(value);
    n += value.length;
  }
  if (n >= CLUSTER) return undefined;
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** `Packer.pack` on this thread: one cluster at a time (several streams at once on one thread were slower, docs/frontend.md). */
export async function deflateEach(clusters: Uint8Array) {
  const out: (Uint8Array | undefined)[] = [];
  for (let at = 0; at < clusters.length; at += CLUSTER) out.push(await deflate(clusters.subarray(at, at + CLUSTER)));
  return out;
}

/** Cluster 0: the header, its extensions and the backing file's name. */
function header(size: number, l1Size: number, l1At: number, tableAt: number, tableClusters: number, backing?: Backing) {
  const out = new Uint8Array(CLUSTER);
  const h = new DataView(out.buffer);
  h.setUint32(0, 0x514649fb);
  h.setUint32(4, 3);
  h.setUint32(20, 12); // cluster_bits
  h.setBigUint64(24, BigInt(size));
  h.setUint32(36, l1Size);
  h.setBigUint64(40, BigInt(l1At * CLUSTER));
  h.setBigUint64(48, BigInt(tableAt * CLUSTER));
  h.setUint32(56, tableClusters);
  h.setUint32(96, 4); // refcount_order: 16 bits
  h.setUint32(100, HEADER_LENGTH);
  let at = HEADER_LENGTH;
  const enc = new TextEncoder();
  const extension = (type: number, data: Uint8Array) => {
    h.setUint32(at, type);
    h.setUint32(at + 4, data.length);
    out.set(data, at + 8);
    at += 8 + Math.ceil(data.length / 8) * 8;
  };
  if (backing) {
    extension(EXT_BACKING_FORMAT, enc.encode(backing.format));
    extension(EXT_BASE_HASH, enc.encode(backing.hash));
  }
  at += 8; // the end-of-extensions marker (type 0, length 0: zeros)
  if (backing) {
    const name = enc.encode(backing.name);
    if (at + name.length > CLUSTER || name.length > 1023) throw new MsgError('disks:qcow2-write.backingNameTooLong');
    h.setBigUint64(8, BigInt(at));
    h.setUint32(16, name.length);
    out.set(name, at);
  }
  return out;
}

/** The overlay's written blocks as clusters, in disk order (the changes over the base). */
export async function* changedClusters(disk: WritableDisk): AsyncGenerator<DataCluster> {
  for (const index of disk.written()) {
    if (disk.zeroed(index)) { yield { index, zero: true }; continue; }
    const bytes = await disk.read(index * CLUSTER, Math.min(CLUSTER, disk.size - index * CLUSTER));
    if (!bytes) throw new MsgError('disks:qcow2-write.overlayUnreadable', { block: index });
    yield { index, data: pad(bytes) };
  }
}

/**
 * The disk's clusters that aren't all zeros, in disk order, read `chunk` bytes at a time. With `held` (the blocks that
 * may not be zeros, ascending: a stored disk's, `Source.held`), only those are read, a run of consecutive ones at a time:
 * an export of a large disk that holds little reads what it holds, not its size.
 */
export async function* nonZeroClusters(disk: Disk, chunk = 1 << 20, progress?: (done: number) => void, held?: Iterable<number>): AsyncGenerator<DataCluster> {
  if (held) {
    let run: number[] = [];
    const flush = async function* () {
      const at = run[0] * CLUSTER;
      const bytes = await disk.read(at, Math.min(run.length * CLUSTER, disk.size - at));
      if (!bytes) throw new MsgError('disks:qcow2-write.diskUnreadable', { offset: at });
      for (let c = 0; c < bytes.length; c += CLUSTER) {
        const data = bytes.subarray(c, c + CLUSTER);
        if (!isZero(data)) yield { index: run[0] + c / CLUSTER, data: pad(data) };
      }
      progress?.(at + bytes.length);
      run = [];
    };
    for (const b of held) {
      if (b * CLUSTER >= disk.size) break;
      if (run.length && (b !== run[run.length - 1] + 1 || run.length * CLUSTER >= chunk)) yield* flush();
      run.push(b);
    }
    if (run.length) yield* flush();
    progress?.(disk.size);
    return;
  }
  for (let off = 0; off < disk.size; off += chunk) {
    const bytes = await disk.read(off, Math.min(chunk, disk.size - off));
    if (!bytes) throw new MsgError('disks:qcow2-write.diskUnreadable', { offset: off });
    for (let c = 0; c < bytes.length; c += CLUSTER) {
      const data = bytes.subarray(c, c + CLUSTER);
      if (!isZero(data)) yield { index: (off + c) / CLUSTER, data: pad(data) };
    }
    progress?.(off + bytes.length);
  }
}

/** The disk as it reads, `chunk` bytes at a time (a raw export). */
export async function* rawChunks(disk: Disk, chunk = 1 << 20): AsyncGenerator<Uint8Array> {
  for (let off = 0; off < disk.size; off += chunk) {
    const bytes = await disk.read(off, Math.min(chunk, disk.size - off));
    if (!bytes) throw new MsgError('disks:qcow2-write.diskUnreadable', { offset: off });
    yield bytes;
  }
}

const pad = (b: Uint8Array) => {
  if (b.length === CLUSTER) return b;
  const out = new Uint8Array(CLUSTER);
  out.set(b);
  return out;
};

export function isZero(b: Uint8Array) {
  if (b.byteOffset % 8 === 0 && b.length % 8 === 0) {
    const w = new BigUint64Array(b.buffer, b.byteOffset, b.length / 8);
    for (let i = 0; i < w.length; i++) if (w[i] !== 0n) return false;
    return true;
  }
  for (let i = 0; i < b.length; i++) if (b[i]) return false;
  return true;
}
