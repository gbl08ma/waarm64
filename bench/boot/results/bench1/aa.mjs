// A/A spreads per measure: for each bench and measure, every run's samples (first dropped where the run has a
// warm-up-less first sample), the spread of single samples and of run medians, and the a/b ratio per round.
import { readFileSync, readdirSync } from 'node:fs';
const dir = 'bench/boot/results/bench1/gates/';
const runs = {};
for (const f of readdirSync(dir).filter((f) => f.startsWith(process.argv[2] ?? 'bench1-aa-'))) {
  const m = /-r(\d+)-([a-z0-9]+)-(.*)\.json$/.exec(f);
  for (const r of JSON.parse(readFileSync(dir + f)).results) ((runs[r.name] ??= {})[m[2]] ??= {})[m[1]] = r.samples;
}
const med = (x) => { const s = [...x].sort((a, b) => a - b); return (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2; };
const cv = (x) => { const m = x.reduce((a, b) => a + b) / x.length; return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1)) / m * 100; };
const want = new RegExp(process.argv[3] ?? '_total');
for (const [name, arms] of Object.entries(runs)) {
  if (!want.test(name) || /cold|joules|ns_step|cpu_ms$|ginstr|gcycles/.test(name) && !process.argv[4]) continue;
  const drop = /alpine_user/.test(name) ? 1 : 0; // the run's first boot is its warm-up there
  const all = [], meds = [], ratios = [];
  for (const r of Object.keys(arms.a)) {
    const a = arms.a[r].slice(drop), b = arms.b?.[r]?.slice(drop);
    all.push(...a, ...(b ?? [])); meds.push(med(a)); if (b) { meds.push(med(b)); ratios.push((med(b) / med(a) - 1) * 100); }
  }
  console.log(name.padEnd(40), 'n', String(all.length).padStart(2), 'sample CV', cv(all).toFixed(3).padStart(6) + '%', 'run-median CV', cv(meds).toFixed(3).padStart(6) + '%', 'b/a per round', ratios.map((x) => x.toFixed(2)).join(' '));
}
