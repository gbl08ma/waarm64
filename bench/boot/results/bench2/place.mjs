// Each arm's deviation from its round's mean, by its place in the round (the first sessions' question: is one arm
// faster by its name or its slot?): node bench/boot/results/bench2/place.mjs <session dir>...   (aa1's rows too, which have rounds)
import { readFileSync } from 'node:fs';
for (const d of process.argv.slice(2)) {
  const run = JSON.parse(readFileSync(`${d}/ab.json`));
  const rows = run.rows.filter((r) => !r.warm && (r.round === undefined || r.round > 0));
  const key = (r) => r.block ?? r.round;
  const groups = new Map();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  const names = run.arms.map((a) => a.name);
  for (const [m, f] of [['wall', (s) => s.ms], ['cycles', (s) => s.proc.cycles]]) {
    const dev = {}; // arm -> place -> deviations from the group's mean (log, %)
    for (const g of groups.values()) {
      const mean = g.reduce((t, r) => t + Math.log(f(r.s)), 0) / g.length;
      for (const r of g) ((dev[r.arm] ??= {})[r.at] ??= []).push((Math.log(f(r.s)) - mean) * 100);
    }
    console.log(d, m);
    for (const n of names) console.log(' ', n.padEnd(5), [0, 1, 2, 3].map((p) => { const x = dev[n][p] ?? []; return `${(x.reduce((a, b) => a + b, 0) / (x.length || 1)).toFixed(2).padStart(6)} (${x.length})`; }).join('  '), ' all', (Object.values(dev[n]).flat().reduce((a, b) => a + b, 0) / Object.values(dev[n]).flat().length).toFixed(3));
  }
}
