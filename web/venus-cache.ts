// Vulkan's shaders across runs (vk/README.md "The shader cache"; VK3 L3): what the renderer's pipeline caches miss they
// look up here (vk/wasi/disk_cache.c: Mesa's disk cache, as `wg` imports), and what they make they store here: a stage's
// NIR after spirv_to_nir and a pipeline's translated shaders (WGSL, with what the driver needs of them), by BLAKE3 keys of
// the SPIR-V, its specialization, the pipeline's layouts and the device's caps. So a program's second run on a machine
// translates nothing it translated on its first (the browser's own pipeline compile is its cache's: Dawn's and the
// GPU's driver's).
//
// The renderer asks synchronously, so the entries are all in memory: loaded once when Vulkan starts, kept under a byte
// budget (least recently used out first), and written back to IndexedDB (database `webpc-shaders`, store `entries`) a
// moment after they change. One store for the origin, shared by every machine: an entry is a translation, which depends
// on the shader and the device, not on the machine. Entries carry the renderer's build ID (`venus_build_id`: a hash of
// vk/'s sources, which is also in their keys): those of another build are dropped at the load, so a translator change
// misses every entry and leaves no stale bytes behind.

/** An entry as stored: its key (hex), the renderer build it is of, its bytes and when it was last used (ms since 1970). */
export type CacheEntry = { key: string; version: string; bytes: Uint8Array; used: number };

/** Where entries persist: IndexedDB in the browser (`idbBackend`), memory in tests. */
export interface CacheBackend {
  load(): Promise<CacheEntry[]>;
  /** Writes (adds or replaces) `put` and deletes `remove`, in one go. */
  save(put: CacheEntry[], remove: string[]): Promise<void>;
}

export type CacheStats = { hits: number; misses: number; stores: number; evicted: number; bytes: number; entries: number; dropped: number };

/** The default budget (bytes): VK3 L3 measured the programs' sets (bench/vulkan/REPORT.md "VK3 L3"). */
export const CACHE_BUDGET = 32 << 20;
/** How long after a change the entries are written back (ms). */
const FLUSH_MS = 1000;

export class ShaderCache {
  readonly stats: CacheStats = { hits: 0, misses: 0, stores: 0, evicted: 0, bytes: 0, entries: 0, dropped: 0 };
  private readonly entries = new Map<string, CacheEntry>();
  private readonly dirty = new Set<string>();
  private readonly removed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private clock = 0;
  readonly version: string;
  readonly budget: number;
  private readonly backend: CacheBackend | undefined;

  private constructor(version: string, budget: number, backend: CacheBackend | undefined) {
    [this.version, this.budget, this.backend] = [version, budget, backend];
  }

  /** The store for renderer build `version`, its entries loaded (none if the backend fails: a cache, not a store of record). */
  static async open(version: string, options: { budget?: number; backend?: CacheBackend } = {}) {
    const c = new ShaderCache(version, options.budget ?? CACHE_BUDGET, options.backend);
    let loaded: CacheEntry[] = [];
    try {
      loaded = (await c.backend?.load()) ?? [];
    } catch (err) {
      console.warn('venus-cache: the stored shaders could not be read', err);
    }
    // Newest first, so that the budget keeps the most recently used; then into the map oldest first (its order is the
    // order of use: `put` evicts from its start).
    loaded.sort((a, b) => b.used - a.used);
    const kept: CacheEntry[] = [];
    for (const e of loaded) {
      if (e.version !== version || !(e.bytes instanceof Uint8Array) || c.stats.bytes + e.bytes.length > c.budget) {
        c.removed.add(e.key);
        c.stats.dropped++;
        continue;
      }
      kept.push(e);
      c.stats.bytes += e.bytes.length;
      c.clock = Math.max(c.clock, e.used);
    }
    for (const e of kept.reverse()) c.entries.set(e.key, e);
    c.stats.entries = c.entries.size;
    if (c.removed.size) c.schedule();
    return c;
  }

  private now() { return (this.clock = Math.max(this.clock + 1, Date.now())); }

  get(key: string): Uint8Array | undefined {
    const e = this.entries.get(key);
    if (!e) {
      this.stats.misses++;
      return undefined;
    }
    this.stats.hits++;
    // Its use, written back too: what the budget keeps at the next load follows it.
    e.used = this.now();
    this.entries.delete(key);
    this.entries.set(key, e);
    this.dirty.add(key);
    this.schedule();
    return e.bytes;
  }

  /** Stores a copy of `bytes` under `key`; the least recently used go while the budget is exceeded. */
  put(key: string, bytes: Uint8Array) {
    if (bytes.length > this.budget / 4) return;
    const old = this.entries.get(key);
    if (old) {
      this.stats.bytes -= old.bytes.length;
      this.entries.delete(key);
    }
    const e: CacheEntry = { key, version: this.version, bytes: bytes.slice(), used: this.now() };
    this.entries.set(key, e);
    this.stats.bytes += e.bytes.length;
    this.stats.stores++;
    this.dirty.add(key);
    this.removed.delete(key);
    // The map iterates in insertion order and a use reinserts: its first entries are the least recently used.
    for (const [k, v] of this.entries) {
      if (this.stats.bytes <= this.budget) break;
      this.entries.delete(k);
      this.stats.bytes -= v.bytes.length;
      this.stats.evicted++;
      this.dirty.delete(k);
      this.removed.add(k);
    }
    this.stats.entries = this.entries.size;
    this.schedule();
  }

  private schedule() {
    if (!this.backend || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, FLUSH_MS);
  }

  /** Writes the changes back now (tests; the worker's timer otherwise). */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const put = [...this.dirty].map((k) => this.entries.get(k)!).filter(Boolean);
    const remove = [...this.removed];
    this.dirty.clear();
    this.removed.clear();
    if (!this.backend || (!put.length && !remove.length)) return this.writing;
    this.writing = this.writing.then(() => this.backend!.save(put, remove)).catch((err) => console.warn('venus-cache: the shaders could not be stored', err));
    return this.writing;
  }
}

/** The backend in the browser: IndexedDB `webpc-shaders`, store `entries` keyed by `key`. */
export function idbBackend(name = 'webpc-shaders'): CacheBackend {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('entries', { keyPath: 'key' }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  let db: Promise<IDBDatabase> | undefined;
  const done = (t: IDBTransaction) => new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return {
    async load() {
      const d = await (db ??= open());
      const t = d.transaction('entries', 'readonly');
      const r = t.objectStore('entries').getAll();
      await done(t);
      return r.result as CacheEntry[];
    },
    async save(put, remove) {
      const d = await (db ??= open());
      const t = d.transaction('entries', 'readwrite');
      const s = t.objectStore('entries');
      for (const k of remove) s.delete(k);
      for (const e of put) s.put(e);
      await done(t);
    },
  };
}

/** A backend in memory (tests: two caches over one backend are two runs). */
export function memoryBackend(): CacheBackend & { entries: Map<string, CacheEntry> } {
  const entries = new Map<string, CacheEntry>();
  return {
    entries,
    async load() { return [...entries.values()].map((e) => ({ ...e, bytes: e.bytes.slice() })); },
    async save(put, remove) {
      for (const k of remove) entries.delete(k);
      for (const e of put) entries.set(e.key, { ...e, bytes: e.bytes.slice() });
    },
  };
}
