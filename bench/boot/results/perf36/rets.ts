// PERF loop 36: a diagnostic core's returns elsewhere (R: lines) and tallies (T: lines) per phase of a
// bench/boot/userprof.ts marks file (README.md).
//   node bench/boot/results/perf36/rets.ts <marks.json> [top entries per phase, 12]
import { readFileSync } from 'node:fs';
type Mark = { name: string; ms: number; report: { op: string; calls: number }[] };
const { marks } = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { marks: Mark[] };
const phases = marks.slice(1).map((m, i) => ({ from: marks[i], to: m })).filter((p) => p.to.ms - p.from.ms > 50);
const N = Number(process.argv[3] ?? 12);
const delta = (p: { from: Mark; to: Mark }) => {
  const a = new Map(p.from.report.map((h) => [h.op, h.calls]));
  return (op: string) => (p.to.report.find((h) => h.op === op)?.calls ?? 0) - (a.get(op) ?? 0);
};
for (const p of phases) {
  const d = delta(p);
  const rest = p.to.report.filter((h) => h.op.startsWith('R:') && !/^R:(total|distinct)$/.test(h.op)).map((h) => [h.op, d(h.op)] as const).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]);
  console.log(`\n== ${p.from.name} -> ${p.to.name}: returns elsewhere ${d('R:total')}`);
  for (const [k, n] of rest.slice(0, N)) console.log(`${String(n).padStart(9)} ${k.slice(2)}`);
}
console.log('\ntallies per phase (M): 2 xc hit, 3 miss function, 11 host call, 12 host return, 13/14 a followed callee\'s ret_up with/without a prediction, 16 followed call, 17 exit from inside a followed call');
for (const p of phases) {
  const d = delta(p);
  const t = [2, 3, 11, 12, 13, 14, 16, 17].map((i) => `${i}=${(d(`T:${i}`) / 1e6).toFixed(3)}`);
  console.log(`${p.from.name.slice(0, 20).padEnd(20)} R=${(d('R:total') / 1e6).toFixed(3)} ${t.join(' ')}`);
}
