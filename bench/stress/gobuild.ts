// The `go build` loop's gate (docs/benchmarking.md "Screening an A/B"): each session's builds as the guest timed them
// (bench/stress/stress.ts's `gobuild` events), the median of those after the first `skip` (the cold ones), and per
// arm (the file name's part before the last `-<n>`) the sessions' medians and their median.
//   node bench/stress/gobuild.ts [--skip 3] <log.jsonl[.gz]>...
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { skip: { type: 'string', default: '3' } } });
const skip = Number(values.skip);
const med = (a: number[]) => [...a].sort((x, y) => x - y)[(a.length - 1) >> 1];
const arms = new Map<string, number[]>();
for (const f of positionals) {
  const raw = readFileSync(f);
  const text = f.endsWith('.gz') ? gunzipSync(raw).toString() : raw.toString();
  const ms = text
    .split('\n')
    .filter((l) => l.includes('"gobuild"'))
    .map((l) => /rc=(\d+) (\d+)(m?s)/.exec(JSON.parse(l).text))
    .filter((m): m is RegExpExecArray => m !== null && m[1] === '0')
    .map((m) => Number(m[2]) * (m[3] === 's' ? 1000 : 1));
  const steady = ms.slice(skip);
  const m = steady.length ? med(steady) : NaN;
  console.log(`${basename(f)}: ${ms.map((x) => (x / 1000).toFixed(1)).join(' ')} s; median after ${skip}: ${(m / 1000).toFixed(2)} s (${steady.length} builds)`);
  const arm = basename(f).replace(/\.jsonl(\.gz)?$/, '').replace(/-\d+$/, '');
  if (!Number.isNaN(m)) arms.set(arm, [...(arms.get(arm) ?? []), m]);
}
for (const [arm, ms] of arms) {
  const spread = (100 * (Math.max(...ms) - Math.min(...ms))) / med(ms);
  console.log(`${arm}: sessions ${ms.map((x) => (x / 1000).toFixed(2)).join(', ')} s; median ${(med(ms) / 1000).toFixed(2)} s, spread ${spread.toFixed(1)}%`);
}
