// NAMES loop 0 (docs/plans/room-names.md "Measure first"): a batch of real OpenTimestamps stamps of random 32-byte
// digests (not names) at the spec's three calendars, and, later, the collection of their finished proofs.
// - `stamp`: POSTs each digest to `alice`, `bob` and `finney` on a schedule (bursts of digests submitted at once, which a
//   calendar aggregates together, and single digests minutes apart, which share only what one calendar transaction
//   gives), and writes every receipt with its commitment (the message the calendar will timestamp) and the time it was
//   made, after each step, to `--out` (bench/net/results/names0/stamps.json).
// - `collect`: for each receipt not yet finished, GETs the calendar's timestamp for its commitment (once a run; a 404
//   is "pending"), checks it ends in a Bitcoin attestation, fetches that block's header from both explorers (they must
//   agree) and checks its Merkle root, and writes the proofs and headers to `--proofs`
//   (bench/net/results/names0/proofs.json). Run it again until nothing is pending; it asks nothing it already has.
//   `--before <ISO time>` asks only about the stamps made before it. Then `sizes` prints the anchors' sizes, raw and with what proofs in one block share.
// The format is read from the OpenTimestamps format's description, not from its (LGPL) libraries. Public services:
// every request is counted and printed; no test runs this. Node 26: `node bench/net/ots-stamps.ts stamp|collect|sizes`.
// In a session behind a proxy Node's fetch needs NODE_USE_ENV_PROXY=1 (docs/cloud.md).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const ROOT = new URL('../..', import.meta.url).pathname;
const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: `${ROOT}bench/net/results/names0/stamps.json` },
    proofs: { type: 'string', default: `${ROOT}bench/net/results/names0/proofs.json` },
    // The schedule: `bursts` bursts of `burst` digests every `burst-every` minutes, and a single digest every
    // `single-every` minutes in between, for `minutes` minutes.
    bursts: { type: 'string', default: '6' }, burst: { type: 'string', default: '8' },
    'burst-every': { type: 'string', default: '25' }, 'single-every': { type: 'string', default: '5' },
    minutes: { type: 'string', default: '150' },
    // collect: only the stamps made before this time (an early look at a few, without asking for all).
    before: { type: 'string' },
  },
});

export const CALENDARS: Record<string, string> = {
  alice: 'https://alice.btc.calendar.opentimestamps.org',
  bob: 'https://bob.btc.calendar.opentimestamps.org',
  finney: 'https://finney.calendar.eternitywall.com',
};
const EXPLORERS = { blockstream: 'https://blockstream.info/api', mempool: 'https://mempool.space/api' };
// A generic client name: nothing about the user or the project goes to a public service.
const HEADERS = { 'User-Agent': 'ots-client/1.0', Accept: 'application/vnd.opentimestamps.v1' };

const counts: Record<string, number> = {};
async function get(url: string, init?: RequestInit): Promise<Response> {
  const host = new URL(url).host;
  counts[host] = (counts[host] ?? 0) + 1;
  return fetch(url, { ...init, headers: { ...HEADERS, ...init?.headers }, signal: AbortSignal.timeout(30_000) });
}

// ---- The format: a timestamp is a tree of operations from a message to attestations. ----
const PENDING = '83dfe30d2ef90c8e';
const BITCOIN = '0588960d73d71901';
export type Op = { op: 'append' | 'prepend' | 'sha256'; arg?: Uint8Array };
export type Leaf = { ops: Op[]; msg: Uint8Array; kind: 'pending' | 'bitcoin' | 'other'; uri?: string; height?: number };

class Reader {
  i = 0;
  b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  byte(): number {
    if (this.i >= this.b.length) throw new Error('truncated timestamp');
    return this.b[this.i++];
  }
  varuint(): number {
    let v = 0, shift = 0, x: number;
    do {
      x = this.byte();
      v += (x & 0x7f) * 2 ** shift;
      shift += 7;
    } while (x & 0x80);
    return v;
  }
  bytes(n: number): Uint8Array {
    if (this.i + n > this.b.length) throw new Error('truncated timestamp');
    return this.b.subarray(this.i, (this.i += n));
  }
  varbytes(): Uint8Array {
    return this.bytes(this.varuint());
  }
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const sha256 = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());

/** Every attestation a serialized timestamp reaches from `msg`, with the operations on the way. */
export function leaves(bytes: Uint8Array, msg: Uint8Array): Leaf[] {
  const r = new Reader(bytes);
  const out: Leaf[] = [];
  const walk = (m: Uint8Array, ops: Op[]) => {
    let tag = r.byte();
    while (tag === 0xff) {
      one(r.byte(), m, ops);
      tag = r.byte();
    }
    one(tag, m, ops);
  };
  const one = (tag: number, m: Uint8Array, ops: Op[]) => {
    if (tag === 0x00) {
      const t = hex(r.bytes(8));
      const p = new Reader(r.varbytes());
      if (t === PENDING) out.push({ ops, msg: m, kind: 'pending', uri: new TextDecoder().decode(p.varbytes()) });
      else if (t === BITCOIN) out.push({ ops, msg: m, kind: 'bitcoin', height: p.varuint() });
      else out.push({ ops, msg: m, kind: 'other' });
      return;
    }
    if (tag === 0xf0 || tag === 0xf1) {
      const arg = r.varbytes().slice();
      const n = new Uint8Array(m.length + arg.length);
      if (tag === 0xf0) n.set(m), n.set(arg, m.length);
      else n.set(arg), n.set(m, arg.length);
      return walk(n, [...ops, { op: tag === 0xf0 ? 'append' : 'prepend', arg }]);
    }
    if (tag === 0x08) return walk(sha256(m), [...ops, { op: 'sha256' }]);
    throw new Error(`operation 0x${tag.toString(16)} is not one the calendars emit`);
  };
  walk(msg, []);
  if (r.i !== bytes.length) throw new Error('bytes after the timestamp');
  return out;
}

/** The bytes of a linear run of operations, as the format serializes them (what an anchor carries). */
export function opsBytes(ops: Op[]): number {
  let n = 0;
  for (const op of ops) {
    n += 1;
    if (op.arg) n += (op.arg.length < 128 ? 1 : 2) + op.arg.length;
  }
  return n;
}

type Receipt = { hex?: string; commitment?: string; uri?: string; ms: number; error?: string };
type Stamp = { digest: string; group: string; madeAt: string; receipts: Record<string, Receipt> };
type Stamps = { made: string; note: string; schedule: Record<string, number>; stamps: Stamp[]; requests: Record<string, number> };

async function stampOne(digest: Uint8Array<ArrayBuffer>, group: string): Promise<Stamp> {
  const madeAt = new Date().toISOString();
  const receipts: Record<string, Receipt> = {};
  await Promise.all(Object.entries(CALENDARS).map(async ([name, base]) => {
    const t0 = performance.now();
    try {
      const res = await get(`${base}/digest`, { method: 'POST', body: digest, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      const body = new Uint8Array(await res.arrayBuffer());
      const ms = Math.round(performance.now() - t0);
      if (!res.ok) return void (receipts[name] = { ms, error: `HTTP ${res.status}` });
      const ls = leaves(body, digest).filter((l) => l.kind === 'pending');
      if (ls.length !== 1) return void (receipts[name] = { ms, hex: hex(body), error: 'not one pending attestation' });
      receipts[name] = { hex: hex(body), commitment: hex(ls[0].msg), uri: ls[0].uri, ms };
    } catch (e) {
      receipts[name] = { ms: Math.round(performance.now() - t0), error: String(e) };
    }
  }));
  return { digest: hex(digest), group, madeAt, receipts };
}

async function stamp() {
  const bursts = +o.bursts!, burst = +o.burst!, every = +o['burst-every']! * 60_000;
  const single = +o['single-every']! * 60_000, total = +o.minutes! * 60_000;
  const plan: { at: number; n: number; group: string }[] = [];
  for (let b = 0; b < bursts; b++) plan.push({ at: b * every, n: burst, group: `burst${b}` });
  for (let t = single / 2, k = 0; t < total; t += single, k++) plan.push({ at: t, n: 1, group: `single${k}` });
  plan.sort((a, b) => a.at - b.at);
  const doc: Stamps = {
    made: new Date().toISOString(),
    note: 'Random 32-byte digests (not names) stamped at the three calendars. A burst\'s digests were POSTed at once; singles minutes apart. Receipts are the calendars\' answers (hex); a commitment is the message the calendar will timestamp, what `collect` asks for.',
    schedule: { bursts, burst, burstEveryMin: +o['burst-every']!, singleEveryMin: +o['single-every']!, minutes: +o.minutes! },
    stamps: [], requests: counts,
  };
  const start = Date.now();
  for (const step of plan) {
    const wait = start + step.at - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const made = await Promise.all(Array.from({ length: step.n }, () => stampOne(new Uint8Array(randomBytes(32)), step.group)));
    doc.stamps.push(...made);
    writeFileSync(o.out!, JSON.stringify(doc, null, 1) + '\n');
    const errs = made.flatMap((s) => Object.entries(s.receipts).filter(([, r]) => r.error).map(([c, r]) => `${c}: ${r.error}`));
    console.log(`${new Date().toISOString()} ${step.group}: ${step.n} digest(s)${errs.length ? `, errors: ${errs.join('; ')}` : ''}`);
  }
  console.log('requests', JSON.stringify(counts));
}

type Proof = { digest: string; calendar: string; hex: string; height: number; merkleRoot: string; anchorBytes: number; ops: number; collectedAt: string };
type Proofs = { proofs: Proof[]; headers: Record<string, { hash: string; header: string }>; pending: Record<string, string>; runs: { at: string; requests: Record<string, number> }[] };

async function explorer(path: string, name: keyof typeof EXPLORERS): Promise<string> {
  const res = await get(`${EXPLORERS[name]}${path}`, { headers: { Accept: 'text/plain' } });
  if (!res.ok) throw new Error(`${name} ${path}: HTTP ${res.status}`);
  return (await res.text()).trim();
}

async function collect() {
  const doc: Stamps = JSON.parse(readFileSync(o.out!, 'utf8'));
  const p: Proofs = existsSync(o.proofs!) ? JSON.parse(readFileSync(o.proofs!, 'utf8')) : { proofs: [], headers: {}, pending: {}, runs: [] };
  const have = new Set(p.proofs.map((x) => `${x.digest}/${x.calendar}`));
  p.pending = {};
  for (const s of doc.stamps) {
    if (o.before && s.madeAt >= o.before) continue;
    for (const [cal, r] of Object.entries(s.receipts)) {
      if (!r.commitment || have.has(`${s.digest}/${cal}`)) continue;
      const res = await get(`${CALENDARS[cal]}/timestamp/${r.commitment}`).catch((e) => String(e));
      if (typeof res === 'string' || !res.ok) {
        p.pending[`${s.digest}/${cal}`] = typeof res === 'string' ? res : `HTTP ${res.status}`;
        continue;
      }
      const body = new Uint8Array(await res.arrayBuffer());
      const btc = leaves(body, Buffer.from(r.commitment, 'hex')).filter((l) => l.kind === 'bitcoin');
      if (!btc.length) {
        p.pending[`${s.digest}/${cal}`] = 'no Bitcoin attestation yet';
        continue;
      }
      // The whole anchor: the receipt's operations (digest to commitment) and the calendar's (commitment to the root).
      const front = leaves(Buffer.from(r.hex!, 'hex'), Buffer.from(s.digest, 'hex')).find((l) => l.kind === 'pending')!;
      const leaf = btc.reduce((a, b) => (a.height! <= b.height! ? a : b));
      const ops = [...front.ops, ...leaf.ops];
      p.proofs.push({
        digest: s.digest, calendar: cal, hex: hex(body), height: leaf.height!, merkleRoot: hex(leaf.msg),
        anchorBytes: opsBytes(ops), ops: ops.length, collectedAt: new Date().toISOString(),
      });
      have.add(`${s.digest}/${cal}`);
    }
  }
  // Each block's header, from both explorers, which must agree; its Merkle root must be the proofs'.
  for (const pr of p.proofs) {
    if (p.headers[pr.height]) continue;
    const hashes = await Promise.all((['blockstream', 'mempool'] as const).map((e) => explorer(`/block-height/${pr.height}`, e)));
    if (hashes[0] !== hashes[1]) throw new Error(`explorers disagree on block ${pr.height}`);
    const header = await explorer(`/block/${hashes[0]}/header`, 'blockstream');
    const h = Buffer.from(header, 'hex');
    if (h.length !== 80 || hex(sha256(sha256(h)).reverse()) !== hashes[0]) throw new Error(`bad header for ${pr.height}`);
    p.headers[pr.height] = { hash: hashes[0], header };
  }
  for (const pr of p.proofs) {
    if (hex(Buffer.from(p.headers[pr.height].header, 'hex').subarray(36, 68)) !== pr.merkleRoot) throw new Error(`Merkle root mismatch at ${pr.height}`);
  }
  p.runs.push({ at: new Date().toISOString(), requests: counts });
  writeFileSync(o.proofs!, JSON.stringify(p, null, 1) + '\n');
  const total = doc.stamps.reduce((n, s) => n + Object.values(s.receipts).filter((r) => r.commitment).length, 0);
  console.log(`${p.proofs.length} of ${total} receipts finished, ${Object.keys(p.pending).length} pending; requests ${JSON.stringify(counts)}`);
}

/** Anchor sizes: each proof whole, and what proofs in one block share (the calendar's tail and the header). */
function sizes() {
  const doc: Stamps = JSON.parse(readFileSync(o.out!, 'utf8'));
  const p: Proofs = JSON.parse(readFileSync(o.proofs!, 'utf8'));
  const byDigest = new Map(doc.stamps.map((s) => [s.digest, s]));
  const opsOf = (pr: Proof) => {
    const s = byDigest.get(pr.digest)!;
    const front = leaves(Buffer.from(s.receipts[pr.calendar].hex!, 'hex'), Buffer.from(s.digest, 'hex')).find((l) => l.kind === 'pending')!;
    const back = leaves(Buffer.from(pr.hex, 'hex'), Buffer.from(s.receipts[pr.calendar].commitment!, 'hex')).find((l) => l.kind === 'bitcoin' && l.height === pr.height)!;
    return [...front.ops, ...back.ops].map((x) => `${x.op}:${x.arg ? hex(x.arg) : ''}`);
  };
  const groups = new Map<string, string[][]>();
  for (const pr of p.proofs) {
    const k = `${pr.calendar}@${pr.height}`;
    groups.set(k, [...(groups.get(k) ?? []), opsOf(pr)]);
  }
  const rows = [];
  for (const [k, list] of groups) {
    // The operations every proof of the group ends with: carried once for the group.
    let tail = 0;
    while (list.every((l) => l.length > tail && l[l.length - 1 - tail] === list[0][list[0].length - 1 - tail])) tail++;
    const size = (l: string[]) => opsBytes(l.map((s) => { const [op, a] = s.split(':'); return { op: op as Op['op'], arg: a ? Buffer.from(a, 'hex') : undefined }; }));
    const raw = list.map(size);
    const shared = size(list[0].slice(list[0].length - tail));
    rows.push({ block: k, proofs: list.length, rawMin: Math.min(...raw), rawMax: Math.max(...raw), sharedTail: shared, header: 80 });
  }
  console.log(JSON.stringify(rows, null, 1));
}

if (import.meta.main) {
  const what = positionals[0];
  if (what === 'stamp') await stamp();
  else if (what === 'collect') await collect();
  else if (what === 'sizes') sizes();
  else throw new Error('usage: ots-stamps.ts stamp|collect|sizes');
}
