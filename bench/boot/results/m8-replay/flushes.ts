// Each JIT flush of a Firefox pages session (bench/gpu/firefox-load.ts with TIMELINE_ALL=1): the slow phase after it
// (the share of steps run in compiled code, a second at a time, back within 5 points of the 20 s before the flush),
// the steps interpreted beyond that share over 60 s, the MIPS, the regions replayed, and Firefox's frames in the
// seconds around it (the pages' FFBENCH lines, lined up by `readyAt`). With --json, JSON.
//   node bench/boot/results/m8-replay/flushes.ts [--json] <session dir>...
import { readFileSync } from 'node:fs';

type Timeline = { ncpus: number; periodMs: number; fields: string[]; rows: number[] };
const json = process.argv.includes('--json');
const out: Record<string, unknown> = {};
for (const dir of process.argv.slice(2).filter((a) => a !== '--json')) {
  const t = JSON.parse(readFileSync(`${dir}/pages-all.timeline.json`, 'utf8')) as Timeline;
  const res = JSON.parse(readFileSync(`${dir}/results.json`, 'utf8')) as Record<string, any>;
  const F = t.fields.length, w = 1 + t.ncpus * F, n = t.rows.length / w, f = (k: string) => t.fields.indexOf(k);
  const time = (r: number) => t.rows[r * w];
  const sum = (r: number, k: number) => { let s = 0; for (let c = 0; c < t.ncpus; c++) s += t.rows[r * w + 1 + c * F + k]; return s; };
  const [S, J, FL, RP] = [f('steps'), f('jitSteps'), f('flushes'), f('replayed')];
  const t0 = time(0);
  // Rows a second apart from the start.
  const at = (ms: number) => { let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (time(m) < ms) lo = m + 1; else hi = m; } return lo; };
  const sec = (from: number) => { const a = at(from), b = at(from + 1000); if (b <= a) return { mips: 0, share: NaN, interp: 0 }; const ds = sum(b, S) - sum(a, S), dj = sum(b, J) - sum(a, J); return { mips: ds / ((time(b) - time(a)) * 1e3), share: ds ? dj / ds : 1, interp: ds - dj }; };
  // Frames: [host ms at the second's end, frames, maxms].
  const frames: [number, number, number][] = [];
  for (const [k, v] of Object.entries(res)) if (k.startsWith('page-') && v?.readyAt && v.fpsAll) for (const [s, fr, mx] of v.fpsAll) frames.push([v.readyAt + s * 1000, fr, mx]);
  const flushes: Record<string, unknown>[] = [];
  for (let r = 1; r < n; r++) {
    const d = sum(r, FL) - sum(r - 1, FL);
    if (!d) continue;
    const ft = time(r);
    const before = Array.from({ length: 20 }, (_, k) => sec(ft - 21_000 + k * 1000)).filter((x) => x.mips > 0);
    const base = before.map((x) => x.share).sort((a, b) => a - b)[before.length >> 1] ?? 1;
    const baseMips = before.map((x) => x.mips).sort((a, b) => a - b)[before.length >> 1] ?? 0;
    const after = Array.from({ length: 60 }, (_, k) => sec(ft + k * 1000));
    const back = (d: number) => { const k = after.findIndex((x, k) => !(x.share < base - d) && !((after[k + 1]?.share ?? 1) < base - d)); return k < 0 ? 60 : k; };
    const slow = back(0.05), slow2 = back(0.02);
    const excess = after.reduce((a, x, k) => a + (isNaN(x.share) ? 0 : Math.max(0, x.interp - (1 - base) * (x.mips * 1e6 * ((time(at(ft + k * 1000 + 1000)) - time(at(ft + k * 1000))) / 1000)))), 0);
    const rp = sum(at(ft + 60_000), RP) - sum(r - 1, RP);
    const near = frames.filter(([h]) => h > ft - 5000 && h <= ft + 15_000).map(([h, fr, mx]) => [Math.round((h - ft) / 1000), fr, mx]);
    // The seconds of frames in the 10 s after the flush: how many, their frames a second, those with a gap ≥ 250 ms.
    const ten = frames.filter(([h]) => h > ft && h <= ft + 10_000);
    const fps10 = ten.length ? { s: ten.length, fps: +(ten.reduce((a, x) => a + x[1], 0) / ten.length).toFixed(1), gaps250: ten.filter((x) => x[2] >= 250).length } : undefined;
    flushes.push({ atS: Math.round((ft - t0) / 1000), n: d, baseShare: +base.toFixed(3), baseMips: Math.round(baseMips), slowS: slow, slow2S: slow2, minShare: +Math.min(...after.slice(0, Math.max(1, slow2)).map((x) => x.share).filter((x) => !isNaN(x))).toFixed(3), mipsSlow: Math.round(after.slice(0, Math.max(1, slow)).reduce((a, x) => a + x.mips, 0) / Math.max(1, slow)), excessInterpM: Math.round(excess / 1e6), interp10M: Math.round(after.slice(0, 10).reduce((a, x) => a + x.interp, 0) / 1e6), interp60M: Math.round(after.reduce((a, x) => a + x.interp, 0) / 1e6), mips10: Math.round(after.slice(0, 10).reduce((a, x) => a + x.mips, 0) / 10), replayed60s: rp, fps10, frames: near });
  }
  const jit = res.jit ?? {};
  const counts = { flushes: jit.flushes, modules: jit.modules, bytes: jit.bytes, replays: jit.replays, replayed: jit.replayed, replayedBytes: jit.replayedBytes, overdue: jit.overdue, workerInstalls: jit.workerInstalls,
    // ABI 42: what the carry kept and let go of, and how the replay was emitted.
    futile: jit.futile, marked: jit.marked, kept: jit.kept, aliveModules: jit.releasedModules === undefined ? undefined : jit.modules - jit.releasedModules,
    emitsInline: jit.emitsInline, emitsWorker: jit.emitsWorker, discards: jit.discardEpoch === undefined ? undefined : jit.discardEpoch + jit.discardPage + jit.discardImport, wasted: jit.wasted };
  out[dir] = { seconds: Math.round((time(n - 1) - t0) / 1000), flushes, jit: counts };
  if (!json) {
    console.log(`${dir}: ${JSON.stringify(counts)}`);
    for (const x of flushes) console.log(`  ${JSON.stringify(x)}`);
  }
}
if (json) console.log(JSON.stringify(out, null, 1));
