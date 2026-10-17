// The ramdisk (docs/plans/machines.md §4.3): a writable disk in the host's memory, owned by the
// device worker and gone with it, so every boot (the guest's reboot too: a new machine worker)
// starts from an empty disk. Its bytes are 1 MiB chunks of shared memory, made on a chunk's first
// write and dropped when a DISCARD or WRITE_ZEROES covers the whole chunk: an empty ramdisk costs
// nothing, and what the guest trims (`fstrim`, a `discard` mount) goes back to the host. A chunk
// that isn't there reads as zeros.
import type { WritableDisk } from './overlay.ts';

/** A chunk's size: what the memory comes back in. */
export const RAM_CHUNK = 1 << 20;
const BLOCK = 4096;
const BLOCKS_PER_CHUNK = RAM_CHUNK / BLOCK;

/** A ramdisk of `size` bytes (a multiple of 512), empty. `chunks()` says how many are held (tests: the memory given back). */
export function ramDisk(size: number, init: [number, SharedArrayBuffer][] = []): WritableDisk & { chunks(): number; chunkList(): [number, SharedArrayBuffer][] } {
  // `init`: a restored ramdisk's chunks (a snapshot's blocks, written by web/snapshot.ts into another ramDisk: shared memory, not copied).
  const chunks = new Map<number, Uint8Array>(init.map(([c, b]) => [c, new Uint8Array(b)]));
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
  const chunkLen = (c: number) => Math.min(RAM_CHUNK, size - c * RAM_CHUNK);
  const read = async (off: number, len: number) => {
    if (!inside(off, len)) return undefined;
    const out = new Uint8Array(len);
    each(off, len, (c, at, n, pos) => { const k = chunks.get(c); if (k) out.set(k.subarray(at, at + n), pos - off); });
    return out;
  };
  const write = async (off: number, bytes: Uint8Array) => {
    if (!inside(off, bytes.length)) return false;
    each(off, bytes.length, (c, at, n, pos) => {
      let k = chunks.get(c);
      if (!k) chunks.set(c, (k = new Uint8Array(new SharedArrayBuffer(chunkLen(c)))));
      k.set(bytes.subarray(pos - off, pos - off + n), at);
    });
    return true;
  };
  /** Zeros [off, off + len): whole chunks are dropped, parts of others filled. */
  const clear = (off: number, len: number) => {
    if (!inside(off, len)) return false;
    each(off, len, (c, at, n) => {
      const k = chunks.get(c);
      if (!k) return;
      if (at === 0 && n === k.length) chunks.delete(c);
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
        for (let b = c * BLOCKS_PER_CHUNK; b < (c + 1) * BLOCKS_PER_CHUNK && b * BLOCK < size; b++) if (blockOf(b)!.some((x) => x !== 0)) out.push(b);
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
    chunkList: () => [...chunks].map(([c, k]) => [c, k.buffer as SharedArrayBuffer]),
  };
}
