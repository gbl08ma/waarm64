// A VM to a snapshot file and back (docs/platform.md "Snapshots"): web/vm.ts has the machine's state
// (`snapshot()`, `BootOptions.restore`), web/snapshot-file.ts the container, web/lz.ts its codec.
// The file: the header (what the machine is, and the writable disks it pins), CORE (the core's
// state), DEVS (the host's: backend state and pending input, JSON), BLOB (the binary parts of DEVS:
// the display's 3D contents, each Uint8Array of the state a blob DEVS names), RAM, then DISK: the blocks the
// disks' overlays hold (a snapshot is only valid with the disk as it was: the guest's page cache
// and filesystem state are in RAM). Round-robin VMs are saved between runs; a parallel one is
// paused first (`pause()`), and runs on afterwards. A restore replaces the overlays with the
// file's blocks before the new VM's backends open them.
import {
  BLOB_CHUNKS,
  CHUNK,
  corrupt,
  diskRuns,
  openSnapshot,
  readHeader,
  snapshotBound,
  SnapshotError,
  SnapshotWriter,
  truncated,
  type Codec,
  type LoadPool,
  type OverlayBlock,
  type ReadFrame,
  type RamPool,
  type ReadTimes,
  type Sink,
  type SnapshotHeader,
  type WriteTimes,
} from './snapshot-file.ts';
import { diskIdentity, type BlkSpec, type DeviceSpec } from './devices.ts';
import { ramDisk } from './ramdisk.ts';
import { lzCodec } from './lz.ts';
import { msg, msgOf, MsgError, type Param } from './msg.ts';
import {
  endFill,
  lockOverlay,
  openOverlay,
  overlay,
  overlayMeta,
  storageFullError,
  withRoom,
  type SyncFile,
  type WritableDisk,
} from './overlay.ts';
import { makeRoom } from './diskcache.ts';
import { zeroDisk } from './stored.ts';
import {
  ABI,
  bootVm,
  makeMemories,
  ramViews,
  type BootOptions,
  type Memories,
  type Restore,
  type Vm,
  type VmState,
} from './vm.ts';
import { compileCore, Exit } from './core.ts';
import type { ConsoleInput } from './test-guests.ts';

/**
 * Each memory's first RAM chunk in the file, for memories of `sizes` bytes (memory 0's RAM, then the spill memories,
 * docs/spill-memories.md): memory 0's at 0, each next one at the whole chunk after the one before ends.
 */
export function ramStarts(sizes: number[]): number[] {
  const starts: number[] = [];
  sizes.reduce((at, size) => (starts.push(at), at + Math.ceil(size / CHUNK)), 0);
  return starts;
}

/** What the caller says the machine is (the header's free fields): a restore checks what it needs of it. */
export type SnapshotMeta = Record<string, unknown>;

/**
 * A writable disk a snapshot pins (the header's `disks`): its device slot, what its overlay
 * belonged to (`diskIdentity`: cheap to compare), its size, how many 4 KiB blocks of it the file
 * carries, and the base image's SHA-256 where the writer knew it (for a base that is the same
 * bytes under another name or date).
 */
export type SnapshotDisk = {
  slot: number;
  identity: string;
  size: number;
  blocks: number;
  sha256?: string;
  overlay?: string;
  generation?: number;
  ram?: boolean;
};

/**
 * What a restore does with a writable disk the file pins (docs/machines.md §5.2): `keep` its overlay as it is
 * (the disk's device runs on `overlay`, `overlays/<id>` or a stored disk written in place `disks/<id>`, and it is at
 * `generation`, the one the page planned with, else the restore is refused: the file's blocks for it are skipped), or `write` the file's blocks into overlay
 * `overlay` (emptied first: a fork into a new overlay, or a replace), with `whole` the disk's every block made zeros
 * first (a stored disk written in place, forked over its moved store: the file has the whole disk), and `fork` when
 * the overlay holds none of the disk's own changes: a new fork the page made (cut off, the page puts the machine back
 * on what it had), or a template's fresh overlay, never written (a refusal after either deleted nothing), and `token` the restore's fill token, written into the overlay's meta with its fill
 * mark (the proof the page's undo needs before it empties or deletes it: docs/machines.md §5.2 "Other machines"). A
 * ramdisk's blocks always go to its new chunks.
 */
export type DiskPlan =
  | { slot: number; action: 'keep'; overlay: string; generation: number }
  | {
      slot: number;
      action: 'write';
      overlay: string;
      identity: string;
      size: number;
      whole?: boolean;
      fork?: boolean;
      token?: string;
    };

/**
 * Where a save's time went, ms (`writeSnapshot`; tools read it in `#message`'s `data-snapshot`, docs/frontend.md
 * "Snapshots"): the devices' state taken (`state`: a 3D renderer's read-back is in it), the CORE, DEVS and BLOB frames
 * (`blobs`), RAM's (`ram`), the disks' blocks read and framed and the end (`disk`); and over all of those, where the
 * writer's time went (`WriteTimes`: RAM's scan, the codec, the frames' encoding and CRC, the sink; with a pool, its
 * workers' sums), and the workers that made RAM's frames (`pool`; 0: this thread).
 */
export type SavePhases = { state: number; blobs: number; ram: number; disk: number; pool: number } & WriteTimes;

/**
 * Where a restore's time went, ms (`readSnapshot`; the machine worker adds its own: web/app/protocol.ts `LoadPhases`):
 * the whole file's check pass (`check`, its reads and CRCs in `checkRead`, `checkCrc`), the CORE, DEVS and BLOB frames
 * (`state`), RAM's frames read and placed (`ram`), the disks' blocks into their overlays (`disk`); over the restore's
 * pass (after the check), the reads, the CRCs, the codec and RAM's placing (`ReadTimes`); and the workers of the pool
 * that took the CRCs and RAM's frames (`pool`, 0: this thread; then `checkCrc`, and RAM's share of `crc`, `unpack` and
 * `apply`, are their sums: CPU time).
 */
export type RestorePhases = {
  check: number;
  checkRead: number;
  checkCrc: number;
  state: number;
  ram: number;
  disk: number;
  pool: number;
} & ReadTimes;

/** A DISK frame's index: the device slot times this, plus the first block. */
const SLOT = 2 ** 40;
const BLOCK = 4096;

/**
 * Writes `vm`'s snapshot to `sink`. No vCPU may be in the core: between `run` calls after
 * `settle()`, or with `pause()` resolved true; the VM is unchanged and may run on once this
 * resolves (RAM and the disks must not move while it is written). `sha256` gives a disk's base
 * image's hash, if the caller has it. `pool`: workers that make RAM's frames (web/snapshot-pool.ts), else this thread
 * does; the file is the same.
 */
export async function writeSnapshot(
  vm: Vm,
  sink: Sink,
  meta: SnapshotMeta,
  codec: Codec,
  opts: {
    progress?: (done: number, total: number) => void;
    sha256?: (slot: number) => string | undefined;
    suspend?: boolean;
    omit?: (slot: number) => boolean;
    pool?: RamPool;
    sized?: (bound: number) => void | Promise<void>;
  } = {},
) {
  const t0 = performance.now();
  const state = await vm.snapshot();
  // How long the devices' state took (a 3D machine's renderer read back is in it): tools split a snapshot's pause with it.
  const stateMs = performance.now() - t0;
  const all = await vm.disks();
  // A suspended machine's file (`suspend`) has no overlay's blocks: it stays beside the overlays it pins, and resumes
  // only while they are as it left them (`readSnapshot`'s `resume`). A ramdisk's are always in the file (they are
  // nowhere else). `omit`: disks whose blocks the caller leaves out (a stored disk written in place: its whole store).
  const carried = (d: (typeof all)[number]) => d.ram || (!opts.suspend && !opts.omit?.(d.slot));
  const pinned: SnapshotDisk[] = all.map((d) => ({
    slot: d.slot,
    identity: d.identity,
    size: d.size,
    blocks: carried(d) ? d.blocks.length : 0,
    sha256: opts.sha256?.(d.slot),
    overlay: d.overlay,
    generation: d.generation,
    ...(d.ram ? { ram: true } : {}),
  }));
  const disks = all.filter(carried);
  const header: SnapshotHeader = {
    ...meta,
    format: 1,
    coreVersion: state.version,
    abi: ABI,
    created: new Date().toISOString(),
    ramSize: vm.ramSize,
    ...(vm.spillRam().length ? { spill: vm.spillRam().map((v) => v.length) } : {}),
    disks: pinned,
    ...(opts.suspend ? { suspend: true } : {}),
  };
  // The state's Uint8Arrays go in BLOB frames; DEVS names each by its number and length.
  const blobs: Uint8Array[] = [];
  const devs = JSON.stringify(state.host, (_k, v: unknown) =>
    v instanceof Uint8Array ? { $blob: blobs.push(v) - 1, length: v.length } : v,
  );
  // The file's largest size, before its first byte goes to the sink (`sized`: a picked file's staging checks its room).
  const views = [new Uint8Array(vm.memory.buffer, vm.ram, vm.ramSize), ...vm.spillRam()];
  await opts.sized?.(
    snapshotBound({
      core: state.core.length,
      devs: devs.length * 3,
      blobs: blobs.map((b) => b.length),
      ram: views.map((v) => v.length),
      blocks: disks.reduce((n, d) => n + d.blocks.length, 0),
    }),
  );
  const w = new SnapshotWriter(sink, header, { codec, concurrency: 1, blobs: blobs.length > 0, pool: opts.pool });
  let at = performance.now();
  /** The ms since the last call (or `at`'s start). */
  const since = () => {
    const was = at;
    at = performance.now();
    return at - was;
  };
  await w.bytes('CORE', state.core);
  await w.bytes('DEVS', new TextEncoder().encode(devs));
  for (const [n, b] of blobs.entries()) await w.blob(n, b);
  const blobsMs = since();
  // Memory 0's RAM, then each spill memory's (node 1's after Venus's arena and window in memory 1), their chunks numbered
  // on (`ramStarts`); the progress is over all of it.
  const total = views.reduce((n, v) => n + v.length, 0);
  const starts = ramStarts(views.map((v) => v.length));
  const ram = { pages: 0, frames: 0 };
  for (let k = 0, before = 0; k < views.length; before += views[k].length, k++) {
    const r = await w.ram(
      views[k],
      opts.progress && ((done) => opts.progress!(before + done, total)),
      starts[k],
      opts.pool,
    );
    [ram.pages, ram.frames] = [ram.pages + r.pages, ram.frames + r.frames];
  }
  const ramMs = since();
  for (const d of disks) {
    await w.disk(
      // Typed, not inferred from `disk`'s union: inferred, it left that union's element `any` in TypeScript 6's cache
      // whenever this file was checked before snapshot-file.ts (the lint failed in about one run in four).
      (async function* (): AsyncGenerator<OverlayBlock> {
        for (let k = 0; k < d.blocks.length; k += 256) {
          const part = d.blocks.slice(k, k + 256);
          const bytes = await vm.diskBlocks(d.slot, part);
          for (const [i, b] of part.entries())
            yield { block: d.slot * SLOT + b, data: bytes.subarray(i * BLOCK, (i + 1) * BLOCK) };
        }
      })(),
    );
  }
  const end = await w.end();
  const phases: SavePhases = { state: stateMs, blobs: blobsMs, ram: ramMs, disk: since(), pool: w.pooled, ...w.times };
  return {
    ...end,
    pages: ram.pages,
    state: state.core.length,
    stateMs,
    devsBytes: devs.length,
    blobBytes: blobs.reduce((n, b) => n + b.length, 0),
    diskBlocks: disks.reduce((n, d) => n + d.blocks.length, 0),
    pins: pinned,
    phases,
  };
}

/**
 * Why a snapshot of `header` can't be restored by a core whose state version is `coreVersion` (the running core's
 * `snapshot_version`, which reads only its own: an older file is refused, not migrated), or none.
 */
export function otherVersion(header: SnapshotHeader, coreVersion: number): SnapshotError | undefined {
  if (header.coreVersion === coreVersion) return undefined;
  return new SnapshotError(
    'snapshots:snapshot.otherVersion',
    { format: header.coreVersion, reads: coreVersion },
    'other-version',
  );
}

/**
 * Opens a snapshot for a restore: its header, and what `bootVm` takes as `restore`. `coreVersion`
 * is the running core's `snapshot_version` (`otherVersion`, checked first); `devices` the device specs of the machine it will
 * start (the `BootOptions.devices`), whose writable disks must be the ones the snapshot pins:
 * the same identity, or the same SHA-256 (`sha256` hashes a slot's base image: seconds, so only
 * asked when the identity differs and the file has the hash). Everything that can be refused is
 * refused here, before anything is touched: another core version, another disk, and for a `Blob`
 * (which can be read twice) a file that is truncated or fails a checksum anywhere. The file is
 * then read as `bootVm` fills the new VM: RAM, and the disks' blocks, which **replace the
 * overlays** of those disks (and the variable stores kept beside them) before the backends open them.
 *
 * `resume`: the file is a suspended machine's (`writeSnapshot`'s `suspend`: no disk blocks) and
 * the overlays are as that machine left them, which only the caller can know (web/overlay.ts
 * `suspended`): they are kept. Such a file is refused without `resume`, and any other with it.
 *
 * `pool`: workers that take both passes' CRCs and put RAM's frames into the new VM's RAM (docs/platform.md "A load's
 * pool"; a Blob only, else this thread reads it all). The caller closes it once `fill` is done.
 *
 * `ram` (a Blob's): the new VM's RAM made ahead (web/vm.ts `makeMemories`, given the header once its own refusals are
 * past): then the file is read **once** before this returns, its CRCs and structure checked, the state kept and RAM's
 * pages put into those views as they come (they are the new VM's, which nothing runs on: a refusal leaves them to be
 * dropped), the DISK frames checked; `fill` is given the same views and reads only the DISK frames, from the first
 * one's place in the file (docs/platform.md "The snapshot file", "One pass").
 */
export async function readSnapshot(
  source: ReadableStream<Uint8Array> | Blob,
  codec: Codec,
  coreVersion: number,
  opts: {
    devices?: DeviceSpec[];
    sha256?: (slot: number) => string | Promise<string>;
    resume?: boolean;
    plan?: DiskPlan[];
    pool?: LoadPool;
    ram?: (header: SnapshotHeader) => RamViews | Promise<RamViews>;
  } = {},
): Promise<{ header: SnapshotHeader; restore: Restore; phases: RestorePhases }> {
  let at = performance.now();
  /** The ms since the last call (or `at`'s start). */
  const since = () => {
    const was = at;
    at = performance.now();
    return at - was;
  };
  const phases: RestorePhases = {
    check: 0,
    checkRead: 0,
    checkCrc: 0,
    state: 0,
    ram: 0,
    disk: 0,
    pool: 0,
    read: 0,
    crc: 0,
    unpack: 0,
    apply: 0,
  };
  // What each pinned disk's blocks do, by slot: an overlay written (emptied first), skipped (the overlay is kept as it
  // is), or a ramdisk's chunks (handed to its new device: `BlkSpec.ramInit`).
  type Target =
    | { kind: 'overlay'; name: string; identity: string; size: number; whole?: boolean; fork?: boolean; token?: string }
    | { kind: 'skip' }
    | { kind: 'ram'; spec: BlkSpec; size: number };
  const targets = new Map<number, Target>();
  /** The header's refusals (another version, a suspend's file or not, the disks it pins against `devices`), `targets` made. */
  const aim = async (header: SnapshotHeader) => {
    const other = otherVersion(header, coreVersion);
    if (other) throw other;
    if (!!header.suspend !== !!opts.resume) {
      throw header.suspend
        ? new SnapshotError('snapshots:snapshot.suspended', {}, 'other-disk')
        : corrupt(msg('snapshots:snapshot.damage.notSuspended'));
    }
    const pinned = (header.disks ?? []) as SnapshotDisk[];
    if (
      !Array.isArray(pinned) ||
      pinned.some(
        (d) =>
          !Number.isInteger(d?.slot) || typeof d.identity !== 'string' || !Number.isSafeInteger(d.size) || d.size < 0,
      )
    )
      throw corrupt(msg('snapshots:snapshot.damage.diskList'));
    for (const d of pinned) {
      const spec = opts.devices?.[d.slot];
      if (d.ram) {
        if (spec?.type !== 'blk' || spec.source !== 'ram' || spec.size !== d.size)
          throw new SnapshotError('snapshots:snapshot.noRamdisk', {}, 'other-machine');
        targets.set(d.slot, { kind: 'ram', spec, size: d.size });
        continue;
      }
      if (spec?.type !== 'blk' || !spec.overlay)
        throw new SnapshotError('snapshots:snapshot.noDisk', {}, 'other-machine');
      const identity = diskIdentity(spec, d.size);
      if (identity !== d.identity) {
        const same = d.sha256 !== undefined && opts.sha256 !== undefined && (await opts.sha256(d.slot)) === d.sha256;
        if (!same) {
          throw new SnapshotError(
            'snapshots:snapshot.otherDisk',
            { was: describe(d.identity), here: describe(identity) },
            'other-disk',
          );
        }
      }
      const plan = opts.plan?.find((p) => p.slot === d.slot);
      // A kept overlay must be the one the disk's device runs on (an attachment switched to another, or to its stored
      // disk written in place, would put the snapshot's RAM over other blocks), still at the generation the page
      // planned with: one written since (the guest ran on between the plan and the stop) would put it over a disk that
      // moved on.
      // One a fill was cut off in (marked) holds none of what it was planned at either, and one grown since (a resize
      // in another tab: its own size, or the disk's record, past the size the snapshot saw) is another disk to the guest.
      const kept = !opts.resume && plan?.action === 'keep' ? plan : undefined;
      const now = kept && (await overlayMeta(spec.overlay));
      const grown = !!now && d.size > 0 && Math.max(spec.size ?? 0, now.size) > d.size;
      if (
        kept &&
        now &&
        (spec.overlay !== kept.overlay || now.generation !== kept.generation || now.filling || grown)
      ) {
        throw new SnapshotError('snapshots:snapshot.keptMoved', {}, 'other-disk');
      }
      targets.set(
        d.slot,
        opts.resume || plan?.action === 'keep'
          ? { kind: 'skip' }
          : plan?.action === 'write'
            ? {
                kind: 'overlay',
                name: plan.overlay,
                identity: plan.identity,
                size: plan.size,
                whole: plan.whole,
                fork: plan.fork,
                token: plan.token,
              }
            : { kind: 'overlay', name: spec.overlay, identity, size: d.size },
      );
    }
  };
  /** DISK frame `index` of `rawLen` bytes refused if its slot isn't pinned or it goes past its disk's end. */
  const diskFrame = (index: number, rawLen: number) => {
    const t = targets.get(Math.floor(index / SLOT));
    if (!t) throw corrupt(msg('snapshots:snapshot.damage.unlistedDisk'));
    if (t.kind !== 'skip' && ((index % SLOT) + rawLen / BLOCK - 1) * BLOCK >= t.size)
      throw corrupt(msg('snapshots:snapshot.damage.pastDisk'));
    return t;
  };
  /** The stages of a file's frames, in the order a restore reads them: a frame of an earlier stage after a later one is refused. */
  const STAGE: Record<string, number> = { CORE: 0, DEVS: 0, BLOB: 1, 'RAM ': 2, DISK: 3 };
  /** One pass (`ram`): the views it placed RAM's frames in, and where the DISK frames begin (none: no DISK frame). */
  let one: { views: RamViews; disk?: { at: number; count: number } } | undefined;
  if (source instanceof Blob) {
    // Another version's file is refused by its header, before its frames are read (an older file may have frames of a
    // codec no longer read); then whatever else the header alone refuses.
    const head = await readHeader(source);
    await aim(head);
    if (opts.ram) {
      const views = await opts.ram(head);
      fits(head, views);
      one = { views };
    }
  }
  if (source instanceof Blob && !one) {
    // A pass over the whole file first: a restore replaces the disk's changes, so it must not find the file damaged
    // halfway. Its CRCs and structure, and what the restore's disk phase would refuse: the frames' order, and each DISK
    // frame's slot, its place in its disk and its unpacking (docs/platform.md "The snapshot file").
    const check = await openSnapshot(source, { codec, check: true, pool: opts.pool });
    let stage = 0;
    for await (const f of check.frames()) {
      try {
        if (STAGE[f.tag] < stage) throw corrupt(msg('snapshots:snapshot.damage.unexpected'));
        stage = STAGE[f.tag];
        if (f.tag === 'DISK') diskFrame(f.index, f.size!);
      } catch (e) {
        // An earlier frame's own refusal (a CRC the pool still has) comes first.
        await check.placed();
        throw e;
      }
    }
    [phases.check, phases.checkRead, phases.checkCrc] = [since(), check.times.read, check.times.crc];
  }
  // With a pool, RAM's frames are checked, unpacked and placed by its workers (docs/platform.md "A load's pool"). One
  // pass checks every frame as the check pass does, but RAM's are placed and the state's come with their data.
  const s = await openSnapshot(source, { codec, pool: opts.pool, check: !!one, keep: !!one });
  phases.pool = s.pooled;
  /** A one pass's disk pass's reading times. */
  let diskTimes: ReadTimes | undefined;
  /** The restore pass's reading times so far (a one pass's and its disk pass's), into `phases`. */
  const read = () => {
    Object.assign(phases, s.times);
    if (diskTimes) for (const k of ['read', 'crc', 'unpack', 'apply'] as const) phases[k] += diskTimes[k];
  };
  const { header } = s;
  if (!(source instanceof Blob)) await aim(header);
  /** The frames yielded so far (a one pass's disk pass starts at the first DISK frame, this many before it). */
  let counted = 0;
  const counting = async function* (g: AsyncGenerator<ReadFrame>) {
    for await (const f of g) {
      counted++;
      yield f;
    }
  };
  let frames: AsyncGenerator<ReadFrame> = counting(s.frames());
  // CORE and DEVS come first, each in index order.
  const parts: Record<string, Uint8Array[]> = { CORE: [], DEVS: [] };
  let next = await frames.next();
  for (; !next.done && next.value.tag in parts; next = await frames.next()) {
    const { tag, index, data } = next.value;
    if (index !== parts[tag].length) throw corrupt(msg('snapshots:snapshot.damage.stateOrder'));
    parts[tag].push(data);
  }
  const join = (p: Uint8Array[]) => {
    const out = new Uint8Array(p.reduce((n, b) => n + b.length, 0));
    p.reduce((at, b) => (out.set(b, at), at + b.length), 0);
    return out;
  };
  if (!parts.CORE.length || !parts.DEVS.length)
    throw next.done ? truncated() : corrupt(msg('snapshots:snapshot.damage.stateMissing'));
  let host: VmState['host'];
  // The blobs DEVS names (`writeSnapshot`), made at their lengths and filled from the BLOB frames that follow.
  const blobs: Uint8Array[] = [];
  try {
    host = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(join(parts.DEVS)), (_k, v: unknown) => {
      if (!v || typeof v !== 'object' || !('$blob' in v)) return v;
      const { $blob: n, length } = v as { $blob: unknown; length: unknown };
      if (
        !Number.isInteger(n) ||
        !Number.isSafeInteger(length) ||
        (n as number) < 0 ||
        (length as number) < 0 ||
        (length as number) > 2 ** 32 ||
        blobs[n as number]
      )
        throw corrupt(msg('snapshots:snapshot.damage.devices'));
      return (blobs[n as number] = new Uint8Array(length as number));
    });
  } catch {
    throw corrupt(msg('snapshots:snapshot.damage.devices'));
  }
  const filled = blobs.map(() => 0);
  /** A one pass's BLOB frames its pool's workers unpack: each copied into its blob once it comes, by the pass's end. */
  const blobsLater: Promise<void>[] = [];
  for (; !next.done && next.value.tag === 'BLOB'; next = await frames.next()) {
    const { index, data, later, size } = next.value;
    const n = Math.floor(index / BLOB_CHUNKS),
      at = (index % BLOB_CHUNKS) * 2 ** 20;
    const length = later ? size! : data.length;
    if (!blobs[n] || at + length > blobs[n].length) throw corrupt(msg('snapshots:snapshot.damage.blobFit'));
    if (later) blobsLater.push(later.then((d) => blobs[n].set(d, at)));
    else blobs[n].set(data, at);
    filled[n] += length;
  }
  if (filled.some((n, k) => n !== blobs[k]?.length)) throw corrupt(msg('snapshots:snapshot.damage.blobMissing'));
  if (
    !Array.isArray(host?.devices) ||
    !Array.isArray(host.input) ||
    host.input.some((b) => !Number.isInteger(b) || b < 0 || b > 255)
  )
    throw corrupt(msg('snapshots:snapshot.damage.devices'));
  phases.state = since();
  read();
  /** RAM's frames from `next` on placed into `ram` and `spill` (memory 0's, then each spill memory's). */
  const placeRam = async (ram: Uint8Array, spill: Uint8Array[]) => {
    const views = [ram, ...spill];
    const starts = ramStarts(views.map((v) => v.length));
    for (; !next.done && next.value.tag === 'RAM '; next = await frames.next()) {
      const { index, place } = next.value;
      let k = views.length - 1;
      while (k > 0 && index < starts[k]) k--;
      place!(views[k], index - starts[k]);
    }
  };
  if (one) {
    // The one pass's RAM, then its DISK frames checked (and where the first is), to its end: every CRC in, every RAM
    // frame placed. A refusal of the structure here (the frames' order, a DISK frame's slot or place) waits for the
    // frames before it: an earlier frame's own refusal (a CRC a worker still has) comes first.
    await placeRam(one.views.ram, one.views.spill);
    for (; !next.done; next = await frames.next()) {
      const { tag, index, size, at } = next.value;
      try {
        if (tag !== 'DISK') throw corrupt(msg('snapshots:snapshot.damage.unexpected'));
        diskFrame(index, size!);
      } catch (e) {
        try {
          await s.placed();
        } finally {
          void frames.return(undefined);
        }
        throw e;
      }
      one.disk ??= { at, count: counted - 1 };
    }
    await Promise.all(blobsLater);
    phases.ram = since();
    read();
  }
  /**
   * The same views as the one pass's, which it placed RAM in: the same bytes in memory (a shared memory's `buffer` is
   * another object after a grow, so a byte is written through one and read through the other, then put back; nothing
   * runs on this RAM yet).
   */
  const same = (a: Uint8Array, b: Uint8Array) => {
    if (a.byteOffset !== b.byteOffset || a.length !== b.length || !a.length) return false;
    const was = a[0];
    try {
      return [was ^ 0x5a, was ^ 0xa5].every((x) => ((a[0] = x), b[0] === x));
    } finally {
      a[0] = was;
    }
  };
  const restore: Restore = {
    core: join(parts.CORE),
    host,
    async fill(ram, spill = []) {
      if (one) {
        if (
          !same(ram, one.views.ram) ||
          spill.length !== one.views.spill.length ||
          spill.some((v, k) => !same(v, one.views.spill[k]))
        )
          throw new Error("a one-pass restore's fill is given the RAM its pass filled");
        // The disks' frames read again, from the first.
        since();
        if (one.disk) {
          const d = await openSnapshot(source, { codec, pool: opts.pool, from: one.disk });
          frames = d.frames();
          next = await frames.next();
          diskTimes = d.times;
        }
      } else {
        fits(header, { ram, spill });
        since();
        await placeRam(ram, spill);
        // Every RAM frame in (a pool's workers placing them): a refusal here comes before the disks are touched.
        await s.placed();
        phases.ram = since();
      }
      // The disks: each overlay written is emptied (a snapshot's blocks are all the disk has written; with `whole`, all
      // the disk has), then takes the file's blocks; a ramdisk's go into chunks for its device.
      // `meta`: an overlay's, whose fill mark is cleared at the end; `disk` set once its files are open and marked.
      const open = new Map<number, { disk?: WritableDisk; meta?: SyncFile; close(): void; size: number } | 'skip'>();
      // A write the storage refused gets the remote disks' kept blocks out of the way (`makeRoom`) and is tried once more
      // (until there's nothing left to give).
      const lands = withRoom(makeRoom);
      const full = async () =>
        new MsgError('snapshots:snapshot.storageFull', undefined, { cause: await storageFullError() });
      const rams: { spec: BlkSpec; disk: ReturnType<typeof ramDisk> }[] = [];
      // Every overlay's lock first, before any is emptied: one open elsewhere (another tab's job or machine) refuses the
      // restore (`overlay-in-use`) with all the disks as they were. Each is handed to its opening below.
      const held = new Map<number, () => void>();
      // Whether an overlay's own changes were deleted (one written that isn't planned as a fork: a replace, the page's
      // own disk): a refusal from here on says so (`emptied`, for the page's words).
      let emptied = false;
      try {
        for (const [slot, t] of targets) if (t.kind === 'overlay') held.set(slot, await lockOverlay(t.name));
        for (const [slot, t] of targets) {
          if (t.kind === 'skip') {
            open.set(slot, 'skip');
            continue;
          }
          if (t.kind === 'ram') {
            const disk = ramDisk(t.size);
            rams.push({ spec: t.spec, disk });
            // Released at the end: its chunks are handed on first (`chunkList`) unless the restore failed.
            open.set(slot, { disk, close: () => disk.release(), size: t.size });
            continue;
          }
          // Its generation goes on from where it was (a replace never takes an overlay back to a generation an older
          // snapshot pinned): one past its old one, written with the fill's mark and token before anything of it is
          // deleted (web/overlay.ts `openOverlay`'s `fresh`), and the writes below move nothing further. Its size is the
          // disk's as the snapshot saw it (a grown overlay's fork is as grown: docs/machines.md §4.5). Emptied under its
          // lock (no other opener between): until the mark is cleared at the end, after both files' flush, every opening
          // takes it as empty, so a restore cut off or refused part way is never read as a disk's.
          const lock = held.get(slot);
          held.delete(slot); // the opening's now: its close (or failure) lets go of it
          const fresh = { size: t.size, token: t.token, lands };
          const files = await openOverlay(t.name, t.identity, undefined, { fresh, held: lock }).catch(
            async (e: unknown) => {
              if (!t.fork && (e as { marked?: unknown } | null)?.marked) emptied = true; // marked, then refused
              throw msgOf(e)?.key.startsWith('disks:overlay.storageFull') ? await full() : e;
            },
          );
          if (!t.fork) emptied = true;
          const o: { disk?: WritableDisk; meta: SyncFile; close(): void; size: number } = {
            meta: files.meta,
            close: files.close,
            size: t.size,
          };
          open.set(slot, o); // closed at the end, failed or not
          // Over zeros: the file's blocks are written whole, but the disk's last one may be shorter than 4 KiB, and its
          // write reads the rest of its block (none: zeros). No meta: its generation is set.
          // Unordered (no flush between a run's data and its map entries): until the restore's end the overlay is half
          // a snapshot's whatever its order, and the end flushes both, then clears the mark (docs/devices.md "Crash
          // and refusal").
          const disk = overlay(zeroDisk(t.size), files.data, files.map, undefined, 0, { ordered: false });
          o.disk = disk;
          if (t.whole && !(await lands(() => disk.zero(0, t.size))))
            throw new MsgError('snapshots:snapshot.storageFull.whole', undefined, { cause: await storageFullError() });
        }
        for (; !next.done; next = await frames.next()) {
          const { tag, index, data } = next.value;
          if (tag !== 'DISK') throw corrupt(msg('snapshots:snapshot.damage.unexpected'));
          // An unlisted slot or a frame past the disk's end (for a stream: a Blob's check pass refused them) is refused
          // before any of it is written. Its runs of data blocks and of zero blocks are a call each (an OPFS call costs
          // ~0.3 ms off the record, a data flush per call ~0.15 ms on disk: bench/boot/REPORT.md "SNAPZ loop 5"); the
          // disk's last block may be shorter than 4 KiB.
          diskFrame(index, data.length);
          const o = open.get(Math.floor(index / SLOT))!;
          if (o === 'skip') continue;
          const disk = o.disk!; // every target's is set above
          for (const run of diskRuns(index % SLOT, data)) {
            const at = run.block * BLOCK;
            const len = Math.min(run.count * BLOCK, o.size - at);
            if (!(await lands(() => (run.zero ? disk.zero(at, len) : disk.write(at, run.data.subarray(0, len))))))
              throw await full();
          }
        }
        for (const o of open.values()) if (o !== 'skip') o.disk!.flush();
        // Every overlay whole on disk: their marks cleared (each in place: its meta's size doesn't change).
        for (const o of open.values()) {
          const meta = o !== 'skip' ? o.meta : undefined;
          if (meta && !(await lands(() => endFill(meta)))) throw await full();
        }
        for (const r of rams) r.spec.ramInit = r.disk.chunkList();
      } catch (e) {
        if (emptied && e && typeof e === 'object') Object.assign(e, { emptied: true });
        throw e;
      } finally {
        for (const release of held.values()) release();
        for (const o of open.values()) if (o !== 'skip') o.close();
        phases.disk = since();
        read();
      }
    },
  };
  return { header, restore, phases };
}

/** Memory 0's RAM and each spill memory's, as a restore fills them (web/vm.ts `ramViews`). */
export type RamViews = { ram: Uint8Array; spill: Uint8Array[] };

/** RAM of the sizes the snapshot `header` says (memory 0's, each spill memory's), or the snapshot's refusal. */
function fits(header: SnapshotHeader, { ram, spill }: RamViews) {
  if (ram.length !== header.ramSize)
    throw new SnapshotError(
      'snapshots:snapshot.otherRam',
      { had: Number(header.ramSize) / 2 ** 20, has: ram.length / 2 ** 20 },
      'other-machine',
    );
  const had = header.spill === undefined ? [] : header.spill;
  if (!Array.isArray(had) || had.some((n) => !Number.isSafeInteger(n) || n <= 0))
    throw corrupt(msg('snapshots:snapshot.damage.memorySizes'));
  const mib = (sizes: number[]) => sizes.map((n) => `${n / 2 ** 20} MiB`).join(' + '); // i18n-ignore: numbers and their unit
  if (had.join() !== spill.map((v) => v.length).join()) {
    throw new SnapshotError(
      'snapshots:snapshot.otherNuma',
      {
        had: had.length
          ? msg('snapshots:snapshot.otherNuma.had', { sizes: mib(had) })
          : msg('snapshots:snapshot.otherNuma.hadNone'),
        has: spill.length ? mib(spill.map((v) => v.length)) : msg('snapshots:snapshot.otherNuma.hasNone'),
      },
      'other-machine',
    );
  }
}

/** A disk identity (`diskIdentity`'s JSON) for a message: a file in words, a URL's path as it is. */
function describe(identity: string): Param {
  try {
    const d = JSON.parse(identity) as { file?: string; path?: string; size?: number; modified?: number };
    return d.file !== undefined
      ? msg('snapshots:snapshot.diskFile', { file: d.file, when: new Date(d.modified ?? 0) })
      : `${d.path}`;
  } catch {
    return identity;
  }
}

/**
 * `runToPowerOff` with the VM saved to a snapshot file, closed, and a new one started from the
 * file each time the steps reach one of `at` (ascending; the first, third, … restored through the one pass, the others
 * through two: `readSnapshot`'s `ram`): what the tests and benchmarks run a
 * guest through. `options(k)` changes the options of the VM started from snapshot `k` (the tier,
 * say). A deterministic guest takes the steps and prints what an unbroken run does. `files` has
 * each snapshot's size and the ms it took to write and to start from.
 */
export async function runThroughSnapshots(
  wasm: BufferSource | WebAssembly.Module,
  o: BootOptions,
  at: number[],
  maxSteps = 20e9,
  input?: ConsoleInput,
  options?: (k: number) => Partial<BootOptions>,
) {
  const module = wasm instanceof WebAssembly.Module ? wasm : await compileCore(wasm);
  const codec = await lzCodec(module);
  let vm = await bootVm(module, o);
  const points = [...at];
  const files: { bytes: number; pages: number; saveMs: number; restoreMs: number }[] = [];
  let [console, hvc, steps] = ['', '', 0];
  const t0 = performance.now();
  for (;;) {
    const stop = Math.min(
      points[0] ?? Infinity,
      input?.step !== undefined && steps < input.step ? input.step : Infinity,
    );
    const r = await vm.runAsync(Math.max(1, Math.min(100_000_000, stop - steps)));
    steps += r.steps;
    console += vm.drain();
    const idle = r.kind === Exit.IDLE;
    if (
      input &&
      (idle || steps >= (input.step ?? Infinity) || (input.after !== undefined && console.includes(input.after)))
    ) {
      vm.send(input.data);
      input = undefined;
      if (idle) continue;
    }
    if (r.kind === Exit.DEVICE) await vm.settle();
    const going = (r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL || r.kind === Exit.DEVICE) && steps < maxSteps;
    if (going && points.length && steps >= points[0]) {
      points.shift();
      const parts: Uint8Array[] = [];
      const t = performance.now();
      if (!(await vm.pause())) throw new Error('the machine ended as it was paused');
      const w = await writeSnapshot(
        vm,
        (b) => {
          parts.push(b.slice());
        },
        { machine: 'test' },
        codec,
      );
      const saveMs = performance.now() - t;
      await vm.flush();
      hvc += vm.hvc();
      await vm.close();
      const t1 = performance.now();
      // Every other restore through the one pass, its memories made ahead (as the page's), the others through two.
      const next = { ...o, ...options?.(files.length) };
      const venus = (next.devices ?? []).some((d) => d.type === 'gpu' && d.virgl && d.venus);
      let memories: Memories | undefined;
      const { restore } = await readSnapshot(new Blob(parts as BlobPart[]), codec, codec.snapshotVersion, {
        devices: o.devices,
        ram:
          files.length % 2 === 0
            ? () => ramViews((memories = makeMemories({ ...next, venus })), next.ramSize)
            : undefined,
      });
      vm = await bootVm(module, { ...next, restore, memories });
      files.push({ bytes: w.bytes, pages: w.pages, saveMs, restoreMs: performance.now() - t1 });
    }
    if (going) continue;
    const ms = performance.now() - t0;
    await vm.flush();
    await vm.close();
    return {
      ...r,
      kind: r.kind === Exit.DEVICE ? Exit.BUDGET : r.kind,
      steps,
      console,
      hvc: hvc + vm.hvc(),
      ms,
      pc: vm.pc(),
      files,
    };
  }
}
