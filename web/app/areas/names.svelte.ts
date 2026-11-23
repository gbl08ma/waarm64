// Registered names on the page (docs/networking/names.md "What the user sees"): the titles the names agent keeps
// (web/names.ts), read into `$state` at load and again whenever the agent changes one (its BroadcastChannel, in any tab)
// and every minute (a reserved name's "in about N hours"); the dialog's checks (as typed, and at Register), Register (the dialog has closed: the
// adapter shows Preparing until the title is stored), a name's zone and its release; and, at load, the notice of names
// in their last week; and a room connection as its room sees it (its key, its name in the room, the room's domains:
// `member`), connected or not. The agent and its worker are loaded only when titles exist, the dialog is used, or a
// room connection's own name or domains are shown.
import { SvelteMap } from 'svelte/reactivity';
import { msg, MsgError, t, type Msg } from '../../i18n.ts';
import type { Action } from './message-bar.svelte.ts';
import type { Member, MemberConn, NameCheck, NamesConn, TitleView } from '../../names.ts';
import { roomOf } from '../../room.ts';
import type { ZonePoint } from '../../names-store.ts';
import { isLive, repointed, titlesOf } from '../names-view.ts';
import type { From } from '../home-route.ts';
import { machinesNav } from './machines-nav.svelte.ts';

const names = () => import('../../names.ts');
/** How often the titles are read again while nothing changes (the reserved state's hours). */
const REFRESH_MS = 60_000;

/** A room connection as the names need it: its key's entry and link, and whether its key lasts (an ephemeral
 * connection's own key is gone with the page). */
export type NamesOf = NamesConn & { ephemeralKey: boolean };

/** Room connection `r` (web/app/connections.ts `RoomConnection`) as `member` takes it: an ephemeral one's own key with it. */
export const memberOf = (r: { identityKey: string; link: string; identity?: { key: string } }): MemberConn => ({
  identityKey: r.identityKey,
  link: r.link,
  ...(r.identity ? { identity: { key: r.identity.key } } : {}),
});

/** `member`'s cache key: the key's entry or the key itself, and the room (not its link: relays don't change it). */
const memberKey = (c: MemberConn) =>
  JSON.stringify([c.identity?.key ?? '', c.identity ? '' : c.identityKey, roomOf(c.link)]);

class PageNames {
  /** Every title kept in this browser, with its state and dates. */
  titles = $state.raw<TitleView[]>([]);
  /** Names being registered here: Preparing until their title is stored. */
  registering = $state.raw<{ identityKey: string; link: string; name: string }[]>([]);
  /** Room connections as their rooms see them, by `memberKey`. */
  readonly #members = new SvelteMap<string, Member>();
  /** Why the last read of one failed, by `memberKey` (until a later read, which tries again, answers). */
  readonly #failed = new SvelteMap<string, MsgError>();
  /** Those being read, with the generation each started in (not reactive: a read starts once). */
  readonly #asking = new Map<string, number>();
  /** Bumped when a key is forgotten (`forgetMember`): a read started before then answers for the old key, dropped. */
  #generation = 0;
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
      const have = await (await import('../../names-store.ts')).idbNamesStore().titles();
      this.titles = have.length ? await n.namesAgent().titles() : [];
    } catch (e) {
      console.warn('names: the titles could not be read:', e);
    }
  }

  /** Connection `c`'s titles in its room, those being registered first (as Preparing). */
  of(c: NamesConn): TitleView[] {
    return titlesOf(this.titles, this.registering, c);
  }

  /**
   * Room connection `c` as its room sees it (web/names.ts `Member`: its node key, its name in the room, the room's
   * domains), whether or not it is connected: undefined until the agent has said, then kept (reactive). Its key is
   * made under its entry if it never started (web/names.ts `NamesAgent.member`). A read that fails says why
   * (`memberError`); the next call reads again.
   */
  member(c: MemberConn): Member | undefined {
    const k = memberKey(c);
    const have = this.#members.get(k);
    if (have || this.#asking.has(k)) return have;
    const gen = this.#generation;
    this.#asking.set(k, gen);
    const plain = memberOf(c); // not a proxy: it crosses to the worker
    const current = () => this.#asking.get(k) === gen;
    void names()
      .then((n) => n.namesAgent().member(plain))
      .then(
        (m) => {
          if (!current()) return;
          this.#members.set(k, m);
          this.#failed.delete(k);
        },
        (e: unknown) => {
          if (current()) this.#failed.set(k, new MsgError('network:names.memberFailed', {}, { cause: e }));
        },
      )
      .finally(() => {
        if (current()) this.#asking.delete(k);
      });
    return undefined;
  }

  /** Why connection `c`'s last `member` read failed (a `MsgError`: the headline, the cause as details), if it did. */
  memberError(c: MemberConn): MsgError | undefined {
    return this.#failed.get(memberKey(c));
  }

  /** The key kept under `identityKey` changed (New name): what `member` said of it, or is still reading, is read again. */
  forgetMember(identityKey: string) {
    this.#generation++;
    const under = (k: string) => (JSON.parse(k) as string[])[1] === identityKey;
    for (const k of [...this.#members.keys()]) if (under(k)) this.#members.delete(k);
    for (const k of [...this.#failed.keys()]) if (under(k)) this.#failed.delete(k);
    for (const k of [...this.#asking.keys()]) if (under(k)) this.#asking.delete(k);
  }

  /** Connection `c` is up with link `c.link`: its titles in the room publish through it (web/names.ts `relink`). */
  async relink(c: NamesConn) {
    if (!this.of(c).some((t) => t.link !== c.link)) return;
    await (await names()).namesAgent().relink(c);
    await this.refresh();
  }

  /** The dialog's check of `name` as typed: the rules and this connection's own, **no server asked**
   * (web/names.ts `NamesAgent.checkHere`). */
  async checkHere(c: NamesConn, name: string): Promise<NameCheck> {
    return (await names()).namesAgent().checkHere(c, name);
  }

  /** The dialog's check of `name` when Register is pressed: the room's servers asked for one first byte
   * (web/names.ts `NamesAgent.check`). */
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

  /** Room connection `c`'s node key as its room sees it (the agent's `member`; made under its entry if it has none). */
  async key(c: MemberConn): Promise<string> {
    return (await (await names()).namesAgent().member(memberOf(c))).key;
  }

  /**
   * After New name on room connection `c` (its key was `from`, now `to`), its domains in the room still held: pointed
   * at the new key (`point`: what pointed at the old one; another member's points stay) or let go (`release`).
   */
  async newKey(c: NamesConn, from: string, to: string, how: 'point' | 'release') {
    const agent = (await names()).namesAgent();
    const room = roomOf(c.link);
    const held = (await agent.titles(c.identityKey)).filter((v) => v.room === room && isLive(v));
    try {
      for (const v of held) {
        if (how === 'release') await agent.release(c, v.name);
        else {
          const points = repointed(v.points, from, to);
          if (points) await agent.setZone(c, v.name, points);
        }
      }
    } finally {
      await this.refresh();
    }
  }

  /**
   * At load: the agent starts when titles are kept; after its first pass, the names in their last week are said, with
   * a Domains action that opens (`open`) the pane of the connection holding the first of them.
   */
  async start(notify: (m: Msg, actions: Action[]) => void, open: (o: { identityKey: string; room: string }) => void) {
    this.watch();
    const n = await names();
    const agent = await n.startNamesAgent();
    if (!agent) return;
    const soon = n.inLastWeek(await agent.titles(), Math.floor(Date.now() / 1000));
    await this.refresh();
    const first = soon.at(0);
    if (first?.keptUntil === undefined) return;
    const list = soon.map((v) => v.name);
    const of = { identityKey: first.identityKey, room: first.room };
    notify(msg('network:names.lastWeek', { names: list, count: list.length, when: new Date(first.keptUntil * 1000) }), [
      { label: t('network:names.domains'), run: () => open(of) },
    ]);
  }
}

export const pageNames = new PageNames();

/**
 * At every load (web/app/main.ts): the agent, and the notice of names in their last week (`messages`), whose Domains
 * action opens the Domains of the room connection among `net`'s that holds the first of them (Back leading to what
 * showed when it was pressed: the machine's screen, or Home's pane, `machinesNav.origin`; `page` read then, once it is
 * made).
 */
export const startPageNames = (
  messages: { notify(m: Msg, kind: 'info', actions: Action[]): void },
  net: { connections: { id: string; room?: { identityKey: string; link: string } }[] },
  page: () => { openConnection(id: string, section: 'domains', from: From): void },
) =>
  pageNames
    .start(
      (m, actions) => messages.notify(m, 'info', actions),
      (o) => {
        const c = net.connections.find((x) => x.room?.identityKey === o.identityKey && roomOf(x.room.link) === o.room);
        if (c) page().openConnection(c.id, 'domains', machinesNav.origin());
      },
    )
    .catch((e: unknown) => console.warn('names agent:', e));
