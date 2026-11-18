// NAMES loop 0c (docs/plans/room-names.md "Measure first", items 5 and 6, and what R2 and R3 left to measure on public
// services; bench/net/REPORT.md "NAMES loop 0c"), from this machine. A few hundred small requests a service at most,
// never a load test; tailcat's DERP for one transfer a size.
// - `relays`: whether each default Nostr relay (net/ts/src/room/link.rs DEFAULT_NOSTR) forwards an ephemeral event of
//   the room's kind (26354, an `x` tag, base64 content, as room.rs `publish_reply` makes a reply) at growing sizes, the
//   largest a reply can be (`REPLY_SEALED_MAX`, wire.rs) among them: one subscriber, one publisher, each event once.
// - `explorers`: the explorers' answers for blocks that don't exist (status, CORS headers: R2's block refusal needs a
//   page to see a 404), then a first sync's block checks at the module's pace (`check_every_ms`, one `block/<hash>/header`
//   every 3 s) against real blocks of the last weeks, each explorer `--n` times.
// - `transfer`, `client`, `lookup`: two or three room nodes on the tests' module (target/net/ts-test.wasm, the tests'
//   cheap proof of work and easy headers; titles from net/ts/examples/names-title.rs), relay only, the link's relays the
//   six defaults and its DERP one public tailcat region (`--derp`, default 303 Frankfurt):
//   - `transfer --mb 5`: server A holds titles of about that many bytes, server B none of them; the time until B's
//     registry holds them all (B's sync with A through the names clients' DERP, 8 parts in flight), B's guest pinging
//     A's guest once a second beside it (the RTTs before, during and after).
//   - `client`: what a second room client (the names client) costs a node: memory, connections, idle CPU over `--idle`
//     seconds, a server (one title: its names client up) against a member that never asks a name.
//   - `lookup`: a member's cold first lookup of a name two servers hold (R3's `ask`/`reply` through the relays), then the
//     same name again (kept) and a second name (a room asked before: the names client up), `--rounds` fresh members.
// Usage: node bench/net/names-public.ts <relays|explorers|transfer|client|lookup> [--out results/x.json] [...]
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { parseArgs } from 'node:util';

const ROOT = new URL('../..', import.meta.url).pathname;
const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' }, relays: { type: 'string' }, derp: { type: 'string', default: '303' },
    n: { type: 'string', default: '100' }, every: { type: 'string', default: '3000' }, mb: { type: 'string', default: '5' },
    idle: { type: 'string', default: '60' }, rounds: { type: 'string', default: '5' }, sizes: { type: 'string' },
  },
});
const what = positionals[0];
const DEFAULT_NOSTR = ['wss://relay.primal.net', 'wss://relay.novospes.com', 'wss://relay.routstr.com', 'wss://nostr.rblb.it', 'wss://relay.degmods.com', 'wss://relay.nostrmap.net'];
const EXPLORERS = ['https://blockstream.info/api', 'https://mempool.space/api'];
const KIND = 26354;
/** wire.rs: the most bytes a sealed reply may have (`32 + REPLY_HEAD + REPLY_MAX + 16 + 16`, REPLY_MAX 4096). */
const REPLY_SEALED_MAX = 32 + (16 + 32 + 2 + 4 + 1) + 4096 + 16 + 16;
const UA = 'Mozilla/5.0 (X11; Linux aarch64) bench';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Record<string, unknown> = { date: new Date().toISOString(), host: `${process.platform} ${process.arch}`, cpus: cpus().length, node: process.version };

// ---- BIP-340 (Nostr's signatures), BigInt: a few dozen events, so slow is fine ----
const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G: [bigint, bigint] = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const mod = (a: bigint, m = P) => ((a % m) + m) % m;
function pow(b: bigint, e: bigint, m = P) {
  let r = 1n;
  b = mod(b, m);
  for (; e > 0n; e >>= 1n, b = (b * b) % m) if (e & 1n) r = (r * b) % m;
  return r;
}
type Pt = [bigint, bigint] | null;
function add(a: Pt, b: Pt): Pt {
  if (!a) return b;
  if (!b) return a;
  if (a[0] === b[0] && mod(a[1] + b[1]) === 0n) return null;
  const l = a[0] === b[0] ? mod(3n * a[0] * a[0] * pow(2n * a[1], P - 2n)) : mod((b[1] - a[1]) * pow(b[0] - a[0], P - 2n));
  const x = mod(l * l - a[0] - b[0]);
  return [x, mod(l * (a[0] - x) - a[1])];
}
function mul(k: bigint, p: Pt = G): Pt {
  let r: Pt = null;
  for (; k > 0n; k >>= 1n, p = add(p, p)) if (k & 1n) r = add(r, p);
  return r;
}
const big = (b: Uint8Array) => BigInt(`0x${Buffer.from(b).toString('hex') || '0'}`);
const bytes32 = (x: bigint) => Buffer.from(x.toString(16).padStart(64, '0'), 'hex');
const sha = (...b: Uint8Array[]) => createHash('sha256').update(Buffer.concat(b)).digest();
const tagged = (tag: string, ...b: Uint8Array[]) => { const t = sha(Buffer.from(tag)); return sha(t, t, ...b); };
function schnorr(msg: Uint8Array, sk: Uint8Array, aux: Uint8Array = randomBytes(32)) {
  const d0 = big(sk);
  const p = mul(d0)!;
  const d = p[1] % 2n === 0n ? d0 : N - d0;
  const t = bytes32(d ^ big(tagged('BIP0340/aux', aux)));
  const k0 = mod(big(tagged('BIP0340/nonce', t, bytes32(p[0]), msg)), N);
  const r = mul(k0)!;
  const k = r[1] % 2n === 0n ? k0 : N - k0;
  const e = mod(big(tagged('BIP0340/challenge', bytes32(r[0]), bytes32(p[0]), msg)), N);
  return { pub: bytes32(p[0]).toString('hex'), sig: Buffer.concat([bytes32(r[0]), bytes32(mod(k + e * d, N))]).toString('hex') };
}
// BIP-340's test vector 0, so a relay's "invalid signature" is the relay's.
if (schnorr(new Uint8Array(32), bytes32(3n), new Uint8Array(32)).sig.toUpperCase() !== 'E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0') throw new Error('BIP-340 vector 0');

function nostrEvent(sk: Uint8Array, x: string, content: string) {
  const { pub } = schnorr(new Uint8Array(32), sk); // the public key only
  const created_at = Math.floor(Date.now() / 1000);
  const tags = [['x', x]];
  const id = sha(Buffer.from(JSON.stringify([0, pub, created_at, KIND, tags, content])));
  return { id: id.toString('hex'), pubkey: pub, created_at, kind: KIND, tags, content, sig: schnorr(id, sk).sig };
}

/** A WebSocket's messages as a queue, with a wait for one that matches. */
function socket(url: string) {
  const ws = new WebSocket(url);
  const got: unknown[][] = [];
  const waiters: (() => void)[] = [];
  ws.onmessage = (m) => {
    try { got.push(JSON.parse(String(m.data))); } catch { /* not JSON */ }
    for (const w of waiters.splice(0)) w();
  };
  const open = new Promise<boolean>((res) => { ws.onopen = () => res(true); ws.onerror = () => res(false); ws.onclose = () => res(false); });
  return {
    ws, got, open,
    async wait(f: (m: unknown[]) => boolean, ms: number) {
      const t = performance.now();
      for (;;) {
        const m = got.find(f);
        if (m) return { m, ms: performance.now() - t };
        const left = ms - (performance.now() - t);
        if (left <= 0) return undefined;
        await new Promise<void>((r) => { waiters.push(r); setTimeout(r, left); });
      }
    },
  };
}

async function relaySizes(url: string, raws: number[]) {
  const sub = socket(url);
  const pub = socket(url);
  const r: Record<string, unknown> = { url };
  try {
    if (!(await sub.open) || !(await pub.open)) return { ...r, error: 'no connection' };
    const x = randomBytes(32).toString('hex');
    sub.ws.send(JSON.stringify(['REQ', 's', { kinds: [KIND], '#x': [x], limit: 0 }]));
    const eose = await sub.wait((m) => m[0] === 'EOSE' || m[0] === 'CLOSED', 3000);
    r.eose = eose ? `${eose.m[0]} ${Math.round(eose.ms)} ms` : 'none in 3 s';
    const sk = randomBytes(32);
    const sizes: unknown[] = [];
    for (const raw of raws) {
      const content = randomBytes(raw).toString('base64');
      const e = nostrEvent(sk, x, content);
      const t = performance.now();
      pub.ws.send(JSON.stringify(['EVENT', e]));
      const ok = await pub.wait((m) => m[0] === 'OK' && m[1] === e.id, 5000);
      const came = await sub.wait((m) => m[0] === 'EVENT' && (m[2] as { id?: string })?.id === e.id, Math.max(0, 5000 - (performance.now() - t)));
      const notices = pub.got.filter((m) => m[0] === 'NOTICE' || m[0] === 'CLOSED').map((m) => String(m.at(-1))).slice(-2);
      sizes.push({ raw, content: content.length, message: JSON.stringify(['EVENT', e]).length, ok: ok ? ok.m[2] : 'no OK', said: ok ? ok.m[3] : undefined, forwarded: !!came, ms: came ? Math.round(performance.now() - t) : undefined, notices: notices.length ? notices : undefined, open: pub.ws.readyState === 1 });
      console.log(`${url} ${raw}: ${JSON.stringify(sizes.at(-1))}`);
      if (pub.ws.readyState !== 1) break;
      await sleep(500);
    }
    r.sizes = sizes;
    return r;
  } finally {
    sub.ws.close();
    pub.ws.close();
  }
}

if (what === 'relays') {
  const relays = o.relays ? o.relays.split(',') : DEFAULT_NOSTR;
  const raws = o.sizes ? o.sizes.split(',').map(Number) : [1000, 2000, REPLY_SEALED_MAX, 8192, 16384, 32768, 65536, 131072];
  results.replySealedMax = REPLY_SEALED_MAX;
  results.relays = await Promise.all(relays.map((u) => relaySizes(u, raws)));
}

// ---- Explorers ----
async function get(url: string, origin = 'https://example.org') {
  const t = performance.now();
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, origin }, signal: AbortSignal.timeout(20_000) });
    const body = await r.text();
    const h = (k: string) => r.headers.get(k) ?? undefined;
    return { status: r.status, ms: Math.round(performance.now() - t), acao: h('access-control-allow-origin'), body: body.slice(0, 80), retryAfter: h('retry-after'), limit: h('x-ratelimit-remaining') };
  } catch (e) {
    return { status: 0, ms: Math.round(performance.now() - t), error: String(e) };
  }
}

if (what === 'explorers') {
  const zero = '00'.repeat(32);
  const random = randomBytes(32).toString('hex');
  const notFound: unknown[] = [];
  for (const e of EXPLORERS) {
    for (const path of [`block/${zero}/header`, `block/${random}/header`, `block/${random.slice(0, 63)}/header`, 'block-height/99999999']) {
      notFound.push({ url: `${e}/${path}`, ...(await get(`${e}/${path}`)) });
      console.log(JSON.stringify(notFound.at(-1)));
    }
  }
  results.notFound = notFound;
  // Real blocks of the last weeks (a registry's anchors are within a term and a grace: ~5,300 blocks), 10 a request
  // from Esplora's `blocks/<height>`, at heights spread over them.
  const tip = Number((await get(`${EXPLORERS[0]}/blocks/tip/height`)).body);
  const n = Number(o.n);
  const hashes: string[] = [];
  for (let k = 0; hashes.length < n; k++) {
    const h = tip - Math.floor((k * 5300) / Math.ceil(n / 10)) - 10;
    const r = await fetch(`${EXPLORERS[k % 2]}/blocks/${h}`, { headers: { 'user-agent': UA } });
    for (const b of (await r.json()) as { id: string }[]) hashes.push(b.id);
    await sleep(1000);
  }
  results.tip = tip;
  // Both explorers in step, each its own blocks (a server asks one, the other only when it fails).
  const runs = await Promise.all(EXPLORERS.map(async (e, i) => {
    const answers: { status: number; ms: number }[] = [];
    const mine = hashes.slice(0, n).map((h, k) => hashes[(k + i * 7) % n]);
    for (const h of mine) {
      const t = performance.now();
      const r = await get(`${e}/block/${h}/header`);
      answers.push({ status: r.status, ms: r.ms });
      if (r.status !== 200) console.log(`${e} ${h}: ${JSON.stringify(r)}`);
      await sleep(Math.max(0, Number(o.every) - (performance.now() - t)));
    }
    const ms = answers.filter((a) => a.status === 200).map((a) => a.ms).sort((a, b) => a - b);
    const by: Record<number, number> = {};
    for (const a of answers) by[a.status] = (by[a.status] ?? 0) + 1;
    const s = { explorer: e, asked: answers.length, every: Number(o.every), statuses: by, medianMs: ms[Math.floor(ms.length / 2)], p90Ms: ms[Math.floor(ms.length * 0.9)], maxMs: ms.at(-1) };
    console.log(JSON.stringify(s));
    return s;
  }));
  results.checks = runs;
  results.requests = { [EXPLORERS[0]]: 4 + 1 + Math.ceil(n / 20) + n, [EXPLORERS[1]]: 4 + Math.ceil(n / 20) + n };
}

// The page's view of a block that doesn't exist: fetch from a cross-origin-isolated page in headless Chromium (the dev
// server's COOP/COEP), as web/names.ts `serviceFetch` fetches: whether the 404 is seen (CORS) or the fetch fails.
if (what === 'cors') {
  const { chromium } = await import('playwright-core');
  const { startServer } = await import('../../tools/serve.ts');
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    const urls = EXPLORERS.flatMap((e) => [`${e}/block/${randomBytes(32).toString('hex')}/header`, `${e}/block/${'00'.repeat(32)}/header`]);
    results.cors = await page.evaluate(async (urls) => Promise.all(urls.map(async (url) => {
      try {
        const r = await fetch(url);
        return { url, isolated: crossOriginIsolated, status: r.status, body: (await r.text()).slice(0, 40) };
      } catch (e) {
        return { url, isolated: crossOriginIsolated, error: String(e) };
      }
    })), urls);
    console.log(JSON.stringify(results.cors, null, 1));
    results.chromium = browser.version();
  } finally {
    await browser.close();
    server.close();
  }
}

// ---- Room nodes, each in a process of its own (`node`: forked), so its CPU and connections are its own ----
type Sock = { url: string; opened: number; closed?: number; in: number; out: number };
type FromNode =
  | { t: 'self'; key: string; address6: number[]; tag: string }
  | { t: 'running'; ms: number }
  | { t: 'names'; at: number; names: number; servers: number; serving: boolean }
  | { t: 'tick'; at: number; socks: Sock[] }
  | { t: 'rtt'; at: number; ms: number }
  | { t: 'answer'; name: string; ms: number; rcode: number; answers: number; tries: number }
  | { t: 'stats'; memory: number; rss: number; cpuUs: number; socks: Sock[]; logs: string[] }
  | { t: 'log'; at: number; msg: string }
  | { t: 'error'; error: string };
type ToNode =
  | { cmd: 'start'; link: string; titles?: { key: string; item: string }[]; maxNames?: number }
  | { cmd: 'ping'; to: number[]; every: number }
  | { cmd: 'stop-ping' }
  | { cmd: 'ask'; name: string; ms: number }
  | { cmd: 'stats' };

if (what === 'node') {
  const { startMember } = await import('./room-member.ts');
  const { dnsQuery, udp } = await import('../../tests/net/packets.ts');
  const send = (m: FromNode) => process.send!(m);
  // Every WebSocket's bytes both ways (the node's relays and DERP, then its names client's).
  const socks: Sock[] = [];
  const Real = globalThis.WebSocket;
  const size = (d: unknown) => (typeof d === 'string' ? Buffer.byteLength(d) : d instanceof ArrayBuffer ? d.byteLength : ArrayBuffer.isView(d) ? d.byteLength : 0);
  globalThis.WebSocket = class extends Real {
    sock: Sock;
    constructor(url: string | URL, p?: string | string[]) {
      super(url, p);
      const s: Sock = { url: String(url).replace(/\?.*/, ''), opened: Date.now(), in: 0, out: 0 };
      this.sock = s;
      socks.push(s);
      this.addEventListener('message', (e) => { s.in += size(e.data); });
      this.addEventListener('close', () => { s.closed = Date.now(); });
    }
    override send(d: string | Blob | BufferSource) {
      super.send(d);
      this.sock.out += size(d);
    }
  } as typeof WebSocket;
  const t0 = Date.now();
  let m: Awaited<ReturnType<typeof startMember>> | undefined;
  let tag = '';
  let pinging = false;
  const dnsWait = new Map<number, (d: Uint8Array) => void>();
  const v6s = (b: number[]) => Array.from({ length: 8 }, (_, k) => ((b[2 * k] << 8) | b[2 * k + 1]).toString(16)).join(':');
  let qid = 1;
  setInterval(() => send({ t: 'tick', at: Date.now(), socks }), 1000).unref();
  process.on('message', async (c: ToNode) => {
    try {
      if (c.cmd === 'start') {
        const wasm = await WebAssembly.compile(readFileSync(`${ROOT}target/net/ts-test.wasm`));
        m = await startMember(wasm, {
          link: c.link,
          ...(c.titles ? { names: { titles: c.titles, maxNames: c.maxNames } } : {}),
          packet(p) {
            if (p[0] >> 4 === 6 && p[6] === 17 && p.length > 60 && ((p[40] << 8) | p[41]) === 53) dnsWait.get((p[48] << 8) | p[49])?.(p.subarray(48));
          },
          event(e) {
            if (e.type === 'self') tag = e.tag ?? '';
            if (e.type === 'log' && /^names/.test(e.msg)) send({ t: 'log', at: Date.now(), msg: e.msg });
            if (e.type === 'names') send({ t: 'names', at: Date.now(), names: e.names, servers: e.servers, serving: e.serving });
            if (e.type === 'state' && e.state === 'Running') send({ t: 'running', ms: Date.now() - t0 });
            if (e.type === 'state' && e.state === 'Failed') send({ t: 'error', error: `Failed: ${e.code}` });
          },
        });
        send({ t: 'self', key: m.key, address6: m.address6, tag });
      } else if (c.cmd === 'ping') {
        pinging = true;
        while (pinging && m) {
          const t = Date.now();
          const r = await m.echoes(c.to, 1, 32, 1, 3000);
          send({ t: 'rtt', at: t, ms: r.back ? r.rtts[0] : -1 });
          await sleep(Math.max(0, c.every - (Date.now() - t)));
        }
      } else if (c.cmd === 'stop-ping') {
        pinging = false;
      } else if (c.cmd === 'ask' && m) {
        // As a guest's resolver asks: again after a SERVFAIL or no answer in 5 s, until an answer or `ms`.
        const me = v6s(m.address6);
        const resolver = v6s([...m.address6.slice(0, 6), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x53]);
        const t = performance.now();
        let tries = 0;
        let last = { rcode: -1, answers: 0 };
        while (performance.now() - t < c.ms) {
          const id = qid++;
          tries++;
          const d = await new Promise<Uint8Array | undefined>((res) => {
            const timer = setTimeout(() => { dnsWait.delete(id); res(undefined); }, 5000);
            dnsWait.set(id, (d) => { clearTimeout(timer); dnsWait.delete(id); res(d); });
            m!.client.guest(udp(me, 40000 + (id % 20000), resolver, 53, dnsQuery(id, `${c.name}.${tag}.p2p.internal`, 28)));
          });
          if (d) {
            last = { rcode: d[3] & 15, answers: (d[6] << 8) | d[7] };
            if (last.rcode === 3 || (last.rcode === 0 && last.answers > 0)) break;
            if (last.rcode !== 2) await sleep(200);
          }
        }
        send({ t: 'answer', name: c.name, ms: performance.now() - t, ...last, tries });
      } else if (c.cmd === 'stats' && m) {
        const u = process.cpuUsage();
        send({ t: 'stats', memory: m.memory(), rss: process.memoryUsage().rss, cpuUs: u.user + u.system, socks, logs: m.logs.slice(-40) });
      }
    } catch (e) {
      send({ t: 'error', error: String((e as Error).stack ?? e) });
    }
  });
} else if (['transfer', 'client', 'lookup'].includes(what)) {
  const { fork } = await import('node:child_process');
  const LOCAL = `${ROOT}bench/results/local/names0c`;
  execFileSync('mkdir', ['-p', LOCAL]);
  const TITLE_TOOL = `${ROOT}target/debug/examples/names-title`;
  type Node = { name: string; msgs: FromNode[]; send(c: ToNode): void; next<T extends FromNode['t']>(t: T, ms: number, f?: (m: Extract<FromNode, { t: T }>) => boolean): Promise<Extract<FromNode, { t: T }>>; kill(): void };
  const nodes: Node[] = [];
  function spawnNode(name: string): Node {
    const p = fork(new URL(import.meta.url).pathname, ['node'], { execArgv: ['--disable-warning=ExperimentalWarning', '--max-old-space-size=3072'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const msgs: FromNode[] = [];
    const waiters: (() => void)[] = [];
    p.on('message', (m: FromNode) => {
      msgs.push(m);
      if (m.t === 'error') console.log(`# ${name}: ${m.error}`);
      for (const w of waiters.splice(0)) w();
    });
    const n: Node = {
      name, msgs,
      send: (c) => p.send(c),
      async next(t, ms, f = () => true) {
        const t0 = Date.now();
        const seen = msgs.length;
        for (;;) {
          const m = msgs.slice(seen).find((x) => x.t === t && f(x as never));
          if (m) return m as never;
          if (Date.now() - t0 > ms) throw new Error(`${name}: no ${t} in ${ms} ms`);
          await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 250); });
        }
      },
      kill: () => p.kill(),
    };
    nodes.push(n);
    return n;
  }
  const stats = async (n: Node) => { n.send({ cmd: 'stats' }); return n.next('stats', 10_000); };
  /** Titles on the tests' pretend Bitcoin for `room` (net/ts/examples/names-title.rs), anchors a calendar's depth. */
  function titles(room: string, names: string[]): { key: string; item: string }[] {
    const spec = `${LOCAL}/spec-${process.pid}.json`;
    writeFileSync(spec, JSON.stringify({
      room, levels: 30,
      titles: names.map((name) => ({ name, secret: 7, claimDaysAgo: 20, renewDaysAgo: [4], zones: [{ seq: 1, points: [{ label: null, key: randomBytes(32).toString('hex') }] }] })),
    }));
    const out = JSON.parse(execFileSync(TITLE_TOOL, [`@${spec}`], { encoding: 'utf8', maxBuffer: 1 << 30 })) as { key: string; items: string[] }[];
    return out.map((t) => ({ key: t.key, item: t.items[0] }));
  }
  const room = `names0c-${randomBytes(12).toString('hex')}`;
  // The six default relays (no `nostr=`: link.rs DEFAULT_NOSTR) and one public tailcat region.
  const link = `waarm64-room:${encodeURIComponent(room)}?derp=${encodeURIComponent(o.derp!)}`;
  results.derp = o.derp;
  const up = async (n: Node, c: ToNode & { cmd: 'start' }) => {
    n.send(c);
    const self = await n.next('self', 120_000);
    const run = await n.next('running', 60_000);
    return { ...self, runningMs: run.ms };
  };
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
  try {
    if (what === 'transfer') {
      const each = 3091; // an item's bytes at levels 30, two entries and a zone (measured)
      const count = Math.ceil((Number(o.mb) * 1e6) / each);
      const tg = performance.now();
      const ta = titles(room, Array.from({ length: count }, (_, k) => `n${k.toString().padStart(6, '0')}`));
      const tb = titles(room, ['bserver']);
      const bytes = ta.reduce((s, t) => s + t.item.length / 2, 0);
      console.log(`# ${count} titles, ${(bytes / 1e6).toFixed(2)} MB of items, made in ${Math.round(performance.now() - tg)} ms`);
      const a = spawnNode('A');
      const b = spawnNode('B');
      const ta0 = Date.now();
      const sa = await up(a, { cmd: 'start', link, titles: ta, maxNames: count + 100 });
      console.log(`# A up in ${Date.now() - ta0} ms (titles verified at the start)`);
      const sb = await up(b, { cmd: 'start', link, titles: tb });
      // RTTs before the transfer: B's guest to A's (the nodes' own DERP connections).
      const rtt = (from: number, to: number) => b.msgs.filter((m): m is Extract<FromNode, { t: 'rtt' }> => m.t === 'rtt' && m.at >= from && m.at < to).map((m) => m.ms);
      b.send({ cmd: 'ping', to: sa.address6, every: 1000 });
      const tStart = Date.now();
      // B's names: its own, then A's as the sync brings them in.
      const want = count + 1;
      let done: number | undefined;
      const limit = Number(process.env.TRANSFER_MS ?? 470_000);
      try {
        await b.next('names', limit, (m) => m.names >= want);
        done = Date.now();
      } catch { /* out of time: what came is reported */ }
      const tEnd = Date.now();
      await sleep(10_000);
      b.send({ cmd: 'stop-ping' });
      const namesB = b.msgs.filter((m): m is Extract<FromNode, { t: 'names' }> => m.t === 'names');
      const firstName = namesB.find((m) => m.names > 1)?.at;
      const ticks = b.msgs.filter((m): m is Extract<FromNode, { t: 'tick' }> => m.t === 'tick');
      const last = ticks.at(-1)!.socks;
      // The names client's DERP connection: the DERP socket B opened after its node's.
      const derpSocks = last.filter((s) => !s.url.startsWith('wss://relay') && !s.url.includes('nostr'));
      const namesSock = derpSocks.length > 1 ? derpSocks.at(-1) : undefined;
      const inAt = (at: number) => { const tk = ticks.filter((t) => t.at <= at).at(-1); return tk?.socks.find((s) => s.opened === namesSock?.opened)?.in ?? 0; };
      // When the names client's bytes stopped growing (within 1%).
      const lastIn = inAt(tEnd);
      const bytesDone = ticks.find((t) => (t.socks.find((s) => s.opened === namesSock?.opened)?.in ?? 0) >= lastIn * 0.99)?.at;
      const pre = rtt(tStart - 60_000, firstName ?? tStart);
      const during = rtt(firstName ?? tStart, done ?? tEnd);
      const after = rtt((done ?? tEnd), tEnd + 10_000);
      const r = {
        mb: Number(o.mb), names: count, itemBytes: bytes, runningA: sa.runningMs, runningB: sb.runningMs,
        firstNameMs: firstName ? firstName - tStart : undefined, allNamesMs: done ? done - tStart : undefined,
        namesAtEnd: namesB.at(-1)?.names, bytesInNamesDerp: lastIn, bytesDoneMs: bytesDone ? bytesDone - tStart : undefined,
        mbpsBytes: bytesDone && firstName ? (lastIn * 8) / ((bytesDone - firstName) / 1000) / 1e6 : undefined,
        progress: namesB.filter((_, k) => k % 10 === 0).map((m) => [m.at - tStart, m.names]),
        rttMs: { before: { n: pre.length, median: median(pre.filter((x) => x >= 0)) }, during: { n: during.length, lost: during.filter((x) => x < 0).length, median: median(during.filter((x) => x >= 0)), p90: q(during.filter((x) => x >= 0), 0.9), max: Math.max(...during) }, after: { n: after.length, median: median(after.filter((x) => x >= 0)) } },
        socksB: last, statsA: await stats(a), statsB: await stats(b),
        // The names clients' own lines (not their relays'), ms from B's start of pinging.
        namesLogs: Object.fromEntries([a, b].map((n) => [n.name, n.msgs.filter((m): m is Extract<FromNode, { t: 'log' }> => m.t === 'log' && !/Nostr:/.test(m.msg)).map((m) => [m.at - tStart, m.msg]).slice(0, 60)])),
      };
      (r.statsA as { logs?: string[] }).logs = (r.statsA as { logs: string[] }).logs.slice(-10);
      (r.statsB as { logs?: string[] }).logs = (r.statsB as { logs: string[] }).logs.slice(-15);
      console.log(JSON.stringify({ ...r, progress: undefined, socksB: undefined }, null, 1));
      results.transfer = r;
    } else if (what === 'client') {
      // A server (one title: its names client up from the start) and a member that asks no name.
      const s = spawnNode('server');
      const m = spawnNode('member');
      const ss = await up(s, { cmd: 'start', link, titles: titles(room, ['srv']) });
      await up(m, { cmd: 'start', link });
      await sleep(20_000);
      const idle = Number(o.idle) * 1000;
      const window = async (n: Node) => {
        const a = await stats(n);
        await sleep(idle);
        const b = await stats(n);
        return { cpuPct: ((b.cpuUs - a.cpuUs) / 1000 / idle) * 100, memory: b.memory, rss: b.rss, socks: b.socks.filter((x) => !x.closed).map((x) => x.url), inBytes: b.socks.reduce((t, x) => t + x.in, 0) - a.socks.reduce((t, x) => t + x.in, 0), outBytes: b.socks.reduce((t, x) => t + x.out, 0) - a.socks.reduce((t, x) => t + x.out, 0) };
      };
      const [server, member] = await Promise.all([window(s), window(m)]);
      // The member's names client: opened by its first name, then idle with it.
      m.send({ cmd: 'ask', name: 'srv', ms: 30_000 });
      const ans = await m.next('answer', 40_000);
      await sleep(10_000);
      const memberNames = await window(m);
      results.client = { idleS: Number(o.idle), server, member, memberAsk: ans, memberWithNamesClient: memberNames, serverKey: ss.key };
      console.log(JSON.stringify(results.client, null, 1));
    } else if (what === 'lookup') {
      // Two servers holding the names (B syncs A's), then fresh members asking.
      const a = spawnNode('A');
      const b = spawnNode('B');
      await up(a, { cmd: 'start', link, titles: titles(room, ['alpha', 'bravo']) });
      await up(b, { cmd: 'start', link, titles: titles(room, ['charlie']) });
      await b.next('names', 120_000, (x) => x.names >= 3);
      await a.next('names', 60_000, (x) => x.names >= 3).catch(() => undefined);
      const rounds: unknown[] = [];
      for (let k = 0; k < Number(o.rounds); k++) {
        const mem = spawnNode(`member${k}`);
        const s = await up(mem, { cmd: 'start', link });
        const ask = async (name: string) => { mem.send({ cmd: 'ask', name, ms: 30_000 }); return mem.next('answer', 40_000); };
        const r = { runningMs: s.runningMs, cold: await ask('alpha'), kept: await ask('alpha'), warm: await ask('bravo'), missing: await ask(`zz${k}nope`) };
        const st = await stats(mem);
        rounds.push({ ...r, logs: st.logs.filter((l) => /name|ask|repl/i.test(l)).slice(-12) });
        console.log(JSON.stringify({ ...r }));
        mem.kill();
        await sleep(2000);
      }
      results.lookup = rounds;
    }
  } finally {
    for (const n of nodes) n.kill();
  }
}

if (o.out) writeFileSync(`${ROOT}bench/net/${o.out}`, `${JSON.stringify(results, null, 1)}\n`);
if (what !== 'node') process.exit(0);
