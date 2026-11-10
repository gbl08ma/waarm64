// A minimal Nostr relay for the tests (docs/plans/networking-p2p.md §7, R1): NIP-01's EVENT, REQ and CLOSE, filters
// by `kinds` and `#x` tags (what a room's lookups use; other filter fields are ignored), forwarding without storing
// (so EOSE at once: ephemeral events are never stored anyway). Signatures aren't checked (the module's are, by its own
// tests against BIP-340's vectors); the id is, as SHA-256 of NIP-01's serialization. No dependency: a small RFC 6455
// server (text frames, ping, close; no extensions, no fragmentation from us) over node:http's upgrade.
//
// As a program: `node tests/net/nostr-relay.ts [port]` prints its ws:// URL and serves until killed, its `stats` at
// `GET /stats` (bench/net/room-scale.ts reads them).
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

type Event = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string };
type Filter = { kinds?: number[]; '#x'?: string[] };
type Client = { send(text: string): void; subs: Map<string, Filter[]>; close(): void };

/** What the relay carried, for a benchmark: counts since the start, and when each client path first subscribed. */
export type RelayStats = {
  connections: number; reqs: number; closes: number; eventsIn: number; forwards: number; bytesIn: number; bytesOut: number;
  /** The connection's request path (a benchmark gives each member its own) → `Date.now()` at its first REQ. */
  firstReq: Record<string, number>;
};

export type NostrRelay = {
  url: string;
  /** Every event published, in order. */
  events: Event[];
  /** While true, published events are dropped (a relay that doesn't forward). */
  drop: boolean;
  /** How many clients are connected. */
  clients(): number;
  stats: RelayStats;
  close(): Promise<void>;
};

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(op: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | op, n])
    : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255])
    : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, payload]);
}

/** Serves one upgraded socket: complete text messages go to `onText`. */
function serve(socket: Duplex, onText: (s: string) => void, onClose: () => void, stats: RelayStats): Client['send'] {
  let buf = Buffer.alloc(0);
  let parts: Buffer[] = [];
  let closed = false;
  const close = () => { if (!closed) { closed = true; socket.destroy(); onClose(); } };
  socket.on('data', (d: Buffer) => {
    stats.bytesIn += d.length;
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80;
      let len = buf[1] & 127, at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
      if (!masked) return close(); // clients mask (RFC 6455 §5.1)
      if (buf.length < at + 4 + len) return;
      const mask = buf.subarray(at, at + 4);
      const p = Buffer.from(buf.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
      buf = buf.subarray(at + 4 + len);
      if (op === 8) { socket.write(frame(8, Buffer.alloc(0))); return close(); }
      if (op === 9) { socket.write(frame(10, p)); continue; }
      if (op === 10) continue;
      parts.push(p);
      if (fin) { const m = Buffer.concat(parts).toString('utf8'); parts = []; onText(m); }
    }
  });
  socket.on('close', close);
  socket.on('error', close);
  return (text) => {
    if (closed) return;
    const f = frame(1, Buffer.from(text, 'utf8'));
    stats.bytesOut += f.length;
    socket.write(f);
  };
}

const matches = (e: Event, f: Filter) =>
  (!f.kinds || f.kinds.includes(e.kind)) && (!f['#x'] || e.tags.some((t) => t[0] === 'x' && f['#x']!.includes(t[1])));

const idOf = (e: Event) =>
  createHash('sha256').update(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])).digest('hex');

/** `keep`: `events` holds every event (the tests'); a benchmark's long run turns it off. */
export async function startNostrRelay(port = 0, keep = true): Promise<NostrRelay> {
  const clients = new Set<Client>();
  const relay: NostrRelay = {
    url: '', events: [], drop: false,
    clients: () => clients.size,
    stats: { connections: 0, reqs: 0, closes: 0, eventsIn: 0, forwards: 0, bytesIn: 0, bytesOut: 0, firstReq: {} },
    close: () => new Promise((resolve) => {
      for (const c of clients) c.close();
      server.close(() => resolve());
    }),
  };
  const server = createServer((req, res) => {
    if (req.url === '/stats') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(relay.stats));
    res.writeHead(426).end('a Nostr relay: WebSocket only');
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket') return socket.destroy();
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const c: Client = { send: () => {}, subs: new Map(), close: () => socket.destroy() };
    clients.add(c);
    const stats = relay.stats;
    stats.connections++;
    const path = req.url ?? '/';
    c.send = serve(socket, (text) => {
      let m: unknown;
      try { m = JSON.parse(text); } catch { return c.send(JSON.stringify(['NOTICE', 'not JSON'])); }
      if (!Array.isArray(m)) return;
      if (m[0] === 'REQ' && typeof m[1] === 'string') {
        stats.reqs++;
        stats.firstReq[path] ??= Date.now();
        c.subs.set(m[1], m.slice(2) as Filter[]);
        c.send(JSON.stringify(['EOSE', m[1]]));
      } else if (m[0] === 'CLOSE' && typeof m[1] === 'string') {
        stats.closes++;
        c.subs.delete(m[1]);
      } else if (m[0] === 'EVENT' && m[1] && typeof m[1] === 'object') {
        const e = m[1] as Event;
        if (idOf(e) !== e.id) return c.send(JSON.stringify(['OK', e.id, false, 'invalid: the id']));
        c.send(JSON.stringify(['OK', e.id, true, '']));
        stats.eventsIn++;
        if (keep) relay.events.push(e);
        if (relay.drop) return;
        for (const o of clients) {
          for (const [sub, filters] of o.subs) {
            if (filters.some((f) => matches(e, f))) { stats.forwards++; o.send(JSON.stringify(['EVENT', sub, e])); }
          }
        }
      }
    }, () => clients.delete(c), stats);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  relay.url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  return relay;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await startNostrRelay(Number(process.argv[2] ?? 0), false);
  console.log(r.url);
}
