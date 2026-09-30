// A few KB per run from memsample.ts's raw samples (which are big: keep them in bench/results/local/):
// node bench/mem/summarize.mjs <raw.json>... > bench/mem/results/summary.json
// Per run: the renderer's RSS by mapping class every ~60 s, its quantiles after 120 s, and the JIT counters.
import { readFileSync } from 'node:fs';

const sum = (o) => Object.values(o).reduce((x, y) => x + y, 0);
const mb = (kb) => Math.round(kb / 1024);
const out = {};
for (const f of process.argv.slice(2)) {
  const d = JSON.parse(readFileSync(f, 'utf8'));
  const series = [];
  let next = 0;
  const rss = [];
  for (const s of d.samples) {
    const big = s.procs.reduce((a, b) => (sum(a.cls.names) > sum(b.cls.names) ? a : b));
    const n = big.cls.names;
    const g = (k) => Object.entries(n).filter(([a]) => a.includes(k)).reduce((x, [, v]) => x + v, 0);
    if (s.t > 120) rss.push(sum(n));
    if (s.t < next) continue;
    next = s.t + 60;
    const w = s.targets.filter((t) => t.jit);
    const m = s.targets.find((t) => t.jit2)?.jit2;
    series.push({
      t: Math.round(s.t), label: s.label, rssMB: mb(sum(n)), partitionAllocMB: mb(g('partition_alloc')), wasmCodeMB: mb(g('rwxp [anon:v8]')),
      linearMemoryMB: mb(g('v8-sandbox')), jsHeapsMB: mb(g('rw-p [anon:v8]')),
      workerModules: w.reduce((a, t) => a + t.jit.modules, 0), workerWasmMB: Math.round(w.reduce((a, t) => a + t.jit.bytes, 0) / 1e6),
      regions: m?.blocks, flushes: m?.flushes, stepsG: m && +(m.steps / 1e9).toFixed(1), compileS: m && +(m.compileNs / 1e9).toFixed(1),
    });
  }
  rss.sort((a, b) => a - b);
  const q = (p) => mb(rss[Math.min(rss.length - 1, Math.floor(rss.length * p))]);
  out[f.split('/').pop().replace(/\.json$/, '')] = { chromium: d.chromium, samples: d.samples.length, rssAfter120s: { medianMB: q(0.5), p90MB: q(0.9), maxMB: q(1) }, series };
}
console.log(JSON.stringify(out, null, 1));
