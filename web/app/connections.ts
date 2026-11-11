// The browser's network connections (docs/network-adapters.md §2): tailnets, tailcat, the local helper and peer-to-peer
// rooms, each with its own state, which a machine's adapters attach to. Stored ones are records in IndexedDB `webpc`
// `connections` (web/app/store.ts); their state stays where the clients keep it: a tailnet's node in `webpc-tailscale`
// under the profile `stateKey` (web/tailscale-state.ts), tailcat's served identity in `webpc-tailcat` under
// `identityKey` (web/tailcat.ts), a room's node key in `webpc-room` under its `identityKey` (web/room.ts). Ephemeral
// ones live only in this page's memory, state included. One running machine has a connection at a time: its Web
// Lock (`connectionLock`, web/app/locks.ts). DOM-free: Node's tests run it over a memory store.
import { t } from '../i18n.ts';
import { newTailcatIdentity, type TailcatIdentity } from '../tailcat.ts';
import { newRoomIdentity, parseRoomLink, roomName, type RoomIdentity } from '../room.ts';
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

export type RoomConnection = {
  /** The room's link (`webpc-room:<id>?…`, web/room.ts `roomLink`): who has it can join (a secret, for a private room). */
  link: string;
  /** Members may open connections to the guest (off: only replies to the guest's own). */
  incoming: boolean;
  /** No WebRTC: everything through the room's DERP relays, so no member learns this computer's IP address. */
  relayOnly: boolean;
  /** The node key's entry in `webpc-room`: the connection's id, or another room connection's (the same key in two rooms). */
  identityKey: string;
  /** An ephemeral connection's key (never stored). */
  identity?: RoomIdentity;
};

export type Connection = {
  id: string;
  /** The user's; by default from the kind and the server. */
  name: string;
  kind: 'tailnet' | 'tailcat' | 'local' | 'room';
  /** Kept nowhere: gone when this page closes (§1.6). */
  ephemeral: boolean;
  tailnet?: TailnetConnection;
  tailcat?: TailcatConnection;
  /** The local helper on this computer (github.com/gbl08ma/webpc-net, docs/plans/networking-local.md). */
  local?: LocalConnection;
  /** A peer-to-peer room (docs/plans/networking-p2p.md, docs/tailnet.md "Rooms"). */
  room?: RoomConnection;
  /** Connect when a machine attached to it starts (off after Disconnect). */
  connectAtStart: boolean;
  /** When a machine last connected it (what the Attach wizard preselects); 0: never. */
  lastUsed: number;
  created: number;
};

/** Connection `c`'s settings of kind `k` (`c[k]`; `c.kind` is `k`): a connection of that kind without them is broken. */
export function settingsOf<K extends Connection['kind']>(c: Connection, k: K): NonNullable<Connection[K]> {
  const v = c[k];
  if (!v) throw new Error(`connection ${c.id} has no ${k} settings`);
  return v;
}

/** What `Connections.create` takes: the kind's settings without the keys it makes. */
export type NewConnection = {
  kind: Connection['kind'];
  name?: string;
  ephemeral?: boolean;
  connectAtStart?: boolean;
  tailnet?: Omit<TailnetConnection, 'stateKey'>;
  tailcat?: Omit<TailcatConnection, 'identityKey' | 'identity'>;
  local?: LocalConnection;
  /** `keyOf`: another stored room connection's id, whose key this one shares; none: a key of its own. */
  room?: Omit<RoomConnection, 'identityKey' | 'identity'> & { keyOf?: string };
};

/** Where a stored connection's state is, to forget it with the connection (the page's: IndexedDB; the tests' fakes). */
export type ConnectionState = {
  forgetTailnet(stateKey: string): Promise<void>;
  forgetTailcat(identityKey: string): Promise<void>;
  forgetRoom(identityKey: string): Promise<void>;
};

/** The connection's Web Lock: held while a running machine has it (in any tab). */
export const connectionLock = (id: string) => `webpc-net:${id}`;

/**
 * The lock on a room connection's node key, which a running room connection holds beside its own: two connections on
 * one key, each with its own DERP connection under it, break each other on a shared region (a derper delivers a key's
 * packets to one connection), so one key runs in one connection at a time (docs/plans/networking-p2p.md §1). Named
 * by the key's entry in `webpc-room`, or by a hash of an ephemeral one's key (never the key itself).
 */
export async function roomKeyLock(r: RoomConnection): Promise<string> {
  if (!r.identity) return `webpc-room-key:${r.identityKey}`;
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(r.identity.key)));
  return `webpc-room-key:#${Array.from(h.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Whether two room connections use one node key. */
export const sameRoomKey = (a: RoomConnection, b: RoomConnection) =>
  a.identity || b.identity ? a.identity?.key === b.identity?.key : a.identityKey === b.identityKey;

/** A connection's default name: Tailscale, a Headscale's host, tailcat, This computer, or a room's name. */
export function defaultName(c: Pick<NewConnection, 'kind' | 'tailnet' | 'room'>): string {
  if (c.kind === 'tailcat') return 'tailcat';
  if (c.kind === 'room') {
    const l = parseRoomLink(c.room?.link ?? '');
    return 'error' in l ? 'room' : roomName(l.room.id);
  }
  if (c.kind === 'local') return t('network:connections.thisComputer');
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- no server ('') is the default one
  const url = c.tailnet?.controlURL || DEFAULT_CONTROL;
  return url === DEFAULT_CONTROL ? 'Tailscale' : new URL(url).host;
}

/** What the Attach wizard preselects: the most recently used connection that isn't held (by another machine); undefined when none has been used. */
export function preselect(all: Connection[], held: (id: string) => boolean): string | undefined {
  return all.filter((c) => c.lastUsed > 0 && !held(c.id)).sort((a, b) => b.lastUsed - a.lastUsed)[0]?.id;
}

const NO_STATE: ConnectionState = {
  forgetTailnet: () => Promise.resolve(),
  forgetTailcat: () => Promise.resolve(),
  forgetRoom: () => Promise.resolve(),
};

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
    return [...(await this.store.all('connections')), ...[...this.memory.values()].map((c) => structuredClone(c))].sort(
      (a, b) => a.created - b.created || (a.id < b.id ? -1 : 1),
    );
  }

  async get(id: string): Promise<Connection | undefined> {
    const c = this.memory.get(id);
    return c ? structuredClone(c) : this.store.get('connections', id);
  }

  /**
   * A new connection: stored, unless `ephemeral`. Its state keys are its id (a room's that shares another's key: that
   * one's); an ephemeral tailcat or room one gets its identity now (a room sharing another's: that one's key).
   */
  async create(o: NewConnection): Promise<Connection> {
    const id = newId();
    const all = await this.list();
    const taken = all.map((c) => c.name);
    const ephemeral = !!o.ephemeral;
    const keyOf = o.room?.keyOf;
    const shared = keyOf ? all.find((c) => c.id === keyOf)?.room : undefined;
    const room = (r: NonNullable<NewConnection['room']>): RoomConnection => {
      const rest = { ...r };
      delete rest.keyOf;
      // Another connection's key: its entry in `webpc-room` (or its key itself, when it's ephemeral too).
      const identityKey = shared && !shared.identity ? shared.identityKey : id;
      const identity = shared?.identity ?? (ephemeral && !shared ? newRoomIdentity() : undefined);
      return { ...rest, identityKey, ...(identity ? { identity } : {}) };
    };
    const c: Connection = {
      id,
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- a blank name is none
      name: uniqueName(o.name?.trim() || defaultName(o), taken),
      kind: o.kind,
      ephemeral,
      ...(o.kind === 'tailnet'
        ? { tailnet: { controlURL: DEFAULT_CONTROL, hostname: 'webpc', exitNode: '', ...o.tailnet, stateKey: id } }
        : {}),
      ...(o.kind === 'local' ? { local: { url: o.local?.url ?? '' } } : {}),
      ...(o.kind === 'tailcat'
        ? {
            tailcat: {
              serve: false,
              relay: '',
              ...o.tailcat,
              identityKey: id,
              ...(ephemeral ? { identity: newTailcatIdentity() } : {}),
            },
          }
        : {}),
      ...(o.kind === 'room' ? { room: room({ incoming: true, relayOnly: false, link: '', ...o.room }) } : {}),
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
   * Deletes a connection: its record, then its state (a tailnet's node, tailcat's identity, a room's key unless another
   * connection shares it), so the next one made is a new node. The caller has its lock (no machine has it) and has
   * logged a tailnet's node out where it could.
   */
  async delete(id: string) {
    const eph = this.memory.get(id);
    if (eph) {
      this.memory.delete(id);
      // An ephemeral room connection may use a stored one's kept key: the last to go forgets it.
      if (eph.room && !eph.room.identity && !(await this.sharesKey(eph)))
        await this.state.forgetRoom(eph.room.identityKey);
      return;
    }
    const c = await this.store.get('connections', id);
    if (!c) return;
    await this.store.forget('connections', id);
    if (c.tailnet) await this.state.forgetTailnet(c.tailnet.stateKey);
    if (c.tailcat) await this.state.forgetTailcat(c.tailcat.identityKey);
    if (c.room && !c.room.identity && !(await this.sharesKey(c))) await this.state.forgetRoom(c.room.identityKey);
  }

  /** Whether another room connection (stored, or this page's ephemeral one) uses room connection `c`'s kept key. */
  async sharesKey(c: Connection): Promise<boolean> {
    return (await this.list()).some(
      (x) => x.id !== c.id && x.room?.identityKey === c.room?.identityKey && !x.room?.identity,
    );
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
      c = await conns.create({
        kind: 'tailnet',
        connectAtStart: !!(mine && s?.kind !== 'tailcat' && s?.autoconnect),
        tailnet: {
          controlURL: profile,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- not ours (false) or '' is unset
          hostname: (mine && s?.hostname) || 'webpc',
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- not ours (false) or '' is unset
          exitNode: (mine && s?.exitNode) || '',
        },
      });
      settingsOf(c, 'tailnet').stateKey = profile;
      await conns.put(c);
    }
    out.push(c);
  }
  if (legacy.served) {
    let c = have.find((x) => x.tailcat?.identityKey === 'served');
    if (!c) {
      // The server's address, a secret, was never kept: the connection serves only until it is edited.
      c = await conns.create({
        kind: 'tailcat',
        connectAtStart: s?.kind === 'tailcat' && s.autoconnect && s.tailcatServe && !s.tailcatExit,
        tailcat: { serve: true, relay: s?.tailcatRelay ?? '' },
      });
      settingsOf(c, 'tailcat').identityKey = 'served';
      await conns.put(c);
    }
    out.push(c);
  }
  const first = (c: Connection) => (s?.kind === 'tailcat' ? c.kind === 'tailcat' : c.tailnet?.stateKey === currentURL);
  return [...out.filter(first), ...out.filter((c) => !first(c))];
}
