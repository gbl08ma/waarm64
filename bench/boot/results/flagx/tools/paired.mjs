// EXPERIMENT (lazy NZCV at loop heads): a paired A/B of core builds on bench/interp's small guests under the JIT, in
// one Node process (as bench/interp/paired.ts does for the block interpreter): every arm's guests side by side, a chunk
// each in a shuffled order every iteration; a sample is an arm's MIPS over the first arm's in that iteration.
//   node bench/boot/results/flagx/tools/paired.mjs <iterations> <name>=<core.wasm>... [--json out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { bootVm } from '../../../../../web/vm.ts';
import { setup, JIT_DEFAULT } from '../../../../interp/suite.ts';

const root = new URL('../../../../../', import.meta.url);
const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const json = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : undefined;
const iters = Number(args.shift());
const arms = args.map((a) => a.split('='));
const CHUNK = Number(process.env.CHUNK ?? 20_000_000);
const bin = (f) => readFileSync(new URL(`bench/interp/${f}`, root));

async function vmGuest(core, mmu, file = 'bench/interp/guest-vm.bin') {
  const start = bin('vm-start.bin'), guest = readFileSync(new URL(file, root));
  const kernel = new Uint8Array(0x10000 + guest.length);
  kernel.set(start);
  kernel.set(guest, 0x10000);
  const vm = await bootVm(readFileSync(new URL(core, root)), { ramSize: 16 << 20, kernel, cmdline: '', jit: 1 });
  new BigUint64Array(vm.memory.buffer, vm.cpu + 8, 1)[0] = mmu ? 1n : 0n;
  return (n) => vm.run(n).steps;
}
const GUESTS = {
  user_pad0: async (core) => (await setup('guest.bin', JIT_DEFAULT, 0, true, core)).run,
  user_pad22272: async (core) => (await setup('guest.bin', JIT_DEFAULT, 22272, true, core)).run,
  fp: async (core) => (await setup('guest-fp.bin', JIT_DEFAULT, 0, true, core)).run,
  vm_flat: (core) => vmGuest(core, false),
  vm_mmu: (core) => vmGuest(core, true),
  // The introduction's capture guest: five tight loops (tools/intro-capture/*.c).
  loops: (core) => vmGuest(core, true, 'tools/intro-capture/guest.bin'),
};
const shuffled = (n) => {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const q = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const out = {};
const only = process.env.GUESTS?.split(',');
for (const [g, make] of Object.entries(GUESTS).filter(([g]) => !only || only.includes(g))) {
  const runs = [];
  for (const [, core] of arms) runs.push(await make(core));
  for (let w = 0; w < 4; w++) for (const r of runs) r(CHUNK); // warm: compiled, tiered up
  const pct = arms.map(() => []);
  for (let it = 0; it < iters; it++) {
    const mips = [];
    for (const k of shuffled(arms.length)) {
      const t = performance.now();
      const done = runs[k](CHUNK);
      mips[k] = done / (performance.now() - t) / 1000;
    }
    arms.forEach((_, k) => pct[k].push((100 * mips[k]) / mips[0] - 100));
  }
  out[g] = Object.fromEntries(arms.map(([name], k) => [name, { median: +q(pct[k], 0.5).toFixed(2), q1: +q(pct[k], 0.25).toFixed(2), q3: +q(pct[k], 0.75).toFixed(2), samples: pct[k].map((x) => +x.toFixed(2)) }]));
  console.log(g, arms.map(([name], k) => `${name} ${q(pct[k], 0.5).toFixed(2)}% [${q(pct[k], 0.25).toFixed(2)}, ${q(pct[k], 0.75).toFixed(2)}]`).join('  '));
}
if (json) writeFileSync(json, `${JSON.stringify({ date: new Date().toISOString(), node: process.version, v8: process.versions.v8, arch: process.arch, iters, chunk: CHUNK, arms: Object.fromEntries(arms), guests: out }, null, 1)}\n`);
process.exit(0);
