// The page around the machine (docs/frontend.md "Views", "Full screen", docs/machines.md §7): the views, full screen
// with the keyboard lock, where the keys go, the Home page in the machine's place and its levels, leaving the page while
// the machine runs, a file dropped on the page, and the local helper's pairing link (web/app/areas/pairing.ts).
import { flushSync } from 'svelte';
import { leaveWarning, remember, settings } from '../settings.ts';
import { shows } from '../statusbar.ts';
import { params } from '../run/knobs.ts';
import type { PageMachine } from '../run/page-machine.svelte.ts';
import type { MachinesTab } from './machines-nav.svelte.ts';
import { machinesNav } from './machines-nav.svelte.ts';
import { homeRoute, type Known } from '../home-route.ts';
import { HomeLevels, writeHome } from './home-levels.ts';
import { demos } from './demos.svelte.ts';
import { demosAddress, demosRoute, firstVisit, leftDemos, pageQuery, type DemosRoute } from '../demos-route.ts';
import { intro } from './intro.svelte.ts';
import { afterIntro, INTRO_HASH, introFromPath, isIntroAddress } from '../intro-route.ts';
import { records } from './records.svelte.ts';
import { transition } from '../view-transition.ts';
import type { Page } from '../page.ts';
import { keys } from './keys.svelte.ts';
import { takePairing } from './pairing.ts';
import { isStopped, power } from './power.svelte.ts';
import { screen, splitShare, type View } from './screen.svelte.ts';
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

/**
 * The view a demo opened this tab in (its `view`), kept for this tab's reloads without being the visitor's preference
 * (review demo-page-2 #9): a view the visitor chooses replaces it. sessionStorage may refuse (then: none).
 */
const TAB_VIEW = 'waarm64-demo-view';
function tabView(v?: View | null): string | null {
  try {
    if (v === null) sessionStorage.removeItem(TAB_VIEW);
    else if (v) sessionStorage.setItem(TAB_VIEW, v);
    return sessionStorage.getItem(TAB_VIEW);
  } catch {
    return null;
  }
}

export type WindowDeps = {
  machine: PageMachine;
  screen: ScreenView;
  terminal: SerialTerminal;
  /** The browser's connections (Home's levels: a connection's page). */
  connections: () => readonly Known[];
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
  /** Home's levels: a connection's page. */
  readonly home: HomeLevels;
  constructor(d: WindowDeps) {
    this.#d = d;
    this.home = new HomeLevels({
      connections: d.connections,
      openMachines: (tab, id) => this.openMachines(tab, id),
      closeMachines: () => this.closeMachines(),
    });
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
          const home = homeRoute(location.hash);
          if (r) this.openDemos(r, 'replace');
          else if (isIntroAddress(location)) this.openIntro('none');
          else if (home) this.home.open(home);
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
    if (save) {
      remember({ view: v });
      tabView(null);
    }
    screen.view = v;
    if (machinesNav.open) this.closeMachines();
    if (demos.open) this.closeDemos(false);
    flushSync(); // the body's data-view (App.svelte) shows the view now: it is measured and focused below
    this.#d.screen.fit();
    const term = this.#d.terminal.term;
    if (v !== 'screen') term.refresh(0, term.rows - 1);
    this.#input().focus();
  }
  /**
   * The first view: the query's, else the demo's this tab opened (a reload of it), else the one chosen last in this
   * browser, else the screen (M8 decision 2).
   */
  firstView() {
    const asked = params.get('view');
    const demo = tabView();
    const kept = settings().view;
    const split = settings().split;
    screen.split = { across: splitShare(split?.across), stacked: splitShare(split?.stacked) };
    this.setView(isView(asked) ? asked : isView(demo) ? demo : isView(kept) ? kept : 'screen', false);
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
  // it. `#home` in the address opens it (a reload keeps it open; main.ts takes the older `#machines` too), and
  // `#home/connections/<id>` (`…/settings`, `…/domains`) a connection's page, one level down (`home`:
  // web/app/areas/home-levels.ts).
  openMachines(tab?: MachinesTab, id?: string) {
    if (demos.open) {
      demos.open = false;
      history.replaceState(null, '', leftDemos(location));
    }
    // A machine or a pane asked for is at the root.
    if (id) machinesNav.leave();
    if (tab) machinesNav.tab = tab;
    if (id) machinesNav.choose(id);
    machinesNav.open = true;
    writeHome();
  }
  closeMachines() {
    machinesNav.open = false;
    machinesNav.reset();
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
   * opened on its route, or closed (to Home for `#home`, else to the machine); and Home's level (`home.follow`).
   */
  followAddress() {
    intro.open = isIntroAddress(location);
    const r = demosRoute(location);
    if (r) return this.openDemos(r, 'none');
    if (demos.open) {
      demos.from = location.hash === '#home' ? 'home' : 'machine';
      this.closeDemos(true, 'none');
    }
    // Home's levels: the browser's Back leaves one, Forward enters it again (web/app/areas/home-levels.ts).
    if (!intro.open) this.home.follow();
  }
  /**
   * What the address opens at the page's load: the store's page (`/demos`, `#demos`), Home (`#home`, the older
   * `#machines`), the introduction (`#intro`), or, on a first visit (no machines: `machines`), the introduction.
   */
  /** The page shows something else than the machine: the introduction, Home or the demo store's page. */
  elsewhere() {
    return intro.open || demos.open || machinesNav.open;
  }

  openFromAddress(machines: number) {
    // `/intro` is a way in: the address becomes the page's own with `#intro` (web/app/intro-route.ts).
    const own = introFromPath(location);
    if (own) history.replaceState(null, '', own);
    const r = demosRoute(location);
    const home = homeRoute(location.hash);
    if (r) this.openDemos(r, 'replace');
    else if (home) this.home.open(home);
    else if (isIntroAddress(location) || firstVisit(location, machines, navigator.webdriver)) this.openIntro('replace');
  }

  // The introduction (docs/frontend.md "The introduction"; web/app/IntroPage.svelte): the whole window, over the
  // machine and the pages that take its place, which stay as they were under it. `#intro` in the address keeps it open
  // across a reload. Leaving it is one movement (web/app/view-transition.ts): the toolbar and the status bar come in.
  openIntro(nav: Nav = 'push') {
    intro.open = true;
    go(`${location.pathname}${pageQuery(location.search)}${INTRO_HASH}`, nav);
  }
  /**
   * The introduction left: for the demo store's page (`demos`), or where its Skip leads (`auto`: the store, or Home
   * for a visitor with machines here), or Home's About pane (`about`: the introduction's credits lead there).
   * Resolves once the page shows where it led.
   */
  closeIntro(to: 'demos' | 'auto' | 'about' = 'auto') {
    const dest = to === 'auto' ? afterIntro(records.machines.length) : to;
    return transition('intro', () => {
      intro.open = false;
      if (dest === 'home') this.openMachines();
      else if (dest === 'about') this.openMachines(undefined, 'about');
      else this.openDemos();
    });
  }
  /** The store's page's part of `page`: `switchTo` opens a stored machine (asked first by `askSwitch`). */
  demoActions(d: {
    switchTo: (id: string) => Promise<void>;
    askSwitch: (id?: string) => Promise<boolean>;
  }): Pick<Page, 'openDemos' | 'closeDemos' | 'chooseDemo' | 'askSwitch' | 'openDemo' | 'openIntro' | 'closeIntro'> {
    return {
      openIntro: () => this.openIntro(),
      closeIntro: (to) => this.closeIntro(to),
      openDemos: (route) => this.openDemos(route),
      closeDemos: (back) => this.closeDemos(back),
      chooseDemo: (id) => this.chooseDemo(id),
      askSwitch: d.askSwitch,
      openDemo: async (id, view) => {
        // Not saved as the visitor's view: it's the demo's, kept for this tab's reloads (review demo-page-2 #9).
        const v = view === 'serial' ? 'terminal' : 'screen';
        tabView(v);
        // The demo's pane becomes its machine: one movement, then the machine starts in it.
        await transition('launch', () => {
          this.closeDemos(false);
          this.setView(v, false);
        });
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

  /** The local helper's pairing link in the address, if any (web/app/areas/pairing.ts). */
  takePairing() {
    takePairing(this.#d.machine.stored?.record.id);
  }
}
