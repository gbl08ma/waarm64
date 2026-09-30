// Medians and IQR over the alternating runs of bench/mem/ab.sh: node bench/mem/ab-summary.ts <prefix in bench/mem/results/>
// (A: the byte budget on, B: off; the `-A-` / `-B-` in the file names).
import { readdirSync, readFileSync } from 'node:fs';

const prefix = process.argv[2];
const dir = new URL('./results/', import.meta.url).pathname;
const by: Record<string, Record<string, number[]>> = {};
for (const f of readdirSync(dir).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.json'))) {
  const v = f.split('-')[1];
  for (const r of JSON.parse(readFileSync(dir + f, 'utf8')).results) ((by[r.name] ??= {})[v] ??= []).push(...r.samples);
}
const q = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * p;
  return s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i % 1);
};
for (const [name, vs] of Object.entries(by)) {
  const row = Object.entries(vs).sort().map(([v, a]) => `${v}: median ${q(a, 0.5).toFixed(0)} IQR ${(q(a, 0.75) - q(a, 0.25)).toFixed(0)} n=${a.length}`);
  const [a, b] = [vs.A, vs.B];
  console.log(name.padEnd(28), row.join(' | '), a && b ? `| A/B ${(q(a, 0.5) / q(b, 0.5)).toFixed(3)}` : '');
}
