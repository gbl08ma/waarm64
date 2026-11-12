// R4 (docs/networking/rooms.md "Numbers"): rooms on public servers, from this machine, with Node members
// (bench/net/room-member.ts: the Rust client, relay only). Two parts:
// - `nostr`: each public Nostr relay against §7's "What a room needs from a Nostr relay", a fresh private room on it
//   alone with its DERP the public tailcat region `--derp`: whether a lookup gets through at all (the kind forwarded
//   under its `#x` filter: the first echo comes back), the time from the first echo sent to its return (the lookup, the
//   call back, then DERP), DERP's RTT after it for comparison, the same with both members' clocks `--ahead` seconds
//   fast (events dated ahead of the relay's clock), and a burst of lookups to absent members at the guest's cap (8 a
//   second for 2 s) before a real one; and what the relay said (refusals, notices, CLOSED), from the members' logs.
// - `derp`: each public tailcat region carrying a room, the lookups on the tests' own relay (tests/net/nostr-relay.ts,
//   on loopback, so only DERP is public): the first echo, the RTT (one at a time), and throughput (1,232-byte UDP
//   payloads, 32 in flight, `--mb` megabytes each way).
// Usage: node bench/net/room-public.ts [nostr|derp|both] [--out out.json] [--derp 303] [--relays wss://a,wss://b]
//   [--ahead 60,600] [--mb 4] [--parallel 6]
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { parseArgs } from 'node:util';
import { startMember, type Member } from './room-member.ts';
import { startNostrRelay } from '../../tests/net/nostr-relay.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' }, derp: { type: 'string', default: '303' }, relays: { type: 'string' },
    ahead: { type: 'string', default: '60,600' }, mb: { type: 'string', default: '4' }, parallel: { type: 'string', default: '6' },
  },
});
const what = positionals[0] ?? 'both';

// Ours (net/ts/src/room/link.rs DEFAULT_NOSTR), then Trystero 0.26.0's (packages/nostr/src/index.ts, its maintained list).
const OURS = ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.primal.net'];
const TRYSTERO = [
  '0x-nostr-relay.fly.dev', 'bendernostur.duckdns.org:8443', 'cdn.satellite.earth', 'nos.lol', 'nostr.chaima.info',
  'nostr.christiansass.de', 'nostr.rblb.it', 'nostr.red5d.dev', 'nostr.robosats.org', 'nostr.stakey.net',
  'nostrcity-club.fly.dev', 'relay-dev.gulugulu.moe', 'relay.aarpia.com', 'relay.agentry.com', 'relay.bitmacro.cloud',
  'relay.bullishbounty.com', 'relay.degmods.com', 'relay.flashapp.me', 'relay.grigic.org', 'relay.hackshed.dev',
  'relay.kaleidoswap.com', 'relay.layer.systems', 'relay.nostr.blockhenge.com', 'relay.nostr.dev.br', 'relay.nostrmap.net',
  'relay.novospes.com', 'relay.piazza.today', 'relay.routstr.com', 'testr.nymble.world',
].map((h) => `wss://${h}`);
const relays = o.relays ? o.relays.split(',') : [...new Set([...OURS, ...TRYSTERO])];
const REGIONS = [301, 302, 303, 304];

const wasm = await WebAssembly.compile(readFileSync(`${ROOT}target/net/ts.wasm`));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const linkOf = (nostr: string, derp: string) =>
  `webpc-room:${encodeURIComponent(`r4-${randomBytes(16).toString('hex')}`)}?nostr=${encodeURIComponent(nostr)}&derp=${encodeURIComponent(derp)}`;

/** Members of one room, each Running within `ms` (or failed: the reason). */
async function members(link: string, n: number, unixOffset = 0, ms = 20_000): Promise<Member[] | string> {
  const unixTime = unixOffset ? Math.floor(Date.now() / 1000) + unixOffset : undefined;
  const ms_ = await Promise.all(Array.from({ length: n }, () => startMember(wasm, { link, unixTime })));
  const t = performance.now();
  while (performance.now() - t < ms && ms_.some((m) => m.runningMs === undefined && !m.failed)) await sleep(100);
  const bad = ms_.find((m) => m.runningMs === undefined);
  if (bad) {
    const why = bad.failed ?? 'not Running in time';
    for (const m of ms_) m.close();
    return `${why}; ${bad.logs.slice(-3).join(' | ')}`;
  }
  return ms_;
}

/** What relays said, from the members' logs (refusals, notices, CLOSED, no answer). */
const said = (ms: Member[]) => [...new Set(ms.flatMap((m) => m.logs.filter((l) => /^Nostr:/.test(l))))].slice(0, 10);

/** A lookup through `nostr` alone: the first echo's time (-1: none in `ms`) and DERP's RTT after it. */
async function lookup(nostr: string, unixOffset = 0, ms = 15_000) {
  const ms_ = await members(linkOf(nostr, o.derp!), 2, unixOffset);
  if (typeof ms_ === 'string') return { error: ms_ };
  const [a, b] = ms_;
  try {
    const firstMs = await a.ping(b.address6, ms);
    const rttMs = firstMs >= 0 ? median((await a.echoes(b.address6, 5, 32, 1, 2000)).rtts) : undefined;
    return { firstMs, rttMs, said: said(ms_) };
  } finally {
    for (const m of ms_) m.close();
  }
}

/** Lookups to absent members at the guest's cap (8 a second, for 2 s), then one to a real member. */
async function burst(nostr: string, ms = 15_000) {
  const ms_ = await members(linkOf(nostr, o.derp!), 2);
  if (typeof ms_ === 'string') return { error: ms_ };
  const [a, b] = ms_;
  try {
    const absent = (k: number) => [...b.address6.slice(0, 6), ...randomBytes(9), k];
    const pending = [];
    for (let k = 0; k < 16; k++) {
      pending.push(a.echoes(absent(k), 1, 32, 1, 500));
      await sleep(125);
    }
    await Promise.all(pending);
    const firstMs = await a.ping(b.address6, ms);
    return { firstMs, said: said(ms_) };
  } finally {
    for (const m of ms_) m.close();
  }
}

async function pool<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < xs.length) {
      const k = next++;
      out[k] = await f(xs[k]);
    }
  }));
  return out;
}

const results: Record<string, unknown> = {
  date: new Date().toISOString(), host: `${process.platform} ${process.arch}`, cpus: cpus().length, derp: o.derp,
};

if (what === 'nostr' || what === 'both') {
  const ahead = o.ahead!.split(',').map(Number).filter((x) => x);
  results.nostr = await pool(relays, Number(o.parallel), async (url) => {
    const r: Record<string, unknown> = { url, now: await lookup(url) };
    if (!('error' in (r.now as object)) && (r.now as { firstMs: number }).firstMs >= 0) {
      for (const s of ahead) r[`ahead${s}`] = await lookup(url, s);
      r.burst = await burst(url);
    }
    console.log(JSON.stringify(r));
    return r;
  });
}

if (what === 'derp' || what === 'both') {
  const relay = await startNostrRelay();
  const n = Math.round(Number(o.mb) * 1e6 / 1232);
  const derp: unknown[] = [];
  try {
    for (const region of REGIONS) {
      const ms_ = await members(linkOf(relay.url, String(region)), 2);
      if (typeof ms_ === 'string') {
        derp.push({ region, error: ms_ });
        console.log(JSON.stringify(derp.at(-1)));
        continue;
      }
      const [a, b] = ms_;
      try {
        const firstMs = await a.ping(b.address6, 15_000);
        const rtt = await a.echoes(b.address6, 20, 32, 1, 3000);
        const tp = await a.echoes(b.address6, n, 1232, 32, 5000);
        derp.push({
          region, runningMs: Math.max(a.runningMs!, b.runningMs!), firstMs, rttMs: median(rtt.rtts), rttBack: rtt.back,
          packets: n, back: tp.back, mbpsEachWay: tp.back * 1232 * 8 / (tp.ms / 1000) / 1e6, tpRttMs: median(tp.rtts),
          said: [...new Set([...a.logs, ...b.logs].filter((l) => /DERP|derp|relay/i.test(l)))].slice(0, 10),
        });
      } finally {
        for (const m of ms_) m.close();
      }
      console.log(JSON.stringify(derp.at(-1)));
    }
  } finally {
    await relay.close();
  }
  results.derp = derp;
}

if (o.out) writeFileSync(`${ROOT}${o.out}`, `${JSON.stringify(results, null, 1)}\n`);
process.exit(0);
