// DIAG: ns per step of each class's loop (classes.S) on the block interpreter (a cache that never compiles) and
// compiled (threshold 0, regions at once), under Liftoff (TIER=liftoff: the tiering budget set past reach before the
// JIT's modules are made) or TurboFan (default: after a warm-up that tiers the loop up). JSON to stdout.
// classes.bin first: clang --target=aarch64-linux-gnu -march=armv8-a -c classes.S -o classes.o && llvm-objcopy -O binary -j .text classes.o classes.bin
import { readFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';
import { coreImports } from '../../../../../web/core.ts';
const WASM = new URL('../../../../../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url);
const code = readFileSync(new URL('classes.bin', import.meta.url));
const SYMS: Record<string, number> = { alu: 0x0, movs: 0x80, flags: 0x100, ldst: 0x180, pairs: 0x200, muls: 0x280, bits: 0x300, fp: 0x380, neon: 0x400, sys: 0x480, short: 0x500, calls: 0x580 };
const N = BigInt(process.env.N ?? 20_000_000), ROUNDS = Number(process.env.ROUNDS ?? 5);
const liftoff = process.env.TIER === 'liftoff';
type Ex = { vcpu_new(): number; mem_new(b: number, s: bigint): number; jit_new(t: number, b: number, c: number, k: number, r: number): number; jit_run_exit(v: number, m: number, n: bigint, e: number): bigint };
const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
const imports = coreImports(memory);
const inst = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM)), imports);
imports.jit.bind(inst);
const ex = inst.exports as unknown as Ex;
const RAM = 0x10000, DATA = 0x8000;
const base = memory.grow(2) * 65536;
new Uint8Array(memory.buffer, base, code.length).set(code);
const mem = ex.mem_new(base, BigInt(RAM));
const exitw = ex.vcpu_new();
function vcpu(threshold: number, pc: number) {
  const v = ex.jit_new(threshold, 1, 16384, 0, 0);
  const c = new BigUint64Array(memory.buffer, v, 144);
  for (let i = 0; i < 31; i++) c[i] = BigInt(i * 3 + 1);
  [c[9], c[10], c[28], c[32]] = [BigInt(DATA), 8n, 1n << 60n, BigInt(pc)];
  c[896 / 8] = 3n << 20n; // CPACR: FPEN
  // V16-V23: normal doubles (1.25, 2.5, …) in both halves.
  for (let k = 16; k < 24; k++) { const f = new Float64Array(memory.buffer, v + 304 + 16 * k, 2); f[0] = f[1] = 1.25 * (k - 15); }
  return v;
}
const time = (v: number, n: bigint) => { const t0 = performance.now(); const done = ex.jit_run_exit(v, mem, n, exitw); const ms = performance.now() - t0; if (done !== n) { const e = new BigUint64Array(memory.buffer, exitw, 2); const c = new BigUint64Array(memory.buffer, v, 34); throw new Error(`stopped after ${done}: exit ${e[0]} ${e[1].toString(16)} pc ${c[32].toString(16)}`); }; return (ms * 1e6) / Number(n); };
const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
const out: Record<string, { interp: number; jit: number; ratio: number }> = {};
// The core's own code tiered up first (the interpreter's loop), on one class.
time(vcpu(0xffffffff, SYMS.alu), 200_000_000n);
if (liftoff) setFlagsFromString('--wasm-tiering-budget=2000000000');
for (const [name, pc] of Object.entries(SYMS)) {
  const [vi, vj] = [vcpu(0xffffffff, pc), vcpu(0, pc)];
  time(vi, N / 4n);
  time(vj, liftoff ? 100_000n : N); // compiled; under TurboFan, tiered up
  const [ti, tj]: number[][] = [[], []];
  for (let r = 0; r < ROUNDS; r++) { ti.push(time(vi, N)); tj.push(time(vj, N)); }
  out[name] = { interp: +med(ti).toFixed(3), jit: +med(tj).toFixed(3), ratio: +(med(ti) / med(tj)).toFixed(2) };
}
console.log(JSON.stringify({ tier: liftoff ? 'liftoff' : 'turbofan', ...out }));
