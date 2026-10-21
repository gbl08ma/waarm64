# M8 JIT cache's lock, round two: handover (2026-10-21)

Built in a cloud session, where nothing can be timed. **This handover is for the dev VM: the fine benchmarking,
and one guest-visible change whose step counts only the VM can regenerate.** The audit behind it, with a ranked list
of the core's other contention points, is in the project's files (`jit-lock/proposal.md`). This file stands on its
own.

## What's in the tree: a miss doesn't wait for the lock

After a6dcd65, the waits that remained were 3 to 8 times longer than before (docs/jit.md "Sharing" "A miss doesn't
wait for it"), because they sat behind a table emitting a module. Now `Jit::miss` takes the lock with `try_lock`
when the cache has more than one table (parallel SMP). If another table holds it, the miss runs its block
interpreted and the next dispatch asks again. That's counter word 114 (ABI 47), shown as `ab-summary`'s `skipped`.
With one table (round-robin, Node's deterministic runs) the miss takes the lock as before, so steps.txt doesn't
move. The unit test is `jit::tests::a_miss_doesnt_wait_for_another_tables_lock`; it fails, by its 10 s timeout,
against the planted bug (`strong_count > 1000`).

In the cloud (Debian on the page, 3 vCPUs, boot, login and 30 s of `bench/stress/stress.ts`'s load, two
alternating rounds, counts only), the waiting fell from 7.7 and 7.4 s to 1.8–2.0 s (three runs), with 470–630 k misses run
interpreted instead.

`firefox-load.ts` now keeps the run's `par` counters too, so `ab-summary` prints `dsbMs` and `platMs` (the DSB
waits for TLBI IS and the platform lock). Those were never in a pages session's summary before.

### To do on the VM

1. **Measure it as a6dcd65 was** (`bench/boot/REPORT.md` "M8: fewer acquisitions of the JIT cache's lock"): the
   pages session and the churn screen from `target/snapbench/pages.webpcsnap` (`bench/gpu/ab.sh`, one session per
   arm, with an A/A), the `go build` loop from `debian-go.webpcsnap` (two sessions per arm), and the gates
   (`smp_alpine_jit`, `smp_user_jit_4`, three rounds alternating). The base is a6dcd65's successor on main.
   - Record `waitMs`, `skipped`, `contended`, `busyMips`, `doneS`, the heavy pages' loads, `interpG`, the stalls,
     and the new `dsbMs` and `platMs`.
   - Expect the waiting to fall by more than half. Busy MIPS should move by at most about what the waiting was
     (~1% on the pages session, ~2% on the churn). Emitting outside the lock cut waiting by a third and moved
     nothing, so "even" is a possible result.
   - Keep it if it's even or better and the waiting falls (it removes a stall source). Drop it if `interpG` or
     `doneS` get worse.
2. Then `scripts/ci-debian.sh` and `scripts/ci-machines.sh`. A guest change isn't involved, but this is a JIT
   change in parallel SMP. `scripts/ci.sh` passed in the cloud, and its image tests skipped there.

## A larger instruction cache line (guest-visible: Gabriel agreed in principle, 2026-10-21)

`CTR_EL0` (`core/src/interp/sys.rs`) reports IminLine 4, i.e. 64-byte instruction cache lines. DIC is 0, so the
guest must issue `IC IVAU` after writing code, and it does one per 64 bytes. Each one:

- takes the JIT cache's lock (`Jit::invalidate`, blocking);
- appends a page to `ival_log`, which every table's catch-up then walks (`dec.drop_page` per entry);
- ends the chunk (the exit leaves JIT code and goes round the run loop).

A Debian boot to login does **2.15 M** of them, a third of its 6.7 M acquisitions, and they drop compiled blocks
only ~450 times. They come from the kernel, which syncs each executable page cache page once
(`__sync_icache_dcache`) and runs module loading, BPF and alternatives, and from user JITs, which flush with
`__clear_cache` (libgcc reads CTR_EL0 at EL0) or their own CTR-driven loops (SpiderMonkey's and V8's).

**The change:** IminLine 9 (2 KiB, the architectural maximum line length). Our IC drops the whole page whatever
the line, so a larger line is still correct. Linux and libgcc step by it, so a 4 KiB page then takes 2 ICs instead
of 64. Leave DminLine, CWG and ERG as they are: IDC is 1, so the D-side cleans are skipped anyway; CWG sets
kmalloc's alignment for DMA; ERG is the exclusives granule.

What else it may bring: fewer chunk ends in code-loading phases (exec-heavy churn, Firefox's JIT), fewer of the
tables' ival-log walks, and less chance of the log overflowing (`IVAL_LOG`, 65,536 entries: a table that misses
one clears its whole decoded cache). Nothing else in Linux reads IminLine for policy.

**Steps:** a one-line change of `CTR_EL0`, a unit test that the field reads 9, and `tests/steps.txt` regenerated
for every boot it moves (all the Linux guests), once, in its commit. Check `par.ic` before and after on the Debian
boot and the churn screen (expect ~1/32). Run the gates and the pages session as in 1. Check the corpus and the
kvm-unit-tests for anything that compares CTR_EL0. If something must keep 64-byte lines, coalescing the ICs per
page until the next context synchronization (not guest-visible) is the fallback; it's described in the proposal.

## Not done here, ranked in the proposal

- Share the logged modules' bytes (`Arc<[u8]>`) instead of copying them into every table's `todo` under the lock
  (`Table::sync`).
- `bench/boot/results/m8-devlat/kick/kick.patch` on the `go build` loop, for the DSB waits for TLBI IS. These are
  4.6 s there, about the JIT lock's 5.9 s, and the patch was never measured on them.
- Count allocations (dlmalloc behind std's global spin lock) before doing anything about them.
