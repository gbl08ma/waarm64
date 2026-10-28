# webpc

A whole-system AArch64 emulator for the browser. It JIT-compiles guest code to WebAssembly and
runs unmodified arm64 Linux. Chromium is the primary target.

## Where things are written down

- **`PLAN.md`**: the decisions that bind, the milestones that built the emulator, **every track and its state**
  (§3), the risks. When a decision changes, update PLAN.md (and the doc it affects) in the same change.
- **`docs/`** ([index](docs/README.md)): how things work now, by topic. Read the relevant page
  before changing an area; update it with the change. State what exists; keep history out unless
  it's a finding worth not re-discovering (then say what was tried and why it lost). Loose ends go in
  [docs/backlog.md](docs/backlog.md), not in TODOs.
- `bench/*/REPORT.md`: dated measurement journals with committed JSON. Read `bench/spike/REPORT.md`
  and [docs/v8.md](docs/v8.md) before designing JIT, dispatch or TLB code.
- `THIRD_PARTY.md`: verified licenses of reference projects and the attribution of ported code.
- `<TRACK>-KICKOFF.md` and `<TRACK>-HANDOVER.md` in the repo root (e.g. `VK2-…`), **tracked** (so a fresh clone or a
  cloud session has them): the user's brief for a track (or one of its phases) and the notes that carry it from one
  session to the next. Several tracks can be open at once: `ls *-KICKOFF.md *-HANDOVER.md` shows which. Commit a
  handover with the work it describes; when a track ends, its outcome moves into docs/ and its row in PLAN.md §3, and
  its kickoff and handover are deleted in that commit (git history keeps them). A kickoff's content is the user's:
  change it only with their OK.

## Status

The emulator is complete: M0–M7 built the CPU, the platform, the devices, the JIT and SMP, and M8 made it a machine
to use in the browser. Work now runs as **tracks**, from the user's ideas and the backlog rather than a milestone
plan (PLAN.md §2–§3). This section stays short: a track's progress goes in its handover, its row in PLAN.md §3 and
its doc, never here. Facts most sessions need:
- The page (`web/app/`, [docs/frontend.md](docs/frontend.md)) starts no disk image: the user opens one. Debian 13
  through UEFI is the tests' guest (`?machine=debian`, `images/build.sh debian`); the desktop guest is Arch Linux with
  sway, PipeWire and Firefox (`images/arch/desktop.sh`). The page is deployed at `https://vm.tny.im` (`npm run dist`;
  deploy only when the user asks).
- Machines are stored in the browser with their disks and snapshots ([docs/plans/machines.md](docs/plans/machines.md));
  3D goes through virgl onto WebGL2, Vulkan through Venus onto WebGPU (`?gpu=vulkan`, in progress: `vk/README.md`).

## Development environment

Development happens in the Lima VM **`dev`** (openSUSE Tumbleweed aarch64, 8 vCPUs, 14 GiB) on the M4 Mac mini
(`macmini.lan`), not on the x86_64 desktop (which the user needs for other work). The repo is `~/Development/webpc`
(remote `origin` on GitHub). Real hardware is the `oracle` VM on the same Mac
(`ssh macmini.lan /opt/homebrew/bin/limactl shell oracle <cmd>`); real-GPU runs go to the Mac host through
`bench/gpu/sway-mac.sh`. What's installed and why, the USB rigs, Go, deploying (the Cloudflare token: never print
it) and the dev-only tools: [docs/devenv.md](docs/devenv.md). Add a missing package with `sudo zypper in` and note it
there.

**Cloud sessions** (Claude Code on the web) are a secondary path: an Ubuntu x86_64 container without Lima, Podman or
the macOS oracles, set up by `scripts/cloud-setup.sh`; there `systemd-run` doesn't work (run under `timeout` only).
Details: [docs/cloud.md](docs/cloud.md).

## Commands

```sh
scripts/ci.sh                  # what every change runs (~8 min): fmt, clippy, cargo test, TestFloat, wasm build, tsc, svelte-check, Node + Chromium tests, image tests, the long multi-vCPU runs
scripts/ci-net.sh              # the network tests on Debian (~4 min): also when a change touches the network (docs/testing.md)
scripts/ci-debian.sh           # Debian on the page (~3.5 min): also for the page, firmware, devices, disks, snapshots, display, guest-visible changes, track ends (docs/testing.md)
scripts/ci-machines.sh         # machines as the unit on Debian (~3.5 min): also for stored machines, their disks (stored, blank, ramdisk, overlays), their snapshots, the Machines page, track ends
scripts/ci-audio.sh            # the realtime sound tests on the page (~1 min, alone): also when a change touches sound (docs/testing.md)
scripts/ci-deqp.sh             # dEQP's pass lists on the page (~6 min): also when a change touches 3D (renderer, translator, caps, GPU worker), graphics track ends; needs images/deqp/build.sh
scripts/ci-deqp-vk.sh          # dEQP-VK's pass list on the page (~8 min): also when a change touches Vulkan (vk/, web/venus-gpu.ts, Venus), Vulkan track ends; needs images/deqp/build.sh vk
scripts/ci-usb.sh              # USB through the dev VM's host rigs (dummy_hcd gadgets, uhid; alone): also when a change touches USB; "skipped: <why>" without the rigs (docs/testing.md "USB")
scripts/ci-fp.sh               # the FP suite in the guest (~3 min): TestFloat through every FP form under the JIT; also when a change touches floating point (the JIT's FP, the FP core); needs images/build.sh linux fptest
scripts/build-wasm.sh          # wasm core -> target/wasm32-unknown-unknown/release/webpc_core.wasm
cargo test                     # native core tests
npm test                       # JS tests (tests/**/*.test.ts, incl. Chromium; needs the wasm build)
npm start                      # what a user runs: builds everything and serves the page (docs/frontend.md)
npm run serve                  # Vite's dev server with COOP/COEP and hot reloading on :8080
images/build.sh [name...]      # guest images in rootless Podman -> target/images/<name>/; docs/images.md
```

Everything else (the corpus, the JIT's tests, the oracles, the USB rigs, the network clients, the renderer,
benchmarks): [docs/devenv.md](docs/devenv.md) "Commands" and [docs/benchmarking.md](docs/benchmarking.md).
**`scripts/ci.sh` must pass before any piece of work is considered done** (and `scripts/ci-debian.sh` when it touches the page, the firmware, the devices, disks, snapshots or
the display, for guest-visible changes and at the end of a track; `scripts/ci-machines.sh` when it touches stored machines, their disks or snapshots, or the Machines page; `scripts/ci-net.sh`
when it touches the network; `scripts/ci-audio.sh` when it touches sound; `scripts/ci-deqp.sh` when it touches 3D; `scripts/ci-deqp-vk.sh` when it touches Vulkan; `scripts/ci-fp.sh` when it touches floating point; `scripts/ci-usb.sh` when it touches USB). **Exception:** a change that only edits docs (`.md` files or code comments)
needs no CI run.

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
- No build step for Node: tools, tests and `bench/` run `.ts` directly. The page is built with **Vite**
  (`vite.config.ts`, Svelte's plugin; docs/frontend.md "The build"): the dev server (`tools/serve.ts`, the tests'
  and benchmarks') compiles per request, `npm run dist` and `npm start` bundle. Use **erasable syntax only** (no
  enums, namespaces or parameter properties; `tsconfig.json` enforces it). Import with `.ts` extensions, and npm
  packages as packages (no copied code or import maps). A worker is `new Worker(new URL('./x.ts',
  import.meta.url), { type: 'module' })` written out whole (Vite bundles only that form; options static).
- Stdlib and platform APIs first where they suit; past them, use a dependency. **Ask before adding one**: each is vetted
  (not too many, none redundant, none of known bad quality). Fewest dependencies isn't a goal in itself: an
  industry-standard set of dependencies and build steps beats a bespoke setup.
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
  IQR (from the JSON), host and Chromium version; in one session's alternated A/B (≥3 rounds), a
  difference counts when the arms' rounds don't overlap and it's past ~1% (Buildroot's boot ~3%);
  across sessions the host moves runs by up to ~8% (docs/benchmarking.md "Rules").
- Commit the result JSON behind any written report; ad-hoc runs go to `bench/results/local/`.
- Compare A/B in one session, alternating; small guests at eight placements.
- Rank changes by the long, real workloads (Alpine, Alpine userspace); don't optimize for
  very short runs (the Buildroot boot is a check, not a target) or fit the design to CoreMark.
- Peer comparisons (QEMU, native) are rare, one-off tables; **qemu-wasm is dropped for good**.

**Guest images**: only in rootless Podman through `images/`; never cross toolchains or build
dependencies on the host; never Docker ([docs/images.md](docs/images.md)).

**Browsers**: Chromium only, headless through Playwright (`playwright-core`, temporary profile).
**Never touch Firefox outside the dev VM** (the user's daily browser is elsewhere); inside it, headless
Firefox through Playwright is fine for checks (docs/backlog.md "Firefox"), and its incompatibilities are never blockers. Never run `/usr/bin/chromium` directly except `--version` (it opens a window on
the user's desktop); for V8 flags use `node --v8-options`. A launcher whose Chromium decodes video passes
`env: chromiumEnv()` (`tools/nosme.ts`): the M4 under Lima has SME but no SVE, and Chromium's SME kernels fault
reading a decoded frame without the shim ([docs/testing.md](docs/testing.md), "Video over virgl").

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
- **Cap memory on heavy runs** (`npm test`, `scripts/ci.sh`, multi-machine experiments):
  `systemd-run --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout N <cmd>`. A leak
  once grew a Node test process to 7 GB and the VM's OOM kill took the whole Claude session down
  (M8 loop 8); a capped scope dies alone. **Subagents cap every `node` and `cargo` run**, small
  ones too, with caps that sum under the VM's memory (a "pure TypeScript" unit test run uncapped
  with a planted bug reached 10 GB and killed the snapshots lane's first session), and tests
  never `assert.deepEqual` large buffers (a mismatch builds a diff of them): compare with
  `Buffer.compare` and fail with a short message.
- **Never `pkill -f`/`pgrep -f` a pattern that appears in your own command line**: it kills your
  shell (exit 144) or makes a wait loop wait forever. Find the PID and `kill <pid>`; wait on
  background jobs through their completion notification, not polling loops. Before a benchmark
  session, check `ps -eo pcpu,etime,args --sort=-pcpu | head` for leftover experiments.
- **Don't boot complex guests under the interpreter in Node or Chromium** (minutes each, nothing
  the native interpreter run doesn't test). Iterate on the Buildroot guest and Alpine under the
  JIT; Debian boots only through UEFI in Chromium (the page tests, ~1 min under the JIT), never natively, in Node or directly.
- Multi-hour JIT-stress runs aren't routine: short stress variants catch what they catch.
- **`scripts/ci.sh`, `scripts/ci-debian.sh`, `scripts/ci-machines.sh`, `scripts/ci-audio.sh`, `scripts/ci-deqp.sh`, `scripts/ci-deqp-vk.sh`, `scripts/ci-fp.sh` and `scripts/ci-usb.sh` run alone, one at a time, in the background** (each is at or over the
  Bash tool's cap): start it, wait for its notification, and run no other Chromium, QEMU or benchmark work beside it (a contended run was cancelled by a
  timeout; a timing-sensitive unit test failed only under its load). `cargo fmt --all` first: it is CI's first step.
- `tsc` covers `bench/`, the git-ignored files under `bench/results/local/` too; `tests/browser.test.ts` pins the
  ABI number.
- Remove debug hooks that use `process` (e.g. module dumps in `web/vm.ts`) before any Chromium run.
- Temporary files go in the job's tmp directory; ad-hoc tools and results in
  `bench/results/local/`.
- **Out-of-context reviews** ([docs/testing.md](docs/testing.md) "Out-of-context reviews"): at each track's end, and
  mid-track every ~3 loops or after a loop that adds a subsystem, a fresh agent with only the repo and a neutral brief
  (the area, "find real defects", a symptom at most; never the handover's theories or what was ruled out) reviews the code statically and
  leaves ranked findings on a `review/<area>` branch. The supervisor triages them into fix loops or the backlog; each
  fix starts with its confirming test, failing first. (VK3's static review of one picture's path found six defects
  that fit the bug being chased and eight more besides, all missed by the loops that wrote the code.)
- Work through a track's loops without check-ins (one commit and a short report per loop);
  settle choices by measurement and ask only what can't be measured. The user is often watching:
  give short status lines during long runs.
