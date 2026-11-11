// The page's composition root (docs/frontend.md "The page's code", docs/frontend-code.md §5.1): it opens the store and
// the page's machine, builds the areas' modules (web/app/run/: the machine's run; web/app/areas/: the rest), assembles
// `page` from their actions, mounts the components (web/app/App.svelte) and starts the machine. The address's knobs are
// web/app/run/knobs.ts's.
import { flushSync, mount } from 'svelte';
import App from './App.svelte';
import { PageAudio } from '../audio.ts';
import { hasOpfs } from '../overlay.ts';
import { forgetRoomIdentity } from '../room.ts';
import { forgetTailcatIdentity } from '../tailcat.ts';
import { forgetProfile, keptProfiles } from '../tailscale-state.ts';
import { current } from './areas/current.svelte.ts';
import { isLive, power } from './areas/power.svelte.ts';
import { records } from './areas/records.svelte.ts';
import { sound } from './areas/sound.svelte.ts';
import { usb } from './areas/usb.svelte.ts';
import { ClipboardActions } from './areas/clipboard-actions.ts';
import { DiskActions } from './areas/disk-actions.ts';
import { changesHeader, DiskChanges } from './areas/disk-changes.ts';
import { DiskExport } from './areas/disk-export.ts';
import { FolderActions } from './areas/folder-actions.ts';
import { KeysActions } from './areas/keys-actions.ts';
import { NetworkActions } from './areas/network-actions.ts';
import { PageWindow } from './areas/page-window.ts';
import { ScreenView } from './areas/screen-view.ts';
import { SerialTerminal } from './areas/serial-terminal.ts';
import { SnapshotActions } from './areas/snapshot-actions.ts';
import { isSnapshot, SnapshotRestore } from './areas/snapshot-restore.ts';
import { UsbActions } from './areas/usb-actions.ts';
import { UsbRun } from './areas/usb-attach.ts';
import { UsbEntries } from './areas/usb-entries.ts';
import { UsbView } from './areas/usb-view.ts';
import { installCopyEdit } from './copy-edit.ts';
import { PageFolders } from './folders-live.ts';
import type { Grab } from './hooks.ts';
import { setAdapterConnection } from './machines.ts';
import { PageNetwork } from './net-live.ts';
import { providePage, type Page } from './page.ts';
import { installBenchHooks } from './run/bench-hooks.ts';
import { params } from './run/knobs.ts';
import { MemorySignal } from './run/memory-signal.ts';
import { Messages, standingNote } from './run/messages.ts';
import { baseName, machineTitle, needsDisk, overlayName } from './run/page-disks.ts';
import { lastMachine, loadStored, PageMachine } from './run/page-machine.svelte.ts';
import { PowerActions } from './run/power-actions.ts';
import { Problems } from './run/problems.ts';
import { Replies } from './run/replies.ts';
import type { FromWorker } from './protocol.ts';
import { Runner } from './run/runner.ts';
import { SizeActions, sizeOf } from './run/size-actions.ts';
import { remember } from './settings.ts';
import { Store } from './store.ts';
import { describe, text } from '../i18n.ts';

// The commit the page was built from (tools/stamp.ts `buildStamp`), for reports of what a user ran.
const build = document.querySelector('meta[name="webpc-build"]')?.getAttribute('content');
if (build) console.info(`webpc: built from ${build}`);

// A machine kept in this browser (docs/machines.md), by id: `?m=<id>`, else the one last opened on a page without a
// query. Without one the machine is transient, made from the query (the tests' `?machine=`).
const store = await Store.open();
const chosenId = params.get('m') ?? (location.search ? undefined : lastMachine());
let storedError: unknown;
const stored = chosenId
  ? await loadStored(store, chosenId).catch((e: unknown) => {
      if (params.get('m')) storedError = e;
      return undefined;
    })
  : undefined;
const machine = new PageMachine(store, stored, storedError);
current.follow({
  id: () => machine.stored?.record.id,
  title: () => machineTitle(machine),
  transient: () =>
    !machine.stored && !needsDisk(machine) ? { label: text(machine.spec.title), disk: baseName(machine) } : undefined,
  hasOverlay: () => !!overlayName(machine),
  size: () => sizeOf(machine),
});
current.firmware = !!machine.spec.firmware;
current.hasNetwork = !!machine.spec.network;
current.hasGpu = machine.hasGpu;
usb.follow({ on: () => machine.has('usb'), running: () => !!machine.run?.usb && isLive(power.state) });

// The network and the folders are made first (their menus show them), and the sound.
const net = new PageNetwork({
  store,
  state: { forgetTailnet: forgetProfile, forgetTailcat: forgetTailcatIdentity, forgetRoom: forgetRoomIdentity },
  kept: keptProfiles,
  me: () => machineTitle(machine),
  save: async (i, id) => {
    const s = machine.stored;
    if (!s) return remember({ transientNet: id });
    await setAdapterConnection(store, s.record.id, i, id);
    await machine.rereadRecord();
  },
});
const network = new NetworkActions(machine, net);
await network
  .migrate()
  .catch((e: unknown) => console.warn('the network settings could not be made into connections:', e));
void net.refresh();
const audio = new PageAudio();
sound.follow(audio);
const folders = new PageFolders({ store, me: () => machineTitle(machine) });
window.__folders = folders; // tools/screens.ts's hook
void folders.refresh();
void records.watch(store);
store.onChange((c) => {
  void net.refresh();
  void folders.refresh();
  if (c.kind === 'machines' && c.id === machine.stored?.record.id) void network.follow();
});

// The machine's areas, each given what it takes (late: what is made after it, called only once all are).
const replies = {
  grabs: new Replies<Grab>(),
  screens: new Replies<Blob | undefined>(),
  bytes: new Replies<number>(),
  worker: new Replies<FromWorker>(),
};
const screen = new ScreenView(machine);
const terminal = new SerialTerminal();
const messages = new Messages(machine, () => {
  net.machineOff();
  // The guest's cursor (an image, or hidden by a graphical session) goes with the machine: the host's pointer is back over its screen.
  if (screen.cursor) screen.setCursor(undefined);
});
const clipboardActions = new ClipboardActions(machine, replies, () => screen.canvas);
const usbView = new UsbView(
  machine,
  () => usbEntries.locks,
  () => usbEntries.list(),
);
const usbEntries: UsbEntries = new UsbEntries(
  machine,
  () => usbView.refresh(),
  (lock) => void usbRun.letGo(lock),
);
const usbRun = new UsbRun({ machine, messages, view: usbView, entries: usbEntries });
const usbActions = new UsbActions({ machine, messages, entries: usbEntries, run: usbRun, view: usbView });
machine.onRecord = () => usbView.refresh();
const signal: MemorySignal = new MemorySignal(machine, messages, () => powerActions.restart());
const runner = new Runner({
  machine,
  messages,
  screen,
  terminal,
  net,
  audio,
  folders,
  replies,
  usb: {
    ports: (port) => usbRun.ports(port),
    attachAtStart: (r) => usbRun.attachAtStart(r, (e) => usbActions.allow(machine.stored?.record.id, e.id)),
    syncKeyboard: (r) => usbRun.syncKeyboard(r),
    keyboardKey: usbRun.keyboardKey,
  },
  clipboard: (port) => clipboardActions.begin(port),
  alive: { mark: (st) => signal.mark(st), clear: () => signal.clear() },
  later: { problems: () => problems, restart: () => powerActions.restart() },
});
const pageWindow: PageWindow = new PageWindow({
  machine,
  screen,
  terminal,
  reloadStored: () => powerActions.reloadStored(),
  dropped: (file, handle) => disks.choose({ file, handle }),
  droppedFolder: (handle) => folderActions.dropped(handle),
  notify: (e) => messages.notify(describe(e), 'error'),
  serial: (d) => {
    runner.wake();
    machine.run?.serial.postMessage(d);
  },
});
const powerActions: PowerActions = new PowerActions({
  machine,
  runner,
  messages,
  terminal,
  later: { openMachines: (tab, id) => pageWindow.openMachines(tab, id), openDisk: () => disks.open() },
});
const core = { machine, runner, power: powerActions, messages, terminal };
const restore = new SnapshotRestore(core);
const changes = new DiskChanges(core);
const disks: DiskActions = new DiskActions({
  ...core,
  isSnapshot,
  loadSnapshot: (file) => restore.load(file),
  changesHeader,
  loadChanges: (file) => changes.load(file),
  openMachines: (tab, id) => pageWindow.openMachines(tab, id),
});
const problems = new Problems({
  messages,
  restart: (resume) => powerActions.restart(resume),
  log: terminal.actions(() => pageWindow.showLog(), machine.name),
  resetDisk: disks.resetAction,
  grantFiles: (d) => disks.grantFiles(d),
});
const diskExport = new DiskExport(core);
const snapshots = new SnapshotActions({
  ...core,
  emptyPorts: (r, what) => usbRun.emptyPorts(r, what),
  plugBack: (r, was) => usbRun.plugBack(r, was),
  askBytes: (r, post) => {
    const gpu = r.gpu;
    return gpu ? replies.bytes.ask((id) => post(gpu, id), { ms: 1000, fallback: 0 }) : Promise.resolve(0);
  },
});
const sizes = new SizeActions({ machine, power: powerActions, runner, messages, terminal });
const folderActions: FolderActions = new FolderActions(machine, folders);
const keysActions = new KeysActions({ machine, runner, screen, terminal });

// What the components ask of the page (web/app/page.ts `Page`), complete before they mount.
const page: Page = {
  restart: () => void powerActions.restartAsked(),
  suspend: () => void snapshots.suspend(),
  takeSnapshot: () => void snapshots.save(),
  saveSnapshotFile: (whole) => void snapshots.save({ toFile: true, whole }),
  restoreKept: (id) => void restore.restoreKept(id),
  loadSnapshot: (file) => void restore.load(file),
  openDiskFile: (file, handle) => void disks.choose({ file, handle }),
  openDisk: () => void disks.open(),
  openMachine: (id) => {
    pageWindow.closeMachines();
    void disks.switchMachine(id);
  },
  powerOff: () => powerActions.powerOff(),
  powerOffAsked: () => void powerActions.powerOffAsked(),
  saveDisk: (mode, compress, target) => void diskExport.save(mode, compress, target),
  importChanges: (file, target) => void changes.load(file, target),
  resetDisk: () => void disks.reset(),
  saveSettings: (m) => sizes.saveSettings(m),
  applySize: (n, r, g) => void sizes.apply(n, r, g),
  shapeNow: (m, d) => sizes.shapeNow(m, d),
  setView: (v) => pageWindow.setView(v),
  showLog: () => {
    pageWindow.showLog();
    terminal.term.focus();
  },
  fullscreen: () => pageWindow.fullscreen(),
  ...keysActions.page(),
  screenSize: () => {
    screen.fit();
    screen.scheduleSize();
  },
  openMachines: (tab, id) => pageWindow.openMachines(tab, id),
  closeMachines: () => pageWindow.closeMachines(),
  dismiss: () => messages.dismiss(),
  ...usbActions.page(),
  ...network.page(),
  ...folderActions.page(),
  ...clipboardActions.page(),
};
providePage(page);

pageWindow.takePairing();
mount(App, { target: document.body, props: { store, audio, net, folders, view: pageWindow.view() } });
installCopyEdit();
flushSync();

// Sound (docs/frontend.md "Sound"; its menu is web/app/Sound.svelte): any click or key on the page lets the browser
// play it. At the document's capture, before the clipboard's (below) and the screen's own listeners: an
// addEventListener, as <svelte:document> can't take a capture-phase listener ahead of them.
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => audio.gesture(), { capture: true });
clipboardActions.listen();
usbActions.listen();
usbView.refresh();
installBenchHooks(machine, terminal, replies, audio);
// What escapes an action (its promise dropped: a click's) is shown as the page shows errors.
addEventListener('unhandledrejection', (e) => messages.notify(describe(e.reason), 'error'));

pageWindow.firstView();
if (location.hash === '#machines') pageWindow.openMachines();
messages.note = standingNote(await hasOpfs());
await disks.fromAddress();
powerActions.boot(signal);
