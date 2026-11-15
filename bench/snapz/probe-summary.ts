// bench/snapz/probe.ts's results summed up (docs/benchmarking.md "The snapshot probe"; dev-only): per file (an arm, a
// guest), per operation, the median and range over its rounds of the wall time, the pause and each phase, and the
// browser's memory before and at the peak of each save.
//   node bench/snapz/probe-summary.ts <result.json>... [--json <out.json>]
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : undefined;

type Op = { wallMs: number; pausedMs?: number; bytes?: number; phases: Record<string, number>; memory?: { before: Record<string, number>; peak: Record<string, number> } };
type Result = { meta: Record<string, unknown>; rounds: Record<string, Op | number>[] };

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
/** Median and range of `v`, as numbers and as "median (min-max)". */
const stat = (v: number[]) => ({ median: Math.round(median(v)), min: Math.min(...v), max: Math.max(...v), n: v.length });
const show = (s: ReturnType<typeof stat>) => (s.n > 1 ? `${s.median} (${s.min}-${s.max})` : `${s.median}`);

const summary: Record<string, Record<string, Record<string, ReturnType<typeof stat>>>> = {};
for (const file of args) {
  const r = JSON.parse(readFileSync(file, 'utf8')) as Result;
  const name = `${basename(file, '.json')} (${r.meta.guest}, ${r.meta.mode}, ${r.rounds.length} rounds)`;
  const ops: Record<string, Record<string, ReturnType<typeof stat>>> = (summary[name] = {});
  for (const op of ['load', 'kept', 'file', 'suspend', 'resume']) {
    const runs = r.rounds.map((x) => x[op]).filter((x): x is Op => !!x && typeof x === 'object');
    if (!runs.length) continue;
    const cols: Record<string, number[]> = { wallMs: runs.map((x) => x.wallMs) };
    if (runs[0].pausedMs !== undefined) cols.pausedMs = runs.map((x) => x.pausedMs!);
    if (runs[0].bytes !== undefined) cols.MB = runs.map((x) => Math.round(x.bytes! / 1e6));
    for (const k of Object.keys(runs[0].phases)) cols[k] = runs.map((x) => x.phases[k]);
    if (runs[0].memory) {
      cols.rssBeforeMiB = runs.map((x) => x.memory!.before.rssMiB);
      cols.rssPeakMiB = runs.map((x) => x.memory!.peak.rssMiB);
      cols.pssBeforeMiB = runs.map((x) => x.memory!.before.pssMiB);
      cols.pssPeakMiB = runs.map((x) => x.memory!.peak.pssMiB);
      // What the save added (its buffers, a pool's instances): the peak over the memory before it.
      cols.rssAddedMiB = runs.map((x) => x.memory!.peak.rssMiB - x.memory!.before.rssMiB);
      cols.pssAddedMiB = runs.map((x) => x.memory!.peak.pssMiB - x.memory!.before.pssMiB);
    }
    ops[op] = Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, stat(v)]));
  }
  console.log(`\n${name}: ${r.meta.chromium}, ${r.meta.commit}`);
  for (const [op, cols] of Object.entries(ops)) console.log(`  ${op.padEnd(8)} ${Object.entries(cols).map(([k, s]) => `${k} ${show(s)}`).join(' | ')}`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(summary, null, 1) + '\n');
