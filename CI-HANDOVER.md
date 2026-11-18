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
- **Not run yet:** the topic scripts since they gained the lock line (each `ci_lock exclusive` after `step()`), and the
  lock with two sessions' real runs at once (it was checked with small scripts only).

## Next, in order

1. **The cheap speedups:** cargo-nextest (the Rust test binaries at once: the fast lane's tail and ~80 s of ci.sh);
   the Rust steps before ci.sh's JS tests (~230 s serial: beside them, or skipped by `ci.sh --affected` when no Rust
   input changed); ci-net.sh at 2 Debian slots; TSan's parts at once (the native group's tail).
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
