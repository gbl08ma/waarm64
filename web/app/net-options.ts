// What the page's live network (web/app/net-live.ts `PageNetwork`) is made with: its clients (the tests' fakes), the
// store, where the connections' state is, and what it calls back. DOM-free.
import type { Msg } from '../i18n.ts';
import type { ConnectionState } from './connections.ts';
import type { createNetwork } from './network.ts';
import type { Store } from './store.ts';

export type PageNetworkOptions = {
  /** The clients (tests' fakes; the page's: web/tailscale.ts, web/tailcat.ts). */
  start?: Parameters<typeof createNetwork>[1];
  startCat?: Parameters<typeof createNetwork>[2];
  startLocal?: Parameters<typeof createNetwork>[3];
  startRoom?: Parameters<typeof createNetwork>[4];
  startDemo?: NonNullable<Parameters<typeof createNetwork>[5]>['startDemo'];
  /** Says something in the message bar (the demo network's notices: a budget crossed, a restart announced). */
  notify?: (m: Msg, kind: 'info' | 'warn') => void;
  store: Store;
  state?: ConnectionState;
  /** The profiles that hold a kept node (web/tailscale-state.ts `keptProfiles`). */
  kept?: () => Promise<string[]>;
  /** The name of this page's machine (what another tab is told holds a connection). */
  me: () => string;
  /** Called when anything `views()`, `connections` or `held` show changed (the page's reads track it themselves). */
  onChange?: () => void;
  /** Saves adapter `index`'s attachment into the page's machine (its record, or a transient machine's settings). */
  save: (index: number, connection: string | undefined) => Promise<void>;
};
