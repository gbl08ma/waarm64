// Registered names as the page says them (docs/plans/room-names.md "What the user sees"): a title's state in the
// adapter's menu and details, the dialog's check as typed, the details' line of the registry, a stored machine's names on
// the Machines page, and where a name points in words (a member's name in the room) and back. Pure: the area
// (web/app/areas/names.svelte.ts) and the components call these.
import { msg, type Msg } from '../i18n.ts';
import type { NameCheck, TitleView } from '../names.ts';
import { base32 } from '../room.ts';

const HOUR_MS = 60 * 60 * 1000;
const date = (unixS: number) => new Date(unixS * 1000);

/** Title `v`'s state in words at `now` (ms): Preparing, Reserved (public in about N hours), Active (kept until about a
 * date), in its grace, lapsed, let go, lost. */
export function titleState(v: TitleView, now = Date.now()): Msg {
  switch (v.state) {
    case 'preparing':
      return msg('network:names-view.preparing');
    case 'reserved': {
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

/** What the dialog's check says under the field: `checking` while the servers are asked; nothing for an empty field. */
export type CheckShown = NameCheck | { state: 'checking' | 'empty' };

export function checkWords(name: string, c: CheckShown): Msg | undefined {
  switch (c.state) {
    case 'empty':
      return undefined;
    case 'checking':
      return msg('network:names-view.check.checking');
    case 'invalid':
      return msg('network:names-view.check.invalid');
    case 'yours':
      return msg('network:names-view.check.yours', { name });
    case 'free':
      return msg('network:names-view.check.free', { name });
    case 'taken':
      return msg('network:names-view.check.taken', { name, when: date(c.until) });
    case 'unknown':
      return msg('network:names-view.check.unknown', { name });
  }
}

/** Register is offered for a name the room's servers don't hold, or that nobody in the room can say about. */
export const canRegister = (c: CheckShown) => c.state === 'free' || c.state === 'unknown';

/** The details' line of the registry: a server's names held, or a member's resolved, and the servers. */
export function namesLine(n: { serving: boolean; names: number; servers: number }): Msg {
  return n.serving
    ? msg('network:names-view.line.serving', { count: n.names, servers: n.servers })
    : msg('network:names-view.line.member', { count: n.names, servers: n.servers });
}

/** A stored machine's names on the Machines page: each with the date it stops resolving unless renewed. */
export function machineNames(views: TitleView[]): Msg[] {
  return views
    .filter((v) => v.state === 'active' || v.state === 'grace' || v.state === 'reserved' || v.state === 'preparing')
    .map((v) =>
      v.keptUntil === undefined
        ? msg('network:names-view.machine.new', { name: v.name })
        : msg('network:names-view.machine.until', { name: v.name, when: date(v.keptUntil) }),
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
