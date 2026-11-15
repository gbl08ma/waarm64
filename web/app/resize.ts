// Growing a disk (docs/machines.md §4.5): an overlay's own size, a stored disk's or a ramdisk's, grow only and with the
// machines that use it off; what the confirmation says (the machines whose disk grows, those running, the snapshots it
// orphans), and the grow mark the guest follows at its next start. Records go through web/app/store.ts, an overlay's
// size into its meta file first (web/overlay.ts `writeOwnSize`: the device worker reads it there). Nothing here asks the
// user: the Machines page confirms first. DOM-free but for Web Locks (Node's tests have them).
import { MsgError } from '../msg.ts';
import { lockOverlay, overlayLock, writeOwnSize } from '../overlay.ts';
import { machineLock } from './machines.ts';
import { SECTOR, sizeSeen, type GrowMark } from './disk-size.ts';
import { serialOf, type Attachment, type DiskRecord, type MachineRecord } from './shape.ts';
import { diskDir, overlayDir, type SnapshotRecord, type Store } from './store.ts';

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
 * The largest size a resize grows to: an overlay keeps its map in memory, 4 bytes per 4 KiB block of its whole size
 * (1 GiB per TiB), so the size is capped where that stays modest.
 */
export const MAX_RESIZE = 256 * 1024 ** 3;

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
async function lockFor(path: string | undefined) {
  if (!path) return () => undefined; // a ramdisk: its machines' locks are what tells
  const inUse = () => refused(new MsgError('machines:resize.inUse'));
  if ((await locksHeld()).has(overlayLock(path))) throw inUse();
  return lockOverlay(path, RESIZE_WAIT_MS).catch((e: unknown) => {
    throw (e as { problem?: string }).problem === 'overlay-in-use' ? inUse() : e;
  });
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
  const { o, d } = await target(store, t);
  const mark = (had: GrowMark | undefined) => ({
    grow: opts.grow ? { from: had?.from ?? costs.size, to: size } : undefined,
  });
  const release = await lockFor(o ? overlayDir(o.id) : d.kind === 'stored' ? diskDir(d.id) : undefined);
  try {
    if (o) {
      await writeOwnSize(overlayDir(o.id), size); // the bytes first: the device worker reads it there
      await store.put('overlays', { ...o, size, modified: Date.now(), ...mark(o.grow) });
    } else await store.put('disks', { ...d, size, ...(d.kind === 'stored' ? mark(d.grow) : {}) });
  } finally {
    release();
  }
  return costs;
}

/** The grow `t` has pending in its guest, if any. */
export async function growMark(store: Store, t: ResizeTarget): Promise<GrowMark | undefined> {
  return 'overlay' in t ? (await store.get('overlays', t.overlay))?.grow : (await store.get('disks', t.disk))?.grow;
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
