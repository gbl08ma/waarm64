// The tailnet nodes kept in this browser (docs/network-adapters.md §3; web/tailscale-state.ts `keptProfiles`): which
// connections have one, and logging one out. A logout always goes through a client of its own: the module, not
// connected, would only forget the keys here, and only `logOutNode` knows the control server has answered. For
// web/app/net-live.ts; DOM-free.
import { MsgError } from '../i18n.ts';
import { settingsOf, type Connection } from './connections.ts';
import { connectOf } from './net-connect.ts';
import { logOutNode, type createNetwork } from './network.ts';

export class KeptNodes {
  /** The profiles that hold a kept node, as last read. */
  private profiles = new Set<string>();
  private kept?: () => Promise<string[]>;
  private start?: Parameters<typeof createNetwork>[1];

  /** `kept`: the profiles that hold a kept node, read now; `start`: the tailnet client (tests' fakes). */
  constructor(kept?: () => Promise<string[]>, start?: Parameters<typeof createNetwork>[1]) {
    [this.kept, this.start] = [kept, start];
  }

  /** Rereads which profiles hold a node. */
  async refresh() {
    this.profiles = new Set((await this.kept?.().catch(() => [])) ?? []);
  }

  /** Whether connection `c` has a node kept here, which can be logged out, as last read. */
  has(c: Connection) {
    return !!c.tailnet && !c.ephemeral && this.profiles.has(c.tailnet.stateKey);
  }

  /** Whether the node is still kept, read now (a logout that worked forgot it). */
  private async stillKept(c: Connection) {
    return !!(await this.kept?.())?.includes(settingsOf(c, 'tailnet').stateKey);
  }

  /** Logs `c`'s kept node out (its clients here stopped): whether it is gone, true when it had none. */
  async logOut(c: Connection): Promise<boolean> {
    const kept = !!c.tailnet && !c.ephemeral && (await this.stillKept(c));
    return !kept || ((await logOutNode(connectOf(c), this.start)) && !(await this.stillKept(c)));
  }
}

/** A node the control server didn't log out (it didn't answer). */
export const notLoggedOut = (c: Connection) =>
  new MsgError(
    'network:net-nodes.notLoggedOut',
    { name: c.name },
    {
      cause: new MsgError('network:net-nodes.notLoggedOut.cause', {
        host: new URL(settingsOf(c, 'tailnet').controlURL).host,
      }),
    },
  );
