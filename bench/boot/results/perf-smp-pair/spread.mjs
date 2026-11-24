import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync(process.argv[2] + '/ab.json', 'utf8'));
const w = process.argv[3] ?? 'smp', b = r.arms[0].name, a = process.argv[4] ?? 'aa';
const rows = r.rows.filter((x) => x.workload === w && !x.warm);
const M = { wall: (s) => s.ms, cyc: (s) => s.proc?.cycles, cycStep: (s) => s.proc?.cycles / s.steps, instr: (s) => s.proc?.instructions, steps: (s) => s.steps, cpu: (s) => s.proc?.cpuNs };
for (const [k, f] of Object.entries(M)) {
  const d = [];
  for (const blk of new Set(rows.map((x) => x.block))) {
    const x = rows.find((q) => q.block === blk && q.arm === b), y = rows.find((q) => q.block === blk && q.arm === a);
    if (x && y && f(x.s) && f(y.s)) d.push(100 * Math.log(f(y.s) / f(x.s)));
  }
  const m = d.reduce((s, v) => s + v, 0) / d.length, sd = Math.sqrt(d.reduce((s, v) => s + (v - m) ** 2, 0) / (d.length - 1));
  console.log(k.padEnd(8), 'n', d.length, 'mean', m.toFixed(2), 'pair sd %', sd.toFixed(2), d.map((v) => v.toFixed(1)).join(' '));
}
const single = rows.filter((x) => x.arm === b).map((x) => x.s.ms);
console.log('base single samples', single.map((v) => v.toFixed(0)).join(' '));
