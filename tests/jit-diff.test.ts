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
// lockstep and the boots), but for the load and store classes on spill
// memories at the end. Needs the wasm build (scripts/ci.sh).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fusedFma } from '../web/fma.ts';
import { coreImports, helperReport } from '../web/vm.ts';

const WASM = new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url);
const WORDS = Number(process.env.WEBPC_JIT_DIFF ?? 4096);
const STATES = 8;
const CPU_BYTES = 1168;
const BRK = 0xd4200000;

type Exports = {
  vcpu_new(): number;
  mem_new(base: number, size: bigint): number;
  interp_run_exit(cpu: number, mem: number, n: bigint, exit: number): bigint;
  jit_new(threshold: number, batch: number, capacity: number, check: number, regionAfter: number): number;
  jit_fma(v: number, on: number): void;
  jit_run_exit(v: number, mem: number, n: bigint, exit: number): bigint;
  jit_stats(v: number): number;
  jit_helper_report(v: number): number;
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
  // AdvSIMD (M6 loop 4), V registers random.
  'AdvSIMD three same': [0x9f200400, 0x0e200400],
  'AdvSIMD scalar SQADD, UQADD, SQSUB, UQSUB': [0xdf20dc00, 0x5e200c00],
  'AdvSIMD shift by immediate, modified immediate': [0x9f800400, 0x0f000400],
  'AdvSIMD two-register miscellaneous': [0x9f3e0c00, 0x0e200800],
  'AdvSIMD copy (DUP, INS, UMOV, SMOV)': [0x9fe08400, 0x0e000400],
  'AdvSIMD extract': [0xbfe08400, 0x2e000000],
  'AdvSIMD three different': [0x9f200c00, 0x0e200000],
  'AdvSIMD across lanes': [0x9f3e0c00, 0x0e300800],
  'AdvSIMD table lookup': [0xbfe08c00, 0x0e000000],
  'AdvSIMD permute (UZP, TRN, ZIP)': [0xbf208c00, 0x0e000800],
  'AdvSIMD vector x indexed element': [0x9f000400, 0x0f000000], // integer and FP
  'AdvSIMD scalar three same': [0xdf200400, 0x5e200400],
  'AdvSIMD scalar three different': [0xdf200c00, 0x5e200000],
  'AdvSIMD scalar two-register miscellaneous': [0xdf3e0c00, 0x5e200800],
  'AdvSIMD scalar pairwise': [0xdf3e0c00, 0x5e300800],
  'AdvSIMD scalar shift by immediate': [0xdf800400, 0x5f000400],
  'AdvSIMD scalar x indexed element': [0xdf000400, 0x5f000000],
  'CRC32, CRC32C': [0x7fe0e000, 0x1ac04000],
  'FP and general register moves, conversions': [0x7f20fc00, 0x1e200000],
  // Scalar FP (M6 loop 5): special values in the V registers, FPCR and FPSR.IXC random.
  'FP data processing, 1 source': [0xff207c00, 0x1e204000],
  'FP data processing, 2 sources': [0xff200c00, 0x1e200800],
  'FP data processing, 3 sources': [0xff000000, 0x1f000000],
  // FCMP/FCMPE, FCCMP/FCCMPE, FCSEL (M8): NZCV lazy, stored, read.
  'FP compare': [0xff20fc07, 0x1e202000],
  'FP conditional compare': [0xff200c00, 0x1e200400],
  'FP conditional select': [0xff200c00, 0x1e200c00],
  // Vector FP (M6 loop 6).
  'AdvSIMD FP three same': [0x9f20c400, 0x0e20c400],
  'AdvSIMD FP by element': [0x9f800400, 0x0f800000],
  'AdvSIMD FP two-register miscellaneous, FCVTL/FCVTN': [0x9f3f0c00, 0x0e210800],
  'AdvSIMD FCVTL, FCVTN': [0xbfbfec00, 0x0e216800], // their fast paths need every lane on them
  'AdvSIMD scalar FP two-register miscellaneous': [0xdf3f0c00, 0x5e210800], // SCVTF/UCVTF with the integer in Vn
  // The crypto extensions (M6.5): V registers random, or states from the FIPS vectors (CRYPTO_STATES).
  'AES': [0xffffcc00, 0x4e284800], // AESE, AESD, AESMC, AESIMC (size 0; the corpus has the reserved ones)
  'SHA three-register': [0xffe08c00, 0x5e000000], // opcodes 0-6, and 7 (reserved)
  'SHA two-register': [0xffffcc00, 0x5e280800], // SHA1H, SHA1SU1, SHA256SU0, and 3 (reserved)
  'PMULL, 64-bit': [0xbfe0fc00, 0x0ee0e000],
};
const CRYPTO = new Set(['AES', 'SHA three-register', 'SHA two-register', 'PMULL, 64-bit']);
/** Vector states from the known-answer vectors: FIPS 197 C.1's plaintext, key and
 * round-1 state (appendix B), SP 800-38A's key, the SHA-1 and SHA-256 initial hash
 * values, their first round constants, GCM test case 2's H (as registers: byte 0 low). */
const CRYPTO_STATES = [
  '00112233445566778899aabbccddeeff', '000102030405060708090a0b0c0d0e0f', '193de3bea0f4e22b9ac68d2ae9f84808', '2b7e151628aed2a6abf7158809cf4f3c',
  '0123456789abcdeffedcba9876543210', '66e94bd4ef8a2c3b884cfa59ca342b2e',
].map((h) => BigInt('0x' + h.match(/../g)!.reverse().join('')))
  .concat([
    [0x67452301n, 0xefcdab89n, 0x98badcfen, 0x10325476n], [0xc3d2e1f0n, 0n, 0n, 0n], [0x5a827999n, 0x5a827999n, 0x5a827999n, 0x5a827999n],
    [0x6a09e667n, 0xbb67ae85n, 0x3c6ef372n, 0xa54ff53an], [0x510e527fn, 0x9b05688cn, 0x1f83d9abn, 0x5be0cd19n], [0x428a2f98n, 0x71374491n, 0xb5c0fbcfn, 0xe9b5dba5n],
  ].map((e) => e.reduceRight((o, w) => (o << 32n) | w, 0n)));
/** Load/store classes: registers are mostly addresses around the data area. */
const MEMORY: Record<string, [number, number]> = {
  'load/store, unsigned offset': [0x3f000000, 0x39000000],
  'load/store, unscaled, pre/post-index, register offset': [0x3f000000, 0x38000000],
  'load/store pair': [0x3e000000, 0x28000000],
  'load literal': [0x3f000000, 0x18000000],
  'load-acquire, store-release': [0x3fa08000, 0x08808000], // LDAR, STLR (M6 loop 1)
  'DC ZVA': [0xffffffe0, 0xd50b7420],
  // M6 loop 7; the exclusives with the monitor armed at random (below).
  'LSE atomics': [0x3f200c00, 0x38200000], // LD<op>, SWP (min/max: helpers)
  'compare and swap': [0x3fa07c00, 0x08a07c00], // CAS, CASB, CASH
  'load exclusive': [0x3fff7c00, 0x085f7c00],
  'store exclusive': [0x3fe07c00, 0x08007c00],
  'load exclusive pair': [0xbfff0000, 0x887f0000], // LDXP, LDAXP (inline since M8)
  'store exclusive pair': [0xbfe00000, 0x88200000], // STXP, STLXP
  // SIMD&FP (M6 loop 2): V set; the V registers are random too.
  'SIMD&FP load/store, unsigned offset': [0x3f000000, 0x3d000000],
  'SIMD&FP load/store, unscaled, pre/post-index, register offset': [0x3f000000, 0x3c000000],
  'SIMD&FP load/store pair': [0x3e000000, 0x2c000000],
  'SIMD&FP load literal': [0x3f000000, 0x1c000000],
  'AdvSIMD load/store multiple structures': [0xbf200000, 0x0c000000], // LD1/ST1 inline (M6 loop 7)
  'AdvSIMD load/store single structure': [0xbf000000, 0x0d000000], // LD1/ST1 of a lane inline
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

/** A 32- or 64-bit FP value, special half of the time: zeros, infinities,
 * quiet and signalling NaNs, denormals, the extreme normals, one. */
function fpValue(d: boolean): bigint {
  const r = rand64();
  if (rand32() % 2 === 0) return d ? r : r & 0xffff_ffffn;
  const [sign, e, f] = d ? [1n << 63n, 0x7ffn << 52n, (1n << 52n) - 1n] : [1n << 31n, 0xffn << 23n, (1n << 23n) - 1n];
  const s = rand32() % 2 === 0 ? sign : 0n;
  const one = d ? 0x3ffn << 52n : 0x7fn << 23n;
  // A tie for the next narrower format (half for singles, single for doubles), singles at
  // exponents around half precision's range.
  const tie = d ? (one | (r & f) & ~0x1fff_ffffn) | 0x1000_0000n : (BigInt(100 + (rand32() % 46)) << 23n) | (r & f & ~0x1fffn) | 0x1000n;
  return s | [0n, e, e | (f & r) | (f + 1n) >> 1n, e | ((f >> 1n) & r | 1n), f & r | 1n, (e - (1n << (d ? 52n : 23n))) | f, 1n << (d ? 52n : 23n), one, one | (r & f), tie][rand32() % 10];
}

/** A normal FP value of moderate exponent (singles around half precision's range), a
 * zero now and then, sometimes a tie for the next narrower format. */
function fpPlain(d: boolean): bigint {
  const r = rand64();
  const s = rand32() % 2 === 0 ? 0n : d ? 1n << 63n : 1n << 31n;
  if (rand32() % 16 === 0) return s;
  const [fb, low, half] = d ? [52n, 0x1fff_ffffn, 0x1000_0000n] : [23n, 0x1fffn, 0x1000n];
  // A quarter of the singles at half precision's edges: 2^-15, 2^-14, 2^15, 2^16.
  const e = d ? BigInt(1023 - 40 + (rand32() % 80)) : rand32() % 4 === 0 ? [112n, 113n, 142n, 143n][rand32() % 4] : BigInt(108 + (rand32() % 40));
  let f = r & ((1n << fb) - 1n);
  if (rand32() % 8 === 0) f |= ((1n << fb) - 1n) & ~low; // all ones above the next format's rounding bits
  if (rand32() % 4 === 0) f = (f & ~low) | half;
  return s | (e << fb) | f;
}

/** The classes whose V registers sometimes hold integer lanes of edge values (`intLanes`). */
const INT_LANES = /^AdvSIMD (?!FP|scalar FP|FCVT)|^AdvSIMD load|^CRC32/;

/** 64 bits of `esize`-bit lanes: the signed and unsigned limits and their neighbours, small
 * values of either sign (shift counts), a lane with one bit set, or random bits. */
function intLanes(esize: bigint): bigint {
  const m = (1n << esize) - 1n, min = 1n << (esize - 1n);
  let v = 0n;
  for (let e = 0n; e < 64n; e += esize) {
    const r = rand32() % 12;
    const small = BigInt(rand32() % (Number(esize) + 4));
    const x = [0n, 1n, m, min, min - 1n, min + 1n, m - 1n, small, -small, 1n << BigInt(rand32() % Number(esize)), rand64(), rand64()][r];
    v |= (x & m) << e;
  }
  return v;
}

/** Two thirds of the words get a random bit window cleared or set: zero and all-ones immediates, XZR/SP. */
function field(w: number) {
  const r = rand32() % 3, lo = rand32() % 27, len = 1 + (rand32() % 12);
  const m = (len >= 32 ? -1 : ((1 << len) - 1) << lo) | 0;
  return r === 0 ? w : r === 1 ? w & ~m : w | m;
}

const DATA_SIZE = 0x2000;

/** What the JIT's FMA forms run on here (docs/jit.md "Floating point"): the host's fused `madd` where it has one. The
 * tests that reach those forms run again on the emulation, forced, so a host that fuses tests both arms. */
const FUSED = fusedFma();
const ARMS = FUSED ? [true, false] : [false];
const armName = (fma: boolean) => (fma === FUSED ? '' : ' (FMA emulated)');
const FMA_CLASSES = new Set(['FP data processing, 3 sources', 'AdvSIMD FP three same', 'AdvSIMD FP by element', 'AdvSIMD scalar x indexed element', 'AdvSIMD scalar three same']);

/** Two vCPUs (interpreter, JIT) on two copies of a RAM that holds `code` bytes
 * of code, a gap, then the data area, which ends the RAM (accesses past it are
 * external aborts). */
function setup(code: number, fma = FUSED) {
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
  const jit = ex.jit_new(0, 1, 16384, 0, 0);
  ex.jit_fma(jit, fma ? 1 : 0);
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
    const st = new BigUint64Array(memory.buffer, ex.jit_stats(jit), 18);
    return `${st[8]} compiled inline, ${st[9]} as helper calls, ${st[16]} blocks in ${st[0]} regions, ${st[17]} back-edges`;
  };
  /** WEBPC_JIT_DIFF_HELPERS=1: the helper calls by instruction since the last call, most first. */
  let lastHelpers = new Map<string, number>();
  const helpers = () => {
    const p = ex.jit_helper_report(jit), m8 = new Uint8Array(memory.buffer);
    const text = new TextDecoder().decode(m8.subarray(p, m8.indexOf(0, p)));
    const now = new Map(text.split('\n').filter(Boolean).map((l) => l.split(' ')).map(([o, n]) => [o, Number(n)] as [string, number]));
    const d = [...now].map(([o, n]) => [o, n - (lastHelpers.get(o) ?? 0)] as [string, number]).filter(([, n]) => n > 0);
    lastHelpers = now;
    return d.sort((x, y) => y[1] - x[1]).slice(0, 24).map(([o, n]) => `${o} ${n}`).join(', ');
  };
  /** Whether `w` is allocated and implemented: one interpreter step on it, in
   * the gap, with every register outside RAM (so it writes no RAM), the
   * interpreter's `Cpu` restored after (a literal load still writes its
   * register, a SIMD&FP one a V register that no run resets). */
  const allocated = (w: number) => {
    const p = new Uint32Array(memory.buffer, ra + code, 1);
    p[0] = w;
    const saved = new Uint8Array(memory.buffer, interp, CPU_BYTES).slice();
    const c = new BigUint64Array(memory.buffer, interp, 34);
    c.fill(1n << 40n, 0, 32);
    [c[32], c[33]] = [BigInt(code), 0n];
    ex.interp_run_exit(interp, ma, 1n, ei);
    new Uint8Array(memory.buffer, interp, CPU_BYTES).set(saved);
    p[0] = 0;
    const kind = new BigUint64Array(memory.buffer, ei, 2)[0];
    return kind !== 1n && kind !== 2n;
  };
  return { ex, jit, a8, ca32, cb32, cpus, run, counts, helpers, allocated, data: DATA };
}

for (const [name, [mask, bits], mem] of [
  ...Object.entries(CLASSES).map(([n, c]) => [n, c, false] as const),
  ...Object.entries(MEMORY).map(([n, c]) => [n, c, true] as const),
]) for (const fma of ARMS.filter((f) => f === FUSED || FMA_CLASSES.has(name))) test(`JIT vs interpreter: ${name}${armName(fma)}`, () => {
  // Each word with a brk after it.
  const { ex, jit, a8, ca32, cb32, cpus, run, counts, helpers, allocated, data } = setup(8 * WORDS, fma);
  const word = () => ((field(rand32()) & ~mask) | bits) >>> 0;
  // With the helper report, allocated words only (the unallocated ones' helper calls hide the rest).
  const words = Array.from({ length: WORDS }, () => {
    let w = word();
    for (let t = 0; process.env.WEBPC_JIT_DIFF_HELPERS && !allocated(w) && t < 64; t++) w = word();
    return w;
  });
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
      // V0–V31 (offset 304), random; FPSR (824) clear or QC only (it's
      // sticky: a helper's saturation earlier would hide a missing QC).
      // Half the words: every register as FP lanes of one size, mostly
      // plain values (a vector instruction's fast path needs all its lanes on it).
      const va = new BigUint64Array(a.buffer, a.byteOffset + 304, 64);
      // Integer classes, a third of the time: every register as integer lanes of one size, edge values
      // (the saturating, rounding and doubling forms' limits, small shift counts) mixed with random ones.
      const mode = INT_LANES.test(name) && rand32() % 3 === 0 ? 4 : rand32() % 4;
      const esize = 8n << BigInt(rand32() % 4);
      for (let r = 0; r < 64; r++) {
        const k = rand32() % 4;
        const lane = (d: boolean) => (rand32() % 8 === 0 ? fpValue(d) : fpPlain(d));
        va[r] = mode === 0 ? lane(true) : mode === 1 ? lane(false) | lane(false) << 32n
          : mode === 4 ? intLanes(esize)
          : k === 0 ? EDGES[rand32() % EDGES.length] : k === 1 ? fpValue(true) : k === 2 ? fpValue(false) | fpValue(false) << 32n : rand64();
      }
      if (CRYPTO.has(name)) {
        for (let r = 0; r < 32; r++) {
          if (rand32() % 3 !== 0) continue;
          const v = CRYPTO_STATES[rand32() % CRYPTO_STATES.length];
          [va[2 * r], va[2 * r + 1]] = [v & M64, v >> 64n];
        }
      }
      // FPCR (816): the default half the time, else RMode, FZ, DN and AHP random;
      // FPSR (824): IXC mostly set (the FP fast paths need it), QC sometimes.
      const fp = new BigUint64Array(a.buffer, a.byteOffset + 816, 2);
      fp[0] = rand32() % 2 === 0 ? 0n : BigInt(rand32() & 0x1f) << 22n;
      fp[1] = (rand32() % 4 === 0 ? 0n : 16n) | (rand32() % 4 === 0 ? 1n << 27n : 0n);
      // The exclusive monitor (272: address, size, value), mostly armed for
      // this word's address, size and the value in memory, so STXR stores.
      // The base half the time aligned to the access (else the helper's).
      if (name.includes('exclusive')) {
        const mon = new BigUint64Array(a.buffer, a.byteOffset + 272, 4);
        const w = words[k], rn = (w >>> 5) & 31;
        const size = name.endsWith('pair') ? 8 << ((w >>> 30) & 1) : 1 << (w >>> 30);
        if (rand32() % 2 === 0) a[rn] &= ~BigInt(size - 1);
        const addr = rand32() % 4 === 0 ? value(true, data) : a[rn];
        let v = 0n;
        for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(addr + BigInt(i) < BigInt(a8.length) ? a8[Number(addr) + i] : 0);
        mon[0] = addr;
        mon[1] = BigInt(rand32() % 4 === 0 ? [0, 1, 2, 4, 8, 16][rand32() % 6] : size);
        mon[2] = rand32() % 4 === 0 ? rand64() : v & M64;
        mon[3] = size === 16 && rand32() % 4 !== 0 ? v >> 64n : rand32() % 2 === 0 ? rand64() : 0n;
      }
      // The JIT's vCPU starts from exactly the interpreter's state.
      new Uint8Array(b.buffer, b.byteOffset, CPU_BYTES).set(new Uint8Array(a.buffer, a.byteOffset, CPU_BYTES));
      const what = run(1n, mem);
      if (what) {
        failures.push(`${words[k].toString(16).padStart(8, '0')}: ${what} differs`);
        break;
      }
    }
  }
  console.log(`${name}: ${WORDS} words, ${counts()}`);
  if (process.env.WEBPC_JIT_DIFF_HELPERS) console.log(`  helper calls: ${helpers()}`);
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} of ${WORDS} words differ`);
});

// System registers (M6 loop 1): MRS of the registers the JIT reads inline
// and of neighbours that stay helper calls (traps, timers, UNDEFINED), the
// barriers, DC ZVA and SIMD&FP loads/stores, at EL0, EL1t and EL1h, with the system registers
// random (registers mostly addresses in and around the data area). The
// `Cpu` offsets are checked natively (`interp::sys::tests::jit_diff_offsets`).
const SYSREG_FIELDS = [976, 984, 992, 840, 848, 856, 864, 872, 896, 904, 912, 920, 928, 944, 968, 880, 1016, 1000]; // tpidr_el0 … mdscr_el1
const PSTATE = 832, SCTLR = 888;
const sr = (op0: number, op1: number, crn: number, crm: number, op2: number) => (op0 - 2) << 14 | op1 << 11 | crn << 7 | crm << 3 | op2;
const SYSREG_KEYS = [
  sr(3, 3, 4, 2, 0), sr(3, 3, 13, 0, 2), sr(3, 3, 13, 0, 3), sr(3, 3, 0, 0, 7), sr(3, 3, 4, 2, 1), sr(3, 3, 0, 0, 1), // NZCV TPIDR_EL0 TPIDRRO DCZID DAIF CTR
  sr(3, 0, 4, 0, 0), sr(3, 0, 4, 0, 1), sr(3, 0, 4, 1, 0), sr(3, 0, 4, 2, 0), sr(3, 0, 4, 2, 2), sr(3, 0, 13, 0, 4), // SPSR ELR SP_EL0 SPSel CurrentEL TPIDR_EL1
  sr(3, 0, 1, 0, 0), sr(3, 0, 1, 0, 2), sr(3, 0, 2, 0, 0), sr(3, 0, 2, 0, 1), sr(3, 0, 2, 0, 2), sr(3, 0, 5, 2, 0), sr(3, 0, 6, 0, 0), // SCTLR CPACR TTBR0/1 TCR ESR FAR
  sr(3, 0, 7, 4, 0), sr(3, 0, 10, 2, 0), sr(3, 0, 12, 0, 0), sr(3, 0, 14, 1, 0), sr(3, 0, 13, 0, 1), sr(2, 0, 0, 2, 2), // PAR MAIR VBAR CNTKCTL CONTEXTIDR MDSCR
  sr(3, 0, 0, 0, 0), sr(3, 0, 0, 0, 5), sr(3, 0, 0, 0, 6), sr(3, 0, 0, 4, 0), sr(3, 0, 0, 5, 0), sr(3, 0, 0, 6, 0), sr(3, 0, 0, 7, 0), // MIDR MPIDR REVIDR ID_AA64*
  sr(3, 3, 4, 4, 0), sr(3, 3, 4, 4, 1), sr(3, 3, 14, 0, 0), sr(3, 3, 14, 0, 2), sr(3, 0, 12, 1, 0), sr(3, 1, 0, 0, 0), // FPCR FPSR CNTFRQ CNTVCT ISR CCSIDR
];
// MSR (M6 loop 7): the registers the JIT writes inline (DAIF, SP_EL0, SPSR, ELR, TPIDR_EL0/EL1, TPIDRRO_EL0).
const MSR_KEYS = [sr(3, 3, 4, 2, 1), sr(3, 0, 4, 1, 0), sr(3, 0, 4, 0, 0), sr(3, 0, 4, 0, 1), sr(3, 3, 13, 0, 2), sr(3, 0, 13, 0, 4), sr(3, 3, 13, 0, 3)];
test('JIT vs interpreter: system registers and barriers', () => {
  const { ex, jit, ca32, cb32, cpus, run, counts, data } = setup(8 * WORDS);
  const words = Array.from({ length: WORDS }, () => {
    const rt = rand32() & 31;
    if (rand32() % 8 === 0) return (0xd503301f | (rand32() & 0xfe0)) >>> 0; // barriers and the rest of that space
    if (rand32() % 8 === 0) return (0xd503401f | (6 + (rand32() % 2)) << 5 | (rand32() & 0xf) << 8) >>> 0; // MSR DAIFSet, DAIFClr
    if (rand32() % 6 === 0) return (0xd5100000 | MSR_KEYS[rand32() % MSR_KEYS.length] << 5 | rt) >>> 0; // MSR
    if (rand32() % 8 === 0) return (0xd50b7420 | rt) >>> 0; // DC ZVA: SCTLR_EL1.DZE decides at EL0
    if (rand32() % 8 === 0) return ((field(rand32()) & ~0x3f000000) | 0x3d000000) >>> 0; // SIMD&FP load/store: CPACR_EL1.FPEN decides
    if (rand32() % 8 === 0) return ((field(rand32()) & ~0x9f200400) | 0x0e200400) >>> 0; // AdvSIMD three same: likewise
    const key = rand32() % 4 === 0 ? rand32() & 0xffff : SYSREG_KEYS[rand32() % SYSREG_KEYS.length];
    return (0xd5300000 | key << 5 | rt) >>> 0; // MRS
  });
  words.forEach((w, k) => {
    ca32.set([w, BRK], 2 * k);
    cb32.set([w, BRK], 2 * k);
  });
  const failures: string[] = [];
  for (let k = 0; k < WORDS; k++) {
    for (let s = 0; s < STATES; s++) {
      // DC ZVA or a store may have hit this word: restore it and drop its
      // block (the guest would need an IC).
      if (ca32[2 * k] !== words[k] || cb32[2 * k] !== words[k] || ca32[2 * k + 1] !== BRK || cb32[2 * k + 1] !== BRK) {
        ca32.set([words[k], BRK], 2 * k);
        cb32.set([words[k], BRK], 2 * k);
        ex.jit_flush(jit);
      }
      const [a, b] = cpus();
      const full = [new BigUint64Array(a.buffer, a.byteOffset, CPU_BYTES / 8), new BigUint64Array(b.buffer, b.byteOffset, CPU_BYTES / 8)];
      for (let r = 0; r < 32; r++) a[r] = value(true, data);
      a[32] = BigInt(8 * k);
      a[33] = BigInt(rand32() & 0xf) << 28n;
      for (const off of SYSREG_FIELDS) full[0][off / 8] = rand64();
      // EL0, EL1t or EL1h (MMU off: the flat bus), random DAIF; SCTLR's EL0 trap enables flipped.
      full[0][PSTATE / 8] = BigInt([0, 4, 5][rand32() % 3]) | BigInt(rand32() & 0x3c0);
      full[0][SCTLR / 8] = full[1][SCTLR / 8] ^ BigInt(rand32() & (1 << 9 | 1 << 14 | 1 << 15));
      full[1].set(full[0]);
      const what = run(1n, true);
      if (what) {
        failures.push(`${words[k].toString(16).padStart(8, '0')} (pstate ${full[0][PSTATE / 8]}): ${what} differs`);
        break;
      }
    }
  }
  console.log(`system registers and barriers: ${WORDS} words, ${counts()}`);
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} of ${WORDS} words differ`);
});

// FP edge cases (M6 loop 5): operands the random classes rarely produce, at
// the fast paths' limits, each under several FPCR/FPSR states.
const f32bits = (x: number) => { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, x, true); return BigInt(d.getUint32(0, true)); };
const f64bits = (x: number) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x, true); return d.getBigUint64(0, true); };
const lanes = (...l: number[]) => l.map(f32bits) as unknown as bigint;
const FP_EDGES: [string, number, bigint[]][] = [
  // Exact product just below the smallest normal, rounding up to it: tiny (Underflow).
  ['fmul s0, s1, s2', 0x1e220820, [0n, 0x3f7fffffn, 0x00800000n]],
  ['fmul d0, d1, d2', 0x1e620820, [0n, 0x3fefffffffffffffn, 0x0010000000000000n]],
  ['fdiv s0, s1, s2', 0x1e221820, [0n, 0x00ffffffn, 0x40000000n]],
  // 1 + 2^-23 + 2^-24 - 2^-60: t = RN64 lands on the singles' midpoint, ties-to-even would pick 1 + 2^-22.
  ['fmadd s0, s1, s2, s3', 0x1f020c20, [0n, f32bits(1 + 2 ** -18), f32bits(2 ** -24 * (1 - 2 ** -18)), f32bits(1 + 2 ** -23)]],
  ['fmsub s0, s1, s2, s3', 0x1f028c20, [0n, f32bits(-(1 + 2 ** -18)), f32bits(2 ** -24 * (1 - 2 ** -18)), f32bits(1 + 2 ** -23)]],
  // Double FMA (Boldo and Melquiond's emulation): ab = 1 - 2^-60, RN(ab) = 1, c's ulp 2, so
  // c + RN(ab) is a midpoint and only the round to odd keeps the tie from going up.
  ['fmadd d0, d1, d2, d3 (midpoint)', 0x1f420c20, [0n, f64bits(1 + 2 ** -30), f64bits(1 - 2 ** -30), f64bits(2 ** 53 + 2)]],
  ['fmsub d0, d1, d2, d3 (midpoint)', 0x1f428c20, [0n, f64bits(-(1 + 2 ** -30)), f64bits(1 - 2 ** -30), f64bits(2 ** 53 + 2)]],
  ['fnmadd d0, d1, d2, d3 (midpoint)', 0x1f620c20, [0n, f64bits(1 + 2 ** -30), f64bits(1 - 2 ** -30), f64bits(-(2 ** 53 + 6))]],
  ['fnmsub d0, d1, d2, d3 (midpoint)', 0x1f628c20, [0n, f64bits(1 + 2 ** -30), f64bits(1 - 2 ** -30), f64bits(-(2 ** 53 + 2))]],
  // The product's lower bound, 2^-900: on it and just under it, a small addend.
  ['fmadd d0 (product 2^-900)', 0x1f420c20, [0n, f64bits(2 ** -450 * (1 + 2 ** -30)), f64bits(2 ** -450 * (1 - 2 ** -30)), f64bits(2 ** -847 + 2 ** -899)]],
  ['fmadd d0 (product 2^-901)', 0x1f420c20, [0n, f64bits(2 ** -451 * (1 + 2 ** -30)), f64bits(2 ** -450 * (1 - 2 ** -30)), f64bits(2 ** -848 + 2 ** -900)]],
  // A product's error under 2^-1074 deciding a midpoint (ab = -2^-1020 (1 - 2^-60)): the helper's.
  ['fmadd d0 (product 2^-1020 on a midpoint)', 0x1f420c20, [0n, f64bits(-(2 ** -510) * (1 + 2 ** -30)), f64bits(2 ** -510 * (1 - 2 ** -30)), f64bits(-(2 ** 53 + 2) * 2 ** -1020)]],
  ['fmadd d0 (denormal factor)', 0x1f420c20, [0n, f64bits(2 ** -1060), f64bits(2 ** 1000), f64bits(1)]],
  ['fmadd d0 (zero factor)', 0x1f420c20, [0n, 0n, f64bits(1.5), f64bits(1)]],
  ['fmadd d0 (denormal addend)', 0x1f420c20, [0n, f64bits(1.5), f64bits(1.5), f64bits(2 ** -1060)]],
  ['fmadd d0 (zero addend)', 0x1f420c20, [0n, f64bits(1 + 2 ** -52), f64bits(1 + 2 ** -52), 1n << 63n]],
  // Veltkamp's split overflows (a near 2^1000): a NaN z, the helper.
  ['fmadd d0 (split overflows)', 0x1f420c20, [0n, f64bits(1.5 * 2 ** 1000), f64bits(2 ** -500), f64bits(1)]],
  // Dekker's product overflows (ah·bh = 2^1024) with p = RN(ab) finite and c cancelling it: an
  // infinite sum and a NaN error, whose sign is the host's (negative on x86-64), mustn't step the
  // sum to the largest finite double. The exact result is 2^962.
  ['fmadd d0 (Dekker product overflows)', 0x1f420c20, [0n, f64bits((2 - 2 ** -30) * 2 ** 992), f64bits((2 - 2 ** -30) * 2 ** 30), f64bits(-(2 ** 30 - 1) * 2 ** 994)]],
  ['fmadd d0 (product overflows)', 0x1f420c20, [0n, f64bits(2 ** 1000), f64bits(2 ** 100), f64bits(-1.7976931348623157e308)]],
  ['fmadd d0 (smallest normal result)', 0x1f420c20, [0n, f64bits(2 ** -500), f64bits(1.5 * 2 ** -400), f64bits(-1.5 * 2 ** -900 + 2 ** -1021)]],
  ['fmadd d0 (exact zero)', 0x1f420c20, [0n, f64bits(1.5), f64bits(2), f64bits(-3)]],
  ['fmadd d0 (product 2^-901, a negative factor)', 0x1f420c20, [0n, f64bits(-(2 ** -451) * (1 + 2 ** -30)), f64bits(2 ** -450 * (1 - 2 ** -30)), f64bits(2 ** -848 + 2 ** -900)]],
  ['fmadd d0 (0 × ∞)', 0x1f420c20, [0n, 0n, f64bits(Infinity), f64bits(1)]],
  // Singles: the double sum exact on a midpoint (the FP guest's 1 × 0.999 + 0.5), zero and denormal factors.
  ['fmadd s0 (exact midpoint)', 0x1f020c20, [0n, f32bits(1), f32bits(0.999), f32bits(0.5)]],
  // The double sum just above a midpoint (by 2^-48): not one, so RN32 of it is right.
  ['fmadd s0 (next to a midpoint)', 0x1f020c20, [0n, f32bits(1 + 2 ** -18), f32bits(2 ** -24 * (1 - 2 ** -18) + 2 ** -48), f32bits(1 + 2 ** -23)]],
  ['fmadd s0 (tiny addend)', 0x1f020c20, [0n, f32bits(1 + 2 ** -12), f32bits(1 + 2 ** -12), f32bits(2 ** -60)]],
  ['fmadd s0 (zero factor)', 0x1f020c20, [0n, 1n << 31n, f32bits(0.999), f32bits(0.5)]],
  ['fmadd s0 (denormal factor)', 0x1f020c20, [0n, 1n, f32bits(2 ** 100), f32bits(1)]],
  ['fmadd s0 (zero addend)', 0x1f020c20, [0n, f32bits(1 + 2 ** -23), f32bits(1 + 2 ** -23), 0n]],
  // FCMP/FCMPE (M8): the result, read by the B.cond … CSET a sequence ends with elsewhere; here NZCV.
  ['fcmp s1, s2 (lt)', 0x1e222020, [0n, f32bits(1), f32bits(2)]],
  ['fcmp s1, s2 (-0 = 0)', 0x1e222020, [0n, 1n << 31n, 0n]],
  ['fcmp d1, d2 (gt)', 0x1e622020, [0n, f64bits(Infinity), f64bits(1e300)]],
  ['fcmp d1, #0 (quiet NaN)', 0x1e602028, [0n, 0x7ff8_0000_0000_0001n]],
  ['fcmp s1, s2 (signaling NaN)', 0x1e222020, [0n, f32bits(1), 0x7f80_0001n]],
  ['fcmpe s1, s2 (quiet NaN)', 0x1e222030, [0n, 0x7fc0_0000n, f32bits(1)]],
  ['fcmp d1, d2 (denormal)', 0x1e622020, [0n, 1n, 0n]],
  ['fcmp d1, d2 (quiet NaN, quiet bit 51)', 0x1e622020, [0n, 0xfff8_0000_0000_0000n, f64bits(1)]],
  ['fccmp s1, s2, #4, eq', 0x1e220424, [0n, f32bits(1), f32bits(2)]],
  ['fccmpe d1, d2, #0, ne (NaN)', 0x1e621430, [0n, f64bits(NaN), f64bits(2)]],
  ['fcsel d0, d1, d2, mi', 0x1e624c20, [0n, f64bits(1), f64bits(2)]],
  // FCVT single ↔ double, FMAX/FMIN's zeros, FRINTA's ties and signed zeros.
  ['fcvt d0, s1', 0x1e22c020, [0n, f32bits(-1.5e-30)]],
  ['fcvt s0, d1 (rounds)', 0x1e624020, [0n, f64bits(1 + 2 ** -24 + 2 ** -40)]],
  ['fcvt s0, d1 (tiny)', 0x1e624020, [0n, f64bits(2 ** -130)]],
  ['fcvt s0, d1 (overflows)', 0x1e624020, [0n, f64bits(2 ** 129)]],
  ['fcvt s0, d1 (-0)', 0x1e624020, [0n, 1n << 63n]],
  ['fmax s0, s1, s2 (-0, +0)', 0x1e224820, [0n, 1n << 31n, 0n]],
  ['fmin d0, d1, d2 (+0, -0)', 0x1e625820, [0n, 0n, 1n << 63n]],
  ['fmaxnm d0, d1, d2 (NaN)', 0x1e626820, [0n, f64bits(NaN), f64bits(1)]],
  ['frinta s0, s1 (-0.5)', 0x1e264020, [0n, f32bits(-0.5)]],
  ['frinta s0, s1 (-0.3)', 0x1e264020, [0n, f32bits(-0.3)]],
  ['frinta d0, d1 (2.5)', 0x1e664020, [0n, f64bits(2.5)]],
  ['frinta d0, d1 (0.49999999999999994)', 0x1e664020, [0n, f64bits(0.49999999999999994)]],
  ['frinta s0, s1 (2^23 + 1)', 0x1e264020, [0n, f32bits(2 ** 23 + 1)]],
  ['frinta d0, d1 (-∞)', 0x1e664020, [0n, f64bits(-Infinity)]],
  ['frintx d0, d1 (1.5)', 0x1e674020, [0n, f64bits(1.5)]],
  ['frintm s0, s1 (-0)', 0x1e254020, [0n, 1n << 31n]],
  // Zero operands of FADD/FSUB/FMUL/FNMUL/FDIV: an exact zero result keeps its IEEE sign; a zero divisor and a
  // product underflowing to zero go to the helper.
  ['fadd d0 (0 + x)', 0x1e622820, [0n, 0n, f64bits(1.5)]],
  ['fadd d0 (-0 + -0)', 0x1e622820, [0n, 1n << 63n, 1n << 63n]],
  ['fadd d0 (0 + -0)', 0x1e622820, [0n, 0n, 1n << 63n]],
  ['fsub d0 (x - x)', 0x1e623820, [0n, f64bits(1.5), f64bits(1.5)]],
  ['fadd s0 (-x + x)', 0x1e222820, [0n, f32bits(-1.5), f32bits(1.5)]],
  ['fmul d0 (-0 × x)', 0x1e620820, [0n, 1n << 63n, f64bits(1.5)]],
  ['fnmul d0 (0 × x)', 0x1e628820, [0n, 0n, f64bits(1.5)]],
  ['fmul s0 (underflow to 0)', 0x1e220820, [0n, f32bits(2 ** -100), f32bits(2 ** -100)]],
  ['fdiv d0 (0 / x)', 0x1e621820, [0n, 0n, f64bits(-3)]],
  ['fdiv d0 (x / 0)', 0x1e621820, [0n, f64bits(3), 0n]],
  ['fdiv d0 (0 / 0)', 0x1e621820, [0n, 0n, 0n]],
  ['fcvtzs w0, s1 (2^31)', 0x1e380020, [0n, 0x4f000000n]],
  ['fcvtzs w0, s1 (-2^31)', 0x1e380020, [0n, 0xcf000000n]],
  ['fcvtzs w0, d1 (-2^31 - 0.5)', 0x1e780020, [0n, f64bits(-2147483648.5)]],
  ['fcvtzs w0, d1 (-2^31 - 1)', 0x1e780020, [0n, f64bits(-2147483649)]],
  ['fcvtzs w0, d1 (2^31 - 0.1)', 0x1e780020, [0n, f64bits(2147483647.9)]],
  ['fcvtzs x0, s1 (2^63)', 0x9e380020, [0n, 0x5f000000n]],
  ['fcvtzu w0, s1 (-0.5)', 0x1e390020, [0n, 0xbf000000n]],
  ['fcvtzu w0, s1 (2^32)', 0x1e390020, [0n, 0x4f800000n]],
  // The same midpoint case in every lane of a vector FMLA (the values replicated).
  ['v fmla v0.4s, v1.4s, v2.4s', 0x4e22cc20, [f32bits(1 + 2 ** -23), f32bits(1 + 2 ** -18), f32bits(2 ** -24 * (1 - 2 ** -18))]],
  ['v fmla v0.2s, v1.2s, v2.2s', 0x0e22cc20, [f32bits(1 + 2 ** -23), f32bits(1 + 2 ** -18), f32bits(2 ** -24 * (1 - 2 ** -18))]],
  ['v fmla v0.4s, v1.4s, v2.s[1]', 0x4fa21020, [f32bits(1 + 2 ** -23), f32bits(1 + 2 ** -18), f32bits(2 ** -24 * (1 - 2 ** -18))]],
  // (1 + 2^-12)^2 = 1 + 2^-11 + 2^-24, a midpoint, exactly; a tiny addend decides it (TwoSum's error).
  ['v fmla v0.4s, v1.4s, v2.4s (tiny addend)', 0x4e22cc20, [f32bits(2 ** -60), f32bits(1 + 2 ** -12), f32bits(1 + 2 ** -12)]],
  ['v fmul v0.4s, v1.4s, v2.4s', 0x6e22dc20, [0n, 0x3f7fffffn, 0x00800000n]],
  // "w …": doubles in both lanes; the double FMA's cases on f64x2.
  ['w fmla v0.2d, v1.2d, v2.2d (midpoint)', 0x4e62cc20, [f64bits(2 ** 53 + 2), f64bits(1 + 2 ** -30), f64bits(1 - 2 ** -30)]],
  ['w fmls v0.2d, v1.2d, v2.2d (midpoint)', 0x4ee2cc20, [f64bits(2 ** 53 + 2), f64bits(-(1 + 2 ** -30)), f64bits(1 - 2 ** -30)]],
  ['w fmla v0.2d, v1.2d, v2.d[1] (midpoint)', 0x4fc21820, [f64bits(2 ** 53 + 2), f64bits(1 + 2 ** -30), f64bits(1 - 2 ** -30)]],
  ['w fmla v0.2d (product 2^-901, a negative factor)', 0x4e62cc20, [f64bits(2 ** -848 + 2 ** -900), f64bits(-(2 ** -451) * (1 + 2 ** -30)), f64bits(2 ** -450 * (1 - 2 ** -30))]],
  ['w fmla v0.2d (product 2^-1020 on a midpoint)', 0x4e62cc20, [f64bits(-(2 ** 53 + 2) * 2 ** -1020), f64bits(-(2 ** -510) * (1 + 2 ** -30)), f64bits(2 ** -510 * (1 - 2 ** -30))]],
  ['w fmla v0.2d (product 2^-900)', 0x4e62cc20, [f64bits(2 ** -847 + 2 ** -899), f64bits(2 ** -450 * (1 + 2 ** -30)), f64bits(2 ** -450 * (1 - 2 ** -30))]],
  ['w fmla v0.2d (zero factor)', 0x4e62cc20, [f64bits(1), 1n << 63n, f64bits(1.5)]],
  ['w fmla v0.2d (denormal factor)', 0x4e62cc20, [f64bits(1), f64bits(2 ** -1060), f64bits(2 ** 1000)]],
  ['w fmla v0.2d (split overflows)', 0x4e62cc20, [f64bits(1), f64bits(1.5 * 2 ** 1000), f64bits(2 ** -500)]],
  ['w fmla v0.2d (Dekker product overflows)', 0x4e62cc20, [f64bits(-(2 ** 30 - 1) * 2 ** 994), f64bits((2 - 2 ** -30) * 2 ** 992), f64bits((2 - 2 ** -30) * 2 ** 30)]],
  ['w fmla v0.2d (exact zero)', 0x4e62cc20, [f64bits(-3), f64bits(1.5), f64bits(2)]],
  // A 64-bit source rounded by one: 2^64 - 1 becomes 2^63, past any signed compare.
  ['uqrshrn s0, d1, #1 (2^64 - 1)', 0x7f3f9c20, [0n, (1n << 64n) - 1n]],
  ['w uqrshrn v0.2s, v1.2d, #1 (2^64 - 1)', 0x2f3f9c20, [0n, (1n << 64n) - 1n]],
  ['w uqrshrn2 v0.4s, v1.2d, #1 (2^64 - 1)', 0x6f3f9c20, [0n, (1n << 64n) - 1n]],
  // The fused arm: its negations, and a zero result it can't read from a double sum. A sum that rounds to zero raises
  // Underflow; an exact one doesn't.
  ['fnmadd s0, s1, s2, s3 (midpoint)', 0x1f220c20, [0n, f32bits(1 + 2 ** -18), f32bits(2 ** -24 * (1 - 2 ** -18)), f32bits(-(1 + 2 ** -23))]],
  ['fnmsub s0, s1, s2, s3 (midpoint)', 0x1f228c20, [0n, f32bits(1 + 2 ** -18), f32bits(2 ** -24 * (1 - 2 ** -18)), f32bits(-(1 + 2 ** -23))]],
  ['fnmadd d0 (exact zero)', 0x1f620c20, [0n, f64bits(1.5), f64bits(2), f64bits(-3)]],
  ['fmadd s0 (product underflows to zero)', 0x1f020c20, [0n, f32bits(2 ** -80), f32bits(2 ** -80), 0n]],
  ['fmadd d0 (denormal factor, a normal result)', 0x1f420c20, [0n, f64bits(2 ** -1060), f64bits(2 ** 100), f64bits(0.5)]],
  ['fmadd d0 (product 2^-1000, a normal result)', 0x1f420c20, [0n, f64bits(2 ** -500 * (1 + 2 ** -30)), f64bits(2 ** -500 * (1 - 2 ** -30)), f64bits(2 ** -900)]],
  ['v fmla v0.4s (product underflows to zero)', 0x4e22cc20, [0n, f32bits(2 ** -80), f32bits(2 ** -80)]],
  ['v fmla v0.4s (negative product underflows to zero)', 0x4e22cc20, [0n, f32bits(-(2 ** -80)), f32bits(2 ** -80)]],
  ['v fmla v0.4s (zero factor, zero addend)', 0x4e22cc20, [1n << 31n, 1n << 31n, f32bits(1.5)]],
  ['v fmla v0.4s (zero factor, denormal partner)', 0x4e22cc20, [0n, 1n, 0n]],
  ['v fmla v0.4s (zero factor, denormal addend)', 0x4e22cc20, [1n, 0n, f32bits(1.5)]],
  ['v fmla v0.4s (cancels exactly)', 0x4e22cc20, [f32bits(-3), f32bits(1.5), f32bits(2)]],
  ['v fmls v0.4s (cancels exactly)', 0x4ea2cc20, [f32bits(3), f32bits(1.5), f32bits(2)]],
  ['v fmls v0.4s (zero factor, zero addend)', 0x4ea2cc20, [0n, 0n, f32bits(1.5)]],
  // Addends around the zero clause's 2^-100, the product's last bits left over or not.
  ['v fmla v0.4s (cancels at 2^-100)', 0x4e22cc20, [f32bits(-(2 ** -100) * 3), f32bits(1.5), f32bits(2 ** -99)]],
  ['v fmla v0.4s (cancels at 2^-101)', 0x4e22cc20, [f32bits(-(2 ** -101) * 3), f32bits(1.5), f32bits(2 ** -100)]],
  ['v fmla v0.4s (residue below the addend, at 2^-100)', 0x4e22cc20, [f32bits(-(2 ** -100) * (1 + 2 ** -22)), f32bits((1 + 2 ** -12) * 2 ** -50), f32bits((1 - 2 ** -12) * 2 ** -50)]],
  ['v fmla v0.4s (residue rounds to zero, at 2^-126)', 0x4e22cc20, [f32bits(-(2 ** -126)), f32bits((1 + 2 ** -12) * 2 ** -63), f32bits((1 - 2 ** -12) * 2 ** -63)]],
  ['v frecps v0.4s (2 - 2)', 0x4e22fc20, [0n, f32bits(1), f32bits(2)]],
  ['v frsqrts v0.4s (3 - 3)', 0x4ea2fc20, [0n, f32bits(1.5), f32bits(2)]],
  ['v frsqrts v0.4s (a midpoint)', 0x4ea2fc20, [0n, f32bits(1 + 2 ** -18), f32bits(2 ** -24 * (1 - 2 ** -18))]],
  ['w frsqrts v0.2d (3 - 3)', 0x4ee2fc20, [0n, f64bits(1.5), f64bits(2)]],
  ['frecps s0, s1, s2', 0x5e22fc20, [0n, f32bits(1.5), f32bits(1.25)]],
  ['v fmla s0, s1, v2.s[1]', 0x5fa21020, [f32bits(1 + 2 ** -23), f32bits(1 + 2 ** -18), f32bits(2 ** -24 * (1 - 2 ** -18))]],
  ['w fmls d0, d1, v2.d[1]', 0x5fc25820, [f64bits(2 ** 53 + 2), f64bits(-(1 + 2 ** -30)), f64bits(1 - 2 ** -30)]],
  ['v fmls v0.4s, v1.4s, v2.s[1]', 0x4fa25020, [f32bits(1 + 2 ** -23), f32bits(-(1 + 2 ** -18)), f32bits(2 ** -24 * (1 - 2 ** -18))]],
  // Lanes that differ: a fast one beside what the zero clause decides, and the lanes a 2S ignores.
  ['x fmla v0.4s (a zero lane beside fast ones)', 0x4e22cc20, [lanes(0, 1, 0, 1), lanes(0, 1.5, 0, 1.5), lanes(1.5, 1.5, 1.5, 1.5)]],
  ['x fmla v0.4s (an underflowed lane beside fast ones)', 0x4e22cc20, [lanes(1, 0, 1, 1), lanes(1.5, 2 ** -80, 1.5, 1.5), lanes(1.5, 2 ** -80, 1.5, 1.5)]],
  ['x fmla v0.4s (an exact zero and an underflow)', 0x4e22cc20, [lanes(0, 0, 1, -3), lanes(0, 2 ** -80, 1.5, 1.5), lanes(1.5, 2 ** -80, 1.5, 2)]],
  ['x fmla v0.2s (a NaN in lanes it ignores)', 0x0e22cc20, [lanes(1, 1, NaN, 2 ** -149), lanes(1.5, 1.5, NaN, 2 ** -80), lanes(1.5, 1.5, NaN, 2 ** -80)]],
  ['x fmla v0.2s (a zero lane, an underflow in lanes it ignores)', 0x0e22cc20, [lanes(0, 1, 0, 0), lanes(0, 1.5, 2 ** -80, 2 ** -80), lanes(1.5, 1.5, 2 ** -80, 2 ** -80)]],
  ['x fmla s0 by element, junk above lane 0', 0x5fa21020, [lanes(1, NaN, Infinity, 2 ** -149), lanes(1.5, NaN, 2 ** -149, Infinity), lanes(1, 1.5, NaN, Infinity)]],
];
test('the probe finds the fused madd on arm64', { skip: process.arch !== 'arm64' }, () => {
  // arm64's relaxed madd is always FMLA. If the probe broke, every host would quietly lose the fused arm.
  assert.equal(FUSED, true);
});

for (const fma of ARMS) test(`JIT vs interpreter: FP edge cases${armName(fma)}`, () => {
  const { ex, jit, ca32, cb32, cpus, run } = setup(8 * FP_EDGES.length, fma);
  const failures: string[] = [];
  FP_EDGES.forEach(([name, w], k) => {
    ca32.set([w, BRK], 2 * k);
    cb32.set([w, BRK], 2 * k);
  });
  FP_EDGES.forEach(([name, , vs], k) => {
    // FPCR default, FZ, DN, round toward zero; FPSR.IXC set and clear.
    for (const fpcr of [0n, 1n << 24n, 1n << 25n, 3n << 22n]) {
      for (const fpsr of [16n, 0n]) {
        const [a, b] = cpus();
        a.fill(0n);
        a[32] = BigInt(8 * k);
        const all = new BigUint64Array(a.buffer, a.byteOffset, CPU_BYTES / 8);
        // "v …" cases: the 32-bit value in every lane; "w …": the 64-bit value in both.
        // "x …": the four lanes of each register, one value each.
        const rep = (v: bigint) => (name.startsWith('v ') ? v | (v << 32n) : v);
        if (name.startsWith('x ')) {
          (vs as unknown as bigint[][]).forEach((l, r) => { all[38 + 2 * r] = l[0] | (l[1] << 32n); all[39 + 2 * r] = l[2] | (l[3] << 32n); });
        } else vs.forEach((v, r) => { all[38 + 2 * r] = rep(v); all[39 + 2 * r] = name.startsWith('v ') || name.startsWith('w ') ? rep(v) : 0n; });
        [all[102], all[103]] = [fpcr, fpsr];
        new Uint8Array(b.buffer, b.byteOffset, CPU_BYTES).set(new Uint8Array(a.buffer, a.byteOffset, CPU_BYTES));
        const what = run(1n, false);
        if (what) failures.push(`${name} (FPCR ${fpcr.toString(16)}, FPSR ${fpsr}): ${what} differs`);
      }
    }
  });
  ex.jit_flush(jit);
  assert.deepEqual(failures, []);
});

// Sequences (step 6). Words that read or write NZCV outside the ALU: MRS
// NZCV (inline since M6 loop 1: it reads lazy flags made current) and MSR
// NZCV (a helper that ends the block); words that force helper calls:
// LDSMAX, FCVTZS (helpers that write X registers); an exclusive load (inline
// since M6 loop 7), an exclusive pair load (since M8) and FMOV between X and D
// registers (since loop 4); loads whose address misses come from the register values.
const HELPERS = [
  (d: number, _n: number) => 0xd53b4200 | d, // mrs xd, nzcv
  (d: number, _n: number) => 0xd51b4200 | d, // msr nzcv, xd
  (d: number, _n: number) => 0xd51b4220 | d, // msr daif, xd (doesn't end a block since M6 loop 7)
  (d: number, n: number) => 0xc85f7c00 | (n << 5) | d, // ldxr xd, [xn] (inline since M6 loop 7)
  (d: number, n: number) => 0xc87f0000 | (((d + 1) & 31) << 10) | (n << 5) | d, // ldxp xd, xd+1, [xn] (inline since M8)
  (d: number, n: number) => 0xf8204000 | (n << 16) | (n << 5) | d, // ldsmax xn, xd, [xn]
  (d: number, n: number) => 0x9e660000 | (n << 5) | d, // fmov xd, dn (inline since M6 loop 4)
  (d: number, n: number) => 0x9e670000 | (n << 5) | d, // fmov dd, xn (likewise)
  (d: number, n: number) => 0x9e780000 | (n << 5) | d, // fcvtzs xd, dn (a helper that writes an X register)
];
// Helper-only words on V registers, among inline NEON, FP and V loads and
// stores on the same few registers: a dirty V local must be written back before
// each, and dropped after the ones that write V (V registers in locals).
const VHELPERS = [
  (d: number, n: number) => 0x4e60fc00 | (n << 16) | (n << 5) | d, // frecps vd.2d, vn.2d, vn.2d
  (d: number, n: number) => 0x4ea1c800 | (n << 5) | d, // urecpe vd.4s, vn.4s
  (d: number, n: number) => 0x6ee1f800 | (n << 5) | d, // fsqrt vd.2d, vn.2d
  (d: number, n: number) => 0x1e664000 | (n << 5) | d, // frinta dd, dn
  (d: number, n: number) => 0x6e218800 | (n << 5) | d, // frinta vd.4s, vn.4s
  (d: number, n: number) => 0x7ee03800 | (n << 5) | d, // usqadd dd, dn
];
const NEON = ['AdvSIMD three same', 'AdvSIMD shift by immediate, modified immediate', 'AdvSIMD two-register miscellaneous', 'AdvSIMD copy (DUP, INS, UMOV, SMOV)', 'AdvSIMD permute (UZP, TRN, ZIP)', 'AdvSIMD three different', 'AdvSIMD FP three same', 'AdvSIMD FP by element', 'AdvSIMD FCVTL, FCVTN', 'FP data processing, 1 source', 'FP data processing, 2 sources', 'FP data processing, 3 sources', 'FP and general register moves, conversions', 'FP compare', 'FP conditional compare', 'FP conditional select', 'conditional select', 'conditional compare'].map((n) => CLASSES[n]);
const VMEM = ['SIMD&FP load/store, unsigned offset', 'SIMD&FP load/store pair', 'AdvSIMD load/store multiple structures', 'AdvSIMD load/store single structure'].map((n) => MEMORY[n]);
const ALU = ['add/sub, immediate', 'add/sub, shifted and extended register', 'add/sub with carry', 'logical, immediate', 'logical, shifted register', 'bitfield, 64-bit', 'bitfield, 32-bit', 'variable shifts', 'conditional select', 'conditional compare', 'multiply-add', 'data processing, register'].map((n) => CLASSES[n]);
const LAST = ['conditional branch', 'compare and branch', 'test and branch', 'branch to register'].map((n) => CLASSES[n]);
const SEQUENCES: Record<string, { pool: [number, number][]; helpers: boolean; aes?: boolean; sha?: boolean; vec?: boolean }> = {
  'ALU, flags and conditions': { pool: ALU, helpers: false },
  'loads, stores and ALU': { pool: [...ALU, ...Object.values(MEMORY), ...Object.values(MEMORY)], helpers: false },
  'with helper calls': { pool: [...ALU, ...Object.values(MEMORY)], helpers: true },
  // AES rounds as compilers emit them (M6.5): round and mix pairs on the same
  // register (fused by the JIT) or not, among single AES words, EOR and other NEON.
  // SHA-256 rounds and schedule (M6.5 loop 6): the fused triple among SHA words and NEON.
  'SHA rounds and NEON': { pool: [CLASSES['SHA three-register'], CLASSES['SHA two-register'], CLASSES['AdvSIMD three same']], helpers: false, sha: true },
  'AES rounds and NEON': { pool: [CLASSES['AES'], CLASSES['AdvSIMD three same'], CLASSES['AdvSIMD copy (DUP, INS, UMOV, SMOV)'], MEMORY['SIMD&FP load/store, unsigned offset']], helpers: false, aes: true },
  // V registers whole FP lanes of one size most of the time, so the vector fast paths (and their fallbacks) run.
  'NEON, FP and V helpers': { pool: [...NEON, ...VMEM], helpers: false, vec: true },
};
/** mov S, A; sha256h A, E, W; sha256h2 E, S, W (fused by the JIT), one register sometimes off. */
function shaTriple(): number[] {
  const r5 = REGS.slice(0, 5);
  const [A, E, S, W] = [pick(r5), pick(r5), pick(r5), pick(r5)];
  const odd = rand32() % 4 === 0 ? rand32() % 4 : -1;
  const x = (k: number, v: number) => (odd === k ? pick(r5) : v);
  return [(0x4ea01c00 | x(0, A) << 16 | A << 5 | S) >>> 0, (0x5e004000 | W << 16 | x(1, E) << 5 | A) >>> 0, (0x5e005000 | x(3, W) << 16 | x(2, S) << 5 | E) >>> 0];
}
/** AESE/AESD then AESMC/AESIMC, mostly on the round's register. */
function aesPair(): number[] {
  const dec = rand32() % 2, d = pick(REGS.slice(0, 5)), n = pick(REGS.slice(0, 5));
  const d2 = rand32() % 5 === 0 ? pick(REGS.slice(0, 5)) : d, n2 = rand32() % 8 === 0 ? pick(REGS.slice(0, 5)) : d;
  return [(0x4e284800 | dec << 12 | n << 5 | d) >>> 0, (0x4e286800 | dec << 12 | n2 << 5 | d2) >>> 0];
}
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

for (const [name, { pool, helpers, aes, sha, vec }] of Object.entries(SEQUENCES)) for (const fma of ARMS.filter((f) => f === FUSED || vec)) test(`JIT vs interpreter, sequences: ${name}${armName(fma)}`, () => {
  const { ex, jit, ca32, cb32, cpus, run, counts, allocated, data } = setup(4 * SLOT * SEQS, fma);
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
      if (vec && rand32() % 4 === 0) return pick(VHELPERS)(pick(REGS.slice(0, 5)), pick(REGS.slice(0, 5))) >>> 0;
      return draw(pool);
    });
    // Pairs replace words, the length stays n (a slot holds 16 words).
    if (aes) for (let k = 0; k + 1 < n; k++) if (rand32() % 3 === 0) words.splice(k, 2, ...aesPair());
    if (sha) for (let k = 0; k + 2 < n; k++) if (rand32() % 3 === 0) words.splice(k, 3, ...shaTriple());
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
      if (aes || sha) {
        const va = new BigUint64Array(a.buffer, a.byteOffset + 304, 64);
        for (let r = 0; r < 32; r++) {
          const v = rand32() % 3 === 0 ? CRYPTO_STATES[rand32() % CRYPTO_STATES.length] : rand64() | rand64() << 64n;
          [va[2 * r], va[2 * r + 1]] = [v & M64, v >> 64n];
        }
      }
      if (vec) {
        // FPSR.IXC mostly set and FPCR the default (the FP fast paths need both).
        const va = new BigUint64Array(a.buffer, a.byteOffset + 304, 66);
        const mode = rand32() % 3;
        const lane = (d: boolean) => (rand32() % 8 === 0 ? fpValue(d) : fpPlain(d));
        for (let r = 0; r < 64; r++) va[r] = mode === 0 ? lane(true) : mode === 1 ? lane(false) | lane(false) << 32n : rand64();
        [va[64], va[65]] = [rand32() % 4 === 0 ? BigInt(rand32() & 0x1f) << 22n : 0n, rand32() % 4 === 0 ? 0n : 16n];
      }
      new Uint8Array(b.buffer, b.byteOffset, CPU_BYTES).set(new Uint8Array(a.buffer, a.byteOffset, CPU_BYTES)); // all of it: V too (a skipped run may leave V different)
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

// Regions (step 8): small programs of 2–6 blocks, each 1–6 words (ALU, loads
// and stores, some helper calls) ending in a branch to the start of any block
// (conditional or not) or falling through, the last one ending in brk. The JIT
// compiles each program as a region, so edges inside it are wasm branches with
// registers kept in locals; runs of a random length stop anywhere, mid-block or
// at the step budget before an edge. (A pass-2 register state collected as
// `Option`s was miscompiled with simd128; this class caught it: docs/backlog.md.)
const PROG = 48; // words per program slot
function branchTo(k: number, to: number) {
  const off = to - k; // in words
  const imm19 = (off & 0x7ffff) << 5, imm14 = (off & 0x3fff) << 5;
  const rt = pick(REGS.slice(0, 5));
  switch (rand32() % 5) {
    case 0: return (0x54000000 | imm19 | (rand32() % 14)) >>> 0; // b.cond (not AL/NV)
    case 1: return ((rand32() % 2 << 31) | 0x34000000 | (rand32() % 2 << 24) | imm19 | rt) >>> 0; // cbz/cbnz
    case 2: return ((rand32() % 2 << 31) | 0x36000000 | (rand32() % 2 << 24) | (rand32() % 32 << 19) | imm14 | rt) >>> 0; // tbz/tbnz
    case 3: return (0x14000000 | (off & 0x3ffffff)) >>> 0; // b
    default: return -1; // fall through
  }
}

test('JIT vs interpreter, regions: branches between blocks', () => {
  const { ex, jit, ca32, cb32, cpus, run, counts, allocated, data } = setup(4 * PROG * SEQS);
  const pool = [...ALU, ...Object.values(MEMORY)];
  const draw = () => {
    if (rand32() % 6 === 0) return pick(HELPERS)(pick(REGS.slice(0, 5)), pick(REGS)) >>> 0;
    for (;;) {
      const [mask, bits] = pick(pool);
      const w = fewRegs(((field(rand32()) & ~mask) | bits) >>> 0);
      if (allocated(w)) return w;
    }
  };
  const progs = Array.from({ length: SEQS }, () => {
    const lens = Array.from({ length: 2 + (rand32() % 5) }, () => 1 + (rand32() % 6));
    const starts = lens.map((_, b) => lens.slice(0, b).reduce((s, n) => s + n + 1, 0));
    const words: number[] = [];
    lens.forEach((n, b) => {
      for (let k = 0; k < n; k++) words.push(draw());
      if (b === lens.length - 1) return words.push(BRK);
      const w = branchTo(words.length, starts[rand32() % lens.length]);
      words.push(w < 0 ? draw() : w); // no branch: one more word, falling through
    });
    return words;
  });
  const place = (k: number) => {
    ca32.set(progs[k], PROG * k);
    cb32.set(progs[k], PROG * k);
  };
  progs.forEach((_, k) => place(k));
  const same = (k: number) => progs[k].every((w, j) => ca32[PROG * k + j] === w && cb32[PROG * k + j] === w);

  const failures: string[] = [];
  let skipped = 0;
  for (let k = 0; k < SEQS; k++) {
    for (let s = 0; s < STATES; s++) {
      if (!same(k)) {
        place(k);
        ex.jit_flush(jit);
      }
      const [a, b] = cpus();
      for (let r = 0; r < 32; r++) a[r] = value(rand32() % 2 === 0, data);
      a[32] = BigInt(4 * PROG * k); // PC
      a[33] = BigInt(rand32() & 0xf) << 28n; // NZCV
      new Uint8Array(b.buffer, b.byteOffset, CPU_BYTES).set(new Uint8Array(a.buffer, a.byteOffset, CPU_BYTES)); // all of it: V too (a skipped run may leave V different)
      const what = run(BigInt(1 + (rand32() % 48)), true);
      if (!same(k)) {
        skipped++;
        continue;
      }
      if (what) {
        failures.push(`${progs[k].map((w) => w.toString(16).padStart(8, '0')).join(' ')}: ${what} differs`);
        break;
      }
    }
  }
  console.log(`regions: ${SEQS} programs, ${counts()}, ${skipped} runs skipped (they rewrote their code)`);
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} of ${SEQS} programs differ`);
});

// Loops (step 8): a counted loop (x5 from movz, 1–20) of 1–3 blocks of random
// words, the inner ones branching forward to each other or back to the head, closed by a
// back-edge (sub + cbnz, subs + b.ne, or a random b.cond), after an optional
// prefix and before a brk; runs of up to 400 steps stop at any iteration, and
// the region's budget check on the back-edge is what stops it there.
test('JIT vs interpreter, regions: loops', () => {
  const { ex, jit, ca32, cb32, cpus, run, counts, allocated, data } = setup(4 * PROG * SEQS);
  const pool = [...ALU, ...Object.values(MEMORY)];
  const draw = () => {
    if (rand32() % 8 === 0) return pick(HELPERS)(pick(REGS.slice(0, 5)), pick(REGS)) >>> 0;
    for (;;) {
      const [mask, bits] = pick(pool);
      const w = fewRegs(((field(rand32()) & ~mask) | bits) >>> 0);
      if (allocated(w)) return w;
    }
  };
  const progs = Array.from({ length: SEQS }, () => {
    const words: number[] = [(0xd2800005 | ((1 + (rand32() % 20)) << 5)) >>> 0]; // movz x5, #k
    for (let k = rand32() % 3; k > 0; k--) words.push(draw());
    const head = words.length;
    const lens = Array.from({ length: 1 + (rand32() % 3) }, () => 1 + (rand32() % 5));
    const starts = lens.map((_, b) => head + lens.slice(0, b).reduce((s, n) => s + n + 1, 0));
    lens.forEach((n, b) => {
      for (let k = 0; k < n; k++) words.push(draw());
      if (b < lens.length - 1) {
        // Forward, or (a third of them) back to the head: a second back-edge.
        const to = rand32() % 3 === 0 ? head : starts[b + 1 + (rand32() % (lens.length - b - 1))];
        const w = branchTo(words.length, to);
        words.push(w < 0 ? draw() : w);
      }
    });
    const back = (to: number) => ((to - words.length) & 0x7ffff) << 5;
    switch (rand32() % 3) {
      case 0: words.push(0xd10004a5, (0xb5000005 | back(head)) >>> 0); break; // sub x5, x5, #1; cbnz x5
      case 1: words.push(0xf10004a5, (0x54000001 | back(head)) >>> 0); break; // subs x5, x5, #1; b.ne
      default: words.push((0x54000000 | back(head) | (rand32() % 14)) >>> 0); // b.cond
    }
    words.push(draw(), BRK);
    return words;
  });
  const place = (k: number) => {
    ca32.set(progs[k], PROG * k);
    cb32.set(progs[k], PROG * k);
  };
  progs.forEach((_, k) => place(k));
  const same = (k: number) => progs[k].every((w, j) => ca32[PROG * k + j] === w && cb32[PROG * k + j] === w);

  const failures: string[] = [];
  let skipped = 0;
  for (let k = 0; k < SEQS; k++) {
    for (let s = 0; s < STATES; s++) {
      if (!same(k)) {
        place(k);
        ex.jit_flush(jit);
      }
      const [a, b] = cpus();
      for (let r = 0; r < 32; r++) a[r] = value(rand32() % 2 === 0, data);
      a[32] = BigInt(4 * PROG * k); // PC
      a[33] = BigInt(rand32() & 0xf) << 28n; // NZCV
      new Uint8Array(b.buffer, b.byteOffset, CPU_BYTES).set(new Uint8Array(a.buffer, a.byteOffset, CPU_BYTES)); // all of it: V too (a skipped run may leave V different)
      const what = run(BigInt(1 + (rand32() % 400)), true);
      if (!same(k)) {
        skipped++;
        continue;
      }
      if (what) {
        failures.push(`${progs[k].map((w) => w.toString(16).padStart(8, '0')).join(' ')}: ${what} differs`);
        break;
      }
    }
  }
  console.log(`loops: ${SEQS} programs, ${counts()}, ${skipped} runs skipped (they rewrote their code)`);
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} of ${SEQS} programs differ`);
});

// Spill memories (docs/spill-memories.md "The JIT's spill arm"): the load and store classes with
// the MMU on, at EL1, the registers mostly addresses around a data area in spill memory 1 (whose
// pages the JIT reaches in an inline arm) or in spill memory 2 (the helper's), on an interpreter
// VM and a JIT-check VM (each block compiled on first sight). Memory 0 is read-only to the guest,
// so the code stays as it was. A page's first access fills its TLB entry; the later states hit it.
const SPILL_WORDS = WORDS >> 1;
const SPILL_DATA = [0x8000_0000, 0xc000_8000]; // memory 1's first bytes; memory 2's at 32 KiB (another TLB index)
function setupSpill(code: number) {
  const RAM = 1 << 20, BASE = 0x4000_0000, TABLES = 0x8_0000, VECTORS = 0x7_0000;
  const B_SELF = 0x14000000;
  const side = (jit: number) => {
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
    const spill = [0, 1].map(() => new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }));
    const imports = coreImports(memory, undefined, undefined, undefined, spill);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM)), imports);
    imports.jit.bind(instance);
    const ex = instance.exports as Record<string, (...a: (number | bigint)[]) => number>;
    const ram = memory.grow(RAM / 65536) * 65536;
    const cfg = memory.grow(1) * 65536;
    const words = new BigUint64Array(memory.buffer, cfg, 32);
    words.set([BigInt(RAM), 1n, 0n, 0n, 0n, 0n, 0n, 0n, BigInt(jit)]);
    [words[24], words[25]] = [65536n, 65536n];
    const vm = ex.vm_new(ram, BigInt(RAM), cfg);
    assert.notEqual(vm, 0);
    // 1 GiB blocks, VA = PA: memory 0's RAM read-only at EL1, the spill memories read-write at EL0 and EL1 (LDTR).
    const block = (pa: number, ap: bigint, xn: boolean) => BigInt(pa) | 1n << 10n | 3n << 8n | ap << 6n | 1n | (xn ? 3n << 53n : 0n);
    new BigUint64Array(memory.buffer, ram + TABLES, 4).set([0n, block(BASE, 2n, false), block(0x8000_0000, 1n, true), block(0xc000_0000, 1n, true)]);
    new Uint32Array(memory.buffer, ram + VECTORS, 0x800 / 4).fill(B_SELF);
    const cpu = ex.vm_cpu(vm, 0);
    const full = new BigUint64Array(memory.buffer, cpu, CPU_BYTES / 8);
    full[904 / 8] = 25n | 1n << 8n | 1n << 10n | 3n << 12n | 1n << 23n | 2n << 32n; // TCR: T0SZ 25, EPD1, IPS 40 bits
    full[912 / 8] = BigInt(BASE + TABLES); // TTBR0
    full[928 / 8] = 0xffn; // MAIR: attribute 0 normal
    full[896 / 8] = 3n << 20n; // CPACR: FPEN
    full[880 / 8] = BigInt(BASE + VECTORS); // VBAR
    full[888 / 8] |= 1n; // SCTLR.M
    new Uint8Array(memory.buffer, cpu, CPU_BYTES)[1146] |= 2; // and the dispatcher's copy of it (`Cpu::dispatch`, DISPATCH_MMU)
    full[832 / 8] = 0x3c5n; // EL1h, DAIF masked
    const code32 = new Uint32Array(memory.buffer, ram, code / 4);
    const data = spill.map((m, k) => new Uint8Array(m.buffer, SPILL_DATA[k] & 0xffff, DATA_SIZE));
    return { ex, vm, memory, cpu, code32, data };
  };
  const [a, b] = [side(0), side(3)];
  for (const d of a.data) for (let k = 0; k < DATA_SIZE; k++) d[k] = rand32() & 0xff;
  a.data.forEach((d, k) => b.data[k].set(d));
  /** Runs both for `n` steps; what differs, or null. */
  const run = (n: bigint) => {
    const [ka, kb] = [a.ex.vm_run(a.vm, n), b.ex.vm_run(b.vm, n)];
    const [ca, cb] = [new Uint8Array(a.memory.buffer, a.cpu, CPU_BYTES), new Uint8Array(b.memory.buffer, b.cpu, CPU_BYTES)];
    const d = ca.findIndex((x, i) => x !== cb[i]);
    const m = a.data.findIndex((x, k) => Buffer.compare(x, b.data[k]) !== 0);
    if (d < 0 && m < 0 && ka === kb) return null;
    a.data.forEach((x, k) => b.data[k].set(x));
    return d >= 0 ? `Cpu byte ${d} (x${d >> 3})` : m >= 0 ? `spill memory ${m + 1}'s data` : `the exit (${ka} vs ${kb})`;
  };
  /** `size` bytes at guest PA `addr` if they're in a data area, else 0n. */
  const peek = (addr: bigint, size: number) => {
    let v = 0n;
    for (let i = size - 1; i >= 0; i--) {
      const p = Number(addr) + i, k = SPILL_DATA.findIndex((s) => p >= s && p < s + DATA_SIZE);
      v = (v << 8n) | BigInt(k < 0 ? 0 : a.data[k][p - SPILL_DATA[k]]);
    }
    return v;
  };
  return { a, b, run, peek, pc: BigInt(BASE) };
}

for (const [name, [mask, bits]] of Object.entries(MEMORY)) test(`JIT vs interpreter on spill memories, MMU on: ${name}`, () => {
  const { a, b, run, peek, pc } = setupSpill(8 * SPILL_WORDS);
  const words = Array.from({ length: SPILL_WORDS }, () => ((field(rand32()) & ~mask) | bits) >>> 0);
  words.forEach((w, k) => {
    a.code32.set([w, 0x14000000], 2 * k); // b .
    b.code32.set([w, 0x14000000], 2 * k);
  });
  const failures: string[] = [];
  for (let k = 0; k < SPILL_WORDS; k++) {
    for (let s = 0; s < STATES; s++) {
      const fa = new BigUint64Array(a.memory.buffer, a.cpu, CPU_BYTES / 8);
      const data = SPILL_DATA[rand32() % 4 === 0 ? 1 : 0];
      for (let r = 0; r < 32; r++) fa[r] = value(true, data);
      fa[32] = pc + BigInt(8 * k);
      fa[33] = BigInt(rand32() & 0xf) << 28n;
      const va = new BigUint64Array(a.memory.buffer, a.cpu + 304, 64);
      for (let r = 0; r < 64; r++) va[r] = rand64();
      if (name.includes('exclusive')) {
        const w = words[k], rn = (w >>> 5) & 31;
        const size = name.endsWith('pair') ? 8 << ((w >>> 30) & 1) : 1 << (w >>> 30);
        if (rand32() % 2 === 0) fa[rn] &= ~BigInt(size - 1);
        const v = peek(fa[rn], size);
        fa.set([fa[rn], BigInt(rand32() % 4 === 0 ? 4 : size), rand32() % 4 === 0 ? rand64() : v & M64, size === 16 ? v >> 64n : 0n], 272 / 8);
      }
      new Uint8Array(b.memory.buffer, b.cpu, CPU_BYTES).set(new Uint8Array(a.memory.buffer, a.cpu, CPU_BYTES));
      const what = run(2n);
      if (what) {
        failures.push(`${words[k].toString(16).padStart(8, '0')}: ${what} differs`);
        break;
      }
    }
  }
  const st = new BigUint64Array(b.memory.buffer, b.ex.vm_counters(b.vm, 0), 82);
  console.log(`${name} on spill memories: ${SPILL_WORDS} words, ${st[79]} compiled inline, ${st[80]} as helper calls`);
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} of ${SPILL_WORDS} words differ`);
});

// Groups of accesses (docs/jit.md "Loads and stores"): three loads and stores off one base share a probe, with an
// add among them at times, their span in memory 0 (read-only: the stores fault), in spill memory 1 (the group's spill
// arm), in memory 2 (the helper), or across a page of the data areas. A load off another base comes first, an add to
// the first access's register before it: a failure past the group's first instruction must leave that register as
// the instructions before it did.
test('JIT vs interpreter on spill memories, MMU on: groups of accesses', () => {
  const N = SPILL_WORDS >> 2;
  const { a, b, run, pc } = setupSpill(32 * N);
  const access = (rn: number) => {
    const rt = rand32() % 32, s = rand32() % 2 === 0 ? 0 : 1 << 22;
    switch (rand32() % 3) {
      case 0: return 0xf9000000 | s | (rand32() % 8) << 10 | rn << 5 | rt; // LDR/STR X, unsigned offset
      case 1: return 0xf8000000 | s | ((rand32() % 64) - 32 & 0x1ff) << 12 | rn << 5 | rt; // LDUR/STUR X
      default: return 0xa9000000 | s | ((rand32() % 16) - 8 & 0x7f) << 15 | (rand32() % 32) << 10 | rn << 5 | rt; // LDP/STP X
    }
  };
  const words: number[][] = [];
  for (let k = 0; k < N; k++) {
    const rn = rand32() % 31, first = access(rn);
    const dirty = first & 31, other = (rn + 1 + rand32() % 29) % 31; // not rn, so the load isn't in the group
    const mid = rand32() % 4 === 0 ? 0x91000400 | (dirty === rn ? other : dirty) * 0x21 : access(rn); // add Xd, Xd, #1
    const w = [0x91000400 | dirty * 0x21, 0xf9400000 | other << 5 | 30, first, mid, access(rn), 0x14000000].map((x) => x >>> 0);
    words.push(w);
    a.code32.set(w, 8 * k);
    b.code32.set(w, 8 * k);
  }
  const failures: string[] = [];
  for (let k = 0; k < N; k++) {
    for (let s = 0; s < STATES; s++) {
      const fa = new BigUint64Array(a.memory.buffer, a.cpu, CPU_BYTES / 8);
      const data = SPILL_DATA[rand32() % 4 === 0 ? 1 : 0];
      for (let r = 0; r < 32; r++) fa[r] = value(true, data);
      fa[32] = pc + BigInt(32 * k);
      fa[33] = BigInt(rand32() & 0xf) << 28n;
      // Twice: the first run fills the TLB, the second takes the fast arm (or, on a read entry alone, must not store).
      const state = fa.slice(0, 34);
      let what = '';
      for (let again = 0; again < 2 && !what; again++) {
        fa.set(state);
        new Uint8Array(b.memory.buffer, b.cpu, CPU_BYTES).set(new Uint8Array(a.memory.buffer, a.cpu, CPU_BYTES));
        what = run(6n) ?? '';
      }
      if (what) {
        failures.push(`${words[k].slice(0, 5).map((w) => w.toString(16).padStart(8, '0')).join(' ')}: ${what} differs`);
        break;
      }
    }
  }
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} of ${N} groups differ`);
});

// The arm runs: a load from a page in spill memory 1, its TLB entry filled, stays in the block, while one from
// spill memory 2 takes the helper each time (the tests above pass either way).
test('JIT on spill memories: memory 1 inline, memory 2 through the helper', () => {
  const { b, pc } = setupSpill(8);
  b.code32.set([0xf9400020, 0x14000000]); // ldr x0, [x1]; b .
  const f = new BigUint64Array(b.memory.buffer, b.cpu, 34);
  const calls = () => helperReport(b.ex as never, b.memory, b.ex.vm_cpu(b.vm, 0)).find((h) => h.op === 'STRx_LDRx_imm_2')?.calls ?? 0;
  for (const [k, inline] of [[0, true], [1, false]] as const) {
    const before = calls();
    for (let n = 0; n < 10; n++) {
      [f[1], f[32]] = [BigInt(SPILL_DATA[k] + 8 * n), pc];
      b.ex.vm_run(b.vm, 2n);
      assert.equal(f[32], pc + 4n, `memory ${k + 1}: the load retired`);
    }
    const n = calls() - before;
    if (inline) assert.ok(n <= 1, `memory 1: ${n} helper calls (only its first, which fills the TLB entry)`);
    else assert.ok(n >= 9, `memory 2: ${n} helper calls`);
  }
});
