// NAMES loop 6a (docs/plans/room-names.md "Servers", "Size, and where it stops"; bench/net/REPORT.md "NAMES loop 6a"):
// a room's registry at scale on the tests' Nostr relay (tests/net/nostr-relay.ts, a process of its own), the tailcat
// rig's derper and the pretend calendars and explorer (tests/net/ots-calendar.ts, in this process): no public service.
// Room nodes are the module (target/net/ts-test.wasm, the tests' cheap proof of work and easy headers) in instances of
// their own, many to a process (bench/net/room-scale-names-worker.ts), as R3's members were: servers two to a process,
// members 250 to one. Each phase is one bounded run (under ~8 minutes); what one leaves the next takes from
// bench/results/local/names6a/ (titles, servers' stored records).
//
// - `make`: titles on the pretend Bitcoin (net/ts/examples/names-title.rs): 20 servers' 250 names each (claims 14 to 28
//   days ago, renewed 16 days later, anchors 30 levels deep, the entries of each half hour in one block), and 5,000
//   junk names claimed in the last day by one key.
// - `converge`: the 20 servers start with their titles only: when each holds all 5,000 names, its CPU, memory and
//   fetches outside the room; their records are saved.
// - `members`: the servers start from those records; 500 members join at 100 a second; a minute idle; 100 cold first
//   lookups of random names (one member each, two a second); 500 more members join in a minute, each asking a random
//   name as it runs; then the servers' totals.
// - `junk`: the servers start from the records with a bound of `--bound` names (7,500), 100 members keep 500 of the
//   names in use (each resolves 5, then again every 2 minutes), and a registrant's server brings 5,000 junk names:
//   what each server's bound drops, honest (in use or not) and junk.
// Usage: node bench/net/room-scale.ts names <make|converge|members|junk> [--out results/x.json] [--bound n] [--wait s]
import { execFileSync, fork, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpus } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { FromWorker, NodeReport, NodeSpec, ToWorker, Answer } from './room-scale-names-worker.ts';
import type { RelayStats } from '../../tests/net/nostr-relay.ts';
import { startOtsCalendar } from '../../tests/net/ots-calendar.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const { values: o, positionals } = parseArgs({
  args: process.argv.slice(3), allowPositionals: true,
  options: { out: { type: 'string' }, bound: { type: 'string', default: '7500' }, wait: { type: 'string', default: '420' } },
});
const phase = positionals[0];
const LOCAL = `${ROOT}bench/results/local/names6a`;
mkdirSync(LOCAL, { recursive: true });
const SERVERS = 20, PER_SERVER = 250, JUNK = 5000;
const DERP = '127.0.0.1:8444';
const rig = `${ROOT}tests/net/tailcat.sh`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const t00 = Date.now();
const log = (s: string) => console.log(`# ${((Date.now() - t00) / 1000).toFixed(0).padStart(4)} s ${s}`);
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const dist = (xs: number[]) => ({ n: xs.length, p50: q(xs, 0.5), p90: q(xs, 0.9), p99: q(xs, 0.99), max: q(xs, 1) });
const round = (v: unknown): unknown => typeof v === 'number' ? Math.round(v * 10) / 10 : Array.isArray(v) ? v.map(round)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v;
const results: Record<string, unknown> = { date: new Date().toISOString(), host: `${process.platform} ${process.arch}`, cpus: cpus().length, node: process.version, phase };

type Title = { name: string; key: string; items: string[]; headers: string[] };
type Titles = { room: string; servers: Title[][]; junk: Title[] };
const idOf = (t: Title) => t.items[0].slice(2, 66);

if (phase === 'make') {
  const TOOL = `${ROOT}target/debug/examples/names-title`;
  const room = `scale names ${Math.random().toString(36).slice(2)}`;
  const make = (titles: object[], spread: number) => {
    const spec = `${LOCAL}/spec.json`;
    writeFileSync(spec, JSON.stringify({ room, levels: 30, spread, blockSecs: 1800, titles }));
    return JSON.parse(execFileSync(TOOL, [`@${spec}`], { encoding: 'utf8', maxBuffer: 1 << 30 })) as Title[];
  };
  const zone = (k: number) => [{ seq: 1, points: [{ label: null, key: (k + 1).toString(16).padStart(64, 'a') }] }];
  const t = performance.now();
  // One call, so that the servers' names share blocks as one room's do.
  const honest = make(Array.from({ length: SERVERS * PER_SERVER }, (_, k) => {
    const s = Math.floor(k / PER_SERVER);
    return { name: `h${String(s).padStart(2, '0')}n${String(k % PER_SERVER).padStart(3, '0')}`, secret: s + 1, claimDaysAgo: 28, renewDaysAgo: [12], zones: zone(k) };
  }), 14 * 86400);
  const servers = Array.from({ length: SERVERS }, (_, s) => honest.slice(s * PER_SERVER, (s + 1) * PER_SERVER));
  const junk = make(Array.from({ length: JUNK }, (_, k) => ({
    name: `jk${String(k).padStart(5, '0')}`, secret: 200, claimDaysAgo: 0, zones: zone(k),
  })), 86400);
  const all = [...servers.flat(), ...junk];
  results.make = {
    ms: performance.now() - t, titles: all.length,
    itemBytes: dist(all.map((x) => x.items[0].length / 2)), honestBytes: servers.flat().reduce((a, x) => a + x.items[0].length / 2, 0),
    junkBytes: junk.reduce((a, x) => a + x.items[0].length / 2, 0),
    blocks: { honest: new Set(servers.flat().flatMap((x) => x.headers)).size, junk: new Set(junk.flatMap((x) => x.headers)).size },
  };
  writeFileSync(`${LOCAL}/titles.json`, JSON.stringify({ room, servers, junk } satisfies Titles));
  log(JSON.stringify(round(results.make)));
} else {
  const T = JSON.parse(readFileSync(`${LOCAL}/titles.json`, 'utf8')) as Titles;
  const honestIds = new Set(T.servers.flat().map(idOf));
  const junkIds = new Set(T.junk.map(idOf));
  const allNames = T.servers.flat().map((x) => x.name);
  const pick = <X>(xs: X[]) => xs[Math.floor(Math.random() * xs.length)];
  const proc = (pid: number) => {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    const rss = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))![1]) * 1024;
    return { cpuMs: (Number(f[11]) + Number(f[12])) * 10, rss };
  };

  execFileSync(rig, ['up'], { encoding: 'utf8', timeout: 300_000 });
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: `${ROOT}target/net/tailcat-test/certs/127.0.0.1.crt` };
  const derper = Number(readFileSync(`${ROOT}target/net/tailcat-test/run/derper.pid`, 'utf8'));
  const relayProc = spawn(process.execPath, [`${ROOT}tests/net/nostr-relay.ts`], { stdio: ['ignore', 'pipe', 'inherit'] });
  process.on('exit', () => relayProc.kill());
  const relayURL = await new Promise<string>((resolve) => relayProc.stdout!.once('data', (d: Buffer) => resolve(d.toString().trim())));
  const statsURL = relayURL.replace('ws://', 'http://') + '/stats';
  const relayStats = async () => await (await fetch(statsURL)).json() as RelayStats;
  const cal = await startOtsCalendar({ depth: 6 });
  for (const t of [...T.servers.flat(), ...T.junk]) for (const h of t.headers) cal.adopt(Buffer.from(h, 'hex'));
  const link = `waarm64-room:${encodeURIComponent(T.room)}?nostr=${encodeURIComponent(relayURL)}&derp=${encodeURIComponent(DERP)}`;

  // Processes: servers two to one (and the registrant's alone), members 250 to one.
  type W = { c: ChildProcess; kind: 'server' | 'member' | 'junk' };
  const workers: W[] = [];
  const answers: Answer[] = [];
  const lines = new Map<number, { at: number; serving: boolean; names: number; servers: number }[]>();
  const running = new Map<number, number>();
  const startedAt = new Map<number, number>();
  let reports: Extract<FromWorker, { type: 'report' }>[] = [];
  let saved = 0;
  const spawnWorker = (kind: W['kind']) => {
    const c = fork(`${ROOT}bench/net/room-scale-names-worker.ts`, [], { env, execArgv: ['--disable-warning=ExperimentalWarning', '--max-old-space-size=4096'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    c.on('message', (m: FromWorker) => {
      if (m.type === 'answer') answers.push(m.a);
      else if (m.type === 'names') { if (!lines.has(m.id)) lines.set(m.id, []); lines.get(m.id)!.push(m); }
      else if (m.type === 'running') running.set(m.id, m.at);
      else if (m.type === 'started') startedAt.set(m.id, m.at);
      else if (m.type === 'saved') saved++;
      else if (m.type === 'report') reports.push(m);
    });
    const w = { c, kind };
    workers.push(w);
    return w;
  };
  const tell = (w: W, m: ToWorker) => w.c.send(m);
  const report = async (ws = workers) => {
    reports = [];
    for (const w of ws) tell(w, { type: 'report' });
    const t = Date.now();
    while (reports.length < ws.length && Date.now() - t < 30_000) await sleep(20);
    return reports.flatMap((r) => r.nodes);
  };
  const latest = (id: number) => lines.get(id)?.at(-1);

  // Every second: the relay's counters; CPU and RSS of the relay, the derper, this process (the calendars) and each
  // kind of worker.
  type Sample = { t: number; relay: RelayStats; cpu: Record<string, number>; rss: Record<string, number> };
  const samples: Sample[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        const s = await relayStats();
        const cpu: Record<string, number> = {}, rss: Record<string, number> = {};
        const add = (k: string, pid: number) => { const p = proc(pid); cpu[k] = (cpu[k] ?? 0) + p.cpuMs; rss[k] = (rss[k] ?? 0) + p.rss; };
        add('relay', relayProc.pid!); add('derper', derper); add('services', process.pid);
        for (const w of workers) if (w.c.exitCode === null) add(w.kind, w.c.pid!);
        samples.push({ t: Date.now(), relay: { ...s, firstReq: {} }, cpu, rss });
      } catch { /* a worker gone */ }
      await sleep(1000 - (Date.now() % 1000));
    }
  })();
  /** Rates over [t0, t1): the relay's per second, CPU as cores, RSS at the end (MiB). */
  const over = (t0: number, t1: number) => {
    const a = samples.find((s) => s.t >= t0) ?? samples[0], b = [...samples].reverse().find((s) => s.t <= t1) ?? samples.at(-1)!;
    const sec = Math.max(1e-3, (b.t - a.t) / 1000);
    const per = (k: keyof RelayStats) => ((b.relay[k] as number) - (a.relay[k] as number)) / sec;
    return {
      seconds: sec,
      relayPerSecond: { reqs: per('reqs'), eventsIn: per('eventsIn'), forwards: per('forwards'), kbIn: per('bytesIn') / 1024, kbOut: per('bytesOut') / 1024 },
      cores: Object.fromEntries(Object.keys(b.cpu).map((k) => [k, (b.cpu[k] - (a.cpu[k] ?? 0)) / 1000 / sec])),
      rssMB: Object.fromEntries(Object.keys(b.rss).map((k) => [k, b.rss[k] / 2 ** 20])),
    };
  };
  const servers: number[] = Array.from({ length: SERVERS }, (_, i) => i);
  const serverWorkers = Array.from({ length: SERVERS / 2 }, () => spawnWorker('server'));
  const serverSpec = (i: number, records?: string[]): NodeSpec => ({
    id: i, link, titles: T.servers[i].map((t) => ({ key: t.key, item: t.items[0] })), records,
    ...(phase === 'junk' ? { maxNames: Number(o.bound) } : {}),
  });
  const startServers = (records?: string[]) => {
    for (let w = 0; w < serverWorkers.length; w++) {
      tell(serverWorkers[w], { type: 'start', spacingMs: 500, services: cal.url, explorer: cal.explorer, nodes: servers.filter((i) => i % serverWorkers.length === w).map((i) => serverSpec(i, records)) });
    }
  };
  const serverOf = (i: number) => serverWorkers[i % serverWorkers.length];
  const fetchTotals = (rs: NodeReport[]) => rs.reduce((a, r) => { for (const [k, v] of Object.entries(r.fetches)) a[k] = (a[k] ?? 0) + v; return a; }, {} as Record<string, number>);
  const logTotals = (rs: NodeReport[]) => rs.reduce((a, r) => { for (const [k, v] of Object.entries(r.logs)) a[k] = (a[k] ?? 0) + v; return a; }, {} as Record<string, number>);
  const serverSummary = (rs: NodeReport[]) => ({
    names: dist(rs.map((r) => r.names?.names ?? 0)), serving: rs.filter((r) => r.names?.serving).length,
    wasmMB: dist(rs.map((r) => r.memory / 2 ** 20)), fetches: fetchTotals(rs), fetchesPerServer: dist(rs.map((r) => Object.values(r.fetches).reduce((a, b) => a + b, 0))),
    stored: rs.reduce((a, r) => a + r.stored, 0), deleted: rs.reduce((a, r) => a + r.deleted, 0), logs: logTotals(rs),
  });
  const records = [`${LOCAL}/records-0.bin`, `${LOCAL}/records-1.bin`];
  /** Members `ids` in the member processes, `perSecond` together; each asks `ask(id)` once it runs, if given. */
  const memberWorkers: W[] = [];
  const startMembers = (ids: number[], perSecond: number, ask?: (id: number) => string | undefined) => {
    while (memberWorkers.length < 4) memberWorkers.push(spawnWorker('member'));
    for (let w = 0; w < memberWorkers.length; w++) {
      tell(memberWorkers[w], {
        type: 'start', spacingMs: (1000 * memberWorkers.length) / perSecond, services: cal.url, explorer: cal.explorer,
        nodes: ids.filter((i) => i % memberWorkers.length === w).map((id) => ({ id, link, ...(ask?.(id) ? { ask: ask(id) } : {}) })),
      });
    }
  };
  const memberOf = (id: number) => memberWorkers[id % memberWorkers.length];
  const waitFor = async (what: string, ms: number, f: () => boolean) => {
    const t = Date.now();
    while (!f()) {
      if (Date.now() - t > ms) { log(`${what}: not within ${ms / 1000} s`); return false; }
      await sleep(250);
    }
    return true;
  };
  const answersOf = (from: number, to = Infinity) => answers.filter((a) => a.at >= from && a.at < to);
  const answerSummary = (as: Answer[]) => ({
    asked: as.length, found: as.filter((a) => a.rcode === 0 && a.answers > 0).length,
    nxdomain: as.filter((a) => a.rcode === 3).length, failed: as.filter((a) => !(a.rcode === 0 && a.answers > 0) && a.rcode !== 3).length,
    ms: dist(as.filter((a) => a.rcode === 0 && a.answers > 0).map((a) => a.ms)), tries: dist(as.map((a) => a.tries)),
  });

  try {
    if (phase === 'converge') {
      const t0 = Date.now();
      log(`converge: ${SERVERS} servers, ${PER_SERVER} titles each`);
      startServers();
      const want = SERVERS * PER_SERVER;
      const deadline = Number(o.wait) * 1000;
      const progress: [number, number[]][] = [];
      let full = false;
      while (Date.now() - t0 < deadline) {
        await sleep(5000);
        const ns = servers.map((i) => latest(i)?.names ?? 0);
        progress.push([(Date.now() - t0) / 1000, ns]);
        if (progress.length % 6 === 0) log(`names held: ${JSON.stringify(dist(ns))}`);
        if (ns.every((n) => n >= want)) { full = true; break; }
      }
      const rs = await report(serverWorkers);
      const fullAt = servers.map((i) => (lines.get(i)?.find((l) => l.names >= want)?.at ?? NaN) - t0);
      const servingAt = servers.map((i) => (lines.get(i)?.find((l) => l.serving)?.at ?? NaN) - t0);
      results.converge = {
        full, seconds: (Date.now() - t0) / 1000, runningMs: dist(servers.map((i) => (running.get(i) ?? NaN) - (startedAt.get(i) ?? NaN))),
        servingS: dist(servingAt.map((x) => x / 1000)), fullS: dist(fullAt.filter(Number.isFinite).map((x) => x / 1000)),
        ...serverSummary(rs), over: over(t0, Date.now()), calendarRequests: cal.requests,
        progress: progress.filter((_, k) => k % 3 === 0).map(([t, ns]) => [t, q(ns, 0), q(ns, 0.5), q(ns, 1)]),
      };
      log(JSON.stringify(round({ ...results.converge as object, progress: undefined })));
      // Idle with the registry held: 20 s.
      const i0 = Date.now();
      await sleep(20_000);
      results.idle = over(i0, Date.now());
      for (const i of [0, 1]) tell(serverOf(i), { type: 'save', id: i, file: records[i] });
      await waitFor('saved', 30_000, () => saved >= 2);
    } else if (phase === 'members') {
      const t0 = Date.now();
      startServers(records);
      await waitFor('servers serving', 300_000, () => servers.every((i) => latest(i)?.serving));
      const tServing = Date.now();
      log(`servers serving after ${(tServing - t0) / 1000} s`);
      results.serversUp = { servingS: (tServing - t0) / 1000, ...serverSummary(await report(serverWorkers)) };
      // 500 members at 100 a second.
      const j0 = Date.now();
      startMembers(Array.from({ length: 500 }, (_, i) => 1000 + i), 100);
      await waitFor('500 running', 60_000, () => [...running.keys()].filter((i) => i >= 1000).length >= 500);
      results.join500 = { seconds: (Date.now() - j0) / 1000, over: over(j0, Date.now()) };
      log(`500 members running in ${(Date.now() - j0) / 1000} s`);
      await sleep(5000);
      const i0 = Date.now();
      const r0 = await report(serverWorkers);
      await sleep(60_000);
      const r1 = await report(serverWorkers);
      results.idle = { ...over(i0, Date.now()), servers: serverSummary(r1), fetchesDuring: fetchTotals(r1).blockstream - (fetchTotals(r0).blockstream ?? 0) };
      log(`idle: ${JSON.stringify(round(results.idle))}`);
      // Cold first lookups: 100 members, two a second, a random name each.
      const c0 = Date.now();
      for (let k = 0; k < 100; k++) {
        const id = 1000 + k;
        tell(memberOf(id), { type: 'ask', id, name: pick(allNames), ms: 30_000 });
        await sleep(500);
      }
      await waitFor('cold lookups', 60_000, () => answersOf(c0).length >= 100);
      results.cold = { ...answerSummary(answersOf(c0)), over: over(c0, Date.now()) };
      log(`cold: ${JSON.stringify(round(results.cold))}`);
      // The same members again, another random name each (the names client up, the room's spread known).
      const w0 = Date.now();
      for (let k = 0; k < 100; k++) {
        const id = 1000 + k;
        tell(memberOf(id), { type: 'ask', id, name: pick(allNames), ms: 30_000 });
        await sleep(500);
      }
      await waitFor('second lookups', 60_000, () => answersOf(w0).length >= 100);
      results.second = { ...answerSummary(answersOf(w0)), over: over(w0, Date.now()) };
      log(`second: ${JSON.stringify(round(results.second))}`);
      // 500 more members in a minute, each asking a random name as it runs.
      const k0 = Date.now();
      const r2 = await report(serverWorkers);
      startMembers(Array.from({ length: 500 }, (_, i) => 2000 + i), 500 / 60, () => pick(allNames));
      await waitFor('joiners asked', 150_000, () => answers.filter((a) => a.id >= 2000).length >= 500);
      const r3 = await report(serverWorkers);
      const joined = answers.filter((a) => a.id >= 2000);
      results.join500InAMinute = {
        ...answerSummary(joined), seconds: (Date.now() - k0) / 1000, over: over(k0, Date.now()),
        byTenSeconds: Array.from({ length: 9 }, (_, k) => answerSummary(joined.filter((a) => a.at >= k0 + k * 10_000 && a.at < k0 + (k + 1) * 10_000)).found),
        serverLogsDuring: Object.fromEntries(Object.entries(logTotals(r3)).map(([k, v]) => [k, v - (logTotals(r2)[k] ?? 0)])),
      };
      log(`join 500 in a minute: ${JSON.stringify(round({ ...results.join500InAMinute as object, over: undefined }))}`);
      const all = await report();
      results.end = {
        servers: serverSummary(all.filter((r) => r.id < SERVERS)),
        memberWasmKB: dist(all.filter((r) => r.id >= 1000).map((r) => r.memory / 1024)),
        memberLogs: logTotals(all.filter((r) => r.id >= 1000)),
        joinerLogs: logTotals(all.filter((r) => r.id >= 2000)),
        workers: reports.map((r) => ({ rssMB: r.rss / 2 ** 20, cpuS: r.cpuMs / 1000, nodes: r.nodes.length })),
        calendarRequests: cal.requests, over: over(t0, Date.now()),
      };
    } else if (phase === 'junk') {
      const t0 = Date.now();
      startServers(records);
      await waitFor('servers serving', 300_000, () => servers.every((i) => latest(i)?.serving));
      log(`servers serving after ${(Date.now() - t0) / 1000} s`);
      // 100 members keep 500 names in use: each resolves 5 (kept names refresh every 5 minutes at their servers).
      const used = [...allNames].sort(() => Math.random() - 0.5).slice(0, 500);
      const usedIds = new Set(T.servers.flat().filter((t) => used.includes(t.name)).map(idOf));
      startMembers(Array.from({ length: 100 }, (_, i) => 1000 + i), 50);
      await waitFor('members running', 60_000, () => [...running.keys()].filter((i) => i >= 1000).length >= 100);
      const u0 = Date.now();
      const useAll = async () => {
        for (let k = 0; k < 500; k++) {
          const id = 1000 + (k % 100);
          tell(memberOf(id), { type: 'ask', id, name: used[k], ms: 20_000 });
          await sleep(40);
        }
      };
      await useAll();
      await waitFor('names in use', 90_000, () => answersOf(u0).length >= 500);
      results.inUse = answerSummary(answersOf(u0));
      log(`in use: ${JSON.stringify(round(results.inUse))}`);
      // The registrant: a server of its own holding the junk titles.
      const j0 = Date.now();
      const junkWorker = spawnWorker('junk');
      tell(junkWorker, {
        type: 'start', spacingMs: 0, services: cal.url, explorer: cal.explorer,
        nodes: [{ id: 99, link, titles: T.junk.map((t) => ({ key: t.key, item: t.items[0] })), maxNames: 20_000 }],
      });
      const deadline = Number(o.wait) * 1000;
      const progress: unknown[] = [];
      let k = 0;
      while (Date.now() - j0 < deadline) {
        await sleep(10_000);
        const rs = await report(serverWorkers);
        const dropped = rs.flatMap((r) => r.deletedIds);
        const row = { t: (Date.now() - j0) / 1000, names: q(rs.map((r) => r.names?.names ?? 0), 0.5), junk: dropped.filter((d) => junkIds.has(d)).length, honest: dropped.filter((d) => honestIds.has(d)).length };
        progress.push(row);
        if (++k % 3 === 0) log(`junk: ${JSON.stringify(row)}`);
        // The names in use asked again every 2 minutes (as members' refreshes and guests do).
        if (k % 12 === 0) void useAll();
      }
      const rs = await report(serverWorkers);
      const per = rs.map((r) => {
        const d = new Set(r.deletedIds);
        return { junk: [...d].filter((x) => junkIds.has(x)).length, honestUsed: [...d].filter((x) => usedIds.has(x)).length, honestUnused: [...d].filter((x) => honestIds.has(x) && !usedIds.has(x)).length };
      });
      results.junk = {
        bound: Number(o.bound), seconds: (Date.now() - j0) / 1000, perServer: per,
        dropped: { junk: dist(per.map((p) => p.junk)), honestUsed: dist(per.map((p) => p.honestUsed)), honestUnused: dist(per.map((p) => p.honestUnused)) },
        servers: serverSummary(rs), over: over(j0, Date.now()), progress,
      };
      log(`junk: ${JSON.stringify(round({ ...results.junk as object, progress: undefined, perServer: undefined }))}`);
      // The names in use, resolved now.
      const a0 = Date.now();
      void useAll();
      await waitFor('names in use after', 90_000, () => answersOf(a0).length >= 500);
      results.inUseAfter = answerSummary(answersOf(a0));
      log(`in use after: ${JSON.stringify(round(results.inUseAfter))}`);
    }
  } finally {
    sampling = false;
    await sampler;
    for (const w of workers) { try { tell(w, { type: 'stop' }); } catch { /* gone */ } }
    await sleep(1000);
    for (const w of workers) w.c.kill();
    relayProc.kill();
    await cal.close();
    spawnSync(rig, ['down']);
  }
}
const row = round(results);
if (o.out) writeFileSync(`${ROOT}bench/net/${o.out}`, `${JSON.stringify(row, null, 1)}\n`);
else if (existsSync(LOCAL)) writeFileSync(`${LOCAL}/${phase}-${Date.now()}.json`, `${JSON.stringify(row, null, 1)}\n`);
process.exit(0);
