# M8 JIT performance: handover (2026-10-03)

A side track of M8, asked for by the user: make general user-space work faster under the JIT. Not
a milestone phase and it has no kickoff; the order of work is docs/backlog.md "JIT", "User space".
Everything measured is in `bench/boot/REPORT.md` from "M8: where the userspace benchmark's time
goes" on.

## Where it stands

Five commits on `main`, pushed, each with CI and `ci-long` green and the same guest steps:

| Commit | What | `alpine_user_jit` total (Chromium, dev VM) |
|---|---|---|
| `d43a536` | before | 24.2 s |
| `fe10685` | the profile, the tools (`bench/boot/userprof.ts`, `userprof-perf.ts`) | |
| `939987b` | a direct branch to another page chains by the target's VA | 23.0 s |
| `311d21e` | forward regions: a batch's blocks that static edges join are one function | 20.9 s |
| `44dcda9` | regions across pages, calls followed with predicted returns; `bench/run-mac.sh`; a parallel-SMP panic in `311d21e`'s plan fixed | 20.5 s |
| this one | the transfer cache: indirect transfers by VA in one probe (lever 1 below) | 20.1 → 19.8 s in one session |

On the **Mac host's Chromium** (no explicit bounds checks): 18.0 → 14.6 → 14.3 s. QEMU TCG: 11.2 s.
Lua −28%, SQLite −27% in the VM over the day; CoreMark 8,480 → 10,080 it/s. The cost: Alpine's
boot compiles 25% more wasm (23.6 → 29.6 MB) and Buildroot's half-second boot is 15% slower.

## What the measurements settled

- **The dev VM pays explicit wasm bounds checks that macOS and x86_64 don't: 47% of the userspace
  benchmark.** Forced on, the Mac takes 21.5 s, as the VM does. Profiles taken in the VM overstate
  what a region's write-backs cost a real user. Check on the Mac (`bench/run-mac.sh`) before
  ranking work by a VM profile.
- A region takes only blocks of **its own batch**. A shared callee is compiled long before its
  callers, so most calls and returns still leave a function. Copying compiled callees into callers
  was tried and lost (docs/jit.md "Tried and not kept").
- Forward regions behind a tier-up (a counting prologue in every block) cost the boots 13 to 20%.
  Forming them at batch time is what was kept.

## The two levers (the user asked for both): the first done, the second next

**1. Done: the transfer cache** (docs/jit.md "Linking", `bench/boot/REPORT.md` "M8: a VA-keyed
cache for indirect transfers"). `BR`, `BLR`, `RET` and by-VA links probe `Tlb::xc` (16,384
entries per vCPU), where they probed the instruction TLB and then the jump cache: Lua −9%, SQLite
−5 to −6%, the userspace total −1.4% (VM) and −2.8% (Mac); Alpine's boot +1% (VM and Mac) and
Buildroot's +1.5%. What differs from the design the last handover sketched, and why (measured,
in the report): a miss falls back in wasm to the old lookup and fills the entry (the
dispatcher-only fill tripled dispatches in churn); the generation is per EL and kept for global
code across ASID changes, and a TLBI by VA clears only its page (most flushes are by VA); the
fallback is one shared pair of functions in table slots 0 and 1 (a copy per module stayed in
Liftoff); 4096 entries were too few.

**2. The fixed-size memory** (Linux arm64 and Android hosts only: no gain on the Mac). V8 reloads
a growable shared memory's size before every checked store; a module that declares
`initial = maximum` loads it once. The idea to verify first, which avoids writing an allocator:

- `bootVm` creates the memory with `maximum` = the planned final size, the core reserves its heap
  (a new export that allocates and frees one big block: std's dlmalloc keeps it and never needs
  `memory.grow` again), RAM is grown as today, the host grows the rest, and the core is told the
  page count; JIT modules then import the memory as `(pages, pages)`.
- **Verify before building on it** that V8 drops the reloads for a module declaring exact limits
  on a memory that was grown to its maximum (`node tools/v8code.ts`, or count `ldur x, [x7, #39]`
  in `perf annotate`), and that the heap reserve costs no RSS.
- If the core's heap outgrows the reserve the VM traps: size it generously and run the snapshot
  tests in that mode. It is an ABI change (bump `ABI_VERSION`, `tests/browser.test.ts`, docs/abi.md).

## How to measure

```sh
node bench/boot/userprof.ts                      # Node: per phase, MIPS, dispatches, regions, bytes (~25 s)
WASM=a.wasm node bench/boot/userprof.ts          # another build; alternate two for a quick A/B
npm run bench -- --page bench/boot/index.html --only alpine_user_jit --out <json>   # Chromium, the number that counts
bench/run-mac.sh <name> --page bench/boot/index.html --only alpine_user_jit         # the Mac host's Chromium
```

A/B in Chromium: keep each build's `webpc_core.wasm`, copy one into `target/…/release/`, run,
alternate (A, B, A, B). Also `boot_alpine_jit`, `boot_jit`, and on `bench/interp/index.html`
`jit_coremark_mips`, `vm_jit_mmu_mips`, `jit_mips`. The diagnostic patches in
`bench/boot/results/m8-userprof/` (dispatch reasons, transfers by kind) are diffs against
`d43a536` and no longer apply: the counters are a dozen `emit::bump` calls, quick to redo.

## Learned this session

- **In round-robin SMP one JIT cache serves every vCPU** (it moves between their `jit.cache`,
  `vm.rs`), while each has its own TLB. State derived from the cache but kept per vCPU must
  notice the cache's changes per vCPU: a one-shot "dropped" flag was consumed by whichever vCPU ran
  next, the others ran dropped blocks (CI's `maint.bin` under JIT-stress panicked, and
  `pause.test.ts` hung for 21 minutes). `Cache::drops` against `Tlb::xdrops` is the fix.

- **Counting in JIT code without new counters:** a measurement-only build that bumps
  `Tlb::stats.misses` / `.flushes` from wasm (an `i64` load, add, store at their `Vcpu` offsets)
  shows up in `userprof.ts`'s TLB columns. How the transfer cache's misses were found.
- **`/tmp` is a 6.9 GB tmpfs:** keep `perf record` data out of the scratchpad (a few profiles
  filled it); `bench/results/local/perf/` is on disk. `bench/run.ts --out /dev/null` writes
  `dev/null` in the repo, and `--only` takes one benchmark.
- Node profiles of the boot vary by a few percent between identical runs (one showed the
  interpreter 27% slower, the next not at all): confirm a boot difference in Chromium, alternated.

- **`scripts/ci.sh` runs its native guest-image tests and tsan beside the JS tests, from the
  working tree.** Don't edit `core/` (or rebuild the wasm) while it runs; `.md` edits are safe.
- The Mac host shares its cores with the VM: run nothing there during CI or a VM benchmark. A
  failed page leaves `bench/run.ts` and Chrome for Testing idle on the host: check with
  `ssh macmini.lan 'ps -axo pid,command | grep -E "bench/run.ts|ms-playwright"'` and kill them.
- **Code read twice can differ on parallel vCPUs** (another vCPU rewrites it in between): a plan
  that formed a region from a head's words after checking them once panicked, about one 2-vCPU
  boot in 20 to 200. Read guest code once per decision, or tolerate it changing; a repeated boot
  loop (500 boots in ~5 min) is what finds such races, CI only sometimes.
- JIT-check and the tests' forced mode form forward regions from any block in reach, so they
  cover regions well; JIT-stress (a block per batch) makes none.
- `maint.bin` without its `IC IVAU` no longer fails check 401 under the default JIT (either
  outcome is legal); the test requires only that JIT-check traps. The stale-code checker runs at a
  region's entries and back-edges; on every edge it made `ci-long`'s JIT-check litmus 24 min.
