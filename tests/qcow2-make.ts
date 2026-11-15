// Small qcow2 v3 images made in a test, from the format spec (QEMU's docs/interop/qcow2.txt; no QEMU code): the
// clusters a test names, with data, zero or compressed, and nothing else (no refcount table: web/qcow2.ts reads none).
// tests/surface-image.test.ts uses them.

export type Kind = 'data' | 'zero' | 'compressed';
/**
 * A qcow2 v3 of `size` bytes at `clusterBits`, its clusters as `clusters` says (the rest unallocated): the header, the
 * L1 table, the L2 tables that hold an entry (`shared`: every L1 entry names one table), then a host cluster each
 * (filled with its index + 1; a zero cluster's is there but reads as zeros). Where each L2 table is in the file (`l2At`).
 */
export function qcow2(size: number, clusterBits: number, clusters: Map<number, Kind>, shared = false) {
  const cs = 2 ** clusterBits;
  const per = cs / 8;
  const l1Size = Math.ceil(size / cs / per);
  const l1Clusters = Math.ceil((l1Size * 8) / cs);
  const tables = shared ? [0] : [...new Set([...clusters.keys()].map((c) => Math.floor(c / per)))].sort((a, b) => a - b);
  const l2At = new Map(tables.map((t, i) => [t, (1 + l1Clusters + i) * cs]));
  const firstData = 1 + l1Clusters + tables.length;
  const data = [...clusters]; // a zero cluster with a host cluster of its own too (QEMU's preallocated zeros)
  const out = new Uint8Array((firstData + data.length) * cs);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x514649fb);
  v.setUint32(4, 3);
  v.setUint32(20, clusterBits);
  v.setBigUint64(24, BigInt(size));
  v.setUint32(36, l1Size);
  v.setBigUint64(40, BigInt(cs));
  v.setUint32(96, 4);
  v.setUint32(100, 104);
  for (let i = 0; i < l1Size; i++) {
    const at = shared ? l2At.get(0) : l2At.get(i);
    if (at) v.setBigUint64(cs + i * 8, BigInt(at) | (1n << 63n));
  }
  const slot = new Map(data.map(([c], i) => [c, (firstData + i) * cs]));
  for (const [c, kind] of clusters) {
    const e = l2At.get(shared ? 0 : Math.floor(c / per))! + (c % per) * 8;
    const host = slot.get(c);
    if (host !== undefined) out.fill((c % 255) + 1, host, host + cs);
    if (kind === 'data') v.setBigUint64(e, BigInt(host!) | (1n << 63n));
    else if (kind === 'zero') v.setBigUint64(e, BigInt(host!) | 1n);
    // Compressed: bit 62, the host offset and a sector count (the allocation reads only the bit).
    else v.setBigUint64(e, (1n << 62n) | BigInt(host!));
  }
  return { bytes: out, l2At, cs };
}
