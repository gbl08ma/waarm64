// The tailcat backend from the page's side (docs/plans/tailnet-client.md §4):
// the guest's network through a tailcat server (`tailcat serve exit-node` on a
// computer of the user's) instead of a tailnet, by the Rust tailnet client
// (net/ts) in its own worker (web/tailcat-worker.ts). The handle is the Go
// Tailscale client's (`Tailscale`, web/tailscale.ts), so the page's network
// controller drives either; what a tailcat server doesn't have (exit nodes,
// logging out) is refused.
import type { Lease } from './gateway.ts';
import type { FromTailscale, NetMap, Tailscale } from './tailscale.ts';

export type TailcatConfig = {
  /** The `tc…` address the server printed: a secret (it lets anyone who has it in). */
  addr: string;
  /** The DERP map for an address that names only a region (default: tailcat's public map). */
  derpMapURL?: string;
  /** Where target/net/ts.wasm is served from (default: this checkout's target/net). */
  wasm?: string;
  /** The gateway's end of the IP port (transferred); default: a new channel, whose device end is `ip`. */
  ip?: MessagePort;
};

/** Messages to the worker. */
export type ToTailcat =
  | { type: 'start'; wasm: string; addr: string; derpMapURL?: string; ip: MessagePort }
  | { type: 'attach'; ip: MessagePort }
  | { type: 'detach' };

/** A tailcat address as typed or pasted: `tc` and base64url, or an error to show. The module checks the rest. */
export function parseTailcatAddr(input: string): { addr: string } | { error: string } {
  const s = input.trim();
  if (!s) return { error: 'Paste the address `tailcat serve exit-node` printed (it starts with “tc”).' };
  if (!/^tc[A-Za-z0-9_-]{40,}$/.test(s)) return { error: 'That isn\'t a tailcat address: it starts with “tc” and is letters, digits, “-” and “_”, ~140 of them.' };
  return { addr: s };
}

const v6text = (b: number[]) => {
  const groups = Array.from({ length: 8 }, (_, k) => ((b[2 * k] << 8) | b[2 * k + 1]).toString(16));
  // The longest run of two or more zero groups becomes '::' (RFC 5952).
  let best = [-1, 0];
  for (let k = 0; k < 8;) {
    let n = 0;
    while (k + n < 8 && groups[k + n] === '0') n++;
    if (n > best[1] && n > 1) best = [k, n];
    k += n || 1;
  }
  if (best[0] < 0) return groups.join(':');
  return `${groups.slice(0, best[0]).join(':')}::${groups.slice(best[0] + best[1]).join(':')}`;
};

/** What the menu shows of a tailcat connection: the guest's addresses and resolvers, no peers. */
export function netmapOf(lease: Lease): NetMap {
  return {
    name: '', via: 'tailcat', peers: [], mtu: lease.mtu, exitNode: '', domains: [],
    addresses: [`${lease.address.join('.')}/32`, ...(lease.address6 ? [`${v6text(lease.address6)}/128`] : [])],
    dns: [...lease.dns.map((d) => d.join('.')), ...(lease.dns6 ?? []).map(v6text)],
  };
}

/** Whether the server has the client (target/net/ts.wasm). */
export const tailcatBuilt = (wasm = new URL('../target/net/ts.wasm', import.meta.url).href) =>
  fetch(wasm, { method: 'HEAD' }).then((r) => r.ok, () => false);

export function startTailcat(config: TailcatConfig, onEvent: (m: FromTailscale) => void = () => {}): Tailscale {
  const worker = new Worker(new URL('./tailcat-worker.ts', import.meta.url), { type: 'module' });
  const own = config.ip ? undefined : new MessageChannel();
  const port1 = config.ip ?? own!.port1;
  let detached: ((ip?: MessagePort) => void) | undefined;
  let state = '';
  let netmap: NetMap | undefined;
  const t0 = performance.now();
  const timings: { loadMs?: number; runningMs?: number } = {};
  const running = new Promise<NetMap>((resolve, reject) => {
    worker.onerror = (e) => reject(new Error(e.message));
    worker.onmessage = (e: MessageEvent<FromTailscale>) => {
      const m = e.data;
      if (m.type === 'state') state = m.state;
      else if (m.type === 'netmap') netmap = m.netmap;
      else if (m.type === 'loaded') timings.loadMs = m.ms;
      else if (m.type === 'detached') detached?.(m.ip);
      else if (m.type === 'error') reject(new Error(m.error));
      if (state === 'Running' && netmap && timings.runningMs === undefined) {
        timings.runningMs = performance.now() - t0;
        resolve(netmap);
      }
      onEvent(m);
    };
  });
  running.catch(() => {});
  const wasm = config.wasm ?? new URL('../target/net/ts.wasm', import.meta.url).href;
  worker.postMessage({ type: 'start', wasm, addr: config.addr, derpMapURL: config.derpMapURL, ip: port1 } satisfies ToTailcat, [port1]);
  return {
    ip: own?.port2, state: () => state, netmap: () => netmap, loginURL: () => undefined, running, timings: () => timings,
    attach: (ip) => worker.postMessage({ type: 'attach', ip } satisfies ToTailcat, [ip]),
    detach: () => new Promise((resolve) => {
      const t = setTimeout(() => resolve(undefined), 3000);
      detached = (ip) => { clearTimeout(t); resolve(ip); };
      worker.postMessage({ type: 'detach' } satisfies ToTailcat);
    }),
    setExitNode: () => Promise.reject(new Error('a tailcat server is the exit node itself')),
    logout: () => Promise.resolve(),
    close: () => worker.terminate(),
  };
}
