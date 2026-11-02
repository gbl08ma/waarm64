// The machine worker (docs/frontend.md): boots one of web/app/machine.ts's
// machines under the JIT, realtime with a worker per vCPU (web/vm.ts), and runs
// it until it stops, talking to the page through web/app/protocol.ts. It
// drains the serial console after every `runAsync` (which returns as soon as
// there's new output) and posts the text, and draws the screen on the page's
// canvas (transferred) on its own animation frames; serial input comes in on a
// port straight to the VM, and the keyboard and tablet ports go to the device
// worker. What stops a machine from starting or running is sorted into a
// `Problem` with a message a user can act on (docs/frontend.md "Errors").
import { bootVm, compileCore, Exit, FLASH_SIZE, PSCI_SYSTEM_OFF, splitError, splitRam, type Restore, type Vm } from '../vm.ts';
import { VENUS_RESERVE } from '../ram.ts';
import { dropSuspend, fileWriter, loadFlash, overlayMeta, saveFlash, suspended, suspendWriter } from '../overlay.ts';
import { showFramebuffer } from '../display.ts';
import { lzCodec } from '../lz.ts';
import { openSnapshot, SnapshotError, type SnapshotHeader, type Sink } from '../snapshot-file.ts';
import { readSnapshot, writeSnapshot, type SnapshotDisk } from '../snapshot.ts';
import { SEVERAL_ADAPTERS, type DeviceSpec } from '../devices.ts';
import { startSampler, startTimeline, type Timeline } from '../profiler.ts';
import { OEM_STRINGS_FILE, oemStrings } from './guest-unit.ts';
import { netCredentials } from './guest-net.ts';
import { keyboardCredentials, keyboardLayout } from './keyboard.ts';
import { SHARES_TAG, sharesCredentials } from './shares-mount.ts';
import { swapCredentials } from './guest-swap.ts';
import { credentialFiles, MACHINES, readyWatcher, withParams, type Machine } from './machine.ts';
import { Signal } from './memory.ts';
import type { FromWorker, PowerState, Problem, StartDisk, Status, ToWorker } from './protocol.ts';
import { CPU_FEATURES, slots, type CpuFeature, type DeviceKind } from './shape.ts';
import type { MachineName } from './machine.ts';
import { bytesText } from './bytes.ts';

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, { transfer });
const state = (s: PowerState, message?: string, problem?: Problem) => post({ type: 'state', state: s, message, problem });
const PANIC = 'Kernel panic - not syncing';

let vm: Vm | undefined;
/** The VM being booted: it may hold the overlay before `bootVm` returns it. */
let booting: Promise<Vm> | undefined;
let stopping = false;
/** The machine this worker was started for. */
let current: Machine | undefined;
/** The OPFS directory of the machine's variable store and suspended copy (the start message's `home`). */
let home: string | undefined;

/** The page's query (the start message's). */
let query = new URLSearchParams();

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'start') {
    query = new URLSearchParams(m.query);
    start(m).catch((err) => {
      if (stopping) return;
      const [problem, message] = explain(err, MACHINES[m.machine]);
      state(vm ? 'crashed' : 'failed', message, problem);
    });
  } else if (m.type === 'snapshot') {
    void saveSnapshot(m.handle, m.keep, m.whole, m.sleep);
  } else if (m.type === 'suspend') {
    void suspend(m.sleep);
  } else if (m.type === 'wake') {
    vm?.wake();
  } else if (m.type === 'profile') {
    void profile(m.on);
  } else if (m.type === 'timeline') {
    void timeline(m.on);
  } else if (m.type === 'heap') {
    if (vm) post({ type: 'heap', heap: vm.heapUse() });
  } else if (m.type === 'stop') {
    stopping = true;
    void (async () => {
      // A machine still booting is closed once it's there (its device worker may have the overlay open).
      const v = vm ?? (await booting?.catch(() => undefined));
      if (v && current) await shutdown(v, current);
      post({ type: 'stopped' });
    })();
  }
};

let stopSampler: (() => Promise<[string, number][]>) | undefined;
/**
 * The guest PC sampler (web/profiler.ts) over every vCPU's counters block, for benchmarks. While it runs, a vCPU
 * publishes its PC every PROFILE_CHUNK steps (`vm_set_chunk`; 32768 otherwise, or at an exit): a sample is then where
 * the vCPU is, not where its last long chunk ended.
 */
const PROFILE_CHUNK = 256;
async function profile(on: boolean) {
  if (on && vm && !stopSampler) {
    vm.setChunk(PROFILE_CHUNK);
    stopSampler = await startSampler(vm.memory, vm.counterBlocks, 50);
  } else if (!on && stopSampler) {
    const stop = stopSampler;
    stopSampler = undefined;
    vm?.setChunk(0);
    post({ type: 'profile', samples: await stop() });
  }
}

let stopTimeline: (() => Promise<Timeline>) | undefined;
/** The vCPU timeline (web/profiler.ts `startTimeline`), for benchmarks. */
async function timeline(on: boolean) {
  if (on && vm && !stopTimeline) {
    stopTimeline = await startTimeline(vm.memory, vm.counterBlocks, vm.liveBlock);
  } else if (!on && stopTimeline) {
    const stop = stopTimeline;
    stopTimeline = undefined;
    post({ type: 'timeline', timeline: await stop() });
  }
}

/** The variable store as last saved (or loaded): the firmware's boot entries and settings, kept beside the disk's overlay. */
let savedFlash: Uint8Array | undefined;
let saving: Promise<void> = Promise.resolve();
const same = (a: Uint8Array, b?: Uint8Array) => !!b && a.length === b.length && a.every((x, i) => x === b[i]);
/** Saves the flash bank if it changed since the last save (a save in flight finishes first). */
function keepFlash(v: Vm, machine: Machine) {
  const flash = v.flash();
  if (!flash || !home || same(flash, savedFlash)) return saving;
  savedFlash = flash;
  return (saving = saving.then(() => saveFlash(home!, flash)).catch(() => { savedFlash = undefined; })); // retried at the next change or tick
}

/** Stops `v` and keeps its variable store (firmware machines); once per machine. */
let closed: Promise<void> | undefined;
const shutdown = (v: Vm, machine: Machine) => (closed ??= (async () => {
  await v.close(); // the vCPUs stop at once; the flash isn't written after that
  await keepFlash(v, machine);
})());

/** An error with the problem it means for the user. */
const failure = (problem: Problem, message: string) => Object.assign(new Error(message), { problem });

/** What this machine is, for a snapshot's header (docs/frontend.md "Snapshots"). */
/** The RAM of the machine being started, MiB (the page's choice, or a snapshot's). */
let ramMiB = 0;
let session: { name: MachineName; ncpus: number; disk: string | null; kinds: DeviceKind[]; cpu: CpuFeature[]; about?: StartMessage['about'] } | undefined;
/** The core, compiled once: `bootVm` and the snapshot codec both take the module. */
let core: WebAssembly.Module | undefined;
let codecP: ReturnType<typeof lzCodec> | undefined;
const codec = () => (codecP ??= lzCodec(core!));
/** The tail of the serial output posted so far: a snapshot carries it, so a restored terminal isn't empty. */
const TAIL = 4096;
let serialTail = '';
let snapshotting = false;
/** The machine was suspended: its run loop ends without a word (the state is `suspended`). */
let isSuspended = false;
/**
 * How long a snapshot waits for the guest to suspend itself after its sleep key: logind took ~1 s on Debian, and a
 * guest that never sleeps on it (no logind) costs every snapshot this wait, the catch-up being the default.
 */
const SLEEP_MS = 10_000;
/**
 * The clock catch-up (docs/frontend.md "The guest's clock"): waits up to `SLEEP_MS` for the guest to suspend itself
 * (PSCI SYSTEM_SUSPEND) after the page pressed its sleep key; whether it did.
 */
async function guestSleeps(v: Vm) {
  post({ type: 'snapshot-progress', phase: 'Putting the guest to sleep', fraction: 0 });
  for (const until = performance.now() + SLEEP_MS; !v.suspended() && performance.now() < until && !stopping;) await new Promise((r) => setTimeout(r, 50));
  return v.suspended();
}
/**
 * A restored guest that went to sleep for its snapshot (the header's `slept`) wakes with its clock moved on by the time
 * the file sat (since the header's `created`): its own resume counts that as sleep (docs/platform.md "System suspend").
 */
function wakeRestored(v: Vm, header: SnapshotHeader) {
  if (!header.slept || !v.suspended()) return;
  const away = Date.now() - Date.parse(header.created);
  if (Number.isFinite(away) && away > 0) v.clockSkip(away);
  v.wake();
}
/** `bootVm` has the snapshot: the disk's overlay may be replaced. */
let restoring = false;
/** The header of the snapshot (or suspended machine) being started from. */
let restoredHeader: SnapshotHeader | undefined;

type StartMessage = Extract<ToWorker, { type: 'start' }>;
/** A transport of the machine: its kind, and the disk it is for a `blk`, the adapter for a `net`. */
type Slot = { kind: DeviceKind; disk?: StartDisk; adapter?: number };

/** The machine's transports in slot order (web/app/shape.ts `slots`): the kinds a snapshot's header lists, so a restore makes the same. */
const layout = (m: StartMessage, machine: Machine): Slot[] =>
  slots({ nets: machine.network ? (m.nets?.length ?? 0) : 0, display: usesGpu(m, machine) ? '2d' : 'none', mouse: !!m.mouse, touch: !!m.touch, clock: !!m.clock, shares: !!m.folders, attachments: m.disks }).map((s) => ({ kind: s.kind, disk: s.attachment === undefined ? undefined : m.disks[s.attachment], adapter: s.adapter }));

/** A disk's device: its source, and its overlay (what the guest trims leaves it; a ramdisk gives the memory back). */
function blkSpec(d: StartDisk, stats?: boolean, keep?: boolean): DeviceSpec {
  const s = d.source;
  const source = 'url' in s ? { url: new URL(s.url, self.location.href).href } : 'file' in s ? { file: s.file } : 'blank' in s ? { source: 'zero' as const, size: s.blank } : 'stored' in s ? { stored: s.stored, size: s.size } : { source: 'ram' as const, size: s.ramdisk, swap: s.swap };
  return { type: 'blk', ...source, overlay: 'ramdisk' in s ? undefined : d.overlay, identity: d.identity, serial: d.serial, discard: true, stats, keep };
}

/** The device in `slot` for this start. */
function device(slot: Slot, m: StartMessage, machine: Machine): DeviceSpec {
  switch (slot.kind) {
    case 'rng': return { type: 'rng' };
    case 'clock': return { type: 'clock' };
    case '9p': {
      // `?sharesasync=<name>,…` (tests, measurements): folders in the browser served as a folder on the computer is.
      const asHost = (query.get('sharesasync') ?? '').split(',');
      return { type: '9p', tag: SHARES_TAG, folders: (m.folders?.list ?? []).map((f) => (asHost.includes(f.name) ? { ...f, kind: 'host' as const } : f)), port: m.folders?.port };
    }
    case 'blk': return blkSpec(slot.disk!, m.ioStats, m.noDiskCache ? false : undefined);
    case 'keyboard': return { type: 'input', kind: 'keyboard', port: m.keyboard };
    case 'tablet': return { type: 'input', kind: 'tablet', port: m.tablet };
    case 'mouse': return { type: 'input', kind: 'mouse', port: m.mouse };
    case 'touch': return { type: 'input', kind: 'touch', port: m.touch };
    case 'gpu': {
      const tuning = gpuTuning();
      const { vulkan, ...rest } = tuning;
      // Vulkan through Venus on a 3D machine (its renderer is the GPU worker's: docs/devices.md "Venus").
      return { type: 'gpu', width: m.size?.width ?? machine.framebuffer.width, height: m.size?.height ?? machine.framebuffer.height, canvas: m.renderer ? undefined : m.screen, port: m.display, stats: m.displayStats, probe: m.avProbe, keepConsole: true, ...rest, virgl: tuning.virgl || !!m.renderer, venus: (vulkan || !!m.vulkan) && !!m.renderer, renderer: m.renderer, caps: m.caps };
    }
    case 'net': {
      const n = m.nets![slot.adapter!];
      // Several adapters: frequent renewals, so the default route follows the primary (network-adapters.md §4).
      return { type: 'net', mac: n.mac, gateway: slot.adapter, ...(m.nets!.length > 1 ? SEVERAL_ADAPTERS : {}), adapter: { ip: n.ip } };
    }
    // Without the page's ring (a page that passed none), the sink plays on its own clock.
    // With the page's sound, its volume and mute are the device's controls (the guest's Master).
    case 'snd': return { type: 'snd', ring: m.sound?.ring, mic: m.sound?.mic, port: m.sound?.port, mixer: m.sound && { level: m.sound.level, muted: m.sound.muted }, ...sndTuning() };
  }
}

/**
 * The sound's tuning, for measurements (docs/audio.md "Measurements"): the page's `?snd=timer` completes played messages
 * on a timer instead of the worklet's notify, `stats` posts their timing once a second (kept in `window.__sndStats`).
 */
function sndTuning() {
  const knobs = (query.get('snd') ?? '').split(',');
  return { wake: knobs.includes('timer') ? 'timer' as const : 'worklet' as const, stats: knobs.includes('stats') };
}
/**
 * The display's tuning: flush replies paced to the frame and a queue of 16 (docs/devices.md "virtio-gpu"); the page's
 * `?gpu=nopace,q<N>` changes them, for measurements; `canvas2d` and `gl2d` choose a 2D machine's screen (web/gpu-present.ts: by default WebGL2 on a GPU, a 2D context elsewhere). 3D is the page's choice (a 3D machine, the default: the start
 * message's `renderer`; `?gpu=2d` turns it off). `?gpu=virgl-null` turns on virgl on the null renderer (G2: the
 * guest's 3D commands are counted, nothing is drawn, so a GL desktop's screen stays black); `capture` adds a trace of
 * them on the display port (web/virgl-trace.ts; the page keeps it in `window.__virglCapture` for a test or a tool).
 * `vulkan` offers Vulkan through Venus on a 3D machine (docs/devices.md "Venus"; VK1: on the null renderer).
 * `nowatch` (with `vulkan`) skips the window's write-watch at each submit: its cost, measured against the default.
 */
function gpuTuning() {
  const knobs = (query.get('gpu') ?? '').split(',');
  const q = knobs.find((k) => /^q\d+$/.test(k));
  return { paceFlushes: !knobs.includes('nopace'), queueSize: q ? Number(q.slice(1)) : 16, virgl: knobs.includes('virgl-null'), vulkan: knobs.includes('vulkan'), noWatch: knobs.includes('nowatch'), capture: knobs.includes('capture'), screen2d: knobs.includes('canvas2d') ? 'canvas2d' as const : knobs.includes('gl2d') ? 'webgl2' as const : 'auto' as const };
}
/** A machine with a virtio-gpu draws through it, unless the page asked for the framebuffer. */
const usesGpu = (m: StartMessage, machine: Machine) => machine.display === 'gpu' && !m.simple;

/**
 * The devices and vCPU count a snapshot's header says, made from what the page passed. Refuses (a
 * `snapshot` problem, with a message for the user) a snapshot of another machine, and one whose
 * devices can't be made here.
 */
function fromHeader(h: SnapshotHeader, m: StartMessage, machine: Machine, name: string) {
  const what = `${name} can't be loaded`;
  // A stored machine's snapshot is checked by its shape (docs/machines.md §5.1): the page checked it first and
  // offers to make a machine like it; here it is refused before anything is touched.
  if (m.about && typeof h.shapeHash === 'string' && h.shapeHash !== m.about.shapeHash) {
    throw failure('snapshot', `${what}: it is a snapshot of a machine with other settings or disks than ${m.about.name} has now.\nIts machine can be made again from it on the Machines page (Make a machine like it).`);
  }
  if (h.machine !== m.machine) {
    const other = typeof h.label === 'string' ? h.label : String(h.machine);
    throw failure('snapshot', `${what}: it is a snapshot of ${other} (?machine=${String(h.machine)}), and this page runs ${machine.label} (?machine=${m.machine}).\nOpen the page for that machine to load it. Start boots ${machine.label} normally.`);
  }
  const kinds = h.devices;
  const all = layout(m, machine);
  if (!Array.isArray(kinds) || !kinds.length || !kinds.every((k) => typeof k === 'string')) {
    throw failure('snapshot', `${what}: its list of devices isn't one this page knows (another version made it?).\nStart boots ${machine.label} normally.`);
  }
  // A snapshot from before the clock device (virtio-rtc) is made without it: it holds no state, and the rest is the same.
  const here = [all, all.filter((s) => s.kind !== 'clock')].find((l) => kinds.join() === l.map((s) => s.kind).join());
  if (!here) {
    throw failure('snapshot', `${what}: its machine had other devices (${kinds.join(', ')}; here: ${all.map((s) => s.kind).join(', ')}).\nOpen this page as that machine was started (the same disks, with its network), or Start ${machine.label} normally.`);
  }
  const ncpus = h.ncpus;
  if (typeof ncpus !== 'number' || !Number.isInteger(ncpus) || ncpus < 1 || ncpus > 64) throw failure('snapshot', `${what}: its processor count isn't readable.\nStart boots ${machine.label} normally.`);
  const specs = here.map((s) => device(s, m, machine));
  // Memory 0's RAM, and the spill memories' (docs/spill-memories.md), as they were.
  const ramSize = Number(h.ramSize);
  const spill = h.spill === undefined ? [] : h.spill;
  if (!Number.isSafeInteger(ramSize) || ramSize < 64 << 20 || !Array.isArray(spill) || splitError(ramSize, spill as number[])) throw failure('snapshot', `${what}: its memory size isn't readable.\nStart boots ${machine.label} normally.`);
  const ram = (ramSize + (spill as number[]).reduce((a, b) => a + b, 0)) / 2 ** 20;
  // A snapshot from before the header said (ABI 34 and older) had none of them.
  const cpu = h.cpu ?? [];
  if (!Array.isArray(cpu) || !cpu.every((f): f is CpuFeature => CPU_FEATURES.includes(f as CpuFeature))) {
    throw failure('snapshot', `${what}: its processor's features aren't ones this page knows (another version made it?).\nStart boots ${machine.label} normally.`);
  }
  return { slots: here, specs, ncpus, ramMiB: ram, split: { ramSize, spill: spill as number[] }, cpu };
}

const CORE = new URL('../../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url).href;
/** A URL as the user knows it: a path in the repository. */
const repoPath = (url: string) => new URL(url).pathname.replace(/^\//, '');

/** Why the file at `url` couldn't be fetched, as a failure a user can act on. */
function missing(url: string, machine: Machine, why: string) {
  if (url === CORE) {
    return failure('missing-core', `The emulator core isn't built: ${repoPath(url)} ${why}.\nRun \`npm start\` in the repository: it builds the core, then serves this page.`);
  }
  return failure('missing-image', `${machine.label}'s image isn't there: ${repoPath(url)} ${why}.\nRun ${machine.prepare}, then Retry.`);
}

/** Fetches `urls` whole, posting the progress over all of them (Content-Length; the server sends it). */
async function download(urls: string[], machine: Machine) {
  const responses = await Promise.all(urls.map(async (url) => {
    const r = await fetch(url).catch(() => { throw failure(url === CORE ? 'missing-core' : 'missing-image', `The server didn't answer for ${repoPath(url)}: is it still running (\`npm start\`)?`); });
    if (!r.ok) throw missing(url, machine, `answered HTTP ${r.status}${r.status === 404 ? ' (not found)' : ''}`);
    return r;
  }));
  const sizes = responses.map((r) => Number(r.headers.get('content-length')) || 0);
  const total = sizes.reduce((a, b) => a + b, 0);
  let loaded = 0;
  let posted = 0;
  const progress = (force = false) => {
    const now = performance.now();
    if (force || now - posted >= 100) {
      posted = now;
      post({ type: 'progress', loaded, total });
    }
  };
  progress(true);
  const files = await Promise.all(responses.map(async (r, i) => {
    const out = new Uint8Array(sizes[i]);
    const parts: Uint8Array[] = []; // past the announced length (none expected)
    let at = 0;
    const reader = r.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done || stopping) break;
      if (at + value.length <= out.length) out.set(value, at);
      else parts.push(value);
      at += value.length;
      loaded += value.length;
      progress();
    }
    if (!parts.length && at === out.length) return out;
    const all = new Uint8Array(at);
    all.set(out.subarray(0, Math.min(at, out.length)));
    for (let k = out.length, j = 0; j < parts.length; k += parts[j++].length) all.set(parts[j], k);
    return all;
  }));
  progress(true);
  return files;
}

/**
 * Firefox's engine (its `InternalError`, which V8 lacks). The compile worker only pays off through V8's
 * process-wide module cache; SpiderMonkey has none, so there it would add a copy of every module, and its
 * process holds ~16K modules' code at most (it throws "out of memory": docs/backlog.md).
 */
const spiderMonkey = 'InternalError' in globalThis;

/** An error from starting or running a machine as `[problem, message]` for the page. */
function explain(err: unknown, machine: Machine): [Problem, string] {
  // A SnapshotError has a `problem` of its own (why the file was refused): checked before the worker's.
  if (err instanceof SnapshotError) {
    // From `readSnapshot` nothing was touched; once `bootVm` has the file, the disk may hold its blocks.
    return ['snapshot', restoring
      ? `The snapshot couldn't be restored: ${err.message}\nThe machine didn't start and its disk may hold part of the snapshot's changes. Start boots ${machine.label} normally from what is there; Reset disk starts over from the image.`
      : `The snapshot couldn't be loaded: ${err.message}\nNothing was changed: the machine isn't running and its disk is as it was. Start boots ${machine.label} normally; Load snapshot… tries another file.`];
  }
  const e = err as Error & { problem?: Problem };
  if (e.problem) return [e.problem, e.message];
  const text = String(e.message ?? e);
  if (/NoModificationAllowedError|overlay \S+ is in use/.test(text)) {
    return ['disk-in-use', `${machine.label}'s disk is in use: another tab or window of this page runs the machine on it (the browser lets one open it at a time).\nClose that tab, then Retry.\n\n${text}`];
  }
  if (/overlay .* belongs to/.test(text)) {
    return ['disk-mismatch', `${machine.label}'s saved disk was written over a different image than the one served now.\nReset the disk to start over from this image (what the machine wrote is deleted).\n\n${text}`];
  }
  if (e instanceof RangeError && /memory/i.test(text)) {
    return ['memory', `The browser couldn't reserve ${ramMiB} MiB for the machine's RAM.\nClose other tabs, then Retry.\n\n${text}`];
  }
  // V8's stack starts with the message; Firefox's is only the frames.
  return ['emulator', `The emulator stopped with an error:\n${e.stack?.includes(text) ? e.stack : `${text}\n${e.stack ?? ''}`.trim()}`];
}

async function start(m: StartMessage, note?: string): Promise<void> {
  const machine: Machine = current = MACHINES[m.machine];
  home = m.home;
  restoredHeader = undefined;
  state('loading');
  // A suspended machine kept beside the disk (docs/frontend.md "Suspend") is resumed, unless the
  // page says boot; either way it is dropped before a machine runs on the disk, which is what
  // keeps a suspended machine and its disk together.
  let resume: Blob | undefined;
  if (home && !m.snapshot) {
    if (m.resume === false) await dropSuspend(home).catch(() => {});
    else resume = await suspended(home).catch(() => undefined);
  }
  const snapshot: Blob | undefined = m.snapshot ?? resume;
  const snapshotName = m.snapshot?.name ?? 'The suspended machine';
  /** A suspended machine that can't be resumed is dropped, and the machine boots. */
  const bootInstead = async (err: unknown) => {
    if (home) await dropSuspend(home).catch(() => {});
    restoring = false;
    return start({ ...m, resume: false }, `The suspended machine couldn't be resumed (${String((err as Error).message ?? err).split('\n')[0]}), so it was dropped and the machine boots from its disk.`);
  };
  // The disk is read by ranges as the guest needs it (not downloaded): check it's there.
  // A snapshot has the variable store in its RAM (the restore writes it beside the overlay) and needs no kernel.
  const flash = !snapshot && machine.firmware && home ? loadFlash(home).then((f) => (f?.length === FLASH_SIZE ? f : undefined), () => undefined) : undefined;
  const urls = m.disks.flatMap((d) => ('url' in d.source ? [new URL(d.source.url, self.location.href).href] : []));
  const disk = Promise.all(urls.map((url) => fetch(url, { method: 'HEAD' }).then((r) => { if (!r.ok) throw missing(url, machine, `answered HTTP ${r.status}${r.status === 404 ? ' (not found)' : ''}`); })));
  const [wasm, kernel = new Uint8Array(0), initrd] = await download([CORE, ...(snapshot ? [] : [machine.kernel, ...(machine.initrd ? [machine.initrd] : [])])], machine);
  await disk;
  if (stopping) return;
  core = await compileCore(wasm);
  // The firmware configuration: what the machine's own credentials and the page's (development, tests) say, and the saved variable store.
  const net = !!m.nets?.length && !!machine.network && m.netConfig;
  const credentials = [...(net ? machine.network!.credentials : []), ...(m.credentials ?? [])];
  savedFlash = await flash;
  // The units' credentials (the keyboard layout, the network's settings, swap ramdisks' fstab lines) are too long for fw_cfg's names: the core puts them in SMBIOS (core/src/smbios.rs).
  const keys = keyboardLayout(m.keyLayout);
  const units = [...(keys ? keyboardCredentials(keys, m.guest.keyboard) : []), ...(net ? netCredentials(m.guest.network) : []), ...(m.sharesPath ? sharesCredentials(m.sharesPath, m.guest.shares) : []), ...swapCredentials(m.disks.flatMap((d) => ('swap' in d.source && d.source.swap ? [d.source.swap] : [])))];
  const oem = units.length ? [{ name: OEM_STRINGS_FILE, data: oemStrings(units).join('\0') }] : [];
  const firmware = machine.firmware ? { flash: savedFlash, fwCfg: [...credentialFiles(credentials), ...oem] } : undefined;
  if (stopping) return;
  let ncpus = m.ncpus;
  ramMiB = m.ramMiB;
  // The transports: the machine's, or a snapshot's (`fromHeader`).
  let here = layout(m, machine);
  let cpu = CPU_FEATURES.filter((f) => m.cpu?.[f] ?? true);
  let restore: Restore | undefined;
  let specs: DeviceSpec[] | undefined;
  // RAM past what memory 0 holds goes to spill memories, NUMA nodes for the guest (docs/spill-memories.md): the
  // user's split, else the automatic one; a snapshot's own.
  // A machine with Vulkan keeps its renderer and window in memory 1, before node 1 (docs/devices.md "Venus").
  const venus = here.some((s) => s.kind === 'gpu') && (gpuTuning().vulkan || !!m.vulkan) && !!m.renderer;
  let split = m.ramSplit ? { ramSize: m.ramSplit[0] * 2 ** 20, spill: m.ramSplit.slice(1).map((n) => n * 2 ** 20) } : splitRam(ramMiB * 2 ** 20, venus ? VENUS_RESERVE : 0);
  if (snapshot) {
    // Everything that can be refused is, before anything is touched (the overlay is replaced inside `bootVm`;
    // a resume keeps it: it is as the suspended machine left it).
    post({ type: 'phase', text: resume ? 'Resuming the suspended machine' : 'Checking the snapshot' });
    try {
      const lz = await codec();
      const { header } = await openSnapshot(snapshot, { codecs: [lz] });
      restoredHeader = header;
      const h = fromHeader(header, m, machine, snapshotName);
      ({ ncpus, ramMiB, cpu, split } = h);
      here = h.slots;
      // A suspended machine resumes only onto its overlays as it left them: the same ones, at the generations it pinned
      // (docs/machines.md §5.3; a switch, a reset, a merge or a boot since moved them on).
      if (resume) {
        for (const d of (header.disks ?? []) as SnapshotDisk[]) {
          if (d.ram || !d.overlay) continue;
          const spec = h.specs[d.slot];
          if (spec?.type !== 'blk' || spec.overlay !== d.overlay || (await overlayMeta(d.overlay)).generation !== d.generation) throw new Error('its disk has changed since it was suspended');
        }
      }
      restore = (await readSnapshot(snapshot, lz, lz.snapshotVersion, { devices: h.specs, resume: !!resume, plan: m.plan })).restore;
      specs = h.specs; // the restore hands ramdisks their chunks through these
      serialTail = typeof header.serial === 'string' ? header.serial : '';
    } catch (err) {
      if (resume && !stopping) return bootInstead(err);
      throw err;
    }
    if (!resume) post({ type: 'phase', text: 'Restoring the machine' });
    if (stopping) return;
    restoring = !resume;
  }
  // A split made without Vulkan's renderer and window in memory 1 (a definition, `?split=`, a record from before
  // they moved there, a snapshot of a machine without Vulkan) can't be laid out: say why, not "couldn't reserve".
  const withVenus = here.some((s) => s.kind === 'gpu') && (gpuTuning().vulkan || !!m.vulkan) && !!m.renderer;
  const tooBig = withVenus && splitError(split.ramSize, split.spill, VENUS_RESERVE);
  if (tooBig) {
    const from = snapshot ? 'the snapshot\'s memory split' : 'its memory split';
    throw failure('memory', `${machine.label} can't start with Vulkan and ${from}: ${tooBig}.\n${snapshot ? 'Turn Vulkan off for it, or Start it normally.' : 'Change its memory on the Machines page (or the split in the address), or turn Vulkan off for it.'}`);
  }
  const devices = liveSpecs = specs ?? here.map((s) => device(s, m, machine));
  const kinds = here.map((s) => s.kind);
  // The status's disks and adapters (`Status.disks`, `nets`): the device index of each of the page's, in its order.
  const io = { disks: here.flatMap((s, i) => (s.kind === 'blk' ? [i] : [])), nets: machine.network ? here.flatMap((s, i) => (s.kind === 'net' ? [i] : [])) : undefined };
  session = { name: m.machine, ncpus, disk: m.disks[0] && !m.disks[0].own ? m.disks[0].name : null, kinds, cpu, about: m.about };
  const { ramSize, spill } = split;
  booting = bootVm(core, {
    ramSize, spill, kernel, initrd, cmdline: machine.firmware ? '' : withParams(machine.cmdline, m.params ?? ''), firmware, jit: 1, jitBytes: m.jitMiB ? m.jitMiB * 2 ** 20 : undefined, ncpus, parallel: true, realtime: true, compileWorker: query.get('jit') !== 'nocw' && !spiderMonkey, fma: query.get('fma') !== 'emul', exactCore: !query.has('growcore'), vcpuYieldMs: query.has('vyield') ? Number(query.get('vyield')) : undefined, rng: cpu.includes('rng'), e0pd: cpu.includes('e0pd'), sha3: cpu.includes('sha3'), jscvt: cpu.includes('jscvt'), rcpc: cpu.includes('rcpc'), sb: cpu.includes('sb'), flagm: cpu.includes('flagm'), dit: cpu.includes('dit'), frintts: cpu.includes('frintts'), dotprod: cpu.includes('dotprod'),
    framebuffer: kinds.includes('gpu') ? undefined : machine.framebuffer, serialIn: m.serial, restore, devices, usb: m.usb ? { port: m.usb } : undefined, onNotice: (message) => post({ type: 'notice', message }),
    // No idleLimitMs: an idle guest may sleep as long as it likes.
  });
  try {
    vm = await booting;
  } catch (err) {
    if (resume && !stopping) return bootInstead(err);
    throw err;
  }
  if (stopping) return; // `stop` closes it
  if (restoredHeader) wakeRestored(vm, restoredHeader);
  // The resumed machine is about to write its disk: its suspended copy is void from here.
  if (resume) await dropSuspend(home!);
  if (restore) await keepFlash(vm, machine); // the restore deleted the copy beside the overlay: the bank the machine has goes back
  if (vm.framebuffer && m.screen) showFramebuffer(m.screen, vm.memory, vm.framebuffer, () => post({ type: 'screen' })); // on this worker's animation frames
  const t0 = performance.now();
  const ready = readyWatcher(machine.ready);
  let running = !!restore; // a restored machine is where it was: there's no marker to wait for
  let panicked = ''; // the message
  let tail = ''; // the last output, for markers split across drains
  let loopAt = performance.now(); // the run loop's last iteration
  let loopMax = 0;
  const output = (text: string) => {
    if (!text) return;
    post({ type: 'serial', data: text });
    serialTail = (serialTail + text).slice(-TAIL);
    // The panic is looked for in the new text with the end of the old (a line split between drains), before that end is
    // cut to 256 characters: a loaded host drains the panic line and its whole stack trace at once, and a cut first lost it.
    const seen = tail + text;
    tail = seen.slice(-256);
    if (!running && ready(text)) {
      running = true;
      state('running');
    }
    const at = seen.indexOf(PANIC);
    // The guest hangs (or resets, with panic=N: the page keeps the crash on show rather than restarting).
    if (!panicked && at >= 0 && seen.indexOf('\n', at) >= 0) {
      panicked = `The guest's kernel panicked: ${seen.slice(at).split('\n')[0].trim()}\nThe serial log shows what led to it; Restart boots the machine again.`;
      state('crashed', panicked, 'panic');
    }
  };
  if (restore) {
    if (serialTail) post({ type: 'serial', data: serialTail, replay: true }); // what the terminal showed when it was saved
    state('running', resume ? 'Resumed the suspended machine.' : undefined);
  } else {
    state('booting', note);
  }
  // Once a second on a timer, not from the loop: a stuck loop then shows in `loopAgeMs` rather than as silence.
  let ticks = 0;
  const signal = new Signal();
  const timer = setInterval(() => {
    // A tab can close without a shutdown: the variable store is kept as it changes (every 5 s at most).
    if (machine.firmware && ++ticks % 5 === 0) void keepFlash(vm!, machine);
    const now = performance.now();
    const st = status(vm!, ncpus, ramMiB, now - t0, loopMax, now - loopAt, io);
    // The memory signal (web/app/memory.ts): past what the device reports, the JIT's cache holds no more than it does now
    // (the gauge's limit: it flushes there, docs/jit.md "The page's memory signal").
    const device = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (device && signal.update(st.memory, ncpus) > device * 2 ** 30 && !st.memory.jitLimit) vm!.setJitLimit(Math.max(st.memory.jitLiveBytes, 1));
    post({ type: 'status', status: st });
    loopMax = 0;
  }, 1000);
  // The keyboard's driver: the page sends keys typed on the screen to the serial console until it is up (the firmware's menus, GRUB).
  const kbd = kinds.indexOf('keyboard');
  let kbdLive: boolean | undefined;
  const kbdTimer = kbd >= 0 ? setInterval(() => {
    const live = (vm!.deviceStatus(kbd) & 4) !== 0;
    if (live !== kbdLive) post({ type: 'keyboard', live: (kbdLive = live) });
  }, 200) : undefined;
  try {
    for (;;) {
      const r = await vm.runAsync(1e9); // while a snapshot pauses the VM this keeps returning BUDGET
      if (stopping || isSuspended) return;
      output(vm.drain());
      const now = performance.now();
      loopMax = Math.max(loopMax, now - loopAt);
      loopAt = now;
      if (r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL) continue;
      // Every vCPU has stopped.
      output(vm.drain());
      await shutdown(vm, machine);
      if (panicked) return; // said
      else if (r.kind === Exit.PSCI) state(r.x[0] === PSCI_SYSTEM_OFF ? 'off' : 'rebooting');
      else state('crashed', `The emulator stopped: ${r.kind === Exit.UNIMPLEMENTED ? `an unimplemented instruction or register at pc 0x${vm.pc().toString(16)}` : `exit ${r.kind}`}.`, 'emulator');
      return;
    }
  } finally {
    clearInterval(timer);
    clearInterval(kbdTimer);
  }
}

/** A snapshot's header fields (beside the core's): what the machine is, its shape for a stored one, the terminal's tail from `cut`. */
function header(s: NonNullable<typeof session>, cut: number) {
  const about = s.about ? { name: s.about.name, shape: s.about.shape, shapeHash: s.about.shapeHash, urls: s.about.urls, format: 2 } : {};
  return { machine: s.name, label: current?.label, ncpus: s.ncpus, disk: s.disk, devices: s.kinds, cpu: s.cpu, serial: serialTail.slice(cut), ...about };
}
/** Whether the disk in `slot` is a stored disk written in place (its overlay is its store: `disks/<id>`). */
const inPlace = (slot: number) => { const d = liveSpecs[slot]; return d?.type === 'blk' && !!d.overlay?.startsWith('disks/'); };
/** The running machine's device specs, by slot. */
let liveSpecs: DeviceSpec[] = [];

/**
 * Saves a snapshot of the running machine (docs/frontend.md "Snapshots"): the VM is paused, written
 * to the picked file's stream or sent back in chunks, and resumed, also on an error. Only the
 * writing is between pause and resume: the file's stream is opened before, and closed (flushed)
 * after.
 */
async function saveSnapshot(handle?: FileSystemFileHandle, keep?: string, whole = false, sleep = false) {
  const fail = (message: string) => post({ type: 'snapshot-error', message });
  const v = vm;
  const s = session;
  if (!v || !s || stopping || closed) return fail("The machine isn't running, so there is nothing to save.");
  if (snapshotting) return fail('A snapshot is already being saved.');
  snapshotting = true;
  let out: FileSystemWritableFileStream | undefined;
  let kept: Awaited<ReturnType<typeof fileWriter>> | undefined;
  let paused = false;
  let slept = false;
  try {
    const lz = await codec();
    out = await handle?.createWritable();
    kept = keep ? await fileWriter(keep) : undefined;
    const sink: Sink = async (chunk) => {
      if (kept) return kept.write(chunk);
      if (out) return out.write(chunk as Uint8Array<ArrayBuffer>);
      const copy = chunk.slice(); // a transferred buffer must be ours alone
      post({ type: 'snapshot-chunk', data: copy }, [copy.buffer]);
    };
    if (sleep) await guestSleeps(v);
    post({ type: 'snapshot-progress', phase: 'Pausing the machine', fraction: 0 });
    const t0 = performance.now();
    if (!(await v.pause())) throw new Error('the machine ended before it could be paused');
    paused = true;
    slept = sleep && v.suspended();
    // The terminal's tail from a line start: a cut escape sequence would draw garbage in the restored terminal.
    const cut = serialTail.length >= TAIL ? serialTail.indexOf('\n') + 1 : 0;
    const meta = { ...header(s, cut), ...(slept ? { slept: true } : {}) };
    let posted = 0;
    const held = performance.now(); // the core holds the guest's clock from the state's save until it runs again
    const w = await writeSnapshot(v, sink, meta, lz, {
      omit: (slot) => !whole && inPlace(slot),
      progress: (done, total) => {
        const now = performance.now();
        if (now - posted < 100 && done < total) return;
        posted = now;
        post({ type: 'snapshot-progress', phase: 'Writing the snapshot', fraction: total ? done / total : 0 });
      },
    });
    // A guest asleep for the file wakes with the time its clock was held as sleep, so it doesn't fall behind here either.
    if (slept) v.clockSkip(performance.now() - held);
    v.resume();
    paused = false;
    if (sleep) v.wake(); // asleep for the file only (or late to it: it slept after the wait)
    const pausedMs = performance.now() - t0;
    post({ type: 'snapshot-progress', phase: 'Finishing the file', fraction: 1 });
    await out?.close();
    out = undefined;
    kept?.close();
    kept = undefined;
    post({ type: 'snapshot-done', bytes: w.bytes, pausedMs, stateMs: w.stateMs, blobBytes: w.blobBytes, pins: w.pins, slept });
  } catch (err) {
    fail(`The snapshot couldn't be saved: ${String((err as Error).message ?? err)}`);
  } finally {
    if (paused) v.resume();
    if (sleep) v.wake();
    await out?.abort().catch(() => {});
    await kept?.abort().catch(() => {});
    snapshotting = false;
  }
}

/**
 * Suspends the machine (docs/frontend.md "Suspend"): paused, its snapshot without the disk's blocks
 * is written beside the overlay, and the machine is closed without running another step, so the
 * overlay is exactly what the file's RAM expects. A failure before that leaves it running.
 */
async function suspend(sleep = false) {
  const fail = (message: string) => post({ type: 'snapshot-error', message });
  const v = vm;
  const s = session;
  const machine = current;
  if (!v || !s || !machine || stopping || closed) return fail("The machine isn't running, so there is nothing to suspend.");
  if (!home) return fail('This machine has no disk of its own to keep a suspended copy beside.');
  if (snapshotting) return fail('A snapshot is being saved: suspend once it is done.');
  snapshotting = true;
  let paused = false;
  try {
    const lz = await codec();
    if (sleep) await guestSleeps(v);
    post({ type: 'snapshot-progress', phase: 'Pausing the machine', fraction: 0 });
    if (!(await v.pause())) throw new Error('the machine ended before it could be paused');
    paused = true;
    const cut = serialTail.length >= TAIL ? serialTail.indexOf('\n') + 1 : 0;
    const meta = { ...header(s, cut), ...(sleep && v.suspended() ? { slept: true } : {}) };
    const out = await suspendWriter(home);
    let bytes = 0;
    try {
      let posted = 0;
      const w = await writeSnapshot(v, (chunk) => out.write(chunk), meta, lz, {
        suspend: true,
        progress: (done, total) => {
          const now = performance.now();
          if (now - posted < 100 && done < total) return;
          posted = now;
          post({ type: 'snapshot-progress', phase: 'Suspending the machine', fraction: total ? done / total : 0 });
        },
      });
      out.close();
      bytes = w.bytes;
    } catch (err) {
      await out.abort();
      throw err;
    }
    // From here the machine must not run: the file is only good for the disk as it is now.
    isSuspended = true;
    await shutdown(v, machine);
    state('suspended', `Suspended: the machine's memory is kept in this browser (${bytesText(bytes)}). Start resumes it where it was; Boot instead starts it from its disk, as after a power cut.`);
  } catch (err) {
    if (paused && !isSuspended) v.resume();
    if (sleep && !isSuspended) v.wake();
    fail(`The machine couldn't be suspended: ${String((err as Error).message ?? err)}`);
  } finally {
    snapshotting = false;
  }
}

/** `io`: the device index of each of the page's disks and adapters, in its order (none: a machine without `network`). */
function status(vm: Vm, ncpus: number, ramMiB: number, uptime: number, loopMaxMs: number, loopAgeMs: number, io: { disks: number[]; nets?: number[] }): Status {
  const s = vm.stats();
  const c = vm.deviceIo(); // two per device: blk read, written; net received, sent
  return {
    ncpus, ramMiB, uptime, steps: s.steps, jitBlocks: s.jit.blocks, jitFlushes: s.jit.flushes, jitCompileMs: s.jit.compileNs / 1e6, jitSteps: s.jit.steps, jitBytes: s.jit.bytes, irqs: s.irqs, loopMaxMs, loopAgeMs, vcpus: vm.liveness(), stats: s, memory: vm.hostUse(),
    disks: io.disks.map((i) => ({ read: c[2 * i], written: c[2 * i + 1] })),
    nets: io.nets?.map((i) => ({ rx: c[2 * i], tx: c[2 * i + 1] })),
    cpus: vm.parallel ? vm.cpuStats().map((b) => ({ steps: b.steps, jitSteps: b.jit.steps })) : undefined,
    asleep: vm.suspended(),
  };
}
