// The network's commands (docs/network-adapters.md §3): the toolbar's Network menu (web/app/Network.svelte) and the
// Network wizard (web/app/NetWizard.svelte) open themselves when called; the page's live network is web/app/net-live.ts.
import { Command } from '../command.ts';
import type { Opened } from '../net-wizard.ts';

class Network {
  /** Answered by the Network menu and the wizard. */
  readonly menu = new Command();
  readonly wizard = new Command<[Opened]>();
  /** Opens the Network menu (a connection was just attached here: it shows how it goes). */
  openMenu() {
    this.menu.call();
  }
  openWizard(o: Opened) {
    this.wizard.call(o);
  }
}
export const network = new Network();
