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
