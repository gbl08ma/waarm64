// What coldest-first eviction could free, from a session run with measure.patch (README.md here).
//   node bench/boot/results/m8-evict/evict.ts <outdir>/evict.txt [seconds,...]
// `E` lines (the core's own summary, every ~10 s and at each flush) are printed as they are, in MiB and as a share of
// the live bytes; each flush's `M` dump (every module: bytes, install tick, last-entered tick, regions, imports) is
// recomputed for the thresholds given (default 5,15,30,60,120 s): the bytes cold, those freeable as importer-closed
// sets, and those freeable when imports of targets that were cold when the importer was compiled don't pin (they'd be
// jump-cache links: proposal option A's "cold target" rule), and those freeable if modules imported only within their
// generation (a run of modules by install order of an eighth or a quarter of the live bytes; links across generations
// through the jump cache). "cold" alone is what no pinning at all would free. Ticks are 100 ms.
import { readFileSync } from 'node:fs';

const [file, list] = process.argv.slice(2);
if (!file) throw new Error('usage: node evict.ts <evict.txt> [seconds,...]');
const secs = (list ?? '5,15,30,60,120').split(',').map(Number);
const mib = (b: number) => (b / 2 ** 20).toFixed(1);
const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(0) : '-') + '%';

type Mod = { bytes: number; born: number; used: number; n: number; imports: number[] };
const flushes: { t: number; live: number; mods: Mod[] }[] = [];
let cur: Mod[] | undefined;
let t0: number | undefined;
let curE: { t: number; live: number } | undefined;
console.log('summaries (MiB; cold / freeable / freeable with the cold-target rule, as % of live):');
for (const raw of readFileSync(file, 'utf8').split('\n')) {
  const l = raw.replace(/^\d+ /, ''); // the worker's Date.now()
  if (l.startsWith('E ')) {
    const f = Object.fromEntries(l.split(' ').slice(2).map((kv) => kv.split('=')));
    const live = Number(f.live);
    t0 ??= Number(f.t);
    const cs = Object.entries(f).filter(([k]) => /^c\d+$/.test(k)).map(([k, v]) => {
      const [c, a, b] = String(v).split('/').map(Number);
      return `${k.slice(1)}s ${pct(c, live)}/${pct(a, live)}/${pct(b, live)}`;
    });
    console.log(`${l.split(' ')[1].padEnd(5)} t=${((Number(f.t) - t0) / 10).toFixed(0)}s live ${mib(live)} mods ${f.mods}  ${cs.join('  ')}`);
    if (l.split(' ')[1] === 'flush') curE = { t: Number(f.t), live };
  } else if (l.startsWith('M end')) {
    if (cur && curE) flushes.push({ ...curE, mods: cur });
    cur = undefined;
  } else if (l.startsWith('M ')) {
    const [, , bytes, born, used, n, imports] = l.split(' ');
    (cur ??= []).push({ bytes: +bytes, born: +born, used: +used, n: +n, imports: imports ? imports.split(',').map(Number) : [] });
  }
}
for (const [k, f] of flushes.entries()) {
  const n = f.mods.length;
  const total = f.mods.reduce((a, m) => a + m.bytes, 0);
  // Importers of each module, and whether that import was of a target cold at compile time (encoded as !id).
  const importers: [number, boolean][][] = Array.from({ length: n }, () => []);
  f.mods.forEach((m, i) => m.imports.forEach((t) => (t < 0 ? importers[~t].push([i, true]) : importers[t].push([i, false]))));
  const edges = f.mods.reduce((a, m) => a + m.imports.length, 0);
  const coldEdges = f.mods.reduce((a, m) => a + m.imports.filter((t) => t < 0).length, 0);
  console.log(`\nflush ${k + 1} at ${((f.t - (t0 ?? 0)) / 10).toFixed(0)} s: ${n} modules, ${mib(total)} MiB, ${edges} imports (${coldEdges} of targets cold at compile time)`);
  // Generations: runs of modules by install order of `size` bytes each.
  const gens = (size: number) => { let g = 0, acc = 0; return f.mods.map((m) => { if (acc >= size) { g++; acc = 0; } acc += m.bytes; return g; }); };
  const g8 = gens(total / 8), g4 = gens(total / 4);
  const cross = (g: number[]) => f.mods.reduce((a, m, i) => a + m.imports.filter((t) => g[t < 0 ? ~t : t] !== g[i]).length, 0);
  console.log(`  imports across generations: ${pct(cross(g8), edges)} of them with eighths, ${pct(cross(g4), edges)} with quarters`);
  for (const s of secs) {
    const cold = f.mods.map((m) => f.t - Math.max(m.used, m.born) >= s * 10);
    const within = (g: number[]) => {
      const ok = new Array<boolean>(n).fill(false);
      for (let i = n - 1; i >= 0; i--) ok[i] = cold[i] && importers[i].every(([j]) => g[j] !== g[i] || ok[j]);
      return ok;
    };
    const [w8, w4] = [within(g8), within(g4)];
    const free = [0, 1].map((rule) => {
      const ok = new Array<boolean>(n).fill(false);
      for (let i = n - 1; i >= 0; i--) ok[i] = cold[i] && importers[i].every(([j, c]) => (rule === 1 && c) || ok[j]);
      return ok;
    });
    const sum = (p: (i: number) => boolean) => f.mods.reduce((a, m, i) => a + (p(i) ? m.bytes : 0), 0);
    const [c, a, b] = [sum((i) => cold[i]), sum((i) => free[0][i]), sum((i) => free[1][i])];
    const [e8, e4] = [sum((i) => w8[i]), sum((i) => w4[i])];
    console.log(`  cold ${String(s).padStart(3)} s: ${mib(c).padStart(6)} MiB (${pct(c, total)}), freeable ${mib(a).padStart(6)} (${pct(a, total)}), with the rule ${mib(b).padStart(6)} (${pct(b, total)}), imports within eighths ${pct(e8, total)}, quarters ${pct(e4, total)}`);
  }
}
