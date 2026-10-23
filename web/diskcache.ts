// A remote disk's blocks kept in OPFS (docs/plans/remote-disks.md R3), under the block cache (web/blockcache.ts): a
// reload, a second boot or a Suspend's resume reads what was fetched before from this browser instead of the network.
// One directory per image under `remote-cache/`, named by the image's identity (a chunked image's id, or a URL with
// its size and the server's validator: an image without one isn't kept): `data` holds blocks in slots, `map` one
// little-endian u32 per image block (0: not held; n: slot n - 1). Bounded by the cache's size when opened plus a
// quarter of the free quota, at most 4 GiB: other images' caches go first (least recently used), then this image's
// slots are reused in the order they were filled. A slot's old map entry is cleared (durably) before its new block is
// written, and the block (durably) before its map entry, so a crash loses a block but never maps one to other bytes.
// The device worker holds the directory's Web Lock while it reads it; another tab on the same image gets no store (an
// opener waits 2 s for it: a restarting machine's old device worker lets go as it closes).
import { opfsDir, type SyncFile } from './overlay.ts';

export const CACHE_DIR = 'remote-cache';
/** At most this many bytes kept, whatever the quota. */
export const CACHE_MAX = 4 * 2 ** 30;
/** Of the free quota, the share the cache may grow into. */
const FREE_SHARE = 0.25;

/** Blocks of one image kept across sessions. */
export type BlockStore = {
  /** Block `b`'s bytes if held. */
  get(b: number): Uint8Array | undefined;
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

/** The stores open in this worker, which `releaseStores` empties. */
const stores = new Set<BlockStore>();

/**
 * Empties every open store (the guest's writes go before kept blocks: a disk's overlay found the storage full, and
 * the browser may have reported more room than it gives, as Chromium's incognito profile does); true if any held
 * something to give back.
 */
export function releaseStores() {
  let freed = false;
  for (const s of stores) {
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

/** The images' caches: their keys, bytes and when last used (the map's modification time). */
async function entries(): Promise<Entry[]> {
  const out: Entry[] = [];
  let root: FileSystemDirectoryHandle;
  try {
    root = await opfsDir(CACHE_DIR);
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
  return out;
}

/** What every image's cache holds, in bytes (the page's storage list). */
export async function cacheBytes() {
  return (await entries()).reduce((n, e) => n + e.bytes, 0);
}

/** Deletes the images' caches no machine is reading now (the page's Clear); resolves to the bytes freed. */
export async function clearCaches() {
  let freed = 0;
  for (const e of await entries()) {
    const release = await tryLock(e.key);
    if (!release) continue;
    try {
      await (await opfsDir(CACHE_DIR)).removeEntry(e.key, { recursive: true });
      freed += e.bytes;
    } finally {
      release();
    }
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
    const all = await entries();
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    const kept = all.reduce((n, e) => n + e.bytes, 0);
    const budget = Math.min(CACHE_MAX, kept + FREE_SHARE * Math.max(0, quota - usage));
    // Other images' caches, least recently used first, until this whole image fits beside them (or none can go).
    const others = all.filter((e) => e.key !== key).sort((a, b) => a.used - b.used);
    let rest = others.reduce((n, e) => n + e.bytes, 0);
    for (const e of others) {
      if (rest + size <= budget) break;
      const r = await tryLock(e.key);
      if (!r) continue;
      try {
        await (await opfsDir(CACHE_DIR)).removeEntry(e.key, { recursive: true });
        rest -= e.bytes;
      } finally {
        r();
      }
    }
    const blocks = Math.ceil(size / block);
    const slots = Math.floor((budget - rest) / (block + 4));
    if (slots < 16) {
      release();
      return undefined;
    }
    const dir = await opfsDir(`${CACHE_DIR}/${key}`, true);
    const open = async (n: string) => {
      const h = await (await dir.getFileHandle(n, { create: true })).createSyncAccessHandle();
      handles.push(h);
      return h as unknown as SyncFile;
    };
    const [data, mapFile] = [await open('data'), await open('map')];
    return blockStore(data, mapFile, size, block, Math.min(slots, blocks), () => {
      for (const h of handles) h.close();
      release();
    });
  } catch (e) {
    for (const h of handles) h.close();
    release();
    throw e;
  }
}

/** The store over its two files (memory files in the tests): `slots` blocks at most. */
export function blockStore(data: SyncFile, mapFile: SyncFile, size: number, block: number, slots: number, close: () => void = () => {}): BlockStore {
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
      // A short write (the storage is full: Chromium's sync handles return a short count, they don't throw) gives up.
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
  stores.add(store);
  return store;
}
