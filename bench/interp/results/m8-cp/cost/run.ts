// DIAG: Alpine (boot, or userspace with USER=1) under the JIT in Node, dumping each module (WEBPC_DUMP).
import { readFileSync } from 'node:fs';
import { DISTROS, guestDevices, testDevices, runToPowerOff } from '../../../../../web/vm.ts';
const IMAGES = new URL('../../../../../target/images/', import.meta.url);
const image = (rel: string) => readFileSync(new URL(rel, IMAGES));
const WASM = readFileSync(process.env.CORE ?? new URL('../../../../../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url));
const a = DISTROS.alpine;
const user = process.env.USER_BENCH === '1';
const t0 = performance.now();
const r = await runToPowerOff(WASM, {
  ramSize: 1 << 30, kernel: image(a.kernel), initrd: image(a.initrd), cmdline: a.cmdline, jit: 1,
  devices: user ? guestDevices(new URL('alpine-user/rootfs-user.ext4', IMAGES).href) : testDevices(new URL(a.disk, IMAGES).href),
  ...(user ? {} : { framebuffer: { width: 640, height: 480 } }),
}, user ? 50e9 : 20e9);
console.log(JSON.stringify({ kind: r.kind, steps: r.steps, ms: Math.round(performance.now() - t0), ok: r.console.includes('webpc: test ok') }));
