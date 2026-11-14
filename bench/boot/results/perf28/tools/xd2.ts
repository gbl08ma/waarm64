import { readFileSync } from 'node:fs';
const marks = JSON.parse(readFileSync(process.argv[2], 'utf8')).marks as { name: string; ms: number; report: { op: string; calls: number }[] }[];
const ph = marks.slice(1).map((m, i) => ({ from: marks[i], to: m })).filter((p) => p.to.ms - p.from.ms > 50);
const g = (m: (typeof marks)[0], i: number) => m.report.find((r) => r.op === `XD${i}`)?.calls ?? 0;
let tot = [0, 0, 0, 0];
for (const p of ph) {
  const v = [0, 1, 2, 3].map((i) => g(p.to, i) - g(p.from, i));
  v.forEach((x, i) => (tot[i] += x));
  console.log(`${(p.from.name === 'begin' ? 'boot' : p.from.name.slice(0, 14)).padEnd(15)} flush_va ${v[0]}, scanned ${v[1]} (${(100 * v[1] / v[0]).toFixed(1)}%), kernel-half ${v[3]} of which scanned ${v[2]}`);
}
console.log('total', tot);
