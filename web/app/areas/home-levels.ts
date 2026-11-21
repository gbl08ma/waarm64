// The Home page's levels (docs/frontend.md "The Home page"; web/app/home-route.ts): a connection's page entered, its
// sections, its Back, and the address that says where Home is. Going down a level is an entry of the browser's history
// (pushed, with where it was entered from in its state: `HomeState`), so the browser's Back leaves the level and Forward
// enters it again (`follow`, on `popstate`); moving between a level's sections, and Home opened or closed, write the
// address in place, as moving between the root's panes does. web/app/areas/page-window.ts opens and closes Home
// itself, and gives this its `openMachines` and `closeMachines`; the state is web/app/areas/machines-nav.svelte.ts's.
import type { Page } from '../page.ts';
import {
  homeHash,
  homeRoute,
  homeState,
  type ConnectionSection,
  type From,
  type HomeRoute,
  type HomeState,
  type Known,
} from '../home-route.ts';
import { machinesNav, type MachinesTab } from './machines-nav.svelte.ts';

const addressOf = (hash: string) => `${location.pathname}${location.search}${hash}`;

/**
 * Home's address as its level says (`#home`, or a connection's section), in place: a level's entry keeps its state.
 * `push`: as an entry of its own (a link out of a pushed level, whose entry the browser's Back then returns to).
 */
export function writeHome(nav: 'replace' | 'push' = 'replace') {
  const ctx = machinesNav.context;
  const hash = homeHash(ctx && { id: ctx.id, section: ctx.section });
  if (nav === 'push') history.pushState(null, '', addressOf(hash));
  else if (location.hash !== hash) history.replaceState(ctx ? history.state : null, '', addressOf(hash));
}

/** Whether the level shown was pushed on top of where it was entered from (its entry is the history's current one). */
export const inPushedLevel = () =>
  !!machinesNav.context &&
  !!homeState(history.state)?.pushed &&
  homeRoute(location.hash)?.connection?.id === machinesNav.context.id;

/** How long a `history.back()` the column's Back started may take to arrive (`popstate`) before Back is taken again. */
const BACK_MAX_MS = 1000;

type HomeDeps = {
  /** The browser's connections (a level is a connection's page while it exists). */
  connections: () => readonly Known[];
  openMachines(tab?: MachinesTab, id?: string): void;
  closeMachines(): void;
};

export class HomeLevels {
  readonly #d: HomeDeps;
  /** When a `history.back()` the column's Back started (0: none on its way): Back and Esc wait for its `popstate`. */
  #backing = 0;
  constructor(d: HomeDeps) {
    this.#d = d;
    machinesNav.follow({ connections: d.connections });
  }

  /**
   * Home as address `r` says (a load, a pasted address, a change of fragment): its root, or a connection's page
   * entered from Connections, in place of the address. Where Home is there already (the browser's Back or Forward,
   * which `follow` took), nothing changes.
   */
  open(r: HomeRoute) {
    const ctx = machinesNav.context;
    const at = r.connection;
    if (at && machinesNav.open && ctx?.id === at.id && ctx.section === at.section) return;
    if (at) this.openConnection(at.id, at.section, { to: 'connections' }, 'replace');
    else this.#d.openMachines();
  }
  /**
   * Connection `id`'s page on Home, at `section`, entered from `from` (where its Back leads: Connections, a machine's
   * Network tab, or the machine's screen). The same connection's page again moves to the section, instantly, and keeps
   * where it was entered from.
   */
  openConnection(
    id: string,
    section: ConnectionSection = 'details',
    from: From = { to: 'connections' },
    nav: 'push' | 'replace' = 'push',
  ) {
    const ctx = machinesNav.context;
    const same = ctx?.id === id;
    machinesNav.enter({ kind: 'connection', id, section, from: same ? ctx.from : from });
    const now = machinesNav.context;
    // Down a level: an entry of its own (`replace`: one the address opened, whose Back has nothing to retrace).
    if (now && !same) {
      const url = addressOf(homeHash({ id, section: now.section }));
      // A plain copy of `from`: a component's state (a proxy) can't be cloned into the history.
      const plain: From =
        from.to === 'tab'
          ? { to: 'tab', machine: from.machine, ...(from.tab ? { tab: from.tab } : {}) }
          : { to: from.to };
      if (nav === 'push') history.pushState({ home: { from: plain, pushed: true } } satisfies HomeState, '', url);
      else history.replaceState(null, '', url);
    }
    // Home opens on it; the address says it (an unknown id: the root's, at Connections).
    this.#d.openMachines();
  }
  /**
   * The column's Back (and Esc) in a context: to where it was entered from (`machinesNav.back`). A level whose entry
   * was pushed on top of that place goes back in the browser's history (`follow` then leaves it), so Forward enters it
   * again and no entry is left over; one the address opened is left in place. Once only: while a move between levels
   * shows, or the history's Back is on its way, Back and Esc pressed again are ignored.
   */
  leaveContext() {
    if (machinesNav.moving || (this.#backing && performance.now() - this.#backing < BACK_MAX_MS)) return;
    if (inPushedLevel()) {
      this.#backing = performance.now();
      history.back();
      return;
    }
    this.#leave();
  }
  /**
   * The level's connection is gone (deleted from its page or elsewhere, or unknown when its address was opened): Home
   * leaves it for Connections, whose title takes the focus, and its address is Home's root, in place.
   */
  gone() {
    machinesNav.leave({ connections: true, focus: 'title' });
    writeHome();
  }
  /**
   * The browser's Back or Forward (`popstate`, an address of neither the store's page nor the introduction): Home's
   * level as the address and its entry's state say, writing no new entry. A connection's address enters it (from where
   * the state says it was entered, else Connections); any other leaves the level for where its Back leads.
   */
  follow() {
    this.#backing = 0;
    const r = homeRoute(location.hash);
    const ctx = machinesNav.context;
    const at = r?.connection;
    if (at) {
      const from = homeState(history.state)?.from ?? { to: 'connections' };
      machinesNav.enter({
        kind: 'connection',
        id: at.id,
        section: at.section,
        from: ctx?.id === at.id ? ctx.from : from,
      });
      this.#d.openMachines();
    } else if (ctx) this.#leave(r ? undefined : 'screen');
  }
  /**
   * Leaves the level for where its Back leads (`screen`: the address says the machine's), in place: Connections with
   * the card's Details focused, a machine's pane at its tab with its title focused, or the machine's screen.
   */
  #leave(force?: 'screen') {
    const to = force ? { to: force } : machinesNav.back;
    if (to?.to === 'connections') machinesNav.leave({ connections: true, focus: 'card' });
    else machinesNav.leave({ focus: to?.to === 'tab' ? 'title' : undefined });
    if (to?.to === 'screen') this.#d.closeMachines();
    else if (to?.to === 'tab') this.#d.openMachines(to.tab ?? 'network', to.machine);
    else writeHome();
  }
  /** Their part of `page`. */
  page(): Pick<Page, 'openConnection' | 'leaveContext' | 'contextGone'> {
    return {
      openConnection: (id, section, from) => this.openConnection(id, section, from),
      leaveContext: () => this.leaveContext(),
      contextGone: () => this.gone(),
    };
  }
}
