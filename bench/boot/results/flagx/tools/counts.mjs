// EXPERIMENT (lazy NZCV at loop heads): the diagnostic core's two tallies of region edges that stored NZCV
// (core/src/tally.rs FLAG_COLD, FLAG_HOT, from flag-counts.patch) beside back-edges and forward edges, per 1000 steps,
// on bench/interp's EL1 guest (MMU off and on), in Node.
//   CARGO_TARGET_DIR=target/diag scripts/build-wasm.sh --features diag
//   node bench/boot/results/flagx/tools/counts.mjs [core.wasm]
import { readFileSync } from 'node:fs';
import { bootVm } from '../../../../../web/vm.ts';
import { Counter } from '../../../../../web/counters.ts';

const root = new URL('../../../../../', import.meta.url);
const wasm = readFileSync(new URL(process.argv[2] ?? 'target/diag/wasm32-unknown-unknown/release/waarm64_core.wasm', root));
const bin = (f) => readFileSync(new URL(`bench/interp/${f}`, root));
for (const mmu of [false, true]) {
  const start = bin('vm-start.bin'), guest = bin('guest-vm.bin');
  const kernel = new Uint8Array(0x10000 + guest.length);
  kernel.set(start);
  kernel.set(guest, 0x10000);
  const vm = await bootVm(wasm, { ramSize: 16 << 20, kernel, cmdline: '', jit: 1 });
  new BigUint64Array(vm.memory.buffer, vm.cpu + 8, 1)[0] = mmu ? 1n : 0n;
  const read = () => Array.from(new BigUint64Array(vm.memory.buffer, vm.counterBlocks[0] + Counter.LEN * 8, 16), Number);
  for (let i = 0; i < 10; i++) vm.run(20_000_000);
  const a = read(), s0 = vm.stats().steps;
  for (let i = 0; i < 10; i++) vm.run(20_000_000);
  const b = read(), steps = vm.stats().steps - s0;
  const per = (i) => ((1000 * (b[i] - a[i])) / steps).toFixed(2);
  console.log(`guest-vm MMU ${mmu ? 'on' : 'off'}, per 1000 steps (warm, ${steps} steps): back-edges ${per(0)}, forward edges ${per(1)}, edges that stored NZCV for a cold path only ${per(14)}, for something else ${per(15)}`);
}
process.exit(0);
