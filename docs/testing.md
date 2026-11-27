# Testing

## Tiers

CI runs in tiers, by when a change is made and what it touches. A change that only edits docs (`.md` files or code
comments) needs none (`tools/i18n-check.ts` when it changes a `(ui:` quote; the fast lane does that by itself).

| Tier | When | What | Time (dev VM, 2026-11-18) |
|---|---|---|---|
| **T1, the fast lane**: `scripts/ci-fast.sh` | after every change | the static checks; the changed areas' crates; the smoke set, the areas' heavy files, reduced | ~2–3 min: 111 s for a network change (net/ts's crate beside 129 files), 161 s for a JIT one (the core's crate, 143 s, the tail; 133 files); peaks 4.2 and 3.3 GiB |
| **T2, before a push**: `scripts/ci.sh` + the areas' topic scripts | before a push or a merge; a piece of work is done when it passed | everything but the Debian boots and the topic scripts' layers; the scripts the change table names | ci.sh ~10.5 min (635 s: the JS tests 581 s of it, CPU-bound), plus the topic scripts |
| **T3, the full set** | a track's end | every script, the track-end column below | ~85 min, ~160 with dEQP's `--full` |

**The fast lane** (`scripts/ci-fast.sh`, the areas map `tests/areas.ts`, the selection `tools/ci-select.ts`). For
the changes (the commits since the merge base with the upstream, the index, the working tree and untracked files;
`--since REV`, `--files F...`, `--all`; `--dry-run` prints the selection):
- `cargo fmt`, then at once: `tsc`, `svelte-check`, the page's linters, the i18n checks, `tools/third-party.ts`, the
  harness pages' imports, the areas map's check, and the wasm core's and net/ts's builds (content-stamped: 0 s when
  current);
- then, beside each other: the areas' crates (clippy and `cargo nextest run` of `waarm64-core` or `waarm64_ts`, TestFloat
  for floating point, the agent's), and the JS tests, 4 files at a time (`WAARM64_FAST_JOBS`): **the smoke set** (every
  test file neither heavy nor topic-only: those under `HEAVY_SECONDS`, 20 s of wall in `ci.sh`, ~125 files and all
  run on every change), **the heavy files of the areas the change touches**, the changed test files and the files
  importing a changed test helper. Reduced: no `WAARM64_DISTROS` (no Alpine), no `WAARM64_LONG_TESTS`,
  `WAARM64_PARALLEL_RUNS=1`, `WAARM64_JIT_DIFF=512` (8× fewer words a class).
- It ends naming the push tier for the changes ("Before a push: scripts/ci.sh scripts/ci-net.sh") and the track end's
  additions (`--dry-run` names them without running anything: `ci.sh` runs all the fast lane does, unreduced, so a
  change going straight to its push tier skips the fast lane), and appends a line to `bench/results/local/ci-history.jsonl` (the changes, areas, files run and failed):
  a `ci.sh` failure on a change whose fast lane passed is a miss of the map, to fix in it.
- A change to the dependencies, the toolchain or the build's configuration (`build-rust`, `build-js`) runs every
  heavy file and every crate, and its tier is `ci.sh`. A file in no area runs the smoke set; the map's check prevents
  that for tracked and new files.
- It misses what only T2 runs: the long guests (Alpine, its userspace benchmark, Alpine through EDK2, the parallel
  litmus at `-r 50`), full jit-diff, TSan, the native image tests, TestFloat unless FP changed, the Debian boots and
  bugs that need ci.sh's load.

**The areas map** (`tests/areas.ts`): each area's source globs, its heavy test files, its crates, the topic scripts a
push adds and what a track's end adds. `node tools/ci-select.ts --check` (in `ci.sh` and the fast lane) fails when a
tracked or new file is in no area, a glob matches nothing, or a topic-only file (`TOPIC`: one that only skips under
`npm test`) is named by no `scripts/ci-*.sh`; it warns when `ci.sh`'s last timings (`target/ci/timings.json`, written
on every run by `tools/test-timings.ts`) show a smoke file past `HEAVY_SECONDS` or a topic-only file running tests.
A warning is fixed in the map: the file becomes heavy in the area it guards.

**The CI lock** (`scripts/ci-lock.sh`, `/tmp/waarm64-ci.lock`, machine-wide across worktrees and sessions):
`ci.sh` and every topic script take it exclusive, `ci-fast.sh` shared. Fast lanes run beside each other and queue
behind an exclusive run; a waiting exclusive run goes first (it holds `/tmp/waarm64-ci.lock.intent` while it waits),
so fast lanes don't hold it off. A waiter prints the holders and gives up after `WAARM64_CI_LOCK_WAIT` s (3600). The
fd is inherited: a leftover child of a run keeps the lock (`lslocks` names it). Memory caps stay the caller's: the
fast lane under `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0` (peak 4.2 GiB at 4 files), `ci.sh` and
the topic scripts at 11G (dEQP-VK 14G).

**GitHub Actions** (`.github/workflows/ci-fast.yml`): the fast lane runs on every push to `main`, for the commits the
push brought (`--since` the push's `before`; Run workflow takes any base), on GitHub's `ubuntu-24.04-arm` runner (4
vCPUs, 16 GB; free for a public repository). An extra check beside the dev VM's tiers, never the gate: a red run is a
signal to look at, and a push still needs its T2. The job installs what docs/cloud.md's container lacks (Node 26, the
pinned nightly, cargo-nextest, dtc 1.7.2, Playwright's Chromium as `CHROMIUM`) and caches the tools and `target/`.
**No guest images are built there**, so every test that boots one skips (`SKIPPED: run images/build.sh …`): a test that
boots a guest checks its image first, like `tests/page-modal.test.ts`'s `kernel`. 2026-11-22: ~14 min uncached (3.5
of setup, ~10 for 171 files and the ts crate; 1,195 passed, 77 skipped).

**Lanes and agents:** a lane runs the fast lane after every change, in its own worktree; it runs T2 once before
pushing (queued on the lock: wait on its notification). Commit after the fast lane, push after T2; a handover says
which tier each commit passed. A T2 failure over a batch of small fixes is bisected with fast lanes.

### The change table

Every change runs the fast lane, which picks its areas' heavy files by itself (`tests/areas.ts`). Before a push, `ci.sh`
and the scripts in the push column; at a track's end, the track-end column too (a track's end always means T3).

| Change (area in `tests/areas.ts`) | Fast lane adds (heavy files, crates) | Push adds to `ci.sh` | Track end adds |
|---|---|---|---|
| Docs only | nothing (`i18n-check` for a `(ui:` quote) | nothing | — |
| Tests only | the changed files, and the importers of a changed helper | `ci.sh` | — |
| Page UI (`page`: `web/app/`, the catalog, the theme) | `page-run`, `page-modal`, `page-statusbar` | — | `ci-debian.sh` |
| The on-screen keyboard, keys (`osk`) | `page-osk` | — | — |
| Page boot path, firmware, UEFI (`firmware`) | `uefi`, `page-run` | `ci-debian.sh` | `ci-debian.sh --platform` |
| Devices (`devices`: virtio, the device worker) | — | `ci-debian.sh` | — |
| Disks, overlays, qcow2, stored disks (`disks`) | `blockcache`, `qcow2-write`, `overlay`, `page-save` | `ci-machines.sh` | `ci-debian.sh` |
| Snapshots (`snapshots`) | `snapshot`, `page-snapshot` | `ci-machines.sh`, `ci-debian.sh` | — |
| Stored machines, the Machines and Home pages (`machines`) | `storage-full` | `ci-machines.sh` | — |
| Shared folders (`folders`) | — | `ci-machines.sh` | — |
| Display: virtio-gpu 2D, presenter, screen, cursor, EDID (`display`) | `page-pointers`, `page-surface`, `page-layout` | `ci-debian.sh`, `ci-graphics.sh` | — |
| 3D: virgl, TGSI, caps, GPU worker, video (`virgl`) | `virgl-browser` | `ci-graphics.sh`, `ci-deqp.sh` | `ci-deqp.sh --full` |
| Vulkan: `vk/`, `web/venus*.ts` (`vulkan`) | `venus-driver`, `wgsl` | `ci-graphics.sh`, `ci-deqp-vk.sh` | `ci-deqp-vk.sh --full` |
| Network: gateway, virtio-net, tailnet, tailcat, the Network menu (`network`) | `page-local`, `page-connections`, `net-path`; `waarm64_ts` | `ci-net.sh` | — |
| Rooms and names (`rooms`) | `waarm64_ts` | `ci-net.sh` | — |
| Sound (`sound`) | — | `ci-audio.sh` | — |
| USB (`usb`) | — | `ci-usb.sh` | `ci-machines.sh` |
| Guest agent, clipboard, soft power-off (`agent`) | `page-clipboard-ui`; the agent's crate | `ci-debian.sh` | `ci-debian.sh --platform` |
| JIT (`jit`: `core/src/jit/`, what compiled code reads) | jit-diff (4 parts, 512 words), `corpus-wasm`, `boot-node`, `boot-node-linux`; `waarm64-core` | `ci-jit.sh` | `ci-debian.sh` |
| FP (`fp`) | jit-diff; `waarm64-core`, TestFloat | `ci-fp.sh`, `ci-jit.sh` | — |
| Core, not JIT (`core`: interpreter, MMU, GIC, platform) | `corpus-wasm`, `boot-node`; `waarm64-core` | — | `ci-jit.sh`, `ci-debian.sh` |
| Parallel SMP (`smp`: the runner, atomics, the stop word) | `boot-node-parallel`, `boot-node-litmus`, `browser`, `hoststall`, `pause` | `ci-jit.sh` | — |
| Guest images (`images`) | — | the scripts that use the image | — |
| Guest-visible changes, step counts | the exact-step boots (`boot-node*` by area) | `ci-debian.sh` | — |
| CI scripts and tools (`ci`) | — | `ci.sh` | — |
| Dependencies, toolchain, Vite, tsconfig (`build-rust`, `build-js`) | every heavy file (and every crate) | `ci.sh` | a toolchain bump: the benchmarks |

## The scripts

Layered, cheapest first:

- **`scripts/ci.sh`** (~10.5 min: T2) before a push: every layer but the
  Debian boots and the JIT's JIT-stress and JIT-check variants (`ci-jit.sh`, below). It includes the heaviest
  multi-vCPU runs (`WAARM64_LONG_TESTS=1`: the parallel litmus and atomics stress under the JIT at `-r 50`, Node's
  Alpine on 4 parallel vCPUs; a plain `npm test` leaves them out or runs `-r 10`), and the graphics and network tests
  that boot no Debian (the gpu guest natively, in Node and in Chromium, `gpu`, `gpu-present`,
  `display`; `network`, `gateway`, `net`, `devices`), and the sound device's (`snd`, the snd guest likewise).
- **`scripts/ci-debian.sh`** boots Debian on the page: `page-debian`, `page-disk`, `start`'s run, `page-spill`, `page-ram`, ~5 min in the dev VM ("Debian boots" below). Three run at a time
  (`WAARM64_DEBIAN_SLOTS=3` in `tests/debian-lock.ts`: nothing else runs beside them there; `--platform` 455 s, peak
  8.2 GiB, against 636 s at two, whose slots stayed full; with the fixtures below, 382 s and 7.2 GiB: 2026-11-18, one
  run each), so
  `page-debian`'s ~5 min is about its wall time (`WAARM64_DEBIAN_TIMES=1` prints each test's hold of a slot). `--platform` adds
  `page-usb-keyboard` (the built-in USB keyboard in the firmware), `page-usb-gamepad` (the game pad of ours from a faked Gamepad API, an Xbox 360 pad under `xpad` in Debian, its rumble), `page-clock` (the guest agent's clock through a snapshot,
  a resume and a load) and `page-clipboard` (clipboard sharing with sway; skipped without images/debian-sway/build.sh), ~7 min in all.
  The page's machines are 3D by default (the GPU worker draws the screen); `WAARM64_PAGE_QUERY=gpu=2d
  scripts/ci-debian.sh` runs it on the 2D path (every page test adds `clocksync=0`, the agent's clock setting off, and `WAARM64_PAGE_QUERY` to the page's
  query, `tests/page-query.ts`): for changes to the 2D presenter (`web/gpu-present.ts`) or the
  device's 2D display, and at the end of a milestone or a track. That is the canvas 2D screen here (SwiftShader's
  WebGL2 is software, which the presenter leaves to canvas 2D); `gpu=2d,gl2d` runs them on the WebGL2 one.
- **`scripts/ci-graphics.sh`** (~3 min, two boots at a time) runs `page-machine`'s graphics tests (the Machine menu's choice; a lost WebGL context, `WEBGL_lose_context` through
  the `hooks` page's `__waarm64LoseGpu`, stops 3D and not the machine: the notice, the guest's uptime moving on, the
  device's 3D off; planted: the page crashing it fails) and `page-venus` (vkcube
  through Venus on images/debian-vulkan/build.sh's Debian, reaching steady frames and living through a 6 s stall of the
  GPU worker's thread past Venus's watchdog (GD G3), its frames presented through a GLES
  sway into virgl and seen by grim, and with images/vkframes/build.sh's disk vkcube's frames compared with lavapipe's,
  vk/README.md "Checking frames"; skipped without that image or vk/build.sh's renderer). Split from `ci-debian.sh` on 2026-10-30, with `--platform`: together they took 476 s; now 291 s, 390 s with `--platform`, and this script 169 s.
- **`scripts/ci-machines.sh`** boots Debian on the page for machines as the unit: `page-folders` (shared folders, [shares.md](shares.md) §7), `page-machines` (five disks: blank,
  ramdisk, read-only, a swap ramdisk, serials, a real reboot), `page-stored` (a disk stored in the browser in two steps: import, variants,
  merge, grown with the agent growing its root at the in-place boot, in place), `page-snapshots` (kept snapshots, forks, the ramdisk, Suspend on pins, orphaned ones), `page-quota` and `page-incognito` (the storage full: docs/machines.md "Storage"), `page-surface-debian` (a disk's map live, opened as the boot starts: the qcow2 counted per table as the boot reads them, its kept blocks ticked, the overlay's cores, a guest write flashing and counted, the files after the power-off), three at a
  time (`WAARM64_DEBIAN_SLOTS=3`), ~3.5 min (206 and 206 s, ~575 slot-seconds, 2026-11-18: 309 s and 844 before the
  stored fixtures below, 269 s with them before the slots' order, 224 and 218 s before page-machines' fixture). The
  slots are full from the start to ~+175 s: their order has little left to give, only fewer slot-seconds do. Before the Debian
  tests, the Alpine demo's template is made from the build under test (`tools/build-demos.ts --only alpine-term --out
  target/ci-demos --no-images`, ~31 s: the image as built, `images/build.sh --check alpine-demo` required; its
  publish's checks planned, a dry run), which `page-demos-guest` restores through the store's page (~21 s, beside the
  Debian slots): ~4 min in all.
  **The slots' order:** a free slot goes to the waiter with the longest `chain` first, then the earliest
  (`withDebianLock(f, { chain })`, a queue file per waiter beside the slots). `chain` is a hint by hand: the
  slot-seconds the test's file still has from that test on (its tests run one after another), set on the long ones
  (page-stored's, page-folders' guest tests, page-machines, page-surface-debian); without it a suite's longest file
  could start last and be its tail (page-folders' first test got a slot at +130 s and ended the run at 269 s).
  Split from `ci-debian.sh` on 2026-10-17: together they took 455 s on two slots (790 s of slot time, the machines
  tests ~415 of it), 361 s on three.
- **`scripts/ci-net.sh`** (~5 min) runs the network tests on Debian (`net-guest`, `page-network`,
  `net-tailnet` (with two adapters: the tailnet beside tailcat), `net-tailcat`, `net-local`, `page-room`) and the local helper's own Go tests,
  three Debian guests at a time (`WAARM64_DEBIAN_SLOTS=3`), then the tailnet client without a guest, one test at a time.
  The tests that don't test the boot start from booted-Debian fixtures (below; a run that makes them all ~30 s more a
  shape). 2026-11-18, one run each: with the fixtures, 3 slots 294 s (peak 6.4 GiB), 2 slots 370 s (531 slot-seconds in
  its 293 s of network tests: the slots stayed full); before them, 2 slots 551 s (7.1 GiB), one 795 s (4.1 GiB).
- **`scripts/ci-audio.sh`** (~1 min) runs the realtime sound tests on the page (`audio-browser`: the snd guest's
  tone heard, the microphone, snapshots while it plays). They time the sound against the clock, so they run alone:
  beside `npm test`'s other files a starved guest failed their timing now and then ([#55](https://github.com/gbl08ma/waarm64/issues/55)).
- **`scripts/ci-deqp.sh`** (~11 min; `--full` ~49 min) runs dEQP on the page (`page-deqp`: GLES2's and GLES3's pass lists in
  `tests/deqp/`, every case expected to pass, a machine each, both at once). It needs `images/deqp/build.sh`'s disk and guest (on demand, ~15 min once). The lists are every
  case of dEQP's mustpass lists that passed on SwiftShader in the census of 2026-11-09 (17,027 and 44,399:
  bench/gpu/REPORT.md "dEQP-GLES's census"; 17,035 and 44,476 with the cases the caps from WebGL2's extensions added; `bench/gpu/deqp-census.ts --lists` makes them from a whole run's results).
  By default a sample of each, as `ci-deqp-vk.sh`'s: every 8th case of each group (a name's second to fourth parts)
  from an offset per group a seed draws, at least one case a group, in the list's order (`tests/deqp-lists.ts`), so
  runs together cover the lists; each run prints its seed (`WAARM64_DEQP_SEED=<n>` runs that sample again). **A case
  that fails in a sample is looked into at once, or filed as an issue ([issues.md](issues.md)) and taken out of the list** until it's
  fixed, flaky or not. `--full` (`WAARM64_DEQP_FULL=1`) runs the whole lists: at a graphics track's end and for a change
  that cuts across groups (the translator, the renderer's state). A machine runs four dEQP processes
  (`WAARM64_DEQP_JOBS`), the list dealt to them in blocks of 16 (`deqp-run.ts`'s `JOBS_BLOCK`: in quarters, GLES3's
  slow `builtin_functions.precision` group fell to one process, 1,500 s where the others took 120 to 400). The timing
  cases (`flush_finish`: their calibration's draw times jump on a busy host, a CompatibilityWarning when both lists ran
  at once) are dealt to no one: every one runs after its list, in one dEQP process, once no other machine is running
  (`deqp-run.ts`'s `LATE` and `LATE_GO=stdin`, ~35 s a list). CI's Chromium is
  SwiftShader; a real GPU differs (graphics.md "Testing": on the Mac's, ANGLE on Metal, 85 GLES2 and 129 GLES3 cases fail,
  all the GPU's, after four fixes of ours that SwiftShader hid). The whole lists, or a pass list, run on the Mac host's
  GPU through `bench/gpu/sway-mac.sh` (`SCRIPT=deqp-run.ts`, mode `gles2`, `gles3` or `vk`, the last with `VIRGL_GPU=virgl,vulkan`, `STRIDE`/`OFFSET`/`CASES`
  passed on; a GLES3 slice ~7 min there); `bench/gpu/results/g5-deqp-metal/` has the Metal results to compare with.
- **`scripts/ci-deqp-vk.sh`** (a sample of the list by default, ~12.5 min with YCbCr's list and the replays; `--full`, the whole list, ~67 min at 83,980 cases (2026-11-22: the list 3,696 s of it, two dEQP processes a machine, `WAARM64_DEQP_VK_JOBS`; at 58,906 cases 47 min, 54 with one process), 13.7 GiB at its peak: run it under a 14 GiB `MemoryMax`; two machines by default past 17 GiB of RAM, `WAARM64_DEQP_VK_SHARDS` to say otherwise, the list split in blocks of 256, each machine with 1,536 MiB of guest RAM; one machine takes ~40 min and 8.9 GiB; two under an 11 GiB cap were killed at the list's memory-heavy stretch at ~16 min, one GPU process going 0.9 → 2.3 GiB) runs dEQP-VK on the page (`page-deqp-vk`: the pass list `tests/deqp/vk.txt`,
  every case expected to pass, one guest boot. By default a sample of it: every 8th case of each group (a name's first
  three parts) from an offset per group a seed draws, at least one case a group, in the list's order: ~11,500 of
  83,980, so runs together cover the list (40 seeds cover 99.6% of it, 50 seeds 99.8%). Each run prints its seed
  (`WAARM64_DEQP_VK_SEED=<n>` runs that sample again). **A case that fails in a sample is looked into at once, or filed in
  as an issue ([issues.md](issues.md)) and taken out of the list** until it's fixed, flaky or not. `--full` (`WAARM64_DEQP_VK_FULL=1`) runs the whole
  list: at a Vulkan track's end, before the user's NVIDIA runs, after a phase of tasks (VK4's census tasks), and for a
  change that cuts across groups (the replay, the pipeline key, descriptors); `--full --phases M [DIR]` runs it in M slices of the list, a boot each (cut at whole rounds of the shards' blocks, so a case keeps its shard and neighbours), each slice's result (counts, the cases that didn't pass, their detail) a checkpoint `DIR/phase-N.json` (default `bench/results/local/deqp-vk-full`): a run that dies resumes at the first slice without one, and a slice that fails doesn't stop the next (VK4's full run: three slices of ~27,000); a task proves its own new cases with runs
  of its own (bench/gpu/deqp-run.ts `CASES`) before they join the list; then `tests/deqp/vk-ycbcr.txt` (YCbCr conversions, VK3 L7.2), a
  second boot), then `page-venus` (the programs' captures against lavapipe's frames,
  also ci-graphics.sh's: VK3 L5b broke vkQuake's first frame, and the three loops after it ran only dEQP-VK). It needs
  `images/deqp/build.sh vk`'s disk and guest (VK-GL-CTS vulkan-cts-1.4.7.0's deqp-vk and Arch Linux with Venus's
  guest driver; on demand, ~25 min once), `page-venus`'s Debian and frames disk and the renderer (`vk/build.sh`); it skips where the page has no WebGPU
  adapter. The list is the cases that passed of samples of the direct set's groups (`PREFIX`/`STRIDE` runs of
  `bench/gpu/deqp-run.ts vk`, `PASSED=1`), and since VK4 T1 of a census's (every 100th case of the whole list, `STRIDE=400`
  at four offsets, `DETAIL` for every case that didn't pass, classed by `bench/vulkan/census.ts`: bench/vulkan/REPORT.md
  "VK4 T1"; with `DETAIL_NOTSUPPORTED=1` too, `census.ts --reasons` counts why the rest aren't supported: "VK4: the
  census again"; on the M4 through `bench/gpu/sway-mac.sh`, `VIRGL_GPU=virgl,vulkan`); what fails is in [the Vulkan issues](https://github.com/gbl08ma/waarm64/issues?q=is%3Aissue+state%3Aopen+label%3Avulkan), by cause. A case
  that crashes deqp-vk is recorded as `Crash` and the run goes on with the cases not recorded yet (also when deqp-vk
  dies between cases); deqp-vk's other lines (an assertion's, its watchdog's) are kept in
  `results.output`, and `WATCHDOG=disable` lifts its 30 s limit on a case's steps to time a slow one. Dawn zeroes
  workgroup memory with Tint's own loop on these runs (`--disable-dawn-features=use_vulkan_zero_initialize_workgroup_memory_extension`):
  SwiftShader's take of Vulkan's extension costs ~17 s of compile for a 16 KiB array (VK4 T2). Another Mesa's Venus in the
  guest: `images/deqp/venus-icd.sh` puts Mesa 26.3's on a copy of the disk (`target/deqp/deqp-vk-venus.ext4`), and
  `DISK2=` with `GUEST_ENV=VK_DRIVER_FILES=/mnt/vdb/venus/virtio_icd.json` runs deqp-vk through it (also through
  `sway-mac.sh`), for a feature a newer Venus passes on before the guest's Mesa has it (maintenance8's cases ran so
  until Arch had Mesa 26.3: VK4 T24).
- **`scripts/ci-jit.sh`** (~2 min, alone: the litmus run takes 4 vCPUs) runs the JIT's amplifying variants, which a plain
  `npm test` and `ci.sh` skip (`WAARM64_JIT_VARIANTS=1`, `tests/jit-variants.ts`): JIT-stress on the bare-metal tests,
  kvm-unit-tests' `cache` and `debug`, the golden corpus and lockstep, and JIT-check on the parallel bare-metal tests and
  the parallel litmus and atomics stress on 4 vCPUs. `ci.sh` keeps the plain JIT's runs (the default path, which every core change
  meets), the differential test and lockstep. Split from `ci.sh` on 2026-11-06: those variants were ~480 s of the JS
  tests' 3,015 s of test time (the litmus run under JIT-check 242 s alone, 100 s here), which ran in ~590 s of wall
  time; after it the JS tests took 416 s (2,130 s of test time) and `ci.sh` 494 s (was 672), this script 104 s.
- **`scripts/ci-usb.sh`** runs the USB tests that need the dev VM's host rigs ([below](#usb-the-dev-vms-host-rigs)):
  WebUSB against dummy_hcd gadgets and WebHID against uhid devices in the pinned Chromium, and the guest through
  them.
  These tests never go in `ci.sh` or `ci-debian.sh`, so cloud sessions and machines without the rigs aren't blocked.
  Without a rig it exits 0 with `CI-USB skipped: <why>`, and each test file skips by itself without
  `WAARM64_USB_TESTS=1` or its rig. Tests are added to its `TESTS` list.

Until 2026-10-08 `ci.sh` held the Debian boots and the long multi-vCPU runs had a script of
their own: `ci.sh` took 765 s, of which the Debian queue was ~460. Without the Debian boots it
takes 302 s, and 365 s with the long runs. JIT and core changes are covered in `ci.sh` by Buildroot, Alpine, Alpine
userspace, Alpine through EDK2, the corpus, the differential test, lockstep and litmus under the plain JIT; the JIT's
stress and check variants are `ci-jit.sh`'s; Debian comes with the end of their track.

**New behavior comes with tests at the cheapest layer that catches it.** Instruction
semantics need golden-corpus coverage; JIT changes must pass the differential test, lockstep
and the exact-step boots.

## Where each thing runs

| Layer | Runner | What it covers |
|---|---|---|
| Unit tests | `cargo test` (native) | decoder, ALU/flags, bitfields, FP core, crypto KATs, MMU walker, GIC, virtio rings, run loop, DTB, the JIT's structure (block formation, liveness, encoder bytes) |
| TestFloat | `scripts/testfloat.sh` | `fp.rs` against TestFloat 3e, every op and FZ/DN combination (51.2M cases) |
| FP suite ([below](#the-fp-suite-imagesbuildsh-fptest)) | `scripts/ci-fp.sh` (`tests/fptest.test.ts`, `WAARM64_FPTEST=1`; not in `scripts/ci.sh`) | TestFloat 3e's level-1 cases through all 777 scalar, vector, by-element, pairwise and general-register FP forms (half precision, FMLAL and bfloat16 included, FZ16 too: the guest boots with FEAT_FP16, FEAT_FHM and FEAT_BF16) in a Linux guest under the JIT (4 parallel vCPUs), every FPCR rounding mode × FZ × DN, FPSR.IXC clear and set, against SoftFloat with ARM's rules, on both arms of the FMA where the host fuses (jit.md "Floating point"); ~770M checks an arm, ~4 min each |
| Golden corpus | `core/tests/corpus.rs` (native interpreter); `tests/corpus-wasm.test.ts` (wasm: interpreter, JIT forced, block interpreter; JIT stress in `ci-jit.sh`) | ~50,000 instruction tests with results from the M4 |
| Block interpreter ([cpu.md](cpu.md) "The block interpreter") | `interp::block::tests` (`cargo test`); `core/tests/boot.rs` `linux_boots_through_the_block_interpreter`, `core/tests/distros.rs` `alpine_boots_through_the_block_interpreter` (native: there the dispatcher runs everything in it); `WAARM64_NATIVE_JIT=1` runs every native guest test through it; every JIT run's cold code | random blocks of the classes it has handlers for (and some it runs generically) from random states against `interp::steps`: steps, exit, registers, RAM; Buildroot on 1 and 4 vCPUs and Alpine with `tests/steps.txt`'s counts, Buildroot on 4 parallel vCPUs |
| JIT differential | `tests/jit-diff-suite.ts` | JIT vs interpreter on random words per inlined class, from 8 random states each, plus multi-instruction sequences and region shapes (branches, loops); on a host that fuses, the FMA forms' classes, FP edge cases and the NEON sequences again on the forced emulation |
| Lockstep | `tests/jit-lockstep.test.ts` | the integer and FP guests (user mode) and the integer guest at EL1 (MMU off and on), JIT (and JIT-stress in `ci-jit.sh`) vs interpreter, `Cpu` + RAM checksum every chunk; 20M steps per JIT case in CI |
| JIT compile worker | `tests/jit-compile-worker.test.ts` (its ready word; its counters: the delay from emission to ready, its buckets, the time busy); `tests/boot-node-suite.ts` "parallel: Buildroot on n vCPUs" (every module through the worker, none overdue); `core/src/jit/mod.rs` unit tests (redirects wait for their region) | the vCPUs install a module only once the worker has compiled it, interpreting its blocks until then (docs/jit.md "Sharing") |
| Core instances on one memory | `tests/threads.test.ts` (Node workers); `tests/browser.test.ts` (Chromium workers) | three concurrent instances (interpreter, JIT, JIT) with their own stack, TLS and table run the integer guest to the reference's exact state (M7) |
| JIT plumbing | `tests/jit.test.ts` | install, IC IVAU invalidation (also across chains), the stale-code checker, call/return chaining, tier-up, direct branches to another page under the MMU (pages that aren't contiguous physically, a decoy at the PA that would follow, a remap), a batch's blocks compiled as one forward region (two calls of one function with a predicted and a mispredicted return; a region across two pages: remapped, and rewritten with an `IC IVAU`) |
| Bare-metal EL1 tests | `core/tests/baremetal.rs`; `tests/boot-node*.test.ts` (interpreter, JIT; JIT-stress in `ci-jit.sh`) | exceptions, MMU, GICv3, timer, the timer registers compiled from the step clock (`timerjit`: writes before, at and after the chunk's end, a fired timer masked inline before ISR_EL1 and ICC_IAR1 read; [jit.md](jit.md) "Timer registers from the step clock"), UART, SMP (4 vCPUs: CPU_ON, SGI ping-pong, per-CPU timers, CPU_OFF), broadcast maintenance (`maint`, 4 vCPUs: every TLBI …IS flavor, TLBI by ASID while the others run another ASID and against a global mapping, IC IVAU and IALLUIS on code the others run; its IC planted out, JIT-check's stale-code checker must trap), cross-modification seen through an ISB in a hot compiled loop (`isb`, 2 vCPUs: CPU 1 reads a flag, ISB, calls the rewritten function; under the parallel JIT a fast-completed ISB ran the old code until the table caught up, 3-8 stale calls in 8 rounds, every run), 128-bit atomics (`pairs`, 4 vCPUs: CASP and LDXP/STXP against each other and against plain stores to the same bytes), memory at the edges (`devmem`: LDAR and STLR on a device register, cache maintenance by VA and DC ZVA on Device mappings with a device behind them and without, Q registers under `SCTLR_EL1.A`, IC IALLU with Rt != 31 on code that ran; checked against the M4), self-hosted debug (`debug`: software step from EL0 through a load-exclusive, an SVC, an UNDEFINED instruction and an IRQ taken first; breakpoints by address, linked and unlinked context ID, PMC, KDE and `PSTATE.D`, the OS lock; watchpoints by byte, LSC, MASK and a store exclusive; planted: the dispatcher's test, `set_pstate` not following the EL, ERET dropping `SPSR.SS`, an arming MSR not ending the chunk, a restore dropping a comparator each fail it or kvm-unit-tests' `debug-*`), console input (`rx`, 2 vCPUs: a line through the PL011's RX interrupt while it waits in WFI with no timer; parallel mode needs `SIGNAL_RX` to wake it), the firmware configuration's CFI flash bank (`flash`: erase, word and buffered program, status, identifier and CFI query, as EDK2 drives it) |
| kvm-unit-tests | `core/tests/kvm_unit_tests.rs`; `tests/boot-node*.test.ts` | selftest (incl. smp), psci, gicv3-ipi, gicv3-active, timer, cache, debug (breakpoints, watchpoints, single step, and through snapshots) |
| Litmus and atomics stress (4 vCPUs) | `core/tests/litmus.rs` (interpreter: round-robin with exact steps, parallel); `tests/boot-node*.test.ts` (round-robin JIT with exact steps; parallel JIT, and JIT-check in `ci-jit.sh`); `tests/browser.test.ts` (parallel JIT); `scripts/tsan.sh` (parallel, small) | the memory model (no state herd7 forbids), LSE and LL/SC atomics, 128-bit CAS, futex wake-ups, spin-wait latency (M7) |
| Buildroot boot and device test | `core/tests/boot.rs`; `tests/boot-node*.test.ts`; `tests/browser.test.ts` | Linux boots, virtio console/rng/blk/net/9p/input, framebuffer, realtime mode, writable overlay, console input (`-- /bin/sh` reads 5.5 KB from the host at a fixed step: more than the RX ring; in parallel through a `MessagePort`) |
| LTP subset + arm64 kselftests | `core/tests/ltp.rs` (interpreter, each result against its table); `tests/boot-node*.test.ts` (JIT) | 93 syscall tests; `syscall-abi`, `ptrace`, `hwcap`, `tpidr2`, `tags_test`, signal tests |
| Crypto test kernel | `tests/boot-node*.test.ts` (JIT; interpreter with `WAARM64_INTERP=1`) | the arm64 CE drivers' full self-tests (sha3-ce among them), lib/crypto's SHA-1/224/256/384/512 KUnit suites, `/proc/cpuinfo` listing `sha3` and `sha512` |
| The firmware configuration (M8 phase B, [firmware.md](firmware.md)) | `core/tests/firmware.rs` (interpreter); `tests/boot-node*.test.ts` (interpreter, JIT); `tests/uefi.test.ts` (parallel JIT, realtime) | EDK2 (`images/build.sh edk2`) boots the UEFI Shell from `shell.img`, whose `startup.nsh` prints an EFI variable, sets it in the flash bank and powers off through `ResetSystem`; a second boot with the bank's bytes prints it (`edk2-shell`, `edk2-shell-again` in `tests/steps.txt`). Alpine's UEFI cloud images through EDK2 to a root login and a power-off, as the UEFI oracle does (Limine, GRUB; a NoCloud seed disk from `web/fat.ts`) with `WAARM64_DISTROS=alpine-uefi` (`images/build.sh alpine-uefi`): `rtc-efi`, the framebuffer above `/memory`, both vCPUs, and a virtio-net card on the echo gateway that Alpine brings up by itself (DHCP and DHCPv6/RA: both addresses, default routes, a ping each; N7) (the two boots side by side, ~55 s; Debian's platform checks are in `tests/page-debian.test.ts`). Planted: a flash program that doesn't stick (the flash unit test, `flash` check 11, EDK2's boot), fw_cfg's directory off by one (its unit test; the page test's timezone credential) |
| Distros | `core/tests/distros.rs` (interpreter: Alpine); `tests/boot-node*.test.ts` (Alpine, Alpine userspace, JIT); `tests/browser.test.ts` (Alpine, JIT); `tests/page-debian.test.ts` (Debian through UEFI on the page, parallel; Debian is never booted natively, interpreted or directly) | real distro boots from virtio-blk |
| Parallel SMP (a thread per vCPU, realtime: not reproducible, so repeated, every run must pass; `WAARM64_PARALLEL_RUNS`) | `core/tests/baremetal.rs` `baremetal_parallel` (every test, 5×), `core/tests/boot.rs` (Buildroot on 1, 2, 4 vCPUs), `core/tests/distros.rs` `alpine_smp` with `WAARM64_PARALLEL=1`; `tests/boot-node*.test.ts` (bare-metal under the JIT and JIT-check, kvm-unit-tests' SMP set, litmus and stress on 4, Buildroot on 2 and 4, Alpine on 4); `tests/browser.test.ts` (Buildroot on 4; litmus and stress on 4; Alpine on 4; the page's Debian on 2) | the vCPU workers, wake-ups, the platform lock, broadcast maintenance and the DSB wait (M7). In Node a run that doesn't power off within its bound (`runToPowerOff`'s `maxMs`: 5 min, the usb guest's 1 min) fails with the console's end and its VM closed, instead of holding its test file until CI's timeout. Natively an idle vCPU thread sleeps at most 50 µs whatever its wake word says (`vm/parallel.rs`), so a lost wake-up is invisible to the native runs: only the Node and Chromium ones (`Atomics.wait`) can catch one |
| virtio-gpu, 2D ([devices.md](devices.md) "virtio-gpu", [graphics.md](graphics.md) "The 2D display") | `tests/gpu.test.ts` (Node; `edid-decode` where installed); `core/tests/gpu.rs` (the native twin); the gpu guest: `core/tests/gpu_guest.rs`, `tests/boot-node-suite.ts`, `tests/browser.test.ts` (`images/build.sh linux-gpu`) | unit: every command on hand-built buffers (the errors the spec and QEMU have, all eight formats, a rectangle narrower than the resource, the scanout showing part of a resource, damage clipped to it, the resource budget across unref and reset, the cursor, events and write-one-to-clear, save and restore, a console restored into a bigger page keeping its buffer's mode in the EDID, a flush alone drawing and a page flip drawn once, one flush reply per frame with the queue behind it in order, a transfer copied on arrival while its reply is held), a seeded run of 20000 random and mutated commands (never throws, answers in the spec, guest RAM unchanged), the EDID checked against `edid-decode --check` for eight sizes and against the twin's bytes (`tests/gpu/edid.json`), and a conformance script whose hashes the twin must give too. Planted: a transfer off by a row, a backing entry outside RAM accepted, the stride ignored (needed a rectangle narrower than the resource), a display event never raised, damage outside the scanout drawn, a cursor hotspot ignored. **The gpu guest** (`gpu` in `tests/steps.txt`): Linux with `virtio_gpu` and a static init (`images/gpu/init.c`, raw KMS ioctls) on a 640×480 display: connector and EDID (mode and physical size), a mode set, DIRTYFB damage with a write outside the clip nobody was told about, a cursor with a hotspot, then the display event the host raises after the second flush (the guest sees a preferred 800×600 and sets it). The scanout's hash after each of the three flushes and the cursor's are `tests/gpu/guest.json`, and `tests/gpu.test.ts` computes them from first principles (init.c's drawing reimplemented), so they aren't merely what the twin says; natively, in Node (interpreter, JIT, JIT-stress) and in Chromium (the device worker) the steps, console and hashes are the same. Planted: the stride ignored and the event never raised (the guest fails each) |
| virtio-snd ([devices.md](devices.md) "snd", [audio.md](audio.md)) | `tests/snd.test.ts` (Node); `core/tests/common/snd.rs` (the native twin); the snd guest: `core/tests/snd_guest.rs`, `tests/boot-node-suite.ts`, `tests/browser.test.ts` (`images/build.sh linux-snd`), its expectations in `tests/snd/`; the sound ring: `tests/audio.test.ts` (Node), `tests/audio-browser.test.ts` (Chromium, the page's `snd` machine; ci-audio); Debian's card in `tests/page-debian.test.ts` (ci-debian) | unit: the device entry and config (two streams); `PCM_INFO`'s bytes, a larger item size padded, and every info query's error (out of range, wrapping, too small, no room, short; jacks and channel maps, of which there are none; `JACK_REMAP`); unknown codes; `SET_PARAMS` with every offered format and the rates' ends, `NOT_SUPP` for the rest, `BAD_MSG` for sizes of no whole frame or period; the state machine's every transition, in order and out of it; transmit messages held until START, completed at the end of their exit in order with their status in the last 8 writable bytes (split over buffers too), the sink's hash and bytes; at most a buffer less a period per exit; STOP holding, START resuming, RELEASE returning without playing (after its own reply); malformed and misplaced messages, rxq, event buffers held; a reset; save and restore (a held message posted again plays once; bad states refused); `toF32` for each format, unaligned; the input stream: its own lifecycle and log name, receive messages held until its START, filled with the pattern at the end of their exit with the frames then the status (split over buffers too), a buffer less a period per exit, malformed ones, STOP and RELEASE (returned with only a status), save and restore (the pattern going on), a one-stream state refused, the pattern in each format and mono; with no microphone, silence at the stream's rate, its bound and the untaken wait, paused while stopped, counted afresh at START; the microphone's ring: frames in order in the stream's format, mono as the mean and FLOAT clamped, at most a buffer behind after a stall, stale frames from before it went live skipped, silence by the clock once its worklet stops. Planted: no burst limit (the unit test and the guest fail: the guest's writes time out), a byte lost from the hash, RELEASE not returning (each caught); no burst limit in the twin (the native guest fails); the pattern's channels swapped (the guest test fails on the frequencies and the pinned hash), no burst limit on the source in JS (the guest and two unit tests fail) and in the twin (the native guest's reads stall). **The snd guest** (`snd` in `tests/steps.txt`): Linux with `virtio_snd` built in and a static init (`images/snd/init.c`, raw ALSA ioctls): the card and the PCM, what the device offers, hw params S16 48 kHz stereo with 4 periods of 1024 frames, sw params that never stop on an underrun, 48 periods of a 440/660 Hz sine, then a drain of what's still queued (a drop when nothing is: ALSA's drain on an empty stream waits out its timeout, [audio.md](audio.md) "Linux driver behavior"); then (audio S4) 16 periods recorded from the capture PCM with the same parameters: the deterministic source's pattern from frame 4096 (the first buffer overwritten before it's read, [audio.md](audio.md) "Linux driver behavior"; FNV-1a `2b1e136b`, pinned in both runners' checks), 999 and 1500 Hz by its zero crossings, the source having filled 24 messages. The sink must have played exactly the 49,152 frames whose FNV-1a the guest printed, which `tests/snd/guest.ts` also makes from the waveform, after the control requests of `tests/snd/log.txt`; natively, in Node (interpreter, JIT) and in Chromium (the device worker, interpreter and JIT) the steps, console, hash and log are the same. QEMU's virtio-sound-device is the oracle ([audio.md](audio.md) "Linux driver behavior": the same requests, the same samples; §16: the same capture requests, and with its `none` backend 16 periods of silence in 342 ms of the guest's time, which the page's clock source matches). **The sound ring** (audio S2): the realtime sink on a fake clock (frames into the ring as f32 stereo in order and across its wrap; messages completed when the worklet's read index passes them, with the page's latency, or by the sink's own clock at the stream's rate, waiting for the guest when the ring ran dry (an underrun with its silent frames when sound comes again; none if frames come before the clock reaches the ring's end), taking over from the worklet's last quantum when its heartbeat stops; at most a buffer less a period since the guest's last message, counted across pumps, the rest after its next message or half a buffer's time and 30 ms after the core took the batch's first completion (not while it hasn't: no vCPU runs); after a restore, a whole buffer counted as in flight (two of three re-posted periods complete); messages waiting for room; STOP and START, RELEASE dropping the ring; mono to both channels) and the worklet's `process` under stubs of its scope (only while started at its rate; a gap counted as an underrun when the sound comes back, not at a stream's end; a lost compare-and-exchange plays silence). In Chromium (`scripts/ci-audio.sh`, alone) the page's `snd` machine plays 4 s (`snd_seconds=4`): the stream's time on the device (START to its stop, the sink's `stop` message) is the sound's length plus the gaps the ring counted, within 40 ms, and the gaps under 10% of it (a loaded host starves the guest's 85 ms buffer for real, but no time may go missing uncounted; the guest's own time, which also has its computing before START in it, is printed; the exit's numbers are measured alone: [audio.md](audio.md) "Measurements"), an analyser after the volume hears 440 and 660 Hz, the guest then records 16 periods in real time (341 ms, up to 60 more: the microphone opens while it records and its switch starts a period again), mute silences it and is remembered over a reload; a suspended context shows [Sound: click to hear](ui:sound:Sound.summary.waiting), the sink's clock keeps the guest playing, a click resumes the worklet. **The microphone** (audio S4; the browser for `tests/audio-browser.test.ts` has Chromium's fake capture device, playing a 500 Hz WAV the test writes): with Raw microphone, the guest records 3 s of it at 500 ± 10 Hz on both channels in its length of its own time (± 150 ms), the summary says "· mic", the track's echo cancellation, noise suppression and gain control are off, and the microphone closes when recording stops; with the browser's processing (the default) they're on and the tone is heard; Microphone off: `getUserMedia` is never called and the guest records silence (16 periods, 341 ms ± 40); refused (`getUserMedia` rejects): silence, and the menu's hint says the browser refused it. **Snapshots while it plays** (audio S4): a 12 s tone saved 2 s in plays on in time through the pause; the file loaded in a fresh profile (over that page's own snd guest) plays on: 440 and 660 Hz heard, the new ring holds what the guest hadn't had completed (whole periods, within a buffer of what the old ring played around the save), the stream's time is that plus its counted gaps within 40 ms, the guest drains normally; and in Node the snd guest through 6 files, 4 mid-tone and 2 mid-recording, in the unbroken run's steps and console (`tests/snapshot.test.ts`). Planted: no burst limit, the bound per pump instead of since the guest's last message, the wait's 10 ms counted while completions are untaken, the take-over from the time it's noticed, the sink's dry spells not counted (each fails a unit test), mute ignored (the page test fails); raw ignored, Microphone off ignored (the microphone tests fail); a restored clock that runs before the vCPUs do, and a saved one not held (the core's `a_realtime_clock_continues…` test). Debian (ci-debian): `/proc/asound/cards` lists the VirtIO SoundCard, and Debian's own driver plays a file (audio S3): `snd-play` (`images/snd/play.c`, a static WAV player on raw ALSA ioctls with aplay's buffer, 500 ms in 4 periods, built by `images/build.sh linux-snd`) and a 3 s 440/660 Hz WAV at 44.1 kHz come in a tar on the page's second disk (`?disk2=`, `tests/snd-disk.ts`; `tar -xf /dev/vdb`); its own clock says the sound's length within a period (3,110 ms for 3,125), no underrun, the page (whose context follows the stream's rate) hears 440 and 660 Hz, and ALSA's delay half-way is the buffer plus the browser's output latency. The same disk and player under QEMU's `virtio-sound-device` give its WAV the file's samples exactly. And it records (audio S4): `snd-rec` (`images/snd/rec.c`, on the same disk) takes 3 s at 48 kHz stereo from the page's microphone (the test's browser has Chromium's fake capture device playing 500 Hz) through Debian's driver: its length in its own time (± 150 ms), no overrun, 500 ± 15 Hz on both channels (the browser's processing on) |
| virgl's device side (M8 graphics G2, [devices.md](devices.md) "virgl") | `tests/gpu.test.ts` (Node) | off by default (the 3D commands are `ERR_UNSPEC`); the capsets' info and blobs (VIRGL v1 308 bytes, VIRGL2 1408, `virglCaps`; GLSL 130, renderer `waarm64`, nothing WebGL2 lacks: no dual-source blending, fbfetch or independent blending), the caps' encoding round trip; contexts (0 and a reused id refused), 3D resources (bad target, reused id), attach and detach, 3D transfers counted in bytes, a 2D transfer of a 3D resource refused, `SUBMIT_3D` walked and counted per command (a length past the end and a size past the payload refused, an unknown context), a 3D scanout black and opaque, a buffer never shown, the snapshot marker, unref, destroy and reset; a seeded run of 20000 random 3D commands and streams (never throws, answers in the spec, guest RAM unchanged). Planted: a stream length past the end accepted, the capset's size misreported (both caught). Guests: none in the test suites (the null renderer is measured, `gl_virgl_jit*` and graphics.md "Measurements"' sway runs, not pinned) |
| virgl's renderer on WebGL2 (M8 graphics G3, [graphics.md](graphics.md) "The renderer") | `tests/virgl.test.ts` (Node, a recording WebGL2: `tests/virgl-mock-gl.ts`); `tests/virgl-browser.test.ts` (Chromium); fixtures in `tests/virgl/` (`tools/virgl-capture.ts`, `bench/gpu/sway-load.ts` with `CAPTURE=`) | Node: every shader of the TGSI corpus (the oracle's glmark2 and the guests') parses and every fragment shader makes a program; the generated GLSL's registers, immediates (bits where a float literal would be denormal), sampler and render-target swizzles (BGRX both ways), integer bits, the fragment coordinate's origin, the alpha test; what GLES 3.0 lacks refused; the trace format round-trips; glcomp's and sway's traces through the device into the renderer with no errors (draws, read-backs, every submit OK); a fenced reply held for the host with the replies behind it in order; the caps from a browser's parameters (formats only with their extensions, limits) and a snapshot's caps checked against today's; half floats. Chromium: the corpus's programs compile and link; glcomp's render target against llvmpipe's last frame (within 8 a byte, mean under 1.5: blending and filtering round differently); sway's last frame against a reference this renderer made (`sway-640.scanout.gz`, a regression check); stream output from a stream made in the test (interleaved and separate, an append, a rebind, a draw cut at a full buffer, PRIMITIVES_EMITTED, nothing bound to draw on; the generated varyings in Node). A 2D machine's WebGL2 screen (`web/gpu-present.ts` through the device): the eight formats' bytes kept as the guest wrote them and drawn through their swizzle, the canvas 2D screen's RGBA too, and a lost context drawn again when it is restored, with nothing flushed (planted: the restore not redrawing, the scanout's swizzle left out; both caught). A 3D machine's snapshot: Node (contexts remade, a context in use saved from the host's state and loaded on restore, a host's refusal kept, caps that can't be backed turn 3D off, the restored scanout told to the host; the null renderer's tables); Chromium (graphics.md "Snapshots with 3D in use": glcomp's and sway's traces saved at several submits and loaded into fresh renderers on new contexts draw the same bytes, each save saved again the same; every format as 2D with levels, cube, array, 3D and 4 samples loads and saves back exactly (4 samples' 32-bit floats normal: D3D11 flushes their denormals, graphics.md "Snapshots with 3D in use"); a save across the GPU worker's port loaded into a second worker; planted: texture uploads skipped at a load, the bound blend dropped, a stencil bit not read, each caught); the page's Debian tests (3D by default; `WAARM64_PAGE_QUERY=gpu=2d` for the 2D path, above). Planted: `B8G8R8X8` sampled as RGBA (the sway check fails); an append started over, the captured bytes not read back into the CPU copy, the restore's scanout not sent, a 3D cursor ignored (each caught). A 3D cursor read back from the renderer and converted from its format, a later update winning over a read in flight (Node). Queries (graphics.md "Queries"): a fence held for the occlusion queries before it, a query destroyed while pending holding none, one with no draw done at once and a `null` span counted as passed, spans paused when another sub-context draws or a blit runs (Node); two contexts and two sub-contexts with queries open at once, each counting its own draws, the fence answered (Chromium); spans folded once one passed. Feedback loops (graphics.md "Feedback loops"): a level drawn while sampled through a swizzle gives its old texels, an array's layer drawn while another is sampled (Chromium). A shader object destroyed deletes its programs, and the draw states forgotten theirs (two rounds of 4,200 states, the vertex shader's object kept or destroyed while bound); a sampler with no view leaves nothing bound on its unit (Node). What only the renderer sets, kept (graphics.md "The renderer"; `?gpu=noattachcache`, `nodrawcache`): the traces and command streams of their own replayed both ways see the same framebuffers (GLES 3.0's model; no attachment ever on the default framebuffer), vertex arrays and uniforms (−0 as such) at every draw, clear, blit and read, with a screen's present between; clears and draws into the same color and Z24S8, Z16 or S8 target set no attachment again, a target of other points after another leaves its own alone, dEQP-GLES2's 481 draws into one target set their attachments under one in ten draws, and the renderer's bindings are GL's after a present (Node; planted: the depth-stencil point emptied before it's attached, the other point left on, the stencil half of the depth-stencil point not compared, the screen binding past the renderer, a blend color's sign lost, the draw buffers' count not compared, an attribute's offset not compared, a forget's programs kept, each caught). State a draw leaves (Node): a surface clear after a draw with the rasterizer's discard on runs with it off, a resource copy's blit with every write mask on, a 3D scanout presented from level 0 through the screen's own sampler; a blended draw into R32F blends with `EXT_float_blend` and draws unblended without it. A draw's program by the ids of its key's parts (graphics.md "The renderer"): one state for equal parts (another surface of a format, views in turn, a blend that folds nothing), another for a part that differs (an integer target, points), a view's part read again when its resource's number names another resource, the kept states forgotten past 4096; the traces' replays and the fuzzer run with `checkPrograms` (every part read again at each draw, a stale kept one a fault) (Node; planted: a view's kept part not tied to its resource, the states never forgotten, a rasterizer changed in place at its bind, each caught). The call queue gives up a picture pending 3 s while later ones come out (`tests/virgl-video.test.ts`). What ANGLE on Metal found (graphics.md "The translator"): one program with stream output captured or not, an invariant position kept invariant, NaN-pattern integer immediates no constant expression, `x != x` as `isnan` (Node); each planted back fails its test. What ANGLE on D3D11 found: integers never through a float register, SSG without GLSL's `sign()`, a normal float's bits copied into a register no constant, a vertex shader's shadow lookup at an explicit level made the implicit one under `Quirks.d3d11`, a program D3D's compiler refused no program (Node, and Chromium: each fails on the Windows VM's D3D11 through `WAARM64_CDP` with its fix taken out, passes on SwiftShader either way); a sampler without mipmaps keeping the guest's LOD range (Node) |
| Video over virgl ([graphics.md](graphics.md) "Video") | `tests/virgl-video.test.ts`, `tests/video-h264.test.ts`, `tests/video-av1.test.ts` (Node); `tests/virgl-browser.test.ts` (Chromium; fixtures `tests/virgl/video-*` from `bench/video/fixture.ts`) | The caps' `video_caps` words as Mesa reads them (at their dwords in the v2 caps), a restore needing every decoder the guest was told of, the codec and buffer tables and a picture's desc and data read from staging buffers; H.264: Exp-Golomb and emulation prevention round trips, the rebuilt SPS and PPS read back field by field by a parser written to §7.3.2 (POC type 1's cycle, Constrained Baseline's flags, the effective scaling lists), a picture's chunk (parameter sets at an IDR and when they change), a software decoder's SPS saying the stream's reorder depth learned from the POCs (the reference count before, raised at an IDR, carried to a drained decoder's successor). `VideoContext` on a fake decoder: VP9 pictures into their planes, a hidden VP9 frame waited for by nothing, a decoder error and the new decoder at the next key picture, software H.264 drained when it holds pictures and decoded again from the IDR by a new decoder (the drained one's output still counting, nothing lost; hardware never drained), a picture a software decoder passed over (a lesser POC pending when a later one comes out) given up at once (in hardware not), pending pictures given up after the bound, a destroyed buffer's pending picture still written into its planes and a destroyed codec's decoder flushed (what it held written, the rest dropped when the flush ends), a picture never written over a later one in the same planes; the renderer (mock GL) writing a picture into planes the decoding context detached after END_FRAME (Firefox's decoder process at a seek); `CallQueue`: a call waits only if its context has a pending plane attached (decode-only submits excepted) or it names one, what must follow a waiting call waits too (its context, its resources; a fence and a read after every waiting call), the rest runs ahead (Venus's calls that make things too, those that end things in order); drained at 200 ms, given up at 1 s. Planted: the compositor's draw not held, a fence or a read passing a waiting call, a transfer of a plane not held, the passed-over rule off or applied to hardware, the drained decoder's output ignored, no decoding again after a drain, the write needing the decoding context's attachment, a destroyed codec closed at once, a destroyed buffer's picture dropped, the older-picture guard off (each fails). In Chromium, 40 pictures a codec of the Sintel trailer as the guest's FFmpeg sent them through VA-API, replayed through the device, decoded by WebCodecs, the planes read back: VP9 each FFmpeg's frame exactly, and so what draws sample (each plane's picture texture, filled from the plane on the GPU; planted: the copy from another column); H.264 each a frame of the browser's own decode of the original stream (the dev VM's Chromium decodes H.264 with OpenH264, not bit-exact with FFmpeg; on a hardware decoder FFmpeg's exactly); AV1 (fixtures `video-av1-aom`, `-svt`, `-tools`: 40 frames each of libaom, SVT-AV1 and libaom with segmentation, tiles, 128x128 superblocks, quantizer matrices, global motion, delta q and lf, loop restoration and film grain) each written picture one of FFmpeg's frames (planted: a live reference's slot taken, no decoding again, hidden frames left hidden, `qm_v` left out, tile sizes off by one; each fails); `tests/video-av1.test.ts` (Node): `ns` and the sub-exponential code read back by readers written to the spec, the slots (a frame into a slot the guest's map doesn't hold, waiting for the next map when none is free, flushed stored nowhere and decoded again when referenced, hidden frames written shown or put in the next unit) and global motion coded against the primary reference's parameters (planted: against the defaults); a waiting AV1 frame sent by the queue's nudge and before a destroyed codec's flush (`tests/virgl-video.test.ts`); a damaged chunk (its bytes garbled, `ChunkFault`) is a WebCodecs decoding error in both codecs (none conceals it), the pictures the decoder put out before it written, every one (each frame's copy held 30 ms, so the error finds copies out and waits for them: VP9's ten exactly; H.264 in software holds some, which go with the decoder: FFmpeg's 5 of 10 out, OpenH264's more), the codec's later ones dropped and no call waiting on them: the queue's drain and give-up, held off for 10 and 20 s there, never fire (planted: the error not closing the codec, the error not waiting for the copies); a frame's copy in its planes' shape (`copyPicture` on frames made on the page, I420 and NV12, since no decoder in the dev VM gives NV12: an odd and an even picture inside the coded size, no shape, the picture's size and larger planes, interleaved and planar, each texel against the frame's bytes and the edges repeated; planted: NV12 parted from the back, V not set aside before interleaving, the chroma's edges not filled; each fails), with `padPlane` from longer rows, `fillEdges` and the shape the context tells its decoder in Node (`tests/virgl-video.test.ts`). **Reading a decoded frame in the dev VM's Chromium needs `tools/nosme.ts`** (`chromiumEnv()` for Playwright's `launch({ env })`: an `LD_PRELOAD` that hides SME from `getauxval`, built on demand into `target/nosme/`, only where the CPU has SME and no SVE; graphics.md "Video's findings"); every launcher that decodes video passes it. The guest's end to end checks are tools: `bench/video/v1.ts` (`SNAPSHOT=1`: Save snapshot refused while a player decodes, saved once it exits) and `bench/video/seek.ts` (seeking, "Video's findings") |
| Pause and resume (`pause()`, [platform.md](platform.md) "Pausing a VM") | `tests/pause.test.ts` (Node; `WAARM64_PARALLEL_RUNS` repeats the parallel ones, taken at 10); `tests/browser.test.ts` (Chromium) | Buildroot on 4 parallel vCPUs (JIT) paused 25 times through its boot (every 30 ms and at console markers): the summed step counter stands still for 20 ms, the doorbell's served word equals its rung word, STOP is clear, the guest still ends as an unpaused boot does; a pause with the backends' service slowed by 10 ms (`Devices.prototype.poll` wrapped) never resolves while one is still serving; a pause with every vCPU idle at a shell prompt then input after `resume()` (a lost wake-up hangs it); a pause requested as the guest powers off (never hangs); `close()` while paused and while a pause is pending frees the VM (no worker left); a `close()` made the instant the pause rings its doorbell (`Atomics.notify` wrapped; one vCPU on `b .`, no image) resolves the pause false; round-robin pauses between runs leave `buildroot` and `buildroot-4cpu` at their exact steps; in Chromium (device worker) ~10 pauses through the 4-vCPU boot. Planted: `resume` not notifying the pause word, STOP left set at the resume, devices not settled before the pause resolves (the slowed-backends test: "resolved with a backend still serving"); the quiesce's doorbell wait (`ringAsync`) without its stop on the close (pending after 5 s); the doorbell's server (`Devices.serve`) ends on a `close` that lands while it yields to the event loop (`tests/devices.test.ts`; [below](#a-test-file-that-never-ends)) |
| ThreadSanitizer | `scripts/tsan.sh` (in `ci.sh`, ~20 s warm) | the native parallel runner under `-Zsanitizer=thread` (std rebuilt, `target/tsan`): the bare-metal tests 3×, Buildroot on 1, 2, 4 vCPUs, the litmus image on 4 (~1 min); any report fails, nothing is suppressed (guest RAM is accessed with relaxed atomics: [cpu.md](cpu.md) "Memory accesses and atomics"); a planted plain load is reported |
| Browser-only | `tests/browser.test.ts` | cross-origin isolation, the device worker, sync XHR ranges, OPFS, the canvas, DOM input, the spike page |
| The page ([frontend.md](frontend.md)) | `tests/browser.test.ts` (smoke test on the Buildroot guest, 2 parallel vCPUs, ~7 s; and the screen's dirty rows on a canvas) | the machine worker and its protocol, pixels written to `/dev/fb0` on the worker-drawn canvas, serial output to xterm.js and keys typed there to the shell, a key on the screen to `/dev/input/event0`, a held key released when the screen loses the focus, a Keys-menu chord (Ctrl+Alt+F12: order and release), the tablet through a scaled-down canvas (`/dev/input/event1`), a paste over 4 KiB (its md5), full screen, power off, Start, Restart while running (the disk overlay handed over); the page's messages (~4 s: served without COOP/COEP, xterm.js, the core or an image missing then Retry, a device reporting 1 GB then Start anyway, an overlay over another image then Reset disk); a guest panic (`?params=init=/nonexistent`) kept on show with the serial log copied and saved, the remembered view, a second tab refused the disk then Retry, a file kept over a restart and gone after Reset disk (~15 s); the overlay's hand-over (`tests/browser/overlay-worker.ts`, ~1 s: a second opener waits for the first's close, 20 holders terminated and the overlay opened at once, one held past the wait is in use) and six restarts in a row while the guest rewrites its disk, during the next machine's loading and booting, one a double click (~9 s; M8 loop 8) |
| The serial terminal's keys into EDK2 and GRUB | `tests/page-disk.test.ts` (`scripts/ci-debian.sh`: the chosen disk's first boot goes through them) | arrows, Enter, Esc, F2, Ctrl-N/E/X, typing through xterm.js: GRUB's menu → "UEFI Firmware Settings" (the guest resets; the variable that asks for the setup survives the page's restart in the flash bank) → EDK2's boot menu and setup forms → Continue → GRUB's editor and command line → Ctrl-X boots the edited entry, whose `/proc/cmdline` has what was typed |
| Disk out ([frontend.md](frontend.md) "Your own disk") | `tests/qcow2-write.test.ts` (needs `qemu-img`), `tests/page-save.test.ts` (Chromium, Buildroot) | the base's hash (SHA-256 of the slices' digests) against node:crypto; the changes qcow2 (backing file, base hash) and the whole-disk qcow2 against `qemu-img check` and `compare` with the merged bytes, small and over several L2 tables and refcount blocks, and read back by our reader (planted: a block left out fails it); a packer that answers several batches at once, late and out of order, writes the same bytes as compressing in place; `tests/qcow2.test.ts`: a read over many clusters is a few host reads (planted: no merging fails it) and survives a merged read that fails; on the page, saving from a running machine downloads raw (the image's bytes), qcow2 (identical) and changes (valid, over the image) and the machine starts again |
| Discard ([devices.md](devices.md) "blk") | `tests/overlay.test.ts`, `tests/devices.test.ts`, `tests/trim.test.ts` (Buildroot, JIT, 2 vCPUs), `tests/qcow2-write.test.ts`, `tests/changes.test.ts` | the overlay against a byte-array model through writes, discards and zeroes, reopened (planted: a discard that zeroes the base's blocks, slots never freed, a partial write over a zeroed block that reads the base, a compaction that maps the wrong slot: each fails); the requests and their refusals without a guest; Linux's `fstrim` shrinks the overlay's data file and can't without the offer; zero blocks as zero clusters under `qemu-img check` and `compare`, and back through Load changes without slots; on Debian, `fstrim` in `tests/page-disk.test.ts` |
| The RAM map ([frontend.md](frontend.md) "RAM's map") | `tests/ram-scan.test.ts` (Node: web/ram-scan.ts over shared buffers, web/app/ram-look.ts, the pacing); `tests/page-ram.test.ts` (Debian, `scripts/ci-debian.sh`); `tests/page-modal.test.ts` (Chromium, no guest: Settings' Visualize only while the machine runs here, opening the window) | a pass's pages with data per cell; no change at the first pass, then pages changed (a word anywhere, two words swapped, written from zeros) and cleared; cells of 4 MiB times a power of two; a range page by page and past RAM; RAM in parts (memory 0 and a spill memory) at their guest addresses, a part that isn't whole pages refused; looks (steps, cores, a cleared-only hollow core), the legend's changes only from the second look, words with addresses in hex; a pass over 1 GiB timed (logged). On Debian: RAM is a link in the status bar only while the machine runs; the map at 0x4000_0000 with data, a second look's changes, looked at again; 64 MiB written into a tmpfs counted as data and as changed over the looks, then given back after its `rm` (the balloon's free page reporting zeroes it); the line's whole and a square's addresses, a pinned square's range; after the power-off the words why and no link |
| The balloon ([devices.md](devices.md) "balloon") and DC ZVA over zero blocks ([cpu.md](cpu.md)) | `tests/balloon.test.ts`, `tests/core-wasm.test.ts`, `tests/store.test.ts`, `agent/src/serve_test.rs`; on Debian, `tests/page-debian.test.ts` (ci-debian) | the backend against the driver's queues without a guest: reporting zeroes only the pages that aren't zero, a hint's id, its blocks after the driver's start (never written) and its STOP, DONE after it and at a restored backend's start; DC ZVA over 256 MiB of fresh RAM grows the process by far less under the interpreter, the block interpreter, the JIT and JIT-stress (planted: each path storing always fails its modes); the slot last and out of the hash; the agent's DROP writes the switch. On Debian, the snapshot's hint hands over more than 256 MiB and the restored guest has its memory back |
| Changes in ([frontend.md](frontend.md) "Your own disk") | `tests/changes.test.ts` (Node, in-memory overlay; qemu-img/qemu-io for one case), the end of `tests/page-save.test.ts` and `tests/page-disk.test.ts` | the saved disk comes back through the overlay and replaces what it held; a changed base, size, a disk and a qcow2 from another tool are refused with the overlay untouched; qemu-img's own changes file (64 KiB clusters, zero cluster) reads; on the page, Buildroot loads its changes back and refuses a raw file, and a fresh profile's Debian plus the changes file saved from another-named copy boots with the file (the last phase of page-disk) |
| Your own disk on the page ([frontend.md](frontend.md) "Your own disk") | `tests/page-disk.test.ts` (with `WAARM64_DISTROS=debian`: two Debian boots and the changes-in boot, ~200 s alone; takes the Debian lock) | a qcow2 chosen with the picker boots through UEFI under its own overlay (`waarm64-disk-<hash>`, flash beside it); its changes are saved (download and picker handle: same bytes, `qemu-img check`, backing file, base hash); after a reload the same file chosen again has the file written before (planted: an overlay name that changes per choice fails it) |
| The page on Debian, end to end ([frontend.md](frontend.md) "The end-to-end test") | `tests/page-debian.test.ts` (`scripts/ci-debian.sh`: three Debian boots shared with GRUB's screen key, the page's size and the snapshot ("Debian boots" below); `WAARM64_PAGE_RUNS=N` repeats it; the ready marker's unit test always) | what a user does on the page's own VM (through UEFI, `tests/debian-unattended.ts`'s credentials over `?credential=`; the flash bank is saved beside the overlay): Debian on 2 parallel vCPUs from a fresh profile reaches `running`; root logs in on the serial terminal (xterm.js to the PL011), waits there for tty1's `login: ` in `/dev/vcs1`, then logs in on the **screen** (keys on the canvas through virtio-input) and runs a command that writes a marker to `/dev/ttyAMA0`, read back on the serial side; tty1's text (`/dev/vcs1`) shows the prompt and the command, and the canvas isn't black; the platform the firmware gave Linux (`rtc-efi`, the virtio-gpu framebuffer `virtio_gpudrmfb`, `/sys/firmware/efi`, both vCPUs, a credential read back from fw_cfg and the timezone systemd-firstboot set from it); a file written and synced is there after a reload (no shutdown). Reset disk is the Buildroot page test's (`tests/browser.test.ts`). The screen is a virtio-gpu here (device worker draws; `bench/gpu/draw-latency.ts` measures flush-to-draw); `tests/page-disk.test.ts` uses `?display=simple` to keep GRUB's serial menu. The transport's "QueueNum 0 is the maximum" has a unit test (EDK2's gpu driver hung the firmware without it) |
| The guest's clock across snapshots ([frontend.md](frontend.md) "The guest's clock", [platform.md](platform.md) "System suspend") | `core/src/vm/tests.rs` (`system_suspend_*`, `a_parallel_vcpu_resumes_from_system_suspend_when_woken`); `core/src/virtio/tests.rs` (`a_queue_turned_off_drops_its_chains_in_flight`); `core/src/xhci/tests.rs` (`a_suspend_and_resume_keeps_the_event_ring_where_the_guest_reads`, `a_snapshot_of_a_saved_controller_restores_its_ring_and_a_crs_without_one_is_sre`); `tests/clock.test.ts` (virtio-rtc); `tests/agent.test.ts` (TIME, `AgentActions`); `agent/src/serve_test.rs` (`sets_the_clock_from_time_past_the_slack`); `tests/page-clock.test.ts` (`ci-debian.sh --platform`) | the core: SYSTEM_SUSPEND in FEATURES, DENIED while another vCPU is on (both modes), the vCPU off until `wake_suspended` and then at its entry with its context (32-bit arguments for SMC32), a suspended state saved and restored with the RTC on the host's time (not in deterministic time, which has no SYSTEM_SUSPEND), a format 2 state restoring awake and a format 2 one with the field refused; a queue turned off drops its chains in flight (planted: kept, the test fails); virtio-rtc's messages and sizes as Linux's driver checks them. The xHCI's CSS and CRS through Linux's suspend and resume, also across a snapshot of the saved controller (planted: CRS leaving the producer where the ERSTBA write put it, both fail), and a format 4 state's CRS reporting SRE. TIME's bytes (Rust and TypeScript, nanoseconds exact for a whole millisecond's fraction), the link sending it only to an agent with `CAP.TIME`, `AgentActions` sending it at the HELLO, on `syncClock` and when the wall clock jumps past `SLEEP_GAP_MS` between checks, nothing with `?clocksync=0`; the agent setting the clock 90 s off and leaving it 1 ms off. On Debian with `?clocksync=1&agent=1&usb=1`: the clock device listed, the guest within 3 s of the host after its booting; its clock set back 120 s, then within 3 s after Save snapshot (the agent's log says so); after `systemctl suspend` and a key; after Suspend and a resume 20 s on; after the file loaded minutes later in a fresh profile, with no failed unit, RCU stall or watchdog line |
| The guest agent's channel and clipboard sharing's ([devices.md](devices.md) "vsock", "The guest's agent", [plans/clipboard.md](plans/clipboard.md)) | `tests/vsock.test.ts`, `tests/agent.test.ts` (Node, no guest); `agent/` (`cargo test` there, in `scripts/ci.sh`: the frames, TYPE's line ends); `tests/store.test.ts` (the shape); `tests/dist.test.ts` (the agent in the static copy, `HOST-BUILD` refused); `tests/page-agent.test.ts` (Debian, `scripts/ci-debian.sh`) | the vsock device's agent connection through hand-built queues as Linux's driver runs them: RESPONSE and `open`, the agent's bytes to the page, the page's into the guest's buffers within its credit (a CREDIT_REQUEST when out), the device's credit given back each quarter, one connection at a time, the page's `reset`, refused without the page's end, a device reset closing it (until 2026-11-13 the agent's virtio-console: MULTIPORT, its named port, PORT_OPEN, a snapshot's state); frames read back whatever pieces they come in, a bad length breaking the reader until reset; HELLO's and PAUSE's bytes (the same in Rust and TypeScript), TYPE cut between characters and never inside a CRLF; the page's link: nothing sent while closed, at most `WINDOW` in flight, a new connection dropping half a frame and the queue, HELLO at each connection (the clipboard's capabilities only where shared), TYPE only once the agent said it can and not while paused, PAUSE or RESUME said at each connection where the clipboard is shared, a stream out of step reset; the unit's lines and the script under dash (no fw_cfg file: nothing; the file: copied 0500 and run in the script's place); the binary's fetch (an ELF file or none); the shape: the agent and the clipboard leave it alone, an old snapshot's `agent` said. On Debian with `?clipboard=1`: the agent over fw_cfg, connected over vsock, its HELLO (TYPE, TIME), its unit active, its binary the page's, the fw_cfg read's time; idle for 20 s (`WAARM64_AGENT_IDLE`): no CPU ticks, no voluntary switches, VmRSS ≤ 1 MiB; TYPE of UTF-8 with CRLF and LF onto tty1's reader (a file, its SHA-256), 20 KiB more arriving whole at a slower reader (not canonical, a `dd` of 512 bytes at a time: the terminal's 4 KiB buffer fills); PAUSE dropping a raw TYPE, RESUME typing again; the agent stopped: the link closed and refusing, the machine running; then perl connected to the agent's port, a small frame and 320 KiB of 64 KiB frames echoed back unchanged; the agent started again. Planted: a close that keeps the bytes waiting, a buffer filled one byte past its room (step 1); TYPE frames cut inside a CRLF, the link not saying PAUSE again on a reopening, the agent's LF left as LF, its reader taking a length one past the largest, the agent ignoring PAUSE (Debian), the agent typing without waiting for the terminal's room (Debian: 5,242 of 20,035 bytes reached the reader); each caught |
| Clipboard sharing's Wayland side ([devices.md](devices.md) "The guest's agent", [plans/clipboard.md](plans/clipboard.md) §6 step 3) | `agent/` (`cargo test`: the wire format, the frames' payloads, logind's files, the types and the echo rule; `sway_test.rs` the session child against a headless sway with wl-clipboard, skipped without them); `tests/agent.test.ts` (Node: `web/app/clipboard.ts` on a faked link and clipboard); `tests/page-clipboard.test.ts` (images/debian-sway/build.sh's Debian, `scripts/ci-debian.sh --platform`, skipped without the image; ~5 min) | natively: Wayland requests as libwayland writes them (strings' NUL and padding, an untyped new_id), events split and read (half a header or message waits, a null string, a string without its NUL, sizes that can't be), descriptors over a socketpair; OFFER, REQUEST, DATA, ACK and MORE's bytes (the same in TypeScript); the seat's and a session's files (no active session, a greeter, a closing session, `ACTIVE_UID=` not `ACTIVE=`); the text types' order, FNV-1a; on sway 1.12 (ext data-control): wl-copy inline, 380 KiB requested within the credit (none past it before a MORE), a stale serial failing, the page's offer ACKed and pasted twice, the host's text copied back not offered, 760 KiB pasted twice under the child's MOREs, PAUSE clearing the host's text, refusing offers (ACK `PAUSED`) and the guest's copies, RESUME. In Node: the guest's offers written with focus (inline; lazy, a MORE per frame, none after the end), kept without it, a failed answer, a newer offer stopping the older request, the cap (by size, and while streaming), paused; the page's offers (inline, ACK before `ACK_WAIT`, the last text either way not offered, a long one answered `CREDIT` frames then one per MORE, MORE 0, stale serials and other types failing, no ACK, an ACK that refuses); the paste chord's keys (by the key: Dvorak), held for the paste event and the ACK, let go after `PASTE_WAIT` without one, not held while off. On the page (sway 1.10 through `zwlr`, the session a tty's on seat0): wl-copy reaching the host's clipboard (short; 200 KiB), the paste chord reaching wl-paste (short, again, 470 KiB, again), the host's text copied back not written again, PAUSE emptying the guest's clipboard and stopping both ways, RESUME; idle with sway for 20 s (`WAARM64_AGENT_IDLE`): no ticks or switches, VmRSS ≤ 1 MiB, for the agent and its child (as the user); sway's end and its start in a new session (getty's autologin), both ways again, one child. Planted (step 3): the agent's echo rule, its DATA past the credit, its own selection offered back, PAUSE leaving the host's text, no cache, no host hash, a greeter's session taken, strings without their NUL (cargo test); the page's echo rule, no MOREs, no credit, Cmd+V not a chord (Node); a held key's `preventDefault` (no paste event), each caught; and the first build's stop of a child (SIGKILL without `CAP_KILL`, the socket closed after the wait) hung the agent at sway's restart: the page test failed (the stop now closes the socket first, which ends the child by itself, then kills and reaps it) |
| systemd's notify socket ([devices.md](devices.md) "vsock") | `tests/vsock.test.ts` (Node, no guest); `tests/store.test.ts` (the shape); `tests/firmware-files.test.ts` (the credential's bytes); `tests/page-debian.test.ts` (Debian, `scripts/ci-debian.sh`) | the virtio-vsock through hand-built queues as Linux's transport drives it for sd_notify: the entry and the guest's CID; a connection to `NOTIFY_PORT` answered, its message across packets posted at the guest's half close (systemd 256+: the host's SHUTDOWN of both ways back, then the guest's RST frees the port) or full close (254: RST back); other ports, types and CIDs and a packet of no connection refused with RST, a guest's RST unanswered, CREDIT_REQUEST answered; a message past `BUF_ALLOC` reset and not posted; packets held until the guest posts receive buffers; a restore's TRANSPORT_RESET, once, when an event buffer comes; a device reset forgetting its connections; the page's end hearing READY=1 only; the credential on a firmware machine, replaced by a `?credential=` of its name, none on a direct boot. The shape: `vsock` last, the disks' slots as they were, the hash (pinned) unchanged, a shape without it the same machine. On Debian with `?ready=guest` (no serial marker): `running` from READY=1 alone; the device bound to `vmw_vsock_virtio_transport`, the credential in fw_cfg, PID 1 not complaining of either |
| Clipboard sharing's host side and its page ([plans/clipboard.md](plans/clipboard.md) §4–§5, [frontend.md](frontend.md) "The toolbar", Clipboard) | `tests/agent.test.ts` (Node: `web/app/clipboard.ts` on a faked link and browser); `tests/page-clipboard-ui.test.ts` (Chromium, Buildroot with `?clipboard=1`: its shell plays the agent on the port; seconds, in `npm test`); `tests/page-clipboard.test.ts` and `tests/page-agent.test.ts` (Debian, above) | In Node: no read without the permission `granted` or without focus, paused or closed; a read when it becomes `granted`; the host's text offered when it changed, an unchanged one not; with `clipboardchange`, a focus reading only after one; the guest's pending text the newest only, written on a focus that finds the host's clipboard unchanged, dropped when it changed, written on a key or pointer without the permission, kept when refused (no activation), dropped by a paste chord and by the pause; an empty read (an image's types) neither offered nor standing for the host's clipboard; `EMPTY_RUN` hidden reads (types say text, the text empty) stopping the focus reads (the toolbar told), a run broken by an image; refusals silent; the toolbar's state (waiting before HELLO and after the port closes, sharing, paused), PAUSE, RESUME and nothing more, Send (offered even when the guest has it; nothing when empty) and Type (TYPE); a paste chord right after a sync's offer of the same text waiting for its ACK; the read permission followed (its `change`; `none` when the name throws, without a clipboard or permissions). In Chromium on Buildroot: no button without the setting; waiting (Send and Type disabled), the page's HELLO and RESUME at the port's opening, sharing with the permission's mark (`prompt`), Allow… denied by headless Chromium (the denied note, no item), granted by the test (no mark, at once); a host copy offered on `clipboardchange`; the switch: PAUSE, paused (a copy not offered), RESUME then nothing until Send's OFFER; Type's TYPE; waiting after the port closes; a start with the permission granted offering the host's text at HELLO; with `?ready=guest`, `booting` with the shell's prompt up and the port open, `running` at the guest's HELLO (planted: the worker ignoring `up`, caught). The Home page: the switch off, its note, ticking it asking (headless: denied), the orphans' warning both ways, saved into the record, the snapshot's diff. On Debian: the button sharing, paused and resumed from its switch (TYPE dropped), waiting once the agent stops; with sway, a host copy reaching wl-paste with no paste chord, a focus with nothing new offering nothing, the pause from the switch. Planted (step 4): reads without the permission, the pending text kept over the host's newer copy, not written on an unchanged focus, not written on a key, written by a paste chord, the oldest kept, an empty read standing for the host's, hidden reads never stopping, a run not broken by an image, `clipboardchange` ignored, the pause keeping the pending text, the resume syncing, the chord ignoring an offer in flight, no RESUME at an opening, the permission's change not followed (Node); no `clipboardchange` listener, the switch not asking (Chromium); each caught. Not caught: the run's share not given the permission at its start (the watcher hands it over too, at its first answer; the page test's starts didn't meet the order this breaks). From the review of steps 1–4 (each test failing first, then planted and caught): `web/input.ts`'s hold queuing the keys after the held one (Ctrl released after V, two presses two, a blur dropping them: a fake DOM in Node); the paste chord by the host (Cmd+V only on a Mac); the guest's hash forgotten by an offer to it; an ACK refusing after `ACK_WAIT` taken; the hashes forgotten and the transfers dropped at the port's reopening, HELLO and SESSION, SESSION syncing again; a restored opening and a reader out of step begun afresh at SYNC (half a frame and garbage before it, cut anywhere); SYNC's and SESSION's bytes (cargo test too); the session child's SESSION on sway's data device and when sway is killed (`sway_test.rs`); on Debian, the host's text in sway's new session by itself. The agent's findings (cargo test; failing first, then planted): the root loop natively (`serve_test.rs`: a socketpair for the port, logind's and the runtime directories of its own, a fake console, a child on a thread echoing what it gets): HELLO, PAUSE and RESUME passed to the child, the parent's SESSION when the session goes and it stops the child, TYPE typed (TYPED DONE), refused on a console in graphics mode (NOT_TEXT), its paste not holding up HELLO's answer behind a stalled reader, the rest dropped past a second's stall (DROPPED); an inotify overflow a change (both loops); root's runtime directory mounted only on another device; a socket that refuses for good given up after the retries (the thread's voluntary switches over 2 s); on sway, the host's text copied again after the guest's own (and after a lazy offer, and a superseded offer's paste) offered, the page's HELLO ending a paste in flight and a stale request's MOREs. In Node: TYPED kept for the menu, and the unit's start limit reachable at its `RestartSec`; in Chromium the menu's note for NOT_TEXT; on Debian, tty1 in graphics mode (`KDSETMODE` by perl) refusing TYPE (TYPED NOT_TEXT, nothing typed) and typing again in text mode |
| Clipboard sharing's images and Copy the screen ([plans/clipboard.md](plans/clipboard.md) §4.4, step 5) | `agent/` (`cargo test`, `sway_test.rs`); `tests/agent.test.ts` (Node, a faked browser with `write`, `read()`'s items and a faked conversion); `tests/page-clipboard-ui.test.ts` (Chromium: Copy the screen on Buildroot, the PNG worker); `tests/page-clipboard.test.ts` (Debian with sway and grim, above) | Natively: PNG first among a program's types, then the types the page converts (not SVG: wl-copy offers it as text, which goes); on sway, a 300 KiB PNG offered at once of unknown size and streamed within the credit, a request for a type not offered failing, a JPEG offered as itself; the page's PNG held, offered as `image/png` alone, each paste requesting it (never cached, the text's cache untouched), text and image together, an image past 64 MiB refused (ACK `TOO_LARGE`) or left out beside text, no text or PNG `NO_TYPE`. In Node: the guest's PNG requested at the write and written as it came, a JPEG and a BMP converted, their text in the same item (inline or requested), the cap by size and while streaming, nothing taken from an agent without `CAP.IMAGE`; pending without focus (a newer text replacing it), refused and pending again (its requests stopped), the read-back after the write keeping the re-encoded image from going back, the host's next image offered; the host's PNG and text in one OFFER (the text inline), not again unchanged, the PNG answered under MOREs, the paste chord's `File`, an older image's answer failed, the cap, text alone for an older agent; the hashes. In Chromium: the PNG worker on a BMP (exact), a JPEG (near) and RGBA (exact), refusing bytes it can't decode; Copy the screen of Buildroot's framebuffer (160 rows the guest drew white, the rest black, opaque). On Debian: grim's PNG on the host with its PPM's pixels and not sent back on a focus; a JPEG typed in as base64 arriving as a PNG of its pixels; Copy the screen (on the default 3D path; on virtio-gpu 2D's scanout with `WAARM64_DISTROS=debian WAARM64_PAGE_QUERY=gpu=2d`, which passes too) and a 1.5 MB PNG of noise in wl-paste byte for byte (~1.9 s), the noise copied back with the same pixels; an offer past the cap refused, nothing requested. Planted (step 5): the agent's image cap, an image cached as the text, PNG not preferred, a request for a type not offered served (cargo test); no read-back, a JPEG unconverted, an older image answer kept, the page's image cap, images to an agent without `CAP.IMAGE`, a refused write not kept pending (Node); the framebuffer's PNG missing (Chromium); each caught. Not caught, and not observable: a copy of an image's bytes made but never kept (the text gate drops it) |
| Clipboard sharing's X11 side and `text/html` ([devices.md](devices.md) "The guest's agent", [plans/clipboard.md](plans/clipboard.md) §3.2, step 5) | `agent/` (`cargo test`: x11.rs's wire format; `x11_test.rs` the session child against an Xvfb of its own with xclip, skipped without Xvfb, xauth or xclip; `sway_test.rs` for HTML on Wayland); `tests/agent.test.ts` (Node: HTML); `tests/page-clipboard-x11.test.ts` (images/debian-sway/build.sh's Debian with its X login, `scripts/ci-debian.sh --platform`, skipped without the image) | Natively: requests as xcb writes them (InternAtom, ConvertSelection, the setup with and without a cookie, SendEvent's SelectionNotify), the setup's reply (the root, the largest request; refused with a reason), replies, errors and events split (SendEvent's bit, half a reply waits, one past the largest out of step), GetProperty's reply by format; `DISPLAY`'s forms, a server's command line and a client's environment, a /proc of the test's own (another user's process not read), the session file's display taking only it, Xauthority entries (this host's, a local one, the wildcard, a cut entry); on Xvfb with a cookie: xclip's text inline, 500 KB read from its offset in 64 KiB pieces, 2 MB by INCR (xclip's chunk is ~1 MiB), a PNG and HTML alone, a stale serial failing; the page's text under each of its names twice (the cache), TARGETS, a type not offered refused, the host's text copied back not offered, 400 KB to xclip by INCR, text, HTML and a 300 KB PNG in one offer each by its type, PAUSE emptying the clipboard and ignoring copies, RESUME, the server's end (SESSION); a compositor without data-control (a fake one answering the registry with nothing) giving way to Xvfb, found by its command line with no session file's display. On sway: wl-copy's HTML offered after its text and requested by type, the page's HTML beside its text pasted by `wl-paste -t text/html`. On the page (Xvfb on display 1 from a tty login, the
| Clipboard sharing: the final review's fixes ([devices.md](devices.md) "The guest's agent", [plans/clipboard.md](plans/clipboard.md)) | `agent/` (`cargo test`: console.rs's Typist on a fake n_tty, x11.rs's units, `x11_test.rs` with a raw X client of its own, `session.rs` with sockets of its own, `sway_test.rs`); `tests/agent.test.ts` (Node) | Natively: a paste past the 1 MiB queue typed as a prefix (no hole) and ending `DROPPED`, the next paste typed again; 8 MiB into a reader that keeps up holding at most 2 MiB; a canonical reader's 6 KiB line not typed past n_tty's buffer (`DROPPED`), short lines whole; a 70-atom TARGETS keeping UTF8_STRING and image/png; a display's socket of another uid not connected to; on Xvfb, seven owners that take the clipboard and exit unanswered, then xclip's copy offered, and an owner that stays unanswered getting its next TARGETS after the wait; a host transfer the page fails refused to xclip (which then tries STRING, refused too), then pasted whole; two INCR transfers to one window, both to their end; a compositor's and an X server's socket with full backlogs not holding the child (a REQUEST answered); on sway, the page's HELLO clearing a lazy host offer (no REQUEST of the old serial), keeping a cached one, and offering the guest's copy again under a new serial. In Node: TYPE's empty end frame; a guest image never served stopped after `REQUEST_WAIT` (a DATA restarting the wait) and the focus sync after it offering the host's copy; a focus read hashing its image when the chord's text comes, and an image paste begun before a text one, neither sent after the newer. Planted (each test failing first against the old behavior, then planted and caught): no owner wait (the TARGETS never reached the second silent owner: Xvfb gave it the first's window id), HELLO keeping everything (wl-paste waited for DATA), the TARGETS filter off, the socket's owner unchecked, the refusal off (xclip pasted 0 bytes), the mask turned off at A's end (B's chunks never came), a blocking connect on Wayland and on X11 (no answer), the Typist's refusal, its compaction and its canonical count each off, no request wait, no paste ordering in `focused` and in `paste` |
session a tty's with no `DISPLAY=`: found by Xvfb's command line, its cookie from `-auth`, its socket through the unit's
bind; ~2 min): xclip's text inline and 2.7 MB by INCR to the host, the paste chord to xclip (short, as `STRING` too,
400 KB by INCR), the host's text copied back not written again, xclip's PNG with its pixels on the host, 1.5 MB of
noise to xclip by INCR byte for byte (2.2 s), xclip's HTML on the host, the host's text and HTML each by its type,
PAUSE emptying the guest's clipboard and dropping its copies, RESUME; idle with X for 20 s: no ticks or switches,
VmRSS ≤ 1 MiB (604, 704 KiB); Xvfb's end, a new session and child, both ways again. In Node: the guest's HTML written with its text in one item (the HTML requested at the write), not offered back on a focus, HTML that fails written as the text escaped, past the cap the text alone, no `ClipboardItem` writes the text alone; the host's HTML offered after the text, answered by request, other HTML with the same text not offered again, the paste chord's HTML (with text, with an image), never alone, past the cap left out. Planted (step 5's X11 and HTML): INCR read as data, the offset not stepped, no INCR to requestors (BadLength), one window for all conversions, an INCR reader gone not drained, TARGETS without the text's names, no X11 where Wayland lacks data-control, PAUSE leaving the host's text, no cookie, the guest's HTML not offered (cargo test); the page's HTML not offered, the guest's not written, HTML in the hash, HTML answered as text (Node); a conversion
started while the owner is busy (the page test, on Debian's xclip 0.13: the 2.7 MB REQUEST never answered; the dev VM's
newer xclip doesn't drop requests, so the native test can't); each caught. Not caught by xclip: PAUSE keeping the ownership while refusing (a paste gets nothing either way) |
| The disk surface window ([frontend.md](frontend.md) "A disk's surface", [devices.md](devices.md) "blk") | `tests/surface.test.ts` (Node: the counts, the activity wrapper, the full walk every 10 s, the job from files and a stored disk's interrupted merge; live through `Devices.open` with `blkSpec`'s specs: a blank and a stored disk under a grown overlay at their own size, a stored disk written in place, blk with `concurrent` and stats under the activity wrapper); `tests/surface-image.test.ts` (Node: qcow2s made by `tests/qcow2-make.ts` at 64 KiB and 512-byte clusters counted from their tables, the tables read once locally, remotely only where the block cache keeps them, never past `ALLOCATION_MAX` (past it, the tables the guest read); tables arriving one by one, each counted once, what's under the others not examined; a remote raw image's and a qcow2's kept blocks (data and compressed clusters' host bytes) as ticks; the time of the kept count for a 20 GiB image; the job from a file; the handle check that never asks; a URL's image offline: the kept store's slots as the store takes them, a qcow2's tables read where kept (`readAllocation`'s `partial`)); `tests/surface-look.test.ts` (Node: looks, legend, words (partly examined squares, ticks over every rim), a dropped answer's activity carried, `chooseSource` (this tab's machine writing the disk in place, a machine loading, a URL disk's job named by `keptIdentity`, pinned to `remoteSource`'s names), the choice's key, the in-place answer, the polls' pacing, a job's timeout and a newer ask ending the one before, what Check contents can read); `tests/block-grid.test.ts` (Chromium: the grid and the floating window on a test page; ticks at their pixels, part and all, on every rim look and under a core); `tests/surface-poll.test.ts` (Chromium, the window's asks over made-up sources on a test page: a replaced answer's activity carried into the next taken at its scale, several adding up, carried once, none from another source, stale until the new source answers); `tests/page-surface.test.ts` (Chromium, no guest: overlays written by `tests/browser/overlay-writer.ts`); `tests/page-surface-debian.test.ts` (Debian, `scripts/ci-machines.sh`) | the link in the Disks pane (the disk alone) and a machine's Disks tab (its overlay); held squares where a stored disk's data is, an overlay grown past the disk (no rims past it, its end marked, cores changed and hollow), the legend's looks, the picker (the picture before dimmed until the other's first answer), a pinned square's blocks, runs and Check contents (a written block of zeros counted), its words beside its map in a short browser window (nothing scrolls), the window over the machine once the Home page closed and the focus left where it was, Refresh, a ramdisk off said in words, a file disk without a handle not examined and why, its blocks not checked (a record can't keep an OPFS handle there: Chromium's headless page goes away as one is stored); URL disks not running read from blocks put in the cache's bucket (a raw image's ticks with its header not kept, a qcow2 counted from its kept tables, one with nothing kept not examined, the cache held by a machine said in use), nothing fetched and the bucket's expiry left alone; a job caught holding a stored disk's lock while it waits for an overlay's, the disk not in use for `inUse` and a resize waiting for it, then resizes, a merge and a delete while the window asks for the overlays they change; the pointed square's words spoken once per square, not per new numbers, the keyboard's square gone on blur; live on Debian: the disk counted from its qcow2 tables as the boot reads them (what isn't examined only shrinks), its kept blocks ticked, the overlay's cores, the picker's live size, polled, a guest write flashing "written" and counted, the files after the power-off (the URL's image counted from its tables kept in this browser, its kept blocks ticked). Planted: the full walk left out, a zeroed-only core not hollow, a zero cluster counted as data, the re-mark of a change once it ended left out, known tables counted again, a full tick needing more than all, a compressed cluster's host bytes read as a data cluster's, a known-empty square with some not examined drawn empty, no stale mark on a source change, the dropped answer's carry left out (in `#take`, or in the accumulation) or carried across sources, a URL's kept blocks read without the image's lock (each caught) |
| The guest's keyboard layout ([frontend.md](frontend.md) "The keyboard layout") | `tests/keyboard.test.ts`; `core/src/smbios.rs`; `tests/store.test.ts`, `tests/page-modal.test.ts`; `tests/page-debian.test.ts` (`?keyboard=gb`) | the layouts and "[Match this browser](ui:machines:KeyboardField.keyboard.match)"'s detection, the credentials as base64 SMBIOS strings, the guest's script under dash on files of its own (Debian's `/etc/default/keyboard` with other lines kept, `/etc/environment`, a second run changing nothing); the host's strings in type 11 and out of fw_cfg; the setting in the record and the definition, not the shape; the Settings field and its note; on Debian the unit's result, localed's X11 layout and `XKB_DEFAULT_*` in a login |
| The page's size to the guest (M8 graphics G1 loop 5) | `tests/page-debian.test.ts` (`scripts/ci-debian.sh`; on its first boot, before any message's bar takes from the screen box); the rules' unit test in `tests/gpu.test.ts` | Debian on virtio-gpu: the console is born at the screen box's size (the connector's preferred mode and the canvas); a bigger window leaves the console enabled (the EDID's extra mode) and a fresh probe lists the new preferred mode; a smaller one never crops the canvas. Planted: the floor removed (the console cropped: caught); no extra modes (the console went blank: seen before the fix) |
| The guest's cursor on the page (M8 graphics G1 loop 6) | `tests/gpu-present.test.ts`; `tests/page-cursor.test.ts` (`scripts/ci.sh` when the Debian images exist: the page's machine is stopped within a second, ~10 s) | The presenter sends a cursor when its image or hotspot changes, its moves as positions (not a hidden one's); the page turns a message into the canvas's CSS cursor at the canvas's scale (hotspot scaled, blob's size and alpha), `none` hidden, the default when never set. Planted: the hotspot ignored (caught) |
| The screen's pointing devices: side buttons, chords, touch, the mouse lock, the leave warning | `tests/devices.test.ts` (the config answers); `tests/page-pointers.test.ts` (`scripts/ci.sh` when the Debian images exist: the start message's input ports are kept on the page and the worker stopped, ~15 s); `tests/page-debian.test.ts` (the guest's devices and a touch reaching its touchscreen) | Back and forward are BTN_SIDE/EXTRA and don't navigate; a second button held with the first is pressed; two touches take two slots, BTN_TOUCH from first down to last up; with the lock a click takes the mouse (not the guest's); in Pointer mode the motion moves the tablet as unlocked (a quarter of the screen's width is a quarter of its range) and stops at the edge; in Raw, motion and buttons go to the mouse, the page draws the guest's cursor at its position, clipped at the screen's corner (no page overflow), and letting go returns to the tablet; a running machine's page asks before a reload, not with Preferences' switch off. Planted: the back button's cancel removed (caught: the page navigated); the cursor's clip removed (caught: the page overflowed) |
| Snapshots on the page ([frontend.md](frontend.md) "Snapshots") | `tests/page-snapshot.test.ts` (Buildroot, ~20 s); Debian's in `tests/page-debian.test.ts` (`scripts/ci-debian.sh`: saved on its first boot, loaded in a second profile). The Debian snapshot is loaded into another window size: the console is drawn at its own size and still shown after the display event, and the connector's preferred mode is the new window's. **Suspend:** Buildroot suspended and the page reloaded resumes with its shell's variable and no suspended copy left, a second reload boots; Start resumes, Boot instead and Reset disk drop it (planted: the copy kept after a resume); Debian, on the same boots as the snapshot test: suspended logged in, resumed after a reload, a file written, then a normal boot finds every file; `tests/snapshot.test.ts` has the file's rules (no disk blocks, the overlay kept, refused as a snapshot), and the rule benchmarks start from (docs/benchmarking.md "Starting from a snapshot"): a file loads into another build of the core (other bytes, another ABI in its header) and Buildroot runs on to the unbroken run's steps and console, while another state version, a changed core state word and another machine are refused (planted: the ABI checked, the version not checked; each fails it) | Save snapshot (download and picker handle; the machine runs on), Load snapshot in a fresh profile (a shell variable, a devtmpfs file, the terminal's tail, the snapshot's vCPUs; Debian: logged in, the disk's file read past the page cache, the flash copy beside the new overlay, a write and a reload after), a snapshot dropped like a disk, the refusals with the disk untouched (not a snapshot, another machine, another disk, devices the page can't make, truncated; Start recovers). Planted: no resume after a save, no flash rewrite, no overlay replacement, a terminal reply to the replayed tail each fail it |
| Machines as the unit ([machines.md](machines.md), [frontend.md](frontend.md) "Machines in the browser") | `tests/store.test.ts` (Node and Chromium), `tests/ramdisk.test.ts`, `tests/stored.test.ts`, `tests/merge.test.ts`, `tests/unrestorable.test.ts`, `tests/overlay.test.ts`, `tests/overlay-leaves.test.ts` (Node, and Chromium for OPFS), `tests/resize.test.ts` (Node, and Chromium for the meta written from a page), `tests/devices.test.ts`, `tests/snapshot-plan.test.ts` (Node, a bare-metal guest; `tests/devices.test.ts`: a write the storage refuses told once until one lands), `tests/restore-records.test.ts` (Node: a restore's records, the rules' table of machines.md §5.2), `tests/file-access.test.ts` (Node: a file disk's file through stand-in handles); `tests/page-disks.test.ts`, `tests/page-file-disk.test.ts`, `tests/page-modal.test.ts`, `tests/page-resize.test.ts`, `tests/page-restore.test.ts` (the machine worker a stand-in), `tests/page-definitions.test.ts`, `tests/page-open.test.ts`, `tests/page-unrestorable.test.ts`, `tests/dist.test.ts`, `tests/storage-full.test.ts` (Chromium, no guest); `tests/page-machines.test.ts`, `tests/page-stored.test.ts`, `tests/page-snapshots.test.ts`, `tests/page-quota.test.ts`, `tests/page-incognito.test.ts` (Debian, `scripts/ci-machines.sh`), `tests/page-disk.test.ts` (Debian, `scripts/ci-debian.sh`) | the records written after their bytes and the sweep of what a crash left (only id-named files; it waits for writers), deletions in order, two tabs hearing each other; the shape's hash pinned, moved by what the guest sees and nothing else (a ramdisk as swap too); Make a machine like it bringing a swap ramdisk back; the ramdisk against a byte array (chunks given back), its swap page against `mkswap`'s and `blkid`, written at a start and not over a restore's chunks, the `fstab.extra` line; a stored disk's import read back (raw, qcow2 with compressed clusters), exported under `qemu-img compare`, merged, an interrupted merge finished at the next opening; a blank disk's overlay merged (one never written to grows the blank disk, a written one makes it a stored disk at its size; from the Overlays dialog too); kept snapshots that can never be restored (another core's format, a stored disk written in place or merged into under them, a disk written in place moved on) shown as orphaned with why, refused by the restore's plan, an unmoved in-place pin forked under an overlay; planted: no bases check, no in-place fork, a generation that didn't move taken as moved, merging an untouched overlay as a written one (each caught); the generation bumped once per opening before the first change, and again after a snapshot's pin; a restore's plan (keep, fork, reuse, replace, in place); a restore's records (each way a restore writes a disk by how far the worker got, and what the next load finds; another machine's restore on a shared overlay left alone; overlays and forks other machines have (no replace into one, a fork another machine took or wrote kept by the undo, an overlay another machine wrote not emptied, a copy on what the undo puts back, the fill token in the meta), the record's other writers keeping a commit and a load that land while they work; a commit cut off part way; an undo left while an overlay is open, refusing a second restore; Delete overlay holding off a machine whose undo names the overlay; a merge undoing the held machines' restores first; on the page, a load whose record is refused stopping the run, Retry no restore after a stop, a start held off by a change to its disks saying so, a template's first commit failing with Retry; PERF loop 86's review: a restore onto an attachment written in place since forking, never kept or written into, the worker refusing a keep of another overlay than its device's, the commit refusing an overlay another machine chose in its transaction's window, a copy not put on an overlay deleted since, a fresh overlay's fork mark and the run's refresh of its record both kept, a template's fresh overlay planned as a fork's, the page's answer to `loaded` sent only once recorded, a stored machine's Reset disk opening its Disks tab, and on Buildroot (tests/page-snapshot.test.ts) a restored machine running only after that answer; planted: each, caught); the Home page making a machine and its disks (the Add a disk wizard; the ramdisk's swap box), the browser's Disks pane (a disk's Overlays dialog, Attach to a machine refusing a machine that has the disk or has the most, Delete refused while attached), definitions carrying a swap ramdisk, the URL check's refusals; definitions across two fresh profiles (a file chosen again of another size or other contents refused); a file disk's file out of reach (machines.md §3.2): each answer of the browser's or none (a grant, a refusal, an error, a question or a request never answered and the request's late answer, a file moved away, changed, or another at its place) a reason with words, the start's bar offering Allow and start where a grant may help and Choose again and start always (the browser stubbed never to answer: Allow and start said unanswered within its bound, where before the click did nothing; a moved file), a file of another size refused, the record keeping its id, identity, attachments and overlays with the new handle, an overlay's export saying so before the save with Choose again, the Disks pane's note and Choose the file again…; planted: the grant trusted without reading the file, the query and the request unbounded, a rejected request uncaught, no size check on a pick, the record rebuilt, a click's grant asked again, no Choose again on the bar, the export not checking first (each caught); a second tab of a machine that runs in another told so at once (not after the overlay's wait), and Open disk… and From a disk image… keeping the picked file's handle (the picker stubbed with an OPFS file: Playwright aborts the real one). On Debian: five disks (a URL, blank formatted and kept, a ramdisk empty after a reboot, read-only refusing writes, a ramdisk as swap: on by its label with `sw,nofail,discard` at boot and after the reboot); Debian stored in the browser (~1 GB, an on-disk profile: an off-the-record context's OPFS holds ~0.8 GB), variants, Import changes into a new overlay, a merge, in place; three kept snapshots (an on-disk profile too: with the URL disk's block cache they outgrow an off-the-record one; the toolbar's Snapshot, renamed on the Snapshots tab), an older one restored forking the newer state, the ramdisk back, Suspend on pins, a RAM change orphaning them; the origin's quota lowered (`Storage.overrideQuotaForOrigin`) under a guest writing past it: I/O errors, the page saying the storage is full once while the machine runs on. Off the record (tests/page-incognito.test.ts), the URL disk's cache filled, then a kept snapshot, a Restore and a Suspend landing as the cache gives its room back. Without a guest (tests/storage-full.test.ts, Chromium, the quota lowered off the record): the snapshot writer giving the cache's room back and saying the storage is full with `estimate()`'s numbers, a stored disk's import saying so, an overlay whose making was refused made by the next opening; tests/overlay.test.ts refuses growing writes at random (data and map, short, thrown, off the record's error count) and checks the overlay reads what its files say; tests/devices.test.ts a zeroing (a new leaf) giving the cache's room back and a discard needing none. The overlay's two-level map (tests/overlay-leaves.test.ts): reads, writes, zeroings and discards across leaf boundaries against a model, a write at the end of 1 TiB leaving two leaves (file and memory), a whole disk zeroed in a few writes, a flat map read as it is (and by a stored disk's reader) and converted by the first change, an interrupted conversion after any of its writes, refused writes at a leaf's making (any prefix landed) and at a conversion, compaction across leaves, a changes export and a snapshot's walk of a 1 TiB overlay, a crash after any write across leaves, and in Chromium a flat map through read-only handles then converted. Growing a disk: an overlay past its base (zeros, writes at the grown end kept reopened, a 32-byte `meta` from before sizes), the resize grow-only in sectors and refused while a machine using it runs or its files are open, what it orphans, the grow mark, the shape and the start's size, an export's qcow2 at the grown size and its changes back in, a stored disk read past its old end, a fork keeping the size (the page's plan and the worker's); the cap (`MAX_RESIZE`); the page's Resize dialog from the Disks pane (a stored disk, an overlay's row, a ramdisk) and a machine's Disks tab (none on a read-only disk; an attachment with no overlay yet given one at the new size, and one made meanwhile resized as itself, tests/resize.test.ts too), what an overlay and a stored disk hold of their sizes where the page shows them (a stored disk's record from before it was kept read at the page's opening), its box on by default (none for a ramdisk), its refusals as typed (not larger, past the cap, a machine running), the machines and orphaned snapshots it lists, the machine on this page powered off from it, and the records' sizes and grow marks after (the Disks tab's shortcut on a stored disk written in place too). The guest's grow from the page (tests/agent.test.ts, tests/resize.test.ts): GROW at each HELLO of an agent with `CAP.GROW` for the marked disks (an overlay's mark, a stored disk's under an overlay and in place, the first machine clearing it for the others), each GROWN's effect on the marks and its words, a duplicate, a late GROWN on a later connection, the run ending first; a definition's `overlaySize` and the imported overlay at it, marked; on Debian (tests/page-stored.test.ts, the stored disk's in-place boot, no boot of its own) the disk grown by 1 GiB, the agent's GROWN, the notice, the mark cleared, `lsblk` and `df` seeing the new size. Planted: a refused leaf kept in memory, a run's leaf made before its data, a conversion without its trailer, its header moved before the records were copied down (each caught by the leaf tests), the bump left out, the epoch left out, an interrupted merge not resumed, a fork skipped when the generation differs, an overlay's own size not read from its `meta`, the shape ignoring an overlay's size, the mark cleared on NOT_YET, GROW not sent for a stored disk's mark (each caught); the page review's findings (RESIZE loop 5b: tests/resize.test.ts "finding N", tests/page-restore.test.ts, tests/agent.test.ts's BAD_REQUEST), each failing first: a restore committing on the record it was planned on and starting on the overlay before its fork, a stored disk's mark sent through an overlay larger already, a grown fork reused, a fork's size missing from its `meta`, a refused record leaving the `meta` grown, a fork dropping a standing mark, a machine like a snapshot at other sizes, New empty, a switch or imported changes changing the size unasked, an `overlaySize` past the cap, a grown stored disk's definition, its changes files refused, a resize writing a record forgotten meanwhile and a ramdisk's without its machines' locks, BAD_REQUEST taken as a failure; planted: the commit on the planned record, the start before the record reread, the stored disk's mark without the size check (each caught) |
| The harness pages' imports (`tests/browser/`, `tests/usb/`, `bench/` HTML: inline module scripts `tsc` doesn't read) | `tools/harness-imports.ts` (in `scripts/ci.sh`) | each tracked page's static imports, `(await import(x)).name` and `{…} = await import(x)`, and its `<script src>`, written to a module per page under `target/harness-imports/` and type-checked with the repository's options: an unknown module or a missing export fails, named by the page. Planted: `primaryOf`/`ranksOf` imported from network.ts again, a module renamed (both caught) |
| Third-party attribution and the About pane ([third-party.md](third-party.md), [frontend.md](frontend.md) "About") | `tools/third-party.ts` (in `scripts/ci.sh`; `--links` by hand); `tests/third-party.test.ts` (Node); `tests/page-about.test.ts` (Chromium, no guest) | THIRD_PARTY.json's checks (ids, every column's cell, a shown row's version, SPDX license and license texts pinned to a commit or tag, `bundled` known), the rows marked `about` reaching the pane and no other (no tool, oracle, workload or reference, no row's Markdown), rows of one project merged, the Markdown rendering's rows; the pane after Preferences with the repository, the checkout's commit and its link, each group's projects in order, the Derived code tag, every link to another site in a new tab with `external nofollow noopener noreferrer`, the files beside the page answering. Planted: `nofollow` dropped (caught) |
| Network adapters and connections ([networking/adapters.md](networking/adapters.md)) | `tests/connections.test.ts` (Node and Chromium), `tests/store.test.ts` (adapters), `tests/net-live.test.ts` (the adapters live, fake clients), `tests/page-connections.test.ts` (Chromium, two stored machines on the firmware alone, ~40 s), `tests/page-net-buttons.test.ts` (Chromium, four adapters on the firmware alone, ~3 s: a toolbar button each where they fit, one for all where they'd wrap, a menu's panel that scrolls inside the window), `tests/net-guest.test.ts`, `tests/page-network.test.ts` and `tests/net-tailnet.test.ts` (Debian, `scripts/ci-net.sh`; the last with headscale and tailcat's rig) | adapters in the shape (one at the default MAC hashes as the card did; more, another MAC or another order move it), added up to four and removed, copies and definitions carrying the MACs and no connections; on Debian, three cards each with its own lease, router and gateway MAC, and two whose default route goes through the primary only (the other's network through it: 100.64.0.0/10, the /48 from a Route Information option), moving when the primary does (IPv6 at once, IPv4 within 10 s, bounded at 45 s); a tailnet without an exit node beside tailcat through a server, the primary though second, the guest reaching the tailnet's peer (by address and by MagicDNS name) and tailcat's internet at once, and a tailcat client coming in over IPv6 from inside the tailnet's /48, answered through tailcat's adapter by its own /128; `tests/gateway.test.ts` and `tests/network.test.ts` for the routes-only lease and `primaryOf`. Planted: a MAC left out of the hash, every adapter's gateway at one address, a default route from every gateway (each caught). Stored and ephemeral connections, their names and state keys (two to one tailnet are two nodes), deleted with their state; the Attach wizard's preselection; the single connection kept before migrated (its kept nodes under their profiles, the served identity), idempotent; the locks between tabs; the store's upgrade to version 2 over a database made before, keeping its records. Planted: a kept node's profile rewritten (caught). The page (L3): what a connection starts its client with (an ephemeral one's node not kept), connect at start, a restart keeping the clients and another machine stopping them, a machine powered off letting them go (an ephemeral tailnet's stays), clients following adapters that move, another tab's attachments followed, kept nodes logged out with no machine (not before the control server answers, none lost when it doesn't), an attachment whose connection is gone detached with a note, the default way out moving to the adapter that reaches the internet; in Chromium a new machine connected in one wizard, another tab's machine named as the holder and taking the connection after asking, Detach, an ephemeral connection gone after a reload, Connections' rename and delete, power off letting the lock go, a running machine connecting and stopping at once for what another tab attaches and detaches, adapters moved and saved. Against headscale (`tests/tailscale-browser.test.ts`), a node no machine runs logged out and its key expired. Planted: a connect without its lock, every node kept, Keep ignored, the page not telling the network its machine stopped, the page not following another tab (each caught) |
| USB on the page ([usb.md](usb.md) "The page") | `tests/usb-page.test.ts` (Node), `tests/page-usb.test.ts` (Chromium, WebUSB and WebHID faked, no guest), `tests/page-usb-guest.test.ts` (Debian, `scripts/ci-machines.sh`) | the controller left out of an off machine's shape (its hash pinned in `tests/store.test.ts`); entries matched to the browser's devices (serial-less twins by order), the messages' remedies, the ports against a fake device worker, the locks between tabs (who holds one, Detach there); the USB tab, the wizard, a definition on another profile (Allow, Forget revoking); Gadget Zero attached from the menu, seen by the guest, unplugged around a snapshot and back |
| The Machine menu ([frontend.md](frontend.md) "Views, settings and the disk") | `tests/page-machine.test.ts` (Buildroot, ~6 s; its graphics test on Debian in `scripts/ci-graphics.sh`) | vCPUs and RAM chosen in the menu show in the status line after the restart, are remembered over a reload, and `?ncpus=`/`?ram=` win; Graphics: 3D by default, 2D from the menu after its restart and over a reload (the page's `data-graphics`), `?gpu=virgl` over it with the choice greyed out; the RAM above 1 GiB with the gpu is Debian's (`scripts/ci-debian.sh`, once a default) |
| The local network helper ([networking/local-helper.md](networking/local-helper.md), `github.com/gbl08ma/waarm64-net`) | the helper's own `go test -race ./...` in its repository (its CI on each push; ~10 s: a guest on gVisor's netstack over a real WebSocket; `main_test.go`: the MTU's bounds, a taken port, loopback only). waarm64's tests take the helper's source at the commit `tests/waarm64-net.ts` pins (fetched with git into `target/net/waarm64-net-src`; `WAARM64_NET_SRC` names a checkout instead; SKIPPED when it can't be fetched): `tests/local-net.test.ts` (the page's framing, a batch under the helper's limit on a message, the pairing link and a malformed one, the lease read from the helper's DHCP and only for the client's own MAC, a blocked port said; always), `tests/local-release.test.ts` (the page's install lines byte for byte against `build.sh --install`'s, for a reproducibility build's sums and the release the page offers), `tests/net-path.test.ts` (the card's switch between the gateway and a frame port, the link flapping only under a driver, the gateway silent on the helper's frames, a MessagePort adapter's frames sent), `tests/network.test.ts` and `tests/connections.test.ts` (the kind, its view, `primaryOf` taking it first, the gateway brought back once), `tests/gateway.test.ts` (a lease for another address flaps the link, a reconnect's doesn't), `tests/page-local.test.ts` (the page with the real helper: the pairing link out of the address, the wizard on This computer with the release's install lines (also from a fragment's change in an open tab), Attach, connected at the start, a stopped helper said, Retry; from an origin `--ip-address-space-overrides` calls public, connected once CDP grants `loopback-network` and the refusal said otherwise; needs the firmware and Go, ~30 s), `tests/net-local.test.ts` (Debian on the page through the helper, built at the pin; then a room on a second adapter beside it, `tests/browser/adapters.html`'s `?local=&room=`; `scripts/ci-net.sh`, needs Go, ~2 min each) | the refusals and their close codes (another origin, an origin's other scheme, none; a wrong or missing token; another version or none); DHCP's offer; a router advertisement's default route following the host's IPv6 reach (the probe's resolver stood in on IPv4 loopback), unsolicited both ways, checksums valid; the gateway's neighbor advertisements saying it's a router; no advertisement with `--no-ipv6`; a megabyte each way over TCP to this machine's loopback with `--host-loopback`, and nothing without it, nor UDP by `0.0.0.0`, `127.0.0.1`, `::`, `::1` or IPv4-mapped addresses. On Debian: the page's gateway's lease first, then the helper's within seconds of the switch to its client (the link's flap; the menu's address from its acknowledgment), DNS through it, 8 MiB each way to a server on this machine (sha256 checked), `apt-get update`, the address in the helper's /64 and its gateway's ping, the IPv6 default as the host has it (none in the cloud: curl's "couldn't connect" at once, a dual-stack name over IPv4 at once), a wrong token and another origin refused from Chromium; beside a room on the second card (its other member tests/browser/room.html), the helper's adapter the primary, the defaults only through its card and the room's /48 through the room's, the member reached by name (UDP to its echo port, through the room's resolver) while names, this machine's server and `apt-get update` go through the helper. Planted: the lifetime left at 1000 while out, the re-advertisement on a change dropped, the taken port's message dropped, the stale lease's flap dropped, the helper not ranked first, the gateway not brought back, no flap on the way back, the refusal not told apart (`loopbackRefused` false), the room's worker offering its lease as the primary's (a default through the room's card) (each caught) |
| The demo network ([networking/demo-network.md](networking/demo-network.md), `github.com/gbl08ma/waarm64-demonet`) | the server's own `go test -race ./...` in its repository. waarm64's tests take its source at the commit `tests/waarm64-demonet.ts` pins (fetched with git into `target/net/waarm64-demonet-src`; `WAARM64_DEMONET_SRC` names a checkout instead; SKIPPED when it can't be fetched, as in a cloud session): `tests/demo-net.test.ts` (the client against a fake server on a fake clock, and its words; always), `tests/net-live.test.ts` (no lock, many at once, the primary, the notices), `tests/page-demonet.test.ts` (Alpine on the page against the real server on loopback; `scripts/ci-net.sh`, needs Go and images/build.sh alpine-uefi edk2, ~2 min) | the frames held until `hello` and the hold's bound; every control message kept, unknown ones ignored; 4012's reconnect only at the guest's next frame; `reconnect_after` plus up to 30 s for 4011/4013/4008; at least 30 s for 4008 `guests`/`site` and 4009; the backoff 1 s doubling to 2 min; a lost socket said once; 4010 until `resets`; 4001/4003/1002/1009/a malformed message for good; `budget?` only while traffic moves; a restart keeping the socket. On Alpine: the server's lease and `/status`, a refusal counted and named in the menu, a restart announced (the message bar) and waited out (4011), the page back by itself, 80 % and the budget spent in the message bar, 4010's wait in the menu. Planted: 4012 reconnecting at once, no random delay, the held frames dropped, the demo connection locked (each caught) |
| The network on Debian ([frontend.md](frontend.md) "Network"), and the agent on Alpine | `tests/page-alpine-agent.test.ts` (ci-net.sh, ~2 min: Alpine's cloud image on the local helper, the agent's OpenRC service installed from fw_cfg, the machine up at the agent's HELLO, a template with an old clock restored in a fresh profile: the clock set, the lease renewed through dhcpcd and udhcpc, `apk` over TLS to this machine, a power-off through busybox; devices.md "On OpenRC"; planted: dhcpcd not found, caught), `tests/network.test.ts` (the page's controller and parsers, a fake client; always), `tests/net-guest.test.ts` (with `WAARM64_DISTROS=debian`: the page's Debian with a card on the echo gateway configures itself from its command line and pings any address over IPv4 and IPv6, and takes a late lease in both families, ~3 min), `tests/page-network.test.ts` (the Network menu against an unreachable control server: form errors, the card, the connection kept but not the key, Disconnect, an ephemeral connection gone after a reload; ~4 min), `tests/net-tailnet.test.ts` (Debian on a headscale tailnet: DHCP lease = the client's address, ping (v4 and v6) and MagicDNS to a peer, the peer reaches a server in the guest over both, and the peer as a subnet router for this machine's address: not reached before the route is approved, reached once it is (the client learning it while running), not with the page's toggle off; then, **opt-in with `WAARM64_TAILNET_INTERNET=1`** (it needs the real internet; skipped loudly otherwise; passed 2026-10-01, ~100 s whole test), the peer as the exit node: the internet (1.1.1.1, example.com) and DNS through it, and the guest's IPv6 default
there only as the peer has an IPv6 route out (the probe, web/reach6.ts: rootless Podman gives it none, so it goes),
back once the exit node is cleared. Its targets must be public: Tailscale's exit nodes never forward RFC 1918, CGNAT or link-local destinations, their own LAN included. The dev VM's LAN address failed as a stand-in for the internet (curl exit 28). Needs Podman and `target/net/ts.wasm` (the page's client); it also pings the peer by its short name (the guest must take the lease's search domain: `UseDomains=yes`, [frontend.md](frontend.md) "Network"; `HEADSCALE_DOMAIN=` runs the rig with another MagicDNS domain, e.g. a `.local` one); `scripts/ci-net.sh` sets `WAARM64_TAILNET=1` when Podman is there, ~2 min; the tailcat backend (docs/networking/tailnet.md): `tests/ts-client.test.ts` (the Rust client's module with a stub WebSocket; always, once `net/ts/build.sh` ran), `tests/room-browser.test.ts` (Chromium, no guest: members of a room in pages joining by its link, which names the rig's derper and the tests' Nostr relay, `tests/net/nostr-relay.ts`; a dialer finds the other by a lookup, by address and by name through the room's resolver: echoes through the relay at once, then over their data channel, back to the relay when it drops; relay only never opens one; incoming off isn't reached; ~15 s; the room client's own cases are `cargo test -p waarm64_ts room`, the relay's `tests/nostr-relay.test.ts`), `tests/page-room.test.ts` (Debian, two guests in one Chromium with two profiles: one creates a private room in the Network wizard on the tests' Nostr relay and the rig's derper, the other joins by its link, and they ping each other by name through the room's resolver; the wizard's refusals; then registered names, served by a guest-less member in the room's harness page with titles of `net/ts/examples/names-title.rs`, every page running the page tests' module (`net/ts/build.sh --test-params`, `target/net/ts-test.wasm`, which the test builds and serves in `ts.wasm`'s place: docs/networking/names.md "Tests' parameters"): no server, a server that appears while a guest keeps asking, the full and the short name, a label, reserved names, a zone change, what Debian asks on its own; ~5 min; the link's own cases are `tests/room-link.test.ts`; room names' TypeScript side, the pretend calendars and explorer `tests/net/ots-calendar.ts` and the records in IndexedDB are `tests/room-names.test.ts`), `tests/tailcat-browser.test.ts` (Chromium, no guest: the page's tailcat client against `tests/net/tailcat.sh`'s exit node comes up and carries UDP; a kept identity's key let in by a second exit node's `--allow` and a fresh key not; a served machine's pong to `tailcat ping`, through tailcat's public relays too with `WAARM64_TAILCAT_INTERNET=1`; ~30 s) and `tests/net-tailcat.test.ts` (Debian through the exit node: both leases, HTTP, 2 MB down and 2 MB up (virtio-net's TSO: under 1,000 packets leave the guest's interface) to this machine's LAN address over IPv4 and IPv6; the IPv6 probe (web/reach6.ts): without an IPv6 address on this machine it is lost, so the guest has no IPv6 default,
keeps its tunnel address (the tailcat clients come in with a /128 route each) and gets curl's "couldn't connect" at once over IPv6;
with one, a stand-in resolver on it (`tests/net/resolver.ts`) answers, and the default is there, goes within 14 s when
the stand-in stops and comes back; with one too, a primary per family: two tailcat adapters, the first's probe
unanswered and the second's answered, IPv4's default through the first and IPv6's through the second (on the dev VM by
hand, with a ULA added to `eth0`: docs/networking/adapters.md §4); the internet opt-in
with `WAARM64_TAILCAT_INTERNET=1`, plain `curl` (IPv6 out, it uses IPv4). On images/debian-tools/build.sh's Debian (on
demand; SKIPPED without it), serving alone with an allow list of the CLI's `client-default` key: `tailcat ssh` logs in to
the guest's sshd with a key of the test's own (an `ssh` wrapper first on `PATH`), `tailcat ping` gets a pong and a fresh
key gets neither; over the rig's relay, or over tailcat's public relays with `WAARM64_TAILCAT_INTERNET=1` (~45 s). No stand-in works without a real IPv6
address: the exit node drops `::1` and `::ffff:127.0.0.1`, and answers from `64:ff9b::/96` reach the guest as IPv4.
The real targets answering was checked by hand: `tailcat serve exit-node` on the Mac (built here with `GOOS=darwin`,
kept in `~/waarm64-tailcat`), the page's Debian through it. **The IPv6 part needs a non-link-local IPv6 address on a non-loopback interface**, which Lima's VM lacks: `sudo ip -6 addr add fd00:7e57::1/128 dev eth0 nodad` before the run, or it says SKIPPED; the exit node doesn't answer its own `[::1]`), both with `WAARM64_TAILCAT=1`, which `scripts/ci-net.sh` sets when Go is there (it builds tailcat and derper)); the Rust Tailscale client (docs/networking/tailnet.md "Tailscale"): `cargo test -p waarm64_ts` (Noise, HTTP/2, the netmap, the store, the session against a fake control server, the filter, the exit node, MagicDNS; always), `tests/ts-tailnet.test.ts` (in Node against the test tailnet: the kept node handed over with the Go client (`net/tailscale`, now only this test's fixture), run in a Node worker, both ways; the netmap against the peer's; interactive login; a stand-in guest's pings, DNS, UDP and TCP, the peer's disco ping and connection in; ~1 min), `tests/tailscale-browser.test.ts` (the client in Chromium, no guest: Running, the lease, 2,000 echoes; a kept node through reloads; logout), both with `WAARM64_TAILNET=1`, and `tests/ts-tailcat.test.ts` (`WAARM64_TAILCAT=1`: the module in Node against the tailcat rig, its relay's WebSocket cut off while it stays open (`tests/net/tailcat-blackhole.ts`): the guest's echoes come back within ~8 s on a new connection; ~15 s), run one at a time by `scripts/ci-net.sh`'s last step (each brings the test tailnet up on the same ports). Without Podman (a cloud session) `WAARM64_TAILNET_SCRIPT=tests/net/tailnet-native.sh` runs the same tailnet natively) | the gateway's bytes are `tests/gateway.test.ts` and `tests/devices.test.ts`, virtio-net's offloads' `tests/offload.test.ts`; these test what the guest and the page do with them. The Debian ones take turns through `tests/debian-lock.ts` |
| Registered names in rooms ([networking/names.md](networking/names.md) "Tests and benches") | `cargo test -p waarm64_ts` (`room/names/tests.rs`: records and rules, a real anchored proof as the vector, merge-order properties; `server_tests.rs`, `member_tests.rs`: the registry on a bus in simulated time; `room/tests/names.rs`: through the fake DERP and relay; ~95 s with the 20-server and 60-day cases); `tests/room-names.test.ts` (the pretend calendars and explorer `tests/net/ots-calendar.ts`, which module runs on which parameters, the records in IndexedDB in Chromium), `tests/names-agent.test.ts` (the agent on the tests' module and the pretend services, through `fetch`: `tests/net/names-agent.ts`), `tests/names-browser.test.ts` (Chromium: the agent's worker, IndexedDB, routes, an export into another profile), `tests/names-page.test.ts` (the page's words and the dialog's outcomes, its `wording:` cases), `tests/names-room.test.ts` (opt-in `WAARM64_TAILCAT=1`: real servers through the rig's derper and the tests' relay), all on the tests' module, which `scripts/ci.sh` builds (`net/ts/build.sh --test-params`, `target/net/ts-test.wasm`) and they skip without; `tests/page-room.test.ts`'s names steps in `scripts/ci-net.sh` (above) | the records and the rules of who owns a name, sealing, the anchor verifier and the floor; servers' sync, asks and replies, the bound, what they ask outside the room; a member's first lookup, contests, what it keeps, the resolver's answers; the agent's stamping, collecting, renewing ahead, publishing, forks and lost titles, export and import; the dialog and the states; production's parameters never in a test title, and only the compiled services fetched |
| `npm start` ([frontend.md](frontend.md) "`npm start`") | `tests/start.test.ts` (the checks: ms; the run: ~5 s, with `WAARM64_DISTROS=debian`) | the Node-version and rustup messages (an old Node faked with `--import`; a `PATH` with Node alone), the npm staleness rule, the core's input hash; then a copy of the repository as a clone has it (tracked and untracked files, no `node_modules` or `target/`) runs `npm start` (PORT=0): `npm ci`, no disk image prepared (no "Debian" in its output), the URL printed, the page waits for a disk ("Open a disk image"), then, given this checkout's Debian linked into the copy (`?disk=`), boots it in Chromium until the firmware writes to the serial console, and a second start with nothing to do takes < 5 s (~0.1). The copy gets this checkout's core and a matching stamp; **`WAARM64_START_COLD=1`** makes it build its own (the whole path a user takes; run it when `start.ts` or the build changes) |
| Host code | `tests/{devices,overlay,qcow2,fat,serve,wasm-encoder,core-wasm,memory-kernels}.test.ts` | 9p server (readdir offsets past removed entries, qid versions, nanosecond times, xattrs and POSIX ACLs; the native twin, `core/tests/p9.rs`, answers the same exchanges, `tests/p9/transcript.txt`), loopback adapter, input config, overlay, qcow2 fixtures (a request's compressed clusters inflated in one batch, and through the inflate pool's workers in Chromium; planted: a worker that drops its clusters' bytes; a damaged compressed cluster refused), the clusters' raw deflate through the core (`tests/deflate.test.ts`: Node's zlib with QEMU's 4 KiB window reads what it deflates, it reads zlib's with the junk after the stream; corrupt, truncated, short or overlong streams refused; planted: a short cluster taken; natively `core/src/codec.rs`, total on any input; planted: a corrupt stream or one past its bound taken), the FAT12 writer (its layout; `fsck.fat` and mtools read it back, where installed), the dev server (ranges, the page, the `node_modules` allow-list), the encoder |
| Snapshots: the core's state ([platform.md](platform.md) "Snapshots") | `cargo test` (unit: `vm/tests.rs`, `virtio/tests.rs`, `cpu.rs`); `core/tests/boot.rs`, `core/tests/distros.rs` (`Boot::snapshots`: the VM saved, dropped and restored into a new one on a copy of RAM at given steps) | unit: a machine with a timer, console output and a device (one chain answered, one held) saved at each of 300 consecutive steps and restored runs on to the unsaved machine's registers, steps, console and RAM, and saves the same bytes; WFI and idle; refusals (another version, each configuration word); every prefix refused and every byte changed in turn refused or run without a panic; the pinned bytes of a fixed machine (a layout change needs `snapshot::VERSION` bumped); the realtime clock continuing and the RTC showing the new host's time; a transport's in-flight chains posted again in order, and states that can't be. Natively, with the steps of `tests/steps.txt` and an unbroken run's console: Buildroot through 28 saves on 1 vCPU and 12 each on 2 and 4, the device test through 40 (net's 256 receive buffers held, 9p and the disk mid-conversation), console input with bytes waiting in the RX ring, Alpine through 8. Planted: a register not restored, a queue's used index not restored, an in-flight chain not posted again (each fails the unit tests and the boots). **Parallel mode** (the VM saved between runs of its vCPU threads, every thread out of the core, and a new one restored): unit (a CPU_ON request not yet taken, WFI, an off vCPU, and the same realtime state restored under the other run mode; a fired timer's line and a device interrupt raised by the save itself reach the restored vCPU); `core/tests/baremetal.rs` (every test through snapshots at growing intervals, round-robin and parallel), `core/tests/boot.rs` (Buildroot on 1, 2, 4 threads, ~27 saves a boot), `core/tests/litmus.rs` (litmus and the stress through 12 saves round-robin with exact steps, and in parallel), all under ThreadSanitizer too. Planted: the realtime counter not rebased, a restored vCPU's timer lines not taken from the GIC, the IRQ lines not published after a restore (each fails its unit test; a Buildroot boot notices none of them: Linux rides out a counter that steps back) |
| The host-visible window and its write-watch (VK1, [devices.md](devices.md) "The host-visible window") | `core/src/virtio/tests.rs` (SHM region 1), `core/src/vm/tests.rs` (`the_window_follows_ram_in_memory_0`), `tests/core-wasm.test.ts` (a window of part of 2 MiB refused); `tests/baremetal/watch.c` through `core/tests/baremetal.rs` `window_watch` (round-robin and parallel; interpreter and block interpreter) and `tests/window-watch.test.ts` (wasm: interpreter, block interpreter, JIT, its JIT steps checked) | each look reports exactly the pages a phase stored to (hot loops, a page-crossing store, LSE and exclusive atomics), a page written again after a look comes back, one only read doesn't. Planted: no mark when a record is dropped (phase 1 fails), records never dropping their entries (phase 3, natively and in wasm under all three) |
| USB: the xHCI and its devices ([usb.md](usb.md)) | `core/src/xhci/tests.rs` (the controller on hand-built rings); `tests/usb.test.ts`, `tests/usb-glue.test.ts` (Node: the virtual device base, Gadget Zero, the glue on the core's ring layout); `core/tests/common/usb.rs` (the native twin); the usb guest: `core/tests/usb_guest.rs`, `tests/boot-node-suite.ts`, `tests/browser.test.ts` (`images/build.sh linux-usb`), its options and checks in `tests/usb/` | unit: bring-up and the protocol capabilities; attach, reset (the first one the core's), suspend and resume, detach; enumeration with BSR and a short control read; bulk TDs across a Link TRB, immediate data, a short bulk IN; a stall through Reset Endpoint and Set TR Dequeue; Stop Endpoint with TDs in flight (a completion before it taken first, late ones dropped, the rest posted again); in realtime mode its completion held until the backend read the cancel; an unplug in flight; TRB errors; a full event ring; Deconfigure; HCRST; the completion latency; a halted TD's dequeue after a Link TRB; snapshots. **The usb guest** (`usb-hubs`, `usb` in `tests/steps.txt`): Linux with `xhci-plat-hcd` and `usbtest`, a static init and the kernel's `testusb`: the two empty root hubs; then `testusb -a` against a high-speed and a super-speed Gadget Zero (`pattern=1`): a clean pass, passes until connector 0 is unplugged at step 95M (mid-pass 2), a clean pass after it is plugged in again at 150M; natively, in Node (interpreter, JIT) and in Chromium (the device worker, interpreter and JIT) the same steps and console. Parallel SMP (2 vCPUs, no hot-plug: one clean pass, three runs), natively and in Node. Planted: the Short Packet event reported as Success (two unit tests and testusb's first pass fail); the realtime Stop Endpoint completing before the backend read its cancel (its unit test). **The built-in keyboard** (docs/usb.md "The keyboard"): `tests/usb-keyboard.test.ts` (Node: descriptors, reports, rollover, LEDs, idle, protocol, `usb-key` through the glue); `tests/page-usb-keyboard.test.ts` (Chromium, Debian, `ci-debian.sh --platform`: GRUB stopped and driven from the screen through EDK2's USB keyboard, a held Shift seen by `keystatus`, the keyboard gone from the guest once its virtio keyboard is live). **The game pad of ours** (docs/usb.md "The game pad", a wired Xbox 360 controller): `tests/usb-gamepad.test.ts` (Node: descriptors as `xpad` matches them; each standard button, the D-pad, the sticks and triggers read as `xpad` reads the report; the whole way to a web page in the guest, through joydev's order and Chromium's mapping for 045e:028e, back to the host's state; reports in order with 32 queued, the start request, cancel, reset; the OUT endpoint's rumble and LEDs; `usb-pad` and `usb-rumble` through the glue; the page's feed: names, a send per change, at rest while hidden or gone, and the rumble played, played again and stopped); `tests/page-usb-gamepad.test.ts` (Chromium, Debian, `ci-debian.sh --platform`, the Gamepad API faked: the menu's hint, then the pad listed and attached; `xpad` binds it with its keys, ABS_X–RZ, HAT0X/Y and FF_RUMBLE; a button, both sticks, a trigger and the D-pad reach `/dev/input` as those codes and back; a rumble effect played in the guest plays on the fake pad; the pad's disconnect unplugs it). Planted: two standard buttons swapped, Y without its complement (Node, each caught); the feed sending only its first state (the page test, caught) |
| Guest RAM past memory 0: spill memories as NUMA nodes ([spill-memories.md](spill-memories.md)) | `core/src/mem.rs`, `core/src/mmu/tests.rs`, `core/src/vm.rs` (`spill_memory_end_to_end`), `core/src/boot.rs` (`tests/dtb/waarm64-numa.dts`), `core/src/smbios.rs`; `tests/core-wasm.test.ts`, `tests/jit-diff-suite.ts` (Node); `tests/page-spill.test.ts` (Chromium, Debian, ci-debian) | unit: the host address and `Mem` across memories, a spill TLB entry missing every inline compare and served by the miss path, the DT's nodes and distance map against `dtc`, the SMBIOS credential and ranges, the page's split; natively and in Node (interpreter, block interpreter, JIT-stress) loads, stores, exclusives, LSE, DC ZVA and code in a spill memory. `tests/jit-diff-suite.ts`: the JIT's spill arm, the load and store classes with the MMU on and data in spill memories 1 (inline) and 2 (the helper), an interpreter VM against a JIT-check VM, and a warm load on memory 1 making no helper call (planted: the arm naming memory 0; LD1's lane load and STXP's W pair left on memory 0); `jit::emit::tests::loads_and_stores`: its bytes, and none without spill memory. the page: the split in shapes and definitions, its note (`tests/store.test.ts`), the advanced section of Settings checked, saved and kept (`tests/page-modal.test.ts`). **Debian with `?split=2560,1024,512`**: the Machine menu's note, three nodes, both CPUs on node 0, distance 20, `numa_balancing` 0 with the credential listed, a tmpfs bound to node 1 read back intact, and direct disk reads into and writes out of a process bound to node 1 and out of one bound to node 2 (systemd's `NUMAPolicy`) intact; then a snapshot saved and loaded in a fresh profile (a shell variable and node 1's tmpfs as they were). `tests/snapshot-plan.test.ts`: the spill memories' RAM round trips and restores only onto the same split; `tests/snapshot-file.test.ts`: pages past 2 GiB. Planted: the backends' views ignoring the segment's memory (the disk check fails) |
| USB through real devices ([usb.md](usb.md) "The usbhost guest") | `tests/usb-guest.test.ts` (Chromium, realtime, JIT; `scripts/ci-usb.sh`, the dev VM's dummy_hcd and uhid rigs, `images/build.sh linux-usbhost`); the backends alone in Node: `tests/usb-webusb.test.ts`, `tests/usb-webhid.test.ts`, `tests/usb-hid-descriptor.test.ts` | the guest's `testusb -a` against the dummy_hcd Gadget Zero through the WebUSB passthrough; the guest's `cdc_acm` on the ACM gadget, echoed, closed and opened again (the IN carry-over); a uhid device through WebHID: the rebuilt report descriptor, input, output and feature reports. In Node: the descriptor filter and speed heuristic on transcribed descriptors of real device types, the standard requests, halts, carry-over and code mapping against a fake USBDevice; the report-descriptor encoder against Chromium's recorded parses; the HID device's requests and reports against a fake HIDDevice. Planted: the carry-over's accounting, the protected-interface filter, the HID ID framing and a flag bit |
| A VM through snapshot files (the host: `web/vm.ts` `snapshot()`/`restore`, `web/snapshot.ts`, `web/lz.ts`) | `tests/snapshot.test.ts` (Node, JIT; Alpine's userspace benchmark with `WAARM64_DISTROS=alpine-user`); `tests/browser.test.ts` (Chromium: the device worker's backends) | the VM saved to a file, closed and a new one started from the file, several times in a run. Round-robin, with the steps of `tests/steps.txt` and an unbroken run's console: Buildroot through 9 files; on 4 vCPUs through 6 with the tier changing at each (interpreter, JIT, JIT-check); the snd guest through 6 while it plays and records; console input with 4 KiB in the RX ring and the rest queued in the host; input and net devices' held buffers; Alpine's userspace benchmark (1 GiB) through 3 (`alpine-user-snapshots`: a restore empties the TLBs, [platform.md](platform.md) "Snapshots"; `core/tests/distros.rs` `userspace_through_snapshots_is_the_run_with_tlb_flushes` shows natively that this is all the difference, on demand, ~2 min); a VM started from a file saves the same core bytes and backend state. Parallel (paused, saved, closed, new workers): Buildroot and litmus with the stress on 4 vCPUs in Node, Buildroot on 4 in Chromium. Refusals: another machine (vCPUs, RAM, devices, features), another state version, a truncated file, a cut state; a 9p device. **The disk in the file:** a boot that writes a file to its root filesystem is saved after the write; from the file, over the overlay as later writes left it and over none at all (a fresh profile), the machine finishes in the unbroken boot's steps and the next boot finds the file (Node, in-memory overlays; Chromium, OPFS, through four files in one boot); another disk, a file cut or damaged in its disk blocks, and a machine without the disk are refused with the overlay untouched; the base's hash is asked for only when the cheap identity differs; a restore's runs (a made file of data and zero runs across a leaf's boundary to a short last block: every block, zeros without slots, read back by a new opening; a frame past the disk's end refused), with `diskRuns` (`tests/snapshot-file.test.ts`) and the overlay's `blocks()` (`tests/overlay.test.ts`) below it (planted: a run's map entries not written, runs not split where data turns to zeros, `blocks()` reading across a slot gap, no past-the-end check; each fails them). Planted: the rng's position not restored, pending serial input not restored, the config spaces overwritten after a restore, the overlay's blocks left out of the file |
| Snapshot file | `tests/snapshot-file.test.ts` | the snapshot container (`web/snapshot-file.ts`, [platform.md](platform.md) "The snapshot file"): CRC-32 against zlib's, round trips of every frame kind (RAM from a shared-memory view at an odd offset), 1-byte, random and Blob input, writer back-pressure and order, every refusal with its `problem`, truncation at every prefix and a flipped bit at every byte of a small file, the stored and a pluggable codec. Node only, ~3 s; buffers are compared with `sameBytes`, never `assert.deepEqual` (a diff of two RAM-sized arrays exhausts memory) |
| Decoder sweep | `core/fuzz` (not in CI) | every 2³² word vs Capstone |
| virtqueue fuzzing | `cargo fuzz run virtqueue` (not in CI) | the transport and split-queue parser |
| virgl stream fuzzing ("virgl fuzzing" below) | `tests/virgl-fuzz.ts` (300 cases in `tests/virgl.test.ts`; longer runs by hand, not in CI) | the renderer's decoding of SUBMIT_3D streams, staging data and 3D resource commands, through the device, on the recording WebGL2 |

Rules behind that matrix:
- **Interpreter runs of long guests happen natively** (Rust release builds are fast and need no
  engine): Buildroot, the device test, LTP and Alpine; natively a JIT mode runs everything in the
  block interpreter, so Buildroot and Alpine boot through it there too. Node runs the **JIT** on every guest and
  the interpreter only on the short ones (where the JIT run must print exactly the interpreter's
  console). Chromium tests what only a browser has, plus JIT boots of the distros. **Don't boot
  complex guests under the interpreter in Node or Chromium**: it costs minutes and tests nothing
  the native run doesn't.
- `WAARM64_DISTROS` (comma list: `alpine,alpine-user,debian,alpine-uefi`) picks the distro tests; `ci.sh`
  defaults to the current images of all. **Debian boots only in Chromium, through UEFI under the JIT**
  (~45 s alone: the page tests); it has no direct-kernel, native or Node boot (dropped when UEFI
  became the production path: the direct boot's tests and its `boot_debian_jit`/`smp_debian_jit`
  benchmarks timed only a boot, which the page tests' logs show). **Make each Debian boot count:**
  a boot is the expensive thing, so a Debian test checks what it can on the boot it has.
- **Debian boots in `ci-debian.sh`, `ci-graphics.sh` and `--platform`** (the Debian tests take turns through `tests/debian-lock.ts`,
  two at a time there and one in `ci.sh` and `ci-net.sh`, so each boot adds to the wall time; **put
  a new Debian check on a boot that exists** unless it
  needs what that boot can't give: another profile, URL, disk or window): `page-debian` 3 (1: a
  Buildroot snapshot refused, `c` on the screen stops GRUB, login on both consoles, the platform,
  the page's size, a snapshot saved; 2: a reload, the file kept; 3: the snapshot in a fresh profile
  at another window size, Suspend and resume, a reload that boots its disk), `page-disk` 3 (1: the
  chosen file, through the serial keys' flow in EDK2 and GRUB with `?display=simple` (two firmware
  starts first; Debian's GRUB passes `quiet`, so the kernel's own echo of its command line can't be
  waited for), its overlay, fstrim, the changes saved; 2: the same file chosen again; 3: a fresh
  profile with the changes file), `start.test.ts` 1 partial (until the firmware writes to the
  console; only the page holds the lock, not the install before it). Until 2026-10-08 they were nine
  boots and five partial starts in eight files: 581 s, then 416 s merged and 229 s with two slots
  (`page-debian` alone 221 s, beside another boot 232). The rest is not repeated on Debian: Reset
  disk, a file kept over a restart and the overlay hand-over are Buildroot's
  (`tests/browser.test.ts`), the deterministic and one-vCPU JIT are Buildroot's and Alpine's. The
  network tests' Debian boots are `ci-net.sh`'s; `page-machine`'s and `page-venus`'s are `ci-graphics.sh`'s, `page-usb-keyboard`'s, `page-usb-gamepad`'s and `page-clock`'s `ci-debian.sh --platform`'s. **CI's wall time:** Node runs test files in parallel and a file's tests in
  sequence, so the long files set it. The Node boots are one suite (`tests/boot-node-suite.ts`)
  in four files that pick their tests by name (`tests/boot-node*.test.ts`: ~280 s in one file
  before). `ci.sh` runs the native guest-image tests (~130 s) beside `npm test`, not after it.
- Guest-image tests skip loudly when `target/images/<name>` is missing or stale
  (`images/build.sh --check`).

**The page's questions in tests:** the page asks with its own dialogs (`<dialog id="ask">`, docs/frontend.md "Dialogs
and the message bar"), not the browser's, so `page.on('dialog')` hears nothing: a test calls
`answerAsks(page, (q) => …)` (`tests/page-ask.ts`) before `goto`, which clicks OK on each question (Cancel when the
callback returns false; a prompt gets the string it returns) and hands the test each question's kind and text.

## Step counts

**Every deterministic guest takes the same number of steps (instructions retired plus exceptions
taken) natively, in Node and in Chromium, under the interpreter and the JIT**, on N vCPUs too
(deterministic round-robin: `buildroot-2cpu`, `buildroot-4cpu`). The guest images'
counts are in `tests/steps.txt`, read by every runner (`core/tests/common` `steps()`,
`tests/steps.ts`). A mismatch is a bug unless the change is guest-visible; then the counts move
**once**, in the same commit, with the reason in its message. Guest-visible changes so far: ERET
ending the chunk (M6), the crypto extensions advertised (M6.5), the GICv3 as the default GIC and
its driver in the test kernels (M7).

Realtime runs and the rw-overlay boots aren't step-exact.

## The golden corpus (`tests/corpus/`)

- **Oracles:** QEMU user mode (`qemu-aarch64`, installed in the dev VM) for day-to-day growth, and
  **real hardware, authoritative:** the Lima VM `oracle` on the M4 Mac mini (Debian 13 arm64, 4
  vCPUs, 8 GiB, 60 GiB, 4K pages; created with `limactl create --name=oracle --vm-type=vz --cpus=4
  --memory=8 --disk=60 --plain template:debian-13`), reached with `ssh macmini.lan
  /opt/homebrew/bin/limactl shell oracle <cmd>`. EL0 code runs natively there. The corpus is
  re-validated on it whenever it grows or QEMU and we disagree. The oracles are only needed when
  the corpus grows; CI compares against the committed files.
- **Format (`waarm64-corpus 1`):** `tests/corpus/<group>.txt`, line-oriented. Each test has `code`, a
  `seed` (splitmix64 expands to X0–X30, SP, NZCV, the 8 KiB data region, then V0–V31 as low/high
  u64 pairs; FPCR and FPSR start at 0), `in` overrides, then the oracle's `out` (changed registers,
  `v0=0x<32 hex>`, `fpcr=`, `fpsr=`), `mem` (changed bytes) and `exit` (`end`, or
  `sigill`/`sigbus`/`sigsegv`/`sigtrap` with PC offset, `si_code` and fault address). `note qemu: …`
  records a QEMU result that differs from the M4's. New keys are additive; anything else bumps the
  version. Fixed VAs: code at `0x100000` followed by `brk #0`, data at `0x200000`, harness at
  `0x400000`.
- **Tooling:** `tests/harness/harness.c` (static, freestanding; state loaded by an asm trampoline
  including FPCR/FPSR/V0–V31, dumped from the signal `ucontext` and its `fpsimd_context` on an
  alternate stack), `tools/corpus/gen.ts` (deterministic generator), `tools/corpus/run.ts` (runs
  the oracles and writes the golden files: `node tools/corpus/run.ts [--oracle qemu|m4|both]
  [group…]`), `core/tests/corpus.rs` (the comparator). `WAARM64_CORPUS=<groups>` filters the wasm run.
- **Groups:** branch, dp_imm, dp_reg, ldst, excl, lse, sys, fp_scalar, ldst_fp, simd_same,
  simd_diff, simd_fp, simd_misc, simd_move, simd_perm, simd_shift, crypto, jscvt (FJCVTZS), ext (LDAPR, SB,
  FlagM and FlagM2, DIT, FRINTTS), dotprod (SDOT, UDOT, reserved sizes included), i8mm (USDOT, SUDOT, SMMLA,
  UMMLA, USMMLA, unallocated sizes and MMLA's Q = 0 included; not the by-element sizes 1 and 3, BF16's on the M4),
  rdm (SQRDMLAH, SQRDMLSH, vector, scalar and by element, reserved sizes included), lrcpc2 (LDAPUR*, STLUR*,
  aligned, unallocated sizes included, and misaligned across 16 bytes: an alignment fault on all three), fcma (FCMLA
  vector and by element, FCADD, on FP edge values with FPCR varied; the reserved sizes, doubles without Q and the
  by-element L = 1 and Q = 0 included; the half forms are in fp16), fp16 (every FEAT_FP16 form, scalar and AdvSIMD, on
  half edge values with FPCR varied, FZ16 included: arithmetic, FMA, compares, conditional compare and select,
  conversions to and from integers and fixed point (immh 001x), FMOVs, estimates, pairwise and across lanes, by element,
  FCMLA and FCADD's half forms, and unallocated combinations beside them; 12,820), fhm (FMLAL, FMLSL and the 2 forms,
  vector and by element, sz = 1 sometimes; 2,300), bf16 (BFCVT, BFCVTN/BFCVTN2, BFDOT and BFMLALB/T vector and by
  element, BFMMLA with Q = 0 sometimes (UNDEFINED); bfloat16 lanes half the tests edge values in every lane, half plain
  values around 1 so that sums round to odd, FPCR varied; 6,600, QEMU and the M4 agree). QEMU 11 disagrees with the M4
  on 60 fp16 vector three-same tests and on 8 fhm ones (it runs FMLAL by element with sz = 1, which the M4 and we make
  UNDEFINED); we match the M4.
- The generator avoids CONSTRAINED UNPREDICTABLE and IMPLEMENTATION DEFINED cases (e.g. `LDP`
  with `Rt == Rt2`, writeback with `Rn == Rt`), where the oracles legitimately disagree.
- **Known oracle behavior** (the generator avoids it):
  - Both oracles implement **FEAT_LSE2**: misaligned exclusives, LDAR/STLR and LSE atomics only
    fault across a 16-byte granule. We keep the v8.0 rule (wasm atomics need natural alignment
    anyway).
  - QEMU's `max` CPU has MTE (`ADDG`/`SUBG`, `STGP` execute); the M4 raises SIGILL, as we do.
    QEMU's `DC ZVA` block is 512 bytes; the M4's and ours 64.
  - **Apple's hypervisor filters ID registers** but the M4 guest still runs v8.x/v9 features we
    leave out: PAC (`paca pacg`: `PACIASP` really signs, where we NOP), BTI, `sb flagm2 frint i8mm
    bf16 afp dit`, `lrcpc ilrcpc dcpop dcpodp flagm uscat asimddp asimdrdm fphp
    jscvt fcma`, FP16 (incl. FP16 FMOV and fixed-point conversions with immh = 001x), BF16 (BFCVT
    is the FCVT encoding with ftype 01, opc 10), FHM, RDM, DotProd, I8MM, FCMA, JSCVT, FRINTTS. The
    generator emits none of them but what's ours since ABI 59 to 66 (groups `jscvt`, `ext`, `dotprod`, `i8mm`, `rdm`,
    `lrcpc2`, `fcma`, `fp16`, `fhm`, `bf16`): JSCVT, LRCPC, SB, FlagM, FlagM2, DIT, FRINTTS, DotProd, I8MM, RDM, LRCPC2,
    FCMA, FP16, FHM, BF16. The M4 has no FEAT_EBF16 (FPCR.EBF is RES0 there, as here).
  - **QEMU before 9.0.2 sets FJCVTZS's Z for a denormal flushed under FZ** (Ubuntu 24.04's 8.2 does, so a cloud
    session's run of `jscvt` can disagree); the pseudocode clears it, as the M4 and QEMU 11 do.
  - Corpus depth: some FP flag paths are thin (only 8 `fp_scalar` tests raise Divide-by-Zero).

## System-level oracles

- `qemu-system-aarch64 -M virt,gic-version=2` (TCG) for behavioral comparison, and Homebrew QEMU
  (11.1) on the Mac with `-accel hvf` for real Apple hardware at EL1 (MMU, exceptions; devices are
  QEMU's). The Sail ARM model for disputed corner cases.
- **Findings:** QEMU TCG raises no SP alignment faults (hvf does, as do we); QEMU under hvf makes
  unassigned PAs RAZ/WI (TCG aborts, as do we); QEMU 11.1's TCG fails `xblock` (code reached through a pointer into
  a 2 MiB block, the block remapped and flushed by VA at its start: TCG runs the old code; hvf passes, as do we since
  PERF loop 29); QEMU 11.1's TCG fails `isb` (exit 10: CPU 1 runs the old code after CPU 0's DC CVAU, DSB, IC IVAU,
DSB and a store-release CPU 1's ISB follows: 5-8 stale calls of 8 in each of 30 runs, 2026-11-16, with the MMU off;
hvf passes 30 of 30, as do we); under hvf a hole is RAZ/WI and an MMIO access with a writeback or a misaligned one
has no syndrome for QEMU, which asserts (`mmio` leaves those out of its `-DHVF` build); HVF can't emulate a GICv2 (moot since we dropped
  ours). **hvf does give a GICv3** (`-M
  virt,gic-version=3`): kvm-unit-tests' `gicv3-ipi`, `gicv3-active`, `selftest-smp`, `psci` and
  `timer` pass there at 4 CPUs. **It's Apple's in-kernel vGIC** (the default, and with
  `kernel-irqchip=on`): its `GICR_TYPER` reads 0 through 32-bit halves, QEMU's own model
  (`kernel-irqchip=off`) doesn't, so the interrupt controller has a hardware oracle.

- **The UEFI oracle** (`tools/uefi-oracle.ts`, M8 phase B; [firmware.md](firmware.md)): our
  EDK2 build (`images/build.sh edk2`) on `qemu-system-aarch64` set up like our machine
  (ArmVirtQemuKernel via `-kernel` with QEMU's DT minus PCIe, the platform bus, the PMU, the PL061
  and its `gpio-keys`, the ITS and the seeds; the variable store in flash bank 1; virtio-mmio disks;
  Cortex-A57), booting `debian`, `alpine` (Limine) and `alpine-grub` unmodified to a root login
  and a power-off, with each stage's time. Dev-only (needs `qemu-system-aarch64`, `dtc`,
  `mkfs.vfat`, `mcopy`), not in CI. `node tools/uefi-oracle.ts debian alpine alpine-grub`: ~30 s
  for all three at once under TCG. **Finding:** QEMU's `kaslr-seed` in `/chosen` made Debian's
  boot 1.8× slower under TCG (KASLR forces KPTI on a CPU without E0PD, as the A57 is: docs/cpu.md,
  "FEAT_RNG and FEAT_E0PD"), which first looked like DT vs ACPI; without it they're equal.

## Bare-metal tests (`tests/baremetal/`)

`start.S` (stack, vectors calling `on_exception(frame, vector)`, FP on, `run_el0()` to drop to EL0
and come back through SVC #1) plus one C file per test (all on a GICv3, `lib.h` `gic_init()`; `// smp: N` boots N
vCPUs, on the oracles too; `// qemu-cpu: <model>` replaces TCG's Cortex-A57, e.g. `max` for LSE; `// flash` runs it in the firmware configuration, for its flash bank (the oracles attach an erased bank 1); `// input: <text>` is typed on
the serial console once the test waits: at its first idle in round-robin, once it printed `ready` in parallel, after a
second on the oracles; `// round-robin` checks what holds in round-robin only, an IRQ's latency after an unmask: not
run in parallel SMP, and run in realtime round-robin under the JIT too, `unmask.c`), built with host clang and lld by
`build.sh` into committed flat `.bin`s loaded at `0x4000_0000`. Pass = PSCI SYSTEM_OFF with
x1 = 0; `power_off` also prints `exit <code>`. `oracle.sh` runs the `-DORACLE` builds
(implementation-specific checks left out) on QEMU TCG, `oracle.sh --hvf` the `-DORACLE -DHVF`
builds on the Mac (`gic-version=3`: Apple's in-kernel vGIC); every test runs on both but `watch` (a `// window`
test, whose phases the host drives), and passes on both but three: on TCG `xblock` and `isb` (QEMU's, "System-level
oracles"), on hvf `debug` (QEMU's model of the debug registers there: [#282](https://github.com/gbl08ma/waarm64/issues/282)). Where TCG and the M4 disagree
the M4 wins. Left out
of the HVF build: two `gicv3` checks that are ours and QEMU's but not Apple's
(`ID_AA64PFR0_EL1.GIC`, `GICR_ICFGR0`: [platform.md](platform.md) "The GIC"), and `smp`'s second
CPU_ON (QEMU's PSCI races it against the target's start: another answer ~1 in 5 under hvf; TCG failed
its check 4 once in 6 runs on a loaded VM, M8 loop 1). Tests mustn't rely on
UNKNOWN or IMPLEMENTATION DEFINED reset values and must pick addresses unmapped on `virt` too (its
flash covers `0x0`–`0x0800_0000`). **Rebuild all of them together** when one changes (different clangs build different bytes;
they were last rebuilt together on the M4 VM in M8 loop 8, when only `timer.bin` changed and the others came out identical).

**The core's heap (`tests/heap.test.ts`, `core/tests/alloc_hook.rs`):** a guest of millions of `b .+4` (every word a
block run once) in a test-only small heap reserve (`BootOptions.heapReserve`): 8M blocks in 320 MiB through the
block map's prunes, and 4M in 64 MiB through the safety net's rescues ([jit.md](jit.md) "The core's heap"; the core
before the bound trapped in both). The allocation error hook's message is checked natively, in a child process that
aborts.

**Host stalls (`tests/hoststall/`, `tests/hoststall.test.ts`):** `stall.c` builds four 2-vCPU
guests (`build.sh`: `stall-run|install|idle|waiter.bin`, committed) that cooperate with a test-only
hook in a vCPU worker (`BootOptions.stall`, web/core.ts `Stall`) through a word in RAM: vCPU 1 arms it,
the hook blocks that worker (`Atomics.wait`), vCPU 0 then runs TLBI IS + DSB. Real workers in Node,
parallel, JIT, the real 10 s DSB limit (no ABI for lowering it). Stalled in the core's clock import
(between chunks) or in `jit_install` (mid-chunk), the vCPU is RUN: the wait ends at 10 s with the
panic report as the error (state 1, applied, retired and PC frozen, the waiter's timing line). Stalled
after `vm_run_cpu` returned IDLE (OUT), the DSB doesn't wait. With the *waiting* vCPU's worker
stalled 11 s inside its wait while vCPU 1 is healthy (frozen 13 s), the wait doesn't panic: it counts
waiting, not its own stalls (`DsbBudget`, unit-tested in `core/src/vm/tests.rs`). ~40 s in all.
These guests aren't in `tests/baremetal/`, so the generic bare-metal runners and the oracles skip them.

**Realtime windows:** in parallel mode the counter follows the host's clock, so a test can't
assume the host keeps its vCPU running for any stretch. `timer.c` retries its "not expired yet"
check (a 1 ms `CNTV_TVAL`, up to 100 times: a host that deschedules the vCPU between the write
and the read made it fail, twice in one M8 loop 6 CI run under two Debian page boots) and bounds
the CVAL written through TVAL by the counter read before and after (it was a fixed 10 ms
window). Under the load that broke it (both Debian page tests at once beside the rest of
`npm test`, `tests/debian-lock.ts` bypassed) the old and new binaries alternated in a loop:
see bench/boot/REPORT.md "M8 loop 8". Bare-metal tests have no entry in `tests/steps.txt` (the
deterministic runners compare the JIT's steps with the interpreter's), so nothing moved there.

**Spin tests (`spin.c`, `tests/spin.test.ts`; PERF loop 31):** parallel SMP's compiled code has no step budget and
polls the vCPU's stop word where a cycle can close ([jit.md](jit.md) "Preemption"), so a vCPU that loops with no exit
must still answer what happens around it. CPU 1 spins in twelve shapes copied to a code area (one block; 20 blocks, more
than a region holds, entered mid-way; a BR to itself; two BRs 64 KiB apart that share a transfer cache slot, so every
transfer goes through the miss function; a branch back to the page before; since PERF loop 33, forward through 16 VA
copies of four pages of code, each copy's entry in its own transfer cache slot, so by-VA links hit (MMU on only);
16 calls to a function making 16 calls to a 16-step one, each callee after its caller, so host calls; and the one-block
loop with a breakpoint armed, which the debug interpreter runs; since PERF loop 34, `pure`, a loop of a register add
with no memory access, where V8 may keep a plain load out of the wasm loop: the handler of the IRQ that comes once
`done` is set moves ELR past it, and CPU 0 pings it every 50 µs until it's out); since PERF loop 35, `xpage` (three
variants, each its own page): one page of code at 32 successive VAs, a forward region whose head at 0x800 reaches a
member at 0x100 of the next VA page (a lower PA, found by the VA it was queued at), which chains forward in VA back to
the head's key, so every lap goes up a page through the same compiled blocks (MMU on only)), each at EL1 with the MMU off and on and
at EL0 (text pages read-only at both ELs, the rest read-write at both: an EL0-writable page is privileged
execute-never). CPU 0 times 8 IPI round trips (SGI 1 there, SGI 2 back) and 8 TLBI VMALLE1IS + DSB ISH a shape, then
in a quiet second pass CPU 1 its own timer's lateness (with long chunks CPU 0 pings it after 50 ms: nothing but the
chunk's steps ends a chunk for a timer); last, CPU 1 spins while the host pauses the machine 8 times (the host's words
at 0x40a0_0000; with no host the guest moves on after 10 ms of the counter). The guest checks only completion (it
runs on the oracles and the deterministic runners too); `tests/spin.test.ts` runs it in parallel under the JIT, and
JIT-stress and JIT-check (`scripts/ci-jit.sh`), each with the default chunk and with 2^30-step chunks (`vm_set_chunk`), where only a
setter ends a chunk early: the medians over the 32 shape runs (12 shapes at 3 ELs and MMU settings, the aliases MMU-on only) must be under 1 ms (the worst under 50 ms; typical: a few
to ~100 µs), the timer's under the JIT with the default chunk, the pauses' median under 5 ms (typical ~0.1 ms). A run
that misses a bound runs once more: a loaded host (`scripts/ci.sh`'s files side by side) once put every shape's round
trip near 2 ms, while a missing poll misses in every run.
The copies' blocks and f1's run 16 times a lap, so CPU 0 waits 200 and 400 laps (compiled by then; the loop calling
f1 may stay interpreted, which also stops at the lap's end), and CPU 1 records where it took each ping (ELR): with a
poll only at the lap's check (a forward by-VA link or a host call's return that didn't poll), all 8 land there; the
test wants at least half inside the shape (PERF loop 33: 0-1 of 8 before, 6-8 after), in `xpage` too (PERF loop 35:
0-1 of 8 in each variant before the region's edges to a lower key polled, 7-8 after). Whether `xpage`'s region takes
its member depends on when each block reaches the compile threshold, which varies: alone (`SPIN_ONLY`) about one run
in three formed it on PERF loop 34's core, after the other shapes every variant did in every run seen (3 runs); hence
three variants. With short laps (copies of a
few dozen steps a page) the pings landed at the lap's end more than its share of steps says, often all 8 at EL1,
even with the polls: what each lap's end costs outweighed the copies; a page of UDIVs each keeps them apart. The
warm-ups take spin.c to ~84M steps, so the native runner's and `boot-node`'s bound for the bare-metal tests is 150M. The block interpreter alone (`VmConfig.jit` 4) runs the shapes too, in
`scripts/ci-jit.sh`. `WAARM64_SPIN_PRINT=1` prints the numbers. Planted (PERF loop 31), each caught: a poll left out of a region's
back-edge, a direct chain backward, the transfer cache's probe, the miss function or the MMU-off jump cache's probe
hangs its shape under every mode (the run fails at its bound); one left out of a static chain through the jump cache
only under JIT-stress (JIT and JIT-check put that link in a region or a direct chain), of a by-VA link backward only
under JIT-check (hence the by-VA shape's entry from a third page: the backward branch's block compiles first)
(PERF loop 34: polls only on a region's back-edge, not on its other edges to a lower VA, fails the 2^30-step runs
under the JIT: the 20-block chain's cycle leaves its region and comes back through chains forward, its one backward
step an edge to a member that isn't the head; the polls on looped regions' edges as plain loads fail nothing, since
today's V8 reads the word again every few laps, PERF loop 34) (PERF loop 35: a region's edge to a lower key in
another page left unpolled puts 0-1 of 8 pings inside `xpage` under the JIT); a
setter left out (`Vm::wake`, the TLBI IS push, the host's `raise`), or the dispatcher's own check, fails the
2^30-step runs' bounds (the device backends' `kick`: tests/devices.test.ts "changeConfig") (milliseconds instead of microseconds); the run loop's chunk bound left out fails the timer's
bound under the JIT.

**A turn for the contender (`tlbi_spin.c`):** CPU 0 holds the lock through each TLBI IS + DSB,
asleep in the DSB wait until CPUs 1–3 end their chunks, then frees it for ~50 loop iterations
before taking it again, so CPU 2's LDAXR/STXR loop wins a round only when the host has its
thread on a core in that window of ~1 µs. In one `scripts/ci.sh` run (2026-10-19) it won none of
the 100 and exited 42. An instrumented copy of the guest (CPU 2's attempts, those that found the
lock taken, failed STXRs, rounds won, gaps in its loop) showed why: on an otherwise idle VM it won
99–100 rounds, but with 4 VMs at once pinned to 3 cores (`taskset -c 0-2`) it won 0–2 in 9 runs of
60, and on one core none. The window before round 0 saved it then, but it misses that too in
about 1 run in 8 even when idle: the first compile of its loop stalls it ~150 µs right after its
`ack`. No STXR ever failed with the lock free (each failure was CPU 0 taking the lock between
CPU 2's LDAXR and STXR), and the monitor is cleared only by exclusive stores, CLREX, exceptions and
ERET, never by a drain or TLBI. So the emulator was right: the architecture promises CPU 2 no
turn, and a host may deschedule a vCPU. With CPU 2 held back until round 0 had begun (a planted
delay standing in for that stall), the old binary failed 23 of 300 runs on 3 cores and 9 of 12 on
one. Now CPU 0 notes CPU 2's wins (`won`, written under the lock) in round 0 and, after the last
round, waits until CPU 2 has won once more (exit 50 if it never does): the same variant passed 200
of 200 runs on 3 cores and 30 of 30 on one, and an idle run takes as long as before (~110 ms).
To stress it by hand, crowd its parallel runs onto a few cores:
`WAARM64_PARALLEL_RUNS=30 taskset -c 0-1 node --test --test-name-pattern='tlbi_spin' tests/boot-node-parallel.test.ts`.

## Bare-metal device tests (`tests/baremetal/virtio/`)

Requests no Linux driver sends, through the whole path. `virtio/virtio.h` is a virtio driver of the tests' own
(virtio-mmio v2, split queues of 128, polled, the MMU off so every access is aligned) with which `blk.c`, `9p.c` and
`net.c` post hand-built chains to the TS backends. `tests/virtio-guest.test.ts` boots each in Node under the
interpreter, the JIT (the interpreter's steps and console) and in parallel mode (the backends served from the
doorbell; the same console), ~0.8 s for the nine runs, and compares its transcript with a table that says why each
answer is the one. Linux's drivers stay the tests of the well-formed path (the Buildroot device test, the Debian page
tests): a driver of ours would share the backends' assumptions there. What this covers is a buggy or hostile driver,
and the rule: an error, a dropped request or frame, never a host exception, a failed device or a changed disk.

- **blk** (a 1 MiB ramdisk, a 64 KiB read-only image, one under an overlay with `discard`): headers short, long,
  split or absent; no status byte or an empty one; the status byte at the end of the data's buffer; data in the wrong
  direction or in the header's buffer; reads and writes across the end, at it, at byte offsets past 2^53 and 2^64;
  unknown types; DISCARD and WRITE_ZEROES segments short, doubled, absent, past the end or the limits, with unmap or
  unknown flags; changes to the read-only disk; a chain the transport refuses (DEVICE_NEEDS_RESET), then a reset.
- **9p** (the in-memory tree with /hello.txt): a session, then a `size` past the readable bytes or under 7, too little
  room, bytes past the size, 1-byte buffers, a count past the room, a reply past it (no answer: a used length of 0);
  truncated fields, a string past the end, unknown types and fids, a write's count past its data, offsets past 2^40
  and 2^63, a Tversion ending every fid.
- **net** (the loopback adapter, which answers ARP and pings): after each case a probe ping, and the frames up to its
  reply are the case's (so a frame let through shows, and the device is shown alive, in parallel runs too). The
  checksum the guest leaves to the device (NEEDS_CSUM, its place in the echoed payload); a checksum's place or start
  past the frame, headers alone or cut short, nothing readable, 1519-byte frames, GSO on a ping, an unknown GSO type,
  MSS 0, a GSO packet past the largest (all dropped); MSS 1 over 60,000 bytes; the header and frame split into 1-byte
  buffers; receiving over 32-byte mergeable buffers, with a readable buffer first, and without MRG_RXBUF into a buffer
  no frame fits (it holds the queue until a reset, each frame dropped, as a NIC drops).

The backends are more lenient than QEMU in places (an 8-byte blk header is UNSUPP where QEMU fails the device; a read
or write that isn't whole sectors is done as asked where QEMU answers IOERR), which is fine while nothing on our side
can go wrong from it: the disks take byte ranges, and the test checks such a write's bytes. Planted: the ramdisk's end
check dropped, blk's status byte written at its buffer's start, a blk backend that throws, 9p's `size` check against
the readable bytes dropped, net's checksum place unchecked (each fails it; the throw within a second, with its
message). `build.sh` builds `virtio/*.c` without oracle variants, and the top-level runners (core/tests/baremetal.rs,
tests/boot-node-suite.ts) don't see them: they need their devices, and natively the devices are Rust twins
(`core/tests/common/`), not these backends. Built with clang 23 (2026-11-09), where the top-level tests came out
identical but for `isb.bin` (left as it was).

## kvm-unit-tests

Commit `5a221342a025`, booted with one CPU and 256 MiB; `EXIT: STATUS=` from the UART. Every
`unittests.cfg` entry is run or skipped with a reason, and the runner fails if a new one appears.
Pass: `selftest-setup`, `selftest-smp`, `selftest-vectors-kernel`, `selftest-vectors-user`,
`psci` (with the concurrent cpu-on check enabled), `gicv3-ipi` and `gicv3-active` (4 vCPUs),
`timer`, `cache`, `debug-bp`, `debug-wp`, `debug-sstep` and their `-migration` variants (the key
`migrate_once()` waits for queued from the start, the VM saved and restored at 15 points over the
run and 21 more packed toward its end, where the tests arm; in Node the three without migration,
under the JIT and JIT-stress too). Skipped: `gicv2-*` (no GICv2), `its-*`, `pmu-*`, `pci-test`,
`micro-bench`, `fpu-context` (KVM only), `mte-*`; `sieve` (not in `unittests.cfg`; too slow
interpreted).
`timer` runs 106,198,491 steps: in Node (deterministic, the M4 dev VM) 2.08 s interpreted and 0.13 s under the JIT
(bench/boot/REPORT.md "PERF loop 61"; the JIT was slower here at M5 step 5, 3.3 s against 2.6).

**The SMP set on QEMU TCG** (11.1, `-M virt,gic-version=3 -cpu max -smp S`), the oracle for M7:
`selftest-setup` (smp 2), `selftest-smp` (4 and 8), `gicv3-ipi` (4, 8), `gicv3-active` and `psci`
(4) pass. `psci` skips its concurrent cpu-on check unless the environment (passed as
an initrd, `ERRATA_6c7a5dce22b3=y`) enables it; enabled, QEMU fails it (several CPUs racing to
start one target must get ALREADY_ON or ON_PENDING).

## The JIT's tests

- **Differential** (`tests/jit-diff-suite.ts`, run as four files, `tests/jit-diff-[1-4].test.ts`, each every fourth test in
  their order: in one file its ~650 s were the tail of `scripts/ci.sh`'s JS tests): `WAARM64_JIT_DIFF=<n>` words per class. Classes seed
  FP with NaNs, denormals, infinities, zeros and FPCR/FPSR states, and crypto with the FIPS
  vectors' states a third of the time. Flat bus only (the MMU path is lockstep's and the boots').
  Each test seeds the generator from its name: a new class moves no other test's words, and a test run alone
  (`--test-name-pattern`) draws what it drew in the whole run.
  It caught all three rustc/LLVM `simd128` miscompiles. The V registers live in locals: only
  sequences (and regions) see a dirty one not written back before a helper or one not dropped
  after it, so "NEON, FP and V helpers" mixes inline NEON, FP and V loads and stores with
  helper-only words on the same V registers (FRECPS on doubles, URECPE, FSQRT, scalar and vector
  FRINTA, USQADD on a D register), from whole registers of FP lanes. The integer NEON classes
  get registers of integer lanes of one size with edge values (the saturating, rounding and
  doubling limits) a third of the time. `WAARM64_JIT_DIFF_HELPERS=1` prints each class's helper
  calls by instruction, from allocated words only (unallocated ones go to the helper too and hide
  the rest): what's still missing from the JIT. On the flat bus a load's slow path never
  returns normally (outside RAM is an abort), so a load that keeps its V destination's stale
  local after the helper shows only under the MMU: the Alpine userspace boot caught it, lockstep
  and Buildroot didn't.
- **Polled code against the interpreter** (PERF loop 33; `scripts/ci-jit.sh`): parallel SMP's polled code (no
  step budget, polls of the stop word: [jit.md](jit.md) "Preemption") runs only in parallel VMs, which the
  differential test, lockstep and the corpus can't compare step for step. The **polled test core** (Cargo feature
  `polled`, built into `target/polled/`; no export changes) compiles every user-mode JIT vCPU's code polled, and its
  `jit_run` stores the steps left in the stop word, as a run loop stores its chunk's, and returns the steps the code
  ran, which may be more (to the first poll past them). `WAARM64_CORE=<its path> WAARM64_POLLED=1` runs
  `tests/jit-diff-suite.ts`, the user-mode lockstep and `tests/corpus-wasm.test.ts` on it: the JIT side first, then the
  interpreter for the steps the JIT ran (one more when it exited, where the interpreter stops too); a run that stopped
  short of the steps asked for without an exit fails. A wrong `acc` shows as the interpreter stopping elsewhere; a
  wrong condition around a poll as a transfer taken wrongly. A poll that never passes or always passes doesn't (the
  dispatcher goes on, or the code runs to its exit): the spin tests catch those. A run whose interpreter stored into
  code is skipped (it runs on into other words and the data area's random ones, then stale blocks), one where only the
  JIT's side did fails (`a store into the code area`); either way the code is restored, the blocks dropped and the
  JIT's RAM made the interpreter's again (PERF loop 35, the final review: before, every run that stored into code
  passed, and its RAM differences surfaced in a later run; planted, a polled store's extra byte into the code area:
  3 of 3 memory classes failed, where the old harness passed them). Planted (PERF loop 33),
  each caught on the polled core: a region edge's `acc` bump one too many (18 tests), a host call's return stopping
  without its block's length, a jump-cache chain's poll ORed in instead of ANDed (42 tests); the bump left out leaves
  a one-block loop that never stops: the run hangs at its bound. The MMU-on paths (the transfer cache, by-VA links,
  the miss function) aren't here: the jit_new vCPUs' tests run flat.
- **Lockstep:** `WAARM64_LOCKSTEP_STEPS=300000000` for the long run, done at the end of every loop
  that touches semantics (stress runs a tenth).
- **JIT-stress** (threshold 0, batch 1, a 4-region cache, tier-up after one entry, the stale-code
  checker) runs in `scripts/ci-jit.sh` on the bare-metal tests, kvm-unit-tests `cache` and `debug`, the corpus
  and lockstep.
  `WAARM64_JIT_STRESS=1` runs every Node boot under it (hours with LTP and Alpine). **The long
  stress runs aren't routine**: they ran once at M5's end (Alpine 4.25 h, LTP 2.9 h) and found
  nothing the short runs, the differential test and the exact-step boots hadn't. Run them only
  when a change targets eviction or invalidation; for coverage per minute prefer short variants
  (a tiny cache with the default threshold, compile-on-sight with a big cache, tier-up after one
  entry).
- **Paths the page doesn't take:** round-robin SMP, Node's deterministic runs and user-mode vCPUs have no compile
  worker (every module's `seq` 0). A "parked on seq" check that didn't exclude 0 parked them for good: Firefox and
  the gates couldn't see it, lockstep and the bare-metal tests did. Run `tests/jit-lockstep.test.ts` and
  `tests/jit.test.ts` on any change to installs before measuring. In round-robin one cache serves every vCPU, each
  with its own TLB: state derived from the cache but kept per vCPU must notice the cache's changes per vCPU
  (`Cache::drops` against `Tlb::xdrops`; a one-shot flag was consumed by whichever vCPU ran next). On parallel vCPUs
  code read twice can differ: read guest code once per decision; a repeated boot loop (500 boots in ~5 min) finds
  such races, CI only sometimes.
- **A bad table index** (a "function signature mismatch" in a worker): dump every index the vCPU's JIT state can
  call (the jump cache, hot-word redirects, the transfer cache) at the trap and test each against the worker's table.
- In parallel mode input timed by steps is wrong (the vCPUs' summed steps say nothing about how far the boot is):
  wait for the prompt; and a test that waits for a shell must never match the console's end (count prompt lines:
  `trim.test.ts` failed 1 in 40 under load until it did). `scripts/ci.sh` runs the native tests from the working
  tree: don't edit `core/` while it runs, and read its result before committing.
- **JIT-check** (`VmConfig.jit` 3: compile on sight into the full-size cache, with the checker)
  finds stale blocks JIT-stress's 4-region cache evicts before they're entered again; the `maint`
  test uses it (code rewritten by another vCPU).
- **Planted bugs:** every new emitter rule gets deliberately broken once (a carry, a condition, a
  write-back, a fusion taken when the registers differ, a swapped swizzle operand, …) and the
  tests must fail. After a planted-bug experiment, restore the source **and rebuild the wasm**,
  and check the build actually compiled before trusting a "caught" result. Every real bug found
  gets a regression test.

## Decoder sweep (`core/fuzz`)

A separate workspace, so Capstone never reaches the core's builds. `cargo run --release --bin
sweep` (from `core/fuzz/`) runs every 2³² word on a scratch vCPU (no panics) and compares "valid
instruction" with Capstone 5.0 (~3 min); `sweep -- sys` covers the system space
(`0xd500_0000..0xd540_0000`) at EL1 in seconds: a register Capstone names must work unless its
feature is one we leave out (`SYS_NOT_OURS`), an unnamed one must be UNDEFINED except the ID space
(reads as zero). `core/fuzz/src/check.rs` lists the expected differences (features we leave out,
CONSTRAINED UNPREDICTABLE encodings Capstone rejects, should-be-one fields the M4 ignores). Both
report 0 mismatch classes. Not in `ci.sh` (it builds Capstone from C): rerun it when the decoder
changes. `cargo fuzz run decode` (from `core/`) is the libFuzzer target.

## virgl fuzzing (`tests/virgl-fuzz.ts`)

The renderer parses what the guest sends (web/virgl-renderer.ts, the TGSI translator, the H.264 and AV1 parsers of
video), and WebGL validates only the calls it is given, so the decoding itself is fuzzed. A case is a seed: one of
the captured traces (`tests/virgl/`: glcomp, sway, three dEQP captures, VP9, H.264 and AV1 with its coding tools) up to
a few submits past a chosen one, with mutations in that window: stream words (interesting values, nudges, bit flips,
handles), command and object types, lengths, a payload's bytes (a shader's text: its numbers made huge or odd, its
punctuation), commands deleted, duplicated or spliced in from any trace, staging data's bytes, and fields of
`RESOURCE_CREATE_3D` and the 3D transfers. It replays through the device (`web/virgl-replay.ts`) into a renderer on
`tests/virgl-mock-gl.ts`, with video decoders that take every chunk and give no picture (so bitstreams are parsed;
without decoders they aren't). A defect is an exception out of the device or renderer (`escape`), an exception a
command's decoding caught that isn't an `Error` thrown on purpose (`fault`, through `VirglRenderer.onCaught`: a
TypeError or RangeError), resources keeping over 256 MiB (`memory`), or a case over 2 s (`slow`; the runner kills one
hung 10 s).
- **`tests/virgl.test.ts` runs seeds 1–300** (~4 s); `node tests/virgl-fuzz.ts [seconds] [first seed]` runs on (~35
  cases a second; a child process the parent watches), prints each new class of finding with its seed and writes its
  trace to `bench/results/local/virgl-fuzz/<seed>.vglt`; `node tests/virgl-fuzz.ts --run <seed|file>` runs one.
  Pure Node: it runs in a cloud session as well as the dev VM. Rerun it for a while when the decoder changes.
- **What it found** (2026-10-30, ~70,000 cases; each now has its test in `tests/virgl.test.ts` or
  `tests/virgl-video.test.ts`, each planted back fails it): a sampler view or state start slot of 2³¹ (every draw walked
  the sparse array: a hang); a blit of 2³² layers (as many blits); index buffers misaligned (a RangeError) or shorter
  than the count (the CPU's rebasing sized by it); an upload box past its level and data shorter than the box; a 2 GiB
  buffer resource (a 2 GiB copy); a TGSI swizzle that isn't one and an instruction missing an operand (TypeErrors); a
  video buffer destroyed between BEGIN_FRAME and END_FRAME (a TypeError). The last run, 9,700 cases over every
  trace, found nothing.
- **What it doesn't reach** (V8's coverage over 800 cases): stream output and Z32_FLOAT_S8X24 uploads (no trace uses
  them), snapshots and external resources (not the stream's), and pictures written into planes (the decoders give
  none). Counting array buffers alive (`process.memoryUsage()`) flagged cases that didn't repeat alone (V8 frees them
  on a thread of its own), so `memory` counts what the resources keep instead.

## Litmus tests (`images/build.sh litmus`, M7)

herdtools7's tools, built and run in the images container ([images.md](images.md)): 42 tests
from our own list of cycles (`images/litmus/tests.txt`), each with herd7's allowed final states
under `aarch64.cat`. `run.sh` runs each program and **`check.awk` fails a test if it observes
any final state herd7 doesn't allow** (the general form of "forbidden outcomes never appear");
each test prints `litmus: <test> ok model=<herd7's verdict on its condition> seen=<litmus7's
observation>`. A test with more threads than the machine has CPUs prints nothing and counts as
skipped (on one vCPU only `CoRW1`, `CoWR`, `CoWW` run).
- **The M4 reference** (`tests/litmus/m4-reference.txt`: the oracle VM, 4 vCPUs, 10⁸ outcomes
  per test): no forbidden outcome; 16 of the 20 allowed relaxations appear (R and SB ~60–70 per
  million, MP ~47, IRIW 1.5, WRC 0.1), never `LB`, `2+2W+dmb.sy+po`, `S+dmb.sy+po`. With
  litmus7's default settings the M4 showed almost nothing (SB never in 2M): the image uses
  herdtools7's Arm settings (stride 1, `userfence` barriers, `incr0` affinity, 5k × 200).
- The checker was checked by removing SB's allowed states (it fails, listing each state).
- **In CI, every mode and tier** (4 vCPUs; `waarm64.litmus=` options, then the stress's):

  | Runner | Mode, tier | Litmus, stress | Time |
  |---|---|---|---|
  | `core/tests/litmus.rs` | round-robin, interpreter (steps: `litmus-4cpu`) | `-s 100 -r 1`, `-n 20000` | 9 s |
  | `core/tests/litmus.rs` | parallel, interpreter | `-s 1000 -r 10`, `-n 100000` | 12 s |
  | `tests/boot-node*.test.ts` | round-robin, JIT (the same steps) | as the interpreter's | 3.4 s |
  | `tests/boot-node*.test.ts` | parallel, JIT / JIT-check | `-s 1000 -r 10` (`-r 50` with `WAARM64_LONG_TESTS=1`, as `ci.sh` runs it), `-n 100000` / `-s 100 -r 2`, `-n 10000` | 18 s / 43 s (JIT-check's boot is 30 s) |
  | `tests/browser.test.ts` | parallel, JIT | `-s 1000 -r 10`, `-n 100000` | 9 s |
  | `scripts/tsan.sh` | parallel, interpreter, ThreadSanitizer | `-s 100 -r 1`, `-n 10000` | 60 s |

  Round-robin is sequentially consistent (one thread, whole quanta), so it shows no relaxed
  outcome at all; parallel runs show them as the M4 does (MP 32, SB 918, R 49 of 20K under the
  JIT; SB and R under the native interpreter). JIT-stress round-robin takes over 5 min: only with
  `WAARM64_JIT_STRESS=1`. With DMB emitted as nothing (planted), MP+dmb.sys, MP+dmb.st+dmb.ld,
  MP+dmb.sy+addr, SB+dmb.sys and 2+2W+dmb.sys fail in parallel.
  **An address dependency lost in V8** (M8 loop 7): TurboFan folded the litmus idiom `eor wN, wM,
  wM` to 0, so the dependent load's address no longer depended on the first load (docs/jit.md
  "Atomics"). It showed as MP+dmb.sy+addr's forbidden outcome about once in 10⁴–10⁵ once the
  code tiered up: twice in CI (1 of 20,000, Chromium) and 95 times in 1.2M in Node at `-r 200`
  (none after the fix). Short runs run mostly Liftoff code, which doesn't fold: the Node parallel
  JIT run uses `-r 50` in `scripts/ci.sh`, where the unfixed build failed 5 of 5 runs
  (`-r 10`, a plain `npm test`, caught it in 1 run of 3). To look for such a
  rare outcome, boot the litmus image in parallel JIT with `waarm64.litmus=-s,1000,-r,200` (~1 min
  in Node, 400K outcomes a test).

## Atomics stress (`images/litmus/stress.c`, M7)

In the litmus image, built twice: `stress-lse` (`-march=armv8.1-a`: CASAL, CASPAL, LDADD) and
`stress-llsc` (`-march=armv8-a`: LDXR/STXR, LDXP/STLXP), both `-mno-outline-atomics`; the build
fails if a binary lacks its instructions. `waarm64.stress=<options>` runs both, a thread per CPU,
each pinned: `count` (32- and 64-bit fetch-add and a CAS loop on one cache line: exact totals),
`stack` (a Treiber stack of 64 nodes under a 128-bit (top, tag) CAS: every node back once, the
pops exact; GCC calls libatomic for a 16-byte `__atomic` CAS, so it uses `__sync`), `pingpong`
(mutex/condvar token passing: futex sleeps and wake-ups), `spin` (plain `STR`/`LDR` round trips
between CPUs 0 and 1: percentiles, not checked). It passes on the oracle VM (4 vCPUs, 10⁶
iterations per thread, 3× each).
- **Planted bugs caught** (native parallel interpreter): LDADD as a load and a store (`count`:
  385K of 400K); CASP/STXP as two plain stores, no lock (`stack` loses nodes, 3 of 3 runs, both
  binaries). A pair op without its lock but with its per-half CASes passes (3 of 3): the ABA it
  then misses needs two whole pair ops inside one; `pairs.c` covers the lock against plain stores.
  STXR succeeding whenever memory still holds what it reads now (not the monitored value): the
  guest never finishes (no pass within 300 s).
- Other planted bugs of M7's list: an SGI delivered to the CPU after its target (bare-metal
  `gicv3` check 21; `smp` hangs, deterministic and parallel); no IC broadcast in parallel mode
  (`maint` checks 401–403 on the first parallel run, JIT and JIT-check).
- **Spin-wait latency** (round trip, 2 × one way; 2026-09-28): the M4 0.08 µs p50, 0.13 p99.9;
  parallel JIT in Node (10⁶ per thread) 0.5 µs p50, 1.2–2.2 p99, 1.5–3.9 p99.9, max 0.3–0.9 ms;
  native parallel interpreter 0.72 p50, 0.95 p99; round-robin ~1 ms (virtual: a quantum each
  way). No chunk-long tail, so TurboFan doesn't keep a polled `LDR` in a register across a
  loop's iterations for long. In Chromium the guest counter moves in `performance.now()`'s
  5 µs steps (coarsened under cross-origin isolation), so sub-5 µs latencies read as 0 or 5.

## The FP suite (`images/build.sh fptest`)

Hand-written FP tests have been wrong where the code was (ed20c9f: a double FMA whose Dekker
product overflowed, which random inputs never made), and the golden corpus sets FPSR.IXC in only a
fifth of its FP tests, so the inline fast paths that need it (anything that rounds) saw a few
hundred cases a form. The suite takes its cases and its answers from Berkeley TestFloat and
SoftFloat instead, and real hardware checks its rules.

- **`images/fptest/fptest.c`** (static, with SoftFloat 3e's ARM-VFPv2 build linked in): reads
  `testfloat_gen`'s cases per operand type (f16/f32/f64 with one to three operands, the four integer
  types) and runs each through every form that takes it (`images/fptest/forms.py` lists them: FADD …
  FNMUL, FMADD … FNMSUB, FMLA/FMLS vector and by element, FSQRT, FMAX/FMIN/FMAXNM/FMINNM, FCMP/FCMPE
  (with zero), FCCMP/FCCMPE, FCSEL, FCMEQ … FACGT and the compares with zero (scalar and vector),
  FRINTN/A/P/M/Z/X/I, FCVT between half, single and double, FCVTL/FCVTN/FCVTXN(2), FCVT{N,A,P,M,Z}{S,U}
  to W, X and V registers, SCVTF/UCVTF from W, X and V registers; scalar, 2S, 4S and 2D), under
  each FPCR rounding mode × FZ × DN and with FPSR clear or with IXC already set. A vector's lanes
  are consecutive cases, so a plain lane sits beside an odd one. What each must give is SoftFloat's
  result with tininess before rounding and ARM's rules on top: FZ flushes denormal single/double
  inputs (IDC) and tiny results (UFC, no IXC); DN; NaN propagation in operand order (the addend first
  for the FMAs, and a quiet-NaN addend with ∞ × 0 is Invalid); FPNeg on NaNs (FNMUL, the negated FMA
  operands); saturating integer conversions; FMAXNM's quiet NaNs. Options: `-level 1|2`, `-every k`
  (a sample of a level; 3-operand types default to every 64th of level 1's 6.1M), `-n`, `-part k/n`,
  form-name prefixes. A type small enough for one chunk (the one-operand floats and the integer
  types: 372–768 cases at level 1) runs again until each form has run ~64k times: on 4 parallel
  vCPUs the JIT installs a compiled block only once the compile worker is done, and a form's
  12k checks finished interpreted (planted bugs in the fixed-point conversions went unseen).
- **Real hardware first:** `fptest.tar` (the programs and `run.sh`) passes on the oracle VM, and
  natively in the dev VM (also the M4): ~770M checks (766 forms since PERF loop 10), 0 failures. A rule wrong in the
  harness fails there.
- **In the guest:** `initramfs.cpio` (BusyBox, `images/fptest/init`: a part of the forms on each
  CPU) boots on `linux/Image`; `tests/fptest.test.ts` runs it on 4 parallel vCPUs under the JIT
  (~4 min an arm; `WAARM64_FPTEST_INTERP=1` adds the interpreter, `WAARM64_FPTEST_ARGS` passes options,
  `WAARM64_FPTEST_CPUS` the vCPUs). The harness's loops get compiled, so its instructions run the
  inline code; each one follows `MSR FPCR/FPSR`, which ends a block, so it starts a block (the FP
  guard reads the FPSR it just set).
- **Planted** (2026-10-18): the single FMA's midpoint branch skipped, scalar FRINTA's tie test
  made strict, FCMP's lt and gt swapped: each failed its forms (44–1.3M failures), nothing else.
- Also FABD, FMULX (∞ × 0 is ±2), FRECPS/FRSQRTS (FPNeg on the first operand, fused; FRSQRTS's
  (3 − ab)/2 as 1.5 + (a/2)·b, so it can't overflow where the halved result doesn't), FRECPX,
  FRECPE/FRSQRTE (the ARM ARM's RecipEstimate and RecipSqrtEstimate, without FEAT_RPRES), the
  pairwise ops (FADDP, FMAXP … on Vm:Vn, and the scalar pairs) and across-lanes ones (FMAXV …,
  reduced pairwise as ARM does), and the fixed-point conversions (fbits 1, 16, 32 and 64): 482
  forms. Models planted wrong (the estimate's rounding, FRSQRTS's 1.5, the reduction's order) fail
  on the M4. Since PERF loop 10 also every FEAT_FP16 form on halves (testfloat_gen's f16 cases with one to three
  operands; the 16-bit integer forms take the 32-bit cases' low halves) under FZ16 set and clear too (FZ16's input
  flush raises nothing; conversions ignore it), and FEAT_FHM's FMLAL/FMLSL(2), vector and by element (a case's third
  half as the single addend, its low bits filled on odd cases). Since PERF loop 11 FEAT_BF16's too (777 forms): BFCVT
  and BFCVTN/BFCVTN2 on the f32 cases (FPConvertBF: the single rounded at bit 16 in FPCR's mode), BFMLALB/T (the single
  FMA on the f32 cases' top halves widened), BFDOT vector and by element and BFMMLA (BFDotAdd from the ARM ARM's
  BFMul, BFAdd and BFRound, written in fptest.c apart from the core's), their bfloat16s the f32 cases' top halves: 791M
  checks natively on the M4, no failure. `tests/fptest.test.ts` boots with `fp16`, `fhm` and `bf16`.

## The stress test (`bench/stress/`)

A long-running run of the real page in headless Chromium (Debian, `?ncpus=4`, JIT, parallel SMP),
not part of `npm test` or CI (it takes as long as you give it; `tests/stress-analyze.test.ts` and
`tests/liveness.test.ts` are its cheap layers). It logs in on the serial console, starts a mixed
guest load (two busy loops, a fork/exec storm, `sort -R` and a Python thread + fork +
`mmap`/`mprotect`/`munmap` churn, `urandom | sha256sum`, `find /usr`, a `dd`/`cat`/`rm` disk loop,
console output) and samples every few seconds into a JSONL log.

```sh
# a few minutes (the guest is up at ~45 s; nothing else heavy should run: the numbers are host-sensitive)
systemd-run --user --scope -q -p MemoryMax=8G -p MemorySwapMax=0 -- timeout 400 \
  node bench/stress/stress.ts --seconds 300 --out bench/results/local/stress.jsonl
# hours, detached: a transient unit that survives the shell; the log is the record
systemd-run --user --unit=waarm64-stress --collect --working-directory="$PWD" -p MemoryMax=10G -p MemorySwapMax=0 -- \
  timeout 14700 node bench/stress/stress.ts --seconds 14400 --out bench/results/local/stress-4h.jsonl
tail -f bench/results/local/stress-4h.jsonl | cut -c1-200      # or:
node bench/stress/summarize.ts bench/results/local/stress-4h.jsonl   # while it runs, or after; exit 1 on findings
systemctl --user status waarm64-stress; journalctl --user -u waarm64-stress   # its console lines and final report
```

Flags: `--seconds` (the sampling time; the ~45 s boot and login come before it), `--interval` (sample period, 5), `--probe` (guest console probe period, 15),
`--ncpus`, `--guest-cmd '<cmd>'` (repeatable: started as `( cmd ) &` after the built-in load, for a
Go or C churn binary put on the guest), `--no-load` (no built-in load; the `--guest-cmd` ones still start), `--query` (added to the page's query, e.g. `jit=nocw`), `--disk2 <repo path>` (a read-only second disk: `images/stress/build-goroot.sh`'s Go toolchain, whose `go build` loop the JIT's cache was measured with: [jit.md](jit.md) "Sharing"), `--stall-ms` (2000), `--freeze-ms` (10000),
`--warmup` (150 s from the tool's start, left out of the memory and speed trends). Exit code 0 clean, 1 findings, 2 the
harness failed (no login).

Debian boots with the page tests' unattended credentials (`tests/debian-unattended.ts`), so no
first-boot questions stop it. What a sample holds (`type: "sample"`): the page's state and message, the status the page shows
(`data-status`: uptime, steps, JIT blocks, compile time, flushes, JIT steps and bytes compiled, IRQs, the run loop's cadence, per-vCPU
liveness), how long since a status message reached the page and the longest gap between two, the
main thread's timer lag, the last `performance.measureUserAgentSpecificMemory()` result (MiB), CDP
`Performance.getMetrics` (main-thread JS heap) and every browser process's RSS from `/proc`
(`SystemInfo.getProcessInfo`; the renderer's includes the workers and guest RAM). Other records:
`probe` (a `dmesg | grep` and an arithmetic marker typed on the serial console every `--probe`
seconds; the answer's latency is the guest console's liveness), `dmesg` (new lockup, stall, hung
task, panic lines), `event` (console errors, page errors, injections), `meta`, `end`.

`bench/stress/analyze.ts` turns the records into findings (the same rules run at the end of a run
and in `summarize.ts`): `crash` (page state `crashed`/`failed`, a panic or page error: the page's
message carries the core's panic text), `freeze` (main thread not answering, or no status for
`--freeze-ms` while running; it says whether a console probe was answered meanwhile), `vcpu-stall`
(one `vm_run_cpu` call, or the host handling an exit, longer than `--stall-ms`, or one in progress),
`loop-stall` (the machine worker's run loop), `memory-growth` (renderer RSS slope above 200 MiB/h
and 200 MiB over at least 600 s after the warm-up), `slowdown` (MIPS in the last third of the run
below 70% of the first third's, or three samples under 10% of the median), `guest-lockup`,
`guest-unresponsive` (a probe unanswered for 60 s).

Fault injection checks the detection: `--inject freeze-main@60:25` keeps the page's main thread
busy for 25 s from t=60 s; `--inject drop-status@60:25` swallows the machine worker's status
messages for 25 s (a frozen display with a live guest). Both are reported as `freeze`.

Liveness is host-side (web/liveness.ts, no core ABI): each vCPU worker times its `vm_run_cpu` calls
into a SharedArrayBuffer block (`Vm.liveness()`). The longest chunk is bounded by the step budget
(100M steps, ~0.3 to 1 s at these speeds), so a call over ~2 s is a real stall, in the core or in
a host import inside it. Blind spots: while the page's main thread or the machine worker is
frozen, the guest console can't be read (it goes through them); the vCPU counters are read
through the same status message.

## USB: the dev VM's host rigs

Lima's `vz` passes no host USB devices through, so the test devices come from the VM's own kernel
([usb.md](usb.md) "Findings"). All of this is dev-VM-only: a cloud container can't load modules.

- **Setup, once per machine** (and after a kernel update): `tests/usb/gadget.sh install` (passwordless sudo). It
  builds `dummy_hcd` for the running kernel and installs it with a udev rule, a modprobe blocklist (`usbtest` and
  `cdc_acm` stay off the host's side of the gadgets) and Chromium's managed policy ([devenv.md](devenv.md) "The USB rigs"). `tests/usb/gadget.sh check` says what's missing.
- **The gadgets** (`tests/usb/gadget.sh up|down|status [name...]`): configfs gadgets on `dummy_hcd`'s four UDCs,
  at high speed. `zero` is Gadget Zero (`0525:a4a0`, serial `waarm64-zero`), with configuration 1 source/sink
  (pattern 1: `i % 63`) and configuration 2 loopback. `zero-a` and `zero-b` are two without a serial, which differ
  only in bcdDevice (1.01 and 1.02). `acm` is a CDC ACM port (`0525:a4a7`, serial `waarm64-acm`). `ci-usb.sh`
  brings up `zero` and `acm` and takes them down after.
- **The uhid rig** (`tests/usb/uhid.ts`) needs no command: a test makes its devices with
  `new UhidDevice(descriptor)`, and they go away with the process. The descriptors are in
  `tests/usb/hid-descriptors.ts`. `node tests/usb/uhid.ts [id...]` keeps some up by hand and prints what the host
  sends them. Its `keyboard` device is also a keyboard and mouse to the VM's own input: send it only empty reports.
- **Permission** comes from the policy alone. It grants the 0525 gadgets (WebUSB) and every HID device (WebHID) to
  `http://127.0.0.1:8190`–`8197`, exact origins only, so a test serves its page on one of those ports
  (`tests/usb/rig.ts` `PORTS`). On Chromium 153 the DevTools protocol's `DeviceAccess` prompt events never fire for
  WebUSB or WebHID: `requestDevice` in headless Chromium waits forever, and no test can answer a chooser.
- **Tests:** `tests/usb-e2e-webusb.test.ts` (Gadget Zero's control, bulk and loopback transfers and the ACM
  gadget's interfaces, from a worker) and `tests/usb-e2e-hid.test.ts` (Chromium's parse against
  `tests/usb/hid-fixtures/`, and reports both ways, protected collections included), both in `scripts/ci-usb.sh`.
- **The fixtures** `tests/usb/hid-fixtures/<id>.json` hold Chromium's parse (`HIDDevice.collections` as JSON) of
  each uhid device, with the raw descriptor as `descriptor` (hex) and in `<id>.rdesc`. The WebHID device's encoder
  round-trips against them. `node tests/usb/hid-record.ts` records them again when the pinned Chromium moves, and
  `usb-e2e-hid` fails until then.
- **The QEMU oracle** (`tests/usb/oracle.sh`): the linux-usb guest on `qemu-system-aarch64 -M virt` (TCG) with
  `qemu-xhci`, and Gadget Zero passed in with `usb-host`. It runs each of testusb's tests in a boot of its own
  (~1 s each), with the usb guest's arguments on ours, and prints ok, the errno, or hung. `--trace` adds QEMU's
  `usb_xhci_*` trace events beside each console log, with the doorbells, transfers and queued events and their
  completion codes, to compare our controller's behavior with. **Finding (2026-10-18, QEMU 11.1.2):** 0–23 and
  25–29 pass or are skipped by usbtest for this device (15, 16, 22 and 23 need isochronous endpoints, 25–28
  interrupt ones). Test 24 (unlink from queues of writes) hangs every time on QEMU. In the run with `-c 10` alone
  (32-deep queues), the guest's xhci-hcd logged events for TRBs that weren't part of any TD. That is a QEMU
  `qemu-xhci`/`usb-host` behavior, not ours, so compare 24 against the native runs instead.
- **Sizing:** `node bench/usb/run.ts` (WebUSB's cost per transfer and bulk throughput from a worker, with a native
  usbfs baseline; usb.md "Findings", `bench/usb/REPORT.md`).

## USB: real devices on the Mac

The dev VM sees no real USB devices, but the Mac mini that hosts it does. A by-hand check (not a test in any
`ci-*.sh`; usb.md "Findings") runs the page in a headless Chrome on the Mac, driven from the VM:

- **The browser:** the current Stable Chrome for Testing on the Mac (`~/waarm64-chrome/current/`, bench/mac-chrome.sh),
  started over SSH with `--headless=new --remote-debugging-port=9223 --user-data-dir=/tmp/waarm64-cft`. It listens on
  the Mac's `127.0.0.1:9223` (with `--remote-debugging-address=127.0.0.1` it took `[::1]`). Start each session
  with a fresh profile (`rm -rf /tmp/waarm64-cft` first): a reused one listed none of the policy's devices.
- **The tunnels:** from the VM, `ssh -N -R 8193:127.0.0.1:8193 -L 9300:127.0.0.1:9223 macmini.lan`, with
  `PORT=8193 node tools/serve.ts` in the VM. The page is then the Mac's `http://127.0.0.1:8193`, and the VM drives
  the browser with `chromium.connectOverCDP('http://127.0.0.1:9300')`. Lima forwards the VM's own listening ports to
  the Mac's loopback too, so don't forward a port to the Mac that the VM also listens on.
- **Permission** is a managed policy again, which needs the user's `sudo` on the Mac: a plist with
  `WebUsbAllowDevicesForUrls` (the devices' vendor and product IDs, for `http://127.0.0.1:8193`) in
  `/Library/Managed Preferences/com.google.ChromeForTesting.plist`, then `sudo killall cfprefsd`. Chrome for
  Testing reads that domain, not its bundle identifier's (`com.google.chrome.for.testing`); `chrome://policy`
  renders blank to `innerText` in headless Chrome, so check with Playwright's `getByText`, or just with
  `navigator.usb.getDevices()`. Remove the plist afterwards.
- **The guest:** a stored Debian machine written into the store from the page (as `tests/page-usb-guest.test.ts`
  does), with the devices in `usbDevices` and *attach at start*, since the chooser can't be answered. Commands go
  through the page's terminal; it holds only what is on screen, so long output is better written to a file in the
  guest and read back in short pieces. Interactive bash drops the rest of a command line when a child dies of
  SIGINT, so stop a timed run with `timeout` (SIGTERM) or a count, not `timeout -s INT`.

## Waiting in tests

A test waits for an effect on its condition, never for a fixed time: `until(cond, what, ms)` and `eventually(check, ms)`
in `tests/until.ts` poll every 2 ms up to a generous deadline (10 s), then fail with `what` or the check's last
assertion. A fixed settle before an assert (`setTimeout(r, 30)`, then `deepEqual`) fails whenever the process stalls
past it, however long it is: when a descheduled process resumes, Node runs the due timer before the message it was
waiting for (timers come before the poll phase), and `scripts/ci.sh` runs every file at once beside the native
guest-image tests. Under `scripts/ci.sh`'s load and a reproduction (24 spinning shells, 8 copies of the files at a
time), the MessageChannel tests failed that way in up to two runs in three: the agent link's (`tests/agent.test.ts`,
`agent-link`, `agent-power`), the game pad's glue (`usb-gamepad`), the network's local connection (`network`), the GPU's
flush pacing (`gpu`). A link's
own wait does too: `await link.hello(ms)` for its HELLO, a one-shot `onHello` listener (`nextHello` in
`tests/agent.test.ts`) when the same agent's HELLO comes again. A fixed settle stays only before a check that
something did *not* happen (`eventually` would pass at once), after the positive wait. A timing that is the behavior
under test is measured so load can't break it or widened with the reason in the test: `gpu.test.ts`'s flush pacing
takes a run again when the process stalled past a frame between its synchronous sends, and checks that replies went
together by the task they came in, not by milliseconds apart; the clipboard's REQUEST_WAIT restart runs on a 1 s
wait. An effect that goes through the thread pool (crypto's hashes: the clipboard's read-back of a written image) is
waited on too, never given a fixed `quiet()`.

## A test file that never ends

`node --test`'s spec reporter prints a file's results only when the file's process ends (only the first file's stream as they come),
so a file cancelled with "Promise resolution is still pending but the event loop has already resolved" and
nothing printed may well have passed every test: its process stayed up for a ref'd handle left behind. In a report
(`node --report-signal=SIGUSR2 --report-on-signal`, `kill -USR2`), a listening `MessagePort` is an `async` handle with
`is_referenced: true` (not a pipe or a worker); `Atomics.waitAsync`'s timeouts are unref'd `timer` handles; the JS stack
is always empty from a signal; and `ps`'s `%CPU` is the average over the process's life, not its current use.
`tests/pause.test.ts` hung like that four times under `scripts/ci.sh` (2026-10-18 to 10-27): `Devices.serve`, which
yields through a `MessageChannel` every 2 ms of work and keeps listening on it, missed a `close` that landed during the
yield and waited on the doorbell for good, its port keeping the process up. It re-checks the close after the yield and
closes the port on every way out; `tests/devices.test.ts` closes in that window.

`scripts/ci.sh` and `scripts/ci-fast.sh` give each test without its own `timeout` 10 minutes (`--test-timeout`; ci.sh's
longest take ~100 s): a test that hangs fails by name and the file goes on, where it once held ci.sh's JS step for the
run's whole timeout without a word of where (`tests/browser.test.ts`, 2026-11-18, once in six runs, an idle event loop
waiting on Chromium; not reproduced alone). Its timings reporter writes only at the end, so ci.sh writes
`target/ci/timings.json.new` and keeps the last good file when a step is cancelled.

## Booted-Debian fixtures

A test that needs Debian but doesn't test its boot starts from a **fixture**: a snapshot of the network harness's
Debian (`tests/browser/tailnet-worker.ts`) at its login prompt, made once per machine shape and key and kept in
`target/ci/debian-booted-<shape>-<key>.waarm64snap` (~165 MiB). `tests/debian-fixture.ts` `debianFixture(browser, base,
shape)` returns its path, making it first (a boot in a Debian slot, ~28 s) when it's missing or its key moved; the
harness pages start from it with `restore=` (~1 s; the guest gets a newline to show its prompt again), and
`tests/serial-console.ts` `loginRoot` then sets the guest's clock from the host's (it stood still since the save).
Parallel test files wait for one maker (a lock directory beside the file). `WAARM64_DEBIAN_FIXTURES=0` boots instead.

- **The shapes** (`SHAPES`) are what the worker builds the machine from: `ip` (one card on an IP port, no card
  credential: tailnet.html), `ip-tools` (the same on debian-tools' disk), `port` (the card's credential, one IP port:
  netguest.html `port=1`), `ports2` (two IP ports: netguest.html `ports=2`, adapters.html), `echo3` (three echo
  cards). A restore must describe the machine that saved it, to the disk's virtio features: the maker's disk has an
  overlay as every restore's does (without one a disk is read-only, and the core refuses the state as another machine's).
- **The key** is what the boot made of the machine: the image's `.inputs` key (or the file's size and time), EDK2's
  hash, the core's snapshot format, ABI and `MIDR` (`interp/sys.rs`'s line: the guest's Linux caches it at boot), and the sources that say what the machine is and is given at boot
  (`fdt.rs`, `smbios.rs`, `fw_cfg.rs`, `virtio.rs`, `boot.rs`, `snapshot.rs`, the worker, the credentials). The JIT,
  the CPU and `web/devices.ts` are left out (they move often, and a restore of a fixture made by another core is the
  snapshot path working); a change to what the guest sets up at boot that none of these files show (a device's
  feature negotiation in `web/devices.ts`, say) needs a run with `WAARM64_DEBIAN_FIXTURES=0` or the files deleted.
- **The page's own machine** (`pageFixture(browser, base, query)`): the page's transient machine of a query
  (`web/app/?<query>`; its `disk=`, else the tests' Debian) at its serial login prompt, saved with the page's Snapshot (a download, 79 MiB for
  `ncpus=2&view=both`, ~30 s to make), its key `fixtureKey`'s, the query and the page worker's device and start
  sources and the guest agent the page serves (a restored guest runs the agent its boot got); a test loads it with Load
  snapshot (bench/snapshot-start.ts `loadSnapshotFile`) into a page of the same query (the machine's name, its disk and
  its devices must match: web/app/worker-header.ts), then sets the guest's clock after its login. The users, 2026-11-18:
  page-room's two guests from one file (its slot 141 → 110 s; their same identity doesn't matter, each page serves its
  own lease), page-power's first boot (75 → 48 s: its Restart boots for real), page-template's (58 → 29 s),
  page-clock's (87 → 47 s: the agent sets the clock after the fixture's load as after its own), page-spill's (81 → 30
  s, its split's own file, loaded after the Machine menu's checks) and the two clipboard tests' (one file of the sway
  image on the uefi machine, `?disk=` keying it: 177 → 145 s, 121 → 97 s).
- **A stored machine** (`storedFixture(browser, base, records, query)`): the records of `STORED` (a test puts them with
  `putStored`) under **fixed ids** (`fixedId`: a stored snapshot is checked by the shape hash, whose disks' serials
  are the attachments' ids), opened with `STORED_QUERY` (`display=simple` is in the shape), at its serial login prompt,
  kept with the toolbar's Snapshot and downloaded from the Snapshots tab (86–95 MiB, 32–40 s to make); its key
  `pageFixture`'s with the records, the query and `shape.ts`. A test loads it with Load snapshot › From a file while
  its machine boots and answers the question whether to keep the overlay with Replace (`replacesFixture`): the start
  attached "Changes", which takes the fixture's blocks, so the machine has the one overlay it would have after a boot.
  The users, 2026-11-18: page-usb-guest and page-usb-gamepad (one file: `STORED.usb`; slot 57 → 12 s), page-incognito
  (`STORED.net`: 112 → 23 s; its cache still fills from the guest's read of the whole disk), page-snapshots
  (`STORED.ramdisk`: ~60 → 19 s), page-machines' first boot (`STORED.five`, five disks, two of them with overlays
  that the Replace answers for: 112 → 69 s in the suite, 55 s alone; its reboot stays real) and page-folders' snapshot and workload tests (`STORED.shares`, on the Debian and the
  debian-tools disks: 42 → 12 s, 51 → 26 s). The folders aren't in the shape: the fixture is made without any, and
  the test attaches its own, which the guest's automount finds at its first look.
- **What keeps a real boot:** the tests whose subject is the boot (net-guest's first test: the card's units don't hold
  the boot up; page-agent: the agent's arrival over fw_cfg, which a restore doesn't give), and page-network (its
  reloads start the machine again, and its first boot runs beside its form checks).
- **Restored and booted guests are the same guest:** two restores of one fixture have the same machine-id and DHCP
  identity, and a lease that comes after the restore meets networkd's retry schedule as it stood at the save (net-guest's
  late lease: taken in 4 s; the default route's move: IPv6 at once, IPv4 at the next renewal, 8 s).

## Out-of-context reviews

Loops review their own work with a context full of their own theory; a fresh reader finds what they miss (VK3,
2026-10-27: one static review of the path of a VA-API picture under Venus found 14 real defects: bench/vulkan/REPORT.md
"VK3 L4b–L4c"). So, besides the tests:
- **When:** at each track's end, over the code the track changed (before its final CI); mid-track every ~3 loops,
  or after a loop that adds a subsystem (a new path through the driver, the worker, the core), over that area.
- **Who:** a fresh agent (a subagent, or a cloud session: [cloud.md](cloud.md)) with only the repo. Read-only on
  main.
- **The brief:** short and neutral: the area and its entry points (docs and files), "a careful static review for real
  defects: races, missing ordering or synchronization, lifetimes and reuse, silent failures, spec gaps, state that
  differs between a first and a later run". A symptom may be named when there is one, never a theory, the
  handover's findings or what has been ruled out: they steer the reader away from what they didn't think of.
- **The output:** one Markdown file on a `review/<area>` branch, findings ranked, each with file:line, the defect,
  the condition or interleaving that triggers it, and a test that would confirm it; plus what was checked and found
  fine.
- **After:** the supervisor (or the session) triages each finding into a fix loop or an issue. A fix starts with
  its confirming test, failing first (as a planted bug for a JIT rule). The findings are fixed or filed as issues
  ([issues.md](issues.md)); the branch is deleted.
- **The core's review (2026-11-03)**, the whole of `core/src` in eight areas: 14 correctness findings and 7
  performance ones, all fixed (the commits that say "REVIEW"). What it checked and found clean, so a next one can
  aim elsewhere: the corpus generators at 2-3× their counts and every `a64.inc` pattern with random fields against
  qemu-aarch64 (no `Exit::Unimplemented`); scalar, AdvSIMD FP and crypto through a qemu-aarch64 harness on biased
  inputs and random FPCR (~1.3M); the JIT's differential test at 10× its words a class; FRECPE/FRSQRTE/FRECPX
  exhaustively; an MMU-on JIT fuzzer (an interpreter VM against one compiling on sight, mixed page permissions, EL0
  and EL1, compared whole: `Cpu`, pages, steps); a randomized TLB against a fresh walk (now
  `mmu::tests::tlb_matches_a_fresh_walk_through_remaps`); and by reading, the platform's wake protocol, the GICv3,
  virtio and the xHCI. Only the TLB test was kept: the harness and the JIT fuzzer would have to be written again.

## Planned layers

- **In-guest suites** not yet run: more LTP areas (need `mkfs` tools and a scratch disk), the
  kselftests `fp` and the generic suites, language test suites (Python), guest JITs (Node/V8,
  LuaJIT) for code invalidation.
