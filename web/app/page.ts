// What the components ask of the page (docs/frontend.md "The page's code"): `page`'s actions, which web/app/main.ts
// provides. What the page shows is in its areas' state (web/app/areas/).
import type { Connection, NewConnection } from './connections.ts';
import type { ExportMode } from './export.ts';
import type { Folder, NewFolder } from './folders.ts';
import type { DiskRecord, MachineRecord, Shape, UsbEntry } from './shape.ts';
import type { EntryView } from './usb-live.ts';
import type { MachinesTab } from './areas/machines-nav.svelte.ts';
import type { LockMode } from '../input.ts';
import type { Mods } from './osk.ts';
import type { View } from './areas/screen.svelte.ts';

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
  /** A machine's shape as it would run on this page now, over the browser's `disks`. */
  shapeNow(m: MachineRecord, disks: Map<string, DiskRecord>): Promise<{ shape: Shape; hash: string }>;
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
  usbEdit(
    machine: string | undefined,
    entry: string,
    change: Partial<Pick<UsbEntry, 'connector' | 'atStart'>>,
  ): Promise<void>;
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
  /** Forgets a connection's served identity or room key, after asking: the connection as it is now, or none if not. */
  netNewAddress(c: Connection): Promise<Connection | undefined>;
  /** The name of the machine (in another tab) that has connection `id`. */
  netHolder(id: string): Promise<string | undefined>;
  /**
   * Shared folders (docs/shares.md). Attaching, detaching and the list's order are saved at once, running or not; the
   * page's machine takes them while it runs. `folderPick` opens the browser's picker (from a click).
   */
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
