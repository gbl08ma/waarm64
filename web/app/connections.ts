// The browser's network connections (docs/network-adapters.md §2): tailnets, tailcat and the local helper, each with its own
// state, which a machine's adapters attach to. Stored ones are records in IndexedDB `webpc` `connections` (web/app/store.ts);
// their state stays where the clients keep it: a tailnet's node in `webpc-tailscale` under the profile `stateKey`
// (web/tailscale-state.ts), tailcat's served identity in `webpc-tailcat` under `identityKey` (web/tailcat.ts). Ephemeral
// ones live only in this page's memory, state included. One running machine has a connection at a time: its Web
// Lock (`connectionLock`, web/app/locks.ts). DOM-free: Node's tests run it over a memory store.
import { t } from '../i18n.ts';
import { newTailcatIdentity, type TailcatIdentity } from '../tailcat.ts';
import { DEFAULT_CONTROL, parseControlURL, type NetworkSettings } from './network.ts';
import { newId, uniqueName } from './shape.ts';
import type { Store } from './store.ts';

export type TailnetConnection = {
  /** The control server's URL (parsed: `parseControlURL`). */
  controlURL: string;
  hostname: string;
  /** The exit node in use (a peer's stable ID), applied again at the next Connect; empty: none. */
  exitNode: string;
  /** Install the peers' subnet routes (absent: yes, Tailscale's apps' default). */
  acceptRoutes?: boolean;
  /** The node's profile prefix in `webpc-tailscale`: the connection's id, or, for the node kept before connections, its control URL. */
  stateKey: string;
};

export type TailcatConnection = {
  /** The address of the tailcat server it goes online through (a secret: kept only in a stored connection); none: serve only. */
  exit?: string;
  /** Let tailcat clients in, through `relay` when there's no `exit` (empty: tailcat's public relays). */
  serve: boolean;
  relay: string;
  /** The clients let in when serving, as `tailcat serve --allow` takes them (`nodekey:…`); none or empty: any with the address. */
  allow?: string[];
  /** The served identity's key in `webpc-tailcat` (`served` for the one kept before connections). */
  identityKey: string;
  /** An ephemeral connection's identity (never stored). */
  identity?: TailcatIdentity;
};

export type LocalConnection = {
  /** The helper's link, `ws://127.0.0.1:<port>/<token>` (a secret: the token lets a page on an allowed origin in). */
  url: string;
};

export type Connection = {
  id: string;
  /** The user's; by default from the kind and the server. */
  name: string;
  kind: 'tailnet' | 'tailcat' | 'local';
  /** Kept nowhere: gone when this page closes (§1.6). */
  ephemeral: boolean;
  tailnet?: TailnetConnection;
  tailcat?: TailcatConnection;
  /** The local helper on this computer (github.com/gbl08ma/webpc-net, docs/plans/networking-local.md). */
  local?: LocalConnection;
  /** Connect when a machine attached to it starts (off after Disconnect). */
  connectAtStart: boolean;
  /** When a machine last connected it (what the Attach wizard preselects); 0: never. */
  lastUsed: number;
  created: number;
};

/** What `Connections.create` takes: the kind's settings without the keys it makes. */
export type NewConnection = {
  kind: Connection['kind'];
  name?: string;
  ephemeral?: boolean;
  connectAtStart?: boolean;
  tailnet?: Omit<TailnetConnection, 'stateKey'>;
  tailcat?: Omit<TailcatConnection, 'identityKey' | 'identity'>;
  local?: LocalConnection;
};

/** Where a stored connection's state is, to forget it with the connection (the page's: IndexedDB; the tests' fakes). */
export type ConnectionState = {
  forgetTailnet(stateKey: string): Promise<void>;
  forgetTailcat(identityKey: string): Promise<void>;
};

/** The connection's Web Lock: held while a running machine has it (in any tab). */
export const connectionLock = (id: string) => `webpc-net:${id}`;

/** A connection's default name: Tailscale, a Headscale's host, tailcat, or This computer. */
export function defaultName(c: Pick<NewConnection, 'kind' | 'tailnet'>): string {
  if (c.kind === 'tailcat') return 'tailcat';
  if (c.kind === 'local') return t('network:connections.thisComputer');
  const url = c.tailnet?.controlURL || DEFAULT_CONTROL;
  return url === DEFAULT_CONTROL ? 'Tailscale' : new URL(url).host;
}

/** What the Attach wizard preselects: the most recently used connection that isn't held (by another machine); undefined when none has been used. */
export function preselect(all: Connection[], held: (id: string) => boolean): string | undefined {
  return all.filter((c) => c.lastUsed > 0 && !held(c.id)).sort((a, b) => b.lastUsed - a.lastUsed)[0]?.id;
}

const NO_STATE: ConnectionState = { forgetTailnet: async () => {}, forgetTailcat: async () => {} };

/** The page's connections: the store's, and its own ephemeral ones. */
export class Connections {
  private store: Store;
  private state: ConnectionState;
  private memory = new Map<string, Connection>();

  constructor(store: Store, state: ConnectionState = NO_STATE) {
    [this.store, this.state] = [store, state];
  }

  /** Every connection this page can attach, stored and ephemeral, oldest first. */
  async list(): Promise<Connection[]> {
    return [...(await this.store.all('connections')), ...[...this.memory.values()].map((c) => structuredClone(c))].sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
  }

  async get(id: string): Promise<Connection | undefined> {
    const c = this.memory.get(id);
    return c ? structuredClone(c) : this.store.get('connections', id);
  }

  /** A new connection: stored, unless `ephemeral`. Its state keys are its id; an ephemeral tailcat one gets its identity now. */
  async create(o: NewConnection): Promise<Connection> {
    const id = newId();
    const taken = (await this.list()).map((c) => c.name);
    const ephemeral = !!o.ephemeral;
    const c: Connection = {
      id,
      name: uniqueName(o.name?.trim() || defaultName(o), taken),
      kind: o.kind,
      ephemeral,
      ...(o.kind === 'tailnet' ? { tailnet: { controlURL: DEFAULT_CONTROL, hostname: 'webpc', exitNode: '', ...o.tailnet, stateKey: id } } : {}),
      ...(o.kind === 'local' ? { local: { url: o.local?.url ?? '' } } : {}),
      ...(o.kind === 'tailcat' ? { tailcat: { serve: false, relay: '', ...o.tailcat, identityKey: id, ...(ephemeral ? { identity: newTailcatIdentity() } : {}) } } : {}),
      connectAtStart: o.connectAtStart ?? true,
      lastUsed: 0,
      created: Date.now(),
    };
    await this.put(c);
    return c;
  }

  /** Writes a connection back (a rename, an edit, `connectAtStart`, `lastUsed`). */
  async put(c: Connection) {
    if (c.ephemeral) this.memory.set(c.id, structuredClone(c));
    else await this.store.put('connections', c);
  }

  /** Marks a connection used now (a machine connected it). */
  async touch(id: string, now = Date.now()) {
    const c = await this.get(id);
    if (c) await this.put({ ...c, lastUsed: now });
  }

  /**
   * Deletes a connection: its record, then its state (a tailnet's node, tailcat's identity), so the next one made is a
   * new node. The caller has its lock (no machine has it) and has logged a tailnet's node out where it could.
   */
  async delete(id: string) {
    if (this.memory.delete(id)) return;
    const c = await this.store.get('connections', id);
    if (!c) return;
    await this.store.forget('connections', id);
    if (c.tailnet) await this.state.forgetTailnet(c.tailnet.stateKey);
    if (c.tailcat) await this.state.forgetTailcat(c.tailcat.identityKey);
  }
}

/** What the page kept before connections (docs/network-adapters.md §2.2). */
export type Legacy = {
  /** `webpc.settings` `net`. */
  settings?: NetworkSettings;
  /** The profiles in `webpc-tailscale` that hold a node (`keptProfiles`): control servers' URLs. */
  profiles: string[];
  /** Whether `webpc-tailcat` has the `served` identity. */
  served: boolean;
};

/**
 * Makes today's single connection into stored ones, so nobody logs in again and a served address stays (§2.2): a
 * tailnet connection per kept node, whose `stateKey` is the profile it is kept under (no bytes move), and a tailcat one
 * for the served identity (`identityKey` `served`). Idempotent: a profile or identity that a connection has already is
 * left. Returns the connections that stand for the old settings, the one the settings were on first (what a machine's
 * first adapter attaches to).
 */
export async function migrateLegacy(conns: Connections, legacy: Legacy): Promise<Connection[]> {
  const s = legacy.settings;
  const current = s?.controlURL !== undefined ? parseControlURL(s.controlURL) : undefined;
  const currentURL = current && 'url' in current ? current.url : DEFAULT_CONTROL;
  const have = await conns.list();
  const out: Connection[] = [];
  for (const profile of legacy.profiles) {
    let c = have.find((x) => x.tailnet?.stateKey === profile);
    if (!c) {
      const mine = profile === currentURL;
      c = await conns.create({ kind: 'tailnet', connectAtStart: !!(mine && s?.kind !== 'tailcat' && s?.autoconnect), tailnet: { controlURL: profile, hostname: (mine && s?.hostname) || 'webpc', exitNode: (mine && s?.exitNode) || '' } });
      c.tailnet!.stateKey = profile;
      await conns.put(c);
    }
    out.push(c);
  }
  if (legacy.served) {
    let c = have.find((x) => x.tailcat?.identityKey === 'served');
    if (!c) {
      // The server's address, a secret, was never kept: the connection serves only until it is edited.
      c = await conns.create({ kind: 'tailcat', connectAtStart: !!(s?.kind === 'tailcat' && s.autoconnect && s.tailcatServe && !s.tailcatExit), tailcat: { serve: true, relay: s?.tailcatRelay ?? '' } });
      c.tailcat!.identityKey = 'served';
      await conns.put(c);
    }
    out.push(c);
  }
  const first = (c: Connection) => (s?.kind === 'tailcat' ? c.kind === 'tailcat' : c.tailnet?.stateKey === currentURL);
  return [...out.filter(first), ...out.filter((c) => !first(c))];
}
