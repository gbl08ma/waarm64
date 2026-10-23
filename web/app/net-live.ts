// The live side of the page's machine's network adapters (docs/network-adapters.md §3): a `Network` per adapter
// (web/app/network.ts), the connection each one has attached (a record of the browser's, web/app/connections.ts) and
// its client, and the connections' locks (one running machine has a connection at a time, in any tab:
// web/app/locks.ts). It picks the guest's default way out (`primaryOf`) whenever an adapter's state changes. The
// toolbar's Network menu, the Network wizard and the Machines page's Network tab and Connections drive it; web/app/main.ts
// hands it the machine's adapters at each start. DOM-free: tests/net-live.test.ts runs it over a memory store.
import { connectionLock, Connections, type Connection, type ConnectionState } from './connections.ts';
import { heldLocks, Locks } from './locks.ts';
import { createNetwork, primaryOf, ranksOf, type Connect, type Network, type NetworkView } from './network.ts';
import type { Adapter } from './shape.ts';
import type { Store } from './store.ts';

/** What a connection's client is started with (`authKey`: a tailnet's first login, never kept). */
export function connectOf(c: Connection, authKey?: string): Connect {
  if (c.kind === 'tailcat') {
    const t = c.tailcat!;
    return { controlURL: '', hostname: '', tailcat: t.exit || undefined, tailcatServe: t.serve ? { relay: t.exit ? '' : t.relay, identityKey: t.identityKey, identity: t.identity } : undefined };
  }
  const t = c.tailnet!;
  // A stored connection's node is kept under its profile (so it comes back without a login, an auth key's too); an ephemeral one's isn't.
  return { controlURL: t.controlURL, hostname: t.hostname, authKey: authKey || undefined, exitNode: t.exitNode || undefined, persist: c.ephemeral ? undefined : t.stateKey };
}

/** A connection another machine has (in another tab): `holder` is its name, when that tab answered. */
export class HeldError extends Error {
  readonly connection: Connection;
  readonly holder?: string;
  constructor(c: Connection, holder?: string) {
    super(`${c.name} is in use by ${holder ?? 'a machine in another tab'}.`);
    [this.connection, this.holder] = [c, holder];
  }
}

/** One adapter as the menu and the Network tab show it. */
export type AdapterView = {
  index: number;
  mac: string;
  /** Its attached connection, if it has one that this browser still has. */
  connection?: Connection;
  view: NetworkView;
  /** A client runs. */
  active: boolean;
  /** Something the page has to say about it: its connection was gone, another machine took it. */
  note?: string;
  /** The guest's default way out goes through it. */
  primary: boolean;
};

export type PageNetworkOptions = {
  /** The clients (tests' fakes; the page's: web/tailscale.ts, web/tailcat.ts). */
  start?: Parameters<typeof createNetwork>[1];
  startCat?: Parameters<typeof createNetwork>[2];
  store: Store;
  state?: ConnectionState;
  /** The name of this page's machine (what another tab is told holds a connection). */
  me: () => string;
  onChange: () => void;
  /** Saves adapter `index`'s attachment into the page's machine (its record, or a transient machine's settings). */
  save: (index: number, connection: string | undefined) => Promise<void>;
};

export class PageNetwork {
  readonly conns: Connections;
  readonly locks: Locks;
  /** The browser's connections (stored and this page's ephemeral ones), as last read (`refresh`). */
  connections: Connection[] = [];
  /** The connection ids another tab's machine holds now, as last read. */
  held = new Set<string>();
  private o: PageNetworkOptions;
  private nets: Network[] = [];
  private adapters: Adapter[] = [];
  private machine?: string;
  /** The connection each adapter's client runs, while one does. */
  private running: (string | undefined)[] = [];
  private notes: (string | undefined)[] = [];
  private primary = -1;

  constructor(o: PageNetworkOptions) {
    this.o = o;
    this.conns = new Connections(o.store, o.state);
    this.locks = new Locks(o.store, 'net', o.me, (lock) => void this.release(lock));
  }

  private fresh(): Network {
    return createNetwork(() => this.changed(), this.o.start, this.o.startCat);
  }

  /** Stops adapter `i`'s client, if any, and lets its connection go; the adapter gets a new `Network` (its port goes with the old one). */
  private retire(i: number) {
    const n = this.nets[i];
    const id = this.running[i];
    this.running[i] = undefined;
    if (n?.active()) void n.disconnect().then(() => { if (id && !this.running.includes(id)) this.locks.drop(connectionLock(id)); });
    else if (id && !this.running.includes(id)) this.locks.drop(connectionLock(id));
  }

  /**
   * The ends of the IP ports of a machine starting now (`machine`: its key; `adapters`: its adapters, in order), for its
   * net devices. The same machine again (a restart) keeps the clients that run, on its new ports; another machine, or an
   * adapter whose attachment changed, stops the client that ran.
   */
  ports(machine: string, adapters: Adapter[]): { mac: string; ip: MessagePort }[] {
    const same = machine === this.machine;
    this.machine = machine;
    const keep = (i: number) => same && i < adapters.length && this.adapters[i]?.id === adapters[i].id && this.adapters[i]?.connection === adapters[i].connection;
    const nets: Network[] = [];
    for (let i = 0; i < Math.max(this.nets.length, adapters.length); i++) {
      if (keep(i) && this.nets[i]) nets[i] = this.nets[i];
      else {
        if (this.nets[i]) this.retire(i);
        if (i < adapters.length) nets[i] = this.fresh();
      }
    }
    this.running = adapters.map((_, i) => (keep(i) ? this.running[i] : undefined));
    this.notes = adapters.map((_, i) => (keep(i) ? this.notes[i] : undefined));
    this.nets = nets.slice(0, adapters.length);
    this.adapters = adapters.map((a) => ({ ...a }));
    const out = this.adapters.map((a, i) => ({ mac: a.mac, ip: this.nets[i].port() }));
    this.changed();
    return out;
  }

  /** Connects what the adapters have attached and connect at start (after a start); an attachment whose connection is gone (an ephemeral one, after the page closed) is detached. */
  async autoconnect() {
    for (const [i, a] of this.adapters.entries()) {
      if (!a.connection || this.nets[i]?.active()) continue;
      const c = await this.conns.get(a.connection);
      if (!c) {
        this.notes[i] = 'Its connection is gone (an ephemeral one goes when its page closes): attach one again.';
        await this.setAttachment(i, undefined);
        continue;
      }
      if (!c.connectAtStart) continue;
      try {
        await this.connect(i, c);
      } catch (e) {
        this.notes[i] = String((e as Error).message ?? e);
      }
    }
    await this.refresh();
  }

  private async setAttachment(i: number, id: string | undefined) {
    this.adapters[i].connection = id;
    await this.o.save(i, id);
  }

  /**
   * Attaches connection `c` to adapter `i` (saved with the machine) and, when the machine has started, connects it,
   * taking its lock first: `HeldError` if another machine has it (`takeFrom` takes it).
   */
  async attach(i: number, c: Connection, authKey?: string) {
    if (i >= this.adapters.length) throw new Error(`the machine has no adapter ${i + 1}`);
    if (this.adapters[i].connection !== c.id) {
      if (this.running[i]) await this.disconnect(i, false);
      await this.setAttachment(i, c.id);
    }
    await this.connect(i, c, authKey);
  }

  /** Asks the tab whose machine has `c` to let it go, then attaches it to adapter `i`. */
  async takeFrom(i: number, c: Connection, authKey?: string) {
    if (!(await this.locks.takeFrom(connectionLock(c.id)))) throw new HeldError(c, await this.locks.holder(connectionLock(c.id)));
    await this.attach(i, c, authKey);
  }

  /** Connects adapter `i`'s attached connection `c` (it must be attached). */
  async connect(i: number, c: Connection, authKey?: string) {
    const n = this.nets[i];
    if (!n) throw new Error(`the machine has no adapter ${i + 1}`);
    if (this.running[i] === c.id && n.active()) return;
    const other = this.running.findIndex((id, k) => id === c.id && k !== i);
    if (other >= 0) throw new Error(`${c.name} is on adapter ${other + 1} already: a connection is one node, on one adapter.`);
    const lock = connectionLock(c.id);
    if (!(await this.locks.take(lock))) throw new HeldError(c, await this.locks.holder(lock));
    if (n.active()) await this.disconnect(i, false);
    try {
      n.connect(connectOf(c, authKey));
    } catch (e) {
      this.locks.drop(lock);
      throw e;
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
      this.locks.drop(connectionLock(id));
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
    await this.nets[i]?.logout();
    await this.disconnect(i);
  }

  /** The exit node of adapter `i`'s tailnet (kept in its connection). */
  async setExitNode(i: number, peer: string) {
    await this.nets[i].setExitNode(peer);
    const c = this.running[i] ? await this.conns.get(this.running[i]!) : undefined;
    if (c?.tailnet) await this.conns.put({ ...c, tailnet: { ...c.tailnet, exitNode: peer } });
    await this.refresh();
  }

  /** Writes an edited connection back; an adapter here that runs it connects again with it. */
  async edit(c: Connection) {
    await this.conns.put(c);
    for (const [i, id] of this.running.entries()) {
      if (id !== c.id) continue;
      await this.disconnect(i, false);
      await this.connect(i, c);
    }
    await this.refresh();
  }

  /** Deletes connection `c` (its record and its state); the adapter here that runs it disconnects. Throws if another tab's machine has it. */
  async remove(c: Connection) {
    for (const [i, id] of this.running.entries()) if (id === c.id) await this.disconnect(i, false);
    const lock = connectionLock(c.id);
    if (!(await this.locks.take(lock))) throw new HeldError(c, await this.locks.holder(lock));
    try {
      await this.conns.delete(c.id);
    } finally {
      this.locks.drop(lock);
    }
    for (const a of this.adapters) if (a.connection === c.id) a.connection = undefined;
    await this.refresh();
  }

  /** Another tab takes a connection one of these adapters runs: it disconnects (and connects at the next start as before). */
  private async release(lock: string) {
    const i = this.running.findIndex((id) => id && connectionLock(id) === lock);
    if (i < 0) return this.locks.drop(lock);
    const c = await this.conns.get(this.running[i]!);
    this.running[i] = undefined;
    await this.nets[i].disconnect();
    this.locks.drop(lock);
    this.notes[i] = `${c?.name ?? 'Its connection'} was taken by another machine.`;
    await this.refresh();
  }

  /** Rereads the connections and which are held elsewhere (the store changed, in this tab or another). */
  async refresh() {
    this.connections = await this.conns.list();
    const held = await heldLocks();
    this.held = new Set(this.connections.filter((c) => held.has(connectionLock(c.id)) && !this.locks.mine(connectionLock(c.id))).map((c) => c.id));
    this.changed();
  }

  /** An adapter's state changed: the primary is chosen again, and the page redraws. */
  private changed() {
    const views = this.nets.map((n) => n.view());
    this.primary = primaryOf(views);
    const ranks = ranksOf(views);
    for (const [k, n] of this.nets.entries()) n.setPrimary(this.primary < 0 || k === this.primary, ranks[k]);
    this.o.onChange();
  }

  /** The page's machine's adapters now. */
  views(): AdapterView[] {
    return this.adapters.map((a, i) => ({
      index: i,
      mac: a.mac,
      connection: this.connections.find((c) => c.id === a.connection),
      view: this.nets[i]?.view() ?? { phase: 'off', text: 'Not connected', exitNodes: [] },
      active: !!this.nets[i]?.active(),
      note: this.notes[i],
      primary: i === this.primary,
    }));
  }

  /** The adapter whose client runs connection `id` here, or -1. */
  runs(id: string) { return this.running.indexOf(id); }

  /** The machine whose adapters these are (its key, as `ports` was given). */
  machineKey() { return this.machine; }
}
