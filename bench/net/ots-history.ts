// NAMES loop 0 (bench/net/REPORT.md "NAMES loop 0", item 1): how long an OpenTimestamps calendar takes to
// anchor, from its own transactions on Bitcoin, read through the two explorers' public HTTP APIs.
// A calendar pays from a wallet that changes address every transaction (each spends the one before's change), so its
// history can't be listed by address: it is walked back one transaction a request. A year of `alice` alone is ~7,500
// transactions, past what this loop may ask a public service, so the year is sampled: windows of consecutive
// transactions walked back from points spread over it. The points are the calendar's latest transaction (its status
// page lists it) and the transactions that spent the gifts to its donation address (the page names that address;
// those transactions are the calendar's, at whatever dates people gave), which the address's history lists.
// - `fetch`: the walks, every response cached under bench/results/local/names0/ (a rerun asks nothing it has);
//   requests alternate between blockstream.info and mempool.space and some are asked of both, which must agree.
// - `model`: from the windows' gaps and a year of block times (mempool.space's fee-rate series, which also gives a
//   height's time to a few minutes), the time from a stamp to its proof (the next calendar transaction's block, then 5
//   blocks more: a calendar serves a proof once its block is 6 deep), usual and worst, per calendar and for the first
//   of the three; and the time from `ref` (a block 6 deep when the entry is made) to the anchor's block, which
//   `REF_WINDOW` must cover. Writes bench/net/results/names0/history.json.
// Usage: node bench/net/ots-history.ts fetch|model [--windows 9] [--per alice=24,bob=18,finney=8] [--lead 600 --out <json>]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const ROOT = new URL('../..', import.meta.url).pathname;
const CACHE = `${ROOT}bench/results/local/names0/`;
const OUT = `${ROOT}bench/net/results/names0/history.json`;
// `--lead <s>`: a stamp misses a calendar transaction mined less than this after it (N0b: the batch's stamps made in
// the ~10 minutes before the block that mined their calendar's transaction went into the one after; 600 models that).
const lead = () => +o.lead!;
const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: { lead: { type: 'string', default: '0' }, out: { type: 'string' }, windows: { type: 'string', default: '9' }, per: { type: 'string', default: 'alice=24,bob=18,finney=8' }, seed: { type: 'string', default: '1' } },
});

// From each calendar's status page (2026-11-16): the latest mined transaction it lists, and its donation address.
const CAL: Record<string, { latest: string; donation: string }> = {
  alice: { latest: '8bbc7b229bda11813fb6952c87649aa1f7785eed31c748fdaf30159875172851', donation: 'bc1qep2un4cvwmhf6kxjgp6kzqcpzzyl98l5zkndl2' },
  bob: { latest: 'a547dbbcf8c02e03c9ff14c1f95d2164034740ddf5bbdaa648652033887ba5fb', donation: 'bc1q83zmvtfks2dnvqfgcmxme24kah602cxr59h5v7' },
  finney: { latest: '6c5b0db1c28e4d679688d95b1722297fedc17d9268f8f8cc838a9ee01431efbf', donation: 'bc1q9gmuj49f0j0470ke8qv50q8fkk0huxlcg3uk7m' },
};
const EXPLORERS = ['https://blockstream.info/api', 'https://mempool.space/api'];
const YEAR = 365 * 86400;

type Tx = {
  txid: string; fee: number; weight: number;
  vin: { txid: string; prevout: { scriptpubkey_address?: string; value: number } }[];
  vout: { scriptpubkey_type: string; value: number }[];
  status: { confirmed: boolean; block_height: number; block_time: number };
};

const counts: Record<string, number> = {};
let turn = 0;
async function api<T>(path: string, cacheName: string, both = false): Promise<T> {
  const file = `${CACHE}${cacheName}`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const ask = async (base: string) => {
    const host = new URL(base).host;
    counts[host] = (counts[host] ?? 0) + 1;
    const res = await fetch(`${base}${path}`, { headers: { 'User-Agent': 'ots-client/1.0' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${host}${path}: HTTP ${res.status}`);
    return res.json() as Promise<T>;
  };
  let v: T;
  if (both) {
    const [a, b] = await Promise.all(EXPLORERS.map(ask));
    const key = (x: unknown) => JSON.stringify((x as Tx).status ?? x);
    if (key(a) !== key(b)) throw new Error(`the explorers disagree on ${path}`);
    v = a;
  } else v = await ask(EXPLORERS[turn++ % 2]);
  mkdirSync(CACHE + 'tx', { recursive: true });
  writeFileSync(file, JSON.stringify(v));
  return v;
}
const tx = (id: string, both = false) => api<Tx>(`/tx/${id}`, `tx/${id}.json`, both);
type Outspend = { spent: boolean; txid?: string; status?: { confirmed: boolean; block_height: number; block_time: number } };
const outspends = (id: string) => api<Outspend[]>(`/tx/${id}/outspends`, `tx/${id}.out.json`);
const isCalendarTx = (t: Tx) => t.vout.some((v) => v.scriptpubkey_type === 'op_return');

const PAGES: Record<string, string> = {
  alice: 'https://alice.btc.calendar.opentimestamps.org/',
  bob: 'https://bob.btc.calendar.opentimestamps.org/',
  finney: 'https://finney.calendar.eternitywall.com/',
};

async function fetchAll() {
  const now = Math.floor(Date.now() / 1000);
  // Each calendar's status page: every transaction of its last ~140 (alice: 3 days; finney: 4 weeks), with its
  // confirmations, so their heights; and its donation address.
  for (const [name, url] of Object.entries(PAGES)) {
    if (existsSync(`${CACHE}page-${name}.html`)) continue;
    const host = new URL(url).host;
    counts[host] = (counts[host] ?? 0) + 1;
    const res = await fetch(url, { headers: { 'User-Agent': 'ots-client/1.0' }, signal: AbortSignal.timeout(30_000) });
    writeFileSync(`${CACHE}page-${name}.html`, await res.text());
  }
  // A year of blocks' fee rates (an average every ~48 blocks, with their height and time): mempool.space only.
  if (!existsSync(`${CACHE}feerates-1y.json`)) {
    counts['mempool.space'] = (counts['mempool.space'] ?? 0) + 1;
    const res = await fetch('https://mempool.space/api/v1/mining/blocks/fee-rates/1y', { headers: { 'User-Agent': 'ots-client/1.0' }, signal: AbortSignal.timeout(30_000) });
    writeFileSync(`${CACHE}feerates-1y.json`, await res.text());
  }
  const per = Object.fromEntries(o.per!.split(',').map((s) => s.split('=')).map(([k, v]) => [k, +v]));
  for (const [name, c] of Object.entries(CAL)) {
    // The donation address's history, newest first, 25 a page, back a year.
    const spends: Tx[] = [];
    let last = '';
    for (let page = 0; page < 20; page++) {
      const list = await api<Tx[]>(`/address/${c.donation}/txs/chain${last ? '/' + last : ''}`, `addr-${name}-${page}.json`);
      for (const t of list) if (t.vin.some((i) => i.prevout.scriptpubkey_address === c.donation) && isCalendarTx(t)) spends.push(t);
      if (list.length < 25 || list[list.length - 1].status.block_time < now - YEAR) break;
      last = list[list.length - 1].txid;
    }
    const inYear = spends.filter((t) => t.status.block_time >= now - YEAR - 86400 * 7).sort((a, b) => a.status.block_time - b.status.block_time);
    // The window starts: the latest, then the donation spends closest to evenly spaced dates through the year.
    const starts = [c.latest];
    const k = +o.windows! - 1;
    for (let i = 0; i < k && inYear.length; i++) {
      const target = now - YEAR + (YEAR * (i + 0.5)) / k;
      const best = inYear.reduce((a, b) => (Math.abs(b.status.block_time - target) < Math.abs(a.status.block_time - target) ? b : a));
      if (!starts.includes(best.txid)) starts.push(best.txid);
    }
    // The latest is walked back (each transaction's input is the change of the one before); the others forward, through
    // the explorers' `outspends` (which transaction spent output 0, the change, and its block): one request a step.
    for (const [w, start] of starts.entries()) {
      if (w === 0) {
        let id = start;
        for (let n = 0; n < per[name]; n++) {
          const t = await tx(id, n === 0);
          if (!isCalendarTx(t) || !t.status.confirmed) break;
          id = (t.vin.find((i) => i.prevout.scriptpubkey_address !== c.donation) ?? t.vin[0]).txid;
        }
      } else {
        let id = start;
        await tx(id, w < 3);
        for (let n = 1; n < per[name]; n++) {
          const outs = await outspends(id);
          if (!outs[0]?.spent || !outs[0].status?.confirmed) break;
          id = outs[0].txid!;
        }
        // The window's last transaction, whole: still the calendar's, so the walk didn't leave its wallet.
        if (!isCalendarTx(await tx(id))) console.log(`${name}: window ${w} ends off the calendar's chain`);
      }
      console.log(`${name}: window ${w} from ${start.slice(0, 12)}…; requests ${JSON.stringify(counts)}`);
    }
    writeFileSync(`${CACHE}starts-${name}.json`, JSON.stringify({ starts, spendsInYear: inYear.length }));
  }
  console.log('requests', JSON.stringify(counts));
  writeFileSync(`${CACHE}requests-history.json`, JSON.stringify(counts));
}

// ---- The model ----
type Point = { height: number; time: number };
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
// A deterministic generator, so the model's numbers don't move between runs.
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => ((x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), (x >>> 0) / 2 ** 32);
}

function model() {
  const series: { avgHeight: number; timestamp: number }[] = JSON.parse(readFileSync(`${CACHE}feerates-1y.json`, 'utf8'));
  // Height to time: the fee-rate series (an average every ~48 blocks) and every calendar block seen, interpolated.
  const pts: Point[] = series.map((x) => ({ height: x.avgHeight, time: x.timestamp }));
  // Mean block interval near a height, from the series (seconds).
  const meanInterval = (h: number) => {
    const i = Math.max(1, Math.min(pts.length - 1, pts.findIndex((p) => p.height >= h)));
    return (pts[i].time - pts[i - 1].time) / (pts[i].height - pts[i - 1].height);
  };
  const random = rng(+o.seed!);
  // Five block intervals, drawn (exponential, the local mean): the wait from a block to its sixth confirmation.
  const fiveBlocks = (h: number) => {
    let t = 0;
    for (let i = 0; i < 5; i++) t += -Math.log(1 - random()) * meanInterval(h);
    return t;
  };
  const out: Record<string, unknown> = {};
  const year: Record<string, unknown> = {};
  out.year = year;
  type Pt = { txid: string; status: { block_height: number; block_time: number } };
  const windows: Record<string, Pt[][]> = {};
  const cached = <T,>(f: string): T | undefined => (existsSync(CACHE + f) ? JSON.parse(readFileSync(CACHE + f, 'utf8')) : undefined);
  for (const [name, c] of Object.entries(CAL)) {
    const { starts } = JSON.parse(readFileSync(`${CACHE}starts-${name}.json`, 'utf8')) as { starts: string[] };
    windows[name] = [];
    for (const [w, start] of starts.entries()) {
      const win: Pt[] = [];
      let id = start;
      if (w === 0) {
        for (let t = cached<Tx>(`tx/${id}.json`); t && isCalendarTx(t) && t.status.confirmed; t = cached<Tx>(`tx/${id}.json`)) {
          win.unshift(t);
          id = (t.vin.find((i) => i.prevout.scriptpubkey_address !== c.donation) ?? t.vin[0]).txid;
        }
      } else {
        win.push(cached<Tx>(`tx/${id}.json`)!);
        for (let outs = cached<Outspend[]>(`tx/${id}.out.json`); outs?.[0]?.spent && outs[0].status?.confirmed; outs = cached<Outspend[]>(`tx/${id}.out.json`)) {
          id = outs[0].txid!;
          win.push({ txid: id, status: outs[0].status });
        }
      }
      windows[name].push(win);
    }
  }
  // Per calendar: the gaps between consecutive transactions' blocks, and a stamp at a uniform random time inside each
  // window. `next`: the stamp is in the first calendar transaction mined after it (the calendar replaces its
  // unconfirmed transaction with one carrying the newer tip); `second`: in the one after (it isn't), the slow bound.
  // The batch of real stamps (ots-stamps.ts) says which holds.
  const SAMPLES = 20_000;
  const sim: Record<string, { s: number; next: number; second: number; nextBlock: number; secondBlock: number }[]> = {};
  for (const [name, wins] of Object.entries(windows)) {
    const gapsH: number[] = [], gapsT: number[] = [], spans: string[] = [];
    let txs = 0;
    for (const w of wins) {
      txs += w.length;
      if (w.length < 3) continue;
      spans.push(`${new Date(w[0].status.block_time * 1000).toISOString().slice(0, 16)} to ${new Date(w[w.length - 1].status.block_time * 1000).toISOString().slice(0, 16)} (${w.length})`);
      for (let i = 1; i < w.length; i++) {
        gapsH.push(w[i].status.block_height - w[i - 1].status.block_height);
        gapsT.push(w[i].status.block_time - w[i - 1].status.block_time);
      }
    }
    // Stamps: a window chosen by its length in time, a uniform time between its first and its second-to-last block.
    const usable: Pt[][] = wins.filter((w) => w.length >= 3);
    const lens = usable.map((w) => Math.max(0, w[w.length - 2].status.block_time - lead() - w[0].status.block_time));
    const total = lens.reduce((a, b) => a + b, 0);
    sim[name] = [];
    for (let k = 0; k < SAMPLES; k++) {
      let r = random() * total, wi = 0;
      while (r > lens[wi]) r -= lens[wi++];
      const w = usable[wi];
      const s = w[0].status.block_time + r;
      const i = w.findIndex((t) => t.status.block_time > s + lead());
      const a = w[i], b = w[Math.min(i + 1, w.length - 1)];
      sim[name].push({
        s, nextBlock: a.status.block_time - s, secondBlock: b.status.block_time - s,
        next: a.status.block_time - s + fiveBlocks(a.status.block_height), second: b.status.block_time - s + fiveBlocks(b.status.block_height),
      });
    }
    const h = (xs: number[]) => ({ median: +(pct(xs, 50) / 3600).toFixed(2), p90: +(pct(xs, 90) / 3600).toFixed(2), p99: +(pct(xs, 99) / 3600).toFixed(2), max: +(Math.max(...xs) / 3600).toFixed(2) });
    year[name] = {
      transactions: txs, windows: spans, gaps: gapsT.length,
      gapBlocks: { median: pct(gapsH, 50), p90: pct(gapsH, 90), max: Math.max(...gapsH) },
      gapHours: h(gapsT),
      meanGapHours: +(gapsT.reduce((a, b) => a + b, 0) / gapsT.length / 3600).toFixed(2),
      stampToBlockHours: { next: h(sim[name].map((x) => x.nextBlock)), second: h(sim[name].map((x) => x.secondBlock)) },
      stampToProofHours: { next: h(sim[name].map((x) => x.next)), second: h(sim[name].map((x) => x.second)) },
    };
  }
  // The first of the three: a stamp at a time all three calendars' windows cover; the earliest proof.
  // Windows don't line up across calendars (each walk started from its own dates), so this pairs each calendar's
  // independent draws: the waits are taken as independent, which they are but for a shared busy mempool.
  const n = Math.min(...Object.values(sim).map((x) => x.length));
  const first = { next: [] as number[], second: [] as number[], nextBlock: [] as number[], secondBlock: [] as number[] };
  for (let k = 0; k < n; k++) {
    for (const key of ['next', 'second', 'nextBlock', 'secondBlock'] as const) first[key].push(Math.min(...Object.values(sim).map((x) => x[k][key])));
  }
  const h = (xs: number[]) => ({ median: +(pct(xs, 50) / 3600).toFixed(2), p90: +(pct(xs, 90) / 3600).toFixed(2), p99: +(pct(xs, 99) / 3600).toFixed(2), max: +(Math.max(...xs) / 3600).toFixed(2) });
  year.firstOfThree = {
    stampToBlockHours: { next: h(first.nextBlock), second: h(first.secondBlock) },
    stampToProofHours: { next: h(first.next), second: h(first.second) },
  };
  // `ref` to the anchor's block: ref is 6 deep when the entry is made (its age then: 5 block intervals plus the time
  // since the tip, drawn as above), proof of work takes a minute, then the slowest calendar's wait to its block.
  const refAge: number[] = [];
  for (let k = 0; k < SAMPLES; k++) refAge.push(fiveBlocks(950_000) - Math.log(1 - random()) * meanInterval(950_000));
  year.refToAnchorBlockHours = Object.fromEntries(Object.entries(sim).map(([name, xs]) => [name, h(xs.map((x, k) => refAge[k] + 60 + x.secondBlock))]));
  out.refAgeHours = h(refAge);
  out.recent = recent(fiveBlocks, h, refAge);
  out.note = 'Hours. Cloud session 2026-11-16. Sampled windows of consecutive calendar transactions (see bench/net/REPORT.md, NAMES loop 0); stamps drawn uniformly over the windows; five blocks to the sixth confirmation drawn as exponential intervals at the local mean. `next`: a stamp is in the first calendar transaction mined after it; `second`: in the one after that.';
  out.requests = existsSync(`${CACHE}requests-history.json`) ? JSON.parse(readFileSync(`${CACHE}requests-history.json`, 'utf8')) : {};
  if (lead()) out.lead = `a stamp misses a calendar transaction mined less than ${lead()} s after it (N0b)`;
  writeFileSync(o.out ?? OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify(out, null, 1));
}

// The calendars' status pages list every transaction of their last days with its confirmations: a complete record,
// where the year's walks follow one of the calendar's several UTXO chains (an upper bound on its waits). Heights get
// their times from every block time known (the walks' transactions, the fee-rate series), interpolated.
function recent(fiveBlocks: (h: number) => number, h: (xs: number[]) => unknown, refAge: number[]) {
  const known = new Map<number, number>();
  const series: { avgHeight: number; timestamp: number }[] = JSON.parse(readFileSync(`${CACHE}feerates-1y.json`, 'utf8'));
  for (const x of series) known.set(Math.round(x.avgHeight), x.timestamp);
  for (const f of readdirSync(`${CACHE}tx`)) {
    const v = JSON.parse(readFileSync(`${CACHE}tx/${f}`, 'utf8'));
    for (const st of Array.isArray(v) ? v.map((x: Outspend) => x.status) : [v.status]) if (st?.confirmed) known.set(st.block_height, st.block_time);
  }
  const hs = [...known.keys()].sort((a, b) => a - b);
  const timeOf = (height: number) => {
    let i = hs.findIndex((x) => x >= height);
    if (i < 0) i = hs.length - 1;
    if (hs[i] === height) return known.get(height)!;
    const a = hs[Math.max(0, i - 1)], b = hs[Math.max(1, i)];
    return known.get(a)! + ((known.get(b)! - known.get(a)!) * (height - a)) / (b - a);
  };
  const cals: Record<string, { heights: number[]; times: number[]; best: number }> = {};
  const res: Record<string, unknown> = {};
  for (const name of Object.keys(CAL)) {
    const html = readFileSync(`${CACHE}page-${name}.html`, 'utf8');
    const best = +html.match(/height (\d+)/)![1];
    const rows = [...html.matchAll(/\/tx\/([0-9a-f]{64})\?mode=details">[0-9a-f]+<\/a><\/td>\s*<td[^>]*>([\d.]+)<\/td>\s*<td[^>]*>(\d+)<\/td>/g)];
    const heights = [...new Set(rows.map((r) => best - +r[3] + 1))].sort((a, b) => a - b);
    cals[name] = { heights, times: heights.map(timeOf), best };
    const gaps = heights.slice(1).map((x, i) => x - heights[i]);
    const fees = rows.map((r) => +r[2]);
    res[name] = {
      transactions: rows.length, blocks: `${heights[0]} to ${heights[heights.length - 1]}`,
      from: new Date(cals[name].times[0] * 1000).toISOString().slice(0, 16),
      gapBlocks: { median: pct(gaps, 50), p90: pct(gaps, 90), max: Math.max(...gaps), mean: +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2) },
      feeRate: { min: Math.min(...fees), median: pct(fees, 50), max: Math.max(...fees) },
    };
  }
  // Stamps at every minute of the span all three cover, up to the last transaction of each.
  const start = Math.max(...Object.values(cals).map((c) => c.times[0]));
  const end = Math.min(...Object.values(cals).map((c) => c.times[c.times.length - 1]));
  const per: Record<string, { block: number[]; proof: number[]; second: number[] }> = {};
  const firstBlock: number[] = [], firstProof: number[] = [];
  for (const name of Object.keys(cals)) per[name] = { block: [], proof: [], second: [] };
  for (let s = start; s < end - lead(); s += 60) {
    let fb = Infinity, fp = Infinity;
    for (const [name, c] of Object.entries(cals)) {
      const i = c.times.findIndex((t) => t > s + lead());
      const block = c.times[i] - s, proof = block + fiveBlocks(c.heights[i]);
      per[name].block.push(block);
      per[name].proof.push(proof);
      const j = Math.min(i + 1, c.times.length - 1);
      per[name].second.push(c.times[j] - s);
      fb = Math.min(fb, block);
      fp = Math.min(fp, proof);
    }
    firstBlock.push(fb);
    firstProof.push(fp);
  }
  for (const name of Object.keys(cals)) {
    Object.assign(res[name] as object, { stampToBlockHours: { next: h(per[name].block), second: h(per[name].second) }, stampToProofHours: h(per[name].proof) });
  }
  // Each calendar on its own: its whole recent span (finney's is four weeks).
  for (const [name, c] of Object.entries(cals)) {
    const block: number[] = [], proof: number[] = [];
    for (let s = c.times[0]; s < c.times[c.times.length - 1] - lead(); s += 60) {
      const i = c.times.findIndex((t) => t > s + lead());
      block.push(c.times[i] - s);
      proof.push(c.times[i] - s + fiveBlocks(c.heights[i]));
    }
    Object.assign(res[name] as object, { ownSpan: { stampToBlockHours: h(block), stampToProofHours: h(proof) } });
  }
  res.commonSpan = `${new Date(start * 1000).toISOString().slice(0, 16)} to ${new Date(end * 1000).toISOString().slice(0, 16)}`;
  res.firstOfThree = { stampToBlockHours: h(firstBlock), stampToProofHours: h(firstProof) };
  res.refToAnchorBlockHours = Object.fromEntries(Object.entries(per).map(([name, x]) => [name, h(x.block.map((b, k) => refAge[k % refAge.length] + 60 + b))]));
  return res;
}

if (import.meta.main) {
  if (positionals[0] === 'fetch') await fetchAll();
  else if (positionals[0] === 'model') model();
  else throw new Error('usage: ots-history.ts fetch|model');
}
