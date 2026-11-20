// Ad-hoc: ns per counter-read exit. 2M iterations of a 4-instruction loop around one MRS
// (CNTVCT_EL0: an exit; TPIDR_EL1: inline), bare metal at EL1, realtime, under the JIT.
//   tools/build-micro.sh && node bench/boot/results/m8-cntvct/tools/micro.ts (an unpatched core)
import { readFileSync } from 'node:fs';
import { runToPowerOff } from '../../../../../web/test-guests.ts';
const wasm = readFileSync(new URL('../../../../../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url));
const DIR = new URL('../../../../../target/cntvct/', import.meta.url);
for (const parallel of [false, true]) for (let rep = 0; rep < 5; rep++) for (const reg of ['tpidr_el1', 'cntvct_el0']) {
  const kernel = readFileSync(new URL(reg + ".bin", DIR));
  const r = await runToPowerOff(wasm, { ramSize: 16 << 20, kernel, kernelOffset: 0, cmdline: '', ncpus: 1, parallel, realtime: true, idleLimitMs: 30_000, jit: 1 }, 1e10, () => {});
  console.log(JSON.stringify({ parallel, reg, ms: +r.ms.toFixed(1), steps: r.steps, nsPerIter: +((r.ms * 1e6) / 2e6).toFixed(1) }));
}
