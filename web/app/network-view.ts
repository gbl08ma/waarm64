// The page's network as the user sees it (docs/frontend.md "Network"): an adapter's phase, its words and what it
// offers, from its client's report (web/app/network.ts); and which adapter is the guest's default way out. DOM-free,
// for tests/network.test.ts.
import { describe, errorText, msg, t, text, type Msg } from '../i18n.ts';
import { isMsg } from '../msg.ts';
import type { NetMap } from '../tailscale.ts';
import type { Connection } from './connections.ts';
import type { Network } from './network.ts';
import type { Adapter } from './shape.ts';

export type Phase =
  /** No client. */
  | 'off'
  /** Loading the client, or waiting for the control server. */
  | 'connecting'
  /** The user has something to do: open the login link, or an admin has to approve the machine. */
  | 'login'
  | 'connected'
  | 'error';

/** A phase's light (the Network menu's dot, an adapter's heading: ui/StatusDot.svelte's tones). */
const PHASE_TONES: Record<Phase, 'ok' | 'busy' | 'bad' | 'off'> = {
  off: 'off',
  connecting: 'busy',
  login: 'busy',
  connected: 'ok',
  error: 'bad',
};
export const phaseTone = (phase: Phase | undefined) => (phase ? PHASE_TONES[phase] : 'off');

export type NetworkView = {
  phase: Phase;
  /** One line for the menu. */
  text: string;
  /** Lines under `text`, one each: an error's (`phase` `error`) what it said; a room's its active connections. */
  details?: string[];
  /** Where to log in (only http(s) URLs). */
  loginURL?: string;
  /** The guest's address, when connected: IPv4, or IPv6 for a room's (rooms carry IPv6 alone). */
  address?: string;
  /** The peers that offer to be the exit node (approved by the tailnet's admin), when connected; `use` marks the one in use. */
  exitNodes: { id: string; name: string; online: boolean; use: boolean }[];
  /** The machine's own tailcat address, when it lets tailcat clients in. */
  served?: string;
  /** tailcat through a server: the machine's node key, for the server's `--allow`. */
  tailcatKey?: string;
  /** The subnets the tailnet's peers route (when any do), and whether they're installed. */
  subnets?: { routes: string[]; on: boolean };
  /** Connected, and it reaches the internet (a tailnet's exit node in use, tailcat through a server, the local helper): it can be the guest's default way out. */
  internet?: boolean;
  /** And over IPv6, as its probe tells (web/reach6.ts; the local helper's isn't known): it can be IPv6's (`primary6Of`). */
  internet6?: boolean;
  /** The local helper's: its lease always routes everything through it, so it is the primary first (`primaryOf`). */
  local?: boolean;
  /**
   * A room's, when connected: the machine's name in it (to give out), the room's link, and whether members may connect;
   * and why members go through the relay where a direct path was wanted (the menu's warning, the details' words):
   * `blocked`, this browser makes none; `peersBlocked`, how many members' browsers make none; `failed`, how many
   * members' attempts failed though this browser gathers. Relay only, by choice, has none of these.
   */
  room?: { name: string; link: string; incoming: boolean; blocked?: boolean; peersBlocked?: number; failed?: number };
};

/** Whether a room's members go through the relay for a reason worth a warning (`NetworkView.room`). */
export const roomWarned = (r: NetworkView['room']) => !!r && (!!r.blocked || !!r.peersBlocked || !!r.failed);

/**
 * Which of a machine's adapters is the guest's default way out (docs/networking/adapters.md §4): the first connected
 * local helper's; else the first, in order, that is connected and reaches the internet; without one, the first connected (so a machine with one adapter
 * keeps its default route, as it always had); -1 when none is connected.
 */
export function primaryOf(views: Pick<NetworkView, 'phase' | 'internet' | 'local'>[]): number {
  // A local helper's lease always carries a default route (its DHCP, not the page's): it goes first, so a tailnet or
  // tailcat adapter beside it is the one given only its routes (docs/networking/adapters.md §4).
  const local = views.findIndex((v) => v.phase === 'connected' && v.local);
  if (local >= 0) return local;
  const net = views.findIndex((v) => v.phase === 'connected' && v.internet);
  return net >= 0 ? net : views.findIndex((v) => v.phase === 'connected');
}

/**
 * Which adapter is IPv6's default way out (docs/networking/adapters.md §4 "A primary per family"): the primary
 * (`primary`, `primaryOf`'s) when it is a local helper's (whose own router advertisements the page can't change) or its
 * IPv6 reaches the internet; else the first, in order, whose IPv6 does (a tailnet's exit node beside tailcat whose
 * server has none); without one, the primary, whose lease then has no IPv6 default (web/reach6.ts `unreached6`).
 */
export function primary6Of(
  views: Pick<NetworkView, 'phase' | 'internet' | 'internet6' | 'local'>[],
  primary = primaryOf(views),
): number {
  if (primary < 0 || views[primary].local || views[primary].internet6) return primary;
  const v6 = views.findIndex((v) => v.phase === 'connected' && v.internet && v.internet6);
  return v6 >= 0 ? v6 : primary;
}

/**
 * Each adapter's rank: how many connected adapters come before it. Its IPv6 routes' preference follows (web/gateway.ts
 * `ranked`), so where two offer the same prefix (a tailnet's and tailcat's /48) the earlier adapter's wins.
 */
export function ranksOf(views: Pick<NetworkView, 'phase'>[]): number[] {
  let n = 0;
  return views.map((v) => (v.phase === 'connected' ? n++ : n));
}

/** What a `Tailscale` client reports, as far as the view needs it. */
export type ClientReport = {
  state: string;
  netmap?: NetMap;
  loginURL?: string;
  error?: unknown;
  tailcat?: boolean;
  local?: boolean;
  room?: boolean;
};

const web = (s: string | undefined) => {
  try {
    const u = new URL(s ?? '');
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
};

/** The local helper's view: its lease routes everything through it. */
function localView(c: ClientReport): NetworkView {
  if (c.state !== 'Running')
    return { phase: 'connecting', text: t('network:network-view.connectingHelper'), exitNodes: [] };
  const address = c.netmap?.addresses[0]?.replace(/\/\d+$/, '');
  return {
    phase: 'connected',
    address,
    exitNodes: [],
    internet: true,
    local: true,
    text: address
      ? t('network:network-view.connectedLocal.address', { address })
      : t('network:network-view.connectedLocal'),
  };
}

/** A room's view: connected, its name, link and connections; or what it's doing. */
function roomView(c: ClientReport): NetworkView {
  const r = c.netmap?.room;
  if (c.state === 'Running' && c.netmap && r) {
    const address = c.netmap.addresses[0]?.replace(/\/\d+$/, '');
    // A room reaches only its members: never the internet, so never the default way out over another adapter's.
    return {
      phase: 'connected',
      address,
      exitNodes: [],
      internet: false,
      room: {
        name: r.name,
        link: r.link,
        incoming: r.incoming,
        // Why members aren't reached directly (web/room.ts): the menu shows a warning, the details say why and what to do.
        ...(r.relayOnly
          ? {}
          : {
              blocked: !!r.directBlocked,
              peersBlocked: r.peersBlocked ?? 0,
              failed: r.directBlocked ? 0 : (r.directFailed ?? 0),
            }),
      },
      text: t('network:network-view.room'),
      details: [
        c.netmap.peers.length
          ? t('network:network-view.room.connectionsDirect', {
              count: c.netmap.peers.length,
              direct: c.netmap.peers.filter((p) => p.direct).length,
            })
          : t('network:network-view.room.connections', { count: 0 }),
      ],
    };
  }
  const doing: Record<string, string> = {
    FetchingMap: t('network:network-view.fetchingMap'),
    Connecting: t('network:network-view.connectingRelay'),
    Running: t('network:network-view.connectingRelay'),
  };
  return { phase: 'connecting', text: doing[c.state] ?? t('network:network-view.loadingClient'), exitNodes: [] };
}

/** tailcat's words once connected: its address, and whether it lets clients in. */
function tailcatText(address: string | undefined, serving: boolean) {
  if (address)
    return serving
      ? t('network:network-view.tailcat.address.serving', { address })
      : t('network:network-view.tailcat.address', { address });
  return serving ? t('network:network-view.tailcat.serving') : t('network:network-view.tailcat');
}

/** tailcat's view: online through a server, or only letting clients in; or what it's doing. */
function tailcatView(c: ClientReport): NetworkView {
  const netmap = c.netmap;
  if (c.state === 'Running' && netmap) {
    const served = netmap.serving ? { served: netmap.serving } : {};
    if (netmap.tailcatExit === false)
      return {
        phase: 'connected',
        exitNodes: [],
        text: t('network:network-view.servingOnly'),
        internet: false,
        ...served,
      };
    const address = netmap.addresses.find((a) => !a.includes(':'))?.replace(/\/\d+$/, '');
    const key = netmap.tailcatKey ? { tailcatKey: netmap.tailcatKey } : {};
    const text = tailcatText(address, !!netmap.serving);
    return {
      phase: 'connected',
      address,
      exitNodes: [],
      internet: true,
      internet6: !!netmap.reached6,
      text,
      ...served,
      ...key,
    };
  }
  const doing: Record<string, string> = {
    FetchingMap: t('network:network-view.fetchingMap'),
    Meowing: t('network:network-view.meowing'),
    Handshaking: t('network:network-view.handshaking'),
  };
  const other = c.state === '' ? t('network:network-view.loadingClient') : t('network:network-view.connectingRelay');
  return { phase: 'connecting', text: doing[c.state] ?? other, exitNodes: [] };
}

/** How a connected tailnet node says it is: by its name and address, as far as they're known. */
function connectedAs(name: string, address: string | undefined): Msg {
  if (name && address) return msg('network:network-view.connected.as.address', { name, address });
  if (name) return msg('network:network-view.connected.as', { name });
  if (address) return msg('network:network-view.connected.address', { address });
  return msg('network:network-view.connected');
}

/** A connected tailnet's view: its peers, the exit nodes on offer and the one in use, the subnets routed. */
function tailnetView(netmap: NetMap | undefined): NetworkView {
  const address = netmap?.addresses.find((a) => !a.includes(':'))?.replace(/\/\d+$/, '');
  const peers = netmap?.peers ?? [];
  const exitNodes = peers
    .filter((p) => p.exitNodeOption || p.id === netmap?.exitNode)
    .map((p) => ({
      id: p.id,
      name: p.name.replace(/\.$/, ''),
      online: p.online !== false,
      use: p.id === netmap?.exitNode,
    }));
  const via = exitNodes.find((e) => e.use);
  const routes = [...new Set(peers.flatMap((p) => p.routes ?? []))];
  const subnets = routes.length ? { subnets: { routes, on: netmap?.acceptRoutes !== false } } : {};
  const connected = connectedAs(netmap?.name ? netmap.name.replace(/\.$/, '') : '', address);
  // An exit node reported offline is named as such: its traffic is dropped (the client fails closed, as Go's does).
  const text = via
    ? via.online
      ? t('network:network-view.connectedPeers.via', { connected, count: peers.length, via: via.name })
      : t('network:network-view.connectedPeers.viaOffline', { connected, count: peers.length, via: via.name })
    : t('network:network-view.connectedPeers', { connected, count: peers.length });
  return {
    phase: 'connected',
    address,
    exitNodes,
    internet: !!via,
    internet6: !!via && !!netmap?.reached6,
    ...subnets,
    text,
  };
}

/** A tailnet client's view, by its state. */
function tailscaleView(c: ClientReport): NetworkView {
  const loginURL = web(c.loginURL);
  switch (c.state) {
    case 'Running':
      return tailnetView(c.netmap);
    case 'NeedsLogin':
      return loginURL
        ? { phase: 'login', text: t('network:network-view.logIn'), loginURL, exitNodes: [] }
        : { phase: 'connecting', text: t('network:network-view.contacting'), exitNodes: [] };
    case 'NeedsMachineAuth':
      return { phase: 'login', text: t('network:network-view.approval'), loginURL, exitNodes: [] };
    case 'Stopped':
      return { phase: 'off', text: t('network:network-view.stopped'), exitNodes: [] };
    default:
      return {
        phase: 'connecting',
        text: c.state === '' ? t('network:network-view.loadingClient') : t('network:network-view.connecting'),
        exitNodes: [],
      };
  }
}

/** The menu's view of a client's report (`undefined`: there's no client). */
export function viewOf(c: ClientReport | undefined): NetworkView {
  if (!c) return { phase: 'off', text: t('network:network-view.notConnected'), exitNodes: [] };
  if (c.error) {
    const d = describe(c.error);
    return {
      phase: 'error',
      text: t('network:network-view.couldntConnect'),
      details: [d.headline, ...d.details].filter((l) => l),
      exitNodes: [],
    };
  }
  if (c.local) return localView(c);
  if (c.netmap?.via === 'room' || c.room) return roomView(c);
  if (c.netmap?.via === 'tailcat' || c.tailcat) return tailcatView(c);
  return tailscaleView(c);
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
  /** Something the page has to say about it, in words: its connection was gone, another machine took it. */
  note?: string;
  /** The guest's default way out goes through it (IPv4's, and IPv6's unless `primary6` is another's). */
  primary: boolean;
  /** IPv6's default way out goes through it (`primary6Of`). */
  primary6: boolean;
  /** The machine runs, so the adapter can connect. */
  on: boolean;
};

/** A note's words: a message's, or an error's headline and details (one line each). */
const noteText = (n: unknown) => (n === undefined ? undefined : isMsg(n) ? text(n) : errorText(n));

/** What `adapterViews` reads of the page's machine's adapters (web/app/net-live.ts), each by its index. */
export type AdaptersNow = {
  adapters: Adapter[];
  /** Each adapter's client. */
  nets: Network[];
  /** What the page has to say about each adapter: a message, or an error its connecting met. */
  notes: unknown[];
  /** The browser's connections, as last read. */
  connections: Connection[];
  /** The guest's default way out, or -1; IPv6's (`primary6Of`; default `primary`). */
  primary: number;
  primary6?: number;
  /** The machine runs. */
  on: boolean;
};

/** The page's machine's adapters as the menu and the Network tab show them. */
export function adapterViews(o: AdaptersNow): AdapterView[] {
  const views = o.adapters.map((_, i) => o.nets[i]?.view() ?? viewOf(undefined));
  // Two adapters on local helpers both give the guest a default route (their DHCP, not the page's): said, not fixed.
  const locals = views.flatMap((v, i) => (v.phase === 'connected' && v.local ? [i] : []));
  return o.adapters.map((a, i) => ({
    index: i,
    mac: a.mac,
    connection: o.connections.find((c) => c.id === a.connection),
    view: views[i],
    active: !!o.nets.at(i)?.active(),
    note:
      noteText(o.notes[i]) ??
      (locals.length > 1 && locals.includes(i) && i !== o.primary
        ? text(msg('network:network-view.twoHelpers', { adapter: o.primary + 1 }))
        : undefined),
    primary: i === o.primary,
    primary6: i === (o.primary6 ?? o.primary),
    on: o.on,
  }));
}

/** Which defaults an adapter carries, for its words: both families', one family's (the other's is another adapter's), or none. */
export const defaultsOf = (a: Pick<AdapterView, 'primary' | 'primary6'>): 'both' | 'v4' | 'v6' | undefined =>
  a.primary && a.primary6 ? 'both' : a.primary ? 'v4' : a.primary6 ? 'v6' : undefined;
