// A restore cut off before its disks were filled (docs/machines.md §5.2 "A restore cut off or refused part way"): the
// page recorded and attached its new forks first (web/app/snapshots.ts `commit`), and the worker's fill marks each
// fork's overlay until it is whole (web/snapshot.ts; docs/devices.md "blk"). A machine whose fork is still marked is
// put back on what it had.
import { fillCutOff } from '../overlay.ts';
import { deleteOverlay } from './disks.ts';
import type { MachineRecord } from './shape.ts';
import { overlayDir, type Store } from './store.ts';

/**
 * Machine `m`'s attachments whose new fork a restore's fill was cut off in (a closed tab, the storage full, a damaged
 * file: its overlay still marked as filling, and no machine or job has it open): back on what they had before the
 * restore (its `before`), the fork deleted (record, then files). The overlay a fill was cut off in reads as empty
 * anyway (web/overlay.ts `openOverlay`); this gives the machine its disks as they were. An overlay the restore wrote
 * into (a replace, a template's fresh overlay) has no `before`: it stays, to be read as empty. The record as it is
 * after (the one given where nothing changed).
 */
export async function undoCutRestores(store: Store, m: MachineRecord): Promise<MachineRecord> {
  let changed = false;
  const next = { ...m, attachments: m.attachments.map((a) => ({ ...a })) };
  for (const a of next.attachments) {
    const o = a.overlay ? await store.get('overlays', a.overlay) : undefined;
    const before = o?.fork?.before;
    if (!o || !before || !(await fillCutOff(overlayDir(o.id)))) continue;
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
