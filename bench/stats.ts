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
