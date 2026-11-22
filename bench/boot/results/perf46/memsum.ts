// PERF loop 46: the diag core's module samples over a pages session's mem.jsonl (bench/boot/REPORT.md "PERF loop 46").
//   node bench/boot/results/perf46/memsum.ts <session dir>...
import { readFileSync } from 'node:fs';
for (const dir of process.argv.slice(2)) {
  const rows = readFileSync(`${dir}/mem.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.diag && r.diag['last:mods'] !== undefined);
  const mb = (x: number) => (x / 2 ** 20).toFixed(1);
  console.log(`== ${dir}: ${rows.length} samples`);
  for (const r of rows) {
    const d = r.diag, g = (n: string) => d[`last:${n}`] ?? 0;
    console.log(`t ${((r.t - rows[0].t) / 1000).toFixed(0).padStart(4)} s  mods ${g('mods')} ${mb(g('bytes'))} MiB fns ${g('fns')} unnamed ${g('unnamed')}  allUnnamed ${g('fullMods')} ${mb(g('fullBytes'))} MiB (free ${g('freeMods')} ${mb(g('freeBytes'))}, imported ${g('impMods')} ${mb(g('impBytes'))})  partly ${g('partMods')} ${mb(g('partBytes'))} MiB dead ${mb(g('partDeadBytes'))} (invalidated ${mb(g('partInvalBytes'))}), tiered heads ${g('tiered')}  flushes ${d.flushes}`);
  }
  const d = rows.at(-1).diag;
  console.log('max:', Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith('max:')).map(([k, v]) => [k.slice(4), v])));
  console.log('flush:', Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith('flush:')).map(([k, v]) => [k.slice(6), v])));
}
