# PERF loop 26: Liftoff's zero-fill (2026-11-14)

The data behind `bench/boot/REPORT.md` "PERF loop 26".

- `perf26-r<round>-r1-<arm>-<bench>.json`: `bench/interp/ab-mac.sh` on the Mac (M4, Chrome for Testing 157.0.8103.78),
  one round a call; `base` the core at c3af2c77 (`bench/results/local/perf25/new.wasm`, 9,418,983 bytes), `pad` the
  same with `pad.patch` (9,420,050 bytes): 21 unused i64 locals more in every function Liftoff zero-fills, which
  doubles its fill (42.4 → 84.3 loop turns a filled function) and changes nothing else TurboFan sees. Base first in
  rounds 1 and 3, pad first in round 2.
- `counts.txt`: `tools/locals.ts sum` over every JIT module of the FP guest (300 M steps), Alpine's boot and its
  userspace benchmark in Node, captured with `tools/locals.ts capture <core> <dir> fp|alpine|user`; `base-*` the core
  before PERF loop 23 (`bench/results/local/perf23/base.wasm`), `new-*` c3af2c77, `pad-*` the pad arm. Then the
  locals by role in the filled functions (a diagnostic core) and `tools/fillcost.mjs`'s cost of a fill a call.
- `hist-alpine.txt`: `tools/hist.ts`, Alpine's boot's functions by declared locals (`+`: one not i32/i64); the
  1-local ones are mostly the modules' NZCV helpers.
