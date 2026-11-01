// Copy-on-write overlay over a read-only disk (M4 step 5), in 4 KiB blocks. The
// browser keeps it on OPFS (web/devices.ts opens the files in the device
// worker, with synchronous access handles): `data` holds the written blocks in
// the order they were first written, `map` one little-endian u32 per disk block
// (0: not written; n: slot n - 1 of `data`; 0xffffffff: zeros, without a slot:
// a block the guest discarded or zeroed). A block is written to its slot
// before its map entry, so a crash can leak a slot but never map a block to
// garbage. Slots that no block maps (a discarded block's, a leaked one) are
// found when the overlay is opened and taken by the next first writes; free
// slots at the end of `data` are cut off, and once half of it is free the rest
// is moved down (`compact`). `meta` holds the overlay's generation (docs/machines.md §3.3):
// bumped, durably, before the first change of each opening, so "the overlay is as it was at
// generation g" is a comparison of two integers. core/tests/common's `Overlay` is the native
// (in-memory) equivalent (without discard or a generation).
import type { Disk } from './qcow2.ts';

/** The part of `FileSystemSyncAccessHandle` the overlay uses. */
export type SyncFile = {
  read(buf: Uint8Array, o: { at: number }): number;
  write(buf: Uint8Array, o: { at: number }): number;
  getSize(): number;
  truncate(size: number): void;
  flush(): void;
};

const BLOCK = 4096;
/** A map entry: the block reads as zeros and has no slot. */
const ZERO = 0xffffffff;
/** The fewest free slots worth compacting `data` for. */
const COMPACT_MIN = 64;

export type WritableDisk = Disk & {
  /** Writes `bytes` at `off` (inside the disk); false on a failed write. */
  write(off: number, bytes: Uint8Array): Promise<boolean>;
  /**
   * The guest has no use for `len` bytes at `off` (inside the disk): the whole blocks among them
   * that the overlay holds read as zeros from now on and give their slots back (the base's bytes
   * must not come back: QEMU's qcow2 does the same over a backing file). Blocks the overlay
   * doesn't hold, and blocks only partly covered, are left as they are. False on a failed write.
   */
  discard(off: number, len: number): boolean;
  /** Makes `len` bytes at `off` read as zeros: whole blocks without a slot, the partly covered ones at the ends written. False on a failed write. */
  zero(off: number, len: number): Promise<boolean>;
  flush(): void;
  /** The disk blocks (4 KiB) the overlay holds, ascending: what the disk has changed (the zeroed ones too). */
  written(): number[];
  /** The overlay's own copy of block `b` (one of `written()`), 4 KiB (zeros past the disk's end); undefined on a failed read. */
  block(b: number): Uint8Array | undefined;
  /** Whether block `b` is one the overlay holds as zeros, without a slot. */
  zeroed(b: number): boolean;
  /** The overlay's generation, and `epoch` (both: overlays with a `meta`; a ramdisk has neither). */
  generation?(): number;
  epoch?(): void;
};

/** An overlay's `meta` file: its generation (u64 LE at 0) and, for a stored disk, the overlay being merged into it (`merging`: its id, or empty). */
export type Meta = { generation: number; merging: string };
const META_SIZE = 32;

/** Reads a `meta` file (an empty one is generation 0, nothing merging). */
export function readMeta(f: SyncFile): Meta {
  const b = new Uint8Array(META_SIZE);
  const n = f.read(b, { at: 0 });
  if (n < 8) return { generation: 0, merging: '' };
  const v = new DataView(b.buffer);
  const merging = new TextDecoder().decode(b.subarray(8, 8 + Math.min(24, Math.max(0, n - 8)))).replace(/\0+$/, '');
  return { generation: Number(v.getBigUint64(0, true)), merging };
}

/** Writes a `meta` file, durably (flushed). False on a failed write. */
export function writeMeta(f: SyncFile, m: Meta) {
  const b = new Uint8Array(META_SIZE);
  new DataView(b.buffer).setBigUint64(0, BigInt(m.generation), true);
  b.set(new TextEncoder().encode(m.merging).subarray(0, 24), 8);
  if (f.write(b, { at: 0 }) !== META_SIZE) return false;
  f.flush();
  return true;
}

/**
 * The overlay over `base` in `data` and `mapFile`. With `meta`, its generation is bumped before the first change
 * (a write, a discard or a zeroing) this opening makes; `generation()` says it. `epoch()` makes the next change bump it
 * again: a snapshot pins the generation it saw, so a change after it must move it (web/snapshot.ts).
 */
export function overlay(base: Disk, data: SyncFile, mapFile: SyncFile, meta?: SyncFile): WritableDisk & { generation(): number; epoch(): void } {
  const blocks = Math.ceil(base.size / BLOCK);
  const map = new Uint32Array(blocks);
  mapFile.read(new Uint8Array(map.buffer, 0, Math.min(mapFile.getSize(), blocks * 4)), { at: 0 }); // the host is little-endian, as the file
  let slots = Math.floor(data.getSize() / BLOCK);
  const blockLen = (b: number) => Math.min(BLOCK, base.size - b * BLOCK);

  // The slots no block maps. `free` may also hold slots that were cut off or taken since: `isFree` decides.
  const isFree = new Set<number>();
  const free: number[] = [];
  const release = (slot: number) => { isFree.add(slot); free.push(slot); };
  const take = () => {
    for (let s = free.pop(); s !== undefined; s = free.pop()) if (isFree.delete(s)) return s;
    return slots++;
  };
  /** Cuts the free slots off the end of `data`. */
  const shrink = () => {
    const was = slots;
    while (slots > 0 && isFree.delete(slots - 1)) slots--;
    if (slots < was || data.getSize() > slots * BLOCK) data.truncate(slots * BLOCK);
  };
  /**
   * Once half of `data` is free slots, the blocks in its highest slots move into the free ones
   * below them and the end is cut off: what the guest trimmed goes back to the browser's storage
   * (the moves are at most as many as the slots freed since the last time). A block is copied
   * before its map entry points to the copy. False on a failed read or write.
   */
  const compact = () => {
    shrink();
    if (isFree.size < COMPACT_MIN || isFree.size * 2 < slots) return true;
    const owner = new Uint32Array(slots);
    for (let b = 0; b < blocks; b++) if (map[b] && map[b] !== ZERO) owner[map[b] - 1] = b;
    const buf = new Uint8Array(BLOCK);
    let top = slots - 1;
    for (const hole of [...isFree].sort((x, y) => x - y)) {
      while (top > hole && isFree.has(top)) top--;
      if (top <= hole) break;
      const b = owner[top];
      if (data.read(buf, { at: top * BLOCK }) !== BLOCK || data.write(buf, { at: hole * BLOCK }) !== BLOCK) return false;
      map[b] = hole + 1;
      if (mapFile.write(new Uint8Array(map.buffer, b * 4, 4), { at: b * 4 }) !== 4) return false;
      isFree.delete(hole);
      isFree.add(top--);
    }
    shrink();
    free.length = 0;
    for (const s of isFree) free.push(s);
    return true;
  };
  {
    const used = new Uint8Array(slots);
    for (let b = 0; b < blocks; b++) if (map[b] && map[b] !== ZERO && map[b] <= slots) used[map[b] - 1] = 1;
    for (let s = slots - 1; s >= 0; s--) if (!used[s]) release(s); // the lowest are taken first
  }

  const held = (b: number) => map[b] !== 0 && map[b] !== ZERO;

  let gen = meta ? readMeta(meta) : { generation: 0, merging: '' };
  let bumped = false;
  /** Before the first change: the generation moves on, on disk, so a snapshot pinning the old one knows. */
  const bump = () => {
    if (bumped || !meta) return true;
    const next = { ...readMeta(meta), generation: gen.generation + 1 };
    if (!writeMeta(meta, next)) return false;
    gen = next;
    return (bumped = true);
  };

  const read = async (off: number, len: number) => {
    if (off < 0 || off + len > base.size) return undefined;
    const out = new Uint8Array(len);
    const stop = off + len;
    for (let pos = off; pos < stop;) {
      const b = Math.floor(pos / BLOCK);
      let end = Math.min((b + 1) * BLOCK, stop);
      if (map[b] === ZERO) {
        // `out` is zeros there already.
      } else if (map[b]) {
        // Blocks in consecutive slots are one read (an OPFS call costs the same whatever its size).
        for (let c = b; end < stop && held(c + 1) && map[c + 1] === map[c] + 1; c++) end = Math.min(end + BLOCK, stop);
        if (data.read(out.subarray(pos - off, end - off), { at: (map[b] - 1) * BLOCK + (pos - b * BLOCK) }) !== end - pos) return undefined;
      } else {
        // Runs of blocks that aren't in the overlay go to the base in one read.
        while (end < stop && !map[end / BLOCK]) end = Math.min(end + BLOCK, stop);
        const bytes = await base.read(pos, end - pos);
        if (!bytes) return undefined;
        out.set(bytes, pos - off);
      }
      pos = end;
    }
    return out;
  };

  /**
   * Writes in as few OPFS calls as it can (each costs ~0.3 ms whatever its size): blocks the overlay holds in
   * consecutive slots are one write, and whole blocks it doesn't hold get consecutive slots where `take` has
   * them and are written from `bytes` as they are, their map entries in one write after their data. Only the
   * (at most two) blocks a write covers in part are read-modify-write.
   */
  const write = async (off: number, bytes: Uint8Array) => {
    if (off < 0 || off + bytes.length > base.size) return false;
    if (bytes.length === 0) return true;
    if (!bump()) return false;
    const stop = off + bytes.length;
    const last = Math.floor((stop - 1) / BLOCK);
    const full = (b: number) => off <= b * BLOCK && stop >= (b + 1) * BLOCK; // all BLOCK bytes of block b are in the request
    for (let b = Math.floor(off / BLOCK); b <= last;) {
      const pos = Math.max(off, b * BLOCK);
      if (held(b)) {
        let c = b;
        while (c < last && held(c + 1) && map[c + 1] === map[c] + 1) c++;
        const end = Math.min(stop, (c + 1) * BLOCK);
        if (data.write(bytes.subarray(pos - off, end - off), { at: (map[b] - 1) * BLOCK + (pos - b * BLOCK) }) !== end - pos) return false;
        b = c + 1;
      } else if (!full(b)) {
        // First write to a block it covers in part: its slot starts as the base's contents (or as the zeros it was).
        const block = new Uint8Array(BLOCK);
        if (!map[b]) {
          const old = await base.read(b * BLOCK, blockLen(b));
          if (!old) return false;
          block.set(old);
        }
        const end = Math.min(stop, (b + 1) * BLOCK);
        block.set(bytes.subarray(pos - off, end - off), pos - b * BLOCK);
        const slot = take();
        if (data.write(block, { at: slot * BLOCK }) !== BLOCK) { release(slot); shrink(); return false; }
        map[b] = slot + 1;
        if (mapFile.write(new Uint8Array(map.buffer, b * 4, 4), { at: b * 4 }) !== 4) return false;
        b++;
      } else {
        // A run of whole blocks the overlay doesn't hold.
        let c = b;
        while (c < last && !held(c + 1) && full(c + 1)) c++;
        const taken: number[] = [];
        for (let k = b; k <= c; k++) taken.push(take());
        for (let i = 0; i < taken.length;) {
          let j = i;
          while (j + 1 < taken.length && taken[j + 1] === taken[j] + 1) j++;
          const [from, to] = [(b + i) * BLOCK - off, (b + j + 1) * BLOCK - off];
          if (data.write(bytes.subarray(from, to), { at: taken[i] * BLOCK }) !== to - from) {
            for (const s of taken.slice(i)) release(s);
            shrink();
            return false;
          }
          for (let k = i; k <= j; k++) map[b + k] = taken[k] + 1;
          if (mapFile.write(new Uint8Array(map.buffer, (b + i) * 4, (j - i + 1) * 4), { at: (b + i) * 4 }) !== (j - i + 1) * 4) return false;
          i = j + 1;
        }
        b = c + 1;
      }
    }
    return true;
  };

  /** The whole blocks of [off, off + len) (the disk's last block is whole when the range ends with the disk). */
  const whole = (off: number, len: number) => [Math.ceil(off / BLOCK), off + len === base.size ? blocks : Math.floor((off + len) / BLOCK)];
  /** Blocks [first, end) become zeros without slots (`held`: only those the overlay holds); the map goes to its file first. */
  const unmap = (first: number, end: number, held: boolean) => {
    if (end <= first) return true;
    const slotsBack: number[] = [];
    for (let b = first; b < end; b++) {
      if (held && !map[b]) continue;
      if (map[b] && map[b] !== ZERO) slotsBack.push(map[b] - 1);
      map[b] = ZERO;
    }
    if (mapFile.write(new Uint8Array(map.buffer, first * 4, (end - first) * 4), { at: first * 4 }) !== (end - first) * 4) return false;
    for (const s of slotsBack) release(s);
    return compact();
  };
  const inside = (off: number, len: number) => off >= 0 && len >= 0 && off + len <= base.size;
  const discard = (off: number, len: number) => {
    if (!inside(off, len) || !bump()) return false;
    const [first, end] = whole(off, len);
    return unmap(first, end, true);
  };
  const zero = async (off: number, len: number) => {
    if (!inside(off, len) || !bump()) return false;
    const [first, end] = whole(off, len);
    if (end <= first) return write(off, new Uint8Array(len));
    const tail = off + len - end * BLOCK; // none when the range ends with the disk
    return (await write(off, new Uint8Array(first * BLOCK - off))) && unmap(first, end, false) && (tail <= 0 || (await write(end * BLOCK, new Uint8Array(tail))));
  };

  const written = () => {
    const out: number[] = [];
    for (let b = 0; b < blocks; b++) if (map[b]) out.push(b);
    return out;
  };

  const block = (b: number) => {
    if (!map[b]) return undefined;
    const out = new Uint8Array(BLOCK);
    if (map[b] === ZERO) return out;
    return data.read(out, { at: (map[b] - 1) * BLOCK }) === BLOCK ? out : undefined;
  };

  return { size: base.size, format: base.format, read, write, discard, zero, written, block, zeroed: (b) => map[b] === ZERO, flush: () => { data.flush(); mapFile.flush(); }, generation: () => gen.generation, epoch: () => { bumped = false; } };
}

/**
 * An overlay's OPFS files, open: sync access handles (so the backend stays
 * synchronous), which lock the files, under the overlay's Web Lock. `close`
 * closes the handles, then releases the lock.
 */
export type OverlayFiles = { data: SyncFile; map: SyncFile; meta: SyncFile; close(): void };

/** A {@link SyncFile} in memory (its capacity doubles as it grows). */
export function memFile(): SyncFile & { bytes: () => Uint8Array } {
  let b = new Uint8Array(0);
  let size = 0;
  return {
    read: (buf, { at }) => { const n = Math.max(0, Math.min(buf.length, size - at)); buf.set(b.subarray(at, at + n)); return n; },
    write: (buf, { at }) => {
      if (at + buf.length > b.length) { const g = new Uint8Array(Math.max(at + buf.length, 2 * b.length)); g.set(b); b = g; }
      b.set(buf, at);
      size = Math.max(size, at + buf.length);
      return buf.length;
    },
    getSize: () => size,
    truncate: (n) => { if (n > b.length) { const g = new Uint8Array(n); g.set(b); b = g; } else b.fill(0, n, size); size = n; },
    flush: () => {},
    bytes: () => b.subarray(0, size),
  };
}

/**
 * The OPFS directory at `path` (`/`-separated: `overlays/<id>`, or a single name), made with its
 * parents when `create`; a missing one throws NotFoundError.
 */
export async function opfsDir(path: string, create = false): Promise<FileSystemDirectoryHandle> {
  let d = await navigator.storage.getDirectory();
  for (const p of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(p, { create });
  return d;
}

/** Node has no OPFS: there an overlay lives in memory for the process's life (tests), by name. */
const inMemory = new Map<string, { data: SyncFile; map: SyncFile; meta: SyncFile; base: string }>();

type LockMode = 'exclusive' | 'shared';

/** How long an opener waits for the overlay's previous holder (another machine, closing or in another tab). */
export const OVERLAY_WAIT_MS = 10_000;

/**
 * Takes the Web Lock `webpc-overlay:<name>` (exclusive, per origin: every tab
 * and worker), which whoever opens the overlay's files holds until they're
 * closed; resolves to its release. A context that ends (a terminated worker, a
 * closed tab) drops its locks with its files. Waits up to `ms` for the
 * previous holder, then rejects with "overlay <name> is in use".
 */
export async function lockOverlay(name: string, ms = OVERLAY_WAIT_MS, mode: LockMode = 'exclusive'): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    await new Promise<void>((granted, reject) => {
      navigator.locks.request(`webpc-overlay:${name}`, { mode, signal: AbortSignal.timeout(ms) }, () => {
        granted();
        return held;
      }).catch(reject);
    });
  } catch (e) {
    if ((e as DOMException).name !== 'TimeoutError') throw e;
    throw new Error(`overlay ${name} is in use: another machine held it for ${ms / 1000} s`);
  }
  return release;
}

/**
 * Opens (or creates) the overlay directory `name` for the image identified by `want`,
 * once its previous holder has closed it (`lockOverlay`: the hand-over between
 * machines, docs/frontend.md "Overlay hand-over"). Its `base` file records the
 * image's identity `want` (`diskIdentity` in web/devices.ts: a URL's path and the size, or a chosen file's name, size and modification time): an overlay only makes sense over the bytes it was
 * written against, so a mismatch is an error (`want` undefined: not checked, as a merge does). `readOnly`: an
 * existing directory, opened with read-only handles under a shared lock (several readers: a stored disk under
 * its machines' overlays, docs/machines.md §4.4; a writer waits for them all). Dedicated workers only
 * (sync access handles).
 */
// ponytail: the image is identified by path (or file name) and size, not content; add a hash if images get replaced in place.
export async function openOverlay(name: string, want: string | undefined, waitMs = OVERLAY_WAIT_MS, opts: { readOnly?: boolean } = {}): Promise<OverlayFiles> {
  const release = await lockOverlay(name, waitMs, opts.readOnly ? 'shared' : 'exclusive');
  const handles: FileSystemSyncAccessHandle[] = [];
  const done = () => {
    for (const h of handles) h.close();
    release();
  };
  try {
    if (typeof navigator.storage === 'undefined') {
      if (opts.readOnly && !inMemory.has(name)) throw new DOMException(`no overlay ${name}`, 'NotFoundError');
      const o = inMemory.get(name) ?? { data: memFile(), map: memFile(), meta: memFile(), base: want ?? '' };
      if (o.base === '' && want !== undefined && !opts.readOnly) o.base = want;
      if (want !== undefined && o.base !== want) throw new Error(`overlay ${name} belongs to ${o.base}, not ${want}`);
      inMemory.set(name, o);
      return { data: o.data, map: o.map, meta: o.meta, close: done };
    }
    const dir = await opfsDir(name, !opts.readOnly);
    const open = async (f: string) => {
      // Read-only handles may be open in several workers at once (machines reading a stored disk under their overlays).
      const file = await dir.getFileHandle(f, { create: !opts.readOnly });
      const h = await (opts.readOnly ? (file.createSyncAccessHandle as (o: object) => Promise<FileSystemSyncAccessHandle>).call(file, { mode: 'read-only' }) : file.createSyncAccessHandle());
      handles.push(h);
      return h;
    };
    const [data, map, meta, base] = [await open('data'), await open('map'), await open('meta'), await open('base')];
    if (base.getSize() === 0 && want !== undefined && !opts.readOnly) {
      base.write(new TextEncoder().encode(want), { at: 0 });
      base.flush();
    }
    const bytes = new Uint8Array(base.getSize());
    base.read(bytes, { at: 0 });
    const got = new TextDecoder().decode(bytes);
    if (want !== undefined && got !== want) throw new Error(`overlay ${name} belongs to ${got}, not ${want}`);
    base.close();
    handles.pop();
    return { data, map, meta, close: done };
  } catch (e) {
    done();
    throw e;
  }
}

/**
 * Deletes the OPFS overlay `name` (M8's "reset disk"): the disk goes back to
 * the image's bytes. Waits for a machine that has it open to close it
 * (`lockOverlay`), or fails as it does. A missing overlay is not an error.
 * Works on a page or in a worker.
 */
export async function removeOverlay(name: string) {
  const release = await lockOverlay(name); // after the machine that had it closed it
  try {
    if (typeof navigator.storage === 'undefined') {
      inMemory.delete(name);
      inMemoryFlash.delete(name);
      inMemoryFiles.delete(`${name}/${SUSPEND}`);
      return;
    }
    const parts = name.split('/');
    await (await opfsDir(parts.slice(0, -1).join('/'))).removeEntry(parts.at(-1)!, { recursive: true });
  } catch (e) {
    if ((e as DOMException).name !== 'NotFoundError') throw e;
  } finally {
    release();
  }
}

/** Node has no OPFS: files written by `fileWriter` (suspended machines) live in memory there, by path. */
const inMemoryFiles = new Map<string, Uint8Array[]>();
const SUSPEND = 'suspend';

/**
 * A suspended machine (docs/frontend.md "Suspend"): its snapshot without the overlays' blocks (they stay in OPFS), in
 * the `suspend` file of the machine's directory `name` (a stored machine's `machines/<id>`, a transient one's overlay).
 * It pins each overlay's generation (docs/machines.md §5.3): a start resumes it only while every pin matches, and
 * drops it (`dropSuspend`) before the machine runs, resumed or booted. This writes it (`fileWriter`).
 */
export const suspendWriter = (name: string) => fileWriter(`${name}/${SUSPEND}`);

/**
 * Writes the OPFS file at `path` (made with its directories; a kept snapshot's, a suspended machine's): a sink for the
 * bytes, in order, then `close` (a file that never got there has no end marker, and a snapshot's is refused as
 * truncated) or `abort` (the file is removed). Dedicated workers only in a browser (a sync access handle).
 */
export async function fileWriter(path: string): Promise<{ write(bytes: Uint8Array): void; close(): void; abort(): Promise<void> }> {
  if (typeof navigator.storage === 'undefined') {
    const parts: Uint8Array[] = [];
    inMemoryFiles.delete(path);
    return { write: (b) => { parts.push(b.slice()); }, close: () => { inMemoryFiles.set(path, parts); }, abort: async () => { inMemoryFiles.delete(path); } };
  }
  const parts = path.split('/');
  const file = parts.pop()!;
  const dir = await opfsDir(parts.join('/'), true);
  const h = await (await dir.getFileHandle(file, { create: true })).createSyncAccessHandle();
  h.truncate(0);
  let at = 0;
  return {
    write(b) {
      if (h.write(b, { at }) !== b.length) throw new Error("the browser's storage is full");
      at += b.length;
    },
    close() {
      h.flush();
      h.close();
    },
    async abort() {
      h.close();
      await dir.removeEntry(file).catch(() => {});
    },
  };
}

/** The suspended machine kept beside overlay `name`, if there is one. */
export async function suspended(name: string): Promise<Blob | undefined> {
  if (typeof navigator.storage === 'undefined') {
    const parts = inMemoryFiles.get(`${name}/${SUSPEND}`);
    return parts && new Blob(parts as BlobPart[]);
  }
  try {
    const dir = await opfsDir(name);
    const file = await (await dir.getFileHandle(SUSPEND)).getFile();
    return file.size ? file : undefined;
  } catch (e) {
    if ((e as DOMException).name !== 'NotFoundError') throw e;
    return undefined;
  }
}

/** Drops the suspended machine beside overlay `name` (none is fine): before a machine runs on the overlay. */
export async function dropSuspend(name: string) {
  if (typeof navigator.storage === 'undefined') return void inMemoryFiles.delete(`${name}/${SUSPEND}`);
  try {
    const dir = await opfsDir(name);
    await dir.removeEntry(SUSPEND);
  } catch (e) {
    if ((e as DOMException).name !== 'NotFoundError') throw e;
  }
}

/** Overlay `name`'s meta (generation, merging), read from a page or a worker without opening it; zeros without one. */
export async function overlayMeta(name: string): Promise<Meta> {
  if (typeof navigator.storage === 'undefined') {
    const o = inMemory.get(name);
    return o ? readMeta(o.meta) : { generation: 0, merging: '' };
  }
  try {
    const file = await (await (await opfsDir(name)).getFileHandle('meta')).getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    return readMeta({ read: (buf, { at }) => { const n = Math.max(0, Math.min(buf.length, bytes.length - at)); buf.set(bytes.subarray(at, at + n)); return n; }, write: () => 0, getSize: () => bytes.length, truncate() {}, flush() {} });
  } catch (e) {
    if ((e as DOMException).name !== 'NotFoundError') throw e;
    return { generation: 0, merging: '' };
  }
}

/** Bytes the overlay `name` holds on OPFS (its written blocks and map), or 0 without one. */
export async function overlayBytes(name: string) {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await opfsDir(name);
  } catch {
    return 0;
  }
  let n = 0;
  for (const f of ['data', 'map']) n += await dir.getFileHandle(f).then((h) => h.getFile()).then((file) => file.size, () => 0);
  return n;
}

/** Node has no OPFS: the firmware's variable stores live in memory there, by overlay name. */
const inMemoryFlash = new Map<string, Uint8Array>();

/**
 * The firmware's variable store (the flash bank, `VmConfig.firmware`) saved beside overlay `name`,
 * in a file of its directory: it belongs to the disk the overlay makes writable, and goes with it
 * when the disk is reset (`removeOverlay`). Undefined when none was saved. No lock: one machine
 * at a time runs on the overlay (`lockOverlay`), and it is that machine's worker that saves.
 */
export async function loadFlash(name: string): Promise<Uint8Array | undefined> {
  if (typeof navigator.storage === 'undefined') return inMemoryFlash.get(name);
  try {
    const dir = await opfsDir(name);
    const bytes = new Uint8Array(await (await (await dir.getFileHandle('flash')).getFile()).arrayBuffer());
    return bytes.length ? bytes : undefined;
  } catch (e) {
    if ((e as DOMException).name !== 'NotFoundError') throw e;
    return undefined;
  }
}

/** Saves the variable store beside overlay `name` (a dedicated worker: sync access handle, which is exclusive). */
export async function saveFlash(name: string, bytes: Uint8Array) {
  if (typeof navigator.storage === 'undefined') {
    inMemoryFlash.set(name, bytes.slice());
    return;
  }
  const dir = await opfsDir(name, true);
  const h = await (await dir.getFileHandle('flash', { create: true })).createSyncAccessHandle();
  try {
    h.truncate(0);
    h.write(bytes, { at: 0 });
    h.flush();
  } finally {
    h.close();
  }
}
