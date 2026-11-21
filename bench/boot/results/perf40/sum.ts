// PERF loop 40: the block map's table across a prune, from a session's mem.jsonl(.gz) (diag.patch's gauge words 8-13
// as `memory.mr`: rehashes in place and their ns, the table's full capacity, its capacity now, resizes and their ns).
//   node bench/boot/results/perf40/sum.ts <mem.jsonl[.gz]>...
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

type Row = { t: number; memory: { heapLive: number; heapPeak: number; jitKeys: number; jitKeyBytes: number; mr?: number[] }; jit: { prunes: number; pruneNs: number; invalidations: number; flushes: number } };
const MiB = (b: number) => Math.round((b / 2 ** 20) * 10) / 10;
const out: Record<string, unknown> = {};
for (const f of process.argv.slice(2)) {
  const raw = readFileSync(f);
  const rows: Row[] = (f.endsWith('.gz') ? gunzipSync(raw) : raw).toString().trim().split('\n').map((l) => JSON.parse(l) as Row);
  const last = rows[rows.length - 1];
  const live = rows.reduce((a, r) => (r.memory.heapLive > a.memory.heapLive ? r : a));
  const markAt = rows.findIndex((r) => r.memory.heapPeak === last.memory.heapPeak);
  const mr = last.memory.mr ?? [];
  const tomb = rows.map((r) => (r.memory.mr ? r.memory.mr[2] - r.memory.mr[3] : 0));
  out[f] = {
    samples: rows.length, seconds: Math.round((last.t - rows[0].t) / 1000),
    markMiB: MiB(last.memory.heapPeak), liveMaxMiB: MiB(live.memory.heapLive),
    markRiseS: Math.round((rows[markAt].t - rows[0].t) / 1000), keysAtMarkRise: rows[markAt].memory.jitKeys,
    mapMiBAtMarkRise: MiB(rows[markAt].memory.jitKeyBytes), mapMiBBefore: markAt > 0 ? MiB(rows[markAt - 1].memory.jitKeyBytes) : undefined,
    keysMax: Math.max(...rows.map((r) => r.memory.jitKeys)),
    prunes: last.jit.prunes, pruneMsEach: last.jit.prunes ? Math.round(last.jit.pruneNs / 1e5 / last.jit.prunes) / 10 : 0,
    flushes: last.jit.flushes, invalidations: last.jit.invalidations,
    rehashes: mr[0], rehashMsEach: mr[0] ? Math.round(mr[1] / 1e5 / mr[0]) / 10 : 0, rehashMsAll: Math.round((mr[1] ?? 0) / 1e5) / 10,
    resizes: mr[4], resizeMsAll: Math.round((mr[5] ?? 0) / 1e5) / 10,
    fullCap: mr[2], tombstonesMax: Math.max(...tomb),
  };
}
console.log(JSON.stringify(out, null, 1));
