// A restore that never ran (docs/machines.md §5.2 "A restore cut off or refused part way"): the page recorded and
// attached what it writes first (web/app/snapshots.ts `commit`: its new forks, and the overlays it writes into, marked
// `restoring`), the worker opens them only in its disk phase, after the check pass, and its fill marks each until it is
// whole (web/snapshot.ts; docs/devices.md "blk"); the page clears the marks once the worker says the snapshot loaded
// (`restoreLoaded`). A machine whose restore was cut off or refused anywhere before that (the tab closed, the file
// refused, the storage full, a disk that didn't open after the fill) is put back on what it had.
import { markCutFill, metaIfFree } from '../overlay.ts';
import type { DiskPlan } from '../snapshot.ts';
import { deleteOverlay } from './disks.ts';
import { machineLock } from './machines.ts';
import type { MachineRecord } from './shape.ts';
import { overlayDir, type OverlayRecord, type Store } from './store.ts';

/**
 * Whether overlay `o` is what a restore wrote, or was to write, that never ran, and that nothing has open: marked
 * `restoring` (its restore hasn't loaded), or, from before that mark, a new fork (its record has `before`) that holds
 * no fill of its own (generation 0: never opened; or a fill cut off in it, still marked).
 */
export async function cutFork(o: OverlayRecord) {
  if (!o.restoring && !o.fork?.before) return false;
  const meta = await metaIfFree(overlayDir(o.id));
  return !!meta && (!!o.restoring || meta.generation === 0 || !!meta.filling);
}

/**
 * Machine `m`'s attachments whose restore never ran (`cutFork`): a new fork goes (record, then files), the attachment
 * back on what it had before the restore (its `before`); an overlay the restore wrote into (a replace, a template's
 * fresh overlay: no `before`) stays attached, read as empty (`markCutFill`: the snapshot's blocks a fill put there
 * are no run's, and what it held was replaced), and is no fork of the snapshot any more (a later restore would attach
 * it again as the snapshot's blocks). Under the machine's lock, taken only if free: a start holds it from before its
 * restore's commit to its end (web/app/areas/snapshot-restore.ts), so nothing is undone while a start, here or in
 * another tab, owns the machine's forks; `owned`: the caller holds it (a start that boots: web/app/run/runner.ts). The
 * record is read again under the lock (another tab's write meanwhile stays); the record as it is after (the one given
 * where nothing changed).
 */
export async function undoCutRestores(
  store: Store,
  m: MachineRecord,
  o: { owned?: boolean } = {},
): Promise<MachineRecord> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a probe: no Web Locks in some contexts
  if (typeof navigator === 'undefined' || !navigator.locks) return m;
  if (o.owned) return undo(store, m);
  return navigator.locks.request(machineLock(m.id), { ifAvailable: true }, (lock) => (lock ? undo(store, m) : m));
}

async function undo(store: Store, given: MachineRecord): Promise<MachineRecord> {
  const m = (await store.get('machines', given.id)) ?? given;
  const next = { ...m, attachments: m.attachments.map((a) => ({ ...a })) };
  const { into, kept, changed } = await goBack(store, next);
  for (const o of into)
    if (await markCutFill(overlayDir(o.id))) {
      const { fork: _, restoring: __, ...rest } = o;
      await store.put('overlays', { ...rest, modified: Date.now() });
    }
  if (!changed) return given;
  next.modified = Date.now();
  await store.put('machines', next);
  for (const o of kept) {
    // Attached again, not made: it stays, as it was (the snapshot's blocks, at its generation).
    const { restoring: _, ...rest } = o;
    await store.put('overlays', {
      ...rest,
      fork: o.fork && { snapshot: o.fork.snapshot, generation: o.fork.generation },
    });
  }
  for (const a of m.attachments)
    if (a.overlay && !kept.some((o) => o.id === a.overlay) && !next.attachments.some((x) => x.overlay === a.overlay))
      // A machine that opened it meanwhile (another tab): it stays, unchosen here, and reads as empty there.
      await deleteOverlay(store, a.overlay).catch((e: unknown) => console.warn('waarm64: a cut fork stays:', e));
  return next;
}

/**
 * `next`'s attachments whose restore never ran put back on what they had (in place); the overlays the restore wrote
 * into (no `before`: they stay), and the earlier forks it attached again (`kept`: they stay, unchosen).
 */
async function goBack(store: Store, next: MachineRecord) {
  const into: OverlayRecord[] = [];
  const kept: OverlayRecord[] = [];
  let changed = false;
  for (const a of next.attachments) {
    const o = a.overlay ? await store.get('overlays', a.overlay) : undefined;
    if (!o || !(await cutFork(o))) continue;
    const before = o.fork?.before;
    if (!before) {
      into.push(o);
      continue;
    }
    if (before.kept) kept.push(o);
    // Its earlier overlay deleted since (none: the next start makes an empty one).
    a.overlay = before.overlay && (await store.get('overlays', before.overlay)) ? before.overlay : undefined;
    a.inPlace = before.inPlace;
    changed = true;
  }
  return { into, kept, changed };
}

/**
 * Restore `plan` of machine `id` loaded (the worker's `loaded`: the machine runs from the snapshot): what it wrote is
 * the machine's now, no longer to be undone (`restoring` and the forks' `before` cleared), and a template's first
 * start is done (`restoreFirst` cleared). Called while the run holds the machine's lock.
 */
export async function restoreLoaded(store: Store, id: string, plan: DiskPlan[]) {
  for (const p of plan) {
    if (p.action !== 'write' || !p.overlay.startsWith('overlays/')) continue;
    const o = await store.get('overlays', p.overlay.slice('overlays/'.length));
    if (!o || (!o.restoring && !o.fork?.before)) continue;
    const { restoring: _, ...rest } = o;
    const fork = o.fork && { snapshot: o.fork.snapshot, generation: o.fork.generation };
    await store.put('overlays', { ...rest, ...(fork ? { fork } : {}) });
  }
  const m = await store.get('machines', id);
  if (m?.restoreFirst) await store.put('machines', { ...m, restoreFirst: undefined });
}
