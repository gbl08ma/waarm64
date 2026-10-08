import { readFileSync } from 'node:fs';
const { marks } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const rep = (m) => new Map(m.report.map((h) => [h.op, h.calls]));
const ph = marks.slice(1).map((m, i) => ({ from: marks[i], to: m })).filter((p) => p.to.ms - p.from.ms > 50);
for (const p of ph) {
  const [a, b] = [rep(p.from), rep(p.to)];
  const d = (i) => (b.get(`M:${i}`) ?? 0) - (a.get(`M:${i}`) ?? 0);
  const st = p.to.steps - p.from.steps;
  console.log(`${p.from.name.slice(0,14).padEnd(14)} steps ${(st/1e6).toFixed(0)}M  interp-at-uncompiled ${(d(4)/1e6).toFixed(2)}M  of which at members ${(d(0)/1e6).toFixed(2)}M (${(100*d(0)/st).toFixed(2)}% of steps, ${d(1)} misses)  heads that were members ${d(2)} of ${p.to.stats.jit.blocks-p.from.stats.jit.blocks} regions; members already compiled ${d(3)} of ${p.to.stats.jit.regionBlocks-p.from.stats.jit.regionBlocks} blocks`);
}
