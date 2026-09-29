// The page (docs/frontend.md): the machine's screen on a canvas, its serial
// console on xterm.js, power state and a status line. The VM runs in
// web/app/worker.ts; this is DOM code only, talking to it through
// web/app/protocol.ts. `?machine=buildroot` picks the test guest, `?ncpus=N`
// the vCPU count, `?view=screen|terminal|both` the first view (the last one
// chosen is remembered), `?params=` extra kernel parameters.
import { Terminal } from '@xterm/xterm';
import { attachInput, type Input } from '../input.ts';
import { overlayBytes, removeOverlay } from '../overlay.ts';
import { defaultCpus, hostMemoryGiB, MACHINES, type Machine, type MachineName } from './machine.ts';
import { createNetwork, DEFAULT_SETTINGS, tailscaleBuilt, parseControlURL, parseHostname, type NetworkSettings } from './network.ts';
import type { FromWorker, PowerState, Problem, Status, ToWorker } from './protocol.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const machine = (params.get('machine') ?? 'debian') as MachineName;
if (!(machine in MACHINES)) throw new Error(`no machine ${machine}`);
const ncpus = Number(params.get('ncpus')) || defaultCpus(navigator.hardwareConcurrency || 4);
const spec: Machine = MACHINES[machine];

// Settings remembered per browser (the view and the network). Storage can be off or throw: then nothing is remembered.
type Settings = { view?: View; net?: NetworkSettings };
const SETTINGS = 'webpc.settings';
const settings = (): Settings => {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS) ?? '{}') as Settings;
  } catch {
    return {};
  }
};
const remember = (s: Settings) => {
  try {
    localStorage.setItem(SETTINGS, JSON.stringify({ ...settings(), ...s }));
  } catch { /* not remembered */ }
};

let canvas = $<HTMLCanvasElement>('screen');
const screenBox = $('screen-view');
const stateEl = $('state');
const statusEl = $('status');
const messageEl = $('message');
const messageText = $('message-text');
const messageActions = $('message-actions');
const restartBtn = $<HTMLButtonElement>('restart');
const resetDiskBtn = $<HTMLButtonElement>('reset-disk');
const bootCard = $('boot');
const bootProgress = $<HTMLProgressElement>('boot-progress');
const bootLine = $('boot-line');

// The serial terminal. The PL011 has no size negotiation: the guest assumes 80×24 unless told (`stty`).
const term = new Terminal({ cols: 80, rows: 24, convertEol: false, scrollback: 5000, fontFamily: 'ui-monospace, "DejaVu Sans Mono", Menlo, monospace', fontSize: 14, theme: { background: '#0b0d10' } });
term.open($('terminal'));

// Views: the screen first (M8 decision 2), the terminal, or both.
type View = 'screen' | 'terminal' | 'both';
const setView = (v: View, save = true) => {
  if (save) remember({ view: v });
  document.body.dataset.view = v;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view-button]')) b.setAttribute('aria-pressed', String(b.dataset.viewButton === v));
  fit();
  if (v !== 'screen') term.refresh(0, term.rows - 1);
  (v === 'terminal' ? term : canvas).focus();
};
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view-button]')) b.onclick = () => setView(b.dataset.viewButton as View);

// The canvas at an integer multiple of the framebuffer in device pixels when that fits (crisp),
// scaled down to fit (smooth) otherwise.
const fb = spec.framebuffer;
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
/** The machine's, plus the page's own `idle`: no machine yet (waiting for "Start anyway"). */
type PageState = PowerState | 'idle';
let state: PageState = 'loading';
let last: { status: Status; at: number } | undefined;

// The serial console's output, kept for the log a user can copy or save (the terminal's scrollback is shorter).
const LOG_MAX = 1 << 20;
let log = '';
let lastLine = ''; // the boot card's line
const addLog = (text: string) => {
  log += text;
  if (log.length > 2 * LOG_MAX) log = log.slice(-LOG_MAX);
  if (bootCard.hidden) return;
  const lines = (lastLine + text).split(/\r?\n/);
  lastLine = lines.pop()!;
  const shown = lines.reverse().find((l) => l.trim());
  if (shown !== undefined) bootLine.textContent = shown.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
};

type Action = { label: string; run: (button: HTMLButtonElement) => void };
/** A standing note (another browser), shown while there's no message. */
let note = '';

function setState(s: PageState, message?: string, actions: Action[] = [], kind: 'error' | 'warn' = 'error') {
  state = s;
  stateEl.textContent = { idle: 'Not started', loading: 'Loading', booting: 'Booting', running: 'Running', off: 'Powered off', rebooting: 'Rebooting', crashed: 'Crashed', failed: "Couldn't start" }[s];
  stateEl.dataset.state = s;
  document.body.dataset.state = s;
  messageText.textContent = message ?? note;
  messageEl.dataset.kind = message ? kind : 'warn';
  messageActions.replaceChildren(...actions.map((a) => {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.onclick = () => a.run(b);
    return b;
  }));
  messageEl.hidden = !(message || note);
  restartBtn.textContent = s === 'off' || s === 'idle' ? 'Start' : s === 'failed' ? 'Retry' : 'Restart';
  bootCard.hidden = !(s === 'loading' || s === 'booting') || bootCard.dataset.done === 'true';
}

// What a user can do about each problem (the worker's message says what happened and why).
const retry: Action = { label: 'Retry', run: () => void restart() };
const showLog: Action = { label: 'Show serial log', run: () => { setView(document.body.dataset.view === 'screen' ? 'both' : (document.body.dataset.view as View), false); term.scrollToBottom(); } };
const copyLog: Action = {
  label: 'Copy serial log',
  run: (b) => navigator.clipboard.writeText(log).then(() => { b.textContent = 'Copied'; }, () => { b.textContent = "Couldn't copy: save it instead"; }),
};
const saveLog: Action = {
  label: 'Save serial log',
  run: () => {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([log], { type: 'text/plain' })), download: `webpc-${machine}-serial-${new Date().toISOString().replace(/[:.]/g, '-')}.log` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  },
};
const resetDisk: Action = { label: 'Reset disk…', run: () => void resetDiskAsked() };
const ACTIONS: Record<Problem, Action[]> = {
  'missing-core': [retry],
  'missing-image': [retry],
  'disk-in-use': [retry],
  'disk-mismatch': [resetDisk],
  memory: [retry],
  panic: [showLog, copyLog, saveLog],
  emulator: [showLog, copyLog, saveLog],
};

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
  // A network card when the user chose one (Network menu): the machine gets its end of the IP port.
  const ip = spec.network && netSettings().enabled ? network.port() : undefined;
  const [kbd, tablet, serial] = [new MessageChannel(), new MessageChannel(), new MessageChannel()];
  const r: Run = { worker, input: attachInput(canvas, kbd.port1, tablet.port1), serial: serial.port1 };
  run = r;
  last = undefined;
  log = lastLine = '';
  bootCard.dataset.done = 'false';
  bootLine.textContent = '';
  bootProgress.removeAttribute('value'); // indeterminate until the sizes are known
  $('boot-title').textContent = `Starting ${spec.label}`;
  setState('loading');
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    if (run !== r) return;
    const m = e.data;
    if (m.type === 'state') {
      setState(m.state, m.message, m.problem ? ACTIONS[m.problem] : []);
      if (m.state === 'booting') {
        $('boot-title').textContent = `Booting ${spec.label}`;
        bootProgress.removeAttribute('value');
        bootLine.textContent = 'Starting the kernel'; // then its lines, until its console takes the screen (~2 s on Debian)
      }
      if (m.state === 'running') bootCard.hidden = true;
      if (m.state === 'rebooting') void restart();
    } else if (m.type === 'serial') {
      term.write(m.data);
      addLog(m.data);
    } else if (m.type === 'status') {
      showStatus(m.status);
    } else if (m.type === 'progress') {
      if (m.total) bootProgress.value = m.loaded / m.total;
      const mb = (n: number) => (n / 1e6).toFixed(1);
      bootLine.textContent = m.total ? `Downloading ${mb(m.loaded)} of ${mb(m.total)} MB` : `Downloading ${mb(m.loaded)} MB`;
      if (state === 'loading') stateEl.textContent = m.total ? `Loading ${Math.floor((100 * m.loaded) / m.total)}%` : 'Loading';
    } else if (m.type === 'screen') {
      bootCard.dataset.done = 'true'; // the guest's console has the screen: it shows the boot from here
      bootCard.hidden = true;
    }
  };
  worker.onerror = (e) => { if (run === r) setState('crashed', `The machine's worker failed: ${e.message}`, ACTIONS.emulator); };
  worker.postMessage({ type: 'start', machine, ncpus, keyboard: kbd.port2, tablet: tablet.port2, serial: serial.port2, screen, params: params.get('params') ?? undefined, ip } satisfies ToWorker, [kbd.port2, tablet.port2, serial.port2, screen, ...(ip ? [ip] : [])]);
  if (ip) autoconnect();
  renderNetwork();
}

/** Stops the machine, if any: its worker releases the disk overlay first (or gets 3 s to). */
async function stop() {
  const r = run;
  run = undefined;
  if (!r) return;
  r.input.detach();
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 3000);
    r.worker.onmessage = (e: MessageEvent<FromWorker>) => { if (e.data.type === 'stopped') { clearTimeout(t); resolve(); } };
    r.worker.postMessage({ type: 'stop' } satisfies ToWorker);
  });
  r.worker.terminate();
}

/**
 * Runs `f` (a stop, then maybe a start) unless another is running: a second Restart click, or one
 * during a disk reset, would start a machine beside the one being started, with nothing to stop it.
 */
let switching = false;
async function exclusively(f: () => Promise<void>) {
  if (switching) return;
  switching = restartBtn.disabled = resetDiskBtn.disabled = true;
  try {
    await f();
  } finally {
    switching = restartBtn.disabled = resetDiskBtn.disabled = false;
  }
}

/** Stops the machine and starts a new one. */
const restart = () => exclusively(async () => {
  await stop();
  term.reset();
  start();
});

restartBtn.onclick = () => {
  if ((state === 'running' || state === 'booting') && !confirm('Restart the machine? Like pulling the plug: unsaved work in the guest is lost.')) return;
  void restart();
};

// The disk reset (M8 decision 4): stop the machine (its overlay's files are locked while it runs), delete the overlay, start again.
async function resetDiskAsked() {
  const name = spec.overlay;
  if (!name) return;
  const written = await overlayBytes(name).catch(() => 0);
  const size = !written ? '' : written < 1e6 ? ` (${Math.ceil(written / 1e3)} KB)` : ` (${(written / 1e6).toFixed(0)} MB)`;
  if (!confirm(`Reset ${spec.label}'s disk? Everything the machine wrote to it${size} is deleted: your files, installed packages and settings. It then boots from the image as published.`)) return;
  await exclusively(async () => {
    await stop();
    term.reset();
    setState('loading');
    stateEl.textContent = 'Resetting the disk';
    try {
      await removeOverlay(name); // once the machine's device worker has closed it
    } catch (e) {
      setState('failed', `The disk couldn't be reset: ${String(e)}\nClose other tabs of this page (one of them may have the disk open), then try again.`, [resetDisk, retry]);
      return;
    }
    start();
  });
}
resetDiskBtn.hidden = !spec.overlay;
resetDiskBtn.onclick = () => void resetDiskAsked();

// Keys typed into the terminal go to the PL011 (xterm.js sends what a terminal would: \r for Enter, escape sequences).
term.onData((d) => run?.serial.postMessage(d));

// Key combinations the browser keeps for itself, to the screen's keyboard (web/input.ts `chord`).
const keysMenu = $<HTMLDetailsElement>('keys');
// Ctrl+Alt+F1 … F12: Linux's virtual consoles (Debian starts gettys on tty1–tty6 on demand).
$('fkeys').append(...Array.from({ length: 12 }, (_, k) => {
  const b = Object.assign(document.createElement('button'), { textContent: `F${k + 1}`, title: `Ctrl+Alt+F${k + 1}` });
  b.setAttribute('aria-label', `Ctrl+Alt+F${k + 1}`);
  b.dataset.chord = `ControlLeft AltLeft F${k + 1}`;
  return b;
}));
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-chord]')) {
  b.onclick = () => {
    keysMenu.open = false;
    canvas.focus();
    run?.input.chord(...b.dataset.chord!.split(' '));
  };
}
document.addEventListener('pointerdown', (e) => { if (!keysMenu.contains(e.target as Node)) keysMenu.open = false; });

// The network (docs/frontend.md "Network"): a machine with `network` gets a card when the user connects; the Network
// menu logs a Tailscale client in and out. The card can't be added to a running machine: connecting restarts it.
const netSettings = (): NetworkSettings => ({ ...DEFAULT_SETTINGS, ...settings().net });
const network = createNetwork(() => renderNetwork());
const netMenu = $<HTMLDetailsElement>('network');
const netEl = { status: $('net-status'), login: $<HTMLAnchorElement>('net-login'), form: $<HTMLFormElement>('net-form'), control: $<HTMLInputElement>('net-control'), hostname: $<HTMLInputElement>('net-hostname'), key: $<HTMLInputElement>('net-authkey'), error: $('net-error'), hint: $('net-hint'), actions: $('net-actions'), disconnect: $('net-disconnect'), logout: $('net-logout') };
let lastPhase = '';

function renderNetwork() {
  const s = netSettings();
  const v = network.view();
  netMenu.dataset.phase = v.phase;
  const active = network.active();
  netEl.status.textContent = s.enabled || active ? v.text : 'No network card';
  netEl.login.hidden = !v.loginURL;
  if (v.loginURL) netEl.login.href = v.loginURL;
  netEl.form.hidden = active;
  netEl.actions.hidden = !s.enabled;
  netEl.disconnect.hidden = !active;
  netEl.logout.hidden = !active || s.keyed;
  netEl.hint.textContent = !s.enabled ? 'Connecting gives the machine a network card, which restarts it (a card can\'t be added to a running machine).'
    : !active && s.keyed ? 'An auth key isn\'t kept: enter it again to connect.' : '';
  if (v.phase === 'login' && lastPhase !== 'login') netMenu.open = true; // the user has something to do
  lastPhase = v.phase;
}

function formError(message?: string) {
  netEl.error.textContent = message ?? '';
  netEl.error.hidden = !message;
}

/** Starts the client for the settings the machine started under (a login's node is kept, so no key is needed). */
function autoconnect() {
  const s = netSettings();
  if (!s.autoconnect || network.active()) return;
  const url = parseControlURL(s.controlURL);
  if ('error' in url) return;
  const host = parseHostname(s.hostname);
  network.connect({ controlURL: url.url, hostname: 'hostname' in host ? host.hostname : 'webpc' });
}

netEl.form.onsubmit = (e) => {
  e.preventDefault();
  const url = parseControlURL(netEl.control.value);
  const host = parseHostname(netEl.hostname.value);
  if ('error' in url) return formError(url.error);
  if ('error' in host) return formError(host.error);
  formError();
  const authKey = netEl.key.value.trim();
  void (async () => {
    if (!(await tailscaleBuilt())) return formError("The Tailscale client isn't built on this server. Start the page with `npm run serve` or `npm start` (they build it; Go is needed), or run net/tailscale/build.sh.");
    const had = netSettings().enabled;
    if (!had && (state === 'running' || state === 'booting') && !confirm('Connecting gives the machine a network card, which restarts it: like pulling the plug, unsaved work in the guest is lost. Continue?')) return;
    remember({ net: { enabled: true, controlURL: netEl.control.value.trim(), hostname: netEl.hostname.value.trim(), autoconnect: !authKey, keyed: !!authKey } });
    if (!had) await restart(); // the new machine has the card
    try {
      network.connect({ controlURL: url.url, hostname: host.hostname, authKey: authKey || undefined });
      netEl.key.value = '';
    } catch (err) {
      formError(String((err as Error).message ?? err));
    }
    renderNetwork();
  })();
};
netEl.disconnect.onclick = () => {
  remember({ net: { ...netSettings(), autoconnect: false } });
  void network.disconnect().then(renderNetwork);
};
netEl.logout.onclick = () => {
  if (!confirm('Log out? This machine is removed from the network and its keys are forgotten here; connecting again logs in as a new node.')) return;
  remember({ net: { ...netSettings(), autoconnect: false } });
  void network.logout().then(renderNetwork);
};
$('net-remove').onclick = () => {
  if ((state === 'running' || state === 'booting') && !confirm('Remove the network card? This restarts the machine: like pulling the plug, unsaved work in the guest is lost.')) return;
  remember({ net: { ...netSettings(), enabled: false, autoconnect: false } });
  void network.disconnect().then(() => restart()).then(renderNetwork);
};
document.addEventListener('pointerdown', (e) => { if (!netMenu.contains(e.target as Node)) netMenu.open = false; });
if (spec.network) {
  netMenu.hidden = false;
  netEl.control.value = netSettings().controlURL;
  netEl.hostname.value = netSettings().hostname;
  renderNetwork();
}

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

$('machine').textContent = spec.label;
// The view: the query's, else the one chosen last in this browser, else the screen (M8 decision 2).
const isView = (v: unknown): v is View => v === 'screen' || v === 'terminal' || v === 'both';
const asked = params.get('view');
setView(isView(asked) ? asked : isView(settings().view) ? settings().view! : 'screen', false);

// Before starting: what the page can tell won't work.
function boot() {
  // SharedArrayBuffer (the guest's memory, shared by the vCPU workers) needs cross-origin isolation.
  if (!crossOriginIsolated) {
    setState('failed', "This page needs cross-origin isolation for the emulator's shared memory, and it wasn't served with it (the COOP and COEP headers).\nRun `npm start` in the repository and open the URL it prints: its server sends them.");
    restartBtn.hidden = resetDiskBtn.hidden = true;
    return;
  }
  // Chromium kills a renderer that runs out of memory without an error to catch (PLAN.md §4): judge up front.
  const need = hostMemoryGiB(spec.ramMiB, ncpus);
  const has = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (has !== undefined && has < need) {
    const fewer = Math.floor((has - hostMemoryGiB(spec.ramMiB, 0)) / (hostMemoryGiB(0, 1) - hostMemoryGiB(0, 0)) + 1e-9);
    setState('idle', `This machine needs about ${need.toFixed(1)} GB of memory (${spec.ramMiB} MiB of guest RAM plus the emulator, ${ncpus} vCPU${ncpus > 1 ? 's' : ''}), and this device reports ${has} GB.\nIf memory runs out, the browser closes the tab without warning. Close other tabs and apps first${fewer > 0 && fewer < ncpus ? `, or use fewer vCPUs (?ncpus=${fewer} fits)` : ''}.`, [{ label: 'Start anyway', run: () => void restart() }], 'warn');
    return;
  }
  start();
}
// Other browsers may work in part; nothing is done for them yet (their pass is in docs/backlog.md).
const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands ?? [];
if (!brands.some((b) => b.brand === 'Chromium')) note = 'webpc is developed and tested in Chromium (and Chrome); in this browser, parts of it may not work.';
boot();
