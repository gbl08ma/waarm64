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
- **Not run yet:** the topic scripts other than ci-net since they gained the lock line, and the lock with two sessions'
  real runs at once (checked with small scripts only).

## Next, in order

1. **ci.sh's JS step at `--test-concurrency=4`** (or 5): the window ran the files at 4 in 492 s against the step's
   581 s at 7, so fewer at once may be faster in ci.sh too, the native group beside it (~500 s) included. One ci.sh run
   each at 4 and the default, alternated; and its peak (7.9 GiB now) should drop.
2. **The Actions shards** (plan §6, plan-only while the repo is private): from `window-files.jsonl`'s times and peaks.
3. **The booted-Debian snapshot fixture** for the Debian tests that don't test booting.
4. **Guests:** which Debian tests need only a Linux guest (purpose-built Buildroot guests, cached by config hash); a
   Buildroot guest with an SMP userspace workload for the exact-step runs; Alpine moved to compatibility runs without
   fixed steps.
5. **The end:** T3 measured, docs/testing.md authoritative, the plan's outcome moved there; GitHub Actions stays the
   plan's §6 until the repo is public.

## Open questions

None yet.
