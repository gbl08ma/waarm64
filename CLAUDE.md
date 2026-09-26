# webpc

A whole-system AArch64 emulator for the browser. It JIT-compiles guest code to WebAssembly
and runs unmodified arm64 Linux. Chromium is the primary target.

- **`PLAN.md` is the source of truth** for decisions, architecture and milestones. When a decision changes, update PLAN.md in the same change. Don't let code and plan drift apart.
- `THIRD_PARTY.md` holds the verified licenses of reference projects and the attribution of any ported code.
- `bench/spike/REPORT.md` has the measured JIT design numbers from M0. Read it before designing JIT, dispatch or TLB code.

## Status

- M0 (foundations + spike): done. Still pending: re-run the spike on Chromium arm64 on the M4 Mac (PLAN.md M9).
- M0.5 (memory architecture): done on x86_64 and arm64 (M4), **layout A**: one shared wasm32 memory with core state then guest RAM, and a wasm32 Rust core. TLB tag bits 3–11 are reserved for a memory index. See `bench/spike/memory/REPORT.md`.
- M1 (A64 integer interpreter + golden corpus): done. Decoder `core/build.rs` ← `core/src/a64/a64.inc`; interpreter `core/src/interp*`; corpus `tests/corpus/` (grow it with `node tools/corpus/run.ts`, compare with `cargo test`); decoder fuzzing `core/fuzz`; MIPS `bench/interp/REPORT.md`.
- M2 (FP and AdvSIMD in the interpreter): done. FP core `core/src/fp.rs` (own implementation of the ARM pseudocode, RNE fast paths; `scripts/testfloat.sh`); FP/SIMD handlers `core/src/interp/{ldst_fp,simd,simd_int,simd_fp,float}.rs`; corpus also runs on wasm (`tests/corpus-wasm.test.ts`); MIPS in `bench/interp/REPORT.md`.
- M3 (system level, Linux boots on the interpreter): done. Whole-VM ABI 5 `core/src/vm.rs` (run loop, deterministic time, IRQs, PSCI), `gic.rs`, `pl011.rs`, `mmu.rs`, `boot.rs` + `fdt.rs`; bare-metal tests `tests/baremetal/`; guest images `images/` (Podman; Linux + BusyBox, kvm-unit-tests); boot runners `core/tests/{boot,kvm_unit_tests}.rs` and `web/vm.ts`; boot baseline and profile `bench/boot/REPORT.md`.
- M4 (virtio devices and real distros): done, from `M4-KICKOFF.md`: steps 1–3 done (`vm_run` MIPS; GIC to 96 INTIDs, virtio-mmio transport and split queues `core/src/virtio.rs`, backends `web/devices.ts` in `web/device-worker.ts`: console, rng, read-only blk over HTTP ranges with the root filesystem on it; realtime mode, ABI 7); step 4: Alpine and Debian 13 boot from virtio-blk (`images/build.sh alpine|debian`, `core/tests/distros.rs`), qcow2 reader (`web/qcow2.ts`, `core/tests/common/qcow2.rs`), arm64 defconfig kernel as `linux/Image-defconfig`; step 5: writable disks through a copy-on-write overlay (`web/overlay.ts` on OPFS, in memory natively). Step 6: virtio-net with frame-level adapters (`web/net.ts`, loopback test adapter), our own 9P2000.L server (`web/9p.ts`), virtio-input (`web/input.ts` for DOM events), a `simple-framebuffer` drawn to a canvas (`web/display.ts`; ABI 8); native twins in `core/tests/common` (`p9.rs`). Step 7: LTP subset + arm64 kselftests in the guest (`images/build.sh ltp`, `core/tests/ltp.rs`), I/O benchmarks (`bench/boot/suite.ts` dd, fio, p9, net) and boot times on both hosts (`bench/boot/REPORT.md` "M4 step 7"). **Iterate on the Buildroot guest and Alpine; Debian boots (6–8 min) are occasional and opt-in until the JIT.** PLAN.md §7 M4 "Progress".
- **M5** (tier-1 JIT), from `M5-KICKOFF.md`, in progress: step 1 done (JIT ABI 9 in PLAN.md §2: table plumbing, `jit_install`, encoder `core/src/jit/wasm.rs`, `bench/jit/`); step 2 done (gadget-only translator `core/src/jit/{mod,block}.rs`, dispatcher `jit::steps`, `VmConfig.jit`, ABI 10; corpus through the JIT in `tests/corpus-wasm.test.ts`, lockstep `tests/jit-lockstep.test.ts`, numbers in `bench/interp/REPORT.md`).
- Loose ends no milestone owns yet (speed levers, unadvertised extensions, the arm64 spike re-run, …) are listed in PLAN.md §7 "M9". Add to that list rather than leaving TODOs scattered.

## Commands

```sh
scripts/ci.sh                  # everything CI runs: fmt, clippy, cargo test, wasm build, tsc, node + Chromium tests
scripts/build-wasm.sh          # wasm core -> target/wasm32-unknown-unknown/release/webpc_core.wasm
cargo test                     # native core tests
scripts/testfloat.sh           # FP core vs TestFloat 3e (builds it under target/ on first run; in ci.sh)
npm test                       # JS tests (tests/**/*.test.ts, incl. Chromium e2e; needs the wasm build)
npm run bench -- [--quick] [--only <bench>] [--config default|liftoff-only|turbofan-only|bounds-checks]
node bench/spike/memory/run-all.ts # M0.5 memory suite (capacity, cost, machine code) -> bench/spike/memory/results/
node bench/spike/node.ts --quick   # spike in Node, fast iteration only
npm run serve                  # dev server with COOP/COEP on :8080 (PORT env overrides)
node tools/corpus/run.ts [--oracle qemu|m4|both] [group...]  # regenerate golden corpus (needs qemu / the M4 VM)
npm run bench -- --page bench/interp/index.html               # interpreter MIPS
npm run bench -- --page bench/boot/index.html                 # Linux boot time (needs target/images)
node bench/boot/profile.ts                                    # PC-sampling profile of a boot, symbolized
images/build.sh [name...]      # guest images in rootless Podman -> target/images/{linux,kvm-unit-tests}/ (--check <name>)
cargo test --release --test boot -- --ignored --nocapture   # boot target/images/linux natively (ci.sh runs it when images exist)
cargo test --release --test kvm_unit_tests -- --ignored --nocapture   # kvm-unit-tests, likewise
cargo test --release --test distros [alpine|debian] -- --ignored --nocapture  # distro boots (Debian: ~8 min native, occasional only)
cargo test --release --test ltp -- --ignored --nocapture   # LTP subset + arm64 kselftests in the guest (images/build.sh ltp linux; ~45 s)
npm run bench -- --page bench/boot/index.html --only fio   # realtime I/O suite: dd, fio, p9, net; boot_alpine for Alpine boot times
WEBPC_DISTROS=alpine,debian scripts/ci.sh   # which distro boots ci.sh and npm test run (default: alpine when current)
WEBPC_LOCKSTEP_STEPS=300000000 node --test tests/jit-lockstep.test.ts   # long JIT vs interpreter lockstep (CI runs 20M)
tests/qcow2/make.sh            # regenerate the qcow2 reader's fixtures with qemu-img
npm run bench -- --page bench/boot/index.html --only dd    # realtime virtio-blk read throughput (also: boot_defconfig)
(cd core/fuzz && cargo run --release --bin sweep [-- sys])    # exhaustive decoder check vs Capstone (~3 min; sys: MRS/MSR/SYS at EL1, seconds)
(cd core && cargo fuzz run virtqueue)                         # libFuzzer on the virtio-mmio transport and split-queue parser
tests/baremetal/build.sh && tests/baremetal/oracle.sh [--hvf] # rebuild the bare-metal EL1 tests (.bin committed), run them on QEMU virt (TCG, or hvf on the Mac)
```

`scripts/ci.sh` must pass before any piece of work is considered done.

## Layout

`core/` Rust core (native + wasm32) · `bench/` harness, spike, results · `tests/` node and
Chromium tests · `tools/serve.ts` dev server · `scripts/` build/CI entry points. PLAN.md §3 lists
the planned directories.

## Conventions

**Rust (core)**
- The nightly is pinned in `rust-toolchain.toml`. wasm threads need `-Zbuild-std` and `-Zllvm-target-feature=+atomics` (see `.cargo/config.toml`). Bump the toolchain deliberately and re-run the benchmarks.
- The core also builds natively, so logic is unit-tested with `cargo test`. Keep wasm-only code behind `cfg(target_arch = "wasm32")`.
- SMP-ready from day one: no mutable globals. All vCPU state sits behind a per-vCPU pointer, and guest atomics use real atomics even single-core.
- Every `unsafe` block gets a `// SAFETY:` comment. Exports to the host are `#[unsafe(no_mangle)] extern "C"`, and `ABI_VERSION` is bumped when they change.

**TypeScript (host, tools, tests)**
- No build step: Node runs `.ts` directly, and `tools/serve.ts` strips types for the browser. Use **erasable syntax only** (no enums, namespaces or parameter properties; `tsconfig.json` enforces this). Import with `.ts` extensions.
- Keep dependencies minimal: stdlib and platform APIs first. Ask before adding a dependency.
- Anything that runs in the browser must work with cross-origin isolation (COOP/COEP) on.

**Testing** (PLAN.md §4)
- New behavior comes with tests at the cheapest layer that catches it.
- From M1: instruction semantics need golden-corpus coverage, and JIT changes must pass lockstep against the interpreter.
- Oracles: `qemu-aarch64` is installed locally (user mode). Real arm64 hardware: the Lima VM `oracle` (Debian 13) on the M4 Mac, reached with `ssh macmini.lan /opt/homebrew/bin/limactl shell oracle <cmd>` (see PLAN.md §4.2). Don't depend on GitHub-hosted runners.

**Performance** (PLAN.md §5)
- Don't claim a speedup or regression without numbers from `bench/run.ts` in Chromium. Report medians and IQR, the host and the Chromium version.
- Commit the result JSON that backs any written report (`bench/spike/results/` style). Ad-hoc runs go to the gitignored `bench/results/local/`.
- The machine is a shared desktop, so treat differences under ~5% as noise unless repeated.

**Guest images**
- Build them only in rootless Podman, through `images/` (PLAN.md §7 M3). Never install cross toolchains or build dependencies on the host, and never use Docker.

**Browsers**
- Chromium only: `/usr/bin/chromium`, driven by Playwright (`playwright-core`, temporary profile, headless).
- **Never launch, automate or touch Firefox.** It's the user's daily browser. Firefox incompatibilities are never blockers.

**Licensing**
- The project is MIT.
- Before porting code, check `THIRD_PARTY.md`. Copy only from projects in the permissive table, keep their headers, and add an attribution row.
- GPL, EPL and CeCILL projects (QEMU, Unicorn, kvm-unit-tests, LTP, risu, herdtools7) are oracles, guest workloads or behavioral references only. **Never copy their code.**

**Git**
- A local repository only, with no remote yet. Don't add one.
