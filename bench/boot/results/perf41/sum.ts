// PERF loop 41: what the block map's prunes keep and lose, from a session's mem.jsonl(.gz) (diag.patch's gauge words
// 8-23 as `memory.pr`, index i = word 8 + i).
//   node bench/boot/results/perf41/sum.ts <mem.jsonl[.gz]>...
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

type Cpu = { decClears?: number; rescues?: number; decoded?: number };
type Row = {
  t: number;
  memory: { heapLive: number; heapPeak: number; jitKeys: number; jitKeyBytes: number; pr?: number[] };
  jit: { prunes: number; pruneNs: number; flushes: number; invalidations: number };
  cpus?: Cpu[];
};
const MiB = (b: number) => Math.round((b / 2 ** 20) * 10) / 10;
const out: Record<string, unknown> = {};
for (const f of process.argv.slice(2)) {
  const raw = readFileSync(f);
  const rows: Row[] = (f.endsWith('.gz') ? gunzipSync(raw) : raw).toString().trim().split('\n').map((l) => JSON.parse(l) as Row);
  const last = rows[rows.length - 1];
  const live = rows.reduce((a, r) => (r.memory.heapLive > a.memory.heapLive ? r : a));
  const markAt = rows.findIndex((r) => r.memory.heapPeak === last.memory.heapPeak);
  const p = last.memory.pr ?? [];
  const w = (n: number) => p[n - 8] ?? 0;
  const pruneT = rows.filter((r, i) => i > 0 && r.jit.prunes > rows[i - 1].jit.prunes).map((r) => Math.round((r.t - rows[0].t) / 1000));
  out[f] = {
    seconds: Math.round((last.t - rows[0].t) / 1000),
    markMiB: MiB(last.memory.heapPeak), liveMaxMiB: MiB(live.memory.heapLive), liveMaxS: Math.round((live.t - rows[0].t) / 1000),
    markRiseS: Math.round((rows[markAt].t - rows[0].t) / 1000), keysAtMarkRise: rows[markAt].memory.jitKeys,
    mapMiBAtMarkRise: MiB(rows[markAt].memory.jitKeyBytes), mapMiBMax: MiB(Math.max(...rows.map((r) => r.memory.jitKeyBytes))),
    keysMax: Math.max(...rows.map((r) => r.memory.jitKeys)),
    prunes: last.jit.prunes, pruneAtS: pruneT, flushes: last.jit.flushes,
    pruneMsEach: last.jit.prunes ? Math.round((last.jit.pruneNs - w(23)) / 1e5 / last.jit.prunes) / 10 : 0,
    diagMsEach: last.jit.prunes ? Math.round(w(23) / 1e5 / last.jit.prunes) / 10 : 0,
    keysBefore: w(8), keptNeeded: w(9), keptRecent: w(10), keptWarm: w(11), secondRetains: w(12), thirdRetains: w(13),
    droppedCold: w(19), droppedWarm: w(20), droppedRecent: w(22),
    newKeys: w(16), newAfterPrune: w(21), backCold: w(14), backWarm: w(15), backColdCompiled: w(17), backWarmCompiled: w(18),
    decClears: (last.cpus ?? []).map((c) => c.decClears), decClearsByKeys: (last.cpus ?? []).map((c) => c.rescues),
  };
}
console.log(JSON.stringify(out, null, 1));
