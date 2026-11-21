// PERF loop 44: the core's heap over a real-sites session, from its mem.jsonl(.gz) (MEMLOG; guest-session.ts).
//   node bench/boot/results/perf44/sum.ts <mem.jsonl[.gz]>...
// Per file: the heap's live maximum and mark (MiB) and when, the block map's keys and table at most, the JIT's prunes,
// flushes and rescues (the block map's among them), the decoded blocks' clears, and the heap in 60 s windows.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

type Jit = { prunes: number; pruneNs: number; flushes: number; rescues: number; mapRescues: number; lagFlushes: number; decClears?: number };
type Row = { t: number; memory?: { heapLive: number; heapPeak: number; jitKeys: number; jitKeyBytes: number; jitLiveBytes: number }; jit?: Jit };
const MiB = (b: number) => Math.round((b / 2 ** 20) * 10) / 10;
const out: Record<string, unknown> = {};
for (const f of process.argv.slice(2)) {
  const raw = readFileSync(f);
  const rows: Row[] = (f.endsWith('.gz') ? gunzipSync(raw) : raw).toString().trim().split('\n').map((l) => JSON.parse(l) as Row).filter((r) => r.memory && r.jit);
  const t0 = rows[0].t, last = rows[rows.length - 1];
  const s = (r: Row) => Math.round((r.t - t0) / 1000);
  const live = rows.reduce((a, r) => (r.memory!.heapLive > a.memory!.heapLive ? r : a));
  const markAt = rows.find((r) => r.memory!.heapPeak === last.memory!.heapPeak)!;
  const keys = rows.reduce((a, r) => (r.memory!.jitKeys > a.memory!.jitKeys ? r : a));
  const j = last.jit!;
  const windows: [number, number, number, number][] = [];
  for (let w = 0; w * 60 <= s(last); w++) {
    const in_ = rows.filter((r) => s(r) >= w * 60 && s(r) < (w + 1) * 60);
    if (in_.length) windows.push([w * 60, MiB(Math.max(...in_.map((r) => r.memory!.heapLive))), Math.max(...in_.map((r) => r.memory!.jitKeys)), MiB(Math.max(...in_.map((r) => r.memory!.jitLiveBytes)))]);
  }
  out[f] = {
    seconds: s(last),
    liveMaxMiB: MiB(live.memory!.heapLive), liveMaxS: s(live),
    markMiB: MiB(last.memory!.heapPeak), markReachedS: s(markAt),
    keysMax: keys.memory!.jitKeys, keysMaxS: s(keys), mapMiBMax: MiB(Math.max(...rows.map((r) => r.memory!.jitKeyBytes))),
    jitLiveMiBMax: MiB(Math.max(...rows.map((r) => r.memory!.jitLiveBytes))),
    prunes: j.prunes, pruneMsEach: j.prunes ? Math.round(j.pruneNs / 1e5 / j.prunes) / 10 : 0,
    pruneAtS: rows.filter((r, i) => i > 0 && r.jit!.prunes > rows[i - 1].jit!.prunes).map(s),
    flushes: j.flushes, flushAtS: rows.filter((r, i) => i > 0 && r.jit!.flushes > rows[i - 1].jit!.flushes).map(s),
    rescues: j.rescues, mapRescues: j.mapRescues, lagFlushes: j.lagFlushes, decClears: j.decClears,
    windows: { columns: ['fromS', 'heapLiveMiB', 'keys', 'jitLiveMiB'], rows: windows },
  };
}
console.log(JSON.stringify(out, null, 1));
