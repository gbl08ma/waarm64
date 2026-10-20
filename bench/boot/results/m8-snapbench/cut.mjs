// node cut.mjs <jit.jsonl.gz>...: the JIT's counts at cutoffs (s after the first sample: the restore, or the page running after a boot): flushes, modules, MB compiled, the share of guest steps run compiled since the start (bench/boot/REPORT.md "M8: benchmarks started from a snapshot").
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const CUTS = [120, 180, 240, 300, 360, 9999];
for (const f of process.argv.slice(2)) {
  const raw = readFileSync(f);
  const lines = (f.endsWith('.gz') ? gunzipSync(raw) : raw).toString().trim().split('\n').map((l) => JSON.parse(l));
  const t0 = lines[0].t, a = lines[0];
  const out = CUTS.map((c) => {
    const b = lines.filter((x) => x.t - t0 <= c * 1000).at(-1);
    return `${c === 9999 ? 'end' : c}s:${b.jit.flushes}f/${b.jit.modules}m/${Math.round(b.jit.bytes / 1e6)}MB/${(((b.jit.steps - a.jit.steps) / (b.steps - a.steps)) * 100).toFixed(1)}%`;
  });
  console.log(f.split('/').slice(-3, -1).join('/'), Math.round((lines.at(-1).t - t0) / 1000) + 's', out.join(' '));
}
