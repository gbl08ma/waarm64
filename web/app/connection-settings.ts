// A connection's Settings on the Home page (ConnectionSettings.svelte; docs/frontend.md "The Home page"): the draft its
// form edits, taken from the stored connection, whether it differs, and the connection Save writes from it, after
// checking what was typed. What a draft holds, by kind, is what can change without a new node: the name; a tailnet's
// hostname; tailcat's exit address, whether it serves, its relay and who is let in; the local helper's link; the demo
// network's server; a room's two switches. DOM-free, so tests/connection-settings.test.ts runs it in Node.
import { msg, type Msg } from '../i18n.ts';
import { DEMO_URL, parseDemoURL } from '../demo-net.ts';
import { parseLocalURL } from '../local-net.ts';
import type { Connection, TailcatConnection } from './connections.ts';
import { parseAllow, parseHostname, parseRelay, parseTailcatAddr } from './network.ts';

/** What the Settings' form edits. Fields of other kinds stay as `draftOf` made them. */
export type SettingsDraft = {
  name: string;
  /** A tailnet's hostname. */
  hostname: string;
  /** tailcat: an exit through `address`, and or a server (`relay`, `allow` a key a line). */
  exit: boolean;
  address: string;
  serve: boolean;
  relay: string;
  allow: string;
  /** The local helper's link, or the demo network's server ('' its default one). */
  url: string;
  /** A room's switches: members may connect to the guest; all traffic through the relays. */
  incoming: boolean;
  relayOnly: boolean;
};

/** A draft with nothing in it (before a connection is read). */
export const emptyDraft = (): SettingsDraft => ({
  name: '',
  hostname: '',
  exit: true,
  address: '',
  serve: false,
  relay: '',
  allow: '',
  url: '',
  incoming: true,
  relayOnly: false,
});

/** The draft of connection `c` as stored. */
export function draftOf(c: Connection): SettingsDraft {
  const d = { ...emptyDraft(), name: c.name };
  const cat = c.tailcat;
  if (c.tailnet) d.hostname = c.tailnet.hostname;
  if (cat) Object.assign(d, { exit: !!cat.exit, address: cat.exit ?? '', serve: cat.serve, relay: cat.relay });
  if (cat?.allow) d.allow = cat.allow.join('\n');
  if (c.local) d.url = c.local.url;
  if (c.demo && c.demo.url !== DEMO_URL) d.url = c.demo.url;
  if (c.room) Object.assign(d, { incoming: c.room.incoming, relayOnly: c.room.relayOnly });
  return d;
}

/** The fields kind `kind`'s Settings show (the name is every kind's). */
const FIELDS: Record<Connection['kind'], (keyof SettingsDraft)[]> = {
  tailnet: ['hostname'],
  tailcat: ['exit', 'address', 'serve', 'relay', 'allow'],
  local: ['url'],
  demo: ['url'],
  room: ['incoming', 'relayOnly'],
};

/** Drafts `a` and `b` of a connection of kind `kind` differ in what its Settings show. */
export const differs = (kind: Connection['kind'], a: SettingsDraft, b: SettingsDraft) =>
  a.name !== b.name || FIELDS[kind].some((k) => a[k] !== b[k]);

/** Draft `d` changes connection `c`'s settings (not counting its name). */
export const settingsChanged = (c: Connection, d: SettingsDraft) => {
  const was = draftOf(c);
  return FIELDS[c.kind].some((k) => was[k] !== d[k]);
};

type Edited = { connection: Connection } | { error: Msg };

/** Tailcat connection `c` with draft `d`'s exit and server, or what's wrong in them. */
function tailcatOf(c: Connection & { tailcat: TailcatConnection }, d: SettingsDraft): Edited {
  if (!d.exit && !d.serve) return { error: msg('network:NetTailcatStep.chooseTailcat') };
  const addr = d.exit ? parseTailcatAddr(d.address) : { addr: '' };
  if ('error' in addr) return addr;
  const r = d.serve && !d.exit ? parseRelay(d.relay) : { relay: d.relay.trim() };
  if ('error' in r) return r;
  const letIn = d.serve ? parseAllow(d.allow) : { allow: [] };
  if ('error' in letIn) return letIn;
  const allow = letIn.allow.length ? letIn.allow : undefined;
  return {
    connection: {
      ...c,
      tailcat: { ...c.tailcat, exit: addr.addr || undefined, serve: d.serve, relay: r.relay, allow },
    },
  };
}

/** Connection `c` with draft `d`'s settings, or what's wrong in what was typed. An empty name keeps the old one. */
export function editedOf(c: Connection, d: SettingsDraft): Edited {
  const named: Connection = { ...c, name: d.name.trim() || c.name };
  const tailnet = named.tailnet;
  const tailcat = named.tailcat;
  if (tailnet) {
    const host = parseHostname(d.hostname);
    return 'error' in host ? host : { connection: { ...named, tailnet: { ...tailnet, hostname: host.hostname } } };
  }
  if (tailcat) return tailcatOf({ ...named, tailcat }, d);
  if (named.local || named.demo) {
    const u = named.local ? parseLocalURL(d.url) : parseDemoURL(d.url);
    if ('error' in u) return u;
    return { connection: named.local ? { ...named, local: { url: u.url } } : { ...named, demo: { url: u.url } } };
  }
  const room = named.room;
  return { connection: room ? { ...named, room: { ...room, incoming: d.incoming, relayOnly: d.relayOnly } } : named };
}
