// The page's state as its components show it (docs/frontend.md "The page's code"): web/app/main.ts runs the machine and
// writes here; App.svelte and the components under it read it, and call `page`'s actions, which main.ts provides.
import type { Connection, NewConnection } from './connections.ts';
import type { ExportMode } from './export.ts';
import type { Folder, NewFolder } from './folders.ts';
import type { PowerState } from './protocol.ts';
import type { DiskRecord, FolderAttachment, MachineRecord, Shape, UsbEntry } from './shape.ts';
import type { EntryView } from './usb-live.ts';
import type { ProblemWords } from './usb-ports.ts';
import type { LockMode } from '../input.ts';
import type { ReadPermission, ShareState } from './clipboard.ts';
import type { ModifierMode, Mods } from './osk.ts';
import { normalize, type Graphics, type Metrics } from './statusbar.ts';
import { settings } from './settings.ts';
import { t } from '../i18n.ts';

export type View = 'screen' | 'terminal' | 'both';
/** The machine's power state, plus the page's own `idle`: no machine yet (waiting for a disk, or for "Start anyway"). */
export type PageState = PowerState | 'idle';
export type Action = { label: string; run: (button: HTMLButtonElement) => void };
export type MachinesTab = 'settings' | 'disks' | 'network' | 'usb' | 'folders' | 'snapshots';

export const ui = $state({
  /** What the toolbar calls the machine. */
  title: '',
  state: 'loading' as PageState,
  /** The state's words (a phase or a progress while loading or saving). */
  stateText: t('statusbar:ui.loading'),
  /** The message bar: a problem or a note, and what can be done about it. */
  message: '',
  /** The message's details, one per line, under it (an error's causes: web/i18n.ts `describe`). */
  messageDetails: [] as string[],
  messageKind: 'warn' as 'error' | 'warn',
  actions: [] as Action[],
  /** The last snapshot written (its bytes, pause and id), for tools: `#message[data-snapshot]`. */
  snapshotResult: '',
  view: 'screen' as View,
  /** The Machines page instead of the machine (`#machines` in the address). */
  machinesOpen: false,
  machinesTab: 'settings' as MachinesTab,
  /** The machine chosen on the Machines page (undefined: the page's own, or none). */
  machinesSelected: undefined as string | undefined,
  /** A stop, start or snapshot in progress: the actions that would overlap it wait. */
  busy: false,
  /** The stored machine on this page (its id), or undefined for a transient one (a test's `?machine=`). */
  current: undefined as string | undefined,
  /** A transient machine with a disk of its own: shown on the Machines page as "this page's machine". */
  transient: undefined as { label: string; disk: string } | undefined,
  /** The machine boots through UEFI and can take a disk file (Open disk…, a dropped file). */
  firmware: false,
  /** The boot disk keeps its changes in this browser: Suspend, the disk's actions. */
  hasOverlay: false,
  /** The machine has a virtio-gpu (the Screen menu, the Graphics choice). */
  hasGpu: false,
  /** The machine has a network card (the Network menu). */
  hasNetwork: false,
  /** The toolbar's mouse lock (remembered): a click on the screen takes the mouse (docs/frontend.md "Mouse lock"). */
  mouseLock: false,
  /** How the locked mouse moves the guest (web/input.ts `LockMode`; remembered): `pointer` by default. */
  mouseLockMode: 'pointer' as LockMode,
  /** The screen holds the mouse now. */
  mouseLocked: false,
  /** The on-screen keyboard is shown (docs/frontend.md "The on-screen keyboard"). */
  osk: false,
  /** How its tapped modifiers are let go (Preferences; remembered): after the next key, by default. */
  oskModifiers: (settings().oskModifiers ?? 'next') as ModifierMode,
  /** Bumped when the guest's keys are released by the page (a blur): the on-screen keyboard forgets what it holds. */
  keysReleased: 0,
  /** The last key typed on the physical keyboard into the screen (`n` bumped each time): it ends the on-screen keyboard's latches. */
  keyTyped: { code: '', n: 0 },
  /**
   * The keyboard layout the running machine gives its guest (a `KEYBOARD_LAYOUTS` id, web/app/keyboard.ts), or none
   * (the guest's own, taken as US): the on-screen keyboard's legends and the characters it types into the serial console.
   */
  keyLayout: undefined as string | undefined,
  /** The LEDs the guest set on the keyboard it reads now (bit 0 Num, 1 Caps, 2 Scroll Lock): the on-screen keyboard lights its lock keys. */
  leds: 0,
  /** The machine has a relative mouse (the lock's `raw` mode). */
  hasMouse: false,
  /** The page can't run here (no cross-origin isolation): no Start. */
  cantRun: false,
  /** Bumped when the network's state changes (the Network menu, the wizard and the Network tab redraw). */
  net: 0,
  /**
   * The Network wizard, open (web/app/NetWizard.svelte, docs/network-adapters.md §3.2): `attach` a connection to
   * `machine`'s adapter `adapter` (machine undefined: the page's transient one), a `new` connection on its own, or `edit`
   * connection `connection`. `here`: the machine is the page's (it connects now, so an auth key is asked for). `tick`
   * opens it again.
   */
  /** Bumped to open the Network menu (a connection was just attached here: it shows how it goes). */
  netMenu: 0,
  netWizard: undefined as undefined | { mode: 'attach' | 'new' | 'edit'; machine?: string; adapter?: number; connection?: string; here?: boolean; tick?: number; /** The local helper's pairing link (`#net=`): the wizard opens on it. */ localURL?: string },
  /**
   * The page's machine's shared folders (docs/shares.md §4): `on` while it runs with them (the toolbar's Folders menu);
   * `path` is where the guest finds them; `wanted` opens the menu (it clears it); `tick` when any of it changes.
   */
  folders: { on: false, path: '', wanted: false, tick: 0 },
  /**
   * Clipboard sharing (docs/plans/clipboard.md §5; the toolbar's clipboard menu): `on` while the page's machine has the
   * setting (its button shows while it runs); its `state`, the browser's read `permission`, `stopped` (focus reads stopped
   * for the run: they came back hidden), whether the agent types (`canType`), `failed`: which of the menu's actions last
   * failed (Send got no text or image, Type no text, Copy the screen no picture or no write), and `typed`: what became
   * of the last Type (the agent's TYPED status: web/agent-frame.ts `TYPED`).
   */
  clipboard: { on: false, state: 'waiting' as ShareState, permission: 'none' as ReadPermission, stopped: false, canType: false, failed: undefined as undefined | 'send' | 'type' | 'screen', typed: undefined as number | undefined },
  /** The Folder wizard, open (web/app/FolderWizard.svelte): for `machine`, which has `attached`; none: it only makes a folder. `tick` opens it again. */
  folderWizard: undefined as undefined | { machine?: string; attached?: FolderAttachment[]; tick?: number },
  boot: { shown: true, done: false, title: '', progress: undefined as number | undefined, line: '', serial: false },
  /**
   * The status bar (web/app/StatusBar.svelte): the last status as JSON (`data`, for tools), the last second's numbers,
   * the names of the running machine's disks, in its order, and the screen's last second (with when it came, ms).
   */
  status: { data: '', metrics: undefined as Metrics | undefined, disks: [] as string[], gpu: undefined as { g: Graphics; at: number } | undefined },
  /** The status bar's elements (Preferences, web/app/statusbar.ts; remembered as the settings' `statusBar`). */
  statusItems: normalize(settings().statusBar),
  /** Full screen takes the status bar along (Preferences; off: the machine alone, edge to edge). */
  statusFullscreen: settings().statusFullscreen === true,
  /** Full screen with the keyboard lock held: the browser's shortcuts reach the machine. */
  keyboardLocked: false,
  /** The screen or the terminal has the focus, in a focused window (the screen's "Click to type" hint is off). */
  keysFocused: false,
  /** The microphone's state (web/audio.ts `micState`), for the status bar. */
  mic: 'off',
  /** A transient machine's size, chosen in the toolbar's Machine menu (a stored machine's is in its Settings). */
  size: { ncpus: 1, ramMiB: 1024, split: undefined as number[] | undefined, gpu: '3d' as '3d' | '2d', vulkan: false, cpuChoices: [] as number[], ramChoices: [] as number[], gpuLock: '' },
  /** Bumped when the store's records change (the toolbar's snapshot list rereads). */
  records: 0,
  /**
   * The page's machine's USB (docs/usb.md "The page"): `on` when it has a controller (the toolbar's USB menu);
   * its remembered devices and their states, what is on each connector while it runs, the offers the menu makes (a
   * device that just appeared, a grant to give), the host's game pads, `zero` with `?usbzero=1` (Gadget Zero in the menu, for tests), and
   * `open`, bumped to open the menu (something to do there). `tick` is bumped whenever any of it changes.
   */
  usb: {
    on: false,
    running: false,
    entries: [] as EntryView[],
    /** `problems`: what of an attached device the guest doesn't get, in words (web/app/usb-ports.ts `problemText`). */
    connectors: [] as ({ name: string; state: string; entry?: string; virtual?: boolean; builtin?: boolean; pad?: number; problems?: ProblemWords[] } | null)[],
    /** The host's game pads the Gamepad API lists (`index`: `Gamepad.index`), for the game pad of ours (docs/usb.md "The game pad"); `hasPads`: the page has the API. */
    pads: [] as { index: number; name: string }[],
    hasPads: false,
    offers: [] as { id: string; text: string; label: string }[],
    zero: false,
    open: 0,
    tick: 0,
  },
});

/** What the components ask of the page (web/app/main.ts fills it in before the first start). */
export type Page = {
  restart(): void;
  suspend(): void;
  /** Take snapshot: kept in the browser (a stored machine) or to a file. */
  takeSnapshot(): void;
  /** Save a snapshot of the running machine to a file (`whole`: disks written in place go in whole). */
  saveSnapshotFile(whole: boolean): void;
  restoreKept(id: string): void;
  loadSnapshot(file: File): void;
  /** A disk image, snapshot or changes file chosen or dropped on the page. */
  openDiskFile(file: File, handle?: FileSystemFileHandle): void;
  /** Open disk…: a disk image picked (with its handle, where the browser has the picker), as if dropped on the page. */
  openDisk(): void;
  /** Opens stored machine `id` on this page. */
  openMachine(id: string): void;
  powerOff(): Promise<void>;
  /** The toolbar's Power off: asks, then stops the machine like pulling the plug. */
  powerOffAsked(): void;
  /** Saves a disk to a file: the page's own (transient machine), or a stored disk with one of its overlays. */
  saveDisk(mode: ExportMode, compress: boolean, target?: { disk: DiskRecord; overlay?: string }): void;
  /** Loads a changes file: onto the page's disk, or into a new overlay of a stored machine's attachment. */
  importChanges(file: File, target?: { machine: MachineRecord; attachment: string }): void;
  resetDisk(): void;
  /** A stored machine's settings saved (a running machine restarts with them). */
  saveSettings(m: MachineRecord): Promise<void>;
  /** A transient machine's size from the Machine menu. */
  applySize(ncpus: number, ramMiB: number, gpu: '3d' | '2d'): void;
  shapeNow(m: MachineRecord): Promise<{ shape: Shape; hash: string }>;
  setView(v: View): void;
  showLog(): void;
  fullscreen(): void;
  /** The toolbar's mouse lock on or off (off lets go of a held mouse), and its mode. */
  setMouseLock(on: boolean, mode?: LockMode): void;
  chord(keys: string[]): void;
  /** Shows or hides the on-screen keyboard; shown, the screen takes the focus (the keys typed on your keyboard go there too). */
  showOsk(on: boolean): void;
  /** Holds key `code` down for `ms` (Hold Esc: a guest's browser leaves its full screen on a held Esc). */
  holdKey(code: string, ms: number): void;
  /**
   * The on-screen keyboard's key `code` down or up, with the modifiers down on it; `repeat`, a held key's repeat. To the
   * serial console when the terminal has the focus (as its own typing does), else to the screen's keys.
   */
  oskKey(code: string, down: boolean, mods: Mods, repeat?: boolean): void;
  screenSize(): void;
  openMachines(tab?: MachinesTab, id?: string): void;
  closeMachines(): void;
  /** Closes the message bar. */
  dismiss(): void;
  /**
   * USB (docs/usb.md "The page"). `machine`: a stored machine's id, or undefined for the page's own. Add opens the
   * browser's chooser (from a click) and remembers what is picked (attached at once when the machine runs here).
   */
  usbAdd(machine: string | undefined, api: 'usb' | 'hid'): Promise<string[]>;
  usbAttach(entry: string): Promise<void>;
  usbDetach(entry: string): Promise<void>;
  usbEdit(machine: string | undefined, entry: string, change: Partial<Pick<UsbEntry, 'connector' | 'atStart'>>): Promise<void>;
  usbForget(machine: string | undefined, entry: string): Promise<void>;
  /** Gives the browser's grant for an entry that has none here (a definition's, made on another browser). */
  usbAllow(machine: string | undefined, entry: string): Promise<void>;
  usbOffer(id: string, take: boolean): void;
  /** The states of a machine's remembered devices now. */
  usbStates(m: MachineRecord): Promise<EntryView[]>;
  /** `?usbzero=1`: attaches Gadget Zero on a free connector, or detaches it. */
  usbZero(): Promise<void>;
  /** Attaches the game pad of ours fed by the host's pad `index` (`Gamepad.index`) on a free connector, or detaches it. */
  usbPad(index: number): Promise<void>;
  /**
   * The network (docs/network-adapters.md §3). `machine`: a stored machine's id, or undefined for the page's
   * transient one; `adapter`: its index. The page's machine connects what is attached to it at once (one another tab's
   * machine has is taken after asking); another machine connects it when it starts.
   */
  netWizard(o: NonNullable<typeof ui.netWizard>): void;
  netCreate(n: NewConnection): Promise<Connection>;
  netAttach(machine: string | undefined, adapter: number, c: Connection, authKey?: string): Promise<void>;
  netDetach(machine: string | undefined, adapter: number): Promise<void>;
  /** The page's machine's adapter `adapter`: connect its attached connection, disconnect, log its node out, its exit node. */
  netConnect(adapter: number): Promise<void>;
  netDisconnect(adapter: number): Promise<void>;
  netLogout(adapter: number): Promise<void>;
  netLogoutConnection(c: Connection): Promise<void>;
  /** The page's machine's record was saved: its adapters take effect. */
  netFollow(): Promise<void>;
  netExit(adapter: number, peer: string): Promise<void>;
  netRoutes(adapter: number, on: boolean): Promise<void>;
  /** A connection's edit (what changes without a new node), name, deletion (after asking), and tailcat's New address (after asking: false if not). */
  netEdit(c: Connection): Promise<void>;
  netRename(c: Connection, name: string): Promise<void>;
  netDelete(c: Connection): Promise<void>;
  netNewAddress(c: Connection): Promise<boolean>;
  /** The name of the machine (in another tab) that has connection `id`. */
  netHolder(id: string): Promise<string | undefined>;
  /**
   * Shared folders (docs/shares.md). Attaching, detaching and the list's order are saved at once, running or not; the
   * page's machine takes them while it runs. `folderPick` opens the browser's picker (from a click).
   */
  folderWizard(machine: string | undefined, attached: FolderAttachment[]): void;
  folderPick(readOnly: boolean): Promise<Folder>;
  folderCreate(n: NewFolder): Promise<Folder>;
  folderAttach(machine: string, f: Folder, readOnly: boolean): Promise<void>;
  folderDetach(machine: string, id: string): Promise<void>;
  folderMove(machine: string, id: string, by: number): Promise<void>;
  folderReadOnly(machine: string, id: string, readOnly: boolean): Promise<void>;
  /** Asks for a folder's grant (from a click). */
  folderAllow(id: string): Promise<void>;
  /** Asks the user, then takes a folder another machine has. */
  folderUseHere(id: string): Promise<void>;
  /**
   * Clipboard sharing (docs/plans/clipboard.md §4–§5), from the user's clicks: `clipboardAsk` asks for the browser's
   * read permission while it is `prompt` (a read the browser prompts for); the toolbar's switch (paused for the run);
   * Send the clipboard to the guest, Type the clipboard (reads on the click); Copy the screen (a PNG of the display
   * written to the host's clipboard with the click's activation, no agent needed: plan §4.4).
   */
  clipboardAsk(): void;
  clipboardPause(paused: boolean): void;
  clipboardSend(): Promise<void>;
  clipboardType(): Promise<void>;
  clipboardScreen(): Promise<void>;
};
export const page = {} as Page;
