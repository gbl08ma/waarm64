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
- ci.sh 937 s on 2026-11-18 (JS step 569 s from 261 s; the serial Rust steps before it are now ~230 s: rust test
  134, agent 18, testfloat 41).

## Next, in order

1. **The cheap speedups:** the Rust steps before the JS tests (~230 s serial: run them beside it, or by `--affected`); ci-net.sh at 2 Debian slots; `ci.sh --affected`; cargo-nextest (the Rust test binaries at
   once); TSan's parts at once (the tail now).
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
