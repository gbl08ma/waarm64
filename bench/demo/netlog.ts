// Bytes on the wire from a Chromium net log (`--log-net-log=<file>`, the default capture mode: byte counts, no
// payloads), for bench/demo/run.ts. Every TCP socket's received bytes (TLS records and all: what the network carried,
// short of TCP/IP's headers), every QUIC session's received packets and every DNS answer, by the host they came from,
// in time order, so the bytes up to a moment (a run's mark) can be summed. The log is read a line at a time (Chromium
// writes one event a line), so a log of a big download needn't fit in one string.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Bytes received from one host, with the wall-clock time (epoch ms) of each arrival, in order. */
export type HostBytes = { host: string; total: number; times: number[]; sizes: number[] };

type Event = { type: number; time: string; phase: number; source: { id: number; type: number }; params?: Record<string, unknown> };

/** Reads a net log: the bytes received, by host. */
export async function readNetLog(path: string): Promise<Map<string, HostBytes>> {
  let types: Record<string, number> = {}, sources: Record<string, number> = {}, offset = 0;
  const T = (name: string) => types[name] ?? -1;
  /** A connect job's host (its socket group, `pm/https://host:port <nak>` or `ssl/host:443`), a socket's connect job. */
  const jobHost = new Map<number, string>(), socketJob = new Map<number, number>(), socketAddr = new Map<number, string>();
  const quicHost = new Map<number, string>();
  /** Received bytes on sockets and sessions, kept until every source's host is known (a socket's job may come after). */
  const pending: { src: number; quic: boolean; udp?: string; t: number; n: number }[] = [];
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let first = true;
  for await (const raw of lines) {
    if (first) {
      first = false;
      // `{"constants": {...},`: the event and source type numbers, and the ticks' offset from the epoch.
      const c = JSON.parse(`${raw.replace(/,\s*$/, '')}}`).constants;
      types = c.logEventTypes;
      sources = c.logSourceType;
      offset = Number(c.timeTickOffset);
      continue;
    }
    if (!raw.startsWith('{')) continue;
    let e: Event;
    try {
      e = JSON.parse(raw.replace(/,\s*$/, ''));
    } catch {
      continue; // the last line of a log cut off by a crash
    }
    const p = e.params ?? {};
    const t = Number(e.time) + offset;
    if (e.type === T('SOCKET_POOL_CONNECT_JOB_CREATED') && typeof p.group_id === 'string') jobHost.set(e.source.id, groupHost(p.group_id));
    else if (e.type === T('SOCKET_ALIVE') && e.source.type === sources.SOCKET) {
      const dep = p.source_dependency as { id: number } | undefined;
      if (dep) socketJob.set(e.source.id, dep.id);
    } else if (e.type === T('TCP_CONNECT') && Array.isArray(p.address_list)) socketAddr.set(e.source.id, String(p.address_list[0]));
    else if (e.type === T('QUIC_SESSION') && typeof p.host === 'string') quicHost.set(e.source.id, p.host);
    else if (e.type === T('SOCKET_BYTES_RECEIVED')) pending.push({ src: e.source.id, quic: false, t, n: Number(p.byte_count) });
    else if (e.type === T('QUIC_SESSION_PACKET_RECEIVED')) pending.push({ src: e.source.id, quic: true, t, n: Number(p.size) });
    else if (e.type === T('UDP_BYTES_RECEIVED') && e.source.type === sources.UDP_SOCKET) {
      // A DNS answer (a QUIC session's packets are counted by the session, not again by its UDP socket).
      if (String(p.address ?? '').endsWith(':53')) pending.push({ src: e.source.id, quic: false, udp: '(dns)', t, n: Number(p.byte_count) });
    }
  }
  const out = new Map<string, HostBytes>();
  for (const x of pending) {
    const host = x.udp ?? (x.quic ? quicHost.get(x.src) : jobHost.get(socketJob.get(x.src) ?? -1) ?? socketAddr.get(x.src)) ?? '(unknown)';
    let h = out.get(host);
    if (!h) out.set(host, (h = { host, total: 0, times: [], sizes: [] }));
    h.total += x.n;
    h.times.push(x.t);
    h.sizes.push(x.n);
  }
  return out;
}

/** A socket group's host: `pm/https://unkernel.dev <...>`, `ssl/wisp.pi0.io:6680`, `https://a.b:443`. */
function groupHost(group: string) {
  const g = group.split(' ')[0].replace(/^(pm|ssl|socks[45]?|http)\//, '');
  const m = /^(?:[a-z]+:\/\/)?(\[[^\]]+\]|[^/:]+)/.exec(g);
  return m ? m[1] : g;
}

/** Chromium's own traffic, not the page's (autofill, component updates, safe browsing, the variations service). */
export const BACKGROUND = /(^|\.)(google\.com|googleapis\.com|gstatic\.com|gvt1\.com|googleusercontent\.com|google|chromium\.org)$/;

/** Bytes received by `until` (epoch ms; all of them without it), the page's hosts and Chromium's own apart. */
export function bytesBy(hosts: Map<string, HostBytes>, until = Infinity) {
  let page = 0, background = 0;
  const byHost: Record<string, number> = {};
  for (const h of hosts.values()) {
    let n = 0;
    for (let i = 0; i < h.times.length && h.times[i] <= until; i++) n += h.sizes[i];
    if (!n) continue;
    byHost[h.host] = n;
    if (BACKGROUND.test(h.host)) background += n;
    else page += n;
  }
  return { page, background, byHost };
}
