# M8 JIT performance: handover (2026-10-02)

A side track of M8, asked for by the user: make general user-space work faster under the JIT. Not
a milestone phase and it has no kickoff; the order of work is docs/backlog.md "JIT", "User space".
Everything measured is in `bench/boot/REPORT.md` from "M8: where the userspace benchmark's time
goes" on.

## Where it stands

Four commits on `main`, pushed, each with CI and `ci-long` green and the same guest steps:

| Commit | What | `alpine_user_jit` total (Chromium, dev VM) |
|---|---|---|
| `d43a536` | before | 24.2 s |
| `fe10685` | the profile, the tools (`bench/boot/userprof.ts`, `userprof-perf.ts`) | |
| `939987b` | a direct branch to another page chains by the target's VA | 23.0 s |
| `311d21e` | forward regions: a batch's blocks that static edges join are one function | 20.9 s |
| this one | regions across pages, calls followed with predicted returns; `bench/run-mac.sh`; a parallel-SMP panic in `311d21e`'s plan fixed | 20.5 s |

On the **Mac host's Chromium** (no explicit bounds checks): 18.0 → 14.6 s. QEMU TCG: 11.2 s.
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

## Next: two levers, in this order (the user asked for both)

**1. A VA-keyed cache for indirect transfers** (`BR`, `BLR`, `RET`, by-VA links: 25 to 55 per 1000
instructions, ~50 host instructions each today: the instruction TLB, then the 1 MiB jump cache,
then `return_call_indirect`). Helps every host. The design worked out, not started:

- In `mmu::Tlb`: 4096 entries of `{tag: pc ^ regime, to: idx | len << 32 | gen << 48}` and a
  generation `xgen` that starts at 1 and skips 0 (a zeroed entry must never match; clear the
  table when it wraps).
- `emit::indirect` with the MMU on becomes one probe: tag, generation, `left`, then
  `return_call_indirect`. A miss returns to the dispatcher, which fills the entry when it enters a
  compiled block (`jit::steps`). The flat bus keeps the jump-cache probe.
- Bump the generation in `Tlb::flush_all`, `flush_ng` and `flush_va`, and when the cache drops
  blocks: a `dropped` flag set by `invalidate`/`drop_all`, consumed in `steps` right after
  `cache.enter` (before any block runs).
- The risk to measure: an ASID switch now drops the kernel's entries too (its global iTLB entries
  survive today), so churn and the boots may pay refills through the dispatcher. If they regress,
  fall back in wasm to today's path on a miss and fill from there.
- Tests to extend: `tests/jit.test.ts`'s cross-page test already remaps with a TLBI (a flush
  without the bump is caught); add an `ic ivau` phase to it (threshold 0) for the drop flag. The
  byte patterns in `block::tests` (`a_successor_in_another_page_is_found_by_its_va`,
  `indirect_branches_look_up_the_jump_cache`, the forward-region test) will change.

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
