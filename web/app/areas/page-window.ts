// The page around the machine (docs/frontend.md "Views", "Full screen", docs/machines.md §7): the views, full screen
// with the keyboard lock, where the keys go, the Home page in the machine's place, leaving the page while the
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
import { demos } from './demos.svelte.ts';
import { demosAddress, demosRoute, firstVisit, leftDemos, type DemosRoute } from '../demos-route.ts';
import type { Page } from '../page.ts';
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
    popState: () => void;
    dragOver: (e: DragEvent) => void;
    drop: (e: DragEvent) => void;
    fullscreenChanged: () => void;
  };
};

/** How an address is written: a new history entry (a step the visitor took), in place of the current one, or not at all. */
type Nav = 'push' | 'replace' | 'none';
/** Address `url` written as `nav` says (nothing when it is the current one). */
function go(url: string, nav: Nav) {
  if (nav === 'none' || url === `${location.pathname}${location.search}${location.hash}`) return;
  if (nav === 'push') history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}

const isView = (v: unknown): v is View => v === 'screen' || v === 'terminal' || v === 'both';

export type WindowDeps = {
  machine: PageMachine;
  screen: ScreenView;
  terminal: SerialTerminal;
  /** What the Home page's closing reads again (a stored machine's record, while nothing runs or switches). */
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
        hashChange: () => {
          this.takePairing();
          const r = demosRoute(location);
          if (r) this.openDemos(r, 'replace');
        },
        popState: () => this.followAddress(),
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
    if (demos.open) this.closeDemos(false);
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
  // the Home page, turns it off). The browser words the question itself. Not under automation (the tests navigate
  // away from running machines) unless `?leavewarning=1`.
  beforeUnload(e: BeforeUnloadEvent) {
    if (!['running', 'booting', 'rebooting'].includes(power.state) || !leaveWarning()) return;
    if (navigator.webdriver && params.get('leavewarning') !== '1') return;
    e.preventDefault();
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- older Chromium asks only with this set
    e.returnValue = '';
  }

  // The Home page (docs/machines.md §7; web/app/MachinesPage.svelte): in the machine's place, which runs on behind
  // it. `#home` in the address opens it (a reload keeps it open; main.ts takes the older `#machines` too).
  openMachines(tab?: MachinesTab, id?: string) {
    if (demos.open) {
      demos.open = false;
      history.replaceState(null, '', leftDemos(location));
    }
    if (tab) machinesNav.tab = tab;
    if (id) machinesNav.choose(id);
    machinesNav.open = true;
    if (location.hash !== '#home') history.replaceState(null, '', `${location.pathname}${location.search}#home`);
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

  // The demo store's page (docs/frontend.md "The demo store"; web/app/DemosPage.svelte): in the machine's place, and
  // Home's, which it closes (its Back returns there). Its address (`/demos`, `#demos`, with `?id=`, `?store=`) keeps it
  // open across a reload; closed, the address is the page's own again. Each step the visitor takes in it (opened, a demo
  // chosen, All demos, left) is an entry of the browser's history (`push`), so its Back retraces them
  // (`followAddress`); what the address itself opened only tidies the address (`replace`).
  openDemos(route: DemosRoute = demos.route, nav: Nav = 'push') {
    if (!demos.open) demos.from = machinesNav.open ? 'home' : 'machine';
    if (machinesNav.open) machinesNav.open = false;
    demos.route = route;
    demos.open = true;
    go(demosAddress(location, route), nav);
  }
  /**
   * The browser's Back or Forward (`popstate`): the store's page as the address now says, without writing the history:
   * opened on its route, or closed (to Home for `#home`, else to the machine).
   */
  followAddress() {
    const r = demosRoute(location);
    if (r) return this.openDemos(r, 'none');
    if (!demos.open) return;
    if (location.hash === '#home') {
      demos.from = 'home';
      return this.closeDemos(true, 'none');
    }
    demos.from = 'machine';
    this.closeDemos(true, 'none');
  }
  /**
   * What the address opens at the page's load: the store's page (`/demos`, `#demos`), Home (`#home`, the older
   * `#machines`), or, on a first visit (no machines: `machines`), the store.
   */
  openFromAddress(machines: number) {
    const r = demosRoute(location);
    if (r) this.openDemos(r, 'replace');
    else if (location.hash === '#home' || location.hash === '#machines') this.openMachines();
    else if (firstVisit(location, machines, navigator.webdriver)) this.openDemos(undefined, 'replace');
  }
  /** The store's page's part of `page`: `switchTo` opens a stored machine (asked first by `askSwitch`). */
  demoActions(d: {
    switchTo: (id: string) => Promise<void>;
    askSwitch: (id?: string) => Promise<boolean>;
  }): Pick<Page, 'openDemos' | 'closeDemos' | 'chooseDemo' | 'askSwitch' | 'openDemo'> {
    return {
      openDemos: (route) => this.openDemos(route),
      closeDemos: (back) => this.closeDemos(back),
      chooseDemo: (id) => this.chooseDemo(id),
      askSwitch: d.askSwitch,
      openDemo: (id, view) => {
        this.closeDemos(false);
        // Not saved as the visitor's view: it's the demo's (review demo-page-2 #9).
        this.setView(view === 'serial' ? 'terminal' : 'screen', false);
        return d.switchTo(id);
      },
    };
  }
  /** The demo `id` chosen in the store shown (undefined: its cards), in the address too. */
  chooseDemo(id?: string) {
    const { id: _, ...rest } = demos.route;
    this.openDemos(id ? { ...rest, id } : rest);
  }
  /** Back (`back`: to Home, when it came from there; else to the machine), or a demo's machine opened (not `back`). */
  closeDemos(back = true, nav: Nav = 'push') {
    demos.open = false;
    go(leftDemos(location), nav);
    if (back && demos.from === 'home') return this.openMachines();
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

  // The local helper's pairing link (waarm64-net prints `https://vm.tny.im/#net=ws://127.0.0.1:<port>/<token>`): the
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
