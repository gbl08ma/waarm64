# CI: tiers and faster lanes — handover

The brief: [CI-KICKOFF.md](CI-KICKOFF.md). The plan: [docs/plans/ci-tiers.md](docs/plans/ci-tiers.md) (the user's
decisions in §11).

## State (2026-11-18)

- Merged: the plan, jit-diff in four parts (per-test seeds), ci.sh's quick checks first.
- **Loop 1 (the fast lane), built:** `scripts/ci-fast.sh` (T1), `tests/areas.ts` (26 areas, 34 heavy files, 36
  topic-only) with `tools/ci-select.ts` (selection, `--check` in ci.sh and the lane, `--record` to
  `bench/results/local/ci-history.jsonl`), `tools/test-timings.ts` (ci.sh writes `target/ci/timings.json`), the CI lock
  (`scripts/ci-lock.sh`, exclusive in ci.sh and every topic script, shared in the lane, an intent file so an
  exclusive waiter goes first). docs/testing.md "Tiers" holds the tiers and the change table (the per-script
  "must pass too when" sentences removed); CLAUDE.md's §10 drafts applied. The names flake (`waarm64_ts`, three
  tests failing ~1 in 6 lib runs under load) fixed by seeding `random()` per test in test builds.
- 3a290c2c and 86d5dbf2 passed ci.sh (790 s). ci.sh earlier that day: 937 s, the JS step 569 s from 261 s; the serial
  Rust steps before it ~230 s (rust test 134, agent 18, testfloat 41).
- **The fast lane measured** (logs in `bench/results/local/ci/loop1-fast-*.log`): 111 s for a network change (net/ts's
  crate beside 129 files, peak 4.2 GiB), 161 s for a JIT one (`--files core/src/jit/emit/simd.rs`: 133 files, peak
  3.3 GiB). Its tail on a core change is the core crate's cargo tests run one binary after another (143 s: lib 44,
  baremetal 66, corpus 21), so cargo-nextest is the biggest win for the lane. Run it under `MemoryMax=6G`.
- **cargo-nextest** (0.9.152, `.config/nextest.toml`: the longest tests first) in ci.sh and the lane, with the test
  builds of `waarm64-core` at opt-level 1 and `waarm64_ts` at 2 (Cargo.toml): the workspace's Rust tests 123 s → 26 s
  (nextest alone 64 s; peak < 300 MiB; a rebuild after an edit ~3 s). Passed ci.sh: 847 s, its rust test step 26 s
  (134 before), the JS tests from 175 s to 736 s. **The tail is now the native group beside them**, ends at ~847 s:
  TSan 361 s of it (272 → 633 s). The tests' CPU sum is 160 s on 8 cores: splitting them further gains little.
- **TSan's three parts at once** (scripts/tsan.sh): alone 112 s → 53 s (peak 2.4 → 4.8 GiB); in ci.sh 361 s → 127 s.
  ci.sh **737 s** (peak 8.0 GiB under its 11G), the JS tests (594 s) and the native group now end together. vmstat
  (`bench/results/local/ci/tsan-par-vmstat.log`): the cores are saturated from the JS tests' start to ~10 min, and ~70%
  idle in the 144 s before them (the serial steps: clippy, rust test, agent, testfloat, wasm build).
- **ci.sh's early steps at once** (`scripts/ci-group.sh`, shared with the lane): the quick checks and clippy (17 s),
  then the Rust tests, the agent, TestFloat and the builds (37 s); the JS tests start at 55 s (144 before). ci.sh
  **635 s** (peak 7.9 GiB); the JS step (581 s) is the whole tail, the cores saturated through it
  (`bench/results/local/ci/early-par-vmstat.log`), the native group done by ~500 s.
- **The fast lane with nextest**, the JIT case (`--files core/src/jit/emit/simd.rs`): 161 → **146 s** (peak 3.3 GiB),
  the core's tests 19 s (143 before); the tail is the JS files (128 s at 4 at a time). One run at
  `WAARM64_FAST_JOBS=6`: 123 s, peak 4.3 GiB (the lane's budget is 4.5): for the measurement window to settle.
- **The measurement window** (2026-11-18, the machine idle, under the CI lock exclusive; rows and logs in
  `bench/results/local/ci/window-*`, runner `window-files.sh`/`file-peak.sh` there):
  - **Each JS file in its own scope, 4 at a time**, ci.sh's env (Alpine, the long runs): all 196 passed, **492 s wall**,
    against ci.sh's JS step at node's default 7 at a time (581 s). The files' times sum to 1961 s, 3631 s in ci.sh: at 7
    the files (each its own Chromium and workers) slow each other ~1.85×. (ci.sh's native group runs beside its JS
    step, nothing did here.) Peaks (`memory.peak`, mostly anon; `file_max` counts only the page cache a scope read
    first): 120 files < 256 MiB, 35 at 0.5–1 GiB, 12 at 1–2 GiB, one over 2 (virgl-browser, 2.7 GiB); the longest at 4
    browser 169 s, venus-driver 141, wgsl 126, jit-diff-1..4 111–125 (one row each in `window-files.jsonl`).
    The fast lane stays at 4: 6 was 23 s faster but peaked at 4.3 of its 4.5 GiB.
  - **ci-net.sh**: 2 Debian slots 551 s (peak 7.1 GiB), the default 795 s (4.1 GiB): ci-net now takes 2 (passed).
  - **The wasm core after a one-line `core/src/jit/` edit: 9 s** (release, LTO), not the ~2 min guessed.
- **A flake fixed** (seen in the fast lane): page-unrestorable's in-place case read the card's first reason (its
  shape's) before the tab had read the disks' generations; it waits for its reason now (a planted 2 s delay in
  `watchGenerations` failed the old test, not the new).
- The commit with ci-net's 2 slots and the flake's fix passed the fast lane (115 s) and ci.sh (712 s, peak 8.4 GiB;
  its JS step 620 s against 581 in the 635 s run: one run each, so no trend yet).
- **ci.sh's JS step at 4 files at a time, against the default 7** (one session, alternated, `WAARM64_JS_JOBS`; logs
  `bench/results/local/ci/js{4,def}-*`): at 4, 684 and 672 s (peaks 6.6, 6.7 GiB); the default, 640 and 640 s (8.4,
  8.7 GiB). The default stays: ~38 s faster, the arms apart; 4 saves ~1.9 GiB (the knob stays for a smaller host).
  The window's 492 s at 4 doesn't carry over: in ci.sh the native group shares the cores.
- **A hang and its fix:** one default round sat idle in `tests/browser.test.ts` from ~6 min until its 1500 s timeout
  (an idle event loop waiting on Chromium; 5/5 alone passed). ci.sh and the fast lane now give each test without its
  own timeout 10 min (`--test-timeout`; the longest take ~100 s), so a hang fails by name. The cancelled run had left
  `target/ci/timings.json` empty and the next ci.sh failed its areas check: ci.sh writes `timings.json.new` and keeps
  the last good file; the check warns on an unreadable one (docs/testing.md "A test file that never ends").
- **A flake seen once:** spin.test.ts's IPI round trip, median 2,121 µs for 1,000 (in docs/backlog.md "Parallel SMP";
  0/20 alone or loaded).
- The commit with these passed the fast lane (89 s) and ci.sh except that flake (640 s, before two comment and `if` tidy-ups). **Not run yet:** the topic scripts other than ci-net
  since they gained the lock line, and the lock with two sessions' real runs at once (checked with small scripts only).
- **The Debian tests classified** (a static read; the table, with file:line: `bench/results/local/ci/debian-tests.md`).
  ~48 Debian boots in 29 files: the boot is the subject in 6 files (14 boots: page-debian, page-disk, page-stored,
  page-surface-debian, page-usb-keyboard, page-machines' reboot); one real boot and the rest not in 3 (page-power,
  page-folders, net-guest: 4 boots stay, 6 don't need to); Debian but not its boot in 16 (21 boots); only Linux or no OS
  in 3 (start: the firmware's first output, any UEFI disk; page-ram: needs tmpfs and the balloon's page reporting;
  page-quota). A restore takes 1.0–1.3 s against ~52 s for a first boot (qa/ci-debian-2.log): ~25–50 s a boot.
  - **Buildroot rarely replaces Debian here:** the Buildroot guest is BusyBox with no init system, systemd, vsock, USB,
    X11 or EFI, the agent runs only on firmware machines (worker-start.ts:51), and stored machines are always the uefi
    machine. The faster guests stay worth it for the Alpine and exact-step runs (plan §11.6), not these.
  - **What a snapshot must match:** a transient one, the machine's name and its device list (worker-header.ts:75;
    ncpus and RAM come from the file); a stored one, the shape hash (shape.ts `shapeOf`: each disk's serial is its
    attachment's id, `newId()` in every test now, so fixed ids are needed to share). A transient snapshot never loads
    on a stored machine nor the reverse. A restore gets no agent pieces (worker-start.ts:51).
  - **Families:** the default transient (`ncpus=2&view=both`: page-agent, page-power's first boot, page-template,
    page-network ×2, page-room ×2), the netguest harness's shapes (ci-net: `bootVm` has a `restore` option the
    harness doesn't use), one aligned stored shape, and one-offs (`usb=1`, `split=`, page-venus before any Venus
    context, docs/devices.md "Snapshots").
  - **Unconfirmed:** page-agent's agent-restart step needs a boot; page-room would restore two identical guests (same
    machine-id, DHCP identity); page-incognito counts the boot's own disk reads; net-guest's test 2 takes its leases
    at boot; a `?disk=` URL machine's restore check (page-clipboard*).

- **Booted-Debian fixtures, the harness half** (docs/testing.md "Booted-Debian fixtures"; `tests/debian-fixture.ts`,
  `tests/browser/fixture.html`, the worker's `save`/`restore`): 5 shapes (`ip`, `ip-tools`, `port`, `ports2`, `echo3`)
  for net-guest 2–4, net-local, net-tailnet, net-tailcat. ci-net **373 s** (551 before; 545 slot-seconds against ~950;
  logs `bench/results/local/ci/fixture/`), a run that makes them ~400 s. Fixtures 155–166 MiB, ~28 s each to make. A
  maker's disk without an overlay was read-only: the restore was refused as another machine (`vm.otherHardware`).
  net-guest alone 91 s from ~184 s of holds. Passed ci-net twice, the fast lane (108 s) and ci.sh (641 s).

- **The page's own machine as a fixture** (`pageFixture`: Snapshot at the login prompt, Load snapshot): page-room's
  two guests from one file (79 MiB, 30 s to make), its slot 141 → 110 s; same identity fine. ci-net 370 s at 2 slots
  (slots full: 531 slot-seconds in 293 s), so **ci-net takes 3 slots: 294 s, peak 6.4 GiB** (one run). 531e8839 and
  the slots' commit passed the fast lane (106 s) and ci-net; **not yet ci.sh** (run it before the push).

## Next, in order

1. **The booted-Debian fixture, the rest:** the default family's other users on the page (page-agent: its
   agent-restart step may need a boot; page-power's first boot; page-template), with `pageFixture`; page-network keeps
   its boots (its reloads start the machine again); then ci-debian's B tests, then the stored shape (ci-machines).
2. **Guests:** a Buildroot guest with an SMP userspace workload for the exact-step runs; Alpine moved to compatibility
   runs without fixed steps; page-ram and start onto a small guest (above).
3. **The Actions shards** (plan §6, plan-only while the repo is private, and it stays private for now): from
   `window-files.jsonl`'s times and peaks.
4. **The end:** T3 measured, docs/testing.md authoritative, the plan's outcome moved there; GitHub Actions stays the
   plan's §6 until the repo is public.

## Open questions

None yet.
