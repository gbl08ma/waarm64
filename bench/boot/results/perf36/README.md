# PERF loop 36: host returns that landed elsewhere (2026-11-21)

The data behind `bench/boot/REPORT.md` "PERF loop 36".

- `diag.patch` (on 3d71d489): the diagnostic core (`--features diag`). `ret_up` stores its RET's VA in the vCPU's
  tally slot 15; a host call's return elsewhere than its continuation calls `jit_diag_ret(vcpu, continuation)`, which
  keeps a histogram by (RET VA, continuation, PC, ASID | EL << 20) with the words around each the first time
  (16 up to the RET, the call before the continuation, PC−8..PC+4) and X30; `jit_helper_report` prints them as
  `R:<ret>,<cont>,<pc>,<asid>,<words> <count>` and tally slots 0-47 as `T:<i>`. Tallies added: 13 / 14 a member's
  `ret_up` at depth > 0 in a region that followed a call to it, with / without a predicted return; 16 a followed call
  (a block ending in BL whose callee is a member); 17 a member taken inside a followed call reaching its exits (not
  BL/BLR/RET).
- `diag-fix.patch`: the same plus the loop's rule (`forward` / `walk` / `Region::open_call`).
- `diag-base-marks.json`, `diag-fix-marks.json`: `bench/boot/userprof.ts` (Alpine's userspace benchmark in Node, the dev
  VM) with each core; `node rets.ts <marks.json> [top]` tabulates the histogram and the tallies per phase.
- `perf36-r<round>-r1-<arm>-<bench>.json`: `bench/interp/ab-mac.sh` on the Mac (M4, Chrome for Testing 158.0.8127.36),
  one round a call; `base` 3d71d489, `fix` the loop's core. Base first in rounds 1 and 3, fix first in round 2.
- `codestats.json`: `bench/jit/codestats.ts` over both arms' modules of Alpine's boot (`bench/jit/dump-modules.ts`,
  deterministic: 319 and 317 modules).
