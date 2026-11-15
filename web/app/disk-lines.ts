// A machine's disk as its Disks tab writes it (web/app/Disks.svelte, docs/machines.md §4.5): the line beside its name
// and an overlay in its Changes in list, each with the size its guest sees and, where known, what it holds of it.
import { t } from '../i18n.ts';
import { bytesText } from './bytes.ts';
import { diskKind } from './disk-kind.ts';
import { sizeSeen } from './disk-size.ts';
import type { Attachment, DiskRecord } from './shape.ts';
import type { OverlayRecord } from './store.ts';

/**
 * Disk `d`'s line beside its name, attached as `a` in slot `i` (`o`: its chosen overlay): its kind, the size its guest
 * sees (a grown overlay's own) and, a stored disk written in place, what it holds of it (its overlay's is in the list).
 */
export function attachmentLine(d: DiskRecord, a: Attachment, i: number, o?: OverlayRecord) {
  const [kind, size, letter] = [diskKind(d.kind).text, bytesText(sizeSeen(d, a, o)), String.fromCharCode(97 + i)];
  return d.kind === 'stored' && a.inPlace && !a.readOnly && d.bytes !== undefined
    ? t('disks:disk-lines.meta.held', { kind, held: bytesText(d.bytes), size, letter })
    : t('disks:disk-lines.meta', { kind, size, letter });
}

/** Overlay `o` of disk `d` in attachment `a`'s Changes in list: its name, what it holds of the size its guest would see. */
export const overlayOption = (d: DiskRecord, a: Attachment, o: OverlayRecord) =>
  t(o.fork ? 'disks:disk-lines.forked' : 'disks:disk-lines.option', {
    name: o.name,
    held: bytesText(o.bytes),
    size: bytesText(sizeSeen(d, { ...a, overlay: o.id }, o)),
  });
