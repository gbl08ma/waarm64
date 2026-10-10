// The machine worker (docs/frontend.md): boots one of web/app/machine.ts's
// machines under the JIT, realtime with a worker per vCPU (web/vm.ts), and runs
// it until it stops, talking to the page through web/app/protocol.ts. It
// drains the serial console after every `runAsync` (which returns as soon as
// there's new output) and posts the text, and draws the screen on the page's
// canvas (transferred) on its own animation frames; serial input comes in on a
// port straight to the VM, and the keyboard and tablet ports go to the device
// worker. What stops a machine from starting or running is sorted into a
// `Problem` with a message a user can act on (docs/frontend.md "Errors").
import { bootVm, Exit, FLASH_SIZE, PSCI_SYSTEM_OFF, type Restore, type Vm } from '../vm.ts';
import { dropSuspend, loadFlash, saveFlash, suspended, suspendWriter } from '../overlay.ts';
import { showFramebuffer } from '../display.ts';
import { lzCodec } from '../lz.ts';
import { openSnapshot, SnapshotError, type SnapshotHeader, type Sink } from '../snapshot-file.ts';
import { readSnapshot, writeSnapshot } from '../snapshot.ts';
import type { DeviceSpec } from '../devices.ts';
import { startSampler } from '../profiler.ts';
import { credentialFiles, MACHINES, readyWatcher, withParams, type Machine } from './machine.ts';
import type { FromWorker, PowerState, Problem, Status, ToWorker } from './protocol.ts';
import type { MachineName } from './machine.ts';

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, { transfer });
const state = (s: PowerState, message?: string, problem?: Problem) => post({ type: 'state', state: s, message, problem });
const PANIC = 'Kernel panic - not syncing';

let vm: Vm | undefined;
/** The VM being booted: it may hold the overlay before `bootVm` returns it. */
let booting: Promise<Vm> | undefined;
let stopping = false;
/** The machine this worker was started for. */
let current: Machine | undefined;
/** The OPFS overlay of the disk it boots: the machine's, or the chosen disk's. */
let overlayName: string | undefined;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'start') {
    start(m).catch((err) => {
      if (stopping) return;
      const [problem, message] = explain(err, MACHINES[m.machine]);
      state(vm ? 'crashed' : 'failed', message, problem);
    });
  } else if (m.type === 'snapshot') {
    void saveSnapshot(m.handle);
  } else if (m.type === 'suspend') {
    void suspend();
  } else if (m.type === 'profile') {
    void profile(m.on);
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

/** The variable store as last saved (or loaded): the firmware's boot entries and settings, kept beside the disk's overlay. */
let savedFlash: Uint8Array | undefined;
let saving: Promise<void> = Promise.resolve();
const same = (a: Uint8Array, b?: Uint8Array) => !!b && a.length === b.length && a.every((x, i) => x === b[i]);
/** Saves the flash bank if it changed since the last save (a save in flight finishes first). */
function keepFlash(v: Vm, machine: Machine) {
  const flash = v.flash();
  if (!flash || !overlayName || same(flash, savedFlash)) return saving;
  savedFlash = flash;
  return (saving = saving.then(() => saveFlash(overlayName!, flash)).catch(() => { savedFlash = undefined; })); // retried at the next change or tick
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
let session: { name: MachineName; ncpus: number; disk: string | null; kinds: DeviceKind[] } | undefined;
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
/** `bootVm` has the snapshot: the disk's overlay may be replaced. */
let restoring = false;

/** The devices of a machine in slot order: the kinds a snapshot's header lists, so a restore makes the same. */
type DeviceKind = 'rng' | 'blk' | 'blk-ro' | 'keyboard' | 'tablet' | 'net' | 'gpu';
const KINDS: DeviceKind[] = ['rng', 'blk', 'blk-ro', 'keyboard', 'tablet', 'net', 'gpu'];
type StartMessage = Extract<ToWorker, { type: 'start' }>;

/** The device of `kind` for this start, or what the page's options lack to make it. */
function device(kind: DeviceKind, m: StartMessage, machine: Machine, diskUrl: string): DeviceSpec | string {
  switch (kind) {
    case 'rng': return { type: 'rng' };
    case 'blk': return { type: 'blk', url: diskUrl, file: m.disk?.file, overlay: overlayName, discard: true }; // what the guest trims leaves the overlay
    case 'blk-ro': return m.disk2 ? { type: 'blk', url: new URL(m.disk2, self.location.href).href } : 'a second disk (?disk2=<url>), and this page was opened without one'; // no overlay: read-only
    case 'keyboard': return { type: 'input', kind: 'keyboard', port: m.keyboard };
    case 'tablet': return { type: 'input', kind: 'tablet', port: m.tablet };
    case 'gpu': {
      const tuning = gpuTuning();
      return { type: 'gpu', width: m.size?.width ?? machine.framebuffer.width, height: m.size?.height ?? machine.framebuffer.height, canvas: m.renderer ? undefined : m.screen, port: m.display, stats: m.displayStats, keepConsole: true, ...tuning, virgl: tuning.virgl || !!m.renderer, renderer: m.renderer, caps: m.caps };
    }
    case 'net': return m.ip && machine.network ? { type: 'net', adapter: { ip: m.ip } } : 'a network card, and this machine has no network port';
  }
}

/** The kinds a normal start makes, as the page's options say. */
const normalKinds = (m: StartMessage, machine: Machine): DeviceKind[] => ['rng', 'blk', ...(m.disk2 ? ['blk-ro' as const] : []), 'keyboard', 'tablet', ...(m.ip && machine.network ? ['net' as const] : []), ...(usesGpu(m, machine) ? ['gpu' as const] : [])];
/**
 * The display's tuning: flush replies paced to the frame and a queue of 16 (docs/devices.md "virtio-gpu"); the page's
 * `?gpu=nopace,q<N>` changes them, for measurements. 3D is the page's choice (a 3D machine, the default: the start
 * message's `renderer`; `?gpu=2d` turns it off). `?gpu=virgl-null` turns on virgl on the null renderer (G2: the
 * guest's 3D commands are counted, nothing is drawn, so a GL desktop's screen stays black); `capture` adds a trace of
 * them on the display port (web/virgl-trace.ts; the page keeps it in `window.__virglCapture` for a test or a tool).
 */
function gpuTuning() {
  const knobs = (new URLSearchParams(self.location.search).get('gpu') ?? '').split(',');
  const q = knobs.find((k) => /^q\d+$/.test(k));
  return { paceFlushes: !knobs.includes('nopace'), queueSize: q ? Number(q.slice(1)) : 16, virgl: knobs.includes('virgl-null'), capture: knobs.includes('capture') };
}
/** A machine with a virtio-gpu draws through it, unless the page asked for the framebuffer. */
const usesGpu = (m: StartMessage, machine: Machine) => machine.display === 'gpu' && !m.simple;

/**
 * The devices and vCPU count a snapshot's header says, made from what the page passed. Refuses (a
 * `snapshot` problem, with a message for the user) a snapshot of another machine, and one whose
 * devices can't be made here.
 */
function fromHeader(h: SnapshotHeader, m: StartMessage, machine: Machine, diskUrl: string, name: string) {
  const what = `${name} can't be loaded`;
  if (h.machine !== m.machine) {
    const other = typeof h.label === 'string' ? h.label : String(h.machine);
    throw failure('snapshot', `${what}: it is a snapshot of ${other} (?machine=${String(h.machine)}), and this page runs ${machine.label} (?machine=${m.machine}).\nOpen the page for that machine to load it. Start boots ${machine.label} normally.`);
  }
  const kinds = h.devices;
  if (!Array.isArray(kinds) || !kinds.length || !kinds.every((k): k is DeviceKind => KINDS.includes(k as DeviceKind))) {
    throw failure('snapshot', `${what}: its list of devices isn't one this page knows (another version made it?).\nStart boots ${machine.label} normally.`);
  }
  const ncpus = h.ncpus;
  if (typeof ncpus !== 'number' || !Number.isInteger(ncpus) || ncpus < 1 || ncpus > 64) throw failure('snapshot', `${what}: its processor count isn't readable.\nStart boots ${machine.label} normally.`);
  const specs = kinds.map((k) => {
    const d = device(k, m, machine, diskUrl);
    if (typeof d === 'string') throw failure('snapshot', `${what}: its machine had ${d}.\nOpen this page as that machine was started (the same ?disk2=…, with its network), or Start ${machine.label} normally.`);
    return d;
  });
  const ram = Number(h.ramSize) / 2 ** 20;
  if (!Number.isInteger(ram) || ram < 64 || ram > 3072) throw failure('snapshot', `${what}: its memory size isn't readable.\nStart boots ${machine.label} normally.`);
  return { specs, kinds, ncpus, ramMiB: ram };
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
  return ['emulator', `The emulator stopped with an error:\n${e.stack ?? text}`];
}

async function start(m: StartMessage, note?: string): Promise<void> {
  const machine: Machine = current = MACHINES[m.machine];
  overlayName = m.disk?.overlay ?? machine.overlay;
  state('loading');
  // A suspended machine kept beside the disk (docs/frontend.md "Suspend") is resumed, unless the
  // page says boot; either way it is dropped before a machine runs on the disk, which is what
  // keeps a suspended machine and its disk together.
  let resume: Blob | undefined;
  if (overlayName && !m.snapshot) {
    if (m.resume === false) await dropSuspend(overlayName).catch(() => {});
    else resume = await suspended(overlayName).catch(() => undefined);
  }
  const snapshot: Blob | undefined = m.snapshot ?? resume;
  const snapshotName = m.snapshot?.name ?? 'The suspended machine';
  /** A suspended machine that can't be resumed is dropped, and the machine boots. */
  const bootInstead = async (err: unknown) => {
    if (overlayName) await dropSuspend(overlayName).catch(() => {});
    restoring = false;
    return start({ ...m, resume: false }, `The suspended machine couldn't be resumed (${String((err as Error).message ?? err).split('\n')[0]}), so it was dropped and the machine boots from its disk.`);
  };
  // The disk is read by ranges as the guest needs it (not downloaded): check it's there.
  // A snapshot has the variable store in its RAM (the restore writes it beside the overlay) and needs no kernel.
  const flash = !snapshot && machine.firmware && overlayName ? loadFlash(overlayName).then((f) => (f?.length === FLASH_SIZE ? f : undefined), () => undefined) : undefined;
  const diskUrl = m.disk?.url ?? machine.disk;
  const disk = m.disk?.file ? Promise.resolve() : fetch(diskUrl, { method: 'HEAD' }).then((r) => { if (!r.ok) throw missing(diskUrl, machine, `answered HTTP ${r.status}${r.status === 404 ? ' (not found)' : ''}`); });
  const [wasm, kernel = new Uint8Array(0), initrd] = await download([CORE, ...(snapshot ? [] : [machine.kernel, ...(machine.initrd ? [machine.initrd] : [])])], machine);
  await disk;
  if (stopping) return;
  core = await WebAssembly.compile(wasm);
  // The firmware configuration: what the machine's own credentials and the page's (development, tests) say, and the saved variable store.
  const credentials = [...(m.ip && machine.network ? machine.network.credentials : []), ...(m.credentials ?? [])];
  savedFlash = await flash;
  const firmware = machine.firmware ? { flash: savedFlash, fwCfg: credentialFiles(credentials) } : undefined;
  if (stopping) return;
  let ncpus = m.ncpus;
  ramMiB = m.ramMiB;
  let kinds = normalKinds(m, machine);
  let restore: Restore | undefined;
  if (snapshot) {
    // Everything that can be refused is, before anything is touched (the overlay is replaced inside `bootVm`;
    // a resume keeps it: it is as the suspended machine left it).
    post({ type: 'phase', text: resume ? 'Resuming the suspended machine' : 'Checking the snapshot' });
    try {
      const lz = await codec();
      const { header } = await openSnapshot(snapshot, { codecs: [lz] });
      const h = fromHeader(header, m, machine, diskUrl, snapshotName);
      ({ kinds, ncpus, ramMiB } = h);
      restore = (await readSnapshot(snapshot, lz, lz.snapshotVersion, { devices: h.specs, resume: !!resume })).restore;
      serialTail = typeof header.serial === 'string' ? header.serial : '';
    } catch (err) {
      if (resume && !stopping) return bootInstead(err);
      throw err;
    }
    if (!resume) post({ type: 'phase', text: 'Restoring the machine' });
    if (stopping) return;
    restoring = !resume;
  }
  const devices = kinds.map((k) => device(k, m, machine, diskUrl) as DeviceSpec);
  session = { name: m.machine, ncpus, disk: m.disk ? (m.disk.file?.name ?? new URL(m.disk.url!, self.location.href).pathname.split('/').pop() ?? 'disk') : null, kinds };
  booting = bootVm(core, {
    ramSize: ramMiB * 2 ** 20, kernel, initrd, cmdline: machine.firmware ? '' : withParams(machine.cmdline, m.params ?? ''), firmware, jit: 1, ncpus, parallel: true, realtime: true,
    framebuffer: kinds.includes('gpu') ? undefined : machine.framebuffer, serialIn: m.serial, restore, devices,
    // No idleLimitMs: an idle guest may sleep as long as it likes.
  });
  try {
    vm = await booting;
  } catch (err) {
    if (resume && !stopping) return bootInstead(err);
    throw err;
  }
  if (stopping) return; // `stop` closes it
  // The resumed machine is about to write its disk: its suspended copy is void from here.
  if (resume) await dropSuspend(overlayName!);
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
    tail = (tail + text).slice(-256);
    if (!running && ready(text)) {
      running = true;
      state('running');
    }
    const at = tail.indexOf(PANIC);
    // The guest hangs (or resets, with panic=N: the page keeps the crash on show rather than restarting).
    if (!panicked && at >= 0 && tail.indexOf('\n', at) >= 0) {
      panicked = `The guest's kernel panicked: ${tail.slice(at).split('\n')[0].trim()}\nThe serial log shows what led to it; Restart boots the machine again.`;
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
  const timer = setInterval(() => {
    // A tab can close without a shutdown: the variable store is kept as it changes (every 5 s at most).
    if (machine.firmware && ++ticks % 5 === 0) void keepFlash(vm!, machine);
    const now = performance.now();
    post({ type: 'status', status: status(vm!, ncpus, ramMiB, now - t0, loopMax, now - loopAt) });
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

/**
 * Saves a snapshot of the running machine (docs/frontend.md "Snapshots"): the VM is paused, written
 * to the picked file's stream or sent back in chunks, and resumed, also on an error. Only the
 * writing is between pause and resume: the file's stream is opened before, and closed (flushed)
 * after.
 */
async function saveSnapshot(handle?: FileSystemFileHandle) {
  const fail = (message: string) => post({ type: 'snapshot-error', message });
  const v = vm;
  const s = session;
  if (!v || !s || stopping || closed) return fail("The machine isn't running, so there is nothing to save.");
  if (snapshotting) return fail('A snapshot is already being saved.');
  snapshotting = true;
  let out: FileSystemWritableFileStream | undefined;
  let paused = false;
  try {
    const lz = await codec();
    out = await handle?.createWritable();
    const sink: Sink = async (chunk) => {
      if (out) return out.write(chunk as Uint8Array<ArrayBuffer>);
      const copy = chunk.slice(); // a transferred buffer must be ours alone
      post({ type: 'snapshot-chunk', data: copy }, [copy.buffer]);
    };
    post({ type: 'snapshot-progress', phase: 'Pausing the machine', fraction: 0 });
    const t0 = performance.now();
    if (!(await v.pause())) throw new Error('the machine ended before it could be paused');
    paused = true;
    // The terminal's tail from a line start: a cut escape sequence would draw garbage in the restored terminal.
    const cut = serialTail.length >= TAIL ? serialTail.indexOf('\n') + 1 : 0;
    const meta = { machine: s.name, label: current?.label, ncpus: s.ncpus, disk: s.disk, devices: s.kinds, serial: serialTail.slice(cut) };
    let posted = 0;
    const w = await writeSnapshot(v, sink, meta, lz, {
      progress: (done, total) => {
        const now = performance.now();
        if (now - posted < 100 && done < total) return;
        posted = now;
        post({ type: 'snapshot-progress', phase: 'Writing the snapshot', fraction: total ? done / total : 0 });
      },
    });
    v.resume();
    paused = false;
    const pausedMs = performance.now() - t0;
    post({ type: 'snapshot-progress', phase: 'Finishing the file', fraction: 1 });
    await out?.close();
    out = undefined;
    post({ type: 'snapshot-done', bytes: w.bytes, pausedMs });
  } catch (err) {
    fail(`The snapshot couldn't be saved: ${String((err as Error).message ?? err)}`);
  } finally {
    if (paused) v.resume();
    await out?.abort().catch(() => {});
    snapshotting = false;
  }
}

/**
 * Suspends the machine (docs/frontend.md "Suspend"): paused, its snapshot without the disk's blocks
 * is written beside the overlay, and the machine is closed without running another step, so the
 * overlay is exactly what the file's RAM expects. A failure before that leaves it running.
 */
async function suspend() {
  const fail = (message: string) => post({ type: 'snapshot-error', message });
  const v = vm;
  const s = session;
  const machine = current;
  if (!v || !s || !machine || stopping || closed) return fail("The machine isn't running, so there is nothing to suspend.");
  if (!overlayName) return fail('This machine has no disk of its own to keep a suspended copy beside.');
  if (snapshotting) return fail('A snapshot is being saved: suspend once it is done.');
  snapshotting = true;
  let paused = false;
  try {
    const lz = await codec();
    post({ type: 'snapshot-progress', phase: 'Pausing the machine', fraction: 0 });
    if (!(await v.pause())) throw new Error('the machine ended before it could be paused');
    paused = true;
    const cut = serialTail.length >= TAIL ? serialTail.indexOf('\n') + 1 : 0;
    const meta = { machine: s.name, label: machine.label, ncpus: s.ncpus, disk: s.disk, devices: s.kinds, serial: serialTail.slice(cut) };
    const out = await suspendWriter(overlayName);
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
    state('suspended', `Suspended: the machine's memory is kept in this browser (${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB). Start resumes it where it was; Boot instead starts it from its disk, as after a power cut.`);
  } catch (err) {
    if (paused && !isSuspended) v.resume();
    fail(`The machine couldn't be suspended: ${String((err as Error).message ?? err)}`);
  } finally {
    snapshotting = false;
  }
}

function status(vm: Vm, ncpus: number, ramMiB: number, uptime: number, loopMaxMs: number, loopAgeMs: number): Status {
  const s = vm.stats();
  return { ncpus, ramMiB, uptime, steps: s.steps, jitBlocks: s.jit.blocks, jitFlushes: s.jit.flushes, jitCompileMs: s.jit.compileNs / 1e6, jitSteps: s.jit.steps, jitBytes: s.jit.bytes, irqs: s.irqs, loopMaxMs, loopAgeMs, vcpus: vm.liveness(), stats: s };
}
