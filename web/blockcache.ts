// A read cache under a remote disk (docs/plans/remote-disks.md R1): the image file in aligned blocks, the most recently
// used kept in memory, so a guest's many small reads (and qcow2's L2 tables and nearby clusters) are a few large
// requests. A read's missing blocks are fetched together where they are adjacent: one request each run.
import type { Source } from './devices.ts';

export type BlockCacheOptions = {
  /** Block size in bytes (a power of two). */
  block: number;
  /** Bytes kept, at most (whole blocks; at least one). */
  bytes: number;
};

/** R1's choice (bench/remote-disk/REPORT.md): 1 MiB blocks, 256 MiB kept. */
export const BLOCK_CACHE: BlockCacheOptions = { block: 1 << 20, bytes: 256 << 20 };

export type BlockCacheStats = { hits: number; misses: number; requests: number; fetched: number; ms: number };

/** `src` read through a block cache. `stats` counts block hits and misses, the requests made, the bytes fetched and the ms inside them. */
export function cachedSource(src: Source, o: BlockCacheOptions = BLOCK_CACHE): Source & { stats: BlockCacheStats } {
  const { block } = o;
  const max = Math.max(1, Math.floor(o.bytes / block));
  const blocks = new Map<number, Uint8Array>(); // insertion order: least recently used first
  const stats: BlockCacheStats = { hits: 0, misses: 0, requests: 0, fetched: 0, ms: 0 };
  const last = Math.floor((src.size - 1) / block);
  const keep = (b: number, bytes: Uint8Array) => {
    blocks.delete(b);
    blocks.set(b, bytes);
    if (blocks.size > max) blocks.delete(blocks.keys().next().value!);
  };
  /** Blocks `a`..`b` (inclusive) from the source in one read; false if it failed. */
  const fetch = (a: number, b: number) => {
    const off = a * block;
    const len = Math.min(src.size, (b + 1) * block) - off;
    const t = performance.now();
    const bytes = src.read(off, len);
    stats.ms += performance.now() - t;
    stats.requests++;
    if (!bytes) return false;
    stats.fetched += len;
    for (let k = a; k <= b; k++) keep(k, bytes.subarray((k - a) * block, Math.min(len, (k - a + 1) * block)));
    return true;
  };
  return {
    size: src.size,
    stats,
    close: src.close,
    read(off, len) {
      if (off < 0 || len < 0 || off + len > src.size) return undefined;
      if (len === 0) return new Uint8Array(0);
      const first = Math.floor(off / block), end = Math.floor((off + len - 1) / block);
      if (end - first + 1 > max) return src.read(off, len); // larger than the cache: past it
      // The missing blocks, fetched in runs of adjacent ones.
      let run = -1;
      for (let k = first; k <= end + 1; k++) {
        const missing = k <= end && !blocks.has(k);
        if (k <= end && missing) stats.misses++;
        else if (k <= end) (stats.hits++, keep(k, blocks.get(k)!)); // most recent now, so this read's fetches don't evict it
        if (missing && run < 0) run = k;
        if (!missing && run >= 0) {
          if (!fetch(run, Math.min(k - 1, last))) return undefined;
          run = -1;
        }
      }
      const out = new Uint8Array(len);
      for (let k = first; k <= end; k++) {
        const b = blocks.get(k);
        if (!b) return undefined;
        keep(k, b);
        const from = Math.max(off, k * block), to = Math.min(off + len, k * block + b.length);
        out.set(b.subarray(from - k * block, to - k * block), from - off);
      }
      return out;
    },
  };
}
