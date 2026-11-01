// A remote disk's blocks kept in OPFS (docs/devices.md "Over HTTP"), under the block cache (web/blockcache.ts): a
// reload, a second boot or a Suspend's resume reads what was fetched before from this browser instead of the network.
// They live in a Storage Bucket of their own where the browser has them (Chromium): not persisted, so the browser may
// take it back under pressure even when the origin's storage is kept (the machines' disks), and expiring a week after
// it was last used, so a visit to a demo doesn't keep its blocks for good. Elsewhere, the origin's OPFS under
// `remote-cache/`. Either way an image's cache unused for a week is deleted when the page next looks (`entries`).
// One directory per image, named by the image's identity (a chunked image's id, or a URL with its size and the
// server's validator: an image without one isn't kept): `data` holds blocks in slots, `map` one little-endian u32 per
// image block (0: not held; n: slot n - 1); the map's modification time is when it was last used (touched at open).
// Bounded by the cache's size when opened plus a quarter of the free quota, at most 2 GiB: other images' caches go
// first (least recently used), then this image's slots are reused in the order they were filled. A slot's old map entry is cleared (durably) before its new block is
// written, and the block (durably) before its map entry, so a crash loses a block but never maps one to other bytes.
// The device worker holds the directory's Web Lock while it reads it; another tab on the same image gets no store (an
// opener waits 2 s for it: a restarting machine's old device worker lets go as it closes). The page's Clear asks the
// workers holding one to give its space back (`clearCaches`).
import { opfsDir, shortOnFull, type SyncFile } from './overlay.ts';

/** The Storage Bucket's name, or the OPFS directory's where there are no buckets. */
export const CACHE_DIR = 'remote-cache';
/** At most this many bytes kept, whatever the quota. */
export const CACHE_MAX = 2 * 2 ** 30;
/** An image's cache unused this long is deleted; the bucket expires this long after its last use. */
export const CACHE_EXPIRY_MS = 7 * 86_400_000;
/** The bucket's quota: the cache and its maps. */
const BUCKET_QUOTA = CACHE_MAX + 64 * 2 ** 20;
/** Of the free quota, the share the cache may grow into. */
const FREE_SHARE = 0.25;

/** Blocks of one image kept across sessions. */
export type BlockStore = {
  /** Block `b`'s bytes if held. */
  get(b: number): Uint8Array | undefined;
  /** Whether it still keeps blocks (not since `giveUp`). */
  active(): boolean;
  /** Whether block `b` is held (without reading it). */
  has(b: number): boolean;
  /** Keeps block `b` (its bytes as fetched: the last block may be short). */
  put(b: number, bytes: Uint8Array): void;
  /** Blocks held and the slots it may use; `gaveUp` once it stopped (`giveUp`). */
  stats(): { held: number; slots: number; reads: number; writes: number; ms: number; gaveUp: boolean };
  /**
   * Stops keeping anything for the rest of the session and gives its space back (its map cleared, its data cut off):
   * after a failed write of its own, or when a disk's own write found the storage full (`releaseStores`).
   */
  giveUp(): void;
  close(): void;
};

/** The stores open in this worker, which `releaseStores` empties, by their image's key. */
const stores = new Map<BlockStore, string>();

type Bucket = { getDirectory(): Promise<FileSystemDirectoryHandle>; setExpires(t: number): Promise<void> };
type Buckets = { open(name: string, o?: { persisted?: boolean; durability?: string; quota?: number; expires?: number }): Promise<Bucket> };
/** Storage Buckets (Chromium; not in the DOM types yet). */
const buckets = () => (navigator as unknown as { storageBuckets?: Buckets }).storageBuckets;

/**
 * The directory holding the images' caches: the bucket's root (`use`: its expiry pushed on, as an image is opened), or
 * `remote-cache/` in the origin's OPFS. Where there are buckets, an older page's `remote-cache/` there is deleted.
 */
export async function cacheRoot(use = false): Promise<FileSystemDirectoryHandle> {
  const sb = buckets();
  if (!sb) return opfsDir(CACHE_DIR, true);
  const bucket = await sb.open(CACHE_DIR, { persisted: false, durability: 'relaxed', quota: BUCKET_QUOTA, expires: Date.now() + CACHE_EXPIRY_MS });
  if (use) await bucket.setExpires(Date.now() + CACHE_EXPIRY_MS);
  await (await navigator.storage.getDirectory()).removeEntry(CACHE_DIR, { recursive: true }).catch(() => {});
  return bucket.getDirectory();
}

/** The channel on which the page's Clear asks this origin's workers to empty the stores they hold. */
const CLEAR_CHANNEL = 'webpc-remote-cache';
let clearChannel: BroadcastChannel | undefined;
/** This worker answers Clear (once it opened a store): its stores give up, and it names the images they were. */
function answerClear() {
  if (clearChannel || typeof BroadcastChannel === 'undefined') return;
  clearChannel = new BroadcastChannel(CLEAR_CHANNEL);
  clearChannel.onmessage = (e) => {
    if (e.data?.clear !== true) return;
    const keys = [...stores].map(([s, key]) => (s.giveUp(), key));
    if (keys.length) clearChannel!.postMessage({ cleared: keys });
  };
}

/**
 * Empties every open store (the guest's writes go before kept blocks: a disk's overlay found the storage full, and
 * the browser may have reported more room than it gives, as Chromium's incognito profile does); true if any held
 * something to give back.
 */
export function releaseStores() {
  let freed = false;
  for (const s of stores.keys()) {
    const st = s.stats();
    if (!st.gaveUp && st.held) freed = true;
    s.giveUp();
  }
  return freed;
}

/** The directory name for an image's identity (any string: a JSON of what identifies it). */
export async function cacheKey(identity: string) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)));
  return [...h.subarray(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Holds the image's lock: its release, or undefined if someone else holds it now (`waitMs` 0) or still after `waitMs`
 * (a machine restarting: its old device worker lets go as it closes).
 */
function tryLock(key: string, waitMs = 0): Promise<(() => void) | undefined> {
  return new Promise((resolve) => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    navigator.locks.request(`webpc-cache:${key}`, waitMs ? { signal: AbortSignal.timeout(waitMs) } : { ifAvailable: true }, (lock) => {
      if (!lock) return void resolve(undefined);
      resolve(release);
      return held;
    }).catch(() => resolve(undefined));
  });
}

/** How long an opener waits for the image's previous reader. */
const LOCK_WAIT_MS = 2000;

type Entry = { key: string; bytes: number; used: number };

/**
 * The images' caches: their keys, bytes and when last used (the map's modification time); those unused past
 * CACHE_EXPIRY_MS (and not open) are deleted instead.
 */
async function entries(root?: FileSystemDirectoryHandle): Promise<Entry[]> {
  const out: Entry[] = [];
  try {
    root ??= await cacheRoot();
  } catch {
    return out;
  }
  for await (const [key, h] of (root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (h.kind !== 'directory') continue;
    const d = h as FileSystemDirectoryHandle;
    const file = (n: string) => d.getFileHandle(n).then((f) => f.getFile(), () => undefined);
    const [data, map] = await Promise.all([file('data'), file('map')]);
    out.push({ key, bytes: (data?.size ?? 0) + (map?.size ?? 0), used: map?.lastModified ?? 0 });
  }
  const now = Date.now();
  const kept: Entry[] = [];
  for (const e of out) if (now - e.used < CACHE_EXPIRY_MS || !(await remove(root, e.key))) kept.push(e);
  return kept;
}

/** Deletes image `key`'s cache unless a machine is reading it; whether it did. */
async function remove(root: FileSystemDirectoryHandle, key: string) {
  const release = await tryLock(key);
  if (!release) return false;
  try {
    await root.removeEntry(key, { recursive: true });
    return true;
  } catch {
    return false;
  } finally {
    release();
  }
}

/** What every image's cache holds, in bytes (the page's storage list). */
export async function cacheBytes() {
  return (await entries()).reduce((n, e) => n + e.bytes, 0);
}

/** How long Clear waits for the machines reading an image to give its space back. */
const CLEAR_WAIT_MS = 2000;

/**
 * Deletes the images' caches (the page's Clear): those a running machine reads, it empties (it reads from memory and
 * the network from then on); resolves to the bytes freed.
 */
export async function clearCaches() {
  const root = await cacheRoot();
  let freed = 0;
  const open = new Map<string, number>();
  for (const e of await entries(root)) {
    if (await remove(root, e.key)) freed += e.bytes;
    else open.set(e.key, e.bytes);
  }
  if (!open.size || typeof BroadcastChannel === 'undefined') return freed;
  const ch = new BroadcastChannel(CLEAR_CHANNEL);
  try {
    await new Promise<void>((done) => {
      const timer = setTimeout(done, CLEAR_WAIT_MS);
      ch.onmessage = (e) => {
        for (const key of (e.data?.cleared ?? []) as string[]) if (open.has(key)) (freed += open.get(key)!, open.delete(key));
        if (!open.size) (clearTimeout(timer), done());
      };
      ch.postMessage({ clear: true });
    });
  } finally {
    ch.close();
  }
  return freed;
}

/**
 * Opens (or makes) the store of the image `key` (`cacheKey`) of `size` bytes in `block`-byte blocks, making room by
 * deleting other images' caches; undefined where it can't (no OPFS, another tab has it, no room).
 */
export async function openBlockStore(key: string, size: number, block: number): Promise<BlockStore | undefined> {
  if (typeof navigator.storage === 'undefined' || typeof FileSystemSyncAccessHandle === 'undefined') return undefined;
  const release = await tryLock(key, LOCK_WAIT_MS);
  if (!release) return undefined;
  const handles: FileSystemSyncAccessHandle[] = [];
  try {
    const root = await cacheRoot(true);
    const all = await entries(root);
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    const kept = all.reduce((n, e) => n + e.bytes, 0);
    const budget = Math.min(CACHE_MAX, kept + FREE_SHARE * Math.max(0, quota - usage));
    // Other images' caches, least recently used first, until this whole image fits beside them (or none can go).
    const others = all.filter((e) => e.key !== key).sort((a, b) => a.used - b.used);
    let rest = others.reduce((n, e) => n + e.bytes, 0);
    for (const e of others) {
      if (rest + size <= budget) break;
      if (await remove(root, e.key)) rest -= e.bytes;
    }
    const blocks = Math.ceil(size / block);
    const slots = Math.floor((budget - rest) / (block + 4));
    if (slots < 16) {
      release();
      return undefined;
    }
    const dir = await root.getDirectoryHandle(key, { create: true });
    const open = async (n: string) => {
      const h = await (await dir.getFileHandle(n, { create: true })).createSyncAccessHandle();
      handles.push(h);
      return h as unknown as SyncFile;
    };
    const [data, mapFile] = [await open('data'), await open('map')];
    // Used now: the map's first entry written back, so its modification time says so (CACHE_EXPIRY_MS).
    const first = new Uint8Array(4);
    mapFile.read(first, { at: 0 });
    mapFile.write(first, { at: 0 });
    mapFile.flush();
    answerClear();
    const store = blockStore(data, mapFile, size, block, Math.min(slots, blocks), () => {
      for (const h of handles) h.close();
      release();
    });
    stores.set(store, key);
    return store;
  } catch (e) {
    for (const h of handles) h.close();
    release();
    throw e;
  }
}

/** The store over its two files (memory files in the tests): `slots` blocks at most. */
export function blockStore(data: SyncFile, mapFile: SyncFile, size: number, block: number, slots: number, close: () => void = () => {}): BlockStore {
  [data, mapFile] = [shortOnFull(data), shortOnFull(mapFile)]; // a refused write gives up, as a short one does, never throws into a read
  const blocks = Math.ceil(size / block);
  const map = new Uint32Array(blocks);
  mapFile.read(new Uint8Array(map.buffer, 0, Math.min(mapFile.getSize(), blocks * 4)), { at: 0 });
  const owner = new Int32Array(slots).fill(-1);
  let used = 0;
  for (let b = 0; b < blocks; b++) {
    const s = map[b] - 1;
    if (s < 0) continue;
    if (s >= slots || owner[s] >= 0) map[b] = 0; // past a smaller budget, or a slot claimed twice: not held
    else (owner[s] = b, used = Math.max(used, s + 1));
  }
  let next = used % slots; // once full, slots are reused from here on
  const lengthOf = (b: number) => Math.min(block, size - b * block);
  /** Writes block `b`'s map entry; false if the write fell short. */
  const entry = (b: number) => mapFile.write(new Uint8Array(map.buffer, b * 4, 4), { at: b * 4 }) === 4;
  const n = { reads: 0, writes: 0, ms: 0 };
  let gaveUp = false;
  const store: BlockStore = {
    active: () => !gaveUp,
    has: (b) => !gaveUp && map[b] > 0,
    get(b) {
      if (gaveUp) return undefined;
      const s = map[b] - 1;
      if (s < 0) return undefined;
      const t = performance.now();
      const bytes = new Uint8Array(lengthOf(b));
      const k = data.read(bytes, { at: s * block });
      n.reads++;
      n.ms += performance.now() - t;
      return k === bytes.length ? bytes : undefined;
    },
    put(b, bytes) {
      if (gaveUp || map[b] || bytes.length !== lengthOf(b)) return;
      const t = performance.now();
      let s: number;
      if (used < slots) s = used++;
      else {
        s = next;
        next = (next + 1) % slots;
        const old = owner[s];
        if (old >= 0) {
          map[old] = 0;
          owner[s] = -1;
          if (!entry(old)) return store.giveUp();
          mapFile.flush();
        }
      }
      // A short write (the storage is full: Chromium's sync handles return a short count or throw `QuotaExceededError`,
      // which `shortOnFull` makes a short count) gives up.
      if (data.write(bytes, { at: s * block }) !== bytes.length) return store.giveUp();
      data.flush();
      owner[s] = b;
      map[b] = s + 1;
      if (!entry(b)) return store.giveUp();
      n.writes++;
      n.ms += performance.now() - t;
    },
    stats: () => ({ held: gaveUp ? 0 : owner.filter((b) => b >= 0).length, slots, ...n, gaveUp }),
    giveUp() {
      if (gaveUp) return;
      gaveUp = true;
      // The map first (nothing maps a slot any more), then the data cut off; best effort: the storage may be full.
      try {
        map.fill(0);
        mapFile.truncate(0);
        mapFile.flush();
        data.truncate(0);
        data.flush();
      } catch {}
    },
    close() {
      stores.delete(store);
      if (!gaveUp) mapFile.flush();
      close();
    },
  };
  stores.set(store, '');
  return store;
}
