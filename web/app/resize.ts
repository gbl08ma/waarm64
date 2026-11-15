// Growing a disk (docs/machines.md §4.5): an overlay's own size, a stored disk's or a ramdisk's, grow only and with the
// machines that use it off; what the confirmation says (the machines whose disk grows, those running, the snapshots it
// orphans), and the grow mark the guest follows at its next start (`growsOf`, `growFailed`, `clearGrowMark`: the run's
// agent, web/app/areas/grow-actions.ts); a definition's grown overlay (`grownSize`, `withGrownOverlay`). Records go
// through web/app/store.ts, an overlay's size into its meta file first (web/overlay.ts `writeOwnSize`: the device worker
// reads it there). Nothing here asks the user: the Machines page confirms first. DOM-free but for Web Locks (Node's
// tests have them).
import { t } from '../i18n.ts';
import { MsgError } from '../msg.ts';
import { lockOverlay, overlayLock, writeOwnSize } from '../overlay.ts';
import { machineLock } from './machines.ts';
import { SECTOR, sizeSeen, type GrowMark } from './disk-size.ts';
import { newId, serialOf, type Attachment, type DiskRecord, type MachineRecord } from './shape.ts';
import { diskDir, overlayDir, type OverlayRecord, type SnapshotRecord, type Store } from './store.ts';

/** What a resize acts on: an overlay (over any base), or a disk (stored in the browser, or a ramdisk). */
export type ResizeTarget = { overlay: string } | { disk: string };

/** What growing a disk or an overlay to a size does, for the confirmation. */
export type ResizeCosts = {
  /** The size now: a disk's, or what an overlay's guests see (the larger of its own and its disk's). */
  size: number;
  /** The machines whose disk grows (their shape changes). */
  machines: MachineRecord[];
  /** Those of them that run now (in any tab): the resize is refused while one does. */
  running: MachineRecord[];
  /** Their kept snapshots made with the disk at its size now: the resize orphans them (§5.1). */
  snapshots: SnapshotRecord[];
};

/**
 * The largest size a resize grows to, 8 TiB: what a changes-only or whole qcow2 export of the disk can be (its 4 KiB
 * clusters and QEMU's 32 MiB L1 table: `qemu-img` refuses 8 TiB + 1 GiB). An overlay's map grows with what's written
 * (web/overlay.ts), and the top table it keeps in memory is 4 bytes per 4 MiB (8 MiB here); its u32 slots would hold
 * 16 TiB of written blocks, and the blk device and JS numbers go far past it.
 */
export const MAX_RESIZE = 8 * 1024 ** 4;

/** How long a resize waits for an overlay's or a stored disk's lock (a machine stopping, an export) before it is refused. */
const RESIZE_WAIT_MS = 2_000;

/** A resize refused: the headline, and why (`cause`). */
const refused = (cause: MsgError) => new MsgError('machines:resize.failed', undefined, { cause });

/** The Web Locks held or asked for now, by name, in every tab (none where there are no Web Locks). */
async function locksHeld() {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a probe: no Web Locks in some contexts
  if (typeof navigator === 'undefined' || !navigator.locks) return new Set<string>();
  const q = await navigator.locks.query();
  return new Set([...(q.held ?? []), ...(q.pending ?? [])].flatMap((l) => (l.name ? [l.name] : [])));
}

/** The overlay or disk a resize acts on, and the size its guests see now. */
async function target(store: Store, t: ResizeTarget) {
  const gone = () => refused(new MsgError('machines:resize.gone'));
  if ('overlay' in t) {
    const o = await store.get('overlays', t.overlay);
    const d = o && (await store.get('disks', o.disk));
    if (!o || !d) throw gone();
    return { o, d, size: Math.max(d.size, o.size ?? 0) };
  }
  const d = await store.get('disks', t.disk);
  if (!d) throw gone();
  if (d.kind !== 'stored' && d.kind !== 'ramdisk') throw refused(new MsgError('machines:resize.notResizable'));
  return { o: undefined, d, size: d.size };
}

/** The size `t`'s guests see now (refused, as `resizeCosts`, when it's gone or can't be resized). */
export const sizeNow = async (store: Store, t: ResizeTarget) => (await target(store, t)).size;

/**
 * What growing `t` to `size` bytes does: the size now, the machines whose disk grows (an overlay's: those that have it
 * chosen; a disk's: those that attach it, unless their overlay is as large already), those of them running, and their
 * kept snapshots it orphans. Refused (a `MsgError`) when `size` isn't a larger multiple of 512 bytes (`SECTOR`: the
 * blk device's sector, and what QEMU asks of a qcow2's size), is past `MAX_RESIZE`, or `t` can't be resized (a URL's, a file's or a blank disk
 * itself: their overlays grow).
 */
export async function resizeCosts(store: Store, t: ResizeTarget, size: number): Promise<ResizeCosts> {
  const { o, d, size: now } = await target(store, t);
  if (!Number.isSafeInteger(size) || size % SECTOR)
    throw refused(new MsgError('machines:resize.unaligned', { size, sector: SECTOR }));
  if (size <= now) throw refused(new MsgError('machines:resize.notLarger', { size, now }));
  if (size > MAX_RESIZE) throw refused(new MsgError('machines:resize.tooLarge', { size, max: MAX_RESIZE }));
  const before = new Map((await store.overlaysOf(d.id)).map((x) => [x.id, x]));
  const after = new Map(before);
  if (o) after.set(o.id, { ...o, size });
  const grown = o ? d : { ...d, size };
  const machines: MachineRecord[] = [];
  /** By machine and serial: the size its snapshots have the disk at now. */
  const was = new Map<string, number>();
  for (const m of await store.machinesWith(d.id)) {
    let grows = false;
    for (const a of m.attachments) {
      if (a.disk !== d.id) continue;
      const x = sizeSeen(d, a, a.overlay ? before.get(a.overlay) : undefined);
      if (x === sizeSeen(grown, a, a.overlay ? after.get(a.overlay) : undefined)) continue;
      grows = true;
      was.set(`${m.id}/${serialOf(a.id)}`, x);
    }
    if (grows) machines.push(m);
  }
  machines.sort((a, b) => a.name.localeCompare(b.name)); // the store's order isn't stable; the confirmation lists them
  const held = await locksHeld();
  const snapshots = (await store.all('snapshots')).filter((s) =>
    s.shape.disks.some((x) => was.get(`${s.machine}/${x.serial}`) === x.size),
  );
  return { size: now, machines, running: machines.filter((m) => held.has(machineLock(m.id))), snapshots };
}

/**
 * What Resize… on a machine's attachment `a` of disk `d` grows: its ramdisk, its stored disk written in place, or its
 * chosen overlay; none for a read-only attachment, or one with no overlay chosen yet.
 */
export function attachmentTarget(a: Attachment, d: DiskRecord | undefined): ResizeTarget | undefined {
  if (!d || a.readOnly) return undefined;
  if (d.kind === 'ramdisk' || (d.kind === 'stored' && a.inPlace)) return { disk: d.id };
  return a.overlay ? { overlay: a.overlay } : undefined;
}

/** Takes overlay or stored disk `path`'s lock (no machine opens it meanwhile), or refuses: something has it open. */
async function lockFor(path: string) {
  const inUse = () => refused(new MsgError('machines:resize.inUse'));
  if ((await locksHeld()).has(overlayLock(path))) throw inUse();
  return lockOverlay(path, RESIZE_WAIT_MS).catch((e: unknown) => {
    throw (e as { problem?: string }).problem === 'overlay-in-use' ? inUse() : e;
  });
}

/**
 * Takes the machine locks of `machines` (a ramdisk's: it has no files of its own to lock), each only if it's free, so
 * that none of them starts while its ramdisk's record changes (a start takes its machine's lock the same way); or
 * refuses, naming those that run.
 */
async function lockMachines(machines: MachineRecord[]) {
  const releases: (() => void)[] = [];
  const release = () => releases.forEach((r) => r());
  const busy: MachineRecord[] = [];
  for (const m of machines) {
    const held = await new Promise<(() => void) | undefined>((got) => {
      void navigator.locks.request(machineLock(m.id), { ifAvailable: true }, (l) => {
        if (!l) return got(undefined);
        return new Promise<void>((done) => got(done));
      });
    });
    if (held) releases.push(held);
    else busy.push(m);
  }
  if (busy.length) {
    release();
    throw refused(new MsgError('machines:resize.running', { machines: busy.map((m) => m.name), count: busy.length }));
  }
  return release;
}

/**
 * Grows `t` to `size` bytes: an overlay's own size (its meta file, then its record), or a stored disk's or a ramdisk's
 * record (their identity keeps the size they were made with). Grow only, its machines off: `resizeCosts` refuses what
 * it refuses; a machine running, or the overlay or stored disk open, refuses it too (the lock Merge into the disk
 * takes). `grow`: the guest grows its partition and filesystem at its next start (the mark, {@link GrowMark}, from the
 * size before the first resize it hasn't followed; an overlay's or a stored disk's: a ramdisk is empty at every
 * start); without it, a mark there was is cleared (the dialog's box is the user's latest word). Returns `resizeCosts`'s.
 */
export async function resize(store: Store, t: ResizeTarget, size: number, opts: { grow?: boolean } = {}) {
  const costs = await resizeCosts(store, t, size);
  if (costs.running.length)
    throw refused(
      new MsgError('machines:resize.running', {
        machines: costs.running.map((m) => m.name),
        count: costs.running.length,
      }),
    );
  const first = await target(store, t);
  const release =
    first.o || first.d.kind === 'stored'
      ? await lockFor(first.o ? overlayDir(first.o.id) : diskDir(first.d.id))
      : await lockMachines(await store.machinesWith(first.d.id));
  try {
    // Read again under the lock: what changed while it was waited for (a merge forgot the overlay, a rename) counts.
    const { o, d, size: now } = await target(store, t);
    if (size <= now) throw refused(new MsgError('machines:resize.notLarger', { size, now })); // grown meanwhile
    const mark = (had: GrowMark | undefined) => ({
      grow: opts.grow ? { from: had?.from ?? costs.size, to: size } : undefined,
    });
    if (o) {
      const dir = overlayDir(o.id);
      await writeOwnSize(dir, size); // the bytes first: the device worker reads it there
      try {
        await store.put('overlays', { ...o, size, modified: Date.now(), ...mark(o.grow) });
      } catch (e) {
        // The record refused: the meta back to what it says, or the guest would see a size the records don't.
        await writeOwnSize(dir, o.size ?? 0).catch(() => undefined); // the failure thrown is the one to report
        throw e;
      }
    } else
      await store.put('disks', {
        ...d,
        size,
        ...(d.kind === 'stored' ? { made: d.made ?? d.size, ...mark(d.grow) } : {}),
      });
  } finally {
    release();
  }
  return costs;
}

/** What a definition carries of attachment `a` of disk `d` through overlay `o` (§6): its own size, where past the disk's. */
export const grownSize = (d: DiskRecord, a: Attachment, o?: { size?: number }) =>
  !a.readOnly && !a.inPlace && d.kind !== 'ramdisk' && (o?.size ?? 0) > d.size ? o?.size : undefined;

/** Whether `v` is a size a definition's disk of `size` bytes may carry (`grownSize`): larger, in whole sectors, at most `MAX_RESIZE`. */
export const validGrownSize = (v: unknown, size: number) =>
  Number.isSafeInteger(v) && (v as number) > size && (v as number) <= MAX_RESIZE && (v as number) % SECTOR === 0;

/**
 * Attachment `a` of disk `d`, made from a definition that carries its overlay's `size` (`grownSize`): given an empty
 * overlay at that size (its meta first: the device worker reads the size there; then its record), marked to grow (the
 * base's last partition and filesystem don't fill the new space). As it is without a size past the disk's.
 */
export async function withGrownOverlay(store: Store, d: DiskRecord, a: Attachment, size: number | undefined) {
  if (!size || grownSize(d, a, { size }) === undefined) return a;
  const now = Date.now();
  const o: OverlayRecord = {
    id: newId(),
    name: t('disks:page-disks.overlayName'),
    disk: d.id,
    identity: d.identity,
    generation: 0,
    bytes: 0,
    created: now,
    modified: now,
    size,
    grow: { from: d.size, to: size },
  };
  await writeOwnSize(overlayDir(o.id), size);
  await store.put('overlays', o);
  return { ...a, overlay: o.id };
}

/** The grow `t` has pending in its guest, if any. */
export async function growMark(store: Store, t: ResizeTarget): Promise<GrowMark | undefined> {
  return 'overlay' in t ? (await store.get('overlays', t.overlay))?.grow : (await store.get('disks', t.disk))?.grow;
}

/** Notes on `t`'s grow mark that the guest's grow failed once (`GrowMark.failed`): kept for the next start. */
export async function growFailed(store: Store, t: ResizeTarget) {
  if ('overlay' in t) {
    const o = await store.get('overlays', t.overlay);
    if (o?.grow) await store.put('overlays', { ...o, grow: { ...o.grow, failed: true } });
  } else {
    const d = await store.get('disks', t.disk);
    if (d?.grow) await store.put('disks', { ...d, grow: { ...d.grow, failed: true } });
  }
}

/** A disk of a machine whose guest is to grow it (GROW): its serial, its name, the size the guest sees, the marks it clears. */
export type GrowDisk = {
  serial: string;
  name: string;
  size: number;
  /** The marked records under the attachment: its overlay, its stored disk (written in place, or under the overlay), or both. */
  marks: { target: ResizeTarget; mark: GrowMark }[];
};

/**
 * Machine `id`'s writable disks whose overlay or stored disk carries a grow mark, read from the records now (a restore
 * may have attached a fork since the start). A stored disk's mark is the disk's: through the overlay of whichever
 * machine boots it first with the agent (that overlay takes the grown table; the disk itself, and other machines'
 * overlays over it, don't). None for a read-only attachment, a ramdisk, an overlay not made yet.
 */
export async function growsOf(store: Store, id: string): Promise<GrowDisk[]> {
  const m = await store.get('machines', id);
  const out: GrowDisk[] = [];
  for (const a of m?.attachments ?? []) {
    const g = await growOf(store, a);
    if (g) out.push(g);
  }
  return out;
}

/**
 * A stored disk's mark, as a guest that sees it through overlay `o` (none: in place) follows it: only where the disk's
 * size is what that guest sees (an overlay larger already hid the disk's growth: its guest saw no change).
 */
const diskMark = (d: DiskRecord, o: OverlayRecord | undefined) =>
  d.kind === 'stored' && (o?.size ?? 0) < d.size ? d.grow : undefined;

/** Attachment `a`'s marks, if it has any (`growsOf`). */
async function growOf(store: Store, a: Attachment): Promise<GrowDisk | undefined> {
  const d = await store.get('disks', a.disk);
  if (!d || a.readOnly || d.kind === 'ramdisk') return undefined;
  const inPlace = d.kind === 'stored' && !!a.inPlace;
  const o = !inPlace && a.overlay ? await store.get('overlays', a.overlay) : undefined;
  if (!inPlace && !o) return undefined;
  const marks: GrowDisk['marks'] = [];
  if (o?.grow) marks.push({ target: { overlay: o.id }, mark: o.grow });
  const disk = diskMark(d, o);
  if (disk) marks.push({ target: { disk: d.id }, mark: disk });
  return marks.length ? { serial: serialOf(a.id), name: d.name, size: sizeSeen(d, a, o), marks } : undefined;
}

/** Clears `t`'s grow mark (the guest did it, or said why not). */
export async function clearGrowMark(store: Store, t: ResizeTarget) {
  if ('overlay' in t) {
    const o = await store.get('overlays', t.overlay);
    if (o?.grow) await store.put('overlays', { ...o, grow: undefined });
  } else {
    const d = await store.get('disks', t.disk);
    if (d?.grow) await store.put('disks', { ...d, grow: undefined });
  }
}

/**
 * Overlay `o`, new and nobody's yet (an empty one, changes just imported), grown to `size` where its guest would see
 * less (its meta, then its record): it keeps the size its attachment's guest saw (§4.5), so the machine's shape, and
 * its snapshots, stay as they were. Marked to grow from what it holds (its partition fills at most that). Returns it.
 */
export async function keepSize(store: Store, o: OverlayRecord, size: number): Promise<OverlayRecord> {
  const d = await store.get('disks', o.disk);
  const had = Math.max(d?.size ?? 0, o.size ?? 0);
  if (size <= had) return o;
  await writeOwnSize(overlayDir(o.id), size);
  const grown = { ...o, size, grow: { from: had, to: size } };
  await store.put('overlays', grown);
  return grown;
}

/**
 * The kept snapshots of machine `machine` that its attachment `attachment` orphans by seeing its disk through `to` (an
 * overlay switched to, or changes of a disk of `size` imported: kept at least at the size now, `keepSize`) at another
 * size than now (§5.1: the size is in the shape): those made at the size it sees now. None when the size stays.
 */
export async function sizeOrphans(
  store: Store,
  machine: string,
  attachment: string,
  to: { overlay: string } | { size: number },
) {
  const m = await store.get('machines', machine);
  const a = m?.attachments.find((x) => x.id === attachment);
  const d = a && (await store.get('disks', a.disk));
  if (!a || !d) return [];
  const now = sizeSeen(d, a, a.overlay ? await store.get('overlays', a.overlay) : undefined);
  const after =
    'size' in to
      ? Math.max(now, to.size)
      : sizeSeen(d, { ...a, overlay: to.overlay }, await store.get('overlays', to.overlay));
  if (after === now) return [];
  const serial = serialOf(a.id);
  return (await store.snapshotsOf(machine)).filter((s) =>
    s.shape.disks.some((x) => x.serial === serial && x.size === now),
  );
}
