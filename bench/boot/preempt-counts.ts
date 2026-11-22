// The diagnostic core's tallies (core/src/tally.rs; docs/benchmarking.md "Preemption's counts"): per guest step, how
// often compiled code takes a region's back-edge or forward edge, an indirect transfer (a transfer cache hit, the miss
// function), a static chain backward or forward, a host call and return; how chunks end (the budget or an exit, by
// kind); parallel mode's timer and IRQ latencies; round-robin's timer (CNTV_CVAL writes, IRQs, platform exits by
// register). Runs the gates' guests in Node (the dev VM):
//   CARGO_TARGET_DIR=target/diag scripts/build-wasm.sh --features diag
//   node bench/boot/preempt-counts.ts [--wasm target/diag/wasm32-unknown-unknown/release/waarm64_core.wasm]
//     [--json out.json] [--chunk N] [run...]       runs: boot user smp1 smp4 smp-user4 (default: all); --chunk:
//     parallel mode's chunk (`vm_set_chunk`)
//   node bench/boot/preempt-counts.ts --in out.json      # print a saved run again
// boot: Alpine's boot as boot_alpine_jit (deterministic, 1 vCPU); user: alpine_user_jit (deterministic, 1 vCPU, by
// phase); smpN: smp_alpine_jit's boot on N vCPUs (parallel, realtime); smp-user4: smp_user_jit_4 (by phase). A normal
// core has no tallies: the tool refuses it (the words past the counters stay zero).
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { boot } from './suite.ts';
import { compileCore } from '../../web/core.ts';
import { Counter } from '../../web/counters.ts';
import { DISTROS } from '../../web/test-guests.ts';

/** core/src/tally.rs's slots. */
const JIT = ['back-edge', 'forward edge', 'transfer cache hit', 'miss function', 'jump cache hit (MMU off)', 'chain back', 'chain fwd', 'chain via jc back', 'chain via jc fwd', 'by-VA link back', 'by-VA link fwd', 'host call', 'host return', 'poll (polled code)'];
const END = ['budget', 'early (stop word, park)', 'Resync (ISB/DSB/ERET/unmask)', 'Invalidate (IC)', 'WFI', 'WFE', 'SEV', 'TLBI IS', 'HVC', 'counter read', 'platform (timer/GIC regs)', 'device (MMIO)', 'SVC', 'exception', 'other'];
const N = 72, END_AT = 16, END_STEPS = 32, BETWEEN = 31, BETWEEN_NS = 47, TIMER_LATE = 48, IRQ_LATE = 54, IRQ_HIST = 60, TIMER_SET = 64, IRQS = 67, PLATFORM_BY = 68;

type Tallies = number[];
type Phase = { name: string; steps: number; t: Tallies };
type Run = { name: string; ncpus: number; parallel: boolean; steps: number; ms: number; t: Tallies; cpus: Tallies[]; phases: Phase[] };

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: { wasm: { type: 'string', default: 'target/diag/wasm32-unknown-unknown/release/waarm64_core.wasm' }, json: { type: 'string' }, in: { type: 'string' }, chunk: { type: 'string' } },
});

const sum = (xs: Tallies[]) => Array.from({ length: N }, (_, i) => ((i % 3 === 2 && i >= TIMER_LATE && i < IRQ_HIST) || i === TIMER_SET + 2 ? Math.max(...xs.map((x) => x[i])) : xs.reduce((s, x) => s + x[i], 0)));

async function run(name: string): Promise<Run> {
  const root = new URL('../../', import.meta.url);
  const IMAGES = new URL('target/images/', root);
  const d = DISTROS.alpine;
  const user = name.includes('user');
  const ncpus = name === 'smp1' ? 1 : name.startsWith('smp') ? 4 : 1;
  const parallel = name.startsWith('smp');
  const disk = new URL(user ? 'alpine-user/rootfs-user.ext4' : d.disk, IMAGES).href;
  const img = { kernel: readFileSync(new URL(d.kernel, IMAGES)), initrd: readFileSync(new URL(d.initrd, IMAGES)), disk, cmdline: d.cmdline, ramSize: 1 << 30, test: !user, jit: 1 as const };
  const module = await compileCore(readFileSync(new URL(a.wasm!, root)));
  let vm!: Awaited<ReturnType<typeof import('../../web/vm.ts').bootVm>>;
  const read = () => vm.counterBlocks.map((b) => Array.from(new BigUint64Array(vm.memory.buffer, b + Counter.LEN * 8, N), Number));
  const marks: Phase[] = [];
  const mark = (m: string) => marks.push({ name: m, steps: vm.stats().steps, t: sum(read()) });
  const t0 = performance.now();
  const r = await boot(module, img, (v) => { vm = v; if (a.chunk) v.setChunk(Number(a.chunk)); mark('begin'); }, { cmdline: parallel && user ? `${d.cmdline} waarm64.threads=${ncpus}` : d.cmdline, ncpus, parallel, realtime: parallel, onMark: (m) => mark(m) });
  const ms = performance.now() - t0;
  const cpus = read();
  const t = sum(cpus);
  if (t.slice(0, 16).every((x) => x === 0)) throw new Error(`${a.wasm}: no tallies (not a diagnostic core: build it with --features diag)`);
  marks.push({ name: 'power off', steps: r.stats.steps, t });
  // The phases: a "<x> start" mark to its "<x> end"; else the whole run.
  const phases: Phase[] = [];
  for (const s of marks.filter((m) => m.name.endsWith(' start'))) {
    const e = marks.find((m) => m.name === s.name.replace(/ start$/, ' end'));
    if (e) phases.push({ name: s.name.replace(/ start$/, ''), steps: e.steps - s.steps, t: e.t.map((x, i) => x - s.t[i]) });
  }
  return { name, ncpus, parallel, steps: r.stats.steps, ms, t, cpus, phases };
}

function print(r: Run) {
  console.log(`\n== ${r.name}: ${r.ncpus} vCPU${r.ncpus > 1 ? 's' : ''}, ${r.parallel ? 'parallel realtime' : 'deterministic round-robin'}, ${(r.steps / 1e6).toFixed(0)}M steps, ${(r.ms / 1000).toFixed(1)} s`);
  const rows: [string, number, Tallies][] = [['all', r.steps, r.t], ...r.phases.map((p) => [p.name, p.steps, p.t] as [string, number, Tallies])];
  console.log(`${'per 1000 steps'.padEnd(24)} ${rows.map(([n]) => n.slice(0, 9).padStart(9)).join(' ')}`);
  JIT.forEach((n, i) => console.log(`${n.padEnd(24).slice(0, 24)} ${rows.map(([, s, t]) => ((1000 * t[i]) / s).toFixed(3).padStart(9)).join(' ')}`));
  const chunks = END.reduce((s, _, k) => s + r.t[END_AT + k], 0);
  console.log(`chunks: ${chunks} (${(r.steps / chunks).toFixed(0)} steps each); by how they ended: count, share, mean steps`);
  END.forEach((n, k) => {
    const c = r.t[END_AT + k];
    if (c) console.log(`  ${n.padEnd(30)} ${String(c).padStart(10)} ${((100 * c) / chunks).toFixed(2).padStart(6)}% ${(r.t[END_STEPS + k] / c).toFixed(0).padStart(7)}`);
  });
  if (!r.parallel) {
    // Round-robin's timer: the virtual timer armed ahead, per phase (steps a write, mean ticks ahead), and IRQs taken.
    console.log(`${'timer (round-robin)'.padEnd(24)} ${rows.map(([n]) => n.slice(0, 9).padStart(9)).join(' ')}`);
    const line = (label: string, f: (s: number, t: Tallies) => string) => console.log(`${label.padEnd(24)} ${rows.map(([, s, t]) => f(s, t).padStart(9)).join(' ')}`);
    line('CNTV_CVAL/TVAL armed', (_, t) => String(t[TIMER_SET]));
    line('  steps a write', (s, t) => (t[TIMER_SET] ? s / t[TIMER_SET] : 0).toFixed(0));
    line('  mean ticks ahead', (_, t) => (t[TIMER_SET] ? t[TIMER_SET + 1] / t[TIMER_SET] : 0).toFixed(0));
    line('  max ticks ahead', (s, t) => (s === r.steps ? String(t[TIMER_SET + 2]) : '-'));
    line('IRQs taken', (_, t) => String(t[IRQS]));
    ['GIC CPU i/f read', 'GIC CPU i/f written', 'timer CTL/CVAL/TVAL', 'other'].forEach((n, k) => line(`platform: ${n}`, (_, t) => String(t[PLATFORM_BY + k])));
    line('counter-read exits', (_, t) => String(t[END_AT + 9]));
    line('  steps a read', (s, t) => (t[END_AT + 9] ? s / t[END_AT + 9] : 0).toFixed(0));
    return;
  }
  const b = r.t[BETWEEN];
  if (b) console.log(`  between a chunk ended by its steps and the next: ${b}, mean ${(r.t[BETWEEN_NS] / b).toFixed(0)} ns`);
  const tick = 1e3 / 62.5; // ns a counter tick
  const lat = (label: string, at: number, scale: number) => {
    const [c, s, m] = r.t.slice(at, at + 3);
    console.log(`  ${label.padEnd(38)} ${String(c).padStart(8)}  mean ${c ? ((s * scale) / c / 1e3).toFixed(1) : '-'} µs  max ${((m * scale) / 1e3).toFixed(1)} µs`);
  };
  console.log('latency:');
  lat('timer line seen, running', TIMER_LATE, tick);
  lat('timer line seen, in WFI', TIMER_LATE + 3, tick);
  lat('IRQ line up to IRQ taken, running', IRQ_LATE, 1);
  lat('IRQ line up to WFI completed', IRQ_LATE + 3, 1);
  const h = r.t.slice(IRQ_HIST, IRQ_HIST + 3);
  const c = r.t[IRQ_LATE];
  console.log(`  IRQs taken running: <10 µs ${h[0]}, <100 µs ${h[1]}, <1 ms ${h[2]}, >=1 ms ${c - h[0] - h[1] - h[2]}`);
}

let runs: Run[];
if (a.in) {
  runs = JSON.parse(readFileSync(a.in, 'utf8')).runs;
} else {
  runs = [];
  for (const n of positionals.length ? positionals : ['boot', 'user', 'smp1', 'smp4', 'smp-user4']) {
    const r = await run(n);
    runs.push(r);
    print(r);
  }
  if (a.json) writeFileSync(a.json, JSON.stringify({ date: new Date().toISOString(), node: process.version, wasm: a.wasm, slots: { jit: JIT, end: END }, runs }, null, 1));
}
if (a.in) runs.forEach(print);
