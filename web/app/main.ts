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
import '@xterm/xterm/css/xterm.css';
import { flushSync, mount } from 'svelte';
import App from './App.svelte';
import { ask } from './ask.svelte.ts';
import { describe, errorText, msg, MsgError, said, t, text, type Described, type Msg, type Said } from '../i18n.ts';
import { devText, fromWire, msgOf } from '../msg.ts';
import { guestWords } from './guest-words.ts';
import { clockSync, leaveWarning, remember, settings } from './settings.ts';
import { page, ui, type Action, type MachinesTab, type PageState, type View } from './ui.svelte.ts';
import type { DisplayToPage } from '../gpu-present.ts';
import type { FromGpuWorker, ToGpuWorker } from '../gpu-worker.ts';
import type { ShareMode } from '../venus-share.ts';
import { attachInput, type Input, type LockMode } from '../input.ts';
import { PageAudio } from '../audio.ts';
import { opfsDir, overlayBytes, removeOverlay } from '../overlay.ts';
import { changesHeader as readChangesHeader } from '../qcow2.ts';
import { openSnapshot, SnapshotError, type SnapshotHeader } from '../snapshot-file.ts';
import { ALIVE_EVERY_MS, clearAlive, lastCrash, markAlive, Signal } from './memory.ts';
import { graphics, metrics, shows, type Graphics, type Sample } from './statusbar.ts';
import { defaultCpus, diskOverlay, hostMemoryGiB, JIT_DEFAULT_MIB, MACHINES, RAM_CHOICES, ramSplitError, type DiskChoice, type Machine, type MachineName } from './machine.ts';
import { fetchManifest, isManifestUrl } from '../chunked.ts';
import { runExport, type ExportMode } from './export.ts';
import { runImport } from './import.ts';
import { HeldError, PageNetwork } from './net-live.ts';
import { connectionLock, migrateLegacy, type Connection, type NewConnection } from './connections.ts';
import { createFolder, type Folder, type NewFolder } from './folders.ts';
import { PageFolders } from './folders-live.ts';
import { DEFAULT_SHARES_PATH } from './shares-mount.ts';
import { swapLabel } from './guest-swap.ts';
import { CLOSE_MS } from '../devices.ts';
import { forgetTailcatIdentity, hasTailcatIdentity, newTailcatIdentity } from '../tailcat.ts';
import { forgetProfile, keptProfiles } from '../tailscale-state.ts';
import type { FromWorker, Problem, StartDisk, Status, ToWorker } from './protocol.ts';
import { adaptersOf, CPU_FEATURES, DEFAULT_MAC, KEYBOARD_CONNECTOR, newId, serialOf, shapeDiff, USB_CONNECTORS, type DiskRecord, type FolderAttachment, type MachineRecord, type Shape, type UsbEntry } from './shape.ts';
import { deviceName, entryOf, errorLines, identityKey, identityOf as usbIdentity, newEntry, problemText, usbLock } from './usb-ports.ts';
import { browserApi, entryStates, filterFor, findDevices, granted, identityOfDevice, isGranted, requestDevices, ungranted, UsbError, UsbHeldError, UsbLocks, UsbPorts, type Api, type HostDevice } from './usb-live.ts';
import type { UsbIdentity, UsbVirtual } from '../usb-device.ts';
import { currentShape, planRestore } from './snapshots.ts';
import { hashFile } from './definitions.ts';
import type { DiskPlan, SnapshotDisk } from '../snapshot.ts';
import { diskDir, overlayDir, machineDir, snapshotPath, Store } from './store.ts';
import { deleteOverlay, diskSource, identityOf, loadChangesInto, refreshOverlay, refreshStored, switchOverlay } from './disks.ts';
import { askPersist, attach, createDisk, createMachine, detachEverywhere, isRunning, knownDisk, machineLock, setAdapterConnection, updateMachine } from './machines.ts';
import { keyboardSetting, resolveKeyboard } from './keyboard.ts';
import { parseLocalURL } from '../local-net.ts';
import { installCopyEdit } from './copy-edit.ts';
import { keyOf, type Mods } from './osk.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
// The commit the page was built from (tools/stamp.ts `buildStamp`), for reports of what a user ran.
const build = document.querySelector('meta[name="webpc-build"]')?.getAttribute('content');
if (build) console.info(`webpc: built from ${build}`);
// A machine kept in this browser (docs/machines.md), by id: `?m=<id>`. It is the page's machine (`uefi`) with its own
// vCPUs, RAM, display and disks. Without one the machine is transient, made from the query (the tests' `?machine=`).
const store = await Store.open();
/** Why the stored machine `?m=` names can't be opened (an error the page shows), if it can't. */
let storedError: unknown;
/** The machine last opened on this page (in this browser): opened again by a page without a query. */
const LAST = 'webpc.machine';
const lastMachine = () => { try { return localStorage.getItem(LAST) ?? undefined; } catch { return undefined; } };
const chosenId = params.get('m') ?? (location.search ? undefined : lastMachine());
let stored = chosenId ? await loadStored(chosenId).catch((e) => { if (params.get('m')) storedError = e; return undefined; }) : undefined;
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
function machineTitle() {
  if (stored) return stored.record.name;
  if (chosen?.name) return chosen.name;
  const disk = diskName();
  return disk ? t('machine:main.title.disk', { machine: spec.title, disk }) : needsDisk() ? t('machine:main.title.noDisk', { machine: spec.title }) : text(spec.title);
}

/** A stored machine and its disks' records; refused (an error the page shows) when one of them is missing. */
async function loadStored(id: string) {
  const record = await store.get('machines', id);
  if (!record) throw new MsgError('machine:main.noMachine', { id });
  const disks = new Map<string, DiskRecord>();
  for (const a of record.attachments) {
    const d = await store.get('disks', a.disk);
    if (!d) throw new MsgError('machine:main.noDisk', { name: record.name, id: a.disk });
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
    super(`${disks.map((d) => d.name).join(', ')}: no permission in this session`);
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
    const file = await pickFile(t('disks:main.pickAgain', { name: d.name }));
    if (!file) return false;
    const want = d.identity as { name?: string; bytes?: number; modified?: number };
    // Another name, size or date: the same bytes by the hash, where the disk has one (a definition's: machines.md §6).
    const differs = file.name !== want.name || file.size !== want.bytes || file.lastModified !== want.modified;
    if (differs && d.sha256 && file.size === want.bytes && (await hashFile(file)) === d.sha256) {
      pickedFiles.set(d.id, file);
      continue;
    }
    if (differs) {
      if (!(await ask.confirm(t('disks:main.otherFile', { file: file.name, name: want.name, bytes: want.bytes, when: new Date(want.modified ?? 0) }), { title: t('disks:main.otherFile.title'), ok: t('disks:main.otherFile.ok'), danger: true }))) return false;
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
    await store.put('overlays', { id: a.overlay, name: t('disks:main.overlayName'), disk: d.id, identity: d.identity, generation: 0, bytes: 0, created: now, modified: now });
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
    // Swap ramdisks are labelled in slot order (web/app/guest-swap.ts).
    const swaps = s.record.attachments.filter((a) => a.swap && s.disks.get(a.disk)!.kind === 'ramdisk').map((a) => a.id);
    const disks = await Promise.all(s.record.attachments.map(async (a): Promise<StartDisk> => {
      const d = s.disks.get(a.disk)!;
      const base = { name: d.name, serial: serialOf(a.id), identity: identityOf(d) };
      if (d.kind === 'ramdisk' && swaps.includes(a.id)) return { ...base, source: { ramdisk: d.size, swap: swapLabel(swaps.indexOf(a.id)) } };
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
  if (disk2) disks.push({ name: new URL(disk2, location.href).pathname.split('/').pop() ?? 'disk2', source: { url: new URL(disk2, location.href).href } }); // the page's, not the worker's (its bundle is under assets/)
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
/** The page's CPU features (`?rng=0`, `?e0pd=0`, `?sha3=0`, `?jscvt=0`, `?rcpc=0`, `?sb=0`, `?flagm=0`, `?dit=0`, `?frintts=0`, `?dotprod=0` turn one off: development). */
const cpuFeatures = () => CPU_FEATURES.filter((f) => params.get(f) !== '0');
/**
 * A stored machine as its snapshots describe it (protocol.ts `about`): its shape as it runs now (`three`: with 3D) and
 * its URL disks' URLs by slot.
 */
async function aboutMachine(three = want3d && !no3d) {
  const s = stored;
  if (!s) return undefined;
  const display = params.get('display') === 'simple' ? 'none' : three ? '3d' : '2d';
  const { shape, hash } = await currentShape(s.record, (id) => s.disks.get(id), { display, cpu: cpuFeatures(), vulkan: three && wantsVulkan() });
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
  kept: keptProfiles,
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
const folders = new PageFolders({ store, me: () => machineTitle(), onChange: () => { ui.folders.on = folders.running; ui.folders.tick++; } });
void folders.refresh();

// The local helper's pairing link (net/webpc-net prints `https://vm.tny.im/#net=ws://127.0.0.1:<port>/<token>`): the
// fragment never reached a server; it leaves the address at once (it holds the token) and opens the Network wizard on
// it, attaching to the page's machine's first adapter when there's one.
{
  const pairing = new URLSearchParams(location.hash.slice(1)).get('net');
  if (pairing) {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    const p = parseLocalURL(pairing);
    if ('url' in p) ui.netWizard = ui.current ? { mode: 'attach', machine: ui.current, adapter: 0, localURL: p.url, tick: 1 } : { mode: 'new', localURL: p.url, tick: 1 };
    else console.warn(`#net: ${devText(p.error)}`);
  }
}
store.onChange((c) => {
  ui.records++;
  void net.refresh();
  void folders.refresh();
  if (c.kind === 'machines' && c.id === stored?.record.id) void followRecord();
});
mount(App, { target: document.body, props: { store, audio, net, folders } });
installCopyEdit();
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
/** `asleep`: the guest has suspended itself (`Status.asleep`): a key or a click wakes it. */
type Run = { worker: Worker; input: Input; serial: MessagePort; display: MessagePort; gpu?: Worker; usb?: UsbPorts; usbStarted?: boolean; asleep?: boolean };

/**
 * The clock catch-up (Preferences, `?clocksync=`; docs/frontend.md "The guest's clock"): before a snapshot the guest's
 * sleep key is pressed, so it suspends itself and its own resume counts the time the file sat. Whether it was pressed.
 */
function sleepFirst(r: Run) {
  if (!clockSync()) return false;
  r.input.chord('Sleep');
  return true;
}

/** A key or a click for a guest that sleeps: it wakes (as a machine does on its keyboard), and the input goes on to it. */
function wakeOnInput() {
  if (!run?.asleep) return;
  run.asleep = false;
  run.worker.postMessage({ type: 'wake' } satisfies ToWorker);
}

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
/** `window.__webpcGrab()`: the 3D screen as the page draws it, read back in the GPU worker (RGBA, top row first): bench/vulkan/present.ts
 * (a Playwright screenshot waits for a compositor frame, which SwiftShader's busy GPU process may not give for minutes). */
const grabs = new Map<number, (g: { width: number; height: number; pixels: Uint8Array }) => void>();
if (benchHooks) (window as unknown as { __webpcGrab?: () => Promise<unknown> }).__webpcGrab = () => new Promise((resolve) => {
  const id = grabs.size + Math.random();
  grabs.set(id, resolve);
  if (run?.gpu) run.gpu.postMessage({ type: 'grab', id } satisfies ToGpuWorker);
  else resolve({ width: 0, height: 0, pixels: new Uint8Array(0) });
});
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
/** Vulkan through Venus beside 3D (docs/devices.md "Venus"): a stored machine's setting (the Machines page), or `?gpu=vulkan`. */
const wantsVulkan = () => gpuKnobs.includes('vulkan') || !!stored?.record.vulkan;
let want3d = wants3d();
let no3d: string | undefined;
const hasWebgl2 = () => { try { return !!new OffscreenCanvas(1, 1).getContext('webgl2'); } catch { return false; } };
const webgl2 = hasWebgl2();
if (want3d && !webgl2) no3d = 'this browser has no WebGL2';
let run: Run | undefined;
/** The guest has a driver on its keyboard (else the screen's keys go to the serial console: the firmware, GRUB). Per machine; false until the worker says. */
let keyboardLive = false;
let state: PageState = 'loading';
let last: Sample | undefined;
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
let note: Said = '';
/** A message that clears itself (`notify`), until then. */
let messageTimer: ReturnType<typeof setTimeout> | undefined;
/** Shows `message` in the message bar: its headline, and its details under it (an error's causes). */
const showMessage = (message: Said | undefined, actions: Action[], kind: 'error' | 'warn') => {
  clearTimeout(messageTimer);
  const d = said(message);
  ui.message = d.headline;
  ui.messageDetails = d.details;
  ui.messageKind = kind;
  ui.actions = actions;
};

/** The state's words (the status bar's state), by state. */
const STATE_WORDS: Record<PageState, string> = {
  idle: 'machine:main.state.idle',
  loading: 'machine:main.state.loading',
  booting: 'machine:main.state.booting',
  running: 'machine:main.state.running',
  off: 'machine:main.state.off',
  suspended: 'machine:main.state.suspended',
  rebooting: 'machine:main.state.rebooting',
  crashed: 'machine:main.state.crashed',
  failed: 'machine:main.state.failed',
};
function setState(s: PageState, message?: Said, actions: Action[] = [], kind: 'error' | 'warn' = 'error') {
  state = s;
  ui.state = s;
  ui.stateText = t(STATE_WORDS[s]);
  document.body.dataset.state = s;
  showMessage(message ?? note, actions, message ? kind : 'warn');
  ui.boot.shown = (s === 'loading' || s === 'booting') && !ui.boot.done;
  ui.boot.serial = !!spec.firmware && s === 'booting';
  ui.usb.running = !!run?.usb && (s === 'running' || s === 'booting');
  // Stopped with no start to follow: a restart doesn't pass here (its clients stay, on the new machine's ports).
  if (s === 'off' || s === 'suspended' || s === 'crashed' || s === 'failed' || s === 'idle') net.machineOff();
  syncButtons();
}
/** What happened, said while the machine stays as it is (a snapshot saved, or not): the message bar clears itself after 30 s. */
const NOTICE_MS = 30_000;
function notify(message: Said, kind: 'error' | 'warn' = 'warn') {
  showMessage(message, [], kind);
  const shown = ui.message;
  messageTimer = setTimeout(() => { if (ui.message === shown) showMessage(note, [], 'warn'); }, NOTICE_MS);
}
/** The state's words for a while (a phase, a progress), until the next state. */
const stateText = (m: Msg) => { ui.stateText = text(m); };
/** A job's phase (words already rendered, or a message) and how far it is, for the state's words. */
const progressText = (phase: string | Msg, f: number) => msg('machine:main.progress', { phase, percent: Math.floor(100 * f) });
/** An error's words with a line said after its headline (what the page did about it), its causes under them. */
function withNote(e: unknown, note: string): Described {
  const d = describe(e);
  return { headline: `${d.headline}\n${note}`, details: d.details };
}
/** Words a USB device's error adds under a headline (web/app/usb-ports.ts `errorLines`: its own, then its problems'). */
const usbDetails = (headline: string, err: unknown): Described => ({ headline, details: errorLines(err).split('\n') });
/** Whether error `e` (or a cause of it) is a disk's overlay another tab has open (web/overlay.ts `problem`, the browser's lock). */
function inUse(e: unknown) {
  for (let c = e, i = 0; c instanceof Error && i < 8; c = c.cause, i++) {
    if ((c as { problem?: string }).problem === 'overlay-in-use' || c.name === 'NoModificationAllowedError') return true;
  }
  return false;
}

// What a user can do about each problem (the worker's message says what happened and why).
const retry: Action = { label: t('machine:main.retry'), run: () => void restart() };
const showLog: Action = { label: t('machine:main.showLog'), run: () => { setView(ui.view === 'screen' ? 'both' : ui.view, false); term.scrollToBottom(); } };
const copyLog: Action = {
  label: t('machine:main.copyLog'),
  run: (b) => navigator.clipboard.writeText(log).then(() => { b.textContent = t('machine:main.copyLog.copied'); }, () => { b.textContent = t('machine:main.copyLog.failed'); }),
};
const saveLog: Action = {
  label: t('machine:main.saveLog'),
  run: () => {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([log], { type: 'text/plain' })), download: `webpc-${machine}-serial-${new Date().toISOString().replace(/[:.]/g, '-')}.log` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  },
};
/** A disk that isn't the one its changes were made over: a stored machine's disks are on the Machines page (a new empty overlay); a transient machine's is reset. */
const resetDisk: Action = { get label() { return stored ? t('disks:main.disks') : t('disks:main.resetDisk'); }, run: () => (stored ? openMachines('disks', stored.record.id) : void resetDiskAsked()) };
const startNormally: Action = { label: t('snapshots:main.startNormally'), run: () => void restart() };
const resumeAction: Action = { label: t('machine:main.resume'), run: () => void restart() };
const bootInstead: Action = { label: t('machine:main.bootInstead'), run: () => void ask.confirm(t('machine:main.bootInstead.confirm'), { ok: t('machine:main.bootInstead.ok'), danger: true }).then((yes) => { if (yes) void restart(false); }) };
const loadAgain: Action = { label: t('snapshots:main.loadAgain'), run: () => loadSnapshotInput.click() };
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
    if (e.data.type === 'screen-stats') { showGraphics(e.data.screen, e.data); return; }
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
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  // A machine's network adapters are there from the start (one can't be added later without a restart): their ends of
  // the IP ports, whose other ends the page's network has (web/app/net-live.ts: the clients of their connections).
  const nets = net.ports(netKey(), pageAdapters());
  ui.hasNetwork = nets.length > 0;
  const [kbd, tablet, serial] = [new MessageChannel(), new MessageChannel(), new MessageChannel()];
  const sound = audio.attach();
  // A machine with a USB controller: the port its devices are attached over (docs/usb.md "The page").
  const usb = usbOn() ? new MessageChannel() : undefined;
  // A machine with shared folders: the port what's attached while it runs goes over (docs/shares.md).
  const shares = stored?.record.shares ? new MessageChannel() : undefined;
  // A relative mouse (the pointer while the screen holds the mouse) and a touchscreen, on machines that have them.
  const mouse = pointerOn('mouse') ? new MessageChannel() : undefined;
  const touch = pointerOn('touch') ? new MessageChannel() : undefined;
  const locked = (on: boolean) => { ui.mouseLocked = on; placeCursor(); };
  const input = attachInput(canvas, kbd.port1, tablet.port1, { live: () => keyboardLive, send: (d) => term.input(d, true), usb: keyboardKey }, { mouse: mouse?.port1, touch: touch?.port1, locked });
  input.mouseLock(ui.mouseLock, ui.mouseLockMode);
  input.onRelease(() => { ui.keysReleased++; });
  ui.hasMouse = !!mouse;
  canvas.addEventListener('keydown', wakeOnInput);
  canvas.addEventListener('pointerdown', wakeOnInput);
  const r: Run = { worker, input, serial: serial.port1, display: display.port1, usb: usb && usbPorts(usb.port1) };
  run = r;
  keyboardLive = false;
  last = undefined;
  log = lastLine = '';
  ui.boot.done = false;
  ui.boot.line = '';
  ui.boot.progress = undefined; // indeterminate until the sizes are known
  ui.boot.title = snapshot ? t('machine:main.boot.loading', { name: snapshot.name }) : t('machine:main.boot.starting', { machine: spec.title });
  setState('loading');
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    if (run !== r) return;
    const m = e.data;
    if (m.type === 'state') {
      if (m.state === 'suspended') {
        saving = false;
        snapshotJob = undefined;
      }
      // A message without a problem is a note (resumed, suspended, a suspended copy that couldn't be resumed), not an error.
      setState(m.state, m.error ?? m.note, m.problem ? ACTIONS[m.problem] : m.state === 'suspended' ? [resumeAction, bootInstead] : [], m.problem || m.state === 'crashed' || m.state === 'failed' ? 'error' : 'warn');
      if (m.state === 'booting') {
        ui.boot.title = t('machine:main.boot.booting', { machine: spec.title });
        ui.boot.progress = undefined;
        ui.boot.line = t('machine:main.boot.kernel'); // then its lines, until its console takes the screen (~2 s on Debian)
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
        folders.end();
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
      if (m.status.asleep && !r.asleep && !saving) notify(msg('machine:main.asleep'));
      r.asleep = !!m.status.asleep;
      showStatus(m.status, alive(m.status));
      if (benchHooks) (window as unknown as { __status?: Status }).__status = m.status;
    } else if (m.type === 'profile') {
      (window as unknown as { __profile?: [string, number][] }).__profile = m.samples;
    } else if (m.type === 'timeline') {
      (window as unknown as { __timeline?: unknown }).__timeline = m.timeline;
    } else if (m.type === 'heap') {
      (window as unknown as { __heap?: unknown }).__heap = m.heap;
    } else if (m.type === 'phase') {
      ui.boot.line = text(m.text);
      ui.boot.progress = undefined;
      if (state === 'loading') stateText(m.text);
    } else if (m.type === 'snapshot-progress') {
      snapshotJob?.progress(m.phase, m.fraction);
    } else if (m.type === 'snapshot-chunk') {
      snapshotJob?.chunk(m.data);
    } else if (m.type === 'snapshot-done') {
      snapshotJob?.done(m);
    } else if (m.type === 'snapshot-error') {
      snapshotJob?.error(fromWire(m.error));
    } else if (m.type === 'progress') {
      if (m.total) ui.boot.progress = m.loaded / m.total;
      ui.boot.line = m.total ? t('machine:main.boot.downloading', { loaded: m.loaded, total: m.total }) : t('machine:main.boot.downloaded', { loaded: m.loaded });
      if (state === 'loading') stateText(m.total ? msg('machine:main.state.loadingPercent', { percent: Math.floor((100 * m.loaded) / m.total) }) : msg('machine:main.state.loading'));
    } else if (m.type === 'screen' && !spec.firmware) {
      // The guest's console has the screen: it shows the boot from here. (Through the firmware the
      // screen stays black until a getty: the boot's output, menus and a first boot's questions are on the serial console.)
      ui.boot.done = true;
      ui.boot.shown = false;
    }
  };
  worker.onerror = (e) => {
    if (run !== r) return;
    const error = new MsgError('machine:main.workerFailed', {}, { cause: new Error(e.message) });
    snapshotJob?.error(error);
    setState('crashed', error, ACTIONS.emulator);
  };
  const begin = async (three?: { renderer: MessagePort; caps: Uint8Array }) => {
    if (run !== r) return;
    let disks: StartDisk[];
    let home: string | undefined;
    let about: Awaited<ReturnType<typeof aboutMachine>>;
    if (!(await holdLock())) {
      if (run !== r) return;
      setState('failed', msg('machine:main.runsElsewhere', { name: stored!.record.name }), [retry]);
      return;
    }
    if (run !== r) return dropLock();
    try {
      const needs = stored ? await filesNeedingUser(stored) : [];
      if (needs.length) throw new NeedsUser(needs);
      ({ disks, home } = await startDisks());
      ui.status.disks = disks.map((d) => d.name);
      about = await aboutMachine(!!three);
    } catch (e) {
      if (run !== r) return;
      dropLock();
      if (e instanceof NeedsUser) {
        const needs = e.disks;
        setState('idle', msg('disks:main.needsUser', { count: needs.length, names: needs.map((d) => d.name) }), [{ label: needs.some((d) => d.handle) ? t('disks:main.allowAndStart') : t('disks:main.pickAndStart'), run: () => void grantFiles(needs).then((ok) => { if (ok) void restart(); }) }], 'warn');
      } else setState('failed', new MsgError('disks:main.notOpened', {}, { cause: e }), [retry]);
      return;
    }
    if (run !== r) return;
    const list = shares ? await folders.begin(stored!.record, shares.port1) : undefined;
    ui.folders.path = stored ? sharesPath(stored.record) ?? '' : '';
    if (run !== r) return folders.end();
    if (folders.views().some((v) => v.problem)) ui.folders.wanted = true; // Allow access…, Use it here
    const s = three ? undefined : screen;
    if (hasGpu) document.body.dataset.graphics = three ? '3d' : '2d'; // for tests
    const startLayout = await resolveKeyboard(keyboardSetting(params.get('keyboard'), stored?.record, params.has('machine')));
    worker.postMessage({ type: 'start', query: location.search, machine, ncpus, ramMiB, ramSplit, jitMiB: jitMiB || undefined, keyLayout: startLayout?.id, netConfig: (params.get('netconfig') ?? (stored?.record.netConfig === false ? '0' : '1')) !== '0', disks, home, keyboard: kbd.port2, tablet: tablet.port2, serial: serial.port2, screen: s, display: display.port2, size: hasGpu ? size : undefined, simple: params.get('display') === 'simple' || undefined, displayStats: params.has('displaystats') || undefined, ioStats: params.has('iostats') || undefined, noDiskCache: params.get('diskcache') === '0' || undefined, avProbe: params.has('avprobe') || undefined, cpu: { rng: params.get('rng') !== '0', e0pd: params.get('e0pd') !== '0', sha3: params.get('sha3') !== '0', jscvt: params.get('jscvt') !== '0', rcpc: params.get('rcpc') !== '0', sb: params.get('sb') !== '0', flagm: params.get('flagm') !== '0', dit: params.get('dit') !== '0', frintts: params.get('frintts') !== '0', dotprod: params.get('dotprod') !== '0' }, params: params.get('params') ?? undefined, credentials, guest: guestWords(startLayout), nets, usb: usb?.port2, mouse: mouse?.port2, touch: touch?.port2, folders: shares && { list: list!, port: shares.port2 }, sharesPath: shares ? sharesPath(stored!.record) : undefined, clock: stored ? !!stored.record.clock : params.get('clock') !== '0', sound, snapshot, resume, about, plan, ...three, vulkan: three && wantsVulkan() ? true : undefined } satisfies ToWorker, [kbd.port2, tablet.port2, serial.port2, display.port2, sound.port, ...(s ? [s] : []), ...(three ? [three.renderer] : []), ...nets.map((n) => n.ip), ...(usb ? [usb.port2] : []), ...(shares ? [shares.port2] : []), ...(mouse ? [mouse.port2] : []), ...(touch ? [touch.port2] : [])]);
  };
  if (want3d && !no3d) {
    // The GPU worker gets the canvas and says what it backs; the machine starts with those caps.
    const gpu = new Worker(new URL('../gpu-worker.ts', import.meta.url), { type: 'module' });
    r.gpu = gpu;
    const channel = new MessageChannel();
    gpu.postMessage({ type: 'init', canvas: screen, port: channel.port1, stats: params.has('displaystats'), debug: gpuKnobs.includes('debug'), probe: params.has('avprobe'), video: !gpuKnobs.includes('novideo'), softwareVideo: gpuKnobs.includes('swvideo'), waitAttached: gpuKnobs.includes('waitattached'), vkShare: (['readback', 'canvas', 'bitmap'] as const).find((w) => gpuKnobs.includes(`vk${w}`)), vkBreak: gpuKnobs.filter((k) => k.startsWith('vkbreak=')).map((k) => k.slice(8) as ShareMode), vkVendor: gpuKnobs.find((k) => k.startsWith('vkvendor='))?.slice(9), vkPoll: gpuKnobs.includes('vkpoll=timeout') ? 'timeout' : gpuKnobs.includes('vkpoll=pump') ? 'pump' : undefined, vkSyncPipelines: gpuKnobs.includes('vkpipelines=sync'), vkPipeDelayMs: ((k) => (k ? Number(k.slice(12)) : undefined))(gpuKnobs.find((k) => k.startsWith('vkpipedelay='))), vkNoCache: gpuKnobs.includes('vkcache=off'), vkNudgeMs: ((k) => (k ? Number(k.slice(8)) : undefined))(gpuKnobs.find((k) => k.startsWith('vknudge='))), vkGpuTime: gpuKnobs.includes('vkgputime'), vkTickMs: ((k) => (k ? Number(k.slice(7)) : undefined))(gpuKnobs.find((k) => k.startsWith('vktick='))), vkIdleMs: ((k) => (k ? Number(k.slice(7)) : undefined))(gpuKnobs.find((k) => k.startsWith('vkidle='))), vkHold: gpuKnobs.filter((k) => k.startsWith('vkhold=')).map((k) => k.slice(7)), vkHeldFormats: gpuKnobs.includes('vkformats=held'), vkYcbcr: !gpuKnobs.includes('vkycbcr=off'), vkL9: gpuKnobs.filter((k) => k.startsWith('vkl9=')).map((k) => k.slice(5)) } satisfies ToGpuWorker, [screen, channel.port1]);
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
      } else if (m.type === 'stats') {
        showGraphics('3d', m);
      } else if (m.type === 'lost') {
        setState('crashed', msg('display:main.webglLost'), ACTIONS.emulator);
      } else if (m.type === 'snapshotBytes') {
        bytesAsked.get(m.id)?.(m.bytes);
        bytesAsked.delete(m.id);
      } else if (m.type === 'render-stats') {
        ((window as unknown as { __renderStats?: unknown[] }).__renderStats ??= []).push(m);
        ((window as unknown as { __presents?: number[] }).__presents ??= []).push(...m.presentAt);
      }
      else if (m.type === 'flash') flashed(m.t);
      else if (m.type === 'grab') {
        grabs.get(m.id)?.(m);
        grabs.delete(m.id);
      }
    };
    gpu.onerror = (e) => {
      if (run !== r) return;
      setState('crashed', new MsgError('display:main.gpuWorkerFailed', {}, { cause: new Error(e.message) }), ACTIONS.emulator);
    };
  } else void begin();
  if (nets.length) void net.autoconnect();
  ui.net++;
}

/**
 * While a stored machine runs on this page, its Web Lock is held (machines.ts `machineLock`): the Machines page, in any
 * tab, sees it running. It's taken before the machine's disks are opened, and only if it's free: false when another
 * tab holds it (the machine runs there), said at once instead of after the overlay's wait (`OVERLAY_WAIT_MS`).
 */
let releaseLock: (() => void) | undefined;
/** Settles once the lock this page last held is released (a restart's next take waits for it, or it'd find its own). */
let lockReleased: Promise<unknown> = Promise.resolve();
async function holdLock() {
  if (!stored || releaseLock) return true;
  await lockReleased;
  const got = await new Promise<boolean>((answer) => {
    lockReleased = navigator.locks.request(machineLock(stored!.record.id), { ifAvailable: true }, (lock) => {
      if (!lock) return answer(false);
      answer(true);
      return new Promise<void>((resolve) => { releaseLock = resolve; });
    }).catch(() => answer(false));
  });
  return got;
}
function dropLock() {
  releaseLock?.();
  releaseLock = undefined;
}

/** Stops the machine, if any: its worker releases the disk overlay and lands what its folders hold first (or gets 4 s to). */
async function stop() {
  const r = run;
  run = undefined;
  if (!r) return;
  clearAlive(aliveKey());
  r.input.detach();
  audio.detach();
  r.usb?.close();
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, CLOSE_MS + 1500);
    r.worker.onmessage = (e: MessageEvent<FromWorker>) => { if (e.data.type === 'stopped') { clearTimeout(t); resolve(); } };
    r.worker.postMessage({ type: 'stop' } satisfies ToWorker);
  });
  r.worker.terminate();
  r.gpu?.terminate();
  dropLock();
  folders.end();
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
  if (saving) void ask.alert(t('snapshots:main.busy'));
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
    setState('failed', new MsgError('machine:main.cantOpen', {}, { cause: e }), [{ label: t('machine:main.machines'), run: () => openMachines() }]);
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
  if ((state === 'running' || state === 'booting') && !(await ask.confirm(t('machine:main.restart.confirm'), { title: t('machine:main.restart.title'), ok: t('machine:main.restart.ok'), danger: true }))) return;
  void restart();
}
/** The toolbar's Power off: the machine stops at once, after asking. */
async function powerOffAsked() {
  if (!(state === 'running' || state === 'booting')) return;
  if (!(await ask.confirm(t('machine:main.powerOff.confirm'), { title: t('machine:main.powerOff.title'), ok: t('machine:main.powerOff.ok'), danger: true }))) return;
  await exclusively(async () => { await stop(); setState('off'); });
}

/** What the page shows of the machine and its disk: its name, Suspend (only with a disk the page keeps changes to), a transient machine's entry on the Machines page. */
function syncDiskButtons() {
  ui.title = machineTitle();
  ui.hasOverlay = !!overlayName();
  ui.transient = !stored && !needsDisk() ? { label: text(spec.title), disk: baseName() } : undefined;
}
/** No disk yet: say how to bring one, and start nothing. */
function waitForDisk() {
  if (stored) return setState('idle', msg('disks:main.noDisks', { name: stored.record.name }), [{ label: t('disks:main.disks'), run: () => openMachines('disks', stored!.record.id) }], 'warn');
  setState('idle', msg('machine:main.openDisk.prompt'), [{ label: t('machine:main.openDisk'), run: () => void openDisk() }], 'warn');
}

// The disk reset (M8 decision 4): stop the machine (its overlay's files are locked while it runs), delete the overlay, start again.
async function resetDiskAsked() {
  const name = overlayName();
  if (!name || busy()) return;
  const written = await overlayBytes(name).catch(() => 0);
  const disk = chosen || stored ? msg('disks:main.theDisk', { name: diskName() }) : msg('disks:main.machineDisk', { machine: spec.title });
  const question = written ? t('disks:main.reset.confirm.size', { disk, size: written }) : t('disks:main.reset.confirm', { disk });
  if (!(await ask.confirm(question, { title: t('disks:main.reset.title'), ok: t('disks:main.reset.ok'), danger: true }))) return;
  await exclusively(async () => {
    await stop();
    term.reset();
    setState('loading');
    stateText(msg('disks:main.resetting'));
    try {
      const a = bootAttachment();
      if (stored && a?.overlay) {
        await deleteOverlay(store, a.overlay); // its record, then its files: the next start makes an empty one
        stored.record = (await store.get('machines', stored.record.id)) ?? stored.record;
      } else if (!stored) await removeOverlay(name); // once the machine's device worker has closed it
    } catch (e) {
      setState('failed', new MsgError('disks:main.reset.failed', {}, { cause: e }), [resetDisk, retry]);
      return;
    }
    start();
  });
}

// Your own disk: a local file (raw or qcow2, by its magic), by the picker or dropped on the page. The machine restarts on it; the
// disk's changes are kept in the browser per file (name, size, modification time), so choosing it again continues where it left off.
const openDiskInput = $<HTMLInputElement>('open-disk-input');
/**
 * Open disk… (the first-run message's, the Machines page's From a disk image…): the browser's file picker where it has
 * one, so the machine keeps the file's handle (a reload's resume asks only to allow it, not to pick the file again), as
 * a drop and the Add disk wizard do; else the plain input.
 */
async function openDisk() {
  const picker = (window as unknown as { showOpenFilePicker?: () => Promise<FileSystemFileHandle[]> }).showOpenFilePicker;
  if (!picker) return openDiskInput.click();
  let handle: FileSystemFileHandle;
  try {
    [handle] = await picker.call(window);
  } catch (e) {
    if ((e as DOMException).name !== 'AbortError') notify(new MsgError('disks:main.openFailed', {}, { cause: e }), 'error');
    return;
  }
  await chooseDisk({ file: await handle.getFile(), handle });
}

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
  if ((state === 'running' || state === 'booting') && stored?.record.id !== id && !(await ask.confirm(t('machine:main.switch.confirm'), { title: t('machine:main.switch.title'), ok: t('machine:main.switch.ok'), danger: true }))) return;
  await exclusively(async () => {
    await stop();
    net.machineOff();
    const next = await loadStored(id);
    stored = next;
    storedError = undefined;
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
    if (!overlayName()) return void ask.alert(t('disks:main.changes.noDisk', { name: choice.file.name }));
    await loadChanges(choice.file);
    return;
  }
  if (!spec.firmware) return; // only a machine that boots through UEFI takes a disk of its own (the test guests' kernels are their own)
  // The page's own machine: a file opened or dropped is a machine of its own, kept in this browser (machines.md §2).
  if ('file' in choice && machine === 'uefi' && !params.has('machine')) return machineForFile(choice.file, choice.handle);
  const next: DiskChoice = { ...choice, overlay: await diskOverlay(choice) };
  if ((state === 'running' || state === 'booting') && !(await ask.confirm(t('disks:main.boot.confirm', { name: next.file?.name ?? next.url }), { ok: t('disks:main.boot.ok'), danger: true }))) return;
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
  if (m && !here && (await isRunning(m.id))) return void ask.alert(t('disks:main.changes.runsElsewhere', { name: m.name }));
  const info = await changesHeader(file);
  if (!info) return void ask.alert(t('disks:main.changes.notChanges', { name: file.name }));
  if (!info.hash) return void ask.alert(t('disks:main.changes.noHash', { name: file.name, backing: info.backingName }));
  const written = !m && overlay ? await overlayBytes(overlay).catch(() => 0) : 0;
  const running = here && (state === 'running' || state === 'booting');
  const onto = chosen ? diskName() : msg('disks:main.machineDisk', { machine: spec.title });
  const into = m ? msg('disks:main.changes.intoOverlay', { disk: disk!.name }) : written ? msg('disks:main.changes.replace.size', { disk: onto, size: written }) : msg('disks:main.changes.replace', { disk: onto });
  const question = running ? t('disks:main.changes.confirm.running', { name: file.name, into }) : t('disks:main.changes.confirm', { name: file.name, into });
  if (!(await ask.confirm(question, { title: t('disks:main.changes.title'), ok: t('disks:main.changes.ok'), danger: running || !m }))) return;
  const progress = (phase: string, f: number) => stateText(progressText(phase, f));
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
      notify(msg('disks:main.changes.loaded', { name: file.name, disk: disk!.name }));
    } catch (e) {
      notify(new MsgError('disks:main.changes.failed', {}, { cause: e }), 'error');
    }
    return;
  }
  const wasOn = state === 'running' || state === 'booting';
  await exclusively(async () => {
    await stop();
    term.reset();
    setState('off');
    stateText(msg('disks:main.changes.loading'));
    try {
      await load();
    } catch (e) {
      setState('failed', inUse(e) ? new MsgError('disks:main.changes.failed.inUse', {}, { cause: e }) : new MsgError('disks:main.changes.failed', {}, { cause: e }), [retry]);
      return;
    }
    if (wasOn || !target) start();
    else setState('off', msg('disks:main.changes.loaded', { name: file.name, disk: disk!.name }), [], 'warn');
  });
}

// Your disk out (loop 5): the changes over the image (a qcow2 that names it as its backing file), or the whole disk. The machine
// stops while it's written (the overlay's files are the writer's); the file goes to where the user picks, or is downloaded.
const SAVES: Record<ExportMode, { suffix: string; description: string; type: string }> = {
  changes: { suffix: '-changes.qcow2', description: t('disks:main.save.type.changes'), type: 'application/x-qcow2' },
  qcow2: { suffix: '.qcow2', description: t('disks:main.save.type.qcow2'), type: 'application/x-qcow2' },
  raw: { suffix: '.img', description: t('disks:main.save.type.raw'), type: 'application/octet-stream' },
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
    for (const m of others) if (await isRunning(m.id)) return void ask.alert(t('disks:main.save.runsElsewhere', { name: m.name }));
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
    notify(msg('disks:main.save.emptied', { name: handle.name }), 'error');
    return;
  }
  const write = async () => {
    if (overlay === NO_OVERLAY_YET) throw new MsgError('disks:main.save.nothing');
    const { source: src, identity } = await source();
    const r = await runExport({ mode, compress, disk: { source: src, overlay, identity }, baseName: fileName, handle }, (phase, f) => stateText(progressText(phase, f)));
    if (r.blob) {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(r.blob), download: suggestedName });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    }
    const name = handle?.name ?? suggestedName;
    return mode === 'changes' ? msg('disks:main.saved.changes', { name, size: r.bytes, blocks: r.blocks, base: fileName }) : msg('disks:main.saved', { name, size: r.bytes });
  };
  if (!uses) {
    // Not this page's machine's disk: nothing stops (the state shows the progress, then says what it was).
    const was = ui.stateText;
    try {
      notify(await write());
    } catch (e) {
      notify(new MsgError('disks:main.save.failed', {}, { cause: e }), 'error');
    } finally {
      ui.stateText = was;
    }
    return;
  }
  const running = state === 'running' || state === 'booting';
  if (running && !(await ask.confirm(t('disks:main.save.confirm'), { title: t('disks:main.save.title'), ok: t('disks:main.save.ok'), danger: true }))) return;
  await exclusively(async () => {
    await stop();
    setState('off');
    stateText(msg('disks:main.saving'));
    try {
      setState('off', await write(), [], 'warn');
    } catch (e) {
      setState('failed', inUse(e) ? new MsgError('disks:main.save.failed.inUse', {}, { cause: e }) : new MsgError('disks:main.save.failed', {}, { cause: e }), [retry]);
      return;
    }
    if (running) start();
  });
}


// Snapshots (docs/frontend.md "Snapshots"): the running machine, RAM and disk changes and all, in a file, and back.
/** The save in progress: the worker's messages for it (the page's `worker.onmessage` forwards them). */
let snapshotJob: { progress(phase: Msg, fraction: number): void; chunk(data: Uint8Array): void; done(m: { bytes: number; pausedMs: number; stateMs: number; blobBytes: number; pins: SnapshotDisk[]; slept?: boolean }): void; error(e: unknown): void } | undefined;
const SNAPSHOT_SUFFIX = '.webpcsnap';
/** A save's phase in the state's words: with how far it is while that's known. */
const snapshotProgress = (phase: Msg, f: number) => stateText(f > 0 && f < 1 ? progressText(phase, f) : phase);

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
  return bytes < GRAPHICS_WARN || ask.confirm(t('snapshots:main.large.confirm', { size: bytes }), { title: t('snapshots:main.large.title'), ok: t('snapshots:main.large.ok') });
}

/**
 * Saves a snapshot of the running machine: to a file (the picker, or a download), or, for a stored machine by default,
 * kept in the browser under a name (docs/machines.md §5.2). `whole`: a disk written in place goes into the file
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
      handle = await picker.call(window, { suggestedName, types: [{ description: t('snapshots:main.fileType'), accept: { 'application/octet-stream': [SNAPSHOT_SUFFIX] } }] });
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return; // cancelled
      handle = undefined; // the download below
    }
  }
  if (run !== r || saving || switching || !(state === 'running' || state === 'booting')) return; // the machine moved on while the picker was open
  const unplugged = await emptyPorts(r, 'snapshot');
  if (!unplugged) return;
  if (run !== r || saving || switching || !(state === 'running' || state === 'booting')) return;
  saving = true;
  syncButtons();
  const parts: Blob[] = [];
  try {
    const result = await new Promise<{ bytes: number; pausedMs: number; stateMs: number; blobBytes: number; slept?: boolean }>((resolve, reject) => {
      snapshotJob = {
        progress: snapshotProgress,
        chunk: (data) => { parts.push(new Blob([data as Uint8Array<ArrayBuffer>])); },
        done: ({ bytes, pausedMs, stateMs, blobBytes, slept }) => resolve({ bytes, pausedMs, stateMs, blobBytes, slept }),
        error: reject,
      };
      r.worker.postMessage({ type: 'snapshot', handle, whole: o.whole, sleep: sleepFirst(r) } satisfies ToWorker);
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
      const words = { name: handle?.name ?? suggestedName, size: result.bytes, seconds: (result.pausedMs / 1000).toFixed(1) };
      const slept = sleptAs(result.slept);
      notify(slept === 'slept' ? msg('snapshots:main.saved.slept', words) : slept === 'awake' ? msg('snapshots:main.saved.awake', words) : msg('snapshots:main.saved', words));
    }
  } catch (e) {
    if (run === r) { setState(state); notify(withNote(e, t('snapshots:main.runsOn.noFile')), 'error'); }
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
  const unplugged = await emptyPorts(r, 'snapshot');
  if (!unplugged || run !== r || saving || switching || !(state === 'running' || state === 'booting')) return;
  saving = true;
  syncButtons();
  const id = newId();
  try {
    const about = (await aboutMachine())!;
    await askPersist();
    const result = await store.writing(async () => {
      const done = await new Promise<{ bytes: number; pausedMs: number; stateMs: number; blobBytes: number; pins: SnapshotDisk[]; slept?: boolean }>((resolve, reject) => {
        snapshotJob = {
          progress: snapshotProgress,
          chunk: () => {},
          done: (m) => resolve(m),
          error: reject,
        };
        r.worker.postMessage({ type: 'snapshot', keep: snapshotPath(s.record.id, id), sleep: sleepFirst(r) } satisfies ToWorker);
      });
      await store.put('snapshots', { id, machine: s.record.id, name, created: Date.now(), bytes: done.bytes, shape: about.shape, shapeHash: about.shapeHash, urls: about.urls, pins: done.pins.map((p) => ({ slot: p.slot, overlay: p.overlay, generation: p.generation, blocks: p.blocks, ram: p.ram })) });
      return done;
    });
    ui.snapshotResult = JSON.stringify({ bytes: result.bytes, pausedMs: result.pausedMs, stateMs: result.stateMs, blobBytes: result.blobBytes, id });
    ui.records++; // this tab's own writes aren't announced to it (Store.onChange)
    if (run === r && (state === 'running' || state === 'booting')) {
      setState(state);
      const words = { name, size: result.bytes, seconds: (result.pausedMs / 1000).toFixed(1) };
      const slept = sleptAs(result.slept);
      notify(slept === 'slept' ? msg('snapshots:main.kept.slept', words) : slept === 'awake' ? msg('snapshots:main.kept.awake', words) : msg('snapshots:main.kept', words));
    }
  } catch (e) {
    if (run === r) { setState(state); notify(withNote(e, t('snapshots:main.runsOn.nothingKept')), 'error'); }
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
  const unplugged = await emptyPorts(r, 'suspend');
  if (!unplugged || run !== r || saving || switching || !(state === 'running' || state === 'booting')) return;
  saving = true;
  syncButtons();
  snapshotJob = {
    progress: snapshotProgress,
    chunk: () => {},
    done: () => {},
    // It runs on; the `suspended` state ends a suspend that worked (the worker's handler above).
    error: (e) => {
      saving = false;
      snapshotJob = undefined;
      if (run === r) { setState(state); notify(withNote(e, t('machine:main.runsOn')), 'error'); }
      syncButtons();
      void plugBack(r, unplugged);
    },
  };
  r.worker.postMessage({ type: 'suspend', sleep: sleepFirst(r) } satisfies ToWorker);
}

/** What a saved snapshot's message adds under the clock catch-up: whether the guest slept for it (undefined: not asked). */
const sleptAs = (slept?: boolean) => (slept === undefined || !clockSync() ? undefined : slept ? 'slept' : 'awake');

/** Whether `file` starts with the snapshot signature (`WEBPCSNP`): how a chosen or dropped file is told from a disk image. */
const isSnapshot = async (file: File) => new TextDecoder().decode(await file.slice(0, 8).arrayBuffer()) === 'WEBPCSNP';

/**
 * Restores a snapshot onto the stored machine (docs/machines.md §5.2): refused when its shape isn't the machine's
 * (it says what differs); else each writable disk keeps its overlay where it is as the snapshot pinned it, and forks
 * (or, if the user says, is replaced) where it moved on. `key` identifies the snapshot for reusing an earlier fork.
 */
async function restoreSnapshot(file: File, header: SnapshotHeader, key: string, name: string) {
  const s = stored!;
  const now = await aboutMachine();
  if (header.shapeHash !== now!.shapeHash) {
    const why = header.shape ? shapeDiff(header.shape as Shape, now!.shape).map((m) => text(m)).join('; ') : msg('snapshots:main.restore.otherVersion');
    return void ask.alert(t('snapshots:main.restore.otherShape', { name, machine: s.record.name, why }), { title: t('snapshots:main.restore.cant') });
  }
  let plan: Awaited<ReturnType<typeof planRestore>>;
  try {
    plan = await planRestore(store, s.record, s.disks, { name: name.replace(/\.webpcsnap$/, ''), key, pins: (header.disks ?? []) as SnapshotDisk[] }, now!.shape.display);
  } catch (e) {
    return void ask.alert(errorText(new MsgError('snapshots:main.restore.failed', { name }, { cause: e })));
  }
  if (plan.refused) return void ask.alert(t('snapshots:main.restore.refused', { name, why: plan.refused }));
  const when = new Date(header.created);
  const taken = !Number.isNaN(when.getTime());
  const running = state === 'running' || state === 'booting';
  // The question, then a line on the disks the snapshot left as they are, and one per disk that forks.
  const lines = [
    running ? (taken ? t('snapshots:main.restore.confirm.takenRunning', { name, when }) : t('snapshots:main.restore.confirm.running', { name })) : taken ? t('snapshots:main.restore.confirm.taken', { name, when }) : t('snapshots:main.restore.confirm', { name }),
    ...(plan.kept.length ? [t('snapshots:main.restore.kept', { disks: plan.kept })] : []),
    ...plan.forks.map((f) => (f.reused ? t('snapshots:main.restore.fork.reused', { disk: f.disk }) : t('snapshots:main.restore.fork.new', { disk: f.disk }))),
  ];
  if (!(await ask.confirm(lines.join('\n'), { title: t('snapshots:main.restore.title'), ok: t('snapshots:main.restore.ok'), danger: running }))) return;
  const replaceable = plan.forks.filter((f) => !f.reused && f.replaceable);
  const count = replaceable.length;
  const list = replaceable.map((f) => t('snapshots:main.restore.keep.item', { name: f.replaceable!.name, size: f.replaceable!.bytes }));
  const replace = count > 0 && !(await ask.confirm(t('snapshots:main.restore.keep', { count, list }), { title: t('snapshots:main.restore.keep.title'), ok: t('snapshots:main.restore.keep.ok'), cancel: t('snapshots:main.restore.replace', { count }) }));
  await exclusively(async () => {
    await stop();
    let disks: DiskPlan[];
    try {
      disks = await plan.commit(replace);
    } catch (e) {
      setState('failed', new MsgError('snapshots:main.restore.failed', { name }, { cause: e }), [retry]);
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
const snapshotDisk = (name: string | null | undefined) => (name ? msg('disks:main.theDisk', { name }) : msg('snapshots:main.ownDisk', { machine: spec.title }));

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
    if (e instanceof SnapshotError) return void ask.alert(t('snapshots:main.notSnapshot', { name: file.name, why: msgOf(e) }), { title: t('snapshots:main.notSnapshot.title') });
    throw e;
  }
  if (stored) return restoreSnapshot(file, header, `file:${String(header.created)}`, file.name);
  const label = typeof header.label === 'string' ? header.label : String(header.machine);
  if (header.machine !== machine) {
    return void ask.alert(t('snapshots:main.load.otherMachine', { name: file.name, other: label, otherId: String(header.machine), machine: spec.title, id: machine }));
  }
  const taken = typeof header.disk === 'string' ? header.disk : null;
  const open = chosen ? diskName()! : null;
  if (taken !== open) {
    return void ask.alert(taken ? t('snapshots:main.load.otherDisk', { name: file.name, taken: snapshotDisk(taken), open: snapshotDisk(open) }) : t('snapshots:main.load.otherDisk.reload', { name: file.name, taken: snapshotDisk(taken), open: snapshotDisk(open) }));
  }
  const overlay = overlayName();
  const written = overlay ? await overlayBytes(overlay).catch(() => 0) : 0;
  const when = new Date(header.created);
  const running = state === 'running' || state === 'booting';
  const dated = !Number.isNaN(when.getTime());
  const count = typeof header.ncpus === 'number' ? header.ncpus : undefined;
  const holds = count === undefined
    ? (dated ? msg('snapshots:main.load.holds.when', { label, when, size: file.size }) : msg('snapshots:main.load.holds', { label, size: file.size }))
    : dated ? msg('snapshots:main.load.holds.when.cpus', { label, when, size: file.size, count }) : msg('snapshots:main.load.holds.cpus', { label, size: file.size, count });
  const replaces = running ? msg('snapshots:main.load.replaces.running') : msg('snapshots:main.load.replaces');
  const disk = chosen ? msg('disks:main.theDisk', { name: diskName() }) : msg('disks:main.machineDisk', { machine: spec.title });
  const lost = written ? msg('snapshots:main.load.written.size', { disk, size: written }) : msg('snapshots:main.load.written', { disk });
  if (!(await ask.confirm(t('snapshots:main.load.confirm', { name: file.name, holds, replaces, lost }), { title: t('snapshots:main.load.title'), ok: t('snapshots:main.load.ok'), danger: true }))) return;
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
    if (h?.kind === 'directory') return void droppedFolder(h as FileSystemDirectoryHandle).catch((err) => notify(err, 'error'));
    void chooseDisk({ file, handle: h?.kind === 'file' ? h as FileSystemFileHandle : undefined });
  })();
});


/** A directory dropped on the page: a folder of this browser's, offered to the running machine if the page's has shared folders. */
async function droppedFolder(handle: FileSystemDirectoryHandle) {
  const here = !ui.machinesOpen && folders.running ? stored?.record : undefined;
  if (here && !(await ask.confirm(t('folders:main.drop.confirm', { folder: handle.name, machine: here.name }), { title: t('folders:main.drop.title'), ok: t('folders:main.drop.ok') }))) return;
  const f = await createFolder(store, { kind: 'host', name: handle.name, handle });
  if (here) await folderPage.folderAttach(here.id, f, false);
  else await folders.refresh();
  if (here) ui.folders.wanted = true;
}

/** Where the guest finds the machine's shared folders; undefined: the page doesn't mount them. */
const sharesPath = (m: MachineRecord) => (m.sharesMount === false ? undefined : m.sharesPath ?? DEFAULT_SHARES_PATH);

// Keys typed into the terminal go to the PL011 (xterm.js sends what a terminal would: \r for Enter, escape sequences).
let replaying = false;
term.onData((d) => { if (!replaying) { wakeOnInput(); run?.serial.postMessage(d); } });

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

/** Another tab changed the page's machine's record: its attachments take effect here (docs/network-adapters.md §3). */
async function followRecord() {
  const s = stored;
  const record = s && await store.get('machines', s.record.id);
  if (!s || !record) return;
  s.record = record;
  if (net.machineKey() === record.id) await net.follow(adaptersOf(record));
}

/** Whether `machine` (an id, or undefined for a transient one) is the page's and its adapters are live here. */
const netLive = (machine: string | undefined, i: number) => (machine ?? 'transient') === netKey() && net.machineKey() === netKey() && i < net.views().length;

/**
 * Attaches connection `c` to adapter `i` of `machine` (undefined: the page's transient one). The page's machine connects
 * it now (`authKey`: a tailnet's first login); one another tab's machine has is taken from it after asking. Another
 * machine keeps it in its record: the tab that runs it, if one does, hears and connects it (`followRecord`), and otherwise it
 * connects when the machine starts.
 */
async function netAttach(machine: string | undefined, i: number, c: Connection, authKey?: string) {
  if (c.ephemeral && machine && machine !== netKey() && await isRunning(machine)) throw new MsgError('network:main.ephemeral', { name: c.name });
  if (netLive(machine, i)) {
    try {
      await net.attach(i, c, authKey);
    } catch (e) {
      if (!(e instanceof HeldError)) throw e;
      if (!(await ask.confirm(t('network:main.held.useHere', { held: e.msg }), { title: t('network:main.held.title'), ok: t('network:main.useHere') }))) return;
      await net.takeFrom(i, c, authKey);
    }
    return;
  }
  await net.conns.put({ ...c, connectAtStart: true }); // first: a tab that runs the machine hears of the attachment and reads this
  if (machine) await setAdapterConnection(store, machine, i, c.id);
  else remember({ transientNet: c.id });
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
  if (settings().transientNet === c.id) on.push(text(spec.title));
  const what = c.kind === 'tailnet' ? (c.ephemeral ? msg('network:main.delete.leaves') : msg('network:main.delete.loggedOut')) : c.tailcat?.serve ? msg('network:main.delete.tailcat') : undefined;
  const question = what
    ? (on.length ? t('network:main.delete.confirm.on.what', { name: c.name, machines: on, what }) : t('network:main.delete.confirm.what', { name: c.name, what }))
    : on.length ? t('network:main.delete.confirm.on', { name: c.name, machines: on }) : t('network:main.delete.confirm', { name: c.name });
  if (!(await ask.confirm(question, { title: t('network:main.delete.title'), ok: t('network:main.delete.ok'), danger: true }))) return;
  const stranded = await net.remove(c);
  await detachEverywhere(store, c.id);
  if (settings().transientNet === c.id) remember({ transientNet: undefined });
  if (stored) stored.record = (await store.get('machines', stored.record.id)) ?? stored.record;
  await net.refresh();
  if (stranded) throw new MsgError('network:main.stranded', { name: c.name });
}

/** Logs out the node of connection `c`, running or not; one another tab's machine has is taken from it after asking. */
async function netLogoutConnection(c: Connection) {
  try {
    await net.logoutKept(c);
  } catch (e) {
    if (!(e instanceof HeldError)) throw e;
    if (!(await ask.confirm(t('network:main.held.logOut', { held: e.msg }), { title: t('network:main.held.title'), ok: t('network:main.logOut'), danger: true }))) return;
    if (!(await net.locks.takeFrom(connectionLock(c.id)))) throw e;
    await net.logoutKept(c);
  }
}

/** Forgets tailcat connection `c`'s served identity, after asking: whoever has its address can't come in any more. */
async function netNewAddress(c: Connection) {
  const tc = c.tailcat;
  if (!tc) return false;
  if (!(await ask.confirm(t('network:main.newAddress.confirm', { name: c.name }), { ok: t('network:main.newAddress.ok'), danger: true }))) return false;
  // An ephemeral connection's identity is in the page's memory: a new one; a stored one's is made again at its next serve.
  if (c.ephemeral) await net.conns.put({ ...c, tailcat: { ...tc, identity: newTailcatIdentity() } });
  else await forgetTailcatIdentity(tc.identityKey);
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
  // With the status bar along (Preferences), the page goes full screen without its toolbar and message bar (index.html).
  const target = ui.statusFullscreen && shows(ui.statusItems) ? document.body : mainEl;
  target.requestFullscreen({ navigationUI: 'hide' }).then(() => keyboardLock?.lock()).then(() => { ui.keyboardLocked = !!keyboardLock && !!document.fullscreenElement; }).catch(() => {});
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) { keyboardLock?.unlock(); ui.keyboardLocked = false; } });
// Where keys go, for the status bar's Keyboard: the screen or the terminal focused in a focused window (what the
// screen's "Click to type" hint says otherwise).
const syncKeys = () => { const a = document.activeElement; ui.keysFocused = document.hasFocus() && !!a && (a.id === 'screen' || !!a.closest('#terminal')); };
for (const ev of ['focusin', 'focusout']) document.addEventListener(ev, () => queueMicrotask(syncKeys));
for (const ev of ['focus', 'blur']) addEventListener(ev, syncKeys);

// Leaving the page while the machine runs stops it like pulling the plug: the browser asks first (Preferences, on the
// Machines page, turns it off). The browser words the question itself. Not under automation (the tests navigate away
// from running machines) unless `?leavewarning=1`.
window.addEventListener('beforeunload', (e) => {
  if (!['running', 'booting', 'rebooting'].includes(ui.state) || !leaveWarning()) return;
  if (navigator.webdriver && params.get('leavewarning') !== '1') return;
  e.preventDefault();
  e.returnValue = ''; // older Chromium asks only with this set
});

function showStatus(s: Status, tabBytes: number) {
  const now = performance.now();
  // A new run's counters start again from 0 (a restart, a resume, a snapshot load): no rates across that.
  const prev = last && s.uptime >= last.status.uptime ? last : undefined;
  last = { status: s, at: now, metrics: metrics(s, now, prev, tabBytes) };
  ui.status.data = JSON.stringify(s); // for tools (bench/stress)
  ui.status.metrics = last.metrics;
}
/** The screen's report each second (a 3D machine's GPU worker, a 2D machine's presenter), for the status bar. */
function showGraphics(mode: Graphics['mode'], m: Parameters<typeof graphics>[1]) {
  const at = performance.now();
  ui.status.gpu = { g: graphics(mode, m, at, ui.status.gpu), at };
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
  // A machine with Vulkan keeps Venus's window and arena in memory 0: its split (the toolbar's note) moves.
  ui.size.vulkan = want3d && wantsVulkan();
  ui.size.cpuChoices = [...new Set([...CPU_CHOICES, ncpus])].sort((a, b) => a - b);
  ui.size.ramChoices = [...new Set([...RAM_CHOICES, ramMiB])].sort((a, b) => a - b);
  ui.size.gpuLock = !webgl2 ? t('toolbar:main.gpuLock.noWebgl2') : gpuAsked ? t('toolbar:main.gpuLock.address', { gpu: params.get('gpu') ?? '' }) : '';
}
syncMachineMenu();
// The memory signal (web/app/memory.ts, docs/frontend.md "Memory"): while the machine runs, a mark in localStorage
// with what it costs, renewed every 10 s and cleared at a clean stop; a mark left over means its tab went away with
// it running (most likely killed for memory), and the next start offers a smaller JIT cache or less RAM first.
const aliveKey = () => (stored ? stored.record.id : `transient-${machine}`);
let aliveAt = 0, signal = new Signal(), signalRun: Run | undefined;
/** Returns the estimate (bytes), for the status bar's Tab memory. */
function alive(st: Status) {
  const now = Date.now();
  if (signalRun !== run) [signal, signalRun] = [new Signal(), run];
  const est = signal.update(st.memory, st.ncpus);
  if (now - aliveAt < ALIVE_EVERY_MS) return est;
  aliveAt = now;
  markAlive(aliveKey(), { name: machineTitle(), ramMiB, ncpus, jitMiB: Math.round(st.memory.jitBudget / 2 ** 20), gib: +(est / 2 ** 30).toFixed(2), peakGiB: +(signal.peak / 2 ** 30).toFixed(2), t: now });
  return est;
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
      if (o.ramMiB && (await store.snapshotsOf(m.id)).length && !(await ask.confirm(t('machine:main.lessRam.confirm'), { ok: t('machine:main.lessRam.ok') }))) return void crashedBefore();
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
    ...(jitNow > 160 ? [{ label: t('machine:main.crashed.jit', { mib: 160 }), run: () => void use({ jitMiB: 160 }) }] : jitNow > 64 ? [{ label: t('machine:main.crashed.jit', { mib: 64 }), run: () => void use({ jitMiB: 64 }) }] : []),
    ...(ramLess < a.ramMiB ? [{ label: t('machine:main.crashed.ram', { mib: ramLess }), run: () => void use({ ramMiB: ramLess }) }] : []),
    { label: t('machine:main.crashed.asIs'), run: () => { clearAlive(aliveKey()); void restart(); } },
  ];
  setState('idle', msg('machine:main.crashed', { name: a.name, when: new Date(a.t), gib: a.gib, peak: a.peakGiB, ram: a.ramMiB, jit: a.jitMiB }), actions, 'warn');
  return true;
}
/** A question's words with the warning for a size this device may not have the memory for, a paragraph after them. */
function memoryWarning(question: string, r: number, n: number, j = jitBudget()) {
  const need = hostMemoryGiB(r, n, j);
  const has = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (has === undefined || has >= need) return question;
  const warning = has >= 8 ? t('machine:main.memoryWarning.max', { need: need.toFixed(1), has }) : t('machine:main.memoryWarning', { need: need.toFixed(1), has });
  return `${question}\n\n${warning}`;
}
async function applySize(n: number, r: number, g: '3d' | '2d') {
  if (n === ncpus && r === ramMiB && g === (want3d ? '3d' : '2d')) return;
  const running = state === 'running' || state === 'booting';
  const size = !hasGpu ? msg('machine:main.size', { count: n, ram: r }) : g === '3d' ? msg('machine:main.size.3d', { count: n, ram: r }) : msg('machine:main.size.2d', { count: n, ram: r });
  const question = running ? t('machine:main.size.confirm.running', { size }) : t('machine:main.size.confirm', { size });
  if (!(await ask.confirm(memoryWarning(question, r, n), { title: t('machine:main.size.title'), ok: t('machine:main.size.ok'), danger: running }))) return;
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
  if (running && !(await ask.confirm(memoryWarning(t('machine:main.settings.confirm', { name: m.name }), m.ramMiB, m.ncpus, jitParam() || m.jitMiB || JIT_DEFAULT_MIB), { title: t('machine:main.settings.title'), ok: t('machine:main.settings.ok'), danger: true }))) return;
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

// The Machines page (docs/machines.md §7; web/app/MachinesPage.svelte): in the machine's place, which runs on behind it.
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
    if (!m) throw new MsgError('usb:main.machineGone');
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
  p.onGone = (connector, was, reason, error) => {
    if (reason === 'unplugged' && was.device.api !== 'virtual') {
      // It may come back as another device (a bootloader, after a firmware upload): the offer to attach that one there.
      const api = was.device.api;
      const entry = usbEntries().find((e) => e.id === was.entry);
      const gone = { connector, api, atStart: entry?.atStart ?? false, name: was.name, at: Date.now() };
      lastGone = gone;
      offer(`gone-${connector}`, t('usb:main.offer.gone', { name: was.name, connector: connector + 1 }), t('usb:main.offer.pick'), async () => {
        for (const d of await requestDevices(api)) await rememberAndAttach(api, d, { connector, atStart: gone.atStart });
      });
    } else if (error) {
      notify(usbDetails(t('usb:main.detached', { name: was.name }), error), 'error');
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

/** An attach's error for the message bar (`again`: an attach after a snapshot): a `UsbError` with problems names the device itself. */
const attachFailed = (name: string, err: unknown, again = false): Said =>
  err instanceof UsbError && err.words.length ? errorLines(err) : usbDetails(again ? t('usb:main.attachFailed.again', { name }) : t('usb:main.attachFailed', { name }), err);

/** Attaches entry `e` on its connector; a device another machine holds is offered to be detached there first (`quiet`: skipped, with a note). */
async function attachEntry(e: UsbEntry, o: { quiet?: boolean } = {}) {
  const p = run?.usb;
  if (!p || !usbRunning()) throw new MsgError('usb:main.stopped');
  if (p.connectorOf(e.id) >= 0) return;
  const name = deviceName(e);
  try {
    await p.attach(e.connector, usbIdentity(e), e.id);
  } catch (err) {
    if (!(err instanceof UsbHeldError)) throw err;
    const who = await usbLocks.holder(usbLock(e));
    if (o.quiet) return void notify(who ? msg('usb:main.held.left', { name, who }) : msg('usb:main.held.left.unknown', { name }));
    if (!(await ask.confirm(who ? t('usb:main.held.confirm', { name, who }) : t('usb:main.held.confirm.unknown', { name }), { title: t('usb:main.held.title'), ok: t('usb:main.held.ok') }))) return;
    if (!(await usbLocks.takeFrom(usbLock(e)))) throw who ? new MsgError('usb:main.held.kept', { name, who }) : new MsgError('usb:main.held.kept.unknown', { name });
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
  notify(msg('usb:main.taken', { name }));
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
    else if (!keyboardLive && !c) await p.attach(KEYBOARD_CONNECTOR, KEYBOARD).catch((err) => notify(usbDetails(t('usb:main.keyboardFailed'), err), 'error'));
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
      if (!isGranted(identityKey(e))) offer(`allow-${e.id}`, t('usb:main.offer.ungranted', { name: deviceName(e) }), t('usb:main.offer.allow'), () => allowEntry(pageMachine(), e.id));
      continue; // not plugged in: skipped without a word
    }
    if (!e.atStart) continue;
    await attachEntry(e, { quiet: true }).catch((err) => notify(usbDetails(t('usb:main.attachFailed', { name: deviceName(e) }), err), 'error'));
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
    return offer(`seen-${identityKey(identity)}`, t('usb:main.offer.plugged', { name }), t('usb:main.offer.attach'), () => attachEntry(e));
  }
  const back = lastGone && Date.now() - lastGone.at < REENUMERATION_MS ? lastGone : undefined;
  if (back) {
    offers.delete(`gone-${back.connector}`);
    return offer(`seen-${identityKey(identity)}`, t('usb:main.offer.back', { name, was: back.name, connector: back.connector + 1 }), t('usb:main.offer.there'), () => rememberAndAttach(api, device, { connector: back.connector, atStart: back.atStart }));
  }
  offer(`seen-${identityKey(identity)}`, t('usb:main.offer.plugged', { name }), t('usb:main.offer.remember'), () => rememberAndAttach(api, device));
}

type Unplugged = { connector: number; device: UsbIdentity | UsbVirtual; entry?: string }[];
/**
 * Snapshot and Suspend need the ports empty (docs/usb.md "The page"): with devices attached it asks once, naming them,
 * and detaches them. Returns what was attached (to attach again after), or undefined when the user says no.
 */
async function emptyPorts(r: Run, what: 'snapshot' | 'suspend'): Promise<Unplugged | undefined> {
  // The built-in keyboard goes out and back in without a question (the firmware's keyboard; Linux has its own).
  const on = (r.usb?.attached() ?? []).filter((c) => !isKeyboard(c));
  if (!on.length) return r.usb ? r.usb.detachAll() : [];
  const names = on.map((c) => c.name);
  const count = names.length;
  const list = count === 1 ? names[0] : t('usb:main.empty.list', { first: names.slice(0, -1), last: names.at(-1) });
  const question = what === 'suspend' ? t('usb:main.empty.suspend', { count, list }) : t('usb:main.empty.snapshot', { count, list });
  if (!(await ask.confirm(question, { title: t('usb:main.empty.title'), ok: t('usb:main.empty.ok') }))) return undefined;
  return r.usb!.detachAll();
}
/** Attaches again what `emptyPorts` detached (the machine runs on after a snapshot). */
async function plugBack(r: Run, was: Unplugged | undefined) {
  for (const c of was ?? []) {
    if (run !== r || !usbRunning()) return;
    if (isKeyboard(c)) { await syncKeyboard(r); continue; }
    await r.usb!.attach(c.connector, c.device, c.entry).catch((err) => notify(attachFailed(deviceName(c.device), err, true), 'error'));
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
    if (change.connector !== undefined && isCurrent(machine) && (run?.usb?.connectorOf(id) ?? -1) >= 0) throw new MsgError('usb:main.edit.detachFirst');
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
    if (take && o) void o.run().catch((err) => notify(err, 'error')).finally(syncUsb);
  },
  usbStates: async (m: MachineRecord) => entryStates(m.usbDevices ?? [], isCurrent(m.id) ? run?.usb?.attachedEntries() ?? new Set<string>() : new Set<string>(), usbLocks),
  usbZero: async () => {
    const p = run?.usb;
    if (!p || !usbRunning()) throw new MsgError('usb:main.zero.stopped');
    const at = p.connectors.findIndex((c) => c?.device.api === 'virtual' && c.device.kind === 'gadget-zero');
    if (at >= 0) return p.detach(at);
    const free = p.connectors.findIndex((c, i) => !c && i !== KEYBOARD_CONNECTOR);
    if (free < 0) throw new MsgError('usb:main.zero.full');
    await p.attach(free, { api: 'virtual', kind: 'gadget-zero' });
  },
};
syncUsb();

// What the components ask of the page (web/app/ui.svelte.ts `Page`).
/** Reads the page's machine's record again, if `machine` is it. */
const rereadRecord = async (machine: string) => {
  if (stored?.record.id === machine) stored.record = (await store.get('machines', machine)) ?? stored.record;
  ui.records++; // this tab's own writes aren't announced to it
};
const folderPage = {
  folderWizard: (machine: string | undefined, attached: FolderAttachment[]) => { ui.folderWizard = { machine, attached, tick: (ui.folderWizard?.tick ?? 0) + 1 }; },
  folderPick: async (readOnly: boolean) => {
    const handle = await (globalThis as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: readOnly ? 'read' : 'readwrite' });
    return folderPage.folderCreate({ kind: 'host', name: handle.name, readOnly, handle });
  },
  folderCreate: async (n: NewFolder) => {
    const f = await createFolder(store, n);
    await folders.refresh();
    return f;
  },
  folderAttach: async (machine: string, f: Folder, readOnly: boolean) => { await folders.attach(machine, f, readOnly); await rereadRecord(machine); },
  folderDetach: async (machine: string, id: string) => { await folders.detach(machine, id); await rereadRecord(machine); },
  folderMove: async (machine: string, id: string, by: number) => { await folders.move(machine, id, by); await rereadRecord(machine); },
  folderReadOnly: async (machine: string, id: string, readOnly: boolean) => { await folders.setReadOnly(machine, id, readOnly); await rereadRecord(machine); },
  folderAllow: (id: string) => folders.allow(id),
  folderUseHere: async (id: string) => {
    const v = folders.views().find((x) => x.id === id);
    if (!(await ask.confirm(t('folders:main.inUse.confirm', { name: v?.name ?? msg('folders:main.inUse.folder'), holder: v?.holder ?? msg('folders:main.inUse.otherTab') }), { title: t('folders:main.inUse.title'), ok: t('folders:main.useHere') }))) return;
    if (!(await folders.useHere(id))) throw new MsgError('folders:main.kept', { holder: v?.holder ?? msg('folders:main.kept.thatMachine') });
  },
};
Object.assign(page, {
  restart: () => void restartAsked(),
  suspend: () => void suspend(),
  takeSnapshot: () => void saveSnapshot(),
  saveSnapshotFile: (whole: boolean) => void saveSnapshot({ toFile: true, whole }),
  restoreKept: (id: string) => void restoreKept(id),
  loadSnapshot: (file: File) => void loadSnapshot(file),
  openDiskFile: (file: File, handle?: FileSystemFileHandle) => void chooseDisk({ file, handle }),
  openDisk: () => void openDisk(),
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
    return currentShape(m, (id) => disks.get(id), { display, cpu: cpuFeatures(), vulkan: display === '3d' && (gpuKnobs.includes('vulkan') || !!m.vulkan) });
  },
  setView: (v: View) => setView(v),
  showLog: () => { setView(ui.view === 'screen' ? 'both' : ui.view, false); term.focus(); },
  fullscreen,
  setMouseLock,
  chord: (keys: string[]) => { canvas.focus(); run?.input.chord(...keys); },
  holdKey: (code: string, ms: number) => {
    canvas.focus();
    const r = run;
    const e = { key: keyOf(code, false), ctrlKey: false, altKey: false, metaKey: false };
    r?.input.key(code, true, e);
    setTimeout(() => r?.input.key(code, false, e), ms);
  },
  oskKey: (code: string, down: boolean, m: Mods) => run?.input.key(code, down, { key: keyOf(code, m.shift), ctrlKey: m.ctrl, altKey: m.alt, metaKey: m.meta }),
  screenSize: () => { fit(); scheduleSize(); },
  openMachines,
  closeMachines,
  dismiss: () => { clearTimeout(messageTimer); note = ''; showMessage('', [], 'warn'); },
  ...usbPage,
  ...folderPage,
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
      if (await ask.confirm(t('network:main.held.useHere', { held: e.msg }), { title: t('network:main.held.title'), ok: t('network:main.useHere') })) await net.takeFrom(i, c);
    }
  },
  netDisconnect: (i: number) => net.disconnect(i),
  netLogout: (i: number) => net.logout(i),
  netLogoutConnection,
  netFollow: followRecord,
  netExit: (i: number, peer: string) => net.setExitNode(i, peer),
  netRoutes: (i: number, on: boolean) => net.setAcceptRoutes(i, on),
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
    setState('failed', msg('machine:main.notIsolated'));
    ui.cantRun = true;
    return;
  }
  if (storedError !== undefined) return setState('failed', new MsgError('machine:main.cantOpen', {}, { cause: storedError }));
  if (needsDisk()) return waitForDisk();
  if (crashedBefore()) return;
  // Chromium kills a renderer that runs out of memory without an error to catch (PLAN.md §4): judge up front.
  const need = hostMemoryGiB(ramMiB + ramdiskMiB(), ncpus, jitBudget());
  const has = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (has !== undefined && has < need) {
    const fewer = Math.floor((has - hostMemoryGiB(ramMiB, 0, jitBudget())) / (hostMemoryGiB(0, 1) - hostMemoryGiB(0, 0)) + 1e-9);
    const advice = fewer > 0 && fewer < ncpus ? msg('machine:main.memory.advice.fewer', { fewer }) : msg('machine:main.memory.advice');
    const words = { need: need.toFixed(1), ram: ramMiB, count: ncpus, has, advice };
    setState('idle', has >= 8 ? msg('machine:main.memory.max', words) : msg('machine:main.memory', words), [{ label: t('machine:main.memory.start'), run: () => void restart() }], 'warn');
    return;
  }
  start();
}
// Other browsers may work in part; nothing is done for them yet (their pass is in docs/backlog.md).
const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands ?? [];
if (!brands.some((b) => b.brand === 'Chromium')) note = msg('machine:main.notChromium');
const diskParam = params.get('disk');
if (diskParam && spec.firmware) {
  const url = new URL(diskParam, location.href).href;
  // A chunked image's manifest names it (the machine is called that, not `prefetch.json`); the boot reads it again.
  const name = isManifestUrl(url) ? await fetchManifest(url).then((m) => m.name, () => undefined) : undefined;
  chosen = { url, overlay: await diskOverlay({ url }), name };
  syncDiskButtons();
}
boot();
