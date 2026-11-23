// What a JIT flush costs in a long browser session (PERF loop 63; dev-only): bench/gpu/firefox-load.ts's
// PHASES=browse session through bench/gpu/ab-mac.sh (JITLOG=1, TIMELINE_ALL=1, KEEP_TIMELINES=1, RSSLOG=1, MEMLOG).
// Per session: the wasm compiled since the restore (MB at the start, each 10 minutes and the end, the rate over the last half), the cache's live
// bytes (the page's gauge, MEMLOG), the flushes' times, the renderer's RSS on the Mac (mac.rss: median and maximum);
// then per flush, against the session's other windows of the same length (the baseline: every start time in the
// session at least 90 s from a flush):
//   - MIPS (all vCPUs) and the compiled share in 5 s bins: the 60 s before, the lowest bin after, the seconds until
//     MIPS is back within 10% of before and the share within 2 points;
//   - the vCPU timeline's stalls (a vCPU inside one vm_run_cpu call retiring nothing for ≥ 50 ms; all vCPUs at once)
//     in the 30 s from the flush, and the longest;
//   - Firefox's frames (each second's longest gap between two frames, `maxms`, on the page it was on): the worst
//     second in the 30 s from the flush and the seconds over 100 ms, against the baseline's median and 90th percentile.
//   node bench/gpu/flush-cost.ts [--json] <session dir>...
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

type Timeline = { ncpus: number; periodMs: number; fields: string[]; rows: number[] };
type S = { t: number; steps: number; jit: Record<string, number> };
const json = process.argv.includes('--json');
const text = (f: string) => (existsSync(`${f}.gz`) ? gunzipSync(readFileSync(`${f}.gz`)).toString() : existsSync(f) ? readFileSync(f, 'utf8') : '');
const lines = (f: string) => text(f).trim().split('\n').filter(Boolean);
const q = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p + 0.5))]; };
const r1 = (x: number) => Math.round(x * 10) / 10;

/** Stall runs (per vCPU, and all vCPUs at once) with their start time (epoch ms), as bench/gpu/stalls.ts counts them. */
export function stallRuns(t: Timeline) {
  const w = 1 + t.ncpus * t.fields.length, n = t.rows.length / w, f = (k: string) => t.fields.indexOf(k);
  const [ST, IN] = [f('steps'), f('enteredAt')];
  const at = (r: number, c: number, k: number) => t.rows[r * w + 1 + c * t.fields.length + k];
  const time = (r: number) => t.rows[r * w];
  const one: { at: number; ms: number }[] = [], all: { at: number; ms: number }[] = [];
  const cur = new Array(t.ncpus).fill(0), from = new Array(t.ncpus).fill(0);
  let allRun = 0, allFrom = 0;
  for (let r = 1; r < n; r++) {
    const dt = time(r) - time(r - 1);
    let stalled = 0, inside = 0;
    for (let c = 0; c < t.ncpus; c++) {
      const same = at(r, c, IN) !== 0 && at(r, c, IN) === at(r - 1, c, IN);
      const ds = at(r, c, ST) - at(r - 1, c, ST);
      if (same) inside++;
      if (same && ds === 0) { if (!cur[c]) from[c] = time(r - 1); stalled++; cur[c] += dt; } else { if (cur[c] >= 20) one.push({ at: from[c], ms: cur[c] }); cur[c] = 0; }
    }
    if (inside === t.ncpus && stalled === t.ncpus) { if (!allRun) allFrom = time(r - 1); allRun += dt; } else { if (allRun >= 20) all.push({ at: allFrom, ms: allRun }); allRun = 0; }
  }
  return { one, all, from: time(0), to: time(n - 1) };
}

function session(dir: string) {
  const res = JSON.parse(readFileSync(`${dir}/results.json`, 'utf8'));
  const b = res.browse;
  if (!b) throw new Error(`${dir}: no browse phase`);
  const from: number = b.readyAt, to: number = b.readyAt + b.seconds * 1000;
  const xs = lines(`${dir}/jit.jsonl`).map((l) => JSON.parse(l) as S).filter((x) => x.t >= from - 5000 && x.t <= to + 5000);
  // Per-second rates from the samples (a second apart, uneven: per actual interval).
  const sec = xs.slice(1).map((x, i) => { const p = xs[i], dt = (x.t - p.t) / 1000, ds = x.steps - p.steps; return { t: x.t, mips: ds / dt / 1e6, share: ds > 0 ? (x.jit.steps - p.jit.steps) / ds : NaN, flushes: x.jit.flushes - p.jit.flushes }; });
  const flushAt = sec.filter((x) => x.flushes > 0).map((x) => x.t - 500);
  const mbAt = (ms: number) => { const x = xs.find((y) => y.t >= from + ms) ?? xs.at(-1)!; return Math.round(x.jit.bytes / 1e6); };
  const half = xs.find((x) => x.t >= from + (to - from) / 2) ?? xs[0];
  const last = xs.at(-1)!;
  const rateMBmin = ((last.jit.bytes - half.jit.bytes) / 1e6) / ((last.t - half.t) / 60000);
  // The page's gauge (MEMLOG's mem.jsonl): the cache's live bytes since the last flush.
  const mem = lines(`${dir}/mem.jsonl`).map((l) => JSON.parse(l) as { t: number; memory?: Record<string, unknown> });
  const live = mem.map((m) => { const h = JSON.stringify(m.memory ?? {}); const v = /"jitLiveBytes":(\d+)/.exec(h); return v ? { t: m.t, mb: Math.round(+v[1] / 1048576) } : undefined; }).filter((x): x is { t: number; mb: number } => !!x && x.t >= from && x.t <= to);
  // Chrome on the Mac (bench/gpu/mac-rss.sh, KiB): the largest renderer, the GPU process.
  const rss = lines(`${dir}/mac.rss`).map((l) => l.split(' ').map(Number)).filter((x) => x[0] * 1000 >= from && x[0] * 1000 <= to);
  const rssMiB = (k: number) => ({ median: Math.round(q(rss.map((x) => x[k]), 0.5) / 1024), max: Math.round(Math.max(...rss.map((x) => x[k])) / 1024) });
  // The vCPU timeline's chunks.
  const tls = readdirSync(dir).filter((f) => /^browse-\d+\.timeline\.json(\.gz)?$/.test(f)).map((f) => stallRuns(JSON.parse(text(`${dir}/${f.replace(/\.gz$/, '')}`)) as Timeline));
  const one = tls.flatMap((t) => t.one), all = tls.flatMap((t) => t.all);
  const covered = (a: number, z: number) => tls.some((t) => t.from <= a && t.to >= z);
  // Firefox's frames on the host's clock: [ms, maxms, frames].
  const off = (b.offsetStartMs + b.offsetEndMs) / 2;
  const frames: [number, number, number][] = b.frames.map((f: number[]) => [f[0] * 1000 - off, f[1], f[2]]);
  // Windows of W s from a start: stalls, frames.
  const W = 30_000;
  const win = (a: number) => {
    const z = a + W;
    const st = one.filter((x) => x.at >= a && x.at < z), sa = all.filter((x) => x.at >= a && x.at < z);
    const fr = frames.filter((x) => x[0] >= a && x[0] < z);
    return { stalls50: st.filter((x) => x.ms >= 50).length, stalls100: st.filter((x) => x.ms >= 100).length, longestStall: Math.max(0, ...st.map((x) => x.ms)), allStalls50: sa.filter((x) => x.ms >= 50).length, longestAll: Math.max(0, ...sa.map((x) => x.ms)), worstFrameMs: Math.max(0, ...fr.map((x) => x[1])), slowSeconds: fr.filter((x) => x[1] > 100).length, fps: fr.length ? r1(fr.reduce((s, x) => s + x[2], 0) / fr.length) : NaN, timeline: covered(a, z) };
  };
  const far = (t: number) => flushAt.every((f) => Math.abs(t - f) > 90_000);
  const base = [] as ReturnType<typeof win>[];
  for (let a = from + 30_000; a + W < to; a += 5000) if (far(a) && far(a + W)) base.push(win(a));
  const baseTl = base.filter((x) => x.timeline);
  const baseline = { windows: base.length, worstFrameMs: { median: q(base.map((x) => x.worstFrameMs), 0.5), p90: q(base.map((x) => x.worstFrameMs), 0.9), max: Math.max(0, ...base.map((x) => x.worstFrameMs)) }, slowSeconds: { median: q(base.map((x) => x.slowSeconds), 0.5), p90: q(base.map((x) => x.slowSeconds), 0.9) }, stalls50: { median: q(baseTl.map((x) => x.stalls50), 0.5), p90: q(baseTl.map((x) => x.stalls50), 0.9) }, longestStall: { median: q(baseTl.map((x) => x.longestStall), 0.5), p90: q(baseTl.map((x) => x.longestStall), 0.9) }, allStalls50: { median: q(baseTl.map((x) => x.allStalls50), 0.5), p90: q(baseTl.map((x) => x.allStalls50), 0.9) } };
  // 5 s bins of MIPS and share.
  const bin = (a: number) => { const s = sec.filter((x) => x.t > a && x.t <= a + 5000); return { mips: s.length ? s.reduce((u, x) => u + x.mips, 0) / s.length : NaN, share: s.length ? s.reduce((u, x) => u + (x.share || 0), 0) / s.length : NaN }; };
  const flushes = flushAt.map((f, i) => {
    const before = sec.filter((x) => x.t > f - 60_000 && x.t <= f - 2000);
    const mipsBefore = before.reduce((u, x) => u + x.mips, 0) / Math.max(1, before.length), shareBefore = before.reduce((u, x) => u + (x.share || 0), 0) / Math.max(1, before.length);
    const bins = Array.from({ length: 24 }, (_, k) => bin(f + k * 5000));
    const back = (ok: (x: { mips: number; share: number }) => boolean) => { const k = bins.findIndex(ok); return k < 0 ? '>120' : k * 5; };
    const visit = (b.visits as { guestS: number; url: string }[]).filter((v) => v.guestS * 1000 - off <= f).at(-1);
    return { n: i + 1, atS: Math.round((f - from) / 1000), page: visit?.url.replace(/.*\/site\//, '').slice(0, 40), mipsBefore: Math.round(mipsBefore), mipsLowest5s: Math.round(Math.min(...bins.map((x) => x.mips))), mipsBackS: back((x) => x.mips >= 0.9 * mipsBefore), shareBefore: +shareBefore.toFixed(3), shareLowest5s: +Math.min(...bins.map((x) => x.share)).toFixed(3), shareBackS: back((x) => x.share >= shareBefore - 0.02), mipsFirst30s: Math.round(bins.slice(0, 6).reduce((u, x) => u + x.mips, 0) / 6), ...win(f - 1000) };
  });
  return {
    session: dir.replace(/.*\//, ''), seconds: b.seconds, visits: b.visits.length, frameSeconds: frames.length,
    wasmMB: Object.fromEntries([[`start`, mbAt(0)] as [string, number]].concat([10, 20, 30, 40, 50, 60, 70, 80, 90].filter((m) => m * 60_000 <= to - from).map((m) => [`${m}min`, mbAt(m * 60_000)] as [string, number]), [['end', mbAt(to - from)]])),
    rateMBperMinLastHalf: r1(rateMBmin), flushesAtS: flushAt.map((f) => Math.round((f - from) / 1000)),
    liveMiB: live.length ? { first: live[0].mb, max: Math.max(...live.map((x) => x.mb)), last: live.at(-1)!.mb } : undefined,
    jit: { flushes: last.jit.flushes, modules: last.jit.modules, compileS: r1(last.jit.compileNs / 1e9), emitS: r1((last.jit.emitNs ?? 0) / 1e9) },
    mips: Math.round(q(sec.map((x) => x.mips), 0.5)), share: +q(sec.map((x) => x.share).filter(Number.isFinite), 0.5).toFixed(3),
    renderer: rss.length ? rssMiB(1) : undefined, gpu: rss.length ? rssMiB(2) : undefined,
    baseline, flushes,
  };
}

const out = process.argv.slice(2).filter((a) => a !== '--json').map(session);
if (json) console.log(JSON.stringify(out, null, 1));
else for (const s of out) {
  const { flushes, baseline, ...rest } = s;
  console.log(JSON.stringify(rest));
  console.log('  baseline', JSON.stringify(baseline));
  for (const f of flushes) console.log('  flush', JSON.stringify(f));
}
