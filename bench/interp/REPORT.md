# M1 interpreter MIPS baseline

**What runs:** the tier-0 interpreter (`core/src/interp.rs`) in wasm, on shared memory in a dedicated worker, through the vCPU exports (`interp_run`). The guest is `guest.c`, bare metal on flat memory, built by `build.sh` into the committed `guest.bin` (clang 22.1.8, `-O2 -mgeneral-regs-only`). It's a loop over a table-driven CRC32, insertion sort, a 16×16 integer matrix multiply, a linked-list walk and byte-string work.
**Method:** `node bench/run.ts --page bench/interp/index.html --config <config>`. Cold is the first 2M instructions after instantiation (one sample). Warm is 15 samples of 20M instructions each, taken after 3 warm-up chunks.
**Date:** 2026-09-25, code at commit `fa617211a391`. The x86_64 JSON says `dirty` only because `M1-KICKOFF.md` was untracked. The Mac copy was an rsync of that tree with the same wasm bytes, not a git checkout, so its `commit` is null.

| Host | Chromium | Config | Cold (MIPS) | Warm median (MIPS) | IQR |
|---|---|---|---|---|---|
| Ryzen 7 5800X3D, Linux x86_64 | 152.0.7977.75 | default | 68.3 | **91.0** | ±0.06 |
| | | turbofan-only | 57.7 | 83.7 | ±0.38 |
| | | liftoff-only | 23.9 | 24.1 | ±0.08 |
| Apple M4, macOS 26.6 arm64 | 153.0.8010.12 (Chrome for Testing) | default | 104.2 | **148.8** | ±3.84 |
| | | turbofan-only | 82.5 | 138.5 | ±4.59 |
| | | liftoff-only | 34.1 | 36.6 | ±0.52 |

Raw data: `results/chromium-{linux-x86_64,darwin-arm64}-{default,turbofan-only,liftoff-only}.json`.

**Notes**
- An earlier x86_64 default run on a dirty tree measured 83.9 MIPS against 91.0 here, so treat about ±8% as noise on this shared desktop. The default vs turbofan-only gap is within that noise on both hosts.
- Liftoff is 3.8× (x86_64) and 4.1× (M4) slower than TurboFan on the interpreter. Tier-up happens early: even the cold 2M instructions run mostly in TurboFan code.
- Every instruction does a fetch through `Mem::host`, a bucket decode and a `match` dispatch, with no decode cache (`ponytail:` note in `interp::step`). That's the obvious lever if the interpreter's speed ever matters beyond being the JIT's fallback and reference.
