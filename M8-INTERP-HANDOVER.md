# M8 interpreter speed: handover (2026-10-21, after loops 0-6 and a second round)

**The goal is the block interpreter's own speed**, so the compile threshold can rise and less code reaches V8. What
ran on 2026-10-21 is in `bench/interp/REPORT.md` from "M8-INTERP loop 0" to "M8-INTERP round 2"; how things work now
in docs/cpu.md "The block interpreter" (with "Its speed" and "Tried and not kept") and docs/jit.md "Compile policy".

- **Kept:** one call-free hot loop (`interp::block::hot`, loop 1); reports every 255 dispatches where nothing
  compiles (`REPORT_IDLE`, loop 2); a run of MOVs in one dispatch (loop 4); UMADDL & co, EXTR, RBIT/REV/CLZ (loop 5)
  and MRS, the SIMD&FP loads and stores and LSE (round 2) as handlers; the compile threshold's floor at 500, then
  1000 (loop 6 and round 2), with one report from `warm` to the threshold. The interpreter alone on the dev VM:
  user-mode guest 249 → 424 MIPS, EL1 176-198 → ~410, Buildroot's boot 89 → ~114, Alpine's 122 → ~173. Firefox's
  pages session compiled 271 MB of wasm at the old floor of 50, 164 at 1000.
- **Tried and not kept:** lazy NZCV, the flag setter + B.cond fusion, pre-linked successors, the micro-op copied
  whole, the literal load inline, reports every 255 in the JIT, floors of 250 and 2000.
- **The tools:** `bench/interp/yardstick.sh` (the yardstick; `CONFIG=liftoff-only` the reference),
  `bench/interp/ab.sh` + `ab-summary.ts` (A/B on it, alternated), `bench/interp/ab-mac.sh` (the same on the Mac),
  `bench/interp/boot-node.ts` (a boot in Node for `perf`); JIT policy changes with the churn page, the pages session,
  the gates and the `go build` loop (docs/benchmarking.md "Screening an A/B").

## Next, ranked (expected payoff · evidence · how to test)

1. **Settle the floor of 1000 on the Mac host.** Payoff: certainty about the default. Evidence: on the Mac,
   one round, 1000 against 500 made Alpine's boot under the JIT 2.0% slower and its userspace 0.6% slower (the dev
   VM: +0.7% and −0.8%); its case is the browser sessions (less wasm, +9% busy MIPS on the dev VM), never run on the
   Mac (`bench/gpu/sway-mac.sh` runs a desktop guest there). The round-2 handlers were confirmed (+1.4%, +2.7%). Test: `bench/interp/ab-mac.sh
   r2 1 a0=<b2fdaea's core> h=<main's core>` on the yardstick, and `-- boot_alpine_mips_jit alpine_user_jit
   boot_mips_jit` with floors 500 and 1000.
2. **Loop 7: one decoded-block store for every table.** Payoff: a few percent on 4-vCPU browser workloads, more now
   that the floor of 1000 interprets more (Firefox's pages session 1.1 G steps at 50, 2.8 at 500, 3.3 at 1000).
   Evidence: Chromium in Debian on 4 vCPUs re-decoded ~1.5M blocks a warm render after full arenas; the 2× arena
   gained ~3.5% (`bench/apps/REPORT.md` "M8: the decoded blocks' arenas"). Test: the 4-vCPU Chromium renders
   (`bench/apps/chromium.ts`, ≥4 pairs), the pages session, and the yardstick (`hot` mustn't slow). Design below.
3. **Count a browser's mix, then add the handlers it asks for.** Payoff: unknown; the boots' generic path is now a
   few percent of their instructions, a browser's may differ (NEON and FP arithmetic, the exclusives, `DC ZVA`).
   Evidence: the boots' counts only (`bench/interp/results/m8-interp-l0/mix-*.txt`). Test: apply
   `bench/interp/results/m8-interp-l0/diag.patch` (its log shim now reads heap pointers past 2 GiB as unsigned:
   reading them as negative crashed the first try's vCPU worker), run the pages session from the snapshot with that
   core (`bench/gpu/ab.sh`), then `node bench/interp/results/m8-interp-l0/diag.ts <session>/results.json`.
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
7. **The exclusives (LDXR/STXR & co) and `DC ZVA` as handlers.** Payoff: ~1% on Buildroot's boot (the exclusives
   were 28% of its generic path), less on Alpine. Evidence: loop 0's mix. Test: as the round-2 handlers (the monitor
   stays in the `Cpu`; STXR a CAS as `Mem`'s); the differential test already draws LDXR/STXR.
8. **Superinstructions beyond the MOV runs.** Payoff: ≤1-2%; the setter + B.cond fusion gave +1% alone and lost
   beside the MOV runs. Candidates from the mix: `STR+STR`/`LDR+LDR` off one base (3.2% as pairs), `STP+STP` (2.4%),
   `ADRP+ADD` (0.5%). Test: one variant each on the yardstick; watch the user-mode guest, which any code in `hot` can
   slow.
9. **A guest-visible lever: fewer IC IVAU exits.** Payoff: unknown, possibly large for JIT-heavy guests. Evidence:
   Chromium in Debian issues ~4,000 ICs a second warm (docs/jit.md "Sharing"), each an exit and a page's decoded
   blocks dropped; Linux's `__flush_icache_range` steps by `CTR_EL0.IminLine`, so a larger IminLine means fewer ICs
   per flush (DIC isn't an option: the invalidation relies on the ICs). The user allows guest-visible changes that pay
   (2026-10-21): `tests/steps.txt` moves once, in that commit, and the corpus and kvm-unit-tests are checked. Test:
   the IC count and the renders in `bench/apps/chromium.ts`, the pages session.
10. **Re-profile `hot`, then register caching or another dispatch shape.** Payoff: unclear. Evidence: no profile was
   taken after loop 1; before it, every register write paid a wasm bounds check with the growable memory's size
   reloaded (backlog "The core's heap in a fixed memory", stage 2, would remove that), and the handlers' entries took
   ~20% of the samples (the jump table's redirect). Test: `perf` with `bench/interp/boot-node.ts alpine 4`, then
   variants on the yardstick.

Dropped by argument, not measurement: threaded dispatch through tail calls (a `call_indirect` is 2.5 ns on the M4,
more than a predicted jump-table branch; there's no PMU in the VM to count mispredicts), and the reference
interpreter's speed (only tests use it).

## Loop 7's design (not built)

- **What's shared and what isn't.** The micro-ops and the key → (start, len) map are shared (one `Arc`, beside the
  JIT `Cache`); each table keeps its own slots (key, start, len, quota, hits): the counting stays per table, as
  `Cache::miss` expects, and `hot` reads only the slot and the arena, so its loop doesn't change.
- **Appends without a lock on the read side.** The arena is one fixed allocation of the VM's whole budget (16M
  micro-ops, 256 MiB), never moved; a writer reserves its range with an atomic `fetch_add` on the fill, writes the
  micro-ops, then publishes (start, len) in the shared map under a mutex (decodes are rare: ~140K in Alpine's boot).
  A table that misses its slot looks in the shared map before it decodes. Two tables decoding one key at once both
  append; the second insert loses and its range is garbage until the arena starts over (counted, bounded).
- **Starting over: an epoch, as the code cache's `drops`.** At the budget the writer bumps an epoch, and every table
  clears its slots when it passes `Jit::fresh` with the new one (as the `drops` path does for compiled code); with
  two halves, a table still on the old epoch reads micro-ops that stay valid until the epoch after.
- **Invalidation** (`IC IVAU`) stays per table: each drops its slots for the page when it catches up with the
  `ival_log`; the shared map drops the page's keys under its mutex.
- **Check first:** the shared map's mutex on every slot miss (~2M misses a warm Chromium render on 4 tables); if it
  shows, an open-addressed table of (key, start|len) words written with a CAS.

## Not to do

- Plain (non-atomic) guest accesses in the shipped core: they're UB under parallel SMP in Rust; measure first (Next 4).
- Lazy NZCV in the hot loop's locals (−4%).

## When done

Write the outcome into docs/cpu.md "The block interpreter", close the backlog's items that were done, update
CLAUDE.md's status and PLAN.md, and delete this file in that commit.
