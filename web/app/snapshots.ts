// Snapshots of stored machines on the page (docs/machines.md §5): the machine's shape now (what its snapshots are
// checked against), which kept snapshots it orphans, and the plan of a restore: per writable disk, **keep** its overlay
// when it is exactly as the snapshot pinned it (nothing is written), else **fork** (a new overlay, named after the
// snapshot, takes its blocks and is attached; the old one stays as it was), reusing an earlier fork of the same
// snapshot that hasn't moved since; or, when the user asks, **replace** (the attached overlay takes the blocks). A
// disk written in place keeps only at its pinned generation; otherwise a file with its whole disk forks it into an
// overlay, and one without is refused (§4.4). Nothing here asks the user; the page and the Home page confirm first.
import { overlayMeta } from '../overlay.ts';
import { SNAPSHOT_VERSION } from '../snapshot-file.ts';
import type { DiskPlan, SnapshotDisk } from '../snapshot.ts';
import { createOverlay, identityOf } from './disks.ts';
import type { GrowMark, OverlaySizes } from './disk-size.ts';
import {
  adaptersOf,
  CPU_DEFAULT,
  newId,
  shapeHash,
  shapeOf,
  slots,
  type CpuFeature,
  type DeviceKind,
  type DiskRecord,
  type Display,
  type MachineRecord,
  type Shape,
} from './shape.ts';
import { overlayDir, type OverlayRecord, type SnapshotRecord, type Store } from './store.ts';
import { msg, MsgError, type Msg } from '../i18n.ts';
import { othersHave, type RestoreStep } from './restore-step.ts';
import { namedByRestores, pendingRestore } from './snapshot-undo.ts';
import { dependsOn, diskGenerations, inPlaceDisk, lost, RECORDED_FROM, type Lost } from './snapshot-lost.ts';

/** The machine's shape and its hash as it would run now (its disks and overlays by id: an overlay's own size counts, §4.5). */
export async function currentShape(
  m: MachineRecord,
  disks: (id: string) => DiskRecord | undefined,
  opts: { display?: Display | 'none'; cpu?: CpuFeature[]; vulkan?: boolean; overlays?: OverlaySizes } = {},
): Promise<{ shape: Shape; hash: string }> {
  const shape = shapeOf(m, disks, { ...opts, cpu: opts.cpu ?? CPU_DEFAULT });
  return { shape, hash: await shapeHash(shape) };
}

/** `lost`'s disk reasons in the lists' words (`unrestorable`) and the restore's (`refused`). */
const LIST_WORDS = {
  base: 'snapshots:snapshots.unrestorable.base',
  inPlace: 'snapshots:snapshots.unrestorable.inPlace',
} as const;
const RESTORE_WORDS = { base: 'snapshots:snapshots.baseMoved', inPlace: 'snapshots:snapshots.writtenInPlace' } as const;

/** Why `lost` says, in the restore's words (`restore`) or the lists'. */
function said(why: Lost, name: (id: string) => string | undefined, restore: boolean): Msg {
  if (why.why === 'version')
    return restore
      ? msg('snapshots:snapshot.otherVersion', { format: why.format, reads: SNAPSHOT_VERSION })
      : msg('snapshots:snapshots.unrestorable.version');
  // A stored disk it was taken over, moved since (written in place, merged into): its overlays' blocks, or what a
  // read-only guest cached, are over other bytes now. A disk it pinned written in place: the bytes it pinned are gone.
  return msg((restore ? RESTORE_WORDS : LIST_WORDS)[why.why], { disk: name(why.disk) ?? why.disk });
}

/**
 * Why kept snapshot `s` can never be restored onto its machine's disks (`lost`, in the lists' words): `generations`
 * the stored disks' from their files (`watchGenerations`); disks without a record aren't checked.
 */
export function unrestorable(
  s: SnapshotRecord,
  disks: (id: string) => DiskRecord | undefined,
  generations: ReadonlyMap<string, number>,
): Msg | undefined {
  const why = lost({ ...s, coreVersion: s.coreVersion ?? RECORDED_FROM }, (id) =>
    disks(id) ? generations.get(id) : undefined,
  );
  return why && said(why, (id) => disks(id)?.name, false);
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

/**
 * `bases`: the stored disks' generations it was taken over (its header's: `basesOf`), where it says them;
 * `coreVersion`: its header's (the core's snapshot format that wrote it).
 */
type Snap = { name: string; key: string; pins: SnapshotDisk[]; bases?: Record<string, number>; coreVersion?: number };
/** What a restore plans with: the store, the machine and its disks, the snapshot, and the slots its pins name. */
type Restoring = {
  store: Store;
  m: MachineRecord;
  disks: Map<string, DiskRecord>;
  snap: Snap;
  run: RunShape;
  bySlot: ReturnType<typeof slots>;
  /** A machine's first restore (a template's, `restoreFirst`): an attached overlay never written takes a fork's blocks. */
  fresh?: boolean;
  /**
   * The overlays this restore leaves as they are (docs/machines.md §5.2 "Other machines"): those another machine has
   * chosen, and those any machine's restore that hasn't loaded names (made, attached, wrote into, or goes back onto:
   * `namedByRestores`). None is written into or attached again as an earlier fork. Set by `survey`.
   */
  taken?: ReadonlySet<string>;
};
/** The generations `lost` judged by (`diskGenerations`), for the steps of the disks written in place. */
type Generations = ReadonlyMap<string, number>;
/** The shape the machine runs with (its display, and its devices: the address's over the record's). */
type RunShape = { display: Display | 'none'; devices?: DeviceKind[] };
/** What a pinned disk's overlay calls for. */
type Step = {
  slot: number;
  attachment: string;
  disk: DiskRecord;
  action: 'keep' | 'reuse' | 'fork' | 'fork-whole';
  /** The disk's size as the snapshot saw it (a grown overlay's: its fork is as grown, §4.5). */
  size: number;
  /** The overlay the snapshot pinned (`overlays/<id>`, or `disks/<id>` written in place). */
  pinned: string;
  /** A kept overlay's generation (as pinned), or the reused fork's. */
  generation?: number;
  reuse?: string;
  replaceable?: { overlay: string; name: string; bytes: number };
  /**
   * A fork's overlay where the attached one never took a write (its generation 0, at the snapshot's size) on a
   * machine's first restore (a template's: `fresh`, the overlays the page made for it): it takes the blocks, as a new
   * fork would, and nothing is left behind or asked (it holds nothing to lose). An overlay the user made stays theirs.
   */
  into?: string;
};

/**
 * An earlier fork of snapshot `key` from disk `d` that hasn't moved since, at the size the snapshot had (`size`: a fork
 * grown since is another disk to the guest): attached again rather than forking once more. Never one in `taken`:
 * another machine's (it would write the fork that machine runs on), or one a restore that hasn't loaded names (its
 * machine's next load may delete it, put that machine back on it, or it is being written).
 */
async function earlierFork(store: Store, d: DiskRecord, key: string, size: number, taken: ReadonlySet<string>) {
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
async function forkMark(store: Store, pinned: string, size: number): Promise<GrowMark | undefined> {
  const id = pinned.startsWith('overlays/') ? pinned.slice('overlays/'.length) : undefined;
  const g = id ? (await store.get('overlays', id))?.grow : undefined;
  return g && size > g.from && size <= g.to ? { from: g.from, to: size } : undefined;
}

/** The attachment and disk in pin `p`'s slot (the caller checked the shape: one is there). */
function pinnedAttachment(r: Restoring, p: SnapshotDisk) {
  const at = (r.bySlot[p.slot] as (typeof r.bySlot)[number] | undefined)?.attachment;
  const a = at === undefined ? undefined : r.m.attachments[at];
  const d = a && r.disks.get(a.disk);
  if (!a || !d) throw new Error(`the snapshot pins a disk in slot ${p.slot} that ${r.m.name} doesn't have`);
  return { a, d };
}

/** What pin `p` calls for as its overlay is on disk now: a step, or why the restore is refused. */
async function stepOf(r: Restoring, p: SnapshotDisk & { overlay: string }, generations: Generations): Promise<Step> {
  const { a, d } = pinnedAttachment(r, p);
  const step = { slot: p.slot, attachment: a.id, disk: d, size: p.size || d.size, pinned: p.overlay };
  const keep: Step = { ...step, action: 'keep', generation: p.generation };
  const inPlace = inPlaceDisk(p);
  if (inPlace) {
    // Written in place: no earlier state to fork from. The disk as it was pinned, now under an overlay (the attachment
    // no longer written in place), forks into an overlay over it that holds nothing (the file has none of its blocks);
    // one moved on without the whole disk in the file was refused (`lost`).
    if (a.inPlace && generations.get(inPlace) === (p.generation ?? 0)) return keep;
    if (p.blocks > 0) return { ...step, action: 'fork-whole' };
    return forkStep(r, step, a.overlay);
  }
  // Pinned under an overlay, the attachment written in place since: the machine runs on the stored disk itself, not
  // on the overlay its record still names, so that overlay is neither kept nor written into (the snapshot's RAM would
  // land on the stored disk without the overlay's blocks). It forks, and the fork's attachment is under an overlay again.
  if (a.inPlace) return forkStep(r, step);
  if (a.overlay && overlayDir(a.overlay) === p.overlay && (await overlayMeta(p.overlay)).generation === p.generation)
    return keep;
  return forkStep(r, step, a.overlay);
}

/**
 * A disk whose overlay moved on: an earlier fork attached again, or a new fork (`replaceable`: the attached overlay,
 * which the user may have the snapshot's blocks written into instead, where no other machine has it: `taken`).
 */
async function forkStep(
  r: Restoring,
  step: Pick<Step, 'slot' | 'attachment' | 'disk' | 'size' | 'pinned'>,
  attached?: string,
): Promise<Step> {
  const taken = r.taken ?? new Set();
  const reuse = await earlierFork(r.store, step.disk, r.snap.key, step.size, taken);
  const found = attached ? await r.store.get('overlays', attached) : undefined;
  // Another machine's too: never written into (a replace or a fresh overlay's fill would change that machine's disk).
  const current = found && !taken.has(found.id) ? found : undefined;
  if (!reuse && r.fresh && current && (await pristine(current, step)))
    return { ...step, action: 'fork', into: current.id };
  const replaceable = current ? { overlay: current.id, name: current.name, bytes: current.bytes } : undefined;
  const action = reuse ? 'reuse' : 'fork';
  return { ...step, action, reuse: reuse?.id, generation: reuse?.generation, replaceable };
}

/**
 * Whether overlay `o` holds nothing (its files' generation 0: never written, the device bumps it before an opening's
 * first change, §3.3; or marked as a cut-off fill: read as empty, a template's first restore undone) and the guest sees
 * it at the size the snapshot had: a fork into it loses nothing.
 */
async function pristine(o: OverlayRecord, step: Pick<Step, 'disk' | 'size'>) {
  if (Math.max(step.disk.size, o.size ?? 0) !== step.size) return false;
  const meta = await overlayMeta(overlayDir(o.id));
  return meta.generation === 0 || !!meta.filling;
}

/** What each pinned disk's overlay calls for as the overlays are on disk now, or why the restore is refused (`lost`). */
async function survey(r: Restoring): Promise<{ steps: Step[]; refused?: Msg }> {
  const others = (await r.store.all('machines')).filter((x) => x.id !== r.m.id);
  r.taken = new Set([
    ...(await namedByRestores(r.store, { before: true })),
    ...others.flatMap((x) => x.attachments.flatMap((a) => (a.overlay ? [a.overlay] : []))),
  ]);
  const generations = await diskGenerations(dependsOn([r.snap]));
  const why = lost(r.snap, (id) => generations.get(id));
  if (why) return { steps: [], refused: said(why, (id) => r.disks.get(id)?.name, true) };
  const steps: Step[] = [];
  for (const p of r.snap.pins)
    if (!p.ram && p.overlay) steps.push(await stepOf(r, { ...p, overlay: p.overlay }, generations));
  return { steps };
}

/** What a commit gathers: the machine's `restoring` steps, and the new forks' records to make once it's written. */
type Commit = { pending: RestoreStep[]; make: (() => Promise<unknown>)[] };

/**
 * Makes step `s` so in machine record `r.m` (a reused fork attached, the attached overlay written, or a new fork, its
 * record made after the machine's: `c.make`), with what undoes it (`c.pending`); its part of the worker's plan.
 * `replace`: the overlay the user was asked to have the snapshot's blocks written into, if this step's disk had one;
 * written into only while it is still the one attached (and no other machine's: the step has it as `replaceable`).
 * `token`: the restore's fill token, in each step and each write (docs/machines.md §5.2 "Other machines").
 */
async function commitStep(
  r: Restoring,
  s: Step,
  replace: string | undefined,
  c: Commit,
  token: string,
): Promise<DiskPlan> {
  const a = r.m.attachments.find((x) => x.id === s.attachment);
  if (!a) throw new Error(`the plan's attachment ${s.attachment} is not the machine's`); // made from m above
  const write = (overlay: string, whole = false, fork = false): DiskPlan => ({
    slot: s.slot,
    action: 'write',
    overlay: overlayDir(overlay),
    identity: identityOf(s.disk),
    size: s.size,
    whole,
    ...(fork ? { fork } : {}),
    token,
  });
  // What the attachment had, for a restore that never loads (cut off, refused: `undoCutRestores` goes back to it).
  const before = { ...(a.overlay ? { overlay: a.overlay } : {}), ...(a.inPlace ? { inPlace: true as const } : {}) };
  const generation = async (id: string) => (await overlayMeta(overlayDir(id))).generation;
  if (s.action === 'reuse') {
    const id = s.reuse;
    if (!id || !(await r.store.get('overlays', id))) throw new Error(`the earlier fork ${id ?? ''} is gone`); // read just now
    c.pending.push({ attachment: a.id, how: 'reuse', overlay: id, before, token });
    a.overlay = id;
    a.inPlace = undefined;
    return { slot: s.slot, action: 'keep', overlay: overlayDir(id), generation: s.generation ?? 0 };
  }
  if (replace && replaces(s, a.overlay, replace)) {
    c.pending.push({ attachment: a.id, how: 'into', overlay: replace, generation: await generation(replace), token });
    return write(replace);
  }
  if (s.into && s.into === a.overlay && (await r.store.get('overlays', s.into))) {
    // The attached overlay never written: it takes the blocks, and is the snapshot's fork (named after it) once it loaded.
    // Its fill deletes nothing of the disk's (it held nothing), so the worker plans it as a fork's (`fork`): a refusal
    // after it (the storage full) is no snapshot that can't load here, and a template's first start keeps its mark.
    const fork = { snapshot: r.snap.key, name: r.snap.name };
    c.pending.push({
      attachment: a.id,
      how: 'into',
      overlay: s.into,
      generation: await generation(s.into),
      fork,
      token,
    });
    return write(s.into, false, true);
  }
  // A new overlay with the snapshot's blocks: its generation after the restore is 1 (web/snapshot.ts).
  const id = newId();
  const mark = await forkMark(r.store, s.pinned, s.size);
  const disk = s.disk;
  c.make.push(() =>
    createOverlay(r.store, disk, r.snap.name, { snapshot: r.snap.key, generation: 1 }, s.size, mark, id),
  );
  c.pending.push({ attachment: a.id, how: 'fork', overlay: id, before, token });
  a.overlay = id;
  a.inPlace = undefined;
  return write(id, s.action === 'fork-whole', true);
}

/**
 * Whether step `s` writes the snapshot's blocks into overlay `asked` (the one the user was asked about and answered
 * replace) rather than forking: a new fork's step whose attachment has it still (`attached`), as the one it could
 * replace now (`replaceable`: no other machine has it).
 */
const replaces = (s: Step, attached: string | undefined, asked: string) =>
  s.action === 'fork' && attached === asked && s.replaceable?.overlay === asked;

/** Machine `id` and its disks as the store has them now. */
async function fresh(store: Store, id: string) {
  const m = await store.get('machines', id);
  if (!m) throw new MsgError('machine:page-machine.noMachine', { id });
  const disks = new Map<string, DiskRecord>();
  for (const a of m.attachments) {
    const d = await store.get('disks', a.disk);
    if (!d) throw new MsgError('machine:page-machine.noDisk', { name: m.name, id: a.disk });
    disks.set(d.id, d);
  }
  return { m, disks };
}

/**
 * The restore made so: planned again on the machine's record and disks as they are now (the guest may have written
 * between the plan and the stop, and a disk kept as the plan found it would take the snapshot's RAM over writes made
 * after it; the record may have been edited since the page read it: what the restore writes back is that record with
 * its attachments' overlays changed, never the one it planned on). A disk that moved since forks (its overlay stays as
 * it is); `replace` holds only for the overlays the user was asked about (`asked`: by attachment, the overlay named).
 */
async function commit(planned: Restoring, asked: Map<string, string>, replace: boolean): Promise<DiskPlan[]> {
  const now = await fresh(planned.store, planned.m.id);
  const r: Restoring = { ...planned, ...now, bySlot: runSlots(now.m, planned.run) };
  const { steps, refused } = await survey(r);
  if (refused) throw new MsgError(refused.key, refused.params);
  const plan: DiskPlan[] = steps.flatMap((s) =>
    s.action === 'keep'
      ? [{ slot: s.slot, action: 'keep' as const, overlay: s.pinned, generation: s.generation ?? 0 }]
      : [],
  );
  pendingRestore(r.m); // an earlier one's undo left steps (an overlay open elsewhere): said, nothing committed
  const c: Commit = { pending: [], make: [] };
  const token = newId(); // this restore's, in its fill's metas (docs/machines.md §5.2 "Other machines")
  for (const s of steps)
    if (s.action !== 'keep') plan.push(await commitStep(r, s, replace ? asked.get(s.attachment) : undefined, c, token));
  // The commit: the attachments switched and what undoes them, in one write (docs/machines.md §5.2 "A restore's
  // records"), made onto the record as the store has it then (one read and write: what another tab wrote to its other
  // fields meanwhile stays). The new forks' records after it: cut off between, the next load finds their ids there and
  // goes back.
  const switched = new Map(
    r.m.attachments.flatMap((a) => (c.pending.some((p) => p.attachment === a.id) ? [[a.id, a] as const] : [])),
  );
  const names = new Map<string, string>();
  for (const p of c.pending)
    if (p.how !== 'fork') names.set(p.overlay, (await r.store.get('overlays', p.overlay))?.name ?? p.overlay);
  // The other machines read in the same transaction (`updateAmong`): an overlay it writes into or attaches again that
  // another machine chose, or copied, since the survey (another tab's Overlays dialog, Duplicate) refuses the commit,
  // with nothing written; its Retry plans again on them, and forks.
  await r.store.updateAmong('machines', r.m.id, (cur, all) => {
    if (!cur) throw new MsgError('machine:page-machine.noMachine', { id: r.m.id });
    pendingRestore(cur);
    for (const id of switched.keys())
      if (!cur.attachments.some((a) => a.id === id)) throw new Error(`attachment ${id} was detached during the commit`); // the machine is held: a detach needs it off
    for (const p of c.pending)
      if (p.how !== 'fork' && othersHave(all, cur.id, p.overlay))
        throw new MsgError('snapshots:snapshots.takenMeanwhile', { overlay: names.get(p.overlay) ?? p.overlay });
    const attachments = cur.attachments.map((a) => {
      const to = switched.get(a.id);
      return to ? { ...a, overlay: to.overlay, inPlace: to.inPlace } : a;
    });
    return { ...cur, attachments, restoring: c.pending.length ? c.pending : undefined, modified: Date.now() };
  });
  for (const make of c.make) await make();
  return plan;
}

/** The slots the pins name, as the machine runs on the page (its shape's display and devices). */
function runSlots(m: MachineRecord, run: RunShape) {
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
  run: RunShape = { display: m.display },
  o: { fresh?: boolean } = {},
): Promise<RestorePlan> {
  const r: Restoring = { store, m, disks, snap, run, bySlot: runSlots(m, run), fresh: o.fresh };
  const planned = await survey(r);
  const forks = planned.steps.filter((s) => s.action !== 'keep');
  /** The overlays the user was asked to replace rather than fork (a fresh fork with an overlay attached), by attachment. */
  const asked = new Map(
    forks.flatMap((s) =>
      s.action === 'fork' && s.replaceable ? [[s.attachment, s.replaceable.overlay] as const] : [],
    ),
  );
  return {
    kept: planned.steps.flatMap((s) => (s.action === 'keep' ? [s.disk.name] : [])),
    forks: forks.map((s) => ({ disk: s.disk.name, reused: s.action === 'reuse', replaceable: s.replaceable })),
    refused: planned.refused,
    commit: (replace) => commit(r, asked, replace),
  };
}
