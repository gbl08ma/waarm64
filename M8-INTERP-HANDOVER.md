# M8 interpreter speed: handover (2026-10-21, after loops 0-6, a second round, loops 8 and 9)

**The goal is the block interpreter's own speed**, so the compile threshold can rise and less code reaches V8. What
ran on 2026-10-21 is in `bench/interp/REPORT.md` from "M8-INTERP loop 0" to "M8-INTERP round 2"; how things work now
in docs/cpu.md "The block interpreter" (with "Its speed" and "Tried and not kept") and docs/jit.md "Compile policy".

- **Kept:** one call-free hot loop (`interp::block::hot`, loop 1); reports every 255 dispatches where nothing
  compiles (`REPORT_IDLE`, loop 2); a run of MOVs in one dispatch (loop 4); UMADDL & co, EXTR, RBIT/REV/CLZ (loop 5)
  and MRS, the SIMD&FP loads and stores and LSE (round 2) as handlers; the compile threshold's floor at 500, then
  1000 (loop 6 and round 2), with one report from `warm` to the threshold. The interpreter alone on the dev VM:
  user-mode guest 249 → 424 MIPS, EL1 176-198 → ~410, Buildroot's boot 89 → ~114, Alpine's 122 → ~173. Firefox's
  pages session compiled 271 MB of wasm at the old floor of 50, 164 at 1000. Loop 8 (a profile of `hot`, then
  what it pointed at): the access path's invariants once a `hot` call, an `LdO`/`StO` handler, LdO/StO pairs in one
  dispatch, LSE's common ops as single atomics: Alpine's boot +4-5%, the small guests +4-9%. Loop 9: the exclusives,
  LDAR/STLR, DMB and DC ZVA as handlers, Alpine's boot 185 → 195, Buildroot's 124 → 134.
- **Tried and not kept:** lazy NZCV, the flag setter + B.cond fusion, pre-linked successors, the micro-op copied
  whole, the literal load inline, reports every 255 in the JIT, floors of 250 and 2000; (loop 8) an `End`
  sentinel per block, LdO/StO runs in a loop, STP+STP pairs.
- **The tools:** `bench/interp/yardstick.sh` (the yardstick; `CONFIG=liftoff-only` the reference),
  `bench/interp/ab.sh` + `ab-summary.ts` (A/B on it, alternated), `bench/interp/ab-mac.sh` (the same on the Mac),
  `bench/interp/boot-node.ts` (a boot in Node for `perf`); JIT policy changes with the churn page, the pages session,
  the gates and the `go build` loop (docs/benchmarking.md "Screening an A/B").

## Next, ranked (expected payoff · evidence · how to test)

1. **Settle the floor of 1000 on the Mac host.** Done (loop 9): three rounds, Alpine's boot and userspace no
   different, Buildroot's boot +4.6% at 1000; the floor stays (`bench/interp/REPORT.md` "M8-INTERP loop 9"). The
   pages session wasn't run there (its case is counts, host-independent).
2. **Loop 7: one decoded-block store for every table.** Closed by measurement (loop 10): decoding is ~0.6% of a
   vCPU in Firefox's pages session and ~1.1% in Chromium's renders on 4 vCPUs; not built (`bench/interp/REPORT.md`
   "M8-INTERP loop 10"; the design is in git history, this file before loop 10).
3. **Count a browser's mix, then add the handlers it asks for.** Done (loop 10): 1.9% generic, spread over scalar FP
   and NEON; their handlers cost the small guests 1-2% and gained nothing in the pages session; not kept.
4. **What the guest accesses' atomics cost on x86_64.** Payoff: unknown, possibly the largest here for most users.
   Evidence: on the M4, perf's cycle samples on `run`'s 24 `ldar`/`stlr` plus the instruction after were 0.24% of
   `run`'s (acquire/release is nearly free there); what it doesn't cover: x86_64 (the user's desktop and most users), where wasm's
   sequentially consistent stores compile to `xchg` (or `mov` + `mfence`, ~20+ cycles) and loads to plain `mov`, never
   measured; the guest accesses outside `run` (the slow paths, the table walker, instruction fetch); and M7 loop 6's
   history, the interpreter with the MMU on 88.7 → 79.0 MIPS when the accesses became atomics, half alignment test
   and half ordering, on the M4. Test: an x86_64 A/B
   of the shipped core against `bench/interp/results/m8-interp-l0/plain-accesses.patch` (volatile plain accesses in
   `mem.rs`, the atomic RMWs' loads and stores too: a measuring build only, UB under parallel SMP, single-vCPU
   guests only), the yardstick (`bench/interp/ab.sh`), on a host with stable timing: the user's desktop by their
   hand, or a cloud session with many alternating rounds as a rough signal. If it costs, the sound options: plain
   loads with atomic stores only where another vCPU can observe them; or plain accesses with one vCPU or round-robin
   SMP, atomics only in parallel SMP. A memory-rule change is the user's decision.
5. **The floor between 1000 and 2000, and `threshold_max` above it.** Payoff: up to ~20% less wasm (2000 compiled
   22% less than 500 in the pages session), if 2000's losses (Alpine's userspace +2.3%, compress +4.9%, boot −1.9%)
   come from where it sits, not from pressure no longer raising it. Evidence: one session per floor
   (`bench/interp/results/m8-interp-r2/`). Test: floors 1000 and 1500 with `threshold_max` 2000-4000; churn page,
   pages session (two rounds), the gates.
6. **A steadier Go workload.** Payoff: a usable fourth gate. Evidence: the `go build` loop spread 1,094-1,489 MIPS
   across sessions at one floor; 2-3 sessions per arm couldn't tell 50, 500 and 1000 apart. Test: a shorter Go job
   timed by the guest (one package, or `go vet`), ≥5 sessions an arm.
7. **The exclusives (LDXR/STXR & co) and `DC ZVA` as handlers.** Done (loop 9), with LDAR/STLR and DMB: +8.7% on
   Buildroot's boot, +5.7% on Alpine's, far past their ~1% share (a generic micro-op ends the chain). The lesson for
   Next 3: weigh a class by the chains it breaks too, not only its count. LDXP/STXP and CAS remain.
8. **Superinstructions beyond the MOV runs.** Done (loop 8): LdO/StO pairs kept (~+0.7% on Alpine's boot, two
   sessions); runs in a loop and STP+STP pairs not; ADRP+ADD untried (docs/backlog.md "`hot`'s cost per micro-op").
9. **A guest-visible lever: fewer IC IVAU exits.** Done (2026-10-21): `CTR_EL0.IminLine` 9, 2 KiB lines. Debian's
   boot issues 1/17 of the ICs, the `go build` loop 1/32 (bench/boot/REPORT.md "M8: a miss doesn't wait for the JIT
   cache's lock, and 2 KiB instruction cache lines"). Not measured: Chromium in Debian (`bench/apps/chromium.ts`'s
   renders and IC count).
10. **Re-profile `hot`.** Done (loop 8, `bench/interp/REPORT.md` "M8-INTERP loop 8"); what it leaves (the cost per
   micro-op, register caching, tail-call dispatch) is docs/backlog.md "`hot`'s cost per micro-op".

Dropped by argument, not measurement: threaded dispatch through tail calls (a `call_indirect` is 2.5 ns on the M4,
more than a predicted jump-table branch; there's no PMU in the VM to count mispredicts), and the reference
interpreter's speed (only tests use it).

## Not to do

- Plain (non-atomic) guest accesses in the shipped core: they're UB under parallel SMP in Rust; measure first (Next 4).
- Lazy NZCV in the hot loop's locals (−4%).

## When done

Write the outcome into docs/cpu.md "The block interpreter", close the backlog's items that were done, update
CLAUDE.md's status and PLAN.md, and delete this file in that commit.
