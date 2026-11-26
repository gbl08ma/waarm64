// A restore that never loaded (docs/machines.md §5.2 "A restore's records"): the page's commit wrote, in the machine's
// record, the attachments it switched and what undoes each (`MachineRecord.restoring`: web/app/snapshots.ts `commit`);
// the worker opens the overlays only in its disk phase, after the check pass, and its fill marks each until it is whole
// (web/snapshot.ts; docs/devices.md "blk"); the page clears the record's `restoring` once the worker says the snapshot
// loaded (`restoreLoaded`). A machine whose restore was cut off or refused anywhere before that (the tab closed, the
// file refused, the storage full, a disk that didn't open after the fill) is put back on what it had at its next load.
import { MsgError } from '../msg.ts';
import { markCutFill } from '../overlay.ts';
import { deleteOverlay, inUse } from './disks.ts';
import { holdMachines } from './machine-hold.ts';
import { machineLock } from './machines.ts';
import type { RestoreStep } from './restore-step.ts';
import type { MachineRecord } from './shape.ts';
import { overlayDir, type Store } from './store.ts';

/**
 * Machine `m`'s restore that never loaded (its record's `restoring`), undone: a new fork's attachment back on what it
 * had (`before`) and the fork deleted (record, then files); an earlier fork attached again, the attachment back, the
 * fork kept; an overlay the restore wrote into (a replace, a template's fresh overlay) left attached, as it was if the
 * fill never moved its generation on, else read as empty (`markCutFill`). Under the machine's lock, taken only if free: a
 * start holds it from before its restore's commit to its end (web/app/areas/snapshot-restore.ts), so nothing is undone
 * while a start, here or in another tab, owns the machine's restore; `owned`: the caller holds it (a start that boots:
 * web/app/run/runner.ts). The record is read again under the lock (another tab's write meanwhile stays); the record as
 * it is after (the one given where there was nothing to undo).
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
  if (!m.restoring?.length) return given;
  const next = { ...m, attachments: m.attachments.map((a) => ({ ...a })) };
  const left: RestoreStep[] = [];
  for (const s of m.restoring) if (!(await undoStep(store, next, s))) left.push(s);
  if (left.length === m.restoring.length) return given;
  next.restoring = left.length ? left : undefined;
  next.modified = Date.now();
  await store.put('machines', next);
  // The new forks go once nothing names them as this restore's. Cut off before, or one that can't go (open, or
  // chosen by a machine that runs): it stays, unattached here, an overlay like another (filled or not, `earlierFork`
  // and its next opening tell).
  for (const s of m.restoring)
    if (s.how === 'fork' && !left.includes(s))
      await dropFork(store, next.id, s.overlay).catch((e: unknown) => console.warn('waarm64: a cut fork stays:', e));
  return next;
}

/**
 * Step `s` of a restore that never loaded undone in record `next` (in place): false where it can't be now. An overlay
 * written into whose fill moved it on is marked as a cut-off fill before the record says it's done; a new fork is to be
 * deleted (`dropFork`, after the record). One of those open elsewhere (another tab's machine or job) can't be: its step
 * stays as it is, for the next load, and until then the machine doesn't start (`pendingRestore`).
 */
async function undoStep(store: Store, next: MachineRecord, s: RestoreStep) {
  if (s.how === 'into') return markCutFill(overlayDir(s.overlay), s.generation);
  if (s.how === 'fork' && (await inUse(overlayDir(s.overlay)))) return false;
  const a = next.attachments.find((x) => x.id === s.attachment);
  // Back on what it had, unless the attachment was switched since (to something other than the fork, or to none: a
  // merge or a delete took the fork away). Its earlier overlay deleted since: none (the next start makes an empty one).
  if (a && (a.overlay === s.overlay || a.overlay === undefined)) {
    a.overlay = s.before.overlay && (await store.get('overlays', s.before.overlay)) ? s.before.overlay : undefined;
    a.inPlace = s.before.inPlace;
  }
  return true;
}

/**
 * Refuses a start or a restore of machine `m` (its record read under its lock, after the undo) while a restore of it
 * that never loaded is still to be undone (an overlay it wrote, or made, open elsewhere): a boot would run over what
 * the undo then changes, and a second restore would stack on it.
 */
export function pendingRestore(m: MachineRecord) {
  if (m.restoring?.length) throw new MsgError('snapshots:snapshot-undo.pending');
}

/** The overlays that the restores that haven't loaded name, any machine's: none is an earlier fork to attach again. */
export async function namedByRestores(store: Store) {
  const named = new Set<string>();
  for (const m of await store.all('machines')) for (const s of m.restoring ?? []) named.add(s.overlay);
  return named;
}

/** Deletes fork `id` that machine `own`'s restore made, holding off the other machines that have it chosen. */
async function dropFork(store: Store, own: string, id: string) {
  const users = (await store.all('machines')).filter(
    (x) => x.id !== own && x.attachments.some((a) => a.overlay === id),
  );
  const held = await holdMachines(users);
  if (held.busy) return;
  try {
    await deleteOverlay(store, id);
  } finally {
    held.release();
  }
}

/**
 * Machine `id`'s restore loaded (the worker's `loaded`: the machine runs from the snapshot): what it wrote is the
 * machine's now, no longer to be undone, and a template's first start is done. One write, the record's `restoring` and
 * `restoreFirst` cleared together: refused (the storage full), the restore is still one that never loaded, as a whole.
 * Then a template's fresh overlay it wrote into is named after the snapshot and marked as its fork (a later restore of
 * it attaches it again while it hasn't moved), which only spares a fork if it fails. Called while the run holds the
 * machine's lock.
 */
export async function restoreLoaded(store: Store, id: string) {
  const m = await store.get('machines', id);
  if (!m || (!m.restoring && !m.restoreFirst)) return;
  const { restoring = [] } = m;
  await store.put('machines', { ...m, restoring: undefined, restoreFirst: undefined, modified: Date.now() });
  for (const s of restoring) {
    if (s.how !== 'into' || !s.fork) continue;
    const o = await store.get('overlays', s.overlay).catch(() => undefined);
    if (!o) continue;
    const fork = { snapshot: s.fork.snapshot, generation: s.generation + 1 };
    await store
      .put('overlays', { ...o, name: s.fork.name, fork, modified: Date.now() })
      .catch((e: unknown) => console.warn('waarm64: a fresh overlay not marked as its fork:', e));
  }
}
