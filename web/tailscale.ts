// The Tailscale backend from the page's side (docs/plans/networking.md §4):
// starts the tailnet client (net/ts, docs/networking/tailnet.md) in its own worker (web/tailnet-worker.ts) and
// hands back the end of an IP-packet port for virtio-net's gateway
// (`{type: 'net', adapter: {ip: port}}`, web/gateway.ts `portBackend`). The
// worker sends `{type: 'lease', lease}` on that port whenever the node's address
// changes, so the guest's DHCP gets the address the client reports.
import type { Lease, Routes } from './gateway.ts';
import { fromWire, MsgError, type WireError } from './msg.ts';
import type { Reach6Options } from './reach6.ts';

/** What the client reports of the node's network map (net/ts/src/netmap.rs). */
export type NetMap = {
  name: string;
  addresses: string[];
  /** `routes`: the subnets a peer routes (approved by the tailnet's admin); `direct`: a room's, whether its packets take a
   * direct (WebRTC) path rather than the relay. */
  peers: { id: string; name: string; addresses: string[]; online?: boolean; exitNodeOption: boolean; routes?: string[]; direct?: boolean }[];
  /** Whether the peers' subnet routes are installed. */
  acceptRoutes?: boolean;
  mtu: number;
  dns: string[] | null;
  domains: string[] | null;
  /** The stable ID of the peer in use as the exit node, or ''. */
  exitNode: string;
  /** The worker's: whether the internet's IPv6 answers through the exit node or tailcat's server (web/reach6.ts), while one is in use. */
  reached6?: boolean;
  /** Not a tailnet: the guest's network goes through a tailcat server (web/tailcat.ts), the local helper (web/local-net.ts),
   * or a peer-to-peer room (web/room.ts, whose `peers` are the members reached). */
  via?: 'tailcat' | 'local' | 'room';
  /** tailcat: whether an exit node carries the guest's traffic, and the machine's own address when it lets clients in. */
  tailcatExit?: boolean;
  serving?: string;
  /** tailcat: the machine's node key (`nodekey:…`), the same at each connect for a kept connection, so a server can `--allow` it. */
  tailcatKey?: string;
  /** A room: the member's name to give out (`<key>.<room name>.p2p.internal`, or `<key>.<tag>.p2p.internal`: net/ts room.rs `Room::domain`), the room's link, and its switches;
   * `directBlocked`: this browser makes no direct paths (web/room.ts `RoomEvent`), so every member goes through the relay;
   * `directFailed`: how many members reached through the relay have a failed attempt behind them (gathering worked here:
   * something between the two is in the way); `peersBlocked`: how many said their browser makes none. */
  room?: {
    name: string; link: string; incoming: boolean; relayOnly: boolean; directBlocked?: boolean; directFailed?: number; peersBlocked?: number;
    /** The node key (64 hex digits): where a name registered on this machine points. */
    key?: string;
    /** The registry's line (names.md "What the user sees"): a server's names held and servers synced with
     * (`serving`), or a member's names resolved and servers held. */
    names?: { serving: boolean; names: number; servers: number };
  };
};

export type TailscaleConfig = {
  controlURL: string;
  authKey?: string;
  hostname?: string;
  /** A peer's stable ID (an `exitNodeOption` of the netmap): send the guest's internet traffic through it from the start. */
  exitNode?: string;
  /** Install peers' subnet routes (default: yes). */
  acceptRoutes?: boolean;
  /** Where the client's module is served from (default: this checkout's target/net/ts.wasm). */
  wasm?: string;
  /**
   * The gateway's end of the IP port, when the caller made the channel (the page: the machine
   * already holds the other end, and keeps it across restarts, `attach`). Transferred. Default:
   * a new channel, whose device end is `Tailscale.ip`.
   */
  ip?: MessagePort;
  /**
   * Keep the node's state (its keys) in this origin's IndexedDB under this name: a reload is the
   * same node, with the same address and no new login. Not for an auth key's ephemeral node.
   */
  persist?: string;
  /** How an exit node's IPv6 reach is checked (web/reach6.ts). */
  probe6?: Reach6Options;
};

/** Messages to the worker. */
export type ToTailscale =
  | { type: 'start'; wasm: string; controlURL: string; authKey?: string; hostname?: string; exitNode?: string; acceptRoutes?: boolean; ip: MessagePort; persist?: string; probe6?: Reach6Options }
  /** A new gateway port (the machine restarted): the client's packets and the lease go to it. */
  | { type: 'attach'; ip: MessagePort }
  /** Whether this adapter is the guest's default way out, or offers only its network's routes (docs/networking/adapters.md §4). */
  | { type: 'primary'; primary: boolean; rank?: number; primary6?: boolean }
  /** Withdraw the lease and hand the gateway's port back (`detached`). */
  | { type: 'detach' }
  /** Use the peer with this stable ID as the exit node ('': none); answered by `exitnode`. */
  | { type: 'exitnode'; id: string }
  /** Install peers' subnet routes, or stop; a `netmap` follows. */
  | { type: 'routes'; on: boolean }
  /** Log the node out of the tailnet and forget its saved state. */
  | { type: 'logout' };

/** Messages from the worker. */
export type FromTailscale =
  | { type: 'state'; state: string }
  | { type: 'netmap'; netmap: NetMap }
  | { type: 'login'; url: string }
  | { type: 'loaded'; ms: number }
  | { type: 'detached'; ip?: MessagePort }
  /** The answer to `exitnode`: no `error` when it took, else the client's reason (web/msg.ts `toWire`). */
  | { type: 'exitnode'; error?: WireError }
  | { type: 'loggedout' }
  /** The client failed: why, as web/msg.ts `toWire` posts it (`fromWire` takes it back). */
  | { type: 'error'; error: WireError };

const ip6 = (s: string) => {
  if (!s.includes(':') || !/^[0-9a-f:]+$/i.test(s)) return undefined;
  const [head, tail, extra] = s.split('::');
  if (extra !== undefined) return undefined;
  const groups = (h: string) => (h ? h.split(':') : []);
  const [a, b] = [groups(head), groups(tail ?? '')];
  if (tail === undefined ? a.length !== 8 : a.length + b.length > 7) return undefined;
  if (![...a, ...b].every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return undefined;
  const all = tail === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  const bytes = all.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 255]; });
  return bytes;
};

const ip4 = (s: string) => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  return m ? m.slice(1).map(Number) : undefined;
};

/**
 * The guest's lease from a network map: the node's first IPv4 address (taken from what the client
 * reports; no range is assumed) and its first IPv6 one, the client's MTU, its DNS resolvers that are
 * IP addresses (MagicDNS's service addresses first) and its search domains. Null while there's no IPv4 address.
 */
/** The subnets the netmap's peers route, when they're installed: what the lease routes besides the tailnet's own addresses. */
export function subnetsOf(nm: NetMap | undefined): Required<Pick<Routes, 'v4' | 'v6'>> {
  const out: Required<Pick<Routes, 'v4' | 'v6'>> = { v4: [], v6: [] };
  if (!nm?.acceptRoutes) return out;
  for (const r of nm.peers.flatMap((p) => p.routes ?? [])) {
    const [a, len] = r.split('/');
    const v4 = ip4(a);
    const v6 = v4 ? undefined : ip6(a);
    if (v4) out.v4.push([v4, Number(len)]);
    else if (v6) out.v6.push([v6, Number(len)]);
  }
  return out;
}

export function leaseFrom(nm: NetMap): Lease | null {
  const address = nm.addresses.map((a) => ip4(a.replace(/\/\d+$/, ''))).find((a) => a);
  if (!address) return null;
  const dns = (nm.dns ?? []).map(ip4).filter((a): a is number[] => !!a);
  const address6 = nm.addresses.map((a) => ip6(a.replace(/\/\d+$/, ''))).find((a) => a);
  const dns6 = (nm.dns ?? []).map(ip6).filter((a): a is number[] => !!a);
  return { address, ...(address6 ? { address6, dns6 } : {}), mtu: nm.mtu, dns, domains: nm.domains ?? [] };
}

export type Tailscale = {
  /** The device's end of the IP port: `{type: 'net', adapter: {ip: tailscale.ip}}` (transfer it). Absent when the config brought its own port. */
  ip?: MessagePort;
  /** The client's state (`NeedsLogin`, `Starting`, `Running`, …), '' before the first report. */
  state(): string;
  netmap(): NetMap | undefined;
  /** The URL to open to log in, when the client asks for one (no auth key). */
  loginURL(): string | undefined;
  /** Resolves with the network map when the client is `Running`; rejects if the worker fails. */
  running: Promise<NetMap>;
  /** Milliseconds from the start to `Running`, and the time to load the module. */
  timings(): { loadMs?: number; runningMs?: number };
  /** Hands the client a new gateway port (the machine restarted). */
  attach(ip: MessagePort): void;
  /** Makes the adapter the guest's default way out (the default), or only the way to its own network's addresses; `rank`: its
   * place among the machine's connected adapters (default 0), its IPv6 routes' preference (web/gateway.ts `ranked`);
   * `primary6` (default `primary`): IPv6's default way out, which can be another adapter (web/app/network-view.ts `primary6Of`). */
  setPrimary(primary: boolean, rank?: number, primary6?: boolean): void;
  /** Withdraws the lease and takes the gateway's port back, for the next client (or machine); undefined if the worker doesn't answer. */
  detach(): Promise<MessagePort | undefined>;
  /** Sends the internet traffic through the peer with this stable ID (a netmap peer with `exitNodeOption`), or with '' stops; rejects with the client's reason. */
  setExitNode(id: string): Promise<void>;
  /** Installs peers' subnet routes, or stops (the netmap that follows says which). */
  setAcceptRoutes(on: boolean): void;
  /** Logs the node out of the tailnet (its control server forgets it) and deletes its saved state; resolves once that's done (at most ~8 s). */
  logout(): Promise<void>;
  close(): void;
};

/** Whether the server has the client (target/net/ts.wasm): the page says so before it restarts a machine for a card. */
export const tailscaleBuilt = (wasm = new URL('../target/net/ts.wasm', import.meta.url).href) =>
  fetch(wasm, { method: 'HEAD' }).then((r) => r.ok, () => false);

export function startTailscale(config: TailscaleConfig, onEvent: (m: FromTailscale) => void = () => {}): Tailscale {
  const worker = new Worker(new URL('./tailnet-worker.ts', import.meta.url), { type: 'module' });
  const own = config.ip ? undefined : new MessageChannel();
  const port1 = config.ip ?? own!.port1;
  let detached: ((ip?: MessagePort) => void) | undefined;
  let loggedOut: (() => void) | undefined;
  let exitDone: ((error?: WireError) => void) | undefined;
  let state = '';
  let netmap: NetMap | undefined;
  let loginURL: string | undefined;
  const t0 = performance.now();
  const timings: { loadMs?: number; runningMs?: number } = {};
  const running = new Promise<NetMap>((resolve, reject) => {
    worker.onerror = (e) => reject(new Error(e.message));
    worker.onmessage = (e: MessageEvent<FromTailscale>) => {
      const m = e.data;
      if (m.type === 'state') {
        state = m.state;
        if (state === 'Running' && netmap) { timings.runningMs = performance.now() - t0; resolve(netmap); }
      } else if (m.type === 'netmap') {
        netmap = m.netmap;
        if (state === 'Running' && timings.runningMs === undefined) { timings.runningMs = performance.now() - t0; resolve(netmap); }
      } else if (m.type === 'login') loginURL = m.url;
      else if (m.type === 'loaded') timings.loadMs = m.ms;
      else if (m.type === 'detached') detached?.(m.ip);
      else if (m.type === 'exitnode') exitDone?.(m.error);
      else if (m.type === 'loggedout') loggedOut?.();
      else if (m.type === 'error') reject(fromWire(m.error));
      onEvent(m);
    };
  });
  running.catch(() => {}); // the caller decides whether to look
  worker.postMessage(
    { type: 'start', wasm: config.wasm ?? new URL('../target/net/ts.wasm', import.meta.url).href, controlURL: config.controlURL, authKey: config.authKey, hostname: config.hostname, exitNode: config.exitNode, acceptRoutes: config.acceptRoutes, ip: port1, persist: config.persist, probe6: config.probe6 } satisfies ToTailscale,
    [port1],
  );
  return {
    ip: own?.port2, state: () => state, netmap: () => netmap, loginURL: () => loginURL, running, timings: () => timings,
    attach: (ip) => worker.postMessage({ type: 'attach', ip } satisfies ToTailscale, [ip]),
    setPrimary: (primary, rank, primary6) => worker.postMessage({ type: 'primary', primary, rank, primary6 } satisfies ToTailscale),
    detach: () => new Promise((resolve) => {
      const t = setTimeout(() => resolve(undefined), 3000);
      detached = (ip) => { clearTimeout(t); resolve(ip); };
      worker.postMessage({ type: 'detach' } satisfies ToTailscale);
    }),
    setExitNode: (id) => new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new MsgError('network:tailscale.noAnswer')), 10_000);
      exitDone = (error) => { clearTimeout(t); error ? reject(fromWire(error)) : resolve(); };
      worker.postMessage({ type: 'exitnode', id } satisfies ToTailscale);
    }),
    setAcceptRoutes: (on) => worker.postMessage({ type: 'routes', on } satisfies ToTailscale),
    logout: () => new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 8000);
      loggedOut = () => { clearTimeout(t); resolve(); };
      worker.postMessage({ type: 'logout' } satisfies ToTailscale);
    }),
    close: () => worker.terminate(),
  };
}
