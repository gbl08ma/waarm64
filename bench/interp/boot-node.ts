// A boot in Node for profiling the block interpreter (M8-INTERP loop 0): Buildroot or Alpine to
// power-off under `VmConfig.jit` 4 (the dispatcher never compiling) or another mode; prints the
// steps, the time and the MIPS. For `perf` with V8's `--perf-prof` (docs/benchmarking.md "Profiling"):
//   [WASM=core.wasm] node [--perf-prof] bench/interp/boot-node.ts [buildroot|alpine] [jit]
import { readFileSync } from 'node:fs';
import { DISTROS, GUEST_CMDLINE, guestDevices, runToPowerOff, testDevices } from '../../web/test-guests.ts';

const [guest = 'buildroot', mode = '4'] = process.argv.slice(2);
const IMAGES = new URL('../../target/images/', import.meta.url);
const image = (p: string) => readFileSync(new URL(p, IMAGES));
const wasm = readFileSync(process.env.WASM ?? new URL('../../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url));
const jit = Number(mode) as 0 | 1 | 4;
const a = DISTROS.alpine;
const o = guest === 'alpine'
  ? { ramSize: 1 << 30, kernel: image(a.kernel), initrd: image(a.initrd), cmdline: a.cmdline, devices: testDevices(new URL(a.disk, IMAGES).href), framebuffer: { width: 640, height: 480 }, jit }
  : { ramSize: 256 << 20, kernel: image('linux/Image'), cmdline: GUEST_CMDLINE, devices: guestDevices(new URL('buildroot/rootfs.ext4', IMAGES).href), jit };
const t = performance.now();
const r = await runToPowerOff(wasm, o);
const ms = performance.now() - t;
if (!/waarm64: test (exit 0|ok)/.test(r.console)) console.log(r.console.slice(-3000));
console.log(`${guest} jit ${jit}: ${r.steps} steps in ${ms.toFixed(0)} ms, ${(r.steps / ms / 1000).toFixed(1)} MIPS`);
if (process.env.STATS) console.log(JSON.stringify(r.stats));
