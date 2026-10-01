// A qcow2 writer for the disk-out exports (M8 phase B loop 5; docs/frontend.md "Your own disk"):
// the changes over a base image (a qcow2 with the base as its backing file, named in the header
// with the base's SHA-256 in an extension of ours) or the whole disk (zero clusters left out),
// streamed through a sink, with 4 KiB clusters (the overlay's block size, web/overlay.ts).
// Written from the format spec, QEMU's docs/interop/qcow2.txt (no QEMU code); `qemu-img check`
// and `qemu-img compare` are the oracle (tests/qcow2-write.test.ts).
//
// Layout: the header cluster, the data clusters in the order given, then the L2 tables, the L1
// table, the refcount blocks and the refcount table: the metadata depends on how many clusters
// there are, so the stream goes data first and the header (cluster 0) is written last, with
// `sink(bytes, 0)`.
import type { WritableDisk } from './overlay.ts';
import type { Disk } from './qcow2.ts';

export const CLUSTER = 4096;
const L2_ENTRIES = CLUSTER / 8;
const REFS_PER_BLOCK = CLUSTER / 2; // 16-bit refcounts
const COPIED = 1n << 63n;
const HEADER_LENGTH = 112;
/** Header extension types: QEMU's backing file format name, and ours: the base image's SHA-256 (hex, ASCII). */
const EXT_BACKING_FORMAT = 0xe2792aca;
export const EXT_BASE_SHA256 = 0x57504331; // "WPC1"

/** Where the stream goes: appended in order, or (the header only) at `at`. */
export type Sink = (chunk: Uint8Array, at?: number) => void | Promise<void>;

/** A data cluster: its index in the virtual disk and its CLUSTER bytes (the last one padded with zeros). */
export type DataCluster = { index: number; data: Uint8Array };

export type Backing = { name: string; format: 'qcow2' | 'raw'; sha256: string };

/**
 * Writes a qcow2 of virtual size `size` holding `clusters` (ascending by index, none twice) to
 * `sink`; everything else reads as zeros (or, with `backing`, as the backing file's bytes).
 * Resolves to the clusters stored and the file's size.
 */
export async function writeQcow2(o: { size: number; clusters: AsyncIterable<DataCluster>; backing?: Backing; sink: Sink }) {
  const { size, sink } = o;
  await sink(new Uint8Array(CLUSTER)); // the header's place
  let indices = new Uint32Array(1024);
  let n = 0;
  for await (const { index, data } of o.clusters) {
    if (data.length !== CLUSTER) throw new Error(`cluster ${index} is ${data.length} bytes`);
    if (n > 0 && index <= indices[n - 1]) throw new Error(`cluster ${index} out of order`);
    if (n === indices.length) { const g = new Uint32Array(2 * n); g.set(indices); indices = g; }
    indices[n++] = index;
    await sink(data);
  }

  // The metadata's clusters, after the data (cluster 1 + n on): L2 tables, L1, refcount blocks, refcount table.
  const l1Size = Math.ceil(size / (CLUSTER * L2_ENTRIES));
  const l1Clusters = Math.ceil((l1Size * 8) / CLUSTER);
  let l2Tables = 0;
  for (let i = 0, last = -1; i < n; i++) {
    const t = Math.floor(indices[i] / L2_ENTRIES);
    if (t !== last) { l2Tables++; last = t; }
  }
  const fixed = 1 + n + l2Tables + l1Clusters;
  let blocks = 1;
  let tableClusters = 1;
  for (;;) { // the refcount structures count themselves
    const b = Math.ceil((fixed + blocks + tableClusters) / REFS_PER_BLOCK);
    const t = Math.ceil((b * 8) / CLUSTER);
    if (b === blocks && t === tableClusters) break;
    [blocks, tableClusters] = [b, t];
  }
  const total = fixed + blocks + tableClusters;
  const l2At = 1 + n;
  const l1At = l2At + l2Tables;
  const blocksAt = l1At + l1Clusters;
  const tableAt = blocksAt + blocks;

  // L2 tables, and the L1 entries that point to them.
  const l1 = new DataView(new ArrayBuffer(l1Clusters * CLUSTER));
  for (let i = 0, t = 0; i < n; t++) {
    const l1Index = Math.floor(indices[i] / L2_ENTRIES);
    const l2 = new DataView(new ArrayBuffer(CLUSTER));
    for (; i < n && Math.floor(indices[i] / L2_ENTRIES) === l1Index; i++) {
      l2.setBigUint64((indices[i] % L2_ENTRIES) * 8, BigInt((1 + i) * CLUSTER) | COPIED);
    }
    l1.setBigUint64(l1Index * 8, BigInt((l2At + t) * CLUSTER) | COPIED);
    await sink(new Uint8Array(l2.buffer));
  }
  await sink(new Uint8Array(l1.buffer));
  // Every cluster is used once.
  for (let b = 0; b < blocks; b++) {
    const refs = new DataView(new ArrayBuffer(CLUSTER));
    for (let k = 0; k < REFS_PER_BLOCK && b * REFS_PER_BLOCK + k < total; k++) refs.setUint16(k * 2, 1);
    await sink(new Uint8Array(refs.buffer));
  }
  const table = new DataView(new ArrayBuffer(tableClusters * CLUSTER));
  for (let b = 0; b < blocks; b++) table.setBigUint64(b * 8, BigInt((blocksAt + b) * CLUSTER));
  await sink(new Uint8Array(table.buffer));

  await sink(header(size, l1Size, l1At, tableAt, tableClusters, o.backing), 0);
  return { clusters: n, bytes: total * CLUSTER };
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
    extension(EXT_BASE_SHA256, enc.encode(backing.sha256));
  }
  at += 8; // the end-of-extensions marker (type 0, length 0: zeros)
  if (backing) {
    const name = enc.encode(backing.name);
    if (at + name.length > CLUSTER || name.length > 1023) throw new Error('the backing file name is too long');
    h.setBigUint64(8, BigInt(at));
    h.setUint32(16, name.length);
    out.set(name, at);
  }
  return out;
}

/** The overlay's written blocks as clusters, in disk order (the changes over the base). */
export async function* changedClusters(disk: WritableDisk): AsyncGenerator<DataCluster> {
  for (const index of disk.written()) {
    const bytes = await disk.read(index * CLUSTER, Math.min(CLUSTER, disk.size - index * CLUSTER));
    if (!bytes) throw new Error(`block ${index} of the overlay can't be read`);
    yield { index, data: pad(bytes) };
  }
}

/** The disk's clusters that aren't all zeros, in disk order, read `chunk` bytes at a time. */
export async function* nonZeroClusters(disk: Disk, chunk = 1 << 20, progress?: (done: number) => void): AsyncGenerator<DataCluster> {
  for (let off = 0; off < disk.size; off += chunk) {
    const bytes = await disk.read(off, Math.min(chunk, disk.size - off));
    if (!bytes) throw new Error(`the disk can't be read at ${off}`);
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
    if (!bytes) throw new Error(`the disk can't be read at ${off}`);
    yield bytes;
  }
}

const pad = (b: Uint8Array) => {
  if (b.length === CLUSTER) return b;
  const out = new Uint8Array(CLUSTER);
  out.set(b);
  return out;
};

function isZero(b: Uint8Array) {
  if (b.byteOffset % 8 === 0 && b.length % 8 === 0) {
    const w = new BigUint64Array(b.buffer, b.byteOffset, b.length / 8);
    for (let i = 0; i < w.length; i++) if (w[i] !== 0n) return false;
    return true;
  }
  for (let i = 0; i < b.length; i++) if (b[i]) return false;
  return true;
}
