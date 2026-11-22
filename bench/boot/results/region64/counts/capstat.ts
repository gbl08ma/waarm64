// CAPSTAT (measurement only): how often compiled blocks end at the 32-instruction cap (block::CAP), and how long
// their straight-line runs would be without it. Needs the diagnostic core with the CAPSTAT slots (tally.rs 80..92):
//   CARGO_TARGET_DIR=target/diag scripts/build-wasm.sh --features diag
//   node bench/results/local/capstat/capstat.ts [--json out.json] [boot|user...]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { boot } from '../../../suite.ts';
import { compileCore } from '../../../../../web/core.ts';
import { Counter } from '../../../../../web/counters.ts';
import { DISTROS } from '../../../../../web/test-guests.ts';

const N = 96, AT = 80, K = 11;
const LEN = ['1-4', '5-8', '9-16', '17-31', '32, not the cap', '32, the cap'];
const UNCAP = ['33-63', '64-127', '128-255', '256+', '  run reaches the page end'];
type Snap = { steps: number; jit: number; t: number[] };
type Phase = { name: string; steps: number; jit: number; t: number[] };

const { values: a, positionals } = parseArgs({ allowPositionals: true, options: { wasm: { type: 'string', default: 'target/diag/wasm32-unknown-unknown/release/waarm64_core.wasm' }, json: { type: 'string' } } });

async function run(name: string) {
  const root = new URL('../../../../../', import.meta.url);
  const IMAGES = new URL('target/images/', root);
  const d = DISTROS.alpine;
  const user = name === 'user';
  const disk = new URL(user ? 'alpine-user/rootfs-user.ext4' : d.disk, IMAGES).href;
  const img = { kernel: readFileSync(new URL(d.kernel, IMAGES)), initrd: readFileSync(new URL(d.initrd, IMAGES)), disk, cmdline: d.cmdline, ramSize: 1 << 30, test: !user, jit: 1 as const };
  const module = await compileCore(readFileSync(new URL(a.wasm!, root)));
  let vm!: Awaited<ReturnType<typeof import('../../../../../web/vm.ts').bootVm>>;
  const read = (): number[] => {
    const xs = vm.counterBlocks.map((b) => Array.from(new BigUint64Array(vm.memory.buffer, b + Counter.LEN * 8, N), Number));
    return Array.from({ length: K }, (_, i) => xs.reduce((s, x) => s + x[AT + i], 0));
  };
  const snap = (): Snap => { const s = vm.stats(); return { steps: s.steps, jit: s.jit.steps, t: read() }; };
  const marks: (Snap & { name: string })[] = [];
  const t0 = performance.now();
  await boot(module, img, (v) => { vm = v; marks.push({ name: 'begin', ...snap() }); }, { cmdline: d.cmdline, ncpus: 1, parallel: false, realtime: false, onMark: (m) => marks.push({ name: m, ...snap() }) });
  const end = snap();
  if (end.t.every((x) => x === 0)) throw new Error('no CAPSTAT tallies: not the instrumented diagnostic core');
  const phases: Phase[] = [{ name: 'all', ...end }];
  for (const s of marks.filter((m) => m.name.endsWith(' start'))) {
    const e = marks.find((m) => m.name === s.name.replace(/ start$/, ' end'));
    if (e) phases.push({ name: s.name.replace(/ start$/, ''), steps: e.steps - s.steps, jit: e.jit - s.jit, t: e.t.map((x, i) => x - s.t[i]) });
  }
  return { name, ms: performance.now() - t0, phases };
}

function print(r: Awaited<ReturnType<typeof run>>) {
  console.log(`\n== ${r.name} (${(r.ms / 1000).toFixed(0)} s)`);
  for (const p of r.phases) {
    const entries = p.t.slice(0, 6).reduce((s, x) => s + x, 0);
    const cap = p.t[5];
    const pct = (x: number, of: number) => `${((100 * x) / of).toFixed(2)}%`;
    console.log(`-- ${p.name}: ${(p.steps / 1e6).toFixed(0)}M steps, ${pct(p.jit, p.steps)} compiled; ${(entries / 1e6).toFixed(1)}M compiled block entries, ${(p.jit / entries).toFixed(2)} steps an entry`);
    LEN.forEach((n, i) => console.log(`   len ${n.padEnd(16)} ${String(p.t[i]).padStart(12)} ${pct(p.t[i], entries).padStart(7)} of entries`));
    console.log(`   cap-ended entries: ${pct(cap, entries)} of entries; their 32 instructions ${pct(32 * cap, p.jit)} of compiled steps; one cap fall-through per ${(p.jit / Math.max(cap, 1)).toFixed(0)} steps`);
    UNCAP.forEach((n, i) => console.log(`     uncapped ${n.padEnd(28)} ${String(p.t[6 + i]).padStart(12)} ${cap ? pct(p.t[6 + i], cap).padStart(7) : '-'}`));
  }
}

const runs = [];
for (const n of positionals.length ? positionals : ['boot', 'user']) {
  const r = await run(n);
  runs.push(r);
  print(r);
}
if (a.json) writeFileSync(a.json, JSON.stringify({ date: new Date().toISOString(), node: process.version, wasm: a.wasm, runs }, null, 1));
