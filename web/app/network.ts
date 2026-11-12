// The page's network (docs/frontend.md "Network"): a machine with a network card (always there)
// (virtio-net on the Ethernet gateway, web/gateway.ts) whose IP packets go to a Tailscale
// client (web/tailscale.ts), which the user connects and logs in from the toolbar's Network
// menu, or to tailcat (web/tailcat.ts, the Rust tailnet client): through a tailcat server, letting
// tailcat clients in, or both. DOM-free, so it's tested in Node (tests/network.test.ts); what the
// menu shows of it is web/app/network-view.ts's.
//
// The machine holds one end of an IP port for as long as it runs; this keeps the other. The
// client, when there is one, has it (`attach`); a restarted machine brings a new port, and
// a disconnected client hands it back (`detach`), so a machine can be connected, disconnected and
// connected again without a restart.
import { msg, type Msg } from '../i18n.ts';
import { MsgError } from '../msg.ts';
import { viewOf, type ClientReport, type NetworkView } from './network-view.ts';
import {
  startTailscale,
  tailscaleBuilt,
  type FromTailscale,
  type Tailscale,
  type TailscaleConfig,
} from '../tailscale.ts';
import type { Reach6Options } from '../reach6.ts';
import { startLocal } from '../local-net.ts';
import { startRoomNet, type RoomNetConfig } from '../room.ts';
import {
  forgetTailcatIdentity,
  hasTailcatIdentity,
  parseAllow,
  parseRelay,
  parseTailcatAddr,
  startTailcat,
  tailcatBuilt,
  type TailcatConfig,
  type TailcatIdentity,
  type TailcatServe,
} from '../tailcat.ts';

export {
  tailscaleBuilt,
  tailcatBuilt,
  parseTailcatAddr,
  parseRelay,
  parseAllow,
  forgetTailcatIdentity,
  hasTailcatIdentity,
};

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

export const DEFAULT_SETTINGS: NetworkSettings = {
  controlURL: '',
  hostname: '',
  autoconnect: false,
  keyed: false,
  exitNode: '',
  kind: 'tailscale',
  tailcatExit: true,
  tailcatServe: false,
  tailcatRelay: '',
};

/** A control server's URL as the client takes it: https (http only for this computer), or an error to show. */
export function parseControlURL(input: string): { url: string } | { error: Msg } {
  const s = input.trim();
  if (!s) return { url: DEFAULT_CONTROL };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return { error: msg('network:network.notURL', { input: s }) };
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { error: msg('network:network.notHttps') };
  return { url: u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')) };
}

/** A node's hostname: one DNS label. Empty: `webpc`. */
export function parseHostname(input: string): { hostname: string } | { error: Msg } {
  const s = input.trim().toLowerCase();
  if (!s) return { hostname: 'webpc' };
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(s)) return { error: msg('network:network.badHostname') };
  return { hostname: s };
}

/**
 * A tailnet (`controlURL`, …), or tailcat: through a server when `tailcat` (its address) is given, letting clients in with
 * `tailcatServe`, as the node `tailcatIdentity` names (web/tailcat.ts `identityKey`, `identity`) (`probe6`: how the server's or the exit node's IPv6 reach is checked, web/reach6.ts). `persist`: the tailnet node's profile in `webpc-tailscale` (web/tailscale-state.ts), so it is kept and
 * comes back without a login; none: an ephemeral node (a connection kept nowhere, web/app/connections.ts). `local`: the
 * local helper's link (`ws://127.0.0.1:<port>/<token>`, web/local-net.ts), the card's frames to it. `room`: a peer-to-peer
 * room (web/room.ts), its link, switches and kept identity.
 */
export type Connect = {
  controlURL: string;
  hostname: string;
  authKey?: string;
  exitNode?: string;
  acceptRoutes?: boolean;
  persist?: string;
  tailcat?: string;
  tailcatServe?: TailcatServe;
  tailcatIdentity?: { identityKey?: string; identity?: TailcatIdentity };
  probe6?: Reach6Options;
  local?: string;
  room?: Omit<RoomNetConfig, 'ip'>;
};

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
 * with the node's keys, expires them there and forgets them (docs/networking/adapters.md §2.1). False when the control
 * server didn't answer in `ms`, with the node left as it was: a client logging out unconnected would only forget it here.
 */
export function logOutNode(
  c: Connect,
  start: (config: TailscaleConfig, onEvent: (m: FromTailscale) => void) => Tailscale = startTailscale,
  ms = LOGOUT_MS,
): Promise<boolean> {
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
    // eslint-disable-next-line prefer-const -- read by onEvent, which `start` may call before it returns
    let client: Tailscale | undefined;
    const onEvent = (m: FromTailscale) => {
      if (leaving || !client) return;
      if (m.type === 'error') return done(false);
      const s = client.state();
      // NeedsLogin is also where it starts: the control server has answered once it gives a login link.
      if (s === 'Running' || s === 'NeedsMachineAuth' || (s === 'NeedsLogin' && client.loginURL())) {
        leaving = true;
        void client.logout().then(
          () => done(true),
          () => done(false),
        );
      }
    };
    client = start({ controlURL: c.controlURL, hostname: c.hostname, ip: port1, persist: c.persist }, onEvent);
    client.running.catch(() => {
      if (!leaving) done(false);
    });
  });
}

type OnEvent = (m: FromTailscale) => void;
/** What starts each kind of client (the tests pass their own). */
type Starters = {
  start: (config: TailscaleConfig, onEvent: OnEvent) => Tailscale;
  startCat: (config: TailcatConfig, onEvent: OnEvent) => Tailscale;
  startHelper: (config: { url: string; ip: MessagePort }, onEvent: OnEvent) => Tailscale;
  startRoom: (config: RoomNetConfig, onEvent: OnEvent) => Tailscale;
};

/** What kind of client `c` asks for: a room's, tailcat's (through a server, or letting clients in) or the local helper's. */
function kindOf(c: Connect) {
  const room = !!c.room;
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- no server ('') is none
  const tailcat = !room && !!(c.tailcat || c.tailcatServe);
  return { room, tailcat, local: !!c.local };
}

/** The client `c` asks for on the machine's port `ip`: the local helper's, a room's, tailcat's or a tailnet's. */
function startClient(c: Connect, ip: MessagePort, tailcat: boolean, onEvent: OnEvent, s: Starters): Tailscale {
  if (c.local) return s.startHelper({ url: c.local, ip }, onEvent);
  if (c.room) return s.startRoom({ ...c.room, ip }, onEvent);
  if (tailcat)
    return s.startCat(
      { addr: c.tailcat ?? '', serve: c.tailcatServe, ...c.tailcatIdentity, probe6: c.probe6, ip },
      onEvent,
    );
  return s.start(
    {
      controlURL: c.controlURL,
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty auth key is none
      authKey: c.authKey || undefined,
      hostname: c.hostname,
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- no exit node ('') is none
      exitNode: c.exitNode || undefined,
      acceptRoutes: c.acceptRoutes,
      ip,
      persist: c.persist,
      probe6: c.probe6,
    },
    onEvent,
  );
}

/** A network's state: the machine's port, its client and what kind it is. */
type State = {
  onChange: () => void;
  starters: Starters;
  /** The page's end of the machine's port, while no client has it. */
  free?: MessagePort;
  client?: Tailscale;
  /** How many ports machines have brought. */
  ports: number;
  error?: unknown;
  kind: { room: boolean; tailcat: boolean; local: boolean };
  /** The card is on frames (a local client had it last): an IP client brings the page's gateway back first. */
  onFrames: boolean;
  primary: boolean;
  rank: number;
};

/** A new machine's end of the IP port: the client gets the other, or the page keeps it until one connects. */
function newPort(s: State) {
  s.ports++;
  const { port1, port2 } = new MessageChannel();
  if (s.client) s.client.attach(port1);
  else {
    s.free?.close();
    s.free = port1;
    s.onFrames = false; // a new machine's card starts on the gateway
  }
  return port2;
}

/** Starts the client `c` asks for on the machine's port. */
function connect(s: State, c: Connect) {
  if (s.client) return;
  if (!s.free) throw new MsgError('network:network.notStarted');
  s.error = undefined;
  const ip = s.free;
  s.free = undefined;
  s.kind = kindOf(c);
  if (s.onFrames && !s.kind.local) ip.postMessage({ type: 'gateway' });
  s.onFrames = s.kind.local;
  const onEvent = (m: FromTailscale) => {
    if (m.type === 'error') s.error = m.error;
    else if (m.type === 'state' && m.state === 'Running') s.error = undefined;
    s.onChange();
  };
  const t = startClient(c, ip, s.kind.tailcat, onEvent, s.starters);
  s.client = t;
  if (!s.primary || s.rank) t.setPrimary(s.primary, s.rank);
  t.running.catch((e: unknown) => {
    s.error = e ?? new Error('failed');
    s.onChange();
  });
  s.onChange();
}

/** Stops the client and takes the port back. */
async function disconnect(s: State) {
  const t = s.client;
  if (!t) return;
  s.client = undefined;
  s.error = undefined;
  // A machine that started meanwhile has brought a new port: the old one is done with.
  const was = s.ports;
  const back = await t.detach();
  if (s.ports !== was) back?.close();
  else s.free = back;
  t.close();
  s.onChange();
}

/** What the client reports, for the view (`undefined`: there's no client). */
function report(s: State): ClientReport | undefined {
  const c = s.client;
  return c ? { state: c.state(), netmap: c.netmap(), loginURL: c.loginURL(), error: s.error, ...s.kind } : undefined;
}

export function createNetwork(
  onChange: () => void,
  start: Starters['start'] = startTailscale,
  startCat: Starters['startCat'] = startTailcat,
  startHelper: Starters['startHelper'] = startLocal,
  startRoom: Starters['startRoom'] = startRoomNet,
): Network {
  const s: State = {
    onChange,
    starters: { start, startCat, startHelper, startRoom },
    ports: 0,
    kind: { room: false, tailcat: false, local: false },
    onFrames: false,
    primary: true,
    rank: 0,
  };
  return {
    port: () => newPort(s),
    connect: (c) => connect(s, c),
    disconnect: () => disconnect(s),
    async setExitNode(id) {
      if (!s.client) throw new MsgError('network:network.noClient');
      await s.client.setExitNode(id);
    },
    setAcceptRoutes(on) {
      s.client?.setAcceptRoutes(on);
    },
    async logout() {
      await s.client?.logout();
      await disconnect(s);
    },
    view: () => viewOf(report(s)),
    active: () => !!s.client,
    setPrimary(p, r = 0) {
      if (p === s.primary && r === s.rank) return;
      s.primary = p;
      s.rank = r;
      s.client?.setPrimary(p, r);
    },
  };
}
