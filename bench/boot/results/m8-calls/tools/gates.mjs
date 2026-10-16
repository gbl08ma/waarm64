// gates.mjs <dir> <build...>: pooled medians of every result name over rounds, per build, and % vs the first.
import { readFileSync, readdirSync } from 'node:fs';
const [dir, ...builds] = process.argv.slice(2);
const pool = new Map(); // name -> build -> samples
const ctr = new Map();
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const m = /^(.*)-([^-]+)-(\d+)\.json$/.exec(f); if (!m) continue;
  const b = m[2]; if (!builds.includes(b)) continue;
  const j = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
  for (const r of j.results) {
    const p = pool.get(r.name) ?? pool.set(r.name, new Map()).get(r.name);
    (p.get(b) ?? p.set(b, []).get(b)).push(...r.samples);
    const jit = r.params?.counters?.jit;
    if (jit && /total/.test(r.name)) { const c = ctr.get(r.name) ?? ctr.set(r.name, new Map()).get(r.name); (c.get(b) ?? c.set(b, []).get(b)).push(`${(jit.bytes/1e6).toFixed(1)}MB/${jit.modules}m/${jit.dispatches}d`); }
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
for (const [name, p] of [...pool].sort()) {
  const base = p.get(builds[0]) ? med(p.get(builds[0])) : NaN;
  console.log(name.padEnd(34), builds.map((b) => { const v = p.get(b) ? med(p.get(b)) : NaN; return `${b} ${v.toFixed(0)} (n${p.get(b)?.length ?? 0}${b === builds[0] ? '' : ', ' + ((100 * (v - base)) / base).toFixed(1) + '%'})`; }).join('  '));
}
for (const [name, c] of ctr) console.log(name, builds.map((b) => `${b}: ${(c.get(b) ?? []).join(' ')}`).join(' | '));
