// PERF loop 67b: the pages session's latency, per arm (dev-only). Reads bench/gpu/ab-mac.sh's <outdir>/<arm>-<round>/
// (KEEP_TIMELINES=1: pages-all.timeline.json.gz; results.json; jit.jsonl.gz with the compile worker's `cw`) and prints,
// per session and per arm (medians of the sessions):
// - starts / loads: Firefox's starts and the pages' loads, summed (s);
// - churn windows: each page from Firefox's launch to 10 s after its `ready` (the JIT churn of a new large program and
//   a new site): the share of steps run compiled, its worst 100 ms and 1 s windows, the compile worker's busy share;
// - frames: Firefox's longest gap between frames in each second of every page (its `maxms`), p50/p90/p99/max and the
//   seconds with a gap past 50 and 100 ms (stutter as the guest sees it), split into the churn window and the scroll;
// - stalls: 10 ms bins inside one core call that retired nothing, ms a second and the longest (all vCPUs).
//   node bench/boot/results/perf67b/latency.ts [--json] <outdir>
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

type Timeline = { ncpus: number; periodMs: number; fields: string[]; rows: number[] };
const json = process.argv.includes('--json');
const dir = process.argv.filter((a) => a !== '--json')[2];
const read = (p: string) => (existsSync(p) ? readFileSync(p) : existsSync(p + '.gz') ? gunzipSync(readFileSync(p + '.gz')) : undefined);
const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const med = (xs: number[]) => q(xs, 0.5);

function session(d: string) {
  const res = JSON.parse(readFileSync(`${d}/results.json`, 'utf8'));
  const raw = read(`${d}/pages-all.timeline.json`) ?? read(`${d}/churn-all.timeline.json`);
  const t: Timeline | undefined = raw && JSON.parse(raw.toString());
  const cw = (read(`${d}/jit.jsonl`)?.toString() ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { t: number; cw?: { busyMs: number; ready: number; readySumMs: number; readyHist: number[] } });
  // PHASES=churn: its run as one "page" (its start, the whole run as its window; frames of every second past the first 10 as the scroll's).
  if (res.churn) res['page-churn'] = { started: res.churn.started, loadMs: 0, readyAt: res.churn.readyAt, fpsAll: res.churn.fpsAll, end: res.churn.readyAt + res.churn.seconds * 1000 };
  const pages = Object.entries(res).filter(([k]) => k.startsWith('page-')) as [string, { started: number; loadMs: number; readyAt: number; fpsAll: number[][]; end?: number }][];
  // The timeline as per-row sums over the vCPUs.
  const rows: { at: number; steps: number; jit: number; stall: number }[] = [];
  if (t) {
    const w = 1 + t.ncpus * t.fields.length, f = (k: string) => t.fields.indexOf(k);
    const [S, J, IN] = [f('steps'), f('jitSteps'), f('enteredAt')];
    const at = (r: number, c: number, k: number) => t.rows[r * w + 1 + c * t.fields.length + k];
    for (let r = 1; r < t.rows.length / w; r++) {
      let steps = 0, jit = 0, stall = 0;
      const dt = t.rows[r * w] - t.rows[(r - 1) * w];
      for (let c = 0; c < t.ncpus; c++) {
        const ds = at(r, c, S) - at(r - 1, c, S);
        steps += ds;
        jit += at(r, c, J) - at(r - 1, c, J);
        if (at(r, c, IN) !== 0 && at(r, c, IN) === at(r - 1, c, IN) && ds === 0) stall += dt;
      }
      rows.push({ at: t.rows[r * w], steps, jit, stall });
    }
  }
  const share = (a: number, b: number) => {
    let s = 0, j = 0;
    for (const r of rows) if (r.at > a && r.at <= b) { s += r.steps; j += r.jit; }
    return s ? (j / s) * 100 : NaN;
  };
  /** The lowest compiled share of any `win` ms window within [a, b] with at least 1% of the window's median steps. */
  const worst = (a: number, b: number, win: number) => {
    let lo = 100;
    for (let x = a; x + win <= b; x += win / 2) {
      const v = share(x, x + win);
      if (Number.isFinite(v)) lo = Math.min(lo, v);
    }
    return lo;
  };
  const busy = (a: number, b: number) => {
    const xs = cw.filter((x) => x.cw && x.t >= a && x.t <= b);
    if (xs.length < 2) return undefined;
    const x0 = xs[0], x1 = xs[xs.length - 1];
    const hist = x1.cw!.readyHist.map((n, k) => n - x0.cw!.readyHist[k]);
    const quant = (p: number) => { const n = hist.reduce((s, v) => s + v, 0); let c = 0; for (let k = 0; k < hist.length && n; k++) if ((c += hist[k]) >= p * n) return 2 ** k; return 0; };
    // The busiest second.
    let peak = 0;
    for (let i = 1; i < xs.length; i++) peak = Math.max(peak, (xs[i].cw!.busyMs - xs[i - 1].cw!.busyMs) / (xs[i].t - xs[i - 1].t));
    const n = x1.cw!.ready - x0.cw!.ready;
    return { busy: (x1.cw!.busyMs - x0.cw!.busyMs) / (x1.t - x0.t), peak, modules: n, readyMean: (x1.cw!.readySumMs - x0.cw!.readySumMs) / Math.max(1, n), p50: quant(0.5), p99: quant(0.99), over64: hist.slice(7).reduce((s, v) => s + v, 0) };
  };
  const per = pages.map(([name, p]) => {
    const launch = p.readyAt - p.started * 1000, end = p.end ?? p.readyAt + 10_000;
    const gaps = p.fpsAll.map((x) => x[2]);
    const churnGaps = p.fpsAll.filter((x) => x[0] <= 10).map((x) => x[2]);
    const scrollGaps = p.fpsAll.filter((x) => x[0] > 10).map((x) => x[2]);
    const made = name === 'page-churn' ? res.churn.made : undefined;
    return { name, made, started: p.started, loadS: p.loadMs / 1000, share: share(launch, end), worst100: worst(launch, end, 100), worst1s: worst(launch, end, 1000), cw: busy(launch, end), gaps, churnGaps, scrollGaps };
  });
  const allGaps = per.flatMap((p) => p.gaps), churn = per.flatMap((p) => p.churnGaps), scroll = per.flatMap((p) => p.scrollGaps);
  const gapStats = (g: number[]) => ({ p50: q(g, 0.5), p90: q(g, 0.9), p99: q(g, 0.99), max: Math.max(...g), over50: g.filter((x) => x > 50).length, over100: g.filter((x) => x > 100).length, n: g.length });
  const stallMs = rows.reduce((s, r) => s + r.stall, 0), secs = rows.length ? (rows[rows.length - 1].at - rows[0].at) / 1000 : NaN;
  let run = 0, longest = 0; // the longest run of rows with a stalled vCPU, any vCPU (coarse: per-row sum)
  for (const r of rows) { run = r.stall > 0 ? run + (r.at - (rows[rows.indexOf(r) - 1]?.at ?? r.at)) : 0; longest = Math.max(longest, run); }
  return {
    startsS: per.reduce((s, p) => s + p.started, 0), loadsS: per.reduce((s, p) => s + p.loadS, 0),
    share: med(per.map((p) => p.share)), worst100: Math.min(...per.map((p) => p.worst100)), worst1s: med(per.map((p) => p.worst1s)),
    cwBusy: med(per.map((p) => p.cw?.busy ?? NaN)), cwPeak: Math.max(...per.map((p) => p.cw?.peak ?? NaN)), readyMean: med(per.map((p) => p.cw?.readyMean ?? NaN)), readyP99: Math.max(...per.map((p) => p.cw?.p99 ?? NaN)), over64: per.reduce((s, p) => s + (p.cw?.over64 ?? 0), 0),
    gaps: gapStats(allGaps), churnGaps: gapStats(churn), scrollGaps: gapStats(scroll),
    stallMsPerS: stallMs / secs, pages: per.map(({ gaps, churnGaps, scrollGaps, ...x }) => x),
  };
}

const out: Record<string, ReturnType<typeof session>> = {};
for (const d of readdirSync(dir).sort()) if (existsSync(`${dir}/${d}/results.json`)) out[d] = session(`${dir}/${d}`);
if (json) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }
const f = (x: number, k = 1) => (Number.isFinite(x) ? x.toFixed(k) : '-');
console.log('session      starts  loads  share% w1s%  w100%  cw busy peak  ready mean p99 >64  gaps p50/p90/p99/max  >50 >100 | churn p90/max >50 | scroll p90/max >50  stall ms/s');
for (const [k, s] of Object.entries(out))
  console.log(`${k.padEnd(12)} ${f(s.startsS).padStart(6)} ${f(s.loadsS).padStart(6)}  ${f(s.share, 2)} ${f(s.worst1s)} ${f(s.worst100)}  ${f(s.cwBusy * 100)}% ${f(s.cwPeak * 100)}%  ${f(s.readyMean, 2)} ${s.readyP99} ${s.over64}  ${s.gaps.p50}/${s.gaps.p90}/${s.gaps.p99}/${s.gaps.max}  ${s.gaps.over50} ${s.gaps.over100} | ${s.churnGaps.p90}/${s.churnGaps.max} ${s.churnGaps.over50} | ${s.scrollGaps.p90}/${s.scrollGaps.max} ${s.scrollGaps.over50}  ${f(s.stallMsPerS, 2)}`);
