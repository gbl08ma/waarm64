// Where the page is (docs/machines.md §7): the machine, or the Machines page in its place (`#machines` in the address),
// with its chosen pane and the machine tab shown. web/app/areas/page-window.ts opens and closes it (`page.openMachines`); the
// Machines page's list chooses a pane.
import { PAGE, PANES } from '../machines-panes.ts';
import { current } from './current.svelte.ts';
import { records } from './records.svelte.ts';

export type MachinesTab = 'settings' | 'disks' | 'network' | 'usb' | 'folders' | 'snapshots';

class MachinesNav {
  /** The Machines page shows instead of the machine. */
  open = $state(false);
  /** A machine's tab shown. */
  tab = $state<MachinesTab>('settings');
  /** The pane chosen: a machine's id or one of the panes that aren't a machine's (web/app/machines-panes.ts). */
  #chosen = $state<string>();
  /**
   * The pane shown: the one chosen, else the page's machine's (a stored one's, or the transient one's: `PAGE`); none
   * once the machine chosen is gone.
   */
  readonly selected = $derived.by(() => {
    const id = this.#chosen ?? current.id ?? (current.transient ? PAGE : undefined);
    return id && (PANES.has(id) || records.machines.some((m) => m.id === id)) ? id : undefined;
  });

  choose(id: string) {
    this.#chosen = id;
  }
}
export const machinesNav = new MachinesNav();
