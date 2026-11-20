// A read cache under a remote disk (docs/devices.md "Over HTTP"): the image file in aligned blocks, the most recently
// used kept in memory, so a guest's many small reads (and qcow2's L2 tables and nearby clusters) are a few large
// requests. A read's missing blocks are fetched together where they are adjacent: one request each run. Over a source
// that reads without blocking (`readAsync`), several reads fetch at once and a block being fetched is fetched once.
import type { Source } from './disk-sources.ts';
import type { BlockStore } from './diskcache.ts';

export type BlockCacheOptions = {
  /** Block size in bytes (a power of two). */
  block: number;
  /** Bytes kept, at most (whole blocks; at least one). */
  bytes: number;
};

/** Fetches in flight at most (`readAsync`; Chromium's HTTP/1.1 opens 6 connections a host, HTTP/2 multiplexes). */
const MAX_FETCHES = 8;
/** Of those, the prefetch's at most (`prefetch`): the guest's own reads keep the rest, and go first in the queue. */
const PREFETCH_FETCHES = 4;

/**
 * How far the prefetch runs ahead of the guest's place in its list, in blocks: it starts at AHEAD_START and widens by
 * AHEAD_STEP each time the guest waits on a block of the list while the prefetch sat idle on its window (a wider one
 * would have had it), up to AHEAD_MAX. A guest at a boot menu, or one a fast host keeps up with, costs a window.
 */
export const AHEAD_START = 16,
  AHEAD_STEP = 8,
  AHEAD_MAX = 128;

/** R1's choice (bench/remote-disk/REPORT.md): 1 MiB blocks, 256 MiB kept. */
export const BLOCK_CACHE: BlockCacheOptions = { block: 1 << 20, bytes: 256 << 20 };

export type BlockCacheStats = {
  hits: number;
  misses: number;
  requests: number;
  fetched: number;
  ms: number;
  store?: ReturnType<BlockStore['stats']> & { hits: number };
  /**
   * `prefetch`'s: blocks fetched ahead, how many the guest then read before they went, how far it got in the list, the
   * window (blocks ahead of the guest) and how many times the guest waited on the list's blocks (`late`; `widened`: of
   * those, the times the window grew).
   */
  prefetch?: { fetched: number; used: number; done: boolean; window: number; late: number; widened: number };
};

/**
 * `src` read through a block cache, over `store` (blocks kept in OPFS, web/diskcache.ts) if given: a block missing here
 * is looked for there before it is fetched, and what is fetched is kept there too. `stats` counts block hits and
 * misses, the requests made, the bytes fetched and the ms inside them, and the store's.
 */
export function cachedSource(
  src: Source,
  o: BlockCacheOptions = BLOCK_CACHE,
  store?: BlockStore,
): Source & { stats: BlockCacheStats; prefetch(blocks: number[]): Promise<void>; kept: NonNullable<Source['kept']> } {
  const { block } = o;
  const max = Math.max(1, Math.floor(o.bytes / block));
  const blocks = new Map<number, Uint8Array>(); // insertion order: least recently used first
  const counts = { hits: 0, misses: 0, requests: 0, fetched: 0, ms: 0 };
  let storeHits = 0;
  const stats = counts as BlockCacheStats;
  if (store)
    Object.defineProperty(stats, 'store', { enumerable: true, get: () => ({ ...store.stats(), hits: storeHits }) });
  const last = Math.floor((src.size - 1) / block);
  const keep = (b: number, bytes: Uint8Array) => {
    blocks.delete(b);
    blocks.set(b, bytes);
    if (blocks.size > max) blocks.delete(blocks.keys().next().value!);
  };
  /** Blocks `a`..`b` widened to what the source fetches anyway: their offset and length in the file. */
  const widen = (a: number, b: number) => {
    const wide = src.span?.(a * block, Math.min(src.size, (b + 1) * block) - a * block);
    if (wide) [a, b] = [Math.min(a, Math.floor(wide[0] / block)), Math.max(b, Math.floor((wide[1] - 1) / block))];
    return [a, b, a * block, Math.min(src.size, (b + 1) * block) - a * block];
  };
  /** Blocks the prefetch brought, until the guest reads them (`prefetch` stats' `used`). */
  const ahead = new Set<number>();
  /**
   * Keeps blocks `a`..`b` fetched as `bytes` (undefined: the read failed); false if it failed. A prefetch's go to the
   * store alone where there is one, so they don't push the guest's blocks out of memory.
   */
  const fetched = (
    a: number,
    b: number,
    len: number,
    bytes: Uint8Array | undefined,
    ms: number,
    background = false,
  ) => {
    stats.ms += ms;
    stats.requests++;
    if (!bytes) return false;
    stats.fetched += len;
    for (let k = a; k <= b; k++) {
      // A block of a run is kept as a copy of its own: a view would keep the run's whole buffer alive for as long as
      // any one of its blocks stays (a chunked image's piece, the prefetch's 8 blocks), past the cache's budget.
      const view = bytes.subarray((k - a) * block, Math.min(len, (k - a + 1) * block));
      const one = a === b ? view : view.slice();
      if (!background || !store?.active()) keep(k, one);
      store?.put(k, one);
      if (background) ahead.add(k);
    }
    return true;
  };
  /** Blocks `a`..`b` (inclusive) from the source in one read, widened to what the source fetches anyway; false if it failed. */
  const fetch = (a: number, b: number) => {
    const [x, y, off, len] = widen(a, b);
    const t = performance.now();
    const bytes = src.read(off, len);
    return fetched(x, y, len, bytes, performance.now() - t);
  };
  /** Blocks being fetched without blocking (`readAsync`): a read that needs one waits for that fetch. */
  const pending = new Map<number, Promise<boolean>>();
  let fetching = 0,
    prefetching = 0;
  /**
   * The fetches' slots: taken when granted (so a fetch woken and not yet running counts), first come first served,
   * the guest's reads before the prefetch's, which also stays under PREFETCH_FETCHES.
   */
  const queued: (() => void)[] = [];
  const queuedAhead: (() => void)[] = [];
  const free = (background: boolean) =>
    fetching < MAX_FETCHES && (!background || (prefetching < PREFETCH_FETCHES && !queued.length));
  const take = (background: boolean) => {
    fetching++;
    if (background) prefetching++;
  };
  const acquire = (background: boolean) => {
    if (free(background) && !queued.length && !(background && queuedAhead.length)) return take(background);
    return new Promise<void>((go) => (background ? queuedAhead : queued).push(go));
  };
  const release = (background: boolean) => {
    fetching--;
    if (background) prefetching--;
    for (;;) {
      if (queued.length && free(false)) {
        take(false);
        queued.shift()!();
      } else if (queuedAhead.length && free(true)) {
        take(true);
        queuedAhead.shift()!();
      } else return;
    }
  };
  /** `fetch` with `src.readAsync`, at most MAX_FETCHES at once (`background`: the prefetch's, at most PREFETCH_FETCHES). */
  const fetchAsync = (a: number, b: number, background = false) => {
    const [x, y, off, len] = widen(a, b);
    let p!: Promise<boolean>; // its `finally` runs after the assignment
    p = (async () => {
      await acquire(background);
      const t = performance.now();
      try {
        return fetched(x, y, len, await src.readAsync!(off, len), performance.now() - t, background);
      } finally {
        release(background);
        for (let k = x; k <= y; k++) if (pending.get(k) === p) pending.delete(k);
        moved();
      }
    })();
    for (let k = x; k <= y; k++) if (!blocks.has(k)) pending.set(k, p);
    return p;
  };
  /**
   * The blocks of [first, end]: held ones (in memory or in the store) made most recent, missing ones fetched in runs of
   * adjacent ones (`get`), blocks already being fetched waited for. Returns what to wait for (`fetchAsync`'s), or false
   * if a synchronous fetch failed. `sync` (a synchronous read: the image's opening) can't wait: a block being fetched
   * (a prefetch's) is fetched again.
   */
  const gather = (
    first: number,
    end: number,
    get: (a: number, b: number) => boolean | Promise<boolean>,
    sync = false,
  ) => {
    const waits: Promise<boolean>[] = [];
    let run = -1;
    for (let k = first; k <= end; k++) {
      const at = order.get(k);
      if (at !== undefined && !blocks.has(k) && !store?.has(k)) late(k);
      if (at !== undefined && at > reached) {
        reached = at;
        moved();
      }
      if (ahead.delete(k)) prefetched.used++;
    }
    for (let k = first; k <= end + 1; k++) {
      if (k <= end && store && !blocks.has(k) && (sync || !pending.has(k))) {
        const kept = store.get(k);
        if (kept) {
          keep(k, kept);
          storeHits++;
        }
      }
      const wait = k <= end && !blocks.has(k) && !sync ? pending.get(k) : undefined;
      if (wait) waits.push(wait);
      const missing = k <= end && !blocks.has(k) && !wait;
      if (k <= end && (missing || wait)) stats.misses++;
      else if (k <= end) {
        stats.hits++;
        keep(k, blocks.get(k)!); // most recent now, so this read's fetches don't evict it
      }
      if (missing && run < 0) run = k;
      if (!missing && run >= 0) {
        const got = get(run, Math.min(k - 1, last));
        if (got === false) return false;
        if (got !== true) waits.push(got);
        run = -1;
      }
    }
    return waits;
  };
  /** The prefetch's list (block → its index), how far in it the guest's reads got, and a wake-up for the prefetch. */
  let order = new Map<number, number>();
  let reached = -1;
  let wake: (() => void) | undefined;
  const moved = () => {
    wake?.();
    wake = undefined;
  };
  const prefetched = { fetched: 0, used: 0, done: false, window: 0, late: 0, widened: 0 };
  /**
   * The window's ceiling (`prefetch`), whether the prefetch sat on its window since it last widened, and the blocks it
   * is fetching that the window held back (fetched once the guest moved).
   */
  let ceiling = 0,
    idled = false;
  const heldBack = new Set<number>();
  /**
   * The guest's read needs block `k` of the list from the network: the window widens if it held the prefetch back (the
   * block is being fetched only because the guest moved, or isn't, and the prefetch sat idle).
   */
  const late = (k: number) => {
    if (!ceiling || prefetched.done) return;
    prefetched.late++;
    if (!(pending.has(k) ? heldBack.has(k) : idled) || prefetched.window >= ceiling) return;
    prefetched.window = Math.min(ceiling, prefetched.window + AHEAD_STEP);
    prefetched.widened++;
    idled = false;
    moved();
  };
  let closed = false;
  /**
   * Fetches `list` (blocks in the order a boot read them) ahead of the guest, in the background: runs of adjacent
   * blocks one request each, at most PREFETCH_FETCHES at once, and no further ahead of the guest's place in the list
   * than its window (AHEAD_START, widened up to AHEAD_MAX, and never past half of what can keep the blocks: the store's
   * slots, or memory's blocks).
   */
  const prefetch = async (list: number[]) => {
    if (!src.readAsync || !list.length) return;
    order = new Map(list.map((b, i) => [b, i]));
    Object.defineProperty(stats, 'prefetch', { enumerable: true, get: () => ({ ...prefetched }) });
    ceiling = Math.min(AHEAD_MAX, Math.max(8, Math.floor((store ? store.stats().slots : max) / 2)));
    prefetched.window = Math.min(AHEAD_START, ceiling);
    const held = (b: number) => blocks.has(b) || pending.has(b) || !!store?.has(b);
    let parked = false; // the window held the prefetch back: what it fetches next, the guest may already want
    let outstanding = 0; // the prefetch's fetches not yet done: at most PREFETCH_FETCHES, so none waits long in the queue
    // It stops if the store gives up (the page's Clear, or the storage full): what it fetched would have nowhere to go.
    for (let i = 0; i < list.length && !closed && (!store || store.active());) {
      if (held(list[i]) || list[i] > last) {
        i++;
        continue;
      }
      if (i - reached > prefetched.window) {
        idled = parked = true;
        await new Promise<void>((go) => {
          wake = go;
        });
        continue;
      }
      let j = i + 1;
      while (j < list.length && j - i < 8 && list[j] === list[j - 1] + 1 && list[j] <= last && !held(list[j])) j++;
      prefetched.fetched += j - i;
      outstanding++;
      const run = list.slice(i, j);
      if (parked) for (const b of run) heldBack.add(b);
      void fetchAsync(list[i], list[j - 1], true).finally(() => {
        for (const b of run) heldBack.delete(b);
        outstanding--;
        moved();
      });
      i = j;
      // Its slots all busy: what it fetches next, the network held back, not the window.
      if (outstanding >= PREFETCH_FETCHES) parked = false;
      while (outstanding >= PREFETCH_FETCHES && !closed)
        await new Promise<void>((go) => {
          wake = go;
        });
    }
    prefetched.done = true;
  };
  /** [off, off + len) from the blocks held, or undefined where one isn't (evicted meanwhile, or never fetched). */
  const assemble = (off: number, len: number, first: number, end: number) => {
    const out = new Uint8Array(len);
    for (let k = first; k <= end; k++) {
      const b = blocks.get(k);
      if (!b) return undefined;
      keep(k, b);
      const from = Math.max(off, k * block),
        to = Math.min(off + len, k * block + b.length);
      out.set(b.subarray(from - k * block, to - k * block), from - off);
    }
    return out;
  };
  return {
    size: src.size,
    stats,
    prefetch,
    // What the disk surface asks (never a request's path): a block in memory, or kept in OPFS.
    kept: { block, has: (k: number) => blocks.has(k) || !!store?.has(k) },
    close: () => {
      closed = true;
      moved();
      store?.close();
      src.close?.();
    },
    read(off, len) {
      if (off < 0 || len < 0 || off + len > src.size) return undefined;
      if (len === 0) return new Uint8Array(0);
      const first = Math.floor(off / block),
        end = Math.floor((off + len - 1) / block);
      if (end - first + 1 > max) return src.read(off, len); // larger than the cache: past it
      return gather(first, end, fetch, true) === false ? undefined : assemble(off, len, first, end);
    },
    ...(src.readAsync && {
      async readAsync(off: number, len: number) {
        if (off < 0 || len < 0 || off + len > src.size) return undefined;
        if (len === 0) return new Uint8Array(0);
        const first = Math.floor(off / block),
          end = Math.floor((off + len - 1) / block);
        if (end - first + 1 > max) return src.readAsync!(off, len);
        // Other reads' fetches may evict this one's blocks while it waits: then it looks again.
        for (let tries = 0; tries < 3; tries++) {
          const waits = gather(first, end, fetchAsync) as Promise<boolean>[];
          if ((await Promise.all(waits)).includes(false)) return undefined;
          const out = assemble(off, len, first, end);
          if (out) return out;
        }
        return src.readAsync!(off, len); // evicted each time: past the cache
      },
    }),
  };
}
