# M8 JIT performance: handover (2026-10-08)

A side track of M8, asked for by the user: make general user-space work faster under the JIT. Not
a milestone phase and it has no kickoff. What was built is in docs/jit.md (and docs/abi.md "A
fixed-size memory"); the measurements are in `bench/boot/REPORT.md` from "M8: where the userspace
benchmark's time goes" on; what's open is docs/backlog.md "JIT", most promising first.

## Where it stands

`alpine_user_jit` in Chromium on the dev VM went from 24.2 s (`d43a536`) to ~18 s: cross-page
chaining by VA, forward regions, the transfer cache, the fixed-size memory, then fewer, larger
modules (−4.2%). The boots: Alpine's ~9.95 → 8.6 s, Buildroot's 768 → 667 ms. On 4 vCPUs the
shared code cache is 25% faster than a cache per vCPU in every phase (rechecked 2026-10-08). On the
Mac host's Chromium the userspace benchmark is ~14 s (no explicit bounds checks there: check work
on the Mac before ranking it by a VM profile, docs/benchmarking.md).

llvmpipe (2026-10-08): profiled with `gl_llvmpipe_jit` (`images/alpine/gl`, a compositor's GLES
frame without a display); ~95% of its rasterizing was helper calls for NEON the JIT didn't inline.
With it inline a frame is 15.6× faster on 1 vCPU (6,936 → 445 ms) and 18.6× on 4 (1,859 → 100
ms), ~14–17× native (`bench/boot/REPORT.md` "M8: llvmpipe"). The user confirmed sway on llvmpipe
is faster on the page; its glitches (frames a flip or two late) remain, a display question for
another time (plans/graphics.md §16), not the JIT's.

Measured and closed (don't redo): copies of compiled callees in callers, a region entered at more
than one block, forward regions behind a tier-up, exact limits for the core's own memory, the
shared cache's single-threaded phases (docs/jit.md "Tried and not kept", the backlog).

## Next: vector registers in locals

The user's choice for the next session (docs/backlog.md "JIT": "Vector registers in locals";
docs/jit.md "Tried and not kept" says why it wasn't built before). Today every inline NEON/FP
instruction loads its operands from `Cpu::v` (`VCPU` + `V + 16 * n`) and stores its result back,
so a chain of dependent vector instructions pays a store-to-load round trip per instruction.

**Start by re-profiling.** No profile was taken after llvmpipe's NEON went inline. Repeat the one
in `bench/boot/REPORT.md` "M8: llvmpipe" (perf with `--perf-prof` on the guest of
`gl_llvmpipe_jit`, split with `bench/boot/userprof-perf.ts`; the ad-hoc driver was
`bench/results/local/llvmpipe/run.ts`, git-ignored: a copy of `userprof.ts`'s loop with
`target/images/alpine-gl/rootfs-gl.ext4`, `webpc.lp=0 webpc.gl=10,3,1376,762` on the command line).
The guest code's share of the rasterizing phase should now dominate; if it doesn't, the lever is
elsewhere. `--print-wasm-code` on one hot shader block shows the V loads and stores directly.

**Baselines** (`d659d18`/`f997fa0`, Chromium 153, dev VM): `gl_llvmpipe_jit` 445 ms a frame,
`gl_llvmpipe_jit_4` 100 ms; Node's rasterizing phase 4.2 s for 10 frames at ~1150 MIPS;
`alpine_crypto_jit` (AES-CBC, the other workload the backlog names; latency-bound per
`bench/interp/REPORT.md` M6.5); `alpine_user_jit` ~18 s and the boots must not regress.

**Where the code is:** the integer registers already live in locals; their model is the one to
extend (docs/jit.md "Emission": `Regs { valid, dirty }` in `emit.rs`, loaded on first use, written
back before helper calls and returns, dropped after a helper; `fallback()` flushes before the
helper and reloads the fast path's state after; regions give each member a fixed entry state from
a first emission). V accesses to route through a new cache: `vreg`/`put` in `emit/simd.rs`,
`vreg`/`vput` and the scalar `F::load`/`put` in `emit/float.rs`, `emit/crypto.rs` (13 sites),
`vload`/`vstore` and `ldst_fp` in `emit.rs` (loads and stores of V registers). Helpers read and
write `Cpu::v` directly, so dirty V locals must be stored before every helper call (including the
FP fast paths' own fallbacks) and dropped after. Locals: VT 119–122 and VTMP 124 are v128 scratch
today. **Liftoff zero-initializes every declared local on every call** (`bench/interp/REPORT.md` M5
step 6: unused locals cost it ~18%): declare only the V locals a function uses (`compact_locals`)
and keep once-read V registers as plain loads, as for the integer registers; check `jit_mips`
and the boots under Liftoff as well as TurboFan.

**Tests:** the differential test's NEON, FP and load/store classes and its sequences ("SHA rounds
and NEON", "AES rounds and NEON": sequences are where register state crosses instructions), the
golden corpus through the JIT, lockstep, the exact-step boots. Plant: a dirty V register not
written back before a helper; a V local not dropped after one; a region edge that doesn't conform
the V state. Single-instruction classes can't see the first two: add sequence classes that mix
inline NEON with helper-only instructions (e.g. FMLA on doubles, LD2) on the same registers.

**Other open items** (docs/backlog.md "JIT", top down): coldest-first eviction (working sets past
160 MiB), the 2–4 s `vm_run_cpu` calls (latency).

## How to measure

```sh
node bench/boot/userprof.ts                      # Node: per phase, MIPS, dispatches, regions, bytes (~25 s)
WASM=a.wasm node bench/boot/userprof.ts          # another build; alternate two for a quick A/B
npm run bench -- --page bench/boot/index.html --only alpine_user_jit --out <json>   # Chromium, the number that counts
bench/run-mac.sh <name> --page bench/boot/index.html --only alpine_user_jit         # the Mac host's Chromium
```

For NEON-heavy guests: `--only gl_llvmpipe_jit` (and `_4`); per-encoding helper counts with the
lanes' FP classes: `bench/boot/results/m8-llvmpipe/helper-classes.patch`.

A/B in Chromium: keep each build's `webpc_core.wasm` aside, copy one into `target/…/release/`, run,
alternate (A, B, A, B), check `sha256sum` before each run. Also `boot_alpine_jit`, `boot_jit`,
`smp_user_jit_4`, and on `bench/interp/index.html` `jit_coremark_mips`, `vm_jit_mmu_mips`,
`jit_mips`. Per-phase, per-vCPU counters on N parallel vCPUs in Node: `boot()` from
`bench/boot/suite.ts` with `parallel: true` and an `onMark` that records `vm.cpuStats()`.
Diagnostic counters without new ABI: append `<letter>:<n> <count>` lines to
`Table::helper_report` (patches in `bench/boot/results/m8-userprof/` and `m8-entries/`).

## Learned

- **`../webpc-base/target` is a symlink to this checkout's `target`:** a build there overwrites
  this checkout's `webpc_core.wasm` (hard-linked). Rebuild here after building there.
- **A Node gain may not reach Chromium** (scalar `UQSUB` inline: compress −9.5% in Node, nothing
  measurable in Chromium). Confirm in Chromium before claiming; Node boot profiles also vary by a
  few percent between identical runs.
- **Four concurrent guests slow down by themselves on this host** (4 P-cores + 6 E-cores): four
  independent 1-vCPU VMs ran Lua 3–6%, SQLite 11–15%, compress 22% slower than one alone. Compare
  N-vCPU runs with N-vCPU runs.
- **In round-robin SMP one JIT cache serves every vCPU**, each with its own TLB: state derived from
  the cache but kept per vCPU must notice the cache's changes per vCPU (`Cache::drops` against
  `Tlb::xdrops`; a one-shot flag was consumed by whichever vCPU ran next).
- **Code read twice can differ on parallel vCPUs**: read guest code once per decision. A repeated
  boot loop (500 boots in ~5 min) is what finds such races; CI only sometimes.
- **Debugging a bad table index** (a "function signature mismatch" in a worker): dump every index
  the vCPU's JIT state can call (jump cache, hot-word redirects, transfer cache) at the trap and
  test each against the worker's table.
- **Counting in JIT code without new counters:** bump `Tlb::stats.misses` / `.flushes` from wasm
  (an `i64` load, add, store at their `Vcpu` offsets); `userprof.ts`'s TLB columns show them.
- **A test that waits for a shell should never match the console's end** (`trim.test.ts` failed 1
  in 40 under load until it counted prompt lines).
- **LLVM deletes an `alloc`/`dealloc` pair nothing uses:** pass the pointer through
  `core::hint::black_box`.
- **`/tmp` is a 6.9 GB tmpfs:** keep `perf record` data in `bench/results/local/perf/`.
  `bench/run.ts --out /dev/null` writes `dev/null` in the repo.
- **`tsc` checks `bench/results/local/` too:** keep ad-hoc `.ts` in the scratchpad while CI runs.
  `scripts/ci.sh` runs native tests from the working tree: don't edit `core/` while it runs.
- **The Mac host shares its cores with the VM:** run nothing there during CI or a VM benchmark; a
  failed page leaves `bench/run.ts` and Chrome for Testing idle there (`ssh macmini.lan 'ps -axo
  pid,command | grep -E "bench/run.ts|ms-playwright"'`).
- **Vector fast paths need every lane on the fast path**, so random V registers almost never run
  them: planted bugs in FCVTN's rounding and bounds went unnoticed until the differential test
  filled whole registers with one lane size, mostly plain values (`fpPlain`), ties and the next
  format's range edges. Plant a bug in each new vector rule and check it's caught.
- **Read CI's result before committing or pushing** (`aee50b9` went out with a failed run). A test
  that fails only under CI's load (JS tests beside the native ones) isn't reproduced by running it
  alone; re-run CI and compare with the build before (`../webpc-base`).
- **Input timed by steps is wrong in parallel mode**: the vCPUs' summed steps say nothing about
  how far the boot is (the browser console-input test sent its input before init under load; fixed
  in `f997fa0` by waiting for the prompt).
- JIT-check and the tests' forced mode form forward regions from any block in reach; JIT-stress (a
  block per batch) makes none. The stale-code checker runs at a region's entries and back-edges.
