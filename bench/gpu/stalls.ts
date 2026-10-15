// Stalls in vCPU timelines (dev-only; web/profiler.ts rows, as bench/gpu/firefox-load.ts saves them): per vCPU, the
// runs of 10 ms bins inside one vm_run_cpu call that retired nothing (the host stopped it: a JIT install, V8's GC, a
// lock), counted by length; and the runs in which every vCPU stalled at once. Prints a line a file; with --json, JSON.
//   node bench/gpu/stalls.ts [--json] <timeline.json>...
import { readFileSync } from 'node:fs';
import type { Timeline } from '../../web/profiler.ts';
const EDGES = [20, 50, 100, 250, 500, 1000];
const json = process.argv.includes('--json');
const out: Record<string, unknown> = {};
for (const file of process.argv.slice(2).filter((a) => a !== '--json')) {
  const t = JSON.parse(readFileSync(file, 'utf8')) as Timeline;
  const w = 1 + t.ncpus * t.fields.length, n = t.rows.length / w, f = (k: string) => t.fields.indexOf(k);
  const [S, IN] = [f('steps'), f('enteredAt')];
  const at = (r: number, c: number, k: number) => t.rows[r * w + 1 + c * t.fields.length + k];
  const time = (r: number) => t.rows[r * w];
  const secs = (time(n - 1) - time(0)) / 1000;
  const runs: number[] = [], all: number[] = [];
  let allRun = 0;
  const cur = new Array(t.ncpus).fill(0);
  let steps = 0;
  for (let r = 1; r < n; r++) {
    const dt = time(r) - time(r - 1);
    let stalled = 0, inside = 0;
    for (let c = 0; c < t.ncpus; c++) {
      const same = at(r, c, IN) !== 0 && at(r, c, IN) === at(r - 1, c, IN);
      const ds = at(r, c, S) - at(r - 1, c, S);
      steps += ds;
      if (same) inside++;
      if (same && ds === 0) { stalled++; cur[c] += dt; } else { if (cur[c] >= 20) runs.push(cur[c]); cur[c] = 0; }
    }
    if (inside === t.ncpus && stalled === t.ncpus) allRun += dt; else { if (allRun >= 20) all.push(allRun); allRun = 0; }
  }
  const hist = (xs: number[]) => EDGES.map((e) => xs.filter((x) => x >= e).length).join('/');
  const top = (xs: number[]) => [...xs].sort((a, b) => b - a).slice(0, 6).map(Math.round).join(',');
  if (json) {
    out[file] = { seconds: Math.round(secs), mips: Math.round(steps / secs / 1e6), stallsAtLeastMs: Object.fromEntries(EDGES.map((e) => [e, runs.filter((x) => x >= e).length])), longestMs: Math.round(Math.max(0, ...runs)), stalledMsPerSecondPerVcpu: +(runs.reduce((a, b) => a + b, 0) / secs / t.ncpus).toFixed(2), allVcpuStallsAtLeastMs: Object.fromEntries(EDGES.map((e) => [e, all.filter((x) => x >= e).length])) };
    continue;
  }
  console.log(`${file}: ${secs.toFixed(0)} s, ${(steps / secs / 1e6).toFixed(0)} MIPS; vCPU stalls >=${EDGES.join('/')} ms: ${hist(runs)} (top ${top(runs)}), stalled ms/s ${(runs.reduce((a, b) => a + b, 0) / secs / t.ncpus).toFixed(1)}; all-vCPU stalls: ${hist(all)} (top ${top(all)})`);
}
if (json) console.log(JSON.stringify(out, null, 1));
