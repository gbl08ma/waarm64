// A machine's disks attached and edited on the Home page (docs/machines.md §4.1): attach, read-only, written in place,
// swap, the order, detach. Each change is made onto the machine's record as the store has it, in one read and write
// (`Store.update`): the caller's copy may be older than another tab's write, a restore's commit or its load (§5.2 "A
// restore's records"), which stay. The machine must be off (`needsOff`). web/app/machines.ts re-exports them.
import { MsgError } from '../msg.ts';
import { SWAP_MIN_PAGES } from '../ramdisk.ts';
import { gone, needsOff } from './machines.ts';
import { MAX_DISKS, newId, type Attachment, type DiskRecord, type MachineRecord } from './shape.ts';
import type { Store } from './store.ts';

/** Attaches disk `disk` to machine `m`, last (16 at most). A blank disk is always writable; an ISO read-only unless asked. */
export async function attach(store: Store, m: MachineRecord, disk: DiskRecord, o: { readOnly?: boolean } = {}) {
  await needsOff(m.id, 'attach');
  if (m.attachments.length >= MAX_DISKS) throw maxDisks();
  const readOnly = disk.kind === 'blank' || disk.kind === 'ramdisk' ? false : (o.readOnly ?? disk.format === 'iso');
  const a: Attachment = { id: newId(), disk: disk.id, readOnly };
  // Onto the record as the store has it (`m` is the caller's copy, maybe older than a restore's commit or its load).
  const saved = await store.update('machines', m.id, (cur) => {
    if (!cur) throw gone();
    if (cur.attachments.length >= MAX_DISKS) throw maxDisks();
    return { ...cur, attachments: [...cur.attachments, a], modified: Date.now() };
  });
  Object.assign(m, saved);
  return a;
}

/** The error of an attach past `MAX_DISKS`. */
const maxDisks = () =>
  new MsgError('machines:machine-attachments.maxDisks', undefined, {
    cause: new MsgError('machines:machine-attachments.maxDisks.cause', { max: MAX_DISKS }),
  });

/** Read-only or not (a blank disk or a ramdisk is always writable); read-only, not written in place any more. */
function setReadOnly(a: Attachment, disk: DiskRecord | undefined, readOnly: boolean) {
  if (!readOnly || (disk?.kind !== 'blank' && disk?.kind !== 'ramdisk')) a.readOnly = readOnly;
  if (a.readOnly) a.inPlace = undefined;
}

/** Written in place (only a disk stored in the browser). */
function setInPlace(a: Attachment, disk: DiskRecord | undefined, inPlace: boolean) {
  if (disk?.kind !== 'stored') throw new Error('only a disk stored in the browser can be written in place');
  a.inPlace = inPlace || undefined;
}

/** The guest's swap (only a ramdisk, of `SWAP_MIN_PAGES` at least). */
function setSwap(a: Attachment, disk: DiskRecord | undefined, swap: boolean) {
  if (disk?.kind !== 'ramdisk') throw new Error("only a ramdisk can be the guest's swap");
  if (swap && disk.size < SWAP_MIN_PAGES * 4096)
    throw new MsgError('machines:machine-attachments.swapMin', undefined, {
      cause: new MsgError('machines:machine-attachments.swapMin.cause', { kib: SWAP_MIN_PAGES * 4 }),
    });
  a.swap = swap || undefined;
}

/**
 * Changes attachment `id` of machine `m` (read-only, in place, swap, its place in the order) or detaches it (`detach`),
 * on the record as the store has it (`m` is the caller's copy, maybe older than a restore's commit or its load).
 */
export async function editAttachment(
  store: Store,
  m: MachineRecord,
  id: string,
  change: { readOnly?: boolean; inPlace?: boolean; swap?: boolean; move?: -1 | 1; detach?: boolean },
) {
  await needsOff(m.id, 'disks');
  const notAttached = () =>
    new MsgError('machines:machine-attachments.notAttached', undefined, {
      cause: new MsgError('machines:machine-attachments.notAttached.cause'),
    });
  const at = m.attachments.find((a) => a.id === id);
  if (!at) throw notAttached();
  const disk = await store.get('disks', at.disk);
  const saved = await store.update('machines', m.id, (cur) => {
    if (!cur) throw gone();
    const attachments = cur.attachments.map((a) => ({ ...a }));
    const i = attachments.findIndex((a) => a.id === id);
    if (i < 0) throw notAttached();
    const a = attachments[i];
    if (change.detach) attachments.splice(i, 1);
    if (change.readOnly !== undefined) setReadOnly(a, disk, change.readOnly);
    if (change.inPlace !== undefined) setInPlace(a, disk, change.inPlace);
    if (change.swap !== undefined) setSwap(a, disk, change.swap);
    if (change.move) {
      const j = i + change.move;
      if (j >= 0 && j < attachments.length) [attachments[i], attachments[j]] = [attachments[j], attachments[i]];
    }
    return { ...cur, attachments, modified: Date.now() };
  });
  Object.assign(m, saved);
}
