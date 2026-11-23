// PERF loop 61: kvm-unit-tests `timer` under the interpreter and the JIT, alternated, in Node (deterministic, 1 vCPU).
// node bench/boot/results/perf61/kut-timer.ts [rounds] [out.json], under a memory cap (CLAUDE.md).
import { readFileSync, writeFileSync } from 'node:fs';
import { runToPowerOff } from '../../../../web/test-guests.ts';

const WASM = new WebAssembly.Module(readFileSync(new URL('../../../../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url)));
const kernel = readFileSync(new URL('../../../../target/images/kvm-unit-tests/timer.flat', import.meta.url));
const rounds = Number(process.argv[2] ?? 3);
const out = process.argv[3];
const res: { mode: string; round: number; ms: number; steps: number; status: boolean }[] = [];
for (let i = 0; i < rounds; i++) {
  const order = i % 2 ? [1, 0] : [0, 1];
  for (const jit of order) {
    const r = await runToPowerOff(WASM, { ramSize: 256 << 20, kernel, cmdline: '', jit: jit as 0 | 1 }, 5e9);
    const ok = r.console.includes('EXIT: STATUS=1');
    res.push({ mode: jit ? 'jit' : 'interp', round: i, ms: r.ms, steps: r.steps, status: ok });
    console.log(`${jit ? 'jit   ' : 'interp'} round ${i}: ${r.ms.toFixed(0)} ms, ${r.steps} steps, ${ok ? 'pass' : 'FAIL'}`);
  }
}
const med = (m: string) => { const a = res.filter((r) => r.mode === m).map((r) => r.ms).sort((x, y) => x - y); return a[a.length >> 1]; };
console.log(`median interp ${med('interp').toFixed(0)} ms, jit ${med('jit').toFixed(0)} ms`);
if (out) writeFileSync(out, JSON.stringify({ node: process.version, rounds, res }, null, 1));
