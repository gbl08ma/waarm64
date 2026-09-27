// Golden-corpus generator: random, constrained A64 integer tests, risu-style.
//
// Each group is a list of forms. A form fills an encoding pattern (one letter
// per field, MSB first, as in dynarmic's table) with random fields, rejects
// CONSTRAINED UNPREDICTABLE and IMPLEMENTATION DEFINED cases, and sets the
// registers that must hold addresses or branch targets. Everything else comes
// from the test's seed, with edge values mixed into source registers.
// Reserved field values are kept on purpose: the oracles must SIGILL where we
// raise UNDEFINED.
//
// Generation is deterministic: same code, same tests.

import { CODE, DATA, DATA_SIZE, initialState, splitmix64, type Test } from "./corpus.ts";

const M64 = (1n << 64n) - 1n;

class Rng {
  g: Generator<bigint>;
  constructor(seed: bigint) {
    this.g = splitmix64(seed);
  }
  u64(): bigint {
    return this.g.next().value as bigint;
  }
  int(n: number): number {
    return Number(this.u64() % BigInt(n));
  }
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }
  chance(p: number): boolean {
    return this.int(1_000_000) < p * 1_000_000;
  }
  pick<T>(a: readonly T[]): T {
    return a[this.int(a.length)];
  }
}

const EDGES = [
  0n, 1n, 2n, M64, M64 - 1n, 0x7fn, 0x80n, 0xffn, 0x7fffn, 0x8000n, 0xffffn, 0x7fffffffn, 0x80000000n,
  0xffffffffn, 0x100000000n, 0xffffffff00000000n, 0x7fffffffffffffffn, 0x8000000000000000n,
  0x8000000000000001n, 0x00000000ffffffffn, 0x5555555555555555n, 0xaaaaaaaaaaaaaaaan,
];

type Fields = Record<string, number>;

/** Encodes `pat` (32 chars of 0/1/letters), filling fields missing from `f` at random. */
function enc(r: Rng, pat: string, f: Fields = {}): { w: number; f: Fields } {
  if (pat.length !== 32) throw new Error(`pattern ${pat}`);
  const width: Record<string, number> = {};
  for (const ch of pat) if (/[a-zA-Z]/.test(ch)) width[ch] = (width[ch] ?? 0) + 1;
  const all: Fields = { ...f };
  for (const [l, n] of Object.entries(width)) all[l] ??= Number(r.u64() & ((1n << BigInt(n)) - 1n));
  const left = { ...width };
  let w = 0;
  for (const ch of pat) {
    let b = ch === "1" ? 1 : 0;
    if (/[a-zA-Z]/.test(ch)) b = (all[ch] >> --left[ch]) & 1;
    w = ((w << 1) | b) >>> 0;
  }
  return { w, f: all };
}

interface Gen {
  code: number[];
  in: Map<string, bigint>;
}

interface Form {
  name: string;
  count: number;
  /** Returns undefined to reject the draw (the generator retries). */
  gen(r: Rng, seed: bigint): Gen | undefined;
}

const reg = (n: number) => (n === 31 ? "sp" : `x${n}`);

/** Puts edge values into some of the named source registers (31 = ZR/SP left alone). */
function edges(r: Rng, m: Map<string, bigint>, regs: number[]) {
  for (const n of regs) if (n !== 31 && r.chance(0.4)) m.set(`x${n}`, r.pick(EDGES));
}

/** A plain data-processing form: random fields, edge values in `src` registers. */
function dp(name: string, pat: string, count: number, opts: { src?: string; fix?: (r: Rng) => Fields; ok?: (f: Fields) => boolean } = {}): Form {
  const src = opts.src ?? "nma";
  return {
    name,
    count,
    gen(r) {
      const { w, f } = enc(r, pat, opts.fix?.(r) ?? {});
      if (opts.ok && !opts.ok(f)) return undefined;
      const m = new Map<string, bigint>();
      edges(r, m, [...src].filter((l) => l in f).map((l) => f[l]));
      return { code: [w], in: m };
    },
  };
}

// Data processing, immediate.
const dpImm: Form[] = [
  dp("adr", "0ii10000iiiiiiiiiiiiiiiiiiiddddd", 100),
  dp("adrp", "1ii10000iiiiiiiiiiiiiiiiiiiddddd", 100),
  // Bit 23 = 1 is ADDG/SUBG (MTE), which the M4 lacks too; keep it for UNDEFINED coverage.
  dp("addsub_imm", "zoS10001hhiiiiiiiiiiiinnnnnddddd", 400, { fix: (r) => ({ h: r.chance(0.9) ? r.int(2) : r.range(2, 3) }) }),
  dp("logical_imm", "zoo100100Nrrrrrrssssssnnnnnddddd", 500),
  dp("movewide", "zoo100101hhiiiiiiiiiiiiiiiiddddd", 300, { src: "d" }),
  dp("bitfield", "zoo100110Nrrrrrrssssssnnnnnddddd", 600, {
    src: "nd",
    // Mostly valid field combinations, so the semantics get the coverage.
    fix: (r): Fields => {
      const z = r.int(2);
      return r.chance(0.9) ? { z, N: z, r: r.int(32 << z), s: r.int(32 << z) } : { z };
    },
  }),
  dp("extr", "z00100111N0mmmmmssssssnnnnnddddd", 200, {
    fix: (r): Fields => {
      const z = r.int(2);
      return r.chance(0.9) ? { z, N: z, s: r.int(32 << z) } : { z };
    },
  }),
];

// Data processing, register.
const OPC2 = [0b000010, 0b000011, 0b001000, 0b001001, 0b001010, 0b001011, 0b010000, 0b010001, 0b010010, 0b010011, 0b010100, 0b010101, 0b010110, 0b010111];
const dpReg: Form[] = [
  dp("logical_shift", "zoo01010hhNmmmmmiiiiiinnnnnddddd", 400),
  dp("addsub_shift", "zoS01011hh0mmmmmiiiiiinnnnnddddd", 400),
  dp("addsub_ext", "zoS01011001mmmmmxxxiiinnnnnddddd", 400, { fix: (r) => ({ i: r.chance(0.9) ? r.int(5) : r.range(5, 7) }) }),
  dp("adcsbc", "zoS11010000mmmmm000000nnnnnddddd", 200),
  dp("ccmp", "zo111010010mmmmmcccck0nnnnn0ffff", 300),
  dp("csel", "zo011010100mmmmmcccc0knnnnnddddd", 300),
  dp("dp2", "z0011010110mmmmmoooooonnnnnddddd", 600, { fix: (r) => ({ o: r.pick(OPC2) }) }),
  dp("dp1", "z101101011000000oooooonnnnnddddd", 300, { fix: (r) => ({ o: r.int(6) }) }),
  dp("dp3", "z0011011ooommmmmxaaaaannnnnddddd", 500, {
    fix: (r): Fields => {
      const [o, x, a, z] = r.pick([[0, -1, -1, -1], [1, -1, -1, 1], [2, 0, 31, 1], [5, -1, -1, 1], [6, 0, 31, 1]] as const);
      const f: Fields = { o };
      if (x >= 0) f.x = x;
      if (a >= 0) f.a = a;
      if (z >= 0) f.z = z;
      return f;
    },
  }),
];

// Branches: a branch at index 0, markers after it, forward targets only.
const MOVZ = (rd: number, imm: number) => (0xd2800000 | (imm << 5) | rd) >>> 0;
const MARK = 9; // x9 records which marker ran last

function branchForm(name: string, count: number, make: (r: Rng, disp: number, m: Map<string, bigint>) => number | undefined): Form {
  return {
    name,
    count,
    gen(r) {
      const k = r.range(1, 3); // markers after the branch
      const target = r.range(1, k + 1); // instruction index; k + 1 is the end marker
      const m = new Map<string, bigint>();
      const w = make(r, target, m);
      if (w === undefined) return undefined;
      const code = [w];
      for (let i = 1; i <= k; i++) code.push(MOVZ(MARK, i));
      return { code, in: m };
    },
  };
}

const imm = (v: number, bits: number) => v & ((1 << bits) - 1);
const branches: Form[] = [
  branchForm("b", 50, (r, t) => (0x14000000 | imm(t, 26)) >>> 0),
  branchForm("bl", 50, (r, t) => (0x94000000 | imm(t, 26)) >>> 0),
  branchForm("bcond", 400, (r, t) => (0x54000000 | (imm(t, 19) << 5) | r.int(16)) >>> 0),
  branchForm("cbz", 300, (r, t, m) => {
    const w = enc(r, "z011010oiiiiiiiiiiiiiiiiiiittttt", { i: imm(t, 19) });
    if (w.f.t !== 31) m.set(`x${w.f.t}`, r.chance(0.5) ? r.pick([0n, 1n << 32n, 0xffffffffn]) : r.u64());
    return w.w;
  }),
  branchForm("tbz", 300, (r, t, m) => {
    const w = enc(r, "b011011obbbbbiiiiiiiiiiiiiittttt", { i: imm(t, 14) });
    if (w.f.t !== 31 && r.chance(0.5)) m.set(`x${w.f.t}`, r.u64() ^ (r.chance(0.5) ? 1n << BigInt(w.f.b) : 0n));
    return w.w;
  }),
  branchForm("br_blr_ret", 200, (r, t, m) => {
    const n = r.int(31); // not 31: that would branch to 0
    m.set(`x${n}`, CODE + BigInt(4 * t));
    return (r.pick([0xd61f0000, 0xd63f0000, 0xd65f0000]) | (n << 5)) >>> 0;
  }),
];

// Loads and stores. Accesses stay inside the data region. SP as a base must be
// 16-byte aligned (Linux sets SCTLR_EL1.SA0).
interface Addr {
  /** Base register value. */
  base: bigint;
  /** The access address. */
  addr: bigint;
}

/** Picks base so that base + off (or base, post-index) lands in the region with `span` bytes and `align`. */
function place(r: Rng, n: number, off: bigint, span: number, align: number, post = false): Addr | undefined {
  const slots = Math.floor((DATA_SIZE - span) / align);
  let addr = DATA + BigInt(r.int(slots + 1) * align);
  let base = post ? addr : addr - off;
  if (n === 31) {
    base &= ~15n;
    addr = post ? base : base + off;
    if (addr < DATA || addr + BigInt(span) > DATA + BigInt(DATA_SIZE) || addr % BigInt(align)) return undefined;
  }
  return { base: base & M64, addr };
}

const sext = (v: number, bits: number) => BigInt.asIntN(bits, BigInt(v));

function extendReg(v: bigint, option: number, sh: number): bigint {
  const t = [0xffn, 0xffffn, 0xffffffffn, M64][option & 3];
  let x = v & t;
  if (option & 4) x = BigInt.asIntN([8, 16, 32, 64][option & 3], x) & M64;
  return (x << BigInt(sh)) & M64;
}

/** Single-register load/store in one addressing mode. */
function single(name: string, pat: string, count: number, offset: (f: Fields, r: Rng, m: Map<string, bigint>) => { off: bigint; wb?: "pre" | "post" } | undefined): Form {
  return {
    name,
    count,
    gen(r) {
      const { w, f } = enc(r, pat);
      const m = new Map<string, bigint>();
      edges(r, m, [f.t]);
      const o = offset(f, r, m);
      if (!o) return undefined;
      if (o.wb && f.n !== 31 && f.n === f.t) return undefined; // writeback with Rn == Rt: CONSTRAINED UNPREDICTABLE
      const p = place(r, f.n, o.off, 1 << f.s, 1, o.wb === "post");
      if (!p) return undefined;
      m.set(reg(f.n), p.base);
      return { code: [w], in: m };
    },
  };
}

const ldst: Form[] = [
  single("ldst_uimm", "ss111001ooiiiiiiiiiiiinnnnnttttt", 500, (f) => ({ off: BigInt(f.i) << BigInt(f.s) })),
  single("ldst_unscaled", "ss111000oo0iiiiiiiii00nnnnnttttt", 400, (f) => ({ off: sext(f.i, 9) })),
  single("ldst_unpriv", "ss111000oo0iiiiiiiii10nnnnnttttt", 300, (f) => ({ off: sext(f.i, 9) })),
  single("ldst_pre", "ss111000oo0iiiiiiiii11nnnnnttttt", 400, (f) => ({ off: sext(f.i, 9), wb: "pre" })),
  single("ldst_post", "ss111000oo0iiiiiiiii01nnnnnttttt", 400, (f) => ({ off: sext(f.i, 9), wb: "post" })),
  single("ldst_reg", "ss111000oo1mmmmmxxxS10nnnnnttttt", 600, (f, r, m) => {
    if (f.m === f.n) return undefined;
    // Small index in the extended bits, random garbage above them (UXTW/SXTW ignore it).
    const idx = BigInt(r.range(-64, 64)) & M64;
    const v = (f.x & 3) === 3 ? idx : (idx & 0xffffffffn) | (r.u64() & 0xffffffff00000000n);
    if (f.m !== 31) m.set(`x${f.m}`, v);
    return { off: extendReg(f.m === 31 ? 0n : v, f.x, f.S ? f.s : 0) };
  }),
  {
    name: "ldr_literal",
    count: 200,
    gen(r) {
      // Targets inside the code page, whatever the harness left there (zeros and the end marker).
      const opc = r.int(4);
      const target = r.int(1022) * 4;
      const { w } = enc(r, "oo011000iiiiiiiiiiiiiiiiiiittttt", { o: opc, i: imm(target / 4, 19) });
      return { code: [w], in: new Map() };
    },
  },
  {
    name: "ldst_pair",
    count: 800,
    gen(r) {
      const { w, f } = enc(r, "oo10100ppLiiiiiiiuuuuunnnnnttttt");
      if (f.L && f.t === f.u) return undefined; // LDP Rt == Rt2
      const wb = f.p === 1 ? "post" : f.p === 3 ? "pre" : undefined;
      if (wb && f.n !== 31 && (f.n === f.t || f.n === f.u)) return undefined;
      const size = f.o === 2 ? 8 : 4;
      const m = new Map<string, bigint>();
      edges(r, m, [f.t, f.u]);
      const p = place(r, f.n, sext(f.i, 7) * BigInt(size), 2 * size, 1, wb === "post");
      if (!p) return undefined;
      m.set(reg(f.n), p.base);
      return { code: [w], in: m };
    },
  },
];

// SIMD&FP loads and stores. z (size) and o (opc<1>) pick B/H/S/D/Q; o with z != 0 is reserved.
const fpBytes = (f: Fields) => (f.o ? (f.z === 0 ? 16 : 0) : 1 << f.z);

/** A SIMD&FP single-register form: `offset` gives the offset from the base for the access. */
function fpSingle(name: string, pat: string, count: number, offset: (f: Fields, bytes: number, r: Rng, m: Map<string, bigint>) => { off: bigint; wb?: "pre" | "post" } | undefined): Form {
  return {
    name,
    count,
    gen(r) {
      // Mostly valid sizes; the reserved ones stay for UNDEFINED coverage.
      const q = r.int(5) === 0 ? 1 : 0;
      const { w, f } = enc(r, pat, r.chance(0.95) ? { o: q, z: q ? 0 : r.int(4) } : {});
      const bytes = fpBytes(f) || 16;
      const m = new Map<string, bigint>();
      const o = offset(f, bytes, r, m);
      if (!o) return undefined;
      const p = place(r, f.n, o.off, bytes, 1, o.wb === "post");
      if (!p) return undefined;
      m.set(reg(f.n), p.base);
      return { code: [w], in: m };
    },
  };
}

/** Structure load/store: base anywhere with room for 64 bytes; `post` also sets Rm. */
function structure(name: string, pat: string, count: number, fix: (r: Rng) => Fields): Form {
  return {
    name,
    count,
    gen(r) {
      const { w, f } = enc(r, pat, fix(r));
      const m = new Map<string, bigint>();
      if (!base(r, m, f.n, 64, 1)) return undefined;
      if ("m" in f && f.m !== 31) {
        if (f.m === f.n) return undefined;
        m.set(`x${f.m}`, BigInt(r.range(-64, 64)) & M64);
      }
      return { code: [w], in: m };
    },
  };
}

const MULT_OPC = [0b0000, 0b0010, 0b0100, 0b0110, 0b0111, 0b1000, 0b1010];
const multOpc = (r: Rng): Fields => ({ o: r.chance(0.95) ? r.pick(MULT_OPC) : r.int(16) });
// Single structure: opcode 15:13 and S; 11x is LDnR for loads (S = 0) and reserved for stores.
// Mostly valid sizes per scale: 1 needs size<0> = 0, 2 needs size 0 (S) or 1 (D, S = 0).
function sngl(r: Rng): Fields {
  if (!r.chance(0.8)) return { o: r.range(6, 7), S: r.chance(0.9) ? 0 : 1 };
  const o = r.int(6);
  if (!r.chance(0.9)) return { o };
  const S = r.int(2);
  return [{ o }, { o, z: 2 * r.int(2) }, S ? { o, S, z: 0 } : { o, S, z: r.int(2) }][o >> 1];
}

const ldstFp: Form[] = [
  fpSingle("fp_uimm", "zz111101oLiiiiiiiiiiiinnnnnttttt", 400, (f, b) => ({ off: BigInt(f.i * b) })),
  fpSingle("fp_unscaled", "zz111100oL0iiiiiiiii00nnnnnttttt", 300, (f) => ({ off: sext(f.i, 9) })),
  fpSingle("fp_pre", "zz111100oL0iiiiiiiii11nnnnnttttt", 300, (f) => ({ off: sext(f.i, 9), wb: "pre" })),
  fpSingle("fp_post", "zz111100oL0iiiiiiiii01nnnnnttttt", 300, (f) => ({ off: sext(f.i, 9), wb: "post" })),
  fpSingle("fp_reg", "zz111100oL1mmmmmxxxS10nnnnnttttt", 400, (f, b, r, m) => {
    if (!(f.x & 2) && r.chance(0.9)) return undefined; // option<1> = 0 is reserved: keep a few
    if (f.m === f.n) return undefined;
    const idx = BigInt(r.range(-64, 64)) & M64;
    const v = (f.x & 3) === 3 ? idx : (idx & 0xffffffffn) | (r.u64() & 0xffffffff00000000n);
    if (f.m !== 31) m.set(`x${f.m}`, v);
    return { off: extendReg(f.m === 31 ? 0n : v, f.x, f.S ? Math.log2(b) : 0) };
  }),
  {
    name: "fp_literal",
    count: 100,
    gen(r) {
      const target = r.int(1020) * 4;
      const { w } = enc(r, "oo011100iiiiiiiiiiiiiiiiiiittttt", { o: r.chance(0.95) ? r.int(3) : 3, i: imm(target / 4, 19) });
      return { code: [w], in: new Map() };
    },
  },
  {
    name: "fp_pair",
    count: 500,
    gen(r) {
      const { w, f } = enc(r, "oo10110ppLiiiiiiiuuuuunnnnnttttt", { o: r.chance(0.95) ? r.int(3) : 3 });
      if (f.L && f.t === f.u) return undefined; // LDP Rt == Rt2
      const wb = f.p === 1 ? "post" : f.p === 3 ? "pre" : undefined;
      const size = 4 << Math.min(f.o, 2);
      const m = new Map<string, bigint>();
      const p = place(r, f.n, sext(f.i, 7) * BigInt(size), 2 * size, 1, wb === "post");
      if (!p) return undefined;
      m.set(reg(f.n), p.base);
      return { code: [w], in: m };
    },
  },
  structure("vec_mult", "0Q0011000L000000oooozznnnnnttttt", 400, multOpc),
  structure("vec_mult_post", "0Q0011001L0mmmmmoooozznnnnnttttt", 400, multOpc),
  structure("vec_single", "0Q0011010LR00000oooSzznnnnnttttt", 500, sngl),
  structure("vec_single_post", "0Q0011011LRmmmmmoooSzznnnnnttttt", 500, sngl),
];

// AdvSIMD and FP moves. ftype 3 (half precision) is left out: the M4 has FEAT_FP16, we don't.
const noHalf = (f: Fields) => f.y !== 3;
const simdMove: Form[] = [
  dp("dup_elt_scalar", "01011110000iiiii000001nnnnnddddd", 100, { src: "" }),
  dp("dup_elt", "0Q001110000iiiii000001nnnnnddddd", 200, { src: "" }),
  dp("dup_gen", "0Q001110000iiiii000011nnnnnddddd", 200, { src: "n" }),
  dp("smov", "0Q001110000iiiii001011nnnnnddddd", 200, { src: "" }),
  dp("umov", "0Q001110000iiiii001111nnnnnddddd", 200, { src: "" }),
  dp("ins_gen", "01001110000iiiii000111nnnnnddddd", 200, { src: "n" }),
  dp("ins_elt", "01101110000iiiii0jjjj1nnnnnddddd", 200, { src: "" }),
  dp("movi", "0Qo0111100000abcmmmm01defghddddd", 500, { src: "" }),
  dp("fmov_gen", "z0011110yy10r11o000000nnnnnddddd", 300, {
    src: "n",
    ok: noHalf,
    // Mostly the valid sf/ftype/rmode combinations: W<->S, X<->D, X<->V.D[1].
    fix: (r): Fields => {
      if (!r.chance(0.9)) return {};
      const [z, y, rm] = r.pick([[0, 0, 0], [1, 1, 0], [1, 2, 1]]);
      return { z, y, r: rm };
    },
  }),
  dp("fmov_reg", "00011110yy100000010000nnnnnddddd", 100, { src: "", ok: noHalf, fix: (r): Fields => (r.chance(0.9) ? { y: r.int(2) } : {}) }),
  dp("fmov_imm", "00011110yy1iiiiiiii10000000ddddd", 100, { src: "", ok: noHalf, fix: (r): Fields => (r.chance(0.9) ? { y: r.int(2) } : {}) }),
];

// AdvSIMD integer. Vector sources get edge values lane by lane; shift-by-register
// operands get small signed shift counts in their low byte. Only v8.0 encodings:
// the M4 also runs RDM (SQRDMLAH), DotProd, FCMA, I8MM and the crypto
// instructions, which we leave UNDEFINED.
function laneEdges(esize: number): bigint[] {
  const e = BigInt(esize);
  const ones = (1n << e) - 1n, smin = 1n << (e - 1n), smax = smin - 1n;
  return [0n, 1n, 2n, ones, ones - 1n, smax, smin, smin + 1n, smax - 1n];
}

/** A random 128-bit value built from `esize`-bit lanes, many of them edge values. */
function vlanes(r: Rng, esize: number, lane: (r: Rng) => bigint = (r) => r.pick(laneEdges(esize))): bigint {
  let v = 0n;
  const mask = (1n << BigInt(esize)) - 1n;
  for (let k = 0; k < 128 / esize; k++) {
    const x = r.chance(0.5) ? lane(r) : r.u64() & mask;
    v |= (x & mask) << BigInt(k * esize);
  }
  return v;
}

/** Shift counts for SSHL & co: small signed values in each lane's low byte, garbage above. */
const shiftLane = (esize: number) => (r: Rng) => (r.u64() & ~0xffn) | (BigInt(r.range(-esize - 2, esize + 2)) & 0xffn);

interface VOpts {
  fix?: (r: Rng) => Fields;
  ok?: (f: Fields) => boolean;
  /** Letters of vector source registers (default n, m and d). */
  src?: string;
  /** Lane size for the edge values (default 8 << z). */
  esize?: (f: Fields) => number;
  /** A letter whose register holds shift counts. */
  shift?: string;
}

function vform(name: string, pat: string, count: number, o: VOpts = {}): Form {
  return {
    name,
    count,
    gen(r) {
      const { w, f } = enc(r, pat, o.fix?.(r) ?? {});
      if (o.ok && !o.ok(f)) return undefined;
      const esize = o.esize?.(f) ?? 8 << (f.z ?? r.int(4));
      const m = new Map<string, bigint>();
      for (const l of o.src ?? "nmd") {
        if (!(l in f) || !r.chance(0.8)) continue;
        m.set(`v${f[l]}`, vlanes(r, esize, l === o.shift ? shiftLane(esize) : undefined));
      }
      return { code: [w], in: m };
    },
  };
}

const oneOf = (a: number[]) => (r: Rng) => r.pick(a);
const SAME = [...Array(23).keys()]; // 0b11xxx is FP
const SCA_SAME = [1, 5, 6, 7, 8, 9, 10, 11, 16, 17, 22];
const simdSame: Form[] = [
  vform("vec", "0QU01110zz1mmmmmooooo1nnnnnddddd", 1500, { fix: (r) => ({ o: r.chance(0.97) ? r.pick(SAME) : 23 }), shift: "m" }),
  vform("scalar", "01U11110zz1mmmmmooooo1nnnnnddddd", 500, { fix: (r) => ({ o: r.pick(SCA_SAME), z: r.chance(0.7) ? 3 : r.int(3) }), shift: "m" }),
  vform("across", "0QU01110zz11000ooooo10nnnnnddddd", 300, {
    fix: (r): Fields => {
      const o = r.pick([0b00011, 0b01010, 0b11010, 0b11011]);
      if (!r.chance(0.9)) return { o };
      const z = r.int(3);
      return z === 2 ? { o, z, Q: 1 } : { o, z };
    },
  }),
  vform("addp_scalar", "01011110zz110001101110nnnnnddddd", 50, { fix: (r) => ({ z: r.chance(0.9) ? 3 : r.int(3) }) }),
];

// Three different: size 3 with PMULL is the 64-bit crypto form (M6.5).
const simdDiff: Form[] = [
  vform("vec", "0QU01110zz1mmmmmoooo00nnnnnddddd", 1200, {
    fix: (r): Fields => {
      const o = r.int(15);
      if (!r.chance(0.9)) return { o };
      // Valid: U=0 for the SQDM* (9, 11, 13) and PMULL (14, size 0) opcodes; size < 3.
      const U = [9, 11, 13, 14].includes(o) ? 0 : r.int(2);
      return { o, U, z: o === 14 ? 0 : [9, 11, 13].includes(o) ? 1 + r.int(2) : r.int(3) };
    },
    ok: (f) => !(f.o === 14 && f.z === 3 && !f.U),
  }),
  vform("scalar", "01011110zz1mmmmm1oo100nnnnnddddd", 200, { fix: (r) => ({ o: r.int(3), z: r.chance(0.9) ? 1 + r.int(2) : 3 * r.int(2) }) }),
  // By element: only the integer opcodes (FP, SDOT/UDOT, SQRDMLAH/SH and FCMLA share the space).
  vform("elem", "0QU01111zzLMmmmmooooH0nnnnnddddd", 1000, {
    fix: (r): Fields => {
      const U = r.int(2);
      return { U, o: r.pick(U ? [0, 2, 4, 6, 10] : [2, 3, 6, 7, 8, 10, 11, 12, 13]), z: r.chance(0.9) ? 1 + r.int(2) : 3 * r.int(2) };
    },
  }),
  vform("elem_scalar", "01011111zzLMmmmmooooH0nnnnnddddd", 300, {
    fix: (r) => ({ o: r.pick([3, 7, 11, 12, 13]), z: r.chance(0.9) ? 1 + r.int(2) : 3 * r.int(2) }),
  }),
];

const MISC_S = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 18, 20];
const MISC_U = [0, 2, 3, 4, 5, 6, 7, 8, 9, 11, 18, 19, 20];
const simdMisc: Form[] = [
  vform("vec", "0QU01110zz10000ooooo10nnnnnddddd", 1200, {
    fix: (r): Fields => {
      const U = r.int(2);
      return { U, o: r.pick(U ? MISC_U : MISC_S) };
    },
  }),
  vform("scalar", "01U11110zz10000ooooo10nnnnnddddd", 400, {
    fix: (r): Fields => {
      const U = r.int(2);
      return { U, o: r.pick(U ? [3, 7, 8, 9, 11, 18, 20] : [3, 7, 8, 9, 10, 11, 20]) };
    },
  }),
];

// Shift by immediate: immh (h) = 0 is the modified-immediate group. 11100/11111 are FP.
const immhEsize = (f: Fields) => 8 << (31 - Math.clz32(f.h));
/** immh for a lane size below 8 << `sizes` (90%), or any nonzero immh. */
const immh = (r: Rng, sizes: number) => {
  if (!r.chance(0.9)) return r.range(1, 15);
  const k = r.int(sizes);
  return (1 << k) | r.int(1 << k);
};
const simdShift: Form[] = [
  vform("vec", "0QU011110hhhhbbbooooo1nnnnnddddd", 1500, {
    fix: (r): Fields => {
      const U = r.int(2);
      const o = r.pick(U ? [0, 2, 4, 6, 8, 10, 12, 14, 16, 17, 18, 19, 20] : [0, 2, 4, 6, 10, 14, 16, 17, 18, 19, 20]);
      return { U, o, h: immh(r, o >= 16 ? 3 : 4) };
    },
    esize: immhEsize,
  }),
  vform("scalar", "01U111110hhhhbbbooooo1nnnnnddddd", 600, {
    fix: (r): Fields => {
      const U = r.int(2);
      const o = r.pick(U ? [0, 2, 4, 6, 8, 10, 12, 14, 16, 17, 18, 19] : [0, 2, 4, 6, 10, 14, 18, 19]);
      // Scalar: 64-bit lanes only, except SQSHL/UQSHL/SQSHLU (any) and the narrowing forms (not 64).
      const k = o >= 16 ? r.int(3) : o === 12 || o === 14 ? r.int(4) : 3;
      return { U, o, h: r.chance(0.9) ? (1 << k) | r.int(1 << k) : r.range(1, 15) };
    },
    esize: immhEsize,
  }),
];

const simdPerm: Form[] = [
  vform("zip_uzp_trn", "0Q001110zz0mmmmm0ooo10nnnnnddddd", 500, { fix: (r) => ({ o: r.pick([1, 2, 3, 5, 6, 7]) }) }),
  vform("ext", "0Q101110000mmmmm0iiii0nnnnnddddd", 200, { esize: () => 8 }),
  {
    name: "tbl_tbx",
    count: 400,
    gen(r) {
      const { w, f } = enc(r, "0Q001110000mmmmm0LLo00nnnnnddddd");
      // Indices mostly inside the table (16 bytes per register), some past it.
      const m = new Map<string, bigint>();
      m.set(`v${f.m}`, vlanes(r, 8, (r) => BigInt(r.int(16 * (f.L + 1) + 8))));
      return { code: [w], in: m };
    },
  },
];

// Scalar floating point. Operands are FP edge values in lane 0 (random bits
// above), FPCR has a random rounding mode, FZ, DN and AHP, and FPSR sometimes
// starts with flags set. ftype 3 (half precision arithmetic) is FEAT_FP16,
// which the M4 has and we don't, so it only appears where v8.0 allows it (FCVT).
interface FpFmt {
  e: number;
  f: number;
}
const FS: FpFmt = { e: 8, f: 23 }, FD: FpFmt = { e: 11, f: 52 }, FH: FpFmt = { e: 5, f: 10 };
const fpFmt = (y: number) => [FS, FD, FS, FH][y];

/** An interesting value in format `t`, as bits. */
function fpVal(r: Rng, t: FpFmt): bigint {
  const E = BigInt(t.e), F = BigInt(t.f);
  const bias = (1n << (E - 1n)) - 1n;
  const expOnes = (1n << E) - 1n;
  const sign = r.chance(0.5) ? 1n << (E + F) : 0n;
  const frac = () => r.u64() & ((1n << F) - 1n);
  const num = (exp: bigint, fr: bigint) => sign | (exp << F) | fr;
  switch (r.int(12)) {
    case 0: return sign; // zero
    case 1: return num(expOnes, 0n); // infinity
    case 2: return num(expOnes, (1n << (F - 1n)) | frac()); // QNaN
    case 3: return num(expOnes, (frac() >> 1n) | 1n); // SNaN
    case 4: return num(0n, r.chance(0.3) ? r.pick([1n, (1n << F) - 1n]) : frac() | 1n); // denormal
    case 5: return num(r.pick([1n, 2n, expOnes - 1n]), r.chance(0.5) ? frac() : r.pick([0n, (1n << F) - 1n])); // extremes
    case 6: return num(bias + BigInt(r.range(-2, 2)), frac()); // near 1
    case 7: {
      // Near an integer or an int32/int64/uint boundary (for conversions and FRINT).
      const e = BigInt(r.pick([0, 1, 2, 22, 23, 30, 31, 32, 52, 62, 63, 64]));
      const fr = e >= F ? r.int(4) === 0 ? 0n : frac() : ((BigInt(r.int(8)) << (F - e)) | (r.chance(0.5) ? 1n << (F - e - 1n) : 0n)) & ((1n << F) - 1n);
      return num(bias + e > expOnes - 1n ? expOnes - 1n : bias + e, fr);
    }
    case 8: {
      // Short mantissas, so some results are exact.
      const e = bias + BigInt(r.range(-40, 40));
      return num(e < 1n ? 1n : e > expOnes - 1n ? expOnes - 1n : e, frac() & ~((1n << (F / 2n)) - 1n));
    }
    default: return num(BigInt(r.range(1, Number(expOnes) - 1)), frac());
  }
}

/** Sets lane 0 of V[n] to an FP value of `t` (the rest random). */
function setFp(r: Rng, m: Map<string, bigint>, n: number, t: FpFmt) {
  const bits = BigInt(1 + t.e + t.f);
  const hi = (r.u64() | (r.u64() << 64n)) & ~((1n << bits) - 1n) & ((1n << 128n) - 1n);
  m.set(`v${n}`, hi | fpVal(r, t));
}

/** Random FPCR (RMode, FZ, DN, AHP) and sometimes a nonzero FPSR. */
function fpEnv(r: Rng, m: Map<string, bigint>) {
  let fpcr = BigInt(r.int(4)) << 22n;
  if (r.chance(0.25)) fpcr |= 1n << 24n; // FZ
  if (r.chance(0.25)) fpcr |= 1n << 25n; // DN
  if (r.chance(0.25)) fpcr |= 1n << 26n; // AHP
  if (fpcr) m.set("fpcr", fpcr);
  if (r.chance(0.2)) m.set("fpsr", r.u64() & 0x0800009fn);
}

function fpForm(name: string, pat: string, count: number, o: { fix?: (r: Rng) => Fields; ok?: (f: Fields) => boolean; fmt?: (f: Fields) => FpFmt; fp?: string; x?: string } = {}): Form {
  return {
    name,
    count,
    gen(r) {
      const { w, f } = enc(r, pat, o.fix?.(r) ?? {});
      if (o.ok && !o.ok(f)) return undefined;
      const m = new Map<string, bigint>();
      const t = o.fmt?.(f) ?? fpFmt(f.y ?? 0);
      for (const l of o.fp ?? "nma") if (l in f) setFp(r, m, f[l], t);
      for (const l of o.x ?? "") if (l in f && f[l] !== 31) m.set(`x${f[l]}`, r.chance(0.5) ? r.pick(EDGES) : r.u64() >> BigInt(r.int(64)));
      fpEnv(r, m);
      return { code: [w], in: m };
    },
  };
}

const fty = (r: Rng) => (r.chance(0.95) ? r.int(2) : 2); // S or D; 2 is unallocated
const DP1 = [1, 2, 3, 8, 9, 10, 11, 12, 14, 15]; // FABS FNEG FSQRT FRINT{N,P,M,Z,A,X,I}
const fpScalar: Form[] = [
  fpForm("dp2", "00011110yy1mmmmmoooo10nnnnnddddd", 1500, { fix: (r) => ({ y: fty(r), o: r.int(9) }) }),
  fpForm("dp1", "00011110yy1oooooo10000nnnnnddddd", 900, { fix: (r) => ({ y: fty(r), o: r.pick(DP1) }) }),
  fpForm("fcvt", "00011110yy10001oo10000nnnnnddddd", 500, {
    // S, D and H in both directions; the same type or type 2 is unallocated,
    // except D to type 2, which is BFCVT (FEAT_BF16: the M4 has it, we don't).
    fix: (r) => (r.chance(0.95) ? { y: r.pick([0, 1, 3]), o: r.pick([0, 1, 3]) } : { y: r.pick([0, 3]), o: 2 }),
  }),
  fpForm("dp3", "00011111yyAmmmmmBaaaaannnnnddddd", 1200, { fix: (r) => ({ y: fty(r) }) }),
  fpForm("fcmp", "00011110yy1mmmmm001000nnnnnEZ000", 500, { fix: (r): Fields => (r.chance(0.3) ? { y: fty(r), Z: 1, m: 0 } : { y: fty(r), Z: 0 }) }),
  fpForm("fccmp", "00011110yy1mmmmmcccc01nnnnnEffff", 400, { fix: (r) => ({ y: fty(r) }) }),
  fpForm("fcsel", "00011110yy1mmmmmcccc11nnnnnddddd", 200, { fix: (r) => ({ y: fty(r) }) }),
  fpForm("fp_to_int", "z0011110yy1rrooo000000nnnnnddddd", 1200, {
    fix: (r): Fields => {
      const [rr, o] = r.pick([[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1], [3, 0], [3, 1], [0, 4], [0, 5]]);
      return { y: fty(r), r: rr, o };
    },
    fp: "n",
  }),
  fpForm("int_to_fp", "z0011110yy10001o000000nnnnnddddd", 500, { fix: (r) => ({ y: fty(r) }), fp: "", x: "n" }),
  fpForm("fixed", "z0011110yy0rrooossssssnnnnnddddd", 800, {
    fix: (r): Fields => {
      const [rr, o] = r.pick([[0, 2], [0, 3], [3, 0], [3, 1]]);
      const z = r.int(2);
      return { y: fty(r), r: rr, o, z, s: r.chance(0.95) ? r.range(z ? 0 : 32, 63) : r.int(32) };
    },
    fp: "n",
    x: "n",
  }),
];

// AdvSIMD floating point: FP edge values in every lane (sz picks single or
// double). Only v8.0 encodings: the M4 also runs FEAT_FHM (FMLAL), FRINTTS,
// BF16 and FP16 in this space.
function vfpForm(name: string, pat: string, count: number, combos: [number, number, number][], o: { fmt?: (f: Fields) => FpFmt; fix?: (r: Rng) => Fields } = {}): Form {
  return {
    name,
    count,
    gen(r) {
      const [U, a, op] = r.pick(combos);
      const fx: Fields = { U, a, o: op, ...(o.fix?.(r) ?? {}) };
      if (!("z" in fx)) fx.z = r.int(2);
      if (!("Q" in fx) && fx.z && r.chance(0.9)) fx.Q = 1; // doubles need Q (mostly)
      const { w, f } = enc(r, pat, fx);
      const t = o.fmt?.(f) ?? (f.z ? FD : FS);
      const m = new Map<string, bigint>();
      for (const l of "nmd") {
        if (!(l in f)) continue;
        let v = 0n;
        const b = 1 + t.e + t.f;
        for (let k = 0; k < 128 / b; k++) v |= fpVal(r, t) << BigInt(k * b);
        m.set(`v${f[l]}`, v);
      }
      fpEnv(r, m);
      return { code: [w], in: m };
    },
  };
}

const combos = (u: number, a: number, ops: number[]) => ops.map((o) => [u, a, o] as [number, number, number]);
const simdFp: Form[] = [
  vfpForm("vec_same", "0QU01110az1mmmmmooooo1nnnnnddddd", 2000, [
    ...combos(0, 0, [24, 25, 26, 27, 28, 30, 31]),
    ...combos(0, 1, [24, 25, 26, 30, 31]),
    ...combos(1, 0, [24, 26, 27, 28, 29, 30, 31]),
    ...combos(1, 1, [24, 26, 28, 29, 30]),
  ]),
  vfpForm("scalar_same", "01U11110az1mmmmmooooo1nnnnnddddd", 600, [
    ...combos(0, 0, [27, 28, 31]),
    [0, 1, 31],
    ...combos(1, 0, [28, 29]),
    ...combos(1, 1, [26, 28, 29]),
  ]),
  vfpForm("vec_misc", "0QU01110az10000ooooo10nnnnnddddd", 2000, [
    ...combos(0, 0, [22, 23, 24, 25, 26, 27, 28, 29]),
    ...combos(0, 1, [12, 13, 14, 15, 24, 25, 26, 27, 28, 29]),
    ...combos(1, 0, [22, 24, 25, 26, 27, 28, 29]),
    ...combos(1, 1, [12, 13, 15, 25, 26, 27, 28, 29, 31]),
  ]),
  vfpForm("scalar_misc", "01U11110az10000ooooo10nnnnnddddd", 800, [
    ...combos(0, 0, [26, 27, 28, 29]),
    ...combos(0, 1, [12, 13, 14, 26, 27, 29, 31]),
    ...combos(1, 0, [22, 26, 27, 28, 29]),
    ...combos(1, 1, [12, 13, 26, 27, 29]),
  ]),
  vfpForm("scalar_pair", "01111110az11000ooooo10nnnnnddddd", 300, [...combos(1, 0, [12, 13, 15]), ...combos(1, 1, [12, 15])]),
  vfpForm("across", "0QU01110az11000ooooo10nnnnnddddd", 300, [...combos(1, 0, [12, 15]), ...combos(1, 1, [12, 15])], {
    fix: (r): Fields => (r.chance(0.9) ? { Q: 1, z: 0 } : {}),
  }),
  vfpForm("elem", "0QU011111zLMmmmmooooH0nnnnnddddd", 800, [...combos(0, 0, [1, 5, 9]), [1, 0, 9]]),
  vfpForm("scalar_elem", "01U111111zLMmmmmooooH0nnnnnddddd", 300, [...combos(0, 0, [1, 5, 9]), [1, 0, 9]]),
  vfpForm("fixed", "0QU011110hhhhbbbooooo1nnnnnddddd", 500, [...combos(0, 0, [28, 31]), ...combos(1, 0, [28, 31])], {
    fix: (r): Fields => ({ h: r.chance(0.95) ? r.range(4, 15) : 1, Q: r.chance(0.9) ? 1 : 0 }),
    fmt: (f) => (f.h >= 8 ? FD : FS),
  }),
  vfpForm("scalar_fixed", "01U111110hhhhbbbooooo1nnnnnddddd", 300, [...combos(0, 0, [28, 31]), ...combos(1, 0, [28, 31])], {
    fix: (r): Fields => ({ h: r.chance(0.95) ? r.range(4, 15) : 1 }),
    fmt: (f) => (f.h >= 8 ? FD : FS),
  }),
];

// Exclusives and acquire/release. Always aligned: the architecture requires it,
// but neither oracle faults on misaligned exclusives (recorded in PLAN.md §4.2).
function exclusive(name: string, count: number, make: (r: Rng, m: Map<string, bigint>) => number[] | undefined): Form {
  return { name, count, gen: (r) => {
    const m = new Map<string, bigint>();
    const code = make(r, m);
    return code && { code, in: m };
  } };
}

/** Sets base register `n` to an address aligned to `align`, room for `span` bytes. */
function base(r: Rng, m: Map<string, bigint>, n: number, span: number, align: number): boolean {
  const p = place(r, n, 0n, span, Math.max(align, n === 31 ? 16 : 1));
  if (!p) return false;
  m.set(reg(n), p.base);
  return true;
}

const EXCL = (sz: number, o2: number, L: number, o1: number, s: number, o0: number, u: number, n: number, t: number) =>
  ((sz << 30) | (0b001000 << 24) | (o2 << 23) | (L << 22) | (o1 << 21) | (s << 16) | (o0 << 15) | (u << 10) | (n << 5) | t) >>> 0;

const excl: Form[] = [
  exclusive("ldxr", 200, (r, m) => {
    const [sz, n, t] = [r.int(4), r.int(32), r.int(32)];
    return base(r, m, n, 1 << sz, 1 << sz) ? [EXCL(sz, 0, 1, 0, 31, r.int(2), 31, n, t)] : undefined;
  }),
  exclusive("stxr_alone", 100, (r, m) => {
    // The monitor is open (exception returns clear it), so this fails and stores nothing.
    const [sz, n, t, s] = [r.int(4), r.int(32), r.int(32), r.int(31)];
    if (s === t || s === n) return undefined;
    return base(r, m, n, 1 << sz, 1 << sz) ? [EXCL(sz, 0, 0, 0, s, r.int(2), 31, n, t)] : undefined;
  }),
  exclusive("ldxr_stxr", 400, (r, m) => {
    const [sz, n, t1, t2, s] = [r.int(4), r.int(32), r.int(31), r.int(32), r.int(31)];
    if (t1 === n || s === t2 || s === n) return undefined;
    edges(r, m, [t2]);
    if (!base(r, m, n, 1 << sz, 1 << sz)) return undefined;
    return [EXCL(sz, 0, 1, 0, 31, r.int(2), 31, n, t1), EXCL(sz, 0, 0, 0, s, r.int(2), 31, n, t2)];
  }),
  exclusive("ldxp_stxp", 300, (r, m) => {
    const [z, n, t1, u1, t2, u2, s] = [r.int(2), r.int(32), r.int(31), r.int(31), r.int(32), r.int(32), r.int(31)];
    if (t1 === u1 || t1 === n || u1 === n || s === t2 || s === u2 || s === n) return undefined;
    edges(r, m, [t2, u2]);
    const sz = 2 + z;
    if (!base(r, m, n, 2 << sz, 2 << sz)) return undefined;
    const code = [EXCL(sz, 0, 1, 1, 31, r.int(2), u1, n, t1)];
    if (r.chance(0.8)) code.push(EXCL(sz, 0, 0, 1, s, r.int(2), u2, n, t2));
    return code;
  }),
  exclusive("ldar_stlr", 300, (r, m) => {
    const [sz, n, t, L] = [r.int(4), r.int(32), r.int(32), r.int(2)];
    edges(r, m, [t]);
    return base(r, m, n, 1 << sz, 1 << sz) ? [EXCL(sz, 1, L, 0, 31, 1, 31, n, t)] : undefined;
  }),
  exclusive("clrex", 50, (r, m) => {
    const [sz, n, t1, t2, s] = [3, r.int(32), r.int(31), r.int(32), r.int(31)];
    if (t1 === n || s === t2 || s === n) return undefined;
    if (!base(r, m, n, 8, 8)) return undefined;
    const clrex = (0xd503305f | (r.int(16) << 8)) >>> 0;
    return [EXCL(sz, 0, 1, 0, 31, 0, 31, n, t1), clrex, EXCL(sz, 0, 0, 0, s, 0, 31, n, t2)];
  }),
];

// LSE. Aligned only: the M4 has LSE2 (unaligned atomics inside 16 bytes), which we don't advertise.
/** The value at `addr` in the test's initial memory, `size` bytes, little-endian. */
function memAt(seed: bigint, m: Map<string, bigint>, addr: bigint, size: number): bigint {
  const mem = initialState({ seed, in: m }).mem;
  let v = 0n;
  for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(mem[Number(addr - DATA) + i]);
  return v;
}

const lse: Form[] = [
  {
    name: "cas",
    count: 400,
    gen(r, seed) {
      const { w, f } = enc(r, "zz0010001L1sssssR11111nnnnnttttt");
      const m = new Map<string, bigint>();
      edges(r, m, [f.t]);
      const size = 1 << f.z;
      if (!base(r, m, f.n, size, size)) return undefined;
      // Half the time the compare value matches memory (upper register bits stay random).
      if (f.s !== 31 && f.s !== f.n && r.chance(0.5)) {
        const hi = r.u64() & ~((1n << BigInt(8 * size)) - 1n) & M64;
        m.set(`x${f.s}`, hi | memAt(seed, m, m.get(reg(f.n))!, size));
      }
      return { code: [w], in: m };
    },
  },
  {
    name: "casp",
    count: 300,
    gen(r, seed) {
      const { w, f } = enc(r, "0z0010000L1SSSSSR11111nnnnnttttt", r.chance(0.95) ? { S: 2 * r.int(16), t: 2 * r.int(16) } : {});
      const m = new Map<string, bigint>();
      edges(r, m, [f.t, f.t + 1]);
      const size = 4 << f.z;
      if (!base(r, m, f.n, 2 * size, 2 * size)) return undefined;
      if (f.S < 30 && f.S !== f.n && f.S + 1 !== f.n && r.chance(0.5)) {
        const a = m.get(reg(f.n))!;
        m.set(`x${f.S}`, memAt(seed, m, a, size));
        m.set(`x${f.S + 1}`, memAt(seed, m, a + BigInt(size), size));
      }
      return { code: [w], in: m };
    },
  },
  {
    name: "ldop_swp",
    count: 900,
    gen(r) {
      const { w, f } = enc(r, "zz111000AR1sssssoooo00nnnnnttttt", { o: r.int(9) });
      const m = new Map<string, bigint>();
      edges(r, m, [f.s]);
      const size = 1 << f.z;
      return base(r, m, f.n, size, size) ? { code: [w], in: m } : undefined;
    },
  },
];

// Hints, barriers, NZCV, DC ZVA, BRK, UDF.
// Hint numbers left out: WFE/WFI (2, 3: may sleep), XPACLRI (7) and the PAC
// hints (8-15, 24-31), which change X30/X17 on the M4, and CHKFEAT (40).
const HINTS = Array.from({ length: 128 }, (_, i) => i).filter((i) => ![2, 3, 7, 40].includes(i) && !(i >= 8 && i <= 15) && !(i >= 24 && i <= 31));
const sys: Form[] = [
  { name: "hint", count: 200, gen: (r) => ({ code: [(0xd503201f | (r.pick(HINTS) << 5)) >>> 0], in: new Map() }) },
  {
    name: "barrier",
    count: 100,
    // DSB, DMB, ISB with any CRm (op2 4, 5, 6). SB (op2 7) is left out: the M4 has it and we don't.
    gen: (r) => ({ code: [(0xd503309f | (r.int(16) << 8) | (r.int(3) << 5)) >>> 0], in: new Map() }),
  },
  dp("mrs_msr_nzcv", "1101010100L110110100001000ottttt", 100, { src: "t", fix: () => ({ o: 0 }) }),
  {
    name: "dc_zva",
    count: 50,
    gen(r) {
      const m = new Map<string, bigint>();
      const t = r.int(31);
      m.set(`x${t}`, DATA + BigInt(r.int(DATA_SIZE - 64)));
      return { code: [(0xd50b7420 | t) >>> 0], in: m };
    },
  },
  { name: "brk", count: 20, gen: (r) => ({ code: [(0xd4200000 | (r.int(0x10000) << 5)) >>> 0], in: new Map() }) },
  { name: "udf", count: 20, gen: (r) => ({ code: [r.int(0x10000)], in: new Map() }) },
];

// The v8.0 crypto extensions (M6.5): AES, SHA1, SHA256 and the 64-bit PMULL,
// random full registers; a few reserved sizes and opcodes for UNDEFINED.
const size0 = (r: Rng) => (r.chance(0.95) ? 0 : r.range(1, 3));
const crypto: Form[] = [
  vform("aes", "01001110zz10100001oo10nnnnnddddd", 400, { fix: (r) => ({ z: size0(r) }), esize: () => 8 }),
  vform("sha_3reg", "01011110zz0mmmmm0ooo00nnnnnddddd", 700, { fix: (r) => ({ z: size0(r), o: r.chance(0.97) ? r.int(7) : 7 }), esize: () => 32 }),
  vform("sha_2reg", "01011110zz10100ooooo10nnnnnddddd", 300, { fix: (r) => ({ z: size0(r), o: r.chance(0.95) ? r.int(3) : r.range(3, 31) }), esize: () => 32 }),
  vform("pmull64", "0Q001110111mmmmm111000nnnnnddddd", 300, { esize: () => 64 }),
  // A round and its mix, as compilers emit them (the JIT fuses the pair when the
  // mix reads and writes the round's register), and a fifth with another destination.
  {
    name: "aes_pair",
    count: 300,
    gen(r) {
      const dec = r.int(2);
      const { w, f } = enc(r, `0100111000101000010${dec}10nnnnnddddd`);
      const t = r.chance(0.8) ? f.d : r.int(32);
      const { w: w2 } = enc(r, `0100111000101000011${dec}10nnnnnddddd`, { n: r.chance(0.9) ? f.d : r.int(32), d: t });
      return { code: [w, w2], in: new Map() };
    },
  },
  // SHA-256's four rounds as OpenSSL and Linux write them (the JIT computes
  // the pair once): mov S, A; sha256h A, E, W; sha256h2 E, S, W; and a fifth
  // with one register changed, which the JIT must not fuse.
  {
    name: "sha256_rounds",
    count: 300,
    gen(r) {
      const [A, E, S, W] = [r.int(32), r.int(32), r.int(32), r.int(32)];
      if (new Set([A, E, S, W]).size < 4 && r.chance(0.9)) return undefined;
      const odd = r.chance(0.2) ? r.int(4) : -1;
      const x = (k: number, v: number) => (odd === k ? r.int(32) : v);
      const mov = (0x4ea01c00 | (x(0, A) << 16) | (A << 5) | S) >>> 0; // orr S.16b, A.16b, A.16b
      const h = (0x5e004000 | (W << 16) | (x(1, E) << 5) | A) >>> 0;
      const h2 = (0x5e005000 | (x(3, W) << 16) | (x(2, S) << 5) | E) >>> 0;
      return { code: [mov, h, h2], in: new Map() };
    },
  },
];

export const GROUPS: Record<string, Form[]> = { dp_imm: dpImm, dp_reg: dpReg, branch: branches, ldst, excl, lse, sys, ldst_fp: ldstFp, simd_move: simdMove, simd_same: simdSame, simd_diff: simdDiff, simd_misc: simdMisc, simd_shift: simdShift, simd_perm: simdPerm, fp_scalar: fpScalar, simd_fp: simdFp, crypto };

/** Generates a group's tests (without oracle results). */
export function generate(group: string): Test[] {
  const forms = GROUPS[group];
  if (!forms) throw new Error(`unknown group ${group}`);
  const tests: Test[] = [];
  for (const form of forms) {
    // Seed per form, so changing one form leaves the others' tests alone.
    let h = 0xcbf29ce484222325n;
    for (const ch of `${group}.${form.name}`) h = ((h ^ BigInt(ch.charCodeAt(0))) * 0x100000001b3n) & M64;
    const r = new Rng(h);
    for (let i = 0; i < form.count; ) {
      const seed = r.u64();
      const g = form.gen(r, seed);
      if (!g) continue;
      tests.push({ name: `${group}.${form.name}.${String(i).padStart(4, "0")}`, code: g.code, seed, in: g.in, notes: [] });
      i++;
    }
  }
  return tests;
}
