// An idle guest's host CPU (PERF loop 58; docs/benchmarking.md): Buildroot's kernel with /bin/sleep as init, parallel
// SMP on N vCPUs under the JIT, in Node; after `settle` s, the process's CPU time (all threads) over `measure` s of wall
// time as a share of one core, the idle exits a second and the guest's MIPS.
//   node bench/boot/idle-cpu.ts [ncpus] [settle s] [measure s] [spin µs (VmOptions.vcpuSpinUs; default web/idle-wait.ts SPIN_MS)]
import { readFileSync } from 'node:fs';
import { bootVm } from '../../web/vm.ts';
import { compileCore, Exit } from '../../web/core.ts';
import { testDevices } from '../../web/test-guests.ts';

const [ncpus = 4, settle = 6, measure = 20, spin] = process.argv.slice(2).map(Number);
const root = new URL('../../', import.meta.url);
const module = await compileCore(readFileSync(new URL('target/wasm32-unknown-unknown/release/waarm64_core.wasm', root)));
const kernel = readFileSync(new URL('target/images/linux/Image', root));
const disk = new URL('target/images/buildroot/rootfs.ext4', root).href;
const cmdline = `console=ttyAMA0 panic=-1 root=/dev/vda ro init=/bin/sleep -- ${settle + measure + 30}`;
const vm = await bootVm(module, { ramSize: 256 << 20, kernel, cmdline, devices: testDevices(disk), realtime: true, jit: 1, ncpus, parallel: true, idleLimitMs: 120_000, vcpuSpinUs: spin });
const t0 = performance.now();
let a: { t: number; cpu: NodeJS.CpuUsage; idles: number; steps: number } | undefined;
let out = '';
for (;;) {
  const r = await vm.runAsync(1_000_000);
  out += vm.drain();
  const t = performance.now() - t0;
  if (!a && t >= settle * 1000) a = { t, cpu: process.cpuUsage(), idles: vm.stats().par.idles, steps: vm.stats().steps };
  if (a && t >= (settle + measure) * 1000) {
    const cpu = process.cpuUsage(a.cpu);
    const s = vm.stats();
    const wall = (t - a.t) / 1000;
    console.log(JSON.stringify({ ncpus, wallS: +wall.toFixed(2), cpuPct: +((100 * (cpu.user + cpu.system)) / 1e6 / wall).toFixed(2), userPct: +((100 * cpu.user) / 1e6 / wall).toFixed(2), sysPct: +((100 * cpu.system) / 1e6 / wall).toFixed(2), idlesPerS: Math.round((s.par.idles - a.idles) / wall), mipsGuest: +((s.steps - a.steps) / 1e6 / wall).toFixed(2) }));
    break;
  }
  if (r.kind === Exit.DEVICE) await vm.settle();
  if (r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL || r.kind === Exit.DEVICE || r.kind === Exit.IDLE) continue;
  throw new Error(`exit ${r.kind}\n${out}`);
}
vm.close();
process.exit(0);
