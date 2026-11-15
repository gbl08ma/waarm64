// A new machine like a kept snapshot's (docs/machines.md §5.1 "Create a machine like it"): its settings and disks from
// the snapshot's shape, each disk the browser has attached again by identity, the rest made again, at the sizes the
// snapshot had (a grown overlay's, §4.5). Nothing here asks the user; the Snapshots tab does.
import { MsgError, t } from '../i18n.ts';
import { withGrownOverlay } from './resize.ts';
import { canonical, macsOf, newId, uniqueName, type DiskRecord, type MachineRecord, type Shape } from './shape.ts';
import { moveSnapshot } from './snapshots.ts';
import type { Store } from './store.ts';

/**
 * A disk of a snapshot's shape the browser doesn't have, made again: a blank disk or ramdisk under its id, a URL disk
 * from the snapshot's URLs (`urls`), a file disk to be picked again; a stored disk can't be.
 */
function diskLike(sd: Shape['disks'][number], urls: Record<number, string> | undefined, now: number): DiskRecord {
  const i = sd.identity;
  const base = { size: sd.size, created: now };
  switch (i.kind) {
    case 'stored':
      throw new MsgError('snapshots:machine-like.storedDiskGone', undefined, {
        cause: new MsgError('snapshots:machine-like.storedDiskGone.cause'),
      });
    case 'url':
      return {
        id: newId(),
        kind: 'url',
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- a path ending in '/' names no file
        name: i.path.split('/').pop() || t('snapshots:machine-like.urlDisk'),
        url: urls?.[sd.slot] ?? i.path,
        identity: i,
        ...base,
      };
    case 'file':
      return { id: newId(), kind: 'file', name: i.name, identity: i, ...base };
    default:
      return {
        id: i.id,
        kind: i.kind,
        name: i.kind === 'blank' ? t('snapshots:machine-like.blankDisk') : t('snapshots:machine-like.ramdisk'),
        identity: i,
        ...base,
      };
  }
}

/**
 * The disk of the browser's `disks` a snapshot's shape disk `sd` is attached as (by identity, at its size where several
 * are), or one made again (`diskLike`, then kept in `disks`). A ramdisk grown since (§4.5) is another of the size the
 * snapshot had, under the same identity (empty at every start: nothing of it is shared); a stored disk grown since
 * can't be seen smaller, and is refused.
 */
async function likeDisk(
  store: Store,
  disks: DiskRecord[],
  sd: Shape['disks'][number],
  urls: Record<number, string> | undefined,
  now: number,
) {
  const want = canonical(sd.identity);
  const same = disks.filter((x) => canonical(x.identity) === want);
  const d = same.find((x) => x.size === sd.size) ?? same.at(0);
  if (d?.kind === 'stored' && d.size > sd.size)
    throw new MsgError('snapshots:machine-like.storedDiskGone', undefined, {
      cause: new MsgError('snapshots:machine-like.storedDiskGrown.cause', { disk: d.name }),
    });
  if (d && !(d.kind === 'ramdisk' && d.size !== sd.size)) return d;
  const made = diskLike(sd, urls, now);
  const fresh = disks.some((x) => x.id === made.id) ? { ...made, id: newId() } : made;
  await store.put('disks', fresh);
  disks.push(fresh);
  return fresh;
}

/**
 * A new machine like the one snapshot `snap` was taken of (§5.1 "Make a machine like it"): its settings and disks from
 * the shape, each disk the browser has (by identity) attached again, a blank disk or ramdisk made again under its id,
 * a URL disk from the snapshot's URLs; a file disk is recorded to be picked again; a stored disk the browser no longer
 * has can't be made. The attachments take the snapshot's serials, so the shape is the snapshot's. The snapshot moves
 * to the new machine. Returns it.
 */
export async function machineLike(
  store: Store,
  snap: { id: string; machine: string; name: string; shape: Shape; urls?: Record<number, string> },
): Promise<MachineRecord> {
  const disks = await store.all('disks');
  const now = Date.now();
  const attachments: MachineRecord['attachments'] = [];
  for (const sd of snap.shape.disks) {
    const d = await likeDisk(store, disks, sd, snap.urls, now);
    const a = {
      id: sd.serial.replace(/^waarm64-/, ''),
      disk: d.id,
      readOnly: sd.readOnly,
      ...(sd.swap && d.kind === 'ramdisk' ? { swap: true as const } : {}),
    };
    // Seen larger than its disk: through a grown overlay (§4.5), an empty one at that size as a definition's.
    attachments.push(await withGrownOverlay(store, d, a, sd.size));
  }
  const taken = (await store.all('machines')).map((m) => m.name);
  const m: MachineRecord = {
    id: newId(),
    name: uniqueName(t('snapshots:machine-like.like', { name: snap.name }), taken),
    ncpus: snap.shape.ncpus,
    ramMiB: snap.shape.ramMiB,
    ...(snap.shape.split ? { ramSplit: snap.shape.split } : {}),
    display: snap.shape.display === '3d' ? '3d' : '2d',
    adapters: macsOf(snap.shape).map((mac) => ({ id: newId(), mac })),
    usb: snap.shape.usb === true,
    mouse: snap.shape.devices.includes('mouse'),
    touch: snap.shape.devices.includes('touch'),
    clock: snap.shape.devices.includes('clock'),
    ...(snap.shape.devices.includes('9p') ? { shares: true } : {}),
    ...(snap.shape.jitMiB ? { jitMiB: snap.shape.jitMiB } : {}),
    attachments,
    created: now,
    modified: now,
  };
  await store.put('machines', m);
  await moveSnapshot(store, snap.id, m.id);
  return m;
}
