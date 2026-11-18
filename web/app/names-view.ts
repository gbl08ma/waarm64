// Registered names as the page says them (docs/plans/room-names.md "What the user sees"): a title's state in the
// adapter's menu and details, the dialog's check (as typed, and at Register), the details' line of the registry, a stored machine's names on
// the Home page, and where a name points in words (a member's name in the room) and back. Pure: the area
// (web/app/areas/names.svelte.ts) and the components call these.
import { msg, type Msg } from '../i18n.ts';
import type { NameCheck, TitleView } from '../names.ts';
import { base32, roomOf } from '../room.ts';

const HOUR_MS = 60 * 60 * 1000;
/** The most points a name has: the name itself and 15 labels (a wide zone's 16 slots; web/names.ts). */
export const MAX_POINTS = 16;

/** Connection `c`'s titles: its key's, in its room (by the room's ID, not the link a title was registered with: a
 * connection rejoined with other relays keeps its names, review 2), those being registered first (as Preparing). */
export function titlesOf(
  titles: TitleView[],
  registering: { identityKey: string; link: string; name: string }[],
  c: { identityKey: string; link: string },
): TitleView[] {
  const room = roomOf(c.link);
  const mine = (x: { identityKey: string }, r: string) => x.identityKey === c.identityKey && r === room;
  const held = titles.filter((t) => mine(t, t.room));
  const making = registering
    .filter((r) => mine(r, roomOf(r.link)) && !held.some((t) => t.name === r.name))
    .map((r): TitleView => ({
      identityKey: r.identityKey,
      room,
      link: r.link,
      name: r.name,
      state: 'preparing',
      points: [],
    }));
  return [...making, ...held];
}
const date = (unixS: number) => new Date(unixS * 1000);

/** Title `v`'s state in words at `now` (ms): Preparing, Reserved (public in about N hours), Active (kept until about a
 * date), in its grace, lapsed, let go, lost. */
export function titleState(v: TitleView, now = Date.now()): Msg {
  switch (v.state) {
    case 'preparing':
      return msg('network:names-view.preparing');
    case 'reserved': {
      // Past the usual wait, the claim's proof waits for this web app to be open long enough to collect it: no hours
      // to count (review 2).
      if ((v.publicAbout ?? now) <= now) return msg('network:names-view.reservedLate');
      const count = Math.max(1, Math.ceil(((v.publicAbout ?? now) - now) / HOUR_MS));
      return msg('network:names-view.reserved', { count });
    }
    case 'active':
      return msg('network:names-view.active', { when: date(v.keptUntil ?? 0) });
    case 'grace':
      return msg('network:names-view.grace', { when: date(v.lapsesAt ?? 0) });
    case 'lapsed':
      return msg('network:names-view.lapsed');
    case 'released':
      return msg('network:names-view.released');
    case 'lost':
      return msg('network:names-view.lost');
  }
}

/** What the dialog's check says under the field: `checking` while the servers are asked (Register pressed); nothing
 * for an empty field or a valid name not asked about yet. */
export type CheckShown = NameCheck | { state: 'checking' | 'empty' };

export function checkWords(name: string, c: CheckShown): Msg | undefined {
  switch (c.state) {
    case 'empty':
    case 'valid':
    case 'free':
      return undefined;
    case 'checking':
      return msg('network:names-view.check.checking');
    case 'invalid':
      return msg('network:names-view.check.invalid');
    case 'yours':
      return msg('network:names-view.check.yours', { name });
    case 'taken':
      return msg('network:names-view.check.taken', {
        name,
        when: date(c.until),
      });
    case 'unknown':
      return msg('network:names-view.check.unknown', { name });
    case 'disputed':
      return msg('network:names-view.check.disputed', { name, when: date(c.until) });
  }
}

/** Register is offered for a valid name not asked about yet, and for one nobody in the room can say about or whose
 * servers disagree about (pressed again, it registers). */
export const canRegister = (c: CheckShown) =>
  c.state === 'valid' || c.state === 'free' || c.state === 'unknown' || c.state === 'disputed';

/** What the dialog asks of the names (web/app/areas/names.svelte.ts `pageNames`; the tests' fakes). */
export type NameAsk = {
  /** As typed: the rules and this connection's own, **asking no server** (`NamesAgent.checkHere`). */
  here(name: string): Promise<NameCheck>;
  /** At Register: the room's servers asked for one first byte (`NamesAgent.check`). */
  servers(name: string): Promise<NameCheck>;
  /** Registers it; the dialog closes. */
  register(name: string): void;
};

/**
 * The dialog's check (room-names.md "What the user sees"; the user's decision, 2026-11-17): **as typed, only what this
 * page can say** (not a valid name, this connection's own); **the room's servers are asked when Register is pressed**,
 * one first byte a press. Free: registered. Taken: the dialog stays open and says until about when. Nobody can say, or
 * the servers disagree (one lists it, another doesn't: an answer is a bare claim, so one liar can't make it taken, the
 * final review's finding 8): it says so, and Register pressed again for the same name registers it (first come still
 * holds; nothing added to the path where the name is free, the kickoff's decision 6).
 */
export class NameForm {
  shown: CheckShown = { state: 'empty' };
  #name = '';
  /** The check under way: an answer to an older one (the name typed since, the dialog closed) is dropped. */
  #serial = 0;
  readonly #ask: NameAsk;
  readonly #onShown: (c: CheckShown) => void;
  constructor(ask: NameAsk, onShown: (c: CheckShown) => void) {
    [this.#ask, this.#onShown] = [ask, onShown];
  }

  /** The field now says `name`: checked here, no server asked. */
  typed(name: string) {
    this.#name = name;
    const k = ++this.#serial;
    this.#show({ state: 'empty' });
    if (!name) return;
    this.#ask.here(name).then(
      (r) => k === this.#serial && this.#show(r),
      () => k === this.#serial && this.#show({ state: 'valid' }),
    );
  }

  /** Register pressed: true when the name was registered (the dialog closes). */
  async press(): Promise<boolean> {
    const name = this.#name;
    const s = this.shown.state;
    if (!name || s === 'checking' || s === 'invalid' || s === 'yours' || s === 'taken') return false;
    if (s === 'unknown' || s === 'disputed') {
      this.#ask.register(name);
      return true;
    }
    const k = ++this.#serial;
    this.#show({ state: 'checking' });
    const r = await this.#ask.servers(name).catch((): NameCheck => ({ state: 'unknown' }));
    if (k !== this.#serial) return false;
    if (r.state === 'free') {
      this.#ask.register(name);
      return true;
    }
    this.#show(r);
    return false;
  }

  /** The dialog closed: an answer still coming is dropped. */
  close() {
    this.#serial++;
  }

  #show(c: CheckShown) {
    this.shown = c;
    this.#onShown(c);
  }
}

/** The details' line of the registry: a server's names held, or a member's resolved, and the servers. */
export function namesLine(n: { serving: boolean; names: number; servers: number }): Msg {
  return n.serving
    ? msg('network:names-view.line.serving', {
        count: n.names,
        servers: n.servers,
      })
    : msg('network:names-view.line.member', {
        count: n.names,
        servers: n.servers,
      });
}

/** A stored machine's names on the Home page: each with the date it stops resolving unless renewed. */
export function machineNames(views: TitleView[]): Msg[] {
  return views
    .filter((v) => v.state === 'active' || v.state === 'grace' || v.state === 'reserved' || v.state === 'preparing')
    .map((v) =>
      v.keptUntil === undefined
        ? msg('network:names-view.machine.new', { name: v.name })
        : msg('network:names-view.machine.until', {
            name: v.name,
            when: date(v.keptUntil),
          }),
    );
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** A member's name in the room (`<key>.<tag>.p2p.internal`, or its first label) or a node key (64 hex digits) as a node
 * key, lower case; undefined if it is neither. */
export function parseTarget(s: string): string | undefined {
  const t = s.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(t)) return t;
  const label = t.split('.')[0];
  if (!/^[a-z2-7]{52}$/.test(label)) return undefined;
  let [acc, bits] = [0, 0];
  const out: number[] = [];
  for (const c of label) {
    acc = ((acc << 5) | B32.indexOf(c)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
    }
  }
  const key = Uint8Array.from(out.slice(0, 32));
  // Only what base32 writes for some key: its last character's spare bits are zero.
  return base32(key) === label ? Array.from(key, (b) => b.toString(16).padStart(2, '0')).join('') : undefined;
}

/** Node key `key` as a member's name in the room whose domain is `domain` (`<tag>.p2p.internal`). */
export function targetName(key: string, domain: string): string {
  const b = Uint8Array.from({ length: 32 }, (_, i) => parseInt(key.slice(2 * i, 2 * i + 2), 16));
  return `${base32(b)}.${domain}`;
}
