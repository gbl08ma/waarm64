// EXITSTAT (measurement only): per 1000 steps, the transfers inside regions and the static exits out of them by why
// the successor isn't a member (tally.rs XTAIL/XCALL). Needs the instrumented diagnostic core.
//   node bench/results/local/exitstat/exitstat.ts --wasm X.wasm [--json out.json] [boot|user...]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { boot } from '../../../suite.ts';
import { compileCore } from '../../../../../web/core.ts';
import { Counter } from '../../../../../web/counters.ts';
import { DISTROS } from '../../../../../web/test-guests.ts';

const N = 96;
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
  if (t[80] === 0) throw new Error('no WALKSTAT tallies');
  const phases: Phase[] = [{ name: 'all', steps: r.stats.steps, t }];
  for (const s of marks.filter((m) => m.name.endsWith(' start'))) {
    const e = marks.find((m) => m.name === s.name.replace(/ start$/, ' end'));
    if (e) phases.push({ name: s.name.replace(/ start$/, ''), steps: e.steps - s.steps, t: e.t.map((x, i) => x - s.t[i]) });
  }
  return { name, ms: performance.now() - t0, phases };
}

function print(r: Awaited<ReturnType<typeof run>>) {
  console.log(`\n== ${r.name} (${(r.ms / 1000).toFixed(0)} s)`);
  for (const p of r.phases) {
    const t = p.t.slice(80, 89);
    const n = t[0] || 1;
    const bins = ['1', '2', '3', '4', '5', '6-8', '9+'].map((b, i) => `${b}: ${((100 * t[1 + i]) / n).toFixed(2)}%`).join(', ');
    const walks = [1, 2, 3, 4, 5, 7, 10].reduce((s, w, i) => s + w * t[1 + i], 0);
    console.log(`-- ${p.name}: ${t[0]} forward regions, ${(walks / n).toFixed(3)} walks each (9+ counted as 10); by walks ${bins}; bound hit ${t[8]} (${((100 * t[8]) / n).toFixed(3)}%)`);
  }
}

const runs = [];
for (const n of positionals.length ? positionals : ['boot', 'user']) {
  const r = await run(n);
  runs.push(r);
  print(r);
}
if (a.json) writeFileSync(a.json, JSON.stringify({ date: new Date().toISOString(), node: process.version, wasm: a.wasm, runs }, null, 1));
