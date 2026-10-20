# What Liftoff runs that a static change could cut: the counts (2026-10-20)

The data behind `bench/boot/REPORT.md` "M8: what Liftoff runs that a static change could cut". Each count comes
from a diagnostic core: a patch here applied to main at 9e680f9 (the failure chain), `scripts/build-wasm.sh`, the
core swapped in, then the source restored. The counts ride in the JIT's static counters (`Stats`'s flag and
condition counts), scaled by 10^6 above the real ones, so `results.json`'s `jit` holds them: `count // 10**6`.

- `count.patch` (Node only): accesses with a base register, and those after an access off the same unchanged base
  in the same straight run (same direction, any direction, through writebacks).
- `count-fp-const.patch` (Node only): instructions, MOVK, ADRP followed by an ADD of its register, scalar FP inline.
- `count-firefox.patch` → `pages/diagff-1`: Firefox's pages session (the Arch Linux ARM desktop disk, 4 vCPUs,
  `tools/pages.sh` in `../slowarms/tools/`): `flagsStored` instructions, `flagsElided` MOVK, `condDirect`
  accesses with a base, `condComputed` same-base same-direction followers, `condMemory` scalar FP inline.
- `count-locals.patch` → `pages/diagloc-1`, and with `no-base-local.patch` applied too → `pages/diagloc2-1`:
  per function compiled, its declared locals and whether Liftoff zero-fills them (`tools/locsum.py` reads them).
  `no-base-local.patch` keeps a load's or store's base in the BASE local only for a writeback or SP's alignment
  check (one local less where nothing else uses BASE).
- `tools/capture.ts <core> <dir> [alpine|user]`: Alpine's boot or its userspace benchmark under the JIT in Node,
  every module to `<dir>` and the counters printed; `tools/zerofill.mjs`: Liftoff's prologue for a function with
  n locals (V8 zero-fills past 12 locals, or with any not i32/i64).
