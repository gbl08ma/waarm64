/** Linear-interpolated quantile of an unsorted sample. */
export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
}

export function summarize(xs: number[]) {
  return { median: quantile(xs, 0.5), iqr: quantile(xs, 0.75) - quantile(xs, 0.25), n: xs.length };
}

// ---- Paired A/Bs with a stopping rule (bench/ab.ts; docs/benchmarking.md "The paired A/B") ----

/** ln Γ(x), x > 0 (Lanczos, g = 7). */
function lgamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  x -= 1;
  let a = c[0];
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** The regularized incomplete beta function I_x(a, b) (its continued fraction, Lentz's method). */
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x > (a + 1) / (a + b + 2)) return 1 - betai(b, a, 1 - x);
  const front = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x)) / a;
  const tiny = 1e-300;
  let f = 1, c = 1, d = 0;
  for (let i = 0; i <= 300; i++) {
    const m = i >> 1;
    const num = i === 0 ? 1 : i % 2 === 0 ? (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m)) : -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + num * d;
    d = 1 / (Math.abs(d) < tiny ? tiny : d);
    c = 1 + num / c;
    if (Math.abs(c) < tiny) c = tiny;
    f *= c * d;
    if (Math.abs(1 - c * d) < 1e-13) break;
  }
  return front * (f - 1);
}

/** Student's t with `df` degrees of freedom: P(|T| > t). */
export const tTail2 = (t: number, df: number) => betai(df / 2, 0.5, df / (df + t * t));

/** The t whose two-sided tail is `alpha`. */
export function tCrit(alpha: number, df: number): number {
  let lo = 0, hi = 1;
  while (tTail2(hi, df) > alpha) hi *= 2;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (tTail2(mid, df) > alpha) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** A seeded generator of uniform numbers in [0, 1) (mulberry32). */
export function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The tail a t interval takes at each look of a sequence, so that looking after every pair from `min` to `cap`
 * pairs calls a true null a difference with probability `overall` at most (an interval read at 5% after every pair
 * would do so several times as often): the `overall` quantile, over simulated runs of normal noise, of the smallest
 * p-value a run shows at any look. Seeded: the same answer every time.
 */
export function lookAlpha(min: number, cap: number, overall: number, sims = 20_000): number {
  if (cap <= min) return overall;
  const u = rng(12345);
  const smallest: number[] = [];
  for (let s = 0; s < sims; s++) {
    let sum = 0, sq = 0, p = 1;
    for (let n = 1; n <= cap; n++) {
      const x = Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
      sum += x;
      sq += x * x;
      if (n < min) continue;
      const v = (sq - (sum * sum) / n) / (n - 1);
      const t = sum / n / Math.sqrt(v / n);
      p = Math.min(p, tTail2(Math.abs(t), n - 1));
    }
    smallest.push(p);
  }
  return quantile(smallest, overall);
}

/** `=`: the interval lies inside ±band; `<` and `>`: it excludes zero (lower, higher); `?`: neither yet. */
export type Call = '=' | '<' | '>' | '?';
export type Paired = { n: number; pct: number; lo: number; hi: number; call: Call };

/**
 * An arm's samples against the base's, pair by pair (the same round of one session): the mean of the ratios' logs as
 * a percentage, its t interval at the tail `alpha` (`lookAlpha`'s under a stopping rule), and what the interval says
 * against a band of ±`band` percent. A band narrower than the interval's half-width can only give `?` or a
 * difference.
 */
export function paired(base: number[], arm: number[], alpha: number, band: number): Paired {
  const d = arm.map((x, i) => Math.log(x / base[i]));
  const n = d.length;
  const mean = d.reduce((a, b) => a + b, 0) / n;
  const pc = (x: number) => (Math.exp(x) - 1) * 100;
  if (n < 2) return { n, pct: pc(mean), lo: -Infinity, hi: Infinity, call: '?' };
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const h = (tCrit(alpha, n - 1) * sd) / Math.sqrt(n);
  const lo = pc(mean - h), hi = pc(mean + h);
  return { n, pct: pc(mean), lo, hi, call: lo > 0 ? '>' : hi < 0 ? '<' : lo > -band && hi < band ? '=' : '?' };
}
