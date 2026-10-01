// Copy-on-write overlay over a read-only disk (M4 step 5), in 4 KiB blocks. The
// browser keeps it on OPFS (web/devices.ts opens the files in the device
// worker, with synchronous access handles): `data` holds the written blocks in
// the order they were first written, `map` one little-endian u32 per disk block
// (0: not written; n: slot n - 1 of `data`). A block is written to its slot
// before its map entry, so a crash can leak a slot but never map a block to
// garbage. core/tests/common's `Overlay` is the native (in-memory) equivalent.
import type { Disk } from './qcow2.ts';

/** The part of `FileSystemSyncAccessHandle` the overlay uses. */
export type SyncFile = {
  read(buf: Uint8Array, o: { at: number }): number;
  write(buf: Uint8Array, o: { at: number }): number;
  getSize(): number;
  flush(): void;
};

const BLOCK = 4096;

export type WritableDisk = Disk & {
  /** Writes `bytes` at `off` (inside the disk); false on a failed write. */
  write(off: number, bytes: Uint8Array): Promise<boolean>;
  flush(): void;
};

export function overlay(base: Disk, data: SyncFile, mapFile: SyncFile): WritableDisk {
  const blocks = Math.ceil(base.size / BLOCK);
  const map = new Uint32Array(blocks);
  mapFile.read(new Uint8Array(map.buffer, 0, Math.min(mapFile.getSize(), blocks * 4)), { at: 0 }); // the host is little-endian, as the file
  let slots = Math.floor(data.getSize() / BLOCK);
  const blockLen = (b: number) => Math.min(BLOCK, base.size - b * BLOCK);

  const read = async (off: number, len: number) => {
    if (off < 0 || off + len > base.size) return undefined;
    const out = new Uint8Array(len);
    // Runs of blocks that aren't in the overlay go to the base in one read.
    for (let pos = off; pos < off + len;) {
      const b = Math.floor(pos / BLOCK);
      let end = Math.min((b + 1) * BLOCK, off + len);
      if (map[b]) {
        const n = end - pos;
        if (data.read(out.subarray(pos - off, pos - off + n), { at: (map[b] - 1) * BLOCK + (pos - b * BLOCK) }) !== n) return undefined;
      } else {
        while (end < off + len && !map[end / BLOCK]) end = Math.min(end + BLOCK, off + len);
        const bytes = await base.read(pos, end - pos);
        if (!bytes) return undefined;
        out.set(bytes, pos - off);
      }
      pos = end;
    }
    return out;
  };

  const write = async (off: number, bytes: Uint8Array) => {
    if (off < 0 || off + bytes.length > base.size) return false;
    for (let k = 0; k < bytes.length;) {
      const pos = off + k;
      const b = Math.floor(pos / BLOCK);
      const o = pos - b * BLOCK;
      const n = Math.min(blockLen(b) - o, bytes.length - k);
      if (!map[b]) {
        // First write to the block: its slot starts as the base's contents.
        const block = new Uint8Array(BLOCK);
        if (n < blockLen(b)) {
          const old = await base.read(b * BLOCK, blockLen(b));
          if (!old) return false;
          block.set(old);
        }
        block.set(bytes.subarray(k, k + n), o);
        if (data.write(block, { at: slots * BLOCK }) !== BLOCK) return false;
        map[b] = ++slots;
        if (mapFile.write(new Uint8Array(map.buffer, b * 4, 4), { at: b * 4 }) !== 4) return false;
      } else if (data.write(bytes.subarray(k, k + n), { at: (map[b] - 1) * BLOCK + o }) !== n) {
        return false;
      }
      k += n;
    }
    return true;
  };

  return { size: base.size, format: base.format, read, write, flush: () => { data.flush(); mapFile.flush(); } };
}

/**
 * An overlay's OPFS files, open: sync access handles (so the backend stays
 * synchronous), which lock the files, under the overlay's Web Lock. `close`
 * closes the handles, then releases the lock.
 */
export type OverlayFiles = { data: SyncFile; map: SyncFile; close(): void };

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
    flush: () => {},
    bytes: () => b.subarray(0, size),
  };
}

/** Node has no OPFS: there an overlay lives in memory for the process's life (tests), by name. */
const inMemory = new Map<string, { data: SyncFile; map: SyncFile; base: string }>();

/** How long an opener waits for the overlay's previous holder (another machine, closing or in another tab). */
export const OVERLAY_WAIT_MS = 10_000;

/**
 * Takes the Web Lock `webpc-overlay:<name>` (exclusive, per origin: every tab
 * and worker), which whoever opens the overlay's files holds until they're
 * closed; resolves to its release. A context that ends (a terminated worker, a
 * closed tab) drops its locks with its files. Waits up to `ms` for the
 * previous holder, then rejects with "overlay <name> is in use".
 */
export async function lockOverlay(name: string, ms = OVERLAY_WAIT_MS): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    await new Promise<void>((granted, reject) => {
      navigator.locks.request(`webpc-overlay:${name}`, { signal: AbortSignal.timeout(ms) }, () => {
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
 * written against, so a mismatch is an error. Dedicated workers only (sync
 * access handles).
 */
// ponytail: the image is identified by path (or file name) and size, not content; add a hash if images get replaced in place.
export async function openOverlay(name: string, want: string, waitMs = OVERLAY_WAIT_MS): Promise<OverlayFiles> {
  const release = await lockOverlay(name, waitMs);
  const handles: FileSystemSyncAccessHandle[] = [];
  const done = () => {
    for (const h of handles) h.close();
    release();
  };
  try {
    if (typeof navigator.storage === 'undefined') {
      const o = inMemory.get(name) ?? { data: memFile(), map: memFile(), base: want };
      if (o.base !== want) throw new Error(`overlay ${name} belongs to ${o.base}, not ${want}`);
      inMemory.set(name, o);
      return { data: o.data, map: o.map, close: done };
    }
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
    const open = async (f: string) => {
      const h = await (await dir.getFileHandle(f, { create: true })).createSyncAccessHandle();
      handles.push(h);
      return h;
    };
    const [data, map, base] = [await open('data'), await open('map'), await open('base')];
    if (base.getSize() === 0) {
      base.write(new TextEncoder().encode(want), { at: 0 });
      base.flush();
    }
    const bytes = new Uint8Array(base.getSize());
    base.read(bytes, { at: 0 });
    const got = new TextDecoder().decode(bytes);
    if (got !== want) throw new Error(`overlay ${name} belongs to ${got}, not ${want}`);
    base.close();
    handles.pop();
    return { data, map, close: done };
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
    await (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true });
  } catch (e) {
    if ((e as DOMException).name !== 'NotFoundError') throw e;
  } finally {
    release();
  }
}

/** Bytes the overlay `name` holds on OPFS (its written blocks and map), or 0 without one. */
export async function overlayBytes(name: string) {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
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
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
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
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
  const h = await (await dir.getFileHandle('flash', { create: true })).createSyncAccessHandle();
  try {
    h.truncate(0);
    h.write(bytes, { at: 0 });
    h.flush();
  } finally {
    h.close();
  }
}
