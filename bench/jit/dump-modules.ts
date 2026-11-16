// Saves every JIT module a guest run compiles (docs/benchmarking.md "The JIT's machine code, x64 and arm64"), for
// bench/jit/codestats.ts to compile with TurboFan on x64 and arm64. Boots the guest in Node, deterministically, with
// `WebAssembly.Module` wrapped (web/vm.ts untouched): each module the JIT installs (its blocks' and the miss
// functions') goes to <out>/m<nnnnn>.wasm in install order, the core itself not; <out>/index.json says what made them.
// A deterministic run compiles the same modules every time: two cores' sets compare (an A/B's arms).
//   node bench/jit/dump-modules.ts <out> [--wasm core.wasm] [--guest alpine|buildroot]
// alpine: Alpine's boot to power-off as boot_alpine_jit (~2.65G steps, 319 modules on 2026-11-16's core);
// buildroot: Buildroot's boot as boot_jit.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DISTROS, GUEST_CMDLINE, runToPowerOff, testDevices, guestDevices } from '../../web/vm.ts';

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: { wasm: { type: 'string', default: 'target/wasm32-unknown-unknown/release/waarm64_core.wasm' }, guest: { type: 'string', default: 'alpine' } },
});
const out = positionals[0];
if (!out) throw new Error('usage: node bench/jit/dump-modules.ts <out> [--wasm core.wasm] [--guest alpine|buildroot]');
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out).filter((f) => /^m\d+\.wasm$/.test(f))) rmSync(`${out}/${f}`);

let n = 0, bytes = 0;
const Module = WebAssembly.Module;
(WebAssembly as { Module: unknown }).Module = new Proxy(Module, {
  construct(target, args: [BufferSource]) {
    const m = Reflect.construct(target, args) as WebAssembly.Module;
    // Not the core (compiled once, before any JIT module, and exporting the VM's ABI).
    if (!WebAssembly.Module.exports(m).some((e) => e.name === 'vm_new')) {
      const b = args[0];
      const u = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      writeFileSync(`${out}/m${String(n++).padStart(5, '0')}.wasm`, u);
      bytes += u.byteLength;
    }
    return m;
  },
});

const root = new URL('../../', import.meta.url);
const IMAGES = new URL('target/images/', root);
const image = (p: string) => readFileSync(new URL(p, IMAGES));
const wasm = readFileSync(new URL(a.wasm!, root));
const o = a.guest === 'alpine'
  ? { ramSize: 1 << 30, kernel: image(DISTROS.alpine.kernel), initrd: image(DISTROS.alpine.initrd), cmdline: DISTROS.alpine.cmdline, devices: testDevices(new URL(DISTROS.alpine.disk, IMAGES).href), framebuffer: { width: 640, height: 480 } }
  : a.guest === 'buildroot'
    ? { ramSize: 256 << 20, kernel: image('linux/Image'), cmdline: GUEST_CMDLINE, devices: guestDevices(new URL('buildroot/rootfs.ext4', IMAGES).href) }
    : (() => { throw new Error(`--guest ${a.guest}: alpine or buildroot`); })();
const r = await runToPowerOff(wasm, { ...o, jit: 1 });
const index = { date: new Date().toISOString(), node: process.version, guest: a.guest, wasm: a.wasm, wasmSha256: createHash('sha256').update(wasm).digest('hex'), steps: r.steps, modules: n, bytes };
writeFileSync(`${out}/index.json`, JSON.stringify(index, null, 1));
console.log(`${a.guest}: ${r.steps} steps, ${n} modules (${(bytes / 1e6).toFixed(1)} MB) in ${out}`);
