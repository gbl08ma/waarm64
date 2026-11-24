// The paired A/B's statistics and its verdict in Node (bench/stats.ts, bench/ab.ts; docs/benchmarking.md "The paired
// A/B"): Student's t against its table, the tail a stopping rule's looks pay, an interval's call against the band,
// a round's random order, a run's analysis (the warm-up left out, the A/A arm holding the stop only when alone),
// and the node workload's script (images/alpine/node/jitjit.js), whose check line is fixed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { analyze, checkStop, shuffled, stopFor, verdict, type Run } from '../bench/ab.ts';
import type { Latency, PairSample } from '../bench/boot/pair.ts';
import { lookAlpha, paired, rng, tCrit, tTail2 } from '../bench/stats.ts';

const near = (a: number, b: number, eps: number) => assert.ok(Math.abs(a - b) < eps, `${a} against ${b}`);
/** Normal noise, seeded. */
const normal = (u: () => number) => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());

test("Student's t: the table's critical values and their tails", () => {
  near(tCrit(0.05, 3), 3.1824, 1e-3);
  near(tCrit(0.01, 10), 3.1693, 1e-3);
  near(tCrit(0.001, 3), 12.924, 1e-2);
  near(tCrit(0.05, 1000), 1.9623, 1e-3);
  near(tTail2(2.2281, 10), 0.05, 1e-4);
});

test("a stopping rule's looks: each interval's tail keeps a null's false differences at the overall rate", () => {
  const [min, cap, overall] = [4, 24, 0.05];
  const alpha = lookAlpha(min, cap, overall);
  assert.ok(alpha < overall / 4 && alpha > overall / 50, `${alpha}`);
  const u = rng(99);
  let wrong = 0, naive = 0;
  const crit = Array.from({ length: cap + 1 }, (_, n) => (n >= min ? [tCrit(alpha, n - 1), tCrit(overall, n - 1)] : [0, 0]));
  for (let s = 0; s < 4000; s++) {
    let sum = 0, sq = 0, hit = false, hitNaive = false;
    for (let n = 1; n <= cap; n++) {
      const x = normal(u);
      sum += x;
      sq += x * x;
      if (n < min) continue;
      const t = Math.abs(sum / n / Math.sqrt((sq - (sum * sum) / n) / (n - 1) / n));
      hit ||= t > crit[n][0];
      hitNaive ||= t > crit[n][1];
    }
    wrong += +hit;
    naive += +hitNaive;
  }
  assert.ok(wrong / 4000 < 0.065 && wrong / 4000 > 0.035, `${wrong} of 4000 nulls called a difference`);
  assert.ok(naive / 4000 > 0.15, `the unadjusted interval: ${naive} of 4000`);
  assert.equal(lookAlpha(5, 5, 0.01), 0.01, 'one look pays nothing');
});

test('a paired interval: a difference, the same within the band, open', () => {
  const u = rng(7);
  const base = Array.from({ length: 12 }, () => 1000 * (1 + 0.01 * normal(u)));
  const lower = paired(base, base.map((x) => x * 0.98 * (1 + 0.001 * normal(u))), 0.01, 0.5);
  assert.equal(lower.call, '<');
  near(lower.pct, -2, 0.2);
  assert.ok(lower.lo < lower.pct && lower.pct < lower.hi && lower.hi < 0);
  assert.equal(paired(base, base.map((x) => x * 1.02 * (1 + 0.001 * normal(u))), 0.01, 0.5).call, '>');
  assert.equal(paired(base, base.map((x) => x * (1 + 0.001 * normal(u))), 0.01, 0.5).call, '=');
  assert.equal(paired(base, base.map((x) => x * (1 + 0.02 * normal(u))), 0.01, 0.5).call, '?');
  assert.equal(paired([1], [2], 0.01, 0.5).call, '?', 'one pair decides nothing');
});

test("a round's order: every arm once, every arm in every place over many rounds", () => {
  const u = rng(5);
  const first = [0, 0, 0];
  for (let r = 0; r < 300; r++) {
    const o = shuffled(3, u);
    assert.deepEqual([...o].sort(), [0, 1, 2]);
    first[o[0]]++;
  }
  for (const f of first) assert.ok(f > 70 && f < 130, `${first}`);
});

test("a run's analysis: the warm-up left out, the stop held by the arms and not the A/A, the verdict's lines", () => {
  const u = rng(3);
  const arm = (name: string) => ({ name, core: `${name}.wasm`, tree: '.', query: '', coreBytes: 1 });
  const run: Run = { schema: 1, date: '', host: {}, browser: 'Chromium 0', arms: [arm('base'), arm('aa'), arm('new')], opts: { min: 4, cap: 24, band: 0.5, overall: 0.01, stop: ['cycles', 'wall'], budget: 1, workloads: ['user'], rounds: 1, warm: 'boot' }, alpha: 0.0014, rows: [], ended: { user: 'every stop measure decided' } };
  const s = (f: number, noise: number): PairSample => {
    const ms = 9500 * f * (1 + noise * normal(u));
    return { ms, steps: 1e9, marks: {}, proc: { instructions: 17e9 * f, cycles: 5e9 * f * (1 + (noise / 3) * normal(u)), cpuNs: ms * 1e6, pInstructions: 0, pCycles: 4.9e9, pCpuNs: 0, energyNj: 0 }, footprint: 2 ** 30, stats: { jit: { emitNs: 2e8, compileNs: 1e8, bytes: 2 ** 20, modules: 300, decSteps: 5 } } as PairSample['stats'] };
  };
  // A warm-up sample would call `new` far slower.
  for (const a of run.arms) run.rows.push({ workload: 'user', block: 1, warm: true, at: 0, slot: 0, arm: a.name, s: s(a.name === 'new' ? 2 : 1, 0) });
  for (let block = 1; block <= 3; block++) for (const a of run.arms) run.rows.push({ workload: 'user', block, at: 0, slot: 0, arm: a.name, s: s(a.name === 'new' ? 0.97 : 1, 0.001) });
  assert.equal(analyze(run, 'user').done, false, 'under the least pairs');
  for (const a of run.arms) run.rows.push({ workload: 'user', block: 4, at: 0, slot: 0, arm: a.name, s: s(a.name === 'new' ? 0.97 : 1, 0.001) });
  const a = analyze(run, 'user');
  assert.equal(a.pairs, 4);
  assert.equal(a.arms.new.wall.call, '<');
  assert.equal(a.arms.new.cycles.call, '<');
  near(a.arms.new.instr.pct, -3, 1e-6);
  assert.equal(a.done, true);
  // A noisy A/A arm is open and doesn't hold the stop; a noisy arm does.
  const noisy = (name: string) => ({ ...run, rows: run.rows.map((r) => (r.arm === name && !r.warm ? { ...r, s: s(1, 0.05) } : r)) });
  assert.equal(analyze(noisy('aa'), 'user').arms.aa.wall.call, '?');
  assert.equal(analyze(noisy('aa'), 'user').done, true);
  assert.equal(analyze(noisy('new'), 'user').done, false);
  const text = verdict(run).join('\n');
  assert.match(text, /user: 4 pairs against base/);
  assert.match(text, /new +4 +-[23]\.\d\d% \[.*\] LOWER/);
  assert.match(text, /ended: every stop measure decided/);
  assert.doesNotMatch(text, /WARNING/);
  // An A/A arm that differs is the session's warning.
  const off = { ...run, rows: run.rows.map((r) => (r.arm === 'aa' && !r.warm ? { ...r, s: s(1.03, 0.001) } : r)) };
  assert.match(verdict(off).join('\n'), /WARNING: the A\/A arm differs from the base in wall, cycles, instr/);
});

test("a run's analysis: what a stop measure can't decide isn't decided, a broken sample costs its pair, a half-run pair counts for the arms that ran", () => {
  const u = rng(11);
  const arm = (name: string) => ({ name, core: `${name}.wasm`, tree: '.', query: '', coreBytes: 1 });
  const s = (f: number, proc = true): PairSample => {
    const ms = 9000 * f * (1 + 0.001 * normal(u));
    return { ms, steps: 1e9, marks: {}, proc: proc ? { instructions: 17e9 * f, cycles: 5e9 * f * (1 + 0.001 * normal(u)), cpuNs: ms * 1e6, pInstructions: 0, pCycles: 4.9e9, pCpuNs: 0, energyNj: 0 } : undefined, stats: { jit: {} } as PairSample['stats'] };
  };
  const make = (stop: string[], proc: boolean, blocks = 6): Run => {
    const run: Run = { schema: 1, date: '', host: {}, browser: '', arms: [arm('base'), arm('new'), arm('other')], opts: { min: 4, cap: 24, band: 0.5, overall: 0.01, stop, budget: 1, workloads: ['node'], rounds: 1, warm: 'same' }, alpha: 0.0012, rows: [] };
    for (let block = 1; block <= blocks; block++) for (const a of run.arms) run.rows.push({ workload: 'node', block, at: 0, slot: 0, arm: a.name, s: s(a.name === 'new' ? 0.95 : 1, proc) });
    return run;
  };
  // Time alone decides here; cycles, the one stop measure, has no data (no counters on this host): not done.
  assert.equal(analyze(make(['wall'], false), 'node').done, true);
  assert.equal(analyze(make(['cycles'], false), 'node').done, false);
  assert.equal(analyze(make(['cycles', 'wall'], false), 'node').done, true, 'the one it has decides');
  assert.throws(() => checkStop(['wall', 'cycle']), /cycle/);
  checkStop(['cycles', 'wall']);
  // A sample whose counters went backwards (a renderer that ended inside it) costs that pair for that measure only.
  const broken = make(['cycles', 'wall'], true);
  broken.rows.find((r) => r.block === 3 && r.arm === 'new')!.s.proc!.cycles = -1e9;
  const a = analyze(broken, 'node');
  assert.equal(a.arms.new.cycles.n, 5);
  assert.equal(a.arms.new.wall.n, 6);
  assert.equal(a.arms.new.cycles.call, '<');
  assert.ok(Number.isFinite(a.arms.new.cycles.pct));
  assert.equal(a.arms.other.cycles.n, 6);
  // A pair the run ended inside (the base and one arm sampled, the other not) counts for the arm that ran, the other's
  // pairs are its own.
  const half = make(['wall'], true);
  half.rows = half.rows.filter((r) => !(r.block === 6 && r.arm === 'other'));
  const h = analyze(half, 'node');
  assert.equal(h.pairs, 6);
  assert.equal(h.arms.new.wall.n, 6);
  assert.equal(h.arms.other.wall.n, 5);
  assert.deepEqual(h.counts, { new: 6, other: 5 });
  // A pair without the base counts for no arm.
  const nobase = make(['wall'], true);
  nobase.rows = nobase.rows.filter((r) => !(r.block === 6 && r.arm === 'base'));
  assert.equal(analyze(nobase, 'node').arms.new.wall.n, 5);
});

test("a run's analysis: an arm decided is reported as decided, and the pairs after it, run without it, are the others'", () => {
  const u = rng(5);
  const arm = (name: string) => ({ name, core: `${name}.wasm`, tree: '.', query: '', coreBytes: 1 });
  const s = (f: number, noise: number): PairSample => ({ ms: 9000 * f * (1 + noise * normal(u)), steps: 1e9, marks: {}, stats: { jit: {} } as PairSample['stats'] });
  const run: Run = { schema: 1, date: '', host: {}, browser: '', arms: [arm('base'), arm('fast'), arm('close')], opts: { min: 4, cap: 12, band: 0.5, overall: 0.01, stop: ['wall'], budget: 1, workloads: ['node'], rounds: 1, warm: 'same' }, alpha: 0.002, rows: [] };
  const add = (block: number, names: string[]) => { for (const n of names) run.rows.push({ workload: 'node', block, at: 0, slot: 0, arm: n, s: s(n === 'fast' ? 0.95 : n === 'close' ? 1.003 : 1, n === 'close' ? 0.01 : 0.001) }); };
  for (let block = 1; block <= 4; block++) add(block, ['base', 'fast', 'close']);
  const first = analyze(run, 'node');
  assert.deepEqual(first.decided, ['fast'], 'the clear arm is decided at the least pairs, the noisy one not');
  assert.equal(first.done, false);
  // The driver then runs the base and `close` alone.
  for (let block = 5; block <= 8; block++) add(block, ['base', 'close']);
  const later = analyze(run, 'node');
  assert.deepEqual(later.counts, { fast: 4, close: 8 });
  assert.equal(later.arms.fast.wall.n, 4);
  assert.equal(later.arms.fast.wall.call, '<');
  assert.ok(later.decided.includes('fast'));
  assert.match(verdict(run).join('\n'), /fast +4 /);
});

test("the smp workload: the clock alone stops it unless --stop says otherwise, and its latency counters are the verdict's", () => {
  const u = rng(13);
  const arm = (name: string) => ({ name, core: `${name}.wasm`, tree: '.', query: '', coreBytes: 1 });
  const lat = (stall: number): Latency => ({ compiledPct: 94.5, interpPct: 5.4, overdue: 0, parks: 10_000, modules: 2600, workerBusyMs: 1700, ready: 2600, readyMeanMs: 1.05, readyP50Ms: 1, readyP99Ms: 8, readyTopMs: 32, readyMaxMs: 20, stallMaxMs: stall, stallMsPerS: 1.5, outMsPerS: 90 });
  // Time 3% lower and tight; cycles a step all over the place (a step isn't fixed work in parallel SMP).
  const s = (f: number, stall: number): PairSample => {
    const ms = 14000 * f * (1 + 0.002 * normal(u));
    return { ms, steps: 19e9 * (1 + 0.03 * normal(u)), marks: {}, proc: { instructions: 60e9, cycles: 50e9, cpuNs: ms * 4e6, pInstructions: 0, pCycles: 40e9, pCpuNs: 0, energyNj: 0 }, lat: lat(stall), stats: { jit: {} } as PairSample['stats'] };
  };
  const make = (stopGiven: boolean): Run => {
    const run: Run = { schema: 1, date: '', host: {}, browser: '', arms: [arm('base'), arm('new')], opts: { min: 4, cap: 12, band: 0.5, overall: 0.01, stop: ['cycles', 'wall'], stopGiven, budget: 1, workloads: ['smp'], rounds: 1, warm: 'same' }, alpha: 0.002, rows: [] };
    for (let block = 1; block <= 4; block++) for (const a of run.arms) run.rows.push({ workload: 'smp', block, at: 0, slot: 0, arm: a.name, s: s(a.name === 'new' ? 0.97 : 1, a.name === 'new' ? 25 : 10) });
    return run;
  };
  assert.deepEqual(stopFor(make(false).opts, 'smp'), ['wall']);
  assert.deepEqual(stopFor(make(false).opts, 'node'), ['cycles', 'wall'], 'the other workloads keep the default');
  assert.deepEqual(stopFor(make(true).opts, 'smp'), ['cycles', 'wall'], 'a --stop given is every workload\'s');
  assert.equal(analyze(make(false), 'smp').arms.new.cycles.call, '?');
  assert.equal(analyze(make(false), 'smp').done, true);
  assert.equal(analyze(make(true), 'smp').done, false);
  // A run from before the per-workload stops (no `stopGiven`) reads as it did.
  const old = make(false);
  delete old.opts.stopGiven;
  assert.equal(analyze(old, 'smp').done, false);
  const text = verdict(make(false)).join('\n');
  assert.match(text, /compiled % +interp % +overdue/);
  assert.match(text, /\n  new +94\.50 +5\.40 +0 +10000 +2600 +1700 +1\.05 +1 +8 +32 +32 +25 +25 +1\.5 +90\n/);
  assert.match(text, /stop on wall,/);
  assert.doesNotMatch(verdict({ ...make(false), rows: make(false).rows.map((r) => ({ ...r, s: { ...r.s, lat: undefined } })) }).join('\n'), /compiled %/, 'no latency table without the counters');
});

test("the node workload's script: its check line, the same every run", () => {
  const run = () => execFileSync(process.execPath, [new URL('../images/alpine/node/jitjit.js', import.meta.url).pathname, '10'], { encoding: 'utf8' }).trim();
  assert.equal(run(), 'jitjit: 2f42acde 132');
  assert.equal(run(), 'jitjit: 2f42acde 132');
});
