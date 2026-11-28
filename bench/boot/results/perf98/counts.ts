// PERF loop 98: the idle tallies of diag.patch (web/vcpu-worker.ts `diagIdle`: each idle's outcome, and candidate poll
// rules simulated on them), for the dev VM's or the Mac's Node:
//   node bench/boot/results/perf98/counts.ts idle|pingpong|smp4|smp-user4 [spin µs]   one JSON line: `idle98` summed
// idle: Buildroot's /bin/sleep on 4 vCPUs (as bench/boot/idle-cpu.ts), 20 s after 6; pingpong: the atomics stress's
// (as ../perf83/pingpong.ts); smp4/smp-user4: smp_alpine_jit n4's boot, smp_user_jit_4 (bench/boot/suite.ts).
import { readFileSync } from 'node:fs';
import { bootVm } from '../../../../web/vm.ts';
import { compileCore, Exit } from '../../../../web/core.ts';
import { DISTROS, runToPowerOff, testDevices } from '../../../../web/test-guests.ts';
import { boot } from '../../suite.ts';

const [what, spinArg] = process.argv.slice(2);
const spin = spinArg === undefined ? undefined : Number(spinArg);
const root = new URL('../../../../', import.meta.url);
const IMAGES = new URL('target/images/', root);
const module = await compileCore(readFileSync(new URL(process.env.WASM ?? 'target/wasm32-unknown-unknown/release/waarm64_core.wasm', root)));
const d98 = (s: { jit: unknown }) => (s.jit as { idle98: number[] }).idle98;
const t0 = performance.now();
let w: number[];
let extra: Record<string, unknown> = {};
if (what === 'idle') {
  const kernel = readFileSync(new URL('linux/Image', IMAGES));
  const disk = new URL('buildroot/rootfs.ext4', IMAGES).href;
  const vm = await bootVm(module, { ramSize: 256 << 20, kernel, cmdline: 'console=ttyAMA0 panic=-1 root=/dev/vda ro init=/bin/sleep -- 60', devices: testDevices(disk), realtime: true, jit: 1, ncpus: 4, parallel: true, idleLimitMs: 120_000, vcpuSpinUs: spin });
  let a: number[] | undefined;
  let ta = 0;
  for (;;) {
    const r = await vm.runAsync(1_000_000);
    vm.drain();
    const t = performance.now() - t0;
    if (!a && t >= 6000) [a, ta] = [d98(vm.stats()), t];
    if (a && t >= 26000) {
      w = d98(vm.stats()).map((x, k) => x - a![k]);
      extra = { secs: (t - ta) / 1000 };
      break;
    }
    if (r.kind === Exit.DEVICE) await vm.settle();
    if (r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL || r.kind === Exit.DEVICE || r.kind === Exit.IDLE) continue;
    throw new Error(`exit ${r.kind}`);
  }
  vm.close();
} else if (what === 'pingpong') {
  const kernel = readFileSync(new URL('linux/Image', IMAGES));
  const initrd = readFileSync(new URL('litmus/initramfs.cpio', IMAGES));
  const r = await runToPowerOff(module, { ramSize: 256 << 20, kernel, initrd, cmdline: `console=ttyAMA0 panic=-1 waarm64.stress=-n,320000,pingpong`, ncpus: 4, parallel: true, realtime: true, jit: 1, idleLimitMs: 30_000, vcpuSpinUs: spin }, 1e12, undefined, undefined, 120_000);
  const took = [...r.console.matchAll(/stress: pingpong took ([\d.]+) s/g)].map((m) => Number(m[1]));
  if (!/stress: pingpong ok/.test(r.console) || took.length !== 2) throw new Error(r.console.slice(-2000));
  w = d98(r.stats);
  extra = { lseS: took[0], llscS: took[1], secs: r.ms / 1000 };
} else {
  const dd = DISTROS.alpine;
  const user = what === 'smp-user4';
  const disk = new URL(user ? 'alpine-user/rootfs-user.ext4' : dd.disk, IMAGES).href;
  const img = { kernel: readFileSync(new URL(dd.kernel, IMAGES)), initrd: readFileSync(new URL(dd.initrd, IMAGES)), disk, cmdline: dd.cmdline, ramSize: 1 << 30, test: !user, jit: 1 as const };
  const r = await boot(module, img, undefined, { cmdline: user ? `${dd.cmdline} waarm64.threads=4` : dd.cmdline, ncpus: 4, parallel: true, realtime: true });
  w = d98(r.stats);
  extra = { secs: (performance.now() - t0) / 1000 };
}
console.log(JSON.stringify({ what, spin, ...extra, idle98: w }));
process.exit(0);
