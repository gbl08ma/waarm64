// PERF loop 59 (bench/boot/REPORT.md): the diagnostic gauge words (8..31) of a session's mem.jsonl, at its end, with the heap's live bytes
// and mark at most.   node sum.ts <mem.jsonl>...
import { readFileSync } from 'node:fs';
const NAMES = ['installs', 'in tier_up', 'that grew', 'grown B', 'max install B', 'max tier_up install B', 'lk tbl grows', 'lk tbl B', 'lk list reallocs', 'lk list B', 'hd tbl grows', 'hd tbl B', 'hd list reallocs', 'hd list B', 'tr tbl grows', 'tr tbl B', 'log reallocs', 'log B', 'links', 'heads filed', 'heads new', 'lk keys max', 'tier_up grown B', 'max one alloc B'];
const out: Record<string, unknown> = {};
for (const f of process.argv.slice(2)) {
  type Row = { t: number; memory: { pr?: number[]; heapLive: number; heapPeak: number; jitKeys: number; jitEpochs: number } };
  const rows = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Row).filter((r) => r.memory?.pr);
  const end = rows[rows.length - 1], last = end.memory;
  const live = Math.max(...rows.map((r) => r.memory.heapLive)), mark = Math.max(...rows.map((r) => r.memory.heapPeak));
  const secs = (end.t - rows[0].t) / 1000;
  out[f] = { samples: rows.length, secs, heapLiveMiB: +(live / 2 ** 20).toFixed(1), heapMarkMiB: +(mark / 2 ** 20).toFixed(1), keys: last.jitKeys, epochs: last.jitEpochs, pr: Object.fromEntries(NAMES.map((n, i) => [n, last.pr![i]])) };
}
console.log(JSON.stringify(out, null, 1));
