// A machine's start in the machine worker (web/app/worker.ts `start`): what it fetches, the machine it makes (the
// page's, or a snapshot's), the options `bootVm` takes, and the framebuffer's screen.
import { FLASH_SIZE, splitError, splitRam, type BootOptions, type Restore, type Vm } from '../vm.ts';
import { warmWorkers, type WarmWorkers } from '../warm-workers.ts';
import { msg, MsgError } from '../msg.ts';
import { VENUS_RESERVE } from '../ram.ts';
import { dropSuspend, loadFlash, overlayMeta, suspended } from '../overlay.ts';
import { showFramebuffer } from '../display.ts';
import type { DisplayFromPage, DisplayToPage, ScreenPng } from '../gpu-present.ts';
import { readHeader, type SnapshotHeader } from '../snapshot-file.ts';
import { startPool, type SavePool } from '../snapshot-pool.ts';
import { otherVersion, readSnapshot, type RestorePhases, type SnapshotDisk } from '../snapshot.ts';
import type { DeviceSpec } from '../devices.ts';
import type { lzCodec } from '../lz.ts';
import { agentBinary } from './guest-agent.ts';
import { splitMsg, withParams, type Machine } from './machine.ts';
import type { CpuFeature } from './shape.ts';
import { device, layout, venusOn, type Slot, type StartMessage } from './worker-devices.ts';
import { failure } from './worker-errors.ts';
import { checkDisks, CORE, download } from './worker-fetch.ts';
import { fromHeader } from './worker-header.ts';
import { post } from './worker-post.ts';
import type { LoadPhases } from './protocol.ts';

type Lz = Awaited<ReturnType<typeof lzCodec>>;

/**
 * What a start fetches: the core, and without a snapshot the kernel and initrd (whole) and the saved variable store
 * (a snapshot has it in its RAM, and needs no kernel); the disks are only checked. The guest agent is fetched only for a
 * `firmware` machine with it on (web/app/guest-agent.ts) and without a snapshot (a restored guest has its own); without
 * it (not built) the machine runs as it would, with no agent. `heads`: what the disks' servers said of them (`checkDisks`).
 */
export async function fetchParts(m: StartMessage, machine: Machine, snapshot: boolean, stopped: () => boolean) {
  const flash =
    !snapshot && machine.firmware && m.home
      ? loadFlash(m.home).then(
          (f) => (f?.length === FLASH_SIZE ? f : undefined),
          () => undefined,
        )
      : undefined;
  const urls = m.disks.flatMap((d) => ('url' in d.source ? [new URL(d.source.url, self.location.href).href] : []));
  const disks = checkDisks(urls, machine);
  const agent = m.config.devices.agent && machine.firmware && !snapshot ? agentBinary() : undefined;
  const images = snapshot ? [] : [machine.kernel, ...(machine.initrd ? [machine.initrd] : [])];
  const [wasm, kernel = new Uint8Array(0), initrd] = await download([CORE, ...images], machine, stopped);
  const heads = await disks;
  return { wasm, kernel, initrd, flash, agent, heads };
}

/** The machine a start makes: its vCPUs, RAM (MiB, and its split over memory 0 and the spill memories), transports, CPU features. */
export type Plan = {
  ncpus: number;
  ramMiB: number;
  here: Slot[];
  cpu: CpuFeature[];
  split: { ramSize: number; spill: number[] };
};

/**
 * The page's machine. RAM past what memory 0 holds goes to spill memories, NUMA nodes for the guest
 * (docs/spill-memories.md): the user's split, else the automatic one. A machine with Vulkan keeps its renderer and
 * window in memory 1, before node 1 (docs/devices.md "Venus").
 */
export function planOf(m: StartMessage, machine: Machine): Plan {
  const here = layout(m, machine);
  const ramMiB = m.config.ram.mib;
  const venus = here.some((s) => s.kind === 'gpu') && venusOn(m);
  const asked = m.config.ram.split;
  const split = asked
    ? { ramSize: asked[0] * 2 ** 20, spill: asked.slice(1).map((n) => n * 2 ** 20) }
    : splitRam(ramMiB * 2 ** 20, venus ? VENUS_RESERVE : 0);
  return { ncpus: m.config.ncpus, ramMiB, here, cpu: m.config.cpu, split };
}

/**
 * A suspended machine resumes only onto its overlays as it left them: the same ones, at the generations it pinned
 * (docs/machines.md §5.3; a switch, a reset, a merge or a boot since moved them on), over the stored disks as they
 * were (the header's `bases`: one written in place or merged into since is another disk under them).
 */
async function sameOverlays(header: SnapshotHeader, specs: DeviceSpec[]) {
  for (const d of (header.disks ?? []) as SnapshotDisk[]) {
    if (d.ram || !d.overlay) continue;
    const spec = specs[d.slot] as DeviceSpec | undefined;
    if (
      spec?.type !== 'blk' ||
      spec.overlay !== d.overlay ||
      (await overlayMeta(d.overlay)).generation !== d.generation
    )
      throw new MsgError('machine:worker-start.diskChanged');
  }
  // A stored disk it ran over (read-only, or under an overlay) written in place or merged into since (`bases`).
  const bases = header.bases as Record<string, number> | undefined;
  for (const [id, generation] of Object.entries(bases ?? {}))
    if ((await overlayMeta(`disks/${id}`)).generation !== generation)
      throw new MsgError('machine:worker-start.diskChanged');
}

/**
 * The machine a snapshot (or a suspended machine, `resume`) says, and its restore: everything that can be refused is,
 * before anything is touched (the overlay is replaced inside `bootVm`; a resume keeps it: it is as the suspended
 * machine left it); its phases posted. Its load's pool (docs/platform.md "A load's pool"; none: it can't start, the
 * machine worker does it all) starts beside the header's checks and is awaited before the check pass; it is this
 * restore's, closed once: when `fill` is done (or failed), at a refusal, or at `release` (the caller's, once `bootVm`
 * has settled: a start that fails before `fill` closes it there). `pooled` is called once the pool is up (or
 * isn't) and the restore not refused: what else starts beside the check pass waits for it (its workers' start slowed
 * the pool's by ~60 ms).
 * `specs`: the devices the restore hands ramdisks their chunks through; `serial`, the terminal's tail.
 */
export async function openRestore(
  snapshot: Blob,
  m: StartMessage,
  machine: Machine,
  resume: boolean,
  lz: Lz,
  pooled?: () => void,
) {
  const pool = startPool(lz.module).catch(() => undefined);
  let open = true;
  void pool.then(() => open && pooled?.()); // not for a restore refused meanwhile
  const release = () => {
    if (open) void pool.then((p) => p?.close());
    open = false;
  };
  try {
    const r = await restoreOf(snapshot, m, machine, resume, lz, pool);
    const restore = r.restore;
    const fill = restore.fill.bind(restore);
    restore.fill = async (ram, spill) => {
      try {
        await fill(ram, spill);
      } finally {
        release();
      }
    };
    return { ...r, release };
  } catch (err) {
    release();
    throw err;
  }
}

/** `f`, then the restore's load's pool released (`release`), whatever came of it. */
export async function releasing<T>(release: (() => void) | undefined, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } finally {
    release?.();
  }
}

async function restoreOf(
  snapshot: Blob,
  m: StartMessage,
  machine: Machine,
  resume: boolean,
  lz: Lz,
  pool: Promise<SavePool | undefined>,
) {
  post({
    type: 'phase',
    text: resume ? msg('machine:worker-start.phase.resuming') : msg('snapshots:worker-start.phase.checking'),
  });
  const name = m.snapshot
    ? msg('snapshots:worker-start.file', { name: m.snapshot.name })
    : msg('machine:worker-start.suspendedMachine');
  const header = await readHeader(snapshot);
  // Another version's file (an older one: they aren't migrated) is refused as that, before its devices are looked at.
  const other = otherVersion(header, lz.snapshotVersion);
  if (other) throw other;
  const h = fromHeader(header, m, machine, name);
  if (resume) await sameOverlays(header, h.specs);
  const { restore, phases } = await readSnapshot(snapshot, lz, lz.snapshotVersion, {
    devices: h.specs,
    resume,
    plan: m.plan,
    pool: await pool,
  });
  const plan: Plan = { ncpus: h.ncpus, ramMiB: h.ramMiB, here: h.slots, cpu: h.cpu, split: h.split };
  if (!resume) post({ type: 'phase', text: msg('snapshots:worker-start.phase.restoring') });
  return {
    header,
    plan,
    restore,
    phases,
    specs: h.specs,
    serial: typeof header.serial === 'string' ? header.serial : '',
  };
}

/**
 * A start from a snapshot's phases (`LoadPhases`): from `t0` (the start) to now, `prepared` the parts' end; `start` is
 * what `prepare` and the restore's own phases leave of the total.
 */
export function loadPhases(t0: number, prepared: number, r: RestorePhases): LoadPhases {
  const total = performance.now() - t0;
  const prepare = prepared - t0;
  return { ...r, prepare, start: total - prepare - r.check - r.state - r.ram - r.disk, total };
}

/**
 * A split made without Vulkan's renderer and window in memory 1 (a definition, `?split=`, a record from before they
 * moved there, a snapshot of a machine without Vulkan) can't be laid out: say why, not "couldn't reserve".
 */
export function checkSplit(plan: Plan, m: StartMessage, machine: Machine, snapshot: boolean) {
  const withVenus = plan.here.some((s) => s.kind === 'gpu') && venusOn(m);
  const tooBig = withVenus && splitError(plan.split.ramSize, plan.split.spill, VENUS_RESERVE);
  if (!tooBig) return;
  const why = splitMsg(tooBig);
  throw failure(
    'memory',
    msg('machine:worker-start.vulkanSplit', { machine: machine.title }),
    snapshot
      ? new MsgError('machine:worker-start.vulkanSplit.snapshot.cause', { why })
      : new MsgError('machine:worker-start.vulkanSplit.cause', { why }),
  );
}

/** The machine's devices: the restore's (`specs`), or made for this start. */
export const devicesOf = (plan: Plan, m: StartMessage, machine: Machine, specs?: DeviceSpec[]) =>
  specs ?? plan.here.map((s) => device(s, m, machine));

/**
 * The status's disks and adapters (`Status.disks`, `nets`): the device index of each of the page's, in its order; the
 * xHCI's counters (`Status.usb`) follow the last device's.
 */
export const ioOf = (plan: Plan, m: StartMessage, machine: Machine, devices: DeviceSpec[]) => ({
  disks: plan.here.flatMap((s, i) => (s.kind === 'blk' ? [i] : [])),
  nets: machine.network ? plan.here.flatMap((s, i) => (s.kind === 'net' ? [i] : [])) : undefined,
  usb: m.ports.usb ? devices.length : undefined,
});

/**
 * Firefox's engine (its `InternalError`, which V8 lacks). The compile worker only pays off through V8's
 * process-wide module cache; SpiderMonkey has none, so there it would add a copy of every module, and its
 * process holds ~16K modules' code at most (it throws "out of memory":
 * https://github.com/gbl08ma/waarm64/issues/168).
 */
const spiderMonkey = 'InternalError' in globalThis;

/** The start's workers started ahead (`warming`). */
let warm: WarmWorkers | undefined;
/**
 * A start's workers started ahead of its `bootVm` (web/warm-workers.ts `warmWorkers`), which takes them: the device worker
 * only, at once for a boot (`begin`), beside a snapshot's check pass (`pooled`: once the load's pool is up). The vCPU
 * workers and the compile worker too took ~80-100 ms more of a desktop snapshot's check pass than they saved after it
 * (bench/boot/REPORT.md "SNAPZ loop 7"): they start at the machine's first run, as they did. A start ends the last
 * one's (a suspended machine that couldn't resume boots instead), a failed start its own (`end`).
 */
export const warming = {
  begin(boot: boolean) {
    warm?.end();
    warm = boot ? warmWorkers(0, false) : undefined;
  },
  pooled: () => void (warm ??= warmWorkers(0, false)),
  take: () => warm,
  end: () => warm?.end(),
};

/**
 * A suspended machine kept beside the disk (docs/frontend.md "Suspend") is resumed, unless the page says boot; either
 * way it is dropped before a machine runs on the disk, which is what keeps a suspended machine and its disk together.
 */
export async function suspendedCopy(m: StartMessage, home: string | undefined): Promise<Blob | undefined> {
  if (!home || m.snapshot) return undefined;
  // A suspension that can't be dropped doesn't stop the boot the page asked for.
  if (m.resume !== false) return suspended(home).catch(() => undefined);
  await dropSuspend(home).catch(() => undefined);
  return undefined;
}

/** What a start fetched for `bootVm`: the kernel and initrd, the firmware's files and variable store. */
type Parts = { kernel: Uint8Array; initrd?: Uint8Array; firmware: BootOptions['firmware'] };

/** `bootVm`'s options for the machine `plan` says, its `devices` made, from `restore` if any. */
export function bootOptions(
  m: StartMessage,
  machine: Machine,
  plan: Plan,
  parts: Parts,
  devices: DeviceSpec[],
  restore: Restore | undefined,
  warm?: WarmWorkers,
): BootOptions {
  const kinds = plan.here.map((s) => s.kind);
  const dev = m.config.dev;
  return {
    ramSize: plan.split.ramSize,
    spill: plan.split.spill,
    kernel: parts.kernel,
    initrd: parts.initrd,
    cmdline: machine.firmware ? '' : withParams(machine.cmdline, m.config.guest.params ?? ''),
    firmware: parts.firmware,
    jit: 1,
    jitBytes: m.config.jitMiB ? m.config.jitMiB * 2 ** 20 : undefined,
    ncpus: plan.ncpus,
    parallel: true,
    realtime: true,
    compileWorker: dev.compileWorker && !spiderMonkey,
    warm,
    fma: dev.fma,
    exactCore: dev.exactCore,
    vcpuYieldMs: dev.vcpuYieldMs,
    vcpuSpinUs: dev.vcpuSpinUs,
    cpu: plan.cpu,
    framebuffer: kinds.includes('gpu') ? undefined : machine.framebuffer,
    serialIn: m.ports.serial,
    restore,
    devices,
    usb: m.ports.usb ? { port: m.ports.usb } : undefined,
    onNotice: (message) => post({ type: 'notice', message }),
    // No idleLimitMs: an idle guest may sleep as long as it likes.
  };
}

/**
 * The simple framebuffer on the page's canvas, drawn on this worker's animation frames, for a machine without
 * virtio-gpu (the display port is this worker's then).
 */
export function showScreen(v: Vm, m: StartMessage) {
  const screen = m.screen;
  if (!v.framebuffer || !screen) return;
  const port = m.ports.display;
  const shown = showFramebuffer(screen, v.memory, v.framebuffer, () => post({ type: 'screen' }));
  // The status bar's renderer and frame rate (the presenter's report on a machine with virtio-gpu: web/gpu-present.ts).
  setInterval(
    () =>
      port.postMessage({
        type: 'screen-stats',
        screen: 'framebuffer',
        presents: shown.presents(),
      } satisfies DisplayToPage),
    1000,
  );
  // "Copy the screen" (docs/plans/clipboard.md §4.4): the framebuffer's canvas as it shows (a 2D context keeps its
  // pixels).
  port.onmessage = (e: MessageEvent<DisplayFromPage | null>) => {
    if (e.data?.type !== 'png') return;
    const id = e.data.id;
    void screen
      .convertToBlob({ type: 'image/png' })
      .catch(() => undefined)
      .then((png) => port.postMessage({ type: 'png', id, png } satisfies ScreenPng));
  };
}
