// The network's commands (docs/networking/adapters.md §3): the toolbar's Network menu (web/app/Network.svelte), the Network
// wizard (web/app/NetWizard.svelte) and Name this machine… (web/app/NameDialog.svelte) open themselves when called (a
// connection's Details is a page of the Home page: `page.openConnection`);
// the page's live network is web/app/net-live.ts.
import { Command } from '../command.ts';
import type { Opened } from '../net-wizard.ts';

class Network {
  /** Answered by the Network menu (an adapter's index: its own button's, where each adapter has one) and the wizard. */
  readonly menu = new Command<[number | undefined]>();
  readonly wizard = new Command<[Opened]>();
  /** Answered by Name this machine…'s dialog (web/app/NameDialog.svelte). */
  readonly naming = new Command<[number]>();
  /** Opens the Network menu (a connection was just attached to `adapter` here: it shows how it goes). */
  openMenu(adapter?: number) {
    this.menu.call(adapter);
  }
  openWizard(o: Opened) {
    this.wizard.call(o);
  }
  /** Opens Name this machine… for adapter `adapter` (a room's): one dialog, a name checked as typed and Register. */
  openNaming(adapter: number) {
    this.naming.call(adapter);
  }
}
export const network = new Network();
