// The network's commands (docs/networking/adapters.md §3): the toolbar's Network menu (web/app/Network.svelte), the Network
// wizard (web/app/NetWizard.svelte) and an adapter's details (web/app/NetDetails.svelte) open themselves when called;
// the page's live network is web/app/net-live.ts.
import { Command } from '../command.ts';
import type { Opened } from '../net-wizard.ts';

class Network {
  /** Answered by the Network menu (an adapter's index: its own button's, where each adapter has one) and the wizard. */
  readonly menu = new Command<[number | undefined]>();
  readonly wizard = new Command<[Opened]>();
  readonly details = new Command<[number]>();
  /** Opens the Network menu (a connection was just attached to `adapter` here: it shows how it goes). */
  openMenu(adapter?: number) {
    this.menu.call(adapter);
  }
  openWizard(o: Opened) {
    this.wizard.call(o);
  }
  /** Opens adapter `adapter`'s details: its connection, what it lets in and how to use it. */
  openDetails(adapter: number) {
    this.details.call(adapter);
  }
}
export const network = new Network();
