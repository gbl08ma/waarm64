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
- **Not run yet:** the topic scripts since they gained the lock line (each `ci_lock exclusive` after `step()`), and the
  lock with two sessions' real runs at once (it was checked with small scripts only).

## Next, in order

1. **The cheap speedups left:** the fast lane re-measured with nextest (and its first run since the shared group
   helper); ci-net.sh at 2 Debian slots. ci.sh is now CPU-bound in its JS step: only less work shortens it (the
   measurement window's per-file CPU and memory say where it goes).
2. **The measurement window** (§9, ~2.5 h, the machine idle): each file's peak memory and time alone, the fast lane's
   concurrency, the Debian slots.
3. **The booted-Debian snapshot fixture** for the Debian tests that don't test booting.
4. **Guests:** which Debian tests need only a Linux guest (purpose-built Buildroot guests, cached by config hash); a
   Buildroot guest with an SMP userspace workload for the exact-step runs; Alpine moved to compatibility runs without
   fixed steps.
5. **The end:** T3 measured, docs/testing.md authoritative, the plan's outcome moved there; GitHub Actions stays the
   plan's §6 until the repo is public.

## Open questions

None yet.
