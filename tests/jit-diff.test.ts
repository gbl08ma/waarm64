// JIT vs interpreter on generated encodings (M5 steps 4–5): random words from
// the instruction classes the JIT inlines, each compiled on its own and run for
// one step from several random register states (edge values weighted; for
// loads and stores, mostly addresses in and around a data area), on an
// interpreter vCPU and a JIT vCPU with separate copies of RAM; the whole
// `Cpu`, the exit and the data must match. Unallocated and helper-call words
// compare trivially. `WEBPC_JIT_DIFF=<n>` sets the words per class. Flat bus
// only (the MMU path is covered by lockstep and the boots). Needs the wasm
// build (scripts/ci.sh).
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
  jit_flush(v: number): void;
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
  'logical, immediate': [0x1f800000, 0x12000000],
  'logical, shifted register': [0x1f000000, 0x0a000000],
  'bitfield, 64-bit': [0x9fc00000, 0x93400000],
  'bitfield, 32-bit': [0x9fe08000, 0x13000000], // immr, imms < 32
  'extract, 64-bit': [0xffe00000, 0x93c00000],
  'extract, 32-bit': [0xffe08000, 0x13800000],
  'variable shifts': [0x5fe0f000, 0x1ac02000],
  'conditional select': [0x3fe00800, 0x1a800000],
  'conditional compare': [0x3fe00410, 0x3a400000],
  'conditional branch': [0xff000010, 0x54000000],
  'compare and branch': [0x7e000000, 0x34000000],
  'test and branch': [0x7e000000, 0x36000000],
  'branch to register': [0xff9ffc1f, 0xd61f0000],
  'multiply-add': [0x7fe00000, 0x1b000000],
  'multiply-add long': [0xff600000, 0x9b200000],
  'multiply high': [0xff608000, 0x9b400000],
  'divide': [0x7fe0f800, 0x1ac00800],
  'bit and byte reversal, CLZ, CLS': [0x7fffe000, 0x5ac00000],
  hints: [0xfffff01f, 0xd503201f],
};
/** Load/store classes: registers are mostly addresses around the data area. */
const MEMORY: Record<string, [number, number]> = {
  'load/store, unsigned offset': [0x3f000000, 0x39000000],
  'load/store, unscaled, pre/post-index, register offset': [0x3f000000, 0x38000000],
  'load/store pair': [0x3e000000, 0x28000000],
  'load literal': [0x3f000000, 0x18000000],
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
function value(mem: boolean) {
  if (mem && rand32() % 4 !== 0) return BigInt(DATA - 64 + (rand32() % (DATA_SIZE + 128))); // in RAM, or just past either end
  const r = rand32() % 4;
  return r === 0 ? rand64() : r === 1 ? rand64() & 0xffff_ffffn : EDGES[rand32() % EDGES.length];
}

/** Two thirds of the words get a random bit window cleared or set: zero and all-ones immediates, XZR/SP. */
function field(w: number) {
  const r = rand32() % 3, lo = rand32() % 27, len = 1 + (rand32() % 12);
  const m = (len >= 32 ? -1 : ((1 << len) - 1) << lo) | 0;
  return r === 0 ? w : r === 1 ? w & ~m : w | m;
}

// Each RAM: the words (with a brk after each), a gap, then the data area,
// which ends the RAM (accesses past it are external aborts).
const DATA = 8 * WORDS + 0x1000;
const DATA_SIZE = 0x2000;
const RAM = DATA + DATA_SIZE;

for (const [name, [mask, bits], mem] of [
  ...Object.entries(CLASSES).map(([n, c]) => [n, c, false] as const),
  ...Object.entries(MEMORY).map(([n, c]) => [n, c, true] as const),
]) test(`JIT vs interpreter: ${name}`, () => {
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const imports = coreImports(memory);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM)), imports);
  imports.jit.bind(instance);
  const ex = instance.exports as unknown as Exports;
  const base = memory.grow(Math.ceil((2 * RAM + 16) / 65536)) * 65536;
  const [ra, rb] = [base, base + RAM + ((16 - (RAM % 16)) % 16)];
  const [ma, mb] = [ex.mem_new(ra, BigInt(RAM)), ex.mem_new(rb, BigInt(RAM))];
  const interp = ex.vcpu_new();
  const jit = ex.jit_new(0, 1, 16384, 0);
  const [ei, ej] = [ex.vcpu_new(), ex.vcpu_new()]; // exit words
  const words = Array.from({ length: WORDS }, () => ((field(rand32()) & ~mask) | bits) >>> 0);
  const [a8, b8] = [new Uint8Array(memory.buffer, ra, RAM), new Uint8Array(memory.buffer, rb, RAM)];
  // Stores only reach the gap and the data area (the addresses registers hold).
  const [a32, b32] = [new Uint32Array(memory.buffer, ra + 8 * WORDS, (RAM - 8 * WORDS) / 4), new Uint32Array(memory.buffer, rb + 8 * WORDS, (RAM - 8 * WORDS) / 4)];
  const ramDiff = () => {
    for (let i = 0; i < a32.length; i++) if (a32[i] !== b32[i]) return 8 * WORDS + 4 * i;
    return -1;
  };
  const [ca32, cb32] = [new Uint32Array(memory.buffer, ra, 2 * WORDS), new Uint32Array(memory.buffer, rb, 2 * WORDS)];
  words.forEach((w, k) => ca32.set([w, BRK], 2 * k));
  for (let k = DATA; k < RAM; k++) a8[k] = rand32() & 0xff;
  b8.set(a8);

  const failures: string[] = [];
  for (let k = 0; k < WORDS; k++) {
    for (let s = 0; s < STATES; s++) {
      // A store may have hit this word (a small base plus a large offset):
      // restore it, and drop its block (the guest would need an IC).
      if (ca32[2 * k] !== words[k] || cb32[2 * k] !== words[k] || ca32[2 * k + 1] !== BRK || cb32[2 * k + 1] !== BRK) {
        ca32.set([words[k], BRK], 2 * k);
        cb32.set([words[k], BRK], 2 * k);
        ex.jit_flush(jit);
      }
      const [a, b] = [new BigUint64Array(memory.buffer, interp, 34), new BigUint64Array(memory.buffer, jit, 34)];
      for (let r = 0; r < 32; r++) a[r] = value(mem);
      a[32] = BigInt(8 * k); // PC
      a[33] = BigInt(rand32() & 0xf) << 28n; // NZCV
      b.set(a);
      ex.interp_run_exit(interp, ma, 1n, ei);
      ex.jit_run_exit(jit, mb, 1n, ej);
      const ca = new Uint8Array(memory.buffer, interp, CPU_BYTES), cb = new Uint8Array(memory.buffer, jit, CPU_BYTES);
      const d = ca.findIndex((x, i) => x !== cb[i]);
      const [xa, xb] = [new BigUint64Array(memory.buffer, ei, 2), new BigUint64Array(memory.buffer, ej, 2)];
      const m = mem ? ramDiff() : -1;
      if (d >= 0 || m >= 0 || xa[0] !== xb[0] || xa[1] !== xb[1]) {
        const what = d >= 0 ? `Cpu byte ${d} (x${d >> 3})` : m >= 0 ? `RAM byte ${m}` : `the exit (${xa[0]}, 0x${xa[1].toString(16)} vs ${xb[0]}, 0x${xb[1].toString(16)})`;
        failures.push(`${words[k].toString(16).padStart(8, '0')}: ${what} differs`);
        b8.set(a8);
        break;
      }
    }
  }
  const st = [...new BigUint64Array(memory.buffer, ex.jit_stats(jit), 11)].map(Number);
  console.log(`${name}: ${WORDS} words, ${st[8]} compiled inline, ${st[9]} as helper calls`);
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} of ${WORDS} words differ`);
});
