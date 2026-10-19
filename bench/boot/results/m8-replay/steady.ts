// A steady phase with the diagnostic core's forced flushes (diag.patch): per second around each flush, Firefox's frames
// and longest gap, the MIPS and the share run in compiled code (the timeline), and from the tables' `E` lines (summed):
// steps interpreted in blocks the epoch before had compiled (old) and in others (new), dispatches of blocks compiled but
// not installed in that table yet (wait), ms emitting modules (emit) and installing them (inst).
//   node bench/boot/results/m8-replay/steady.ts <session dir> [tag=webgl]
import { readFileSync } from 'node:fs';

type Timeline = { ncpus: number; periodMs: number; fields: string[]; rows: number[] };
const dir = process.argv[2], tag = process.argv[3] ?? 'webgl';
const t = JSON.parse(readFileSync(`${dir}/${tag}.timeline.json`, 'utf8')) as Timeline;
const res = JSON.parse(readFileSync(`${dir}/results.json`, 'utf8')) as Record<string, any>;
const F = t.fields.length, w = 1 + t.ncpus * F, n = t.rows.length / w, f = (k: string) => t.fields.indexOf(k);
const time = (r: number) => t.rows[r * w];
const sum = (r: number, k: number) => { let s = 0; for (let c = 0; c < t.ncpus; c++) s += t.rows[r * w + 1 + c * F + k]; return s; };
const [S, J, FL] = [f('steps'), f('jitSteps'), f('flushes')];
const at = (ms: number) => { let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (time(m) < ms) lo = m + 1; else hi = m; } return lo; };
// E lines: <host ms> E <table> <epoch> <flush ms> old new wait emitNs compileNs steps dispatches
const E = readFileSync(`${dir}/evict.txt`, 'utf8').split('\n').filter((l) => / E /.test(l)).map((l) => l.split(' ').map(Number)).map((x) => ({ at: x[0], id: x[2], v: x.slice(5, 10) }));
const tables = [...new Set(E.map((e) => e.id))];
/** The tables' summed counters at host time `ms` (each table's last line before it). */
const counters = (ms: number) => { const v = [0, 0, 0, 0, 0]; for (const id of tables) { let last: number[] | undefined; for (const e of E) if (e.id === id && e.at <= ms) last = e.v; if (last) last.forEach((x, k) => (v[k] += x)); } return v; };
const rec = res[tag];
const frames = new Map<number, [number, number]>();
for (const [s, fr, mx] of rec.fpsAll ?? []) frames.set(Math.round(rec.readyAt / 1000) + s, [fr, mx]);
const quiet = process.argv.includes('--summary');
process.on('exit', () => { if (quiet) console.log(JSON.stringify({ dir, tag, jit: res.jit ?? null, flushes: summary })); });
const summary: Record<string, number>[] = [];
for (let r = 1; r < n; r++) {
  if (sum(r, FL) === sum(r - 1, FL)) continue;
  const ft = time(r);
  {
    // Per flush: the slow phase (seconds until the compiled share is back within 2 points of the 4 s before, two
    // seconds running), Firefox's frames a second before (−4..−1) and after (0..9), the seconds after with a gap ≥ 250 ms.
    const sec = (k: number) => { const ra = at(ft + k * 1000), rb = at(ft + k * 1000 + 1000); const ds = sum(rb, S) - sum(ra, S); return rb > ra ? { mips: ds / ((time(rb) - time(ra)) * 1e3), share: ds ? (sum(rb, J) - sum(ra, J)) / ds : 1, fr: frames.get(Math.round((ft + k * 1000 + 1000) / 1000)) } : undefined; };
    const pre = [-4, -3, -2].map(sec).filter((x) => x) as { share: number; mips: number }[];
    const base = pre.map((x) => x.share).sort()[pre.length >> 1] ?? 1;
    const post = Array.from({ length: 30 }, (_, k) => sec(k));
    if (post.every((x) => x)) {
      let slow = post.findIndex((x, k) => x!.share >= base - 0.02 && (post[k + 1]?.share ?? 1) >= base - 0.02);
      if (slow < 0) slow = 30;
      const fb = [-4, -3, -2, -1].map((k) => sec(k)?.fr?.[0]).filter((x) => x !== undefined) as number[];
      const fa = post.slice(0, 10).map((x) => x!.fr).filter((x) => x) as [number, number][];
      summary.push({ atS: Math.round((ft - time(0)) / 1000), slowS: slow, fpsBefore: fb.length ? +(fb.reduce((a, b) => a + b, 0) / fb.length).toFixed(1) : NaN, fpsAfter10: fa.length ? +(fa.reduce((a, b) => a + b[0], 0) / fa.length).toFixed(1) : NaN, fpsMin: fa.length ? Math.min(...fa.map((x) => x[0])) : NaN, gaps250: fa.filter((x) => x[1] >= 250).length, framesSeconds: fa.length, mips0to2: Math.round((post[0]!.mips + post[1]!.mips) / 2), mipsBefore: Math.round(pre.reduce((a, x) => a + x.mips, 0) / pre.length) });
    }
  }
  if (quiet) continue;
  console.log(`flush at ${((ft - time(0)) / 1000).toFixed(1)} s of the phase`);
  console.log('   s  frames maxms   MIPS  jit%    old    new   wait  emit  inst (M steps, K dispatches, ms)');
  for (let k = -4; k <= 20; k++) {
    const a = ft + k * 1000, b = a + 1000, ra = at(a), rb = at(b);
    if (rb <= ra) break;
    const ds = sum(rb, S) - sum(ra, S), dj = sum(rb, J) - sum(ra, J);
    const ca = counters(a), cb = counters(b), d = cb.map((x, i) => x - ca[i]);
    const fr = frames.get(Math.round(b / 1000));
    console.log(`${String(k).padStart(4)} ${String(fr?.[0] ?? '').padStart(7)} ${String(fr?.[1] ?? '').padStart(5)} ${(ds / ((time(rb) - time(ra)) * 1e3)).toFixed(0).padStart(6)} ${(ds ? (100 * dj) / ds : 100).toFixed(1).padStart(5)} ${(d[0] / 1e6).toFixed(1).padStart(6)} ${(d[1] / 1e6).toFixed(1).padStart(6)} ${(d[2] / 1e3).toFixed(1).padStart(6)} ${(d[3] / 1e6).toFixed(0).padStart(5)} ${(d[4] / 1e6).toFixed(0).padStart(5)}`);
  }
}
