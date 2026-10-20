// Modules by the regions they hold, from a session of the counting build (count.patch: `jit.hist` in results.json):
// buckets 1, 2, 3-8, 9-32, 33-128, 129-511, 512+ regions; batches emitted full, by BATCH_STEPS, by BATCH_TIMEOUT;
// tier-up modules, and those with the loop region alone.
//   node bench/boot/results/m8-emit/hist.ts <session dir>...
import { readFileSync } from 'node:fs';

const NAMES = ['1', '2', '3-8', '9-32', '33-128', '129-511', '512+', 'full', 'steps', 'timeout', 'tierups', 'tierAlone'];
for (const d of process.argv.slice(2)) {
  const j = JSON.parse(readFileSync(`${d}/results.json`, 'utf8')).jit;
  const h: number[] = j.hist;
  const row = Object.fromEntries(NAMES.map((n, i) => [n, h[i]]));
  const small = h[0] + h[1] + h[2];
  console.log(JSON.stringify({ session: d, modules: j.modules, regions: j.blocks, wasmMB: Math.round(j.bytes / 1e6), perModule: +(j.blocks / j.modules).toFixed(1), small1to8: small, smallShare: +(small / j.modules).toFixed(3), ...row }));
}
