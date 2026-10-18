# Architecture

webpc is a whole-system AArch64 emulator for the browser: a Rust core compiled to wasm32 (the same
crate builds natively for tests), TypeScript host glue, and a JIT that turns guest code into
WebAssembly modules at run time. It runs unmodified arm64 Linux. Chromium is the primary target.

## Threads and memory

```
┌──────────── vCPU worker (one, or one per vCPU in parallel SMP) ──────┐
│  core.wasm (Rust): decoder, interpreter, JIT, MMU + software TLB,   │
│  exceptions, system registers, timer, GICv3, PL011, PSCI, virtio    │
│  transports, the run loop, counters                                  │
│  JIT modules: import the memory, the core's table and its helpers   │
└──────────────────────────────────────────────────────────────────────┘
        │ one shared wasm32 memory: core state, heap, guest RAM, rings
┌──────────── device worker (TS) ──────┐   ┌──────── page (main thread) ─┐
│ virtio backends: blk (HTTP, qcow2,   │   │ UI, <canvas> framebuffer,   │
│ OPFS overlay), net adapters, 9p,     │◄─►│ DOM input → MessagePorts,   │
│ console, rng, input                  │   │ page-side net adapters      │
└──────────────────────────────────────┘   └─────────────────────────────┘
      (+ an optional PC-sampler worker reading the counters)
```

- The page must be **cross-origin isolated** (COOP/COEP) for `SharedArrayBuffer`; everything that
  runs in the browser works with it on (`tools/serve.ts` sets the headers).
- `web/vm.ts` is the host side of the ABI: it instantiates the core, boots a VM (`bootVm`), runs it
  (`run`, `runAsync`, `runToPowerOff`), handles exits, and hosts the JIT's installs.
  `tests/browser/boot.html` and the bench pages run it in a worker; Node runs it directly (devices
  inline). **Parallel SMP** (M7): that thread becomes a coordinator; each vCPU runs in its own
  worker (`web/vcpu-worker.ts`: its own core instance, table and JIT code on the one memory),
  which sleeps on its vCPU's wake word and rings the device doorbell itself; the coordinator drains
  the console and reports the run's end ([platform.md](platform.md) "The run loop").

## Guest memory: layout A

**One shared wasm32 memory holds the core's state first, then guest RAM** (≤ ~3.5 GiB, sized
against host RAM at VM start), then the rest of the core's heap: `bootVm` makes the memory its
final size, with a 1 GiB heap reserve, unless RAM leaves no room for it ([abi.md](abi.md) "A
fixed-size memory"); the Rust core targets wasm32. Decided in M0.5
(`bench/spike/memory/REPORT.md`): every >4 GiB-capable layout cost more than the 5% threshold in
JIT-shaped kernels. On x86_64 Chromium: memory64 (C) +6–20% in JIT code and +11% in the core,
multi-memory wasm32 RAM (B) +12–14%, a memory64 RAM memory (D) +19–28%. On the M4: C +17–19% (its
wasm64 core was free there), B +31–40%, D +26–32%.
- The guest physical address map is independent of placement, because the TLB translates.
- **Every guest RAM access in generated code goes through one lowering function**, so a later
  layout change stays inside the emitter and the core allocator.
- **Spill memories** ("A + spill memories", [plans/spill-memories.md](plans/spill-memories.md), under way): RAM
  past memory 0 in more wasm32 memories, each a CPU-less NUMA node in the DT. TLB tag bits 11:3 hold the memory
  index (inverted, all ones for memory 0), so every inline compare misses on a spill page and memory 0's code is
  unchanged; the interpreter's miss path does the access through `ram.*` imports from a host-made module
  (`web/spill.ts`), and the JIT's miss re-runs the instruction there. A core host address (`mem::Host`) names its
  memory in its top byte. NUMA balancing must be off (its hinting faults are expensive under emulation): an SMBIOS
  systemd credential does it.
- Re-measure the gaps on new Chromium releases.

## Design principles

- **The interpreter is the reference semantics**; the JIT falls back to its code for anything not
  inline and must match it step for step ([jit.md](jit.md)).
- **Determinism:** in deterministic mode time derives from the step count and device completions
  land at fixed steps, so every run of a guest takes the same steps on every host and tier
  ([platform.md](platform.md) "Time", [testing.md](testing.md) "Step counts").
- **SMP-ready from day one:** no mutable globals in the core; all vCPU state sits behind a
  per-vCPU pointer (`Vcpu`: `Cpu`, TLB, JIT state); guest atomics use real wasm atomics even
  single-core. **N vCPUs run two ways** (M7): round-robin on one thread (deterministic, exact
  steps) or a worker per vCPU (parallel, realtime); broadcast `TLBI …IS` completes before the
  issuer's `DSB` returns, and `IC` reaches every code cache by the next context synchronization
  ([platform.md](platform.md) "Broadcast maintenance").
- **The host never parses virtio rings**, only device protocols ([devices.md](devices.md)).
- **Our own code** where a port would drag in more than it gives (the FDT writer, the virtqueues,
  the 9p server, the FP core, the crypto, the wasm encoder); ports only from permissively licensed
  projects, attributed in `THIRD_PARTY.md` (the decoder's pattern table is dynarmic's).

## Code map

| Path | What |
|---|---|
| `core/src/lib.rs` | the host ABI exports ([abi.md](abi.md)) |
| `core/src/a64/a64.inc`, `core/build.rs`, `decode.rs` | the decoder, generated from the pattern table |
| `core/src/cpu.rs` | `Cpu` (registers, EL1 state, features) |
| `core/src/interp.rs`, `interp/{ldst,ldst_fp,simd,simd_int,simd_fp,float,sys}.rs` | the interpreter; `sys.rs` has system registers, exceptions, ERET, timer registers |
| `core/src/fp.rs` | software FP ([cpu.md](cpu.md)) |
| `core/src/crypto.rs` | AES, SHA, PMULL |
| `core/src/mem.rs` | guest RAM accesses and atomics |
| `core/src/mmu.rs` | the walker, `Vcpu`, the TLB |
| `core/src/vm.rs`, `vm/parallel.rs` | `Vm`: the run loop (round-robin; parallel SMP's per-vCPU run, queues and DSB wait), time, IRQs, PSCI, device dispatch |
| `core/src/gicv3.rs`, `pl011.rs`, `pl031.rs`, `virtio.rs`, `boot.rs`, `fdt.rs` | the platform ([platform.md](platform.md), [devices.md](devices.md)) |
| `core/src/jit/` | the JIT ([jit.md](jit.md)) |
| `core/tests/` | native runners (corpus, TestFloat, bare-metal, boots, LTP, distros, litmus) and `common/` (native backends, the thread-per-vCPU runner) |
| `core/fuzz/` | decoder sweep and libFuzzer targets (separate workspace) |
| `web/` | `vm.ts` (host ABI, parallel SMP's coordinator), `vcpu-worker.ts`, `devices.ts` + `device-worker.ts` (backends), `9p.ts`, `net.ts`, `input.ts`, `display.ts`, `overlay.ts`, `qcow2.ts` + `inflate-pool.ts`, `sampler-worker.ts`, `profiler.ts`; `app/`: the page ([frontend.md](frontend.md)) |
| `tests/` | Node and Chromium tests, the corpus, the harness, bare-metal tests, qcow2 fixtures, `steps.txt` |
| `tools/` | `serve.ts` (dev server with COOP/COEP and ranges), `corpus/` (generator and oracle runner), `v8code.ts` (V8 machine code of JIT functions), `wasm-sizes.ts` |
| `bench/` | `run.ts` (the harness), `interp/`, `boot/`, `jit/`, `spike/` (pages, suites, reports, committed results) |
| `images/` | guest image builds ([images.md](images.md)) |
| `scripts/` | `ci.sh`, `build-wasm.sh`, `testfloat.sh`, `tsan.sh` |

## Toolchain

- The nightly is pinned in `rust-toolchain.toml`, needed only to rebuild std with atomics
  (`-Zbuild-std`, `-Zllvm-target-feature=+atomics`; `-Ctarget-feature=+atomics` is being phased
  out, rust-lang/rust#162235). The core has no `#![feature]`. Bump the toolchain deliberately and
  re-run the benchmarks.
- **The core is built without `simd128`**: with it, the pinned nightly miscompiled the JIT's
  register-mask code three times (LLVM's wasm backend combines `<32|64 x i1>` bitcasts in the
  wrong order, llvm/llvm-project#226741). Nothing needs it: the JIT's SIMD128 comes from our own
  encoder. How to turn it on safely is in [backlog.md](backlog.md).
- TypeScript runs without a build step (Node runs `.ts` directly; `tools/serve.ts` strips types
  for the browser): erasable syntax only.
