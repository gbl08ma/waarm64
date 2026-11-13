// What the run's workers and display port say (web/app/protocol.ts `FromWorker`, web/gpu-present.ts `DisplayToPage`,
// web/gpu-worker.ts `FromGpuWorker`), by message type: each table is a run's (web/app/run/runner.ts sets them,
// dropped once the run is replaced: `Run.guard`).
import { msg, MsgError, t, text } from '../../i18n.ts';
import { fromWire } from '../../msg.ts';
import type { DisplayToPage } from '../../gpu-present.ts';
import type { FromGpuWorker } from '../../gpu-worker.ts';
import type { EvdevEvent } from '../../input.ts';
import { bootCard } from '../areas/boot-card.svelte.ts';
import { keys } from '../areas/keys.svelte.ts';
import { power } from '../areas/power.svelte.ts';
import { status } from '../areas/status.svelte.ts';
import { graphics, type Graphics } from '../statusbar-graphics.ts';
import { metrics } from '../statusbar-metrics.ts';
import type { FromWorker, Status } from '../protocol.ts';
import { benchHooks } from './knobs.ts';
import type { Handlers, Run } from './run.ts';
import type { Runner } from './runner.ts';

type StateMessage = Extract<FromWorker, { type: 'state' }>;

/** The status for the status bar, with the rates since the run's last (`Run.last`). */
function showStatus(r: Run, s: Status, tabBytes: number) {
  const now = performance.now();
  // The worker's counters start again from 0 when it starts again (a suspended copy that couldn't resume boots): no rates across that.
  const prev = r.last && s.uptime >= r.last.status.uptime ? r.last : undefined;
  r.last = { status: s, at: now, metrics: metrics(s, now, prev, tabBytes) };
  status.data = JSON.stringify(s); // for tools (bench/stress)
  status.metrics = r.last.metrics;
}
/** The screen's report each second (a 3D machine's GPU worker, a 2D machine's presenter), for the status bar. */
function showGraphics(mode: Graphics['mode'], m: Parameters<typeof graphics>[1]) {
  const at = performance.now();
  status.gpu = { g: graphics(mode, m, at, status.gpu), at };
}
/** `?avprobe`: when the screen's centre turned bright (ms on this page's clock), for bench/audio/avsync.ts. */
const flashed = (t: number) => (window.__flashes ??= []).push(t - performance.timeOrigin);

/** The guest's screen has taken over (its console, the firmware's graphics): the boot card goes. */
function screenTaken() {
  bootCard.done = true;
  bootCard.shown = false;
}

export function displayHandlers(x: Runner): Handlers<DisplayToPage> {
  const screen = x.d.screen;
  return {
    png: (m) => x.d.replies.screens.answer(m.id, m.png),
    cursor: (m) => screen.setCursor(m),
    'screen-stats': (m) => showGraphics(m.screen, m),
    'cursor-at': (m) => screen.cursorAt(m.x, m.y),
    'draw-stats': (m) => {
      (window.__drawStats ??= []).push(m);
      (window.__devEvents ??= []).push(...(m.busy.events ?? []));
    },
    capture: (m) => (window.__virglCapture ??= []).push(m.record),
    flash: (m) => flashed(m.t),
    mode: (m) => {
      if (!(m.width > 0 && m.height > 0)) return;
      screen.mode(m);
      // The firmware's graphics output is up: its screens are the boot (the card hides, as it does for a console on a simple framebuffer).
      screenTaken();
    },
  };
}

/** The boot card and the devices as the machine's state changes. */
function stateChanged(x: Runner, r: Run, m: StateMessage) {
  const title = x.d.machine.spec.title;
  if (m.state === 'booting') {
    bootCard.title = t('machine:worker-messages.boot.booting', { machine: title });
    bootCard.progress = undefined;
    bootCard.line = t('machine:worker-messages.boot.kernel'); // then its lines, until its console takes the screen (~2 s on Debian)
  }
  if (m.state === 'running') {
    bootCard.shown = false;
    x.d.screen.scheduleSize(true); // a restored machine starts at the size it was saved with
  }
  if (m.state === 'rebooting') void x.d.later.rebooted(() => r.live());
  // Its devices go on once the machine runs: at a boot, a resume and a restore alike (a snapshot's ports are empty).
  if ((m.state === 'booting' || m.state === 'running') && r.usb && !r.usbStarted) {
    r.usbStarted = true;
    void x.d.usb.attachAtStart(r);
  }
  if (m.state === 'off' || m.state === 'crashed' || m.state === 'suspended' || m.state === 'failed') x.ended(r);
}

function state(x: Runner, r: Run, m: StateMessage) {
  if (m.state === 'suspended') power.saving = false;
  const problems = x.d.later.problems();
  // A message without a problem is a note (resumed, suspended, a suspended copy that couldn't be resumed), not an error.
  const actions = m.problem ? problems.table[m.problem] : m.state === 'suspended' ? problems.suspended : [];
  const error = !!m.problem || m.state === 'crashed' || m.state === 'failed';
  x.d.messages.setState(m.state, m.error ?? m.note, actions, error ? 'error' : 'warn');
  stateChanged(x, r, m);
}

/** A download's progress, on the boot card and in the state's words. */
function progress(x: Runner, m: Extract<FromWorker, { type: 'progress' }>) {
  if (m.total) bootCard.progress = m.loaded / m.total;
  bootCard.line = m.total
    ? t('machine:worker-messages.boot.downloading', { loaded: m.loaded, total: m.total })
    : t('machine:worker-messages.boot.downloaded', { loaded: m.loaded });
  if (power.state === 'loading')
    x.d.messages.stateText(
      m.total
        ? msg('machine:worker-messages.state.loadingPercent', { percent: Math.floor((100 * m.loaded) / m.total) })
        : msg('machine:messages.state.loading'),
    );
}

/** The guest's LEDs on the virtio keyboard's port: its status events (EV_LED, code 0 Num, 1 Caps, 2 Scroll Lock). */
const EV_LED = 0x11;
export function ledEvent([type, code, value]: EvdevEvent) {
  if (type !== EV_LED || code > 2) return;
  const bits = keys.ledBits;
  bits.virtio = value ? bits.virtio | (1 << code) : bits.virtio & ~(1 << code);
}

export function workerHandlers(x: Runner, r: Run): Handlers<FromWorker> {
  return {
    state: (m) => state(x, r, m),
    serial: (m) => x.d.terminal.write(m.data, m.replay),
    keyboard: (m) => {
      // The keys go elsewhere now (the virtio keyboard, or the built-in USB one or the serial console): what's held is released where it went down.
      if (m.live !== keys.live) r.input.release();
      keys.live = m.live;
      void x.d.usb.syncKeyboard(r);
    },
    notice: (m) => x.d.messages.notify(m.message, 'error'),
    status: (m) => {
      if (m.status.asleep && !r.asleep && !power.saving) x.d.messages.notify(msg('machine:worker-messages.asleep'));
      r.asleep = !!m.status.asleep;
      showStatus(r, m.status, x.d.alive.mark(m.status));
      if (benchHooks) window.__status = m.status;
    },
    profile: (m) => x.d.replies.worker.answer(m.id, m),
    timeline: (m) => x.d.replies.worker.answer(m.id, m),
    heap: (m) => x.d.replies.worker.answer(m.id, m),
    'snapshot-check': (m) => x.d.replies.worker.answer(m.id, m),
    restored: (m) => x.d.agent.restored(m.template),
    phase: (m) => {
      bootCard.line = text(m.text);
      bootCard.progress = undefined;
      if (power.state === 'loading') x.d.messages.stateText(m.text);
    },
    'snapshot-progress': (m) => r.job(m.id)?.progress(m.phase, m.fraction),
    'snapshot-chunk': (m) => r.job(m.id)?.chunk(m.data),
    'snapshot-done': (m) => r.job(m.id, true)?.done(m),
    'suspend-done': (m) => r.job(m.id, true)?.done(m),
    'snapshot-error': (m) => r.job(m.id, true)?.error(fromWire(m.error)),
    progress: (m) => progress(x, m),
    screen: () => {
      // The guest's console has the screen: it shows the boot from here. (Through the firmware the
      // screen stays black until a getty: the boot's output, menus and a first boot's questions are on the serial console.)
      if (!x.d.machine.spec.firmware) screenTaken();
    },
  };
}

export function gpuHandlers(
  x: Runner,
  r: Run,
  ready: (caps: Uint8Array) => void,
  failed: (reason: string) => void,
): Handlers<FromGpuWorker> {
  return {
    ready: (m) => {
      console.info(`waarm64: 3D on ${m.renderer}`);
      ready(m.caps);
    },
    failed: (m) => failed(m.reason),
    stats: (m) => showGraphics('3d', m),
    lost: () => x.crash(r, new MsgError('display:worker-messages.webglLost')),
    snapshotBytes: (m) => x.d.replies.bytes.answer(m.id, m.bytes),
    'render-stats': (m) => {
      (window.__renderStats ??= []).push(m);
      (window.__presents ??= []).push(...m.presentAt);
    },
    flash: (m) => flashed(m.t),
    grab: (m) => x.d.replies.grabs.answer(m.id, m),
  };
}
