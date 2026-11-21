// The Home page's levels (docs/frontend.md "The Home page"; web/app/home-route.ts): a connection's page entered, its
// sections, its Back, and the address that says where Home is, written in place (the browser's Back leaves Home as
// before). web/app/areas/page-window.ts opens and closes Home itself, and gives this its `openMachines` and
// `closeMachines`; the state is web/app/areas/machines-nav.svelte.ts's.
import type { Page } from '../page.ts';
import { homeHash, type ConnectionSection, type From, type HomeRoute, type Known } from '../home-route.ts';
import { machinesNav, type MachinesTab } from './machines-nav.svelte.ts';

/** Home's address as its level says (`#home`, or a connection's section). */
export function writeHome() {
  const ctx = machinesNav.context;
  const hash = homeHash(ctx && { id: ctx.id, section: ctx.section });
  if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
}

type HomeDeps = {
  /** The browser's connections (a level is a connection's page while it exists). */
  connections: () => readonly Known[];
  openMachines(tab?: MachinesTab, id?: string): void;
  closeMachines(): void;
};

export class HomeLevels {
  readonly #d: HomeDeps;
  constructor(d: HomeDeps) {
    this.#d = d;
    machinesNav.follow({ connections: d.connections });
  }

  /** Home as address `r` says: its root, or a connection's page (entered from Connections). */
  open(r: HomeRoute) {
    if (r.connection) this.openConnection(r.connection.id, r.connection.section);
    else this.#d.openMachines();
  }
  /**
   * Connection `id`'s page on Home, at `section`, entered from `from` (where its Back leads: Connections, a machine's
   * Network tab, or the machine's screen). The same connection's page again moves to the section, instantly, and keeps
   * where it was entered from.
   */
  openConnection(id: string, section: ConnectionSection = 'details', from: From = { to: 'connections' }) {
    const ctx = machinesNav.context;
    machinesNav.enter({ kind: 'connection', id, section, from: ctx?.id === id ? ctx.from : from });
    // Home opens on it; the address says it (an unknown id: the root's, at Connections).
    this.#d.openMachines();
  }
  /** The column's Back (and Esc) in a context: to where it was entered from (`machinesNav.back`). */
  leaveContext() {
    const to = machinesNav.back;
    machinesNav.leave(to?.to === 'connections');
    if (to?.to === 'screen') this.#d.closeMachines();
    else if (to?.to === 'tab') this.#d.openMachines('network', to.machine);
    else writeHome();
  }
  /** Their part of `page`. */
  page(): Pick<Page, 'openConnection' | 'leaveContext'> {
    return {
      openConnection: (id, section, from) => this.openConnection(id, section, from),
      leaveContext: () => this.leaveContext(),
    };
  }
}
