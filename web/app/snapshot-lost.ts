// Which snapshots can never be restored (docs/machines.md §5.1 "Unrestorable"): one judgment (`lost`) over the stored
// disks' generations read from their files (`watchGenerations` while a list is shown), which the snapshot lists show
// and the restore refuses by (web/app/snapshots.ts `unrestorable`, `planRestore`), so the lists say it before a
// restore would; and the stored disks a snapshot is taken over (`basesOf`, `basesIn`).
import { overlayMeta } from '../overlay.ts';
import { SNAPSHOT_VERSION, type SnapshotHeader } from '../snapshot-file.ts';
import type { SnapshotDisk } from '../snapshot.ts';
import type { DiskRecord, MachineRecord } from './shape.ts';
import { diskDir } from './store.ts';

/**
 * The generations of the stored disks machine `m` reads, by disk id (§5.1 "Unrestorable"): those attached read-only or
 * under an overlay, from their files (one written in place is pinned instead). A running machine holds them open, so
 * none moves while it runs: a snapshot's are its start's. None: no such disk.
 */
export async function basesOf(m: MachineRecord, disks: (id: string) => DiskRecord | undefined) {
  const out: Record<string, number> = {};
  for (const a of m.attachments) {
    const d = disks(a.disk);
    // Written in place only when not read-only (as the device: web/app/run/page-disks.ts), a mark left or not.
    if (d?.kind === 'stored' && !(a.inPlace && !a.readOnly)) out[d.id] = (await overlayMeta(diskDir(d.id))).generation;
  }
  return Object.keys(out).length ? out : undefined;
}

/** A header's `bases` (`basesOf`, written by the machine worker: web/app/worker-header.ts), where it has them whole. */
export function basesIn(header: SnapshotHeader): Record<string, number> | undefined {
  const b = header.bases;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return undefined;
  const entries = Object.entries(b as Record<string, unknown>);
  return entries.every(([, g]) => Number.isSafeInteger(g)) ? (b as Record<string, number>) : undefined;
}

/**
 * The snapshot format a kept snapshot's record from before records kept theirs was written in, at most (`coreVersion`
 * absent): the core's then. One older than it can't restore either, but isn't told apart.
 */
export const RECORDED_FROM = 6;

/** What a snapshot's restore depends on besides its shape: its core's format, the stored disks under it, its pins. */
type Depends = {
  coreVersion?: number;
  bases?: Record<string, number>;
  pins: Pick<SnapshotDisk, 'overlay' | 'generation' | 'blocks'>[];
};
/** Why a snapshot can never be restored (`lost`): another core's format, or a stored disk (by id) that moved on. */
export type Lost = { why: 'version'; format: number } | { why: 'base' | 'inPlace'; disk: string };

/** The stored disk pin `p` names written in place (`disks/<id>`), if it does. */
export const inPlaceDisk = (p: Pick<SnapshotDisk, 'overlay'>) =>
  p.overlay?.startsWith('disks/') ? p.overlay.slice('disks/'.length) : undefined;

/**
 * Why snapshot `s` can never be restored, whatever is done to its machine (§5.1 "Unrestorable"): made by another core's
 * snapshot format; a stored disk it was taken over written in place or merged into since (`bases`); a disk it pinned
 * written in place, moved on since, and not in the file whole. `generation` is a stored disk's generation **from its
 * files** (`diskGenerations`; none: not checked): a machine writing a disk in place moves them at its first write,
 * while the disk's record follows only at the run's end (`refreshStored`). The one judgment the snapshot lists
 * (`unrestorable`) and the restore (`planRestore`) make, so the list says it before a restore would refuse it. Its
 * shape is checked apart (`orphaned`).
 */
export function lost(s: Depends, generation: (disk: string) => number | undefined): Lost | undefined {
  if (s.coreVersion !== undefined && s.coreVersion !== SNAPSHOT_VERSION)
    return { why: 'version', format: s.coreVersion };
  const moved = (id: string, pinned: number) => {
    const now = generation(id);
    return now !== undefined && now !== pinned;
  };
  for (const [id, g] of Object.entries(s.bases ?? {})) if (moved(id, g)) return { why: 'base', disk: id };
  for (const p of s.pins) {
    const id = inPlaceDisk(p);
    if (id && p.blocks === 0 && moved(id, p.generation ?? 0)) return { why: 'inPlace', disk: id };
  }
  return undefined;
}

/** The stored disks `lost` reads the generations of for snapshots `snaps`: their bases and the disks they pin in place. */
export function dependsOn(snaps: Iterable<Depends>) {
  const ids = new Set<string>();
  for (const s of snaps) {
    for (const id of Object.keys(s.bases ?? {})) ids.add(id);
    for (const p of s.pins) {
      const id = inPlaceDisk(p);
      if (id) ids.add(id);
    }
  }
  return [...ids].sort();
}

/** Stored disks `ids`' generations from their files (each its `meta`'s first 8 bytes: cheap, and readable while a machine writes it). */
export async function diskGenerations(ids: Iterable<string>) {
  const out = new Map<string, number>();
  for (const id of ids) out.set(id, (await overlayMeta(diskDir(id))).generation);
  return out;
}

/** How often an open snapshot list reads its disks' generations again (a machine may be writing one in place meanwhile). */
export const GENERATIONS_MS = 2000;

/**
 * Reads stored disks `ids`' generations now and every `GENERATIONS_MS` until the returned function is called, giving
 * each read that differs from the last to `set` (the snapshot lists, while shown: Snapshots.svelte,
 * LoadSnapshotMenu.svelte). A read that fails is tried again at the next tick.
 */
export function watchGenerations(ids: string[], set: (g: Map<string, number>) => void) {
  let last = '';
  let live = true;
  const read = () =>
    diskGenerations(ids)
      .then((g) => {
        const key = JSON.stringify([...g]);
        if (live && key !== last) {
          last = key;
          set(g);
        }
      })
      .catch(() => undefined);
  void read();
  const timer = ids.length ? setInterval(() => void read(), GENERATIONS_MS) : undefined;
  return () => {
    live = false;
    clearInterval(timer);
  };
}
