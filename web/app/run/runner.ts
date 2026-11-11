// The machine's run (docs/frontend.md "The page's code"): a start makes the run's worker, channels and input, the GPU
// worker on a 3D machine, and hands the machine worker its start message once the disks are open; a stop ends it.
// The workers' and ports' messages go to web/app/run/worker-messages.ts's handlers.
import { MsgError, t } from '../../i18n.ts';
import type { PageAudio } from '../../audio.ts';
import { attachInput } from '../../input.ts';
import { CLOSE_MS } from '../../devices.ts';
import type { DisplayToPage } from '../../gpu-present.ts';
import type { FromGpuWorker, ToGpuWorker } from '../../gpu-worker.ts';
import { bootCard } from '../areas/boot-card.svelte.ts';
import { clipboard } from '../areas/clipboard.svelte.ts';
import { current } from '../areas/current.svelte.ts';
import { keys } from '../areas/keys.svelte.ts';
import { mouse } from '../areas/mouse.svelte.ts';
import { shares } from '../areas/shares.svelte.ts';
import { status } from '../areas/status.svelte.ts';
import type { ScreenView } from '../areas/screen-view.ts';
import type { SerialTerminal } from '../areas/serial-terminal.ts';
import type { ClipboardShare } from '../clipboard.ts';
import type { PageFolders } from '../folders-live.ts';
import type { Grab } from '../hooks.ts';
import { resolveKeyboard } from '../keyboard.ts';
import type { PageNetwork } from '../net-live.ts';
import type { FromWorker, Status, ToWorker } from '../protocol.ts';
import type { Sample } from '../statusbar.ts';
import type { UsbPorts } from '../usb-live.ts';
import type { SnapshotJob } from '../areas/snapshot-actions.ts';
import { gpuInitKnobs } from './knobs.ts';
import { MachineLock } from './machine-lock.ts';
import type { Messages } from './messages.ts';
import { filesNeedingUser, refreshRecords, startDisks } from './page-disks.ts';
import { sharesPath, type PageMachine } from './page-machine.svelte.ts';
import type { Problems } from './problems.ts';
import type { Replies } from './replies.ts';
import { dispatch, Run } from './run.ts';
import { channels, startMessage, type Channels, type StartWith } from './start-message.ts';
import { displayHandlers, gpuHandlers, workerHandlers } from './worker-messages.ts';
import type { DiskRecord } from '../shape.ts';
import type { DiskPlan } from '../../snapshot.ts';

/** What the run takes of the other areas. */
export type RunnerDeps = {
  machine: PageMachine;
  messages: Messages;
  screen: ScreenView;
  terminal: SerialTerminal;
  net: PageNetwork;
  audio: PageAudio;
  folders: PageFolders;
  replies: { grabs: Replies<Grab>; screens: Replies<Blob | undefined>; bytes: Replies<number> };
  /** The run's USB (web/app/areas/usb-actions.ts). */
  usb: {
    ports(port: MessagePort): UsbPorts;
    attachAtStart(r: Run): Promise<void>;
    syncKeyboard(r: Run): Promise<void>;
    keyboardKey(code: string, down: boolean): boolean;
  };
  /** Clipboard sharing over the agent's port (none: the machine has none). */
  clipboard: (port: MessagePort | undefined) => ClipboardShare | undefined;
  /** The memory signal's mark (web/app/run/memory-signal.ts): renewed with each status, cleared at a stop. */
  alive: { mark(st: Status): number; clear(): void };
  /** What can be done about a problem (web/app/run/problems.ts), and a restart. */
  later: { problems(): Problems; restart(): Promise<void> };
};

/** A start's arguments: booted, or (with `snapshot`) the one the file holds; `resume` false drops a suspended machine. */
type StartArgs = { snapshot?: File; resume: boolean; plan?: DiskPlan[] };

/** A file disk whose file the page can't read without the user: no handle (picked again), or a handle without permission (granted again by a click). */
export class NeedsUser extends Error {
  readonly disks: DiskRecord[];
  constructor(disks: DiskRecord[]) {
    super(`${disks.map((d) => d.name).join(', ')}: no permission in this session`);
    this.disks = disks;
  }
}

export class Runner {
  readonly d: RunnerDeps;
  readonly lock = new MachineLock();
  /** The snapshot being written: the worker's messages for it (web/app/areas/snapshot-actions.ts). */
  job: SnapshotJob | undefined;
  /** The run's last status (its rates are since it). */
  last: Sample | undefined;

  constructor(d: RunnerDeps) {
    this.d = d;
  }

  /** A key or a click for a guest that sleeps: it wakes (as a machine does on its keyboard), and the input goes on to it. */
  wake() {
    const r = this.d.machine.run;
    if (!r?.asleep) return;
    r.asleep = false;
    r.worker.postMessage({ type: 'wake' } satisfies ToWorker);
  }

  /**
   * Starts a machine: booted, or (with `snapshot`) the one the file holds. A machine suspended on
   * this disk is resumed instead of booting, unless `resume` is false (it is then dropped).
   */
  start(snapshot?: File, resume = true, plan?: DiskPlan[]) {
    const { machine: m, screen, net, audio } = this.d;
    const size = m.hasGpu ? screen.wantedSize() : m.spec.framebuffer;
    screen.sent = m.hasGpu ? size : undefined;
    // The machine worker draws the screen (web/display.ts): a canvas hands its drawing over only once.
    const canvas = screen.freshCanvas(size);
    const offscreen = canvas.transferControlToOffscreen();
    const ch = channels(m, audio.attach(), net.ports(m.netKey(), m.adapters()));
    current.hasNetwork = ch.nets.length > 0;
    const r = this.#newRun(canvas, ch);
    this.#loading(snapshot);
    const args = { snapshot, resume, plan };
    if (m.display().display === '3d') this.#gpu(r, ch, offscreen, args, size);
    else void this.#begin(r, ch, { ...args, screen: offscreen, size });
    if (ch.nets.length) void net.autoconnect();
  }

  /** The run's worker, input and handlers, made the page's run. */
  #newRun(canvas: HTMLCanvasElement, ch: Channels) {
    const { machine: m, screen, terminal } = this.d;
    const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
    const share = this.d.clipboard(ch.agent?.port1);
    clipboard.follow(share);
    window.__clipboard = share; // the tests' hook
    const input = attachInput(
      canvas,
      ch.keyboard.port1,
      ch.tablet.port1,
      {
        live: () => keys.live,
        send: (d) => terminal.term.input(d, true),
        usb: (code, down) => this.d.usb.keyboardKey(code, down),
      },
      {
        mouse: ch.mouse?.port1,
        touch: ch.touch?.port1,
        locked: (on) => {
          mouse.locked = on;
          screen.placeCursor();
        },
      },
      { hold: share && ((e) => share.chord(e)) },
    );
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
    const r = new Run(m, { worker, input, serial: ch.serial.port1, display: ch.display.port1, usb });
    m.run = r;
    const display = displayHandlers(this);
    // Not through `guard`: tests/page-cursor.test.ts finds the display's port by this handler's source.
    ch.display.port1.onmessage = (e: MessageEvent<DisplayToPage>) => {
      if (r.live()) dispatch(display, e.data);
    };
    ch.keyboard.port1.onmessage = (e: MessageEvent<number[]>) => ledEvent(e.data);
    keys.ledBits = { virtio: 0, usb: 0 };
    const fromWorker = workerHandlers(this, r);
    worker.onmessage = r.guard((e: MessageEvent<FromWorker>) => dispatch(fromWorker, e.data));
    worker.onerror = r.guard((e: ErrorEvent) => {
      const error = new MsgError('machine:runner.workerFailed', {}, { cause: new Error(e.message) });
      this.job?.error(error);
      this.d.messages.setState('crashed', error, this.d.later.problems().table.emulator);
    });
    return r;
  }

  /** The boot card and the state for a run that loads. */
  #loading(snapshot: File | undefined) {
    keys.live = false;
    this.last = undefined;
    this.d.terminal.clear();
    bootCard.done = false;
    bootCard.line = '';
    bootCard.progress = undefined; // indeterminate until the sizes are known
    bootCard.title = snapshot
      ? t('machine:runner.boot.loading', { name: snapshot.name })
      : t('machine:runner.boot.starting', { machine: this.d.machine.spec.title });
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
      console.warn(`webpc: no 3D: ${reason}`);
      gpu.terminate();
      r.worker.terminate();
      r.input.detach();
      this.d.machine.run = undefined;
      this.start(args.snapshot, args.resume, args.plan);
    };
    const fromGpu = gpuHandlers(this, ready, failed);
    gpu.onmessage = r.guard((e: MessageEvent<FromGpuWorker>) => dispatch(fromGpu, e.data));
    gpu.onerror = r.guard((e: ErrorEvent) => {
      this.d.messages.setState(
        'crashed',
        new MsgError('display:runner.gpuWorkerFailed', {}, { cause: new Error(e.message) }),
        this.d.later.problems().table.emulator,
      );
    });
  }

  /** Once the lock is held and the disks are open: the start message. */
  async #begin(r: Run, ch: Channels, w: StartArgs & Pick<StartWith, 'screen' | 'size' | 'three'>) {
    const { machine: m, folders } = this.d;
    if (!r.live()) return;
    if (!(await this.#holdLock(r))) return;
    const opened = await this.#openDisks(r);
    if (!opened) return;
    const list = ch.shares && m.stored ? await folders.begin(m.stored.record, ch.shares.port1) : undefined;
    shares.path = m.stored ? (sharesPath(m.stored.record) ?? '') : '';
    if (!r.live()) {
      folders.end();
      return;
    }
    if (folders.views().some((v) => v.problem)) shares.openMenu(); // Allow access…, Use it here
    if (m.hasGpu) current.graphics = w.three ? '3d' : '2d'; // `data-graphics`, for tests
    const layout = await resolveKeyboard(m.resolve().keyboard);
    keys.layout = layout?.id;
    const screen = w.three ? undefined : w.screen;
    r.worker.postMessage(...startMessage(m, ch, { ...w, ...opened, screen, layout, folders: list }));
  }

  /** The machine's lock (a stored machine's), or the run fails: it runs in another tab. */
  async #holdLock(r: Run) {
    const s = this.d.machine.stored;
    if (await this.lock.hold(s?.record.id)) {
      if (r.live()) return true;
      this.lock.drop();
      return false;
    }
    if (!r.live() || !s) return false;
    this.d.messages.setState(
      'failed',
      new MsgError(
        'machine:runner.runsElsewhere',
        { name: s.record.name },
        { cause: new MsgError('machine:runner.runsElsewhere.cause') },
      ),
      [this.d.later.problems().retry],
    );
    return false;
  }

  /** The disks to start with and what snapshots say of the machine; none when they can't be opened (said). */
  async #openDisks(r: Run) {
    const m = this.d.machine;
    try {
      const needs = m.stored ? await filesNeedingUser(m, m.stored) : [];
      if (needs.length) throw new NeedsUser(needs);
      const { disks, home } = await startDisks(m);
      status.disks = disks.map((d) => d.name);
      const about = await m.about();
      return r.live() ? { disks, home, about } : undefined;
    } catch (e) {
      if (!r.live()) return undefined;
      this.lock.drop();
      if (e instanceof NeedsUser) this.d.later.problems().needsUser(e.disks);
      else
        this.d.messages.setState('failed', new MsgError('disks:runner.notOpened', {}, { cause: e }), [
          this.d.later.problems().retry,
        ]);
      return undefined;
    }
  }

  /** The run ended (off, crashed, suspended, failed): what it held goes. */
  ended(r: Run) {
    this.d.alive.clear();
    r.usb?.close();
    // The screen lets go of the mouse (a stopped machine has nothing to give it to) and a click doesn't take it again; the next start's input takes the setting.
    r.input.mouseLock(false);
    this.lock.drop();
    this.d.folders.end();
    void refreshRecords(this.d.machine);
  }

  /** Stops the machine, if any: its worker releases the disk overlay and lands what its folders hold first (or gets 4 s to). */
  async stop() {
    const m = this.d.machine;
    const r = m.run;
    m.run = undefined;
    if (!r) return;
    this.d.alive.clear();
    r.input.detach();
    this.d.audio.detach();
    r.usb?.close();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_MS + 1500);
      r.worker.onmessage = (e: MessageEvent<FromWorker>) => {
        if (e.data.type === 'stopped') {
          clearTimeout(timer);
          resolve();
        }
      };
      r.worker.postMessage({ type: 'stop' } satisfies ToWorker);
    });
    r.worker.terminate();
    r.gpu?.terminate();
    this.lock.drop();
    this.d.folders.end();
    await refreshRecords(m);
  }
}

/** The guest's LEDs on the virtio keyboard: its status events (EV_LED, code 0 Num, 1 Caps, 2 Scroll Lock). */
const EV_LED = 0x11;
function ledEvent([type, code, value]: number[]) {
  if (type !== EV_LED || code > 2) return;
  const bits = keys.ledBits;
  bits.virtio = value ? bits.virtio | (1 << code) : bits.virtio & ~(1 << code);
}
