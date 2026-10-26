// Snapshots of stored machines on the page (docs/plans/machines.md §5): the machine's shape now (what its snapshots are
// checked against), which kept snapshots it orphans, and the plan of a restore: per writable disk, **keep** its overlay
// when it is exactly as the snapshot pinned it (nothing is written), else **fork** (a new overlay, named after the
// snapshot, takes its blocks and is attached; the old one stays as it was), reusing an earlier fork of the same
// snapshot that hasn't moved since; or, when the user asks, **replace** (the attached overlay takes the blocks). A
// disk written in place keeps only at its pinned generation; otherwise a file with its whole disk forks it into an
// overlay, and one without is refused (§4.4). Nothing here asks the user; the page and the Machines page confirm first.
import { opfsDir, overlayMeta } from '../overlay.ts';
import { openSnapshot } from '../snapshot-file.ts';
import type { DiskPlan, SnapshotDisk } from '../snapshot.ts';
import { createOverlay, identityOf } from './disks.ts';
import { adaptersOf, canonical, CPU_FEATURES, macsOf, newId, shapeHash, shapeOf, slots, uniqueName, type CpuFeature, type DiskRecord, type Display, type MachineRecord, type Shape } from './shape.ts';
import { overlayDir, snapshotPath, type Store } from './store.ts';

/** The display a machine runs with on this page: its own, 2D without WebGL2, none with the page's `?display=simple`. */
export function effectiveDisplay(m: MachineRecord, page: { webgl2: boolean; simple: boolean }): Display | 'none' {
  if (page.simple) return 'none';
  return m.display === '3d' && !page.webgl2 ? '2d' : m.display;
}

/** The machine's shape and its hash as it would run now (its disks by id). */
export async function currentShape(m: MachineRecord, disks: (id: string) => DiskRecord | undefined, opts: { display?: Display | 'none'; cpu?: CpuFeature[]; vulkan?: boolean } = {}): Promise<{ shape: Shape; hash: string }> {
  const shape = shapeOf(m, disks, { display: opts.display, cpu: opts.cpu ?? CPU_FEATURES, vulkan: opts.vulkan });
  return { shape, hash: await shapeHash(shape) };
}

/** What a restore will do, in words for the confirmation, and how to make it so (`commit`). */
export type RestorePlan = {
  /** Disks whose overlay is kept as it is. */
  kept: string[];
  /** Disks whose state forks: the snapshot's blocks go into a new overlay (or an earlier unmoved fork is attached again). */
  forks: { disk: string; reused: boolean; replaceable?: { overlay: string; name: string; bytes: number } }[];
  /** Why it can't restore (a disk written in place moved on, and the file hasn't the whole disk). */
  refused?: string;
  /** Creates what the plan needs (fork overlays, attachments switched) and returns the worker's plan; `replace` writes into the attached overlays instead of forking. */
  commit(replace: boolean): Promise<DiskPlan[]>;
};

/**
 * The plan to restore snapshot `snap` (its pins; `key` identifies it for reusing a fork: a kept snapshot's id, or a
 * file's creation time) onto machine `m`, whose shape the caller checked to be the snapshot's; `display` is the one it
 * runs with (`effectiveDisplay`).
 */
export async function planRestore(store: Store, m: MachineRecord, disks: Map<string, DiskRecord>, snap: { name: string; key: string; pins: SnapshotDisk[] }, display: Display | 'none' = m.display): Promise<RestorePlan> {
  const bySlot = slots({ nets: adaptersOf(m).length, display, mouse: m.mouse, touch: m.touch, attachments: m.attachments }); // as the machine runs on the page (its shape's display): the slots the pins name
  type Step = { slot: number; attachment: string; disk: DiskRecord; action: 'keep' | 'reuse' | 'fork' | 'fork-whole'; reuse?: string; replaceable?: { overlay: string; name: string; bytes: number } };
  const steps: Step[] = [];
  const kept: string[] = [];
  let refused: string | undefined;
  for (const p of snap.pins) {
    if (p.ram || !p.overlay) continue;
    const at = bySlot[p.slot]?.attachment;
    const a = at === undefined ? undefined : m.attachments[at];
    const d = a && disks.get(a.disk);
    if (!a || !d) throw new Error(`the snapshot pins a disk in slot ${p.slot} that ${m.name} doesn't have`);
    if (p.overlay.startsWith('disks/')) {
      // Written in place: no earlier state to fork from.
      if (a.inPlace && (await overlayMeta(p.overlay)).generation === p.generation) { kept.push(d.name); continue; }
      if (p.blocks > 0) { steps.push({ slot: p.slot, attachment: a.id, disk: d, action: 'fork-whole' }); continue; }
      refused = `${d.name} was written in place since this snapshot was taken, and the snapshot doesn't carry the whole disk: it can only restore onto that disk as it was.`;
      continue;
    }
    if (a.overlay && overlayDir(a.overlay) === p.overlay && (await overlayMeta(p.overlay)).generation === p.generation) { kept.push(d.name); continue; }
    // An earlier fork of this snapshot that hasn't moved since: attached again rather than forking once more.
    let reuse: string | undefined;
    for (const o of await store.overlaysOf(d.id)) {
      if (o.fork?.snapshot === snap.key && (await overlayMeta(overlayDir(o.id))).generation === o.fork.generation) { reuse = o.id; break; }
    }
    const current = a.overlay ? await store.get('overlays', a.overlay) : undefined;
    const replaceable = current ? { overlay: current.id, name: current.name, bytes: current.bytes } : undefined;
    steps.push({ slot: p.slot, attachment: a.id, disk: d, action: reuse ? 'reuse' : 'fork', reuse, replaceable });
  }
  return {
    kept,
    forks: steps.map((s) => ({ disk: s.disk.name, reused: s.action === 'reuse', replaceable: s.replaceable })),
    refused,
    async commit(replace) {
      if (refused) throw new Error(refused);
      const plan: DiskPlan[] = [];
      for (const p of snap.pins) if (!p.ram && p.overlay && !steps.some((s) => s.slot === p.slot)) plan.push({ slot: p.slot, action: 'keep' });
      for (const s of steps) {
        const a = m.attachments.find((x) => x.id === s.attachment)!;
        const write = (overlay: string, whole = false): DiskPlan => ({ slot: s.slot, action: 'write', overlay: overlayDir(overlay), identity: identityOf(s.disk), size: s.disk.size, whole });
        if (s.action === 'reuse') {
          a.overlay = s.reuse;
          plan.push({ slot: s.slot, action: 'keep' });
        } else if (replace && s.action === 'fork' && a.overlay) {
          plan.push(write(a.overlay));
        } else {
          // A new overlay with the snapshot's blocks: its generation after the restore is 1 (web/snapshot.ts).
          const o = await createOverlay(store, s.disk, snap.name, { snapshot: snap.key, generation: 1 });
          a.overlay = o.id;
          a.inPlace = undefined;
          plan.push(write(o.id, s.action === 'fork-whole'));
        }
      }
      m.modified = Date.now();
      await store.put('machines', m);
      return plan;
    },
  };
}

/**
 * A new machine like the one snapshot `snap` was taken of (§5.1 "Make a machine like it"): its settings and disks from
 * the shape, each disk the browser has (by identity) attached again, a blank disk or ramdisk made again under its id,
 * a URL disk from the snapshot's URLs; a file disk is recorded to be picked again; a stored disk the browser no longer
 * has can't be made. The attachments take the snapshot's serials, so the shape is the snapshot's. The snapshot moves
 * to the new machine. Returns it.
 */
export async function machineLike(store: Store, snap: { id: string; machine: string; name: string; shape: Shape; urls?: Record<number, string> }): Promise<MachineRecord> {
  const disks = await store.all('disks');
  const now = Date.now();
  const attachments: MachineRecord['attachments'] = [];
  for (const sd of snap.shape.disks) {
    const want = canonical(sd.identity);
    let d = disks.find((x) => canonical(x.identity) === want);
    if (!d) {
      const i = sd.identity;
      if (i.kind === 'stored') throw new Error('one of its disks was stored in this browser and is gone: the machine can\'t be made again');
      d = i.kind === 'url'
        ? { id: newId(), kind: 'url', name: i.path.split('/').pop() || 'disk', size: sd.size, url: snap.urls?.[sd.slot] ?? i.path, identity: i, created: now }
        : i.kind === 'file'
          ? { id: newId(), kind: 'file', name: i.name, size: sd.size, identity: i, created: now }
          : { id: i.id, kind: i.kind, name: i.kind === 'blank' ? 'Blank disk' : 'Ramdisk', size: sd.size, identity: i, created: now };
      await store.put('disks', d);
      disks.push(d);
    }
    attachments.push({ id: sd.serial.replace(/^webpc-/, ''), disk: d.id, readOnly: sd.readOnly });
  }
  const taken = (await store.all('machines')).map((m) => m.name);
  const m: MachineRecord = {
    id: newId(),
    name: uniqueName(`Like ${snap.name}`, taken),
    ncpus: snap.shape.ncpus,
    ramMiB: snap.shape.ramMiB,
    ...(snap.shape.split ? { ramSplit: snap.shape.split } : {}),
    display: snap.shape.display === '3d' ? '3d' : '2d',
    adapters: macsOf(snap.shape).map((mac) => ({ id: newId(), mac })),
    usb: snap.shape.usb === true,
    mouse: snap.shape.devices.includes('mouse'),
    touch: snap.shape.devices.includes('touch'),
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
  const from = snapshotPath(s.machine, id).split('/');
  const name = from.pop()!;
  const src = await (await opfsDir(from.join('/'))).getFileHandle(name);
  const dest = await opfsDir(`machines/${to}/snapshots`, true);
  const move = (src as FileSystemFileHandle & { move?(dir: FileSystemDirectoryHandle): Promise<void> }).move;
  if (move) await move.call(src, dest);
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
  if (typeof header.shapeHash !== 'string' || !header.shape) throw new Error(`${file.name} is a snapshot of a machine this page didn't keep (a test's, or an older version's): it can only be loaded on that page`);
  const id = newId();
  return store.writing(async () => {
    const dir = await opfsDir(`machines/${machine}/snapshots`, true);
    const w = await (await dir.getFileHandle(id, { create: true })).createWritable();
    await file.stream().pipeTo(w);
    const pins = ((header.disks ?? []) as SnapshotDisk[]).map((p) => ({ slot: p.slot, overlay: p.overlay, generation: p.generation, blocks: p.blocks, ram: p.ram }));
    const rec = { id, machine, name: file.name.replace(/\.webpcsnap$/, ''), created: Date.parse(String(header.created)) || Date.now(), bytes: file.size, shape: header.shape as Shape, shapeHash: header.shapeHash as string, pins, urls: header.urls as Record<number, string> | undefined };
    await store.put('snapshots', rec);
    return rec;
  });
}
