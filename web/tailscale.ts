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
  peers: { name: string; addresses: string[]; online?: boolean; exitNodeOption: boolean }[];
  mtu: number;
  dns: string[] | null;
  domains: string[] | null;
};

export type TailscaleConfig = {
  controlURL: string;
  authKey?: string;
  hostname?: string;
  /** Where target/net/tailscale.wasm and wasm_exec.js are served from (default: this checkout's target/net). */
  wasm?: string;
  wasmExec?: string;
};

/** Messages from the worker. */
export type FromTailscale =
  | { type: 'state'; state: string }
  | { type: 'netmap'; netmap: NetMap }
  | { type: 'login'; url: string }
  | { type: 'loaded'; ms: number }
  | { type: 'error'; error: string };

const ip4 = (s: string) => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  return m ? m.slice(1).map(Number) : undefined;
};

/**
 * The guest's lease from a network map: the node's first IPv4 address (taken from what the client
 * reports; no range is assumed), the client's MTU, its DNS resolvers that are IPv4 addresses
 * (MagicDNS's service address first) and its search domains. Null while there's no IPv4 address.
 */
export function leaseFrom(nm: NetMap): Lease | null {
  const address = nm.addresses.map((a) => ip4(a.replace(/\/\d+$/, ''))).find((a) => a);
  if (!address) return null;
  const dns = (nm.dns ?? []).map(ip4).filter((a): a is number[] => !!a);
  return { address, mtu: nm.mtu, dns, domains: nm.domains ?? [] };
}

export type Tailscale = {
  /** The device's end of the IP port: `{type: 'net', adapter: {ip: tailscale.ip}}` (transfer it). */
  ip: MessagePort;
  /** The client's state (`NeedsLogin`, `Starting`, `Running`, …), '' before the first report. */
  state(): string;
  netmap(): NetMap | undefined;
  /** The URL to open to log in, when the client asks for one (no auth key). */
  loginURL(): string | undefined;
  /** Resolves with the network map when the client is `Running`; rejects if the worker fails. */
  running: Promise<NetMap>;
  /** Milliseconds from the start to `Running`, and the time to load the module. */
  timings(): { loadMs?: number; runningMs?: number };
  close(): void;
};

export function startTailscale(config: TailscaleConfig, onEvent: (m: FromTailscale) => void = () => {}): Tailscale {
  const worker = new Worker(new URL('./tailscale-worker.ts', import.meta.url), { type: 'module' });
  const { port1, port2 } = new MessageChannel();
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
      else if (m.type === 'error') reject(new Error(m.error));
      onEvent(m);
    };
  });
  running.catch(() => {}); // the caller decides whether to look
  worker.postMessage(
    { type: 'start', wasm: config.wasm ?? new URL('tailscale.wasm', base).href, wasmExec: config.wasmExec ?? new URL('wasm_exec.js', base).href, controlURL: config.controlURL, authKey: config.authKey, hostname: config.hostname, ip: port1 },
    [port1],
  );
  return { ip: port2, state: () => state, netmap: () => netmap, loginURL: () => loginURL, running, timings: () => timings, close: () => worker.terminate() };
}
