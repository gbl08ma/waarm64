# CI in tiers (the CI track's plan)

**Status:** written 2026-11-18 from the logs of that day's CI runs on the dev VM (static analysis only: the machine
was busy, so nothing here was re-measured; what needs a run is in "Measurements needed"). Two quick wins are merged (see "Quick wins": ci.sh 971 s
on the branch's first run in a cold worktree, the JS step 736 → 456 s; the native group is now the tail). The user's
decisions are in "Decisions"; the work runs as the CI track (CI-KICKOFF.md, CI-HANDOVER.md).

**The problem.** Every change waits ~15.5 min for `scripts/ci.sh`, and most changes add a topic script (1 to 14 min
each), all run alone on the shared dev VM. Batching CI to the end of a loop has problems of its own (a failure can't
be pinned on one change) and doesn't speed up small fixes. This plan finds where the time goes, then proposes tiers:
a fast lane after every change, a fuller run before a push, and the full set at track ends or nightly.

**Headlines.**
- **One file is `ci.sh`'s critical path.** `tests/jit-diff.test.ts` is 183 synchronous tests, ~650 s of CPU in a
  single process (node:test runs a file's tests in sequence), inside a 736 s JS step. Split four ways (done on this
  branch), it's ~167 s a part. Then the native group beside it (~540 s, TSan's ~295 s of it) becomes the long pole.
  Expected: `ci.sh` 935 s → ~745 s (−20%), to be measured.
- **~200 s of serial Rust and lint steps come before the JS tests**, and the checks that take seconds ran last of
  them: a type error surfaced after 168 s (qa/ci-1.log). They now come first.
- **91% of the JS test time is in 38 of 192 files**: the other 153 files take 310 s of test time together. A fast lane
  can run all 153 plus the heavy files a change reaches, with reduced sizes.
- **A static import graph can't pick tests**: 142 of 192 test files reach the wasm core and 140 reach `web/app/`.
  Selection needs a curated areas map, and later a coverage map that the nightly runs refresh.
- **The topic scripts serialize Debian boots**: `ci-net.sh` runs its ~10 Debian tests on one slot (the lock's
  default) and takes 13.7 min. `ci-debian.sh` uses 2 slots and `ci-machines.sh` 3.
- **Tiers, estimated:** fast lane **3–5 min**; before a push **~12 min** for `ci.sh`, plus the topic scripts a change
  names; the full set **~85 min** with dEQP sampled (~160 min with `--full`), nightly.

## 1. The measured profile

Sources: `bench/results/local/names/` (final-ci, ci-n6a, ci-n6b, final-ci-net, final-ci-debian, final-ci-machines) and
`bench/results/local/qa/` (ci-1 to ci-5, ci-names-1/2, ci-debian-1/2, ci-machines-1/2, ci-graphics-1, ci-audio-1,
ci-usb-1, ci-net-1/2), all from 2026-11-18. Step times come from `ci.sh`'s `== step (at N s)` lines. Per-file JS times
are sums of each file's top-level test durations. The spec reporter prints a file's tests together and in file order,
so each test line was assigned to its file by matching its name against the sources, in order. The
`boot-node*`/`jit-diff` names were assigned by their prefixes. Before hooks (a browser's and a server's start) and
process start-up aren't in those sums. `bench/results/local/` is git-ignored, so the scripts and their outputs are
only in that session's scratchpad. They're short and can be written again from this description.

### 1.1 `scripts/ci.sh` (final-ci.log: 935 s; ci-n6a 928, ci-n6b 932, ci-names-2 886, qa/ci-3 1086)

| Step | Wall (final-ci) | Notes |
|---|---:|---|
| rust fmt, clippy | 3 s | cached; an edited crate's clippy is not measured |
| **rust test** (`cargo test -q`) | **124 s** | binaries run one after another: core lib 34 s (370 tests), `core/tests/baremetal.rs` 43 s (7 tests), corpus 15 s, net/ts lib 31 s (288), the rest ~1 s. Compilation ~0 (cached) |
| agent (fmt, clippy, test; `images/build.sh agent`) | 19 s | its tests 18 s |
| testfloat | 23 s | 51.2M cases, release |
| wasm build, tailnet client ×2 | 0 s | cached (content-stamped); a cold or edited build is not in these logs |
| npm deps, lint deps | 0 s (35 s when `npm ci` ran: ci-n6a) | |
| typecheck (tsc 7) | 1 s | `tsc --incremental` would gain nothing |
| svelte-check | 4 s | |
| lint (ESLint type-checked, stylelint, prettier) | 14 s | ESLint's rules are type-aware, so `--cache` would miss cross-file changes: not proposed |
| i18n | 11 s | |
| third-party, harness imports | 0 s | |
| **js tests** (`npm test`, 7 files at a time) | **736 s** | 1,900 tests, 3,440 s of test time |
| native guest-image tests, **beside** the JS tests | ~540 s | boot 71, **TSan 295** (bare-metal parallel 93, Buildroot parallel 86, litmus 115), kvm-unit-tests 18, litmus 46, LTP 40, EDK2 11, gpu/snd/usb 6, Alpine 53 |

**Critical path:** 199 s of serial steps, then the JS step (736 s). The native group ends ~200 s before the JS step.

**JS step, the heavy files** (median of three runs' sums; Ch = Chromium):

| File | Test time | | File | Test time |
|---|---:|---|---|---:|
| **jit-diff** (183 tests, sync, CPU) | **649 s** | | page-modal (Ch) | 59 s |
| **browser** (Ch, 34 tests: Linux/litmus boots, page) | **416 s** | | page-run (Ch) | 57 s |
| venus-driver (Ch) | 191 s | | page-osk (Ch) | 54 s |
| wgsl (Ch) | 164 s | | page-connections (Ch) | 43 s |
| blockcache | 159 s | | page-clipboard-ui (Ch) | 41 s |
| boot-node-parallel | 138 s | | qcow2-write, page-pointers (Ch), hoststall | ~40 s each |
| boot-node-litmus (parallel litmus `-r 50`) | 120–150 s | | boot-node, page-surface, page-layout, page-local | 29–34 s |
| snapshot (Alpine userspace through snapshot files) | 120 s | | 14 more files | 15–25 s each |
| uefi (Alpine through EDK2) | 96 s | | **153 files under 15 s** | **310 s together** |
| corpus-wasm | 90 s | | | |
| virgl-browser (Ch) | 86 s | | | |

By kind: 79 Chromium files (1,705 s), 70 Node files on the wasm core (1,670 s), 42 Node-only files (6 s).

**Why jit-diff is the path:** its tests are synchronous, so they run in sequence in one process. 649 s of them fit in
the 736 s step only if the file started within the first ~85 s and ran to the end, alone at the end. The four
`boot-node*.test.ts` files were split the same way before (one suite module, a part by name), for the same reason.

### 1.2 The topic scripts

| Script | Wall | Shape | Its longest test (incl. lock waits) |
|---|---:|---|---|
| `ci-net.sh` | 783–851 s (5 runs) | 8 files, **one Debian slot** (lock default), then the tailnet client step alone (74 s) | the local helper on Debian 634 s; tailnet 551 s; the Network wizard 478 s |
| `ci-debian.sh` | 347 s; `--platform` 640–712 s | 2 slots | Debian's OS and power 346 s (`--platform`: 588 s) |
| `ci-machines.sh` | 325–368 s | 3 slots | the off-the-record cache 297 s; the five disks 168–198 s |
| `ci-graphics.sh` | 261 s | 2 slots, but one test is the wall | vkcube through Venus 261 s |
| `ci-audio.sh` | 49 s | alone (timing) | the snapshot while a tone plays 25 s |
| `ci-usb.sh` | 10 s | rigs | |
| `ci-jit.sh` | ~104 s (docs) | | |
| `ci-fp.sh` | ~8.5 min (docs) | | |
| `ci-deqp.sh` | ~11 min sample, ~49 `--full` (docs) | | |
| `ci-deqp-vk.sh` | ~12.5 min sample, ~47 `--full` (docs) | 14 GiB cap | |

A Debian test's duration includes its wait for a slot, so the longest test is roughly the script's wall time.

### 1.3 What the profile shows

**Serialization that isn't needed.**
1. jit-diff in one process (above). Fixed on this branch.
2. `cargo test` runs its binaries one after another (124 s, the longest binary 43 s). Running them at once would take
   ~45 s.
3. The seconds-long checks came after the Rust tests. Fixed on this branch.
4. ci.sh's 199 s of Rust steps (rust test, agent, testfloat) run before the JS tests and don't need to. Moving them
   beside the JS tests saves wall time but adds load to the realtime tests (see "Risks").
5. ci-net's Debian tests take one slot at a time (`WAARM64_DEBIAN_SLOTS` unset there), where the other Debian scripts
   take 2 or 3.
6. ci-debian, ci-machines and ci-graphics run as three scripts with three ramps up and down. One runner with 3 slots
   would overlap them: ~933 s of walls in a row against an estimated ~730 s together.

**Work repeated across scripts.**
- **Every Chromium test file starts its own Vite dev server** (78 files call `startServer()`), and the server compiles
  the page's modules on first request, each time without a shared cache. A server shared through
  `--test-global-setup` (Node ≥ 24) would compile once. Saving: unknown. It's probably a few seconds of CPU a file,
  ~80 files a run (to measure).
- **Every Debian test boots Debian through UEFI** (~30 s to the login prompt in the VM; "login prompt after 30 s" in
  ci-net's log). Across ci-net, ci-debian, ci-machines and ci-graphics, that's ~30 lock holders and more boots than
  that. A booted-Debian snapshot as a fixture would save ~30–40 s a boot, but it changes what's tested (a user
  decision, §2.3).
- **Builds:** the wasm core, `ts.wasm`, `ts-test.wasm` and the polled core are content-stamped, so they cost 0 s when
  current. The repeated cost is the **cold start of a new worktree**: its `target/` has no Cargo or wasm outputs
  (docs/devenv.md "Worktrees"), so its first `ci.sh` builds the debug test binaries, the wasm core with `-Zbuild-std`,
  both `ts` modules, TSan's std and `target/tsan`. Probably several minutes; not in these logs.
- `page-venus` runs in both ci-graphics and ci-deqp-vk (261 s, deliberate: VK3 L6c). At a track's end it runs twice.

**Tests slow for no good reason.** Few. The fixed waits are mostly retry intervals inside bounded loops
(`waitForTimeout(1000)` while polling) or the behavior under test: net-guest's 20 s of unanswered DHCP, page-clock's
20 s of suspend, names-room's resolver retries. docs/testing.md "Waiting in tests" already bans settle timers. Time
goes to real guest work, not to sleeps. The costly patterns are structural: big sequential files and serialized
boots.

**Where memory, not CPU, forces running alone.** The JS step peaks near 10 GiB at 7 files at a time
([#289](https://github.com/gbl08ma/waarm64/issues/289): boot-node-litmus 3.1 GiB, a native test binary 2.6 GiB, TSan's litmus 1.7 GiB, Chrome renderers
up to 2 GiB, overlapping by chance). Under the 11 GiB cap on an 18 GiB VM, that leaves room for nothing else, so CPU
isn't what makes `ci.sh` exclusive: memory is. A Debian machine on the page is ~2–3 GiB (ci-machines runs 3 under
11 GiB), and a dEQP-VK machine is 5.6–6.3 GiB. Per-file peaks aren't known: measuring them is the first thing to do
(§9), because the fast lane's concurrency and any parallel lanes depend on them.

## 2. What each test guards: from changed files to tests

### 2.1 What a static import graph gives

A prototype followed ES imports, workers (`new URL('./x', import.meta.url)`), harness pages, `page.goto` paths
(`/web/app/` is the whole page) and the wasm and module artifacts back to their sources (`core/`, `net/ts/`, `vk/`).
Results:

| A change to | Test files reached | Their test time |
|---|---:|---:|
| any `core/` file (the wasm core) | 142 | 3,170 s |
| `web/qcow2.ts`, `web/overlay.ts`, `web/usb.ts`, `web/gpu.ts`, `web/devices.ts`, `web/snd.ts` | 138–141 | ~3,150 s |
| any `web/app/` component, the catalog | 94–97 | ~1,330 s |
| `net/ts/` | 118 | 1,666 s |
| `vk/` | 100 | 1,794 s |

The page's bundle and `web/vm.ts` import every device, so everything reaches everything. **Import-based selection
would select almost all tests.** Selection must say what a test *guards*, not what it can reach.

### 2.2 The design: an areas map, then a coverage map

1. **`tests/areas.ts`**, curated and checked by CI. Each area has its source globs, its **guard tests** (the files or
   name patterns that are about it), its heavy tests, and the topic script that owns it. An example of the areas
   (§4 has the full table): `disks` = `web/qcow2*.ts`, `web/overlay*.ts`, `web/stored.ts`, `web/blockcache.ts`,
   `web/diskcache.ts`, `web/ramdisk.ts`, `web/app/disks*` → `qcow2*`, `overlay*`, `blockcache`, `diskcache`,
   `ramdisk`, `page-disks`, `page-save`, `trim`, `chunked` → owner `ci-machines.sh`. A check (in T0) fails when a
   test file belongs to no area or a source file matches no glob, so the map can't rot silently.
2. **A coverage map, refreshed by every nightly run.** Node has `NODE_V8_COVERAGE` (worker threads included). For
   Chromium, CDP's `Profiler.startPreciseCoverage` runs per target, the page's workers too, through
   `Target.setAutoAttach`. The dev server serves sources at their own paths (`/web/app/...`), so a covered URL is a
   file. Result: `target/ci/coverage-map.json`, test file → source files it ran. Covered-but-not-guarded entries
   would give the import graph's answer again, so the map **narrows** areas: a component's change selects the page
   tests that ran that component's code, not every page test. Rust in the wasm core has no per-function JS coverage.
   A `core/` change goes by its areas (JIT, FP, MMU and so on).
3. **Fallbacks, always on:**
   - a changed test file selects itself;
   - a change outside every area selects the smoke set;
   - `package-lock.json`, `Cargo.lock`, `rust-toolchain.toml`, `.cargo/`, `vite.config.ts`, `tsconfig*.json` or
     `tools/serve.ts` selects the before-push tier (T2);
   - a change only to `.md` files runs `tools/i18n-check.ts` when the diff touches a `(ui:` quote, which docs-only
     changes skip today.

### 2.3 Mechanisms, and what's feasible

| Mechanism | Feasible? | Notes |
|---|---|---|
| Node file selection | yes | `node --test <files>` with `--test-concurrency=N` |
| Name patterns | yes | `--test-name-pattern` works across the parts of a split suite. jit-diff's per-test seed (this branch) makes a test run alone draw the same words |
| Reduced sizes in the fast lane | yes, already knobs | `WAARM64_JIT_DIFF=512` (649 s → ~80 s of CPU), `WAARM64_LONG_TESTS` unset, `WAARM64_PARALLEL_RUNS=1`, the corpus by group (`WAARM64_CORPUS=`) |
| cargo tests by crate | yes | Rust tests read only `core/`, `net/ts/`, `agent/`, `tests/{steps.txt,corpus,baremetal,qcow2,gpu,snd,dtb,p9,…}` and `target/images/`. A diff touching none of those skips clippy's, cargo's and testfloat's runs (~150 s) and the native group (~540 s of CPU beside the JS tests) |
| Running the test binaries at once | yes | `cargo test --no-run --message-format=json`, then run the binaries in parallel from each crate's directory. Or cargo-nextest (a dependency: ask) |
| wasm build caching | already | content-stamped. A shared `CARGO_TARGET_DIR` for worktrees (as `waarm64-base` does) would reuse std and crates.io builds. Builds would then queue on its lock |
| `tsc --incremental` | not worth it | tsc 7 checks everything in 1 s |
| Sharding the Chromium tests under a memory budget | yes | generalize `tests/debian-lock.ts` into a weighted budget: a test takes N GiB of a machine-wide budget before it starts its browser. Heavy files would then overlap by design, not by chance. Needs §9's per-file peaks |
| Reusing a booted Debian | yes, but a choice | a snapshot at the login prompt with the agent up, made once per Debian image's `.inputs` key (`target/ci/debian-booted.snap`), restored by the tests that don't test the boot. Saves ~30–40 s a boot × ~30 boots. The snapshot path becomes every test's dependency, and the boot path is tested less often. **User decision** |
| Trimming duplicate coverage | small | `page-venus` once per session at a track's end (−261 s). Native, Node and Chromium boots of the same guest are deliberate layers (interpreter natively, JIT in wasm, the browser's workers): keep them |

## 3. The tiers

### T0: static (every change, ~20–35 s)

`cargo fmt --check`, then at once: `tsc`, `svelte-check`, the page's linters, `i18n-check`, `third-party`,
`harness-imports`, and `cargo clippy` of the changed crates. Serial today: ~35 s. In parallel: ~15–20 s (bounded by
ESLint's 14 s). Catches: type errors, harness imports (the class of bug ci-net found on 2026-11-11), i18n and copy
rules, formatting. Misses: all behavior.

### T1: the fast lane (after every change, target ≤ 5 min, ≤ 4 GiB)

T0, plus:
- **cargo**: the changed crates' tests, with the binaries run at once. Core: lib + baremetal + corpus, ~45 s.
  `net/ts`: 31 s. `agent`: 18 s.
- **wasm and modules**: rebuilt when stale. An edited core's incremental release build (LTO, one codegen unit) isn't
  measured: it may dominate a JIT change's lane (§9).
- **the smoke set**: every test file whose median is under 15 s (153 files, 310 s of test time), at concurrency 4.
  Estimated ~2–3 min with the browsers' and servers' start-ups, which aren't in the sums (§9).
- **the area's heavy tests** (§4), reduced: jit-diff at 512 words a class (~20 s a part), boot-node's short guests
  only, no `WAARM64_LONG_TESTS`. The lane has a time budget, and heavy tests past it are named as not run.
- **its record**: each run appends a line to `bench/results/local/ci-history.jsonl` (tier, commit, changed files,
  selected and not selected files, failures, wall time). A later T2 failure on a change whose T1 passed is a miss,
  counted per area. That's how the map gets tuned.

Expected: **3–5 min** for a typical change (one area, no core edit). Up to ~6 for a core change, while the wasm
rebuild is unmeasured.

**What T1 misses, and how often that would have mattered.**
- The long guests: Alpine and its userspace benchmark, Alpine through EDK2, the parallel litmus at `-r 50`, Linux on
  4 parallel vCPUs in Chromium.
- Full jit-diff word counts: 8× fewer words. jit-diff caught all three `simd128` miscompiles, with sequences of
  ordinary density, so a reduced count would probably still catch that class.
- TSan, the native image tests, TestFloat (unless FP changed), and every Debian page test.
- Bugs that need the full load: today's "under ci.sh's load" failures were all **flakes**. Eight commits name one;
  none found a product defect, and ten commits name flakes.

The commit log doesn't record which layer first caught each real bug, so the miss rate can't be computed from
history. The `ci-history.jsonl` record is there to measure it from now on. What the log does show:
- most real defects of the last two months came from tests a change's own loop ran (its planted bugs, its area's
  tests);
- the out-of-context reviews found more than any CI layer;
- the topic scripts' noted catches are few: ci-net (a harness page's stale import, now caught by T0's
  `harness-imports`), ci-deqp-vk's sample (one case), ci-jit (planted bugs);
- x86_64 runs found two real bugs the arm64 VM didn't show (the JIT's FMA emulation, the renderer's attachments
  loop: docs/cloud.md).

### T2: before a push or a merge (~12 min plus topics)

`scripts/ci.sh`, whole, plus the topic scripts of the areas the branch touched (§4). With this branch's two changes,
ci.sh is estimated at ~745 s (the native group becomes the path at ~540 s from the JS tests' start).
- With the test binaries run at once (~−80 s) and TSan's three runs at once or moved to the core area: **~10–11 min**.
- An `--affected` mode that skips the Rust steps and the native group when no Rust input changed would bring a
  page-only branch to **~9 min** (35 s static + ~500 s JS).
- Misses: what only the track-end set runs (`--platform`, `--full` dEQP, the FP suite unless FP changed).

### T3: the full set (track ends, nightly in the background)

Everything:
- with dEQP sampled: ci.sh 15.5 + ci-net 13.7 + ci-debian `--platform` 11.3 + ci-machines 5.6 + ci-graphics 4.4 +
  ci-jit 2 + ci-fp 8.5 + ci-deqp 11 + ci-deqp-vk 12.5 + ci-audio 0.8 + ci-usb 0.2 ≈ **85 min**;
- with `--full` for both dEQPs: ≈ **160 min**.

Nightly, it also refreshes the coverage map and records the per-file memory peaks (§9) that the budget lock uses.
At the measured 18 GiB, T3 runs alone. Nightly means the user's night, when no session runs heavy work.

## 4. Change type → tier (a replacement for CLAUDE.md's "must pass" list)

Every change runs T1 for its areas. The table says what T1 selects beyond T0 and the smoke set, what T2 adds before a
push, and what a track's end adds (T3 for a track always means the whole set).

| Change type (paths) | T1 selects | T2 (before a push) | Track end |
|---|---|---|---|
| Docs only (`.md`, comments) | none; `i18n-check` if a `(ui:` quote changed | none | — |
| Tests only | the changed files | ci.sh if a shared helper changed | — |
| Page UI (`web/app/`, theme, the catalog) | node units of `web/app` (store, machines, statusbar, i18n, osk), the page tests the coverage map names, `page-run` | ci.sh; ci-machines for the store, Machines or Home pages | ci-debian |
| Page boot path, firmware, UEFI (`web/app/run/`, `images/edk2`, `core/src/{boot,fw_cfg,smbios}*`) | `uefi`, `firmware-files`, `page-run`, `page-open` | ci.sh + ci-debian | + `--platform` |
| Devices (`web/devices.ts`, `device-worker.ts`, `core/src/virtio*`) | `devices`, `virtio-guest`, `balloon`, `vsock`, the device's own | ci.sh + ci-debian | |
| Disks, overlays, qcow2, stored disks | `qcow2*`, `overlay*`, `blockcache`, `diskcache`, `ramdisk`, `trim`, `chunked`, `page-disks`, `page-save` | ci.sh + ci-machines | + ci-debian |
| Snapshots (`web/snapshot*.ts`, the core's save and restore) | `snapshot-file`, `snapshot-plan`, `snapshot-pool`, `page-snapshot*`, `page-restore`, `unrestorable` | ci.sh + ci-machines + ci-debian | |
| Display (virtio-gpu 2D, presenter, screen, cursor, EDID) | `gpu`, `gpu-present`, `display`, `page-resize`, `page-cursor`, `page-pointers` | ci.sh + ci-debian + ci-graphics | |
| Network (gateway, virtio-net, `web/net*.ts`, `local-net`, tailnet, tailcat) | `gateway`, `network`, `net`, `net-path`, `net-live`, `local-net`, `page-local`, `ts-client` | ci.sh + ci-net | |
| Rooms and names (`net/ts/src/room/`, `web/room*.ts`, `web/names*.ts`) | `cargo test -p waarm64_ts` (31 s), `room-*`, `names-*`, `nostr-relay` | ci.sh + ci-net | |
| Sound (virtio-snd, `web/snd.ts`, `web/audio-*`) | `snd`, `audio` | ci.sh + ci-audio | |
| 3D (virgl, TGSI, caps, GPU worker) | `virgl`, `virgl-video`, `gpu`, `virgl-browser` | ci.sh + ci-graphics + ci-deqp (sample) | ci-deqp `--full` |
| Vulkan (`vk/`, `web/venus-gpu.ts`, Venus's device) | `venus-*`, `wgsl` | ci.sh + ci-graphics + ci-deqp-vk (sample) | ci-deqp-vk `--full` |
| JIT (`core/src/jit/`, dispatcher, code cache, what compiled code reads) | core cargo, jit-diff at 512 words, `corpus-wasm` JIT, `jit-lockstep`, `jit`, the boot-node short guests (exact steps) | ci.sh + ci-jit | + ci-debian |
| FP (`core/src/fp*`, the JIT's FP) | + TestFloat (23 s), jit-diff's FP classes | ci.sh + ci-fp (+ ci-jit for the JIT's FP) | |
| Core, not JIT (interpreter, MMU, GIC, platform) | core cargo (lib, baremetal, corpus), `corpus-wasm`, `core-wasm`, boot-node bare-metal | ci.sh (+ ci-jit when compiled code reads it) | + ci-debian |
| Parallel SMP (the runner, atomics, the stop word) | + `boot-node-parallel` reduced | ci.sh (TSan in it) + ci-jit | |
| USB (xHCI, glue, WebUSB, WebHID, the USB tab) | `usb*` | ci.sh + ci-usb | ci-machines (Gadget Zero) |
| Guest agent (`agent/`) | agent cargo, `agent*` | ci.sh + ci-debian | + `--platform` |
| Guest images (`images/<name>`) | the tests that name the image | ci.sh + the scripts that use it | |
| Guest-visible changes, step counts | the exact-step boots | ci.sh + ci-debian | |
| CI scripts and tools | T0 + the changed script itself | ci.sh | |
| Dependencies, toolchain, Vite or tsconfig | — | ci.sh | T3 (a toolchain bump: the benchmarks too) |

## 5. Lanes and agents

- **One machine-wide lock for CI**, taken by every `scripts/ci*.sh` and the fast lane, in place of "run alone"
  coordinated by hand: `flock` on `/tmp/waarm64-ci.lock`. T2 and T3 take it exclusive, T1 takes it shared. A T1
  waits while a T2 runs, and a T2 waits for the T1s to drain. The Debian lock (`/tmp/waarm64-debian-page.lock`) is
  already machine-wide across worktrees.
- **A memory budget, not a fixed concurrency.** The weighted budget (§2.3) with a machine total of ~14 GiB:
  - each T1 lane is capped at 4 GiB (`systemd-run … MemoryMax=4G`), so two lanes fit beside an editor-only session;
  - T2 takes 11 GiB, exclusive;
  - CLAUDE.md's rule that subagents cap every `node` and `cargo` run stays.
- **Agents in parallel worktrees:**
  - run T1 after every change, in their own worktree, under the shared lock;
  - run T2 once before pushing, queued on the exclusive lock (Monitor-wait in the turn, memory: "Subagents wait in
    turn");
  - commit only after T2, or commit after T1 and push after T2. The handover says which tier each commit passed.
- **Worktree cold starts:** a first T1 in a fresh worktree builds everything. Either share `CARGO_TARGET_DIR`
  (builds queue on its lock, std and crates are reused), or accept one cold build per worktree. To measure (§9).
- **Batching:** a lane may run T1 after each small fix and one T2 per batch. A T2 failure is bisected over the batch
  with T1s, which is cheaper than a T2 per fix.

## 6. GitHub Actions: what could run there

CLAUDE.md says: "Oracles: `qemu-aarch64` in the dev VM; real hardware is the `oracle` VM. **Don't depend on
GitHub-hosted runners.**" That line is about oracles. Actions would be **an extra check, not a replacement for the
dev VM**: T2 and T3 stay on the dev VM, and an Actions failure is a signal, not a gate, unless the user decides
otherwise. **The wording should be clarified** (draft in §8) so that an Actions workflow doesn't read as breaking the
rule.

**The runners:**
- GitHub's standard Linux runner is x86_64 Ubuntu with 4 vCPUs and 16 GB for public repositories (smaller for
  private ones), ~14 GB of free disk, a 6 h job limit, no Lima, no USB rigs, and passwordless sudo.
- arm64 Ubuntu runners (`ubuntu-24.04-arm`) are free for public repositories, larger runners for private ones. They
  would remove most of the architecture differences below and could build the guest images natively in Podman.
  Whether the repository is public decides this.
- docs/cloud.md's x86_64 container is the closest precedent: the same Ubuntu, 4 vCPUs and 15 GiB.
  `scripts/cloud-setup.sh` does most of what a workflow needs.

**What could run there:**

| Part | x86_64 runner | Notes |
|---|---|---|
| T0 (static) | yes, ~3 min with setup | Node 26 (`actions/setup-node`), the pinned nightly through `rust-toolchain.toml`, `npm ci` twice |
| cargo tests, TestFloat, the agent's tests | yes | as a non-root user, so the agent's six root failures (docs/cloud.md) don't occur. dtc 1.7.2 is built as cloud-setup.sh does |
| `npm test` without images | yes, sharded | 3,440 s of test time at 3 files a job is ~20 min a job. Three or four jobs by file list (the areas map gives balanced shards) take ~8–12 min wall |
| The native image tests, `boot-node`'s guests | not on x86 without images | Buildroot, Alpine, the kernels, LTP, kvm-unit-tests and litmus are built in arm64 Podman: hours under qemu-user. Either an arm64 runner builds them (cached by each image's `.inputs` key), or they're prebuilt and hosted |
| Debian page tests (ci-debian, ci-machines, ci-net minus Podman's tailnet) | possible, slow | `tools/debian.ts` fetches the pinned qcow2 (403 MB); cloud-setup.sh fetches EDK2 from waarm64.com; `linux-snd`'s `snd-play` is missing, so `page-debian` skips. Debian boots ~2.5× slower than in the VM (147 s), so the realtime bounds may fail. One job per script |
| dEQP-GLES and dEQP-VK | no (x86) | the pass lists are a census on the M4's SwiftShader. x86 SwiftShader has 6 color attachments, not 8, and other differences. The disk and guest are on static.gbl08ma.com (1.3 GB) |
| USB rigs, Mac oracles, benchmarks | no | |

**What would have to change:**
- **Image caching:** `actions/cache` keyed by `images/SHA256SUMS` plus each image's `.inputs` for Debian, EDK2 and
  the agent; `target/deqp/` from static.gbl08ma.com if ever used. Hosting more prebuilt images there goes through
  the user's `.new` upload step (memory: static server upload).
- **Chromium:** `npx playwright-core install chromium`, or Chrome for Testing, with `CHROMIUM` pointing at it (every
  launcher honors it). That Chromium has no H.264, so the tests skip H.264 already where
  `CLAUDE_CODE_REMOTE` is set. Make that gate a general `WAARM64_HOSTED=1` (the damaged-chunk VP9 test too).
- **Memory caps:** a job is its own VM, so an OOM kills the job, not a session. Cap concurrency instead
  (`--test-concurrency=3`, `WAARM64_DEBIAN_SLOTS=1`). `systemd-run --user` has no user bus there;
  `sudo systemd-run --scope --uid=runner -p MemoryMax=…` works if a cap is wanted.
- **Time limits:** `timeout-minutes` per job (25 for a JS shard, 40 for a Debian job). Timing-bound tests (1 ms windows,
  audio, realtime round-robin) skip under `WAARM64_HOSTED=1`, or retry once. A hosted runner's noise isn't a bug.
- **Architecture-sensitive tests:**
  - the FMA arms: x86's V8 doesn't fuse, so `ARMS` is the emulated arm only and "the probe finds the fused madd on
    arm64" skips. That's also the reason to run there: it found the FMA bug;
  - x86's default NaN sign;
  - SwiftShader's limits (the dEQP lists, `venus-*` attachment counts);
  - the video decoders;
  - `tools/nosme.ts` (arm64-only, harmless).

  Step counts (`tests/steps.txt`) are emulated, so they're the same on any host.

**A first workflow, without YAML:** on push to `main` and on pull requests, five jobs: T0; cargo with TestFloat and the
agent; and three `npm test` shards, run without images and with `WAARM64_HOSTED=1`. Nightly, one more job: Debian's
page tests. Everything stays advisory until it has a month of green.

## 7. Quick wins

**Done on this branch (untested: they need §9's window, and ci-jit.sh for the first):**

1. **jit-diff in four parts.**
   - `tests/jit-diff.test.ts` → `tests/jit-diff-suite.ts`, run as `tests/jit-diff-[1-4].test.ts`, each every fourth
     test in their order (the `boot-node` pattern). The measured split is 168/170/167/162 s.
   - Each test now seeds the generator from its name (FNV-1a), so a part draws the same words whatever runs beside
     it, and a test run alone with `--test-name-pattern` draws what it drew in the full run. Before, one stream ran
     through all 183 tests: a new class moved every later test's words, and a failure didn't reproduce alone. The
     words drawn differ from before, once.
   - A tiny run (`WAARM64_JIT_DIFF=4`) passed all 183 across the four files, with no test in two parts.
   - Updated: `scripts/ci-jit.sh`, docs/testing.md, docs/devenv.md, docs/jit.md, docs/spill-memories.md and the
     comments that named the file.
   - Expected: `ci.sh` −~190 s (935 → ~745 s). The JS step's tail goes; the native group becomes the path.
2. **`ci.sh` runs the checks that take seconds first:** npm deps, tsc, svelte-check, lint, i18n, third-party and
   harness imports run right after `cargo fmt`, before clippy and the Rust tests. Nothing tested changes. A
   failing check reports at ~35 s instead of ~200 s (qa/ci-1.log failed at tsc after 168 s).

**Proposed, ranked by time saved per effort:**

| # | Change | Saves | Effort | Risk |
|---|---|---|---|---|
| 1 | `ci-net.sh` with `WAARM64_DEBIAN_SLOTS=2` (as ci-debian) | ~4–6 min of 13.7 (est.) | a line, plus one measured run | the rigs' ports: they already overlap outside the lock, so probably none |
| 2 | ci.sh `--affected`: skip clippy, cargo, TestFloat, the agent and the native group when no Rust input changed | ~150 s of wall and ~540 s of CPU on page-only branches | small (a path filter in bash) | a Rust input missed by the filter; the list is in §2.3 |
| 3 | Run cargo's test binaries at once | ~80 s | small | memory: the binaries' peaks overlap; a native test binary reached 2.6 GiB |
| 4 | TSan's three runs at once, or TSan only for core changes | ~150–200 s off the native path once the JS step is shorter | small | load beside the JS tests |
| 5 | The fast lane, `scripts/ci-fast.sh` (T1) with `tests/areas.ts` and its check | every change: ~15 min → 3–5 | medium (a loop or two) | the map's gaps, measured by `ci-history.jsonl` |
| 6 | One Debian runner for ci-debian, ci-machines and ci-graphics, 3 slots | ~3 min at a track's end | small | memory at 3 slots with graphics: measure |
| 7 | `browser.test.ts` in two or three parts | ~0 now; ~200 s once the native path is shorter | medium: one shared `context` (OPFS) across its boot tests | state between its tests |
| 8 | The machine-wide CI lock | no wall time; makes parallel lanes safe | small | a stale lock: flock releases on exit |
| 9 | A shared Vite server (`--test-global-setup`) | unknown (§9) | medium | tests that need their own server (dist, no isolation) keep theirs |
| 10 | A booted-Debian snapshot fixture | ~30–40 s a boot, ~15–20 min of slot time at a track's end | medium | changes what's tested: user decision |

## 8. Risks

- **Load and flakes.** Shortening the wall time by running more at once (the Rust steps beside the JS tests, the
  test binaries at once) raises the load that the realtime tests already flake under. Every "under ci.sh's load"
  failure in the log was a flake. Prefer cutting work (`--affected`, TSan by area) over packing it tighter.
- **The fast lane's false confidence.** A green T1 is not a green ci.sh. The handover says which tier a commit
  passed, and `ci-history.jsonl` counts the misses.
- **A rotting areas map.** Its T0 check (every test file in an area, every source file under a glob) and the nightly
  coverage map keep it honest.
- **jit-diff's new seeds** draw different words from before, once. A latent bug that only the old words hit would
  stop showing; one that the new words hit would show up as a "new" failure on an unrelated change. At 4,096 words
  a class, both are unlikely.
- **Memory with more processes.** Four jit-diff processes are small (2 MiB memories), but more Chromium files at once
  aren't. The budget lock needs the per-file peaks.

## 9. Measurements needed (a window with the machine idle)

**Shortened (2026-11-18):** CI-HANDOVER.md's "Next" item 2 replaces this list: the files 4 at a time, each in its
own scope (~45 min in all).

In order of what they unblock:
1. **Per-file memory peaks and wall times of `npm test`:** every file alone under `systemd-run … MemoryMax=…`,
   reading the scope's `memory.peak`, at concurrency 1. ~60 min (3,440 s of test time plus start-ups). This
   unblocks the budget lock, the fast lane's concurrency and the Actions shards.
2. **`scripts/ci.sh` on this branch, twice:** the jit-diff split's and the reordering's gain (~30 min). Then
   `scripts/ci-jit.sh` once (~2 min), for its `jit-diff-[1-4]` list.
3. **`WAARM64_DEBIAN_SLOTS=2 WAARM64_DEBIAN_TIMES=1 scripts/ci-net.sh`**, and once at the default for the holds
   (~25 min).
4. **The smoke set's wall time:** the 153 files under 15 s at concurrency 4, under a 4 GiB cap (~5 min).
5. **An edited core's incremental wasm build** (a one-line change in `core/src/jit/`) and a cold worktree's first
   `ci.sh` build time (~15 min).
6. **A Chromium file's start-up:** a server's start and its first page compile, from a small page test's timings
   with and without a warm server (~5 min).

## 10. Drafts for CLAUDE.md and docs/testing.md (applied in loop 1: docs/testing.md "Tiers" is the current copy)

**CLAUDE.md, "Commands"** (replacing the `scripts/ci.sh` line's description, adding one):
```sh
scripts/ci-fast.sh             # the fast lane (T1, ~3–5 min, ≤ 4 GiB): the static checks, the changed crates' tests, the smoke set and the changed areas' tests (tests/areas.ts); after every change
scripts/ci.sh                  # before a push (T2, ~12 min): fmt, clippy, cargo test, TestFloat, wasm build, tsc, svelte-check, the page's linters, the i18n checks, Node + Chromium tests, image tests, the long multi-vCPU runs; --affected skips the Rust steps when no Rust input changed
```

**CLAUDE.md, the paragraph after Commands** (replacing "**`scripts/ci.sh` must pass before any piece of work is
considered done** (and …)"):
> **CI runs in tiers** ([docs/testing.md](docs/testing.md) "Tiers"): `scripts/ci-fast.sh` after every change; before
> a push, `scripts/ci.sh` and the topic scripts of the areas the branch touched (docs/testing.md's change table:
> e.g. the network → `ci-net.sh`, Vulkan → `ci-deqp-vk.sh`); at a track's end the whole set. A piece of work is done
> when its push tier passed. A handover says which tier each commit passed. **Exception:** a change that only edits
> docs needs no CI run (`tools/i18n-check.ts` if it changes a `(ui:` quote).

**CLAUDE.md, "Working rules"**, the "run alone" rule becomes:
> `scripts/ci.sh` and the topic scripts take the machine's CI lock exclusive (`/tmp/waarm64-ci.lock`), and
> `scripts/ci-fast.sh` takes it shared: they queue by themselves. Start them in the background and wait for the
> notification. Run no other Chromium, QEMU or benchmark work beside an exclusive one. `cargo fmt --all` first.

**CLAUDE.md, "Testing", the oracles line:**
> Oracles: `qemu-aarch64` in the dev VM; real hardware is the `oracle` VM. Never depend on GitHub-hosted runners as an
> oracle or as the gate: a workflow there is an extra check beside the dev VM's tiers.

**docs/testing.md**, a new first section, **Tiers**, holding §3's four tiers, §4's change table (the authoritative
copy, in place of the per-script "it must pass too when…" sentences), and §5's lane rules. Then the script list as it
is, with each script's measured time updated (ci.sh ~15.5 min, ~12 after this branch; ci-net ~14; ci-debian ~6,
`--platform` ~11; ci-machines ~5.5; ci-graphics ~4.5). "Where each thing runs" gains a row for `tests/areas.ts`.

## 11. The user's decisions (2026-11-18)

1. **The tiers are the rule**, and §10's drafts for CLAUDE.md are accepted. They are applied with the loop that builds
   what they describe (`scripts/ci-fast.sh`, the CI lock), so CLAUDE.md never names a tool that isn't there; the
   oracles line, true now, is applied at once.
2. **jit-diff's per-test seeds are kept** (they are what lets a part, or one test alone, draw the same words as the
   whole run; they don't speed anything up by themselves).
3. **More tests may depend on the snapshot path**: a booted-Debian snapshot fixture for the Debian tests that don't
   test booting.
4. **GitHub Actions was a plan** (§6) while the repository was private, so no workflow spent the private repo's
   allowance; the repository is public since 2026-11-22, so §6 can be built, as an extra check beside the dev VM's,
   never the gate; its first job, the fast lane on each push to main, runs since 2026-11-22 (docs/testing.md
   "GitHub Actions"). **No CI image comes from static.gbl08ma.com**: images a workflow needs are built
   in it, or passed between its jobs as artifacts (the smaller ones), or kept across runs in the Actions cache.
5. **Popular, industry-standard Rust tools and dependencies are fine** (cargo-nextest; sccache if worth it).
6. **Faster guests for more tests** (the user, 2026-11-18): Buildroot guests built for a purpose where a test needs a
   Linux guest rather than Debian, their build cost kept down by caching each image by its config's hash. For the
   fixed-step role Alpine had: Alpine is to be used as its developers intend (taking new packages as they come, no
   fixed steps: a compatibility check), and a **Buildroot guest with a real SMP userspace workload** (stress-ng, xz,
   zstd, sqlite, openssl and the like, from Buildroot's checksummed sources, an init that runs them on every vCPU and
   ends with a checksum) takes the fixed-step place, so the exact-step runs exercise user mode, threads and syscalls
   under load, not mostly the kernel's boot. Alternatives weighed: Alpine from a bundle of our own `.apk`s (a real
   distribution's userspace with fixed steps, but a bundle to maintain), Debian through snapshot.debian.org (flaky,
   slow to boot), Nix (a large toolchain).
7. **The measurement window** (§9) runs when the machine is otherwise idle.
