// The network (docs/frontend.md "Network", docs/networking/adapters.md): the machine's adapters, each with a connection
// of the browser's attached (web/app/net-live.ts); the toolbar's Network menu, the Network wizard and the Machines
// page's Network tab and Connections act through these (web/app/page.ts's `net*`).
import { msg, MsgError, t, text } from '../../i18n.ts';
import { forgetTailcatIdentity, hasTailcatIdentity, newTailcatIdentity } from '../../tailcat.ts';
import { keptProfiles } from '../../tailscale-state.ts';
import { ask } from '../ask.svelte.ts';
import { connectionLock, migrateLegacy, type Connection } from '../connections.ts';
import { detachEverywhere, isRunning, setAdapterConnection } from '../machines.ts';
import { HeldError } from '../net-claims.ts';
import type { PageNetwork } from '../net-live.ts';
import type { Page } from '../page.ts';
import { remember, settings } from '../settings.ts';
import { adaptersOf } from '../shape.ts';
import type { PageMachine } from '../run/page-machine.svelte.ts';
import { takeHeld } from './held.ts';

type NetPage = Pick<
  Page,
  | 'netCreate'
  | 'netAttach'
  | 'netDetach'
  | 'netConnect'
  | 'netDisconnect'
  | 'netLogout'
  | 'netLogoutConnection'
  | 'netFollow'
  | 'netExit'
  | 'netRoutes'
  | 'netEdit'
  | 'netRename'
  | 'netDelete'
  | 'netNewAddress'
  | 'netHolder'
>;

/** The question before a connection held by another tab's machine is used here. */
const useHere = (e: HeldError) =>
  ask.confirm(t('network:network-actions.held.useHere', { held: e.msg }), {
    title: t('network:network-actions.held.title'),
    ok: t('network:network-actions.useHere'),
  });

export class NetworkActions {
  readonly #m: PageMachine;
  readonly #net: PageNetwork;

  constructor(m: PageMachine, net: PageNetwork) {
    this.#m = m;
    this.#net = net;
  }

  /**
   * The network as it was kept before connections (`waarm64.settings` `net`, a kept node, the served tailcat identity)
   * made into connections (docs/networking/adapters.md §2.2), once: the transient machine's adapter and every stored
   * machine's first one get the one the settings were on.
   */
  async migrate() {
    if (!settings().net) return;
    const run = async () => {
      const legacy = settings().net;
      if (!legacy) return; // another tab did it
      const made = await migrateLegacy(this.#net.conns, {
        settings: legacy,
        profiles: await keptProfiles().catch(() => []),
        served: await hasTailcatIdentity(),
      });
      const first = made.at(0);
      if (first) {
        if (!settings().transientNet) remember({ transientNet: first.id });
        for (const m of await this.#m.store.all('machines')) {
          const a = adaptersOf(m);
          if (a.length && !a[0].connection) await setAdapterConnection(this.#m.store, m.id, 0, first.id);
        }
        await this.#m.rereadRecord();
      }
      remember({ net: undefined });
    };
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Web Locks are missing outside a secure context
    if (navigator.locks) await navigator.locks.request('waarm64-net-migrate', run);
    else await run();
  }

  /** Another tab changed the page's machine's record: its attachments take effect here (docs/networking/adapters.md §3). */
  async follow() {
    const s = this.#m.stored;
    const record = s && (await this.#m.store.get('machines', s.record.id));
    if (!s || !record) return;
    s.record = record;
    if (this.#net.machineKey() === record.id) await this.#net.follow(adaptersOf(record));
  }

  /** Whether `machine` (an id, or undefined for a transient one) is the page's and its adapters are live here. */
  #live(machine: string | undefined, i: number) {
    const key = this.#m.netKey();
    return (machine ?? 'transient') === key && this.#net.machineKey() === key && i < this.#net.views().length;
  }

  /**
   * Attaches connection `c` to adapter `i` of `machine` (undefined: the page's transient one). The page's machine
   * connects it now (`authKey`: a tailnet's first login); one another tab's machine has is taken from it after
   * asking. Another machine keeps it in its record: the tab that runs it, if one does, hears and connects it
   * (`follow`), and otherwise it connects when the machine starts.
   */
  async attach(machine: string | undefined, i: number, c: Connection, authKey?: string) {
    const net = this.#net;
    if (c.ephemeral && machine && machine !== this.#m.netKey() && (await isRunning(machine)))
      throw new MsgError('network:network-actions.ephemeral', { name: c.name });
    if (this.#live(machine, i)) {
      await takeHeld(
        () => net.attach(i, c, authKey),
        HeldError,
        useHere,
        () => net.takeFrom(i, c, authKey),
      );
      return;
    }
    await net.conns.put({ ...c, connectAtStart: true }); // first: a tab that runs the machine hears of the attachment and reads this
    if (machine) await setAdapterConnection(this.#m.store, machine, i, c.id);
    else remember({ transientNet: c.id });
    if (machine) await this.#m.rereadRecord(machine);
    await net.refresh();
  }

  async detach(machine: string | undefined, i: number) {
    if (this.#live(machine, i)) {
      await this.#net.detach(i);
      return;
    }
    if (machine) await setAdapterConnection(this.#m.store, machine, i, undefined);
    else remember({ transientNet: undefined });
    if (machine) await this.#m.rereadRecord(machine);
    await this.#net.refresh();
  }

  /** What deleting `c` does besides detaching it (a node logged out or left, an identity forgotten). */
  async #deleteWhat(c: Connection) {
    if (c.kind === 'tailnet')
      return c.ephemeral
        ? msg('network:network-actions.delete.leaves')
        : msg('network:network-actions.delete.loggedOut');
    if (c.tailcat?.serve) return msg('network:network-actions.delete.tailcat');
    if (c.room && !(await this.#net.conns.sharesKey(c))) return msg('network:network-actions.delete.room');
    return undefined;
  }

  /** Deletes connection `c` after asking (naming the machines it is attached to): it is detached from them, and its state forgotten. */
  async delete(c: Connection) {
    const { store, spec } = this.#m;
    const on = (await store.all('machines'))
      .filter((m) => m.adapters?.some((a) => a.connection === c.id))
      .map((m) => m.name);
    if (settings().transientNet === c.id) on.push(text(spec.title));
    const what = await this.#deleteWhat(c);
    const question = what
      ? on.length
        ? t('network:network-actions.delete.confirm.on.what', { name: c.name, machines: on, what })
        : t('network:network-actions.delete.confirm.what', { name: c.name, what })
      : on.length
        ? t('network:network-actions.delete.confirm.on', { name: c.name, machines: on })
        : t('network:network-actions.delete.confirm', { name: c.name });
    const ok = t('network:network-actions.delete.ok');
    if (!(await ask.confirm(question, { title: t('network:network-actions.delete.title'), ok, danger: true }))) return;
    const stranded = await this.#net.remove(c);
    await detachEverywhere(store, c.id);
    if (settings().transientNet === c.id) remember({ transientNet: undefined });
    await this.#m.rereadRecord();
    await this.#net.refresh();
    if (stranded) throw new MsgError('network:network-actions.stranded', { name: c.name });
  }

  /** Logs out the node of connection `c`, running or not; one another tab's machine has is taken from it after asking. */
  async logoutConnection(c: Connection) {
    const net = this.#net;
    const logOut = (e: HeldError) =>
      ask.confirm(t('network:network-actions.held.logOut', { held: e.msg }), {
        title: t('network:network-actions.held.title'),
        ok: t('network:network-actions.logOut'),
        danger: true,
      });
    await takeHeld(
      () => net.logoutKept(c),
      HeldError,
      logOut,
      async (e) => {
        if (!(await net.locks.takeFrom(connectionLock(c.id)))) throw e;
        await net.logoutKept(c);
      },
    );
  }

  /** A room connection's new key, after asking (so a new address and name in its room); a key it shared with another stays that one's. */
  async #newRoomKey(c: Connection & { room: NonNullable<Connection['room']> }) {
    const net = this.#net;
    const r = c.room;
    const ok = t('network:network-actions.newName.ok');
    if (!(await ask.confirm(t('network:network-actions.newName.confirm', { name: c.name }), { ok, danger: true })))
      return false;
    await net.conns.newRoomKey({ ...c, room: r });
    return true;
  }

  /**
   * Forgets tailcat connection `c`'s served identity, after asking: whoever has its address can't come in any more. A
   * room connection gets a new key instead.
   */
  async newAddress(c: Connection): Promise<Connection | undefined> {
    const net = this.#net;
    const room = c.room;
    if (room) {
      if (!(await this.#newRoomKey({ ...c, room }))) return undefined;
    } else {
      const tc = c.tailcat;
      if (!tc) return undefined;
      const ok = t('network:network-actions.newAddress.ok');
      if (!(await ask.confirm(t('network:network-actions.newAddress.confirm', { name: c.name }), { ok, danger: true })))
        return undefined;
      // An ephemeral connection's identity is in the page's memory: a new one; a stored one's is made again at its next serve.
      if (c.ephemeral) await net.conns.put({ ...c, tailcat: { ...tc, identity: newTailcatIdentity() } });
      else await forgetTailcatIdentity(tc.identityKey);
    }
    const at = net.runs(c.id);
    const now = await net.conns.get(c.id);
    if (now && at >= 0) await net.edit(now);
    return now;
  }

  /** The page's `net*` actions. */
  page(): NetPage {
    const net = this.#net;
    return {
      netCreate: async (n) => {
        const c = await net.conns.create(n);
        await net.refresh();
        return c;
      },
      netAttach: (machine, i, c, authKey) => this.attach(machine, i, c, authKey),
      netDetach: (machine, i) => this.detach(machine, i),
      netConnect: async (i) => {
        const c = net.views()[i]?.connection;
        if (c)
          await takeHeld(
            () => net.connect(i, c),
            HeldError,
            useHere,
            () => net.takeFrom(i, c),
          );
      },
      netDisconnect: (i) => net.disconnect(i),
      netLogout: (i) => net.logout(i),
      netLogoutConnection: (c) => this.logoutConnection(c),
      netFollow: () => this.follow(),
      netExit: (i, peer) => net.setExitNode(i, peer),
      netRoutes: (i, on) => net.setAcceptRoutes(i, on),
      netEdit: (c) => net.edit(c),
      netRename: async (c, name) => {
        await net.conns.put({ ...c, name: name.trim() || c.name });
        await net.refresh();
      },
      netDelete: (c) => this.delete(c),
      netNewAddress: (c) => this.newAddress(c),
      netHolder: (id) => net.locks.holder(connectionLock(id)),
    };
  }
}
