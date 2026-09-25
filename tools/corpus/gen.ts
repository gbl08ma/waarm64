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

export const GROUPS: Record<string, Form[]> = { dp_imm: dpImm, dp_reg: dpReg, branch: branches, ldst, excl, lse, sys };

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
