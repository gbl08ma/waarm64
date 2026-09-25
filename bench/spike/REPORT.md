# M0 spike report: JIT design numbers

**Host:** AMD Ryzen 7 5800X3D (Zen 3, x86_64), 47 GiB, Linux, Chromium 152.0.7977.75 headless.
**Date:** 2026-09-25. Raw data: `results/chromium-x86_64-{default,liftoff-only,turbofan-only}.json`.
**Reproduce:** `node bench/run.ts --config <cfg> --out …`. Benchmark code: `benchmarks.ts`.

Caveats:
- The machine is a desktop that was in use during the run, not an isolated benchmark box. IQRs were small throughout, so the medians are trustworthy to roughly ±5%.
- **Chromium on arm64 (M4 Mac) isn't measured yet.** Re-run there before treating any number as host-independent.
- Memory layout alternatives (memory64, multi-memory) are M0.5's job and aren't covered here.

Columns are medians for V8 default (dynamic tiering), `--liftoff-only` and `--no-liftoff` (TurboFan only).

## 1. Compile and instantiate latency

Each module holds N functions shaped like translated guest blocks (~330 bytes each: CPU-state loads and stores, ALU, a branch).

| funcs (bytes) | sync compile | instantiate | first call of every function (default / TurboFan-only) | async compile |
|---|---|---|---|---|
| 1 (358 B) | 0.050 ms | 0.010 ms | 0.015 / 0.115 ms | — |
| 8 (2.6 KB) | 0.065 ms | 0.010 ms | 0.055 / 0.605 ms | 0.085 ms |
| 64 (21 KB) | 0.115 ms | 0.040 ms | 0.340 / 4.61 ms | 0.150 ms |
| 512 (170 KB) | 0.325 ms | 0.260 ms | 2.63 / 35.8 ms | 0.335 ms |

- **V8 compiles lazily.** `new WebAssembly.Module` only validates (about 2 µs/KB). The real compile happens on each function's first call: about **5 µs per block function with Liftoff**, versus about **70 µs with TurboFan**.
- **Fixed per-module cost is about 60 µs** (compile + instantiate of a 1-function module). A batch of 64 blocks costs about 7.5 µs per block all-in, versus about 75 µs for one block per module. **Batch blocks into modules.**
- Synchronous compile inside a worker is sub-millisecond even at 170 KB, and async compile brings no benefit at these sizes. The vCPU worker can compile synchronously.

## 2. Tier-up

A hot TLB loop right after instantiation (chunks of 200k accesses, about 0.4 ms each): the first chunk is 5.2 ns/access (lazy compile + Liftoff). **From the second chunk on it holds at 2.15 ns, the same as TurboFan-only.** V8's dynamic tiering promotes hot generated code within about a millisecond, so there's no need to force TurboFan. Liftoff-only is 1.2–3.5× slower across the suite, which is the cost cold code pays.

## 3. Call and dispatch costs (TurboFan, ns per call)

| call kind | default | Liftoff-only |
|---|---|---|
| direct call within the same module | 0.23 (inlined) | 3.6 |
| `call_indirect`, one target (monomorphic) | **0.31** (speculatively inlined) | 7.0 |
| `call_indirect`, cycling over 16 targets | **11.1** | 13.1 |
| `call_indirect` through an imported table, 16 targets | 11.0 | 12.6 |
| call to an imported wasm function (other instance) | **2.2** | 8.2 |
| wasm → JS import | 5.2 | 5.6 |
| JS → wasm export (JS dispatcher loop) | 3.1 | 9.5 |

- **Polymorphic `call_indirect` costs about 11 ns**, which is expensive relative to a guest basic block of ~5 instructions. A dispatcher that makes a table call per block would dominate run time.
- Calling an **imported function from another instance costs 2.2 ns**. Implication for M5: when a new module is built, its already-compiled successor blocks can be **imported directly** (static chaining at module-creation time), so the table dispatcher is only a fallback.
- Code in the same module can be inlined by TurboFan. Region formation (several blocks per function, guest loops as wasm `loop`s) removes transitions entirely.
- Even a JS dispatcher loop (3.1 ns per JS→wasm call) beats polymorphic `call_indirect`. What matters is how many dispatches there are, not where the dispatcher lives.

## 4. Guest memory access through the inline software TLB (ns/access, default config)

Random 8-byte loads. The TLB is direct-mapped with 4096 entries × 16 bytes (tag, addend), and misses refill in wasm.

| working set | raw load (lower bound) | TLB load | TLB hit rate |
|---|---|---|---|
| 16 KiB | 1.07 | 1.27 | 100% |
| 1 MiB | 1.38 | 2.13 | 100% |
| 16 MiB | 1.44 | 2.44 | 100% (4096 pages) |
| 64 MiB | 1.44 | 3.70 | ~25% |
| 512 MiB | 1.58 | 2.66 | ~3% |

- **With a warm TLB the fast path adds about 0.2 ns** per access. It adds about 0.75–1 ns once the working set pushes the 64 KiB TLB array out of L1. In M5, consider denser entries: an i32 addend, or split tag/addend arrays.
- **At high miss rates, branch misprediction on hit/miss dominates**, which is why 64 MiB (unpredictable, ~25% hits) is slower than 512 MiB (almost always missing, so predictable). Real guests have high hit rates, but TLB size and indexing still need tuning against real guest traces.
- **Shared vs non-shared memory: no measurable difference** (the shared numbers match within noise; see the raw JSON). Plain accesses to a `SharedArrayBuffer`-backed memory are free, so keeping the core on shared memory from day one costs nothing.

## 5. SIMD128

Available. `i32x4.add` streams at 40.9 GB/s vs 13.5 GB/s for scalar `i32.add` (3×) in TurboFan (Liftoff: 14.9 vs 3.8). Lowering NEON to SIMD128 (M6) is worthwhile.

## Decisions and inputs for later milestones

1. Keep the core on **shared memory** (no measured cost).
2. JIT emits **batched modules** (target ≥ 16–64 blocks per module) and compiles them **synchronously in the vCPU worker**. It relies on V8 dynamic tiering and doesn't force TurboFan.
3. Block linking, cheapest first:
   - intra-function branches or loops (region formation);
   - same-module calls;
   - **imports of already-compiled blocks** (2.2 ns);
   - polymorphic `call_indirect` or a dispatcher only as a fallback (~11 ns).
   M5 must count dispatcher transitions per guest instruction as a first-class metric.
4. TLB fast path as designed is cheap on hits. Entry size and TLB geometry get tuned in M5 with real guest traces.
5. SIMD128 lowering for NEON is worth doing (M6).

**Open:** re-run on Chromium arm64 (M4 Mac). Memory64 and multi-memory move to M0.5.
