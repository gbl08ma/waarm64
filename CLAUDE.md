# waarm64

A whole-system AArch64 emulator for the browser. It JIT-compiles guest code to WebAssembly and
runs unmodified arm64 Linux. Chromium is the primary target.

## Where things are written down

- **`PLAN.md`**: the index of tracks and nothing else: one line per track (a name, a state with a date, links). Edit it
  only when a track opens, changes state or ends, and keep the row a line: what a track did goes in its doc, its
  numbers in its REPORT.md, its progress in its handover.
- **[docs/decisions.md](docs/decisions.md)**: the decisions that bind. Changing one is the user's call; update it (and
  the doc it affects) in the same change.
- **`docs/`** ([index](docs/README.md)): how things work now, by topic. Read the relevant page
  before changing an area; update it with the change. State what exists; keep history out unless
  it's a finding worth not re-discovering (then say what was tried and why it lost). Loose ends go in
  [docs/backlog.md](docs/backlog.md), not in TODOs.
- `bench/*/REPORT.md`: dated measurement journals with committed JSON. Read `bench/spike/REPORT.md`
  and [docs/v8.md](docs/v8.md) before designing JIT, dispatch or TLB code.
- `THIRD_PARTY.json`: verified licenses of reference projects, the dependencies, and the attribution of ported code: the
  authoritative, machine-readable list (no THIRD_PARTY.md; [docs/third-party.md](docs/third-party.md) says how to keep it).
  Its rows marked `about` are what the page's About pane credits.
- `docs/plans/`: a track's plan doc, when it needs one.
- `<TRACK>-KICKOFF.md` and `<TRACK>-HANDOVER.md` in the repo root (e.g. `VK2-…`), **tracked** (so a fresh clone or a
  cloud session has them): the user's brief for a track (or one of its phases) and the notes that carry it from one
  session to the next. Several tracks can be open at once: `ls *-KICKOFF.md *-HANDOVER.md` shows which. Commit a
  handover with the work it describes; when a track ends, its outcome moves into docs/ and its row in PLAN.md, and
  its kickoff and handover are deleted in that commit (git history keeps them). A kickoff's content is the user's:
  change it only with their OK.

## Status

The emulator is complete: M0–M7 built the CPU, the platform, the devices, the JIT and SMP, and M8 made it a machine
to use in the browser. Work now runs as **tracks**, from the user's ideas and the backlog rather than a milestone
plan (the tracks: PLAN.md). This section stays short: a track's progress goes in its handover and its doc, never
here. Facts most sessions need:
- The page (`web/app/`, [docs/frontend.md](docs/frontend.md)) starts no disk image: the user opens one. Debian 13
  through UEFI is the tests' guest (`?machine=debian`, `images/build.sh debian`); the desktop guest is Arch Linux with
  sway, PipeWire and Firefox (`images/arch/desktop.sh`). The page is deployed at `https://vm.tny.im` (`npm run dist`;
  deploy only when the user asks).
- Machines are stored in the browser with their disks and snapshots ([docs/machines.md](docs/machines.md));
  3D goes through virgl onto WebGL2, Vulkan through Venus onto WebGPU (`?gpu=vulkan`, in progress: `vk/README.md`).

## Development environment

Development happens in the Lima VM **`dev`** (openSUSE Tumbleweed aarch64, 8 vCPUs, 18 GiB) on the M4 Mac mini
(`macmini.lan`), not on the x86_64 desktop (which the user needs for other work). The repo is `~/Development/waarm64`
(remote `origin` on GitHub). Real hardware is the `oracle` VM on the same Mac
(`ssh macmini.lan /opt/homebrew/bin/limactl shell oracle <cmd>`); real-GPU runs go to the Mac host through
`bench/gpu/sway-mac.sh`. What's installed and why, the USB rigs, Go, deploying (the Cloudflare token: never print
it) and the dev-only tools: [docs/devenv.md](docs/devenv.md). Add a missing package with `sudo zypper in` and note it
there.

**Cloud sessions** (Claude Code on the web) are a secondary path: an Ubuntu x86_64 container without Lima, Podman or
the macOS oracles, set up by `scripts/cloud-setup.sh`; there `systemd-run` doesn't work (run under `timeout` only).
dEQP-VK's disk and guest, which they can't build, are prebuilt at `https://static.gbl08ma.com/diskimages/deqp-vk.ext4`
and `.../guest-vk.qcow2` (fetch them into `target/deqp/`). Details: [docs/cloud.md](docs/cloud.md).

## Commands

```sh
scripts/ci-fast.sh             # the fast lane (T1, ~2–3 min, ≤ 4.5 GiB): the static checks, the changed crates' tests, the smoke set and the changed areas' heavy tests (tests/areas.ts), reduced; after every change
scripts/ci.sh                  # before a push (T2, ~10.5 min): fmt, clippy, the Rust tests (cargo-nextest), TestFloat, wasm build, tsc, svelte-check, the page's linters, the i18n checks, the areas map's check, Node + Chromium tests, image tests, the long multi-vCPU runs
scripts/ci-net.sh              # the network tests on Debian (~5 min): also when a change touches the network (docs/testing.md)
scripts/ci-debian.sh           # Debian on the page (~5 min): also for the page, firmware, devices, disks, snapshots, display, guest-visible changes; --platform (~6.5 min) adds the USB keyboard in the firmware, the clock catch-up and the clipboard with sway, for those and track ends (docs/testing.md)
scripts/ci-graphics.sh         # graphics on Debian (~3 min): also for the display, 3D, Venus's device, track ends: the Machine menu's 3D or 2D, vkcube through Venus
scripts/ci-machines.sh         # machines as the unit on Debian (~4 min): also for stored machines, their disks (stored, blank, ramdisk, overlays), their snapshots, the Machines page, track ends
scripts/ci-audio.sh            # the realtime sound tests on the page (~1 min, alone): also when a change touches sound (docs/testing.md)
scripts/ci-deqp.sh             # a seeded sample of dEQP-GLES's pass lists on the page (~11 min; --full the whole lists, ~49 min): also when a change touches 3D (renderer, translator, caps, GPU worker), graphics track ends; needs images/deqp/build.sh
scripts/ci-deqp-vk.sh          # a seeded sample of dEQP-VK's pass list on two machines and the programs' replays on the page (~12.5 min, under a 14 GiB `MemoryMax`): also when a change touches Vulkan (vk/, web/venus-gpu.ts, Venus); --full the whole list (~47 min): Vulkan track ends, cross-cutting changes (docs/testing.md); a sample's failure is fixed at once or filed and taken out of the list; needs images/deqp/build.sh vk
scripts/ci-usb.sh              # USB through the dev VM's host rigs (dummy_hcd gadgets, uhid; alone): also when a change touches USB; "skipped: <why>" without the rigs (docs/testing.md "USB")
scripts/ci-jit.sh              # the JIT's JIT-stress and JIT-check variants (~2 min, alone): also when a change touches the JIT (its emitters, runtime, code cache, what compiled code reads), JIT track ends; ci.sh keeps the plain JIT's runs
scripts/ci-fp.sh               # the FP suite in the guest (~8.5 min): TestFloat through every FP form under the JIT; also when a change touches floating point (the JIT's FP, the FP core); needs images/build.sh linux fptest
scripts/build-wasm.sh          # wasm core -> target/wasm32-unknown-unknown/release/waarm64_core.wasm
cargo test                     # native core tests
npm test                       # JS tests (tests/**/*.test.ts, incl. Chromium; needs the wasm build)
npm start                      # what a user runs: builds everything and serves the page (docs/frontend.md)
npm run serve                  # Vite's dev server with COOP/COEP and hot reloading on :8080
images/build.sh [name...]      # guest images in rootless Podman -> target/images/<name>/; docs/images.md
```

Everything else (the corpus, the JIT's tests, the oracles, the USB rigs, the network clients, the renderer,
benchmarks): [docs/devenv.md](docs/devenv.md) "Commands" and [docs/benchmarking.md](docs/benchmarking.md).
**CI runs in tiers** ([docs/testing.md](docs/testing.md) "Tiers"): `scripts/ci-fast.sh` after every change; before
a push, `scripts/ci.sh` and the topic scripts of the areas the branch touched (docs/testing.md's change table, which
`ci-fast.sh` prints at its end: e.g. the network → `ci-net.sh`, Vulkan → `ci-deqp-vk.sh`); at a track's end the whole
set. A piece of work is done when its push tier passed. A handover says which tier each commit passed. A new file goes
in an area of `tests/areas.ts` (the map's check fails otherwise). **Exception:** a change that only edits docs needs no
CI run (`tools/i18n-check.ts` if it changes a `(ui:` quote).

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
- **The page's code** (`web/app/`) follows [docs/frontend-code.md](docs/frontend-code.md): design tokens, shared
  components, small components, reactive state by area.
- **The host's code** (`web/*.ts`: devices, workers, renderers) follows [docs/host-code.md](docs/host-code.md): no
  allocation per event on hot paths, teardown frees what start took, worker failures reach their owner; linted and
  formatted like the page, without its size rules.
- **Words the user reads come from the catalog** (`web/messages/en/`, i18next; [docs/i18n.md](docs/i18n.md)): a new
  message gets an entry with a note, keyed by its source file; workers, libraries, the core and C send keys, codes and
  data, only the page renders; errors for the user are `MsgError`s (headline, cause as details). `tools/i18n-check.ts`
  (in `scripts/ci.sh`) checks it, the docs quote the page as `[words](ui:key)`, and tests take its words from the
  catalog (`t`, `tests/words.ts`; a test that pins words is its own `wording: …` case).

**Testing** ([docs/testing.md](docs/testing.md))
- New behavior comes with tests at the cheapest layer that catches it. Instruction semantics need
  golden-corpus coverage; JIT changes must pass the differential test, lockstep and the exact-step
  boots (`scripts/ci.sh`), and their JIT-stress and JIT-check variants (`scripts/ci-jit.sh`).
- Step counts live in `tests/steps.txt`; they move only with a guest-visible change, once, in its
  commit (and guest-visible changes need the user's OK).
- Plant a bug for every new JIT rule and check the tests fail; restore the source **and rebuild
  the wasm** afterwards.
- Oracles: `qemu-aarch64` in the dev VM; real hardware is the `oracle` VM. Never depend on GitHub-hosted runners as an
  oracle or as the gate: a workflow there would be an extra check beside the dev VM's (none while the repo is private).

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

**Licensing**: MIT. Check `THIRD_PARTY.json` before porting code; copy only from the permissive section,
keep headers, add an attribution row (and mark it `about` when the code ships: docs/third-party.md). GPL, EPL and CeCILL projects (QEMU, Unicorn, kvm-unit-tests,
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
  `systemd-run --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout N <cmd>` (6G for `scripts/ci-fast.sh`; 11G for `npm test` and the
  other `scripts/ci*.sh` scripts, whose JS step peaks near 10G: docs/backlog.md; 14G for `scripts/ci-deqp-vk.sh`'s two machines). A leak
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
- **`scripts/ci.sh` and the topic scripts take the machine's CI lock exclusive** (`scripts/ci-lock.sh`,
  `/tmp/waarm64-ci.lock`), and `scripts/ci-fast.sh` takes it shared: they queue by themselves. Start them in the
  background (each can pass the Bash tool's cap) under their memory cap and wait for the notification. Run no other
  Chromium, QEMU or benchmark work beside an exclusive one (a contended run was cancelled by a timeout; a
  timing-sensitive unit test failed only under its load). `cargo fmt --all` first: it is CI's first step.
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
- **How a track runs:** it starts from a kickoff brief the user confirms (goal, decisions taken, loops, what needs
  their OK, validation, the end). Work through its loops without check-ins (one slice, one commit and a short report
  per loop); settle choices by measurement and ask only what can't be measured: dependencies, host ABI changes (a
  design note in [docs/abi.md](docs/abi.md) first), guest-visible changes and step counts, CPU features, FP semantics,
  forcing TurboFan. The user is often watching: give short status lines during long runs.
- **A track ends** with every test layer green, its numbers recorded, its docs updated, its loose ends in the backlog,
  and its row in PLAN.md set to done.
