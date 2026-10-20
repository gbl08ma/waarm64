// Gate summary: per *_total result, per arm, each round's median (IQR, n), and the arm's median of rounds vs the first arm.
import { readdirSync, readFileSync } from 'node:fs';
const dir = process.argv[2];
const rows = {};
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const [, , arm, round] = /^(.*)-([a-z0-9]+)-(\d+)\.json$/.exec(f) ?? [];
  const j = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
  for (const r of j.results) {
    if (!r.name.endsWith('_total')) continue;
    ((rows[r.name] ??= {})[arm] ??= []).push([+round, r.median, r.iqr, r.samples?.length ?? r.n]);
  }
}
const med = (v) => { const s = [...v].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
for (const [name, arms] of Object.entries(rows)) {
  console.log(name);
  const base = Object.values(arms)[0];
  for (const [arm, xs] of Object.entries(arms)) {
    xs.sort((a, b) => a[0] - b[0]);
    const m = med(xs.map((x) => x[1])), b = med(base.map((x) => x[1]));
    console.log(`  ${arm.padEnd(6)} ${xs.map((x) => `${Math.round(x[1]).toLocaleString('en')} (IQR ${Math.round(x[2])}, n=${x[3]})`).join(' · ')}   ${((100 * (m - b)) / b).toFixed(1)}%`);
  }
}
