// The machine's run (docs/frontend.md "The page's code"): a start makes the run's worker, channels and input, the GPU
// worker on a 3D machine, and hands the machine worker its start message once the disks are open; a stop ends it.
// The workers' and ports' messages go to web/app/run/worker-messages.ts's handlers.
import { msg, MsgError } from '../../i18n.ts';
import type { PageAudio } from '../../audio.ts';
import { attachInput, type EvdevEvent } from '../../input.ts';
import type { DisplayToPage } from '../../gpu-present.ts';
import type { FromGpuWorker, ToGpuWorker } from '../../gpu-messages.ts';
import { bootCard } from '../areas/boot-card.svelte.ts';
import { current } from '../areas/current.svelte.ts';
import { keys } from '../areas/keys.svelte.ts';
import { mouse } from '../areas/mouse.svelte.ts';
import { power } from '../areas/power.svelte.ts';
import { shares } from '../areas/shares.svelte.ts';
import { status } from '../areas/status.svelte.ts';
import type { ScreenView } from '../areas/screen-view.ts';
import type { SerialTerminal } from '../areas/serial-terminal.ts';
import type { PageFolders } from '../folders-live.ts';
import type { Grab } from '../hooks.ts';
import { resolveKeyboard } from '../keyboard.ts';
import type { PageNetwork } from '../net-live.ts';
import type { FromWorker, MachineConfig, Problem, Status, ToWorker } from '../protocol.ts';
import { onReady } from '../../vsock-device.ts';
import type { UsbPorts } from '../usb-live.ts';
import { checkDisks, isGone } from '../demo-open.ts';
import { gpuInitKnobs } from './knobs.ts';
import { MachineLock } from './machine-lock.ts';
import { mergeRuns, mergingInto } from '../machine-hold.ts';
import type { Messages } from './messages.ts';
import { filesNeedingUser, NeedsUser, refreshRecords, startDisks } from './page-disks.ts';
import { loadStored, sharesPath, type PageMachine } from './page-machine.svelte.ts';
import type { Problems } from './problems.ts';
import type { Replies } from './replies.ts';
import { dispatch, Run } from './run.ts';
import { channels, startMessage, type Channels, type StartWith } from './start-message.ts';
import type { RunAgent } from '../areas/agent-actions.ts';
import { displayHandlers, gpuHandlers, ledEvent, workerHandlers } from './worker-messages.ts';
import type { DiskPlan } from '../../snapshot.ts';

/** How long a panicked machine's workers are kept for the rest of its panic's output (the trace after the line), ms. */
const PANIC_TAIL_MS = 2000;

/** What the run takes of the other areas. */
export type RunnerDeps = {
  machine: PageMachine;
  messages: Messages;
  screen: ScreenView;
  terminal: SerialTerminal;
  net: PageNetwork;
  audio: PageAudio;
  folders: PageFolders;
  replies: {
    grabs: Replies<Grab>;
    screens: Replies<Blob | undefined>;
    bytes: Replies<number>;
    /** The machine worker's answers to the benchmarks' questions (`profile`, `timeline`, `heap`), by id. */
    worker: Replies<FromWorker>;
  };
  /** The run's USB (web/app/areas/usb-actions.ts). */
  usb: {
    ports(port: MessagePort): UsbPorts;
    attachAtStart(r: Run): Promise<void>;
    syncKeyboard(r: Run): Promise<void>;
    keyboardKey(code: string, down: boolean): boolean;
  };
  /** A run's guest agent (web/app/areas/agent-actions.ts) and its clipboard sharing (none: not shared); `up` at each HELLO. */
  agent: RunAgent;

  /** The memory signal's mark (web/app/run/memory-signal.ts): renewed with each status, cleared at a stop. */
  alive: { mark(st: Status): number; clear(): void };
  /** What can be done about a problem (web/app/run/problems.ts), and the guest's own reset (`PowerActions.rebooted`). */
  later: { problems(): Problems; rebooted(live: () => boolean): Promise<void> };
};

/** A start's arguments: booted, or (with `snapshot`) the one the file holds; `resume` false drops a suspended machine. */
/** `first`: a template's first start (`restoreFirst`), which boots instead when its snapshot can't load here. */
type StartArgs = { snapshot?: File; resume: boolean; plan?: DiskPlan[]; first?: boolean; config: MachineConfig };

export class Runner {
  readonly d: RunnerDeps;
  readonly lock = new MachineLock();

  /**
   * A template's first start whose snapshot can't load once under way (`restart`: its run has ended): the restore's to
   * handle (web/app/areas/snapshot-restore.ts `bootInstead`).
   */
  firstFailed: (restart: boolean) => Promise<void> = () => Promise.resolve();
  /**
   * What Retry does after the last start failed, where it isn't a restart (web/app/run/problems.ts `again`): set by a
   * snapshot's restore right after its start (the restore again: a restart would boot), cleared by every start.
   */
  again: (() => Promise<void>) | undefined;
  constructor(d: RunnerDeps) {
    this.d = d;
  }

  /** Run `r` loaded its snapshot (the worker's `loaded`): the restore's to handle (web/app/areas/snapshot-restore.ts). */
  loaded: (r: Run) => Promise<void> = () => Promise.resolve();

  /** A key or a click for a guest that sleeps: it wakes (as a machine does on its keyboard), and the input goes on to it. */
  wake() {
    const r = this.d.machine.run;
    // Not while a snapshot holds the input: the guest sleeps for it (web/input.ts `hold`).
    if (!r?.asleep || r.input.held()) return;
    r.asleep = false;
    r.worker.postMessage({ type: 'wake' } satisfies ToWorker);
  }

  /**
   * Starts a machine: booted, or (with `snapshot`) the one the file holds. A machine suspended on
   * this disk is resumed instead of booting, unless `resume` is false (it is then dropped). `first`: the snapshot is a
   * template's at the machine's first start (`restoreFirst`): one that 3D's failure leaves unloadable boots instead.
   */
  start(snapshot?: File, resume = true, plan?: DiskPlan[], first = false) {
    const { machine: m, screen, net, audio } = this.d;
    this.again = undefined;
    const size = m.hasGpu ? screen.wantedSize() : m.spec.framebuffer;
    screen.sent = m.hasGpu ? size : undefined;
    // The machine worker draws the screen (web/display.ts): a canvas hands its drawing over only once.
    const canvas = screen.freshCanvas(size);
    const offscreen = canvas.transferControlToOffscreen();
    const nets = net.ports(m.netKey(), m.adapters());
    const config = m.config(nets.length);
    const ch = channels(config, audio.attach(), nets);
    current.hasNetwork = ch.nets.length > 0;
    const r = this.#newRun(canvas, ch);
    if (first && snapshot) r.first = true;
    if (snapshot && plan && m.stored) r.plan = plan;
    this.#loading(snapshot);
    const args = { snapshot, resume, plan, first, config };
    if (config.display === '3d') this.#gpu(r, ch, offscreen, args, size);
    else void this.#begin(r, ch, { ...args, screen: offscreen, size });
    if (ch.nets.length) void net.autoconnect();
  }

  /** The run's worker, input and handlers, made the page's run. */
  #newRun(canvas: HTMLCanvasElement, ch: Channels) {
    const { machine: m, screen, terminal } = this.d;
    const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
    // The guest's signs that it's up, beside its ready marker: the agent's HELLO, systemd's READY=1 (web/vsock-device.ts).
    const up = () => worker.postMessage({ type: 'up' } satisfies ToWorker);
    const share = this.d.agent.begin(ch, up);
    if (ch.notify) onReady(ch.notify.port1, up);
    const input = attachInput(canvas, {
      keyboard: ch.keyboard.port1,
      tablet: ch.tablet.port1,
      text: {
        live: () => keys.live,
        send: (d) => terminal.term.input(d, true),
        usb: (code, down) => this.d.usb.keyboardKey(code, down),
      },
      mouse: ch.mouse?.port1,
      touch: ch.touch?.port1,
      locked: (on) => {
        mouse.locked = on;
        screen.placeCursor();
      },
      hold: share && ((e) => share.chord(e)),
    });
    input.mouseLock(mouse.lock, mouse.mode);
    input.onRelease(() => {
      keys.released.emit();
    });
    input.onTyped((code) => {
      keys.typed.emit(code);
    });
    current.hasMouse = !!ch.mouse;
    canvas.addEventListener('keydown', () => this.wake());
    canvas.addEventListener('pointerdown', () => this.wake());
    const usb = ch.usb && this.d.usb.ports(ch.usb.port1);
    const r = new Run(m, { worker, input, ch, usb });
    m.run = r;
    current.inspect = { worker, replies: this.d.replies.worker, attachments: m.stored?.record.attachments };
    const display = displayHandlers(this);
    // Not through `guard`: tests/page-cursor.test.ts finds the display's port by this handler's source.
    ch.display.port1.onmessage = (e: MessageEvent<DisplayToPage>) => {
      if (r.live()) dispatch(display, e.data);
    };
    ch.keyboard.port1.onmessage = (e: MessageEvent<EvdevEvent>) => ledEvent(e.data);
    keys.ledBits = { virtio: 0, usb: 0 };
    const fromWorker = workerHandlers(this, r);
    worker.onmessage = r.guard((e: MessageEvent<FromWorker>) => dispatch(fromWorker, e.data));
    worker.onerror = r.guard((e: ErrorEvent) => {
      this.crash(r, new MsgError('machine:runner.workerFailed', {}, { cause: new Error(e.message) }));
    });
    return r;
  }

  /** The boot card and the state for a run that loads. */
  #loading(snapshot: File | undefined) {
    keys.live = false;
    power.paused = false;
    this.d.terminal.clear();
    bootCard.done = false;
    bootCard.line = '';
    bootCard.progress = undefined; // indeterminate until the sizes are known
    bootCard.title = snapshot
      ? msg('machine:runner.boot.loading', { name: snapshot.name })
      : msg('machine:runner.boot.starting', { machine: this.d.machine.spec.title });
    this.d.messages.setState('loading');
  }

  /** 3D: the GPU worker gets the canvas and says what it backs; the machine starts with those caps. */
  #gpu(r: Run, ch: Channels, offscreen: OffscreenCanvas, args: StartArgs, size: StartWith['size']) {
    const gpu = new Worker(new URL('../../gpu-worker.ts', import.meta.url), { type: 'module' });
    r.gpu = gpu;
    const channel = new MessageChannel();
    gpu.postMessage({ type: 'init', canvas: offscreen, port: channel.port1, ...gpuInitKnobs() } satisfies ToGpuWorker, [
      offscreen,
      channel.port1,
    ]);
    const ready = (caps: Uint8Array) =>
      void this.#begin(r, ch, { ...args, size, three: { renderer: channel.port2, caps } });
    const failed = (reason: string) => {
      // The canvas is the GPU worker's now: a fresh start, without 3D.
      this.d.machine.no3d = reason;
      console.warn(`waarm64: no 3D: ${reason}`);
      gpu.terminate();
      r.worker.terminate();
      r.input.detach();
      this.d.machine.run = undefined;
      // A template's snapshot needs the 3D it was taken with (its shape): the machine's first start boots instead.
      if (args.first && args.snapshot) return void this.firstFailed(false);
      const again = this.again; // the same start, without 3D: a restore's Retry is still the restore
      this.start(args.snapshot, args.resume, args.plan);
      this.again = again;
    };
    const fromGpu = gpuHandlers(this, r, ready, failed);
    gpu.onmessage = r.guard((e: MessageEvent<FromGpuWorker>) => dispatch(fromGpu, e.data));
    gpu.onerror = r.guard((e: ErrorEvent) => {
      this.crash(r, new MsgError('display:runner.gpuWorkerFailed', {}, { cause: new Error(e.message) }));
    });
  }

  /**
   * Once the lock is held and the disks are open: the start message, unless the run was stopped meanwhile (each await
   * is a moment a stop can come in: a start posted after its `stop` would boot a machine nothing stops).
   */
  async #begin(r: Run, ch: Channels, w: StartArgs & Pick<StartWith, 'screen' | 'size' | 'three'>) {
    const { machine: m, folders } = this.d;
    if (!r.live()) return;
    if (!(await this.own(() => r.live()))) return;
    const opened = await this.#openDisks(r, w.config, !!w.plan);
    if (!opened) return;
    const ready = await this.#prepare(r, ch);
    if (!ready) return;
    if (folders.views().some((v) => v.problem)) shares.openMenu(); // Allow access…, Use it here
    if (m.hasGpu) current.graphics = w.three ? '3d' : '2d'; // `data-graphics`, for tests
    keys.layout = ready.layout?.id;
    const screen = w.three ? undefined : w.screen;
    r.worker.postMessage(
      ...startMessage(m, w.config, ch, { ...w, ...opened, screen, layout: ready.layout, folders: ready.folders }),
    );
  }

  /** The start's folders and keyboard layout; none if the run stopped meanwhile or one failed (said, with Retry). */
  async #prepare(r: Run, ch: Channels) {
    const { machine: m, folders } = this.d;
    try {
      const list = ch.shares && m.stored ? await folders.begin(m.stored.record, ch.shares.port1) : undefined;
      shares.path = m.stored ? (sharesPath(m.stored.record) ?? '') : '';
      const layout = r.live() ? await resolveKeyboard(m.resolve().keyboard) : undefined;
      if (r.live()) return { folders: list, layout };
      folders.end();
    } catch (e) {
      if (!r.live()) return undefined;
      this.lock.drop();
      folders.end();
      this.d.messages.setState('failed', new MsgError('machine:runner.notStarted', {}, { cause: e }), [
        this.d.later.problems().retry,
      ]);
    }
    return undefined;
  }

  /**
   * The stored machine's lock for the run `live` says is current, or the start fails (said): it runs in another tab. A
   * restore takes it before its commit, so its forks are this start's (web/app/snapshot-undo.ts), and its start keeps
   * it (`hold` again is a no-op) to the run's end; the restore drops it if it starts nothing.
   */
  async own(live: () => boolean = () => true) {
    const s = this.d.machine.stored;
    if (await this.lock.hold(s?.record.id)) {
      if (live()) return true;
      this.lock.drop();
      return false;
    }
    if (!live() || !s) return false;
    // A merge into one of its disks holds the machine off (web/app/merge.ts): said as that.
    const error = (await mergingInto(s.disks.values()))
      ? mergeRuns(s.record.name)
      : new MsgError(
          'machine:runner.runsElsewhere',
          { name: s.record.name },
          { cause: new MsgError('machine:runner.runsElsewhere.cause') },
        );
    this.d.messages.setState('failed', error, [this.d.later.problems().retry]);
    return false;
  }

  /**
   * The disks to start with and what snapshots say of the machine; none when they can't be opened (said). The stored
   * machine's records are read again first, under its lock (`own`): read before it, they may name an overlay a merge
   * or a delete in another tab took away meanwhile (web/app/merge.ts holds the machines off, so not after), which the
   * worker would make anew with no record naming it. A boot (`restore` false) undoes a restore that never ran as the
   * lock's owner (web/app/snapshot-undo.ts): a reading before the lock found it held, by that restore's run.
   */
  async #openDisks(r: Run, config: MachineConfig, restore: boolean) {
    const m = this.d.machine;
    try {
      if (m.stored) m.stored = await loadStored(m.store, m.stored.record.id, { owned: !restore });
      const needs = m.stored ? await filesNeedingUser(m, m.stored) : [];
      if (needs.length) throw new NeedsUser(needs);
      // A demo's machine (from Home as from the store's page): its files gone from the server is said as that.
      if (m.stored?.record.fromDemo) await checkDisks(m.store, m.stored.record, { goneOnly: true });
      const { disks, home } = await startDisks(m);
      // The attachments a live surface asks about (`inspect`) as the record read again names them, its new overlays too.
      const i = current.inspect;
      if (i?.worker === r.worker) current.inspect = { ...i, attachments: m.stored?.record.attachments };
      status.disks = disks.map((d) => d.name);
      const about = await m.about(config);
      r.about = about;
      return r.live() ? { disks, home, about } : undefined;
    } catch (e) {
      if (!r.live()) return undefined;
      this.lock.drop();
      if (e instanceof NeedsUser) this.d.later.problems().needsUser(e.disks);
      else if (isGone(e)) this.d.messages.setState('failed', e as Error, [this.d.later.problems().retry]);
      else
        this.d.messages.setState('failed', new MsgError('disks:runner.notOpened', {}, { cause: e }), [
          this.d.later.problems().retry,
        ]);
      return undefined;
    }
  }

  /**
   * The run ended (off, crashed, suspended, failed): what it held goes. Its workers too, once the machine worker has
   * closed the machine (`Run.close`); a panicked guest's after `PANIC_TAIL_MS`, for the rest of its panic's trace to
   * reach the terminal: it can't come back by itself (it hangs, or its reset is ignored: the worker keeps the crash on
   * show). The run stays the page's until the next stop, but a stopped machine's tab runs nothing and keeps none of its
   * memory (its RAM, the framebuffer's animation frames, the status timer).
   */
  ended(r: Run, m: { problem?: Problem }) {
    if (m.problem === 'panic') setTimeout(() => void r.close(), PANIC_TAIL_MS);
    else void r.close();
    this.d.alive.clear();
    r.usb?.close();
    // The screen lets go of the mouse (a stopped machine has nothing to give it to) and a click doesn't take it again; the next start's input takes the setting.
    r.input.mouseLock(false);
    this.lock.drop();
    this.d.folders.end();
    this.d.agent.end();
    void refreshRecords(this.d.machine);
  }

  /**
   * The run can't go on (its machine worker failed, its GPU worker failed or lost its context): said crashed, and
   * stopped as a stop does (the worker lands its disks if it still can), so the guest doesn't run on unseen holding the
   * machine's lock and disks. A restart meanwhile waits for that stop (`stop`).
   */
  crash(r: Run, error: MsgError) {
    if (!r.live()) return;
    r.failJobs(error);
    this.d.messages.setState('crashed', error, this.d.later.problems().table.emulator);
    void this.stop();
  }

  #stopping: Promise<void> = Promise.resolve(); // the stop under way (a crash's): the next stop waits for it

  /** Stops the machine, if any: its worker releases the disk overlay and lands what its folders hold first (or gets 4 s to). */
  stop(): Promise<void> {
    const r = this.d.machine.run;
    this.d.machine.run = undefined;
    if (!r) return this.#stopping;
    return (this.#stopping = this.#stopRun(r));
  }

  async #stopRun(r: Run) {
    const m = this.d.machine;
    this.d.alive.clear();
    r.input.detach();
    this.d.audio.detach();
    r.usb?.close();
    await r.close();
    this.lock.drop();
    this.d.folders.end();
    this.d.agent.end();
    await refreshRecords(m);
  }
}
