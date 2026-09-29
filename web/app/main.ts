// The page (docs/frontend.md): the machine's screen on a canvas, its serial
// console on xterm.js, power state and a status line. The VM runs in
// web/app/worker.ts; this is DOM code only, talking to it through
// web/app/protocol.ts. `?machine=buildroot` picks the test guest, `?ncpus=N`
// the vCPU count, `?view=screen|terminal|both` the first view.
import { Terminal } from '@xterm/xterm';
import { attachInput, type Input } from '../input.ts';
import { defaultCpus, MACHINES, type MachineName } from './machine.ts';
import type { FromWorker, PowerState, Status, ToWorker } from './protocol.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const machine = (params.get('machine') ?? 'debian') as MachineName;
if (!(machine in MACHINES)) throw new Error(`no machine ${machine}`);
const ncpus = Number(params.get('ncpus')) || defaultCpus(navigator.hardwareConcurrency || 4);

let canvas = $<HTMLCanvasElement>('screen');
const screenBox = $('screen-view');
const stateEl = $('state');
const statusEl = $('status');
const messageEl = $('message');
const restartBtn = $<HTMLButtonElement>('restart');

// The serial terminal. The PL011 has no size negotiation: the guest assumes 80×24 unless told (`stty`).
const term = new Terminal({ cols: 80, rows: 24, convertEol: false, scrollback: 5000, fontFamily: 'ui-monospace, "DejaVu Sans Mono", Menlo, monospace', fontSize: 14, theme: { background: '#0b0d10' } });
term.open($('terminal'));

// Views: the screen first (M8 decision 2), the terminal, or both.
type View = 'screen' | 'terminal' | 'both';
const setView = (v: View) => {
  document.body.dataset.view = v;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view-button]')) b.setAttribute('aria-pressed', String(b.dataset.viewButton === v));
  fit();
  if (v !== 'screen') term.refresh(0, term.rows - 1);
  (v === 'terminal' ? term : canvas).focus();
};
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view-button]')) b.onclick = () => setView(b.dataset.viewButton as View);

// The canvas at an integer multiple of the framebuffer in device pixels when that fits (crisp),
// scaled down to fit (smooth) otherwise.
const fb = MACHINES[machine].framebuffer;
function fit() {
  if (!screenBox.clientWidth) return; // hidden
  const dpr = devicePixelRatio;
  const box = screenBox.getBoundingClientRect();
  const fits = Math.min((box.width * dpr) / fb.width, (box.height * dpr) / fb.height);
  const scale = fits >= 1 ? Math.floor(fits) : fits;
  canvas.style.width = `${(fb.width * scale) / dpr}px`;
  canvas.style.height = `${(fb.height * scale) / dpr}px`;
  canvas.style.imageRendering = Number.isInteger(scale) ? 'pixelated' : 'auto';
  canvas.dataset.scale = String(Math.round(scale * 1000) / 1000);
}
new ResizeObserver(fit).observe(screenBox);
matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', fit); // moved to a screen with another density

// One machine at a time; a restart stops it and starts a new worker (fresh memory, fresh ports, a fresh canvas).
type Run = { worker: Worker; input: Input; serial: MessagePort };
let run: Run | undefined;
let state: PowerState = 'loading';
let last: { status: Status; at: number } | undefined;

function setState(s: PowerState, message?: string) {
  state = s;
  stateEl.textContent = { loading: 'Loading', booting: 'Booting', running: 'Running', off: 'Powered off', rebooting: 'Rebooting', crashed: 'Crashed' }[s];
  stateEl.dataset.state = s;
  document.body.dataset.state = s;
  messageEl.textContent = message ?? '';
  messageEl.hidden = !message;
  restartBtn.textContent = s === 'off' ? 'Start' : 'Restart';
}

function start() {
  // The machine worker draws the screen (web/display.ts): a canvas hands its drawing over only once.
  const focused = document.activeElement === canvas;
  const fresh = canvas.cloneNode() as HTMLCanvasElement;
  [fresh.width, fresh.height] = [fb.width, fb.height];
  canvas.replaceWith(fresh);
  canvas = fresh;
  if (focused) canvas.focus();
  const screen = canvas.transferControlToOffscreen();
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const [kbd, tablet, serial] = [new MessageChannel(), new MessageChannel(), new MessageChannel()];
  const r: Run = { worker, input: attachInput(canvas, kbd.port1, tablet.port1), serial: serial.port1 };
  run = r;
  last = undefined;
  setState('loading');
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    if (run !== r) return;
    const m = e.data;
    if (m.type === 'state') {
      setState(m.state, m.message);
      if (m.state === 'rebooting') void restart();
    } else if (m.type === 'serial') {
      term.write(m.data);
    } else if (m.type === 'status') {
      showStatus(m.status);
    }
  };
  worker.onerror = (e) => { if (run === r) setState('crashed', `machine worker: ${e.message}`); };
  worker.postMessage({ type: 'start', machine, ncpus, keyboard: kbd.port2, tablet: tablet.port2, serial: serial.port2, screen } satisfies ToWorker, [kbd.port2, tablet.port2, serial.port2, screen]);
}

/** Stops the machine (its worker releases the disk overlay first, or gets 3 s to) and starts a new one. */
async function restart() {
  const r = run;
  run = undefined;
  if (r) {
    r.input.detach();
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3000);
      r.worker.onmessage = (e: MessageEvent<FromWorker>) => { if (e.data.type === 'stopped') { clearTimeout(t); resolve(); } };
      r.worker.postMessage({ type: 'stop' } satisfies ToWorker);
    });
    r.worker.terminate();
  }
  term.reset();
  start();
}

restartBtn.onclick = () => {
  if ((state === 'running' || state === 'booting') && !confirm('Restart the machine? Like pulling the plug: unsaved work in the guest is lost.')) return;
  void restart();
};

// Keys typed into the terminal go to the PL011 (xterm.js sends what a terminal would: \r for Enter, escape sequences).
term.onData((d) => run?.serial.postMessage(d));

// Key combinations the browser keeps for itself, to the screen's keyboard (web/input.ts `chord`).
const keysMenu = $<HTMLDetailsElement>('keys');
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-chord]')) {
  b.onclick = () => {
    keysMenu.open = false;
    canvas.focus();
    run?.input.chord(...b.dataset.chord!.split(' '));
  };
}
document.addEventListener('pointerdown', (e) => { if (!keysMenu.contains(e.target as Node)) keysMenu.open = false; });

// Full screen, with the Keyboard Lock API (Chromium) so that Ctrl+W, Ctrl+T, Esc and the like reach
// the machine; Chromium leaves full screen when Esc is held.
type KeyboardLock = { lock(): Promise<void>; unlock(): void };
const keyboardLock = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
const mainEl = document.querySelector('main')!;
$('fullscreen').onclick = () => {
  (document.body.dataset.view === 'terminal' ? term : canvas).focus();
  // Without the lock (refused, or another browser), the browser keeps its shortcuts.
  mainEl.requestFullscreen({ navigationUI: 'hide' }).then(() => keyboardLock?.lock()).catch(() => {});
};
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) keyboardLock?.unlock(); });

const hms = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
function showStatus(s: Status) {
  const now = performance.now();
  const dt = last ? (now - last.at) / 1000 : 0;
  const mips = last && dt > 0 ? (s.steps - last.status.steps) / dt / 1e6 : undefined;
  const irqs = last && dt > 0 ? (s.irqs - last.status.irqs) / dt : undefined;
  last = { status: s, at: now };
  statusEl.textContent = [
    `${s.ncpus} vCPU${s.ncpus > 1 ? 's' : ''}`, `${s.ramMiB} MiB`, `up ${hms(s.uptime)}`,
    mips === undefined ? '' : `${mips.toFixed(0)} MIPS`,
    `JIT ${s.jitBlocks.toLocaleString('en')} blocks, ${(s.jitCompileMs / 1000).toFixed(1)} s compiling`,
    irqs === undefined ? '' : `${irqs.toFixed(0)} IRQ/s`,
  ].filter(Boolean).join(' · ');
}

$('machine').textContent = { debian: 'Debian 13', buildroot: 'Buildroot (test guest)' }[machine];
const view = params.get('view') as View | null;
setView(view === 'terminal' || view === 'both' ? view : 'screen');
start();
