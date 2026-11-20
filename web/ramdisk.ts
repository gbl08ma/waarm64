// The ramdisk (docs/machines.md §4.3): a writable disk in the host's memory, owned by the
// device worker and gone with it, so every boot (the guest's reboot too: a new machine worker)
// starts from an empty disk. Its bytes are 1 MiB chunks of shared memory, made on a chunk's first
// write and dropped when a DISCARD or WRITE_ZEROES covers the whole chunk: an empty ramdisk costs
// nothing, and what the guest trims (`fstrim`, a `discard` mount) goes back to the host. A chunk
// that isn't there reads as zeros.
//
// A tab's ArrayBuffers and SharedArrayBuffers share one pool of 8 GiB (Chromium 153: 8191 buffers of 1 MiB, 4095
// of 2 MiB; wasm memories aren't in it), and once it is used up every allocation in the tab throws, the device
// worker's and the page's: a full 8 GiB ramdisk locked the machine up so. So a chunk is a SharedArrayBuffer of its
// own only while this realm's ramdisks hold less than `SAB_BUDGET` in them; past it (or when one can't be had),
// chunks are slots in shared wasm memories of up to 4 GiB, grown a chunk at a time. A slot that is dropped goes
// back to its ramdisk (the next new chunk takes it), not to the host: a wasm memory never shrinks. A chunk that
// can't be had at all fails its write (the guest sees an I/O error), and `onFull` is told, once.
import type { WritableDisk } from './overlay.ts';

/** A chunk's size: what the memory comes back in. */
export const RAM_CHUNK = 1 << 20;

/** `b`'s 32-bit words where it is 4-aligned (a chunk, a fresh buffer), for `zeroRange`. */
export const wordsOf = (b: Uint8Array) =>
  (b.byteOffset & 3) === 0 ? new Uint32Array(b.buffer, b.byteOffset, b.length >>> 2) : undefined;

/**
 * Whether bytes [from, to) of `b` are all zeros, eight words at a time over `words` (`wordsOf(b)`) where `from` is
 * 4-aligned: a snapshot's scan of a ramdisk's chunks, an import's of its image (a byte at a time was ~8G closure calls
 * for a 4 GiB ramdisk).
 */
export function zeroRange(b: Uint8Array, words: Uint32Array | undefined, from: number, to: number) {
  let k = from;
  if (words && (from & 3) === 0) {
    let i = from >>> 2;
    const end = to >>> 2;
    for (; i + 8 <= end; i += 8)
      if (
        (words[i] |
          words[i + 1] |
          words[i + 2] |
          words[i + 3] |
          words[i + 4] |
          words[i + 5] |
          words[i + 6] |
          words[i + 7]) !==
        0
      )
        return false;
    for (; i < end; i++) if (words[i] !== 0) return false;
    k = end << 2;
  }
  for (; k < to; k++) if (b[k] !== 0) return false;
  return true;
}
const BLOCK = 4096;
const BLOCKS_PER_CHUNK = RAM_CHUNK / BLOCK;
/** What this realm's ramdisks keep in SharedArrayBuffers of their own, at most: half the tab's pool. */
export const SAB_BUDGET = 4 * 2 ** 30;
/** A wasm memory's pages at most (4 GiB), and a chunk's. */
const ARENA_PAGES = 65536;
const CHUNK_PAGES = RAM_CHUNK / 65536;
let sabBytes = 0;

/** The guest's swap page size (arm64 Linux with 4 KiB pages: Debian's and Arch's kernels). */
const SWAP_PAGE = 4096;
/** The fewest pages `swapon` takes (mkswap's minimum). */
export const SWAP_MIN_PAGES = 10;

/**
 * The first page of a swap area over a disk of `size` bytes, as `mkswap` writes it (Linux's `union swap_header`,
 * version 1, little-endian): the version, the last page, no bad pages, `uuid` (16 bytes) and `label` (at most 15
 * bytes: blkid's `LABEL=`), and `SWAPSPACE2` at the page's end. A guest whose pages are larger than 4 KiB doesn't
 * find the signature (its `swapon` refuses the disk).
 */
export function swapHeader(
  size: number,
  label: string,
  uuid: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
): Uint8Array {
  const pages = Math.floor(size / SWAP_PAGE);
  const name = new TextEncoder().encode(label);
  if (pages < SWAP_MIN_PAGES) throw new Error(`a swap area needs ${SWAP_MIN_PAGES} pages of ${SWAP_PAGE} bytes`);
  if (name.length > 15) throw new Error('a swap label of at most 15 bytes');
  if (uuid.length !== 16) throw new Error('a 16-byte UUID');
  const page = new Uint8Array(SWAP_PAGE);
  const v = new DataView(page.buffer);
  v.setUint32(1024, 1, true); // version
  v.setUint32(1028, Math.min(pages - 1, 0xffffffff), true); // last_page
  v.setUint32(1032, 0, true); // nr_badpages
  page.set(uuid, 1036);
  page.set(name, 1052);
  page.set(new TextEncoder().encode('SWAPSPACE2'), SWAP_PAGE - 10);
  return page;
}

/** A ramdisk of `size` bytes (a multiple of 512), empty. `chunks()` says how many are held (tests: the memory given back). */
export function ramDisk(
  size: number,
  init: [number, Uint8Array][] = [],
  opts: { sabBudget?: number; onFull?: () => void } = {},
): WritableDisk & {
  chunks(): number;
  arenaBytes(): number;
  chunkList(): [number, Uint8Array][];
  chunkKeys(): Iterable<number>;
} {
  // `init`: a restored ramdisk's chunks (a snapshot's blocks, written by web/snapshot.ts into another ramDisk: shared memory, not copied).
  const chunks = new Map<number, Uint8Array>(init);
  const budget = opts.sabBudget ?? SAB_BUDGET;
  const arenas: WebAssembly.Memory[] = [];
  /** The buffers of this ramdisk's wasm memories its slots are views of. */
  const mine = new WeakSet<ArrayBufferLike>();
  /** Whether a chunk is a SharedArrayBuffer of its own (counted in `sabBytes`), not a slot in a wasm memory. */
  const own = (k: Uint8Array) => !mine.has(k.buffer) && k.byteOffset === 0 && k.byteLength === k.buffer.byteLength;
  for (const k of chunks.values()) if (own(k)) sabBytes += k.byteLength;
  const chunkLen = (c: number) => Math.min(RAM_CHUNK, size - c * RAM_CHUNK);
  /** Slots of this ramdisk's wasm memories that no chunk holds (each RAM_CHUNK long, zeroed when taken again). */
  const free: Uint8Array[] = [];
  let full = false;
  const slot = (): Uint8Array | undefined => {
    const k = free.pop();
    if (k) return k.fill(0);
    try {
      let a = arenas.at(-1);
      if (!a || a.buffer.byteLength / 65536 + CHUNK_PAGES > ARENA_PAGES) {
        // Its maximum: what the disk could still need, at most 4 GiB (address space reserved, not memory).
        const pages = Math.min(ARENA_PAGES, Math.ceil(size / RAM_CHUNK) * CHUNK_PAGES - arenas.length * ARENA_PAGES);
        arenas.push((a = new WebAssembly.Memory({ initial: 0, maximum: Math.max(pages, CHUNK_PAGES), shared: true })));
      }
      const at = a.grow(CHUNK_PAGES) * 65536;
      mine.add(a.buffer);
      return new Uint8Array(a.buffer, at, RAM_CHUNK);
    } catch {
      return undefined;
    }
  };
  /** A new chunk `c` (zeros), or undefined when there is no memory for one. */
  const make = (c: number): Uint8Array | undefined => {
    const len = chunkLen(c);
    if (sabBytes + len <= budget) {
      try {
        const k = new Uint8Array(new SharedArrayBuffer(len));
        sabBytes += len;
        return k;
      } catch {} // the tab's pool used up by something else: a slot
    }
    return slot()?.subarray(0, len);
  };
  /** Gives chunk `c` up: its SharedArrayBuffer to the host, or its slot to this ramdisk. */
  const drop = (c: number, k: Uint8Array) => {
    chunks.delete(c);
    full = false; // room again: the next failure is told too
    if (own(k)) sabBytes -= k.byteLength;
    else if (mine.has(k.buffer)) free.push(new Uint8Array(k.buffer, k.byteOffset, RAM_CHUNK));
  };
  const inside = (off: number, len: number) => Number.isSafeInteger(off) && off >= 0 && len >= 0 && off + len <= size;
  /** Calls `f` for each chunk [off, off + len) touches: its index, the range's start in it, and its length there. */
  const each = (off: number, len: number, f: (c: number, at: number, n: number, pos: number) => void) => {
    for (let pos = off; pos < off + len;) {
      const c = Math.floor(pos / RAM_CHUNK);
      const at = pos - c * RAM_CHUNK;
      const n = Math.min(RAM_CHUNK - at, off + len - pos);
      f(c, at, n, pos);
      pos += n;
    }
  };
  const read = async (off: number, len: number) => {
    if (!inside(off, len)) return undefined;
    const out = new Uint8Array(len);
    each(off, len, (c, at, n, pos) => {
      const k = chunks.get(c);
      if (k) out.set(k.subarray(at, at + n), pos - off);
    });
    return out;
  };
  const write = async (off: number, bytes: Uint8Array) => {
    if (!inside(off, bytes.length)) return false;
    let ok = true;
    each(off, bytes.length, (c, at, n, pos) => {
      let k = chunks.get(c);
      if (!k && !(k = make(c))) {
        ok = false;
        return;
      }
      chunks.set(c, k);
      k.set(bytes.subarray(pos - off, pos - off + n), at);
    });
    if (!ok && !full) {
      full = true;
      opts.onFull?.();
    }
    return ok;
  };
  /** Zeros [off, off + len): whole chunks are dropped, parts of others filled. */
  const clear = (off: number, len: number) => {
    if (!inside(off, len)) return false;
    each(off, len, (c, at, n) => {
      const k = chunks.get(c);
      if (!k) return;
      if (at === 0 && n === k.length) drop(c, k);
      else k.fill(0, at, at + n);
    });
    return true;
  };
  const blockOf = (b: number) => {
    const k = chunks.get(Math.floor(b / BLOCKS_PER_CHUNK));
    const at = (b % BLOCKS_PER_CHUNK) * BLOCK;
    return k && at < k.length ? k.subarray(at, Math.min(at + BLOCK, k.length)) : undefined;
  };
  return {
    size,
    format: 'raw',
    read,
    write,
    // Discarded bytes read as zeros (the guest may expect either; zeros are what gives memory back).
    discard: clear,
    zero: async (off, len) => clear(off, len),
    flush() {},
    /** The blocks with a byte that isn't zero, ascending: what a snapshot carries. */
    written() {
      const out: number[] = [];
      for (const c of [...chunks.keys()].sort((x, y) => x - y)) {
        const k = chunks.get(c)!;
        const words = wordsOf(k);
        for (let at = 0; at < k.length && c * RAM_CHUNK + at < size; at += BLOCK)
          if (!zeroRange(k, words, at, Math.min(at + BLOCK, k.length))) out.push(c * BLOCKS_PER_CHUNK + at / BLOCK);
      }
      return out;
    },
    block(b) {
      const bytes = blockOf(b);
      if (!bytes) return undefined;
      const out = new Uint8Array(BLOCK);
      out.set(bytes);
      return out;
    },
    zeroed: () => false,
    chunks: () => chunks.size,
    chunkKeys: () => chunks.keys(),
    /** The bytes its wasm memories hold (chunks past `SAB_BUDGET`; what a trim doesn't give back to the host). */
    arenaBytes: () => arenas.reduce((n, a) => n + a.buffer.byteLength, 0),
    /** Hands its chunks over (to the device of a restored machine, which counts them from then on). */
    chunkList() {
      const out = [...chunks];
      for (const [c, k] of out) {
        if (own(k)) sabBytes -= k.byteLength;
        chunks.delete(c);
      }
      return out;
    },
  };
}
