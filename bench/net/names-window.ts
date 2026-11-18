// NAMES loop 6b: the transfer window (net/ts/src/room/names/wire.rs `IN_FLIGHT`, 8 parts) against 16 and 32, through
// the tailcat rig's local derper (tests/net/tailcat.sh: its 32-packet queue a client) and the tests' Nostr relay; no
// public service. A new server B syncs a registry from one or two servers holding it (B's first sync: its two runs at
// once, or one when only one server answers), its DERP connections through a shaper that adds a public region's round
// trip (`--rtt`, default 95 ms, N0c's tailcat 303) and, optionally, a downlink's rate (`--mbps`) with a bottleneck's
// buffer, so that the derper's queue to B can fill (its drops read from the derper's /debug/varz). The module is the
// tests' (cheap proof of work, easy headers) built with each window: bench/results/local/names6b-window/ts-test-w<n>.wasm.
// Usage: node bench/net/names-window.ts --windows 8,16,32 --flows 1,2 --mb 6 [--mbps 0,10] [--rounds 1] --out results/names6b/window.json
import { execFileSync, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { cpus } from 'node:os';
import { parseArgs } from 'node:util';

const ROOT = new URL('../..', import.meta.url).pathname;
const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    windows: { type: 'string', default: '8,16,32' }, flows: { type: 'string', default: '1,2' }, mb: { type: 'string', default: '6' },
    mbps: { type: 'string', default: '0' }, rtt: { type: 'string', default: '95' }, rounds: { type: 'string', default: '1' },
    buffer: { type: 'string', default: '65536' }, limit: { type: 'string', default: '240' }, out: { type: 'string' },
  },
});
const DIR = `${ROOT}bench/results/local/names6b-window`;
const DERP = '127.0.0.1:8444';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type FromNode = { t: 'self'; key: string } | { t: 'running' } | { t: 'names'; at: number; names: number; serving: boolean; servers: number } | { t: 'log'; at: number; msg: string } | { t: 'error'; error: string } | { t: 'bytes'; in: number; out: number };
type Start = { wasm: string; link: string; titles: { key: string; item: string }[]; records?: string[]; shape?: number; maxNames: number };

if (positionals[0] === 'node') {
  const send = (m: FromNode) => process.send!(m);
  const s = JSON.parse(readFileSync(process.argv[3], 'utf8')) as Start;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the rig's relay's self-signed certificate
  // B's DERP connections through the shaper; every DERP byte counted.
  const Real = globalThis.WebSocket;
  let bin = 0;
  let bout = 0;
  const size = (d: unknown) => (typeof d === 'string' ? Buffer.byteLength(d) : d instanceof ArrayBuffer ? d.byteLength : ArrayBuffer.isView(d) ? d.byteLength : 0);
  globalThis.WebSocket = class extends Real {
    derp: boolean;
    constructor(url: string | URL, p?: string | string[]) {
      const u = String(url);
      const derp = u.includes(DERP);
      super(derp && s.shape ? u.replace(DERP, `127.0.0.1:${s.shape}`) : u, p);
      this.derp = derp;
      if (derp) this.addEventListener('message', (e) => { bin += size(e.data); });
    }
    override send(d: string | Blob | BufferSource) {
      super.send(d);
      if (this.derp) bout += size(d);
    }
  } as typeof WebSocket;
  setInterval(() => send({ t: 'bytes', in: bin, out: bout }), 1000).unref();
  const { startMember } = await import('./room-member.ts');
  const wasm = await WebAssembly.compile(readFileSync(s.wasm));
  const m = await startMember(wasm, {
    link: s.link,
    names: { titles: s.titles, maxNames: s.maxNames },
    records: (s.records ?? []).map((r) => Buffer.from(r, 'hex')),
    namesFetch: (c, id) => c.namesFetched(id, 0, new Uint8Array()),
    event(e) {
      if (e.type === 'names') send({ t: 'names', at: Date.now(), names: e.names, serving: e.serving, servers: e.servers });
      if (e.type === 'log' && /^names/.test(e.msg)) send({ t: 'log', at: Date.now(), msg: e.msg });
      if (e.type === 'state' && e.state === 'Running') send({ t: 'running' });
    },
  });
  send({ t: 'self', key: m.key });
  process.on('disconnect', () => process.exit(0));
} else {
  execFileSync(`${ROOT}tests/net/tailcat.sh`, ['up'], { encoding: 'utf8', timeout: 300_000 });
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const { startNostrRelay } = await import('../../tests/net/nostr-relay.ts');
  const nostr = await startNostrRelay(0, false);
  const results: Record<string, unknown> = { date: new Date().toISOString(), host: `${process.platform} ${process.arch}`, cpus: cpus().length, node: process.version, rttMs: Number(o.rtt), bufferBytes: Number(o.buffer) };

  /** Drops at the derper so far (`derp_packets_dropped`, every reason), and its packets sent. */
  async function derpVars() {
    const r = await fetch(`https://${DERP}/debug/varz`);
    const t = await r.text();
    const sum = (re: RegExp) => [...t.matchAll(re)].reduce((s, m) => s + Number(m[1]), 0);
    return { dropped: sum(/^derp_packets_dropped\{[^}]*\} (\d+)/gm), queueHead: sum(/^derp_packets_dropped\{reason="queue_head"[^}]*\} (\d+)/gm), queueTail: sum(/^derp_packets_dropped\{reason="queue_tail"[^}]*\} (\d+)/gm), sent: sum(/^derp_packets_sent\{[^}]*\} (\d+)/gm) };
  }

  /** A TCP shaper to the derper: both ways delayed by half the RTT; the way to B (down) at `mbps` at most (0: no cap),
   * through a bottleneck holding `buffer` bytes, past which it stops reading (so the derper's writes to B back up). */
  function shaper(rtt: number, mbps: number, buffer: number): Promise<{ server: Server; port: number }> {
    const pipe = (from: Socket, to: Socket, rate: number) => {
      const q: { at: number; b: Buffer }[] = [];
      let queued = 0;
      let free = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let ended = false;
      const flush = () => {
        timer = undefined;
        const now = performance.now();
        while (q.length && q[0].at <= now) {
          const x = q.shift()!;
          queued -= x.b.length;
          if (!to.destroyed) to.write(x.b);
        }
        if (queued < buffer / 2 && from.isPaused()) from.resume();
        if (q.length) timer = setTimeout(flush, Math.max(0, q[0].at - now));
        else if (ended) to.end();
      };
      from.on('data', (b: Buffer) => {
        const now = performance.now();
        const start = Math.max(now, free);
        free = start + (rate ? (b.length * 8) / (rate * 1000) : 0);
        q.push({ at: free + rtt / 2, b });
        queued += b.length;
        if (rate && queued > buffer) from.pause();
        if (!timer) timer = setTimeout(flush, Math.max(0, q[0].at - now));
      });
      from.on('end', () => { ended = true; if (!q.length) to.end(); });
      from.on('error', () => to.destroy());
    };
    const server = createServer((c) => {
      const u = connect(8444, '127.0.0.1');
      c.setNoDelay(true);
      u.setNoDelay(true);
      pipe(c, u, 0);
      pipe(u, c, mbps);
      u.on('error', () => c.destroy());
      c.on('error', () => u.destroy());
    });
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: (server.address() as { port: number }).port })));
  }

  /** Titles on the tests' pretend Bitcoin (names-title, anchors 30 levels deep: real anchors' weight). */
  function titles(room: string, names: string[]): { key: string; item: string }[] {
    const spec = `${DIR}/spec-${process.pid}.json`;
    writeFileSync(spec, JSON.stringify({ room, levels: 30, titles: names.map((name) => ({ name, secret: 7, claimDaysAgo: 20, renewDaysAgo: [4], zones: [{ seq: 1, points: [{ label: null, key: randomBytes(32).toString('hex') }] }] })) }));
    const out = JSON.parse(execFileSync(`${ROOT}target/debug/examples/names-title`, [`@${spec}`], { encoding: 'utf8', maxBuffer: 1 << 30 })) as { key: string; items: string[] }[];
    return out.map((t) => ({ key: t.key, item: t.items[0] }));
  }
  const record = (item: string) => { const b = Buffer.alloc(9); b[0] = 1; b.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000)), 1); return b.toString('hex') + item; };

  type Node = { msgs: FromNode[]; kill(): void; next<T extends FromNode['t']>(t: T, ms: number, f?: (m: Extract<FromNode, { t: T }>) => boolean): Promise<Extract<FromNode, { t: T }>> };
  let started = 0;
  function spawnNode(s: Start): Node {
    const file = `${DIR}/start-${process.pid}-${++started}.json`;
    writeFileSync(file, JSON.stringify(s));
    const p = fork(new URL(import.meta.url).pathname, ['node', file], { execArgv: ['--disable-warning=ExperimentalWarning', '--max-old-space-size=2048'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const msgs: FromNode[] = [];
    const waiters: (() => void)[] = [];
    p.on('message', (m: FromNode) => { msgs.push(m); if (m.t === 'error') console.log(`# ${m.error}`); for (const w of waiters.splice(0)) w(); });
    return {
      msgs, kill: () => p.kill(),
      async next(t, ms, f = () => true) {
        const t0 = Date.now();
        let seen = 0;
        for (;;) {
          const m = msgs.slice(seen).find((x) => x.t === t && f(x as never));
          if (m) return m as never;
          seen = Math.max(0, msgs.length - 1);
          if (Date.now() - t0 > ms) throw new Error(`no ${t} in ${ms} ms`);
          await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 250); });
        }
      },
    };
  }

  // A number is IN_FLIGHT alone (ts-test-w<n>.wasm); a name a variant file (e.g. p8w16: SYNC_PARALLEL 8, IN_FLIGHT 16).
  const windows = o.windows!.split(',').map((v) => (/^\d+$/.test(v) ? `w${v}` : v));
  const flows = o.flows!.split(',').map(Number);
  const rates = o.mbps!.split(',').map(Number);
  const runs: unknown[] = [];
  const count = Math.ceil((Number(o.mb) * 1e6) / 3091);
  for (let round = 0; round < Number(o.rounds); round++) {
    for (const mbps of rates) {
      for (const nflows of flows) {
        // Alternated: each window in turn within a shape.
        for (const w of round % 2 ? [...windows].reverse() : windows) {
          const room = `names6b-window-${randomBytes(8).toString('hex')}`;
          const link = `waarm64-room:${encodeURIComponent(room)}?nostr=${encodeURIComponent(nostr.url)}&derp=${encodeURIComponent(DERP)}`;
          const reg = titles(room, Array.from({ length: count }, (_, k) => `n${k.toString().padStart(6, '0')}`));
          const own = titles(room, ['srvone', 'srvtwo', 'bnew']);
          const wasm = `${DIR}/ts-test-${w}.wasm`;
          const maxNames = count + 100;
          const shaped = await shaper(Number(o.rtt), mbps, Number(o.buffer));
          const nodes: Node[] = [];
          try {
            // The servers holding the registry: the first as its titles, the second from records (so each answers with a
            // name of its own: one owner key answers a question once).
            const a1 = spawnNode({ wasm, link, titles: [...reg, own[0]], maxNames });
            nodes.push(a1);
            await a1.next('running', 60_000);
            await a1.next('names', 120_000, (m) => m.serving && m.names >= count);
            if (nflows > 1) {
              const a2 = spawnNode({ wasm, link, titles: [own[1]], records: reg.map((t) => record(t.item)), maxNames });
              nodes.push(a2);
              await a2.next('names', 120_000, (m) => m.names >= count + 1);
            }
            // Both found each other and serve.
            await sleep(8000);
            const before = await derpVars();
            const t0 = Date.now();
            const b = spawnNode({ wasm, link, titles: [own[2]], shape: shaped.port, maxNames });
            nodes.push(b);
            const want = count + nflows + 1;
            let done: number | undefined;
            try {
              await b.next('names', Number(o.limit) * 1000, (m) => m.names >= want);
              done = Date.now();
            } catch { /* out of time */ }
            await sleep(1500);
            const after = await derpVars();
            const names = b.msgs.filter((m): m is Extract<FromNode, { t: 'names' }> => m.t === 'names');
            const first = names.find((m) => m.names > 1)?.at;
            const bytes = b.msgs.filter((m): m is Extract<FromNode, { t: 'bytes' }> => m.t === 'bytes').at(-1);
            const logs = b.msgs.filter((m): m is Extract<FromNode, { t: 'log' }> => m.t === 'log').map((m) => [m.at - t0, m.msg]);
            const r = {
              round, window: w, flows: nflows, mbps, names: count, firstNameMs: first ? first - t0 : null, allMs: done ? done - t0 : null,
              syncMs: done && first ? done - first : null, namesAtEnd: names.at(-1)?.names, partnersMax: Math.max(0, ...names.map((m) => m.servers)), derpInMB: bytes ? Math.round(bytes.in / 1e4) / 100 : null,
              mbitsDuringSync: done && first && bytes ? Math.round(((bytes.in * 8) / ((done - first) / 1000) / 1e6) * 100) / 100 : null,
              derpDropped: after.dropped - before.dropped, queueHead: after.queueHead - before.queueHead, queueTail: after.queueTail - before.queueTail, derpSent: after.sent - before.sent,
              logs: logs.slice(0, 40),
            };
            console.log(JSON.stringify({ ...r, logs: undefined }));
            runs.push(r);
          } finally {
            for (const n of nodes) n.kill();
            shaped.server.close();
            await sleep(2000);
          }
        }
      }
    }
  }
  results.runs = runs;
  await nostr.close();
  execFileSync(`${ROOT}tests/net/tailcat.sh`, ['down']);
  if (o.out) writeFileSync(`${ROOT}bench/net/${o.out}`, `${JSON.stringify(results, null, 1)}\n`);
  process.exit(0);
}
