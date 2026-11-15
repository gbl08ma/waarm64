// The machine worker (docs/frontend.md): boots one of web/app/machine.ts's
// machines under the JIT, realtime with a worker per vCPU (web/vm.ts), and runs
// it until it stops, talking to the page through web/app/protocol.ts. It
// drains the serial console after every `runAsync` (which returns as soon as
// there's new output) and posts the text, and draws the screen on the page's
// canvas (transferred) on its own animation frames; serial input comes in on a
// port straight to the VM, and the keyboard and tablet ports go to the device
// worker. What stops a machine from starting or running is sorted into a
// `Problem` with an error a user can act on (docs/frontend.md "Errors"; web/app/worker-errors.ts): the worker renders
// no words, it posts messages (web/msg.ts) and errors (`toWire`) for the page to say. This module holds the run's state,
// the start and the run loop; what a start fetches and makes is web/app/worker-start.ts's, snapshots and suspension
// web/app/worker-snapshot.ts's.
import { bootVm, compileCore, Exit, PSCI_SYSTEM_OFF, type Restore, type Vm } from '../vm.ts';
import { msg, MsgError } from '../msg.ts';
import { dropSuspend, saveFlash, suspended } from '../overlay.ts';
import { lzCodec } from '../lz.ts';
import type { SnapshotHeader } from '../snapshot-file.ts';
import type { RestorePhases } from '../snapshot.ts';
import type { DeviceSpec } from '../devices.ts';
import { firmwareFiles } from './firmware-files.ts';
import { MACHINES, readiness, type Machine } from './machine.ts';
import { Signal } from './memory.ts';
import type { ToWorker } from './protocol.ts';
import type { StartMessage } from './worker-devices.ts';
import { explain } from './worker-errors.ts';
import { sessionOf, type Session } from './worker-header.ts';
import { asked } from './worker-profile.ts';
import { post, state } from './worker-post.ts';
import { limitJit, status, watchKeyboard } from './worker-status.ts';
import { checkSnapshot, saveSnapshot, spareBuffer, suspend, TAIL, type Running } from './worker-snapshot.ts';
import {
  loadPhases,
  bootOptions,
  checkSplit,
  devicesOf,
  fetchParts,
  ioOf,
  openRestore,
  releasing,
  planOf,
  showScreen,
  type Plan,
} from './worker-start.ts';

const PANIC = 'Kernel panic - not syncing'; // i18n-ignore: the guest kernel's line

let vm: Vm | undefined;
/** The VM being booted: it may hold the overlay before `bootVm` returns it. */
let booting: Promise<Vm> | undefined;
let stopping = false;
/** Whether the machine is being stopped: read after an `await`, which `stopping` may have changed across. */
const stopped = () => stopping;
/** The machine this worker was started for. */
let current: Machine | undefined;
/** The OPFS directory of the machine's variable store and suspended copy (the start message's `home`). */
let home: string | undefined;
/** `?stageroom=`'s room for a file save's staging file (docs/frontend.md "Query parameters"). */
let stageRoom: number | undefined;
let up: (() => void) | undefined; // the run's: says `running` once (from the guest's sign: `up`)

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'start':
      start(m).catch((err: unknown) => {
        if (stopping) return;
        const [problem, error] = explain(err, MACHINES[m.config.machine], { restoring, ramMiB });
        state(vm ? 'crashed' : 'failed', { error, problem });
      });
      break;
    case 'snapshot':
      void saveSnapshot(running(), m.id, m.handle, m.keep, m.whole, m.stage);
      break;
    case 'suspend':
      void suspend(running(), m.id);
      break;
    case 'snapshot-spare':
      return spareBuffer(m.id, m.buffer);
    case 'snapshot-check':
      void checkSnapshot(running(), m.id, m.what);
      break;
    case 'wake':
      return vm?.wake();
    case 'up':
      return up?.();
    case 'stop':
      stopping = true;
      void (async () => {
        // A machine still booting is closed once it's there (its device worker may have the overlay open).
        const v = vm ?? (await booting?.catch(() => undefined));
        if (v && current) await shutdown(v);
        post({ type: 'stopped' });
      })();
      break;
    default:
      asked(vm, m); // the profilers, the heap, the disks' compaction
  }
};

/** The variable store as last saved (or loaded): the firmware's boot entries and settings, kept beside the disk's overlay. */
let savedFlash: Uint8Array | undefined;
let saving: Promise<void> = Promise.resolve();
const same = (a: Uint8Array, b?: Uint8Array) => !!b && a.length === b.length && a.every((x, i) => x === b[i]);
/** Saves the flash bank if it changed since the last save (a save in flight finishes first). */
function keepFlash(v: Vm) {
  const flash = v.flash();
  const at = home;
  if (!flash || !at || same(flash, savedFlash)) return saving;
  savedFlash = flash;
  return (saving = saving
    .then(() => saveFlash(at, flash))
    .catch(() => {
      savedFlash = undefined;
    })); // retried at the next change or tick
}

/** Stops `v` and keeps its variable store (firmware machines); once per machine. */
let closed: Promise<void> | undefined;
const shutdown = (v: Vm) =>
  (closed ??= (async () => {
    await v.close(); // the vCPUs stop at once; the flash isn't written after that
    await keepFlash(v);
  })());

/** The RAM of the machine being started, MiB (the page's choice, or a snapshot's). */
let ramMiB = 0;
/** What this machine is, for a snapshot's header (docs/frontend.md "Snapshots"). */
let session: Session | undefined;
/** The core, compiled once: `bootVm` and the snapshot codec both take the module. */
let core: WebAssembly.Module | undefined;
let codecP: ReturnType<typeof lzCodec> | undefined;
const codec = () => {
  if (!core) throw new Error('the snapshot codec before the core is compiled');
  return (codecP ??= lzCodec(core));
};
/** The tail of the serial output posted so far: a snapshot carries it, so a restored terminal isn't empty. */
let serialTail = '';
/** The machine was suspended: its run loop ends without a word (the state is `suspended`). */
let isSuspended = false;
/** `bootVm` has the snapshot: the disk's overlay may be replaced. */
let restoring = false;
/** The running machine's device specs, by slot. */
let liveSpecs: DeviceSpec[] = [];

/** Whether the disk in `slot` is a stored disk written in place (its overlay is its store: `disks/<id>`). */
const inPlace = (slot: number) => {
  const d = liveSpecs.at(slot);
  return d?.type === 'blk' && !!d.overlay?.startsWith('disks/');
};

/** The running machine for a snapshot or a suspension; none while it boots, stops or has stopped. */
function running(): Running | undefined {
  const v = vm;
  const machine = current;
  if (!v || !session || !machine || stopping || closed) return undefined;
  return {
    vm: v,
    session,
    machine,
    home,
    serial: () => serialTail,
    inPlace,
    stopping: stopped,
    codec,
    close: () => {
      isSuspended = true;
      return shutdown(v);
    },
    stageRoom,
  };
}

/**
 * A suspended machine kept beside the disk (docs/frontend.md "Suspend") is resumed, unless the page says boot; either
 * way it is dropped before a machine runs on the disk, which is what keeps a suspended machine and its disk together.
 */
async function suspendedCopy(m: StartMessage): Promise<Blob | undefined> {
  if (!home || m.snapshot) return undefined;
  // A suspension that can't be dropped doesn't stop the boot the page asked for.
  if (m.resume !== false) return suspended(home).catch(() => undefined);
  await dropSuspend(home).catch(() => undefined);
  return undefined;
}

/** The machine a snapshot (or a suspended copy) says, with its restore. */
async function fromSnapshot(m: StartMessage, machine: Machine, snapshot: Blob, resume: boolean) {
  const r = await openRestore(snapshot, m, machine, resume, await codec());
  // Its guest's leases renewed once the page's connections are up; a template's identity too (web/snapshot-file.ts `asTemplate`).
  post({ type: 'restored', template: !resume && r.header.template === true });
  ramMiB = r.plan.ramMiB;
  serialTail = r.serial;
  return r;
}

/**
 * What a start fetches and makes before the machine: the core compiled, the kernel and initrd, the firmware
 * configuration (web/app/firmware-files.ts: the credentials, the units' OEM strings, the agent) and the saved variable
 * store; none when the machine is stopped meanwhile.
 */
async function prepare(m: StartMessage, machine: Machine, snapshot: boolean) {
  const parts = await fetchParts(m, machine, snapshot, stopped);
  if (stopped()) return undefined;
  const wasm = await compileCore(parts.wasm);
  core = wasm;
  savedFlash = await parts.flash;
  const files = firmwareFiles(m, await parts.agent);
  const firmware = files ? { flash: savedFlash, fwCfg: files } : undefined;
  return { core: wasm, kernel: parts.kernel, initrd: parts.initrd, firmware };
}

async function start(m: StartMessage, note?: unknown): Promise<void> {
  const t0 = performance.now();
  const machine: Machine = (current = MACHINES[m.config.machine]);
  home = m.home;
  stageRoom = m.config.dev.stageRoom;
  state('loading');
  const resume = await suspendedCopy(m);
  const snapshot: Blob | undefined = m.snapshot ?? resume;
  /** A suspended machine that can't be resumed is dropped, and the machine boots (saying why, as a note: no problem). */
  const bootInstead = async (err: unknown) => {
    if (home) await dropSuspend(home).catch(() => undefined); // the boot goes on, as when it was dropped
    restoring = false;
    return start(
      { ...m, resume: false },
      new MsgError('machine:worker.notResumed', undefined, {
        cause: new MsgError('machine:worker.notResumed.cause', undefined, { cause: err }),
      }),
    );
  };
  const parts = await prepare(m, machine, !!snapshot);
  if (!parts || stopped()) return;
  const prepared = performance.now();
  ramMiB = m.config.ram.mib;
  let plan = planOf(m, machine);
  let restore: Restore | undefined;
  let specs: DeviceSpec[] | undefined;
  let header: SnapshotHeader | undefined;
  let restored: RestorePhases | undefined;
  /** The restore's load's pool closed (it is by `fill`'s end; a start that ends before that closes it here). */
  let release: (() => void) | undefined;
  if (snapshot) {
    try {
      ({
        plan,
        restore,
        specs,
        header,
        phases: restored,
        release,
      } = await fromSnapshot(m, machine, snapshot, !!resume));
    } catch (err) {
      if (resume && !stopped()) return bootInstead(err);
      throw err;
    }
    restoring = !resume;
  }
  const made = await releasing(release, async () => {
    if (stopped()) return undefined;
    checkSplit(plan, m, machine, !!snapshot);
    const devices = (liveSpecs = devicesOf(plan, m, machine, specs));
    session = sessionOf(m, plan);
    booting = bootVm(parts.core, bootOptions(m, machine, plan, parts, devices, restore));
    try {
      return { devices, v: (vm = await booting) };
    } catch (err) {
      if (resume && !stopped()) return { instead: err };
      throw err;
    }
  });
  if (!made || stopped()) return; // `stop` closes it
  if ('instead' in made) return bootInstead(made.instead);
  const { devices, v } = made;
  await booted(v, m, { header, resume: !!resume, note });
  // A start from a snapshot says where its time went, once it runs (for tools: `#message[data-load]`).
  if (restored) post({ type: 'loaded', phases: loadPhases(t0, prepared, restored) });
  const marker = m.config.dev.guestReadyOnly ? undefined : machine.ready; // `?ready=guest`: only the guest's signs
  return run({ ...machine, ready: marker }, plan, ioOf(plan, m, machine, devices), !!restore);
}

/**
 * The booted machine before it runs: a resumed one's suspended copy is dropped, a restore's variable store is kept again, the framebuffer is shown; and its state posted
 * (booting, with the boot's `note`; or running where it was, the terminal as it was).
 */
async function booted(v: Vm, m: StartMessage, o: { header?: SnapshotHeader; resume: boolean; note: unknown }) {
  // The resumed machine is about to write its disk: its suspended copy is void from here.
  if (o.resume && home) await dropSuspend(home);
  if (o.header) await keepFlash(v); // the restore deleted the copy beside the overlay: the bank the machine has goes back
  showScreen(v, m);
  if (!o.header) return state('booting', { error: o.note });
  if (serialTail) post({ type: 'serial', data: serialTail, replay: true }); // what the terminal showed when it was saved
  state('running', { note: o.resume ? msg('machine:worker.resumed') : undefined });
}

/**
 * Runs the booted machine until it stops: its serial output posted and watched for the guest's ready marker and a
 * panic (or the guest's own sign: `up`), its status posted every second. `restore`: from a snapshot, where the machine was (running already).
 */
async function run(machine: Machine, plan: Plan, io: Parameters<typeof status>[6], restore: boolean): Promise<void> {
  if (!vm) return;
  const { ncpus } = plan;
  const t0 = performance.now();
  const ready = readiness(machine.ready, restore, () => state('running')); // restored: where it was, no marker to wait for
  up = ready.up;
  let panicked = false;
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
    ready.serial(text);
    const at = seen.indexOf(PANIC);
    // The guest hangs (or resets, with panic=N: the page keeps the crash on show rather than restarting).
    if (!panicked && at >= 0 && seen.includes('\n', at)) {
      panicked = true;
      state('crashed', {
        error: new MsgError('machine:worker.panic', undefined, {
          cause: new MsgError('machine:worker.panic.cause', undefined, { cause: seen.slice(at).split('\n')[0].trim() }),
        }),
        problem: 'panic',
      });
    }
  };
  // Once a second on a timer, not from the loop: a stuck loop then shows in `loopAgeMs` rather than as silence.
  let ticks = 0;
  const signal = new Signal();
  const timer = setInterval(() => {
    // A tab can close without a shutdown: the variable store is kept as it changes (every 5 s at most).
    if (machine.firmware && ++ticks % 5 === 0) void keepFlash(vm!);
    const now = performance.now();
    const st = status(vm!, ncpus, ramMiB, now - t0, loopMax, now - loopAt, io, signal);
    limitJit(vm!, st);
    post({ type: 'status', status: st });
    loopMax = 0;
  }, 1000);
  const kbdTimer = watchKeyboard(vm, plan.here);
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
      await shutdown(vm);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set by `output`, a closure the types don't follow
      if (panicked)
        return; // said
      else if (r.kind === Exit.PSCI) state(r.x[0] === PSCI_SYSTEM_OFF ? 'off' : 'rebooting');
      else
        state('crashed', {
          error:
            r.kind === Exit.UNIMPLEMENTED
              ? new MsgError('machine:worker.stopped.unimplemented', undefined, {
                  cause: new MsgError('machine:worker.stopped.unimplemented.cause', { pc: vm.pc().toString(16) }),
                })
              : new MsgError('machine:worker.stopped.exit', { exit: r.kind }),
          problem: 'emulator',
        });
      return;
    }
  } finally {
    up = undefined;
    clearInterval(timer);
    clearInterval(kbdTimer);
  }
}
