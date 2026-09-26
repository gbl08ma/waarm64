// JIT vs interpreter on generated encodings (M5 step 4): random words from the
// instruction classes the JIT inlines, each compiled on its own and run for
// one step from several random register states (edge values weighted), on an
// interpreter vCPU and a JIT vCPU; the whole `Cpu` and the exit must match.
// Unallocated and helper-call words compare trivially. `WEBPC_JIT_DIFF=<n>`
// sets the words per class. Needs the wasm build (scripts/ci.sh).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { coreImports } from '../web/vm.ts';

const WASM = new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url);
const WORDS = Number(process.env.WEBPC_JIT_DIFF ?? 4096);
const STATES = 8;
const CPU_BYTES = 1056;
const BRK = 0xd4200000;

type Exports = {
  vcpu_new(): number;
  mem_new(base: number, size: bigint): number;
  interp_run_exit(cpu: number, mem: number, n: bigint, exit: number): bigint;
  jit_new(threshold: number, batch: number, capacity: number, check: number): number;
  jit_run_exit(v: number, mem: number, n: bigint, exit: number): bigint;
  jit_stats(v: number): number;
};

/** Instruction classes: fixed bits (mask, value) over random words. */
const CLASSES: Record<string, [number, number]> = {
  'data processing, immediate': [0x1c000000, 0x10000000], // op0 100x
  'data processing, register': [0x0e000000, 0x0a000000], // op0 x101
  branches: [0x1c000000, 0x14000000], // op0 101x
  // Narrower, for the flag and operand edge cases.
  'add/sub, immediate': [0x1f800000, 0x11000000],
  'add/sub, shifted and extended register': [0x1f000000, 0x0b000000],
  'add/sub with carry': [0x1fe0fc00, 0x1a000000],
};

// xorshift64*, seeded: failures reproduce.
let seed = 0x9e3779b97f4a7c15n;
const M64 = (1n << 64n) - 1n;
function rand64() {
  seed ^= seed >> 12n;
  seed ^= (seed << 25n) & M64;
  seed ^= seed >> 27n;
  return (seed * 0x2545f4914f6cdd1dn) & M64;
}
const rand32 = () => Number(rand64() >> 32n);
const EDGES = [0n, 1n, 2n, 31n, 32n, 63n, 64n, 0x7fn, 0x80n, 0xffffn, 0x7fff_ffffn, 0x8000_0000n, 0xffff_ffffn, 0x1_0000_0000n, 0x7fff_ffff_ffff_ffffn, 0x8000_0000_0000_0000n, M64, M64 - 1n];
function value() {
  const r = rand32() % 4;
  return r === 0 ? rand64() : r === 1 ? rand64() & 0xffff_ffffn : EDGES[rand32() % EDGES.length];
}

/** Two thirds of the words get a random bit window cleared or set: zero and all-ones immediates, XZR/SP. */
function field(w: number) {
  const r = rand32() % 3, lo = rand32() % 27, len = 1 + (rand32() % 12);
  const m = (len >= 32 ? -1 : ((1 << len) - 1) << lo) | 0;
  return r === 0 ? w : r === 1 ? w & ~m : w | m;
}

for (const [name, [mask, bits]] of Object.entries(CLASSES)) test(`JIT vs interpreter: ${name}`, () => {
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const imports = coreImports(memory);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM)), imports);
  imports.jit.bind(instance);
  const ex = instance.exports as unknown as Exports;
  const size = 8 * WORDS + 0x1000;
  const base = memory.grow(Math.ceil(size / 65536)) * 65536;
  const mem = ex.mem_new(base, BigInt(size));
  const interp = ex.vcpu_new();
  const jit = ex.jit_new(0, 1, 16384, 0);
  const [ei, ej] = [ex.vcpu_new(), ex.vcpu_new()]; // exit words
  const words = Array.from({ length: WORDS }, () => ((field(rand32()) & ~mask) | bits) >>> 0);
  const code = new Uint32Array(memory.buffer, base, 2 * WORDS);
  words.forEach((w, k) => code.set([w, BRK], 2 * k));

  const failures: string[] = [];
  for (let k = 0; k < WORDS; k++) {
    for (let s = 0; s < STATES; s++) {
      const [a, b] = [new BigUint64Array(memory.buffer, interp, 34), new BigUint64Array(memory.buffer, jit, 34)];
      for (let r = 0; r < 32; r++) a[r] = value();
      a[32] = BigInt(8 * k); // PC
      a[33] = BigInt(rand32() & 0xf) << 28n; // NZCV
      b.set(a);
      ex.interp_run_exit(interp, mem, 1n, ei);
      ex.jit_run_exit(jit, mem, 1n, ej);
      const ca = new Uint8Array(memory.buffer, interp, CPU_BYTES), cb = new Uint8Array(memory.buffer, jit, CPU_BYTES);
      const d = ca.findIndex((x, i) => x !== cb[i]);
      const [xa, xb] = [new BigUint64Array(memory.buffer, ei, 2), new BigUint64Array(memory.buffer, ej, 2)];
      if (d >= 0 || xa[0] !== xb[0] || xa[1] !== xb[1]) {
        failures.push(`${words[k].toString(16).padStart(8, '0')}: Cpu byte ${d} (${d >= 0 ? `x${d >> 3}` : 'exit'}) differs`);
        break;
      }
    }
  }
  const st = [...new BigUint64Array(memory.buffer, ex.jit_stats(jit), 11)].map(Number);
  console.log(`${name}: ${WORDS} words, ${st[8]} compiled inline, ${st[9]} as helper calls`);
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} of ${WORDS} words differ`);
});
