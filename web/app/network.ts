// The page's network (docs/frontend.md "Network"): a machine with a network card (always there)
// (virtio-net on the Ethernet gateway, web/gateway.ts) whose IP packets go to a Tailscale
// client (web/tailscale.ts), which the user connects and logs in from the toolbar's Network
// menu, or to tailcat (web/tailcat.ts, the Rust tailnet client): through a tailcat server, letting
// tailcat clients in, or both. DOM-free, so it's tested in Node (tests/network.test.ts).
//
// The machine holds one end of an IP port for as long as it runs; this keeps the other. The
// client, when there is one, has it (`attach`); a restarted machine brings a new port, and
// a disconnected client hands it back (`detach`), so a machine can be connected, disconnected and
// connected again without a restart.
import { startTailscale, tailscaleBuilt, type FromTailscale, type NetMap, type Tailscale, type TailscaleConfig } from '../tailscale.ts';
import type { Reach6Options } from '../reach6.ts';
import { startLocal } from '../local-net.ts';
import { forgetTailcatIdentity, hasTailcatIdentity, parseRelay, parseTailcatAddr, startTailcat, tailcatBuilt, type TailcatConfig, type TailcatServe } from '../tailcat.ts';

export { tailscaleBuilt, tailcatBuilt, parseTailcatAddr, parseRelay, forgetTailcatIdentity, hasTailcatIdentity };

export const DEFAULT_CONTROL = 'https://controlplane.tailscale.com';

/** What the user chooses (remembered per browser, except the auth key, which is never kept). */
export type NetworkSettings = {
  /** Empty: Tailscale's. */
  controlURL: string;
  hostname: string;
  /** Connect when the machine starts (off after Disconnect, and for an auth key, which isn't kept). */
  autoconnect: boolean;
  /** The last connection used an auth key: an ephemeral node, not kept, so it can't reconnect by itself or log out. */
  keyed: boolean;
  /** The exit node in use (a peer's stable ID), applied again on the next connection; empty: none. */
  exitNode: string;
  /** What the menu connects to: a tailnet, or tailcat. */
  kind: 'tailscale' | 'tailcat';
  /** tailcat: online through a tailcat server (whose address, a secret, isn't kept), letting tailcat clients in (the
   * machine's own address is kept, in IndexedDB), and the relay for them without a server (empty: tailcat's public ones). */
  tailcatExit: boolean;
  tailcatServe: boolean;
  tailcatRelay: string;
};

export const DEFAULT_SETTINGS: NetworkSettings = { controlURL: '', hostname: '', autoconnect: false, keyed: false, exitNode: '', kind: 'tailscale', tailcatExit: true, tailcatServe: false, tailcatRelay: '' };

/** A control server's URL as the client takes it: https (http only for this computer), or an error to show. */
export function parseControlURL(input: string): { url: string } | { error: string } {
  const s = input.trim();
  if (!s) return { url: DEFAULT_CONTROL };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return { error: `“${s}” isn't a URL (for example https://headscale.example.com).` };
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { error: 'The control server must be an https:// URL (http:// works for this computer only).' };
  return { url: u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')) };
}

/** A node's hostname: one DNS label. Empty: `webpc`. */
export function parseHostname(input: string): { hostname: string } | { error: string } {
  const s = input.trim().toLowerCase();
  if (!s) return { hostname: 'webpc' };
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(s)) return { error: 'The hostname is letters, digits and hyphens (63 at most), not starting or ending with a hyphen.' };
  return { hostname: s };
}

export type Phase =
  /** No client. */
  | 'off'
  /** Loading the client, or waiting for the control server. */
  | 'connecting'
  /** The user has something to do: open the login link, or an admin has to approve the machine. */
  | 'login'
  | 'connected'
  | 'error';

export type NetworkView = {
  phase: Phase;
  /** One line for the menu. */
  text: string;
  /** Where to log in (only http(s) URLs). */
  loginURL?: string;
  /** The guest's IPv4 address, when connected. */
  address?: string;
  /** The peers that offer to be the exit node (approved by the tailnet's admin), when connected; `use` marks the one in use. */
  exitNodes: { id: string; name: string; online: boolean; use: boolean }[];
  /** The machine's own tailcat address, when it lets tailcat clients in. */
  served?: string;
  /** The subnets the tailnet's peers route (when any do), and whether they're installed. */
  subnets?: { routes: string[]; on: boolean };
  /** Connected, and it reaches the internet (a tailnet's exit node in use, tailcat through a server, the local helper): it can be the guest's default way out. */
  internet?: boolean;
  /** The local helper's: its lease always routes everything through it, so it is the primary first (`primaryOf`). */
  local?: boolean;
};

/**
 * Which of a machine's adapters is the guest's default way out (docs/network-adapters.md §4): the first connected
 * local helper's; else the first, in order, that is connected and reaches the internet; without one, the first connected (so a machine with one adapter
 * keeps its default route, as it always had); -1 when none is connected.
 */
export function primaryOf(views: Pick<NetworkView, 'phase' | 'internet' | 'local'>[]): number {
  // A local helper's lease always carries a default route (its DHCP, not the page's): it goes first, so a tailnet or
  // tailcat adapter beside it is the one given only its routes (docs/network-adapters.md §4).
  const local = views.findIndex((v) => v.phase === 'connected' && v.local);
  if (local >= 0) return local;
  const net = views.findIndex((v) => v.phase === 'connected' && v.internet);
  return net >= 0 ? net : views.findIndex((v) => v.phase === 'connected');
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
export type ClientReport = { state: string; netmap?: NetMap; loginURL?: string; error?: string; tailcat?: boolean; local?: boolean };

const web = (s: string | undefined) => {
  try {
    const u = new URL(s ?? '');
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
};

/** The menu's view of a client's report (`undefined`: there's no client). */
export function viewOf(c: ClientReport | undefined): NetworkView {
  if (!c) return { phase: 'off', text: 'Not connected', exitNodes: [] };
  if (c.error) return { phase: 'error', text: `Couldn't connect: ${c.error.split('\n')[0]}`, exitNodes: [] };
  const loginURL = web(c.loginURL);
  if (c.local) {
    if (c.state !== 'Running') return { phase: 'connecting', text: 'Connecting to the helper on this computer…', exitNodes: [] };
    const address = c.netmap?.addresses[0]?.replace(/\/\d+$/, '');
    return { phase: 'connected', address, exitNodes: [], internet: true, local: true, text: `Connected through this computer${address ? ` (${address})` : ''}` };
  }
  if (c.netmap?.via === 'tailcat' || c.tailcat) {
    if (c.state === 'Running' && c.netmap) {
      const served = c.netmap.serving ? { served: c.netmap.serving } : {};
      if (c.netmap.tailcatExit === false) return { phase: 'connected', exitNodes: [], text: 'Letting tailcat clients in', internet: false, ...served };
      const address = c.netmap.addresses.find((a) => !a.includes(':'))?.replace(/\/\d+$/, '');
      return { phase: 'connected', address, exitNodes: [], internet: true, text: `Connected through the tailcat server${address ? ` (${address})` : ''}${c.netmap.serving ? ', letting tailcat clients in' : ''}`, ...served };
    }
    const doing: Record<string, string> = { FetchingMap: 'Looking up the relay…', Meowing: 'Waiting for the tailcat server…', Handshaking: 'Opening the tunnel…' };
    return { phase: 'connecting', text: doing[c.state] ?? (c.state === '' ? 'Loading the client…' : 'Connecting to the relay…'), exitNodes: [] };
  }
  switch (c.state) {
    case 'Running': {
      const address = c.netmap?.addresses.find((a) => !a.includes(':'))?.replace(/\/\d+$/, '');
      const peers = c.netmap?.peers.length ?? 0;
      const exitNodes = (c.netmap?.peers ?? []).filter((p) => p.exitNodeOption || p.id === c.netmap?.exitNode).map((p) => ({ id: p.id, name: p.name.replace(/\.$/, ''), online: p.online !== false, use: p.id === c.netmap?.exitNode }));
      const via = exitNodes.find((e) => e.use);
      const routes = [...new Set((c.netmap?.peers ?? []).flatMap((p) => p.routes ?? []))];
      const subnets = routes.length ? { subnets: { routes, on: c.netmap?.acceptRoutes !== false } } : {};
      return { phase: 'connected', address, exitNodes, internet: !!via, ...subnets, text: `Connected${c.netmap?.name ? ` as ${c.netmap.name.replace(/\.$/, '')}` : ''}${address ? ` (${address})` : ''}, ${peers} peer${peers === 1 ? '' : 's'}${via ? `, internet through ${via.name}` : ''}` };
    }
    case 'NeedsLogin':
      return loginURL ? { phase: 'login', text: 'Log in to connect', loginURL, exitNodes: [] } : { phase: 'connecting', text: 'Contacting the control server…', exitNodes: [] };
    case 'NeedsMachineAuth':
      return { phase: 'login', text: 'Waiting for an administrator to approve this machine', loginURL, exitNodes: [] };
    case 'Stopped':
      return { phase: 'off', text: 'Stopped', exitNodes: [] };
    default:
      return { phase: 'connecting', text: c.state === '' ? 'Loading the client…' : 'Connecting…', exitNodes: [] };
  }
}

/**
 * A tailnet (`controlURL`, …), or tailcat: through a server when `tailcat` (its address) is given, letting clients in with
 * `tailcatServe` (`probe6`: how the server's or the exit node's IPv6 reach is checked, web/reach6.ts). `persist`: the tailnet node's profile in `webpc-tailscale` (web/tailscale-state.ts), so it is kept and
 * comes back without a login; none: an ephemeral node (a connection kept nowhere, web/app/connections.ts). `local`: the
 * local helper's link (`ws://127.0.0.1:<port>/<token>`, web/local-net.ts), the card's frames to it.
 */
export type Connect = { controlURL: string; hostname: string; authKey?: string; exitNode?: string; acceptRoutes?: boolean; persist?: string; tailcat?: string; tailcatServe?: TailcatServe; probe6?: Reach6Options; local?: string };

export type Network = {
  /** A new machine's end of the IP port (its device's `{ip: port}`; transfer it). Any client gets the other end. */
  port(): MessagePort;
  /** Starts the client on the machine's port (a machine with a card must have started). Throws if there's none. */
  connect(c: Connect): void;
  /** Stops the client and takes the port back; the machine keeps its card (and the address it was given). */
  disconnect(): Promise<void>;
  /** Sends the machine's internet traffic through the peer with this stable ID (see `view().exitNodes`), or with '' directly; rejects with the client's reason. Needs a client. */
  setExitNode(id: string): Promise<void>;
  /** Installs the tailnet's peers' subnet routes, or stops (`view().subnets` follows). */
  setAcceptRoutes(on: boolean): void;
  /** Logs the node out of its tailnet and forgets it, then disconnects. */
  logout(): Promise<void>;
  view(): NetworkView;
  /** Whether a client runs. */
  active(): boolean;
  /** Whether this adapter is the guest's default way out (`primaryOf`), and its `rank` (`ranksOf`; default 0), kept across clients; true and 0 until told otherwise. */
  setPrimary(primary: boolean, rank?: number): void;
};

/** How long a kept node has to reach its control server to be logged out. */
const LOGOUT_MS = 15_000;

/**
 * Logs a kept node out with no machine: a client of its own on a port no guest has, which reaches the control server
 * with the node's keys, expires them there and forgets them (docs/network-adapters.md §2.1). False when the control
 * server didn't answer in `ms`, with the node left as it was: a client logging out unconnected would only forget it here.
 */
export function logOutNode(c: Connect, start: (config: TailscaleConfig, onEvent: (m: FromTailscale) => void) => Tailscale = startTailscale, ms = LOGOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    const done = (ok: boolean) => {
      clearTimeout(timer);
      port2.close();
      client?.close();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), ms);
    let leaving = false;
    let client: Tailscale | undefined;
    const onEvent = (m: FromTailscale) => {
      if (leaving || !client) return;
      if (m.type === 'error') return done(false);
      const s = client.state();
      // NeedsLogin is also where it starts: the control server has answered once it gives a login link.
      if (s === 'Running' || s === 'NeedsMachineAuth' || (s === 'NeedsLogin' && client.loginURL())) {
        leaving = true;
        void client.logout().then(() => done(true), () => done(false));
      }
    };
    client = start({ controlURL: c.controlURL, hostname: c.hostname, ip: port1, persist: c.persist }, onEvent);
    client.running.catch(() => { if (!leaving) done(false); });
  });
}

export function createNetwork(
  onChange: () => void,
  start: (config: TailscaleConfig, onEvent: (m: FromTailscale) => void) => Tailscale = startTailscale,
  startCat: (config: TailcatConfig, onEvent: (m: FromTailscale) => void) => Tailscale = startTailcat,
  startHelper: (config: { url: string; ip: MessagePort }, onEvent: (m: FromTailscale) => void) => Tailscale = startLocal,
): Network {
  /** The page's end of the machine's port, while no client has it. */
  let free: MessagePort | undefined;
  let client: Tailscale | undefined;
  /** How many ports machines have brought. */
  let ports = 0;
  let error: string | undefined;
  let tailcat = false;
  let local = false;
  /** The card is on frames (a local client had it last): an IP client brings the page's gateway back first. */
  let onFrames = false;
  let primary = true;
  let rank = 0;

  const report = (): ClientReport | undefined => (client ? { state: client.state(), netmap: client.netmap(), loginURL: client.loginURL(), error, tailcat, local } : undefined);

  async function disconnect() {
    const t = client;
    if (!t) return;
    client = undefined;
    error = undefined;
    // A machine that started meanwhile has brought a new port: the old one is done with.
    const was = ports;
    const back = await t.detach();
    if (ports !== was) back?.close();
    else free = back;
    t.close();
    onChange();
  }

  return {
    port() {
      ports++;
      const { port1, port2 } = new MessageChannel();
      if (client) client.attach(port1);
      else {
        free?.close();
        free = port1;
        onFrames = false; // a new machine's card starts on the gateway
      }
      return port2;
    },
    connect(c) {
      if (client) return;
      if (!free) throw new Error('the machine hasn\'t started, so its network card isn\'t there yet: start it first');
      error = undefined;
      const ip = free;
      free = undefined;
      const onEvent = (m: FromTailscale) => {
        if (m.type === 'error') error = m.error;
        else if (m.type === 'state' && m.state === 'Running') error = undefined;
        onChange();
      };
      tailcat = !!(c.tailcat || c.tailcatServe);
      local = !!c.local;
      if (onFrames && !local) ip.postMessage({ type: 'gateway' });
      onFrames = local;
      const t = local
        ? startHelper({ url: c.local!, ip }, onEvent)
        : tailcat
        ? startCat({ addr: c.tailcat ?? '', serve: c.tailcatServe, probe6: c.probe6, ip }, onEvent)
        : start({ controlURL: c.controlURL, authKey: c.authKey || undefined, hostname: c.hostname, exitNode: c.exitNode || undefined, acceptRoutes: c.acceptRoutes, ip, persist: c.persist, probe6: c.probe6 }, onEvent);
      client = t;
      if (!primary || rank) t.setPrimary(primary, rank);
      t.running.catch((e) => { error = String(e?.message ?? e); onChange(); });
      onChange();
    },
    disconnect,
    async setExitNode(id) {
      if (!client) throw new Error('not connected');
      await client.setExitNode(id);
    },
    setAcceptRoutes(on) {
      client?.setAcceptRoutes(on);
    },
    async logout() {
      await client?.logout();
      await disconnect();
    },
    view: () => viewOf(report()),
    active: () => !!client,
    setPrimary(p, r = 0) {
      if (p === primary && r === rank) return;
      primary = p;
      rank = r;
      client?.setPrimary(p, r);
    },
  };
}
