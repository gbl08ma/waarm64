# M8 interpreter speed: handover (2026-10-21, after loops 0-6)

**The goal is the block interpreter's own speed**, so the compile threshold can rise and less code reaches V8. Loops
0-6 ran on 2026-10-21 (`bench/interp/REPORT.md` from "M8-INTERP loop 0"; docs/cpu.md "The block interpreter",
"Its speed" and "Tried and not kept"; docs/jit.md "Compile policy"):

- **Kept:** one call-free hot loop (`interp::block::hot`, loop 1); reports every 255 dispatches where nothing
  compiles (`REPORT_IDLE`, loop 2); a run of MOVs in one dispatch (loop 4); UMADDL & co, EXTR, RBIT/REV/CLZ as
  handlers (loop 5); the compile threshold's floor at 500, and one report from `warm` to the threshold (loop 6). The interpreter alone: user-mode guest 249 → 424
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

## More handlers, measured on the small guests too

MRS of the plain registers (28% of the generic path in Alpine's boot), FP and SIMD loads and stores, LSE and the
exclusives. Each handler in `hot` is code its hot path carries (the literal load inline cost the user-mode guest
4-5%); put rare ones in `run` only, where `hot` sends them through the slow path. A browser's mix wasn't counted:
`bench/interp/results/m8-interp-l0/diag.patch`'s core never got Firefox's pages session's first command through
(three tries); find out why before counting there.

## Not to do

- Threaded dispatch through tail calls: loop 0 didn't show the dispatch branch mispredicting more than a jump
  table's (the handlers' first instructions take ~20% of `run`'s samples, the M4's redirect).
- Plain (non-atomic) guest accesses: `ldar`/`stlr` were 0.24% of `run`'s samples. Nothing to bring to the user.
- Lazy NZCV in the hot loop's locals (−4%), and the setter + B.cond fusion (+1%, −2% beside the MOV runs).
- Loop 4 for its own sake: the counted pairs have no other run as long as the MOVs' (`results/m8-interp-l0/mix-*.txt`).

## When done

Write the outcome into docs/cpu.md "The block interpreter", close the backlog's items that were done, update
CLAUDE.md's status and PLAN.md, and delete this file in that commit.
