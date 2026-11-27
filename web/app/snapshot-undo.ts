// A restore that never loaded (docs/machines.md §5.2 "A restore's records"): the page's commit wrote, in the machine's
// record, the attachments it switched and what undoes each (`MachineRecord.restoring`: web/app/snapshots.ts `commit`);
// the worker opens the overlays only in its disk phase, after the check pass, and its fill marks each until it is whole
// and leaves the restore's token in its meta (web/snapshot.ts; docs/devices.md "blk"); the page clears the record's
// `restoring` once the worker says the snapshot loaded (`restoreLoaded`). A machine whose restore was cut off or refused
// anywhere before that (the tab closed, the file refused, the storage full, a disk that didn't open after the fill) is
// put back on what it had at its next load. What the undo may do to an overlay other machines share (§5.2 "Other
// machines"): it moves only this machine's attachments, and empties or deletes an overlay only where the fill's token
// proves nothing else wrote it since and no other machine has it.
import { MsgError } from '../msg.ts';
import { markCutFill, overlayMeta } from '../overlay.ts';
import { deleteOverlay, deleteOverlayAsked, inUse } from './disks.ts';
import { machineLock } from './machines.ts';
import { othersHave, restoreNames, type RestoreStep } from './restore-step.ts';
import type { MachineRecord } from './shape.ts';
import { overlayDir, type Store } from './store.ts';

/**
 * Machine `m`'s restore that never loaded (its record's `restoring`), undone: a new fork's attachment back on what it
 * had (`before`) and the fork deleted where nothing else has it (`dropFork`); an earlier fork attached again, the
 * attachment back, the fork kept; an overlay the restore wrote into (a replace, a template's fresh overlay) left
 * attached, read as empty only where its meta carries the restore's fill token (`markCutFill`: the fill opened it and
 * nothing wrote it since), else as it is. Under the machine's lock, taken only if free: a start holds it from before
 * its restore's commit to its end (web/app/areas/snapshot-restore.ts), so nothing is undone while a start, here or in
 * another tab, owns the machine's restore; `owned`: the caller holds it (a start that boots: web/app/run/runner.ts). The
 * record is read again under the lock and written in one read and write (`Store.update`: another tab's write
 * meanwhile stays); the record as it is after (the one given where there was nothing to undo).
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

/** Whether steps `a` and `b` are the same step (of one record's `restoring`). */
const same = (a: RestoreStep, b: RestoreStep) =>
  a.attachment === b.attachment && a.how === b.how && a.overlay === b.overlay;

async function undo(store: Store, given: MachineRecord): Promise<MachineRecord> {
  const m = (await store.get('machines', given.id)) ?? given;
  if (!m.restoring?.length) return given;
  const all = await store.all('machines');
  const done: { s: RestoreStep; back?: RestoreBack }[] = [];
  for (const s of m.restoring) {
    const r = await undoStep(store, all, m.id, s);
    if (r) done.push({ s, back: r.back });
  }
  if (!done.length) return given;
  const next = await store.update('machines', m.id, (cur) => {
    if (!cur) return undefined;
    const attachments = cur.attachments.map((a) => ({ ...a }));
    for (const { s, back } of done) {
      const a = back && cur.restoring?.some((x) => same(x, s)) && attachments.find((x) => x.id === s.attachment);
      // Back on what it had, unless the attachment was switched since (to something other than the fork, or to none:
      // a merge or a delete took the fork away).
      if (a && (a.overlay === s.overlay || a.overlay === undefined)) {
        a.overlay = back.overlay;
        a.inPlace = back.inPlace;
      }
    }
    const left = (cur.restoring ?? []).filter((x) => !done.some((d) => same(d.s, x)));
    return { ...cur, attachments, restoring: left.length ? left : undefined, modified: Date.now() };
  });
  if (!next) return given;
  // The new forks go once nothing names them as this restore's, where nothing else has them (`dropFork`). Cut off
  // before, or one that stays: an overlay like another (filled or not: `earlierFork` and its next opening tell).
  for (const { s } of done)
    if (s.how === 'fork')
      await dropFork(store, next.id, s).catch((e: unknown) => console.warn('waarm64: a cut fork stays:', e));
  return next;
}

/** What an attachment goes back on: its earlier overlay (none if it was deleted since), or the disk written in place. */
type RestoreBack = { overlay?: string; inPlace?: true };

/**
 * Step `s` of machine `own`'s restore that never loaded, undone where it can be now (`all`: the machines' records):
 * what its attachment goes back on (`back`; none for an overlay written into), or undefined where it can't be yet. An
 * overlay written into is marked as a cut-off fill where its fill's token is still in its meta (`markCutFill`), which
 * can't be while it's open elsewhere (another tab's machine or job); a new fork that no other machine has is to be
 * deleted (`dropFork`, after the record), which can't be while it's open. Such a step stays as it is, for the next
 * load, and until then the machine doesn't start (`pendingRestore`). A fork another machine has chosen stays theirs:
 * only this machine's attachment goes back (its run on it holds nothing up).
 */
async function undoStep(
  store: Store,
  all: MachineRecord[],
  own: string,
  s: RestoreStep,
): Promise<{ back?: RestoreBack } | undefined> {
  if (s.how === 'into') return (await markCutFill(overlayDir(s.overlay), s.token)) ? {} : undefined;
  if (s.how === 'fork' && !othersHave(all, own, s.overlay) && (await inUse(overlayDir(s.overlay)))) return undefined;
  // Its earlier overlay deleted since: none (the next start makes an empty one).
  const overlay = s.before.overlay && (await store.get('overlays', s.before.overlay)) ? s.before.overlay : undefined;
  return { back: { ...(overlay ? { overlay } : {}), ...(s.before.inPlace ? { inPlace: true as const } : {}) } };
}

/**
 * Refuses a start or a restore of machine `m` (its record read under its lock, after the undo) while a restore of it
 * that never loaded is still to be undone (an overlay it wrote, or made, open elsewhere): a boot would run over what
 * the undo then changes, and a second restore would stack on it.
 */
export function pendingRestore(m: MachineRecord) {
  if (m.restoring?.length) throw new MsgError('snapshots:snapshot-undo.pending');
}

/**
 * The overlays that the restores that haven't loaded name, any machine's: what they made, attached or wrote into, and
 * with `before`, what their undo puts a machine back on (none of them is an earlier fork to attach again).
 */
export async function namedByRestores(store: Store, o: { before?: boolean } = {}) {
  const named = new Set<string>();
  for (const m of await store.all('machines'))
    for (const s of m.restoring ?? []) {
      named.add(s.overlay);
      if (o.before && s.how !== 'into' && s.before.overlay) named.add(s.before.overlay);
    }
  return named;
}

/**
 * Deletes fork `s.overlay` that machine `own`'s restore made, now that its undo took the machine off it, where nothing
 * else has it: no other machine has it chosen or names it (`othersHave`), and its meta proves that nothing but this
 * restore's fill wrote it (never opened: generation 0; or the fill's token, which any later opening's first change
 * clears). Otherwise it stays, an overlay like another. Refused while it's open (`deleteOverlay`): it stays too.
 */
async function dropFork(store: Store, own: string, s: RestoreStep) {
  if (othersHave(await store.all('machines'), own, s.overlay)) return;
  const meta = await overlayMeta(overlayDir(s.overlay));
  if (meta.generation !== 0 && !(s.token && meta.token === s.token)) return;
  await deleteOverlay(store, s.overlay);
}

/**
 * Machine `id`'s restore loaded (the worker's `loaded`: the machine runs from the snapshot): what it wrote is the
 * machine's now, no longer to be undone, and a template's first start is done. One write, the record's `restoring` and
 * `restoreFirst` cleared together in one read and write (`Store.update`): refused (the storage full), the restore is
 * still one that never loaded, as a whole (the guest hasn't run: its vCPUs wait for the page's answer to `loaded`). Then a template's fresh overlay it wrote into is named after the snapshot
 * and marked as its fork (a later restore of it attaches it again while it hasn't moved), which only spares a fork if
 * it fails. A replace's fork (`replaced`) deletes the overlay it replaced and takes its name (`dropReplaced`). Called
 * while the run holds the machine's lock.
 */
export async function restoreLoaded(store: Store, id: string) {
  let restoring: RestoreStep[] = [];
  await store.update('machines', id, (m) => {
    if (!m || (!m.restoring && !m.restoreFirst)) return undefined;
    restoring = m.restoring ?? [];
    return { ...m, restoring: undefined, restoreFirst: undefined, modified: Date.now() };
  });
  for (const s of restoring)
    if (s.how === 'fork' && s.replaced)
      await dropReplaced(store, id, s).catch((e: unknown) => console.warn('waarm64: a replaced overlay stays:', e));
  for (const s of restoring) {
    if (s.how !== 'into' || !s.fork) continue;
    const { name, snapshot } = s.fork;
    const fork = { snapshot, generation: s.generation + 1 };
    // Onto its record as the store has it, in one read and write (the run's stop may be refreshing it meanwhile).
    await store
      .update('overlays', s.overlay, (o) => o && { ...o, name, fork, modified: Date.now() })
      .catch((e: unknown) => console.warn('waarm64: a fresh overlay not marked as its fork:', e));
  }
}

/**
 * Replace's end, once the snapshot loaded (machine `own`'s step `s`: a fork made with room for both, docs/machines.md
 * §5.2): the overlay it replaced (`before.overlay`) deleted, where no machine has it chosen or a restore names it (the
 * question offered only one no other machine had, but another tab may have chosen it since), with the machines that
 * could open it held off but `own` (`deleteOverlayAsked`); then the fork takes its name and is no snapshot's fork (as
 * the overlay a replace fills in place stays what it was). Refused (one of those machines runs, the storage refused the
 * delete), both stay: the fork named after the snapshot, the replaced overlay as it was.
 */
async function dropReplaced(store: Store, own: string, s: Extract<RestoreStep, { before: unknown }>) {
  const old = s.before.overlay;
  const was = old && (await store.get('overlays', old));
  if (!was) return;
  const all = await store.all('machines');
  if (all.some((m) => m.attachments.some((a) => a.overlay === old) || restoreNames(m, old))) return;
  await deleteOverlayAsked(store, old, { owner: own });
  await store.update(
    'overlays',
    s.overlay,
    (o) => o && { ...o, name: was.name, fork: undefined, modified: Date.now() },
  );
}
