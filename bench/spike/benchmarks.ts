// M0 spike: micro-benchmarks that fix the JIT design numbers (bench/spike/REPORT.md).
// Runs unchanged in a browser worker and in Node.
import { I32, I64, ModuleBuilder, op } from './wasm.ts';

export type Sample = { name: string; unit: string; params?: Record<string, unknown>; samples: number[] };
export type Options = { quick: boolean; log?: (msg: string) => void };

const now = () => performance.now();
const PAGE = 65536;

function time(fn: () => void): number {
  const t = now();
  fn();
  return now() - t;
}

function repeat(n: number, fn: () => number): number[] {
  return Array.from({ length: n }, fn);
}

// --- compile / instantiate latency -------------------------------------

/** A function shaped like a translated guest block: register loads from a
 * CPU-state struct, ALU work, a data-dependent branch, register stores. */
function blockBody(seed: number): number[] {
  const b: number[] = [];
  for (let i = 0; i < 8; i++) {
    const r = (seed + i * 7) % 31;
    b.push(
      ...op.i32Const(0), ...op.i64Load(r * 8), ...op.i64Const(seed * 13 + i), ...op.i64Add,
      ...op.i32Const(0), ...op.i64Load(((r + 3) % 31) * 8), ...op.i64Xor, ...op.localSet(0),
      ...op.localGet(0), ...op.i64Eqz, ...op.if(), ...op.i32Const(0), ...op.i64Const(1), ...op.i64Store(256), ...op.end,
      ...op.i32Const(0), ...op.localGet(0), ...op.i64Store(r * 8),
    );
  }
  b.push(...op.i32Const(seed));
  return b;
}

function blockModule(nFuncs: number, seed = 0): Uint8Array<ArrayBuffer> {
  const m = new ModuleBuilder();
  const t = m.type([], [I32]);
  m.importMemory('env', 'mem', { min: 1 });
  for (let i = 0; i < nFuncs; i++) m.exportFunc(`b${i}`, m.func(t, [I64], blockBody(seed + i)));
  return m.bytes();
}

function benchCompile(o: Options): Sample[] {
  const out: Sample[] = [];
  const mem = new WebAssembly.Memory({ initial: 1 });
  const reps = o.quick ? 3 : 15;
  for (const n of o.quick ? [1, 64] : [1, 8, 64, 512]) {
    const bytes = Array.from({ length: reps }, (_, i) => blockModule(n, i * 1000)); // distinct bytes: no module cache hits
    const params = { funcs: n, bytes: bytes[0].length };
    const compile: number[] = [], inst: number[] = [], first: number[] = [];
    for (const b of bytes) {
      let mod!: WebAssembly.Module, instance!: WebAssembly.Instance;
      compile.push(time(() => { mod = new WebAssembly.Module(b); }));
      inst.push(time(() => { instance = new WebAssembly.Instance(mod, { env: { mem } }); }));
      const fns = Object.values(instance.exports) as (() => number)[];
      first.push(time(() => { for (const f of fns) f(); }));
    }
    out.push({ name: 'compile.sync', unit: 'ms', params, samples: compile });
    out.push({ name: 'compile.instantiate', unit: 'ms', params, samples: inst });
    out.push({ name: 'compile.first_call_all', unit: 'ms', params, samples: first });
  }
  return out;
}

async function benchCompileAsync(o: Options): Promise<Sample[]> {
  const out: Sample[] = [];
  for (const n of o.quick ? [64] : [8, 64, 512]) {
    const samples: number[] = [];
    for (let i = 0; i < (o.quick ? 3 : 15); i++) {
      const b = blockModule(n, 50_000 + i * 1000);
      const t = now();
      await WebAssembly.compile(b);
      samples.push(now() - t);
    }
    out.push({ name: 'compile.async', unit: 'ms', params: { funcs: n }, samples });
  }
  return out;
}

// --- call / dispatch costs --------------------------------------------

/** Module B exports `leaf(x) = x + 1`, and a table holding 16 copies of it. */
function leafModule() {
  const m = new ModuleBuilder();
  const t = m.type([I32], [I32]);
  const leaves = Array.from({ length: 16 }, (_, i) => m.func(t, [], [...op.localGet(0), ...op.i32Const(i + 1), ...op.i32Add]));
  m.exportFunc('leaf', leaves[0]);
  for (let i = 0; i < 16; i++) m.exportFunc(`leaf${i}`, leaves[i]);
  return new WebAssembly.Instance(new WebAssembly.Module(m.bytes())).exports as Record<string, Function>;
}

/** loop(n): calls a callee n times via the given call sequence. */
type CallKind = 'local' | 'import' | 'js' | 'indirect_local' | 'indirect_local_mono' | 'indirect_imported';

function callLoop(kind: CallKind, leaf: Record<string, Function>) {
  const m = new ModuleBuilder();
  const t = m.type([I32], [I32]);
  const tl = m.type([I32], [I32]);
  let callee = -1;
  if (kind === 'import') callee = m.importFunc('env', 'leaf', t);
  if (kind === 'js') callee = m.importFunc('env', 'js', t);
  if (kind === 'indirect_imported') m.importTable('env', 'table', { min: 16 });
  if (kind === 'local' || kind.startsWith('indirect_local')) {
    const leaves = Array.from({ length: 16 }, (_, i) => m.func(t, [], [...op.localGet(0), ...op.i32Const(i + 1), ...op.i32Add]));
    callee = leaves[0];
    if (kind.startsWith('indirect_local')) { m.table({ min: 16 }); m.elem(0, leaves); }
  }
  // locals: 0 = n (param), 1 = acc, 2 = i
  const call = kind.startsWith('indirect')
    // index cycles through 16 targets (i & 15), or stays fixed for the _mono variant
    ? [...op.localGet(1), ...op.localGet(2), ...op.i32Const(kind.endsWith('mono') ? 0 : 15), ...op.i32And, ...op.callIndirect(t)]
    : [...op.localGet(1), ...op.call(callee)];
  const loop = m.func(tl, [I32, I32], [
    ...op.block(), ...op.loop(),
    ...op.localGet(2), ...op.localGet(0), ...op.i32GeU, ...op.brIf(1),
    ...call, ...op.localSet(1),
    ...op.localGet(2), ...op.i32Const(1), ...op.i32Add, ...op.localSet(2),
    ...op.br(0), ...op.end, ...op.end,
    ...op.localGet(1),
  ]);
  m.exportFunc('run', loop);
  const table = new WebAssembly.Table({ element: 'anyfunc', initial: 16 });
  for (let i = 0; i < 16; i++) table.set(i, leaf[`leaf${i}`] as never);
  const inst = new WebAssembly.Instance(new WebAssembly.Module(m.bytes()), {
    env: { leaf: leaf.leaf, js: (x: number) => x + 1, table },
  });
  return inst.exports.run as (n: number) => number;
}

function benchCalls(o: Options): Sample[] {
  const leaf = leafModule();
  const n = o.quick ? 1e6 : 2e7;
  const out: Sample[] = [];
  for (const kind of ['local', 'import', 'indirect_local', 'indirect_local_mono', 'indirect_imported', 'js'] as const) {
    const run = callLoop(kind, leaf);
    run(n / 10); // warm up / tier up
    out.push({ name: `call.${kind}`, unit: 'ns/call', samples: repeat(o.quick ? 3 : 9, () => (time(() => run(n)) * 1e6) / n) });
  }
  // JS -> wasm export round trip: the cost of a dispatcher loop living in JS.
  const f = leaf.leaf as (x: number) => number;
  const jsn = o.quick ? 1e6 : 1e7;
  out.push({
    name: 'call.js_to_wasm', unit: 'ns/call',
    samples: repeat(o.quick ? 3 : 9, () => time(() => { let a = 0; for (let i = 0; i < jsn; i++) a = f(a); }) * 1e6 / jsn),
  });
  return out;
}

// --- guest memory access through a software TLB ------------------------

const TLB_ENTRIES = 4096; // direct mapped; entry = { tag: i64, addend: i64 }
const TLB_BASE = 0;
const RAM_BASE = 1 << 20; // host offset of guest RAM inside linear memory
const GUEST_VA = 0x4000_0000n; // guest virtual base the kernel accesses

/**
 * run(n, seed, mask) -> checksum: n loads at pseudo-random guest addresses
 * within `mask + 1` bytes. mode 'raw' loads the host address directly (lower
 * bound); 'tlb' does the planned inline lookup with a refill slow path.
 */
function memModule(mode: 'raw' | 'tlb', shared: boolean, pages: number): (n: number, seed: number, mask: number) => bigint {
  const m = new ModuleBuilder();
  m.importMemory('env', 'mem', { min: pages, max: pages, shared });
  const tRun = m.type([I32, I64, I64], [I64]);
  const tFill = m.type([I64], [I64]);
  // fill(va) -> addend. Stand-in for the page walk: maps GUEST_VA linearly to RAM_BASE.
  const fill = m.func(tFill, [I32], [
    // entry = TLB_BASE + ((va >> 12) & (N-1)) * 16
    ...op.localGet(0), ...op.i64Const(12), ...op.i64ShrU, ...op.i32WrapI64, ...op.i32Const(TLB_ENTRIES - 1), ...op.i32And,
    ...op.i32Const(4), ...op.i32Shl, ...op.localSet(1),
    ...op.localGet(1), ...op.localGet(0), ...op.i64Const(12), ...op.i64ShrU, ...op.i64Store(TLB_BASE),
    ...op.localGet(1), ...op.i64Const(BigInt(RAM_BASE) - GUEST_VA), ...op.i64Store(TLB_BASE + 8),
    ...op.i64Const(BigInt(RAM_BASE) - GUEST_VA),
  ]);
  // locals: 0 n, 1 lcg, 2 mask | 3 i:i32, 4 acc:i64, 5 va:i64, 6 entry:i32, 7 addend:i64
  const nextVa = [
    // lcg = lcg * 6364136223846793005 + 1442695040888963407; va = GUEST_VA + ((lcg >> 29) & mask & ~7)
    ...op.localGet(1), ...op.i64Const(6364136223846793005n), ...op.i64Mul, ...op.i64Const(1442695040888963407n), ...op.i64Add,
    ...op.localTee(1), ...op.i64Const(29), ...op.i64ShrU, ...op.localGet(2), ...op.i64And, ...op.i64Const(-8), ...op.i64And,
    ...op.i64Const(GUEST_VA), ...op.i64Add, ...op.localSet(5),
  ];
  const access = mode === 'raw'
    ? [...op.localGet(5), ...op.i64Const(BigInt(RAM_BASE) - GUEST_VA), ...op.i64Add, ...op.i32WrapI64, ...op.i64Load()]
    : [
      ...op.localGet(5), ...op.i64Const(12), ...op.i64ShrU, ...op.i32WrapI64, ...op.i32Const(TLB_ENTRIES - 1), ...op.i32And,
      ...op.i32Const(4), ...op.i32Shl, ...op.localTee(6), ...op.i64Load(TLB_BASE),
      ...op.localGet(5), ...op.i64Const(12), ...op.i64ShrU, ...op.i64Eq,
      ...op.if(I64), ...op.localGet(6), ...op.i64Load(TLB_BASE + 8), ...op.else, ...op.localGet(5), ...op.call(fill), ...op.end,
      ...op.localGet(5), ...op.i64Add, ...op.i32WrapI64, ...op.i64Load(),
    ];
  const run = m.func(tRun, [I32, I64, I64, I32, I64], [
    ...op.block(), ...op.loop(),
    ...op.localGet(3), ...op.localGet(0), ...op.i32GeU, ...op.brIf(1),
    ...nextVa,
    ...op.localGet(4), ...access, ...op.i64Add, ...op.localSet(4),
    ...op.localGet(3), ...op.i32Const(1), ...op.i32Add, ...op.localSet(3),
    ...op.br(0), ...op.end, ...op.end,
    ...op.localGet(4),
  ]);
  m.exportFunc('run', run);
  const mem = new WebAssembly.Memory({ initial: pages, maximum: pages, shared } as WebAssembly.MemoryDescriptor);
  const inst = new WebAssembly.Instance(new WebAssembly.Module(m.bytes()), { env: { mem } });
  // Invalidate the TLB: tags of all-ones never match.
  new BigInt64Array(mem.buffer, TLB_BASE, TLB_ENTRIES * 2).fill(-1n);
  const f = inst.exports.run as (n: number, seed: bigint, mask: bigint) => bigint;
  return (n, seed, mask) => f(n, BigInt(seed), BigInt(mask));
}

function benchMemory(o: Options): Sample[] {
  const out: Sample[] = [];
  const ramBytes = o.quick ? 64 << 20 : 512 << 20;
  const pages = (RAM_BASE + ramBytes) / PAGE;
  const n = o.quick ? 2e6 : 2e7;
  const sets = o.quick ? [16 << 10, 64 << 20] : [16 << 10, 1 << 20, 16 << 20, 64 << 20, 512 << 20];
  for (const shared of [false, true]) {
    for (const mode of ['raw', 'tlb'] as const) {
      const run = memModule(mode, shared, pages);
      for (const ws of sets) {
        run(n / 10, 1, ws - 1);
        out.push({
          name: `mem.${mode}`, unit: 'ns/access', params: { shared, working_set: ws, tlb_entries: TLB_ENTRIES },
          samples: repeat(o.quick ? 3 : 7, () => (time(() => run(n, 1, ws - 1)) * 1e6) / n),
        });
      }
    }
  }
  return out;
}

/** Liftoff -> TurboFan transition: per-chunk cost right after instantiation. */
function benchTierUp(o: Options): Sample[] {
  const run = memModule('tlb', false, (RAM_BASE + (16 << 20)) / PAGE);
  const chunk = 2e5;
  const samples: number[] = [];
  for (let i = 0; i < (o.quick ? 20 : 200); i++) samples.push((time(() => run(chunk, i, (1 << 20) - 1)) * 1e6) / chunk);
  return [{ name: 'tierup.tlb_chunk', unit: 'ns/access', params: { chunk, note: 'samples in order, not repetitions' }, samples }];
}

// --- SIMD ---------------------------------------------------------------

function simdModule(simd: boolean) {
  const m = new ModuleBuilder();
  m.importMemory('env', 'mem', { min: 2 });
  const t = m.type([I32], [I32]);
  // run(reps): reps passes of dst[i] += src[i] over 32 KiB
  const step = simd ? 16 : 4;
  const body = simd
    ? [...op.localGet(2), ...op.localGet(2), ...op.v128Load(0), ...op.localGet(2), ...op.v128Load(32768), ...op.i32x4Add, ...op.v128Store(0)]
    : [...op.localGet(2), ...op.localGet(2), ...op.i32Load(0), ...op.localGet(2), ...op.i32Load(32768), ...op.i32Add, ...op.i32Store(0)];
  const f = m.func(t, [I32, I32], [
    ...op.block(), ...op.loop(),
    ...op.localGet(1), ...op.localGet(0), ...op.i32GeU, ...op.brIf(1),
    ...op.i32Const(0), ...op.localSet(2),
    ...op.block(), ...op.loop(),
    ...op.localGet(2), ...op.i32Const(32768), ...op.i32GeU, ...op.brIf(1),
    ...body,
    ...op.localGet(2), ...op.i32Const(step), ...op.i32Add, ...op.localSet(2),
    ...op.br(0), ...op.end, ...op.end,
    ...op.localGet(1), ...op.i32Const(1), ...op.i32Add, ...op.localSet(1),
    ...op.br(0), ...op.end, ...op.end,
    ...op.localGet(1),
  ]);
  m.exportFunc('run', f);
  return m.bytes();
}

function benchSimd(o: Options): Sample[] {
  const bytes = simdModule(true);
  if (!WebAssembly.validate(bytes)) return [{ name: 'simd.available', unit: 'bool', samples: [0] }];
  const out: Sample[] = [{ name: 'simd.available', unit: 'bool', samples: [1] }];
  const reps = o.quick ? 200 : 5000;
  for (const simd of [false, true]) {
    const mem = new WebAssembly.Memory({ initial: 2 });
    const run = new WebAssembly.Instance(new WebAssembly.Module(simdModule(simd)), { env: { mem } }).exports.run as (n: number) => number;
    run(reps / 10);
    out.push({
      name: simd ? 'simd.i32x4_add' : 'simd.scalar_i32_add', unit: 'GB/s',
      samples: repeat(o.quick ? 3 : 9, () => (reps * 32768) / (time(() => run(reps)) * 1e6)),
    });
  }
  return out;
}

// -------------------------------------------------------------------------

export const suite: Record<string, (o: Options) => Sample[] | Promise<Sample[]>> = {
  compile: benchCompile,
  compileAsync: benchCompileAsync,
  calls: benchCalls,
  memory: benchMemory,
  tierup: benchTierUp,
  simd: benchSimd,
};

export async function runAll(o: Options): Promise<Sample[]> {
  const all: Sample[] = [];
  for (const [name, fn] of Object.entries(suite)) {
    o.log?.(`running ${name}`);
    all.push(...(await fn(o)));
  }
  return all;
}
