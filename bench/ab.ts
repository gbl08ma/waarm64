// A paired A/B of core builds with a stopping rule (docs/benchmarking.md "The paired A/B"; on the Mac through
// bench/ab-mac.sh): every arm is a page of one Chromium (bench/boot/pair.ts: its core compiled once), and a round
// runs one sample of the workload on each arm, one after the other, in an order drawn at random. A pair
// is a block: a freshly launched browser, the arms' pages, a warm-up sample of each (`--warm`: `same`, the
// workload itself; another workload; `none`) and `--rounds` rounds, each in a random order; an arm's samples of a
// block over the base's. Each measure's pairs give an interval
// (bench/stats.ts `paired`, the tail of `lookAlpha`: looking after every pair is paid for), and the workload stops
// once every arm's stop measures are each a difference or inside the band, or at the cap or the budget (one clock
// for the whole run: a workload it leaves no time for isn't run); an arm decided earlier stops running. `--aa` runs
// the base a second time as the arm `aa`: what the same core against itself gives at this moment, to hold a result
// against (it holds the stop only when it is the one arm: `--aa` with the base alone is an A/A run).
//   node bench/ab.ts --out <dir> [--workloads node,user,boot] [--min 4] [--cap 12] [--band 0.5] [--overall 0.01]
//     [--stop cycles,wall (smp: wall)] [--budget <s>] [--warm same] [--rounds 1] [--aa] <base>=<core.wasm> <arm>=<core.wasm>[@<tree>][?<query>]...
// `@<tree>`: the arm's page, host code and dev server come from another checkout (a core of another ABI), with this
// tree's bench/boot/pair* copied over it; `?<query>`: more of that arm's page query (`nocw`, `fma=emul`: what
// bench/boot/suite.ts's `boot` reads). Measures (lower is better in all): `wall` ms, `cycles` and `instr` a guest
// step (where the host counts them: macOS), `cpu` ns a step. `--analyze <dir>` prints a finished run's verdict again.
// Writes <dir>/ab.json after every pair (every sample, in the order run) and <dir>/verdict.txt at the end, of a run
// that failed too (what it had, and why it ended: its exit is then 1).
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Server } from 'node:http';
import type { Latency, PairSample } from './boot/pair.ts';
import { lookAlpha, paired, quantile, rng, type Paired } from './stats.ts';

export type Arm = { name: string; core: string; tree: string; query: string; coreBytes?: number };
/** One sample as run: `at` its place in the round. */
export type Row = { workload: string; block: number; warm?: true; at: number; slot: number; arm: string; s: PairSample };
export type Run = { schema: 1; date: string; host: object; browser: string; arms: Arm[]; opts: Opts; alpha: number; seed?: number; rows: Row[]; ended?: Record<string, string>; failed?: string };
/** `stop`: the stop measures given (`--stop`), else each workload's (`stopFor`). */
type Opts = { min: number; cap: number; band: number; overall: number; stop: string[]; stopGiven?: boolean; budget: number; workloads: string[]; rounds: number; warm: string };

/**
 * A workload's stop measures when `--stop` doesn't name them: the clock and cycles a step, but the clock alone on
 * `smp`, whose work a step isn't fixed (parallel SMP: a vCPU's spins and the guest's scheduling are steps too, and
 * which vCPU runs what differs run to run; bench/boot/REPORT.md "PERF tooling: a multi-vCPU paired workload").
 */
const STOP_BY: Record<string, string[]> = { smp: ['wall'] };
export const stopFor = (o: Opts, workload: string) => (o.stopGiven === false ? (STOP_BY[workload] ?? o.stop) : o.stop);

/** A measure's value, or none: not counted on this host, or counters that went backwards (a renderer ended inside the sample). */
const pos = (x: number) => (x > 0 && Number.isFinite(x) ? x : undefined);
/** The measures a verdict is read from; undefined where the host doesn't count it. */
export const MEASURES: Record<string, (s: PairSample) => number | undefined> = {
  wall: (s) => pos(s.ms),
  cycles: (s) => pos((s.proc?.cycles ?? 0) / s.steps),
  instr: (s) => pos((s.proc?.instructions ?? 0) / s.steps),
  cpu: (s) => pos((s.proc?.cpuNs ?? 0) / s.steps),
};

/** The stop measures' names, checked: a mistyped one would otherwise never hold the stop. */
export function checkStop(stop: string[]): void {
  for (const m of stop) if (!(m in MEASURES)) throw new Error(`--stop: no measure "${m}"; one of ${Object.keys(MEASURES).join(', ')}`);
}

/**
 * A workload's blocks so far (warm-ups left out): each arm's measure against the base's. A pair is a block: the
 * arm's samples of it (their geometric mean, when a block has several rounds) over the base's.
 */
export function analyze(run: Run, workload: string): { pairs: number; arms: Record<string, Record<string, Paired>>; counts: Record<string, number>; decided: string[]; done: boolean } {
  const rows = run.rows.filter((r) => r.workload === workload && !r.warm);
  const base = run.arms[0].name;
  const by = (arm: string) => {
    const m = new Map<number, PairSample[]>();
    for (const r of rows) if (r.arm === arm) m.set(r.block, [...(m.get(r.block) ?? []), r.s]);
    return m;
  };
  const b = by(base);
  // A pair counts for an arm when it and the base ran all their rounds: one the run ended inside counts for neither,
  // and an arm decided earlier is left out of the pairs after (it no longer runs).
  const all = (arm: string, r: number) => rows.filter((x) => x.arm === arm && x.block === r).length === run.opts.rounds;
  const baseWhole = [...b.keys()].filter((r) => all(base, r));
  const arms: Record<string, Record<string, Paired>> = {};
  const counts: Record<string, number> = {};
  const decided: string[] = [];
  let done = true;
  for (const a of run.arms.slice(1)) {
    const mine = by(a.name);
    const whole = baseWhole.filter((r) => all(a.name, r));
    counts[a.name] = whole.length;
    arms[a.name] = {};
    let decides = 0;
    let open = false;
    for (const [m, f] of Object.entries(MEASURES)) {
      const gm = (ss: PairSample[]) => (ss.some((s) => f(s) === undefined) ? undefined : Math.exp(ss.reduce((t, s) => t + Math.log(f(s)!), 0) / ss.length));
      // A pair without the measure in either arm is left out of that measure alone.
      const xy = whole.map((r) => [gm(b.get(r)!), gm(mine.get(r)!)]).filter((p): p is [number, number] => p[0] !== undefined && p[1] !== undefined);
      if (!xy.length) continue;
      const p = paired(xy.map((v) => v[0]), xy.map((v) => v[1]), run.alpha, run.opts.band);
      arms[a.name][m] = p;
      if (!stopFor(run.opts, workload).includes(m)) continue;
      decides++;
      if (p.call === '?') open = true;
    }
    // An arm none of whose stop measures exists here (no counters, and the clock not among them) is never decided.
    const settled = decides > 0 && !open && whole.length >= run.opts.min;
    if (settled) decided.push(a.name);
    if (!settled && (a.name !== 'aa' || run.arms.length === 2)) done = false;
  }
  return { pairs: baseWhole.length, arms, counts, decided, done: done && baseWhole.length >= run.opts.min };
}

const WORD: Record<string, string> = { '=': 'same', '<': 'LOWER', '>': 'HIGHER', '?': 'open' };
const pct = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
const cell = (p?: Paired) => (p ? `${pct(p.pct)} [${pct(p.lo)}, ${pct(p.hi)}] ${WORD[p.call]}` : '-').padEnd(36);

/** The table of a workload's intervals, a line an arm. */
export function table(run: Run, workload: string): string[] {
  const a = analyze(run, workload);
  const ms = Object.keys(MEASURES).filter((m) => Object.values(a.arms).some((x) => x[m]));
  return [`${workload}: ${a.pairs} pairs against ${run.arms[0].name}`, `  ${'arm'.padEnd(12)} ${'pairs'.padStart(5)} ${ms.map((m) => m.padEnd(36)).join(' ')}`, ...Object.entries(a.arms).map(([n, x]) => `  ${n.padEnd(12)} ${String(a.counts[n]).padStart(5)} ${ms.map((m) => cell(x[m])).join(' ')}`)];
}

/** The verdict: each workload's table and how it ended, the A/A arm's warning, and each arm's memory and compile side. */
export function verdict(run: Run): string[] {
  const out: string[] = [];
  const med = (xs: number[]) => (xs.length ? quantile(xs, 0.5) : NaN);
  for (const w of run.opts.workloads) {
    const rows = run.rows.filter((r) => r.workload === w && !r.warm);
    if (!rows.length) { if (run.ended?.[w]) out.push(`${w}: ${run.ended[w]}`); continue; }
    const a = analyze(run, w);
    out.push(...table(run, w), `  ended: ${run.ended?.[w] ?? 'not finished'}`);
    const aa = Object.entries(a.arms.aa ?? {}).filter(([, p]) => p.call === '<' || p.call === '>').map(([m]) => m);
    if (aa.length) out.push(`  WARNING: the A/A arm differs from the base in ${aa.join(', ')}: this session's differences are suspect`);
    out.push(`  ${'arm'.padEnd(12)} ${['wall ms', 'P share', 'memory MiB', 'emit ms', 'compile ms', 'JIT wasm MiB', 'modules', 'interp steps'].map((h) => h.padStart(12)).join(' ')}`);
    for (const arm of run.arms) {
      const s = rows.filter((r) => r.arm === arm.name).map((r) => r.s);
      const j = (f: (x: PairSample['stats']['jit']) => number) => med(s.map((x) => f(x.stats.jit)));
      const v = [med(s.map((x) => x.ms)).toFixed(0), s[0]?.proc?.cycles ? med(s.map((x) => x.proc!.pCycles / x.proc!.cycles)).toFixed(4) : '-', s[0]?.footprint ? (med(s.map((x) => x.footprint!)) / 2 ** 20).toFixed(0) : '-', (j((x) => x.emitNs) / 1e6).toFixed(1), (j((x) => x.compileNs) / 1e6).toFixed(1), (j((x) => x.bytes) / 2 ** 20).toFixed(2), j((x) => x.modules).toFixed(0), j((x) => x.decSteps).toFixed(0)];
      out.push(`  ${arm.name.padEnd(12)} ${v.map((x) => x.padStart(12)).join(' ')}`);
    }
    // A parallel workload's latency counters (bench/boot/pair.ts `Latency`), each the median of the arm's samples,
    // and the longest stall and emission-to-ready delay of any.
    if (rows.some((r) => r.s.lat)) {
      out.push(`  ${'arm'.padEnd(12)} ${['compiled %', 'interp %', 'overdue', 'parks', 'modules', 'worker ms', 'ready ms', 'ready p50', 'ready p99', 'ready top', 'top of any', 'stall ms', 'of any', 'stall ms/s', 'out ms/s'].map((h) => h.padStart(10)).join(' ')}`);
      for (const arm of run.arms) {
        const l = rows.filter((r) => r.arm === arm.name && r.s.lat).map((r) => r.s.lat!);
        if (!l.length) continue;
        const m = (f: (x: Latency) => number, d = 0) => med(l.map(f)).toFixed(d);
        const most = (f: (x: Latency) => number) => Math.max(...l.map(f)).toFixed(0);
        const v = [m((x) => x.compiledPct, 2), m((x) => x.interpPct, 2), m((x) => x.overdue), m((x) => x.parks), m((x) => x.modules), m((x) => x.workerBusyMs), m((x) => x.readyMeanMs, 2), m((x) => x.readyP50Ms), m((x) => x.readyP99Ms), m((x) => x.readyTopMs), most((x) => x.readyTopMs), m((x) => x.stallMaxMs), most((x) => x.stallMaxMs), m((x) => x.stallMsPerS, 1), m((x) => x.outMsPerS, 0)];
        out.push(`  ${arm.name.padEnd(12)} ${v.map((x) => x.padStart(10)).join(' ')}`);
      }
    }
  }
  out.push(`arms: ${run.arms.map((a) => `${a.name} ${a.coreBytes ?? '?'} bytes${a.query && ` ?${a.query}`}`).join('; ')}`);
  out.push(`rule: a pair a fresh browser (warm-up ${run.opts.warm}, ${run.opts.rounds} round${run.opts.rounds > 1 ? 's' : ''}), pairs ${run.opts.min}-${run.opts.cap}, band ±${run.opts.band}%, stop on ${run.opts.workloads.map((w) => `${stopFor(run.opts, w).join(' and ')}${run.opts.workloads.length > 1 ? ` (${w})` : ''}`).join(', ')}${run.rows.some((r) => !r.s.proc?.cycles) ? ' (no cycles or instructions on this host)' : ''}, each interval's tail ${run.alpha.toExponential(2)} (${run.opts.overall} over all its looks, an interval: several arms and measures each take that chance); ${run.browser}`);
  return out;
}

/** 0..n-1 in a random order (Fisher-Yates over `u`). */
export function shuffled(n: number, u: () => number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(u() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

if (import.meta.main) {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: 'string' }, workloads: { type: 'string', default: 'node' }, min: { type: 'string', default: '4' }, cap: { type: 'string', default: '12' }, band: { type: 'string', default: '0.5' }, overall: { type: 'string', default: '0.01' }, stop: { type: 'string' }, budget: { type: 'string', default: '3000' }, rounds: { type: 'string', default: '1' }, aa: { type: 'boolean', default: false }, warm: { type: 'string', default: 'same' }, analyze: { type: 'string' } },
  });
  if (v.analyze) {
    console.log(verdict(JSON.parse(readFileSync(`${v.analyze}/ab.json`, 'utf8')) as Run).join('\n'));
    process.exit(0);
  }
  if (!v.out || positionals.length < 1) throw new Error('usage: node bench/ab.ts --out <dir> [--aa] <base>=<core.wasm> [<arm>=<core.wasm>[@<tree>][?<query>]...]');
  const here = resolve(import.meta.dirname, '..');
  const arms: Arm[] = positionals.map((p) => {
    const m = /^([A-Za-z0-9_.-]+)=([^@?]+)(?:@([^?]+))?(?:\?(.*))?$/.exec(p);
    if (!m) throw new Error(`arm "${p}": <name>=<core.wasm>[@<tree>][?<query>]`);
    return { name: m[1], core: resolve(m[2]), tree: m[3] ? resolve(m[3]) : here, query: m[4] ?? '' };
  });
  if (new Set(arms.map((a) => a.name)).size !== arms.length || arms.some((a) => a.name === 'aa' || /^slot\d+$/.test(a.name))) throw new Error("arms' names must differ, `aa` is the A/A arm's and `slot<n>` the served cores'");
  if (v.aa) arms.splice(1, 0, { ...arms[0], name: 'aa' });
  if (arms.length < 2) throw new Error('one arm: nothing to compare (--aa compares the base with itself)');
  const opts: Opts = { min: Number(v.min), cap: Number(v.cap), band: Number(v.band), overall: Number(v.overall), stop: (v.stop ?? 'cycles,wall').split(','), stopGiven: v.stop !== undefined, budget: Number(v.budget), workloads: v.workloads!.split(','), rounds: Number(v.rounds), warm: v.warm! };
  if (!(opts.min >= 2 && opts.cap >= opts.min)) throw new Error('--min at least 2, --cap at least --min');
  checkStop(opts.stop);
  mkdirSync(v.out, { recursive: true });

  // Each arm's tree gets this tree's page for an arm (its core is copied in pair by pair, below).
  for (const a of arms) {
    mkdirSync(`${a.tree}/target/ab`, { recursive: true });
    a.coreBytes = statSync(a.core).size;
    if (a.tree !== here) for (const f of ['pair.html', 'pair-page.ts', 'pair.ts']) copyFileSync(`${here}/bench/boot/${f}`, `${a.tree}/bench/boot/${f}`);
  }
  const { chromium } = await import('playwright-core');
  const { procServer } = await import('./procstat.ts');
  const servers = new Map<string, Server>();
  for (const t of new Set(arms.map((a) => a.tree))) {
    const { startServer } = (await import(pathToFileURL(`${t}/tools/serve.ts`).href)) as typeof import('../tools/serve.ts');
    servers.set(t, await startServer());
  }
  const proc = await procServer(process.pid);
  const launch = () => chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--js-flags=--expose-gc'] });
  let browser = await launch();
  const run: Run = { schema: 1, date: new Date().toISOString(), host: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.cpus().length }, browser: `Chromium ${browser.version()}`, arms, opts, alpha: lookAlpha(opts.min, opts.cap, opts.overall), rows: [], ended: {} };
  const save = () => writeFileSync(`${v.out}/ab.json`, JSON.stringify(run) + '\n');
  const t0 = performance.now();
  const left = () => opts.budget - (performance.now() - t0) / 1000;
  // Nothing but its core and its query may tell an arm from another: in every pair the arms draw their slots (the
  // name its core is served under, so its page's address) and the order their pages open in, and each round its
  // order (four A/A sessions with the arms' names and a rotating order all had the base fastest, by 0.1-0.15%).
  run.seed = Date.now() >>> 0;
  const u = rng(run.seed);
  /** The running arms' pages in a browser: arm `live[k]` in slot `slots[k]`, opened in a random order. */
  const open = async (live: number[], slots: number[]) => {
    const pages: import('playwright-core').Page[] = [];
    for (const k of shuffled(live.length, u)) {
      const i = live[k];
      const a = arms[i];
      copyFileSync(a.core, `${a.tree}/target/ab/slot${slots[k]}.wasm`);
      const page = await browser.newPage();
      page.on('pageerror', (e) => console.error(`[${a.name}] ${e.message}`));
      const qs = new URLSearchParams(a.query);
      qs.set('core', `target/ab/slot${slots[k]}.wasm`);
      qs.set('proc', String((proc.address() as { port: number }).port));
      await page.goto(`http://127.0.0.1:${(servers.get(a.tree)!.address() as { port: number }).port}/bench/boot/pair.html?${qs}`);
      await page.waitForFunction(() => 'pairSample' in window, null, { timeout: 60_000 });
      if (!(await page.evaluate(() => (window as unknown as { pairIsolated: boolean }).pairIsolated))) throw new Error('the page is not cross-origin isolated');
      pages[i] = page;
    }
    // A sample is bounded: a boot that hangs ends the run rather than the Mac's alarm ending it without a verdict.
    return (i: number, w: string) => {
      let timer: NodeJS.Timeout;
      const late = new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error(`${arms[i].name}: a ${w} sample took over 180 s`)), 180_000); });
      return Promise.race([pages[i].evaluate((w) => (window as unknown as { pairSample: (w: string) => Promise<unknown> }).pairSample(w), w) as Promise<PairSample>, late]).finally(() => clearTimeout(timer));
    };
  };
  try {
    let used = false; // the browser has run a pair: the next gets a new one, a later workload's first too
    for (const w of opts.workloads) {
      if (left() < 0) { run.ended![w] = `not run: the budget of ${opts.budget} s was spent`; continue; }
      // A block is a pair: a fresh browser and fresh pages (a page keeps a speed of its own for as long as it lives:
      // identical cores on two pages stayed 0.2% apart over 20 rounds), a warm-up sample of each arm, then the rounds.
      const warm = opts.warm === 'same' ? w : opts.warm;
      // An arm whose stop measures are decided stops running: its verdict stays the one it had, and the pairs after
      // are the remaining arms' (each arm is compared with the base alone, pair by pair). The base always runs, and
      // the A/A arm while any other does (it is what the remaining arms are held against).
      let decided = new Set<string>();
      for (let block = 1; ; block++) {
        if (used) { await browser.close(); browser = await launch(); }
        used = true;
        const live = arms.map((_, i) => i).filter((i) => i === 0 || !decided.has(arms[i].name));
        const slots = shuffled(live.length, u);
        const sample = await open(live, slots);
        const round = async (what: string, more: { warm?: true }) => {
          const o = shuffled(live.length, u);
          for (let at = 0; at < o.length; at++) {
            // The counters are every renderer's: a moment for the arm before to finish what it left (its collector,
            // V8 freeing its code) outside this arm's sample.
            await new Promise((ok) => setTimeout(ok, 300));
            run.rows.push({ workload: w, block, ...more, at, slot: slots[o[at]], arm: arms[live[o[at]]].name, s: await sample(live[o[at]], what) });
          }
        };
        if (warm !== 'none') await round(warm, { warm: true });
        for (let r = 0; r < opts.rounds; r++) {
          await round(w, {});
          console.error(`${w} pair ${block}: ${run.rows.slice(-live.length).map((r) => `${r.arm} ${r.s.ms.toFixed(0)}`).join(', ')} ms (${left().toFixed(0)} s left)`);
        }
        // A workload's check line (bench/boot/pair.ts) is one for every arm and every sample: a core that computes
        // something else isn't a faster one.
        const checks = new Set(run.rows.filter((r) => r.workload === w && r.s.check !== undefined).map((r) => r.s.check));
        if (checks.size > 1) throw new Error(`${w}: the guest's check line differs between samples: ${[...checks].join(' | ')}`);
        const a = analyze(run, w);
        const was = decided.size;
        decided = new Set(a.decided.filter((n) => n !== 'aa' || arms.length === 2));
        if (decided.size > was) console.error(`${w}: decided, no longer run: ${[...decided].join(', ')}`);
        const end = a.done ? 'every stop measure decided' : block >= opts.cap ? `the cap of ${opts.cap} pairs` : left() < 0 ? `the budget of ${opts.budget} s` : '';
        if (block >= opts.min || end) console.error(table(run, w).slice(1).join('\n'));
        if (end) run.ended![w] = end;
        save();
        if (end) break;
      }
    }
  } catch (e) {
    run.failed = String((e as Error).message ?? e);
  } finally {
    save();
    await browser.close().catch(() => {});
    for (const s of servers.values()) s.close();
    proc.close();
  }
  const text = [...verdict(run), ...(run.failed ? [`FAILED: ${run.failed}`] : [])].join('\n');
  writeFileSync(`${v.out}/verdict.txt`, text + '\n');
  console.log(text);
  if (run.failed) process.exit(1);
}
