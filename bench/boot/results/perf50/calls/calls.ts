// node calls.ts [rounds] [core]: ns per leaf call, a host call (host.bin) against a followed call (follow.bin).
import { setup, JIT_DEFAULT } from '../../../../interp/suite.ts';
const here = new URL('./', import.meta.url).pathname;
const R = Number(process.argv[2] ?? 5), core = process.argv[3];
async function arm(name: string) {
  const g = await setup(here + name + '.bin', JIT_DEFAULT, 0, true, core);
  const t0 = performance.now();
  while (performance.now() - t0 < 1500) g.run(5_000_000);
  const r0 = g.rounds(), t1 = performance.now();
  let steps = 0;
  while (performance.now() - t1 < 3000) steps += g.run(5_000_000);
  const dt = performance.now() - t1, rounds = Number(g.rounds() - r0);
  return { ns: (dt * 1e6) / rounds, steps: steps / rounds };
}
const out: Record<string, number[]> = { follow: [], host: [] };
for (let i = 0; i < R; i++) for (const a of i % 2 ? ['host', 'follow'] : ['follow', 'host']) { const r = await arm(a); out[a].push(r.ns); console.log(a, (r.ns / 1000).toFixed(1), 'us a round,', r.steps.toFixed(0), 'steps'); }
const med = (x: number[]) => [...x].sort((a, b) => a - b)[x.length >> 1];
console.log('median ns per round: follow', med(out.follow).toFixed(0), 'host', med(out.host).toFixed(0), '; per leaf call', ((med(out.host) - med(out.follow)) / 4000).toFixed(2), 'ns');
