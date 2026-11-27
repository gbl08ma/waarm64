// The forks a restore plans with (docs/machines.md §5.2, web/app/snapshots.ts): an earlier fork of the snapshot to
// attach again, the grow mark a new one carries, and whether an attached overlay holds nothing (a template's first restore).
import { overlayMeta } from '../overlay.ts';
import type { GrowMark } from './disk-size.ts';
import type { DiskRecord } from './shape.ts';
import { overlayDir, type OverlayRecord, type Store } from './store.ts';

/**
 * An earlier fork of snapshot `key` from disk `d` that hasn't moved since, at the size the snapshot had (`size`: a fork
 * grown since is another disk to the guest): attached again rather than forking once more. Never one in `taken`:
 * another machine's (it would write the fork that machine runs on), or one a restore that hasn't loaded names (its
 * machine's next load may delete it, put that machine back on it, or it is being written).
 */
export async function earlierFork(store: Store, d: DiskRecord, key: string, size: number, taken: ReadonlySet<string>) {
  for (const o of await store.overlaysOf(d.id)) {
    if (o.fork?.snapshot !== key || taken.has(o.id) || Math.max(d.size, o.size ?? 0) !== size) continue;
    // One whose fill was cut off (still marked) holds part of the snapshot at the fork's generation: not reused.
    const meta = await overlayMeta(overlayDir(o.id));
    if (meta.generation === o.fork.generation && !meta.filling) return { id: o.id, generation: o.fork.generation };
  }
  return undefined;
}

/**
 * The grow mark a new fork of the snapshot carries (§4.5): the pinned overlay's, where it still stands and the snapshot
 * was taken past its `from` (after the resize, its guest not having grown into it: a standing mark means no run since
 * did), up to the size the snapshot had. None otherwise (taken before the resize, or the guest grew it).
 */
export async function forkMark(store: Store, pinned: string, size: number): Promise<GrowMark | undefined> {
  const id = pinned.startsWith('overlays/') ? pinned.slice('overlays/'.length) : undefined;
  const g = id ? (await store.get('overlays', id))?.grow : undefined;
  return g && size > g.from && size <= g.to ? { from: g.from, to: size } : undefined;
}

/**
 * Whether overlay `o` holds nothing (its files' generation 0: never written, the device bumps it before an opening's
 * first change, §3.3; or marked as a cut-off fill: read as empty, a template's first restore undone) and the guest sees
 * it at the size the snapshot had: a fork into it loses nothing.
 */
export async function pristine(o: OverlayRecord, step: { disk: DiskRecord; size: number }) {
  if (Math.max(step.disk.size, o.size ?? 0) !== step.size) return false;
  const meta = await overlayMeta(overlayDir(o.id));
  return meta.generation === 0 || !!meta.filling;
}
