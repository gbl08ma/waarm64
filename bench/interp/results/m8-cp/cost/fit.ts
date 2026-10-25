// DIAG: least squares of a module's costs against modules (intercept), functions and bytes.
import { readFileSync } from 'node:fs';
const rows = (f: string) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).slice(5); // warm-up out
function lsq(X: number[][], y: number[]) {
  const k = X[0].length, A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  for (let i = 0; i < y.length; i++) for (let a = 0; a < k; a++) { for (let b = 0; b < k; b++) A[a][b] += X[i][a] * X[i][b]; A[a][k] += X[i][a] * y[i]; }
  for (let c = 0; c < k; c++) { for (let r = c + 1; r < k; r++) { const f = A[r][c] / A[c][c]; for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j]; } }
  const x = new Array(k).fill(0);
  for (let r = k - 1; r >= 0; r--) { let s = A[r][k]; for (let j = r + 1; j < k; j++) s -= A[r][j] * x[j]; x[r] = s / A[r][r]; }
  const mean = y.reduce((a, b) => a + b, 0) / y.length;
  const ss = y.reduce((a, v, i) => a + (v - X[i].reduce((s, xv, j) => s + xv * x[j], 0)) ** 2, 0), st = y.reduce((a, v) => a + (v - mean) ** 2, 0);
  return { coef: x.map((v) => +v.toPrecision(3)), r2: +(1 - ss / st).toFixed(3) };
}
for (const w of process.argv.slice(2)) {
  const e = rows(`${w}.eager.jsonl`), l = rows(`${w}.lazy.jsonl`);
  const sum = (r: { [k: string]: number }[], k: string) => r.reduce((a, v) => a + v[k], 0);
  console.log(w, { modules: e.length, fns: sum(e, 'fns'), kb: Math.round(sum(e, 'len') / 1024), words: sum(e, 'words'), bytesPerWord: +(sum(e, 'len') / sum(e, 'words')).toFixed(1), bytesPerFn: Math.round(sum(e, 'len') / sum(e, 'fns')) });
  console.log(' totals ms: emit', Math.round(sum(e, 'emit') / 1e6), 'module(lazy)', Math.round(sum(l, 'us') / 1e3), 'module(eager liftoff)', Math.round(sum(e, 'us') / 1e3));
  console.log(' emit us ~ 1, fns, KB:', lsq(e.map((r) => [1, r.fns, r.len / 1024]), e.map((r) => r.emit / 1e3)));
  console.log(' emit us ~ 1, fns, words:', lsq(e.map((r) => [1, r.fns, r.words]), e.map((r) => r.emit / 1e3)));
  console.log(' lazy us ~ 1, fns, KB:', lsq(l.map((r) => [1, r.fns, r.len / 1024]), l.map((r) => r.us)));
  console.log(' eager us ~ 1, fns, KB:', lsq(e.map((r) => [1, r.fns, r.len / 1024]), e.map((r) => r.us)));
}
