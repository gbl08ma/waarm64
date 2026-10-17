// The page (docs/frontend.md): the machine's screen on a canvas, its serial
// console on xterm.js, power state and a status line. The VM runs in
// web/app/worker.ts; this is DOM code only, talking to it through
// web/app/protocol.ts. `?machine=buildroot` picks the test guest, `?ncpus=N`
// the vCPU count, `?view=screen|terminal|both` the first view (the last one
// chosen is remembered), `?params=` extra kernel parameters (direct-boot machines), `?credential=name:value` a systemd
// credential over fw_cfg (firmware machines), `?disk2=<url>` a read-only second disk, `?disk=<url>` a root
// disk of your own (the header's "Open disk…" and a dropped file choose a local one), `?machine=snd` the sound
// test guest and `?snd=stats[,timer]` the sound's measurements (docs/frontend.md "Sound"), `?avprobe` the screen's
// flashes for A/V sync (bench/audio/avsync.ts).
import { Terminal } from '@xterm/xterm';
import type { DisplayToPage } from '../gpu-present.ts';
import type { FromGpuWorker, ToGpuWorker } from '../gpu-worker.ts';
import { attachInput, type Input } from '../input.ts';
import { PageAudio } from '../audio.ts';
import { opfsDir, overlayBytes, removeOverlay } from '../overlay.ts';
import { changesHeader as readChangesHeader } from '../qcow2.ts';
import { openSnapshot, SnapshotError, type SnapshotHeader } from '../snapshot-file.ts';
import { defaultCpus, diskOverlay, hostMemoryGiB, MACHINES, type DiskChoice, type Machine, type MachineName } from './machine.ts';
import { runExport, type ExportMode } from './export.ts';
import { runImport } from './import.ts';
import { createNetwork, DEFAULT_SETTINGS, forgetTailcatIdentity, hasTailcatIdentity, tailscaleBuilt, tailcatBuilt, parseControlURL, parseHostname, parseRelay, parseTailcatAddr, type NetworkSettings } from './network.ts';
import type { FromWorker, PowerState, Problem, StartDisk, Status, ToWorker } from './protocol.ts';
import { CPU_FEATURES, newId, serialOf, shapeDiff, type DiskRecord, type MachineRecord, type Shape } from './shape.ts';
import { currentShape, planRestore } from './snapshots.ts';
import type { DiskPlan, SnapshotDisk } from '../snapshot.ts';
import { diskDir, overlayDir, machineDir, snapshotPath, Store } from './store.ts';
import { deleteOverlay, diskSource, identityOf, loadChangesInto, refreshOverlay, refreshStored, switchOverlay } from './disks.ts';
import { askPersist, attach, createDisk, createMachine, machineLock, updateMachine } from './machines.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
// A machine kept in this browser (docs/plans/machines.md), by id: `?m=<id>`. It is the page's machine (`uefi`) with its own
// vCPUs, RAM, display and disks. Without one the machine is transient, made from the query (the tests' `?machine=`).
const store = await Store.open();
let storedError = '';
/** The machine last opened on this page (in this browser): opened again by a page without a query. */
const LAST = 'webpc.machine';
const lastMachine = () => { try { return localStorage.getItem(LAST) ?? undefined; } catch { return undefined; } };
const chosenId = params.get('m') ?? (location.search ? undefined : lastMachine());
let stored = chosenId ? await loadStored(chosenId).catch((e) => { if (params.get('m')) storedError = String((e as Error).message ?? e); return undefined; }) : undefined;
const machine = stored ? 'uefi' : (params.get('machine') ?? 'uefi') as MachineName;
if (!(machine in MACHINES)) throw new Error(`no machine ${machine}`);
const spec: Machine = MACHINES[machine];
// `?credential=name:value` (repeatable): a systemd credential for a firmware machine, for development and tests.
const credentials = params.getAll('credential').map((c) => ({ name: c.slice(0, c.indexOf(':')), data: c.slice(c.indexOf(':') + 1) }));

// The root disk: the machine's own, or the one the user chose (a file, or `?disk=<url>`). A chosen disk has its own overlay,
// so choosing the same file again finds its changes (docs/frontend.md "Your own disk").
let chosen: DiskChoice | undefined;
/** The OPFS overlay of the disk the machine boots. */
const overlayName = () => {
  const a = bootAttachment();
  return stored ? a && (a.overlay ? overlayDir(a.overlay) : NO_OVERLAY_YET) : chosen?.overlay ?? spec.overlay;
};
/** A stored machine's boot disk has no overlay before its first start (the start makes one): nothing written yet. */
const NO_OVERLAY_YET = 'overlays/none';
/**
 * A stored machine's boot disk: its first writable attachment that takes an overlay (the header's Save disk, Reset disk
 * and Load changes act on it; the modal has every disk's).
 */
function bootAttachment() {
  const s = stored;
  return s?.record.attachments.find((a) => !a.readOnly && !a.inPlace && s.disks.get(a.disk)?.kind !== 'ramdisk');
}
const bootDisk = () => { const a = bootAttachment(); return a && stored!.disks.get(a.disk); };
/** What the disk is called on the page. */
const diskName = () => (stored ? bootDisk()?.name : chosen ? (chosen.file?.name ?? new URL(chosen.url!, location.href).pathname.split('/').pop() ?? 'disk') : undefined);
/** The page's disk as a job reads it (Save disk, Load changes): its source, overlay and identity. */
async function pageDisk() {
  const d = bootDisk();
  if (d) {
    const picked = pickedFiles.get(d.id);
    return { source: picked ? { file: picked } : await diskSource(d), identity: identityOf(d), file: picked };
  }
  return { source: chosen?.file ? { file: chosen.file } : { url: chosen?.url ?? spec.disk! }, identity: undefined, file: chosen?.file };
}
/** A machine that boots the user's disk and has none yet (the page's own, until a disk is opened): it waits. */
const needsDisk = () => !!spec.firmware && !spec.disk && !chosen && !stored?.record.attachments.length;
/** What the header calls the machine: its name and the disk's. */
const machineTitle = () => (stored ? stored.record.name : `${spec.label} · ${diskName() ?? (needsDisk() ? 'no disk' : '')}`.replace(/ · $/, ''));

/** A stored machine and its disks' records; refused (an error the page shows) when one of them is missing. */
async function loadStored(id: string) {
  const record = await store.get('machines', id);
  if (!record) throw new Error(`there is no machine ${id} in this browser`);
  const disks = new Map<string, DiskRecord>();
  for (const a of record.attachments) {
    const d = await store.get('disks', a.disk);
    if (!d) throw new Error(`machine ${record.name} has a disk that isn't in this browser (${a.disk})`);
    disks.set(d.id, d);
  }
  return { record, disks };
}

/** Remembers `id` as the machine this page opens without a query. */
const rememberMachine = (id: string) => { try { localStorage.setItem(LAST, id); } catch { /* not remembered */ } };
if (stored) rememberMachine(stored.record.id);

/** Files picked in this session for file disks without a usable handle, by disk id. */
const pickedFiles = new Map<string, File>();
/** A file disk whose file the page can't read without the user: no handle (picked again), or a handle without permission (granted again by a click). */
class NeedsUser extends Error {
  readonly disks: DiskRecord[];
  constructor(disks: DiskRecord[]) {
    super(`${disks.map((d) => d.name).join(', ')} need${disks.length === 1 ? 's' : ''} your permission (or picking again) in this session`);
    this.disks = disks;
  }
}
/** The stored machine's file disks that need the user before it can start (machines.md §3.2). */
async function filesNeedingUser(s: { record: MachineRecord; disks: Map<string, DiskRecord> }) {
  const out: DiskRecord[] = [];
  for (const a of s.record.attachments) {
    const d = s.disks.get(a.disk)!;
    if (d.kind !== 'file' || pickedFiles.has(d.id)) continue;
    const h = d.handle as (FileSystemFileHandle & { queryPermission?(o: object): Promise<PermissionState> }) | undefined;
    if (!h || (h.queryPermission && (await h.queryPermission({ mode: 'read' })) !== 'granted')) out.push(d);
  }
  return out;
}
/** Asks for read permission on every file disk that needs it, from a click; files without a handle are picked again (by identity: name, size, date). */
async function grantFiles(disks: DiskRecord[]) {
  for (const d of disks) {
    const h = d.handle as (FileSystemFileHandle & { requestPermission?(o: object): Promise<PermissionState> }) | undefined;
    if (h?.requestPermission) {
      if ((await h.requestPermission({ mode: 'read' })) === 'granted') continue;
    }
    const file = await pickFile(`Pick ${d.name} again`);
    if (!file) return false;
    const want = d.identity as { name?: string; bytes?: number; modified?: number };
    if (file.name !== want.name || file.size !== want.bytes || file.lastModified !== want.modified) {
      if (!confirm(`${file.name} isn't the file this disk was made from (${want.name}, ${want.bytes} bytes, modified ${new Date(want.modified ?? 0).toLocaleString()}). Use it anyway? Its overlays were written over the other file's bytes and may not make sense over this one.`)) return false;
    }
    pickedFiles.set(d.id, file);
  }
  return true;
}
/** One file from the user (the hidden input), or undefined if they cancel. */
function pickFile(title: string) {
  return new Promise<File | undefined>((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', title });
    input.onchange = () => resolve(input.files?.[0]);
    input.oncancel = () => resolve(undefined);
    input.click();
  });
}

/**
 * Gives each writable attachment of the stored machine an overlay, if it has none yet (an empty one, "Changes"), and keeps
 * the machine's record. A ramdisk has none (its writes stay in memory).
 */
async function ensureOverlays(s: { record: MachineRecord; disks: Map<string, DiskRecord> }) {
  let changed = false;
  for (const a of s.record.attachments) {
    const d = s.disks.get(a.disk)!;
    if (a.readOnly || d.kind === 'ramdisk' || a.inPlace || a.overlay) continue;
    const now = Date.now();
    a.overlay = newId();
    await store.put('overlays', { id: a.overlay, name: 'Changes', disk: d.id, identity: d.identity, generation: 0, bytes: 0, created: now, modified: now });
    changed = true;
  }
  if (changed) await store.put('machines', s.record);
}

/**
 * The disks of the machine to start, in slot order, and the OPFS directory of its own files (the variable store, a
 * suspended copy). A transient machine's: its image or the chosen disk, its overlay as home, and `?disk2=` read-only.
 */
async function startDisks(): Promise<{ disks: StartDisk[]; home?: string }> {
  const s = stored;
  if (s) {
    await ensureOverlays(s);
    const disks = await Promise.all(s.record.attachments.map(async (a): Promise<StartDisk> => {
      const d = s.disks.get(a.disk)!;
      const base = { name: d.name, serial: serialOf(a.id), identity: identityOf(d) };
      // A stored disk written in place is its own overlay, over zeros (web/stored.ts).
      if (d.kind === 'stored' && a.inPlace && !a.readOnly) return { ...base, source: { blank: d.size }, overlay: diskDir(d.id) };
      const picked = pickedFiles.get(d.id);
      return { ...base, source: picked ? { file: picked } : await diskSource(d), overlay: a.readOnly || d.kind === 'ramdisk' || !a.overlay ? undefined : overlayDir(a.overlay) };
    }));
    return { disks, home: machineDir(s.record.id) };
  }
  const disks: StartDisk[] = [];
  const own: { url?: string; file?: File; overlay?: string } | undefined = chosen ?? (spec.disk ? { url: spec.disk, overlay: spec.overlay } : undefined);
  if (own) disks.push({ name: baseName(), source: own.file ? { file: own.file } : { url: own.url! }, overlay: own.overlay });
  const disk2 = params.get('disk2');
  if (disk2) disks.push({ name: new URL(disk2, location.href).pathname.split('/').pop() ?? 'disk2', source: { url: disk2 } });
  return { disks, home: own?.overlay };
}
/** After a stored machine ran: its overlays' and in-place disks' generations and sizes from their files into their records (§3.3). */
async function refreshRecords() {
  if (!stored) return;
  for (const a of stored.record.attachments) {
    if (a.inPlace) await refreshStored(store, a.disk).catch(() => {});
    else if (a.overlay) await refreshOverlay(store, a.overlay).catch(() => {});
  }
}
/** The page's CPU features (`?rng=0`, `?e0pd=0` turn one off: development). */
const cpuFeatures = () => CPU_FEATURES.filter((f) => params.get(f) !== '0');
/**
 * A stored machine as its snapshots describe it (protocol.ts `about`): its shape as it runs now (`three`: with 3D) and
 * its URL disks' URLs by slot.
 */
async function aboutMachine(three = want3d && !no3d) {
  const s = stored;
  if (!s) return undefined;
  const display = params.get('display') === 'simple' ? 'none' : three ? '3d' : '2d';
  const { shape, hash } = await currentShape(s.record, (id) => s.disks.get(id), { display, cpu: cpuFeatures() });
  const urls: Record<number, string> = {};
  for (const d of shape.disks) {
    const a = s.record.attachments.find((x) => serialOf(x.id) === d.serial)!;
    const rec = s.disks.get(a.disk)!;
    if (rec.kind === 'url') urls[d.slot] = rec.url!;
  }
  return { name: s.record.name, shape, shapeHash: hash, urls };
}
/** The ramdisks' size, MiB: host memory the machine may take beside its RAM. */
const ramdiskMiB = () => {
  const s = stored;
  return s ? s.record.attachments.reduce((n, a) => n + (s.disks.get(a.disk)!.kind === 'ramdisk' ? s.disks.get(a.disk)!.size / 2 ** 20 : 0), 0) : 0;
};

// Settings remembered per browser (the view, the network, whether saved disks are compressed, the sound's volume). Storage can be off or throw: then nothing is remembered.
type Settings = { ncpus?: number; ramMiB?: number; view?: View; net?: NetworkSettings; compress?: boolean; screen?: string; hidpi?: boolean; gpu?: '3d' | '2d'; muted?: boolean; volume?: number; mic?: boolean; micRaw?: boolean };
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

// The machine's size (the Machine menu): the query's, else the one chosen last in this browser, else the defaults.
const CPU_CHOICES = [1, 2, 3, 4, 6, 8];
const RAM_CHOICES = [512, 1024, 1536, 2048, 2560];
let ncpus = Number(params.get('ncpus')) || stored?.record.ncpus || (CPU_CHOICES.includes(settings().ncpus!) ? settings().ncpus! : 0) || defaultCpus(navigator.hardwareConcurrency || 4);
let ramMiB = Number(params.get('ram')) || stored?.record.ramMiB || (RAM_CHOICES.includes(settings().ramMiB!) ? settings().ramMiB! : 0) || spec.ramMiB;

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

// The screen's size: the machine's to begin with, then what a virtio-gpu scanout says (`mode` on the display port).
const fb = { ...spec.framebuffer };
/** The canvas at an integer multiple of the guest's screen in device pixels when that fits (crisp), scaled down to fit (smooth) otherwise. */
function fit() {
  if (!screenBox.clientWidth) return; // hidden
  const dpr = devicePixelRatio;
  const box = screenBox.getBoundingClientRect();
  const fits = Math.min((box.width * dpr) / fb.width, (box.height * dpr) / fb.height);
  let scale = fits >= 1 ? Math.floor(fits) : fits;
  // A guest in CSS pixels on a screen of fractional density: one guest pixel is one CSS pixel (a little soft), not a device pixel (a smaller screen).
  if (!settings().hidpi && !Number.isInteger(dpr) && fits >= dpr && scale < dpr) scale = dpr;
  canvas.style.width = `${(fb.width * scale) / dpr}px`;
  canvas.style.height = `${(fb.height * scale) / dpr}px`;
  canvas.style.imageRendering = Number.isInteger(scale) ? 'pixelated' : 'auto';
  canvas.dataset.scale = String(Math.round(scale * 1000) / 1000);
  showCursor();
}

// The guest's cursor (virtio-gpu's cursor queue) is the canvas's CSS cursor: the tablet is absolute, so the host's pointer is the
// guest's and moves at the host's rate. Drawn at the canvas's scale (a guest pixel is `scale` device pixels), crisp when the scale is
// whole; Chromium takes cursor images up to 128×128 device pixels, so a bigger one is capped. `none` is the guest hiding it.
type GuestCursor = { image: ArrayBuffer | null | undefined; hotX: number; hotY: number };
let guestCursor: GuestCursor | undefined;
let cursorUrls: string[] = [];
let cursorToken = 0;
function showCursor() {
  const token = ++cursorToken;
  const c = guestCursor;
  if (!c || c.image === undefined) { canvas.style.cursor = ''; return; }
  if (c.image === null) { canvas.style.cursor = 'none'; return; }
  const scale = Number(canvas.dataset.scale) || 1;
  const draw = new OffscreenCanvas(64, 64);
  draw.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(c.image.slice(0)), 64, 64), 0, 0);
  const render = (size: number, keep = size) => {
    const k = size / 64;
    const out = new OffscreenCanvas(keep, keep);
    const ctx = out.getContext('2d')!;
    ctx.imageSmoothingEnabled = !Number.isInteger(k);
    ctx.drawImage(draw, 0, 0, size, size);
    return out.convertToBlob().then((blob) => {
      const hot = (n: number) => Math.min(keep - 1, Math.round(n * k));
      return { url: URL.createObjectURL(blob), at: `${hot(c.hotX)} ${hot(c.hotY)}` };
    });
  };
  // Chromium drops a cursor over 32×32 CSS pixels for the next one in the list when its image would reach past the page's edge (so
  // a page can't draw over the browser's UI): the guest's cursor then vanished in the last 64 pixels, so the same cursor cut to its top-left 32 pixels follows it (a cursor's drawing is in the corner by its hotspot).
  const size = Math.min(128, Math.max(1, Math.round(64 * scale)));
  const small = Math.floor(32 * devicePixelRatio);
  Promise.all([render(size), size > small ? render(size, small) : undefined]).then(([big, little]) => {
    const urls = [big.url, little?.url];
    if (token !== cursorToken) { for (const u of urls) if (u) URL.revokeObjectURL(u); return; }
    for (const u of cursorUrls) URL.revokeObjectURL(u);
    cursorUrls = urls.filter((u) => u !== undefined);
    const one = (r: { url: string; at: string }) => `-webkit-image-set(url(${r.url}) ${devicePixelRatio}x) ${r.at}`;
    canvas.style.cursor = [one(big), little && one(little), 'none'].filter(Boolean).join(', ');
  }, () => {});
}
new ResizeObserver(() => { fit(); scheduleSize(); }).observe(screenBox);
matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { fit(); scheduleSize(); }); // moved to a screen with another density

// The size the guest is asked for (virtio-gpu machines): the screen's box in CSS pixels (device pixels with HiDPI on) or a fixed size,
// width down to a multiple of 8 (the guest's CVT modes are, and a sliver would show), at least 640×480, at most what the EDID can say.
const SIZE_MIN = { width: 640, height: 480 };
const SIZE_MAX = 4088; // 4095 down to a multiple of 8
const SIZE_DEBOUNCE_MS = 300;
const hasGpu = spec.display === 'gpu' && params.get('display') !== 'simple';
let sent: { width: number; height: number } | undefined;
function wantedSize(): { width: number; height: number } {
  const fixed = /^(\d+)x(\d+)$/.exec(settings().screen ?? '');
  if (fixed) return { width: Number(fixed[1]), height: Number(fixed[2]) };
  if (!screenBox.clientWidth) return sent ?? spec.framebuffer; // hidden: no box to measure
  const k = settings().hidpi ? devicePixelRatio : 1;
  const box = screenBox.getBoundingClientRect();
  const clamp = (n: number, lo: number) => Math.min(SIZE_MAX, Math.max(lo, n));
  return { width: clamp(Math.floor((box.width * k) / 8) * 8, SIZE_MIN.width), height: clamp(Math.floor(box.height * k), SIZE_MIN.height) };
}
let sizeTimer: ReturnType<typeof setTimeout> | undefined;
/** Tell the guest the screen's size once it has settled (a window drag sends a stream of sizes); `now` also when it is the one already sent (a restored machine has its own). */
function scheduleSize(now = false) {
  if (!hasGpu) return;
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(() => {
    const w = wantedSize();
    if (!run || (!now && sent && sent.width === w.width && sent.height === w.height)) return;
    sent = w;
    run.display.postMessage({ type: 'size', ...w });
  }, now ? 0 : SIZE_DEBOUNCE_MS);
}
const sizeSelect = $<HTMLSelectElement>('screen-size');
const hidpiBox = $<HTMLInputElement>('screen-hidpi');
if (hasGpu) $('screen-menu').hidden = false;
sizeSelect.value = [...sizeSelect.options].some((o) => o.value === settings().screen) ? settings().screen! : 'fit';
hidpiBox.checked = settings().hidpi ?? false;
sizeSelect.onchange = () => { remember({ screen: sizeSelect.value }); scheduleSize(); };
hidpiBox.onchange = () => { remember({ hidpi: hidpiBox.checked }); fit(); scheduleSize(); };

// One machine at a time; a restart stops it and starts a new worker (fresh memory, fresh ports, a fresh canvas).
type Run = { worker: Worker; input: Input; serial: MessagePort; display: MessagePort; gpu?: Worker };

/**
 * Benchmarks' hooks (`?displaystats`, bench/gpu/sway-load.ts): the last status in `window.__status`, and
 * `window.__webpcProfile(on)` starting and stopping the guest PC sampler (the histogram lands in `window.__profile`),
 * `window.__webpcTimeline(on)` the vCPU timeline (in `window.__timeline`).
 */
const benchHooks = params.has('displaystats') || params.has('snd'); // ?snd= (sound measurements) wants the serial log and status too
if (benchHooks) (window as unknown as { __webpcProfile?: (on: boolean) => void }).__webpcProfile = (on) => run?.worker.postMessage({ type: 'profile', on } satisfies ToWorker);
if (benchHooks) (window as unknown as { __webpcTimeline?: (on: boolean) => void }).__webpcTimeline = (on) => run?.worker.postMessage({ type: 'timeline', on } satisfies ToWorker);
if (benchHooks) (window as unknown as { __serialLog?: () => string }).__serialLog = () => log;
/** `?avprobe`: when the screen's centre turned bright (ms on this page's clock), for bench/audio/avsync.ts. */
const flashed = (t: number) => ((window as unknown as { __flashes?: number[] }).__flashes ??= []).push(t - performance.timeOrigin);
/**
 * 3D: a machine with a virtio-gpu gets virgl, rendered by a GPU worker that owns the screen as WebGL2
 * (web/gpu-worker.ts; docs/frontend.md "A 3D machine"). The default since G3 (the kickoff's decision 3: once the page's
 * Debian and snapshot tests passed with it on); the Machine menu's Graphics turns it off (`2d`, kept in this browser),
 * and the query is over it: `?gpu=2d` (or `virgl-null`, G2's null renderer) off, `?gpu=virgl` on. Off where this
 * browser has no WebGL2 (`no3d` says why): the machine is 2D then.
 */
const gpuKnobs = (params.get('gpu') ?? '').split(',');
const gpuAsked = gpuKnobs.includes('2d') || gpuKnobs.includes('virgl-null') ? '2d' : gpuKnobs.includes('virgl') ? '3d' : undefined;
const wants3d = () => hasGpu && (gpuAsked ?? stored?.record.display ?? settings().gpu ?? '3d') === '3d';
let want3d = wants3d();
let no3d: string | undefined;
const hasWebgl2 = () => { try { return !!new OffscreenCanvas(1, 1).getContext('webgl2'); } catch { return false; } };
const webgl2 = hasWebgl2();
if (want3d && !webgl2) no3d = 'this browser has no WebGL2';
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
function start(snapshot?: File, resume = true, plan?: DiskPlan[]) {
  // The machine worker draws the screen (web/display.ts): a canvas hands its drawing over only once.
  const focused = document.activeElement === canvas;
  const size = hasGpu ? wantedSize() : spec.framebuffer;
  sent = hasGpu ? size : undefined;
  [fb.width, fb.height] = [size.width, size.height];
  const fresh = canvas.cloneNode() as HTMLCanvasElement;
  fresh.style.cursor = '';
  guestCursor = undefined;
  [fresh.width, fresh.height] = [fb.width, fb.height];
  canvas.replaceWith(fresh);
  canvas = fresh;
  if (focused) canvas.focus();
  fit();
  const screen = canvas.transferControlToOffscreen();
  const display = new MessageChannel();
  display.port1.onmessage = (e: MessageEvent<DisplayToPage>) => {
    if (run?.display !== display.port1) return;
    if (e.data.type === 'cursor') { guestCursor = e.data; showCursor(); return; }
    if ((e.data as { type: string }).type === 'draw-stats') ((window as unknown as { __drawStats?: unknown[] }).__drawStats ??= []).push(e.data);
    if (e.data.type === 'capture') ((window as unknown as { __virglCapture?: Uint8Array[] }).__virglCapture ??= []).push(e.data.record);
    if (e.data.type === 'flash') return flashed(e.data.t);
    if (e.data?.type !== 'mode' || !(e.data.width > 0 && e.data.height > 0)) return;
    [fb.width, fb.height] = [e.data.width, e.data.height];
    fit();
    // The firmware's graphics output is up: its screens are the boot (the card hides, as it does for a console on a simple framebuffer).
    bootCard.dataset.done = 'true';
    bootCard.hidden = true;
  };
  const worker = new Worker(new URL(`./worker.ts${location.search}`, import.meta.url), { type: 'module' });
  // A machine that can have a network card has one from the start (it can't be added later without a restart): its end of the IP port.
  const ip = spec.network ? network.port() : undefined;
  const [kbd, tablet, serial] = [new MessageChannel(), new MessageChannel(), new MessageChannel()];
  const sound = audio.attach();
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
      if (m.state === 'running') {
        bootCard.hidden = true;
        scheduleSize(true); // a restored machine starts at the size it was saved with
      }
      if (m.state === 'rebooting') void restart();
      if (m.state === 'off' || m.state === 'crashed' || m.state === 'suspended' || m.state === 'failed') {
        dropLock();
        void refreshRecords();
      }
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
      if (benchHooks) (window as unknown as { __status?: Status }).__status = m.status;
    } else if (m.type === 'profile') {
      (window as unknown as { __profile?: [string, number][] }).__profile = m.samples;
    } else if (m.type === 'timeline') {
      (window as unknown as { __timeline?: unknown }).__timeline = m.timeline;
    } else if (m.type === 'phase') {
      bootLine.textContent = m.text;
      bootProgress.removeAttribute('value');
      if (state === 'loading') stateEl.textContent = m.text;
    } else if (m.type === 'snapshot-progress') {
      snapshotJob?.progress(m.phase, m.fraction);
    } else if (m.type === 'snapshot-chunk') {
      snapshotJob?.chunk(m.data);
    } else if (m.type === 'snapshot-done') {
      snapshotJob?.done(m.bytes, m.pausedMs, m.pins);
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
  const begin = async (three?: { renderer: MessagePort; caps: Uint8Array }) => {
    if (run !== r) return;
    let disks: StartDisk[];
    let home: string | undefined;
    let about: Awaited<ReturnType<typeof aboutMachine>>;
    try {
      const needs = stored ? await filesNeedingUser(stored) : [];
      if (needs.length) throw new NeedsUser(needs);
      ({ disks, home } = await startDisks());
      about = await aboutMachine(!!three);
    } catch (e) {
      if (run !== r) return;
      if (e instanceof NeedsUser) {
        const needs = e.disks;
        setState('idle', `${e.message}: the browser lets a page read a file only after you say so.`, [{ label: needs.some((d) => d.handle) ? 'Allow and start' : 'Pick and start', run: () => void grantFiles(needs).then((ok) => { if (ok) void restart(); }) }], 'warn');
      } else setState('failed', `The machine's disks couldn't be opened: ${String((e as Error).message ?? e)}`, [retry]);
      return;
    }
    holdLock();
    if (run !== r) return;
    const s = three ? undefined : screen;
    if (hasGpu) document.body.dataset.graphics = three ? '3d' : '2d'; // for tests
    worker.postMessage({ type: 'start', machine, ncpus, ramMiB, disks, home, keyboard: kbd.port2, tablet: tablet.port2, serial: serial.port2, screen: s, display: display.port2, size: hasGpu ? size : undefined, simple: params.get('display') === 'simple' || undefined, displayStats: params.has('displaystats') || undefined, avProbe: params.has('avprobe') || undefined, cpu: { rng: params.get('rng') !== '0', e0pd: params.get('e0pd') !== '0' }, params: params.get('params') ?? undefined, credentials, ip, sound, snapshot, resume, about, plan, ...three } satisfies ToWorker, [kbd.port2, tablet.port2, serial.port2, display.port2, sound.port, ...(s ? [s] : []), ...(three ? [three.renderer] : []), ...(ip ? [ip] : [])]);
  };
  if (want3d && !no3d) {
    // The GPU worker gets the canvas and says what it backs; the machine starts with those caps.
    const gpu = new Worker(new URL('../gpu-worker.ts', import.meta.url), { type: 'module' });
    r.gpu = gpu;
    const channel = new MessageChannel();
    gpu.postMessage({ type: 'init', canvas: screen, port: channel.port1, stats: params.has('displaystats'), debug: gpuKnobs.includes('debug'), probe: params.has('avprobe'), video: !gpuKnobs.includes('novideo'), softwareVideo: gpuKnobs.includes('swvideo') } satisfies ToGpuWorker, [screen, channel.port1]);
    gpu.onmessage = (e: MessageEvent<FromGpuWorker>) => {
      if (run !== r) return;
      const m = e.data;
      if (m.type === 'ready') {
        console.info(`webpc: 3D on ${m.renderer}`);
        void begin({ renderer: channel.port2, caps: m.caps });
      } else if (m.type === 'failed') {
        // The canvas is the GPU worker's now: a fresh start, without 3D.
        no3d = m.reason;
        console.warn(`webpc: no 3D: ${m.reason}`);
        gpu.terminate();
        worker.terminate();
        r.input.detach();
        run = undefined;
        start(snapshot, resume, plan);
      } else if (m.type === 'lost') {
        setState('crashed', 'The browser lost the WebGL context the screen was drawn with.', ACTIONS.emulator);
      } else if (m.type === 'render-stats') ((window as unknown as { __renderStats?: unknown[] }).__renderStats ??= []).push(m);
      else if (m.type === 'flash') flashed(m.t);
    };
    gpu.onerror = (e) => {
      if (run !== r) return;
      setState('crashed', `The GPU worker failed: ${e.message}`, ACTIONS.emulator);
    };
  } else void begin();
  if (ip) autoconnect();
  renderNetwork();
}

/** While a stored machine runs on this page, its Web Lock is held (machines.ts `machineLock`): the modal, in any tab, sees it running. */
let releaseLock: (() => void) | undefined;
function holdLock() {
  if (!stored || releaseLock) return;
  const held = new Promise<void>((resolve) => { releaseLock = resolve; });
  void navigator.locks.request(machineLock(stored.record.id), () => held);
}
function dropLock() {
  releaseLock?.();
  releaseLock = undefined;
}

/** Stops the machine, if any: its worker releases the disk overlay first (or gets 3 s to). */
async function stop() {
  const r = run;
  run = undefined;
  if (!r) return;
  r.input.detach();
  audio.detach();
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 3000);
    r.worker.onmessage = (e: MessageEvent<FromWorker>) => { if (e.data.type === 'stopped') { clearTimeout(t); resolve(); } };
    r.worker.postMessage({ type: 'stop' } satisfies ToWorker);
  });
  r.worker.terminate();
  r.gpu?.terminate();
  dropLock();
  await refreshRecords();
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
const restart = (resume = true) => (needsDisk() ? Promise.resolve(waitForDisk()) : exclusively(async () => {
  await stop();
  term.reset();
  start(undefined, resume);
}));

restartBtn.onclick = () => {
  if ((state === 'running' || state === 'booting') && !confirm('Restart the machine? Like pulling the plug: unsaved work in the guest is lost.')) return;
  void restart();
};

/** The disk's actions (Save disk, Reset disk, Load changes, Suspend): only with a disk the page keeps changes to. */
function syncDiskButtons() {
  resetDiskBtn.hidden = $('save').hidden = $('load-changes').hidden = suspendBtn.hidden = !overlayName();
}
/** No disk yet: say how to bring one, and start nothing. */
function waitForDisk() {
  if (stored) return setState('idle', `${stored.record.name} has no disks yet: add one in Machines….`, [{ label: 'Machines…', run: () => void openMachines() }], 'warn');
  setState('idle', 'Open a disk image to start the machine: an arm64 Linux image that boots through UEFI, as qcow2, raw or an installer or live ISO (Open disk…, or drop the file on the page). What the machine writes to it is kept in this browser, per file.', [{ label: 'Open disk…', run: () => openDiskInput.click() }], 'warn');
}

// The disk reset (M8 decision 4): stop the machine (its overlay's files are locked while it runs), delete the overlay, start again.
async function resetDiskAsked() {
  const name = overlayName();
  if (!name || busy()) return;
  const written = await overlayBytes(name).catch(() => 0);
  const size = !written ? '' : written < 1e6 ? ` (${Math.ceil(written / 1e3)} KB)` : ` (${(written / 1e6).toFixed(0)} MB)`;
  if (!confirm(`Reset ${chosen || stored ? `the disk ${diskName()}` : `${spec.label}'s disk`}? Everything the machine wrote to it${size} is deleted: your files, installed packages and settings. It then boots from the image as published.`)) return;
  await exclusively(async () => {
    await stop();
    term.reset();
    setState('loading');
    stateEl.textContent = 'Resetting the disk';
    try {
      const a = bootAttachment();
      if (stored && a?.overlay) {
        await deleteOverlay(store, a.overlay); // its record, then its files: the next start makes an empty one
        stored.record = (await store.get('machines', stored.record.id)) ?? stored.record;
      } else if (!stored) await removeOverlay(name); // once the machine's device worker has closed it
    } catch (e) {
      setState('failed', `The disk couldn't be reset: ${String(e)}\nClose other tabs of this page (one of them may have the disk open), then try again.`, [resetDisk, retry]);
      return;
    }
    start();
  });
}
$('open-disk').hidden = !spec.firmware;
resetDiskBtn.onclick = () => void resetDiskAsked();

// Your own disk: a local file (raw or qcow2, by its magic), by the picker or dropped on the page. The machine restarts on it; the
// disk's changes are kept in the browser per file (name, size, modification time), so choosing it again continues where it left off.
const openDiskInput = $<HTMLInputElement>('open-disk-input');

/**
 * The machine for a disk file opened or dropped on the page (machines.md §2: "opening a disk the old way stays"): the
 * one that already attaches it (the same name, size and date), or a new one named after it. Its handle, when the
 * browser gave one, is kept; the file itself is used for this session either way.
 */
async function machineForFile(file: File, handle?: FileSystemFileHandle) {
  const same = (d: DiskRecord) => d.kind === 'file' && d.identity.kind === 'file' && d.identity.name === file.name && d.identity.bytes === file.size && d.identity.modified === file.lastModified;
  const known = (await store.all('disks')).find(same);
  let id = known && (await store.machinesWith(known.id))[0]?.id;
  if (!id) {
    const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    const qcow2 = head.length >= 32 && new DataView(head.buffer).getUint32(0) === 0x514649fb;
    const d = known ?? await createDisk(store, { kind: 'file', file, handle, size: qcow2 ? Number(new DataView(head.buffer).getBigUint64(24)) : file.size });
    const m = await createMachine(store, { name: file.name.replace(/\.(qcow2|img|raw|iso)$/i, ''), ncpus, ramMiB });
    await attach(store, m, d, { readOnly: /\.iso$/i.test(file.name) });
    id = m.id;
    pickedFiles.set(d.id, file);
  } else pickedFiles.set(known!.id, file);
  await switchMachine(id);
}

/**
 * Opens stored machine `id` on this page: the one running stops (after asking), and it starts. From a transient
 * machine's page (a test's `?machine=`) the page is reloaded as the machine's.
 */
async function switchMachine(id: string) {
  if (machine !== 'uefi' || params.has('machine')) return void (location.search = `?m=${id}`);
  if ((state === 'running' || state === 'booting') && stored?.record.id !== id && !confirm('Open the other machine? This one stops, like pulling the plug: unsaved work in the guest is lost.')) return;
  await exclusively(async () => {
    await stop();
    const next = await loadStored(id);
    stored = next;
    storedError = '';
    chosen = undefined;
    [ncpus, ramMiB] = [next.record.ncpus, next.record.ramMiB];
    want3d = wants3d();
    no3d = want3d && !webgl2 ? 'this browser has no WebGL2' : undefined;
    const q = new URLSearchParams(location.search);
    for (const k of ['m', 'disk', 'ncpus', 'ram']) q.delete(k);
    q.set('m', id);
    history.replaceState(null, '', `?${q}`);
    rememberMachine(id);
    $('machine').textContent = machineTitle();
    syncDiskButtons();
    syncMachineMenu();
    term.reset();
    if (needsDisk()) waitForDisk();
    else start();
  });
}
async function chooseDisk(choice: { file: File; handle?: FileSystemFileHandle } | { url: string }) {
  if ('file' in choice && (await isSnapshot(choice.file))) return loadSnapshot(choice.file); // a snapshot isn't a disk to boot: it replaces the machine
  if (busy()) return;
  if ('file' in choice && (await changesHeader(choice.file))) { // a changes file isn't a disk to boot: it goes onto the disk on the page
    if (!overlayName()) return void alert(`${choice.file.name} holds changes to a disk: open that disk first (Open disk…), then load them.`);
    await loadChanges(choice.file);
    return;
  }
  if (!spec.firmware) return; // only a machine that boots through UEFI takes a disk of its own (the test guests' kernels are their own)
  // The page's own machine: a file opened or dropped is a machine of its own, kept in this browser (machines.md §2).
  if ('file' in choice && machine === 'uefi' && !params.has('machine')) return machineForFile(choice.file, choice.handle);
  const next: DiskChoice = { ...choice, overlay: await diskOverlay(choice) };
  if ((state === 'running' || state === 'booting') && !confirm(`Boot ${next.file?.name ?? next.url}? The machine restarts, like pulling the plug: unsaved work in the guest is lost. Its changes to the current disk are kept.`)) return;
  chosen = next;
  $('machine').textContent = machineTitle();
  syncDiskButtons();
  await restart();
}
// Changes in (loop 6): a changes file (Save disk's "Changes only") replaces what the machine has written to the disk on the page,
// once the page's disk is checked to be the one it was made over (its hash). The machine stops while it's loaded.
const changesHeader = async (file: File) => readChangesHeader(new Uint8Array(await file.slice(0, 1 << 16).arrayBuffer()));
async function loadChanges(file: File) {
  const overlay = overlayName();
  if (!overlay || busy()) return;
  const info = await changesHeader(file);
  if (!info) return void alert(`${file.name} isn't a changes file (a qcow2 made by Save disk's "Changes only"). To boot a disk, use Open disk….`);
  if (!info.hash) return void alert(`${file.name} has a backing file (${info.backingName}) but wasn't made by this page's Save disk, so its base can't be checked: it can't be loaded.`);
  const written = await overlayBytes(overlay).catch(() => 0);
  const running = state === 'running' || state === 'booting';
  const into = stored ? `They go into a new overlay of ${diskName()}, which the machine switches to (the one it has now is kept).` : `They replace everything the machine has written to ${chosen ? diskName() : `${spec.label}'s disk`}${written ? ` (${(written / 1e6).toFixed(written < 1e7 ? 1 : 0)} MB)` : ''}, and the firmware's settings.`;
  if (!confirm(`Load the changes in ${file.name}? ${into} The machine ${running ? 'stops, like pulling the plug, and ' : ''}starts again afterwards.`)) return;
  await exclusively(async () => {
    await stop();
    term.reset();
    setState('off');
    stateEl.textContent = 'Loading the changes';
    try {
      const progress = (phase: string, f: number) => { stateEl.textContent = `${phase} ${Math.floor(100 * f)}%`; };
      const s = stored;
      const a = bootAttachment();
      if (s && a) {
        const o = await loadChangesInto(store, s.disks.get(a.disk)!, file, progress, (await pageDisk()).source);
        await switchOverlay(store, s.record, a.id, o.id);
      } else await runImport({ changes: file, disk: { source: (await pageDisk()).source, overlay }, label: baseName() }, progress);
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
const baseName = () => diskName() ?? (spec.disk ? new URL(spec.disk, location.href).pathname.split('/').pop() : undefined) ?? 'disk';
const saveCompress = $<HTMLInputElement>('save-compress');
saveCompress.checked = settings().compress ?? true;
saveCompress.onchange = () => remember({ compress: saveCompress.checked });
async function saveDisk(mode: ExportMode) {
  const overlay = overlayName();
  if (!overlay || busy()) return;
  const how = SAVES[mode];
  const stem = baseName().replace(/\.(qcow2|img|raw)$/i, '');
  // Never the running disk's own name: a save dialog empties the file it's given at once (Chromium creates or
  // truncates it before the page writes a byte), and accepting the suggestion beside the disk would destroy it.
  const named = `${stem}${how.suffix}`;
  const suggestedName = named.toLowerCase() === diskName()?.toLowerCase() ? `${stem}-saved${how.suffix}` : named;
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
  // A file chosen as the disk is read in place: if the dialog's file was that one, it's gone already (its File no longer
  // reads); say so and write nothing, before the machine is stopped.
  const ownFile = (await pageDisk()).file;
  if (handle && ownFile && !(await ownFile.slice(0, 1).arrayBuffer().then(() => true, () => false))) {
    setState(state, `${handle.name} was the disk this machine runs from: the save dialog emptied it, so nothing was saved. The machine can't read its disk any more. Save to a different file next time.`, [], 'error');
    return;
  }
  const running = state === 'running' || state === 'booting';
  if (running && !confirm('Stop the machine to save its disk? It is stopped like pulling the plug: unsaved work in the guest is lost (shut it down first with poweroff for a clean disk). It starts again afterwards.')) return;
  await exclusively(async () => {
    await stop();
    setState('off');
    stateEl.textContent = 'Saving the disk';
    const mb = (n: number) => (n / 1e6).toFixed(n < 1e7 ? 1 : 0);
    try {
      if (overlay === NO_OVERLAY_YET) throw new Error('the machine has written nothing to it yet');
      const { source, identity } = await pageDisk();
      const r = await runExport({ mode, compress: mode !== 'raw' && saveCompress.checked, disk: { source, overlay, identity }, baseName: baseName(), handle }, (phase, f) => {
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


// Snapshots (docs/frontend.md "Snapshots"): the running machine, RAM and disk changes and all, in a file, and back.
/** The save in progress: the worker's messages for it (the page's `worker.onmessage` forwards them). */
let snapshotJob: { progress(phase: string, fraction: number): void; chunk(data: Uint8Array): void; done(bytes: number, pausedMs: number, pins?: SnapshotDisk[]): void; error(message: string): void } | undefined;
const SNAPSHOT_SUFFIX = '.webpcsnap';
const mb = (n: number) => (n < 1e6 ? `${Math.ceil(n / 1e3)} KB` : `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`);

/**
 * Saves a snapshot of the running machine: to a file (the picker, or a download), or, for a stored machine by default,
 * kept in the browser under a name (docs/plans/machines.md §5.2). `whole`: a disk written in place goes into the file
 * whole (§4.4; a kept snapshot pins its generation instead).
 */
async function saveSnapshot(o: { toFile?: boolean; whole?: boolean } = {}) {
  const r = run;
  if (!r || saving || switching || !(state === 'running' || state === 'booting')) return;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const suggestedName = `${stored ? stored.record.name.replace(/[^\w.-]+/g, '-') : machine}-${stamp}${SNAPSHOT_SUFFIX}`;
  if (stored && !o.toFile) {
    const name = prompt('Keep the snapshot in this browser, named:', `${stored.record.name} ${d.toLocaleString()}`);
    if (name) await keepSnapshot(name.trim() || stamp);
    return;
  }
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
      r.worker.postMessage({ type: 'snapshot', handle, whole: o.whole } satisfies ToWorker);
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

/** Keeps a snapshot of the running stored machine in the browser (its file in OPFS first, then its record). */
async function keepSnapshot(name: string) {
  const r = run;
  const s = stored;
  if (!r || !s || saving || switching || !(state === 'running' || state === 'booting')) return;
  saving = true;
  syncButtons();
  const id = newId();
  try {
    const about = (await aboutMachine())!;
    await askPersist();
    const result = await store.writing(async () => {
      const done = await new Promise<{ bytes: number; pausedMs: number; pins: SnapshotDisk[] }>((resolve, reject) => {
        snapshotJob = {
          progress: (phase, f) => { stateEl.textContent = f > 0 && f < 1 ? `${phase} ${Math.floor(100 * f)}%` : phase; },
          chunk: () => {},
          done: (bytes, pausedMs, pins) => resolve({ bytes, pausedMs, pins: pins ?? [] }),
          error: (message) => reject(new Error(message)),
        };
        r.worker.postMessage({ type: 'snapshot', keep: snapshotPath(s.record.id, id) } satisfies ToWorker);
      });
      await store.put('snapshots', { id, machine: s.record.id, name, created: Date.now(), bytes: done.bytes, shape: about.shape, shapeHash: about.shapeHash, urls: about.urls, pins: done.pins.map((p) => ({ slot: p.slot, overlay: p.overlay, generation: p.generation, blocks: p.blocks, ram: p.ram })) });
      return done;
    });
    $('message').dataset.snapshot = JSON.stringify({ bytes: result.bytes, pausedMs: result.pausedMs, id });
    if (run === r && (state === 'running' || state === 'booting')) setState(state, `Kept the snapshot ${name} in this browser (${mb(result.bytes)}); the machine was paused for ${(result.pausedMs / 1000).toFixed(1)} s and runs on.`, [], 'warn');
  } catch (e) {
    if (run === r) setState(state, `${String((e as Error).message ?? e)}\nThe machine runs on; nothing was kept.`, [], 'error');
  } finally {
    saving = false;
    snapshotJob = undefined;
    syncButtons();
  }
}

// Suspend (docs/frontend.md "Suspend"): the machine stops with its memory kept beside its disk in this
// browser; the next start (this page opened again, Start) resumes it. Nothing is asked: nothing is lost.
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

/**
 * Restores a snapshot onto the stored machine (docs/plans/machines.md §5.2): refused when its shape isn't the machine's
 * (it says what differs); else each writable disk keeps its overlay where it is as the snapshot pinned it, and forks
 * (or, if the user says, is replaced) where it moved on. `key` identifies the snapshot for reusing an earlier fork.
 */
async function restoreSnapshot(file: File, header: SnapshotHeader, key: string, name: string) {
  const s = stored!;
  const now = await aboutMachine();
  if (header.shapeHash !== now!.shapeHash) {
    const why = header.shape ? shapeDiff(header.shape as Shape, now!.shape) : ['it was made by another version of this page'];
    return void alert(`${name} is a snapshot of a machine other than ${s.record.name} as it is now: ${why.join('; ')}.\nMachines… can make a machine like it.`);
  }
  let plan: Awaited<ReturnType<typeof planRestore>>;
  try {
    plan = await planRestore(store, s.record, s.disks, { name: name.replace(/\.webpcsnap$/, ''), key, pins: (header.disks ?? []) as SnapshotDisk[] }, now!.shape.display);
  } catch (e) {
    return void alert(`${name} can't be restored: ${String((e as Error).message ?? e)}`);
  }
  if (plan.refused) return void alert(`${name} can't be restored: ${plan.refused}`);
  const when = new Date(header.created);
  const running = state === 'running' || state === 'booting';
  const forks = plan.forks.map((f) => (f.reused ? `${f.disk}: its earlier fork of this snapshot, attached again` : `${f.disk}: changed since, so the snapshot's state goes into a new overlay, attached now (the one it has stays as it is)`));
  if (!confirm(`Restore ${name}${Number.isNaN(when.getTime()) ? '' : `, taken ${when.toLocaleString()}`}? ${running ? 'The machine stops, like pulling the plug, and' : 'The machine'} runs on from where the snapshot was taken.${plan.kept.length ? `\nAs the snapshot left them: ${plan.kept.join(', ')}.` : ''}${forks.length ? `\n${forks.join('\n')}` : ''}`)) return;
  const replaceable = plan.forks.filter((f) => !f.reused && f.replaceable);
  const replace = replaceable.length > 0 && !confirm(`Keep ${replaceable.map((f) => `${f.replaceable!.name} (${mb(f.replaceable!.bytes)})`).join(', ')} as ${replaceable.length > 1 ? 'they are' : 'it is'} and restore into a new overlay (OK)? Cancel replaces ${replaceable.length > 1 ? 'them' : 'it'} instead: what the machine wrote since the snapshot is lost.`);
  await exclusively(async () => {
    await stop();
    let disks: DiskPlan[];
    try {
      disks = await plan.commit(replace);
    } catch (e) {
      setState('failed', `${name} can't be restored: ${String((e as Error).message ?? e)}`, [retry]);
      return;
    }
    term.reset();
    start(file, true, disks);
  });
}

/** Restores the kept snapshot `id` of the stored machine. */
async function restoreKept(id: string) {
  const rec = await store.get('snapshots', id);
  if (!rec || !stored || rec.machine !== stored.record.id) return;
  const file = await (await opfsFile(snapshotPath(rec.machine, id))).getFile();
  const { header } = await openSnapshot(file);
  await restoreSnapshot(new File([file], `${rec.name}.webpcsnap`), header, id, rec.name);
}
/** The OPFS file at `path`. */
async function opfsFile(path: string) {
  const parts = path.split('/');
  const name = parts.pop()!;
  return (await opfsDir(parts.join('/'))).getFileHandle(name);
}

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
  if (stored) return restoreSnapshot(file, header, `file:${String(header.created)}`, file.name);
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
  // The item's handle (Chromium), so the machine made for it can read it in later sessions too (machines.md §3.2).
  const item = e.dataTransfer?.items[0] as (DataTransferItem & { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> }) | undefined;
  const handle = item?.getAsFileSystemHandle?.().catch(() => null);
  void (async () => {
    const h = await handle;
    void chooseDisk({ file, handle: h?.kind === 'file' ? h as FileSystemFileHandle : undefined });
  })();
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

// The network (docs/frontend.md "Network"): a machine with `network` always has a card (it costs no boot time). The
// Network wizard (a dialog) picks a tailnet or tailcat and takes its settings; the Network menu shows the connection
// and what can be done with it (the exit node, the machine's tailcat address, Disconnect, Log out, Change…).
const netSettings = (): NetworkSettings => ({ ...DEFAULT_SETTINGS, ...settings().net });
const network = createNetwork(() => renderNetwork());
const netMenu = $<HTMLDetailsElement>('network');
const wizard = $<HTMLDialogElement>('net-wizard');
const netEl = {
  status: $('net-status'), login: $<HTMLAnchorElement>('net-login'), exitLabel: $('net-exit-label'), exit: $<HTMLSelectElement>('net-exit'),
  served: $('net-served'), servedAddr: $<HTMLInputElement>('net-served-addr'), menuError: $('net-menu-error'), hint: $('net-hint'),
  setup: $<HTMLButtonElement>('net-setup'), disconnect: $('net-disconnect'), logout: $('net-logout'),
  form: $<HTMLFormElement>('net-form'), title: $('net-title'), error: $('net-error'), back: $('net-back'), connect: $<HTMLButtonElement>('net-connect'),
  steps: { kind: $('net-step-kind'), tailscale: $('net-step-tailnet'), tailcat: $('net-step-tailcat') },
  control: $<HTMLInputElement>('net-control'), hostname: $<HTMLInputElement>('net-hostname'), key: $<HTMLInputElement>('net-authkey'),
  tcExit: $<HTMLInputElement>('net-tc-exit'), tailcat: $<HTMLInputElement>('net-tailcat'), tcServe: $<HTMLInputElement>('net-tc-serve'),
  relay: $<HTMLInputElement>('net-tc-relay'), forget: $<HTMLButtonElement>('net-tc-forget'),
};
let lastPhase = '';
let step: 'kind' | 'tailscale' | 'tailcat' = 'kind';

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
  netEl.served.hidden = !v.served;
  if (v.served && netEl.servedAddr.value !== v.served) netEl.servedAddr.value = v.served;
  netEl.setup.textContent = active ? 'Change…' : 'Connect…';
  netEl.disconnect.hidden = !active;
  netEl.logout.hidden = !active || s.keyed || s.kind === 'tailcat';
  netEl.hint.textContent = !active && s.kind === 'tailscale' && s.keyed ? 'An auth key isn\'t kept: enter it again to connect.' : '';
  if (v.phase === 'login' && lastPhase !== 'login') netMenu.open = true; // the user has something to do
  lastPhase = v.phase;
}

function formError(message?: string) {
  netEl.error.textContent = message ?? '';
  netEl.error.hidden = !message;
}

function menuError(message?: string) {
  netEl.menuError.textContent = message ?? '';
  netEl.menuError.hidden = !message;
}

/** Shows a step of the wizard: the choice, or a kind's settings. */
function showStep(to: typeof step) {
  step = to;
  formError();
  for (const [k, el] of Object.entries(netEl.steps)) el.hidden = k !== to;
  netEl.back.hidden = to === 'kind';
  netEl.connect.hidden = to === 'kind';
  netEl.title.textContent = to === 'kind' ? 'Network' : to === 'tailscale' ? 'Network: a tailnet' : 'Network: tailcat';
  if (to === 'tailcat') renderTailcatStep();
  (to === 'kind' ? $(`net-pick-${netSettings().kind === 'tailcat' ? 'tailcat' : 'tailnet'}`) : to === 'tailscale' ? netEl.control : netEl.tcExit).focus();
}

function renderTailcatStep() {
  $('net-tc-exit-fields').hidden = !netEl.tcExit.checked;
  $('net-tc-serve-fields').hidden = !netEl.tcServe.checked;
  netEl.relay.disabled = netEl.tcExit.checked; // that computer's relay serves then
  void hasTailcatIdentity().then((kept) => { netEl.forget.disabled = !kept; });
}

/** Opens the wizard with the saved settings: at the choice, or at a kind's step. */
function openWizard(at: typeof step = 'kind') {
  const s = netSettings();
  netEl.control.value = s.controlURL;
  netEl.hostname.value = s.hostname;
  netEl.key.value = '';
  netEl.tcExit.checked = s.tailcatExit;
  netEl.tcServe.checked = s.tailcatServe;
  netEl.tailcat.value = '';
  netEl.relay.value = s.tailcatRelay;
  $<HTMLDetailsElement>('net-tc-advanced').open = !!s.tailcatRelay;
  netMenu.open = false;
  if (!wizard.open) wizard.showModal();
  showStep(at);
}

/** Starts the client for the settings the machine started under (a login's node is kept, so is a served machine's address). */
function autoconnect() {
  const s = netSettings();
  if (!s.autoconnect || network.active()) return;
  if (s.kind === 'tailcat') {
    // Only a machine that lets clients in without a server: the server's address isn't kept.
    if (s.tailcatServe && !s.tailcatExit) network.connect({ controlURL: '', hostname: '', tailcatServe: { relay: s.tailcatRelay } });
    return;
  }
  const url = parseControlURL(s.controlURL);
  if ('error' in url) return;
  const host = parseHostname(s.hostname);
  network.connect({ controlURL: url.url, hostname: 'hostname' in host ? host.hostname : 'webpc', exitNode: s.exitNode });
}

/** Connects with the wizard's settings, after the running client (if any) stops; then the menu shows how it goes. */
function connectWith(c: Parameters<typeof network.connect>[0]) {
  void (async () => {
    try {
      if (network.active()) await network.disconnect();
      network.connect(c);
      wizard.close();
      menuError();
      netMenu.open = true;
    } catch (err) {
      formError(String((err as Error).message ?? err));
    }
    renderNetwork();
  })();
}

$('net-pick-tailnet').onclick = () => { remember({ net: { ...netSettings(), kind: 'tailscale' } }); showStep('tailscale'); };
$('net-pick-tailcat').onclick = () => { remember({ net: { ...netSettings(), kind: 'tailcat' } }); showStep('tailcat'); };
netEl.back.onclick = () => showStep('kind');
$('net-cancel').onclick = () => wizard.close();
netEl.tcExit.onchange = renderTailcatStep;
netEl.tcServe.onchange = renderTailcatStep;
netEl.forget.onclick = () => {
  if (!confirm('Forget this machine\'s tailcat address? Whoever has it can\'t come in any more, and the machine gets a new one when it next lets clients in.')) return;
  void forgetTailcatIdentity().then(renderTailcatStep);
};
$<HTMLInputElement>('net-reveal').onchange = (e) => { netEl.key.type = (e.target as HTMLInputElement).checked ? 'text' : 'password'; };
netEl.setup.onclick = () => openWizard();
$('net-served-copy').onclick = () => { void navigator.clipboard.writeText(netEl.servedAddr.value).catch(() => { netEl.servedAddr.type = 'text'; netEl.servedAddr.select(); }); };
$('net-served-show').onclick = (e) => {
  const show = netEl.servedAddr.type === 'password';
  netEl.servedAddr.type = show ? 'text' : 'password';
  (e.target as HTMLButtonElement).textContent = show ? 'Hide' : 'Show';
};
netEl.form.onsubmit = (e) => {
  e.preventDefault();
  if (step === 'tailcat') {
    const exit = netEl.tcExit.checked;
    const serve = netEl.tcServe.checked;
    if (!exit && !serve) return formError('Choose at least one: going online through a computer of yours, or letting clients in.');
    const addr = exit ? parseTailcatAddr(netEl.tailcat.value) : { addr: '' };
    if ('error' in addr) return formError(addr.error);
    const relay = serve && !exit ? parseRelay(netEl.relay.value) : { relay: '' };
    if ('error' in relay) return formError(relay.error);
    formError();
    void (async () => {
      if (!(await tailcatBuilt())) return formError("The tailnet client isn't built on this server. Start the page with `npm run serve` or `npm start` (they build it), or run net/ts/build.sh.");
      // The server's address is a secret and isn't kept; a served machine's own address is, so it reconnects by itself.
      remember({ net: { ...netSettings(), kind: 'tailcat', tailcatExit: exit, tailcatServe: serve, tailcatRelay: netEl.relay.value.trim(), autoconnect: serve && !exit } });
      connectWith({ controlURL: '', hostname: '', tailcat: addr.addr || undefined, tailcatServe: serve ? { relay: exit ? '' : relay.relay } : undefined });
    })();
    return;
  }
  const url = parseControlURL(netEl.control.value);
  const host = parseHostname(netEl.hostname.value);
  if ('error' in url) return formError(url.error);
  if ('error' in host) return formError(host.error);
  formError();
  const authKey = netEl.key.value.trim();
  void (async () => {
    if (!(await tailscaleBuilt())) return formError("The Tailscale client isn't built on this server. Start the page with `npm run serve` or `npm start` (they build it), or run net/ts/build.sh.");
    remember({ net: { ...netSettings(), kind: 'tailscale', controlURL: netEl.control.value.trim(), hostname: netEl.hostname.value.trim(), autoconnect: !authKey, keyed: !!authKey } });
    netEl.key.value = '';
    connectWith({ controlURL: url.url, hostname: host.hostname, authKey: authKey || undefined, exitNode: netSettings().exitNode });
  })();
};
netEl.exit.onchange = () => {
  const id = netEl.exit.value;
  netEl.exit.blur();
  network.setExitNode(id).then(
    () => { remember({ net: { ...netSettings(), exitNode: id } }); menuError(); },
    (err) => { menuError(`Couldn't ${id ? 'use that exit node' : 'stop using the exit node'}: ${(err as Error).message ?? err}`); },
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
  // The share of those steps retired in JIT code (the rest were interpreted).
  const dSteps = last ? s.steps - last.status.steps : 0;
  const jitPct = last && dSteps > 0 ? ((s.jitSteps - last.status.jitSteps) / dSteps) * 100 : undefined;
  const irqs = last && dt > 0 ? (s.irqs - last.status.irqs) / dt : undefined;
  last = { status: s, at: now };
  statusEl.dataset.status = JSON.stringify(s); // for tools (bench/stress)
  statusEl.textContent = [
    `${s.ncpus} vCPU${s.ncpus > 1 ? 's' : ''}`, `${s.ramMiB} MiB`, `up ${hms(s.uptime)}`,
    mips === undefined ? '' : `${mips.toFixed(0)} MIPS`,
    jitPct === undefined ? '' : `${jitPct.toFixed(1)}% in JIT`,
    `JIT ${s.jitBlocks.toLocaleString('en')} blocks compiled${s.jitFlushes ? ` (cache flushed ${s.jitFlushes}×)` : ''}, ${(s.jitCompileMs / 1000).toFixed(1)} s compiling`,
    irqs === undefined ? '' : `${irqs.toFixed(0)} IRQ/s`,
  ].filter(Boolean).join(' · ');
}

$('machine').textContent = machineTitle();
syncDiskButtons();
// The view: the query's, else the one chosen last in this browser, else the screen (M8 decision 2).
const isView = (v: unknown): v is View => v === 'screen' || v === 'terminal' || v === 'both';
const asked = params.get('view');
setView(isView(asked) ? asked : isView(settings().view) ? settings().view! : 'screen', false);

// The Machine menu: vCPUs and RAM, applied by a restart (a power cut, like the other restarts).
const cpuSelect = $<HTMLSelectElement>('machine-cpus');
const ramSelect = $<HTMLSelectElement>('machine-ram');
const cpuChoices = [...new Set([...CPU_CHOICES, ncpus])].sort((a, b) => a - b);
const ramChoices = [...new Set([...RAM_CHOICES, ramMiB])].sort((a, b) => a - b);
cpuSelect.replaceChildren(...cpuChoices.map((n) => new Option(`${n} vCPU${n > 1 ? 's' : ''}`, String(n))));
ramSelect.replaceChildren(...ramChoices.map((n) => new Option(n >= 1024 && n % 512 === 0 ? `${n / 1024} GiB` : `${n} MiB`, String(n))));
/** The Machine menu shows what runs (a stored machine's own settings after a switch). */
function syncMachineMenu() {
  for (const [sel, n] of [[cpuSelect, ncpus], [ramSelect, ramMiB]] as const) {
    if (![...sel.options].some((o) => o.value === String(n))) sel.add(new Option(String(n), String(n)));
    sel.value = String(n);
  }
  gpuSelect.value = want3d ? '3d' : '2d';
}
cpuSelect.value = String(ncpus);
ramSelect.value = String(ramMiB);
// Graphics (virtio-gpu machines): 3D or 2D, the query's choice over it.
const gpuSelect = $<HTMLSelectElement>('machine-gpu');
$('machine-gpu-label').hidden = !hasGpu;
gpuSelect.value = want3d ? '3d' : '2d';
if (!webgl2) [gpuSelect.disabled, gpuSelect.title] = [true, 'This browser has no WebGL2: 2D only'];
else if (gpuAsked) [gpuSelect.disabled, gpuSelect.title] = [true, `Set by the page's address (?gpu=${params.get('gpu')})`];
$<HTMLButtonElement>('machine-apply').onclick = () => {
  const [n, r] = [Number(cpuSelect.value), Number(ramSelect.value)];
  const g = gpuSelect.value as '3d' | '2d';
  if (n === ncpus && r === ramMiB && g === (want3d ? '3d' : '2d')) return;
  const need = hostMemoryGiB(r, n);
  const has = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const low = has !== undefined && has < need ? `\n\nThis needs about ${need.toFixed(1)} GB of memory and this device reports ${has} GB: if it runs out, the browser closes the tab without warning.` : '';
  const running = state === 'running' || state === 'booting';
  if (!confirm(`Restart with ${n} vCPU${n > 1 ? 's' : ''}, ${r} MiB of RAM${hasGpu ? ` and ${g === '3d' ? '3D' : '2D'} graphics` : ''}?${running ? ' Like pulling the plug: unsaved work in the guest is lost.' : ''} A suspended machine is resumed as it was, with its own size.${low}`)) return;
  [ncpus, ramMiB] = [n, r];
  $<HTMLDetailsElement>('machine-menu').open = false;
  const s = stored;
  if (s) {
    // A stored machine's settings are its record's (its snapshots of the old shape are orphaned: they stay, marked).
    void exclusively(async () => {
      await stop();
      s.record = await updateMachine(store, { ...s.record, ncpus: n, ramMiB: r, display: hasGpu && !gpuAsked ? g : s.record.display });
      want3d = wants3d();
      no3d = want3d && !webgl2 ? 'this browser has no WebGL2' : undefined;
      term.reset();
      start();
    });
    return;
  }
  remember({ ncpus, ramMiB, ...(hasGpu && !gpuAsked ? { gpu: g } : {}) });
  want3d = wants3d();
  no3d = want3d && !webgl2 ? 'this browser has no WebGL2' : undefined;
  void restart();
};

// The Machines modal (docs/plans/machines.md §7; web/app/Machines.svelte, compiled when served): the machines kept in this
// browser, their disks, overlays and snapshots. Loaded when first opened.
const machinesDialog = $<HTMLDialogElement>('machines-dialog');
let modal: { close(): void } | undefined;
async function openMachines() {
  if (modal) return void machinesDialog.showModal();
  const [{ mount, unmount }, { default: Machines }] = await Promise.all([import('svelte'), import('./Machines.svelte')]);
  const close = () => {
    machinesDialog.close();
  };
  const component = mount(Machines, {
    target: machinesDialog,
    props: {
      store,
      current: stored?.record.id,
      open: (id: string) => { close(); void switchMachine(id); },
      powerOff: () => exclusively(async () => { await stop(); setState('off'); }),
      close,
      shapeNow: async (m: MachineRecord) => {
        const disks = new Map((await store.all('disks')).map((d) => [d.id, d]));
        const display = params.get('display') === 'simple' ? 'none' : m.display === '3d' && (!webgl2 || no3d || gpuAsked === '2d') ? '2d' : m.display;
        return currentShape(m, (id) => disks.get(id), { display, cpu: cpuFeatures() });
      },
      restore: (id: string) => { close(); void restoreKept(id); },
      apply: (file: File) => { close(); void loadSnapshot(file); },
      saveToFile: (whole: boolean) => { close(); void saveSnapshot({ toFile: true, whole }); },
    },
  });
  modal = { close: () => { void unmount(component); modal = undefined; } };
  machinesDialog.addEventListener('close', () => modal?.close(), { once: true });
  machinesDialog.showModal();
}
$<HTMLButtonElement>('machines-open').onclick = () => void openMachines();

// Sound (docs/frontend.md "Sound"): on by default; muted and the volume are kept in this browser. Any click or key on
// the page lets the browser play it (its autoplay rule): until one, the summary says sound is waiting.
const audio = new PageAudio();
const soundOn = $<HTMLInputElement>('sound-on');
const soundVolume = $<HTMLInputElement>('sound-volume');
const soundMenu = $<HTMLDetailsElement>('sound-menu');
soundOn.checked = !(settings().muted ?? false);
soundVolume.value = String(Math.round(100 * Math.min(1, Math.max(0, settings().volume ?? 1))));
const applySound = () => audio.setVolume(Number(soundVolume.value) / 100, !soundOn.checked);
applySound();
// The microphone (audio S4): asked for when the machine records, unless turned off; raw turns off the browser's processing.
const micOn = $<HTMLInputElement>('mic-on');
const micRaw = $<HTMLInputElement>('mic-raw');
micOn.checked = settings().mic ?? true;
micRaw.checked = settings().micRaw ?? false;
const applyMic = () => audio.setMic(micOn.checked, micRaw.checked);
applyMic();
micOn.onchange = micRaw.onchange = () => {
  applyMic();
  remember({ mic: micOn.checked, micRaw: micRaw.checked });
};
soundOn.onchange = soundVolume.oninput = () => {
  applySound();
  remember({ muted: !soundOn.checked, volume: Number(soundVolume.value) / 100 });
};
audio.onChange = () => {
  const waiting = audio.waiting();
  soundMenu.toggleAttribute('data-waiting', waiting);
  const mic = audio.micState;
  $('sound-summary').textContent = waiting ? 'Sound: click to hear' : `${soundOn.checked ? 'Sound' : 'Sound (muted)'}${mic === 'on' ? ' · mic' : ''}`;
  const hint = $('mic-hint');
  hint.hidden = mic !== 'denied' && mic !== 'asking';
  hint.textContent = mic === 'denied' ? 'The browser refused the microphone: the machine records silence. Allow it in the site\'s settings, then turn Microphone off and on.' : 'The machine is recording: the browser asks for the microphone.';
};
soundOn.addEventListener('change', () => audio.onChange());
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => audio.gesture(), { capture: true });
document.addEventListener('pointerdown', (e) => { if (!soundMenu.contains(e.target as Node)) soundMenu.open = false; });
if (params.has('snd')) (window as unknown as { __audio?: PageAudio }).__audio = audio; // tests and measurements (?snd=stats)
audio.onChange();

// Before starting: what the page can tell won't work.
function boot() {
  // SharedArrayBuffer (the guest's memory, shared by the vCPU workers) needs cross-origin isolation.
  if (!crossOriginIsolated) {
    setState('failed', "This page needs cross-origin isolation for the emulator's shared memory, and it wasn't served with it (the COOP and COEP headers).\nRun `npm start` in the repository and open the URL it prints: its server sends them.");
    restartBtn.hidden = resetDiskBtn.hidden = true;
    return;
  }
  if (storedError) return setState('failed', `This machine can't be opened: ${storedError}.`);
  if (needsDisk()) return waitForDisk();
  // Chromium kills a renderer that runs out of memory without an error to catch (PLAN.md §4): judge up front.
  const need = hostMemoryGiB(ramMiB + ramdiskMiB(), ncpus);
  const has = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (has !== undefined && has < need) {
    const fewer = Math.floor((has - hostMemoryGiB(ramMiB, 0)) / (hostMemoryGiB(0, 1) - hostMemoryGiB(0, 0)) + 1e-9);
    setState('idle', `This machine needs about ${need.toFixed(1)} GB of memory (${ramMiB} MiB of guest RAM plus the emulator, ${ncpus} vCPU${ncpus > 1 ? 's' : ''}), and this device reports ${has} GB.\nIf memory runs out, the browser closes the tab without warning. Close other tabs and apps first${fewer > 0 && fewer < ncpus ? `, or use fewer vCPUs (?ncpus=${fewer} fits)` : ''}.`, [{ label: 'Start anyway', run: () => void restart() }], 'warn');
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
  $('machine').textContent = machineTitle();
  syncDiskButtons();
}
boot();
