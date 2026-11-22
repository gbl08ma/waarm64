// EXITSTAT (measurement only): per 1000 steps, the transfers inside regions and the static exits out of them by why
// the successor isn't a member (tally.rs XTAIL/XCALL). Needs the instrumented diagnostic core.
//   node bench/results/local/exitstat/exitstat.ts --wasm X.wasm [--json out.json] [boot|user...]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { boot } from '../../../suite.ts';
import { compileCore } from '../../../../../web/core.ts';
import { Counter } from '../../../../../web/counters.ts';
import { DISTROS } from '../../../../../web/test-guests.ts';

const N = 104;
const WHY = ['region full', 'in region already', 'loop head (batch)', 'taken by another region', 'compiled before', 'not hot yet', 'call could leave', 'loop region exit', 'loop head alone', 'other'];
type Phase = { name: string; steps: number; t: number[] };
const { values: a, positionals } = parseArgs({ allowPositionals: true, options: { wasm: { type: 'string' }, json: { type: 'string' } } });

async function run(name: string) {
  const root = new URL('../../../../../', import.meta.url);
  const IMAGES = new URL('target/images/', root);
  const d = DISTROS.alpine;
  const user = name === 'user';
  const disk = new URL(user ? 'alpine-user/rootfs-user.ext4' : d.disk, IMAGES).href;
  const img = { kernel: readFileSync(new URL(d.kernel, IMAGES)), initrd: readFileSync(new URL(d.initrd, IMAGES)), disk, cmdline: d.cmdline, ramSize: 1 << 30, test: !user, jit: 1 as const };
  const module = await compileCore(readFileSync(a.wasm!));
  let vm!: Awaited<ReturnType<typeof import('../../../../../web/vm.ts').bootVm>>;
  const read = (): number[] => {
    const xs = vm.counterBlocks.map((b) => Array.from(new BigUint64Array(vm.memory.buffer, b + Counter.LEN * 8, N), Number));
    return Array.from({ length: N }, (_, i) => xs.reduce((s, x) => s + x[i], 0));
  };
  const marks: Phase[] = [];
  const mark = (m: string) => marks.push({ name: m, steps: vm.stats().steps, t: read() });
  const t0 = performance.now();
  const r = await boot(module, img, (v) => { vm = v; mark('begin'); }, { cmdline: d.cmdline, ncpus: 1, parallel: false, realtime: false, onMark: (m) => mark(m) });
  const t = read();
  if (t.slice(80).every((x) => x === 0)) throw new Error('no EXITSTAT tallies');
  const phases: Phase[] = [{ name: 'all', steps: r.stats.steps, t }];
  for (const s of marks.filter((m) => m.name.endsWith(' start'))) {
    const e = marks.find((m) => m.name === s.name.replace(/ start$/, ' end'));
    if (e) phases.push({ name: s.name.replace(/ start$/, ''), steps: e.steps - s.steps, t: e.t.map((x, i) => x - s.t[i]) });
  }
  return { name, ms: performance.now() - t0, phases };
}

function print(r: Awaited<ReturnType<typeof run>>) {
  console.log(`\n== ${r.name} (${(r.ms / 1000).toFixed(0)} s); per 1000 steps`);
  const ps = r.phases;
  console.log(`${''.padEnd(30)} ${ps.map((p) => p.name.slice(0, 8).padStart(8)).join(' ')}`);
  const line = (label: string, f: (t: number[]) => number) => console.log(`${label.padEnd(30)} ${ps.map((p) => ((1000 * f(p.t)) / p.steps).toFixed(2).padStart(8)).join(' ')}`);
  const sum = (t: number[], from: number, n: number) => t.slice(from, from + n).reduce((s, x) => s + x, 0);
  line('inside: back-edge + fwd edge', (t) => t[0] + t[1]);
  line('indirect (xc hit + miss)', (t) => t[2] + t[3]);
  line('host return', (t) => t[12]);
  line('static tail exits, all', (t) => sum(t, 80, 10));
  WHY.forEach((w, i) => line(`  tail: ${w}`, (t) => t[80 + i]));
  line('host calls (BL callee), all', (t) => sum(t, 92, 10));
  WHY.forEach((w, i) => line(`  call: ${w}`, (t) => t[92 + i]));
}

const runs = [];
for (const n of positionals.length ? positionals : ['boot', 'user']) {
  const r = await run(n);
  runs.push(r);
  print(r);
}
if (a.json) writeFileSync(a.json, JSON.stringify({ date: new Date().toISOString(), node: process.version, wasm: a.wasm, runs }, null, 1));
