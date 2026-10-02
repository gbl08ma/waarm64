// The page (docs/frontend.md): the machine's screen on a canvas, its serial
// console on xterm.js, power state and a status line. The VM runs in
// web/app/worker.ts; this is DOM code only, talking to it through
// web/app/protocol.ts. `?machine=buildroot` picks the test guest, `?ncpus=N`
// the vCPU count, `?view=screen|terminal|both` the first view (the last one
// chosen is remembered), `?params=` extra kernel parameters (direct-boot machines), `?credential=name:value` a systemd
// credential over fw_cfg (firmware machines), `?disk2=<url>` a read-only second disk, `?disk=<url>` a root
// disk of your own (the header's "Open disk…" and a dropped file choose a local one).
import { Terminal } from '@xterm/xterm';
import { attachInput, type Input } from '../input.ts';
import { overlayBytes, removeOverlay } from '../overlay.ts';
import { changesHeader as readChangesHeader } from '../qcow2.ts';
import { openSnapshot, SnapshotError, type SnapshotHeader } from '../snapshot-file.ts';
import { defaultCpus, diskOverlay, hostMemoryGiB, MACHINES, type DiskChoice, type Machine, type MachineName } from './machine.ts';
import { runExport, type ExportMode } from './export.ts';
import { runImport } from './import.ts';
import { createNetwork, DEFAULT_SETTINGS, tailscaleBuilt, parseControlURL, parseHostname, type NetworkSettings } from './network.ts';
import type { FromWorker, PowerState, Problem, Status, ToWorker } from './protocol.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const machine = (params.get('machine') ?? 'debian') as MachineName;
if (!(machine in MACHINES)) throw new Error(`no machine ${machine}`);
const ncpus = Number(params.get('ncpus')) || defaultCpus(navigator.hardwareConcurrency || 4);
const spec: Machine = MACHINES[machine];
// `?credential=name:value` (repeatable): a systemd credential for a firmware machine, for development and tests.
const credentials = params.getAll('credential').map((c) => ({ name: c.slice(0, c.indexOf(':')), data: c.slice(c.indexOf(':') + 1) }));

// The root disk: the machine's own, or the one the user chose (a file, or `?disk=<url>`). A chosen disk has its own overlay,
// so choosing the same file again finds its changes (docs/frontend.md "Your own disk").
let chosen: DiskChoice | undefined;
/** The OPFS overlay of the disk the machine boots. */
const overlayName = () => chosen?.overlay ?? spec.overlay;
/** What the disk is called on the page. */
const diskName = () => (chosen ? (chosen.file?.name ?? new URL(chosen.url!, location.href).pathname.split('/').pop() ?? 'disk') : undefined);

// Settings remembered per browser (the view, the network, whether saved disks are compressed). Storage can be off or throw: then nothing is remembered.
type Settings = { view?: View; net?: NetworkSettings; compress?: boolean };
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
const saveSnapshotBtn = $<HTMLButtonElement>('save-snapshot');
const suspendBtn = $<HTMLButtonElement>('suspend');
const loadSnapshotInput = $<HTMLInputElement>('load-snapshot-input');
const bootCard = $('boot');
const bootProgress = $<HTMLProgressElement>('boot-progress');
const bootLine = $('boot-line');
const bootSerial = $('boot-serial');

// The serial terminal. The PL011 has no size negotiation: the guest assumes 80×24 unless told (`stty`); the firmware's console is 80×25 (images/build.sh edk2 offers no other mode), so the terminal has 25 rows.
const term = new Terminal({ cols: 80, rows: 25, convertEol: false, scrollback: 5000, fontFamily: 'ui-monospace, "DejaVu Sans Mono", Menlo, monospace', fontSize: 14, theme: { background: '#0b0d10' } });
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
// The screen's size: the machine's to begin with, then what a virtio-gpu scanout says (`mode` on the display port).
const fb = { ...spec.framebuffer };
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
type Run = { worker: Worker; input: Input; serial: MessagePort; display: MessagePort };
let run: Run | undefined;
/** The guest has a driver on its keyboard (else the screen's keys go to the serial console: the firmware, GRUB). Per machine; false until the worker says. */
let keyboardLive = false;
/** The machine's, plus the page's own `idle`: no machine yet (waiting for "Start anyway"). */
type PageState = PowerState | 'idle';
let state: PageState = 'loading';
let last: { status: Status; at: number } | undefined;
/** A stop and start in progress (`exclusively`), or a snapshot being written (`saveSnapshot`): the other actions wait. */
let switching = false;
let saving = false;
/** Which buttons can be used now: a snapshot saves from a machine that runs, and none of the actions that stop it overlap a save or a switch. */
function syncButtons() {
  restartBtn.disabled = resetDiskBtn.disabled = switching || saving;
  saveSnapshotBtn.disabled = suspendBtn.disabled = switching || saving || !(state === 'running' || state === 'booting');
}

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
  stateEl.textContent = { idle: 'Not started', loading: 'Loading', booting: 'Booting', running: 'Running', off: 'Powered off', suspended: 'Suspended', rebooting: 'Rebooting', crashed: 'Crashed', failed: "Couldn't start" }[s];
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
  restartBtn.textContent = s === 'off' || s === 'idle' || s === 'suspended' ? 'Start' : s === 'failed' ? 'Retry' : 'Restart';
  bootCard.hidden = !(s === 'loading' || s === 'booting') || bootCard.dataset.done === 'true';
  bootSerial.hidden = !spec.firmware || s !== 'booting';
  syncButtons();
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
const startNormally: Action = { label: 'Start', run: () => void restart() };
const resumeAction: Action = { label: 'Start', run: () => void restart() };
const bootInstead: Action = { label: 'Boot instead', run: () => { if (confirm('Boot the machine from its disk instead? Its suspended memory is dropped: what the guest had not written to its disk is lost, as after a power cut.')) void restart(false); } };
const loadAgain: Action = { label: 'Load snapshot…', run: () => loadSnapshotInput.click() };
const ACTIONS: Record<Problem, Action[]> = {
  'missing-core': [retry],
  'missing-image': [retry],
  'disk-in-use': [retry],
  'disk-mismatch': [resetDisk],
  memory: [retry],
  panic: [showLog, copyLog, saveLog],
  snapshot: [startNormally, loadAgain],
  emulator: [showLog, copyLog, saveLog],
};

/**
 * Starts a machine: booted, or (with `snapshot`) the one the file holds. A machine suspended on
 * this disk is resumed instead of booting, unless `resume` is false (it is then dropped).
 */
function start(snapshot?: File, resume = true) {
  // The machine worker draws the screen (web/display.ts): a canvas hands its drawing over only once.
  const focused = document.activeElement === canvas;
  [fb.width, fb.height] = [spec.framebuffer.width, spec.framebuffer.height];
  const fresh = canvas.cloneNode() as HTMLCanvasElement;
  [fresh.width, fresh.height] = [fb.width, fb.height];
  canvas.replaceWith(fresh);
  canvas = fresh;
  if (focused) canvas.focus();
  fit();
  const screen = canvas.transferControlToOffscreen();
  const display = new MessageChannel();
  display.port1.onmessage = (e: MessageEvent<{ type: 'mode'; width: number; height: number }>) => {
    if (run?.display !== display.port1) return;
    if ((e.data as { type: string }).type === 'draw-stats') ((window as unknown as { __drawStats?: unknown[] }).__drawStats ??= []).push(e.data);
    if (e.data?.type !== 'mode' || !(e.data.width > 0 && e.data.height > 0)) return;
    [fb.width, fb.height] = [e.data.width, e.data.height];
    fit();
    // The firmware's graphics output is up: its screens are the boot (the card hides, as it does for a console on a simple framebuffer).
    bootCard.dataset.done = 'true';
    bootCard.hidden = true;
  };
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  // A machine that can have a network card has one from the start (it can't be added later without a restart): its end of the IP port.
  const ip = spec.network ? network.port() : undefined;
  const [kbd, tablet, serial] = [new MessageChannel(), new MessageChannel(), new MessageChannel()];
  const r: Run = { worker, input: attachInput(canvas, kbd.port1, tablet.port1, { live: () => keyboardLive, send: (d) => term.input(d, true) }), serial: serial.port1, display: display.port1 };
  run = r;
  keyboardLive = false;
  last = undefined;
  log = lastLine = '';
  bootCard.dataset.done = 'false';
  bootLine.textContent = '';
  bootProgress.removeAttribute('value'); // indeterminate until the sizes are known
  $('boot-title').textContent = snapshot ? `Loading ${snapshot.name}` : `Starting ${spec.label}`;
  setState('loading');
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    if (run !== r) return;
    const m = e.data;
    if (m.type === 'state') {
      if (m.state === 'suspended') {
        saving = false;
        snapshotJob = undefined;
      }
      // A message without a problem is a note (resumed, suspended), not an error.
      setState(m.state, m.message, m.problem ? ACTIONS[m.problem] : m.state === 'suspended' ? [resumeAction, bootInstead] : [], m.problem || m.state === 'crashed' || m.state === 'failed' ? 'error' : 'warn');
      if (m.state === 'booting') {
        $('boot-title').textContent = `Booting ${spec.label}`;
        bootProgress.removeAttribute('value');
        bootLine.textContent = 'Starting the kernel'; // then its lines, until its console takes the screen (~2 s on Debian)
      }
      if (m.state === 'running') bootCard.hidden = true;
      if (m.state === 'rebooting') void restart();
    } else if (m.type === 'serial') {
      if (m.replay) {
        replaying = true; // xterm.js answers a query in the text (a cursor position request) while it parses it: the guest didn't ask
        term.write(m.data, () => { replaying = false; });
      } else {
        term.write(m.data);
      }
      addLog(m.data);
    } else if (m.type === 'keyboard') {
      keyboardLive = m.live;
    } else if (m.type === 'status') {
      showStatus(m.status);
    } else if (m.type === 'phase') {
      bootLine.textContent = m.text;
      bootProgress.removeAttribute('value');
      if (state === 'loading') stateEl.textContent = m.text;
    } else if (m.type === 'snapshot-progress') {
      snapshotJob?.progress(m.phase, m.fraction);
    } else if (m.type === 'snapshot-chunk') {
      snapshotJob?.chunk(m.data);
    } else if (m.type === 'snapshot-done') {
      snapshotJob?.done(m.bytes, m.pausedMs);
    } else if (m.type === 'snapshot-error') {
      snapshotJob?.error(m.message);
    } else if (m.type === 'progress') {
      if (m.total) bootProgress.value = m.loaded / m.total;
      const mb = (n: number) => (n / 1e6).toFixed(1);
      bootLine.textContent = m.total ? `Downloading ${mb(m.loaded)} of ${mb(m.total)} MB` : `Downloading ${mb(m.loaded)} MB`;
      if (state === 'loading') stateEl.textContent = m.total ? `Loading ${Math.floor((100 * m.loaded) / m.total)}%` : 'Loading';
    } else if (m.type === 'screen' && !spec.firmware) {
      // The guest's console has the screen: it shows the boot from here. (Through the firmware the
      // screen stays black until a getty: the boot's output, menus and a first boot's questions are on the serial console.)
      bootCard.dataset.done = 'true';
      bootCard.hidden = true;
    }
  };
  worker.onerror = (e) => {
    if (run !== r) return;
    snapshotJob?.error(`the machine's worker failed: ${e.message}`);
    setState('crashed', `The machine's worker failed: ${e.message}`, ACTIONS.emulator);
  };
  worker.postMessage({ type: 'start', machine, ncpus, disk: chosen, keyboard: kbd.port2, tablet: tablet.port2, serial: serial.port2, screen, display: display.port2, simple: params.get('display') === 'simple' || undefined, displayStats: params.has('displaystats') || undefined, params: params.get('params') ?? undefined, credentials, disk2: params.get('disk2') ?? undefined, ip, snapshot, resume } satisfies ToWorker, [kbd.port2, tablet.port2, serial.port2, screen, display.port2, ...(ip ? [ip] : [])]);
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
async function exclusively(f: () => Promise<void>) {
  if (switching || saving) return;
  switching = true;
  syncButtons();
  try {
    await f();
  } finally {
    switching = false;
    syncButtons();
  }
}
/** True while a snapshot is being written (after saying so) or the machine is being switched: Save disk, Open disk and the like wait for it. */
function busy() {
  if (saving) alert('A snapshot is being saved. Try again once it is done.');
  return switching || saving;
}

/** Stops the machine and starts a new one (which resumes a suspended machine, unless `resume` is false). */
const restart = (resume = true) => exclusively(async () => {
  await stop();
  term.reset();
  start(undefined, resume);
});

restartBtn.onclick = () => {
  if ((state === 'running' || state === 'booting') && !confirm('Restart the machine? Like pulling the plug: unsaved work in the guest is lost.')) return;
  void restart();
};

// The disk reset (M8 decision 4): stop the machine (its overlay's files are locked while it runs), delete the overlay, start again.
async function resetDiskAsked() {
  const name = overlayName();
  if (!name || busy()) return;
  const written = await overlayBytes(name).catch(() => 0);
  const size = !written ? '' : written < 1e6 ? ` (${Math.ceil(written / 1e3)} KB)` : ` (${(written / 1e6).toFixed(0)} MB)`;
  if (!confirm(`Reset ${chosen ? `the disk ${diskName()}` : `${spec.label}'s disk`}? Everything the machine wrote to it${size} is deleted: your files, installed packages and settings. It then boots from the image as published.`)) return;
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
$('open-disk').hidden = !spec.firmware;
resetDiskBtn.onclick = () => void resetDiskAsked();

// Your own disk: a local file (raw or qcow2, by its magic), by the picker or dropped on the page. The machine restarts on it; the
// disk's changes are kept in the browser per file (name, size, modification time), so choosing it again continues where it left off.
const openDiskInput = $<HTMLInputElement>('open-disk-input');
async function chooseDisk(choice: { file: File } | { url: string }) {
  if ('file' in choice && (await isSnapshot(choice.file))) return loadSnapshot(choice.file); // a snapshot isn't a disk to boot: it replaces the machine
  if (busy()) return;
  if ('file' in choice && spec.overlay) {
    if (await changesHeader(choice.file)) { // a changes file isn't a disk to boot: it goes onto the disk on the page
      await loadChanges(choice.file);
      return;
    }
  }
  if (!spec.firmware) return; // only a machine that boots through UEFI takes a disk of its own (the test guests' kernels are their own)
  const next: DiskChoice = { ...choice, overlay: await diskOverlay(choice) };
  if ((state === 'running' || state === 'booting') && !confirm(`Boot ${next.file?.name ?? next.url}? The machine restarts, like pulling the plug: unsaved work in the guest is lost. Its changes to the current disk are kept.`)) return;
  chosen = next;
  $('machine').textContent = `${spec.label} · ${diskName()}`;
  resetDiskBtn.hidden = false;
  await restart();
}
// Changes in (loop 6): a changes file (Save disk's "Changes only") replaces what the machine has written to the disk on the page,
// once the page's disk is checked to be the one it was made over (its SHA-256). The machine stops while it's loaded.
const changesHeader = async (file: File) => readChangesHeader(new Uint8Array(await file.slice(0, 1 << 16).arrayBuffer()));
async function loadChanges(file: File) {
  const overlay = overlayName();
  if (!overlay || busy()) return;
  const info = await changesHeader(file);
  if (!info) return void alert(`${file.name} isn't a changes file (a qcow2 made by Save disk's "Changes only"). To boot a disk, use Open disk….`);
  if (!info.sha256) return void alert(`${file.name} has a backing file (${info.backingName}) but wasn't made by Save disk, so its base can't be checked: it can't be loaded.`);
  const written = await overlayBytes(overlay).catch(() => 0);
  const running = state === 'running' || state === 'booting';
  if (!confirm(`Load the changes in ${file.name}? They replace everything the machine has written to ${chosen ? diskName() : `${spec.label}'s disk`}${written ? ` (${(written / 1e6).toFixed(written < 1e7 ? 1 : 0)} MB)` : ''}, and the firmware's settings. The machine ${running ? 'stops, like pulling the plug, and ' : ''}starts again afterwards.`)) return;
  await exclusively(async () => {
    await stop();
    term.reset();
    setState('off');
    stateEl.textContent = 'Loading the changes';
    try {
      await runImport({ changes: file, disk: chosen ?? { url: spec.disk, overlay }, label: baseName() }, (phase, f) => {
        stateEl.textContent = `${phase} ${Math.floor(100 * f)}%`;
      });
    } catch (e) {
      const text = String((e as Error).message ?? e);
      setState('failed', `The changes couldn't be loaded: ${text}\n${/in use/.test(text) ? 'Close other tabs of this page (one of them may have the disk open), then try again.' : 'The disk is as it was.'}`, [retry]);
      return;
    }
    start();
  });
}
const loadChangesInput = $<HTMLInputElement>('load-changes-input');
$<HTMLButtonElement>('load-changes').onclick = () => loadChangesInput.click();
$('load-changes').hidden = !spec.overlay;
loadChangesInput.onchange = () => {
  const file = loadChangesInput.files?.[0];
  loadChangesInput.value = '';
  if (file) void loadChanges(file);
};

// Your disk out (loop 5): the changes over the image (a qcow2 that names it as its backing file), or the whole disk. The machine
// stops while it's written (the overlay's files are the writer's); the file goes to where the user picks, or is downloaded.
const SAVES: Record<ExportMode, { suffix: string; description: string; type: string }> = {
  changes: { suffix: '-changes.qcow2', description: 'Changes over the base image (qcow2)', type: 'application/x-qcow2' },
  qcow2: { suffix: '.qcow2', description: 'Whole disk (qcow2)', type: 'application/x-qcow2' },
  raw: { suffix: '.img', description: 'Whole disk (raw)', type: 'application/octet-stream' },
};
/** The disk's file name: the chosen file's or URL's, or the machine's own image's. */
const baseName = () => diskName() ?? new URL(spec.disk, location.href).pathname.split('/').pop() ?? 'disk';
const saveCompress = $<HTMLInputElement>('save-compress');
saveCompress.checked = settings().compress ?? true;
saveCompress.onchange = () => remember({ compress: saveCompress.checked });
async function saveDisk(mode: ExportMode) {
  const overlay = overlayName();
  if (!overlay || busy()) return;
  const how = SAVES[mode];
  const stem = baseName().replace(/\.(qcow2|img|raw)$/i, '');
  const suggestedName = `${stem}${how.suffix}`;
  // The picker first: it needs the click's user activation, which the stop below would let expire.
  let handle: FileSystemFileHandle | undefined;
  const picker = (window as unknown as { showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (picker) {
    try {
      handle = await picker.call(window, { suggestedName, types: [{ description: how.description, accept: { [how.type]: [how.suffix.slice(how.suffix.lastIndexOf('.'))] } }] });
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return; // cancelled
      handle = undefined; // the download below
    }
  }
  const running = state === 'running' || state === 'booting';
  if (running && !confirm('Stop the machine to save its disk? It is stopped like pulling the plug: unsaved work in the guest is lost (shut it down first with poweroff for a clean disk). It starts again afterwards.')) return;
  await exclusively(async () => {
    await stop();
    setState('off');
    stateEl.textContent = 'Saving the disk';
    const mb = (n: number) => (n / 1e6).toFixed(n < 1e7 ? 1 : 0);
    try {
      const r = await runExport({ mode, compress: mode !== 'raw' && saveCompress.checked, disk: chosen ?? { url: spec.disk, overlay }, baseName: baseName(), handle }, (phase, f) => {
        stateEl.textContent = `${phase} ${Math.floor(100 * f)}%`;
      });
      if (r.blob) {
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(r.blob), download: suggestedName });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      }
      setState('off', `Saved ${handle?.name ?? suggestedName} (${mb(r.bytes)} MB${mode === 'changes' ? `, ${r.blocks} changed blocks; keep ${baseName()} beside it` : ''}).`, [], 'warn');
    } catch (e) {
      const text = String((e as Error).message ?? e);
      setState('failed', `The disk couldn't be saved: ${text}\n${/in use/.test(text) ? 'Close other tabs of this page (one of them may have the disk open), then try again.' : ''}`, [retry]);
      return;
    }
    if (running) start();
  });
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-save]')) {
  b.onclick = () => {
    b.closest('details')!.open = false;
    void saveDisk(b.dataset.save as ExportMode);
  };
}
$('save').hidden = !spec.overlay;


// Snapshots (docs/frontend.md "Snapshots"): the running machine, RAM and disk changes and all, in a file, and back.
/** The save in progress: the worker's messages for it (the page's `worker.onmessage` forwards them). */
let snapshotJob: { progress(phase: string, fraction: number): void; chunk(data: Uint8Array): void; done(bytes: number, pausedMs: number): void; error(message: string): void } | undefined;
const SNAPSHOT_SUFFIX = '.webpcsnap';
const mb = (n: number) => (n < 1e6 ? `${Math.ceil(n / 1e3)} KB` : `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`);

async function saveSnapshot() {
  const r = run;
  if (!r || saving || switching || !(state === 'running' || state === 'booting')) return;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const suggestedName = `${machine}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${SNAPSHOT_SUFFIX}`;
  // The picker first, as Save disk does: it needs the click's user activation. The machine isn't stopped, so nothing is asked.
  let handle: FileSystemFileHandle | undefined;
  const picker = (window as unknown as { showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (picker) {
    try {
      handle = await picker.call(window, { suggestedName, types: [{ description: 'webpc snapshot', accept: { 'application/octet-stream': [SNAPSHOT_SUFFIX] } }] });
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return; // cancelled
      handle = undefined; // the download below
    }
  }
  if (run !== r || saving || switching || !(state === 'running' || state === 'booting')) return; // the machine moved on while the picker was open
  saving = true;
  syncButtons();
  const parts: Blob[] = [];
  try {
    const result = await new Promise<{ bytes: number; pausedMs: number }>((resolve, reject) => {
      snapshotJob = {
        progress: (phase, f) => { stateEl.textContent = f > 0 && f < 1 ? `${phase} ${Math.floor(100 * f)}%` : phase; },
        chunk: (data) => { parts.push(new Blob([data as Uint8Array<ArrayBuffer>])); },
        done: (bytes, pausedMs) => resolve({ bytes, pausedMs }),
        error: (message) => reject(new Error(message)),
      };
      r.worker.postMessage({ type: 'snapshot', handle } satisfies ToWorker);
    });
    if (!handle) {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob(parts)), download: suggestedName });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    }
    parts.length = 0;
    $('message').dataset.snapshot = JSON.stringify(result); // for tools: the file's bytes and the pause's ms
    if (run === r && (state === 'running' || state === 'booting')) {
      setState(state, `Saved the snapshot ${handle?.name ?? suggestedName} (${mb(result.bytes)}); the machine was paused for ${(result.pausedMs / 1000).toFixed(1)} s and runs on.`, [], 'warn');
    }
  } catch (e) {
    if (run === r) setState(state, `${String((e as Error).message ?? e)}\nThe machine runs on; no file was saved.`, [], 'error');
  } finally {
    saving = false;
    snapshotJob = undefined;
    syncButtons();
  }
}
saveSnapshotBtn.onclick = () => void saveSnapshot();

// Suspend (docs/frontend.md "Suspend"): the machine stops with its memory kept beside its disk in this
// browser; the next start (this page opened again, Start) resumes it. Nothing is asked: nothing is lost.
suspendBtn.hidden = !spec.overlay;
suspendBtn.onclick = () => {
  const r = run;
  if (!r || saving || switching || !(state === 'running' || state === 'booting')) return;
  saving = true;
  syncButtons();
  snapshotJob = {
    progress: (phase, f) => { stateEl.textContent = f > 0 && f < 1 ? `${phase} ${Math.floor(100 * f)}%` : phase; },
    chunk: () => {},
    done: () => {},
    // It runs on; the `suspended` state ends a suspend that worked (the worker's handler above).
    error: (message) => {
      saving = false;
      snapshotJob = undefined;
      if (run === r) setState(state, `${message}\nThe machine runs on.`, [], 'error');
      syncButtons();
    },
  };
  r.worker.postMessage({ type: 'suspend' } satisfies ToWorker);
};

/** Whether `file` starts with the snapshot signature (`WEBPCSNP`): how a chosen or dropped file is told from a disk image. */
const isSnapshot = async (file: File) => new TextDecoder().decode(await file.slice(0, 8).arrayBuffer()) === 'WEBPCSNP';

/** What a snapshot's disk is called, for messages. */
const snapshotDisk = (name: string | null | undefined) => (name ? `the disk ${name}` : `${spec.label}'s own disk`);

/**
 * Loads a snapshot: the header is read here (no codec needed) to say what the file is and to refuse
 * at once what can't work (not a snapshot, another machine, another disk by name); then, after the
 * user confirms, the machine stops and a new one starts from the file. The worker checks the rest
 * before it touches anything (web/snapshot.ts `readSnapshot`).
 */
async function loadSnapshot(file: File) {
  if (busy()) return;
  let header: SnapshotHeader;
  try {
    header = (await openSnapshot(file)).header;
  } catch (e) {
    if (e instanceof SnapshotError) return void alert(`${file.name}: ${e.message}`);
    throw e;
  }
  const label = typeof header.label === 'string' ? header.label : String(header.machine);
  if (header.machine !== machine) {
    return void alert(`${file.name} is a snapshot of ${label} (?machine=${String(header.machine)}), and this page runs ${spec.label} (?machine=${machine}). Open the page for that machine to load it.`);
  }
  const taken = typeof header.disk === 'string' ? header.disk : null;
  const open = chosen ? diskName()! : null;
  if (taken !== open) {
    return void alert(`${file.name} was taken on ${snapshotDisk(taken)}, and the disk open now is ${snapshotDisk(open)}. A snapshot continues only on the disk it was taken on: ${taken ? 'open that disk first (Open disk…), then load the snapshot' : 'reload the page (it starts with the machine\'s own disk), then load the snapshot'}.`);
  }
  const overlay = overlayName();
  const written = overlay ? await overlayBytes(overlay).catch(() => 0) : 0;
  const when = new Date(header.created);
  const running = state === 'running' || state === 'booting';
  if (!confirm(`Load the snapshot ${file.name}? It holds ${label}${Number.isNaN(when.getTime()) ? '' : ` as it was on ${when.toLocaleString()}`} (${mb(file.size)}${typeof header.ncpus === 'number' ? `, ${header.ncpus} vCPU${header.ncpus > 1 ? 's' : ''}` : ''}). ${running ? 'This machine stops, like pulling the plug, and the' : 'The'} snapshot's machine takes its place, running where it was saved. Everything ${chosen ? `the disk ${diskName()}` : `${spec.label}'s disk`} has written${written ? ` (${mb(written)})` : ''} is replaced by the snapshot's changes to the disk.`)) return;
  await exclusively(async () => {
    await stop();
    term.reset();
    start(file);
  });
}
$<HTMLButtonElement>('load-snapshot').onclick = () => loadSnapshotInput.click();
loadSnapshotInput.onchange = () => {
  const file = loadSnapshotInput.files?.[0];
  loadSnapshotInput.value = '';
  if (file) void loadSnapshot(file);
};

$<HTMLButtonElement>('open-disk').onclick = () => openDiskInput.click();
openDiskInput.onchange = () => {
  const file = openDiskInput.files?.[0];
  openDiskInput.value = '';
  if (file) void chooseDisk({ file });
};
document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  e.preventDefault();
  void chooseDisk({ file });
});

$<HTMLButtonElement>('boot-serial-show').onclick = () => { setView(document.body.dataset.view === 'screen' ? 'both' : (document.body.dataset.view as View), false); term.focus(); };

// Keys typed into the terminal go to the PL011 (xterm.js sends what a terminal would: \r for Enter, escape sequences).
let replaying = false;
term.onData((d) => { if (!replaying) run?.serial.postMessage(d); });

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

// The network (docs/frontend.md "Network"): a machine with `network` always has a card (it costs no boot time); the
// Network menu connects and logs in a Tailscale client that gives the card its address.
const netSettings = (): NetworkSettings => ({ ...DEFAULT_SETTINGS, ...settings().net });
const network = createNetwork(() => renderNetwork());
const netMenu = $<HTMLDetailsElement>('network');
const netEl = { status: $('net-status'), login: $<HTMLAnchorElement>('net-login'), form: $<HTMLFormElement>('net-form'), control: $<HTMLInputElement>('net-control'), hostname: $<HTMLInputElement>('net-hostname'), key: $<HTMLInputElement>('net-authkey'), exitLabel: $('net-exit-label'), exit: $<HTMLSelectElement>('net-exit'), error: $('net-error'), hint: $('net-hint'), actions: $('net-actions'), disconnect: $('net-disconnect'), logout: $('net-logout') };
let lastPhase = '';

function renderNetwork() {
  const s = netSettings();
  const v = network.view();
  netMenu.dataset.phase = v.phase;
  const active = network.active();
  netEl.status.textContent = v.text;
  netEl.login.hidden = !v.loginURL;
  if (v.loginURL) netEl.login.href = v.loginURL;
  // The exit nodes the tailnet offers (unless the menu is being used: a redraw would close its list).
  netEl.exitLabel.hidden = v.exitNodes.length === 0;
  if (document.activeElement !== netEl.exit) {
    netEl.exit.replaceChildren(new Option('Nothing: directly', ''), ...v.exitNodes.map((e) => new Option(e.online ? e.name : `${e.name} (offline)`, e.id)));
    netEl.exit.value = v.exitNodes.find((e) => e.use)?.id ?? '';
  }
  netEl.form.hidden = active;
  netEl.actions.hidden = !active;
  netEl.disconnect.hidden = !active;
  netEl.logout.hidden = !active || s.keyed;
  netEl.hint.textContent = !active && s.keyed ? 'An auth key isn\'t kept: enter it again to connect.' : '';
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
  network.connect({ controlURL: url.url, hostname: 'hostname' in host ? host.hostname : 'webpc', exitNode: s.exitNode });
}

$<HTMLInputElement>('net-reveal').onchange = (e) => { netEl.key.type = (e.target as HTMLInputElement).checked ? 'text' : 'password'; };
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
    remember({ net: { ...netSettings(), controlURL: netEl.control.value.trim(), hostname: netEl.hostname.value.trim(), autoconnect: !authKey, keyed: !!authKey } });
    try {
      network.connect({ controlURL: url.url, hostname: host.hostname, authKey: authKey || undefined, exitNode: netSettings().exitNode });
      netEl.key.value = '';
    } catch (err) {
      formError(String((err as Error).message ?? err));
    }
    renderNetwork();
  })();
};
netEl.exit.onchange = () => {
  const id = netEl.exit.value;
  netEl.exit.blur();
  network.setExitNode(id).then(
    () => { remember({ net: { ...netSettings(), exitNode: id } }); formError(); },
    (err) => { formError(`Couldn't ${id ? 'use that exit node' : 'stop using the exit node'}: ${(err as Error).message ?? err}`); },
  ).finally(renderNetwork);
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
  statusEl.dataset.status = JSON.stringify(s); // for tools (bench/stress)
  statusEl.textContent = [
    `${s.ncpus} vCPU${s.ncpus > 1 ? 's' : ''}`, `${s.ramMiB} MiB`, `up ${hms(s.uptime)}`,
    mips === undefined ? '' : `${mips.toFixed(0)} MIPS`,
    `JIT ${s.jitBlocks.toLocaleString('en')} blocks compiled${s.jitFlushes ? ` (cache flushed ${s.jitFlushes}×)` : ''}, ${(s.jitCompileMs / 1000).toFixed(1)} s compiling`,
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
const diskParam = params.get('disk');
if (diskParam && spec.firmware) {
  const url = new URL(diskParam, location.href).href;
  chosen = { url, overlay: await diskOverlay({ url }) };
  $('machine').textContent = `${spec.label} · ${diskName()}`;
}
boot();
