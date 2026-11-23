// PERF loop 59 (bench/boot/REPORT.md), with diag.patch applied: what Cache::install grows (gauge words 8..31) at the end of a gate guest's run.
//   node bench/boot/results/perf59/counts.ts <core.wasm> boot|user|smp-user4
import { readFileSync } from 'node:fs';
import { boot } from '../../suite.ts';
import { compileCore } from '../../../../web/core.ts';
import { DISTROS } from '../../../../web/test-guests.ts';
export const NAMES = ['installs', 'in tier_up', 'that grew', 'grown B', 'max install B', 'max tier_up install B', 'lk tbl grows', 'lk tbl B', 'lk list reallocs', 'lk list B', 'hd tbl grows', 'hd tbl B', 'hd list reallocs', 'hd list B', 'tr tbl grows', 'tr tbl B', 'log reallocs', 'log B', 'links', 'heads filed', 'heads new', 'lk keys max', 'tier_up grown B', 'max one alloc B'];
const [wasm, name] = process.argv.slice(2);
const root = new URL('../../../../', import.meta.url);
const IMAGES = new URL('target/images/', root);
const d = DISTROS.alpine;
const user = name.includes('user');
const ncpus = name.startsWith('smp') ? 4 : 1;
const parallel = name.startsWith('smp');
const disk = new URL(user ? 'alpine-user/rootfs-user.ext4' : d.disk, IMAGES).href;
const img = { kernel: readFileSync(new URL(d.kernel, IMAGES)), initrd: readFileSync(new URL(d.initrd, IMAGES)), disk, cmdline: d.cmdline, ramSize: 1 << 30, test: !user, jit: 1 as const };
const module = await compileCore(readFileSync(wasm));
let vm!: Awaited<ReturnType<typeof import('../../../../web/vm.ts').bootVm>>;
const r = await boot(module, img, (v) => { vm = v; }, { cmdline: parallel && user ? `${d.cmdline} waarm64.threads=${ncpus}` : d.cmdline, ncpus, parallel, realtime: parallel });
const u = vm.hostUse() as unknown as { pr: number[]; heapLive: number; heapPeak: number; jitKeys: number };
console.log(JSON.stringify({ name, steps: r.stats.steps, heapLive: u.heapLive, heapPeak: u.heapPeak, keys: u.jitKeys, pr: Object.fromEntries(NAMES.map((n, i) => [n, u.pr[i]])) }, null, 1));
