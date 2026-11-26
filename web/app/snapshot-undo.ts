// A restore cut off before its disks were filled (docs/machines.md §5.2 "A restore cut off or refused part way"): the
// page recorded and attached its new forks first (web/app/snapshots.ts `commit`), the worker opens each fork only in
// its disk phase, after the check pass, and its fill marks the fork's overlay until it is whole (web/snapshot.ts;
// docs/devices.md "blk"). A machine whose fork holds no fill of its own is put back on what it had.
import { metaIfFree } from '../overlay.ts';
import { deleteOverlay } from './disks.ts';
import { machineLock } from './machines.ts';
import type { MachineRecord } from './shape.ts';
import { overlayDir, type OverlayRecord, type Store } from './store.ts';

/**
 * Whether overlay `o` is a restore's new fork (its record has `before`) that holds no fill of its own and that nothing
 * has open: never opened by the restore's fill (generation 0: cut off before the disk phase, in the check pass or the
 * RAM's, or before the worker started) or a fill cut off in it (still marked). Its `before` holds only until a later
 * restore replaces its blocks (`commitStep` drops it then), so a fill of another restore into it is never this.
 */
export async function cutFork(o: OverlayRecord) {
  if (!o.fork?.before) return false;
  const meta = await metaIfFree(overlayDir(o.id));
  return !!meta && (meta.generation === 0 || !!meta.filling);
}

/**
 * Machine `m`'s attachments whose new fork a restore was cut off before filling (`cutFork`: a closed tab, the file
 * refused, the storage full): back on what they had before the restore (its `before`), the fork deleted (record, then
 * files). An overlay a fill was cut off in reads as empty anyway (web/overlay.ts `openOverlay`); this gives the machine
 * its disks as they were. An overlay the restore wrote into (a replace, a template's fresh overlay) has no `before`: it
 * stays, to be read as empty. Under the machine's lock, taken only if free: a start holds it from before its restore's
 * commit to its end (web/app/areas/snapshot-restore.ts), so nothing is undone while a start, here or in another tab,
 * owns the machine's forks. The record as it is after (the one given where nothing changed).
 */
export async function undoCutRestores(store: Store, m: MachineRecord): Promise<MachineRecord> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a probe: no Web Locks in some contexts
  if (typeof navigator === 'undefined' || !navigator.locks) return m;
  return navigator.locks.request(machineLock(m.id), { ifAvailable: true }, (lock) => (lock ? undo(store, m) : m));
}

async function undo(store: Store, m: MachineRecord): Promise<MachineRecord> {
  let changed = false;
  const next = { ...m, attachments: m.attachments.map((a) => ({ ...a })) };
  for (const a of next.attachments) {
    const o = a.overlay ? await store.get('overlays', a.overlay) : undefined;
    const before = o?.fork?.before;
    if (!o || !before || !(await cutFork(o))) continue;
    // Its earlier overlay deleted since (none: the next start makes an empty one).
    a.overlay = before.overlay && (await store.get('overlays', before.overlay)) ? before.overlay : undefined;
    a.inPlace = before.inPlace;
    changed = true;
  }
  if (!changed) return m;
  next.modified = Date.now();
  await store.put('machines', next);
  for (const a of m.attachments)
    if (a.overlay && !next.attachments.some((x) => x.overlay === a.overlay))
      // A machine that opened it meanwhile (another tab): it stays, unchosen here, and reads as empty there.
      await deleteOverlay(store, a.overlay).catch((e: unknown) => console.warn('waarm64: a cut fork stays:', e));
  return next;
}
