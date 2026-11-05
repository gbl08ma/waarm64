# What a function's size costs, in the VM and on the Mac (2026-11-05)

`bench/boot/REPORT.md` "What a function's size costs, in the VM and on the Mac".

- `pad.patch`: 150 dead ops at every JIT function's entry (`block.rs` `emit_region`); `nzcv-helpers.patch`: the
  failure chains' and slow arms' NZCV through the module's helpers (built and tested, no A/B).
- `vm/`, `mac/`: each session's results, busy MIPS (`stalls.json`) and the JIT's counters (`jit.jsonl.gz`); the VM's
  also the renderer's RSS; `summary.txt` each.
- `sizes.mts.txt`: machine code per guest function by tier, from a `--perf-prof` jitdump.
