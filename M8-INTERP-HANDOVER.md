# M8 interpreter speed: handover (2026-10-21, after loops 0-6)

**The goal is the block interpreter's own speed**, so the compile threshold can rise and less code reaches V8. Loops
0-6 ran on 2026-10-21 (`bench/interp/REPORT.md` from "M8-INTERP loop 0"; docs/cpu.md "The block interpreter",
"Its speed" and "Tried and not kept"; docs/jit.md "Compile policy"):

- **Kept:** one call-free hot loop (`interp::block::hot`, loop 1); reports every 255 dispatches where nothing
  compiles (`REPORT_IDLE`, loop 2); a run of MOVs in one dispatch (loop 4); UMADDL & co, EXTR, RBIT/REV/CLZ as
  handlers (loop 5); the compile threshold's floor at 500, then 1000 in a second round (250-2000 screened), and one report from `warm` to the threshold (loop 6). MRS, SIMD&FP loads/stores and LSE handlers were screened in round 2 (+0-1.5%, not kept: their diffs are in `bench/interp/results/m8-interp-r2/handlers/`). The interpreter alone: user-mode guest 249 → 424
  MIPS, EL1 176-198 → 412-416, Buildroot's boot 89 → 114, Alpine's 122 → 172 (dev VM; Mac host before loop 4: 261 →
  427, 232 → 404, 104 → 144, 138 → 182). Firefox's pages session compiles 271 → 218 MB of wasm with the floor and → 172 with the report (two sessions
  of A/B each), busy MIPS 181 → 185 and 187 → 194.
- **Tried and not kept:** lazy NZCV (loop 3), a flag setter fused with its B.cond (+1%; with the MOV runs −2%),
  pre-linked successors (at most 1-1.5%), the micro-op copied whole, the literal load inline, reports every 255 in
  the JIT.

What's left, in order. The yardstick and the rules are as before: interpreter MIPS on the small guests at eight
placements and the boots under `jit` 4 (`bench/interp/yardstick.sh`; A/B with `bench/interp/ab.sh`, the Mac with
`bench/interp/ab-mac.sh`), `--config liftoff-only` for the reference; JIT changes with the churn page, the pages
session, the `go build` loop and the gates (docs/benchmarking.md "Screening an A/B").

## 7. One decoded-block store shared by the tables (not started)

Docs/backlog.md "Interpreter", first item: each vCPU's table decodes the same code again. A shared arena with an
epoch scheme like the code cache's `drops` gives each table the whole budget and decodes once. The floor of 500
doubled the interpreted steps (Firefox's pages session 1.1 → 2.1 G), so it's worth more than when the backlog
priced it. Measure with the 4-vCPU Chromium renders (`bench/apps/chromium.ts`) and Firefox's pages session.

Design notes (not built; the second round's time went to the floor and the handlers):
- **What's shared and what isn't.** The micro-ops and the key → (start, len) map are shared (one `Arc`, beside the
  JIT `Cache`); each table keeps its own slots (key, start, len, quota, hits): the counting stays per table, as
  `Cache::miss` expects (`n` reported per table), and `hot` reads only the slot and the arena, so its loop doesn't
  change.
- **Appends without a lock on the read side.** The arena is one fixed allocation of the VM's whole budget (16M
  micro-ops, 256 MiB), never moved; a writer reserves its range with an atomic `fetch_add` on the fill, writes the
  micro-ops, then publishes (start, len) in the shared map under a mutex (decodes are rare: ~140K in Alpine's boot,
  the lock is cheap there). A table that misses its slot looks in the shared map (under that mutex) before it decodes.
  Two tables decoding the same key at once both append; the second insert loses and its range is garbage until the
  arena starts over (counted, bounded).
- **Starting over: an epoch, as the code cache's `drops`.** When the fill reaches the budget, the writer bumps an
  epoch (`AtomicU64`) and the arena restarts only when no table runs from it: every table holds the epoch it entered
  `hot` with in a per-table word, and the restart waits (or, simpler, defers: keeps appending into a second half) until
  every table has passed `Jit::fresh` with the new epoch, where it clears its slots (the `drops` path does the same for
  compiled code). With two halves, a table on the old epoch reads micro-ops that stay valid until the epoch after.
- **Invalidation** (`IC IVAU`) stays per table: each table drops its slots for the page when it catches up with the
  `ival_log`; the shared map drops the page's keys under its mutex, so a later miss decodes the new words. Stale
  micro-ops in the arena are only reachable from slots, which the catch-up clears before the vCPU runs another block.
- **Cost to check first:** the shared map's mutex on every slot miss (Chromium in Debian: ~2M misses a warm render on
  4 tables); if it shows, a lock-free read side (the map as a fixed open-addressed table of (key, start|len) words,
  written with a CAS) is the next step.

## More handlers, measured on the small guests too

MRS of the plain registers (28% of the generic path in Alpine's boot), FP and SIMD loads and stores and LSE are
written, tested (the differential test draws them; MRS has its own test over every key `sys::plain` knows) and
screened once: +0-1.5% on the boots under `jit` 4 (`bench/interp/REPORT.md` "M8-INTERP round 2"; the diffs in
`bench/interp/results/m8-interp-r2/handlers/`, against `b2fdaea`). Next: repeat that A/B (two rounds) and run the
pages session with them, where memcpy's Q pairs should count; then the exclusives. Each handler in `hot` is code its hot path carries (the literal load inline cost the user-mode guest
4-5%); put rare ones in `run` only, where `hot` sends them through the slow path. A browser's mix wasn't counted:
`bench/interp/results/m8-interp-l0/diag.patch`'s core crashed the session (the page's error: its `diag_log` shim made
a `Uint8Array` at a heap pointer past 2 GiB, read as negative; the patch now has `p >>> 0`). Run it again first.

## Not to do

- Threaded dispatch through tail calls: loop 0 didn't show the dispatch branch mispredicting more than a jump
  table's (the handlers' first instructions take ~20% of `run`'s samples, the M4's redirect).
- Plain (non-atomic) guest accesses: `ldar`/`stlr` were 0.24% of `run`'s samples. Nothing to bring to the user.
- Lazy NZCV in the hot loop's locals (−4%), and the setter + B.cond fusion (+1%, −2% beside the MOV runs).
- Loop 4 for its own sake: the counted pairs have no other run as long as the MOVs' (`results/m8-interp-l0/mix-*.txt`).

## When done

Write the outcome into docs/cpu.md "The block interpreter", close the backlog's items that were done, update
CLAUDE.md's status and PLAN.md, and delete this file in that commit.
