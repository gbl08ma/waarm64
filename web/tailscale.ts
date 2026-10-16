// The Tailscale backend from the page's side (docs/plans/networking.md §4):
// starts the Go wasm client in its own worker (web/tailscale-worker.ts) and
// hands back the end of an IP-packet port for virtio-net's gateway
// (`{type: 'net', adapter: {ip: port}}`, web/gateway.ts `portBackend`). The
// worker sends `{type: 'lease', lease}` on that port whenever the node's address
// changes, so the guest's DHCP gets the address the client reports.
import type { Lease } from './gateway.ts';

/** What net/tailscale/main_js.go reports of the node's network map. */
export type NetMap = {
  name: string;
  addresses: string[];
  peers: { id: string; name: string; addresses: string[]; online?: boolean; exitNodeOption: boolean }[];
  mtu: number;
  dns: string[] | null;
  domains: string[] | null;
  /** The stable ID of the peer in use as the exit node, or ''. */
  exitNode: string;
  /** Not a tailnet: the guest's network goes through a tailcat server (web/tailcat.ts). */
  via?: 'tailcat';
  /** tailcat: whether an exit node carries the guest's traffic, and the machine's own address when it lets clients in. */
  tailcatExit?: boolean;
  serving?: string;
};

export type TailscaleConfig = {
  controlURL: string;
  authKey?: string;
  hostname?: string;
  /** A peer's stable ID (an `exitNodeOption` of the netmap): send the guest's internet traffic through it from the start. */
  exitNode?: string;
  /** Where target/net/tailscale.wasm and wasm_exec.js are served from (default: this checkout's target/net). */
  wasm?: string;
  wasmExec?: string;
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
};

/** Messages to the worker. */
export type ToTailscale =
  | { type: 'start'; wasm: string; wasmExec: string; controlURL: string; authKey?: string; hostname?: string; exitNode?: string; ip: MessagePort; persist?: string }
  /** A new gateway port (the machine restarted): the client's packets and the lease go to it. */
  | { type: 'attach'; ip: MessagePort }
  /** Withdraw the lease and hand the gateway's port back (`detached`). */
  | { type: 'detach' }
  /** Use the peer with this stable ID as the exit node ('': none); answered by `exitnode`. */
  | { type: 'exitnode'; id: string }
  /** Log the node out of the tailnet and forget its saved state. */
  | { type: 'logout' };

/** Messages from the worker. */
export type FromTailscale =
  | { type: 'state'; state: string }
  | { type: 'netmap'; netmap: NetMap }
  | { type: 'login'; url: string }
  | { type: 'loaded'; ms: number }
  | { type: 'detached'; ip?: MessagePort }
  /** The answer to `exitnode`: '' when it took, else the client's reason. */
  | { type: 'exitnode'; error: string }
  | { type: 'loggedout' }
  | { type: 'error'; error: string };

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
  /** Withdraws the lease and takes the gateway's port back, for the next client (or machine); undefined if the worker doesn't answer. */
  detach(): Promise<MessagePort | undefined>;
  /** Sends the internet traffic through the peer with this stable ID (a netmap peer with `exitNodeOption`), or with '' stops; rejects with the client's reason. */
  setExitNode(id: string): Promise<void>;
  /** Logs the node out of the tailnet (its control server forgets it) and deletes its saved state; resolves once that's done (at most ~8 s). */
  logout(): Promise<void>;
  close(): void;
};

/** Whether the server has the client (target/net/tailscale.wasm): the page says so before it restarts a machine for a card. */
export const tailscaleBuilt = (wasm = new URL('../target/net/tailscale.wasm', import.meta.url).href) =>
  fetch(wasm, { method: 'HEAD' }).then((r) => r.ok, () => false);

export function startTailscale(config: TailscaleConfig, onEvent: (m: FromTailscale) => void = () => {}): Tailscale {
  const worker = new Worker(new URL('./tailscale-worker.ts', import.meta.url), { type: 'module' });
  const own = config.ip ? undefined : new MessageChannel();
  const port1 = config.ip ?? own!.port1;
  let detached: ((ip?: MessagePort) => void) | undefined;
  let loggedOut: (() => void) | undefined;
  let exitDone: ((error: string) => void) | undefined;
  const base = new URL('../target/net/', import.meta.url);
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
      else if (m.type === 'error') reject(new Error(m.error));
      onEvent(m);
    };
  });
  running.catch(() => {}); // the caller decides whether to look
  worker.postMessage(
    { type: 'start', wasm: config.wasm ?? new URL('tailscale.wasm', base).href, wasmExec: config.wasmExec ?? new URL('wasm_exec.js', base).href, controlURL: config.controlURL, authKey: config.authKey, hostname: config.hostname, exitNode: config.exitNode, ip: port1, persist: config.persist } satisfies ToTailscale,
    [port1],
  );
  return {
    ip: own?.port2, state: () => state, netmap: () => netmap, loginURL: () => loginURL, running, timings: () => timings,
    attach: (ip) => worker.postMessage({ type: 'attach', ip } satisfies ToTailscale, [ip]),
    detach: () => new Promise((resolve) => {
      const t = setTimeout(() => resolve(undefined), 3000);
      detached = (ip) => { clearTimeout(t); resolve(ip); };
      worker.postMessage({ type: 'detach' } satisfies ToTailscale);
    }),
    setExitNode: (id) => new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the client did not answer')), 10_000);
      exitDone = (error) => { clearTimeout(t); error ? reject(new Error(error)) : resolve(); };
      worker.postMessage({ type: 'exitnode', id } satisfies ToTailscale);
    }),
    logout: () => new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 8000);
      loggedOut = () => { clearTimeout(t); resolve(); };
      worker.postMessage({ type: 'logout' } satisfies ToTailscale);
    }),
    close: () => worker.terminate(),
  };
}
