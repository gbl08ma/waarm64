// Changes in (M8 phase B loop 6; docs/frontend.md "Your own disk"): a changes file, the qcow2 that
// web/qcow2-write.ts writes (the blocks a machine wrote over a base image, naming the image's
// hash: `hashSource`), becomes the overlay of the disk on the page, once the base image is checked
// to be the one it was made over. Workers only in a browser (sync access handles, synchronous reads).
import type { Source } from './devices.ts';
import { msg, MsgError, type Msg } from './msg.ts';
import { openOverlay, overlay, readMeta, removeOverlay, storageFullError, withRoom, writeMeta } from './overlay.ts';
import { openDisk, readChanges } from './qcow2.ts';
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
    running.push(crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>).then((d) => leaves.set(new Uint8Array(d), i * 32)));
    if (running.length === HASH_AT_ONCE) await running.shift();
    progress(off + bytes.length);
  }
  await Promise.all(running);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', leaves))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Replaces overlay `overlayName` (over `base`, whose identity is `identity`: `diskIdentity`) with
 * the blocks of the changes file `changes`. The overlay, and the firmware's variable store beside
 * it, are deleted first: the changes are the whole of what the disk has written. Refuses, before
 * touching anything, a file that isn't one of ours or whose base isn't `base` (`hashSource` of its
 * bytes is compared), with a message for the user (a `MsgError`). `label` names `base` in it. A write the storage
 * refuses asks `makeRoom` for room first (`withRoom`).
 */
export async function loadChanges(o: {
  changes: Source;
  base: Source;
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
  // A changes file may be larger than its base (a grown overlay's export, docs/machines.md §4.5): the overlay takes its size.
  if (c.size < base.size) throw new MsgError('disks:changes.otherSize', { size: c.size, backing: c.backingName, label: o.label, baseSize: base.size });
  const hash = await hashSource(o.base, (done) => progress(msg('disks:changes.checkingBase'), done, o.base.size));
  if (hash !== c.hash) {
    throw new MsgError('disks:changes.otherBase', { backing: c.backingName, hash: c.hash.slice(0, 12), label: o.label, baseHash: hash.slice(0, 12) });
  }
  await removeOverlay(o.overlay);
  const files = await openOverlay(o.overlay, o.identity);
  try {
    if (c.size > base.size && !writeMeta(files.meta, { ...readMeta(files.meta), size: c.size })) throw await storageFullError();
    const disk = overlay(base, files.data, files.map, files.meta);
    const lands = withRoom(o.makeRoom);
    const total = Math.ceil(c.size / 4096);
    let blocks = 0;
    for await (const { block, data } of c.blocks()) {
      if (!(await lands(() => (isZero(data) ? disk.zero(block * 4096, data.length) : disk.write(block * 4096, data))))) throw new MsgError('disks:changes.blockWriteFailed', { block }, { cause: await storageFullError() });
      if (++blocks % 256 === 0) progress(msg('disks:changes.loadingChanges'), block, total);
    }
    disk.flush();
    return { blocks };
  } finally {
    files.close();
  }
}
