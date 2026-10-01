// Changes in (M8 phase B loop 6; docs/frontend.md "Your own disk"): a changes file, the qcow2 that
// web/qcow2-write.ts writes (the blocks a machine wrote over a base image, naming the image's
// SHA-256), becomes the overlay of the disk on the page, once the base image is checked to be the
// one it was made over. Workers only in a browser (sync access handles, synchronous reads).
import type { Source } from './devices.ts';
import { openOverlay, overlay, removeOverlay } from './overlay.ts';
import { openDisk, readChanges } from './qcow2.ts';
import { Sha256 } from './sha256.ts';

/** SHA-256 of an image's file, read in 1 MiB slices (a changes file names its base by it). */
export function hashSource(src: Source, progress: (done: number) => void) {
  const sha = new Sha256();
  for (let off = 0; off < src.size; off += 1 << 20) {
    const bytes = src.read(off, Math.min(1 << 20, src.size - off));
    if (!bytes) throw new Error(`the base image can't be read at ${off}`);
    sha.update(bytes);
    progress(off + bytes.length);
  }
  return sha.hex();
}

/**
 * Replaces overlay `overlayName` (over `base`, whose identity is `identity`: `diskIdentity`) with
 * the blocks of the changes file `changes`. The overlay, and the firmware's variable store beside
 * it, are deleted first: the changes are the whole of what the disk has written. Refuses, before
 * touching anything, a file that isn't one of ours or whose base isn't `base` (the SHA-256 of its
 * bytes is compared), with a message for the user. `label` names `base` in it.
 */
export async function loadChanges(o: {
  changes: Source;
  base: Source;
  label: string;
  overlay: string;
  identity: string;
  progress?: (phase: string, done: number, total: number) => void;
}) {
  const progress = o.progress ?? (() => {});
  const c = readChanges((off, len) => (len === 0 ? new Uint8Array(0) : o.changes.read(off, len)), o.changes.size);
  if (!c) throw new Error("This file isn't a changes file: it has no base image (it is a disk: use Open disk… to boot it).");
  if (!c.sha256) throw new Error(`This qcow2 has a backing file (${c.backingName}) but wasn't made by Save disk, so the base can't be checked: its changes can't be loaded.`);
  const base = openDisk((off, len) => (len === 0 ? new Uint8Array(0) : o.base.read(off, len)), o.base.size);
  if (c.size !== base.size) throw new Error(`These changes are for a disk of ${c.size} bytes (made over ${c.backingName}); ${o.label} has ${base.size}. Open the disk they were made over first.`);
  const sha = hashSource(o.base, (done) => progress('Checking the base image', done, o.base.size));
  if (sha !== c.sha256) {
    throw new Error(`These changes were made over ${c.backingName} (SHA-256 ${c.sha256.slice(0, 12)}…), which isn't ${o.label} (SHA-256 ${sha.slice(0, 12)}…). Open the disk they were made over first (Open disk…), then load them.`);
  }
  await removeOverlay(o.overlay);
  const files = await openOverlay(o.overlay, o.identity);
  try {
    const disk = overlay(base, files.data, files.map);
    const total = Math.ceil(c.size / 4096);
    let blocks = 0;
    for await (const { block, data } of c.blocks()) {
      if (!(await disk.write(block * 4096, data))) throw new Error(`block ${block} can't be written to the browser's storage (is the disk full?)`);
      if (++blocks % 256 === 0) progress('Loading the changes', block, total);
    }
    disk.flush();
    return { blocks };
  } finally {
    files.close();
  }
}
