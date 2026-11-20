// Stored disks (docs/machines.md §4.4): an image copied into the browser, kept in the overlay's sparse block
// format over nothing (web/overlay.ts: `data`, `map`, `meta` in OPFS `disks/<id>/`; a block without a slot reads as
// zeros). The same code reads, writes and exports them: an attachment writes into one of the disk's overlays, whose
// base is the store read here (`openStored`), or into the store itself ("in place": it is then an overlay over
// zeros). `importImage` converts a qcow2 or raw image on the way in (zero blocks left out); `mergeOverlay` writes an
// overlay into the store and deletes it, marking the store first so an interrupted merge is finished at its next
// opening (`resumeMerge`), before anything reads it. Workers only in a browser (sync access handles).
import type { Source } from './devices.ts';
import { MsgError } from './msg.ts';
import {
  mapBlocks,
  mapEntry,
  openOverlay,
  overlay,
  overlayMeta,
  readMap,
  readMeta,
  removeOverlay,
  storageFullError,
  withRoom,
  writeMeta,
  type OverlayFiles,
  type SyncFile,
} from './overlay.ts';
import { openDisk, qcow2Allocated, type Disk, type Inflater } from './qcow2.ts';
import { wordsOf, zeroRange } from './ramdisk.ts';

const BLOCK = 4096;
/** A map entry for a block that reads as zeros without a slot (web/overlay.ts). */
const ZERO = 0xffffffff;

/** A disk of `size` bytes that reads as zeros: the base of a stored disk's own block store. */
export const zeroDisk = (size: number): Disk => ({
  size,
  format: 'raw',
  read: async (off, len) => (off >= 0 && off + len <= size ? new Uint8Array(len) : undefined),
});

/** A block store's bytes as a synchronous source (the base under an overlay, or an export's), from its open files. */
export function blockSource(data: SyncFile, mapFile: SyncFile, size: number): Source {
  const m = readMap(mapFile, Math.ceil(size / BLOCK)); // either format, as its leaves (a flat map isn't converted: read-only)
  const ent = (b: number) => mapEntry(m, b);
  const held = (b: number) => ent(b) !== 0 && ent(b) !== ZERO;
  return {
    size,
    read(off, len) {
      if (off < 0 || off + len > size) return undefined;
      const out = new Uint8Array(len);
      for (let pos = off; pos < off + len;) {
        const b = Math.floor(pos / BLOCK);
        let end = Math.min((b + 1) * BLOCK, off + len);
        if (held(b)) {
          // Blocks in consecutive slots are one read.
          for (let c = b; end < off + len && held(c + 1) && ent(c + 1) === ent(c) + 1; c++)
            end = Math.min(end + BLOCK, off + len);
          if (
            data.read(out.subarray(pos - off, end - off), { at: (ent(b) - 1) * BLOCK + (pos - b * BLOCK) }) !==
            end - pos
          )
            return undefined;
        }
        pos = end;
      }
      return out;
    },
    held: () => mapBlocks(m, Math.ceil(size / BLOCK), true),
    leaves: () => m, // read-only: it never changes
  };
}

/**
 * Opens stored disk `path` (`disks/<id>`) to read it, under a shared lock (several machines may read it under their
 * overlays; one writing it in place, or a merge, waits for them). A merge that was interrupted is finished first.
 */
export async function openStored(path: string, size: number): Promise<Source & { close(): void }> {
  await resumeMerge(path, size);
  const files = await openOverlay(path, undefined, undefined, { readOnly: true });
  return { ...blockSource(files.data, files.map, size), close: files.close };
}

/** Opens stored disk `path` for writing (exclusive): in place, an import or a merge. An interrupted merge is finished first. */
export async function openStoredForWriting(path: string, identity: string, size: number) {
  await resumeMerge(path, size);
  return openOverlay(path, identity);
}

/**
 * Copies image `src` (qcow2 or raw: its virtual bytes, compressed clusters inflated) into the empty block store
 * `files`, leaving zero blocks out. `progress` gets the bytes done of the virtual size. Returns the size and the
 * blocks written. `inflater` unpacks compressed clusters (web/inflate-pool.ts in the disk worker). A write the storage
 * refuses asks `makeRoom` for room first (`withRoom`).
 */
export async function importImage(
  src: Source,
  files: OverlayFiles,
  progress: (done: number, total: number) => void = () => {},
  inflater?: Inflater,
  makeRoom?: () => Promise<boolean>,
) {
  const image = openDisk((off, len) => (len === 0 ? new Uint8Array(0) : src.read(off, len)), src.size, inflater);
  const store = overlay(zeroDisk(image.size), files.data, files.map, files.meta);
  const lands = withRoom(makeRoom);
  const CHUNK = 1 << 20;
  let blocks = 0;
  for (let off = 0; off < image.size; off += CHUNK) {
    const len = Math.min(CHUNK, image.size - off);
    const bytes = await image.read(off, len);
    if (!bytes) throw new MsgError('disks:stored.imageUnreadable', { offset: off });
    // Runs of blocks with a byte that isn't zero, each one write.
    const words = wordsOf(bytes);
    for (let b = 0; b * BLOCK < len;) {
      const nonzero = (k: number) =>
        k * BLOCK < len && !zeroRange(bytes, words, k * BLOCK, Math.min(len, (k + 1) * BLOCK));
      if (!nonzero(b)) {
        b++;
        continue;
      }
      let e = b + 1;
      while (nonzero(e)) e++;
      if (!(await lands(() => store.write(off + b * BLOCK, bytes.subarray(b * BLOCK, Math.min(len, e * BLOCK))))))
        throw new MsgError('disks:stored.writeFailed', undefined, { cause: await storageFullError() });
      blocks += e - b;
      b = e;
    }
    progress(off + len, image.size);
  }
  store.flush();
  return { size: image.size, format: image.format, blocks };
}

/** The bytes an image will take as a stored disk, at most (a qcow2's allocated clusters, a raw file's size): for the confirmation. */
export function storedEstimate(src: Source): { size: number; format: 'raw' | 'qcow2'; estimate: number } {
  const image = openDisk((off, len) => (len === 0 ? new Uint8Array(0) : src.read(off, len)), src.size);
  return {
    size: image.size,
    format: image.format,
    estimate: image.format === 'qcow2' ? qcow2Allocated((off, len) => src.read(off, len)) : src.size,
  };
}

/**
 * Writes overlay `overlayPath`'s blocks into stored disk `diskPath` and deletes the overlay (docs/machines.md
 * §4.4: the page has deleted its record, and the disk's other overlays, first). The store's generation moves on and
 * its meta names the overlay while the blocks are copied: interrupted, the next opening of the store does it again
 * (`resumeMerge`: the same blocks written again are harmless). Returns the blocks merged. A write the storage refuses
 * asks `makeRoom` for room first (`withRoom`).
 */
export async function mergeOverlay(
  diskPath: string,
  overlayPath: string,
  identity: string,
  size: number,
  makeRoom?: () => Promise<boolean>,
) {
  const was = (await overlayMeta(diskPath)).merging;
  const resumed = await resumeMerge(diskPath, size, makeRoom);
  if (was === overlayPath) return resumed; // its own merge, that failed partway: finished now
  const files = await openOverlay(diskPath, identity);
  try {
    const m = readMeta(files.meta);
    if (!writeMeta(files.meta, { ...m, generation: m.generation + 1, merging: overlayPath }))
      throw new MsgError('disks:stored.stateWriteFailed');
    return await copyIn(files, overlayPath, size, makeRoom);
  } finally {
    files.close();
  }
}

/**
 * Finishes a merge into stored disk `diskPath` that was interrupted or failed (its meta names the overlay); nothing
 * otherwise. The blocks it merged.
 */
export async function resumeMerge(diskPath: string, size: number, makeRoom?: () => Promise<boolean>) {
  if (!(await overlayMeta(diskPath)).merging) return 0; // without opening it: readers may have it open
  const files = await openOverlay(diskPath, undefined);
  try {
    const merging = readMeta(files.meta).merging;
    return merging ? await copyIn(files, merging, size, makeRoom) : 0;
  } finally {
    files.close();
  }
}

/** The most blocks a merge copies in one read and write (1 MiB). */
const MERGE_RUN = 256;

/** The merge's copy, with the store open and marked: the overlay's blocks in (its zero blocks as zeros), the overlay deleted, the mark cleared. */
async function copyIn(files: OverlayFiles, overlayPath: string, size: number, makeRoom?: () => Promise<boolean>) {
  let blocks = 0;
  let ov: OverlayFiles | undefined;
  try {
    ov = await openOverlay(overlayPath, undefined, undefined, { readOnly: true });
  } catch (e) {
    // Deleted already, or one of its files: the copy was done, and its deletion (below) was interrupted or has been made.
    if ((e as DOMException).name !== 'NotFoundError') throw e;
  }
  if (ov) {
    try {
      const store = overlay(zeroDisk(size), files.data, files.map); // no meta: the merge moved the generation once
      const changes = overlay(zeroDisk(size), ov.data, ov.map);
      const lands = withRoom(makeRoom);
      // Runs of consecutive blocks of one kind (data or zeroed), each one read and one write (a block at a time, a
      // 2 GiB overlay was ~1.5M OPFS calls and 512k flushes).
      const run: number[] = [];
      let zeros = false;
      const land = async () => {
        if (!run.length) return;
        const at = run[0] * BLOCK;
        const len = Math.min(run.length * BLOCK, size - at);
        const ok = await lands(() => {
          if (zeros) return store.zero(at, len);
          const bytes = changes.blocks!(run);
          return bytes ? store.write(at, bytes.subarray(0, len)) : Promise.resolve(false);
        });
        if (!ok) throw new MsgError('disks:stored.writeFailed', undefined, { cause: await storageFullError() });
        blocks += run.length;
        run.length = 0;
      };
      for (const b of changes.written()) {
        const z = changes.zeroed(b);
        if (run.length && (b !== run[run.length - 1] + 1 || z !== zeros || run.length === MERGE_RUN)) await land();
        zeros = z;
        run.push(b);
      }
      await land();
      store.flush();
    } finally {
      ov.close();
    }
  }
  await removeOverlay(overlayPath); // what is left of it (none is fine)
  const m = readMeta(files.meta);
  if (!writeMeta(files.meta, { ...m, merging: '' })) throw new MsgError('disks:stored.stateWriteFailed');
  return blocks;
}
