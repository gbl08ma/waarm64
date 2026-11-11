// The live side of the page's machine's network adapters (docs/network-adapters.md §3): a `Network` per adapter
// (web/app/network.ts), the connection each one has attached (a record of the browser's, web/app/connections.ts) and
// its client, and the connections' locks (one running machine has a connection at a time, in any tab:
// web/app/locks.ts). It picks the guest's default way out (`primaryOf`) whenever an adapter's state changes. The
// toolbar's Network menu, the Network wizard and the Machines page's Network tab and Connections drive it; web/app/areas/network-actions.ts
// hands it the machine's adapters at each start. DOM-free: tests/net-live.test.ts runs it over a memory store.
import { errorText, msg, MsgError, text } from '../i18n.ts';
import { isMsg } from '../msg.ts';
import {
  connectionLock,
  Connections,
  roomKeyLock,
  sameRoomKey,
  settingsOf,
  type Connection,
  type ConnectionState,
} from './connections.ts';
import { heldLocks, Locks } from './locks.ts';
import { createNetwork, logOutNode, type Connect, type Network } from './network.ts';
import { primaryOf, ranksOf, viewOf, type NetworkView } from './network-view.ts';
import type { Adapter } from './shape.ts';
import type { Store } from './store.ts';
import { Changes } from './changes.ts';

/** What a connection's client is started with (`authKey`: a tailnet's first login, never kept). */
export function connectOf(c: Connection, authKey?: string): Connect {
  if (c.kind === 'local') return { controlURL: '', hostname: '', local: settingsOf(c, 'local').url };
  if (c.kind === 'room') {
    const r = settingsOf(c, 'room');
    return {
      controlURL: '',
      hostname: '',
      room: {
        link: r.link,
        incoming: r.incoming,
        relayOnly: r.relayOnly,
        identityKey: r.identityKey,
        identity: r.identity,
      },
    };
  }
  if (c.kind === 'tailcat') {
    const t = settingsOf(c, 'tailcat');
    // Its identity always: a kept connection is the same node going online through a server too (a server can `--allow` it).
    const serve = t.serve
      ? { tailcatServe: { relay: t.exit ? '' : t.relay, ...(t.allow?.length ? { allow: t.allow } : {}) } }
      : {};
    return {
      controlURL: '',
      hostname: '',
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- no exit node ('') is none
      tailcat: t.exit || undefined,
      ...serve,
      tailcatIdentity: { identityKey: t.identityKey, identity: t.identity },
    };
  }
  const t = settingsOf(c, 'tailnet');
  // A stored connection's node is kept under its profile (so it comes back without a login, an auth key's too); an ephemeral one's isn't.
  return {
    controlURL: t.controlURL,
    hostname: t.hostname,
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty auth key is none
    authKey: authKey || undefined,
    exitNode: t.exitNode || undefined,
    ...(t.acceptRoutes === false ? { acceptRoutes: false } : {}),
    persist: c.ephemeral ? undefined : t.stateKey,
  };
}

/** A connection another machine has (in another tab): `holder` is its name, when that tab answered. */
export class HeldError extends MsgError {
  readonly connection: Connection;
  readonly holder?: string;
  constructor(c: Connection, holder?: string) {
    if (holder) super('network:net-live.held', { name: c.name, holder });
    else super('network:net-live.heldElsewhere', { name: c.name });
    this.name = 'HeldError';
    [this.connection, this.holder] = [c, holder];
  }
}

/** A note's words: a message's, or an error's headline and details (one line each). */
const noteText = (n: unknown) => (n === undefined ? undefined : isMsg(n) ? text(n) : errorText(n));

/** One adapter as the menu and the Network tab show it. */
export type AdapterView = {
  index: number;
  mac: string;
  /** Its attached connection, if it has one that this browser still has. */
  connection?: Connection;
  view: NetworkView;
  /** A client runs. */
  active: boolean;
  /** Something the page has to say about it, in words: its connection was gone, another machine took it. */
  note?: string;
  /** The guest's default way out goes through it. */
  primary: boolean;
  /** The machine runs, so the adapter can connect. */
  on: boolean;
};

export type PageNetworkOptions = {
  /** The clients (tests' fakes; the page's: web/tailscale.ts, web/tailcat.ts). */
  start?: Parameters<typeof createNetwork>[1];
  startCat?: Parameters<typeof createNetwork>[2];
  startLocal?: Parameters<typeof createNetwork>[3];
  startRoom?: Parameters<typeof createNetwork>[4];
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

export class PageNetwork {
  readonly conns: Connections;
  readonly locks: Locks;
  /** What the page shows of it changed (web/app/changes.ts): its reads below track it. */
  readonly #changes = new Changes();
  #connections: Connection[] = [];
  #held = new Set<string>();
  /** The profiles that hold a kept node, as last read. */
  private keptNodes = new Set<string>();
  private o: PageNetworkOptions;
  private nets: Network[] = [];
  private adapters: Adapter[] = [];
  private machine?: string;
  /** The machine has started and hasn't stopped (`ports`, `machineOff`). */
  private on = false;
  /** The connections whose nodes are being logged out: nothing connects them meanwhile, and no other tab is let in. */
  private leaving = new Set<string>();
  /** The connection each adapter's client runs, while one does. */
  private running: (string | undefined)[] = [];
  /** The room key locks the running room connections hold, by connection (`roomKeyLock`). */
  private keyLocks = new Map<string, string>();
  /** What the page has to say about each adapter: a message, or an error its connecting met. */
  private notes: unknown[] = []; // a Msg, or an error
  private primary = -1;

  /** The browser's connections (stored and this page's ephemeral ones), as last read (`refresh`). */
  get connections(): Connection[] {
    this.#changes.track();
    return this.#connections;
  }
  /** The connection ids another tab's machine holds now, as last read. */
  get held(): Set<string> {
    this.#changes.track();
    return this.#held;
  }

  constructor(o: PageNetworkOptions) {
    this.o = o;
    this.conns = new Connections(o.store, o.state);
    this.locks = new Locks(o.store, 'net', o.me, (lock) => void this.release(lock));
  }

  private fresh(): Network {
    return createNetwork(() => this.changed(), this.o.start, this.o.startCat, this.o.startLocal, this.o.startRoom);
  }

  /** Stops adapter `i`'s client, if any, and lets its connection go; the adapter gets a new `Network` (its port goes with the old one). */
  private retire(i: number) {
    const n = this.nets.at(i);
    const id = this.running[i];
    this.running[i] = undefined;
    if (n?.active())
      void n.disconnect().then(() => {
        if (id && !this.running.includes(id)) this.let(id);
      });
    else if (id && !this.running.includes(id)) this.let(id);
  }

  /** Lets connection `id` go: its lock, and its room key's. */
  private let(id: string) {
    this.locks.drop(connectionLock(id));
    const k = this.keyLocks.get(id);
    this.keyLocks.delete(id);
    if (k) this.locks.drop(k);
  }

  /**
   * The ends of the IP ports of a machine starting now (`machine`: its key; `adapters`: its adapters, in order), for its
   * net devices. The same machine again (a restart) keeps the clients that run, on its new ports; another machine, or an
   * adapter whose attachment changed, stops the client that ran.
   */
  ports(machine: string, adapters: Adapter[]): { mac: string; ip: MessagePort }[] {
    const same = machine === this.machine;
    this.machine = machine;
    this.on = true;
    this.adopt(adapters, same);
    const out = this.adapters.map((a, i) => ({ mac: a.mac, ip: this.nets[i].port() }));
    this.changed();
    return out;
  }

  /** Takes `adapters` as the machine's: by the adapter's id, so a client moves with its adapter when they are reordered (`same`: the same machine; otherwise every client stops). */
  private adopt(adapters: Adapter[], same: boolean) {
    const was = adapters.map((a) =>
      same ? this.adapters.findIndex((o) => o.id === a.id && o.connection === a.connection) : -1,
    );
    for (const i of this.nets.keys()) if (!was.includes(i)) this.retire(i);
    const nets = adapters.map((_, i) => (was[i] >= 0 ? this.nets[was[i]] : this.fresh()));
    this.running = was.map((k) => (k >= 0 ? this.running[k] : undefined));
    this.notes = was.map((k) => (k >= 0 ? this.notes[k] : undefined));
    this.nets = nets;
    this.adapters = adapters.map((a) => ({ ...a }));
  }

  /**
   * The machine stopped and no start follows (powered off, suspended, crashed): its clients stop and their connections
   * go free for other machines, connecting again at its next start. An ephemeral tailnet's stays: its node is in the
   * client, and stopping it would need a new login (or an auth key that's gone); no other tab can want it.
   */
  machineOff() {
    this.on = false;
    for (const i of this.nets.keys()) {
      const c = this.connections.find((x) => x.id === this.running[i]);
      if (!(c?.ephemeral && c.kind === 'tailnet')) this.retire(i);
    }
    void this.refresh();
  }

  /** Connects what the adapters have attached and connect at start (after a start). */
  async autoconnect() {
    for (const i of this.adapters.keys()) await this.connectAttached(i);
    await this.refresh();
  }

  /** Connects adapter `i`'s attachment if it should connect by itself; one whose connection is gone (an ephemeral one, after its page closed) is detached. */
  private async connectAttached(i: number) {
    const a = this.adapters[i];
    if (!this.on || !a.connection || this.nets[i]?.active()) return;
    const c = await this.conns.get(a.connection);
    if (!c) {
      this.notes[i] = msg('network:net-live.gone');
      await this.setAttachment(i, undefined);
    } else if (c.connectAtStart) {
      try {
        await this.connect(i, c);
      } catch (e) {
        this.notes[i] = e;
      }
    }
  }

  /**
   * The machine's record changed (another tab's Machines page attached or detached a connection, or this one's saved
   * it): the attachments it has now take effect, at once if the machine runs. Matched by adapter: its shape can't
   * change while it runs, and off, the adapters are simply the record's.
   */
  async follow(adapters: Adapter[]) {
    if (!this.on) {
      this.adopt(adapters, true);
      return this.refresh();
    }
    for (const [i, a] of this.adapters.entries()) {
      const now = adapters.find((x) => x.id === a.id);
      if (!now || now.connection === a.connection) continue;
      if (this.running[i]) await this.disconnect(i, false);
      this.notes[i] = undefined;
      a.connection = now.connection;
      await this.connectAttached(i);
    }
    await this.refresh();
  }

  private async setAttachment(i: number, id: string | undefined) {
    this.adapters[i].connection = id;
    await this.o.save(i, id);
  }

  /**
   * Attaches connection `c` to adapter `i` (saved with the machine) and, while the machine runs, connects it, taking
   * its lock first: `HeldError` if another machine has it (`takeFrom` takes it).
   */
  async attach(i: number, c: Connection, authKey?: string) {
    if (i >= this.adapters.length) throw new Error(`the machine has no adapter ${i + 1}`);
    if (this.adapters[i].connection !== c.id) {
      if (this.running[i]) await this.disconnect(i, false);
      await this.setAttachment(i, c.id);
    }
    if (this.on) return this.connect(i, c, authKey);
    await this.conns.put({ ...c, connectAtStart: true });
    // `takeFrom`'s, if the machine stopped while it was asked.
    if (!this.running.includes(c.id)) this.let(c.id);
    await this.refresh();
  }

  /** Asks the tab whose machine has `c` to let it go, then attaches it to adapter `i`. */
  async takeFrom(i: number, c: Connection, authKey?: string) {
    if (!(await this.locks.takeFrom(connectionLock(c.id))))
      throw new HeldError(c, await this.locks.holder(connectionLock(c.id)));
    await this.attach(i, c, authKey);
  }

  /** Connects adapter `i`'s attached connection `c` (it must be attached). */
  async connect(i: number, c: Connection, authKey?: string) {
    const n = this.nets.at(i);
    if (!n) throw new Error(`the machine has no adapter ${i + 1}`);
    if (this.running[i] === c.id && n.active()) return;
    const refused = (cause: unknown) => new MsgError('network:net-live.notConnected', { name: c.name }, { cause });
    if (!this.on) throw refused(new MsgError('network:net-live.off'));
    if (this.leaving.has(c.id)) throw refused(new MsgError('network:net-live.loggingOut', { name: c.name }));
    const other = this.running.findIndex((id, k) => id === c.id && k !== i);
    if (other >= 0)
      throw refused(new MsgError('network:net-live.onOtherAdapter', { name: c.name, adapter: other + 1 }));
    const lock = connectionLock(c.id);
    if (!(await this.locks.take(lock))) throw new HeldError(c, await this.locks.holder(lock));
    // It stopped, or its adapters changed, while the lock was asked for.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `on` and the adapters can change across the await
    if (!this.on || this.nets[i] !== n) {
      if (!this.running.includes(c.id)) this.locks.drop(lock);
      throw refused(new MsgError('network:net-live.off'));
    }
    const room = c.room;
    if (room) {
      // One key runs in one connection at a time (`roomKeyLock`): this page's other adapters first, then other tabs.
      const others = await Promise.all(
        this.running.flatMap((id, k) => (id && id !== c.id && k !== i ? [this.conns.get(id)] : [])),
      );
      const here = others.find((o) => o?.room && sameRoomKey(o.room, room));
      const key = await roomKeyLock(room);
      if (here || !(await this.locks.take(key))) {
        if (!this.running.includes(c.id)) this.locks.drop(lock);
        const holder = here ? undefined : await this.locks.holder(key);
        throw refused(
          here
            ? new MsgError('network:net-live.keyInUse', { other: here.name })
            : holder
              ? new MsgError('network:net-live.keyHeld', { holder })
              : new MsgError('network:net-live.keyHeldElsewhere'),
        );
      }
      this.keyLocks.set(c.id, key);
    }
    if (n.active()) await this.disconnect(i, false);
    try {
      n.connect(connectOf(c, authKey));
    } catch (e) {
      this.let(c.id);
      throw refused(e);
    }
    this.running[i] = c.id;
    this.notes[i] = undefined;
    await this.conns.put({ ...c, connectAtStart: true, lastUsed: Date.now() });
    await this.refresh();
  }

  /** Stops adapter `i`'s client and lets its connection go; `byUser`: it stays off at the next start too. */
  async disconnect(i: number, byUser = true) {
    const id = this.running[i];
    this.running[i] = undefined;
    await this.nets[i]?.disconnect();
    if (id) {
      this.let(id);
      const c = byUser ? await this.conns.get(id) : undefined;
      if (c) await this.conns.put({ ...c, connectAtStart: false });
    }
    await this.refresh();
  }

  /** Takes adapter `i`'s connection off it (its client stops). */
  async detach(i: number) {
    if (this.running[i]) await this.disconnect(i, false);
    this.notes[i] = undefined;
    await this.setAttachment(i, undefined);
    await this.refresh();
  }

  /** Logs adapter `i`'s tailnet node out (it is removed from the tailnet and its keys forgotten), then disconnects. */
  async logout(i: number) {
    const c = await this.runningConnection(i);
    if (c && !c.ephemeral) return this.logoutKept(c);
    await this.nets[i]?.logout();
    await this.disconnect(i);
  }

  /** The connection adapter `i` runs, if it runs one. */
  private async runningConnection(i: number) {
    const id = this.running[i];
    return id ? this.conns.get(id) : undefined;
  }

  /** Whether connection `c` has a node kept here, which can be logged out. */
  hasNode(c: Connection) {
    this.#changes.track();
    return !!c.tailnet && !c.ephemeral && this.keptNodes.has(c.tailnet.stateKey);
  }

  /** Whether the node is still kept, read now (a logout that worked forgot it). */
  private async stillKept(c: Connection) {
    return !!(await this.o.kept?.())?.includes(settingsOf(c, 'tailnet').stateKey);
  }

  /**
   * Runs `then` with `c`'s client stopped and its lock held, once its kept node, if any, is logged out: `then` hears
   * whether that worked. Always through a client of its own: the module, not connected, would only forget the keys
   * here, and only `logOutNode` knows the control server has answered. `HeldError` if another tab's machine has it.
   */
  private async nodeOut<T>(c: Connection, then: (gone: boolean) => Promise<T>): Promise<T> {
    this.leaving.add(c.id);
    const lock = connectionLock(c.id);
    try {
      for (const [i, id] of this.running.entries()) if (id === c.id) await this.disconnect(i, false);
      if (!(await this.locks.take(lock))) throw new HeldError(c, await this.locks.holder(lock));
      const kept = !!c.tailnet && !c.ephemeral && (await this.stillKept(c));
      return await then(!kept || ((await logOutNode(connectOf(c), this.o.start)) && !(await this.stillKept(c))));
    } finally {
      this.locks.drop(lock);
      this.leaving.delete(c.id);
    }
  }

  /**
   * Logs connection `c`'s kept node out, whether or not a client runs it here (one that does stops). `HeldError` if
   * another tab's machine has it (`takeFrom`'s lock, then this again); it stays off at the next start.
   */
  async logoutKept(c: Connection) {
    await this.nodeOut(c, async (gone) => {
      if (!gone)
        throw new MsgError(
          'network:net-live.notLoggedOut',
          { name: c.name },
          {
            cause: new MsgError('network:net-live.notLoggedOut.cause', {
              host: new URL(settingsOf(c, 'tailnet').controlURL).host,
            }),
          },
        );
      await this.conns.put({ ...c, connectAtStart: false });
    });
    await this.refresh();
  }

  /** The exit node of adapter `i`'s tailnet (kept in its connection). */
  async setExitNode(i: number, peer: string) {
    await this.nets[i].setExitNode(peer);
    const c = await this.runningConnection(i);
    if (c?.tailnet) await this.conns.put({ ...c, tailnet: { ...c.tailnet, exitNode: peer } });
    await this.refresh();
  }

  /** Whether adapter `i`'s tailnet installs its peers' subnet routes (kept in its connection). */
  async setAcceptRoutes(i: number, on: boolean) {
    this.nets[i].setAcceptRoutes(on);
    const c = await this.runningConnection(i);
    if (c?.tailnet) await this.conns.put({ ...c, tailnet: { ...c.tailnet, acceptRoutes: on } });
    await this.refresh();
  }

  /** Writes an edited connection back; an adapter here that runs it connects again with it. */
  async edit(c: Connection) {
    await this.conns.put(c);
    for (const [i, id] of this.running.entries()) {
      if (id !== c.id || !this.on) continue; // off, an ephemeral tailnet's client stays as it is
      await this.disconnect(i, false);
      await this.connect(i, c);
    }
    await this.refresh();
  }

  /**
   * Deletes connection `c` (its record and its state): a kept tailnet node is logged out first, and the adapter here that
   * runs it disconnects. Throws if another tab's machine has it. True when the node couldn't be logged out (the control
   * server didn't answer): it stays on the tailnet until it expires or an admin removes it.
   */
  async remove(c: Connection): Promise<boolean> {
    const stranded = await this.nodeOut(c, async (gone) => {
      await this.conns.delete(c.id);
      return !gone;
    });
    for (const a of this.adapters) if (a.connection === c.id) a.connection = undefined;
    await this.refresh();
    return stranded;
  }

  /** Another tab takes a connection one of these adapters runs: it disconnects (and connects at the next start as before). */
  private async release(lock: string) {
    if ([...this.leaving].some((id) => connectionLock(id) === lock)) return; // not until the node is out
    const i = this.running.findIndex((id) => id && connectionLock(id) === lock);
    const id = this.running[i];
    if (!id) return this.locks.drop(lock);
    const c = await this.conns.get(id);
    this.running[i] = undefined;
    await this.nets[i].disconnect();
    if (!this.running.includes(id)) this.let(id);
    this.notes[i] = c ? msg('network:net-live.taken', { name: c.name }) : msg('network:net-live.takenUnnamed');
    await this.refresh();
  }

  /** Rereads the connections and which are held elsewhere (the store changed, in this tab or another). */
  async refresh() {
    this.#connections = await this.conns.list();
    this.keptNodes = new Set((await this.o.kept?.().catch(() => [])) ?? []);
    const held = await heldLocks();
    this.#held = new Set(
      this.#connections
        .filter((c) => held.has(connectionLock(c.id)) && !this.locks.mine(connectionLock(c.id)))
        .map((c) => c.id),
    );
    this.changed();
  }

  /** An adapter's state changed: the primary is chosen again, and the page redraws. */
  private changed() {
    const views = this.nets.map((n) => n.view());
    this.primary = primaryOf(views);
    const ranks = ranksOf(views);
    for (const [k, n] of this.nets.entries()) n.setPrimary(this.primary < 0 || k === this.primary, ranks[k]);
    this.#changes.notify();
    this.o.onChange?.();
  }

  /** The page's machine's adapters now. */
  views(): AdapterView[] {
    this.#changes.track();
    const views = this.adapters.map((_, i) => this.nets[i]?.view() ?? viewOf(undefined));
    // Two adapters on local helpers both give the guest a default route (their DHCP, not the page's): said, not fixed.
    const locals = views.flatMap((v, i) => (v.phase === 'connected' && v.local ? [i] : []));
    return this.adapters.map((a, i) => ({
      index: i,
      mac: a.mac,
      connection: this.connections.find((c) => c.id === a.connection),
      view: views[i],
      active: !!this.nets.at(i)?.active(),
      note:
        noteText(this.notes[i]) ??
        (locals.length > 1 && locals.includes(i) && i !== this.primary
          ? text(msg('network:net-live.twoHelpers', { adapter: this.primary + 1 }))
          : undefined),
      primary: i === this.primary,
      on: this.on,
    }));
  }

  /** The adapter whose client runs connection `id` here, or -1. */
  runs(id: string) {
    this.#changes.track();
    return this.running.indexOf(id);
  }

  /** The machine whose adapters these are (its key, as `ports` was given). */
  machineKey() {
    return this.machine;
  }
}
