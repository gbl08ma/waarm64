// The page's controller (docs/frontend.md): it runs the machine, whose screen is a canvas and serial console xterm.js,
// and writes the page's state into `ui` (web/app/ui.svelte.ts), which the Svelte components (web/app/App.svelte) show;
// they act through `page`. The VM runs in web/app/worker.ts, talking to it through
// web/app/protocol.ts. `?machine=buildroot` picks the test guest, `?ncpus=N`
// the vCPU count, `?view=screen|terminal|both` the first view (the last one
// chosen is remembered), `?params=` extra kernel parameters (direct-boot machines), `?credential=name:value` a systemd
// credential over fw_cfg (firmware machines), `?keyboard=<id>` the guest's keyboard layout (web/app/keyboard.ts, `browser` the browser's; firmware machines), `?disk2=<url>` a read-only second disk, `?disk=<url>` a root
// disk of your own ("Open disk…" and a dropped file choose a local one), `?machine=snd` the sound
// test guest and `?snd=stats[,timer]` the sound's measurements (docs/frontend.md "Sound"), `?avprobe` the screen's
// flashes for A/V sync (bench/audio/avsync.ts).
import { Terminal } from '@xterm/xterm';
import { flushSync, mount } from 'svelte';
import App from './App.svelte';
import { ask } from './ask.svelte.ts';
import { leaveWarning, remember, settings } from './settings.ts';
import { page, ui, type Action, type MachinesTab, type PageState, type View } from './ui.svelte.ts';
import type { DisplayToPage } from '../gpu-present.ts';
import type { FromGpuWorker, ToGpuWorker } from '../gpu-worker.ts';
import { attachInput, type Input, type LockMode } from '../input.ts';
import { PageAudio } from '../audio.ts';
import { opfsDir, overlayBytes, removeOverlay } from '../overlay.ts';
import { changesHeader as readChangesHeader } from '../qcow2.ts';
import { openSnapshot, SnapshotError, type SnapshotHeader } from '../snapshot-file.ts';
import { ALIVE_EVERY_MS, clearAlive, lastCrash, markAlive, Signal } from './memory.ts';
import { defaultCpus, diskOverlay, hostMemoryGiB, JIT_DEFAULT_MIB, MACHINES, RAM_CHOICES, ramSplitError, type DiskChoice, type Machine, type MachineName } from './machine.ts';
import { fetchManifest, isManifestUrl } from '../chunked.ts';
import { runExport, type ExportMode } from './export.ts';
import { runImport } from './import.ts';
import { HeldError, PageNetwork } from './net-live.ts';
import { connectionLock, migrateLegacy, type Connection, type NewConnection } from './connections.ts';
import { forgetTailcatIdentity, hasTailcatIdentity, newTailcatIdentity } from '../tailcat.ts';
import { forgetProfile, keptProfiles } from '../tailscale-state.ts';
import type { FromWorker, Problem, StartDisk, Status, ToWorker } from './protocol.ts';
import { adaptersOf, CPU_FEATURES, DEFAULT_MAC, KEYBOARD_CONNECTOR, newId, serialOf, shapeDiff, USB_CONNECTORS, type DiskRecord, type MachineRecord, type Shape, type UsbEntry } from './shape.ts';
import { deviceName, entryOf, identityKey, identityOf as usbIdentity, newEntry, problemText, usbLock } from './usb-ports.ts';
import { browserApi, entryStates, filterFor, findDevices, granted, identityOfDevice, isGranted, requestDevices, ungranted, UsbError, UsbLocks, UsbPorts, type Api, type HostDevice } from './usb-live.ts';
import type { UsbIdentity, UsbVirtual } from '../usb-device.ts';
import { currentShape, planRestore } from './snapshots.ts';
import { hashFile } from './definitions.ts';
import type { DiskPlan, SnapshotDisk } from '../snapshot.ts';
import { diskDir, overlayDir, machineDir, snapshotPath, Store } from './store.ts';
import { deleteOverlay, diskSource, identityOf, loadChangesInto, refreshOverlay, refreshStored, switchOverlay } from './disks.ts';
import { bytesText } from './bytes.ts';
import { askPersist, attach, createDisk, createMachine, detachEverywhere, isRunning, knownDisk, machineLock, setAdapterConnection, updateMachine } from './machines.ts';
import { keyboardSetting, resolveKeyboard } from './keyboard.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
// The commit the page was built from (tools/serve.ts `buildStamp`), for reports of what a user ran.
const build = document.querySelector('meta[name="webpc-build"]')?.getAttribute('content');
if (build) console.info(`webpc: built from ${build}`);
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
 * A stored machine's boot disk: its first writable attachment that takes an overlay (a changes file dropped on the page,
 * and Suspend's "has a disk", go by it; the Machines page has every disk's).
 */
function bootAttachment() {
  const s = stored;
  return s?.record.attachments.find((a) => !a.readOnly && !a.inPlace && s.disks.get(a.disk)?.kind !== 'ramdisk');
}
const bootDisk = () => { const a = bootAttachment(); return a && stored!.disks.get(a.disk); };
/** What the disk is called on the page. */
const diskName = () => (stored ? bootDisk()?.name : chosen ? (chosen.file?.name ?? chosen.name ?? new URL(chosen.url!, location.href).pathname.split('/').pop() ?? 'disk') : undefined);
/** The page's disk as a job reads it (its Export, Import changes): its source, overlay and identity. */
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
/** What the toolbar calls the machine: its name, a chunked image's own (`?disk=` its manifest), or a transient one's and its disk's. */
const machineTitle = () => (stored ? stored.record.name : chosen?.name ?? `${spec.label} · ${diskName() ?? (needsDisk() ? 'no disk' : '')}`.replace(/ · $/, ''));

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
    // Another name, size or date: the same bytes by the hash, where the disk has one (a definition's: machines.md §6).
    const differs = file.name !== want.name || file.size !== want.bytes || file.lastModified !== want.modified;
    if (differs && d.sha256 && file.size === want.bytes && (await hashFile(file)) === d.sha256) {
      pickedFiles.set(d.id, file);
      continue;
    }
    if (differs) {
      if (!(await ask.confirm(`${file.name} isn't the file this disk was made from (${want.name}, ${want.bytes} bytes, modified ${new Date(want.modified ?? 0).toLocaleString()}). Use it anyway? Its overlays were written over the other file's bytes and may not make sense over this one.`, { title: 'Another file', ok: 'Use it anyway', danger: true }))) return false;
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
  if (own) disks.push({ name: baseName(), source: own.file ? { file: own.file } : { url: own.url! }, overlay: own.overlay, own: chosen ? undefined : true });
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
/** The page's CPU features (`?rng=0`, `?e0pd=0`, `?sha3=0` turn one off: development). */
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

// The machine's size (the Machine menu): the query's, else the one chosen last in this browser, else the defaults.
const CPU_CHOICES = [1, 2, 3, 4, 6, 8];
let ncpus = Number(params.get('ncpus')) || stored?.record.ncpus || (CPU_CHOICES.includes(settings().ncpus!) ? settings().ncpus! : 0) || defaultCpus(navigator.hardwareConcurrency || 4);
let ramMiB = Number(params.get('ram')) || stored?.record.ramMiB || (RAM_CHOICES.includes(settings().ramMiB!) ? settings().ramMiB! : 0) || spec.ramMiB;
/** The RAM's split as the user set it, MiB, memory 0 first (docs/spill-memories.md): `?split=3071,1024` (its sum is the RAM, over `?ram=`), else a stored machine's own. */
const splitParam = params.get('split')?.split(',').map(Number);
let ramSplit = splitParam && !ramSplitError(splitParam) ? splitParam : params.has('ram') ? undefined : stored?.record.ramSplit;
if (ramSplit) ramMiB = ramSplit.reduce((a, b) => a + b, 0);
/** The JIT's code cache budget, MiB (`BootOptions.jitBytes`; docs/jit.md "Memory"): `?jitmb=`, else a stored machine's own; 0: the default. */
const jitParam = () => Math.max(0, Math.round(Number(new URLSearchParams(location.search).get('jitmb')) || 0));
let jitMiB = jitParam() || (stored ? stored.record.jitMiB : settings().jitMiB) || 0;
/** The budget the machine runs with, MiB. */
const jitBudget = () => jitMiB || JIT_DEFAULT_MIB;

// The page's components (web/app/App.svelte), drawn now: the canvas and the terminal below are theirs. The network and the
// sound are made first (their menus show them).
const net = new PageNetwork({
  store,
  state: { forgetTailnet: forgetProfile, forgetTailcat: forgetTailcatIdentity },
  me: () => machineTitle(),
  onChange: () => { ui.net++; },
  save: async (i, id) => {
    const s = stored;
    if (!s) return remember({ transientNet: id });
    await setAdapterConnection(store, s.record.id, i, id);
    s.record = (await store.get('machines', s.record.id)) ?? s.record;
  },
});
await migrateNetwork().catch((e) => console.warn('the network settings could not be made into connections:', e));
void net.refresh();
const audio = new PageAudio();
ui.current = stored?.record.id;
ui.firmware = !!spec.firmware;
ui.hasNetwork = !!spec.network;
store.onChange(() => { ui.records++; void net.refresh(); });
mount(App, { target: document.body, props: { store, audio, net } });
flushSync();
let canvas = $<HTMLCanvasElement>('screen');
const screenBox = $('screen-view');
const lockCursor = $<HTMLCanvasElement>('screen-cursor');
const loadSnapshotInput = $<HTMLInputElement>('load-snapshot-input');

// The serial terminal. The PL011 has no size negotiation: the guest assumes 80×24 unless told (`stty`); the firmware's console is 80×25 (images/build.sh edk2 offers no other mode), so the terminal has 25 rows.
const term = new Terminal({ cols: 80, rows: 25, convertEol: false, scrollback: 5000, fontFamily: 'ui-monospace, "DejaVu Sans Mono", Menlo, monospace', fontSize: 14, theme: { background: '#0b0d10' } });
term.open($('terminal'));

// Views: the screen first (M8 decision 2), the terminal, or both.
const setView = (v: View, save = true) => {
  if (save) remember({ view: v });
  ui.view = v;
  document.body.dataset.view = v;
  if (ui.machinesOpen) closeMachines();
  fit();
  if (v !== 'screen') term.refresh(0, term.rows - 1);
  (v === 'terminal' ? term : canvas).focus();
};

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
type GuestCursor = { image: ArrayBuffer | null | undefined; hotX: number; hotY: number; x: number; y: number };
let guestCursor: GuestCursor | undefined;
let cursorUrls: string[] = [];
let cursorToken = 0;
function showCursor() {
  const token = ++cursorToken;
  const c = guestCursor;
  drawLockCursor();
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

// While the screen holds the mouse (docs/frontend.md "Mouse lock") the browser hides the pointer, the CSS cursor with
// it: the guest's cursor is drawn over the screen where the guest says it is (virtio-gpu's cursor position, the
// image's top-left corner, in guest pixels), as the CSS cursor is (`showCursor`): at the canvas's scale up to 128
// device pixels, the hotspot where the guest's pointer is, smoothed unless the scale is whole, clipped to the screen.
function drawLockCursor() {
  const c = guestCursor;
  if (c?.image) lockCursor.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(c.image.slice(0)), 64, 64), 0, 0);
  placeCursor();
}
function placeCursor() {
  const c = guestCursor;
  lockCursor.hidden = !ui.mouseLocked || !c?.image;
  if (lockCursor.hidden || !c) return;
  const k = canvas.clientWidth / fb.width; // CSS pixels per guest pixel
  const scale = Number(canvas.dataset.scale) || 1;
  const size = Math.min(128, Math.max(1, Math.round(64 * scale))) / devicePixelRatio; // CSS pixels, as showCursor's
  const hot = size / 64; // CSS pixels per cursor pixel
  lockCursor.style.width = lockCursor.style.height = `${size}px`;
  lockCursor.style.imageRendering = Number.isInteger(size * devicePixelRatio / 64) ? 'pixelated' : 'auto';
  // The guest's pointer (its hotspot) at the guest's place, the image around it at the cursor's own scale.
  lockCursor.style.transform = `translate(${((c.x | 0) + c.hotX) * k - c.hotX * hot}px, ${((c.y | 0) + c.hotY) * k - c.hotY * hot}px)`;
}
const setMouseLock = (on: boolean, mode: LockMode = ui.mouseLockMode) => {
  [ui.mouseLock, ui.mouseLockMode] = [on, mode];
  remember({ mouseLock: on, mouseLockMode: mode });
  run?.input.mouseLock(on, mode);
  if (on) canvas.focus();
};
ui.mouseLock = settings().mouseLock ?? false;
ui.mouseLockMode = settings().mouseLockMode === 'raw' ? 'raw' : 'pointer';

new ResizeObserver(() => { fit(); scheduleSize(); placeCursor(); }).observe(screenBox);
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
ui.hasGpu = hasGpu;

// One machine at a time; a restart stops it and starts a new worker (fresh memory, fresh ports, a fresh canvas).
type Run = { worker: Worker; input: Input; serial: MessagePort; display: MessagePort; gpu?: Worker; usb?: UsbPorts; usbStarted?: boolean };

/**
 * Benchmarks' hooks (`?displaystats`, bench/gpu/sway-load.ts): the last status in `window.__status`, and
 * `window.__webpcProfile(on)` starting and stopping the guest PC sampler (the histogram lands in `window.__profile`),
 * `window.__webpcTimeline(on)` the vCPU timeline (in `window.__timeline`), `window.__webpcHeap()` what the core's heap
 * touched (in `window.__heap`).
 */
const benchHooks = params.has('displaystats') || params.has('snd'); // ?snd= (sound measurements) wants the serial log and status too
if (benchHooks) (window as unknown as { __webpcProfile?: (on: boolean) => void }).__webpcProfile = (on) => run?.worker.postMessage({ type: 'profile', on } satisfies ToWorker);
if (benchHooks) (window as unknown as { __webpcTimeline?: (on: boolean) => void }).__webpcTimeline = (on) => run?.worker.postMessage({ type: 'timeline', on } satisfies ToWorker);
if (benchHooks) (window as unknown as { __serialLog?: () => string }).__serialLog = () => log;
if (benchHooks) (window as unknown as { __webpcHeap?: () => void }).__webpcHeap = () => run?.worker.postMessage({ type: 'heap' } satisfies ToWorker);
/** `?iostats`: `window.__ioStats()` resolves to the disks' timers and base-read traces (web/iostats.ts), by device (bench/remote-disk). */
if (params.has('iostats')) (window as unknown as { __ioStats?: () => Promise<unknown> }).__ioStats = () => new Promise((resolve) => {
  const ch = new BroadcastChannel('webpc-iostats');
  ch.onmessage = (e) => { ch.close(); resolve(e.data); };
  ch.postMessage('ask');
});
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
let state: PageState = 'loading';
let last: { status: Status; at: number } | undefined;
/** A stop and start in progress (`exclusively`), or a snapshot being written (`saveSnapshot`): the other actions wait. */
let switching = false;
let saving = false;
/** Which actions can be used now: none of the ones that stop the machine overlap a save or a switch. */
function syncButtons() {
  ui.busy = switching || saving;
}

// The serial console's output, kept for the log a user can copy or save (the terminal's scrollback is shorter).
const LOG_MAX = 1 << 20;
let log = '';
let lastLine = ''; // the boot card's line
const addLog = (text: string) => {
  log += text;
  if (log.length > 2 * LOG_MAX) log = log.slice(-LOG_MAX);
  if (!ui.boot.shown) return;
  const lines = (lastLine + text).split(/\r?\n/);
  lastLine = lines.pop()!;
  const shown = lines.reverse().find((l) => l.trim());
  if (shown !== undefined) ui.boot.line = shown.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
};

/** A standing note (another browser), shown while there's no message. */
let note = '';
/** A message that clears itself (`notify`), until then. */
let messageTimer: ReturnType<typeof setTimeout> | undefined;
const showMessage = (message: string, actions: Action[], kind: 'error' | 'warn') => {
  clearTimeout(messageTimer);
  ui.message = message;
  ui.messageKind = kind;
  ui.actions = actions;
};

function setState(s: PageState, message?: string, actions: Action[] = [], kind: 'error' | 'warn' = 'error') {
  state = s;
  ui.state = s;
  ui.stateText = { idle: 'Not started', loading: 'Loading', booting: 'Booting', running: 'Running', off: 'Powered off', suspended: 'Suspended', rebooting: 'Rebooting', crashed: 'Crashed', failed: "Couldn't start" }[s];
  document.body.dataset.state = s;
  showMessage(message ?? note, actions, message ? kind : 'warn');
  ui.boot.shown = (s === 'loading' || s === 'booting') && !ui.boot.done;
  ui.boot.serial = !!spec.firmware && s === 'booting';
  ui.usb.running = !!run?.usb && (s === 'running' || s === 'booting');
  syncButtons();
}
/** What happened, said while the machine stays as it is (a snapshot saved, or not): the message bar clears itself after 30 s. */
const NOTICE_MS = 30_000;
function notify(message: string, kind: 'error' | 'warn' = 'warn') {
  showMessage(message, [], kind);
  messageTimer = setTimeout(() => { if (ui.message === message) showMessage(note, [], 'warn'); }, NOTICE_MS);
}
/** The state's words for a while (a phase, a progress), until the next state. */
const stateText = (text: string) => { ui.stateText = text; };

// What a user can do about each problem (the worker's message says what happened and why).
const retry: Action = { label: 'Retry', run: () => void restart() };
const showLog: Action = { label: 'Show serial log', run: () => { setView(ui.view === 'screen' ? 'both' : ui.view, false); term.scrollToBottom(); } };
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
/** A disk that isn't the one its changes were made over: a stored machine's disks are on the Machines page (a new empty overlay); a transient machine's is reset. */
const resetDisk: Action = { get label() { return stored ? 'Disks…' : 'Reset disk…'; }, run: () => (stored ? openMachines('disks', stored.record.id) : void resetDiskAsked()) };
const startNormally: Action = { label: 'Start', run: () => void restart() };
const resumeAction: Action = { label: 'Start', run: () => void restart() };
const bootInstead: Action = { label: 'Boot instead', run: () => void ask.confirm('Boot the machine from its disk instead? Its suspended memory is dropped: what the guest had not written to its disk is lost, as after a power cut.', { ok: 'Boot', danger: true }).then((yes) => { if (yes) void restart(false); }) };
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
    if (e.data.type === 'cursor-at') { if (guestCursor) [guestCursor.x, guestCursor.y] = [e.data.x, e.data.y]; placeCursor(); return; }
    if ((e.data as { type: string }).type === 'draw-stats') {
      ((window as unknown as { __drawStats?: unknown[] }).__drawStats ??= []).push(e.data);
      ((window as unknown as { __devEvents?: number[] }).__devEvents ??= []).push(...((e.data as { busy: { events?: number[] } }).busy.events ?? []));
    }
    if (e.data.type === 'capture') ((window as unknown as { __virglCapture?: Uint8Array[] }).__virglCapture ??= []).push(e.data.record);
    if (e.data.type === 'flash') return flashed(e.data.t);
    if (e.data?.type !== 'mode' || !(e.data.width > 0 && e.data.height > 0)) return;
    [fb.width, fb.height] = [e.data.width, e.data.height];
    fit();
    // The firmware's graphics output is up: its screens are the boot (the card hides, as it does for a console on a simple framebuffer).
    ui.boot.done = true;
    ui.boot.shown = false;
  };
  const worker = new Worker(new URL(`./worker.ts${location.search}`, import.meta.url), { type: 'module' });
  // A machine's network adapters are there from the start (one can't be added later without a restart): their ends of
  // the IP ports, whose other ends the page's network has (web/app/net-live.ts: the clients of their connections).
  const nets = net.ports(netKey(), pageAdapters());
  ui.hasNetwork = nets.length > 0;
  const [kbd, tablet, serial] = [new MessageChannel(), new MessageChannel(), new MessageChannel()];
  const sound = audio.attach();
  // A machine with a USB controller: the port its devices are attached over (docs/usb.md "The page").
  const usb = usbOn() ? new MessageChannel() : undefined;
  // A relative mouse (the pointer while the screen holds the mouse) and a touchscreen, on machines that have them.
  const mouse = pointerOn('mouse') ? new MessageChannel() : undefined;
  const touch = pointerOn('touch') ? new MessageChannel() : undefined;
  const locked = (on: boolean) => { ui.mouseLocked = on; placeCursor(); };
  const input = attachInput(canvas, kbd.port1, tablet.port1, { live: () => keyboardLive, send: (d) => term.input(d, true), usb: keyboardKey }, { mouse: mouse?.port1, touch: touch?.port1, locked });
  input.mouseLock(ui.mouseLock, ui.mouseLockMode);
  ui.hasMouse = !!mouse;
  const r: Run = { worker, input, serial: serial.port1, display: display.port1, usb: usb && usbPorts(usb.port1) };
  run = r;
  keyboardLive = false;
  last = undefined;
  log = lastLine = '';
  ui.boot.done = false;
  ui.boot.line = '';
  ui.boot.progress = undefined; // indeterminate until the sizes are known
  ui.boot.title = snapshot ? `Loading ${snapshot.name}` : `Starting ${spec.label}`;
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
        ui.boot.title = `Booting ${spec.label}`;
        ui.boot.progress = undefined;
        ui.boot.line = 'Starting the kernel'; // then its lines, until its console takes the screen (~2 s on Debian)
      }
      if (m.state === 'running') {
        ui.boot.shown = false;
        scheduleSize(true); // a restored machine starts at the size it was saved with
      }
      if (m.state === 'rebooting') void restart();
      // Its devices go on once the machine runs: at a boot, a resume and a restore alike (a snapshot's ports are empty).
      if ((m.state === 'booting' || m.state === 'running') && r.usb && !r.usbStarted) { r.usbStarted = true; void attachAtStart(r); }
      if (m.state === 'off' || m.state === 'crashed' || m.state === 'suspended' || m.state === 'failed') {
        clearAlive(aliveKey());
        r.usb?.close();
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
      void syncKeyboard(r);
    } else if (m.type === 'notice') {
      notify(m.message, 'error');
    } else if (m.type === 'status') {
      showStatus(m.status);
      alive(m.status);
      if (benchHooks) (window as unknown as { __status?: Status }).__status = m.status;
    } else if (m.type === 'profile') {
      (window as unknown as { __profile?: [string, number][] }).__profile = m.samples;
    } else if (m.type === 'timeline') {
      (window as unknown as { __timeline?: unknown }).__timeline = m.timeline;
    } else if (m.type === 'heap') {
      (window as unknown as { __heap?: unknown }).__heap = m.heap;
    } else if (m.type === 'phase') {
      ui.boot.line = m.text;
      ui.boot.progress = undefined;
      if (state === 'loading') stateText(m.text);
    } else if (m.type === 'snapshot-progress') {
      snapshotJob?.progress(m.phase, m.fraction);
    } else if (m.type === 'snapshot-chunk') {
      snapshotJob?.chunk(m.data);
    } else if (m.type === 'snapshot-done') {
      snapshotJob?.done(m);
    } else if (m.type === 'snapshot-error') {
      snapshotJob?.error(m.message);
    } else if (m.type === 'progress') {
      if (m.total) ui.boot.progress = m.loaded / m.total;
      ui.boot.line = m.total ? `Downloading ${bytesText(m.loaded)} of ${bytesText(m.total)}` : `Downloading ${bytesText(m.loaded)}`;
      if (state === 'loading') stateText(m.total ? `Loading ${Math.floor((100 * m.loaded) / m.total)}%` : 'Loading');
    } else if (m.type === 'screen' && !spec.firmware) {
      // The guest's console has the screen: it shows the boot from here. (Through the firmware the
      // screen stays black until a getty: the boot's output, menus and a first boot's questions are on the serial console.)
      ui.boot.done = true;
      ui.boot.shown = false;
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
    worker.postMessage({ type: 'start', machine, ncpus, ramMiB, ramSplit, jitMiB: jitMiB || undefined, keyLayout: (await resolveKeyboard(keyboardSetting(params.get('keyboard'), stored?.record, params.has('machine'))))?.id, netConfig: (params.get('netconfig') ?? (stored?.record.netConfig === false ? '0' : '1')) !== '0', disks, home, keyboard: kbd.port2, tablet: tablet.port2, serial: serial.port2, screen: s, display: display.port2, size: hasGpu ? size : undefined, simple: params.get('display') === 'simple' || undefined, displayStats: params.has('displaystats') || undefined, ioStats: params.has('iostats') || undefined, noDiskCache: params.get('diskcache') === '0' || undefined, avProbe: params.has('avprobe') || undefined, cpu: { rng: params.get('rng') !== '0', e0pd: params.get('e0pd') !== '0', sha3: params.get('sha3') !== '0' }, params: params.get('params') ?? undefined, credentials, nets, usb: usb?.port2, mouse: mouse?.port2, touch: touch?.port2, sound, snapshot, resume, about, plan, ...three } satisfies ToWorker, [kbd.port2, tablet.port2, serial.port2, display.port2, sound.port, ...(s ? [s] : []), ...(three ? [three.renderer] : []), ...nets.map((n) => n.ip), ...(usb ? [usb.port2] : []), ...(mouse ? [mouse.port2] : []), ...(touch ? [touch.port2] : [])]);
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
      } else if (m.type === 'snapshotBytes') {
        bytesAsked.get(m.id)?.(m.bytes);
        bytesAsked.delete(m.id);
      } else if (m.type === 'render-stats') {
        ((window as unknown as { __renderStats?: unknown[] }).__renderStats ??= []).push(m);
        ((window as unknown as { __presents?: number[] }).__presents ??= []).push(...m.presentAt);
      }
      else if (m.type === 'flash') flashed(m.t);
    };
    gpu.onerror = (e) => {
      if (run !== r) return;
      setState('crashed', `The GPU worker failed: ${e.message}`, ACTIONS.emulator);
    };
  } else void begin();
  if (nets.length) void net.autoconnect();
  ui.net++;
}

/** While a stored machine runs on this page, its Web Lock is held (machines.ts `machineLock`): the Machines page, in any tab, sees it running. */
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
  clearAlive(aliveKey());
  r.input.detach();
  audio.detach();
  r.usb?.close();
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
/** True while a snapshot is being written (after saying so) or the machine is being switched: a disk's Export, Open disk and the like wait for it. */
function busy() {
  if (saving) void ask.alert('A snapshot is being saved. Try again once it is done.');
  return switching || saving;
}

/**
 * A stored machine's record and disks as the store has them now (the Machines page edits them while the machine is
 * off), and what follows from them: its size, its display, the toolbar's name. False, with the page saying why, when
 * the machine can't be opened any more (deleted, or a disk gone).
 */
async function reloadStored() {
  const s = stored;
  if (!s) return true;
  try {
    stored = await loadStored(s.record.id);
  } catch (e) {
    setState('failed', `This machine can't be opened: ${String((e as Error).message ?? e)}.`, [{ label: 'Machines…', run: () => openMachines() }]);
    return false;
  }
  [ncpus, ramMiB, ramSplit, jitMiB] = [stored.record.ncpus, stored.record.ramMiB, stored.record.ramSplit, jitParam() || stored.record.jitMiB || 0];
  want3d = wants3d();
  no3d = want3d && !webgl2 ? 'this browser has no WebGL2' : undefined;
  syncMachineMenu();
  syncDiskButtons();
  syncUsb();
  return true;
}

/** Stops the machine and starts a new one (which resumes a suspended machine, unless `resume` is false): a stored machine as its record is now. */
const restart = (resume = true) => exclusively(async () => {
  await stop();
  if (!(await reloadStored())) return;
  if (needsDisk()) return waitForDisk();
  term.reset();
  start(undefined, resume);
});

/** The toolbar's Start, Restart or Retry: a restart of a running machine is a power cut, so it asks first. */
async function restartAsked() {
  if ((state === 'running' || state === 'booting') && !(await ask.confirm('Restart the machine? Like pulling the plug: unsaved work in the guest is lost.', { title: 'Restart', ok: 'Restart', danger: true }))) return;
  void restart();
}
/** The toolbar's Power off: the machine stops at once, after asking. */
async function powerOffAsked() {
  if (!(state === 'running' || state === 'booting')) return;
  if (!(await ask.confirm('Power the machine off? Like pulling the plug: unsaved work in the guest is lost (shut the guest down first, with poweroff, for a clean stop).', { title: 'Power off', ok: 'Power off', danger: true }))) return;
  await exclusively(async () => { await stop(); setState('off'); });
}

/** What the page shows of the machine and its disk: its name, Suspend (only with a disk the page keeps changes to), a transient machine's entry on the Machines page. */
function syncDiskButtons() {
  ui.title = machineTitle();
  ui.hasOverlay = !!overlayName();
  ui.transient = !stored && !needsDisk() ? { label: spec.label, disk: baseName() } : undefined;
}
/** No disk yet: say how to bring one, and start nothing. */
function waitForDisk() {
  if (stored) return setState('idle', `${stored.record.name} has no disks yet: add one on its Disks tab.`, [{ label: 'Disks…', run: () => openMachines('disks', stored!.record.id) }], 'warn');
  setState('idle', 'Open a disk image to start the machine: an arm64 Linux image that boots through UEFI, as qcow2, raw or an installer or live ISO (Open disk…, or drop the file on the page). What the machine writes to it is kept in this browser, per file.', [{ label: 'Open disk…', run: () => openDiskInput.click() }], 'warn');
}

// The disk reset (M8 decision 4): stop the machine (its overlay's files are locked while it runs), delete the overlay, start again.
async function resetDiskAsked() {
  const name = overlayName();
  if (!name || busy()) return;
  const written = await overlayBytes(name).catch(() => 0);
  const size = written ? ` (${bytesText(written)})` : '';
  if (!(await ask.confirm(`Reset ${chosen || stored ? `the disk ${diskName()}` : `${spec.label}'s disk`}? Everything the machine wrote to it${size} is deleted: your files, installed packages and settings. It then boots from the image as published.`, { title: 'Reset the disk', ok: 'Reset', danger: true }))) return;
  await exclusively(async () => {
    await stop();
    term.reset();
    setState('loading');
    stateText('Resetting the disk');
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

// Your own disk: a local file (raw or qcow2, by its magic), by the picker or dropped on the page. The machine restarts on it; the
// disk's changes are kept in the browser per file (name, size, modification time), so choosing it again continues where it left off.
const openDiskInput = $<HTMLInputElement>('open-disk-input');

/**
 * The machine for a disk file opened or dropped on the page (machines.md §2: "opening a disk the old way stays"): the
 * one that already attaches it (the same name, size and date), or a new one named after it. Its handle, when the
 * browser gave one, is kept; the file itself is used for this session either way.
 */
async function machineForFile(file: File, handle?: FileSystemFileHandle) {
  const known = await knownDisk(store, { kind: 'file', file, handle, size: 0 });
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
  if ((state === 'running' || state === 'booting') && stored?.record.id !== id && !(await ask.confirm('Open the other machine? This one stops, like pulling the plug: unsaved work in the guest is lost.', { title: 'Open the machine', ok: 'Open it', danger: true }))) return;
  await exclusively(async () => {
    await stop();
    const next = await loadStored(id);
    stored = next;
    storedError = '';
    chosen = undefined;
    [ncpus, ramMiB, ramSplit, jitMiB] = [next.record.ncpus, next.record.ramMiB, next.record.ramSplit, next.record.jitMiB ?? 0];
    want3d = wants3d();
    no3d = want3d && !webgl2 ? 'this browser has no WebGL2' : undefined;
    const q = new URLSearchParams(location.search);
    for (const k of ['m', 'disk', 'ncpus', 'ram', 'jitmb']) q.delete(k);
    q.set('m', id);
    history.replaceState(null, '', `?${q}`);
    rememberMachine(id);
    ui.current = id;
    syncDiskButtons();
    syncMachineMenu();
    syncUsb();
    term.reset();
    if (needsDisk()) waitForDisk();
    else start();
  });
}
async function chooseDisk(choice: { file: File; handle?: FileSystemFileHandle } | { url: string }) {
  if ('file' in choice && (await isSnapshot(choice.file))) return loadSnapshot(choice.file); // a snapshot isn't a disk to boot: it replaces the machine
  if (busy()) return;
  if ('file' in choice && (await changesHeader(choice.file))) { // a changes file isn't a disk to boot: it goes onto the disk on the page
    if (!overlayName()) return void ask.alert(`${choice.file.name} holds changes to a disk: open that disk first (Open disk…), then load them.`);
    await loadChanges(choice.file);
    return;
  }
  if (!spec.firmware) return; // only a machine that boots through UEFI takes a disk of its own (the test guests' kernels are their own)
  // The page's own machine: a file opened or dropped is a machine of its own, kept in this browser (machines.md §2).
  if ('file' in choice && machine === 'uefi' && !params.has('machine')) return machineForFile(choice.file, choice.handle);
  const next: DiskChoice = { ...choice, overlay: await diskOverlay(choice) };
  if ((state === 'running' || state === 'booting') && !(await ask.confirm(`Boot ${next.file?.name ?? next.url}? The machine restarts, like pulling the plug: unsaved work in the guest is lost. Its changes to the current disk are kept.`, { ok: 'Boot it', danger: true }))) return;
  chosen = next;
  syncDiskButtons();
  await restart();
}
// Changes in (loop 6): a changes file (Export's "Changes only") goes onto a disk, once the disk is checked to be the one it was
// made over (its hash). A stored machine's disk takes it as a new overlay, which it switches to (the one it has is kept); a
// transient machine's has what it wrote replaced. The machine on the page stops while it's loaded, and starts again after.
const changesHeader = async (file: File) => readChangesHeader(new Uint8Array(await file.slice(0, 1 << 16).arrayBuffer()));
async function loadChanges(file: File, target?: { machine: MachineRecord; attachment: string }) {
  if (busy()) return;
  // The stored machine's attachment it goes into: the one named, or the page's boot disk.
  const m = target?.machine ?? stored?.record;
  const a = target ? m!.attachments.find((x) => x.id === target.attachment) : bootAttachment();
  const here = !!m && m.id === stored?.record.id;
  const disk = !m ? undefined : here ? stored!.disks.get(a?.disk ?? '') : await store.get('disks', a?.disk ?? '');
  const overlay = overlayName();
  if (m ? !a || !disk : !overlay) return;
  if (m && !here && (await isRunning(m.id))) return void ask.alert(`${m.name} runs in another tab: power it off there first.`);
  const info = await changesHeader(file);
  if (!info) return void ask.alert(`${file.name} isn't a changes file (a qcow2 made by Export's "Changes only"). To boot a disk, use Open disk….`);
  if (!info.hash) return void ask.alert(`${file.name} has a backing file (${info.backingName}) but wasn't made by this page's Export, so its base can't be checked: it can't be loaded.`);
  const written = !m && overlay ? await overlayBytes(overlay).catch(() => 0) : 0;
  const running = here && (state === 'running' || state === 'booting');
  const into = m ? `They go into a new overlay of ${disk!.name}, which the machine switches to (the one it has now is kept).` : `They replace everything the machine has written to ${chosen ? diskName() : `${spec.label}'s disk`}${written ? ` (${bytesText(written)})` : ''}, and the firmware's settings.`;
  if (!(await ask.confirm(`Load the changes in ${file.name}? ${into}${running ? ' The machine stops, like pulling the plug, and starts again afterwards.' : ''}`, { title: 'Import changes', ok: 'Load them', danger: running || !m }))) return;
  const progress = (phase: string, f: number) => stateText(`${phase} ${Math.floor(100 * f)}%`);
  const load = async () => {
    if (m) {
      const picked = pickedFiles.get(disk!.id);
      const o = await loadChangesInto(store, disk!, file, progress, picked ? { file: picked } : await diskSource(disk!));
      await switchOverlay(store, m, a!.id, o.id);
      if (here) stored!.record = (await store.get('machines', m.id)) ?? stored!.record;
    } else await runImport({ changes: file, disk: { source: (await pageDisk()).source, overlay: overlay! }, label: baseName() }, progress);
  };
  if (m && !here) {
    // Another machine, off: nothing on this page stops.
    try {
      await load();
      notify(`Loaded the changes in ${file.name} into a new overlay of ${disk!.name}.`);
    } catch (e) {
      notify(`The changes couldn't be loaded: ${String((e as Error).message ?? e)}\nThe disk is as it was.`, 'error');
    }
    return;
  }
  const wasOn = state === 'running' || state === 'booting';
  await exclusively(async () => {
    await stop();
    term.reset();
    setState('off');
    stateText('Loading the changes');
    try {
      await load();
    } catch (e) {
      const text = String((e as Error).message ?? e);
      setState('failed', `The changes couldn't be loaded: ${text}\n${/in use/.test(text) ? 'Close other tabs of this page (one of them may have the disk open), then try again.' : 'The disk is as it was.'}`, [retry]);
      return;
    }
    if (wasOn || !target) start();
    else setState('off', `Loaded the changes in ${file.name} into a new overlay of ${disk!.name}.`, [], 'warn');
  });
}

// Your disk out (loop 5): the changes over the image (a qcow2 that names it as its backing file), or the whole disk. The machine
// stops while it's written (the overlay's files are the writer's); the file goes to where the user picks, or is downloaded.
const SAVES: Record<ExportMode, { suffix: string; description: string; type: string }> = {
  changes: { suffix: '-changes.qcow2', description: 'Changes over the base image (qcow2)', type: 'application/x-qcow2' },
  qcow2: { suffix: '.qcow2', description: 'Whole disk (qcow2)', type: 'application/x-qcow2' },
  raw: { suffix: '.img', description: 'Whole disk (raw)', type: 'application/octet-stream' },
};
/** The disk's file name: the chosen file's or URL's, or the machine's own image's. */
const baseName = () => diskName() ?? (spec.disk ? new URL(spec.disk, location.href).pathname.split('/').pop() : undefined) ?? 'disk';
/**
 * Saves a disk to a file: the page's disk (a transient machine's, or a stored machine's boot disk), or `target`, a stored
 * disk with one of its overlays (or none: the stored disk itself). A machine on this page that runs from it stops while
 * it's written and starts again after; one running in another tab is said to be.
 */
async function saveDisk(mode: ExportMode, compress: boolean, target?: { disk: DiskRecord; overlay?: string }) {
  if (busy()) return;
  // Does the page's machine use it (then it stops)? Its boot disk's overlay, or any attachment of the stored machine.
  const uses = !target || (!!stored && stored.record.attachments.some((a) => a.disk === target.disk.id && (target.overlay ? a.overlay === target.overlay : a.inPlace)));
  const overlay = !target ? overlayName() : target.overlay ? overlayDir(target.overlay) : undefined;
  if (!target && !overlay) return;
  if (target && !uses) {
    const others = (await store.machinesWith(target.disk.id)).filter((m) => m.attachments.some((a) => a.disk === target.disk.id && (target.overlay ? a.overlay === target.overlay : a.inPlace)));
    for (const m of others) if (await isRunning(m.id)) return void ask.alert(`${m.name} runs from this disk in another tab: power it off there first.`);
  }
  const how = SAVES[mode];
  const fileName = target ? target.disk.name : baseName();
  const stem = fileName.replace(/\.(qcow2|img|raw|iso)$/i, '');
  // Never the running disk's own name: a save dialog empties the file it's given at once (Chromium creates or
  // truncates it before the page writes a byte), and accepting the suggestion beside the disk would destroy it.
  const named = `${stem}${how.suffix}`;
  const suggestedName = named.toLowerCase() === fileName.toLowerCase() ? `${stem}-saved${how.suffix}` : named;
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
  const source = async () => {
    if (!target) return pageDisk();
    const picked = pickedFiles.get(target.disk.id);
    const src = picked ? { file: picked } : await diskSource(target.disk);
    return { source: src, identity: identityOf(target.disk), file: picked };
  };
  const ownFile = uses ? (await source()).file : undefined;
  if (handle && ownFile && !(await ownFile.slice(0, 1).arrayBuffer().then(() => true, () => false))) {
    notify(`${handle.name} was the disk this machine runs from: the save dialog emptied it, so nothing was saved. The machine can't read its disk any more. Save to a different file next time.`, 'error');
    return;
  }
  const write = async () => {
    if (overlay === NO_OVERLAY_YET) throw new Error('the machine has written nothing to it yet');
    const { source: src, identity } = await source();
    const r = await runExport({ mode, compress, disk: { source: src, overlay, identity }, baseName: fileName, handle }, (phase, f) => stateText(`${phase} ${Math.floor(100 * f)}%`));
    if (r.blob) {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(r.blob), download: suggestedName });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    }
    return `Saved ${handle?.name ?? suggestedName} (${bytesText(r.bytes)}${mode === 'changes' ? `, ${r.blocks} changed blocks; keep ${fileName} beside it` : ''}).`;
  };
  if (!uses) {
    // Not this page's machine's disk: nothing stops (the state shows the progress, then says what it was).
    const was = ui.stateText;
    try {
      notify(await write());
    } catch (e) {
      notify(`The disk couldn't be saved: ${String((e as Error).message ?? e)}`, 'error');
    } finally {
      ui.stateText = was;
    }
    return;
  }
  const running = state === 'running' || state === 'booting';
  if (running && !(await ask.confirm('Stop the machine to save its disk? It is stopped like pulling the plug: unsaved work in the guest is lost (shut it down first with poweroff for a clean disk). It starts again afterwards.', { title: 'Save the disk', ok: 'Stop and save', danger: true }))) return;
  await exclusively(async () => {
    await stop();
    setState('off');
    stateText('Saving the disk');
    try {
      setState('off', await write(), [], 'warn');
    } catch (e) {
      const text = String((e as Error).message ?? e);
      setState('failed', `The disk couldn't be saved: ${text}\n${/in use/.test(text) ? 'Close other tabs of this page (one of them may have the disk open), then try again.' : ''}`, [retry]);
      return;
    }
    if (running) start();
  });
}


// Snapshots (docs/frontend.md "Snapshots"): the running machine, RAM and disk changes and all, in a file, and back.
/** The save in progress: the worker's messages for it (the page's `worker.onmessage` forwards them). */
let snapshotJob: { progress(phase: string, fraction: number): void; chunk(data: Uint8Array): void; done(m: { bytes: number; pausedMs: number; stateMs: number; blobBytes: number; pins: SnapshotDisk[] }): void; error(message: string): void } | undefined;
const SNAPSHOT_SUFFIX = '.webpcsnap';
const mb = bytesText;

/** Past this, a snapshot says how much the 3D state adds to it and asks first (docs/graphics.md "Snapshots with 3D in use"). */
const GRAPHICS_WARN = 64 << 20;
const bytesAsked = new Map<number, (bytes: number) => void>();
let bytesAskId = 0;

/** The bytes a snapshot would hold for the 3D resources, before compression (the GPU worker's count; 0 without 3D, or without an answer). */
function graphicsBytes(r: Run) {
  const gpu = r.gpu;
  if (!gpu) return Promise.resolve(0);
  const id = ++bytesAskId;
  return new Promise<number>((resolve) => {
    const t = setTimeout(() => { bytesAsked.delete(id); resolve(0); }, 1000);
    bytesAsked.set(id, (bytes) => { clearTimeout(t); resolve(bytes); });
    gpu.postMessage({ type: 'snapshotBytes', id } satisfies ToGpuWorker);
  });
}

/** Whether to take the snapshot: yes, unless the 3D state is large and the user says no. */
async function graphicsOk(r: Run) {
  const bytes = await graphicsBytes(r);
  return bytes < GRAPHICS_WARN || ask.confirm(`The machine is using 3D: its graphics memory (textures and buffers) adds up to ${mb(bytes)} to the snapshot before compression, and the machine pauses while it is read. Take the snapshot anyway?`, { title: 'A large snapshot', ok: 'Take it' });
}

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
  // A stored machine's is kept at once, named by the time (Snapshot is the toolbar's panic button: renamed later, on the Machines page).
  if (stored && !o.toFile) return keepSnapshot(d.toLocaleString());
  // A large 3D state is asked about first (its OK is a click: the picker after it has its user activation).
  if (!(await graphicsOk(r)) || run !== r || saving || switching || !(state === 'running' || state === 'booting')) return;
  // The picker next, as a disk's Export does: it needs the click's user activation. The machine isn't stopped, so nothing is asked.
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
  const unplugged = await emptyPorts(r, 'Taking a snapshot');
  if (!unplugged) return;
  if (run !== r || saving || switching || !(state === 'running' || state === 'booting')) return;
  saving = true;
  syncButtons();
  const parts: Blob[] = [];
  try {
    const result = await new Promise<{ bytes: number; pausedMs: number; stateMs: number; blobBytes: number }>((resolve, reject) => {
      snapshotJob = {
        progress: (phase, f) => stateText(f > 0 && f < 1 ? `${phase} ${Math.floor(100 * f)}%` : phase),
        chunk: (data) => { parts.push(new Blob([data as Uint8Array<ArrayBuffer>])); },
        done: ({ bytes, pausedMs, stateMs, blobBytes }) => resolve({ bytes, pausedMs, stateMs, blobBytes }),
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
    ui.snapshotResult = JSON.stringify(result); // for tools: the file's bytes, the pause's ms (and the devices' state's), the 3D contents' bytes
    if (run === r && (state === 'running' || state === 'booting')) {
      setState(state);
      notify(`Saved the snapshot ${handle?.name ?? suggestedName} (${mb(result.bytes)}); the machine was paused for ${(result.pausedMs / 1000).toFixed(1)} s and runs on.`);
    }
  } catch (e) {
    if (run === r) { setState(state); notify(`${String((e as Error).message ?? e)}\nThe machine runs on; no file was saved.`, 'error'); }
  } finally {
    saving = false;
    snapshotJob = undefined;
    syncButtons();
    void plugBack(r, unplugged);
  }
}

/** Keeps a snapshot of the running stored machine in the browser (its file in OPFS first, then its record). */
async function keepSnapshot(name: string) {
  const r = run;
  const s = stored;
  if (!r || !s || saving || switching || !(state === 'running' || state === 'booting')) return;
  if (!(await graphicsOk(r)) || run !== r || saving || switching || !(state === 'running' || state === 'booting')) return;
  const unplugged = await emptyPorts(r, 'Taking a snapshot');
  if (!unplugged || run !== r || saving || switching || !(state === 'running' || state === 'booting')) return;
  saving = true;
  syncButtons();
  const id = newId();
  try {
    const about = (await aboutMachine())!;
    await askPersist();
    const result = await store.writing(async () => {
      const done = await new Promise<{ bytes: number; pausedMs: number; stateMs: number; blobBytes: number; pins: SnapshotDisk[] }>((resolve, reject) => {
        snapshotJob = {
          progress: (phase, f) => stateText(f > 0 && f < 1 ? `${phase} ${Math.floor(100 * f)}%` : phase),
          chunk: () => {},
          done: (m) => resolve(m),
          error: (message) => reject(new Error(message)),
        };
        r.worker.postMessage({ type: 'snapshot', keep: snapshotPath(s.record.id, id) } satisfies ToWorker);
      });
      await store.put('snapshots', { id, machine: s.record.id, name, created: Date.now(), bytes: done.bytes, shape: about.shape, shapeHash: about.shapeHash, urls: about.urls, pins: done.pins.map((p) => ({ slot: p.slot, overlay: p.overlay, generation: p.generation, blocks: p.blocks, ram: p.ram })) });
      return done;
    });
    ui.snapshotResult = JSON.stringify({ bytes: result.bytes, pausedMs: result.pausedMs, stateMs: result.stateMs, blobBytes: result.blobBytes, id });
    ui.records++; // this tab's own writes aren't announced to it (Store.onChange)
    if (run === r && (state === 'running' || state === 'booting')) { setState(state); notify(`Kept the snapshot ${name} in this browser (${mb(result.bytes)}); the machine was paused for ${(result.pausedMs / 1000).toFixed(1)} s and runs on. Rename it on the Machines page.`); }
  } catch (e) {
    if (run === r) { setState(state); notify(`${String((e as Error).message ?? e)}\nThe machine runs on; nothing was kept.`, 'error'); }
  } finally {
    saving = false;
    snapshotJob = undefined;
    syncButtons();
    void plugBack(r, unplugged);
  }
}

// Suspend (docs/frontend.md "Suspend"): the machine stops with its memory kept beside its disk in this
// browser; the next start (this page opened again, Start) resumes it. Nothing is asked: nothing is lost.
async function suspend() {
  const r = run;
  if (!r || saving || switching || !(state === 'running' || state === 'booting')) return;
  // Its devices are unplugged first; the next start attaches the ones attached at start (docs/usb.md "The page").
  const unplugged = await emptyPorts(r, 'Suspending');
  if (!unplugged || run !== r || saving || switching || !(state === 'running' || state === 'booting')) return;
  saving = true;
  syncButtons();
  snapshotJob = {
    progress: (phase, f) => stateText(f > 0 && f < 1 ? `${phase} ${Math.floor(100 * f)}%` : phase),
    chunk: () => {},
    done: () => {},
    // It runs on; the `suspended` state ends a suspend that worked (the worker's handler above).
    error: (message) => {
      saving = false;
      snapshotJob = undefined;
      if (run === r) { setState(state); notify(`${message}\nThe machine runs on.`, 'error'); }
      syncButtons();
      void plugBack(r, unplugged);
    },
  };
  r.worker.postMessage({ type: 'suspend' } satisfies ToWorker);
}

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
    return void ask.alert(`${name} is a snapshot of a machine other than ${s.record.name} as it is now: ${why.join('; ')}.\nMachines… can make a machine like it.`, { title: "The snapshot can't be restored" });
  }
  let plan: Awaited<ReturnType<typeof planRestore>>;
  try {
    plan = await planRestore(store, s.record, s.disks, { name: name.replace(/\.webpcsnap$/, ''), key, pins: (header.disks ?? []) as SnapshotDisk[] }, now!.shape.display);
  } catch (e) {
    return void ask.alert(`${name} can't be restored: ${String((e as Error).message ?? e)}`);
  }
  if (plan.refused) return void ask.alert(`${name} can't be restored: ${plan.refused}`);
  const when = new Date(header.created);
  const running = state === 'running' || state === 'booting';
  const forks = plan.forks.map((f) => (f.reused ? `${f.disk}: its earlier fork of this snapshot, attached again` : `${f.disk}: changed since, so the snapshot's state goes into a new overlay, attached now (the one it has stays as it is)`));
  if (!(await ask.confirm(`Restore ${name}${Number.isNaN(when.getTime()) ? '' : `, taken ${when.toLocaleString()}`}? ${running ? 'The machine stops, like pulling the plug, and' : 'The machine'} runs on from where the snapshot was taken.${plan.kept.length ? `\nAs the snapshot left them: ${plan.kept.join(', ')}.` : ''}${forks.length ? `\n${forks.join('\n')}` : ''}`, { title: 'Restore a snapshot', ok: 'Restore', danger: running }))) return;
  const replaceable = plan.forks.filter((f) => !f.reused && f.replaceable);
  const they = replaceable.length > 1;
  const replace = replaceable.length > 0 && !(await ask.confirm(`Keep ${replaceable.map((f) => `${f.replaceable!.name} (${mb(f.replaceable!.bytes)})`).join(', ')} as ${they ? 'they are' : 'it is'} and restore into a new overlay? Replacing ${they ? 'them' : 'it'} instead loses what the machine wrote since the snapshot.`, { title: 'Keep the changes since?', ok: 'Keep, restore into a new overlay', cancel: `Replace ${they ? 'them' : 'it'}` }));
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
    if (e instanceof SnapshotError) return void ask.alert(`${file.name}: ${e.message}`, { title: "Not a snapshot this page can load" });
    throw e;
  }
  if (stored) return restoreSnapshot(file, header, `file:${String(header.created)}`, file.name);
  const label = typeof header.label === 'string' ? header.label : String(header.machine);
  if (header.machine !== machine) {
    return void ask.alert(`${file.name} is a snapshot of ${label} (?machine=${String(header.machine)}), and this page runs ${spec.label} (?machine=${machine}). Open the page for that machine to load it.`);
  }
  const taken = typeof header.disk === 'string' ? header.disk : null;
  const open = chosen ? diskName()! : null;
  if (taken !== open) {
    return void ask.alert(`${file.name} was taken on ${snapshotDisk(taken)}, and the disk open now is ${snapshotDisk(open)}. A snapshot continues only on the disk it was taken on: ${taken ? 'open that disk first (Open disk…), then load the snapshot' : 'reload the page (it starts with the machine\'s own disk), then load the snapshot'}.`);
  }
  const overlay = overlayName();
  const written = overlay ? await overlayBytes(overlay).catch(() => 0) : 0;
  const when = new Date(header.created);
  const running = state === 'running' || state === 'booting';
  if (!(await ask.confirm(`Load the snapshot ${file.name}? It holds ${label}${Number.isNaN(when.getTime()) ? '' : ` as it was on ${when.toLocaleString()}`} (${mb(file.size)}${typeof header.ncpus === 'number' ? `, ${header.ncpus} vCPU${header.ncpus > 1 ? 's' : ''}` : ''}). ${running ? 'This machine stops, like pulling the plug, and the' : 'The'} snapshot's machine takes its place, running where it was saved. Everything ${chosen ? `the disk ${diskName()}` : `${spec.label}'s disk`} has written${written ? ` (${mb(written)})` : ''} is replaced by the snapshot's changes to the disk.`, { title: 'Load a snapshot', ok: 'Load it', danger: true }))) return;
  await exclusively(async () => {
    await stop();
    term.reset();
    start(file);
  });
}
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


// Keys typed into the terminal go to the PL011 (xterm.js sends what a terminal would: \r for Enter, escape sequences).
let replaying = false;
term.onData((d) => { if (!replaying) run?.serial.postMessage(d); });

// The network (docs/frontend.md "Network", docs/network-adapters.md): the machine's adapters, each with a connection
// of the browser's attached (web/app/net-live.ts); the toolbar's Network menu, the Network wizard and the Machines page's
// Network tab and Connections act through these.
/** The page's machine as the network knows it: a stored machine's id, or the transient machine. */
const netKey = () => stored?.record.id ?? 'transient';
/** The page's machine's adapters: a stored machine's, or a transient one's card (its connection kept in the settings). */
function pageAdapters() {
  if (!spec.network) return [];
  if (stored) return adaptersOf(stored.record);
  const id = settings().transientNet;
  return [{ id: 'transient', mac: DEFAULT_MAC, ...(id ? { connection: id } : {}) }];
}

/**
 * The network as it was kept before connections (`webpc.settings` `net`, a kept node, the served tailcat identity) made
 * into connections (docs/network-adapters.md §2.2), once: the transient machine's adapter and every stored
 * machine's first one get the one the settings were on.
 */
async function migrateNetwork() {
  if (!settings().net) return;
  const run = async () => {
    const legacy = settings().net;
    if (!legacy) return; // another tab did it
    const [first] = await migrateLegacy(net.conns, { settings: legacy, profiles: await keptProfiles().catch(() => []), served: await hasTailcatIdentity() });
    if (first) {
      if (!settings().transientNet) remember({ transientNet: first.id });
      for (const m of await store.all('machines')) {
        const a = adaptersOf(m);
        if (a.length && !a[0].connection) await setAdapterConnection(store, m.id, 0, first.id);
      }
      if (stored) stored.record = (await store.get('machines', stored.record.id)) ?? stored.record;
    }
    remember({ net: undefined });
  };
  if (navigator.locks) await navigator.locks.request('webpc-net-migrate', run);
  else await run();
}

/** Whether `machine` (an id, or undefined for a transient one) is the page's and its adapters are live here. */
const netLive = (machine: string | undefined, i: number) => (machine ?? 'transient') === netKey() && net.machineKey() === netKey() && i < net.views().length;

/**
 * Attaches connection `c` to adapter `i` of `machine` (undefined: the page's transient one). The page's machine connects
 * it now (`authKey`: a tailnet's first login); one another tab's machine has is taken from it after asking. Another
 * machine keeps it in its record, and connects it when it starts.
 */
async function netAttach(machine: string | undefined, i: number, c: Connection, authKey?: string) {
  if (netLive(machine, i)) {
    try {
      await net.attach(i, c, authKey);
    } catch (e) {
      if (!(e instanceof HeldError)) throw e;
      if (!(await ask.confirm(`${e.message} Use it here instead? That machine disconnects from it.`, { title: 'The connection is in use', ok: 'Use it here' }))) return;
      await net.takeFrom(i, c, authKey);
    }
    return;
  }
  if (machine) await setAdapterConnection(store, machine, i, c.id);
  else remember({ transientNet: c.id });
  await net.conns.put({ ...c, connectAtStart: true });
  if (stored && machine === stored.record.id) stored.record = (await store.get('machines', machine)) ?? stored.record;
  await net.refresh();
}

async function netDetach(machine: string | undefined, i: number) {
  if (netLive(machine, i)) return net.detach(i);
  if (machine) await setAdapterConnection(store, machine, i, undefined);
  else remember({ transientNet: undefined });
  if (stored && machine === stored.record.id) stored.record = (await store.get('machines', machine)) ?? stored.record;
  await net.refresh();
}

/** Deletes connection `c` after asking (naming the machines it is attached to): it is detached from them, and its state forgotten. */
async function netDelete(c: Connection) {
  const on = (await store.all('machines')).filter((m) => m.adapters?.some((a) => a.connection === c.id)).map((m) => m.name);
  if (settings().transientNet === c.id) on.push(spec.label);
  const what = c.kind === 'tailnet' ? (c.ephemeral ? 'Its node leaves the tailnet when it is next seen offline.' : "Its node's keys are deleted here: connecting again is a new node, with a login (log it out first to take it off the tailnet now).") : c.tailcat?.serve ? 'Its tailcat address stops working.' : '';
  if (!(await ask.confirm(`Delete the connection ${c.name}?${on.length ? ` It is detached from ${on.join(', ')}.` : ''} ${what}`.trim(), { title: 'Delete the connection', ok: 'Delete', danger: true }))) return;
  await net.remove(c);
  await detachEverywhere(store, c.id);
  if (settings().transientNet === c.id) remember({ transientNet: undefined });
  if (stored) stored.record = (await store.get('machines', stored.record.id)) ?? stored.record;
  await net.refresh();
}

/** Forgets tailcat connection `c`'s served identity, after asking: whoever has its address can't come in any more. */
async function netNewAddress(c: Connection) {
  const t = c.tailcat;
  if (!t) return false;
  if (!(await ask.confirm(`Forget ${c.name}'s tailcat address? Whoever has it can't come in any more, and the machine gets a new one when it next lets clients in.`, { ok: 'Forget it', danger: true }))) return false;
  // An ephemeral connection's identity is in the page's memory: a new one; a stored one's is made again at its next serve.
  if (c.ephemeral) await net.conns.put({ ...c, tailcat: { ...t, identity: newTailcatIdentity() } });
  else await forgetTailcatIdentity(t.identityKey);
  const at = net.runs(c.id);
  if (at >= 0) await net.edit((await net.conns.get(c.id))!);
  return true;
}

// Full screen, with the Keyboard Lock API (Chromium) so that Ctrl+W, Ctrl+T, Esc and the like reach
// the machine; Chromium leaves full screen when Esc is held.
type KeyboardLock = { lock(): Promise<void>; unlock(): void };
const keyboardLock = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
const mainEl = document.querySelector('main')!;
function fullscreen() {
  if (ui.machinesOpen) closeMachines();
  (ui.view === 'terminal' ? term : canvas).focus();
  // Without the lock (refused, or another browser), the browser keeps its shortcuts.
  mainEl.requestFullscreen({ navigationUI: 'hide' }).then(() => keyboardLock?.lock()).catch(() => {});
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) keyboardLock?.unlock(); });

// Leaving the page while the machine runs stops it like pulling the plug: the browser asks first (Preferences, on the
// Machines page, turns it off). The browser words the question itself. Not under automation (the tests navigate away
// from running machines) unless `?leavewarning=1`.
window.addEventListener('beforeunload', (e) => {
  if (!['running', 'booting', 'rebooting'].includes(ui.state) || !leaveWarning()) return;
  if (navigator.webdriver && params.get('leavewarning') !== '1') return;
  e.preventDefault();
  e.returnValue = ''; // older Chromium asks only with this set
});

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
  ui.status.data = JSON.stringify(s); // for tools (bench/stress)
  ui.status.text = [
    `${s.ncpus} vCPU${s.ncpus > 1 ? 's' : ''}`, `${s.ramMiB} MiB`, `up ${hms(s.uptime)}`,
    mips === undefined ? '' : `${mips.toFixed(0)} MIPS`,
    jitPct === undefined ? '' : `${jitPct.toFixed(1)}% in JIT`,
    `JIT ${s.jitBlocks.toLocaleString('en')} blocks compiled${s.jitFlushes ? ` (cache flushed ${s.jitFlushes}×)` : ''}, ${(s.jitCompileMs / 1000).toFixed(1)} s compiling`,
    irqs === undefined ? '' : `${irqs.toFixed(0)} IRQ/s`,
  ].filter(Boolean).join(' · ');
}

syncDiskButtons();
// The view: the query's, else the one chosen last in this browser, else the screen (M8 decision 2).
const isView = (v: unknown): v is View => v === 'screen' || v === 'terminal' || v === 'both';
const asked = params.get('view');
setView(isView(asked) ? asked : isView(settings().view) ? settings().view! : 'screen', false);

// A transient machine's size (the toolbar's Machine menu): vCPUs, RAM and graphics, applied by a restart (a power cut, like
// the other restarts). A stored machine's are its Settings, on the Machines page (`saveSettings`).
/** The Machine menu shows what runs (a stored machine's own settings after a switch). */
function syncMachineMenu() {
  ui.size.ncpus = ncpus;
  ui.size.ramMiB = ramMiB;
  ui.size.split = ramSplit;
  ui.size.gpu = want3d ? '3d' : '2d';
  ui.size.cpuChoices = [...new Set([...CPU_CHOICES, ncpus])].sort((a, b) => a - b);
  ui.size.ramChoices = [...new Set([...RAM_CHOICES, ramMiB])].sort((a, b) => a - b);
  ui.size.gpuLock = !webgl2 ? 'This browser has no WebGL2: 2D only' : gpuAsked ? `Set by the page's address (?gpu=${params.get('gpu')})` : '';
}
syncMachineMenu();
// The memory signal (web/app/memory.ts, docs/frontend.md "Memory"): while the machine runs, a mark in localStorage
// with what it costs, renewed every 10 s and cleared at a clean stop; a mark left over means its tab went away with
// it running (most likely killed for memory), and the next start offers a smaller JIT cache or less RAM first.
const aliveKey = () => (stored ? stored.record.id : `transient-${machine}`);
let aliveAt = 0, signal = new Signal(), signalRun: Run | undefined;
function alive(st: Status) {
  const now = Date.now();
  if (signalRun !== run) [signal, signalRun] = [new Signal(), run];
  const est = signal.update(st.memory, st.ncpus);
  if (now - aliveAt < ALIVE_EVERY_MS) return;
  aliveAt = now;
  markAlive(aliveKey(), { name: machineTitle(), ramMiB, ncpus, jitMiB: Math.round(st.memory.jitBudget / 2 ** 20), gib: +(est / 2 ** 30).toFixed(2), peakGiB: +(signal.peak / 2 ** 30).toFixed(2), t: now });
}
addEventListener('pagehide', () => { if (run) clearAlive(aliveKey()); });
/** A mark left by a tab that went away with this machine running: says so and offers what may fit (true: not started). */
function crashedBefore() {
  const a = lastCrash(aliveKey());
  if (!a) return false;
  const use = async (o: { jitMiB?: number; ramMiB?: number }) => {
    clearAlive(aliveKey());
    if (stored) {
      const m = { ...stored.record, ...(o.jitMiB ? { jitMiB: o.jitMiB } : {}), ...(o.ramMiB ? { ramMiB: o.ramMiB, ramSplit: undefined } : {}) };
      if (o.ramMiB && (await store.snapshotsOf(m.id)).length && !(await ask.confirm('Less RAM orphans its snapshots: they were taken of a machine with the old settings (they stay, marked, until deleted).', { ok: 'Use less RAM' }))) return void crashedBefore();
      stored.record = await updateMachine(store, m);
    } else remember(o);
    if (o.jitMiB) jitMiB = o.jitMiB;
    if (o.ramMiB) [ramMiB, ramSplit] = [o.ramMiB, undefined];
    syncMachineMenu();
    void restart();
  };
  const jitNow = a.jitMiB || jitBudget();
  const ramLess = [...RAM_CHOICES].reverse().find((r) => r <= a.ramMiB / 2) ?? RAM_CHOICES[0];
  const actions: Action[] = [
    ...(jitNow > 160 ? [{ label: 'Start with a 160 MiB JIT cache', run: () => void use({ jitMiB: 160 }) }] : jitNow > 64 ? [{ label: 'Start with a 64 MiB JIT cache', run: () => void use({ jitMiB: 64 }) }] : []),
    ...(ramLess < a.ramMiB ? [{ label: `Start with ${ramLess} MiB of RAM`, run: () => void use({ ramMiB: ramLess }) }] : []),
    { label: 'Start as it is', run: () => { clearAlive(aliveKey()); void restart(); } },
  ];
  setState('idle', `${a.name} was running when its tab closed without stopping it (${new Date(a.t).toLocaleString()}), most likely because the browser ran out of memory: by the emulator's own accounting it was using about ${a.gib} GiB (${a.peakGiB} at most), with ${a.ramMiB} MiB of guest RAM and a ${a.jitMiB} MiB JIT cache.\nA smaller JIT cache keeps less of the guest's code compiled (the browser spends about six times the cache's size on it when it is full); less RAM leaves the guest less room.`, actions, 'warn');
  return true;
}
/** The warning for a size this device may not have the memory for. */
function memoryWarning(r: number, n: number, j = jitBudget()) {
  const need = hostMemoryGiB(r, n, j);
  const has = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return has !== undefined && has < need ? `\n\nThis needs about ${need.toFixed(1)} GiB of memory and this device reports ${has} GiB${has >= 8 ? ' (browsers report at most 8, so it may well have more)' : ''}: if it runs out, the browser closes the tab without warning.` : '';
}
async function applySize(n: number, r: number, g: '3d' | '2d') {
  if (n === ncpus && r === ramMiB && g === (want3d ? '3d' : '2d')) return;
  const running = state === 'running' || state === 'booting';
  if (!(await ask.confirm(`Restart with ${n} vCPU${n > 1 ? 's' : ''}, ${r} MiB of RAM${hasGpu ? ` and ${g === '3d' ? '3D' : '2D'} graphics` : ''}?${running ? ' Like pulling the plug: unsaved work in the guest is lost.' : ''} A suspended machine is resumed as it was, with its own size.${memoryWarning(r, n)}`, { title: 'The machine\'s size', ok: 'Restart', danger: running }))) return;
  if (r !== ramMiB) ramSplit = undefined;
  [ncpus, ramMiB] = [n, r];
  remember({ ncpus, ramMiB, ...(hasGpu && !gpuAsked ? { gpu: g } : {}) });
  want3d = wants3d();
  no3d = want3d && !webgl2 ? 'this browser has no WebGL2' : undefined;
  syncMachineMenu();
  void restart();
}
/** A stored machine's settings, from its Settings tab while it runs on this page: it restarts with them (its snapshots of the old shape are orphaned: they stay, marked). */
async function saveSettings(m: MachineRecord) {
  const s = stored;
  if (!s || m.id !== s.record.id) return;
  const running = state === 'running' || state === 'booting';
  if (running && !(await ask.confirm(`Restart ${m.name} with its new settings? Like pulling the plug: unsaved work in the guest is lost. A suspended machine is resumed as it was, with its own size.${memoryWarning(m.ramMiB, m.ncpus, jitParam() || m.jitMiB || JIT_DEFAULT_MIB)}`, { title: 'Save and restart', ok: 'Restart', danger: true }))) return;
  await exclusively(async () => {
    await stop();
    s.record = await updateMachine(store, m);
    syncUsb();
    [ncpus, ramMiB, ramSplit, jitMiB] = [s.record.ncpus, s.record.ramMiB, s.record.ramSplit, jitParam() || s.record.jitMiB || 0];
    want3d = wants3d();
    no3d = want3d && !webgl2 ? 'this browser has no WebGL2' : undefined;
    syncMachineMenu();
    syncDiskButtons();
    term.reset();
    if (running) start();
    else setState('off');
  });
}

// The Machines page (docs/plans/machines.md §7; web/app/MachinesPage.svelte): in the machine's place, which runs on behind it.
// `#machines` in the address opens it (a reload keeps it open).
function openMachines(tab?: MachinesTab, id?: string) {
  if (tab) ui.machinesTab = tab;
  if (id) ui.machinesSelected = id;
  ui.machinesOpen = true;
  if (location.hash !== '#machines') history.replaceState(null, '', `${location.pathname}${location.search}#machines`);
}
function closeMachines() {
  ui.machinesOpen = false;
  // What the page changed shows in the toolbar now (a running machine takes it at its next start).
  if (!run && !switching && !saving) void reloadStored();
  if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
  queueMicrotask(() => { fit(); (ui.view === 'terminal' ? term : canvas).focus(); });
}
if (location.hash === '#machines') openMachines();

// Sound (docs/frontend.md "Sound"; its menu is web/app/Sound.svelte): any click or key on the page lets the browser play it.
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => audio.gesture(), { capture: true });
if (params.has('snd')) (window as unknown as { __audio?: PageAudio }).__audio = audio; // tests and measurements (?snd=stats)

// USB (docs/usb.md "The page"; the USB tab is web/app/Usb.svelte, the menu UsbMenu.svelte): a
// machine with a controller (a stored one's `usb`, a transient one's `?usb=1`) attaches its remembered devices when it
// runs, by their identities: the device worker opens them (web/usb-device.ts). A device is one machine's at a time (its
// Web Lock, web/app/usb-live.ts); Snapshot and Suspend empty the ports first.
const usbOn = () => (stored ? !!stored.record.usb : params.get('usb') === '1');
/** A relative mouse or a touchscreen: a stored machine's `mouse`, `touch`; a transient one's `?mouse=1`, `?touch=1`. */
const pointerOn = (kind: 'mouse' | 'touch') => (stored ? !!stored.record[kind] : params.get(kind) === '1');
/** A transient machine's remembered devices: this page's only, for its session. */
let transientUsb: UsbEntry[] = [];
const usbEntries = (): UsbEntry[] => (stored ? stored.record.usbDevices ?? [] : transientUsb);
/** Changes machine `id`'s remembered devices (undefined: the page's transient machine's), in the store and here. */
let usbEdits: Promise<unknown> = Promise.resolve();
function editUsbEntries(id: string | undefined, f: (e: UsbEntry[]) => UsbEntry[]): Promise<void> {
  // One at a time: each reads the record the one before wrote.
  const next = usbEdits.then(() => editUsbEntriesNow(id, f));
  usbEdits = next.catch(() => {});
  return next;
}
async function editUsbEntriesNow(id: string | undefined, f: (e: UsbEntry[]) => UsbEntry[]) {
  if (!id) {
    transientUsb = f(transientUsb);
  } else {
    const m = await store.get('machines', id);
    if (!m) throw new Error('that machine is gone');
    m.usbDevices = f(m.usbDevices ?? []);
    if (!m.usbDevices.length) delete m.usbDevices;
    await store.put('machines', m);
    if (stored?.record.id === id) stored.record.usbDevices = m.usbDevices;
    ui.records++; // this tab's own writes aren't announced to it
  }
  syncUsb();
}
const isCurrent = (id: string | undefined) => (stored ? stored.record.id === id : id === undefined);
const usbRunning = () => !!run?.usb && (state === 'running' || state === 'booting');
const usbLocks = new UsbLocks(store, () => machineTitle(), (lock) => void letGo(lock));
const stoppedText = "The machine isn't running on this page: its devices are attached when it runs.";

/** The page's machine's USB as the menu and the tab show it (`ui.usb`), read again now. */
let usbReading: Promise<void> | undefined;
let usbAgain = false;
function syncUsb() {
  ui.usb.on = usbOn();
  ui.usb.zero = params.get('usbzero') === '1';
  ui.usb.running = usbRunning();
  ui.usb.connectors = Array.from({ length: USB_CONNECTORS }, (_, i) => {
    const c = run?.usb?.connectors[i];
    const d = c?.device;
    const problems = c?.problems?.length && d && d.api !== 'virtual' ? c.problems.map((p) => problemText(p, d)) : undefined;
    return c ? { name: c.name, state: c.state, entry: c.entry, virtual: c.device.api === 'virtual', builtin: isKeyboard(c), problems } : null;
  });
  ui.usb.offers = [...offers.values()].map(({ id, text, label }) => ({ id, text, label }));
  ui.usb.tick++;
  if (usbReading) { usbAgain = true; return; }
  usbReading = (async () => {
    try {
      ui.usb.entries = await entryStates(usbEntries(), run?.usb?.attachedEntries() ?? new Set(), usbLocks);
      ui.usb.tick++;
    } finally {
      usbReading = undefined;
      if (usbAgain) { usbAgain = false; syncUsb(); }
    }
  })();
}
function usbPorts(port: MessagePort) {
  const p = new UsbPorts(port, usbLocks);
  p.onChange = syncUsb;
  p.onGone = (connector, was, reason) => {
    if (reason === 'unplugged' && was.device.api !== 'virtual') {
      // It may come back as another device (a bootloader, after a firmware upload): the offer to attach that one there.
      const api = was.device.api;
      const entry = usbEntries().find((e) => e.id === was.entry);
      const gone = { connector, api, atStart: entry?.atStart ?? false, name: was.name, at: Date.now() };
      lastGone = gone;
      offer(`gone-${connector}`, `${was.name} was unplugged from connector ${connector + 1}. If it came back as another device (a bootloader, after a firmware upload), pick that one to attach it there.`, 'Pick it…', async () => {
        for (const d of await requestDevices(api)) await rememberAndAttach(api, d, { connector, atStart: gone.atStart });
      });
    } else if (reason && reason !== 'unplugged' && reason !== 'guest' && reason !== 'page') {
      notify(`${was.name} was detached: ${reason}`, 'error');
    }
  };
  return p;
}
/** The last device that was unplugged while attached (re-enumeration: the next new device takes its connector). */
let lastGone: { connector: number; api: Api; atStart: boolean; name: string; at: number } | undefined;
const REENUMERATION_MS = 60_000;

/** The offers in the USB menu, by id: a device that just appeared, one that left, a grant to give. */
const offers = new Map<string, { id: string; text: string; label: string; run: () => Promise<void> }>();
function offer(id: string, text: string, label: string, f: () => Promise<void>) {
  offers.set(id, { id, text, label, run: f });
  ui.usb.open++;
  syncUsb();
}

/** An attach's error for the message bar: a `UsbError` with problems names the device itself. */
const attachFailed = (name: string, err: unknown, again = '') =>
  err instanceof UsbError && err.words.length ? err.message : `${name} couldn't be attached${again}: ${String((err as Error).message ?? err)}`;

/** Attaches entry `e` on its connector; a device another machine holds is offered to be detached there first (`quiet`: skipped, with a note). */
async function attachEntry(e: UsbEntry, o: { quiet?: boolean } = {}) {
  const p = run?.usb;
  if (!p || !usbRunning()) throw new Error(stoppedText);
  if (p.connectorOf(e.id) >= 0) return;
  const name = deviceName(e);
  try {
    await p.attach(e.connector, usbIdentity(e), e.id);
  } catch (err) {
    if (!(err instanceof UsbError) || err.message !== 'held') throw err;
    const who = await usbLocks.holder(usbLock(e));
    const where = who ? `${who}, in another tab` : 'another machine (in another tab)';
    if (o.quiet) return void notify(`${name} is attached to ${where}: it was left there.`);
    if (!(await ask.confirm(`${name} is attached to ${where}. Detach it there and attach it here? That machine sees it unplugged: whatever it was doing with it breaks.`, { title: 'The device is in use', ok: 'Detach it there' }))) return;
    if (!(await usbLocks.takeFrom(usbLock(e)))) throw new Error(`${where} didn't let ${name} go.`);
    await p.attach(e.connector, usbIdentity(e), e.id);
  }
}
/** Another tab wants the device of `lock`: it is detached here. */
async function letGo(lock: string) {
  const p = run?.usb;
  const at = p?.connectors.findIndex((c) => c && c.device.api !== 'virtual' && usbLock(c.device) === lock) ?? -1;
  if (!p || at < 0) return usbLocks.drop(lock);
  const name = p.connectors[at]!.name;
  await p.detach(at).catch(() => {});
  notify(`${name} was detached: another machine took it.`);
}

const pageMachine = () => stored?.record.id;
// The built-in keyboard (docs/usb.md "The keyboard"): a HID boot keyboard on the last connector, plugged in while the
// guest has no driver on its virtio keyboard (the firmware, the boot loader, an initramfs), so the screen's keys reach
// them as a keyboard's (every key, held modifiers); unplugged once that driver is live, so the guest's own kernel
// doesn't get every key twice.
const KEYBOARD = { api: 'virtual', kind: 'keyboard' } as const;
const isKeyboard = (c?: { device: UsbIdentity | UsbVirtual }) => c?.device.api === 'virtual' && c.device.kind === 'keyboard';
/** The screen's key for the built-in keyboard: false when it isn't plugged in (the serial console takes it then). */
function keyboardKey(code: string, down: boolean): boolean {
  const p = run?.usb;
  const c = p?.connectors[KEYBOARD_CONNECTOR];
  if (!p || !isKeyboard(c) || c!.state !== 'attached') return false;
  p.key(KEYBOARD_CONNECTOR, code, down);
  return true;
}
/** Plugs the built-in keyboard in or out, as the guest's virtio keyboard is live or not. */
let keyboardSync: Promise<void> = Promise.resolve();
function syncKeyboard(r: Run) {
  keyboardSync = keyboardSync.then(async () => {
    const p = r.usb;
    if (!p || run !== r || !usbRunning()) return;
    const c = p.connectors[KEYBOARD_CONNECTOR];
    if (keyboardLive && isKeyboard(c)) await p.detach(KEYBOARD_CONNECTOR).catch(() => {});
    else if (!keyboardLive && !c) await p.attach(KEYBOARD_CONNECTOR, KEYBOARD).catch((err) => notify(`The built-in keyboard couldn't be plugged in: ${String((err as Error).message ?? err)}`, 'error'));
  });
  return keyboardSync;
}

/** At a start, a resume or a restore: the entries attached at start that are plugged in go on; those without a grant here are offered one. */
async function attachAtStart(r: Run) {
  await syncKeyboard(r);
  const entries = usbEntries();
  const found = await findDevices(entries);
  for (const e of entries) {
    if (run !== r) return;
    if (!found.has(e.id)) {
      if (!isGranted(identityKey(e))) offer(`allow-${e.id}`, `${deviceName(e)} has no permission in this browser yet (the machine was made in another).`, 'Allow…', () => allowEntry(pageMachine(), e.id));
      continue; // not plugged in: skipped without a word
    }
    if (!e.atStart) continue;
    await attachEntry(e, { quiet: true }).catch((err) => notify(`${deviceName(e)} couldn't be attached: ${String((err as Error).message ?? err)}`, 'error'));
  }
  syncUsb();
}

/** The remembered devices of machine `machine` (undefined: the page's transient one). */
const entriesOf = async (machine: string | undefined) => (machine ? (await store.get('machines', machine))?.usbDevices ?? [] : transientUsb);

/** The browser's grant for entry `id` of machine `machine`, from a click: its chooser, filtered on the entry's device. */
async function allowEntry(machine: string | undefined, id: string) {
  const e = (await entriesOf(machine)).find((x) => x.id === id);
  if (!e) return;
  const devices = await requestDevices(e.api, [filterFor(e)]);
  if (!devices.length) return;
  granted(identityKey(e));
  offers.delete(`allow-${e.id}`);
  if (isCurrent(machine) && usbRunning() && e.atStart) await attachEntry(e);
  syncUsb();
}

/** Remembers `device` (just picked or plugged in) on the page's machine, unless it is already, and attaches it while the machine runs. */
async function rememberAndAttach(api: Api, device: HostDevice, o: { connector?: number; atStart?: boolean } = {}) {
  const identity = await identityOfDevice(api, device);
  granted(identityKey(identity));
  let e = entryOf(usbEntries(), identity);
  if (!e) {
    const added = newEntry(identity, usbEntries(), o);
    await editUsbEntries(pageMachine(), (list) => [...list, added]);
    e = added;
  }
  if (usbRunning()) await attachEntry(e);
}

// A device plugged in with a grant (WebUSB and WebHID say so only for those): an entry attached at start goes on; a
// remembered one not attached at start, or one this machine doesn't remember, is offered; one right after an attached
// device left takes that one's connector (re-enumeration: docs/usb.md "What the browser allows").
for (const api of ['usb', 'hid'] as const) {
  browserApi(api)?.addEventListener('connect', (ev) => void connected(api, ev.device));
  browserApi(api)?.addEventListener('disconnect', () => syncUsb());
}
async function connected(api: Api, device: HostDevice) {
  syncUsb();
  if (!usbRunning()) return;
  const identity = await identityOfDevice(api, device);
  granted(identityKey(identity));
  const name = deviceName(identity);
  const e = entryOf(usbEntries(), identity);
  if (e) {
    if (run?.usb?.connectorOf(e.id) !== -1) return;
    if (e.atStart && !run.usb.connectors[e.connector]) return void attachEntry(e, { quiet: true }).catch((err) => notify(attachFailed(name, err), 'error'));
    return offer(`seen-${identityKey(identity)}`, `${name} was plugged in.`, 'Attach', () => attachEntry(e));
  }
  const back = lastGone && Date.now() - lastGone.at < REENUMERATION_MS ? lastGone : undefined;
  if (back) {
    offers.delete(`gone-${back.connector}`);
    return offer(`seen-${identityKey(identity)}`, `${name} just appeared, where ${back.name} was (connector ${back.connector + 1}).`, 'Attach it there', () => rememberAndAttach(api, device, { connector: back.connector, atStart: back.atStart }));
  }
  offer(`seen-${identityKey(identity)}`, `${name} was plugged in.`, 'Attach and remember', () => rememberAndAttach(api, device));
}

type Unplugged = { connector: number; device: UsbIdentity | UsbVirtual; entry?: string }[];
/**
 * Snapshot and Suspend need the ports empty (docs/usb.md "The page"): with devices attached it asks once, naming them,
 * and detaches them. Returns what was attached (to attach again after), or undefined when the user says no.
 */
async function emptyPorts(r: Run, what: string): Promise<Unplugged | undefined> {
  // The built-in keyboard goes out and back in without a question (the firmware's keyboard; Linux has its own).
  const on = (r.usb?.attached() ?? []).filter((c) => !isKeyboard(c));
  if (!on.length) return r.usb ? r.usb.detachAll() : [];
  const names = on.map((c) => c.name);
  const one = names.length === 1;
  const list = one ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const after = what === 'Suspending' ? 'The ones attached at start are attached again when it resumes.' : 'They are attached again once it is saved.';
  if (!(await ask.confirm(`${what} needs the USB ports empty: ${list} ${one ? 'is' : 'are'} detached first, and the guest sees ${one ? 'it' : 'them'} unplugged: anything in progress with ${one ? 'it' : 'them'} (a copy, a firmware flash) breaks. ${after}`, { title: 'Detach the USB devices?', ok: 'Detach and go on' }))) return undefined;
  return r.usb!.detachAll();
}
/** Attaches again what `emptyPorts` detached (the machine runs on after a snapshot). */
async function plugBack(r: Run, was: Unplugged | undefined) {
  for (const c of was ?? []) {
    if (run !== r || !usbRunning()) return;
    if (isKeyboard(c)) { await syncKeyboard(r); continue; }
    await r.usb!.attach(c.connector, c.device, c.entry).catch((err) => notify(attachFailed(deviceName(c.device), err, ' again'), 'error'));
  }
}

const usbPage = {
  usbAdd: async (machine: string | undefined, api: Api) => {
    const names: string[] = [];
    for (const d of await requestDevices(api)) {
      const identity = await identityOfDevice(api, d);
      granted(identityKey(identity));
      names.push(deviceName(identity));
      const have = await entriesOf(machine);
      if (entryOf(have, identity)) continue;
      const e = newEntry(identity, have);
      await editUsbEntries(machine, (list) => [...list, e]);
      if (isCurrent(machine) && usbRunning()) await attachEntry(e);
    }
    return names;
  },
  usbAttach: async (id: string) => {
    const e = usbEntries().find((x) => x.id === id);
    if (e) await attachEntry(e);
  },
  usbDetach: async (id: string) => {
    const at = run?.usb?.connectorOf(id) ?? -1;
    if (at >= 0) await run!.usb!.detach(at);
  },
  usbEdit: async (machine: string | undefined, id: string, change: Partial<Pick<UsbEntry, 'connector' | 'atStart'>>) => {
    if (change.connector !== undefined && isCurrent(machine) && (run?.usb?.connectorOf(id) ?? -1) >= 0) throw new Error('Detach it first: it is on its connector now.');
    await editUsbEntries(machine, (list) => list.map((e) => (e.id === id ? { ...e, ...change } : e)));
  },
  usbForget: async (machine: string | undefined, id: string) => {
    const e = (await entriesOf(machine)).find((x) => x.id === id);
    if (!e) return;
    if (isCurrent(machine)) await usbPage.usbDetach(id);
    await editUsbEntries(machine, (list) => list.filter((x) => x.id !== id));
    // No other machine remembers it: the browser's grant goes too.
    const key = identityKey(e);
    const others = [...(await store.all('machines')).flatMap((m) => m.usbDevices ?? []), ...transientUsb];
    if (others.some((x) => identityKey(x) === key)) return;
    const d = (await findDevices([e])).get(e.id);
    await d?.forget?.().catch(() => {});
    ungranted(key);
    syncUsb();
  },
  usbAllow: allowEntry,
  usbOffer: (id: string, take: boolean) => {
    const o = offers.get(id);
    offers.delete(id);
    syncUsb();
    if (take && o) void o.run().catch((err) => notify(String((err as Error).message ?? err), 'error')).finally(syncUsb);
  },
  usbStates: async (m: MachineRecord) => entryStates(m.usbDevices ?? [], isCurrent(m.id) ? run?.usb?.attachedEntries() ?? new Set<string>() : new Set<string>(), usbLocks),
  usbZero: async () => {
    const p = run?.usb;
    if (!p || !usbRunning()) throw new Error("The machine isn't running with a USB controller.");
    const at = p.connectors.findIndex((c) => c?.device.api === 'virtual' && c.device.kind === 'gadget-zero');
    if (at >= 0) return p.detach(at);
    const free = p.connectors.findIndex((c, i) => !c && i !== KEYBOARD_CONNECTOR);
    if (free < 0) throw new Error('Every connector is in use.');
    await p.attach(free, { api: 'virtual', kind: 'gadget-zero' });
  },
};
syncUsb();

// What the components ask of the page (web/app/ui.svelte.ts `Page`).
Object.assign(page, {
  restart: () => void restartAsked(),
  suspend: () => void suspend(),
  takeSnapshot: () => void saveSnapshot(),
  saveSnapshotFile: (whole: boolean) => void saveSnapshot({ toFile: true, whole }),
  restoreKept: (id: string) => void restoreKept(id),
  loadSnapshot: (file: File) => void loadSnapshot(file),
  openDiskFile: (file: File, handle?: FileSystemFileHandle) => void chooseDisk({ file, handle }),
  openMachine: (id: string) => { closeMachines(); void switchMachine(id); },
  powerOff: () => exclusively(async () => { await stop(); setState('off'); }),
  powerOffAsked: () => void powerOffAsked(),
  saveDisk: (mode: ExportMode, compress: boolean, target?: { disk: DiskRecord; overlay?: string }) => void saveDisk(mode, compress, target),
  importChanges: (file: File, target?: { machine: MachineRecord; attachment: string }) => void loadChanges(file, target),
  resetDisk: () => void resetDiskAsked(),
  saveSettings,
  applySize: (n: number, r: number, g: '3d' | '2d') => void applySize(n, r, g),
  shapeNow: async (m: MachineRecord) => {
    const disks = new Map((await store.all('disks')).map((d) => [d.id, d]));
    const display = params.get('display') === 'simple' ? 'none' : m.display === '3d' && (!webgl2 || no3d || gpuAsked === '2d') ? '2d' : m.display;
    return currentShape(m, (id) => disks.get(id), { display, cpu: cpuFeatures() });
  },
  setView: (v: View) => setView(v),
  showLog: () => { setView(ui.view === 'screen' ? 'both' : ui.view, false); term.focus(); },
  fullscreen,
  setMouseLock,
  chord: (keys: string[]) => { canvas.focus(); run?.input.chord(...keys); },
  screenSize: () => { fit(); scheduleSize(); },
  openMachines,
  closeMachines,
  dismiss: () => { clearTimeout(messageTimer); note = ''; showMessage('', [], 'warn'); },
  ...usbPage,
  netWizard: (o: NonNullable<typeof ui.netWizard>) => { ui.netWizard = { ...o, tick: (ui.netWizard?.tick ?? 0) + 1 }; },
  netCreate: (n: NewConnection) => net.conns.create(n).then(async (c) => { await net.refresh(); return c; }),
  netAttach,
  netDetach,
  netConnect: async (i: number) => {
    const c = net.views()[i]?.connection;
    if (!c) return;
    try {
      await net.connect(i, c);
    } catch (e) {
      if (!(e instanceof HeldError)) throw e;
      if (await ask.confirm(`${e.message} Use it here instead? That machine disconnects from it.`, { title: 'The connection is in use', ok: 'Use it here' })) await net.takeFrom(i, c);
    }
  },
  netDisconnect: (i: number) => net.disconnect(i),
  netLogout: (i: number) => net.logout(i),
  netExit: (i: number, peer: string) => net.setExitNode(i, peer),
  netEdit: (c: Connection) => net.edit(c),
  netRename: async (c: Connection, name: string) => { await net.conns.put({ ...c, name: name.trim() || c.name }); await net.refresh(); },
  netDelete,
  netNewAddress,
  netHolder: (id: string) => net.locks.holder(connectionLock(id)),
} satisfies typeof page);

// Before starting: what the page can tell won't work.
function boot() {
  // SharedArrayBuffer (the guest's memory, shared by the vCPU workers) needs cross-origin isolation.
  if (!crossOriginIsolated) {
    setState('failed', "This page needs cross-origin isolation for the emulator's shared memory, and it wasn't served with it (the COOP and COEP headers).\nRun `npm start` in the repository and open the URL it prints: its server sends them.");
    ui.cantRun = true;
    return;
  }
  if (storedError) return setState('failed', `This machine can't be opened: ${storedError}.`);
  if (needsDisk()) return waitForDisk();
  if (crashedBefore()) return;
  // Chromium kills a renderer that runs out of memory without an error to catch (PLAN.md §4): judge up front.
  const need = hostMemoryGiB(ramMiB + ramdiskMiB(), ncpus, jitBudget());
  const has = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (has !== undefined && has < need) {
    const fewer = Math.floor((has - hostMemoryGiB(ramMiB, 0, jitBudget())) / (hostMemoryGiB(0, 1) - hostMemoryGiB(0, 0)) + 1e-9);
    setState('idle', `This machine needs about ${need.toFixed(1)} GiB of memory (${ramMiB} MiB of guest RAM plus the emulator, ${ncpus} vCPU${ncpus > 1 ? 's' : ''}), and this device reports ${has} GiB${has >= 8 ? ' (browsers report at most 8, so it may well have more)' : ''}.\nIf memory runs out, the browser closes the tab without warning. Close other tabs and apps first${fewer > 0 && fewer < ncpus ? `, or use fewer vCPUs (?ncpus=${fewer} fits)` : ''}.`, [{ label: 'Start anyway', run: () => void restart() }], 'warn');
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
  // A chunked image's manifest names it (the machine is called that, not `prefetch.json`); the boot reads it again.
  const name = isManifestUrl(url) ? await fetchManifest(url).then((m) => m.name, () => undefined) : undefined;
  chosen = { url, overlay: await diskOverlay({ url }), name };
  syncDiskButtons();
}
boot();
