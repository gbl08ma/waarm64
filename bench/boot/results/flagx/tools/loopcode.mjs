// EXPERIMENT (lazy NZCV at loop heads): TurboFan's machine code for the introduction's capture guest's loops
// (tools/intro-capture/guest.bin: sum, move, collatz, total, cap) as a given core's JIT emits them: for each snippet,
// every JIT function in its range (the last emitted at each head), its code saved to <outdir>/<snippet>.txt, and the instructions between
// the first target of a backward branch and the last backward branch (the loop, with V8's unrolled copies).
//   node bench/boot/results/flagx/tools/loopcode.mjs <core.wasm> <outdir>
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { bootVm } from '../../../../../web/vm.ts';

const root = new URL('../../../../../', import.meta.url);
const [core, outdir] = process.argv.slice(2);
mkdirSync(outdir, { recursive: true });
const f = (p) => readFileSync(new URL(p, root));
const fns = new Map();
let cur;
for (const l of f('tools/intro-capture/guest.lst').toString().split('\n')) {
  const m = /^([0-9a-f]+) <(.+)>:$/.exec(l);
  if (m) fns.set(m[2], (cur = { start: parseInt(m[1], 16), end: parseInt(m[1], 16) }));
  else if (cur && /^\s*([0-9a-f]+):/.test(l)) cur.end = parseInt(/^\s*([0-9a-f]+):/.exec(l)[1], 16) + 4;
}
const seen = [];
const Real = WebAssembly.Module;
class Tap extends Real {
  constructor(bytes) {
    seen.push(new Uint8Array(ArrayBuffer.isView(bytes) ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes.slice(0)));
    super(bytes);
  }
}
const start = f('bench/interp/vm-start.bin'), guest = f('tools/intro-capture/guest.bin');
const kernel = new Uint8Array(0x10000 + guest.length);
kernel.set(start);
kernel.set(guest, 0x10000);
const vm = await bootVm(new Uint8Array(f(core)), { ramSize: 16 << 20, kernel, cmdline: '', jit: 1 });
new BigUint64Array(vm.memory.buffer, vm.cpu + 8, 1)[0] = 1n;
WebAssembly.Module = Tap;
for (let done = 0; done < 40_000_000; ) done += vm.run(1_000_000).steps;
WebAssembly.Module = Real;
const last = new Map(); // snippet -> code text
seen.forEach((bytes, k) => {
  const path = `${outdir}/module-${k}.wasm`;
  writeFileSync(path, bytes);
  const r = spawnSync(process.execPath, ['--print-wasm-code', '--no-wasm-lazy-compilation', '--no-liftoff', '-e', 'new WebAssembly.Module(require("node:fs").readFileSync(process.argv[1]))', path], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 120_000 });
  if (r.status !== 0) return; // a module that imports another's functions compiles alone all the same; else skipped
  for (const rec of r.stdout.split('--- WebAssembly code ---').slice(1)) {
    const text = rec.split('--- End code ---')[0];
    const va = parseInt(/^name: 0x([0-9a-f]+)_pa/m.exec(text)?.[1] ?? '', 16);
    for (const [name, r] of fns) if (va >= r.start && va < r.end) last.set(`${name}+0x${(va - r.start).toString(16)}`, text);
  }
});
for (const [name, text] of [...last].filter(([n]) => /^(sum|move|collatz|total|cap)\+/.test(n)).sort()) {
  writeFileSync(`${outdir}/${name}.txt`, text);
  const lines = [];
  for (const l of text.split('\n')) {
    const m = /^0x[0-9a-f]+\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(.*)$/.exec(l);
    if (m) lines.push({ at: parseInt(m[1], 16), text: m[3] });
  }
  let lo = Infinity, hi = -1;
  for (const l of lines) {
    const t = /<\+0x([0-9a-f]+)>/.exec(l.text);
    if (t && /^j/.test(l.text) && parseInt(t[1], 16) <= l.at) { lo = Math.min(lo, parseInt(t[1], 16)); hi = Math.max(hi, l.at); }
  }
  const span = lines.filter((l) => l.at >= lo && l.at <= hi && !/^nop/.test(l.text));
  console.log(`${name.padEnd(14)} ${/^name: (.*)$/m.exec(text)[1]}: ${lines.length} instructions, ${span.length} in the loop's span (0x${lo.toString(16)}..0x${hi.toString(16)})`);
}
process.exit(0);
