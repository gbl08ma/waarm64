// The tailcat backend from the page's side (docs/tailnet.md "tailcat"):
// the guest's network through a tailcat server (`tailcat serve exit-node` on a
// computer of the user's) instead of a tailnet, by the Rust tailnet client
// (net/ts) in its own worker (web/tailcat-worker.ts); and the VM as a tailcat
// server: clients with its address (`tailcat ssh tc…`) reach the guest.
// The handle is the Tailscale backend's (`Tailscale`, web/tailscale.ts), so
// the page's network controller drives either; what a tailcat server doesn't
// have (exit nodes, logging out) is refused.
import type { Lease } from './gateway.ts';
import type { FromTailscale, NetMap, Tailscale } from './tailscale.ts';

export type TailcatConfig = {
  /** The `tc…` address the server printed: a secret (it lets anyone who has it in). Empty: serve only. */
  addr: string;
  /** Let tailcat clients in to the guest; `relay`, when there's no `addr`: one's own derper (`host[:port]`), or empty
   * for tailcat's public relays (the nearest region). The machine's address is kept (`webpc-tailcat` in IndexedDB, under
   * `identityKey`: default `served`), or, given `identity`, is that one's (an ephemeral connection's, kept nowhere). */
  serve?: TailcatServe;
  /** The DERP map for an address that names only a region (default: tailcat's public map). */
  derpMapURL?: string;
  /** Where target/net/ts.wasm is served from (default: this checkout's target/net). */
  wasm?: string;
  /** The gateway's end of the IP port (transferred); default: a new channel, whose device end is `ip`. */
  ip?: MessagePort;
};

export type TailcatServe = { relay: string; identityKey?: string; identity?: TailcatIdentity };

/** Messages to the worker. */
export type ToTailcat =
  | { type: 'start'; wasm: string; addr: string; serve?: TailcatServe; derpMapURL?: string; ip: MessagePort }
  | { type: 'attach'; ip: MessagePort }
  | { type: 'primary'; primary: boolean }
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

/** A relay as typed: `host` or `host:port`, or an error to show (the module checks it again). */
export function parseRelay(input: string): { relay: string } | { error: string } {
  const s = input.trim();
  if (!s) return { relay: '' };
  if (!/^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/.test(s)) return { error: 'A relay is a host name, or host:port (your derper; no https://).' };
  return { relay: s };
}

/** The served machine's kept identity: its node key and the address's pre-shared key (hex), in this origin's IndexedDB. */
export type TailcatIdentity = { key: string; psk: string };
const IDB = 'webpc-tailcat';

function idb<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('identity');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const r = f(db.transaction('identity', mode).objectStore('identity'));
      r.onsuccess = () => { db.close(); resolve(r.result); };
      r.onerror = () => { db.close(); reject(r.error); };
    };
  });
}

const hex32 = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

/** A new identity (an ephemeral connection's lives in memory: docs/network-adapters.md §2.1). */
export const newTailcatIdentity = (): TailcatIdentity => ({ key: hex32(), psk: hex32() });

/**
 * The identity kept under `key`, made the first time. `served` is the one the page kept before connections
 * (docs/network-adapters.md §2.2); a connection's is under its own key.
 */
export async function tailcatIdentity(key = 'served'): Promise<TailcatIdentity> {
  const kept = await idb<TailcatIdentity | undefined>('readonly', (s) => s.get(key));
  if (kept) return kept;
  const made = newTailcatIdentity();
  await idb('readwrite', (s) => s.put(made, key));
  return made;
}

/** Whether there's a kept identity under `key` (an address to forget). */
export const hasTailcatIdentity = (key = 'served') => idb<number>('readonly', (s) => s.count(key)).then((n) => n > 0, () => false);

/** Forgets the identity under `key`: the next serve has a new address, and the old one stops working. */
export const forgetTailcatIdentity = (key = 'served') => idb('readwrite', (s) => s.delete(key)).then(() => {});

/** The region of a DERP map with the fastest `/derp/probe` (what tailcat's own server picks by), or 0 if none answers. */
export async function nearestRegion(derpMapURL: string, timeoutMs = 3000): Promise<number> {
  type Node = { HostName: string; DERPPort?: number; STUNOnly?: boolean };
  const map = await (await fetch(derpMapURL)).json() as { Regions: Record<string, { Nodes?: Node[] }> };
  const timed = await Promise.all(Object.entries(map.Regions).map(async ([id, r]) => {
    const n = r.Nodes?.find((x) => !x.STUNOnly && x.HostName);
    if (!n) return [Number(id), Infinity] as const;
    const url = `https://${n.HostName}${n.DERPPort && n.DERPPort !== 443 ? `:${n.DERPPort}` : ''}/derp/probe`;
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const t = performance.now();
      try {
        await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
        best = Math.min(best, performance.now() - t);
      } catch {
        break;
      }
    }
    return [Number(id), best] as const;
  }));
  const [id, ms] = timed.reduce((a, b) => (b[1] < a[1] ? b : a), [0, Infinity] as const);
  return ms < Infinity ? id : 0;
}

/** What the menu shows of a tailcat connection: the guest's addresses and resolvers, no peers. */
export function netmapOf(lease: Lease, serving?: string, exit = true): NetMap {
  return {
    name: '', via: 'tailcat', peers: [], mtu: lease.mtu, exitNode: '', domains: [], serving, tailcatExit: exit,
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
  worker.postMessage({ type: 'start', wasm, addr: config.addr, serve: config.serve, derpMapURL: config.derpMapURL, ip: port1 } satisfies ToTailcat, [port1]);
  return {
    ip: own?.port2, state: () => state, netmap: () => netmap, loginURL: () => undefined, running, timings: () => timings,
    attach: (ip) => worker.postMessage({ type: 'attach', ip } satisfies ToTailcat, [ip]),
    setPrimary: (primary) => worker.postMessage({ type: 'primary', primary } satisfies ToTailcat),
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
