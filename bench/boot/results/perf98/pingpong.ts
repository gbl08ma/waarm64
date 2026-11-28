// PERF loop 98 (from ../perf83/pingpong.ts): the atomics stress's futex hand-offs (images/litmus/stress.c `pingpong`: two pairs of threads pass a
// token through a mutex and a condition variable, sleeping and waking CPUs) on 4 vCPUs, parallel SMP under the JIT, with
// an idle vCPU's poll stopped after `misses` idles without a catch (`VmOptions.vcpuPollMisses`, 0: always polls).
//   node bench/boot/results/perf98/pingpong.ts <misses>...    one JSON line per run: the guest's "took" for LSE's and LL/SC's
//   (PP_N: the stress's -n, default 320000: n / 16 hand-offs a pair)
import { readFileSync } from 'node:fs';
import { compileCore } from '../../../../web/core.ts';
import { runToPowerOff } from '../../../../web/test-guests.ts';

const root = new URL('../../../../', import.meta.url);
const module = await compileCore(readFileSync(new URL(process.env.WASM ?? 'target/wasm32-unknown-unknown/release/waarm64_core.wasm', root)));
const kernel = readFileSync(new URL('target/images/linux/Image', root));
const initrd = readFileSync(new URL('target/images/litmus/initramfs.cpio', root));
for (const misses of process.argv.slice(2).map(Number)) {
  const t0 = performance.now();
  const r = await runToPowerOff(module, { ramSize: 256 << 20, kernel, initrd, cmdline: `console=ttyAMA0 panic=-1 waarm64.stress=-n,${process.env.PP_N ?? 320000},pingpong`, ncpus: 4, parallel: true, realtime: true, jit: 1, idleLimitMs: 30_000, vcpuPollMisses: misses }, 1e12, undefined, undefined, 120_000);
  const took = [...r.console.matchAll(/stress: pingpong took ([\d.]+) s/g)].map((m) => Number(m[1]));
  if (!/stress: pingpong ok/.test(r.console) || took.length !== 2) throw new Error(r.console.slice(-2000));
  console.log(JSON.stringify({ misses, lseS: took[0], llscS: took[1], wallS: +((performance.now() - t0) / 1000).toFixed(2) }));
}
process.exit(0);
