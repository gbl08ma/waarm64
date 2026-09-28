# webpc

A whole-system AArch64 emulator for the browser. It JIT-compiles guest code to WebAssembly and
runs unmodified arm64 Linux. Chromium is the primary target.

## Where things are written down

- **`PLAN.md`**: the decisions that bind, the milestones (done, current, next) and the risks. When
  a decision changes, update PLAN.md (and the doc it affects) in the same change.
- **`docs/`** ([index](docs/README.md)): how things work now, by topic: architecture, cpu,
  platform, devices, abi, jit, v8, testing, benchmarking, images, backlog. Read the relevant page
  before changing an area; update it with the change. State what exists; keep history out unless
  it's a finding worth not re-discovering (then say what was tried and why it lost).
- `bench/*/REPORT.md`: dated measurement journals with committed JSON. Read `bench/spike/REPORT.md`
  and [docs/v8.md](docs/v8.md) before designing JIT, dispatch or TLB code.
- `THIRD_PARTY.md`: verified licenses of reference projects and the attribution of ported code.
- `M<n>-KICKOFF.md` (untracked): the user's brief for a milestone.

## Status

M0–M6.5 are done (the summary table is in PLAN.md §3): the interpreter, the golden corpus, Linux
with virtio devices, Alpine and Debian, a JIT that boots Alpine in ~10 s in Chromium, the crypto
extensions. **Now: M7 (SMP)**, from `M7-KICKOFF.md` (loops 0–5 done: PLAN.md §3). Loose ends go in [docs/backlog.md](docs/backlog.md),
not in TODOs.

## Development environment

Development happens in the Lima VM **`dev`** on the M4 Mac mini (`macmini.lan`: 10 cores, 24 GiB,
macOS 26), not on the x86_64 desktop (which the user needs for other work).
- openSUSE Tumbleweed aarch64, Lima `vz`, 8 vCPUs, 14 GiB, 150 GiB disk, no host mounts, from
  `template:experimental/opensuse-tumbleweed` with Lima's containerd off. Home is
  `/home/gabriel.guest`; the repo is `~/Development/webpc` (remote `origin` on GitHub).
- From outside: `ssh macmini.lan /opt/homebrew/bin/limactl shell dev`. Inside, `macmini.lan`
  points at the Mac host (`~/.ssh/config`). The `oracle` VM (Debian 13, 4 vCPUs, 8 GiB) shares the
  Mac: `ssh macmini.lan /opt/homebrew/bin/limactl shell oracle <cmd>`.
- Packages from zypper: Node 26, Chromium 153 (`/usr/bin/chromium`), clang/lld/llvm, qemu (user,
  system, tools), podman (rootless), dtc, capstone; Rust through rustup and `rust-toolchain.toml`.
  Add what's missing with `sudo zypper in`, and note it here.
- Dev-only tools (not repo dependencies, not in tests or CI): `perf` (with V8's `--perf-prof`;
  `perf_event_paranoid` is 2, so profile your own processes) and `wasm-tools` (`cargo +stable
  install --locked wasm-tools`, in `~/.cargo/bin`). Node's `--print-wasm-code` prints V8's machine
  code without either.
- Side checkouts: `../webpc-exp` and `../webpc-base` (detached worktrees for A/B experiments).
- Benchmark numbers from the x86_64 desktop (M0 to M5 step 7) aren't comparable with the VM's.

## Commands

```sh
scripts/ci.sh                  # everything CI runs (~5 min): fmt, clippy, cargo test, TestFloat, wasm build, tsc, Node + Chromium tests, image tests
scripts/build-wasm.sh          # wasm core -> target/wasm32-unknown-unknown/release/webpc_core.wasm
cargo test                     # native core tests
npm test                       # JS tests (tests/**/*.test.ts, incl. Chromium; needs the wasm build)
WEBPC_CORPUS=dp_imm,dp_reg node --test tests/corpus-wasm.test.ts   # corpus groups only (fast JIT iteration)
node --test tests/jit-diff.test.ts                                 # JIT vs interpreter on random words (WEBPC_JIT_DIFF=<n>)
WEBPC_LOCKSTEP_STEPS=300000000 node --test tests/jit-lockstep.test.ts   # long lockstep (CI runs 20M)
WEBPC_DISTROS=alpine,alpine-user,debian scripts/ci.sh   # which distro tests run (default: the current alpine images)
WEBPC_INTERP=1 node --test tests/boot-node.test.ts      # also the long guests' interpreter runs in Node
WEBPC_JIT_STRESS=1 node --test tests/boot-node.test.ts  # every Node boot under JIT-stress (hours; not routine)
cargo test --release --test boot -- --ignored --nocapture      # Buildroot natively (also: kvm_unit_tests, ltp, distros [alpine|debian])
images/build.sh [name...]      # guest images in rootless Podman -> target/images/<name>/ (--check <name>); docs/images.md
node tools/corpus/run.ts [--oracle qemu|m4|both] [group...]    # regenerate golden corpus groups (QEMU / the M4 oracle VM)
scripts/tsan.sh                # ThreadSanitizer on the native parallel SMP runner (in ci.sh)
WEBPC_PARALLEL_RUNS=20 cargo test --release --test baremetal baremetal_parallel   # parallel SMP, repeated
(cd core/fuzz && cargo run --release --bin sweep [-- sys])      # decoder sweep vs Capstone (~3 min; sys: seconds)
(cd core && cargo fuzz run virtqueue)                           # libFuzzer on the virtio transport
tests/baremetal/build.sh && tests/baremetal/oracle.sh [--hvf]  # rebuild the bare-metal tests, run them on QEMU (TCG or hvf)
scripts/testfloat.sh           # FP core vs TestFloat 3e (in ci.sh)
tests/qcow2/make.sh            # regenerate the qcow2 fixtures with qemu-img
npm run serve                  # dev server with COOP/COEP on :8080 (PORT overrides)
npm run bench -- --page bench/interp/index.html [--only jit_mips]       # small guests, CoreMark
npm run bench -- --page bench/boot/index.html --only boot_alpine_jit    # boots, userspace, openssl, I/O
bench/interp/build-coremark.sh # CoreMark -> target/bench/
node bench/boot/profile.ts     # PC-sampling profile of a boot, symbolized
node bench/spike/memory/run-all.ts   # M0.5 memory suite
```

The full benchmark list is in [docs/benchmarking.md](docs/benchmarking.md). **`scripts/ci.sh` must
pass before any piece of work is considered done.**

## Conventions

**Rust (core)**
- The nightly is pinned in `rust-toolchain.toml` (wasm threads need `-Zbuild-std` and
  `-Zllvm-target-feature=+atomics`, see `.cargo/config.toml`). Bump it deliberately and re-run the
  benchmarks; the core stays built **without `simd128`** ([docs/backlog.md](docs/backlog.md)).
- The core also builds natively, so logic is unit-tested with `cargo test`. Keep wasm-only code
  behind `cfg(target_arch = "wasm32")`.
- SMP-ready: no mutable globals; all vCPU state behind a per-vCPU pointer; guest atomics use real
  atomics even single-core.
- Every `unsafe` block gets a `// SAFETY:` comment. Exports are `#[unsafe(no_mangle)] extern "C"`,
  and `ABI_VERSION` is bumped when they change ([docs/abi.md](docs/abi.md)).

**TypeScript (host, tools, tests)**
- No build step: Node runs `.ts` directly, and `tools/serve.ts` strips types for the browser. Use
  **erasable syntax only** (no enums, namespaces or parameter properties; `tsconfig.json` enforces
  it). Import with `.ts` extensions.
- Keep dependencies minimal: stdlib and platform APIs first. **Ask before adding a dependency.**
- Anything that runs in the browser must work with cross-origin isolation (COOP/COEP) on.

**Testing** ([docs/testing.md](docs/testing.md))
- New behavior comes with tests at the cheapest layer that catches it. Instruction semantics need
  golden-corpus coverage; JIT changes must pass the differential test, lockstep and the exact-step
  boots.
- Step counts live in `tests/steps.txt`; they move only with a guest-visible change, once, in its
  commit (and guest-visible changes need the user's OK).
- Plant a bug for every new JIT rule and check the tests fail; restore the source **and rebuild
  the wasm** afterwards.
- Oracles: `qemu-aarch64` in the dev VM; real hardware is the `oracle` VM. Don't depend on
  GitHub-hosted runners.

**Performance** ([docs/benchmarking.md](docs/benchmarking.md))
- Don't claim a speedup or regression without numbers from `bench/run.ts` in Chromium: medians and
  IQR (from the JSON), host and Chromium version; differences under ~5% are noise unless repeated.
- Commit the result JSON behind any written report; ad-hoc runs go to `bench/results/local/`.
- Compare A/B in one session, alternating; small guests at eight placements.
- Rank changes by the long, real workloads (Alpine, Alpine userspace, Debian); don't optimize for
  very short runs (the Buildroot boot is a check, not a target) or fit the design to CoreMark.
- Peer comparisons (QEMU, native) are rare, one-off tables; **qemu-wasm is dropped for good**.

**Guest images**: only in rootless Podman through `images/`; never cross toolchains or build
dependencies on the host; never Docker ([docs/images.md](docs/images.md)).

**Browsers**: Chromium only, headless through Playwright (`playwright-core`, temporary profile).
**Never launch, automate or touch Firefox** (the user's daily browser; its incompatibilities are
never blockers). Never run `/usr/bin/chromium` directly except `--version` (it opens a window on
the user's desktop); for V8 flags use `node --v8-options`.

**Licensing**: MIT. Check `THIRD_PARTY.md` before porting code; copy only from the permissive table,
keep headers, add an attribution row. GPL, EPL and CeCILL projects (QEMU, Unicorn, kvm-unit-tests,
LTP, risu, herdtools7) are oracles, guest workloads or behavioral references only: **never copy
their code.**

**Git**: push to `origin` (GitHub) so the user can pull. Don't add other remotes.

## Working rules (learned the hard way)

- **Bound every run.** Wrap ad-hoc experiments, guest runs and benchmarks in `timeout N`, know
  the expected duration first, and keep each command under the Bash tool's ~600 s cap (a command
  that overruns is backgrounded and can stall unseen: a hung benchmark once sat 17 minutes, an
  experiment 9). Bound every wait too; if a run's CPU or progress doesn't match its expected time,
  kill it and investigate.
- **Never `pkill -f`/`pgrep -f` a pattern that appears in your own command line**: it kills your
  shell (exit 144) or makes a wait loop wait forever. Find the PID and `kill <pid>`; wait on
  background jobs through their completion notification, not polling loops. Before a benchmark
  session, check `ps -eo pcpu,etime,args --sort=-pcpu | head` for leftover experiments.
- **Don't boot complex guests under the interpreter in Node or Chromium** (minutes each, nothing
  the native interpreter run doesn't test). Iterate on the Buildroot guest and Alpine under the
  JIT; Debian is an occasional check (~1 min under the JIT in Chromium).
- Multi-hour JIT-stress runs aren't routine: short stress variants catch what they catch.
- Remove debug hooks that use `process` (e.g. module dumps in `web/vm.ts`) before any Chromium run.
- Temporary files go in the job's tmp directory; ad-hoc tools and results in
  `bench/results/local/`.
- Work through a milestone's loops without check-ins (one commit and a short report per loop);
  settle choices by measurement and ask only what can't be measured. The user is often watching:
  give short status lines during long runs.
