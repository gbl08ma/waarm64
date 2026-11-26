// Changes in (M8 phase B loop 6; docs/frontend.md "Your own disk"): a changes file, the qcow2 that
// web/qcow2-write.ts writes (the blocks a machine wrote over a base image, naming the image's
// hash: `hashSource`), becomes the overlay of the disk on the page, once the base image is checked
// to be the one it was made over. Workers only in a browser (sync access handles, synchronous reads).
import type { Source } from './disk-sources.ts';
import { msg, MsgError, type Msg } from './msg.ts';
import {
  endFill,
  openOverlay,
  overlay,
  storageFullError,
  withRoom,
  type OverlayFiles,
  type SyncFile,
} from './overlay.ts';
import { openDisk, readChanges, type ChangedBlock, type Disk } from './qcow2.ts';
import { isZero } from './qcow2-write.ts';

/** The slices of an image's file that `hashSource` digests, and how many digests run at once. */
export const HASH_SLICE = 4 << 20;
const HASH_AT_ONCE = 4;

/**
 * The hash a changes file names its base by, as lowercase hex: the SHA-256 of the SHA-256 digests,
 * in order, of the image file's slices of `slice` bytes (the last one shorter). `crypto.subtle`
 * has no incremental digest and a SHA-256 in JS runs at ~50 MiB/s in Chromium; the platform's over
 * slices is as fast as the file reads (docs/frontend.md "Your own disk").
 */
export async function hashSource(src: Source, progress: (done: number) => void, slice = HASH_SLICE) {
  const leaves = new Uint8Array(Math.ceil(src.size / slice) * 32);
  const running: Promise<void>[] = [];
  for (let off = 0, i = 0; off < src.size; off += slice, i++) {
    const bytes = src.read(off, Math.min(slice, src.size - off));
    if (!bytes) throw new MsgError('disks:changes.baseUnreadable', { offset: off });
    running.push(
      crypto.subtle
        .digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
        .then((d) => leaves.set(new Uint8Array(d), i * 32)),
    );
    if (running.length === HASH_AT_ONCE) await running.shift();
    progress(off + bytes.length);
  }
  await Promise.all(running);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', leaves))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * How much of base `src` its hash covers (`baseHash`): all of it; but a stored disk grown since it was made (`made`,
 * its size then: docs/machines.md §4.5) only up to the larger of that and the end of the last block it holds, the rest
 * reading as zeros. So growing it doesn't change its hash (the changes files exported from its overlays still import),
 * and a disk whose bytes past its old end were written does change it.
 */
export function hashedSize(src: Source, made?: number) {
  if (made === undefined || made >= src.size || !src.held) return src.size;
  let end = 0;
  for (const b of src.held()) end = (b + 1) * 4096;
  return Math.min(src.size, Math.max(made, end));
}

/** The hash a changes file names base `src` by (`hashSource` of its first `hashedSize` bytes). */
export function baseHash(src: Source, made: number | undefined, progress: (done: number) => void) {
  const size = hashedSize(src, made);
  return hashSource(size === src.size ? src : { size, read: (off, len) => src.read(off, len) }, progress);
}

/**
 * Replaces overlay `overlayName` (over `base`, whose identity is `identity`: `diskIdentity`) with
 * the blocks of the changes file `changes`. The overlay, and the firmware's variable store beside
 * it, are deleted first: the changes are the whole of what the disk has written. Refuses, before
 * touching anything, a file that isn't one of ours, whose tables or clusters lie past its end (`check`), or whose base
 * isn't `base` (`hashSource` of its bytes is compared), with a message for the user (a `MsgError`). `label` names
 * `base` in it. A write the storage refuses asks `makeRoom` for room first (`withRoom`). A failure once the overlay was
 * emptied (a cluster that doesn't unpack, the file unreadable, the storage full) leaves it marked, so it reads as empty
 * (its next opening empties it), and the error says so (`cleared: true`).
 */
export async function loadChanges(o: {
  changes: Source;
  base: Source;
  /** A stored base grown since it was made: its size then (`hashedSize`). */
  made?: number;
  label: string;
  overlay: string;
  identity: string;
  progress?: (phase: Msg, done: number, total: number) => void;
  makeRoom?: () => Promise<boolean>;
}) {
  const progress = o.progress ?? (() => {});
  const c = readChanges((off, len) => (len === 0 ? new Uint8Array(0) : o.changes.read(off, len)), o.changes.size);
  if (!c) throw new MsgError('disks:changes.notChanges');
  if (!c.hash) throw new MsgError('disks:changes.notOurs', { backing: c.backingName });
  const base = openDisk((off, len) => (len === 0 ? new Uint8Array(0) : o.base.read(off, len)), o.base.size);
  // A changes file may be larger than its base (a grown overlay's export, docs/machines.md §4.5): the overlay takes its
  // size. A stored base grown since is the size its hash covers (`hashedSize`); the overlay over it is as large as it.
  const hashed = hashedSize(o.base, o.made);
  // At least an image's virtual size (a qcow2's file may be larger or smaller than it); a stored or blank base's bytes
  // are its disk's (`held`), where one grown since counts up to the size its hash covers.
  const least = o.base.held ? hashed : base.size;
  if (c.size < least)
    throw new MsgError('disks:changes.otherSize', {
      size: c.size,
      backing: c.backingName,
      label: o.label,
      baseSize: least,
    });
  // Every table and cluster the file names is in it, checked before the overlay is touched (they are read lazily, as
  // the blocks are loaded).
  await c.check();
  const hash = await baseHash(o.base, o.made, (done) => progress(msg('disks:changes.checkingBase'), done, hashed));
  if (hash !== c.hash) {
    throw new MsgError('disks:changes.otherBase', {
      backing: c.backingName,
      hash: c.hash.slice(0, 12),
      label: o.label,
      baseHash: hash.slice(0, 12),
    });
  }
  // Emptied under its lock (no other opener between), marked as filling (its generation moved on) before anything of
  // it is deleted and cleared once both files are flushed: a load refused or cut off part way is never read as the
  // disk's (web/overlay.ts `openOverlay`'s `fresh`). What failed once it was marked has emptied the overlay: it says so
  // (`cleared`, for the page's words).
  let files: OverlayFiles | undefined;
  try {
    const lands = withRoom(o.makeRoom);
    files = await openOverlay(o.overlay, o.identity, undefined, {
      fresh: { size: c.size > base.size ? c.size : 0, lands },
    });
    const f = files;
    const total = Math.ceil(c.size / 4096);
    const r = await changesInto(c.blocks(), base, f, lands, (block) =>
      progress(msg('disks:changes.loadingChanges'), block, total),
    );
    if (!(await lands(() => endFill(f.meta)))) throw await storageFullError();
    return r;
  } catch (e) {
    // Its lock not given (another tab has the disk open), or its mark refused (the storage full): nothing was touched.
    const untouched = !files && !(e as { marked?: unknown } | null)?.marked;
    if (!untouched && e && typeof e === 'object') Object.assign(e, { cleared: true });
    throw e;
  } finally {
    files?.close();
  }
}

/** The most blocks a changes file's load gives one write or zeroing (1 MiB). */
const CHANGES_RUN = 256;

/**
 * Writes a changes file's blocks (`blocks`, ascending) into the new, empty overlay of `files` over `base`: runs of
 * consecutive blocks of one kind (data or zeros), up to `CHANGES_RUN`, a write or a zeroing each (a block a call, a
 * changes file of 4 GiB was ~10^6 calls, each with a data flush). Unordered (`overlay`'s `ordered: false`), both files
 * flushed at its end: the caller marks the overlay as filling until then (`loadChanges`), so a load cut off part way
 * is never read as a disk (web/overlay.ts `openOverlay` takes a marked overlay as empty). A write the storage refuses
 * goes through `lands` (`withRoom`). `progress` gets a block every 256. The blocks written, and the calls.
 */
export async function changesInto(
  blocks: AsyncIterable<ChangedBlock>,
  base: Disk,
  files: { data: SyncFile; map: SyncFile; meta: SyncFile },
  lands: (w: () => boolean | Promise<boolean>) => Promise<boolean>,
  progress?: (block: number) => void,
) {
  const disk = overlay(base, files.data, files.map, files.meta, 0, { ordered: false });
  const run = new Uint8Array(CHANGES_RUN * 4096);
  let [first, n, len, zeros, written, calls] = [0, 0, 0, false, 0, 0];
  const land = async () => {
    if (!n) return;
    const at = first * 4096;
    if (!(await lands(() => (zeros ? disk.zero(at, len) : disk.write(at, run.subarray(0, len))))))
      throw new MsgError('disks:changes.blockWriteFailed', { block: first }, { cause: await storageFullError() });
    calls++;
    [n, len] = [0, 0];
  };
  for await (const { block, data } of blocks) {
    const z = isZero(data);
    if (n && (block !== first + n || z !== zeros || n === CHANGES_RUN)) await land();
    if (!n) [first, zeros] = [block, z];
    if (!z) run.set(data, len);
    len += data.length;
    n++;
    if (++written % 256 === 0) progress?.(block);
  }
  await land();
  disk.flush();
  return { blocks: written, calls };
}
