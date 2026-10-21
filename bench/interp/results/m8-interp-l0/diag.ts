// Sums the last `webpc-slow diag` dump of each table in a file (text or results.json) and prints the mix.
//   node diag.ts <file> [top]
import { readFileSync } from 'node:fs';
const [file, topArg = '40'] = process.argv.slice(2);
const top = Number(topArg);
let text = readFileSync(file, 'utf8');
let lines: string[];
if (file.endsWith('.json')) lines = (JSON.parse(text).slow as string[]).filter((l) => l.startsWith('diag ')).map((l) => `webpc-slow ${l}`);
else lines = text.split('\n').filter((l) => l.startsWith('webpc-slow diag '));
const last = new Map<string, string>();
for (const l of lines) last.set(l.split(' ')[2], l);
const sum = new Map<string, Map<string, number>>();
const head: Record<string, number> = {};
for (const l of last.values()) {
  const f = l.split(' ');
  for (let i = 3; i + 1 < f.length && !f[i].includes(':'); i += 2) head[f[i]] = (head[f[i]] ?? 0) + Number(f[i + 1]);
  for (const t of f) {
    const m = /^([A-Z]+):(.*)=(\d+)$/.exec(t);
    if (!m) continue;
    const g = sum.get(m[1]) ?? new Map();
    g.set(m[2], (g.get(m[2]) ?? 0) + Number(m[3]));
    sum.set(m[1], g);
  }
}
console.log(`tables ${last.size}`, head);
const tot = { S: head.insns_s, D: head.insns_d };
for (const [tag, title] of [['D', 'dynamic mix'], ['S', 'static mix'], ['DP', 'dynamic pairs'], ['SP', 'static pairs'], ['DT', 'dynamic triples'], ['ST', 'static triples']]) {
  const g = [...(sum.get(tag) ?? new Map()).entries()].sort((a, b) => b[1] - a[1]);
  const t = tag.startsWith('D') ? tot.D : tot.S;
  console.log(`\n== ${title}`);
  let cum = 0;
  for (const [k, n] of g.slice(0, top)) {
    cum += n;
    console.log(`${((100 * n) / t).toFixed(2).padStart(6)}% ${((100 * cum) / t).toFixed(1).padStart(5)}%  ${k}`);
  }
  if (tag === 'D' || tag === 'S') {
    const gen = g.filter(([k]) => k.endsWith('*'));
    const gs = gen.reduce((s, [, n]) => s + n, 0);
    console.log(`-- generic: ${((100 * gs) / t).toFixed(2)}% of the instructions; by class:`);
    for (const [k, n] of gen.slice(0, 25)) console.log(`${((100 * n) / gs).toFixed(2).padStart(6)}% of generic  ${k}`);
  }
}
