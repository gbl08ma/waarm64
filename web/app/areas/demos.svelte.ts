// The demo store's page (docs/frontend.md "The demo store"; web/app/DemosPage.svelte): whether it shows (in the
// machine's place, as Home does), the store and demo the address asks for (web/app/demos-route.ts), and where its Back
// returns. web/app/areas/page-window.ts opens and closes it (`page.openDemos`).
import { OUR_STORE } from '../demo-store.ts';
import type { DemosRoute } from '../demos-route.ts';

class Demos {
  /** The store's page shows instead of the machine (and of Home). */
  open = $state(false);
  /** The store shown, and the demo chosen in it (its pane). */
  route = $state<DemosRoute>({ store: OUR_STORE, ours: true });
  /** Where Back returns: Home, when it was opened from there; else the machine. */
  from = $state<'home' | 'machine'>('machine');
  /**
   * The demo start in flight on this page (web/app/DemoStart.svelte), one at a time: while it runs, every pane's
   * Start waits. Aborted when its pane goes (another demo chosen, All demos, the store's page closed).
   */
  starting = $state.raw<AbortController>();
}
export const demos = new Demos();
