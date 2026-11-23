// A few KB per run from memsample.ts's raw samples (which are big: keep them in bench/results/local/):
// node bench/mem/summarize.mjs <raw.json>... > bench/mem/results/<name>.json
// Per run: the renderer's RSS by mapping class every ~60 s, its quantiles after 120 s, and the JIT counters. Raw files
// of today's memsample.ts (samples with `procs[].cls`) give every sample instead, with the kernel's RSS counters around
// each smaps read, the code mappings' reserved and huge-page bytes, the JS heaps of every realm, and from the
// V8TRACE log beside the file (`<raw>.v8.log`) V8's wasm code GC between samples: GCs started, code objects freed, and
// the dead code bytes it last counted.
import { existsSync, readFileSync } from 'node:fs';

const sum = (o) => Object.values(o).reduce((x, y) => x + y, 0);
const mb = (kb) => Math.round(kb / 1024);
const MiB = (b) => Math.round(b / 2 ** 20);
const quant = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { medianMB: q(0.5), p90MB: q(0.9), maxMB: q(1) };
};

/** V8's wasm code GC lines between byte offsets of the log, per sample: GCs started, code objects freed, the last dead bytes counted. */
function v8gc(log, ats) {
  if (!log || !existsSync(log)) return undefined;
  const txt = readFileSync(log);
  let from = 0;
  return ats.map((at) => {
    const part = txt.subarray(from, at ?? from).toString();
    from = at ?? from;
    let gcs = 0, freed = 0, dead;
    for (const m of part.matchAll(/Starting GC \(nr \d+\)|Freeing (\d+) code objects? of module|potentially dead: (\d+) bytes/g)) {
      if (m[1]) freed += Number(m[1]);
      else if (m[2]) dead = Number(m[2]);
      else gcs++;
    }
    return { gcs, freed, deadMB: dead === undefined ? undefined : +(dead / 2 ** 20).toFixed(1) };
  });
}

function today(f, d) {
  const series = [];
  const rss = [], vm = [], code = [];
  const big = d.samples.map((s) => s.procs.reduce((a, b) => (b.total.rss > a.total.rss ? b : a)));
  const gc = v8gc(d.v8log, d.samples.map((s) => s.v8at));
  let jump = { mb: 0 };
  d.samples.forEach((s, i) => {
    const p = big[i];
    const heaps = s.heaps.filter((h) => h.type === 'worker' || h.type === 'page');
    const st = s.status ?? {};
    const row = {
      t: Math.round(s.t), label: s.label, rssMB: MiB(p.total.rss), vmRssMB: [MiB(p.before?.VmRSS ?? 0), MiB(p.after?.VmRSS ?? 0)], readMs: p.readMs,
      codeMB: MiB(p.cls.code.rss), codeSizeMB: MiB(p.cls.code.size), codeThpMB: MiB(p.cls.code.thp), codeMaps: p.cls.code.n,
      anonMB: MiB(p.cls.anon.rss), anonThpMB: MiB(p.cls.anon.thp), wasmMemMB: MiB(p.cls['wasm-mem'].rss),
      jsHeapsMB: MiB(heaps.reduce((a, h) => a + h.usedSize, 0)), backingStoresMB: MiB(heaps.reduce((a, h) => a + (h.backingStorageSize ?? 0), 0)),
      flushes: st.jitFlushes, jitMB: st.jitBytes && Math.round(st.jitBytes / 1e6), modules: st.stats?.jit?.modules, compileS: st.jitCompileMs && +(st.jitCompileMs / 1000).toFixed(1),
      estimateMB: st.estimateBytes && MiB(st.estimateBytes), thpFaults: s.thp?.thp_fault_alloc, thpCollapses: s.thp?.thp_collapse_alloc,
      ...(gc ? { v8gc: gc[i] } : {}),
    };
    if (i && row.codeMB - series[i - 1].codeMB > jump.mb) jump = { mb: row.codeMB - series[i - 1].codeMB, t: row.t, s: +(s.t - d.samples[i - 1].t).toFixed(1) };
    series.push(row);
    if (s.t > 120) { rss.push(row.rssMB); vm.push(row.vmRssMB[1]); code.push(row.codeMB); }
  });
  return { chromium: d.chromium, query: d.query.replace(/credential=[^&]*&?/g, ''), every: d.every, samples: d.samples.length, rssAfter120s: quant(rss), vmRssAfter120s: quant(vm), codeAfter120s: quant(code), codeJump: jump, series };
}

const out = {};
for (const f of process.argv.slice(2)) {
  const d = JSON.parse(readFileSync(f, 'utf8'));
  const key = f.split('/').pop().replace(/\.json$/, '');
  if (d.samples[0]?.procs?.[0]?.cls) { out[key] = today(f, d); continue; }
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
  const q = quant(rss.map(mb));
  out[key] = { chromium: d.chromium, samples: d.samples.length, rssAfter120s: q, series };
}
console.log(JSON.stringify(out, null, 1));
