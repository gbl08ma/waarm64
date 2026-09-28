// M0.5: wasm kernels shaped like the planned JIT output, one per memory
// layout candidate (bench/spike/memory/REPORT.md). Every guest access does an inline TLB
// lookup; hits access RAM inline, misses call an in-module slow path that
// refills the TLB and performs the access (the planned MMIO/fault path).
import { I32, I64, ModuleBuilder, op, type Limits } from '../wasm.ts';

export const GUEST_VA = 0x4000_0000n;
export const TLB_ENTRIES = 4096; // direct mapped, 16-byte entries
export const TLB_R = 0, TLB_W = TLB_ENTRIES * 16; // read and write TLBs, at the start of the core memory
export const RAM_OFF = 1 << 20; // host offset of guest RAM in its memory (room for core state before it)
export const HIGH_OFF = 2 ** 32 + RAM_OFF; // Dhigh: RAM above 4 GiB in the memory64 memory
/** Tag compare mask: page bits plus the low 3 bits, so misaligned 8-byte accesses miss (bits 3..11 are free). */
const TAG_MASK = ~0xff8n;

/**
 * Named memories every kernel draws from (allocated once by the benchmark):
 * core32: small wasm32 core memory (TLBs); big32: wasm32 with RAM at RAM_OFF;
 * alt0/alt1: wasm32, the two halves of B2's page-interleaved RAM;
 * big64: memory64, core at 0 (layout C), RAM at RAM_OFF and HIGH_OFF.
 */
export type MemName = 'core32' | 'big32' | 'alt0' | 'alt1' | 'big64';

export type Layout = 'A' | 'A2' | 'AB' | 'B1' | 'Bswap' | 'B2' | 'C' | 'D' | 'Dhigh';
/** Memory select with 2 RAM memories (B2, AB): br_table on the entry's memory index, guarded specialization on the first RAM memory, or an accessor-module call. */
export type Select = 'brtable' | 'spec' | 'helper';
/** B2 page placement: all in the first RAM memory (predictable) or alternating per page (unpredictable for random access). */
export type Mapping = 'one' | 'alt';
export type Pattern = 'seq' | 'rand' | 'chase';
export type Kernel = { layout: Layout; select?: Select; mapping?: Mapping; pattern: Pattern; mixed: boolean };

type Plan = { mems: MemName[]; tlb: number; ram: number[]; ramOff: number };

export function plan(k: Kernel): Plan {
  switch (k.layout) {
    case 'A': return { mems: ['big32'], tlb: 0, ram: [0], ramOff: RAM_OFF };
    case 'A2': return { mems: ['big32', 'core32'], tlb: 0, ram: [0], ramOff: RAM_OFF }; // A plus an unused second memory
    // A plus a spill memory: core + RAM in memory 0, more RAM in memory 1 (the NUMA follow-up). spec only.
    case 'AB': return k.mapping === 'alt'
      ? { mems: ['alt0', 'alt1'], tlb: 0, ram: [0, 1], ramOff: RAM_OFF }
      : { mems: ['big32', 'alt1'], tlb: 0, ram: [0, 1], ramOff: RAM_OFF };
    case 'B1': return { mems: ['core32', 'big32'], tlb: 0, ram: [1], ramOff: RAM_OFF };
    case 'Bswap': return { mems: ['big32', 'core32'], tlb: 1, ram: [0], ramOff: RAM_OFF }; // RAM in memory 0, TLB in memory 1
    case 'B2': return k.mapping === 'alt'
      ? { mems: ['core32', 'alt0', 'alt1'], tlb: 0, ram: [1, 2], ramOff: RAM_OFF }
      : { mems: ['core32', 'big32', 'alt1'], tlb: 0, ram: [1, 2], ramOff: RAM_OFF };
    case 'C': return { mems: ['big64'], tlb: 0, ram: [0], ramOff: RAM_OFF };
    case 'D': return { mems: ['core32', 'big64'], tlb: 0, ram: [1], ramOff: RAM_OFF };
    case 'Dhigh': return { mems: ['core32', 'big64'], tlb: 0, ram: [1], ramOff: HIGH_OFF };
  }
}

export const is64 = (m: MemName) => m === 'big64';

/** Where guest VA `va` lives: memory and byte offset (mirrors the slow path's mapping). */
export function hostOf(k: Kernel, va: bigint): [MemName, number] {
  const p = plan(k);
  const rel = Number(va - GUEST_VA);
  if (k.mapping === 'alt') {
    const page = Math.floor(rel / 4096);
    return [page & 1 ? 'alt1' : 'alt0', RAM_OFF + Math.floor(page / 2) * 4096 + (rel & 4095)];
  }
  return [p.mems[p.ram[0]], p.ramOff + rel];
}

export function kernelName(k: Kernel) {
  return [k.layout, k.select, k.mapping, k.pattern, k.mixed ? 'mixed' : 'bare'].filter(Boolean).join('_');
}

/**
 * run(n: i32, seed: i64, mask: i64) -> i64. One iteration is one guest block:
 * mixed: address generation, ldr x1,[va]; ldr x2,[va,#8]; 4 ALU ops; str x4,[va,#16]; loop
 * (13 guest instructions for rand, 9 for chase: about 1 memory op per 3-4 instructions).
 * bare: address generation and one load.
 * rand: independent LCG addresses; seq: 64-byte stride; chase: the next address is the value loaded at [va].
 */
export function buildKernel(k: Kernel, limits: Record<MemName, Limits>): Uint8Array<ArrayBuffer> {
  const P = plan(k);
  const m = new ModuleBuilder();
  const mem64 = P.mems.map(is64);
  const tlb64 = mem64[P.tlb], ram64 = mem64[P.ram[0]];
  const fmt32 = k.layout === 'B2' && k.select !== 'spec'; // entry {tag i64, addend i32, ram index i32}
  const spec = k.select === 'spec';
  const tLd = m.type([I64], [I64]), tSt = m.type([I64, I64], []);
  let hLd = -1, hSt = -1;
  if (k.select === 'helper') {
    hLd = m.importFunc('acc', 'ld', m.type([I32, I32], [I64]));
    hSt = m.importFunc('acc', 'st', m.type([I32, I32, I64], []));
  }
  for (const [i, name] of P.mems.entries()) m.importMemory('env', `m${i}`, limits[name]);

  const load = (mem: number) => op.i64Load(0, mem), store = (mem: number) => op.i64Store(0, mem);
  /** Access RAM memory `ram[r]`, choosing r at run time from local `rLocal` (br_table), with the address/value code given. */
  const selectRam = (rLocal: number, addr: number[], val: number[] | null) => {
    const access = (mem: number) => [...addr, ...(val ?? []), ...(val ? store(mem) : load(mem))];
    return [
      ...op.block(val ? 0x40 : I64), ...op.block(), ...op.block(),
      ...op.localGet(rLocal), ...op.brTable([0, 1], 1), ...op.end,
      ...access(P.ram[0]), ...op.br(1), ...op.end,
      ...access(P.ram[1]), ...op.end,
    ];
  };
  /** Entry offset in the TLB from the address in local `t` (i64 when the TLB is in memory64). */
  const entry = (t: number) => tlb64
    ? [...op.localGet(t), ...op.i64Const(12), ...op.i64ShrU, ...op.i64Const(TLB_ENTRIES - 1), ...op.i64And, ...op.i64Const(4), ...op.i64Shl]
    : [...op.localGet(t), ...op.i64Const(12), ...op.i64ShrU, ...op.i32WrapI64, ...op.i32Const(TLB_ENTRIES - 1), ...op.i32And, ...op.i32Const(4), ...op.i32Shl];

  // Slow paths: slow_ld(t) -> i64, slow_st(t, v). Refill both TLBs, then access.
  // locals after params: page i64, p i64, r i32, hp i64 (host page), e (i32 or i64)
  const slow = (isStore: boolean) => {
    const base = isStore ? 2 : 1;
    const [page, p, r, hp, e] = [base, base + 1, base + 2, base + 3, base + 4];
    const alt = k.mapping === 'alt';
    const b = [
      ...op.localGet(0), ...op.i64Const(-4096), ...op.i64And, ...op.localTee(page),
      ...op.i64Const(GUEST_VA), ...op.i64Sub, ...op.i64Const(12), ...op.i64ShrU, ...op.localSet(p),
      ...(alt
        ? [...op.localGet(p), ...op.i64Const(1), ...op.i64And, ...op.i32WrapI64, ...op.localSet(r),
          ...op.i64Const(RAM_OFF), ...op.localGet(p), ...op.i64Const(1), ...op.i64ShrU, ...op.i64Const(12), ...op.i64Shl, ...op.i64Add, ...op.localSet(hp)]
        : [...op.i32Const(0), ...op.localSet(r),
          ...op.i64Const(P.ramOff), ...op.localGet(p), ...op.i64Const(12), ...op.i64Shl, ...op.i64Add, ...op.localSet(hp)]),
      ...entry(0), ...op.localSet(e),
    ];
    for (const tlb of [TLB_R, TLB_W]) {
      // tag = page | r << 3 (spec) or page
      b.push(...op.localGet(e), ...op.localGet(page));
      if (spec) b.push(...op.localGet(r), ...op.i64ExtendI32U, ...op.i64Const(3), ...op.i64Shl, ...op.i64Or);
      b.push(...op.i64Store(tlb, P.tlb));
      if (fmt32) {
        b.push(...op.localGet(e), ...op.localGet(hp), ...op.localGet(page), ...op.i64Sub, ...op.i32WrapI64, ...op.i32Store(tlb + 8, P.tlb));
        b.push(...op.localGet(e), ...op.localGet(r), ...op.i32Store(tlb + 12, P.tlb));
      } else {
        b.push(...op.localGet(e), ...op.localGet(hp), ...op.localGet(page), ...op.i64Sub, ...op.i64Store(tlb + 8, P.tlb));
      }
    }
    const addr = [...op.localGet(hp), ...op.localGet(0), ...op.i64Const(0xfff), ...op.i64And, ...op.i64Add, ...(ram64 ? [] : op.i32WrapI64)];
    const val = isStore ? op.localGet(1) : null;
    b.push(...(P.ram.length > 1 ? selectRam(r, addr, val) : [...addr, ...(val ?? []), ...(isStore ? store(P.ram[0]) : load(P.ram[0]))]));
    return m.func(isStore ? tSt : tLd, [I64, I64, I32, I64, tlb64 ? I64 : I32], b);
  };
  const slowLd = slow(false), slowSt = slow(true);

  // run locals: 0 n:i32, 1 x5:i64 (seed/LCG/stride counter), 2 mask:i64,
  // 3 i:i32, 4 va, 5 t, 6 e32:i32, 7 e64, 8 x1, 9 x2, 10 x3, 11 x4 (i64), 12 h32:i32, 13 r:i32
  const [N, X5, MASK, I, VA, T, E32, E64, X1, X2, X3, X4, H32, R] = [...Array(14).keys()];
  const E = tlb64 ? E64 : E32;

  /** One guest access at va+off: inline TLB lookup, fast path inline, slow path call. Loads leave an i64. */
  const access = (off: number, storeVal: number | null) => {
    const tlb = storeVal === null ? TLB_R : TLB_W;
    const val = storeVal === null ? null : op.localGet(storeVal);
    const b = [
      ...op.localGet(VA), ...(off ? [...op.i64Const(off), ...op.i64Add] : []), ...op.localSet(T),
      ...entry(T), ...op.localTee(E), ...op.i64Load(tlb, P.tlb),
      ...op.localGet(T), ...op.i64Const(TAG_MASK), ...op.i64And, ...op.i64Eq,
      ...op.if(storeVal === null ? I64 : 0x40),
    ];
    if (fmt32) {
      // host = wrap(t) + addend32; r = entry.ram
      b.push(...op.localGet(E), ...op.i32Load(tlb + 8, P.tlb), ...op.localGet(T), ...op.i32WrapI64, ...op.i32Add, ...op.localSet(H32));
      b.push(...op.localGet(E), ...op.i32Load(tlb + 12, P.tlb), ...op.localSet(R));
      if (k.select === 'helper') b.push(...op.localGet(R), ...op.localGet(H32), ...(val ?? []), ...op.call(val ? hSt : hLd));
      else b.push(...selectRam(R, op.localGet(H32), val));
    } else {
      // host = t + addend (wrapped to i32 for wasm32 RAM); spec: memory index 0 is folded into the tag compare
      b.push(...op.localGet(E), ...op.i64Load(tlb + 8, P.tlb), ...op.localGet(T), ...op.i64Add, ...(ram64 ? [] : op.i32WrapI64));
      b.push(...(val ?? []), ...(val ? store(P.ram[0]) : load(P.ram[0])));
    }
    b.push(...op.else, ...op.localGet(T), ...(val ?? []), ...op.call(val ? slowSt : slowLd), ...op.end);
    return b;
  };

  const addrGen = {
    rand: [...op.localGet(X5), ...op.i64Const(6364136223846793005n), ...op.i64Mul, ...op.i64Const(1442695040888963407n), ...op.i64Add,
      ...op.localTee(X5), ...op.i64Const(29), ...op.i64ShrU, ...op.localGet(MASK), ...op.i64And, ...op.i64Const(GUEST_VA), ...op.i64Add, ...op.localSet(VA)],
    seq: [...op.localGet(X5), ...op.i64Const(64), ...op.i64Add, ...op.localTee(X5), ...op.localGet(MASK), ...op.i64And,
      ...op.i64Const(GUEST_VA), ...op.i64Add, ...op.localSet(VA)],
    chase: [...op.localGet(X1), ...op.localSet(VA)],
  }[k.pattern];
  const body = k.mixed
    ? [
      ...access(0, null), ...op.localSet(X1),
      ...access(8, null), ...op.localSet(X2),
      ...op.localGet(X3), ...op.localGet(X2), ...op.i64Add, ...op.localSet(X3),
      ...op.localGet(X4), ...op.localGet(X3), ...op.i64Xor, ...op.i64Const(7), ...op.i64Rotl, ...op.localGet(X1), ...op.i64Add, ...op.localSet(X4),
      ...access(16, X4),
    ]
    : [...access(0, null), ...op.localTee(X1), ...op.localGet(X3), ...op.i64Add, ...op.localSet(X3)];
  const run = m.func(m.type([I32, I64, I64], [I64]), [I32, I64, I64, I32, I64, I64, I64, I64, I64, I32, I32], [
    ...(k.pattern === 'chase' ? [...op.localGet(X5), ...op.localSet(X1)] : []),
    ...op.block(), ...op.loop(),
    ...op.localGet(I), ...op.localGet(N), ...op.i32GeU, ...op.brIf(1),
    ...addrGen, ...body,
    ...op.localGet(I), ...op.i32Const(1), ...op.i32Add, ...op.localSet(I),
    ...op.br(0), ...op.end, ...op.end,
    ...op.localGet(X3), ...op.localGet(X4), ...op.i64Xor, ...op.localGet(X1), ...op.i64Add,
  ]);
  m.exportFunc('run', run);
  m.name(run, `k_${kernelName(k)}`);
  m.name(slowLd, `slow_ld_${kernelName(k)}`);
  m.name(slowSt, `slow_st_${kernelName(k)}`);
  return m.bytes();
}

/** B2 helper strategy's accessor: ld(r, host), st(r, host, v) over two RAM memories. */
export function buildJitAccessor(limits: Limits[]): Uint8Array<ArrayBuffer> {
  const m = new ModuleBuilder();
  limits.forEach((l, i) => m.importMemory('env', `m${i}`, l));
  const sel = (acc: (mem: number) => number[], result: number) => [
    ...op.block(result), ...op.block(), ...op.block(),
    ...op.localGet(0), ...op.brTable([0, 1], 1), ...op.end,
    ...acc(0), ...op.br(1), ...op.end,
    ...acc(1), ...op.end,
  ];
  m.exportFunc('ld', m.func(m.type([I32, I32], [I64]), [], sel((mem) => [...op.localGet(1), ...op.i64Load(0, mem)], I64)));
  m.exportFunc('st', m.func(m.type([I32, I32, I64], []), [], sel((mem) => [...op.localGet(1), ...op.localGet(2), ...op.i64Store(0, mem)], 0x40)));
  return m.bytes();
}

/**
 * The Rust side's accessor (imports "ram" in the Rust module). Memory 0 is the
 * Rust core memory, 1 a wasm32 RAM memory (layout B), 2 a memory64 RAM memory (D).
 */
export function buildRustAccessor(limits: [Limits, Limits, Limits]): Uint8Array<ArrayBuffer> {
  const m = new ModuleBuilder();
  limits.forEach((l, i) => m.importMemory('env', `m${i}`, l));
  const g = op.localGet;
  m.exportFunc('ld32', m.func(m.type([I32], [I64]), [], [...g(0), ...op.i64Load(0, 1)]));
  m.exportFunc('st32', m.func(m.type([I32, I64], []), [], [...g(0), ...g(1), ...op.i64Store(0, 1)]));
  m.exportFunc('read32', m.func(m.type([I32, I32, I32], []), [], [...g(0), ...g(1), ...g(2), ...op.memoryCopy(0, 1)]));
  m.exportFunc('ld64', m.func(m.type([I64], [I64]), [], [...g(0), ...op.i64Load(0, 2)]));
  m.exportFunc('st64', m.func(m.type([I64, I64], []), [], [...g(0), ...g(1), ...op.i64Store(0, 2)]));
  m.exportFunc('read64', m.func(m.type([I32, I64, I32], []), [], [...g(0), ...g(1), ...g(2), ...op.memoryCopy(0, 2)]));
  return m.bytes();
}
