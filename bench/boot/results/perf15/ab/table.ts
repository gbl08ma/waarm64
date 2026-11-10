// Prints each arm's per-round medians for the A/B in this directory:   node table.ts [prefix] [arms...]
import { readFileSync, readdirSync } from 'node:fs';
const dir = new URL('.', import.meta.url);
const prefix = process.argv[2] ?? 'perf15';
const arms = process.argv.length > 3 ? process.argv.slice(3) : ['nofix', 'main'];
const rows = new Map<string, Map<string, number[]>>();
for (const f of readdirSync(dir).filter((f) => f.startsWith(prefix + '-r') && f.endsWith('.json')).sort()) {
  const arm = f.split('-')[2];
  const j = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as { results: { name: string; median: number }[] };
  for (const r of j.results) {
    const byArm = rows.get(r.name) ?? new Map<string, number[]>();
    rows.set(r.name, byArm);
    byArm.set(arm, [...(byArm.get(arm) ?? []), r.median]);
  }
}
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
for (const [name, byArm] of rows) {
  const cells = arms.map((a) => `${(byArm.get(a) ?? []).map((x) => Math.round(x)).join(' · ')} (${Math.round(med(byArm.get(a) ?? [0]))})`);
  const ratio = med(byArm.get(arms[1]) ?? [0]) / med(byArm.get(arms[0]) ?? [1]);
  console.log(`${name}: ${cells.join(' | ')} ${arms[1]}/${arms[0]} ${ratio.toFixed(3)}`);
}
