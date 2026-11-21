// Where the page is (docs/machines.md §7, docs/frontend.md "The Home page"): the machine, or the Home page in its place
// (`#home` in the address), with its chosen pane, the machine tab shown and its level: the root, or a context one level
// down (a connection's page, web/app/home-route.ts), which the column's entries and the pane show instead of the root's.
// web/app/areas/page-window.ts opens and closes it and writes the address (`page.openMachines`, `page.openConnection`,
// `page.leaveContext`); the Home page's list chooses a pane.
import { CONNECTIONS, PAGE, PANES } from '../machines-panes.ts';
import { backOf, shownContext, type HomeContext, type Known } from '../home-route.ts';
import { current } from './current.svelte.ts';
import { records } from './records.svelte.ts';

export type MachinesTab = 'settings' | 'disks' | 'network' | 'usb' | 'folders' | 'snapshots';

class MachinesNav {
  /** The Home page shows instead of the machine. */
  open = $state(false);
  /** A machine's tab shown. */
  tab = $state<MachinesTab>('settings');
  /** The pane chosen: a machine's id or one of the panes that aren't a machine's (web/app/machines-panes.ts). */
  #chosen = $state<string>();
  /** The level entered (none: the root), as entered: `context` is what the page shows of it. */
  #context = $state<HomeContext>();
  /** The browser's connections (web/app/net-live.ts's, given once by main.ts: `follow`). */
  #connections: () => readonly Known[] = () => [];
  /** The way the last move between levels went: down into a context, or up out of one (the transitions read it). */
  direction = $state<'down' | 'up'>('down');
  /** A level was just entered: its pane's title takes the focus (once). */
  focusPane = $state(false);
  /** A level was just left for Connections: the card of this connection gives its Details button the focus (once). */
  returnFocus = $state<string>();

  /**
   * The pane shown: the one chosen, else the page's machine's (a stored one's, or the transient one's: `PAGE`); none
   * once the machine chosen is gone. In a context, Connections.
   */
  readonly selected = $derived.by(() => {
    const id = this.#chosen ?? current.id ?? (current.transient ? PAGE : undefined);
    return id && (PANES.has(id) || records.machines.some((m) => m.id === id)) ? id : undefined;
  });
  /** The level shown: none at the root, and once its connection is gone (then Connections). */
  readonly context = $derived(shownContext(this.#context, (id) => this.#connections().find((c) => c.id === id)));
  /** Where the context's Back leads (none at the root). */
  readonly back = $derived(
    this.context &&
      backOf(this.context.from, {
        loaded: current.loaded,
        machineName: (id) => records.machines.find((m) => m.id === id)?.name,
      }),
  );
  /** What the column and the pane are keyed by: a change of it is a move between levels, which they show. */
  readonly level = $derived(this.context ? `${this.context.kind}:${this.context.id}` : 'root');

  /** Whether the pane that appears takes the focus: once, after a level was entered (a Pane's `takeFocus`). */
  takeFocus() {
    const was = this.focusPane;
    this.focusPane = false;
    return was;
  }
  /** Whether connection `id`'s card takes the focus back: once, after its page was left for Connections. */
  takeReturn(id: string) {
    if (this.returnFocus !== id) return false;
    this.returnFocus = undefined;
    return true;
  }
  /** Reads the connections from `o` (main.ts, once). */
  follow(o: { connections: () => readonly Known[] }) {
    this.#connections = o.connections;
  }
  choose(id: string) {
    this.#chosen = id;
  }
  /** Enters `ctx` (or moves to another of its sections: instant, as between the root's panes). */
  enter(ctx: HomeContext) {
    if (this.#context?.id !== ctx.id) {
      this.direction = 'down';
      this.focusPane = true;
    } else this.focusPane = false;
    this.#context = ctx;
    this.#chosen = CONNECTIONS;
  }
  /** Back to the root; `toCard`: to Connections, where the connection's card takes the focus. */
  leave(toCard = false) {
    const was = this.#context;
    if (!was) return;
    this.direction = 'up';
    this.focusPane = false;
    this.returnFocus = toCard ? was.id : undefined;
    this.#context = undefined;
  }
  /** The Home page closed: it opens at its root next time (Connections, where the level was). */
  reset() {
    this.#context = undefined;
    this.focusPane = false;
    this.returnFocus = undefined;
  }
}
export const machinesNav = new MachinesNav();
