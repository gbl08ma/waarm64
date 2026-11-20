// The tailcat backend from the page's side (docs/networking/tailnet.md "tailcat"):
// the guest's network through a tailcat server (`tailcat serve exit-node` on a
// computer of the user's) instead of a tailnet, by the Rust tailnet client
// (net/ts) in its own worker (web/tailcat-worker.ts); and the VM as a tailcat
// server: clients with its address (`tailcat ssh tc…`) reach the guest.
// The handle is the Tailscale backend's (`Tailscale`, web/tailscale.ts), so
// the page's network controller drives either; what a tailcat server doesn't
// have (exit nodes, logging out) is refused.
import type { Lease } from './gateway.ts';
import { hex } from './bytes.ts';
import { v6text } from './ip6.ts';
import { fromWire, msg, MsgError, type Msg } from './msg.ts';
import type { Reach6Options } from './reach6.ts';
import { workerFailures, type FromTailscale, type NetMap, type Tailscale } from './tailscale.ts';

export type TailcatConfig = {
  /** The `tc…` address the server printed: a secret (it lets anyone who has it in). Empty: serve only. */
  addr: string;
  /** Let tailcat clients in to the guest; `relay`, when there's no `addr`: one's own derper (`host[:port]`), or empty
   * for tailcat's public relays (the nearest region); `allow`: the clients' node keys let in (empty: any with the address). */
  serve?: TailcatServe;
  /** The machine's identity (its node key, and its address when serving): kept in `waarm64-tailcat` in IndexedDB under
   * `identityKey` (default `served` when serving), or, given `identity`, that one (an ephemeral connection's, kept
   * nowhere). Neither, and not serving: a fresh key each connect. */
  identityKey?: string;
  identity?: TailcatIdentity;
  /** The DERP map for an address that names only a region (default: tailcat's public map). */
  derpMapURL?: string;
  /** How the server's machine's IPv6 reach is checked (web/reach6.ts; the tests point it at a resolver of theirs). */
  probe6?: Reach6Options;
  /** Where target/net/ts.wasm is served from (default: this checkout's target/net). */
  wasm?: string;
  /** The gateway's end of the IP port (transferred); default: a new channel, whose device end is `ip`. */
  ip?: MessagePort;
};

export type TailcatServe = { relay: string; allow?: string[] };

/** Messages to the worker. */
export type ToTailcat =
  | {
      type: 'start';
      wasm: string;
      addr: string;
      serve?: TailcatServe;
      identityKey?: string;
      identity?: TailcatIdentity;
      derpMapURL?: string;
      probe6?: Reach6Options;
      ip: MessagePort;
    }
  | { type: 'attach'; ip: MessagePort }
  | { type: 'primary'; primary: boolean; rank?: number; primary6?: boolean }
  | { type: 'detach' };

/** A tailcat address as typed or pasted: `tc` and base64url, or an error to show. The module checks the rest. */
export function parseTailcatAddr(input: string): { addr: string } | { error: Msg } {
  const s = input.trim();
  if (!s) return { error: msg('network:tailcat.pasteAddress') };
  if (!/^tc[A-Za-z0-9_-]{40,}$/.test(s)) return { error: msg('network:tailcat.notAddress') };
  return { addr: s };
}

/** The clients let in, as typed (`tailcat serve --allow`'s keys, `nodekey:` and 64 hex digits, separated by commas,
 * spaces or lines), or an error to show. Empty: any client with the address. */
export function parseAllow(input: string): { allow: string[] } | { error: Msg } {
  const keys = input.split(/[\s,]+/).filter((k) => k);
  const bad = keys.find((k) => !/^nodekey:[0-9a-fA-F]{64}$/.test(k));
  if (bad) return { error: msg('network:tailcat.badKey', { key: bad.length > 24 ? `${bad.slice(0, 24)}…` : bad }) };
  return { allow: [...new Set(keys.map((k) => k.toLowerCase()))] };
}

/** A relay as typed: `host` or `host:port`, or an error to show (the module checks it again). */
export function parseRelay(input: string): { relay: string } | { error: Msg } {
  const s = input.trim();
  if (!s) return { relay: '' };
  if (!/^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/.test(s)) return { error: msg('network:tailcat.badRelay') };
  return { relay: s };
}

/** The served machine's kept identity: its node key and the address's pre-shared key (hex), in this origin's IndexedDB. */
export type TailcatIdentity = { key: string; psk: string };
const IDB = 'waarm64-tailcat';

function idb<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('identity');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const r = f(db.transaction('identity', mode).objectStore('identity'));
      r.onsuccess = () => {
        db.close();
        resolve(r.result);
      };
      r.onerror = () => {
        db.close();
        reject(r.error);
      };
    };
  });
}

const hex32 = () => hex(crypto.getRandomValues(new Uint8Array(32)));

/** A new identity (an ephemeral connection's lives in memory: docs/networking/adapters.md §2.1). */
export const newTailcatIdentity = (): TailcatIdentity => ({ key: hex32(), psk: hex32() });

/**
 * The identity kept under `key`, made the first time. `served` is the one the page kept before connections
 * (docs/networking/adapters.md §2.2); a connection's is under its own key.
 */
export async function tailcatIdentity(key = 'served'): Promise<TailcatIdentity> {
  const get = () => idb<TailcatIdentity | undefined>('readonly', (s) => s.get(key));
  const kept = await get();
  if (kept) return kept;
  const made = newTailcatIdentity();
  // `add` refuses a key that's there (two starts at once made one each): then the one kept first is everyone's.
  const added = await idb('readwrite', (s) => s.add(made, key)).then(
    () => true,
    () => false,
  );
  return added ? made : ((await get()) ?? Promise.reject(new Error(`no tailcat identity under ${key}`)));
}

/** Whether there's a kept identity under `key` (an address to forget). */
export const hasTailcatIdentity = (key = 'served') =>
  idb<number>('readonly', (s) => s.count(key)).then(
    (n) => n > 0,
    () => false,
  );

/** Forgets the identity under `key`: the next serve has a new address, and the old one stops working. */
export const forgetTailcatIdentity = (key = 'served') => idb('readwrite', (s) => s.delete(key)).then(() => {});

/** The region of a DERP map with the fastest `/derp/probe` (what tailcat's own server picks by), or 0 if none answers. */
export async function nearestRegion(derpMapURL: string, timeoutMs = 3000): Promise<number> {
  type Node = { HostName: string; DERPPort?: number; STUNOnly?: boolean };
  const map = (await (await fetch(derpMapURL, { signal: AbortSignal.timeout(timeoutMs) })).json()) as {
    Regions: Record<string, { Nodes?: Node[] }>;
  };
  const timed = await Promise.all(
    Object.entries(map.Regions).map(async ([id, r]) => {
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
    }),
  );
  const [id, ms] = timed.reduce((a, b) => (b[1] < a[1] ? b : a), [0, Infinity] as const);
  return ms < Infinity ? id : 0;
}

/** What the menu shows of a tailcat connection: the guest's addresses and resolvers, no peers. */
export function netmapOf(lease: Lease, serving?: string, exit = true, key?: string): NetMap {
  return {
    name: '',
    via: 'tailcat',
    peers: [],
    mtu: lease.mtu,
    exitNode: '',
    domains: [],
    serving,
    tailcatExit: exit,
    tailcatKey: key,
    addresses: [`${lease.address.join('.')}/32`, ...(lease.address6 ? [`${v6text(lease.address6)}/128`] : [])],
    dns: [...lease.dns.map((d) => d.join('.')), ...(lease.dns6 ?? []).map(v6text)],
  };
}

/** Whether the server has the client (target/net/ts.wasm). */
export const tailcatBuilt = (wasm = new URL('../target/net/ts.wasm', import.meta.url).href) =>
  fetch(wasm, { method: 'HEAD' }).then(
    (r) => r.ok,
    () => false,
  );

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
    const heard = (m: FromTailscale) => {
      if (m.type === 'state') state = m.state;
      else if (m.type === 'netmap') netmap = m.netmap;
      else if (m.type === 'loaded') timings.loadMs = m.ms;
      else if (m.type === 'detached') detached?.(m.ip);
      else if (m.type === 'error') reject(fromWire(m.error));
      if (state === 'Running' && netmap && timings.runningMs === undefined) {
        timings.runningMs = performance.now() - t0;
        resolve(netmap);
      }
      onEvent(m);
    };
    worker.onmessage = (e: MessageEvent<FromTailscale>) => heard(e.data);
    workerFailures(worker, (error) => heard({ type: 'error', error }));
  });
  running.catch(() => {});
  const wasm = config.wasm ?? new URL('../target/net/ts.wasm', import.meta.url).href;
  worker.postMessage(
    {
      type: 'start',
      wasm,
      addr: config.addr,
      serve: config.serve,
      identityKey: config.identityKey,
      identity: config.identity,
      derpMapURL: config.derpMapURL,
      probe6: config.probe6,
      ip: port1,
    } satisfies ToTailcat,
    [port1],
  );
  return {
    ip: own?.port2,
    state: () => state,
    netmap: () => netmap,
    loginURL: () => undefined,
    running,
    timings: () => timings,
    attach: (ip) => worker.postMessage({ type: 'attach', ip } satisfies ToTailcat, [ip]),
    setPrimary: (primary, rank, primary6) =>
      worker.postMessage({ type: 'primary', primary, rank, primary6 } satisfies ToTailcat),
    detach: () =>
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(undefined), 3000);
        detached = (ip) => {
          clearTimeout(t);
          resolve(ip);
        };
        worker.postMessage({ type: 'detach' } satisfies ToTailcat);
      }),
    setExitNode: () => Promise.reject(new MsgError('network:tailcat.noExitNodes')),
    setAcceptRoutes: () => {},
    logout: () => Promise.resolve(),
    close: () => worker.terminate(),
  };
}
