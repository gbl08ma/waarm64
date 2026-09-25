# webpc

A whole-system AArch64 emulator for the browser. It JIT-compiles guest code to WebAssembly
and runs unmodified arm64 Linux. Chromium is the primary target.

- **`PLAN.md` is the source of truth** for decisions, architecture and milestones. When a decision changes, update PLAN.md in the same change. Don't let code and plan drift apart.
- `THIRD_PARTY.md` holds the verified licenses of reference projects and the attribution of any ported code.
- `bench/spike/REPORT.md` has the measured JIT design numbers from M0. Read it before designing JIT, dispatch or TLB code.

## Status

- M0 (foundations + spike): done. Still pending: re-run the spike on Chromium arm64 on the M4 Mac.
- M0.5 (memory architecture): done on x86_64 and arm64 (M4), **layout A**: one shared wasm32 memory with core state then guest RAM, and a wasm32 Rust core. TLB tag bits 3–11 are reserved for a memory index. See `bench/spike/memory/REPORT.md`.
- M1 (A64 integer interpreter + golden corpus): done. Decoder `core/build.rs` ← `core/src/a64/a64.inc`; interpreter `core/src/interp*`; corpus `tests/corpus/` (grow it with `node tools/corpus/run.ts`, compare with `cargo test`); decoder fuzzing `core/fuzz`; MIPS `bench/interp/REPORT.md`.
- **Next: M2**, FP and AdvSIMD in the interpreter.

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
(cd core/fuzz && cargo run --release --bin sweep)             # exhaustive decoder check vs Capstone (~2 min)
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

**Browsers**
- Chromium only: `/usr/bin/chromium`, driven by Playwright (`playwright-core`, temporary profile, headless).
- **Never launch, automate or touch Firefox.** It's the user's daily browser. Firefox incompatibilities are never blockers.

**Licensing**
- The project is MIT.
- Before porting code, check `THIRD_PARTY.md`. Copy only from projects in the permissive table, keep their headers, and add an attribution row.
- GPL, EPL and CeCILL projects (QEMU, Unicorn, kvm-unit-tests, LTP, risu, herdtools7) are oracles, guest workloads or behavioral references only. **Never copy their code.**

**Git**
- A local repository only, with no remote yet. Don't add one.
