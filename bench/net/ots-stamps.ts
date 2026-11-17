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
// - `anchors` (N0b): the anchors' sizes as the module encodes them, raw and stored as one tree a calendar transaction,
//   and their times against the calendars' own transactions (each status page once: every recent transaction with its
//   confirmations) and the blocks' times (an explorer's block lists): stamp to block and to the sixth confirmation,
//   next or later transaction, the first of the three, when the page's agent would collect it. Writes
//   bench/net/results/names0/anchors.json; what it fetches is cached under bench/results/local/names0b/.
// The format is read from the OpenTimestamps format's description, not from its (LGPL) libraries. Public services:
// every request is counted and printed; no test runs this. Node 26: `node bench/net/ots-stamps.ts stamp|collect|sizes|anchors`.
// In a session behind a proxy Node's fetch needs NODE_USE_ENV_PROXY=1 (docs/cloud.md).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
        // What the calendar says of it (a 404's body names the transaction it waits on, and the confirmations).
        p.pending[`${s.digest}/${cal}`] = typeof res === 'string' ? res : `HTTP ${res.status}: ${(await res.text().catch(() => '')).trim().slice(0, 200)}`;
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

// ---- N0b: the batch's anchors against the calendars' own transactions. ----
const CACHE_B = `${ROOT}bench/results/local/names0b/`;
const PAGES: Record<string, string> = { alice: `${CALENDARS.alice}/`, bob: `${CALENDARS.bob}/`, finney: `${CALENDARS.finney}/` };

/** A cached GET (text): asked once, kept under bench/results/local/names0b/. */
async function cachedText(url: string, name: string, accept = 'text/html'): Promise<string> {
  const file = `${CACHE_B}${name}`;
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const res = await get(url, { headers: { Accept: accept } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const t = await res.text();
  mkdirSync(CACHE_B, { recursive: true });
  writeFileSync(file, t);
  return t;
}

/** The calendar transaction an anchor goes through: the first SHA-256 over more than 64 bytes (a transaction, where
 * a tree's or a block's hashes are over 64) and the one after it give its txid. */
function txidOf(ops: Op[], msg: Uint8Array): string {
  let m = msg;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.op === 'sha256') {
      if (m.length > 64 && ops[i + 1]?.op === 'sha256') return hex(sha256(sha256(m)).reverse());
      m = sha256(m);
    } else if (op.op === 'append') m = Buffer.concat([m, op.arg!]);
    else m = Buffer.concat([op.arg!, m]);
  }
  throw new Error('no transaction in the anchor');
}

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((q / 100) * s.length) - 1))];
};
const stats = (xs: number[], d = 2) => {
  const r = (x: number) => +x.toFixed(d);
  return { n: xs.length, min: r(Math.min(...xs)), median: r(pct(xs, 50)), p90: r(pct(xs, 90)), max: r(Math.max(...xs)), mean: r(xs.reduce((a, b) => a + b, 0) / xs.length) };
};

/** N0b: sizes (raw, a calendar transaction's anchors stored as one tree, headers once a block) and times (stamp to
 * block, to 6 deep; next or later calendar transaction), from the committed stamps and proofs, the calendars' status
 * pages and the blocks' times; writes results/names0/anchors.json. */
async function anchors() {
  const doc: Stamps = JSON.parse(readFileSync(o.out!, 'utf8'));
  const p: Proofs = JSON.parse(readFileSync(o.proofs!, 'utf8'));
  const byDigest = new Map(doc.stamps.map((s) => [s.digest, s]));
  const opsOf = (pr: Proof): Op[] => {
    const s = byDigest.get(pr.digest)!;
    const front = leaves(Buffer.from(s.receipts[pr.calendar].hex!, 'hex'), Buffer.from(s.digest, 'hex')).find((l) => l.kind === 'pending')!;
    const back = leaves(Buffer.from(pr.hex, 'hex'), Buffer.from(s.receipts[pr.calendar].commitment!, 'hex')).find((l) => l.kind === 'bitcoin' && l.height === pr.height)!;
    return [...front.ops, ...back.ops];
  };
  // The module's encoding of an anchor (anchor.rs `Anchor::encode`): the operations, then 0x00, the attestation's
  // 8-byte tag, a length and the height's varuint (3 bytes at these heights).
  const encoded = (ops: Op[], height: number) => opsBytes(ops) + 1 + 8 + 1 + Math.ceil(Math.log2(height + 1) / 7);
  const rows = p.proofs.map((pr) => {
    const ops = opsOf(pr);
    return { pr, ops, txid: txidOf(ops, Buffer.from(pr.digest, 'hex')), size: encoded(ops, pr.height) };
  });

  // Sizes. Shared: the anchors through one calendar transaction stored as one tree (each operation once for every
  // anchor whose path from the root runs through it), and each block's header once.
  const sizesBy = (f: (r: (typeof rows)[number]) => boolean) => stats(rows.filter(f).map((r) => r.size), 0);
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(r.txid, [...(groups.get(r.txid) ?? []), r]);
  const trees = [...groups.entries()].map(([txid, list]) => {
    const nodes = new Set<string>();
    let shared = 0;
    for (const r of list) {
      let key = '';
      for (let i = r.ops.length - 1; i >= 0; i--) {
        const op = r.ops[i];
        key += `|${op.op}:${op.arg ? hex(op.arg) : ''}`;
        if (nodes.has(key)) continue;
        nodes.add(key);
        shared += opsBytes([op]);
      }
      shared += 13; // each anchor's own attestation and height
    }
    const raw = list.reduce((a, r) => a + r.size, 0);
    const groupsInIt = new Set(list.map((r) => byDigest.get(r.pr.digest)!.group)).size;
    return { calendar: list[0].pr.calendar, height: list[0].pr.height, txid, anchors: list.length, stampGroups: groupsInIt, raw, shared, perAnchorRaw: Math.round(raw / list.length), perAnchorShared: Math.round(shared / list.length) };
  });
  // Pairs: two anchors through one transaction, made apart (singles) or at once (a burst): what the second adds.
  const pairAdd = (same: boolean) => {
    const adds: number[] = [];
    for (const list of groups.values()) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const gi = byDigest.get(list[i].pr.digest)!.group, gj = byDigest.get(list[j].pr.digest)!.group;
        if ((gi === gj && gi.startsWith('burst')) !== same) continue;
        const a = list[i].ops, b = list[j].ops;
        let t = 0;
        while (t < a.length && t < b.length && JSON.stringify(a[a.length - 1 - t]) === JSON.stringify(b[b.length - 1 - t])) t++;
        adds.push(opsBytes(b.slice(0, b.length - t)) + 13);
      }
    }
    return stats(adds, 0);
  };

  // Times. Each calendar's transactions with their heights (its status page, now), the blocks' times (an explorer's
  // block lists, ten a request), and each stamp's block, its sixth confirmation, and how many of the calendar's
  // transactions were mined after the stamp and before the one that carries it.
  const heights = rows.map((r) => r.pr.height);
  const lo = Math.min(...heights) - 30, hi = Math.max(...heights) + 5;
  const blockTime = new Map<number, number>();
  for (let h = hi + 9; h >= lo; h -= 10) {
    const list: { height: number; timestamp: number }[] = JSON.parse(await cachedText(`${EXPLORERS.blockstream}/blocks/${h}`, `blocks-${h}.json`, 'application/json'));
    for (const b of list) blockTime.set(b.height, b.timestamp);
  }
  for (const [h, v] of Object.entries(p.headers)) {
    if (Buffer.from(v.header, 'hex').readUInt32LE(68) !== blockTime.get(+h)) throw new Error(`block ${h}'s time differs from its header's`);
  }
  const calTx: Record<string, { txid: string; height: number }[]> = {};
  const pageNotes: Record<string, unknown> = {};
  for (const [name, url] of Object.entries(PAGES)) {
    const html = await cachedText(url, `page-${name}.html`);
    const best = +html.match(/height (\d+)/)![1];
    const list = [...html.matchAll(/\/tx\/([0-9a-f]{64})\?mode=details">[0-9a-f]+<\/a><\/td>\s*<td[^>]*>([\d.]+)<\/td>\s*<td[^>]*>(\d+)<\/td>/g)]
      .map((r) => ({ txid: r[1], height: best - +r[3] + 1, confs: +r[3] }));
    const waiting = +(html.match(/Transactions waiting for confirmation:\s*(?:<[^>]*>\s*)*([\d,]+)/)?.[1] ?? 'NaN');
    pageNotes[name] = { best, listed: list.length, waitingForConfirmation: waiting, minedUnder6: list.filter((t) => t.confs < 6).length, confsOfLatest: list.slice(0, 8).map((t) => t.confs) };
    calTx[name] = list.filter((t) => t.height >= lo && t.height <= hi).map(({ txid, height }) => ({ txid, height })).sort((a, b) => a.height - b.height);
  }
  const H = 3600;
  type T = { digest: string; group: string; calendar: string; madeAt: string; height: number; later: number; toBlockH: number; toSixDeepH: number };
  const times: T[] = [];
  for (const r of rows) {
    const s = byDigest.get(r.pr.digest)!;
    const made = Date.parse(s.madeAt) / 1000;
    const txs = calTx[r.pr.calendar];
    if (!txs.some((t) => t.txid === r.txid && t.height === r.pr.height)) throw new Error(`${r.txid} isn't on ${r.pr.calendar}'s page at ${r.pr.height}`);
    // The calendar's transactions mined in a block timed after the stamp, before the one that carries it.
    const later = txs.filter((t) => blockTime.get(t.height)! > made && t.height < r.pr.height).length;
    times.push({
      digest: r.pr.digest, group: s.group, calendar: r.pr.calendar, madeAt: s.madeAt, height: r.pr.height, later,
      toBlockH: +((blockTime.get(r.pr.height)! - made) / H).toFixed(3),
      toSixDeepH: +((blockTime.get(r.pr.height + 5)! - made) / H).toFixed(3),
    });
  }
  const per: Record<string, unknown> = {};
  for (const cal of Object.keys(CALENDARS)) {
    const t = times.filter((x) => x.calendar === cal);
    per[cal] = {
      transactions: [...new Set(t.map((x) => `${x.height}`))].join(', '),
      nextTransaction: t.filter((x) => x.later === 0).length, laterTransaction: t.filter((x) => x.later > 0).length,
      stampToBlockHours: stats(t.map((x) => x.toBlockH)), stampToSixDeepHours: stats(t.map((x) => x.toSixDeepH)),
      blockToSixDeepHours: stats([...new Set(t.map((x) => x.height))].map((h) => (blockTime.get(h + 5)! - blockTime.get(h)!) / H)),
    };
  }
  const first = doc.stamps.map((s) => Math.min(...times.filter((x) => x.digest === s.digest).map((x) => x.toSixDeepH)));
  const firstWho = doc.stamps.map((s) => times.filter((x) => x.digest === s.digest).reduce((a, b) => (a.toSixDeepH <= b.toSixDeepH ? a : b)).calendar);
  // When the page's agent (web/names.ts, page open throughout) would collect the first of the three: it asks 5 minutes
  // after stamping (`RETRY_MS`), then waits 5 minutes doubling to an hour (`PASS_MS`): asks at 5, 10, 20, 40, 80, 140,
  // 200, ... minutes. And `PUBLIC_IN_MS` (2 hours), what the dialog counts down from.
  const asks: number[] = [];
  for (let t = 5, w = 5; t < 48 * 60; t += w, w = Math.min(w * 2, 60)) asks.push(t);
  const collected = first.map((h) => asks.find((m) => m >= h * 60)! / 60);
  const out = {
    made: new Date().toISOString(),
    note: 'NAMES loop 0b: the batch of results/names0/stamps.json, its proofs (proofs.json) against the calendars\' status pages and the blocks\' times. An anchor\'s size is the module\'s encoding (anchor.rs): its operations from the 32-byte digest to the Merkle root, the attestation and height (13 bytes). "shared": the anchors through one calendar transaction stored as one tree. Times in hours from the stamp: to its block\'s time, and to the block 5 after it (6 confirmations, when a calendar serves the proof). "later": calendar transactions mined (in a block timed after the stamp) before the one that carried it.',
    span: { stamps: doc.stamps.length, from: doc.stamps[0].madeAt, to: doc.stamps[doc.stamps.length - 1].madeAt, blocks: `${lo} to ${hi}` },
    sizes: {
      anchor: sizesBy(() => true), alice: sizesBy((r) => r.pr.calendar === 'alice'), bob: sizesBy((r) => r.pr.calendar === 'bob'), finney: sizesBy((r) => r.pr.calendar === 'finney'),
      transactions: trees, secondAnchorAdds: { madeApart: pairAdd(false), sameBurst: pairAdd(true) }, header: 80, blocks: new Set(heights).size,
    },
    times: {
      perCalendar: per,
      firstOfThree: { sixDeepHours: stats(first), byCalendar: Object.fromEntries(Object.keys(CALENDARS).map((c) => [c, firstWho.filter((x) => x === c).length])) },
      agentCollectsHours: { asksAtMinutes: asks.slice(0, 9), firstOfThree: stats(collected), pastTwoHours: collected.filter((h) => h > 2).length },
    },
    pages: pageNotes, calendarTransactions: calTx,
    blockTimes: Object.fromEntries([...blockTime.entries()].filter(([h]) => h >= lo && h <= hi).sort((a, b) => a[0] - b[0]).map(([h, t]) => [h, new Date(t * 1000).toISOString().slice(0, 19)])),
    stamps: times,
    requests: counts,
  };
  writeFileSync(`${ROOT}bench/net/results/names0/anchors.json`, JSON.stringify(out, null, 1) + '\n');
  const { stamps: _s, calendarTransactions: _c, blockTimes: _b, ...brief } = out;
  console.log(JSON.stringify(brief, null, 1));
}

if (import.meta.main) {
  const what = positionals[0];
  if (what === 'stamp') await stamp();
  else if (what === 'collect') await collect();
  else if (what === 'sizes') sizes();
  else if (what === 'anchors') await anchors();
  else throw new Error('usage: ots-stamps.ts stamp|collect|sizes|anchors');
}
