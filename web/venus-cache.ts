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
// misses every entry and leaves no stale bytes behind. Entries go to IndexedDB compressed (CompressionStream's
// deflate-raw, VK4 T17; one that doesn't shrink as it is) and are inflated at the load, so the budget counts what is
// stored: the bytes held in memory are larger by the ratio. The budget is the page's Preferences' (the Machines page:
// `Settings.shaderMiB`), and the Machines page's storage line shows the store's size and clears it
// (`shaderStoreSize`, `clearShaderStore`).

/**
 * An entry as stored: its key (hex), the renderer build it is of, its bytes (deflated when `packed`) and when it was last
 * used (ms since 1970).
 */
export type CacheEntry = { key: string; version: string; bytes: Uint8Array; used: number; packed?: boolean };

/** An entry in memory: its bytes as the renderer reads them, and what is stored of them once known (`stored`, deflated
 * or not: `packed`), whose length the budget counts (the bytes' own until then). */
type Held = { key: string; version: string; bytes: Uint8Array; used: number; stored?: Uint8Array; packed?: boolean };
const size = (e: Held) => (e.stored ?? e.bytes).length;

/** Where entries persist: IndexedDB in the browser (`idbBackend`), memory in tests. */
export interface CacheBackend {
  load(): Promise<CacheEntry[]>;
  /** Writes (adds or replaces) `put` and deletes `remove`, in one go. */
  save(put: CacheEntry[], remove: string[]): Promise<void>;
}

/** `bytes`: what the entries take stored (the budget's measure); `held`: their bytes in memory. */
export type CacheStats = { hits: number; misses: number; stores: number; evicted: number; bytes: number; held: number; entries: number; dropped: number };

/** The default budget (bytes): VK3 L3 measured the programs' sets (bench/vulkan/REPORT.md "VK3 L3"). */
export const CACHE_BUDGET = 32 << 20;
/** The budgets the Preferences offer (MiB): the bytes held in memory are ~7× the stored (vkQuake's; bench/vulkan/REPORT.md "VK4 T17"). */
export const CACHE_BUDGET_CHOICES = [8, 16, 32, 64];
/** How long after a change the entries are written back (ms). */
const FLUSH_MS = 1000;

export class ShaderCache {
  readonly stats: CacheStats = { hits: 0, misses: 0, stores: 0, evicted: 0, bytes: 0, held: 0, entries: 0, dropped: 0 };
  private readonly entries = new Map<string, Held>();
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
    const kept: Held[] = [];
    for (const e of loaded) {
      const bytes = e.version !== version || !(e.bytes instanceof Uint8Array) || c.stats.bytes + e.bytes.length > c.budget ? undefined
        : e.packed ? await inflate(e.bytes).catch(() => undefined) : e.bytes;
      if (!bytes) {
        c.removed.add(e.key);
        c.stats.dropped++;
        continue;
      }
      kept.push({ key: e.key, version: e.version, bytes, used: e.used, stored: e.bytes, packed: !!e.packed });
      c.stats.bytes += e.bytes.length;
      c.stats.held += bytes.length;
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
    this.drop(key);
    const e: Held = { key, version: this.version, bytes: bytes.slice(), used: this.now() };
    this.entries.set(key, e);
    this.stats.bytes += size(e);
    this.stats.held += e.bytes.length;
    this.stats.stores++;
    this.dirty.add(key);
    this.removed.delete(key);
    this.fit();
    this.schedule();
  }

  private drop(key: string) {
    const old = this.entries.get(key);
    if (!old) return;
    this.stats.bytes -= size(old);
    this.stats.held -= old.bytes.length;
    this.entries.delete(key);
  }

  /** The least recently used out while the budget is exceeded (the map iterates in insertion order and a use
   * reinserts: its first entries are the least recently used). */
  private fit() {
    for (const [k] of this.entries) {
      if (this.stats.bytes <= this.budget) break;
      this.drop(k);
      this.stats.evicted++;
      this.dirty.delete(k);
      this.removed.add(k);
    }
    this.stats.entries = this.entries.size;
  }

  private schedule() {
    if (!this.backend || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, FLUSH_MS);
  }

  /** Writes the changes back now (tests; the worker's timer otherwise), deflating what isn't yet. */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const put = [...this.dirty].map((k) => this.entries.get(k)!).filter(Boolean);
    const remove = [...this.removed];
    this.dirty.clear();
    this.removed.clear();
    if (!this.backend || (!put.length && !remove.length)) return this.writing;
    this.writing = this.writing.then(async () => {
      for (const e of put) {
        if (e.stored) continue;
        const packed = await deflate(e.bytes).catch(() => undefined);
        const before = size(e);
        [e.stored, e.packed] = packed && packed.length < e.bytes.length ? [packed, true] : [e.bytes, false];
        // Still held (not dropped meanwhile): what it takes stored now counts.
        if (this.entries.get(e.key) === e) this.stats.bytes += size(e) - before;
      }
      await this.backend!.save(put.map((e) => ({ key: e.key, version: e.version, bytes: e.stored!, used: e.used, packed: e.packed })), remove);
    }).catch((err) => console.warn('venus-cache: the shaders could not be stored', err));
    return this.writing;
  }
}

/** Bytes through a CompressionStream or DecompressionStream. */
async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream)).arrayBuffer());
}
const deflate = (bytes: Uint8Array) => through(bytes, new CompressionStream('deflate-raw'));
const inflate = (bytes: Uint8Array) => through(bytes, new DecompressionStream('deflate-raw'));

/** The backend in the browser: IndexedDB `webpc-shaders`, store `entries` keyed by `key`. */
export function idbBackend(name = 'webpc-shaders'): CacheBackend & { clear(): Promise<void>; close(): void } {
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
    async clear() {
      const d = await (db ??= open());
      const t = d.transaction('entries', 'readwrite');
      t.objectStore('entries').clear();
      await done(t);
    },
    close() {
      void db?.then((d) => d.close(), () => {});
      db = undefined;
    },
  };
}

/** Whether the origin has the store's database (so that looking doesn't make one). */
async function exists(name: string) {
  const list = await indexedDB.databases?.().catch(() => undefined);
  return !list || list.some((d) => d.name === name);
}

/** What the store takes in this browser (the Machines page's storage line): its entries' stored bytes. */
export async function shaderStoreSize(name = 'webpc-shaders'): Promise<{ bytes: number; entries: number }> {
  if (typeof indexedDB === 'undefined' || !(await exists(name))) return { bytes: 0, entries: 0 };
  const backend = idbBackend(name);
  const entries = await backend.load().finally(() => backend.close());
  return { bytes: entries.reduce((n, e) => n + (e.bytes?.length ?? 0), 0), entries: entries.length };
}

/** Deletes every entry (the Machines page): a machine running with Vulkan keeps what it holds, and stores it again as it changes. */
export async function clearShaderStore(name = 'webpc-shaders') {
  if (typeof indexedDB === 'undefined' || !(await exists(name))) return;
  const backend = idbBackend(name);
  await backend.clear().finally(() => backend.close());
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
