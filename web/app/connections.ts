// The browser's network connections (docs/networking/adapters.md §2): tailnets, tailcat, the local helper, the demo
// network and peer-to-peer rooms, each with its own state, which a machine's adapters attach to. Stored ones are records in IndexedDB `waarm64`
// `connections` (web/app/store.ts); their state stays where the clients keep it: a tailnet's node in `waarm64-tailscale`
// under the profile `stateKey` (web/tailscale-state.ts), tailcat's served identity in `waarm64-tailcat` under
// `identityKey` (web/tailcat.ts), a room's node key in `waarm64-room` under its `identityKey` (web/room.ts). Ephemeral
// ones live only in this page's memory, state included. One running machine has a connection at a time: its Web
// Lock (`connectionLock`, web/app/locks.ts); the demo network's excepted (`exclusive`: a socket each, any number). DOM-free: Node's tests run it over a memory store.
import { DEMO_URL } from '../demo-net.ts';
import { t } from '../i18n.ts';
import { newTailcatIdentity, type TailcatIdentity } from '../tailcat.ts';
import { RoomEntries } from './room-entries.ts';
import { forgetRoomNames, keepExported, roomExportOf } from './room-export.ts';
import { newRoomIdentity, parseRoomLink, roomName, type RoomIdentity } from '../room.ts';
import { memoryState } from './connection-memory.ts';
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
  /** The node's profile prefix in `waarm64-tailscale`: the connection's id, or, for the node kept before connections, its control URL. */
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
  /** The served identity's key in `waarm64-tailcat` (`served` for the one kept before connections). */
  identityKey: string;
  /** An ephemeral connection's identity (never stored). */
  identity?: TailcatIdentity;
};

export type LocalConnection = {
  /** The helper's link, `ws://127.0.0.1:<port>/<token>` (a secret: the token lets a page on an allowed origin in). */
  url: string;
};

export type DemoConnection = {
  /** The demo network's server, `wss://…` (web/demo-net.ts `DEMO_URL` by default; `parseDemoURL`). Not a secret. */
  url: string;
};

export type RoomConnection = {
  /** The room's link (`waarm64-room:<id>?…`, web/room.ts `roomLink`): who has it can join (a secret, for a private room). */
  link: string;
  /** Members may open connections to the guest (off: only replies to the guest's own). */
  incoming: boolean;
  /** No WebRTC: everything through the room's DERP relays, so no member learns this computer's IP address. */
  relayOnly: boolean;
  /** The node key's entry in `waarm64-room`: the connection's id, or another room connection's (the same key in two rooms). */
  identityKey: string;
  /** An ephemeral connection's key (never stored: a stored connection made with one's key keeps a copy in its entry). */
  identity?: RoomIdentity;
};

export type Connection = {
  id: string;
  /** The user's; by default from the kind and the server. */
  name: string;
  kind: 'tailnet' | 'tailcat' | 'local' | 'demo' | 'room';
  /** Kept nowhere: gone when this page closes (§1.6). */
  ephemeral: boolean;
  tailnet?: TailnetConnection;
  tailcat?: TailcatConnection;
  /** The local helper on this computer (github.com/gbl08ma/waarm64-net, docs/networking/local-helper.md). */
  local?: LocalConnection;
  /** The demo network (github.com/gbl08ma/waarm64-demonet, docs/networking/demo-network.md). */
  demo?: DemoConnection;
  /** A peer-to-peer room (docs/networking/rooms.md). */
  room?: RoomConnection;
  /** Connect when a machine attached to it starts (off after Disconnect). */
  connectAtStart: boolean;
  /**
   * The machine it was made for, by the page (a demo's room: web/app/net-demo.ts `withDemoRoom`), deleted with that
   * machine (`deleteOwnConnections`); none: the user's.
   */
  forMachine?: string;
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
  forMachine?: string;
  tailnet?: Omit<TailnetConnection, 'stateKey'>;
  tailcat?: Omit<TailcatConnection, 'identityKey' | 'identity'>;
  local?: LocalConnection;
  demo?: DemoConnection;
  /** `keyOf`: another stored room connection's id, whose key this one shares; `key`: a pasted key (web/room.ts
   * `parseRoomKey`), which is another connection's when it has that key; neither: a new key of its own. `names`: the
   * owners' secret and titles a pasted export carried (web/names.ts `parseRoomExport`), kept as the new connection's. */
  room?: Omit<RoomConnection, 'identityKey' | 'identity'> & { keyOf?: string; key?: string; names?: string };
};

/** Where a stored connection's state is, to forget it with the connection (the page's: IndexedDB; the tests' fakes). */
export type ConnectionState = {
  forgetTailnet(stateKey: string): Promise<void>;
  forgetTailcat(identityKey: string): Promise<void>;
  forgetRoom(identityKey: string): Promise<void>;
  /** A room's key under `identityKey`, and one pasted kept there. */
  readRoom(identityKey: string): Promise<RoomIdentity | undefined>;
  /** The key under `identityKey`, made the first time (web/room.ts `roomIdentity`, as the worker reads it). */
  roomIdentity(identityKey: string): Promise<RoomIdentity>;
  keepRoom(identityKey: string, identity: RoomIdentity): Promise<void>;
  /** The names agent's owners' secret and titles kept under `identityKey`, as an export carries them (web/names.ts
   * `exportNames`), and one pasted taken there (`importNames`); the page's own when absent (web/app/room-export.ts). */
  exportNames?(identityKey: string): Promise<string | undefined>;
  keepNames?(identityKey: string, names: string): Promise<void>;
  /** Forgets the names kept under `identityKey` (its connection deleted, after saying so). */
  forgetNames?(identityKey: string): Promise<void>;
};

export { memoryState };

/** The connection's Web Lock: held while a running machine has it (in any tab). */
export const connectionLock = (id: string) => `waarm64-net:${id}`;

/**
 * Whether one running machine has the connection at a time (its lock, docs/networking/adapters.md §1 rule 4): every
 * kind but the demo network's, where each adapter has a socket of its own and the server a network per socket.
 */
export const exclusive = (c: Pick<Connection, 'kind'>) => c.kind !== 'demo';

/**
 * The lock on room node key `key`, which a running room connection holds beside its own: two connections on one key,
 * each with its own DERP connection under it, break each other on a shared region (a derper delivers a key's packets
 * to one connection), so one key runs in one connection at a time (docs/networking/rooms.md "Decisions"). Named by a hash
 * of the key (never the key itself), so connections of every kind that have it, in any tab, name one lock.
 */
async function roomKeyLock(key: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  return `waarm64-room-key:#${Array.from(h.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** A connection's default name: Tailscale, a Headscale's host, tailcat, This computer, Demo network, or a room's name. */
export function defaultName(c: Pick<NewConnection, 'kind' | 'tailnet' | 'room'>): string {
  if (c.kind === 'tailcat') return 'tailcat';
  if (c.kind === 'demo') return t('network:connections.demoNetwork');
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

/**
 * A new room connection's record, id `id`: a key of its own (`own`, an ephemeral one's in the record, a stored one's
 * kept in its entry first), or `shared`'s, through its entry in `waarm64-room` (or its key itself, when both are
 * ephemeral; a stored one sharing an ephemeral one's has it as `own`).
 */
function roomOf(
  r: NonNullable<NewConnection['room']>,
  id: string,
  ephemeral: boolean,
  shared?: RoomConnection,
  own?: RoomIdentity,
): RoomConnection {
  const rest = { ...r };
  delete rest.keyOf;
  delete rest.key;
  delete rest.names;
  const identityKey = shared && !shared.identity ? shared.identityKey : id;
  const identity = ephemeral ? (shared?.identity ?? (shared ? undefined : (own ?? newRoomIdentity()))) : undefined;
  return { ...rest, identityKey, ...(identity ? { identity } : {}) };
}

/** A new connection's settings of its kind (`room`: a room's, made with its key). */
function settingsFor(
  o: NewConnection,
  id: string,
  ephemeral: boolean,
  room: (r: NonNullable<NewConnection['room']>) => RoomConnection,
): Partial<Connection> {
  switch (o.kind) {
    case 'tailnet':
      return {
        tailnet: { controlURL: DEFAULT_CONTROL, hostname: 'waarm64', exitNode: '', ...o.tailnet, stateKey: id },
      };
    case 'local':
      return { local: { url: o.local?.url ?? '' } };
    case 'demo':
      return { demo: { url: o.demo?.url ?? DEMO_URL } };
    case 'tailcat': {
      const identity = ephemeral ? { identity: newTailcatIdentity() } : {};
      return { tailcat: { serve: false, relay: '', ...o.tailcat, identityKey: id, ...identity } };
    }
    case 'room':
      return { room: room({ incoming: true, relayOnly: false, link: '', ...o.room }) };
  }
}

/** The page's connections: the store's, and its own ephemeral ones. */
export class Connections {
  private store: Store;
  private state: ConnectionState;
  private memory = new Map<string, Connection>();
  /** This page's ephemeral room connections' holds on stored entries (web/app/room-entries.ts). */
  private entries = new RoomEntries();

  constructor(store: Store, state: ConnectionState = memoryState()) {
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
    const { shared, own } = await this.roomKey(o.room, all, ephemeral);
    const room = (r: NonNullable<NewConnection['room']>) => roomOf(r, id, ephemeral, shared, own);
    if (own && !ephemeral) await this.state.keepRoom(id, own); // before the connection: it never starts without it
    const c: Connection = {
      id,
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- a blank name is none
      name: uniqueName(o.name?.trim() || defaultName(o), taken),
      kind: o.kind,
      ephemeral,
      ...settingsFor(o, id, ephemeral, room),
      connectAtStart: o.connectAtStart ?? true,
      ...(o.forMachine ? { forMachine: o.forMachine } : {}),
      lastUsed: 0,
      created: Date.now(),
    };
    await this.put(c);
    await this.entries.hold(c);
    await keepExported(this.state, c, o); // an export's names come with its key
    return c;
  }

  /** Room connection `c`'s export: its key, then its names after a dot (web/names.ts `roomExport`); '' before a key. */
  exportKey(c: Connection): Promise<string> {
    return roomExportOf(this.state, c);
  }

  /**
   * A new room connection's key: another connection's (`keyOf`, or the one that has the pasted key), or its own pasted
   * one. A stored connection never shares an ephemeral one's record: it keeps that key as its own.
   */
  private async roomKey(
    r: NewConnection['room'],
    all: Connection[],
    ephemeral: boolean,
  ): Promise<{ shared?: RoomConnection; own?: RoomIdentity }> {
    const pasted = r?.keyOf ? undefined : r?.key;
    const keyOf = r?.keyOf ?? (pasted ? await this.holderOf(pasted, all) : undefined);
    const shared = keyOf ? all.find((c) => c.id === keyOf)?.room : undefined;
    if (shared?.identity && !ephemeral) return { own: { ...shared.identity } };
    return { shared, own: pasted && !shared ? { key: pasted } : undefined };
  }

  /** Room connection `r`'s key lock (`roomKeyLock`): a stored one's key read from its entry, made there the first time. */
  async keyLock(r: RoomConnection): Promise<string> {
    return roomKeyLock(r.identity?.key ?? (await this.state.roomIdentity(r.identityKey)).key);
  }

  /**
   * The room connection that has node key `key`, if one does (stored, or this page's ephemeral one): a pasted key is
   * that one's, shared as `keyOf` shares it, so New name and Delete see them together.
   */
  private async holderOf(key: string, all: Connection[]): Promise<string | undefined> {
    for (const c of all) {
      if (c.room && (c.room.identity?.key ?? (await this.state.readRoom(c.room.identityKey))?.key) === key) return c.id;
    }
    return undefined;
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
      this.entries.release(id);
      // An ephemeral room connection may use a stored one's kept key: the last to go forgets it.
      if (eph.room && !(await this.sharesKey(eph))) await this.#forgetKey(eph.room);
      return;
    }
    const c = await this.store.get('connections', id);
    if (!c) return;
    await this.store.forget('connections', id);
    if (c.tailnet) await this.state.forgetTailnet(c.tailnet.stateKey);
    if (c.tailcat) await this.state.forgetTailcat(c.tailcat.identityKey);
    if (c.room && !(await this.sharesKey(c))) await this.#forgetKey(c.room);
  }

  /** A room key no connection uses any more: its entry (a stored one's) and its names (the delete said so). */
  async #forgetKey(r: RoomConnection) {
    if (!r.identity) await this.state.forgetRoom(r.identityKey);
    await forgetRoomNames(this.state, r.identityKey);
  }

  /**
   * Room connection `c` with a new key (New name): a key it shared with another stays that one's. A stored one's is
   * made at its next start (or claim) under its entry, which is forgotten unless another connection uses it.
   */
  async newRoomKey(c: Connection & { room: RoomConnection }) {
    const r = { ...c.room };
    if (c.ephemeral) {
      this.entries.release(c.id); // its key is its own now
      return this.put({ ...c, room: { ...r, identity: newRoomIdentity() } });
    }
    delete r.identity; // never in a stored record (one written before may have it)
    const shared = await this.sharesKey(c);
    await this.put({ ...c, room: { ...r, identityKey: shared ? `${c.id}.${Date.now()}` : r.identityKey } });
    if (!shared) await this.state.forgetRoom(r.identityKey);
  }

  /**
   * Whether another room connection uses room connection `c`'s kept key: a stored one, this page's ephemeral one, or
   * another tab's ephemeral one (`RoomEntries`).
   */
  async sharesKey(c: Connection): Promise<boolean> {
    const k = c.room?.identityKey;
    if (!k || c.room?.identity) return false;
    if ((await this.list()).some((x) => x.id !== c.id && x.room?.identityKey === k && !x.room.identity)) return true;
    return this.entries.elsewhere(k);
  }
}

/** What the page kept before connections (docs/networking/adapters.md §2.2). */
export type Legacy = {
  /** `waarm64.settings` `net`. */
  settings?: NetworkSettings;
  /** The profiles in `waarm64-tailscale` that hold a node (`keptProfiles`): control servers' URLs. */
  profiles: string[];
  /** Whether `waarm64-tailcat` has the `served` identity. */
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
  for (const profile of legacy.profiles)
    out.push(
      have.find((x) => x.tailnet?.stateKey === profile) ??
        (await legacyTailnet(conns, profile, profile === currentURL ? s : undefined)),
    );
  if (legacy.served) out.push(have.find((x) => x.tailcat?.identityKey === 'served') ?? (await legacyTailcat(conns, s)));
  const first = (c: Connection) => (s?.kind === 'tailcat' ? c.kind === 'tailcat' : c.tailnet?.stateKey === currentURL);
  return [...out.filter(first), ...out.filter((c) => !first(c))];
}

/** A tailnet connection for a kept node's profile; `s`, the old settings, when they were on this profile. */
async function legacyTailnet(conns: Connections, profile: string, s: NetworkSettings | undefined) {
  const c = await conns.create({
    kind: 'tailnet',
    connectAtStart: !!(s && s.kind !== 'tailcat' && s.autoconnect),
    tailnet: {
      controlURL: profile,
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- '' is unset
      hostname: s?.hostname || 'waarm64',
      exitNode: s?.exitNode ?? '',
    },
  });
  settingsOf(c, 'tailnet').stateKey = profile;
  await conns.put(c);
  return c;
}

/**
 * A tailcat connection for the served identity. The server's address, a secret, was never kept: the connection serves
 * only until it is edited.
 */
async function legacyTailcat(conns: Connections, s: NetworkSettings | undefined) {
  const c = await conns.create({
    kind: 'tailcat',
    connectAtStart: s?.kind === 'tailcat' && s.autoconnect && s.tailcatServe && !s.tailcatExit,
    tailcat: { serve: true, relay: s?.tailcatRelay ?? '' },
  });
  settingsOf(c, 'tailcat').identityKey = 'served';
  await conns.put(c);
  return c;
}
