// NAMES loop 6b: the kickoff's days-long run (NAMES-KICKOFF.md loop 6, "a few days on the public calendars, explorers and
// default relays with real stamps, between two pages"; bench/net/REPORT.md "NAMES loop 6b"). Two Node processes play the
// two pages, each running the page's own code: the shipped module (target/net/ts.wasm: production's proof of work and
// headers floor), the names agent (web/names.ts `NamesAgent` on web/names-ops.ts `localBackend`, the ops the names
// worker runs, in the process's thread: Node has no page Worker), its publisher, and a room node as the room's worker
// runs one (web/room-worker.ts: titles from `roomTitles`, again on the agent's `NAMES_CHANNEL`, a server's fetches through
// `serviceFetch`). Why Node and not two Chromium pages: days of two headless browsers cost ~1 GB more and a GPU-less
// renderer, and a page adds nothing the names code sees (no WebRTC is used by names; the page's IndexedDB store is
// replaced by a file).
// - Page A names its node: a claim made with production's proof of work, stamped at the three calendars; the agent
//   collects it once anchored (hours), publishes it, and A's node serves it (its titles); the agent's passes go on
//   hourly, as a page left open does.
// - Page B, a member, resolves the name through its guest's resolver every `--every` minutes.
// The services are the public ones: the six default Nostr relays (link.rs DEFAULT_NOSTR, the link names none), one
// public tailcat DERP region (`--derp`, default 303), the calendars and explorers web/names.ts compiles in.
//
// It logs JSON lines, appended to `<dir>/log.jsonl` (`t`: ms since the Unix epoch, `ev`: what): each step's time (claim,
// stamp, collect, anchored, published, first resolve), each resolve's result and latency, every WebSocket opened and
// every one that closed (a drop: not closed by us), every HTTP request by service, memory and CPU every 10 minutes, the
// nodes' names lines and the agent's. Every public request is counted by service against the caps below; past a cap a
// fetch is refused (HTTP) or the run ends (relays, DERP): a few hundred small requests a service over the run, never a
// load test (relays: what the room's own cadence sends, see CAPS). State (the room, the name, A's node key, the agent's
// store, the counts) is in `<dir>/state.json`, so a run killed and launched again with the same `--dir` goes on.
// SIGTERM ends it cleanly (an `end` line). Low CPU: the module idles at well under 1% of a core a node.
//
// Usage:
//   node bench/net/names-long.ts run --dir bench/results/local/names-long [--days 4] [--every 20] [--derp 303]
//   node bench/net/names-long.ts summary bench/results/local/names-long/log.jsonl [--out results/names6b/long.json]
// (`--drop <min>`: close A's first relay connection after that many minutes, once: the proof that a drop is survived.)
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { parseArgs } from 'node:util';

const ROOT = new URL('../..', import.meta.url).pathname;
const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string', default: 'bench/results/local/names-long' }, days: { type: 'string', default: '4' },
    every: { type: 'string', default: '20' }, derp: { type: 'string', default: '303' }, drop: { type: 'string' },
    out: { type: 'string' }, wasm: { type: 'string', default: 'target/net/ts.wasm' },
  },
});
const what = positionals[0];
const abs = (p: string) => (p.startsWith('/') ? p : `${ROOT}${p}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Caps over the whole run, by service (host). HTTP: a request past its cap is refused (the agent and the server treat it
 * as a failed fetch and back off). Relays and DERP: past a cap the run ends (`cap` line); events and connections are what
 * the product's cadence makes (a server alone in its room asks "who serves?" about every 5 minutes, three events each;
 * the agent's publisher connects hourly; the member's names client opens at a lookup after 10 idle minutes), measured
 * by the proof run (bench/net/REPORT.md "NAMES loop 6b") and scaled by `--days` with room to spare.
 */
const CAPS = {
  /** Each calendar: a stamp an entry, the agent's collects backing off 5 minutes doubling to an hour. */
  calendar: 150,
  /** Each explorer: two GETs a collect; a server checks each distinct block once. */
  explorer: 150,
  /** Anything else over HTTP (the DERP map). */
  other: 100,
  /** A relay a day: events sent, connections opened. */
  relayEventsADay: 2000,
  relayOpensADay: 300,
  /** The DERP region a day: connections opened; bytes both ways over the run. */
  derpOpensADay: 300,
  derpBytes: 200e6,
};
const CALENDAR_HOSTS = ['alice.btc.calendar.opentimestamps.org', 'bob.btc.calendar.opentimestamps.org', 'finney.calendar.eternitywall.com'];
const EXPLORER_HOSTS = ['blockstream.info', 'mempool.space'];
const capOf = (host: string) => (CALENDAR_HOSTS.includes(host) ? CAPS.calendar : EXPLORER_HOSTS.includes(host) ? CAPS.explorer : CAPS.other);

/** A count of one service: HTTP requests, WebSocket opens, messages sent, Nostr events sent, bytes both ways, drops. */
type Count = { http: number; opens: number; sent: number; events: number; bytesIn: number; bytesOut: number; drops: number };
const zero = (): Count => ({ http: 0, opens: 0, sent: 0, events: 0, bytesIn: 0, bytesOut: 0, drops: 0 });
type Counts = Record<string, Count>;

type FromChild =
  | { t: 'line'; line: Record<string, unknown> }
  | { t: 'counts'; counts: Counts }
  | { t: 'store'; store: unknown }
  | { t: 'self'; key: string; address6: number[]; tag: string };
type ToChild = { cmd: 'stop' } | { cmd: 'start'; start: Start };

type Start = { role: 'a' | 'b'; link: string; room: string; name: string; nodeKey?: string; store?: unknown; used: Counts; every: number; drop?: number; wasm: string };

// ---- A child: one page ----
if (what === 'child') {
  // Through IPC, not the command line: the agent's store holds the owners' secret, and a command line is anyone's to read.
  const start = await new Promise<Start>((resolve) => {
    const first = (c: ToChild) => { if (c.cmd === 'start') { process.off('message', first); resolve(c.start); } };
    process.on('message', first);
  });
  const send = (m: FromChild) => { try { process.send?.(m); } catch { /* the parent is gone */ } };
  const line = (ev: string, x: Record<string, unknown> = {}) => send({ t: 'line', line: { t: Date.now(), role: start.role, ev, ...x } });
  const counts: Counts = {};
  const count = (host: string) => (counts[host] ??= zero());
  const used = (host: string) => (start.used[host]?.http ?? 0) + (counts[host]?.http ?? 0);

  // Every HTTP request by host, the compiled services held to their caps.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).host;
    if (used(host) >= capOf(host)) {
      line('refused', { host, url: url.replace(/[0-9a-f]{32,}/g, '…'), cap: capOf(host) });
      throw new TypeError(`names-long: ${host} past its cap`);
    }
    count(host).http++;
    const t = performance.now();
    try {
      const r = await realFetch(input, init);
      line('http', { host, method: init?.method ?? 'GET', path: new URL(url).pathname.replace(/[0-9a-f]{32,}/g, '…'), status: r.status, ms: Math.round(performance.now() - t) });
      return r;
    } catch (e) {
      line('http', { host, method: init?.method ?? 'GET', path: new URL(url).pathname.replace(/[0-9a-f]{32,}/g, '…'), status: 0, ms: Math.round(performance.now() - t), error: String(e).slice(0, 120) });
      throw e;
    }
  };

  // Every WebSocket: opens, messages and Nostr events sent, bytes, and closes we didn't ask for (drops).
  const Real = globalThis.WebSocket;
  const size = (d: unknown) => (typeof d === 'string' ? Buffer.byteLength(d) : d instanceof ArrayBuffer ? d.byteLength : ArrayBuffer.isView(d) ? d.byteLength : 0);
  const open: { ws: WebSocket; host: string }[] = [];
  const ours = new WeakSet<WebSocket>();
  globalThis.WebSocket = class extends Real {
    host: string;
    constructor(url: string | URL, p?: string | string[]) {
      super(url, p);
      const host = new URL(String(url)).host;
      this.host = host;
      const c = count(host);
      c.opens++;
      const opened = Date.now();
      open.push({ ws: this, host });
      this.addEventListener('message', (e) => { c.bytesIn += size(e.data); });
      this.addEventListener('close', (e) => {
        const i = open.findIndex((x) => x.ws === this);
        if (i >= 0) open.splice(i, 1);
        if (!ours.has(this)) {
          c.drops++;
          line('drop', { host, code: e.code, clean: e.wasClean, ageS: Math.round((Date.now() - opened) / 1000) });
        }
      });
    }
    override send(d: string | Blob | BufferSource) {
      super.send(d);
      const c = count(this.host);
      c.sent++;
      c.bytesOut += size(d);
      if (typeof d === 'string' && d.startsWith('["EVENT"')) c.events++;
    }
    override close(code?: number, reason?: string) {
      ours.add(this);
      super.close(code, reason);
    }
  } as typeof WebSocket;
  setInterval(() => send({ t: 'counts', counts }), 60_000).unref();

  const { readFileSync: read } = await import('node:fs');
  const { startMember } = await import('./room-member.ts');
  const { dnsQuery, udp } = await import('../../tests/net/packets.ts');
  const wasm = await WebAssembly.compile(read(abs(start.wasm)));
  let lastCpu = process.cpuUsage();
  let lastAt = performance.now();
  const stats = (m: { memory(): number }) => {
    const u = process.cpuUsage(lastCpu);
    const now = performance.now();
    const cpuPct = ((u.user + u.system) / 1000 / (now - lastAt)) * 100;
    lastCpu = process.cpuUsage();
    lastAt = now;
    const mu = process.memoryUsage();
    line('stats', { cpuPct: Math.round(cpuPct * 100) / 100, rss: mu.rss, heap: mu.heapUsed, wasm: m.memory(), sockets: open.length });
  };
  const onEvent = (e: { type: string; msg?: string; state?: string; code?: string; names?: number; servers?: number; serving?: boolean }) => {
    if (e.type === 'log' && e.msg && (/^names/.test(e.msg) || /relay|derp|DERP|reconnect/i.test(e.msg))) line('node', { msg: e.msg.slice(0, 300) });
    if (e.type === 'state') line('state', { state: e.state, code: e.code });
    if (e.type === 'names') line('names', { names: e.names, servers: e.servers, serving: e.serving });
  };
  const closeAll = () => { for (const s of [...open]) { ours.add(s.ws); try { s.ws.close(); } catch { /* closed */ } } };

  if (start.role === 'a') {
    const { memoryNamesStore, NamesAgent, NAMES_CHANNEL, roomTitles, serviceFetch } = await import('../../web/names.ts');
    const { localBackend, namesOp } = await import('../../web/names-ops.ts');
    const { TsModule } = await import('../../web/ts-client.ts');
    // The agent's store: in memory, every change sent to the parent (state.json), so a run launched again goes on.
    type Dump = { secrets: [string, string][]; titles: unknown[] };
    const store = memoryNamesStore();
    const dump = start.store as Dump | undefined;
    for (const [i, s] of dump?.secrets ?? []) await store.addSecret(i, s);
    for (const t of dump?.titles ?? []) await store.put(t as never);
    const secrets = new Map<string, string>(dump?.secrets ?? []);
    const save = async () => send({ t: 'store', store: { secrets: [...secrets], titles: await store.titles() } satisfies Dump });
    const kept: typeof store = {
      ...store,
      addSecret: async (i, s) => { const k = await store.addSecret(i, s); secrets.set(i, k); await save(); return k; },
      put: async (t) => { await store.put(t); await save(); },
      delete: async (i, r, n) => { await store.delete(i, r, n); await save(); },
    };
    const mod = await TsModule.load(wasm);
    const agent = new NamesAgent({ store: kept, backend: localBackend(mod, { log: (s) => { if (/^names/.test(s)) line('publisher', { msg: s.slice(0, 300) }); } }), log: (s) => line('agent', { msg: s.slice(0, 300) }) });
    const conn = { identityKey: 'names-long-a', link: start.link };
    const titles = () => roomTitles(kept, (op, input) => namesOp(mod, op, input), conn.identityKey, start.room);
    const nodeKey = start.nodeKey ?? randomBytes(32).toString('hex');
    const records = new Map<string, Uint8Array>();
    const m = await startMember(wasm, {
      link: start.link, key: nodeKey, event: onEvent,
      ...((await titles()).length ? { names: { titles: await titles() } } : {}),
      namesStore: (id, r) => { const k = Buffer.from(id).toString('hex'); if (r) records.set(k, r); else records.delete(k); },
      namesFetch: (client, id, url) => { void serviceFetch(url).then((r) => client.namesFetched(id, r.status, r.body)); },
    });
    send({ t: 'self', key: m.key, address6: m.address6, tag: '' });
    line('self', { key: m.key, address6: m.address6, nodeKey: 'from state.json' });
    // As the room's worker does: the titles again whenever the agent saves one.
    const channel = new BroadcastChannel(NAMES_CHANNEL);
    (channel as { unref?: () => void }).unref?.();
    channel.onmessage = async () => { m.client.namesTitles(await titles()); };
    // The title's state now and then, each change a line: the steps.
    let last = '';
    const watch = async () => {
      const [v] = await agent.titles(conn.identityKey);
      const [t] = await store.titles(conn.identityKey);
      if (!v || !t) return;
      let anchored: number | null = null;
      if (t.item) {
        const st = await namesOp<{ entries: { kind: string; time: number | null }[] }>(mod, 'status', { item: t.item, now: Math.floor(Date.now() / 1000) });
        anchored = st.entries.find((e) => e.kind === 'claim')?.time ?? null;
      }
      const now = { state: v.state, stamps: Object.values(t.stamps).reduce((s, x) => s + x.length, 0), collectTries: Object.values(t.collect).map((c) => c.tries), anchored, publishedAt: t.publishedAt ?? null, stampedAt: t.stampedAt ?? null, keptUntil: v.keptUntil ?? null, renewAt: v.renewAt ?? null, ahead: !!t.ahead };
      const s = JSON.stringify(now);
      if (s !== last) line('title', now);
      last = s;
    };
    const have = (await store.titles(conn.identityKey))[0];
    if (!have) {
      const t0 = Date.now();
      line('claim-start', { name: start.name });
      try {
        const v = await agent.register(conn, start.name, [{ label: null, key: m.key.replace(/^nodekey:/, '') }]);
        line('claim', { name: start.name, ms: Date.now() - t0, state: v.state });
      } catch (e) {
        line('claim-failed', { error: String(e).slice(0, 300) });
      }
    }
    await watch();
    void agent.start();
    setInterval(() => void watch().catch((e) => line('error', { where: 'watch', error: String(e).slice(0, 200) })), 60_000);
    setInterval(() => stats(m), 10 * 60_000);
    stats(m);
    if (start.drop !== undefined) {
      setTimeout(() => {
        const s = open.find((x) => x.host.startsWith('relay') || x.host.startsWith('nostr'));
        if (s) { line('drop-made', { host: s.host }); s.ws.close(4000, 'names-long: a drop'); ours.delete(s.ws); }
      }, start.drop * 60_000);
    }
    process.on('message', (c: ToChild) => {
      if (c.cmd !== 'stop') return;
      agent.stop();
      closeAll();
      m.close();
      send({ t: 'counts', counts });
      setTimeout(() => process.exit(0), 500);
    });
  } else {
    // Page B: a member, its guest asking the name as a guest's resolver does (again after SERVFAIL or no answer in
    // 5 s, until an answer or 30 s).
    const dnsWait = new Map<number, (d: Uint8Array) => void>();
    let tag = '';
    const m = await startMember(wasm, {
      link: start.link,
      event: (e) => {
        if (e.type === 'self') tag = e.tag ?? '';
        onEvent(e as never);
      },
      packet(p) {
        if (p[0] >> 4 === 6 && p[6] === 17 && p.length > 60 && ((p[40] << 8) | p[41]) === 53) dnsWait.get((p[48] << 8) | p[49])?.(p.subarray(48));
      },
    });
    line('self', { key: m.key, address6: m.address6, tag });
    const v6 = (b: number[] | Uint8Array) => Array.from({ length: 8 }, (_, k) => ((b[2 * k] << 8) | b[2 * k + 1]).toString(16)).join(':');
    let qid = 1;
    const resolve = async () => {
      const me = v6(m.address6);
      const resolver = v6([...m.address6.slice(0, 6), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x53]);
      const t = performance.now();
      let tries = 0;
      let last = { rcode: -1, answers: 0, address: '' };
      while (performance.now() - t < 30_000) {
        const id = (qid++ % 65535) + 1;
        tries++;
        const d = await new Promise<Uint8Array | undefined>((res) => {
          const timer = setTimeout(() => { dnsWait.delete(id); res(undefined); }, 5000);
          dnsWait.set(id, (d) => { clearTimeout(timer); dnsWait.delete(id); res(d); });
          m.client.guest(udp(me, 40000 + (id % 20000), resolver, 53, dnsQuery(id, `${start.name}.${tag}.p2p.internal`, 28)));
        });
        if (d) {
          const answers = (d[6] << 8) | d[7];
          last = { rcode: d[3] & 15, answers, address: answers ? v6(d.subarray(d.length - 16)) : '' };
          if (last.rcode === 3 || (last.rcode === 0 && last.answers > 0)) break;
          if (last.rcode !== 2) await sleep(200);
        }
      }
      line('resolve', { ...last, ms: Math.round(performance.now() - t), tries });
    };
    let stopped = false;
    void (async () => {
      while (!stopped) {
        await resolve().catch((e) => line('error', { where: 'resolve', error: String(e).slice(0, 200) }));
        await sleep(start.every * 60_000);
      }
    })();
    setInterval(() => stats(m), 10 * 60_000);
    stats(m);
    process.on('message', (c: ToChild) => {
      if (c.cmd !== 'stop') return;
      stopped = true;
      closeAll();
      m.close();
      send({ t: 'counts', counts });
      setTimeout(() => process.exit(0), 500);
    });
  }
  process.on('SIGTERM', () => { /* the parent stops us through IPC; a scope's SIGTERM to all waits for that */ });
  process.on('disconnect', () => process.exit(0));
}

// ---- The run: two children, the log, the caps ----
if (what === 'run') {
  const dir = abs(o.dir!);
  mkdirSync(dir, { recursive: true });
  const logFile = `${dir}/log.jsonl`;
  const stateFile = `${dir}/state.json`;
  type State = { room: string; name: string; link: string; nodeKey: string; store?: unknown; base: Counts; t0: number; derp: string };
  const fresh = (): State => {
    const room = `names-long-${randomBytes(12).toString('hex')}`;
    const letters = Array.from(randomBytes(8), (b) => String.fromCharCode(97 + (b % 26))).join('');
    return { room, name: `n6b${letters}`, link: `waarm64-room:${encodeURIComponent(room)}?derp=${encodeURIComponent(o.derp!)}`, nodeKey: randomBytes(32).toString('hex'), base: {}, t0: Date.now(), derp: o.derp! };
  };
  const resumed = existsSync(stateFile);
  const state: State = resumed ? (JSON.parse(readFileSync(stateFile, 'utf8')) as State) : fresh();
  const log = (ev: string, x: Record<string, unknown> = {}) => appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), role: 'run', ev, ...x })}\n`);
  // Counts of this launch's children, by role, added to `state.base` (earlier launches and children) for the caps.
  const live: Record<string, Counts> = {};
  const total = (): Counts => {
    const t: Counts = {};
    for (const c of [state.base, ...Object.values(live)]) {
      for (const [h, x] of Object.entries(c)) {
        const y = (t[h] ??= zero());
        for (const k of Object.keys(x) as (keyof Count)[]) y[k] += x[k];
      }
    }
    return t;
  };
  const save = () => {
    const tmp = `${stateFile}.tmp`;
    // The agent's store holds the owners' secret: the owner's to read only.
    writeFileSync(tmp, JSON.stringify({ ...state, base: state.base }), { mode: 0o600 });
    renameSync(tmp, stateFile);
  };
  const days = Number(o.days);
  log('start', { room: state.room.slice(0, 20), name: state.name, derp: state.derp, days, every: Number(o.every), resumed, host: `${process.platform} ${process.arch}`, cpus: cpus().length, node: process.version, wasm: o.wasm, caps: CAPS });
  save();
  let ending = false;
  const children: Partial<Record<'a' | 'b', ChildProcess>> = {};
  const spawnChild = (role: 'a' | 'b') => {
    const s: Start = { role, link: state.link, room: state.room, name: state.name, nodeKey: state.nodeKey, store: state.store, used: total(), every: Number(o.every), ...(role === 'a' && o.drop ? { drop: Number(o.drop) } : {}), wasm: o.wasm! };
    const p = fork(new URL(import.meta.url).pathname, ['child', role], { execArgv: ['--disable-warning=ExperimentalWarning', '--max-old-space-size=512'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let err = '';
    p.stderr?.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-2000); });
    children[role] = p;
    p.send({ cmd: 'start', start: s } satisfies ToChild);
    p.on('message', (m: FromChild) => {
      if (m.t === 'line') appendFileSync(logFile, `${JSON.stringify(m.line)}\n`);
      else if (m.t === 'counts') live[`${role}${p.pid}`] = m.counts;
      else if (m.t === 'store') { state.store = m.store; save(); }
    });
    p.on('exit', (code, sig) => {
      // Its counts join the base; a child that died unasked starts again after a minute.
      const k = `${role}${p.pid}`;
      for (const [h, x] of Object.entries(live[k] ?? {})) {
        const y = (state.base[h] ??= zero());
        for (const f of Object.keys(x) as (keyof Count)[]) y[f] += x[f];
      }
      delete live[k];
      save();
      if (ending) return;
      log('child-exit', { role, code, sig, stderr: err.slice(-600) });
      setTimeout(() => { if (!ending) spawnChild(role); }, 60_000);
    });
  };
  // The caps on relays and DERP: past one, the run ends.
  const capCheck = () => {
    const days = Math.max(1, (Date.now() - state.t0) / 86_400_000);
    for (const [host, c] of Object.entries(total())) {
      const relay = /relay|nostr/.test(host);
      const derp = !relay && c.opens > 0 && !CALENDAR_HOSTS.includes(host) && !EXPLORER_HOSTS.includes(host);
      const over = relay ? (c.events > CAPS.relayEventsADay * days ? 'events' : c.opens > CAPS.relayOpensADay * days ? 'opens' : '')
        : derp ? (c.opens > CAPS.derpOpensADay * days ? 'opens' : c.bytesIn + c.bytesOut > CAPS.derpBytes ? 'bytes' : '') : '';
      if (over) return { host, over, count: c };
    }
    return undefined;
  };
  const end = async (why: string) => {
    if (ending) return;
    ending = true;
    for (const p of Object.values(children)) p?.send({ cmd: 'stop' } satisfies ToChild);
    await Promise.race([Promise.all(Object.values(children).map((p) => new Promise((r) => (p && p.exitCode === null ? p.on('exit', r) : r(0))))), sleep(10_000)]);
    for (const p of Object.values(children)) p?.kill('SIGKILL');
    // Children that exited sent their last counts: merged by their exit handlers.
    log('end', { why, hours: Math.round(((Date.now() - state.t0) / 3_600_000) * 100) / 100, counts: total() });
    save();
    process.exit(0);
  };
  process.on('SIGTERM', () => void end('SIGTERM'));
  process.on('SIGINT', () => void end('SIGINT'));
  spawnChild('a');
  // B after A has had its minute (its node up, the claim's proof of work started).
  setTimeout(() => { if (!ending) spawnChild('b'); }, 60_000);
  setInterval(() => {
    const t = total();
    log('counts', { counts: t });
    const over = capCheck();
    if (over) { log('cap', over); void end(`cap: ${over.host} ${over.over}`); }
  }, 10 * 60_000);
}

// ---- The summary of a log ----
if (what === 'summary') {
  const file = abs(positionals[1] ?? `${o.dir}/log.jsonl`);
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown> & { t: number; ev: string; role: string });
  const first = (ev: string, f: (l: (typeof lines)[number]) => boolean = () => true) => lines.find((l) => l.ev === ev && f(l));
  const starts = lines.filter((l) => l.ev === 'start');
  const t0 = starts[0]?.t ?? lines[0].t;
  const h = (t?: number) => (t === undefined ? null : Math.round(((t - t0) / 3_600_000) * 1000) / 1000);
  const titles = lines.filter((l) => l.ev === 'title') as unknown as { t: number; state: string; stamps: number; anchored: number | null; publishedAt: number | null; stampedAt: number | null }[];
  const resolves = lines.filter((l) => l.ev === 'resolve') as unknown as { t: number; rcode: number; answers: number; address: string; ms: number; tries: number }[];
  const ok = (r: (typeof resolves)[number]) => r.rcode === 0 && r.answers > 0;
  const firstOk = resolves.find(ok);
  const after = firstOk ? resolves.filter((r) => r.t >= firstOk.t) : [];
  const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };
  const aSelf = lines.filter((l) => l.ev === 'self' && l.role === 'a').at(-1) as unknown as { address6?: number[] } | undefined;
  const v6 = (b: number[]) => Array.from({ length: 8 }, (_, k) => ((b[2 * k] << 8) | b[2 * k + 1]).toString(16)).join(':');
  const anchoredAt = titles.find((x) => x.anchored)?.anchored;
  const ends = lines.filter((l) => l.ev === 'end');
  const lastCounts = (lines.filter((l) => l.ev === 'end' || l.ev === 'counts').at(-1)?.counts ?? {}) as Counts;
  const stats = (role: string) => {
    const s = lines.filter((l) => l.ev === 'stats' && l.role === role) as unknown as { cpuPct: number; rss: number; wasm: number }[];
    return s.length ? { n: s.length, cpuPctMedian: q(s.slice(1).map((x) => x.cpuPct), 0.5), cpuPctMax: Math.max(...s.slice(1).map((x) => x.cpuPct), 0), rssMBMax: Math.round(Math.max(...s.map((x) => x.rss)) / 1e5) / 10, rssMBLast: Math.round(s.at(-1)!.rss / 1e5) / 10, wasmMBMax: Math.round(Math.max(...s.map((x) => x.wasm)) / 1e5) / 10 } : null;
  };
  const summary = {
    log: file.replace(ROOT, ''),
    from: new Date(t0).toISOString(), hours: h(lines.at(-1)!.t), launches: starts.length, ends: ends.map((e) => e.why),
    name: starts[0]?.name, derp: starts[0]?.derp,
    steps: {
      claimHours: h(first('claim')?.t), claimPowMs: first('claim')?.ms,
      stampedHours: h(titles.find((x) => x.stamps > 0)?.t), collectedHours: h(first('agent', (l) => /an anchor for claim/.test(String(l.msg)))?.t),
      anchoredBlockTimeHours: anchoredAt ? h(anchoredAt * 1000) : null,
      publishedHours: h(titles.find((x) => x.publishedAt)?.publishedAt ?? undefined), firstResolveHours: h(firstOk?.t),
      states: titles.map((x) => [h(x.t), x.state]).filter((x, i, a) => i === 0 || x[1] !== a[i - 1][1]),
    },
    resolves: {
      n: resolves.length, beforeFirst: resolves.length - after.length,
      after: after.length, ok: after.filter(ok).length, nxdomain: after.filter((r) => r.rcode === 3).length, other: after.filter((r) => !ok(r) && r.rcode !== 3).length,
      availability: after.length ? Math.round((after.filter(ok).length / after.length) * 10000) / 100 : null,
      rightAddress: aSelf?.address6 ? after.filter((r) => ok(r) && r.address === v6(aSelf.address6!)).length : null,
      msMedian: q(after.filter(ok).map((r) => r.ms), 0.5), msP90: q(after.filter(ok).map((r) => r.ms), 0.9), msMax: after.length ? Math.max(...after.map((r) => r.ms)) : null,
      firstMs: firstOk?.ms ?? null,
      failures: after.filter((r) => !ok(r)).slice(0, 20).map((r) => ({ hours: h(r.t), rcode: r.rcode, ms: r.ms })),
    },
    drops: lines.filter((l) => l.ev === 'drop').map((l) => ({ hours: h(l.t), role: l.role, host: l.host, code: l.code, ageS: l.ageS })).slice(0, 50),
    dropsByHost: Object.fromEntries(Object.entries(lastCounts).map(([k, c]) => [k, c.drops])),
    requests: Object.fromEntries(Object.entries(lastCounts).map(([k, c]) => [k, { http: c.http, opens: c.opens, events: c.events, sent: c.sent, mbIn: Math.round(c.bytesIn / 1e4) / 100, mbOut: Math.round(c.bytesOut / 1e4) / 100, cap: c.http ? capOf(k) : /relay|nostr/.test(k) ? { eventsADay: CAPS.relayEventsADay, opensADay: CAPS.relayOpensADay } : { opensADay: CAPS.derpOpensADay, bytes: CAPS.derpBytes } }])),
    refused: lines.filter((l) => l.ev === 'refused').length,
    childExits: lines.filter((l) => l.ev === 'child-exit').map((l) => ({ hours: h(l.t), role: l.role, code: l.code })),
    stats: { a: stats('a'), b: stats('b') },
  };
  console.log(JSON.stringify(summary, null, 1));
  if (o.out) writeFileSync(`${ROOT}bench/net/${o.out}`, `${JSON.stringify(summary, null, 1)}\n`);
}
