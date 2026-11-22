# PERF loop 50: followed calls whose callee completes inside the region, counted (2026-11-22)

The data behind `bench/boot/REPORT.md` "PERF loop 50".

- `diag.patch` (on 5cabcc62): the diagnostic tallies. Slot 14 counts a followed call run (a member ending in a BL that
  `Region::follows`), slot 15 a predicted return taken (the `ret` of a followed callee, back inside the region).
  Compile-time `WAARM64_FOLLOW_ALL` makes `block::forward` keep its first walk (no `open_call` demotions: every callee
  the walk takes is followed, with loop 37's rules for which call follows). Built twice:
  `CARGO_TARGET_DIR=target/diag scripts/build-wasm.sh --features diag` (today's rule) and the same with
  `WAARM64_FOLLOW_ALL=1 CARGO_TARGET_DIR=target/diag-all`.
- `diag.json`, `diag-all.json` (and `.txt`): `bench/boot/preempt-counts.ts --json … boot user` with each core (the
  dev VM, Node; with the patch's two names added to its `JIT` list). Slot 11 is host calls, 12 host returns.
- `userprof-diag.json`, `userprof-diag-all.json`: `bench/boot/userprof.ts` with each core (the regions, modules and
  wasm bytes per phase).
- `calls/`: what a host call costs against a followed call. `calls.c` (built as bench/interp/build.sh builds
  guest.bin: `clang --target=aarch64-linux-gnu -O2 -ffreestanding -nostdlib -static -fno-stack-protector -fno-pie
  -fuse-ld=lld -Wl,-T,../../../../interp/guest.ld -Wl,--defsym=BASE=0 -mgeneral-regs-only [-DHOST] -o x.elf calls.c`,
  `llvm-objcopy -O binary`, into `follow.bin` and `host.bin`): f calls four leaves; in `host` each leaf has a cold
  tail call through a pointer, so f's region can't follow them (host calls), in `follow` a `csel` of the same
  constant instead (followed). `node calls.ts [rounds]` runs them alternated through `bench/interp/suite.ts`'s
  `setup` (flat memory, the JIT's defaults). `mac.txt` (the Mac, Node 26.10.0) and `vm.txt` (the dev VM).
