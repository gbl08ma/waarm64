// The paired A/B's stopping rule replayed over measured A/A pairs (bench/boot/REPORT.md "BENCH loop 2"): every
// pair's ratio of two identical arms, from the sessions given, is the noise; a replayed run draws its pairs from
// them (with replacement), shifted by a true difference, and stops as bench/ab.ts does. Per workload and measure:
// how often a run of no difference is called one, and for each true difference how the runs end and after how many
// pairs (the median and the 90th percentile).
//   node bench/boot/results/bench2/replay.ts <session dir>...     (each with an ab.json; arms of the base's core only)
import { readFileSync } from 'node:fs';
import { MEASURES, type Run } from '../../../ab.ts';
import { lookAlpha, quantile, rng, tCrit } from '../../../stats.ts';

const [MIN, CAP, BAND, OVERALL, RUNS] = [4, 24, 0.5, 0.01, 20_000];
const noise = new Map<string, number[]>(); // `${workload} ${measure}` -> the pairs' log ratios
for (const dir of process.argv.slice(2)) {
  const run = JSON.parse(readFileSync(`${dir}/ab.json`, 'utf8')) as Run;
  const base = run.arms[0];
  for (const w of run.opts.workloads) {
    const rows = run.rows.filter((r) => r.workload === w && !r.warm);
    for (const a of run.arms.slice(1)) {
      if (a.coreBytes !== base.coreBytes || a.query !== base.query) continue; // not an A/A arm (by name: the sessions here)
      if (a.name !== 'aa' && !/^a\d$/.test(a.name)) continue;
      for (const r of rows.filter((x) => x.arm === a.name)) {
        const b = rows.find((x) => x.arm === base.name && x.block === r.block);
        if (!b) continue;
        for (const [m, f] of Object.entries(MEASURES)) {
          const [x, y] = [f(b.s), f(r.s)];
          if (x && y) noise.set(`${w} ${m}`, [...(noise.get(`${w} ${m}`) ?? []), Math.log(y / x)]);
        }
      }
    }
  }
}
const alpha = lookAlpha(MIN, CAP, OVERALL);
const crit = Array.from({ length: CAP + 1 }, (_, n) => (n >= MIN ? tCrit(alpha, n - 1) : 0));
const u = rng(2);
console.log(`pairs ${MIN}-${CAP}, band ±${BAND}%, each look's tail ${alpha.toExponential(2)}; ${RUNS} replayed runs a row`);
for (const [key, d] of noise) {
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (d.length - 1));
  console.log(`${key}: ${d.length} A/A pairs, mean ${(mean * 100).toFixed(3)}%, sd ${(sd * 100).toFixed(3)}%`);
  if (!/wall|cycles/.test(key)) continue;
  for (const shift of [0, 0.25, 0.5, 0.75, 1, 2, 4]) {
    const ends = { differs: 0, wrong: 0, same: 0, open: 0 };
    const at: number[] = [];
    for (let r = 0; r < RUNS; r++) {
      let sum = 0, sq = 0, end: keyof typeof ends = 'open', n = 0;
      while (n < CAP && end === 'open') {
        // The measured noise, centred: an A/A's true difference is none.
        const x = (d[Math.floor(u() * d.length)] - mean) * 100 + shift;
        n++;
        sum += x;
        sq += x * x;
        if (n < MIN) continue;
        const m = sum / n;
        const h = crit[n] * Math.sqrt(Math.max(sq - sum * m, 0) / (n - 1) / n);
        if (m - h > 0) end = 'differs';
        else if (m + h < 0) end = 'wrong';
        else if (m - h > -BAND && m + h < BAND) end = 'same';
      }
      ends[end]++;
      at.push(n);
    }
    const p = (x: number) => `${((100 * x) / RUNS).toFixed(1)}%`.padStart(6);
    console.log(`  true ${shift.toFixed(2).padStart(5)}%: higher ${p(ends.differs)}  lower ${p(ends.wrong)}  same ${p(ends.same)}  open at the cap ${p(ends.open)}   pairs: median ${quantile(at, 0.5)}, 90% within ${quantile(at, 0.9)}`);
  }
}
