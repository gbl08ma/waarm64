// Whether an adapter's IPv6 reaches the internet (docs/network-adapters.md §4 "IPv6 out"). A backend whose far end
// may have no IPv6 route out (a tailcat exit node on a machine without one accepts the guest's IPv6 connections and
// closes them empty, so a client that tries IPv6 first never falls back to IPv4) asks public resolvers over IPv6, from
// the guest's own address, through the backend: at the start, every minute, and when the browser's network changes. While
// one answers, the lease is the backend's; while it doesn't, the lease has no IPv6 default route and no IPv6
// resolvers (`unreached6`), so the guest's IPv6 to the internet fails at once and its clients use IPv4. The prober
// lives in the backend's worker, between the backend's packets and the guest's: it sends as the guest and takes its
// answers out of the packets to the guest. Any backend that carries the guest's IPv6 can use it.
import { udp6 } from './ip6.ts';
import type { Lease, Prefix } from './gateway.ts';

export type Reach6Options = {
  /** The resolvers asked, all at once (IPv6 text; default `PROBE_TARGETS`), and their port (53). Any answer counts. */
  to?: string[];
  port?: number;
  /** A probe this often while nothing changes (default a minute). */
  everyMs?: number;
  /** A probe without an answer within this is lost (default 3 s). */
  timeoutMs?: number;
  /** IPv6 is out after this many lost in a row (default 3, sent one after another); one answer brings it back. */
  misses?: number;
};

export type Reach6 = {
  /** Probes from `source` (the lease's IPv6 address) from now on, the first at once; the same source again changes nothing. */
  start(source: number[]): void;
  /** Stops probing (the backend's connection ended); what was found is kept for the next `start`. */
  stop(): void;
  /** Probes again at once, as when the browser's network changed. */
  probe(): void;
  /** A packet on its way to the guest: true if it was the prober's (an answer), which the guest mustn't get. */
  take(packet: Uint8Array): boolean;
  /** Whether IPv6 reaches the internet, as far as the probes tell (false until the first answer). */
  reached(): boolean;
};

/**
 * Public resolvers of three operators (Cloudflare, Google, Quad9): one blocked where the guest's traffic leaves (a
 * country's court order, a network's policy) mustn't make IPv6 as a whole count as out.
 */
export const PROBE_TARGETS = ['2606:4700:4700::1111', '2001:4860:4860::8888', '2620:fe::fe'];

/** IPv6 text (`2606:4700:4700::1111`) as 16 bytes, or undefined. */
export function parse6(s: string): number[] | undefined {
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const groups = (h: string) => (h ? h.split(':') : []);
  const [head, tail] = [groups(halves[0]), groups(halves[1] ?? '')];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < (halves.length === 2 ? 1 : 0) || head.length + fill + tail.length !== 8) return undefined;
  const all = [...head, ...Array(fill).fill('0'), ...tail];
  if (!all.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return undefined;
  return all.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
}

/**
 * The lease for a guest whose IPv6 doesn't reach the internet: the address stays (the backend's own network, e.g. a
 * tunnel's `fd7a:` services), routed through `keep` only (unless the lease already has IPv6 routes), with no IPv6
 * resolvers. A lease without IPv6, and null, stay as they are.
 */
export const unreached6 = (lease: Lease | null, keep: Prefix[]): Lease | null =>
  !lease?.address6 ? lease : { ...lease, dns6: [], routes: { ...lease.routes, v6: lease.routes?.v6 ?? keep } };

const eq = (a: Uint8Array, at: number, b: number[]) => b.every((v, k) => a[at + k] === v);

/**
 * A prober: `send` puts a packet on the backend as if the guest had sent it, and `onChange` hears when the answer to
 * "does IPv6 reach the internet" changes. A probe is a DNS query for the root's NS records to each resolver, from a
 * port above Linux's ephemeral range (61000–65535, picked once), matched by its ID: lost when none answers.
 */
export function reach6(send: (packet: Uint8Array) => void, onChange: (reached: boolean) => void, o: Reach6Options = {}): Reach6 {
  const to = (o.to ?? PROBE_TARGETS).map((t) => {
    const a = parse6(t);
    if (!a) throw new Error(`not an IPv6 address: ${t}`);
    return a;
  });
  const port = o.port ?? 53;
  const everyMs = o.everyMs ?? 60_000;
  const timeoutMs = o.timeoutMs ?? 3000;
  const misses = o.misses ?? 3;
  const random16 = () => crypto.getRandomValues(new Uint16Array(1))[0];
  const sport = 61000 + (random16() % 4536);
  let source: number[] | undefined;
  let reached = false;
  let lost = 0;
  let pending: { id: number; timer: ReturnType<typeof setTimeout> } | undefined;
  let next: ReturnType<typeof setTimeout> | undefined;

  const set = (r: boolean) => {
    if (r === reached) return;
    reached = r;
    onChange(r);
  };
  // Lost probes are sent again one after another until IPv6 counts as out; then (and while it answers) every `everyMs`.
  const schedule = (ms: number) => {
    clearTimeout(next);
    next = source ? setTimeout(probe, ms) : undefined;
  };
  function probe() {
    if (!source || pending) return;
    clearTimeout(next);
    const id = random16();
    const query = new Uint8Array([id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1]);
    const timer = setTimeout(() => {
      pending = undefined;
      lost++;
      if (lost >= misses) set(false);
      schedule(lost >= misses ? everyMs : 0);
    }, timeoutMs);
    pending = { id, timer };
    for (const t of to) send(udp6(source, t, sport, port, query));
  }
  const changed = () => {
    lost = 0;
    if (!pending) schedule(0);
  };
  const g = globalThis as { addEventListener?: EventTarget['addEventListener']; removeEventListener?: EventTarget['removeEventListener']; navigator?: { connection?: EventTarget } };

  return {
    start(s) {
      const watching = !!source;
      if (watching && source!.every((b, k) => b === s[k])) return;
      source = s;
      lost = 0;
      // Not at once: `start` may run in the backend's own event, which `send` mustn't re-enter.
      if (!pending) schedule(0);
      if (watching) return;
      g.addEventListener?.('online', changed);
      g.navigator?.connection?.addEventListener('change', changed);
    },
    stop() {
      if (!source) return;
      source = undefined;
      clearTimeout(next);
      if (pending) clearTimeout(pending.timer);
      pending = undefined;
      g.removeEventListener?.('online', changed);
      g.navigator?.connection?.removeEventListener('change', changed);
    },
    probe: changed,
    take(p) {
      // IPv6, UDP (no extension headers: an answer has none), from a resolver's port to ours, to our source.
      if (p.length < 48 + 12 || p[0] >> 4 !== 6 || p[6] !== 17 || !source) return false;
      if (((p[42] << 8) | p[43]) !== sport || ((p[40] << 8) | p[41]) !== port || !to.some((t) => eq(p, 8, t)) || !eq(p, 24, source)) return false;
      const id = (p[48] << 8) | p[49];
      if (pending && pending.id === id && p[50] & 0x80) {
        clearTimeout(pending.timer);
        pending = undefined;
        lost = 0;
        set(true);
        schedule(everyMs);
      }
      return true;
    },
    reached: () => reached,
  };
}
