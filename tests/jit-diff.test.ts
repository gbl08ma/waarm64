// JIT vs interpreter on generated encodings (M5 steps 4–6): random words from
// the instruction classes the JIT inlines, each compiled on its own and run for
// one step from several random register states (edge values weighted; for
// loads and stores, mostly addresses in and around a data area), on an
// interpreter vCPU and a JIT vCPU with separate copies of RAM; the whole
// `Cpu`, the exit and the data must match. Unallocated and helper-call words
// compare trivially. Then sequences (step 6): blocks of 2–16 such words on few
// registers, mixed with flag readers and words that force helper calls, run
// for their length, so stale register locals, missing write-backs and wrong
// flag liveness show. `WEBPC_JIT_DIFF=<n>` sets the words per class (and a
// quarter as many sequences). Flat bus only (the MMU path is covered by
// lockstep and the boots). Needs the wasm build (scripts/ci.sh).
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
function value(mem: boolean, data: number) {
  if (mem && rand32() % 4 !== 0) return BigInt(data - 64 + (rand32() % (DATA_SIZE + 128))); // in RAM, or just past either end
  const r = rand32() % 4;
  return r === 0 ? rand64() : r === 1 ? rand64() & 0xffff_ffffn : EDGES[rand32() % EDGES.length];
}

/** Two thirds of the words get a random bit window cleared or set: zero and all-ones immediates, XZR/SP. */
function field(w: number) {
  const r = rand32() % 3, lo = rand32() % 27, len = 1 + (rand32() % 12);
  const m = (len >= 32 ? -1 : ((1 << len) - 1) << lo) | 0;
  return r === 0 ? w : r === 1 ? w & ~m : w | m;
}

const DATA_SIZE = 0x2000;

/** Two vCPUs (interpreter, JIT) on two copies of a RAM that holds `code` bytes
 * of code, a gap, then the data area, which ends the RAM (accesses past it are
 * external aborts). */
function setup(code: number) {
  const DATA = code + 0x1000;
  const RAM = DATA + DATA_SIZE;
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
  const [a8, b8] = [new Uint8Array(memory.buffer, ra, RAM), new Uint8Array(memory.buffer, rb, RAM)];
  // Stores only reach the gap and the data area (the addresses registers hold).
  const [a32, b32] = [new Uint32Array(memory.buffer, ra + code, (RAM - code) / 4), new Uint32Array(memory.buffer, rb + code, (RAM - code) / 4)];
  const ramDiff = () => {
    for (let i = 0; i < a32.length; i++) if (a32[i] !== b32[i]) return code + 4 * i;
    return -1;
  };
  const [ca32, cb32] = [new Uint32Array(memory.buffer, ra, code / 4), new Uint32Array(memory.buffer, rb, code / 4)];
  for (let k = DATA; k < RAM; k++) a8[k] = rand32() & 0xff;
  b8.set(a8);
  const cpus = () => [new BigUint64Array(memory.buffer, interp, 34), new BigUint64Array(memory.buffer, jit, 34)];
  /** Runs both for `n` steps; what differs, or null. */
  const run = (n: bigint, mem: boolean) => {
    const [da, db] = [ex.interp_run_exit(interp, ma, n, ei), ex.jit_run_exit(jit, mb, n, ej)];
    const ca = new Uint8Array(memory.buffer, interp, CPU_BYTES), cb = new Uint8Array(memory.buffer, jit, CPU_BYTES);
    const d = ca.findIndex((x, i) => x !== cb[i]);
    const [xa, xb] = [new BigUint64Array(memory.buffer, ei, 2), new BigUint64Array(memory.buffer, ej, 2)];
    const m = mem ? ramDiff() : -1;
    if (d < 0 && m < 0 && xa[0] === xb[0] && xa[1] === xb[1] && da === db) return null;
    b8.set(a8);
    return d >= 0 ? `Cpu byte ${d} (x${d >> 3})` : m >= 0 ? `RAM byte ${m}` : da !== db ? `the steps (${da} vs ${db})` : `the exit (${xa[0]}, 0x${xa[1].toString(16)} vs ${xb[0]}, 0x${xb[1].toString(16)})`;
  };
  /** Instructions compiled inline and as helper calls so far. */
  const counts = () => {
    const st = new BigUint64Array(memory.buffer, ex.jit_stats(jit), 11);
    return `${st[8]} compiled inline, ${st[9]} as helper calls`;
  };
  /** Whether `w` is allocated and implemented: one interpreter step on it, in
   * the gap, with every register outside RAM (so it writes nothing). */
  const allocated = (w: number) => {
    const p = new Uint32Array(memory.buffer, ra + code, 1);
    p[0] = w;
    const c = new BigUint64Array(memory.buffer, interp, 34);
    c.fill(1n << 40n, 0, 32);
    [c[32], c[33]] = [BigInt(code), 0n];
    ex.interp_run_exit(interp, ma, 1n, ei);
    p[0] = 0;
    const kind = new BigUint64Array(memory.buffer, ei, 2)[0];
    return kind !== 1n && kind !== 2n;
  };
  return { ex, jit, ca32, cb32, cpus, run, counts, allocated, data: DATA };
}

for (const [name, [mask, bits], mem] of [
  ...Object.entries(CLASSES).map(([n, c]) => [n, c, false] as const),
  ...Object.entries(MEMORY).map(([n, c]) => [n, c, true] as const),
]) test(`JIT vs interpreter: ${name}`, () => {
  // Each word with a brk after it.
  const { ex, jit, ca32, cb32, cpus, run, counts, data } = setup(8 * WORDS);
  const words = Array.from({ length: WORDS }, () => ((field(rand32()) & ~mask) | bits) >>> 0);
  words.forEach((w, k) => {
    ca32.set([w, BRK], 2 * k);
    cb32.set([w, BRK], 2 * k);
  });

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
      const [a, b] = cpus();
      for (let r = 0; r < 32; r++) a[r] = value(mem, data);
      a[32] = BigInt(8 * k); // PC
      a[33] = BigInt(rand32() & 0xf) << 28n; // NZCV
      b.set(a);
      const what = run(1n, mem);
      if (what) {
        failures.push(`${words[k].toString(16).padStart(8, '0')}: ${what} differs`);
        break;
      }
    }
  }
  console.log(`${name}: ${WORDS} words, ${counts()}`);
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} of ${WORDS} words differ`);
});

// Sequences (step 6). Words that force helper calls: MRS/MSR NZCV (they end a
// block), an exclusive load, FMOV between X and D registers (a helper that
// reads or writes an X register); loads whose address misses come from the
// register values.
const HELPERS = [
  (d: number, _n: number) => 0xd53b4200 | d, // mrs xd, nzcv
  (d: number, _n: number) => 0xd51b4200 | d, // msr nzcv, xd
  (d: number, n: number) => 0xc85f7c00 | (n << 5) | d, // ldxr xd, [xn]
  (d: number, n: number) => 0x9e660000 | (n << 5) | d, // fmov xd, dn
  (d: number, n: number) => 0x9e670000 | (n << 5) | d, // fmov dd, xn
];
const ALU = ['add/sub, immediate', 'add/sub, shifted and extended register', 'add/sub with carry', 'logical, immediate', 'logical, shifted register', 'bitfield, 64-bit', 'bitfield, 32-bit', 'variable shifts', 'conditional select', 'conditional compare', 'multiply-add', 'data processing, register'].map((n) => CLASSES[n]);
const LAST = ['conditional branch', 'compare and branch', 'test and branch', 'branch to register'].map((n) => CLASSES[n]);
const SEQUENCES: Record<string, { pool: [number, number][]; helpers: boolean }> = {
  'ALU, flags and conditions': { pool: ALU, helpers: false },
  'loads, stores and ALU': { pool: [...ALU, ...Object.values(MEMORY), ...Object.values(MEMORY)], helpers: false },
  'with helper calls': { pool: [...ALU, ...Object.values(MEMORY)], helpers: true },
};
const SEQS = Math.max(1, WORDS >> 2);
const SLOT = 17; // up to 16 words, then brk
const REGS = [0, 1, 2, 3, 4, 31];
const pick = <T>(a: T[]) => a[rand32() % a.length];

/** Two thirds of the words get their register fields (4:0, 9:5, 14:10, 20:16) from a few registers. */
function fewRegs(w: number) {
  if (rand32() % 3 === 0) return w;
  for (const lo of [0, 5, 10, 16]) w = (w & ~(31 << lo)) | (pick(REGS) << lo);
  return w >>> 0;
}

for (const [name, { pool, helpers }] of Object.entries(SEQUENCES)) test(`JIT vs interpreter, sequences: ${name}`, () => {
  const { ex, jit, ca32, cb32, cpus, run, counts, allocated, data } = setup(4 * SLOT * SEQS);
  /** A random allocated word of a class in `from`, on few registers. */
  const draw = (from: [number, number][]) => {
    for (;;) {
      const [mask, bits] = pick(from);
      const w = fewRegs(((field(rand32()) & ~mask) | bits) >>> 0);
      if (allocated(w)) return w;
    }
  };
  const seqs = Array.from({ length: SEQS }, () => {
    const n = 2 + (rand32() % 15);
    const words = Array.from({ length: n }, (_, k) => {
      if (k === n - 1 && rand32() % 2 === 0) return draw(LAST);
      if (helpers && rand32() % 5 === 0) return pick(HELPERS)(pick(REGS.slice(0, 5)), pick(REGS)) >>> 0;
      return draw(pool);
    });
    return [...words, BRK];
  });
  const place = (k: number) => {
    ca32.set(seqs[k], SLOT * k);
    cb32.set(seqs[k], SLOT * k);
  };
  seqs.forEach((_, k) => place(k));
  const same = (k: number) => seqs[k].every((w, j) => ca32[SLOT * k + j] === w && cb32[SLOT * k + j] === w);

  const failures: string[] = [];
  let skipped = 0;
  for (let k = 0; k < SEQS; k++) {
    for (let s = 0; s < STATES; s++) {
      // As above: a store may have hit the code; restore it and drop its blocks.
      if (!same(k)) {
        place(k);
        ex.jit_flush(jit);
      }
      const [a, b] = cpus();
      for (let r = 0; r < 32; r++) a[r] = value(rand32() % 2 === 0, data);
      a[32] = BigInt(4 * SLOT * k); // PC
      a[33] = BigInt(rand32() & 0xf) << 28n; // NZCV
      b.set(a);
      // Exactly the sequence: a final branch is its last step (where it goes may be data).
      const what = run(BigInt(seqs[k].length - 1), true);
      // Code the run itself rewrote (without an IC) may legitimately differ.
      if (!same(k)) {
        skipped++;
        continue;
      }
      if (what) {
        failures.push(`${seqs[k].map((w) => w.toString(16).padStart(8, '0')).join(' ')}: ${what} differs`);
        break;
      }
    }
  }
  console.log(`${name}: ${SEQS} sequences, ${counts()}, ${skipped} runs skipped (they rewrote their code)`);
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} of ${SEQS} sequences differ`);
});
