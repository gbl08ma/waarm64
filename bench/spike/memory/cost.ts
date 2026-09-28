// M0.5 cost experiments (bench/spike/memory/REPORT.md): JIT-shaped kernels per memory
// layout, and Rust-side access through accessor modules. Runs in a worker via
// bench/run.ts --page bench/spike/memory/index.html.
import type { Options, Sample } from '../benchmarks.ts';
import type { Limits } from '../wasm.ts';
import {
  GUEST_VA, HIGH_OFF, RAM_OFF, TLB_ENTRIES, buildJitAccessor, buildKernel, buildRustAccessor, hostOf, is64, kernelName, plan,
  type Kernel, type Layout, type MemName, type Pattern,
} from './kernels.ts';

const MiB = 1 << 20, GiB = 1 << 30;
const now = () => performance.now();

// --- memories ---------------------------------------------------------

const PAGES: Record<MemName, number> = {
  core32: 4,
  big32: (RAM_OFF + GiB) / 65536,
  alt0: (RAM_OFF + GiB / 2) / 65536,
  alt1: (RAM_OFF + GiB / 2) / 65536,
  big64: (HIGH_OFF + GiB) / 65536,
};
const LIMITS = Object.fromEntries(Object.entries(PAGES).map(([k, p]) => [k, { min: p, max: p, shared: true, memory64: is64(k as MemName) }])) as Record<MemName, Limits>;

function newMemory(l: Limits): WebAssembly.Memory {
  const d = l.memory64
    ? { initial: BigInt(l.min), maximum: BigInt(l.max!), shared: l.shared, address: 'i64' }
    : { initial: l.min, maximum: l.max, shared: l.shared };
  return new WebAssembly.Memory(d as WebAssembly.MemoryDescriptor);
}

let memCache: Record<MemName, WebAssembly.Memory> | null = null;
/** All shared memories, allocated once. Untouched pages stay uncommitted, so only what the kernels touch is resident (≤ ~4 GiB). */
const mems = () => (memCache ??= Object.fromEntries(Object.keys(PAGES).map((k) => [k, newMemory(LIMITS[k as MemName])])) as Record<MemName, WebAssembly.Memory>);
const views = new Map<MemName, BigInt64Array>();
export const view = (m: MemName) => {
  let v = views.get(m);
  if (!v) views.set(m, (v = new BigInt64Array(mems()[m].buffer)));
  return v;
};

// --- pointer chase setup -------------------------------------------------

/** Chase slots: 64-byte lines for small working sets, one line per page (at a hashed offset) for large ones. */
function chaseSlots(ws: number): { count: number; va: (i: number) => bigint } {
  if (ws <= 64 * MiB) return { count: ws / 64, va: (i) => GUEST_VA + BigInt(i * 64) };
  return { count: ws / 4096, va: (i) => GUEST_VA + BigInt(i * 4096 + (Math.imul(i, 0x9e3779b1) >>> 26) * 64) };
}

/** Single random cycle over all slots (Sattolo), deterministic. */
function cycle(count: number): Uint32Array {
  const a = new Uint32Array(count);
  for (let i = 0; i < count; i++) a[i] = i;
  let s = 0x9e3779b9;
  for (let i = count - 1; i > 0; i--) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    const j = (s >>> 0) % i;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const chaseState = new Map<string, number>(); // target -> working set it currently holds
const faulted = new Map<string, number>(); // target -> bytes prefaulted

/** Touches every page of the working set once (at page offset 40, which no kernel reads), so timing and calibration exclude first-touch faults. */
function prefault(k: Kernel, ws: number) {
  const t = target(k);
  if ((faulted.get(t) ?? 0) >= ws) return;
  for (let p = 0; p < ws / 4096; p++) {
    const [m, off] = hostOf(k, GUEST_VA + BigInt(p * 4096 + 40));
    view(m)[off / 8] = 0n;
  }
  faulted.set(t, ws);
}

/** Deterministic shuffle (xorshift). */
function shuffled(n: number, seed: number): number[] {
  const a = [...Array(n).keys()];
  let s = seed * 0x9e3779b9 || 1;
  for (let i = n - 1; i > 0; i--) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    const j = (s >>> 0) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
/** Where a kernel's guest RAM lives; kernels with the same target share chase data. */
function target(k: Kernel) {
  if (k.mapping === 'alt') return 'alt';
  const p = plan(k);
  return `${p.mems[p.ram[0]]}@${p.ramOff}`;
}
function initChase(k: Kernel, ws: number): bigint {
  const { count, va } = chaseSlots(ws);
  const t = target(k);
  if (chaseState.get(t) !== ws) {
    const order = cycle(count);
    for (let i = 0; i < count; i++) {
      const from = va(order[i]), to = va(order[(i + 1) % count]);
      const [m, off] = hostOf(k, from);
      view(m)[off / 8] = to;
    }
    chaseState.set(t, ws);
  }
  return va(0);
}

// --- kernels ----------------------------------------------------------------

type Run = (n: number, seed: bigint, mask: bigint) => bigint;

let accessor: WebAssembly.Instance | null = null;
export function instantiate(k: Kernel): Run {
  const M = mems();
  const p = plan(k);
  const env: Record<string, WebAssembly.Memory> = {};
  p.mems.forEach((name, i) => (env[`m${i}`] = M[name]));
  const imports: WebAssembly.Imports = { env };
  if (k.select === 'helper') {
    // The helper strategy's accessor sees the two RAM memories of this mapping.
    const ram = p.ram.map((i) => p.mems[i]);
    const acc = new WebAssembly.Instance(new WebAssembly.Module(buildJitAccessor(ram.map((n) => LIMITS[n]))), {
      env: { m0: M[ram[0]], m1: M[ram[1]] },
    });
    imports.acc = acc.exports as Record<string, WebAssembly.ExportValue>;
  }
  const inst = new WebAssembly.Instance(new WebAssembly.Module(buildKernel(k, LIMITS)), imports);
  const run = inst.exports.run as Run;
  const tlb = view(p.mems[p.tlb]);
  return (n, seed, mask) => {
    tlb.fill(-1n, 0, (TLB_ENTRIES * 32) / 8); // flush both TLBs: kernels sharing a core memory use different entry formats
    return run(n, seed, mask);
  };
}

const B2 = (select: 'brtable' | 'spec' | 'helper', mapping: 'one' | 'alt') => ({ layout: 'B2' as Layout, select, mapping });
export const VARIANTS: Omit<Kernel, 'pattern' | 'mixed'>[] = [
  { layout: 'A' }, { layout: 'A2' }, { layout: 'AB', select: 'spec', mapping: 'one' }, { layout: 'AB', select: 'spec', mapping: 'alt' }, { layout: 'B1' }, { layout: 'Bswap' },
  B2('brtable', 'one'), B2('brtable', 'alt'), B2('spec', 'one'), B2('spec', 'alt'), B2('helper', 'one'), B2('helper', 'alt'),
  { layout: 'C' }, { layout: 'D' }, { layout: 'Dhigh' },
];

type Group = { pattern: Pattern; ws: number; mixed: boolean };
const GROUPS: Group[] = [
  { pattern: 'rand', ws: 8 * MiB, mixed: true },
  { pattern: 'chase', ws: 8 * MiB, mixed: true },
  { pattern: 'seq', ws: 64 * MiB, mixed: true },
  { pattern: 'rand', ws: 8 * MiB, mixed: false },
  { pattern: 'chase', ws: 8 * MiB, mixed: false },
  { pattern: 'rand', ws: GiB, mixed: true },
  { pattern: 'chase', ws: GiB, mixed: true },
];

export function seedFor(k: Kernel, ws: number): bigint {
  prefault(k, ws);
  return k.pattern === 'chase' ? initChase(k, ws) : k.pattern === 'rand' ? 1n : 0n;
}

async function benchKernels(o: Options, groups = o.quick ? GROUPS.filter((g) => g.ws <= 8 * MiB) : GROUPS): Promise<Sample[]> {
  const out: Sample[] = [];
  const rounds = o.quick ? 3 : 15, targetMs = o.quick ? 5 : 25;
  for (const g of groups) {
    o.log?.(`kernels ${g.pattern} ${g.ws / MiB} MiB ${g.mixed ? 'mixed' : 'bare'}`);
    const mask = BigInt((g.ws - 1) & ~63);
    const ks = VARIANTS.map((v) => ({ ...v, ...g }) as Kernel);
    const runs = ks.map(instantiate);
    const seeds = ks.map((k) => seedFor(k, g.ws));
    // Calibrate n on layout A so a sample takes ~targetMs; every layout uses the same n.
    runs[0](10_000, seeds[0], mask);
    let t = now();
    runs[0](100_000, seeds[0], mask);
    const n = Math.max(10_000, Math.round((targetMs * 100_000) / (now() - t)));
    for (const [i, run] of runs.entries()) for (let w = 0; w < 3; w++) run(n, seeds[i], mask); // tier up, warm caches
    const samples = ks.map(() => [] as number[]);
    for (let r = 0; r < rounds; r++) {
      // Shuffled order per round, and an untimed run right before each sample: kernels on
      // different memories otherwise inherit cold host caches/TLB. For the 1 GiB sets it is
      // full length (the chase cycle of 256 Ki pages must be re-warmed, not just a part of it).
      for (const i of shuffled(ks.length, r + 1)) {
        runs[i](g.ws > 64 * MiB ? n : n >> 2, seeds[i], mask);
        t = now();
        runs[i](n, seeds[i], mask);
        samples[i].push(((now() - t) * 1e6) / n);
      }
    }
    for (const [i, k] of ks.entries()) {
      out.push({ name: 'mem.kernel', unit: 'ns/iter', params: { kernel: kernelName(k), ...k, ws: g.ws, n }, samples: samples[i] });
    }
  }
  return out;
}

// --- Rust side --------------------------------------------------------------

type RustExports = { setup: (n: number | bigint) => number | bigint; run: Function; dma: Function };

async function loadRust() {
  const M = mems();
  const fetchMod = async (target: string) =>
    new WebAssembly.Module(await (await fetch(new URL(`../../../target/${target}/release/webpc_memspike.wasm`, import.meta.url))).arrayBuffer());
  const mem32 = newMemory({ min: 512, max: 65536, shared: true });
  const mem64 = newMemory({ min: 512, max: 262144, shared: true, memory64: true });
  const acc = new WebAssembly.Instance(new WebAssembly.Module(buildRustAccessor([
    { min: 512, max: 65536, shared: true }, LIMITS.big32, LIMITS.big64,
  ])), { env: { m0: mem32, m1: M.big32, m2: M.big64 } });
  const r32 = new WebAssembly.Instance(await fetchMod('wasm32-unknown-unknown'), { env: { memory: mem32 }, ram: acc.exports as never }).exports as unknown as RustExports;
  const r64 = new WebAssembly.Instance(await fetchMod('wasm64-unknown-unknown'), { env: { memory: mem64 } }).exports as unknown as RustExports;
  return { r32, r64 };
}

/** Rust core per layout: the build it runs in and the RAM kind (0 own memory, 1 wasm32 accessor, 2 memory64 accessor). */
const RUST_KINDS = [
  { layout: 'A', build: 'wasm32', kind: 0 },
  { layout: 'B', build: 'wasm32', kind: 1 },
  { layout: 'C', build: 'wasm64', kind: 0 },
  { layout: 'D', build: 'wasm32', kind: 2 },
] as const;

async function benchRust(o: Options): Promise<Sample[]> {
  const { r32, r64 } = await loadRust();
  const ws = 8 * MiB, mask = BigInt((ws - 1) & ~63);
  const s32 = r32.setup(ws), s64 = r64.setup(BigInt(ws));
  const call = (k: (typeof RUST_KINDS)[number], f: 'run' | 'dma', ...args: (number | bigint)[]) =>
    k.build === 'wasm64' ? r64[f](s64, k.kind, ...args) : r32[f](s32, k.kind, ...args);
  const kinds = RUST_KINDS;
  const rounds = o.quick ? 3 : 15;
  const out: Sample[] = [];

  const iters = o.quick ? 200_000 : 1_000_000;
  for (const k of kinds) for (let w = 0; w < 3; w++) call(k, 'run', BigInt(iters), mask, BigInt(RAM_OFF));
  const interp = kinds.map(() => [] as number[]);
  for (let r = 0; r < rounds; r++) {
    for (const i of shuffled(kinds.length, r + 1)) {
      call(kinds[i], 'run', BigInt(iters >> 2), mask, BigInt(RAM_OFF));
      const t = now();
      call(kinds[i], 'run', BigInt(iters), mask, BigInt(RAM_OFF));
      interp[i].push(((now() - t) * 1e6) / (iters * 14));
    }
  }
  kinds.forEach((k, i) => out.push({ name: 'rust.interp', unit: 'ns/insn', params: { layout: k.layout, build: k.build }, samples: interp[i] }));

  for (const len of [4096, 65536]) {
    const reps = Math.round((o.quick ? 16 : 256) * MiB / len);
    for (const k of kinds) call(k, 'dma', len, reps, BigInt(ws), BigInt(RAM_OFF));
    const bw = kinds.map(() => [] as number[]);
    for (let r = 0; r < rounds; r++) {
      for (const i of shuffled(kinds.length, r + 1)) {
        call(kinds[i], 'dma', len, reps >> 2, BigInt(ws), BigInt(RAM_OFF));
        const t = now();
        call(kinds[i], 'dma', len, reps, BigInt(ws), BigInt(RAM_OFF));
        bw[i].push((len * reps) / ((now() - t) * 1e6));
      }
    }
    kinds.forEach((k, i) => out.push({ name: 'rust.dma', unit: 'GB/s', params: { layout: k.layout, build: k.build, len }, samples: bw[i] }));
  }
  return out;
}

// --- machine code capture ------------------------------------------------------

/** Compiles and briefly runs one kernel per layout (rand, 8 MiB) plus the Rust builds, for machine-code.ts. */
async function machineCode(o: Options): Promise<Sample[]> {
  for (const mixed of [true, false]) {
    for (const v of VARIANTS) {
      const k = { ...v, pattern: 'rand', mixed } as Kernel;
      const run = instantiate(k);
      for (let i = 0; i < 20; i++) run(20_000, 1n, BigInt(8 * MiB - 64));
    }
  }
  await benchRust({ ...o, quick: true });
  return [];
}

export const suite: Record<string, (o: Options) => Promise<Sample[]>> = {
  kernels: (o) => benchKernels(o),
  /** Only the 1 GiB working sets (for the no-THP control run). */
  large: (o) => benchKernels(o, GROUPS.filter((g) => g.ws > 64 * MiB)),
  rust: benchRust,
  machinecode: machineCode,
};

export async function runAll(o: Options): Promise<Sample[]> {
  return [...(await benchRust(o)), ...(await benchKernels(o))];
}
