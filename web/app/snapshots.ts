// Snapshots of stored machines on the page (docs/machines.md §5): the machine's shape now (what its snapshots are
// checked against), which kept snapshots it orphans, and the plan of a restore: per writable disk, **keep** its overlay
// when it is exactly as the snapshot pinned it (nothing is written), else **fork** (a new overlay, named after the
// snapshot, takes its blocks and is attached; the old one stays as it was), reusing an earlier fork of the same
// snapshot that hasn't moved since; or, when the user asks, **replace** (the attached overlay takes the blocks). A
// disk written in place keeps only at its pinned generation; otherwise a file with its whole disk forks it into an
// overlay, and one without is refused (§4.4). Nothing here asks the user; the page and the Machines page confirm first.
import { opfsDir, overlayMeta, storageFullError } from '../overlay.ts';
import { makeRoom } from '../diskcache.ts';
import { openSnapshot } from '../snapshot-file.ts';
import type { DiskPlan, SnapshotDisk } from '../snapshot.ts';
import { createOverlay, identityOf } from './disks.ts';
import {
  adaptersOf,
  canonical,
  CPU_DEFAULT,
  macsOf,
  newId,
  shapeHash,
  shapeOf,
  slots,
  uniqueName,
  type CpuFeature,
  type DeviceKind,
  type DiskRecord,
  type Display,
  type MachineRecord,
  type Shape,
} from './shape.ts';
import { overlayDir, snapshotPath, type Store } from './store.ts';
import { msg, MsgError, t, type Msg } from '../i18n.ts';

/** The machine's shape and its hash as it would run now (its disks by id). */
export async function currentShape(
  m: MachineRecord,
  disks: (id: string) => DiskRecord | undefined,
  opts: { display?: Display | 'none'; cpu?: CpuFeature[]; vulkan?: boolean } = {},
): Promise<{ shape: Shape; hash: string }> {
  const shape = shapeOf(m, disks, { display: opts.display, cpu: opts.cpu ?? CPU_DEFAULT, vulkan: opts.vulkan });
  return { shape, hash: await shapeHash(shape) };
}

/** What a restore will do, in words for the confirmation, and how to make it so (`commit`). */
export type RestorePlan = {
  /** Disks whose overlay is kept as it is. */
  kept: string[];
  /** Disks whose state forks: the snapshot's blocks go into a new overlay (or an earlier unmoved fork is attached again). */
  forks: { disk: string; reused: boolean; replaceable?: { overlay: string; name: string; bytes: number } }[];
  /** Why it can't restore (a disk written in place moved on, and the file hasn't the whole disk). */
  refused?: Msg;
  /**
   * Plans again as the overlays are now (call it once the machine stopped), creates what that needs (fork overlays,
   * attachments switched) and returns the worker's plan; `replace` writes into the attached overlays the user was
   * asked about (the `forks` with a `replaceable`) instead of forking.
   */
  commit(replace: boolean): Promise<DiskPlan[]>;
};

type Snap = { name: string; key: string; pins: SnapshotDisk[] };
/** What a restore plans with: the store, the machine and its disks, the snapshot, and the slots its pins name. */
type Restoring = {
  store: Store;
  m: MachineRecord;
  disks: Map<string, DiskRecord>;
  snap: Snap;
  bySlot: ReturnType<typeof slots>;
};
/** What a pinned disk's overlay calls for. */
type Step = {
  slot: number;
  attachment: string;
  disk: DiskRecord;
  action: 'keep' | 'reuse' | 'fork' | 'fork-whole';
  /** A kept overlay's generation (as pinned), or the reused fork's. */
  generation?: number;
  reuse?: string;
  replaceable?: { overlay: string; name: string; bytes: number };
};

/** An earlier fork of snapshot `key` from disk `d` that hasn't moved since: attached again rather than forking once more. */
async function earlierFork(store: Store, d: DiskRecord, key: string) {
  for (const o of await store.overlaysOf(d.id))
    if (o.fork?.snapshot === key && (await overlayMeta(overlayDir(o.id))).generation === o.fork.generation)
      return { id: o.id, generation: o.fork.generation };
  return undefined;
}

/** What pin `p` calls for as its overlay is on disk now: a step, or why the restore is refused. */
async function stepOf(r: Restoring, p: SnapshotDisk & { overlay: string }): Promise<Step | Msg> {
  const at = (r.bySlot[p.slot] as (typeof r.bySlot)[number] | undefined)?.attachment;
  const a = at === undefined ? undefined : r.m.attachments[at];
  const d = a && r.disks.get(a.disk);
  if (!a || !d) throw new Error(`the snapshot pins a disk in slot ${p.slot} that ${r.m.name} doesn't have`);
  const step = { slot: p.slot, attachment: a.id, disk: d };
  const keep: Step = { ...step, action: 'keep', generation: p.generation };
  const pinned = async () => (await overlayMeta(p.overlay)).generation === p.generation;
  if (p.overlay.startsWith('disks/')) {
    // Written in place: no earlier state to fork from.
    if (a.inPlace && (await pinned())) return keep;
    if (p.blocks > 0) return { ...step, action: 'fork-whole' };
    return msg('snapshots:snapshots.writtenInPlace', { disk: d.name });
  }
  if (a.overlay && overlayDir(a.overlay) === p.overlay && (await pinned())) return keep;
  return forkStep(r, step, a.overlay);
}

/** A disk whose overlay moved on: an earlier fork attached again, or a new fork (`replaceable`: the attached overlay). */
async function forkStep(
  r: Restoring,
  step: Pick<Step, 'slot' | 'attachment' | 'disk'>,
  attached?: string,
): Promise<Step> {
  const reuse = await earlierFork(r.store, step.disk, r.snap.key);
  const current = attached ? await r.store.get('overlays', attached) : undefined;
  const replaceable = current ? { overlay: current.id, name: current.name, bytes: current.bytes } : undefined;
  const action = reuse ? 'reuse' : 'fork';
  return { ...step, action, reuse: reuse?.id, generation: reuse?.generation, replaceable };
}

/** What each pinned disk's overlay calls for as the overlays are on disk now. */
async function survey(r: Restoring) {
  const steps: Step[] = [];
  let refused: Msg | undefined;
  for (const p of r.snap.pins) {
    if (p.ram || !p.overlay) continue;
    const s = await stepOf(r, { ...p, overlay: p.overlay });
    if ('action' in s) steps.push(s);
    else refused = s;
  }
  return { steps, refused };
}

/** Makes step `s` so (a reused fork attached, the attached overlay written, or a new fork); its part of the worker's plan. */
async function commitStep(r: Restoring, s: Step, replace: boolean): Promise<DiskPlan> {
  const a = r.m.attachments.find((x) => x.id === s.attachment);
  if (!a) throw new Error(`the plan's attachment ${s.attachment} is not the machine's`); // made from m above
  const write = (overlay: string, whole = false): DiskPlan => ({
    slot: s.slot,
    action: 'write',
    overlay: overlayDir(overlay),
    identity: identityOf(s.disk),
    size: s.disk.size,
    whole,
  });
  if (s.action === 'reuse') {
    a.overlay = s.reuse;
    return { slot: s.slot, action: 'keep', generation: s.generation ?? 0 };
  }
  if (replace && s.action === 'fork' && a.overlay) return write(a.overlay);
  // A new overlay with the snapshot's blocks: its generation after the restore is 1 (web/snapshot.ts).
  const o = await createOverlay(r.store, s.disk, r.snap.name, { snapshot: r.snap.key, generation: 1 });
  a.overlay = o.id;
  a.inPlace = undefined;
  return write(o.id, s.action === 'fork-whole');
}

/**
 * The restore made so: planned again (the guest may have written between the plan and the stop, and a disk kept as
 * the plan found it would take the snapshot's RAM over writes made after it). A disk that moved since forks (its
 * overlay stays as it is); `replace` holds only for the disks the user was asked about (`asked`).
 */
async function commit(r: Restoring, asked: Set<string>, replace: boolean): Promise<DiskPlan[]> {
  const { steps, refused } = await survey(r);
  if (refused) throw new MsgError(refused.key, refused.params);
  const plan: DiskPlan[] = steps.flatMap((s) =>
    s.action === 'keep' ? [{ slot: s.slot, action: 'keep' as const, generation: s.generation ?? 0 }] : [],
  );
  for (const s of steps) if (s.action !== 'keep') plan.push(await commitStep(r, s, replace && asked.has(s.attachment)));
  r.m.modified = Date.now();
  await r.store.put('machines', r.m);
  return plan;
}

/** The slots the pins name, as the machine runs on the page (its shape's display and devices). */
function runSlots(m: MachineRecord, run: { display: Display | 'none'; devices?: DeviceKind[] }) {
  const has = (k: DeviceKind, own: boolean | undefined) => (run.devices ? run.devices.includes(k) : own);
  return slots({
    nets: adaptersOf(m).length,
    display: run.display,
    mouse: has('mouse', m.mouse),
    touch: has('touch', m.touch),
    clock: has('clock', m.clock),
    shares: has('9p', m.shares),
    attachments: m.attachments,
  });
}

/**
 * The plan to restore snapshot `snap` (its pins; `key` identifies it for reusing a fork: a kept snapshot's id, or a
 * file's creation time) onto machine `m`, whose shape the caller checked to be the snapshot's; `run` is the shape it
 * runs with (its display, web/app/run/config.ts `effectiveDisplay`, and its devices, the address's over the record's).
 */
export async function planRestore(
  store: Store,
  m: MachineRecord,
  disks: Map<string, DiskRecord>,
  snap: Snap,
  run: { display: Display | 'none'; devices?: DeviceKind[] } = { display: m.display },
): Promise<RestorePlan> {
  const r: Restoring = { store, m, disks, snap, bySlot: runSlots(m, run) };
  const planned = await survey(r);
  const forks = planned.steps.filter((s) => s.action !== 'keep');
  /** The attachments the user was asked to replace rather than fork (a fresh fork with an overlay attached). */
  const asked = new Set(forks.flatMap((s) => (s.action === 'fork' && s.replaceable ? [s.attachment] : [])));
  return {
    kept: planned.steps.flatMap((s) => (s.action === 'keep' ? [s.disk.name] : [])),
    forks: forks.map((s) => ({ disk: s.disk.name, reused: s.action === 'reuse', replaceable: s.replaceable })),
    refused: planned.refused,
    commit: (replace) => commit(r, asked, replace),
  };
}

/**
 * A disk of a snapshot's shape the browser doesn't have, made again: a blank disk or ramdisk under its id, a URL disk
 * from the snapshot's URLs (`urls`), a file disk to be picked again; a stored disk can't be.
 */
function diskLike(sd: Shape['disks'][number], urls: Record<number, string> | undefined, now: number): DiskRecord {
  const i = sd.identity;
  const base = { size: sd.size, created: now };
  switch (i.kind) {
    case 'stored':
      throw new MsgError('snapshots:snapshots.storedDiskGone', undefined, {
        cause: new MsgError('snapshots:snapshots.storedDiskGone.cause'),
      });
    case 'url':
      return {
        id: newId(),
        kind: 'url',
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- a path ending in '/' names no file
        name: i.path.split('/').pop() || t('snapshots:snapshots.urlDisk'),
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
        name: i.kind === 'blank' ? t('snapshots:snapshots.blankDisk') : t('snapshots:snapshots.ramdisk'),
        identity: i,
        ...base,
      };
  }
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
    const want = canonical(sd.identity);
    let d = disks.find((x) => canonical(x.identity) === want);
    if (!d) {
      d = diskLike(sd, snap.urls, now);
      await store.put('disks', d);
      disks.push(d);
    }
    attachments.push({
      id: sd.serial.replace(/^waarm64-/, ''),
      disk: d.id,
      readOnly: sd.readOnly,
      ...(sd.swap && d.kind === 'ramdisk' ? { swap: true as const } : {}),
    });
  }
  const taken = (await store.all('machines')).map((m) => m.name);
  const m: MachineRecord = {
    id: newId(),
    name: uniqueName(t('snapshots:snapshots.like', { name: snap.name }), taken),
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

/** Moves kept snapshot `id` to machine `to` (its file, then its record). */
export async function moveSnapshot(store: Store, id: string, to: string) {
  const s = await store.get('snapshots', id);
  if (!s || s.machine === to) return;
  const path = snapshotPath(s.machine, id);
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  const src = await (await opfsDir(path.slice(0, slash))).getFileHandle(name);
  const dest = await opfsDir(`machines/${to}/snapshots`, true);
  if (src.move) await src.move(dest);
  else {
    const w = await (await dest.getFileHandle(name, { create: true })).createWritable();
    await (await src.getFile()).stream().pipeTo(w);
    await store.files.remove(snapshotPath(s.machine, id));
  }
  await store.put('snapshots', { ...s, machine: to });
}

/** Imports a snapshot file into machine `machine`'s kept snapshots (its header read first; one of another shape is kept, orphaned). */
export async function importSnapshot(store: Store, machine: string, file: File) {
  const { header } = await openSnapshot(file);
  if (typeof header.shapeHash !== 'string' || !header.shape)
    throw new MsgError(
      'snapshots:snapshots.notKept',
      { file: file.name },
      { cause: new MsgError('snapshots:snapshots.notKept.cause') },
    );
  const id = newId();
  return store.writing(async () => {
    const dir = await opfsDir(`machines/${machine}/snapshots`, true);
    const copy = async () =>
      file.stream().pipeTo(await (await dir.getFileHandle(id, { create: true })).createWritable());
    const full = (e: unknown) => (e as { name?: unknown } | null | undefined)?.name === 'QuotaExceededError';
    try {
      // The storage full: the remote disks' kept blocks go (`makeRoom`), and it's copied once more.
      await copy().catch(async (e: unknown) => {
        if (full(e) && (await makeRoom())) return copy();
        throw e;
      });
    } catch (e) {
      await dir.removeEntry(id).catch(() => undefined); // tidying up: the failure thrown is the one to report
      if (full(e))
        throw new MsgError('snapshots:snapshots.notKept', { file: file.name }, { cause: await storageFullError() });
      throw e;
    }
    const pins = ((header.disks ?? []) as SnapshotDisk[]).map((p) => ({
      slot: p.slot,
      overlay: p.overlay,
      generation: p.generation,
      blocks: p.blocks,
      ram: p.ram,
    }));
    const rec = {
      id,
      machine,
      name: file.name.replace(/\.waarm64snap$/, ''),
      created: Date.parse(header.created) || Date.now(),
      bytes: file.size,
      shape: header.shape as Shape,
      shapeHash: header.shapeHash as string,
      pins,
      urls: header.urls as Record<number, string> | undefined,
    };
    await store.put('snapshots', rec);
    return rec;
  });
}
