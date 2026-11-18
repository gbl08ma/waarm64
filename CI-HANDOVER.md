# CI: tiers and faster lanes — handover

The brief: [CI-KICKOFF.md](CI-KICKOFF.md). The plan: [docs/plans/ci-tiers.md](docs/plans/ci-tiers.md) (the user's
decisions in §11).

## State (2026-11-18)

- Merged: the plan, jit-diff in four parts (per-test seeds, kept), ci.sh's quick checks first. Measured once in a
  cold worktree: ci.sh 971 s (the JS step 736 → 456 s; the steps before it ~130 s slower from the cold build; the
  native group, TSan in it, is now the tail). CLAUDE.md's oracles line updated; the rest of §10's drafts wait for
  loop 1.

## Next, in order

1. **Loop 1, the fast lane:** `tests/areas.ts` (the areas map, with a check that keeps it complete), the CI lock
   (exclusive for ci.sh and the topic scripts, shared for the fast lane), `scripts/ci-fast.sh` (T1); docs/testing.md
   "Tiers" with the change table; CLAUDE.md's §10 drafts applied in the same commit.
2. **The cheap speedups:** ci-net.sh at 2 Debian slots; `ci.sh --affected`; cargo-nextest (the Rust test binaries at
   once); TSan's parts at once (the tail now).
3. **The measurement window** (§9, ~2.5 h, the machine idle): each file's peak memory and time alone, the fast lane's
   concurrency, the Debian slots.
4. **The booted-Debian snapshot fixture** for the Debian tests that don't test booting.
5. **Guests:** which Debian tests need only a Linux guest (purpose-built Buildroot guests, cached by config hash); a
   Buildroot guest with an SMP userspace workload for the exact-step runs; Alpine moved to compatibility runs without
   fixed steps.
6. **The end:** T3 measured, docs/testing.md authoritative, the plan's outcome moved there; GitHub Actions stays the
   plan's §6 until the repo is public.

## Open questions

None yet.
