// Ad-hoc: counter-read exits per phase of Alpine's userspace benchmark in Node under the JIT.
// Needs a core built with ../count-exits.patch: exceptions[0x3f] counts EL0 CNTVCT/CNTPCT reads, [0x3e] EL1 ones, [0x3d] the other timer-register exits.
// RT=1: realtime (the page's mode); without it deterministic time (one tick an instruction).
//   [RT=1] node bench/boot/results/m8-cntvct/tools/count.ts
import { readFileSync } from 'node:fs';
import { bootVm, DISTROS, Exit, guestDevices } from '../../../../../web/vm.ts';
const IMAGES = new URL('../../../../../target/images/', import.meta.url);
const wasm = readFileSync(new URL('../../../../../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url));
const a = DISTROS.alpine;
const vm = await bootVm(wasm, { ramSize: 1 << 30, kernel: readFileSync(new URL(a.kernel, IMAGES)), initrd: readFileSync(new URL(a.initrd, IMAGES)), cmdline: a.cmdline, devices: guestDevices(new URL('alpine-user/rootfs-user.ext4', IMAGES).href), jit: 1, realtime: !!process.env.RT });
type M = { name: string; ms: number; steps: number; e: Record<string, number>; disp: number };
const marks: M[] = [];
let out = '', steps = 0, scanned = 0;
const t0 = performance.now();
const mark = (name: string) => { const s = vm.stats() as any; marks.push({ name, ms: performance.now() - t0, steps, e: s.exceptions, disp: s.jit.dispatches }); };
mark('begin');
for (;;) {
  const r = vm.run(1_000_000);
  steps += r.steps;
  out += vm.drain();
  const end = out.lastIndexOf('\n') + 1;
  for (const m of out.slice(scanned, end).matchAll(/webpc: ([^\r\n]*)/g)) mark(m[1]);
  scanned = end;
  if (r.kind === Exit.DEVICE) { await vm.settle(); continue; }
  if (r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL) continue;
  break;
}
mark('power off');
vm.close();
const g = (m: M, k: string) => m.e[k] ?? 0;
const rows = marks.slice(1).map((to, i) => ({ from: marks[i], to })).filter((p) => p.to.ms - p.from.ms > 50);
rows.push({ from: marks[0], to: marks[marks.length - 1] });
for (const { from, to } of rows) {
  const ms = to.ms - from.ms, st = to.steps - from.steps;
  const [el0, el1, oth] = ['0x3f', '0x3e', '0x3d'].map((k) => g(to, k) - g(from, k));
  const name = from === marks[0] && to === marks[marks.length - 1] ? 'TOTAL' : from.name;
  console.log(`${name.padEnd(28)} ${(ms / 1000).toFixed(2).padStart(6)} s ${(st / 1e6).toFixed(0).padStart(6)}M steps  cnt EL0 ${el0} EL1 ${el1} other-timer ${oth}  = ${(((el0 + el1) / ms) * 1000).toFixed(0)}/s, 1 per ${((st / (el0 + el1 || 1)) | 0)} steps; dispatches ${to.disp - from.disp}`);
}
