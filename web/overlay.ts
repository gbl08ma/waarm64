// Copy-on-write overlay over a read-only disk (M4 step 5), in 4 KiB blocks. The
// browser keeps it on OPFS (web/devices.ts opens the files in the device
// worker, with synchronous access handles): `data` holds the written blocks in
// the order they were first written, `map` a u32 entry per disk block (0: not
// written; n: slot n - 1 of `data`; 0xffffffff: zeros, without a slot: a block
// the guest discarded or zeroed) in two levels: leaves of 1,024 entries (4 MiB of
// disk), made at the first write into their range and appended to the file, each
// its entries then its range (its top entry), so the map grows with what is
// written, not with the disk's size; the top table (range -> leaf) is rebuilt in
// memory at opening (`readMap`). A flat map (one entry per block, from before
// leaves) is read as it is and converted at the first change (`convert`). A block
// is written to its slot before its map entry, so a crash can leak a slot but never
// map a block to garbage. Slots that no block maps (a discarded block's, a leaked
// one) are found when the overlay is opened and taken by the next first writes;
// free slots at the end of `data` are cut off, and once half of it is free the rest
// is moved down (`compact`). `meta` holds the overlay's generation (docs/machines.md §3.3):
// bumped, durably, before the first change of each opening, so "the overlay is as it was at
// generation g" is a comparison of two integers. core/tests/common's `Overlay` is the native
// (in-memory) equivalent (without discard or a generation).
import { MsgError } from './msg.ts';
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
/** Map entries in a leaf: a leaf covers 4 MiB of disk (a range). */
const LEAF = 1024;
/** A leaf's record in the map file, in u32s: its entries, its range + 1 (its top entry), 0. */
const REC = LEAF + 2;
const REC_BYTES = REC * 4;
/** A two-level map file's header: `MAGIC`, `VERSION` (u32s), where its records start (u64). */
const HEAD = 16;
/** As a flat map's first entry, slot 0xfffffffd: a data file of 16 TiB, which no overlay has (`MAX_RESIZE`). */
const MAGIC = 0xfffffffe;
const VERSION = 2;
/** A flat map whose conversion was interrupted ends with `TRAILER`, 0 (u32s) and its length (u64). */
const TRAILER = 0xfffffffd;

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
  /**
   * Moves the blocks in the overlay's highest slots into its free ones and cuts its file's end off, however few are
   * free (a change does it only once half of them are: after a trim the page asked for, all that was freed goes back
   * to the browser's storage). False on a failed read or write. An overlay's; a ramdisk gives memory back by itself.
   */
  compact?(): boolean;
  /** The bytes the overlay's files take (its data and map). */
  bytes?(): number;
  /** The overlay's generation, and `epoch` (both: overlays with a `meta`; a ramdisk has neither). */
  generation?(): number;
  epoch?(): void;
};

/**
 * The numbers of this origin's storage, as `navigator.storage.estimate()` gives them (the Machines page's storage line
 * has them too): what it holds and what the browser gives it; undefined where the browser says nothing. Off the record,
 * and under a quota a test lowers, the browser refuses writes before `quota`: these are what it says, not the limit met.
 */
export async function storageNumbers(): Promise<{ used: number; quota: number } | undefined> {
  const est = await globalThis.navigator?.storage?.estimate?.().catch(() => undefined);
  return est?.quota ? { used: est.usage ?? 0, quota: est.quota } : undefined;
}

/** The cause of a write the browser's storage refused (docs/machines.md "Storage"): it's full, with its numbers where the browser gives them. */
export async function storageFullError(): Promise<MsgError> {
  const n = await storageNumbers();
  return n ? new MsgError('disks:overlay.storageFull.numbers', { used: n.used, quota: n.quota }) : new MsgError('disks:overlay.storageFull');
}

/**
 * Writes that make room when the storage refuses one (docs/machines.md "Storage"): `w` is tried, and refused, tried once
 * more after `makeRoom` (the remote disks' kept blocks: `makeRoom` in web/diskcache.ts) made some; once it makes none,
 * a refusal stands. Whether it landed. A write the overlay refused is safe to try again (its map is as it was).
 */
export function withRoom(makeRoom?: () => Promise<boolean>) {
  let room = !!makeRoom;
  return async (w: () => boolean | Promise<boolean>) => (await w()) || (room && (room = await makeRoom!().catch(() => false)) && (await w()));
}

/**
 * An overlay's `meta` file: its generation (u64 LE at 0), for a stored disk the overlay being merged into it
 * (`merging`: its id, or empty; 24 bytes at 8), and the overlay's own size (`size`, u64 LE at 32: a grown overlay's,
 * docs/machines.md §4.5; 0 for none: the base's). A meta of 32 bytes, from before sizes, has none.
 */
export type Meta = { generation: number; merging: string; size: number };
const META_SIZE = 40;
/** A meta file's bytes (`writeMeta`'s). */
export function encodeMeta(m: Meta) {
  const b = new Uint8Array(META_SIZE);
  const v = new DataView(b.buffer);
  v.setBigUint64(0, BigInt(m.generation), true);
  b.set(new TextEncoder().encode(m.merging).subarray(0, 24), 8);
  v.setBigUint64(32, BigInt(m.size), true);
  return b;
}

/**
 * The size a disk opened over `base` has: its own `size` where that is larger. Past `base`'s end it reads as zeros (an
 * overlay grown past its base, docs/machines.md §4.5); `base` itself where it isn't larger.
 */
export function grown(base: Disk, size: number): Disk {
  if (size <= base.size) return base;
  return {
    size,
    format: base.format,
    read: async (off, len) => {
      if (off < 0 || len < 0 || off + len > size) return undefined;
      if (off + len <= base.size) return base.read(off, len);
      const out = new Uint8Array(len);
      if (off < base.size) {
        const head = await base.read(off, base.size - off);
        if (!head) return undefined;
        out.set(head);
      }
      return out;
    },
  };
}

/**
 * `f` with a write the storage refuses as a short count, as the overlay checks for: Chromium's sync handles come back
 * short past the quota in some contexts and throw `QuotaExceededError` in others. A thrown write would leave the slots
 * it took neither mapped nor free, and a later compaction would move them as block 0's (tests/overlay.test.ts).
 */
export function shortOnFull(f: SyncFile): SyncFile {
  return {
    read: (buf, o) => f.read(buf, o),
    write: (buf, o) => {
      try {
        return f.write(buf, o);
      } catch (e) {
        if ((e as DOMException)?.name === 'QuotaExceededError') return 0;
        throw e;
      }
    },
    getSize: () => f.getSize(),
    truncate: (size) => f.truncate(size),
    flush: () => f.flush(),
  };
}

/** Reads a `meta` file (an empty one is generation 0, nothing merging, no size of its own). */
export function readMeta(f: SyncFile): Meta {
  const b = new Uint8Array(META_SIZE);
  const n = f.read(b, { at: 0 });
  if (n < 8) return { generation: 0, merging: '', size: 0 };
  const v = new DataView(b.buffer);
  const merging = new TextDecoder().decode(b.subarray(8, 8 + Math.min(24, Math.max(0, n - 8)))).replace(/\0+$/, '');
  return { generation: Number(v.getBigUint64(0, true)), merging, size: n >= META_SIZE ? Number(v.getBigUint64(32, true)) : 0 };
}

/** Writes a `meta` file, durably (flushed). False on a failed write. */
export function writeMeta(f: SyncFile, m: Meta) {
  if (f.write(encodeMeta(m), { at: 0 }) !== META_SIZE) return false;
  f.flush();
  return true;
}

/** A {@link SyncFile} that reads `bytes` (and writes nothing). */
const bytesFile = (bytes: Uint8Array): SyncFile => ({
  read: (buf, { at }) => {
    const n = Math.max(0, Math.min(buf.length, bytes.length - at));
    buf.set(bytes.subarray(at, at + n));
    return n;
  },
  write: () => 0,
  getSize: () => bytes.length,
  truncate() {},
  flush() {},
});

/**
 * A map read from its file, in either format, as its leaves: what the overlay and a stored disk's reader
 * (web/stored.ts `blockSource`) keep in memory.
 */
export type MapLeaves = {
  /** By range (`LEAF` blocks, 4 MiB of disk, up to the disk's end): its leaf's record + 1, or 0 (none: nothing there is written). */
  top: Uint32Array;
  /** The leaves' records, `REC` u32s each (as the map file has them: entries, range + 1, 0), `n` of them. */
  recs: Uint32Array;
  n: number;
  /** Where the records start in the map file; undefined: a flat map, `flat` bytes long, not converted yet. */
  at?: number;
  flat: number;
};

/** `recs` with room for `count` u32s (doubling). */
function room(recs: Uint32Array, used: number, count: number): Uint32Array {
  if (count <= recs.length) return recs;
  const g = new Uint32Array(Math.max(count, 2 * recs.length, 16 * REC));
  g.set(recs.subarray(0, used));
  return g;
}

/**
 * Reads map file `f` for a disk of `blocks` blocks. A two-level map (its header) is its records, read whole; a flat
 * one (from before leaves) becomes leaves in memory for the ranges where an entry isn't 0 (read 1 MiB at a time),
 * the file untouched: an opening that only reads (a stored disk under its machines' overlays) never converts it. A
 * flat map with an interrupted conversion's records after it (the trailer says the flat map's length) is that length.
 * Leaves for ranges past `blocks` (an opening at a smaller size) are kept, outside `top`.
 */
export function readMap(f: SyncFile, blocks: number): MapLeaves {
  const ranges = Math.ceil(blocks / LEAF);
  const top = new Uint32Array(ranges);
  const size = f.getSize();
  const head = new DataView(new ArrayBuffer(HEAD));
  if (size >= HEAD && f.read(new Uint8Array(head.buffer), { at: 0 }) === HEAD && head.getUint32(0, true) === MAGIC && head.getUint32(4, true) === VERSION) {
    const at = Number(head.getBigUint64(8, true));
    const n = Math.max(0, Math.floor((size - at) / REC_BYTES)); // a record the file doesn't hold whole was never added
    const recs = new Uint32Array(n * REC);
    if (n && f.read(new Uint8Array(recs.buffer), { at }) !== n * REC_BYTES) recs.fill(0);
    for (let k = 0; k < n; k++) {
      const r = recs[k * REC + LEAF] - 1;
      if (r >= 0 && r < ranges && !top[r]) top[r] = k + 1;
    }
    return { top, recs, n, at, flat: 0 };
  }
  let flat = size;
  if (size >= 2 * HEAD) {
    const t = new DataView(new ArrayBuffer(HEAD));
    f.read(new Uint8Array(t.buffer), { at: size - HEAD });
    const len = Number(t.getBigUint64(8, true));
    if (t.getUint32(0, true) === TRAILER && t.getUint32(4, true) === 0 && len + HEAD <= size) flat = len;
  }
  let recs: Uint32Array = new Uint32Array(0);
  let n = 0;
  const chunk = new Uint32Array(256 * LEAF);
  for (let e = 0; e * 4 < flat; e += chunk.length) {
    chunk.fill(0);
    f.read(new Uint8Array(chunk.buffer, 0, Math.min(chunk.length * 4, flat - e * 4)), { at: e * 4 });
    for (let i = 0; i < chunk.length; i += LEAF) {
      const leaf = chunk.subarray(i, i + LEAF);
      if (leaf.every((x) => x === 0)) continue;
      const r = (e + i) / LEAF;
      recs = room(recs, n * REC, (n + 1) * REC);
      recs.set(leaf, n * REC);
      recs[n * REC + LEAF] = r + 1;
      if (r < ranges) top[r] = n + 1;
      n++;
    }
  }
  return { top, recs, n, flat };
}

/** Block `b`'s map entry in `m` (0: not written; n: slot n - 1; `ZERO`). */
export const mapEntry = (m: MapLeaves, b: number) => {
  const t = m.top[Math.floor(b / LEAF)];
  return t ? m.recs[(t - 1) * REC + (b % LEAF)] : 0;
};

/**
 * The overlay over `base` in `data` and `mapFile`. With `meta`, its generation is bumped before the first change
 * (a write, a discard or a zeroing) this opening makes; `generation()` says it. `epoch()` makes the next change bump it
 * again: a snapshot pins the generation it saw, so a change after it must move it (web/snapshot.ts). Its size is the
 * largest of `base`'s, its meta's own (a grown overlay's, docs/machines.md §4.5) and `size` (the guest's, as the page
 * gave it): past `base`'s end it reads as zeros until written, and its map grows as blocks there are. A flat map
 * (from before leaves) is converted at the first change (`convert`); until then it is read as it is.
 */
export function overlay(base: Disk, data: SyncFile, mapFile: SyncFile, meta?: SyncFile, size = 0): WritableDisk & { generation(): number; epoch(): void } {
  [data, mapFile, meta] = [shortOnFull(data), shortOnFull(mapFile), meta && shortOnFull(meta)];
  base = grown(base, Math.max(size, meta ? readMeta(meta).size : 0));
  const blocks = Math.ceil(base.size / BLOCK);
  const loaded = readMap(mapFile, blocks);
  const { top } = loaded;
  let { recs, n, at } = loaded;
  let slots = Math.floor(data.getSize() / BLOCK);
  const blockLen = (b: number) => Math.min(BLOCK, base.size - b * BLOCK);
  /** Block `b`'s map entry (0: not written; n: slot n - 1; `ZERO`). */
  const ent = (b: number) => {
    const t = top[Math.floor(b / LEAF)];
    return t ? recs[(t - 1) * REC + (b % LEAF)] : 0;
  };

  /**
   * Writes the leaves' entries recs[p, p + count) to the map file (`recs` has them already; they're inside one leaf
   * the file holds, so the write needs no room); `old` is what they were. A write refused all the same may have landed
   * in part, a torn entry too: `old` is written back and `recs` takes it again, so the file and memory still agree.
   * False then.
   */
  const putMap = (p: number, count: number, old: Uint32Array) => {
    const off = at! + p * 4;
    if (mapFile.write(new Uint8Array(recs.buffer, p * 4, count * 4), { at: off }) === count * 4) return true;
    recs.set(old, p);
    mapFile.write(new Uint8Array(old.buffer, old.byteOffset, old.byteLength), { at: off });
    return false;
  };
  /**
   * New leaves for ranges `rs` (ascending or not), entries `fill(k)` of the k-th, appended to the map file in one write.
   * A record is its entries, then its top entry (range + 1) after them, so a write that lands in part holds no
   * leaf whole: the opening counts only whole records. A leaf's entries map only blocks whose slots are written
   * already, or `ZERO`. Refused: the file is cut back to where it ended, and there are no new leaves.
   */
  const addLeaves = (rs: number[], fill: (k: number, entries: Uint32Array) => void) => {
    const end = at! + n * REC_BYTES;
    recs = room(recs, n * REC, (n + rs.length) * REC);
    const p = n * REC;
    rs.forEach((r, k) => {
      const q = p + k * REC;
      recs.fill(0, q, q + REC);
      fill(k, recs.subarray(q, q + LEAF));
      recs[q + LEAF] = r + 1;
    });
    if (mapFile.write(new Uint8Array(recs.buffer, p * 4, rs.length * REC_BYTES), { at: end }) !== rs.length * REC_BYTES) {
      recs.fill(0, p, p + rs.length * REC);
      mapFile.truncate(end);
      return false;
    }
    rs.forEach((r) => { top[r] = ++n; });
    return true;
  };
  /**
   * Sets the map entries of blocks [b, e) (one leaf's) to `value(k, old)` (block b + k's), in memory and in the
   * file: an existing leaf's are written over (`putMap`; nothing when none changes), a range without a leaf gets
   * one (`addLeaves`; none when every entry stays 0). False when the storage refused it: memory and file as they were.
   */
  const setMap = (b: number, e: number, value: (k: number, old: number) => number) => {
    const r = Math.floor(b / LEAF);
    const i = b % LEAF;
    if (!top[r]) {
      const want = Uint32Array.from({ length: e - b }, (_, k) => value(k, 0));
      return want.every((x) => x === 0) || addLeaves([r], (_, entries) => entries.set(want, i));
    }
    const p = (top[r] - 1) * REC + i;
    const old = recs.slice(p, p + e - b);
    let changed = false;
    for (let k = 0; k < e - b; k++) {
      recs[p + k] = value(k, old[k]);
      changed ||= recs[p + k] !== old[k];
    }
    return !changed || putMap(p, e - b, old);
  };
  /** `setMap` for a write: blocks [b, e) (one leaf's) in consecutive slots, the first `slot1 - 1`. */
  const setRun = (b: number, e: number, slot1: number) => {
    const r = Math.floor(b / LEAF);
    const i = b % LEAF;
    if (!top[r]) return addLeaves([r], (_, entries) => { for (let k = 0; k < e - b; k++) entries[i + k] = slot1 + k; });
    const p = (top[r] - 1) * REC + i;
    const old = recs.slice(p, p + e - b);
    for (let k = 0; k < e - b; k++) recs[p + k] = slot1 + k;
    return putMap(p, e - b, old);
  };
  /** Writes the map file's header (its records at `to`); refused, the 16 bytes that were there are put back. */
  const writeHead = (to: number) => {
    const h = new DataView(new ArrayBuffer(HEAD));
    h.setUint32(0, MAGIC, true);
    h.setUint32(4, VERSION, true);
    h.setBigUint64(8, BigInt(to), true);
    const old = new Uint8Array(HEAD);
    mapFile.read(old, { at: 0 });
    if (mapFile.write(new Uint8Array(h.buffer), { at: 0 }) === HEAD) return true;
    mapFile.write(old, { at: 0 });
    return false;
  };
  /**
   * Before the first change: a flat map (from before leaves) becomes a two-level one, in its own file. A new map is
   * its header alone. Otherwise: a trailer goes after where the records will end (from then on, and until the
   * header, the file reads as the flat map of its old length: `readMap`), the records into the room before it, and
   * the header over the flat map's first entries is the switch (inside the file: it needs no room). Then, where the
   * records fit in the flat map's room, they're copied down and the header moved to them, and the file is cut after
   * them. Refused: the file is the flat map again (cut back), and the change that asked fails.
   */
  const convert = () => {
    if (at !== undefined) return true;
    const flat = loaded.flat;
    const undo = () => { mapFile.truncate(flat); return false; };
    if (mapFile.getSize() > flat) mapFile.truncate(flat); // what an interrupted conversion left
    if (n === 0) {
      // Nothing written (an empty file, or entries all 0): the header alone.
      mapFile.truncate(0);
      if (!writeHead(HEAD)) { mapFile.truncate(0); return false; }
      mapFile.flush();
      at = HEAD;
      return true;
    }
    const from = Math.max(HEAD, Math.ceil(flat / 8) * 8);
    const end = from + n * REC_BYTES;
    const t = new DataView(new ArrayBuffer(HEAD));
    t.setUint32(0, TRAILER, true);
    t.setBigUint64(8, BigInt(flat), true);
    if (mapFile.write(new Uint8Array(t.buffer), { at: end }) !== HEAD) return undo();
    const CHUNK = 256 * REC;
    for (let p = 0; p < n * REC; p += CHUNK) {
      const len = Math.min(CHUNK, n * REC - p) * 4;
      if (mapFile.write(new Uint8Array(recs.buffer, p * 4, len), { at: from + p * 4 }) !== len) return undo();
    }
    mapFile.flush();
    if (!writeHead(from)) return undo();
    mapFile.flush();
    at = from;
    mapFile.truncate(end);
    if (from > HEAD && n * REC_BYTES <= from - HEAD && mapFile.write(new Uint8Array(recs.buffer, 0, n * REC_BYTES), { at: HEAD }) === n * REC_BYTES) {
      mapFile.flush();
      if (writeHead(HEAD)) {
        mapFile.flush();
        at = HEAD;
        mapFile.truncate(HEAD + n * REC_BYTES);
      }
    }
    return true;
  };

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
   * (the moves are at most as many as the slots freed since the last time); with `force`, however
   * few are free. A block is copied before its map entry points to the copy. False on a failed read
   * or write.
   */
  const compact = (force = false) => {
    shrink();
    if (!force && (isFree.size < COMPACT_MIN || isFree.size * 2 < slots)) return true;
    if (!isFree.size) return true;
    if (!convert()) return false;
    // Each slot's entry, as its place in `recs` + 1: the leaves' entries, every leaf's.
    const owner = new Uint32Array(slots);
    for (let q = 0; q < n * REC; q += REC) {
      for (let i = q; i < q + LEAF; i++) if (recs[i] && recs[i] !== ZERO && recs[i] <= slots) owner[recs[i] - 1] = i + 1;
    }
    const buf = new Uint8Array(BLOCK);
    let hi = slots - 1;
    for (const hole of [...isFree].sort((x, y) => x - y)) {
      while (hi > hole && isFree.has(hi)) hi--;
      if (hi <= hole) break;
      const p = owner[hi] - 1;
      if (p < 0) return false; // a slot neither free nor a block's: none is
      if (data.read(buf, { at: hi * BLOCK }) !== BLOCK || data.write(buf, { at: hole * BLOCK }) !== BLOCK) return false;
      const old = recs.slice(p, p + 1);
      recs[p] = hole + 1;
      if (!putMap(p, 1, old)) return false;
      isFree.delete(hole);
      isFree.add(hi--);
    }
    shrink();
    free.length = 0;
    for (const s of isFree) free.push(s);
    return true;
  };
  {
    const used = new Uint8Array(slots);
    for (let q = 0; q < n * REC; q += REC) {
      for (let i = q; i < q + LEAF; i++) if (recs[i] && recs[i] !== ZERO && recs[i] <= slots) used[recs[i] - 1] = 1;
    }
    for (let s = slots - 1; s >= 0; s--) if (!used[s]) release(s); // the lowest are taken first
  }

  const held = (b: number) => { const e = ent(b); return e !== 0 && e !== ZERO; };

  let gen = meta ? readMeta(meta) : { generation: 0, merging: '', size: 0 };
  let bumped = false;
  /** Before the first change: the map converted (`convert`), and the generation moves on, on disk, so a snapshot pinning the old one knows. */
  const bump = () => {
    if (!convert()) return false;
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
      const e = ent(b);
      if (e === ZERO) {
        // `out` is zeros there already.
      } else if (e) {
        // Blocks in consecutive slots are one read (an OPFS call costs the same whatever its size).
        for (let c = b, x = e; end < stop && held(c + 1) && ent(c + 1) === x + 1; c++, x++) end = Math.min(end + BLOCK, stop);
        if (data.read(out.subarray(pos - off, end - off), { at: (e - 1) * BLOCK + (pos - b * BLOCK) }) !== end - pos) return undefined;
      } else {
        // Runs of blocks that aren't in the overlay go to the base in one read.
        while (end < stop && !ent(end / BLOCK)) end = Math.min(end + BLOCK, stop);
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
   * them and are written from `bytes` as they are, their map entries in one write after their data (one per leaf
   * the run crosses; a range's first is its leaf's making). Only the (at most two) blocks a write covers in part are
   * read-modify-write.
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
        while (c < last && held(c + 1) && ent(c + 1) === ent(c) + 1) c++;
        const end = Math.min(stop, (c + 1) * BLOCK);
        if (data.write(bytes.subarray(pos - off, end - off), { at: (ent(b) - 1) * BLOCK + (pos - b * BLOCK) }) !== end - pos) return false;
        b = c + 1;
      } else if (!full(b)) {
        // First write to a block it covers in part: its slot starts as the base's contents (or as the zeros it was).
        const block = new Uint8Array(BLOCK);
        if (!ent(b)) {
          const old = await base.read(b * BLOCK, blockLen(b));
          if (!old) return false;
          block.set(old);
        }
        const end = Math.min(stop, (b + 1) * BLOCK);
        block.set(bytes.subarray(pos - off, end - off), pos - b * BLOCK);
        const slot = take();
        if (data.write(block, { at: slot * BLOCK }) !== BLOCK) { release(slot); shrink(); return false; }
        if (!setRun(b, b + 1, slot + 1)) { release(slot); shrink(); return false; }
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
          // Their map entries (consecutive slots), a leaf at a time.
          for (let s = i; s <= j;) {
            const e = Math.min(j + 1, (Math.floor((b + s) / LEAF) + 1) * LEAF - b);
            if (!setRun(b + s, b + e, taken[s] + 1)) {
              for (const x of taken.slice(s)) release(x);
              shrink();
              return false;
            }
            s = e;
          }
          i = j + 1;
        }
        b = c + 1;
      }
    }
    return true;
  };

  /** The whole blocks of [off, off + len) (the disk's last block is whole when the range ends with the disk). */
  const whole = (off: number, len: number) => [Math.ceil(off / BLOCK), off + len === base.size ? blocks : Math.floor((off + len) / BLOCK)];
  /**
   * Blocks [first, end) become zeros without slots (`heldOnly`: only those the overlay holds), a leaf at a time, each
   * leaf's entries to its file before its slots are free; whole ranges without a leaf get theirs in one write (up to
   * 256: 1 MiB). Refused, what landed before stays (its slots free) and the rest is as it was.
   */
  const unmap = (first: number, end: number, heldOnly: boolean) => {
    for (let s = first; s < end;) {
      const r = Math.floor(s / LEAF);
      const e = Math.min(end, (r + 1) * LEAF);
      if (!top[r] && heldOnly) { s = e; continue; }
      if (!top[r] && s === r * LEAF && e === (r + 1) * LEAF) {
        const rs = [r];
        while (rs.length < 256 && (r + rs.length + 1) * LEAF <= end && !top[r + rs.length]) rs.push(r + rs.length);
        if (!addLeaves(rs, (_, entries) => entries.fill(ZERO))) return false;
        s = (r + rs.length) * LEAF;
        continue;
      }
      const back: number[] = [];
      const ok = setMap(s, e, (_, old) => {
        if (heldOnly && !old) return 0;
        if (old && old !== ZERO) back.push(old - 1);
        return ZERO;
      });
      if (!ok) return false; // the blocks keep their slots
      for (const x of back) release(x);
      s = e;
    }
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

  /** The blocks written, ascending: the leaves' entries, the leaves in their ranges' order. */
  const written = () => {
    const out: number[] = [];
    const leaves: number[] = [];
    for (let k = 0; k < n; k++) {
      const r = recs[k * REC + LEAF] - 1;
      if (r >= 0 && r < top.length && top[r] === k + 1) leaves.push(k);
    }
    leaves.sort((x, y) => recs[x * REC + LEAF] - recs[y * REC + LEAF]);
    for (const k of leaves) {
      const first = (recs[k * REC + LEAF] - 1) * LEAF;
      for (let i = 0; i < LEAF && first + i < blocks; i++) if (recs[k * REC + i]) out.push(first + i);
    }
    return out;
  };

  const block = (b: number) => {
    const e = ent(b);
    if (!e) return undefined;
    const out = new Uint8Array(BLOCK);
    if (e === ZERO) return out;
    return data.read(out, { at: (e - 1) * BLOCK }) === BLOCK ? out : undefined;
  };

  return { size: base.size, format: base.format, read, write, discard, zero, written, block, zeroed: (b) => ent(b) === ZERO, compact: () => compact(true), bytes: () => data.getSize() + mapFile.getSize(), flush: () => { data.flush(); mapFile.flush(); }, generation: () => gen.generation, epoch: () => { bumped = false; } };
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

let opfs: Promise<boolean> | undefined;
/**
 * Whether this context has OPFS: not in Node, and not in Firefox's private windows, where `getDirectory` throws a
 * SecurityError. Without it, overlays, firmware variables and suspended machines live in this context's memory (as in
 * Node), and the page's store in the page's (`Store.open`): a machine runs, and nothing outlives the tab.
 */
export function hasOpfs(): Promise<boolean> {
  return (opfs ??= typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function'
    ? Promise.resolve(false)
    : navigator.storage.getDirectory().then(() => true, () => false));
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

/** The Web Lock whoever opens overlay (or stored disk) `name`'s files holds (`lockOverlay`). */
export const overlayLock = (name: string) => `waarm64-overlay:${name}`;

/** How long an opener waits for the overlay's previous holder (another machine, closing or in another tab). */
export const OVERLAY_WAIT_MS = 10_000;

/**
 * Takes the Web Lock `waarm64-overlay:<name>` (exclusive, per origin: every tab
 * and worker), which whoever opens the overlay's files holds until they're
 * closed; resolves to its release. A context that ends (a terminated worker, a
 * closed tab) drops its locks with its files. Waits up to `ms` for the
 * previous holder, then rejects with "overlay <name> is in use" (a developer's words: its `problem` is
 * `'overlay-in-use'`, for the page to say it).
 */
export async function lockOverlay(name: string, ms = OVERLAY_WAIT_MS, mode: LockMode = 'exclusive'): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    await new Promise<void>((granted, reject) => {
      navigator.locks.request(overlayLock(name), { mode, signal: AbortSignal.timeout(ms) }, () => {
        granted();
        return held;
      }).catch(reject);
    });
  } catch (e) {
    if ((e as DOMException).name !== 'TimeoutError') throw e;
    throw Object.assign(new Error(`overlay ${name} is in use: another machine held it for ${ms / 1000} s`), { problem: 'overlay-in-use' });
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
    if (!(await hasOpfs())) {
      if (opts.readOnly && !inMemory.has(name)) throw new DOMException(`no overlay ${name}`, 'NotFoundError');
      const o = inMemory.get(name) ?? { data: memFile(), map: memFile(), meta: memFile(), base: want ?? '' };
      if (o.base === '' && want !== undefined && !opts.readOnly) o.base = want;
      if (want !== undefined && o.base !== want) throw Object.assign(new Error(`overlay ${name} belongs to ${o.base}, not ${want}`), { problem: 'overlay-mismatch' });
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
      // A new overlay records its image. Refused (the storage full), none is recorded, so the next opening records it
      // (a part of one would be another image's, and every opening after would be refused as a mismatch).
      const id = new TextEncoder().encode(want);
      if (shortOnFull(base as unknown as SyncFile).write(id, { at: 0 }) !== id.length) {
        base.truncate(0);
        throw await storageFullError();
      }
      base.flush();
    }
    const bytes = new Uint8Array(base.getSize());
    base.read(bytes, { at: 0 });
    const got = new TextDecoder().decode(bytes);
    if (want !== undefined && got !== want) throw Object.assign(new Error(`overlay ${name} belongs to ${got}, not ${want}`), { problem: 'overlay-mismatch' });
    base.close();
    handles.pop();
    return { data, map, meta, close: done };
  } catch (e) {
    done();
    // Making its directory or files refused (the storage full): said as a write is. What was made is empty, and the
    // next opening goes on from it.
    if ((e as DOMException)?.name === 'QuotaExceededError') throw await storageFullError();
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
    if (!(await hasOpfs())) {
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
 * drops it (`dropSuspend`) before the machine runs, resumed or booted. This writes it (`fileWriter`, `makeRoom` as there).
 */
export const suspendWriter = (name: string, makeRoom?: () => Promise<boolean>) => fileWriter(`${name}/${SUSPEND}`, makeRoom);

/**
 * Writes the OPFS file at `path` (made with its directories; a kept snapshot's, a suspended machine's): a sink for the
 * bytes, in order, then `close` (a file that never got there has no end marker, and a snapshot's is refused as
 * truncated) or `abort` (the file is removed). A write the storage refuses (short, or `QuotaExceededError`) asks
 * `makeRoom` for room (the remote disks' kept blocks: `makeRoom` in web/diskcache.ts) and is tried again if it made
 * some; still refused, it throws `storageFullError()`. Dedicated workers only in a browser (a sync access handle).
 */
export async function fileWriter(path: string, makeRoom?: () => Promise<boolean>): Promise<{ write(bytes: Uint8Array): void | Promise<void>; close(): void; abort(): Promise<void> }> {
  if (!(await hasOpfs())) {
    const parts: Uint8Array[] = [];
    inMemoryFiles.delete(path);
    return { write: (b) => { parts.push(b.slice()); }, close: () => { inMemoryFiles.set(path, parts); }, abort: async () => { inMemoryFiles.delete(path); } };
  }
  const parts = path.split('/');
  const file = parts.pop()!;
  const dir = await opfsDir(parts.join('/'), true);
  const h = await (await dir.getFileHandle(file, { create: true })).createSyncAccessHandle();
  h.truncate(0);
  const f = shortOnFull(h as unknown as SyncFile);
  let at = 0;
  const put = (b: Uint8Array) => f.write(b, { at }) === b.length;
  return {
    async write(b) {
      if (!put(b) && !(makeRoom && (await makeRoom()) && put(b))) throw await storageFullError();
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
  if (!(await hasOpfs())) {
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
  if (!(await hasOpfs())) return void inMemoryFiles.delete(`${name}/${SUSPEND}`);
  try {
    const dir = await opfsDir(name);
    await dir.removeEntry(SUSPEND);
  } catch (e) {
    if ((e as DOMException).name !== 'NotFoundError') throw e;
  }
}

/** Overlay `name`'s meta (generation, merging, own size), read from a page or a worker without opening it; zeros without one. */
export async function overlayMeta(name: string): Promise<Meta> {
  if (!(await hasOpfs())) {
    const o = inMemory.get(name);
    return o ? readMeta(o.meta) : { generation: 0, merging: '', size: 0 };
  }
  try {
    const file = await (await (await opfsDir(name)).getFileHandle('meta')).getFile();
    return readMeta(bytesFile(new Uint8Array(await file.arrayBuffer())));
  } catch (e) {
    if ((e as DOMException).name !== 'NotFoundError') throw e;
    return { generation: 0, merging: '', size: 0 };
  }
}

/**
 * Gives overlay `name` its own size `size` (docs/machines.md §4.5: a grown overlay; its generation and the rest of its
 * meta as they were), made with its directory if it has none yet. The caller holds the overlay's lock (`lockOverlay`:
 * no machine has it open). From a page or a worker (a writable stream, not a sync handle).
 */
export async function writeOwnSize(name: string, size: number) {
  if (!(await hasOpfs())) {
    const o = inMemory.get(name) ?? { data: memFile(), map: memFile(), meta: memFile(), base: '' };
    inMemory.set(name, o);
    if (!writeMeta(o.meta, { ...readMeta(o.meta), size })) throw await storageFullError();
    return;
  }
  try {
    const handle = await (await opfsDir(name, true)).getFileHandle('meta', { create: true });
    const was = readMeta(bytesFile(new Uint8Array(await (await handle.getFile()).arrayBuffer())));
    const out = await handle.createWritable();
    try {
      await out.write(encodeMeta({ ...was, size }) as Uint8Array<ArrayBuffer>);
      await out.close();
    } catch (e) {
      await out.abort().catch(() => undefined); // the failure thrown is the one to report
      throw e;
    }
  } catch (e) {
    if ((e as DOMException)?.name === 'QuotaExceededError') throw await storageFullError();
    throw e;
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
  if (!(await hasOpfs())) return inMemoryFlash.get(name);
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
  if (!(await hasOpfs())) {
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
