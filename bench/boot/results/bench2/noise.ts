// What an A/A session of bench/ab.ts says about its noise: node bench/boot/results/bench2/noise.ts <session dir>/ab.json [workload]
import { readFileSync } from 'node:fs';
import { MEASURES, type Run } from '../../../ab.ts';
const run = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Run;
const w = process.argv[3] ?? run.opts.workloads[0];
const rows = run.rows.filter((r) => r.workload === w && !r.warm);
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
const sd = (x: number[]) => { const m = mean(x); return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1)); };
const ps = (s: (typeof rows)[0]['s']) => (s.proc?.cycles ? s.proc.pCycles / s.proc.cycles : NaN);
const f = { ...MEASURES, pshare: ps };
const rounds = [...new Set(rows.map((r) => r.block))];
const get = (arm: string, round: number) => rows.find((r) => r.arm === arm && r.block === round)!;
console.log(`${w}: ${rounds.length} rounds, ${run.arms.length} arms`);
for (const [m, fn] of Object.entries(f)) {
  const all = rows.map((r) => fn(r.s)!);
  if (all.some((x) => x === undefined || Number.isNaN(x))) continue;
  const line = [`${m.padEnd(7)} sample CV ${(sd(all) / mean(all) * 100).toFixed(3)}%`];
  for (const a of run.arms.slice(1)) {
    const d = rounds.map((r) => Math.log(fn(get(a.name, r).s)! / fn(get(run.arms[0].name, r).s)!) * 100);
    line.push(`${a.name}: ${mean(d).toFixed(3)} sd ${sd(d).toFixed(3)} t ${(mean(d) / (sd(d) / Math.sqrt(d.length))).toFixed(2)}`);
  }
  const at = run.arms.map((_, k) => mean(rows.filter((r) => r.at === k).map((r) => fn(r.s)!)));
  line.push(`by place ${at.map((x) => ((x / at[0] - 1) * 100).toFixed(2)).join(' ')}`);
  line.push(`first half/second ${((mean(rows.filter((r) => r.block > rounds.length / 2).map((r) => fn(r.s)!)) / mean(rows.filter((r) => r.block <= rounds.length / 2).map((r) => fn(r.s)!)) - 1) * 100).toFixed(2)}%`);
  console.log(line.join(' | '));
}
// The clock against the P-core share: pooled slope of the pairs' log ratios on the share's differences, what is left.
if (!Number.isNaN(ps(rows[0].s))) {
  const dx: number[] = [], dy: number[] = [], dc: number[] = [];
  for (const a of run.arms.slice(1)) for (const r of rounds) {
    const [x, b] = [get(a.name, r).s, get(run.arms[0].name, r).s];
    dx.push(ps(x) - ps(b)); dy.push(Math.log(x.ms / b.ms) * 100); dc.push(Math.log(x.proc!.cycles / b.proc!.cycles) * 100);
  }
  const fit = (y: number[], x: number[]) => { const [mx, my] = [mean(x), mean(y)]; const b = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / x.reduce((s, v) => s + (v - mx) ** 2, 0); const res = y.map((v, i) => v - my - b * (x[i] - mx)); const r = b * sd(x) / sd(y); return { b, r, res: sd(res) }; };
  const a = fit(dy, dx), c = fit(dc, dx), wc = fit(dy, dc);
  console.log(`pairs: wall sd ${sd(dy).toFixed(3)}; on pshare: slope ${a.b.toFixed(1)} %/1.0, r ${a.r.toFixed(2)}, residual sd ${a.res.toFixed(3)}`);
  console.log(`pairs: cycles sd ${sd(dc).toFixed(3)}; on pshare: slope ${c.b.toFixed(1)}, r ${c.r.toFixed(2)}, residual sd ${c.res.toFixed(3)}`);
  console.log(`pairs: wall on cycles: slope ${wc.b.toFixed(2)}, r ${wc.r.toFixed(2)}, residual sd ${wc.res.toFixed(3)}`);
  const sx = sd(dx);
  for (const k of [1, 1.5, 2]) { const keep = dy.filter((_, i) => Math.abs(dx[i]) < k * sx); console.log(`rejecting pairs whose share differs past ${k} sd: ${keep.length}/${dy.length} kept, wall sd ${sd(keep).toFixed(3)}`); }
}
