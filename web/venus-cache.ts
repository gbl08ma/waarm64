// Vulkan's shaders across runs (vk/README.md "The shader cache"; VK3 L3): what the renderer's pipeline caches miss they
// look up here (vk/wasi/disk_cache.c: Mesa's disk cache, as `wg` imports), and what they make they store here: a stage's
// NIR after spirv_to_nir and a pipeline's translated shaders (WGSL, with what the driver needs of them), by BLAKE3 keys of
// the SPIR-V, its specialization, the pipeline's layouts and the device's caps. So a program's second run on a machine
// translates nothing it translated on its first (the browser's own pipeline compile is its cache's: Dawn's and the
// GPU's driver's).
//
// The renderer asks synchronously, so the entries are all in memory: loaded once when Vulkan starts, kept under a byte
// budget (least recently used out first), and written back to IndexedDB (database `waarm64-shaders`, store `entries`) a
// moment after they change. One store for the origin, shared by every machine: an entry is a translation, which depends
// on the shader and the device, not on the machine. Entries carry the renderer's build ID (`venus_build_id`: a hash of
// vk/'s sources, which is also in their keys): those of another build are dropped at the load, so a translator change
// misses every entry and leaves no stale bytes behind. Entries are held and stored compressed (CompressionStream's
// deflate-raw at the write-back, VK4 T17; one that doesn't shrink as it is), and inflated at each lookup, synchronously
// (fflate's inflateSync: bench/vulkan/REPORT.md "VK4 T49 follow-up"), so the budget counts what is held too; an entry
// is held as the renderer gave it only until its write-back. The budget is the page's Preferences' (the Home page:
// `Settings.shaderMiB`), and the Home page's storage line shows the store's size and clears it
// (`shaderStoreSize`, `clearShaderStore`).

import { inflateSync } from 'fflate';

/**
 * An entry as stored: its key (hex), the renderer build it is of, its bytes (deflated when `packed`; `size`, their
 * length inflated, where known) and when it was last used (ms since 1970).
 */
export type CacheEntry = { key: string; version: string; bytes: Uint8Array; used: number; packed?: boolean; size?: number };

/** An entry in memory: until its write-back, its bytes as the renderer gave them (`bytes`); from then on what is stored
 * of them (`stored`, deflated or not: `packed`, `size` long inflated). The budget counts what it holds. */
type Held = { key: string; version: string; used: number; bytes?: Uint8Array; stored?: Uint8Array; packed?: boolean; size?: number };
const size = (e: Held) => (e.stored ?? e.bytes)!.length;

/** Where entries persist: IndexedDB in the browser (`idbBackend`), memory in tests. */
export interface CacheBackend {
  load(): Promise<CacheEntry[]>;
  /** Writes (adds or replaces) `put` and deletes `remove`, in one go. */
  save(put: CacheEntry[], remove: string[]): Promise<void>;
}

/** `bytes`: what the entries take stored (the budget's measure); `held`: their bytes in memory (more than `bytes` only
 * by the entries not yet written back); `inflateMs`: the lookups' inflates, in all. */
export type CacheStats = { hits: number; misses: number; stores: number; evicted: number; bytes: number; held: number; entries: number; dropped: number; inflateMs: number };

/** The default budget (bytes): VK3 L3 measured the programs' sets (bench/vulkan/REPORT.md "VK3 L3"). */
export const CACHE_BUDGET = 32 << 20;
/** The budgets the Preferences offer (MiB): the bytes held in memory are the stored (bench/vulkan/REPORT.md "VK4 T49 follow-up"). */
export const CACHE_BUDGET_CHOICES = [8, 16, 32, 64];
/** How long after a change the entries are written back (ms). */
const FLUSH_MS = 1000;

export class ShaderCache {
  readonly stats: CacheStats = { hits: 0, misses: 0, stores: 0, evicted: 0, bytes: 0, held: 0, entries: 0, dropped: 0, inflateMs: 0 };
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
      // Held as stored: a packed entry is inflated at its lookups (one that fails to is dropped there).
      if (e.version !== version || !(e.bytes instanceof Uint8Array) || c.stats.bytes + e.bytes.length > c.budget) {
        c.removed.add(e.key);
        c.stats.dropped++;
        continue;
      }
      kept.push({ key: e.key, version: e.version, used: e.used, stored: e.bytes, packed: !!e.packed, size: e.size });
      c.stats.bytes += e.bytes.length;
      c.stats.held += e.bytes.length;
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
    const bytes = e.bytes ?? (e.packed ? this.inflate(e) : e.stored);
    if (!bytes) {
      // A stored entry that doesn't inflate: gone, and a miss.
      this.drop(key);
      this.stats.dropped++;
      this.stats.misses++;
      this.stats.entries = this.entries.size;
      this.removed.add(key);
      this.dirty.delete(key);
      this.schedule();
      return undefined;
    }
    this.stats.hits++;
    // Its use, written back too: what the budget keeps at the next load follows it.
    e.used = this.now();
    this.entries.delete(key);
    this.entries.set(key, e);
    this.dirty.add(key);
    this.schedule();
    return bytes;
  }

  /** A held entry's bytes inflated (a new array each time: the renderer copies them at once), its size learned. */
  private inflate(e: Held): Uint8Array | undefined {
    const t = performance.now();
    try {
      const bytes = inflateSync(e.stored!, e.size ? { out: new Uint8Array(e.size) } : undefined);
      if (e.size !== undefined && bytes.length !== e.size) return undefined;
      e.size = bytes.length;
      return bytes;
    } catch {
      return undefined;
    } finally {
      this.stats.inflateMs += performance.now() - t;
    }
  }

  /** Stores a copy of `bytes` under `key`; the least recently used go while the budget is exceeded. */
  put(key: string, bytes: Uint8Array) {
    if (bytes.length > this.budget / 4) return;
    this.drop(key);
    const e: Held = { key, version: this.version, bytes: bytes.slice(), used: this.now(), size: bytes.length };
    this.entries.set(key, e);
    this.stats.bytes += size(e);
    this.stats.held += size(e);
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
    this.stats.held -= size(old);
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

  /** Writes the changes back now (tests; the worker's timer otherwise), deflating what isn't yet: from then on that is
   * what is held. */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const put = [...this.dirty].map((k) => this.entries.get(k)!).filter(Boolean);
    const remove = [...this.removed];
    this.dirty.clear();
    this.removed.clear();
    if (!this.backend || (!put.length && !remove.length)) return this.writing;
    this.writing = this.writing.then(async () => {
      for (const e of put) {
        if (e.stored || !e.bytes) continue;
        const raw = e.bytes;
        const packed = await deflate(raw).catch(() => undefined);
        const before = size(e);
        [e.stored, e.packed, e.bytes] = packed && packed.length < raw.length ? [packed, true, undefined] : [raw, false, undefined];
        // Still held: what it takes now counts.
        if (this.entries.get(e.key) === e) {
          this.stats.bytes += size(e) - before;
          this.stats.held += size(e) - before;
        }
      }
      await this.backend!.save(put.map((e) => ({ key: e.key, version: e.version, bytes: e.stored!, used: e.used, packed: e.packed, size: e.size })), remove);
    }).catch((err) => console.warn('venus-cache: the shaders could not be stored', err));
    return this.writing;
  }
}

/** Bytes through a CompressionStream (deflate-raw: what inflateSync reads). */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
}

/** The backend in the browser: IndexedDB `waarm64-shaders`, store `entries` keyed by `key`. */
export function idbBackend(name = 'waarm64-shaders'): CacheBackend & { clear(): Promise<void>; close(): void } {
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

/** What the store takes in this browser (the Home page's storage line): its entries' stored bytes. */
export async function shaderStoreSize(name = 'waarm64-shaders'): Promise<{ bytes: number; entries: number }> {
  if (typeof indexedDB === 'undefined' || !(await exists(name))) return { bytes: 0, entries: 0 };
  const backend = idbBackend(name);
  const entries = await backend.load().finally(() => backend.close());
  return { bytes: entries.reduce((n, e) => n + (e.bytes?.length ?? 0), 0), entries: entries.length };
}

/** Deletes every entry (the Home page): a machine running with Vulkan keeps what it holds, and stores it again as it changes. */
export async function clearShaderStore(name = 'waarm64-shaders') {
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
