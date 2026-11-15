// A disk's size as its guest sees it (docs/machines.md §4.5): an overlay may be larger than its disk (its own size, a
// grown overlay's), a stored disk and a ramdisk grow in their records, sizes are whole sectors, and a grow the guest has
// yet to follow is marked. DOM-free (the page, the workers and Node's tests); web/app/resize.ts grows them.
import type { Attachment, DiskRecord } from './shape.ts';

/**
 * A resize the guest has yet to follow: the disk's size before and after, so that the next start with the guest agent
 * grows its last partition and filesystem into the new space. Kept on the overlay or stored disk that was resized, not
 * on an attachment: whichever machine boots it next does it. `failed`: the guest's grow failed once (GROWN's FAILED),
 * and the next failure clears the mark (web/app/areas/grow-actions.ts: a failure is tried again once, not at every start).
 */
export type GrowMark = { from: number; to: number; failed?: true };

/** Sizes are multiples of this (virtio-blk's sector; a qcow2's virtual size, for QEMU): a resize's new size too. */
export const SECTOR = 512;

/** The overlays' own sizes, by id (their records': `OverlayRecord.size`). */
export type OverlaySizes = (id: string) => { size?: number } | undefined;

/**
 * The size the guest sees of disk `d` through attachment `a`: through its overlay, the larger of the overlay's own size
 * and the disk's; read-only, written in place or a ramdisk, the disk's.
 */
export function sizeSeen(
  d: Pick<DiskRecord, 'size' | 'kind'>,
  a: Pick<Attachment, 'readOnly' | 'inPlace' | 'overlay'>,
  overlay?: { size?: number },
) {
  return a.readOnly || a.inPlace || d.kind === 'ramdisk' || !a.overlay ? d.size : Math.max(d.size, overlay?.size ?? 0);
}
