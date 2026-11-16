// The tests' pretend OpenTimestamps calendars and block explorer (docs/plans/room-names.md "Bitcoin as the clock"): no
// test touches a public service. One HTTP server plays the three calendars the module compiles in (anchor.rs `Calendar`:
// alice, bob and finney, each under its own path) and an Esplora explorer (blockstream.info's and mempool.space's API),
// over a pretend Bitcoin whose headers meet the tests' floor (room/names.rs `Params::TEST`: regtest's target, so half of
// all hashes pass) and carry the wall clock's time. No dependency.
//
// - A calendar answers as the real ones do: `POST /<calendar>/digest` (the digest, 32 bytes) with a receipt (the
//   digest's path to a commitment, then a pending attestation naming the calendar), `access-control-allow-origin: *`;
//   `GET /<calendar>/timestamp/<commitment, hex>` with **404 and no CORS header** while it is pending (a page sees a failed
//   fetch), then with the finished proof (the commitment's path to a block's Merkle root and the Bitcoin attestation with
//   its height) once that block is `depth` deep.
// - `mine(n)` mines blocks: each takes every commitment waiting (on every calendar) into its Merkle tree; `every`
//   mines one on a timer. `down` holds calendars that answer 503.
// - The explorer, at `explorer` (`…/api`): `blocks/tip/height`, `blocks/tip/hash`, `block-height/<h>`,
//   `block/<hash>/header` (hex), CORS open; hashes in the explorers' byte order (the reverse of the header's).
//
// The formats are OpenTimestamps' (ops 0x08 SHA-256, 0xf0 append, 0xf1 prepend; 0x00 and an 8-byte tag for an
// attestation, its payload as varbytes), as net/ts/src/room/names/anchor.rs reads them.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';

export const CALENDARS = ['alice', 'bob', 'finney'] as const;
export type CalendarName = (typeof CALENDARS)[number];
/** The URLs the module compiles in (anchor.rs `Calendar::url`), for a page test to route here. */
export const CALENDAR_URLS: Record<CalendarName, string> = {
  alice: 'https://alice.btc.calendar.opentimestamps.org',
  bob: 'https://bob.btc.calendar.opentimestamps.org',
  finney: 'https://finney.calendar.eternitywall.com',
};
/** Regtest's compact target, the tests' floor. */
export const EASY_BITS = 0x207fffff;
const BITCOIN = Buffer.from([0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01]);
const PENDING = Buffer.from([0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e]);

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();
export const sha256d = (b: Buffer) => sha256(sha256(b));

function varuint(v: number): Buffer {
  const out: number[] = [];
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}
const varbytes = (b: Buffer) => Buffer.concat([varuint(b.length), b]);

/** An OpenTimestamps operation, as the calendars emit them. */
export type Op = { op: 'sha256' } | { op: 'append' | 'prepend'; arg: Buffer };
export function writeOps(ops: Op[]): Buffer {
  return Buffer.concat(ops.map((o) => o.op === 'sha256' ? Buffer.from([0x08]) : Buffer.concat([Buffer.from([o.op === 'append' ? 0xf0 : 0xf1]), varbytes(o.arg)])));
}
export function applyOps(ops: Op[], m: Buffer): Buffer {
  for (const o of ops) m = o.op === 'sha256' ? sha256(m) : o.op === 'append' ? Buffer.concat([m, o.arg]) : Buffer.concat([o.arg, m]);
  return m;
}

/** A timestamp read back (one path, no forks: what the calendars emit): its ops and its attestation. */
export function readTimestamp(b: Buffer): { ops: Op[]; attestation: { kind: 'bitcoin'; height: number } | { kind: 'pending'; uri: string } } {
  let i = 0;
  const vu = () => { let v = 0, s = 1; for (;;) { const x = b[i++]; v += (x & 0x7f) * s; s *= 128; if (!(x & 0x80)) return v; } };
  const vb = () => { const n = vu(); const r = b.subarray(i, i + n); i += n; return r; };
  const ops: Op[] = [];
  for (;;) {
    const tag = b[i++];
    if (tag === 0x08) ops.push({ op: 'sha256' });
    else if (tag === 0xf0 || tag === 0xf1) ops.push({ op: tag === 0xf0 ? 'append' : 'prepend', arg: Buffer.from(vb()) });
    else if (tag === 0x00) {
      const kind = b.subarray(i, i + 8);
      i += 8;
      const p = vb();
      if (kind.equals(BITCOIN)) { let v = 0, s = 1, j = 0; for (;;) { const x = p[j++]; v += (x & 0x7f) * s; s *= 128; if (!(x & 0x80)) break; } return { ops, attestation: { kind: 'bitcoin', height: v } }; }
      if (kind.equals(PENDING)) {
        let n = 0, s = 1, j = 0;
        for (;;) { const x = p[j++]; n += (x & 0x7f) * s; s *= 128; if (!(x & 0x80)) break; }
        return { ops, attestation: { kind: 'pending', uri: p.subarray(j, j + n).toString() } };
      }
      throw new Error('an attestation of another kind');
    } else throw new Error(`not an op: ${tag}`);
  }
}

/** The target a compact `bits` stands for, big-endian. */
export function target(bits: number): Buffer {
  const t = Buffer.alloc(32);
  const exp = bits >>> 24;
  const mant = bits & 0x7fffff;
  for (let k = 0; k < 3; k++) {
    const at = 32 - exp + k;
    if (at >= 0 && at < 32) t[at] = (mant >> (8 * (2 - k))) & 0xff;
  }
  return t;
}

export type Block = { height: number; header: Buffer; hash: Buffer; time: number };

export type OtsCalendar = {
  /** The server's base URL (`http://127.0.0.1:<port>`). */
  url: string;
  /** Each calendar's URL here, by name. */
  calendars: Record<CalendarName, string>;
  /** The explorer's API (`…/explorer/api`). */
  explorer: string;
  /** The chain, genesis first. */
  blocks: Block[];
  /** Calendars that answer 503. */
  down: Set<CalendarName>;
  /** Mines `n` blocks (default 1) at the wall clock's time; the commitments waiting go into the first. */
  mine(n?: number): Block[];
  /** Commitments waiting for a block. */
  waiting(): number;
  /** Requests served, by path's first part (`alice`, `explorer`, …). */
  requests: Record<string, number>;
  close(): Promise<void>;
};

/** Mines a header over `root` at `time` on `prev` to the tests' target. */
export function mineHeader(prev: Buffer, root: Buffer, time: number, bits = EASY_BITS): Buffer {
  const h = Buffer.alloc(80);
  h.writeUInt32LE(0x20000000, 0);
  prev.copy(h, 4);
  root.copy(h, 36);
  h.writeUInt32LE(time >>> 0, 68);
  h.writeUInt32LE(bits >>> 0, 72);
  const t = target(bits);
  for (let nonce = 0; ; nonce++) {
    h.writeUInt32LE(nonce, 76);
    if (Buffer.from(sha256d(h)).reverse().compare(t) <= 0) return h;
  }
}

/**
 * Starts the pretend calendars and explorer on 127.0.0.1 (`port` 0: any). `depth`: how deep a block must be before a
 * calendar serves its proofs (the real ones wait for 6); `every`: mine a block every so many ms.
 */
export async function startOtsCalendar(o: { port?: number; depth?: number; every?: number } = {}): Promise<OtsCalendar> {
  const depth = o.depth ?? 6;
  const blocks: Block[] = [];
  /** Commitment (hex) → its calendar and, once mined, its block's height and path to the root. */
  const commits = new Map<string, { ops?: Op[]; height?: number }>();
  let waiting: string[] = [];
  const down = new Set<CalendarName>();
  const requests: Record<string, number> = {};

  function mine(n = 1): Block[] {
    const made: Block[] = [];
    for (let k = 0; k < n; k++) {
      const leaves = waiting.map((h) => Buffer.from(h, 'hex'));
      const owners = waiting;
      waiting = [];
      // A Merkle tree over the commitments (an odd one out is paired with itself), each leaf's path as ops.
      const paths: Op[][] = leaves.map(() => []);
      let level = leaves.length ? leaves.map((l, i) => ({ m: l, who: [i] })) : [{ m: randomBytes(32), who: [] as number[] }];
      while (level.length > 1) {
        const next: typeof level = [];
        for (let i = 0; i < level.length; i += 2) {
          const l = level[i];
          const r = level[i + 1] ?? l;
          for (const w of l.who) paths[w].push({ op: 'append', arg: r.m }, { op: 'sha256' });
          if (r !== l) for (const w of r.who) paths[w].push({ op: 'prepend', arg: l.m }, { op: 'sha256' });
          next.push({ m: sha256(Buffer.concat([l.m, r.m])), who: r === l ? l.who : [...l.who, ...r.who] });
        }
        level = next;
      }
      if (leaves.length === 1) paths[0].push({ op: 'append', arg: Buffer.alloc(0) }, { op: 'sha256' });
      const root = leaves.length === 1 ? sha256(leaves[0]) : level[0].m;
      const prev = blocks.length ? blocks[blocks.length - 1].hash : Buffer.alloc(32);
      const time = Math.floor(Date.now() / 1000);
      const header = mineHeader(prev, root, time);
      const b = { height: blocks.length, header, hash: sha256d(header), time };
      blocks.push(b);
      made.push(b);
      owners.forEach((h, i) => commits.set(h, { ops: paths[i], height: b.height }));
    }
    return made;
  }
  mine(); // genesis

  const cors = (res: ServerResponse) => res.setHeader('access-control-allow-origin', '*');
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const parts = u.pathname.split('/').filter((p) => p);
    requests[parts[0] ?? ''] = (requests[parts[0] ?? ''] ?? 0) + 1;
    if (req.method === 'OPTIONS') {
      cors(res);
      res.setHeader('access-control-allow-methods', 'GET, POST');
      res.setHeader('access-control-allow-headers', '*');
      return res.writeHead(204).end();
    }
    if (parts[0] === 'explorer' && parts[1] === 'api') {
      cors(res);
      const display = (b: Block) => Buffer.from(b.hash).reverse().toString('hex');
      const tip = blocks[blocks.length - 1];
      const p = parts.slice(2).join('/');
      if (p === 'blocks/tip/height') return res.end(String(tip.height));
      if (p === 'blocks/tip/hash') return res.end(display(tip));
      if (parts[2] === 'block-height' && blocks[Number(parts[3])]) return res.end(display(blocks[Number(parts[3])]));
      const b = parts[2] === 'block' && blocks.find((x) => display(x) === parts[3]);
      if (b && parts[4] === 'header') return res.end(b.header.toString('hex'));
      return res.writeHead(404).end('Block not found');
    }
    const cal = parts[0] as CalendarName;
    if (!CALENDARS.includes(cal)) return res.writeHead(404).end();
    if (down.has(cal)) return res.writeHead(503).end();
    if (req.method === 'POST' && parts[1] === 'digest') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const digest = Buffer.concat(chunks);
        if (digest.length === 0 || digest.length > 64) return res.writeHead(400).end();
        // The receipt: a nonce appended and hashed (the calendar's commitment), then a pending attestation.
        const ops: Op[] = [{ op: 'append', arg: randomBytes(16) }, { op: 'sha256' }];
        const c = applyOps(ops, digest).toString('hex');
        commits.set(c, {});
        waiting.push(c);
        const uri = Buffer.from(`${base}/${cal}`);
        cors(res);
        res.setHeader('content-type', 'application/vnd.opentimestamps.v1');
        res.end(Buffer.concat([writeOps(ops), Buffer.from([0]), PENDING, varbytes(varbytes(uri))]));
      });
      return;
    }
    if (req.method === 'GET' && parts[1] === 'timestamp' && parts[2]) {
      const c = commits.get(parts[2]);
      const tip = blocks.length - 1;
      if (!c?.ops || c.height === undefined || tip - c.height + 1 < depth) return res.writeHead(404).end('Pending confirmation in Bitcoin blockchain'); // no CORS
      cors(res);
      res.setHeader('content-type', 'application/vnd.opentimestamps.v1');
      return res.end(Buffer.concat([writeOps(c.ops), Buffer.from([0]), BITCOIN, varbytes(varuint(c.height))]));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(o.port ?? 0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const timer = o.every ? setInterval(() => mine(), o.every) : undefined;
  return {
    url: base,
    calendars: Object.fromEntries(CALENDARS.map((c) => [c, `${base}/${c}`])) as Record<CalendarName, string>,
    explorer: `${base}/explorer/api`,
    blocks,
    down,
    mine,
    waiting: () => waiting.length,
    requests,
    close: () => { clearInterval(timer); return new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = await startOtsCalendar({ port: Number(process.argv[2] ?? 0), every: 10_000 });
  console.log(JSON.stringify({ calendars: c.calendars, explorer: c.explorer }));
}
