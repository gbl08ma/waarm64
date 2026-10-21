// Sums up bench/interp/ab.sh's results: per benchmark and arm, each round's median, then the arms'
// medians of them against the first arm's.
//   node bench/interp/ab-summary.ts <outdir>
import { readdirSync, readFileSync } from 'node:fs';

const dir = process.argv[2];
type Result = { name: string; unit: string; median: number; iqr: number };
const rows = new Map<string, Map<string, { median: number; iqr: number }[]>>();
const arms: string[] = [];
for (const f of readdirSync(dir).filter((f) => /^r\d+-.*\.json$/.test(f)).sort()) {
  const arm = f.split('-')[1];
  if (!arms.includes(arm)) arms.push(arm);
  for (const r of JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')).results as Result[]) {
    if (r.name.endsWith('_cold') || r.unit === 'ms') continue;
    const m = rows.get(r.name) ?? new Map();
    m.set(arm, [...(m.get(arm) ?? []), { median: r.median, iqr: r.iqr }]);
    rows.set(r.name, m);
  }
}
const med = (a: number[]) => [...a].sort((x, y) => x - y)[(a.length - 1) >> 1];
console.log(`| benchmark | ${arms.map((a) => `${a} (rounds; median)`).join(' | ')} |`);
console.log(`|---|${arms.map(() => '---').join('|')}|`);
for (const [name, m] of rows) {
  const base = med((m.get(arms[0]) ?? []).map((x) => x.median));
  const cells = arms.map((a) => {
    const xs = m.get(a) ?? [];
    const v = med(xs.map((x) => x.median));
    const d = a === arms[0] ? '' : ` (${v > base ? '+' : ''}${((100 * (v - base)) / base).toFixed(1)}%)`;
    return `${xs.map((x) => `${x.median.toFixed(1)} ±${x.iqr.toFixed(1)}`).join(' · ')}; **${v.toFixed(1)}**${d}`;
  });
  console.log(`| ${name} | ${cells.join(' | ')} |`);
}
