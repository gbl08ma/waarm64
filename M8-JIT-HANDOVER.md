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

Measured and closed (don't redo): copies of compiled callees in callers, a region entered at more
than one block, forward regions behind a tier-up, exact limits for the core's own memory, the
shared cache's single-threaded phases (docs/jit.md "Tried and not kept", the backlog).

## Next

docs/backlog.md "JIT", top down. The user-space levers left there are small; the larger open items
are llvmpipe (GL desktops), coldest-first eviction (working sets past 160 MiB) and the 2–4 s
`vm_run_cpu` calls (latency).

## How to measure

```sh
node bench/boot/userprof.ts                      # Node: per phase, MIPS, dispatches, regions, bytes (~25 s)
WASM=a.wasm node bench/boot/userprof.ts          # another build; alternate two for a quick A/B
npm run bench -- --page bench/boot/index.html --only alpine_user_jit --out <json>   # Chromium, the number that counts
bench/run-mac.sh <name> --page bench/boot/index.html --only alpine_user_jit         # the Mac host's Chromium
```

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
- JIT-check and the tests' forced mode form forward regions from any block in reach; JIT-stress (a
  block per batch) makes none. The stale-code checker runs at a region's entries and back-edges.
