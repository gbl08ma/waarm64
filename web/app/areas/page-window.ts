// The page around the machine (docs/frontend.md "Views", "Full screen", docs/machines.md §7): the views, full screen
// with the keyboard lock, where the keys go, the Machines page in the machine's place, leaving the page while the
// machine runs, a file dropped on the page, and the local helper's pairing link.
import { flushSync } from 'svelte';
import { devText } from '../../msg.ts';
import { parseLocalURL } from '../../local-net.ts';
import { leaveWarning, remember, settings } from '../settings.ts';
import { shows } from '../statusbar.ts';
import { params } from '../run/knobs.ts';
import type { PageMachine } from '../run/page-machine.svelte.ts';
import type { MachinesTab } from './machines-nav.svelte.ts';
import { machinesNav } from './machines-nav.svelte.ts';
import { keys } from './keys.svelte.ts';
import { network } from './network.ts';
import { isStopped, power } from './power.svelte.ts';
import { screen, type View } from './screen.svelte.ts';
import type { ScreenElements, ScreenView } from './screen-view.ts';
import type { SerialTerminal } from './serial-terminal.ts';
import { status } from './status.svelte.ts';

/** What App.svelte gives the page: the machine's elements as it renders them, and the window's and document's events. */
export type PageView = {
  screen: (els: ScreenElements) => void;
  terminal: (el: HTMLElement) => void;
  main: (el: HTMLElement) => void;
  events: {
    focus: () => void;
    focusLater: () => void;
    beforeUnload: (e: BeforeUnloadEvent) => void;
    hashChange: () => void;
    dragOver: (e: DragEvent) => void;
    drop: (e: DragEvent) => void;
    fullscreenChanged: () => void;
  };
};

const isView = (v: unknown): v is View => v === 'screen' || v === 'terminal' || v === 'both';

export type WindowDeps = {
  machine: PageMachine;
  screen: ScreenView;
  terminal: SerialTerminal;
  /** What the Machines page's closing reads again (a stored machine's record, while nothing runs or switches). */
  reloadStored(): Promise<unknown>;
  /** A file dropped: a disk image, a snapshot or a changes file; a directory: a folder. */
  dropped(file: File, handle?: FileSystemFileHandle): Promise<void>;
  droppedFolder(handle: FileSystemDirectoryHandle): Promise<void>;
  notify(e: unknown): void;
  /** What's typed into the terminal, for the serial console. */
  serial(d: string): void;
};

export class PageWindow {
  readonly #d: WindowDeps;
  /** The page's `main` (the machine's place): full screen takes it, unless the status bar goes along. */
  #main: HTMLElement | undefined;
  constructor(d: WindowDeps) {
    this.#d = d;
  }

  /** What App.svelte gives and calls. */
  view(): PageView {
    const d = this.#d;
    return {
      screen: (els) => d.screen.attach(els),
      terminal: (el) => d.terminal.open(el, (data) => d.serial(data)),
      main: (el) => (this.#main = el),
      events: {
        focus: () => this.focusChanged(),
        focusLater: () => queueMicrotask(() => this.focusChanged()),
        beforeUnload: (e) => this.beforeUnload(e),
        hashChange: () => this.takePairing(),
        dragOver: (e) => this.dragOver(e),
        drop: (e) => this.drop(e),
        fullscreenChanged: () => this.fullscreenChanged(),
      },
    };
  }

  /** The view's input: the terminal in its view, else the screen. */
  #input() {
    return screen.view === 'terminal' ? this.#d.terminal.term : this.#d.screen.canvas;
  }

  // Views: the screen first (M8 decision 2), the terminal, or both.
  setView(v: View, save = true) {
    if (save) remember({ view: v });
    screen.view = v;
    if (machinesNav.open) this.closeMachines();
    flushSync(); // the body's data-view (App.svelte) shows the view now: it is measured and focused below
    this.#d.screen.fit();
    const term = this.#d.terminal.term;
    if (v !== 'screen') term.refresh(0, term.rows - 1);
    this.#input().focus();
  }
  /** The first view: the query's, else the one chosen last in this browser, else the screen (M8 decision 2). */
  firstView() {
    const asked = params.get('view');
    const kept = settings().view;
    this.setView(isView(asked) ? asked : isView(kept) ? kept : 'screen', false);
  }
  /** The serial log shown: the terminal's view, or both. */
  showLog() {
    this.setView(screen.view === 'screen' ? 'both' : screen.view, false);
  }

  // Full screen, with the Keyboard Lock API (Chromium) so that Ctrl+W, Ctrl+T, Esc and the like reach
  // the machine; Chromium leaves full screen when Esc is held.
  fullscreen() {
    const main = this.#main;
    if (!main) return;
    if (machinesNav.open) this.closeMachines();
    this.#input().focus();
    const lock = navigator.keyboard;
    // Without the lock (refused, or another browser), the browser keeps its shortcuts.
    // With the status bar along (Preferences), the page goes full screen without its toolbar and message bar.
    const target = status.fullscreen && shows(status.items) ? document.body : main;
    target
      .requestFullscreen({ navigationUI: 'hide' })
      .then(() => lock?.lock())
      .then(() => {
        keys.locked = !!lock && !!document.fullscreenElement;
      })
      .catch(() => undefined); // refused: the page stays as it is
  }
  /** Full screen left: the keyboard lock goes with it. */
  fullscreenChanged() {
    if (document.fullscreenElement) return;
    navigator.keyboard?.unlock();
    keys.locked = false;
  }
  // Where keys go, for the status bar's Keyboard: the screen or the terminal focused in a focused window (what the
  // screen's "Click to type" hint says otherwise).
  focusChanged() {
    const a = document.activeElement;
    keys.focused = document.hasFocus() && !!a && (a.id === 'screen' || !!a.closest('#terminal'));
  }

  // Leaving the page while the machine runs stops it like pulling the plug: the browser asks first (Preferences, on
  // the Machines page, turns it off). The browser words the question itself. Not under automation (the tests navigate
  // away from running machines) unless `?leavewarning=1`.
  beforeUnload(e: BeforeUnloadEvent) {
    if (!['running', 'booting', 'rebooting'].includes(power.state) || !leaveWarning()) return;
    if (navigator.webdriver && params.get('leavewarning') !== '1') return;
    e.preventDefault();
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- older Chromium asks only with this set
    e.returnValue = '';
  }

  // The Machines page (docs/machines.md §7; web/app/MachinesPage.svelte): in the machine's place, which runs on behind
  // it. `#machines` in the address opens it (a reload keeps it open).
  openMachines(tab?: MachinesTab, id?: string) {
    if (tab) machinesNav.tab = tab;
    if (id) machinesNav.choose(id);
    machinesNav.open = true;
    if (location.hash !== '#machines')
      history.replaceState(null, '', `${location.pathname}${location.search}#machines`);
  }
  closeMachines() {
    machinesNav.open = false;
    // What the page changed shows in the toolbar now (a running machine takes it at its next start). Stopped by the
    // guest (off, crashed, suspended), the run is still `machine.run` until the next stop: the state says.
    if (isStopped(power.state) && !power.busy) void this.#d.reloadStored();
    if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
    queueMicrotask(() => {
      this.#d.screen.fit();
      this.#input().focus();
    });
  }

  dragOver(e: DragEvent) {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  }
  /** A file or a directory dropped on the page. */
  drop(e: DragEvent) {
    const dt = e.dataTransfer;
    const file = dt?.files[0];
    if (!dt || !file) return;
    e.preventDefault();
    // The item's handle (Chromium), so the machine made for it can read it in later sessions too (machines.md §3.2).
    const item = dt.items[0] as DataTransferItem | undefined;
    const handle = item?.getAsFileSystemHandle?.().catch(() => null); // Chromium's: other browsers' items have none
    void (async () => {
      const h = await handle;
      if (h?.kind === 'directory')
        return void this.#d.droppedFolder(h as FileSystemDirectoryHandle).catch((err: unknown) => this.#d.notify(err));
      void this.#d.dropped(file, h?.kind === 'file' ? (h as FileSystemFileHandle) : undefined);
    })();
  }

  // The local helper's pairing link (webpc-net prints `https://vm.tny.im/#net=ws://127.0.0.1:<port>/<token>`): the
  // fragment never reached a server; it leaves the address at once (it holds the token) and opens the Network wizard
  // on it, attaching to the page's machine's first adapter when there's one. Also when the link is opened in a tab
  // that already shows the page: only the fragment changes, and the browser doesn't load the page again.
  takePairing() {
    const pairing = new URLSearchParams(location.hash.slice(1)).get('net');
    if (!pairing) return;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    const p = parseLocalURL(pairing);
    const id = this.#d.machine.stored?.record.id;
    if ('url' in p)
      network.openWizard(
        id ? { mode: 'attach', machine: id, adapter: 0, localURL: p.url } : { mode: 'new', localURL: p.url },
      );
    else console.warn(`#net: ${devText(p.error)}`);
  }
}
