# PERF loop 27: sharing X-register locals, estimated (2026-11-14)

The data behind `bench/boot/REPORT.md` "PERF loop 27". No core change was kept.

- `diag.patch`: the diagnostic core (on b262da7f). The emitter records which X registers each instruction touches
  (`Func::local`, `Func::reg`); `block::diag_colors` drops each register's local after its last touch and colours the
  held masks; `block::module` emits every function Liftoff fills a second time with a prologue that adds its fill's
  turns today and with sharing to two statics, reported through the Stats counters `flagsStored` (calls),
  `flagsElided` (turns today) and `condDirect` (turns with sharing). As in the patch it models regions (`diagw`); with
  `if r.looped() || r.blocks.len() > 1` in place of `if r.looped()` it models single blocks only (`diag1w`). An
  earlier form of the same patch put the static counts in the five counters (`counts.txt`'s first part).
- `tools/estimate.ts capture <core> <dir> alpine|user`: perf26's `locals.ts capture` with this patch's print.
- `counts.txt`: the numbers.
