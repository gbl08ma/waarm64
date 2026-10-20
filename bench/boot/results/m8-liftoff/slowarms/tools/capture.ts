// capture.ts <core.wasm> <outdir>: boots Alpine under the JIT in Node, deterministic, and writes every JIT
// module's bytes to <outdir>/m<n>.wasm; prints the count and total bytes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DISTROS, runToPowerOff, testDevices } from '../../../../../../web/vm.ts';
const [core, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
let n = 0, total = 0;
const M = WebAssembly.Module;
(WebAssembly as { Module: unknown }).Module = function (bytes: Uint8Array) {
  const b = new Uint8Array(bytes as unknown as ArrayBuffer);
  if (b.length < 4 << 20) { writeFileSync(`${out}/m${n}.wasm`, b); total += b.length; }
  n++;
  return new M(bytes as unknown as BufferSource);
} as unknown;
Object.setPrototypeOf(WebAssembly.Module, M);
(WebAssembly.Module as unknown as { prototype: unknown }).prototype = M.prototype;
const IMAGES = new URL('../../../../../../target/images/', import.meta.url);
const image = (rel: string) => readFileSync(new URL(rel, IMAGES));
const a = DISTROS.alpine;
const o = { ramSize: 1 << 30, kernel: image(a.kernel), initrd: image(a.initrd), cmdline: a.cmdline, devices: testDevices(new URL(a.disk, IMAGES).href), framebuffer: { width: 640, height: 480 } };
const r = await runToPowerOff(readFileSync(core), { ...o, jit: 1 }, 20e9);
console.log(`alpine: ${r.steps} steps, ${n} modules, ${total} bytes`);
