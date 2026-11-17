// Registered names on the page (docs/plans/room-names.md "What the user sees"): the titles the names agent keeps
// (web/names.ts), read into `$state` at load and again whenever the agent changes one (its BroadcastChannel, in any tab)
// and every minute (a reserved name's "in about N hours"); the dialog's check, Register (the dialog has closed: the
// adapter shows Preparing until the title is stored), a name's zone and its release; and, at load, the notice of names
// in their last week. The agent and its worker are loaded only when titles exist or the dialog is used.
import { msg, MsgError, type Msg } from '../../i18n.ts';
import type { NameCheck, NamesConn, TitleView, ZonePoint } from '../../names.ts';
import { titlesOf } from '../names-view.ts';

const names = () => import('../../names.ts');
/** How often the titles are read again while nothing changes (the reserved state's hours). */
const REFRESH_MS = 60_000;

/** A room connection as the names need it: its key's entry and link, and whether its key lasts (an ephemeral
 * connection's own key is gone with the page). */
export type NamesOf = NamesConn & { ephemeralKey: boolean };

class PageNames {
  /** Every title kept in this browser, with its state and dates. */
  titles = $state.raw<TitleView[]>([]);
  /** Names being registered here: Preparing until their title is stored. */
  registering = $state.raw<{ identityKey: string; link: string; name: string }[]>([]);
  #watching = false;

  /** Reads the titles now, again at each change the agent announces, and every minute. */
  watch() {
    if (this.#watching) return;
    this.#watching = true;
    try {
      const channel = new BroadcastChannel('waarm64-names'); // web/names.ts NAMES_CHANNEL
      channel.onmessage = () => void this.refresh();
    } catch {
      // No BroadcastChannel: the minute's reading still follows other tabs.
    }
    setInterval(() => void this.refresh(), REFRESH_MS);
    void this.refresh();
  }

  async refresh() {
    try {
      const n = await names();
      const have = await n.idbNamesStore().titles();
      this.titles = have.length ? await n.namesAgent().titles() : [];
    } catch (e) {
      console.warn('names: the titles could not be read:', e);
    }
  }

  /** Connection `c`'s titles in its room, those being registered first (as Preparing). */
  of(c: NamesConn): TitleView[] {
    return titlesOf(this.titles, this.registering, c);
  }

  /** Connection `c` is up with link `c.link`: its titles in the room publish through it (web/names.ts `relink`). */
  async relink(c: NamesConn) {
    if (!this.of(c).some((t) => t.link !== c.link)) return;
    await (await names()).namesAgent().relink(c);
    await this.refresh();
  }

  /** The dialog's check of `name` as typed (web/names.ts `NamesAgent.check`: servers asked for its id's first byte). */
  async check(c: NamesConn, name: string): Promise<NameCheck> {
    return (await names()).namesAgent().check(c, name);
  }

  /**
   * Registers `name` for connection `c`, pointing at node key `key`. **Refused on a connection whose key is
   * ephemeral**: the name would outlive its key by weeks, and point nowhere once the page closed. The agent starts
   * looking after the title (collecting, publishing) at once.
   */
  async register(c: NamesOf, name: string, key: string) {
    if (c.ephemeralKey) throw new MsgError('network:names.ephemeral');
    const r = { identityKey: c.identityKey, link: c.link, name };
    this.registering = [...this.registering, r];
    try {
      const agent = (await names()).namesAgent();
      await agent.register(c, name, [{ label: null, key }]).catch((e: unknown) => {
        throw new MsgError('network:names.registerFailed', { name }, { cause: e });
      });
      void agent.start();
    } finally {
      this.registering = this.registering.filter((x) => x !== r);
      await this.refresh();
    }
  }

  async setZone(c: NamesConn, name: string, points: ZonePoint[]) {
    await (await names()).namesAgent().setZone(c, name, points);
    await this.refresh();
  }

  async release(c: NamesConn, name: string) {
    await (await names()).namesAgent().release(c, name);
    await this.refresh();
  }

  /** At load: the agent starts when titles are kept; after its first pass, the names in their last week are said. */
  async start(notify: (m: Msg) => void) {
    this.watch();
    const n = await names();
    const agent = await n.startNamesAgent();
    if (!agent) return;
    const soon = n.inLastWeek(await agent.titles(), Math.floor(Date.now() / 1000));
    await this.refresh();
    const first = soon.at(0);
    if (first?.keptUntil === undefined) return;
    const list = soon.map((v) => v.name);
    notify(msg('network:names.lastWeek', { names: list, count: list.length, when: new Date(first.keptUntil * 1000) }));
  }
}

export const pageNames = new PageNames();

/** At every load (web/app/main.ts): the agent, and the notice of names in their last week (`notify`). */
export const startPageNames = (notify: (m: Msg) => void) =>
  pageNames.start(notify).catch((e: unknown) => console.warn('names agent:', e));
