// Renderer RSS (MB) quantiles over the samples after the first 120 s: node bench/mem/rss-stats.mjs <samples.json>...
import { readFileSync } from 'node:fs';
const sum = (o) => Object.values(o).reduce((x, y) => x + y, 0);
for (const f of process.argv.slice(2)) {
  const d = JSON.parse(readFileSync(f, 'utf8'));
  const r = d.samples.filter((s) => s.t > 120).map((s) => Math.max(...s.procs.map((p) => sum(p.cls.names))) / 1024).sort((a, b) => a - b);
  const flushes = d.samples.at(-1).targets.find((t) => t.jit2)?.jit2.flushes;
  console.log(f.split('/').pop().padEnd(28), 'n', r.length, 'median', r[Math.floor(r.length / 2)].toFixed(0), 'p90', r[Math.floor(r.length * 0.9)].toFixed(0), 'max', r.at(-1).toFixed(0), 'flushes(all vCPUs)', flushes);
}
