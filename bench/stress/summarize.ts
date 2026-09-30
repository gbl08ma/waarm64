// Summarizes a stress run's JSONL log (bench/stress/stress.ts writes it; a run in progress is fine).
// usage: node bench/stress/summarize.ts <log.jsonl> [--stall-ms N] [--freeze-ms N] [--warmup S]
// Exit code 1 when there are findings.
import { readFileSync } from 'node:fs';
import { analyze, DEFAULTS, report, type Rec } from './analyze.ts';

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!file) {
  console.error('usage: node bench/stress/summarize.ts <log.jsonl> [--stall-ms N] [--freeze-ms N] [--warmup S]');
  process.exit(2);
}
const opt = (name: string, dflt: number) => Number(args[args.indexOf(name) + 1] ?? NaN) || dflt;
const recs = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l): Rec[] => {
  try {
    return [JSON.parse(l)];
  } catch {
    return []; // a line cut off by a kill
  }
});
const r = analyze(recs, { ...DEFAULTS, stallMs: opt('--stall-ms', DEFAULTS.stallMs), freezeMs: opt('--freeze-ms', DEFAULTS.freezeMs), warmupS: opt('--warmup', DEFAULTS.warmupS) });
console.log(report(r));
process.exit(r.findings.length ? 1 : 0);
