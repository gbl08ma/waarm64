// Merge into the disk (docs/machines.md §4.4): an overlay's blocks written into its stored disk (the disk's other
// overlays deleted), or into a blank disk, which grows to an untouched overlay's size or becomes a stored disk of a
// written one's blocks; and what a merge does, for its confirmation (`mergeEffect`). The copy runs in the disk worker
// (web/app/disk-worker.ts, web/stored.ts `mergeOverlay`). Nothing here asks the user: the Overlays dialog confirms first.
import { MsgError } from '../msg.ts';
import { mergeLock, overlayBytes, overlayMeta, removeOverlay } from '../overlay.ts';
import { sizeSeen } from './disk-size.ts';
import { deleteOverlay, diskJob, identityOf, inUse, refreshStored } from './disks.ts';
import { canonical, serialOf, type DiskRecord } from './shape.ts';
import { diskDir, overlayDir, type OverlayRecord, type Store } from './store.ts';

/**
 * What a merge of overlay `o` into its disk `d` is (§4.4): `stored`, its blocks written into the stored disk; for a
 * blank disk (§4.4 "A blank disk's overlay merged"), `grow` when nothing was ever written to the overlay (its
 * generation is 0: the disk grows to the overlay's size and stays blank), else `convert` (the disk becomes a stored
 * disk that holds the overlay's blocks). None: a URL, file or ramdisk can't be merged into.
 */
async function mergeHow(d: DiskRecord, o: OverlayRecord) {
  if (d.kind === 'stored') return 'stored' as const;
  if (d.kind !== 'blank') return undefined;
  return (await overlayMeta(overlayDir(o.id))).generation === 0 ? ('grow' as const) : ('convert' as const);
}

/**
 * Merges overlay `overlay` into its disk (§4.4). Into a stored disk: every other overlay of the disk is deleted (they
 * were over the old bytes), then its blocks go into the disk and its files away (in the worker; failed or interrupted,
 * the overlay's record stays and the disk's mark has the next merge of it, or the disk's next opening, finish it), then
 * its record. Into a blank disk: an overlay never written to grows the
 * disk to its size and is deleted (the other overlays stay: the disk still reads as zeros); one written to makes the
 * disk a stored disk of its blocks (the other overlays deleted, as above). Machines that had the deleted overlays
 * chosen are left without one. The caller confirmed `confirmed` (its `mergeEffect`): a merge that would differ from
 * it now (how, the size, an overlay to delete it didn't list: the overlay written, or one made, meanwhile) is refused.
 * Returns the blocks merged.
 */
export async function mergeIntoDisk(store: Store, overlay: string, confirmed: Confirmed): Promise<number> {
  const o = await store.get('overlays', overlay);
  if (!o) throw new MsgError('disks:disks.overlayGone');
  const d = await store.get('disks', o.disk);
  if (!d || !(await mergeHow(d, o))) throw new MsgError('disks:merge.onlyStored');
  // Held to the end: the disk surface's jobs wait for it (web/overlay.ts `mergeLock`).
  return navigator.locks.request(mergeLock(diskDir(d.id)), async () => {
    // Read again under the lock: another tab may have merged meanwhile, or a machine written the overlay.
    const [o2, d2] = [await store.get('overlays', overlay), await store.get('disks', o.disk)];
    if (!o2) throw new MsgError('disks:disks.overlayGone');
    const how = d2 && (await mergeHow(d2, o2));
    if (!d2 || !how) throw new MsgError('disks:merge.onlyStored');
    const others = how === 'grow' ? [] : (await store.overlaysOf(d2.id)).filter((x) => x.id !== o2.id);
    const listed = new Set(confirmed.others.map((x) => x.id));
    const size = Math.max(d2.size, o2.size ?? 0);
    if (how !== confirmed.how || size !== confirmed.size || others.some((x) => !listed.has(x.id)))
      throw new MsgError('disks:merge.changed');
    return how === 'grow' ? growBlank(store, o2, d2) : merge(store, o2, d2);
  });
}

/** What the user confirmed of a merge (its `mergeEffect`). */
type Confirmed = Pick<NonNullable<Awaited<ReturnType<typeof mergeEffect>>>, 'how' | 'others' | 'size'>;

/** Refused while one of `overlays`, or disk `d` itself, is open. */
async function noneInUse(d: DiskRecord, overlays: OverlayRecord[]) {
  for (const x of overlays)
    if (await inUse(overlayDir(x.id))) throw new MsgError('disks:merge.overlayNamedRunning', { name: x.name });
  if (await inUse(diskDir(d.id))) throw new MsgError('disks:merge.diskRunning');
}

/** Leaves the machines that had overlay `id` chosen without one (their next start makes an empty one). */
async function unchoose(store: Store, id: string) {
  for (const m of await store.all('machines')) {
    if (!m.attachments.some((a) => a.overlay === id)) continue;
    for (const a of m.attachments) if (a.overlay === id) a.overlay = undefined;
    await store.put('machines', { ...m, modified: Date.now() });
  }
}

/** `mergeIntoDisk`'s work into a stored disk, or into a blank disk made a stored one, under its lock. */
async function merge(store: Store, o: OverlayRecord, d: DiskRecord) {
  const others = (await store.overlaysOf(d.id)).filter((x) => x.id !== o.id);
  await noneInUse(d, [o, ...others]);
  for (const x of others) await deleteOverlay(store, x.id);
  if (d.kind === 'blank') return convertBlank(store, o, d);
  const size = await growForMerge(store, d, o);
  // The overlay's record stays until its blocks are in (the worker deletes its files then): failed or cut off partway,
  // its files outlive the sweep, and the disk's mark has the next merge of it, or the disk's next opening, finish it.
  try {
    const r = await diskJob({
      type: 'merge',
      disk: diskDir(d.id),
      overlay: overlayDir(o.id),
      identity: identityOf(d),
      size,
    });
    await store.forget('overlays', o.id);
    await unchoose(store, o.id);
    return r.blocks ?? 0;
  } finally {
    await refreshStored(store, d.id); // its generation moved at the mark
  }
}

/**
 * Blank disk `d` made a stored disk of overlay `o`'s blocks (its other overlays deleted already): its block store made
 * at `disks/<id>` with the overlay merged into it (the job of a stored disk's merge, into a store that starts empty),
 * then its record says `stored`, with a stored disk's identity (the machines that attach it see another disk: their
 * snapshots orphan), the overlay's size and its grow mark; then `o`'s record goes, and the machines that had it chosen
 * are left without one. A copy that fails (the storage full) leaves the overlay as it was, and the half-made store is
 * removed. The record after the bytes: cut off between the copy (which deletes the overlay's files) and the disk's
 * record, the disk is still blank, and what the overlay held is lost.
 */
async function convertBlank(store: Store, o: OverlayRecord, d: DiskRecord) {
  const size = Math.max(d.size, o.size ?? 0);
  const identity = { kind: 'stored' as const, id: d.id, bytes: 0 }; // as an import's: a stored disk is known by its id
  return store.writing(async () => {
    await removeOverlay(diskDir(d.id)); // what an earlier conversion, cut off, left
    let r;
    try {
      r = await diskJob({
        type: 'merge',
        disk: diskDir(d.id),
        overlay: overlayDir(o.id),
        identity: canonical(identity),
        size,
      });
    } catch (e) {
      await removeOverlay(diskDir(d.id)).catch(() => undefined); // tidying up: the failure thrown is the one to report
      throw e;
    }
    await store.put('disks', {
      ...d,
      kind: 'stored',
      identity,
      size,
      generation: (await overlayMeta(diskDir(d.id))).generation,
      bytes: await overlayBytes(diskDir(d.id)),
      ...(o.grow ? { grow: o.grow } : {}),
    });
    await store.forget('overlays', o.id); // its files went with the copy
    await unchoose(store, o.id);
    return r.blocks ?? 0;
  });
}

/**
 * Blank disk `d` grown by merging overlay `o`, never written to: the disk takes the overlay's size (its identity keeps
 * the size it was made with, so its other overlays still fit it), and `o` is deleted, unchosen. Nothing is copied: both
 * read as zeros. A machine that had `o` chosen gets an empty overlay at the disk's new size at its next start: what its
 * guest sees stays.
 */
async function growBlank(store: Store, o: OverlayRecord, d: DiskRecord) {
  await noneInUse(d, [o]);
  const size = Math.max(d.size, o.size ?? 0);
  if (size > d.size) await store.put('disks', { ...d, size });
  await deleteOverlay(store, o.id);
  return 0;
}

/**
 * A grown overlay grows its stored disk to its size before it is merged (§4.5; its grow mark goes with it), so that a
 * merge resumed at the disk's next opening copies at that size. The size merged at.
 */
async function growForMerge(store: Store, d: DiskRecord, o: OverlayRecord) {
  const size = Math.max(d.size, o.size ?? 0);
  if (size > d.size)
    await store.put('disks', { ...d, size, made: d.made ?? d.size, ...(o.grow ? { grow: o.grow } : {}) });
  return size;
}

/** What a merge of `overlay` deletes: the disk's other overlays (with their sizes). */
export async function mergeCosts(store: Store, overlay: string) {
  const o = await store.get('overlays', overlay);
  return o ? (await store.overlaysOf(o.disk)).filter((x) => x.id !== o.id) : [];
}

/**
 * What Merge into the disk of overlay `overlay` does, for its confirmation (§4.4): how (`mergeHow`), the overlays it
 * deletes, the size the disk will have, and the kept snapshots it leaves unrestorable or orphans. For a stored disk,
 * those over the disk or its overlays (its bytes change under them: §5.1 "Unrestorable"); for a blank disk made a
 * stored one, those of every machine that attaches it (another disk to their shape); for a blank disk grown, those of
 * the machines whose guest would see the disk at another size (an overlay of theirs smaller than the new size). None:
 * the overlay is gone, or its disk can't be merged into.
 */
export async function mergeEffect(store: Store, overlay: string) {
  const o = await store.get('overlays', overlay);
  const d = o && (await store.get('disks', o.disk));
  const how = o && d && (await mergeHow(d, o));
  if (!o || !d || !how) return undefined;
  const size = Math.max(d.size, o.size ?? 0);
  const mine = await store.overlaysOf(d.id);
  const others = how === 'grow' ? [] : mine.filter((x) => x.id !== o.id);
  const snapshots = await store.all('snapshots');
  const users = await store.machinesWith(d.id);
  if (how === 'stored') {
    const pinned = new Set([`disks/${d.id}`, ...mine.map((x) => overlayDir(x.id))]);
    const lost = snapshots.filter(
      (s) => s.pins.some((p) => p.overlay && pinned.has(p.overlay)) || (s.bases && d.id in s.bases),
    );
    return { how, others, size, snapshots: lost };
  }
  if (how === 'convert') {
    const ids = new Set(users.map((m) => m.id));
    return { how, others, size, snapshots: snapshots.filter((s) => ids.has(s.machine)) };
  }
  // Grown: what each attachment's guest sees now and after (the disk at `size`; `o` unchosen: an empty one at its size).
  const byId = new Map(mine.map((x) => [x.id, x]));
  const moved = users.flatMap((m) =>
    m.attachments.flatMap((a) => {
      if (a.disk !== d.id) return [];
      const was = sizeSeen(d, a, a.overlay ? byId.get(a.overlay) : undefined);
      const after = a.overlay === o.id ? { ...a, overlay: undefined } : a;
      const now = sizeSeen({ ...d, size }, after, after.overlay ? byId.get(after.overlay) : undefined);
      return now === was ? [] : [{ machine: m.id, serial: serialOf(a.id), was }];
    }),
  );
  const lost = snapshots.filter((s) =>
    moved.some((x) => x.machine === s.machine && s.shape.disks.some((y) => y.serial === x.serial && y.size === x.was)),
  );
  return { how, others, size, snapshots: lost };
}
