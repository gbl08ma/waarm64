// The live side of the page's machine's network adapters (docs/networking/adapters.md §3): a `Network` per adapter
// (web/app/network.ts), the connection each one has attached (a record of the browser's, web/app/connections.ts) and
// its client (what it starts with: web/app/net-connect.ts), and the connections' locks (one running machine has a
// connection at a time, in any tab: web/app/net-claims.ts) and kept nodes (web/app/net-nodes.ts). It picks the guest's default way out (`primaryOf`, and IPv6's: `primary6Of`) whenever an adapter's state changes. The
// toolbar's Network menu, the Network wizard and the Home page's Network tab and Connections drive it; web/app/areas/network-actions.ts
// hands it the machine's adapters at each start. DOM-free: tests/net-live.test.ts runs it over a memory store.
import { msg, MsgError } from '../i18n.ts';
import { connectionLock, Connections, exclusive, type Connection } from './connections.ts';
import type { TailnetConnection } from './connections.ts';
import type { Locks } from './locks.ts';
import { NetClaims, type ClaimHere } from './net-claims.ts';
import { connectOf } from './net-connect.ts';
import { KeptNodes, notLoggedOut } from './net-nodes.ts';
import { createNetwork, type Network } from './network.ts';
import { adapterViews, primary6Of, primaryOf, ranksOf, type AdapterView } from './network-view.ts';
import { demoNotice } from './demo-view.ts';
import type { PageNetworkOptions } from './net-options.ts';
import type { Adapter } from './shape.ts';
import { Changes } from './changes.ts';

export type { PageNetworkOptions };

export class PageNetwork {
  readonly conns: Connections;
  readonly locks: Locks;
  /** The connections' locks and their room keys'. */
  private claims: NetClaims;
  /** What the page shows of it changed (web/app/changes.ts): its reads below track it. */
  readonly #changes = new Changes();
  #connections: Connection[] = [];
  #held = new Set<string>();
  /** The tailnet nodes kept here. */
  private nodes: KeptNodes;
  private o: PageNetworkOptions;
  private nets: Network[] = [];
  private adapters: Adapter[] = [];
  private machine?: string;
  /** The machine has started and hasn't stopped (`ports`, `machineOff`). */
  private on = false;
  /** The connection each adapter's client runs, while one does. */
  private running: (string | undefined)[] = [];
  /** What the page has to say about each adapter: a message, or an error its connecting met. */
  private notes: unknown[] = []; // a Msg, or an error
  private primary = { v4: -1, v6: -1 }; // the guest's default ways out, per family

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
    this.claims = new NetClaims(
      o.store,
      o.me,
      (lock) => void this.release(lock),
      (r) => this.conns.keyLock(r),
    );
    this.locks = this.claims.locks;
    this.nodes = new KeptNodes(o.kept, o.start);
  }

  private fresh(): Network {
    return createNetwork(() => this.changed(), this.o.start, this.o.startCat, this.o.startLocal, this.o.startRoom, {
      startDemo: this.o.startDemo,
      onNotice: (n) => {
        const w = demoNotice(n);
        this.o.notify?.(w.message, w.kind);
      },
    });
  }

  /** Stops adapter `i`'s client, if any, and lets its connection go; the adapter gets a new `Network` (its port goes with the old one). */
  private retire(i: number) {
    const n = this.nets.at(i);
    const id = this.running[i];
    this.running[i] = undefined;
    if (n?.active())
      void n.disconnect().then(() => {
        if (id && !this.running.includes(id)) this.claims.let(id);
      });
    else if (id && !this.running.includes(id)) this.claims.let(id);
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
   * The machine's record changed (another tab's Home page attached or detached a connection, or this one's saved
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
    if (!this.running.includes(c.id)) this.claims.let(c.id);
    await this.refresh();
  }

  /** Asks the tab whose machine has `c` to let it go, then attaches it to adapter `i`. */
  async takeFrom(i: number, c: Connection, authKey?: string) {
    await this.claims.takeFrom(c);
    await this.attach(i, c, authKey);
  }

  /** Connects adapter `i`'s attached connection `c` (it must be attached). */
  async connect(i: number, c: Connection, authKey?: string) {
    const n = this.nets.at(i);
    if (!n) throw new Error(`the machine has no adapter ${i + 1}`);
    if (this.running[i] === c.id && n.active()) return;
    const refused = (cause: unknown) => new MsgError('network:net-live.notConnected', { name: c.name }, { cause });
    const why = this.refusal(i, c) ?? (await this.claims.claim(c, this.claimHere(i, c, n)));
    if (why) throw refused(why);
    if (n.active()) await this.disconnect(i, false);
    try {
      n.connect(connectOf(c, authKey));
    } catch (e) {
      this.claims.let(c.id);
      throw refused(e);
    }
    this.running[i] = c.id;
    this.notes[i] = undefined;
    await this.conns.put({ ...c, connectAtStart: true, lastUsed: Date.now() });
    await this.refresh();
  }

  /**
   * Why adapter `i` can't connect `c` now: the machine is off, `c`'s node is being logged out, another adapter runs it
   * (unless it isn't `exclusive`: the demo network gives each adapter a socket and a network of its own).
   */
  private refusal(i: number, c: Connection): MsgError | undefined {
    if (!this.on) return new MsgError('network:net-live.off');
    if (this.claims.leaving.has(c.id)) return new MsgError('network:net-live.loggingOut', { name: c.name });
    if (!exclusive(c)) return undefined;
    const other = this.running.findIndex((id, k) => id === c.id && k !== i);
    if (other >= 0) return new MsgError('network:net-live.onOtherAdapter', { name: c.name, adapter: other + 1 });
    return undefined;
  }

  /** What `NetClaims.claim` asks of adapter `i`, whose network is `n`, connecting `c`. */
  private claimHere(i: number, c: Connection, n: Network): ClaimHere {
    return {
      // It stopped, or its adapters changed, while the lock was asked for.
      stopped: () => (!this.on || this.nets[i] !== n ? new MsgError('network:net-live.off') : undefined),
      runs: () => this.running.includes(c.id),
    };
  }

  /** Stops adapter `i`'s client and lets its connection go; `byUser`: it stays off at the next start too. */
  async disconnect(i: number, byUser = true) {
    const id = this.running[i];
    this.running[i] = undefined;
    await this.nets[i]?.disconnect();
    if (id) {
      this.claims.let(id);
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
    return this.nodes.has(c);
  }

  /**
   * Runs `then` with `c`'s client stopped and its lock held, once its kept node, if any, is logged out (net-nodes.ts):
   * `then` hears whether that worked. `HeldError` if another tab's machine has it.
   */
  private async nodeOut<T>(c: Connection, then: (gone: boolean) => Promise<T>): Promise<T> {
    const stop = async () => {
      for (const [i, id] of this.running.entries()) if (id === c.id) await this.disconnect(i, false);
    };
    return this.claims.whileLeaving(c, stop, async () => then(await this.nodes.logOut(c)));
  }

  /**
   * Logs connection `c`'s kept node out, whether or not a client runs it here (one that does stops). `HeldError` if
   * another tab's machine has it (`takeFrom`'s lock, then this again); it stays off at the next start.
   */
  async logoutKept(c: Connection) {
    await this.nodeOut(c, async (gone) => {
      if (!gone) throw notLoggedOut(c);
      await this.conns.put({ ...c, connectAtStart: false });
    });
    await this.refresh();
  }

  /** The exit node of adapter `i`'s tailnet (kept in its connection). */
  async setExitNode(i: number, peer: string) {
    await this.nets[i].setExitNode(peer);
    await this.keepTailnet(i, { exitNode: peer });
  }

  /** Whether adapter `i`'s tailnet installs its peers' subnet routes (kept in its connection). */
  async setAcceptRoutes(i: number, on: boolean) {
    this.nets[i].setAcceptRoutes(on);
    await this.keepTailnet(i, { acceptRoutes: on });
  }

  /** Keeps a setting of adapter `i`'s running tailnet in its connection. */
  private async keepTailnet(i: number, set: Partial<TailnetConnection>) {
    const c = await this.runningConnection(i);
    if (c?.tailnet) await this.conns.put({ ...c, tailnet: { ...c.tailnet, ...set } });
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
    if (this.claims.isLeaving(lock)) return; // not until the node is out
    const i = this.running.findIndex((id) => id && connectionLock(id) === lock);
    const id = this.running[i];
    if (!id) return this.locks.drop(lock);
    const c = await this.conns.get(id);
    this.running[i] = undefined;
    await this.nets[i].disconnect();
    if (!this.running.includes(id)) this.claims.let(id);
    this.notes[i] = c ? msg('network:net-live.taken', { name: c.name }) : msg('network:net-live.takenUnnamed');
    await this.refresh();
  }

  /** Rereads the connections and which are held elsewhere (the store changed, in this tab or another). */
  async refresh() {
    this.#connections = await this.conns.list();
    await this.nodes.refresh();
    this.#held = await this.claims.heldElsewhere(this.#connections);
    this.changed();
  }

  /** An adapter's state changed: the primary is chosen again, and the page redraws. */
  private changed() {
    const views = this.nets.map((n) => n.view());
    const { v4, v6 } = (this.primary = { v4: primaryOf(views), v6: primary6Of(views) });
    const ranks = ranksOf(views);
    for (const [k, n] of this.nets.entries()) n.setPrimary(v4 < 0 || k === v4, ranks[k], v6 < 0 || k === v6);
    this.#changes.notify();
    this.o.onChange?.();
  }

  /** The page's machine's adapters now. */
  views(): AdapterView[] {
    this.#changes.track();
    const { adapters, nets, notes, on, primary: p } = this;
    return adapterViews({ adapters, nets, notes, connections: this.connections, primary: p.v4, primary6: p.v6, on });
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
