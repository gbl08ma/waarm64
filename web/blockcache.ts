// A read cache under a remote disk (docs/plans/remote-disks.md R1): the image file in aligned blocks, the most recently
// used kept in memory, so a guest's many small reads (and qcow2's L2 tables and nearby clusters) are a few large
// requests. A read's missing blocks are fetched together where they are adjacent: one request each run.
import type { Source } from './devices.ts';
import type { BlockStore } from './diskcache.ts';

export type BlockCacheOptions = {
  /** Block size in bytes (a power of two). */
  block: number;
  /** Bytes kept, at most (whole blocks; at least one). */
  bytes: number;
};

/** R1's choice (bench/remote-disk/REPORT.md): 1 MiB blocks, 256 MiB kept. */
export const BLOCK_CACHE: BlockCacheOptions = { block: 1 << 20, bytes: 256 << 20 };

export type BlockCacheStats = { hits: number; misses: number; requests: number; fetched: number; ms: number; store?: ReturnType<BlockStore['stats']> & { hits: number } };

/**
 * `src` read through a block cache, over `store` (blocks kept in OPFS, web/diskcache.ts) if given: a block missing here
 * is looked for there before it is fetched, and what is fetched is kept there too. `stats` counts block hits and
 * misses, the requests made, the bytes fetched and the ms inside them, and the store's.
 */
export function cachedSource(src: Source, o: BlockCacheOptions = BLOCK_CACHE, store?: BlockStore): Source & { stats: BlockCacheStats } {
  const { block } = o;
  const max = Math.max(1, Math.floor(o.bytes / block));
  const blocks = new Map<number, Uint8Array>(); // insertion order: least recently used first
  const counts = { hits: 0, misses: 0, requests: 0, fetched: 0, ms: 0 };
  let storeHits = 0;
  const stats = counts as BlockCacheStats;
  if (store) Object.defineProperty(stats, 'store', { enumerable: true, get: () => ({ ...store.stats(), hits: storeHits }) });
  const last = Math.floor((src.size - 1) / block);
  const keep = (b: number, bytes: Uint8Array) => {
    blocks.delete(b);
    blocks.set(b, bytes);
    if (blocks.size > max) blocks.delete(blocks.keys().next().value!);
  };
  /** Blocks `a`..`b` (inclusive) from the source in one read, widened to what the source fetches anyway; false if it failed. */
  const fetch = (a: number, b: number) => {
    const wide = src.span?.(a * block, Math.min(src.size, (b + 1) * block) - a * block);
    if (wide) [a, b] = [Math.min(a, Math.floor(wide[0] / block)), Math.max(b, Math.floor((wide[1] - 1) / block))];
    const off = a * block;
    const len = Math.min(src.size, (b + 1) * block) - off;
    const t = performance.now();
    const bytes = src.read(off, len);
    stats.ms += performance.now() - t;
    stats.requests++;
    if (!bytes) return false;
    stats.fetched += len;
    for (let k = a; k <= b; k++) {
      const one = bytes.subarray((k - a) * block, Math.min(len, (k - a + 1) * block));
      keep(k, one);
      store?.put(k, one);
    }
    return true;
  };
  return {
    size: src.size,
    stats,
    close: () => {
      store?.close();
      src.close?.();
    },
    read(off, len) {
      if (off < 0 || len < 0 || off + len > src.size) return undefined;
      if (len === 0) return new Uint8Array(0);
      const first = Math.floor(off / block), end = Math.floor((off + len - 1) / block);
      if (end - first + 1 > max) return src.read(off, len); // larger than the cache: past it
      // The missing blocks, fetched in runs of adjacent ones.
      let run = -1;
      for (let k = first; k <= end + 1; k++) {
        if (k <= end && store && !blocks.has(k)) {
          const kept = store.get(k);
          if (kept) (keep(k, kept), storeHits++);
        }
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
