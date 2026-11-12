// R3 (docs/networking/rooms.md "Numbers"): a room at scale, with nothing outside the test harness. N synthetic members
// (bench/net/room-member.ts: the Rust client, a module instance each as a page's worker has, relay only) in P worker
// processes join one room on the tests' Nostr relay (tests/net/nostr-relay.ts, its own process) and the tailcat rig's
// derper (tests/net/tailcat.sh), then, in phases:
//
// - join: members start at `rate` a second; each one's time to its first REQ at the relay (each member's Nostr URL
//   has a path of its own, so the relay tells them apart) and to `Running` (its home region connected);
// - idle: a minute of nothing: every process's CPU and memory, the relay's traffic (subscriptions renew each minute);
// - lookups: random pairs, at 10 and then 50 new pairs a second: the time from the guest's first packet to the
//   first echo back (lookup, call back, handshake, the echo; relay only, so all through DERP);
// - crowd: 20, then 200 members send to one member at once (a directory, a popular server): how many reach it;
// - the hour: the members' clocks are shifted so that the hour turns during the run; the relay's REQs a second
//   from 10 s before it to 70 s after, and pairs that dial across it.
//
// Every second the relay's counters and the processes' CPU (/proc) are sampled. Usage:
//   node bench/net/room-scale.ts [members] [processes] [out.json]
// Needs NODE_EXTRA_CA_CERTS for the rig's certificate (the script sets it for its children).
import { execFileSync, fork, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpus } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import type { FromWorker, ToWorker } from './room-scale-worker.ts';
import type { RelayStats } from '../../tests/net/nostr-relay.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const N = Number(process.argv[2] ?? 1000);
const P = Number(process.argv[3] ?? 4);
const out = process.argv[4];
const RATE = 100; // members started a second, all processes together
const DERP = '127.0.0.1:8444';
const rig = `${ROOT}tests/net/tailcat.sh`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const log = (s: string) => console.log(`# ${new Date().toISOString().slice(11, 19)} ${s}`);

const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const dist = (xs: number[]) => ({ n: xs.length, p50: q(xs, 0.5), p90: q(xs, 0.9), p99: q(xs, 0.99), max: q(xs, 1) });
const round = (v: unknown): unknown => typeof v === 'number' ? Math.round(v * 10) / 10 : Array.isArray(v) ? v.map(round)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v;

/** CPU ms (utime + stime) and RSS bytes of `pid`, from /proc. */
function proc(pid: number) {
  const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  const rss = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))![1]) * 1024;
  return { cpuMs: (Number(f[11]) + Number(f[12])) * 10, rss };
}

execFileSync(rig, ['up'], { encoding: 'utf8', timeout: 300_000 });
const env = { ...process.env, NODE_EXTRA_CA_CERTS: `${ROOT}target/net/tailcat-test/certs/127.0.0.1.crt` };
const derper = Number(readFileSync(`${ROOT}target/net/tailcat-test/run/derper.pid`, 'utf8'));
const relayProc = spawn(process.execPath, [`${ROOT}tests/net/nostr-relay.ts`], { stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => relayProc.kill());
const relayURL = await new Promise<string>((resolve) => relayProc.stdout!.once('data', (d: Buffer) => resolve(d.toString().trim())));
const statsURL = relayURL.replace('ws://', 'http://') + '/stats';
const stats = async () => await (await fetch(statsURL)).json() as RelayStats;

const workers: ChildProcess[] = [];
const started = new Map<number, { at: number; address6: number[]; key: string }>();
const pinged: { from: number; tag: string; at: number; ms: number }[] = [];
let reports: Extract<FromWorker, { type: 'report' }>[] = [];
for (let w = 0; w < P; w++) {
  const c = fork(`${ROOT}bench/net/room-scale-worker.ts`, [], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  c.on('message', (m: FromWorker) => {
    if (m.type === 'started') started.set(m.id, m);
    else if (m.type === 'pinged') pinged.push(m);
    else reports.push(m);
  });
  c.on('exit', (code, signal) => { if (code !== 0) log(`worker ${w} exited: ${code ?? signal}`); });
  workers.push(c);
}
const worker = (id: number) => workers[id % P];
const tell = (c: ChildProcess, m: ToWorker) => c.send(m);
async function report() {
  reports = [];
  for (const c of workers) tell(c, { type: 'report' });
  const t = Date.now();
  while (reports.length < P && Date.now() - t < 30_000) await sleep(20);
  return reports;
}

// Every second: the relay's counters, and CPU of the relay, the derper and the workers.
type Sample = { t: number; relay: RelayStats; cpu: { relay: number; derper: number; workers: number }; rss: { relay: number; derper: number; workers: number } };
const samples: Sample[] = [];
async function sample() {
  const s = await stats();
  const ws = workers.map((c) => proc(c.pid!));
  const r = proc(relayProc.pid!), d = proc(derper);
  samples.push({
    t: Date.now(), relay: { ...s, firstReq: {} },
    cpu: { relay: r.cpuMs, derper: d.cpuMs, workers: ws.reduce((a, x) => a + x.cpuMs, 0) },
    rss: { relay: r.rss, derper: d.rss, workers: ws.reduce((a, x) => a + x.rss, 0) },
  });
}
let sampling = true, sampleFailed = false;
const sampler = (async () => { while (sampling) { await sample().catch((e) => { if (!sampleFailed) log(`sample: ${e}`); sampleFailed = true; }); await sleep(1000 - (Date.now() % 1000)); } })();

/** Rates over [t0, t1): the relay's per second, CPU as cores. */
function over(t0: number, t1: number) {
  const a = samples.find((s) => s.t >= t0)!, b = [...samples].reverse().find((s) => s.t <= t1)!;
  const sec = (b.t - a.t) / 1000;
  const per = (k: keyof RelayStats) => ((b.relay[k] as number) - (a.relay[k] as number)) / sec;
  const cores = (k: keyof Sample['cpu']) => (b.cpu[k] - a.cpu[k]) / 1000 / sec;
  const peak = (k: 'reqs' | 'eventsIn') => {
    let m = 0;
    for (let i = samples.indexOf(a) + 1; i <= samples.indexOf(b); i++) m = Math.max(m, (samples[i].relay[k] as number) - (samples[i - 1].relay[k] as number));
    return m;
  };
  return {
    seconds: sec,
    relayPerSecond: { reqs: per('reqs'), closes: per('closes'), eventsIn: per('eventsIn'), forwards: per('forwards'), kbIn: per('bytesIn') / 1024, kbOut: per('bytesOut') / 1024 },
    relayPeakPerSecond: { reqs: peak('reqs'), eventsIn: peak('eventsIn') },
    cores: { relay: cores('relay'), derper: cores('derper'), workers: cores('workers') },
    rssMB: { relay: b.rss.relay / 2 ** 20, derper: b.rss.derper / 2 ** 20, workers: b.rss.workers / 2 ** 20 },
  };
}

/** Pings `pairs` [from, to] starting at `at` + i / `perSecond` s; waits for them all; their times. */
async function pings(tag: string, pairs: [number, number][], at: number, perSecond: number, ms = 10_000) {
  const jobs = new Map<ChildProcess, Extract<ToWorker, { type: 'ping' }>['jobs']>();
  pairs.forEach(([f, t], i) => {
    const c = worker(f);
    if (!jobs.has(c)) jobs.set(c, []);
    jobs.get(c)!.push({ from: f, to: started.get(t)!.address6, at: at + Math.floor(i * 1000 / perSecond), ms, tag });
  });
  for (const [c, j] of jobs) tell(c, { type: 'ping', jobs: j });
  const t = Date.now();
  while (pinged.filter((p) => p.tag === tag).length < pairs.length && Date.now() - t < 120_000 + pairs.length * 1000 / perSecond) await sleep(100);
  const got = pinged.filter((p) => p.tag === tag);
  const ok = got.filter((p) => p.ms >= 0).map((p) => p.ms);
  return { pairs: pairs.length, reached: ok.length, ms: dist(ok), byAt: got };
}

const randomPairs = (n: number): [number, number][] => Array.from({ length: n }, () => {
  const f = Math.floor(Math.random() * N);
  let t = Math.floor(Math.random() * (N - 1));
  if (t >= f) t++;
  return [f, t];
});

const results: Record<string, unknown> = {};
try {
  const room = `scale ${Math.random()}`;
  const t0 = Date.now();
  // The hour turns at `turn` on the members' clocks: after the phases before it (join ~N/RATE s and its wait, idle
  // 60 s, lookups 60 s and their tail, the crowds ~40 s).
  const turn = t0 + (N / RATE + 320) * 1000;
  const unixOffset = Math.ceil(turn / 1000 / 3600) * 3600 - Math.floor(turn / 1000);

  // Join.
  log(`join: ${N} members in ${P} processes at ${RATE}/s`);
  for (let w = 0; w < P; w++) {
    const ids = Array.from({ length: N }, (_, i) => i).filter((i) => i % P === w);
    tell(workers[w], {
      type: 'start', spacingMs: 1000 * P / RATE,
      members: ids.map((id) => ({ id, unixOffset, link: `webpc-room:${encodeURIComponent(room)}?nostr=${encodeURIComponent(`${relayURL}/m${id}`)}&derp=${encodeURIComponent(DERP)}` })),
    });
  }
  let s: RelayStats;
  for (;;) {
    s = await stats();
    if (Object.keys(s.firstReq).length >= N || Date.now() - t0 > (N / RATE + 60) * 1000) break;
    await sleep(500);
  }
  const joined = Date.now();
  const reqMs = [...started].map(([id, m]) => (s.firstReq[`/m${id}`] ?? NaN) - m.at);
  let r = await report();
  const members = r.flatMap((x) => x.members);
  const running = members.map((m) => m.runningMs ?? NaN);
  const tenth = Math.floor(N / 10);
  results.join = {
    joinSeconds: (joined - t0) / 1000, subscribed: Object.keys(s.firstReq).length, failed: members.filter((m) => m.failed).length,
    firstReqMs: dist(reqMs.filter(Number.isFinite)), runningMs: dist(running.filter(Number.isFinite)),
    firstReqMsFirstTenth: dist(reqMs.slice(0, tenth).filter(Number.isFinite)), firstReqMsLastTenth: dist(reqMs.slice(-tenth).filter(Number.isFinite)),
    ...over(t0, joined),
  };
  log(`joined: ${JSON.stringify(round(results.join))}`);

  // Idle.
  await sleep(5000);
  const i0 = Date.now();
  const c0 = await report();
  await sleep(60_000);
  const i1 = Date.now();
  r = await report();
  const cpuMs = r.reduce((a, x) => a + x.cpuMs, 0) - c0.reduce((a, x) => a + x.cpuMs, 0);
  const wasm = r.flatMap((x) => x.members.map((m) => m.memory));
  results.idle = {
    ...over(i0, i1), workerCpuMsPerMemberPerSecond: cpuMs / N / ((i1 - i0) / 1000),
    wasmMemoryKB: dist(wasm.map((b) => b / 1024)), rssKBPerMember: r.reduce((a, x) => a + x.rss, 0) / N / 1024,
  };
  log(`idle: ${JSON.stringify(round(results.idle))}`);

  // Lookups at load.
  const lookups: Record<string, unknown> = {};
  for (const [perSecond, seconds] of [[10, 30], [50, 30]] as const) {
    const at = Date.now() + 1000;
    const res = await pings(`load${perSecond}`, randomPairs(perSecond * seconds), at, perSecond);
    lookups[`${perSecond}PerSecond`] = { pairs: res.pairs, reached: res.reached, ms: res.ms, ...over(at, at + seconds * 1000) };
    log(`lookups ${perSecond}/s: ${JSON.stringify(round(lookups[`${perSecond}PerSecond`]))}`);
  }
  results.lookups = lookups;
  r = await report();
  results.afterLookups = { peers: dist(r.flatMap((x) => x.members.map((m) => m.peers))), wasmMemoryKB: dist(r.flatMap((x) => x.members.map((m) => m.memory / 1024))) };

  // Crowds: k members dial one target at once.
  const crowds: Record<string, unknown> = {};
  for (const [k, target] of [[20, 1], [200, 2]].filter(([k]) => k + 10 <= N)) {
    const pairs = Array.from({ length: k }, (_, i): [number, number] => [10 + i, target]);
    const res = await pings(`crowd${k}`, pairs, Date.now() + 500, 1e6, 15_000);
    const reachedBy = (sec: number) => res.byAt.filter((p) => p.ms >= 0 && p.ms <= sec * 1000).length;
    crowds[`${k}`] = { reached: res.reached, ms: res.ms, within: { '1s': reachedBy(1), '3s': reachedBy(3), '6s': reachedBy(6), '15s': reachedBy(15) } };
    log(`crowd ${k}: ${JSON.stringify(round(crowds[`${k}`]))}`);
    await sleep(2000);
  }
  results.crowds = crowds;

  // The hour's turn: pairs one a second from 10 s before it to 20 s after.
  const wait = turn - 10_000 - Date.now();
  log(`the hour turns in ${Math.round((turn - Date.now()) / 1000)} s`);
  if (wait < 0) throw new Error('the phases ran past the planned turn: start later');
  await sleep(wait);
  const h = await pings('hour', randomPairs(30), turn - 10_000, 1);
  await sleep(turn + 71_000 - Date.now());
  // The relay's REQs a second from 10 s before the turn to 70 s after.
  const perSecond = samples.filter((x) => x.t >= turn - 10_000 && x.t <= turn + 70_000)
    .map((x, i, a) => i ? x.relay.reqs - a[i - 1].relay.reqs : 0).slice(1);
  results.hour = {
    reached: h.reached, pairs: h.pairs, failedAt: h.byAt.filter((p) => p.ms < 0).map((p) => (p.at - turn) / 1000),
    around: over(turn - 5000, turn + 5000), atTurn: over(turn - 1000, turn + 2000), minuteAfter: over(turn, turn + 65_000),
    reqsPerSecondFromTenBefore: perSecond,
  };
  log(`hour: ${JSON.stringify(round(results.hour))}`);
} finally {
  sampling = false;
  await sampler;
  for (const c of workers) { try { tell(c, { type: 'stop' }); } catch { /* gone */ } }
  await sleep(1000);
  relayProc.kill();
  spawnSync(rig, ['down']);
  const row = { date: new Date().toISOString(), host: `${process.platform} ${process.arch}`, cpus: cpus().length, node: process.version, members: N, processes: P, rate: RATE, results: round(results) };
  console.log(JSON.stringify(row));
  if (out) writeFileSync(out, JSON.stringify(row, null, 2) + '\n');
}
