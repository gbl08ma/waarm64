# M8 JIT performance: handover (2026-10-03, third session)

A side track of M8, asked for by the user: make general user-space work faster under the JIT. Not
a milestone phase and it has no kickoff; the order of work is docs/backlog.md "JIT", "User space".
Everything measured is in `bench/boot/REPORT.md` from "M8: where the userspace benchmark's time
goes" on.

## Where it stands

Seven commits on `main`, pushed, each with CI and `ci-long` green and the same guest steps:

| Commit | What | `alpine_user_jit` total (Chromium, dev VM) |
|---|---|---|
| `d43a536` | before | 24.2 s |
| `fe10685` | the profile, the tools (`bench/boot/userprof.ts`, `userprof-perf.ts`) | |
| `939987b` | a direct branch to another page chains by the target's VA | 23.0 s |
| `311d21e` | forward regions: a batch's blocks that static edges join are one function | 20.9 s |
| `44dcda9` | regions across pages, calls followed with predicted returns; `bench/run-mac.sh`; a parallel-SMP panic in `311d21e`'s plan fixed | 20.5 s |
| `e63324b` | the transfer cache: indirect transfers by VA in one probe (lever 1 below) | 20.1 → 19.8 s in one session |
| `a946760` | the fixed-size memory: JIT modules import exact limits (lever 2 below) | 20.0 → 18.6 s in one session |
| this one | one code cache for all vCPUs (below) | 18.9 → 19.2 s; on 4 vCPUs 26.8 → 21.9 s |

On the **Mac host's Chromium** (no explicit bounds checks): 18.0 → 14.6 → 14.3 s (lever 2 changes
nothing there). QEMU TCG: 11.2 s. The boots: Alpine's 9.95 → 9.23 s and Buildroot's 768 → 725 ms
with lever 2.
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

## One code cache for all vCPUs (third session)

The user saw Firefox in a 4-vCPU guest flush the cache every few seconds at 200–300 MIPS, and
asked to share compiled code across vCPUs within the existing 160 MiB total. Done:
`bench/boot/REPORT.md` "M8: one code cache for all vCPUs", docs/jit.md "Sharing". A `go build`
loop on 4 vCPUs: 143–150 s a build → 48–81 s, 296 → 755 MIPS, ~76 flushes → 1, same tab memory.
What's left, in docs/backlog.md "JIT": the single-threaded phases on 4 parallel vCPUs 4–5%
slower (Lua, SQLite in `smp_user_jit_4`; unexplained), one vCPU 1–2% slower, the 2–4 s
`vm_run_cpu` calls under heavy load, eviction for working sets past 160 MiB (a browser in the
guest; not measured with sharing).

- **How to load the guest:** `bench/stress/stress.ts` with `--no-load --disk2
  target/images/stress/goroot.ext4 --guest-cmd '<go build loop>'` (the loop is in
  `bench/boot/REPORT.md`'s section; the harness's samples print the interpreted share, flushes and
  compile time). The guest times its builds: steps per second alone hid the flushes' cost.
- **Debugging a bad table index** (a "function signature mismatch" in a worker): dump, at the
  trap, every index the vCPU's JIT state can call (jump cache, hot-word redirects, live transfer
  cache entries) and test each against the worker's table (`table.get(i) === null`). An export
  and a catch in `web/vcpu-worker.ts` did it in a few lines; it named the hot words at once.

## The two levers (the user asked for both): both done

**1. The transfer cache** (docs/jit.md "Linking", `bench/boot/REPORT.md` "M8: a VA-keyed
cache for indirect transfers"). `BR`, `BLR`, `RET` and by-VA links probe `Tlb::xc` (16,384
entries per vCPU), where they probed the instruction TLB and then the jump cache: Lua −9%, SQLite
−5 to −6%, the userspace total −1.4% (VM) and −2.8% (Mac); Alpine's boot +1% (VM and Mac) and
Buildroot's +1.5%. A miss falls back in wasm to the old lookup and fills the entry; the generation
is per EL and kept for global code across ASID changes, and a TLBI by VA clears only its page; the
fallback is one shared pair of functions in table slots 0 and 1; 4096 entries were too few.

**2. The fixed-size memory** (docs/abi.md "A fixed-size memory", `bench/boot/REPORT.md` "M8: a
fixed-size memory"; ABI 32). `bootVm` creates the memory with `maximum` = RAM + scratch + fw_cfg +
a 1 GiB heap reserve, grows its parts, calls `heap_reserve(pages)` (one alloc/free that std's
dlmalloc keeps), grows the last page or two, and passes `VmConfig.mem_pages`; JIT modules import
`(pages, pages)`. Userspace −6.9%, Alpine's boot −7.2%, Buildroot's −5.6% in the VM; the Mac
unchanged; no RSS cost. `fixedMemory: false` keeps the growable memory (tested both ways on
smp.bin). The core module itself still imports a growable memory: exact limits there need an
allocator of our own (backlog).

## Fourth session (2026-10-08)

- **The core's share of the profile is measured:** 8 to 19% of the hot phases, so exact limits for
  the core's memory are a small, VM-only lever; set aside (`bench/boot/REPORT.md` "M8: the core's
  share of the userspace profile").
- **Scalar `SQADD`/`UQADD`/`SQSUB`/`UQSUB` inline** (`simd::sat_scalar`; `7bafed9` had done the
  vector 8- and 16-bit lanes only): compress −9.5% in Node, no change measurable in Chromium (the
  host was busy; unexplained). Kept: no cost, no guest-visible change.

## Fifth session (2026-10-08): fewer, larger modules

The user asked whether cutting V8's per-region overhead could reduce memory without costing
speed. It does both: `bench/boot/REPORT.md` "M8: fewer, larger modules", docs/jit.md "Compile
policy" and "Memory".
- **V8 spends ~16 KB per module besides its functions** (Chromium 153: ~8 KB PartitionAlloc,
  ~8 KB code-space pages); half of the userspace benchmark's 3,860 modules had one function.
- **A batch is emitted once its blocks have run 50K steps interpreted** (`BATCH_STEPS`), with a
  64M-step timeout for lukewarm ones (was 1M), and a tier-up takes the pending batch into its
  module. Modules 3,860 → 970; Chromium: userspace −4.2%, Alpine's boot −10%, Buildroot's −12.5%;
  Debian on the page under a mixed load 6–9% less renderer memory (~200–330 MB).
- Tools: `bench/mem/modules.ts` (synthetic cost per module, a capture of a run's modules, its
  replay in Chromium); `bench/mem/memsample.ts` boots Debian unattended again.
- A longer timeout alone cut modules too but kept hot blocks in the interpreter (4M: +4%).

## Next

The backlog's "JIT", "User space" list, in its order. Not yet tried: a region entered at more than
one block (a `br_table` on the entry PC), which would reach blocks compiled in earlier batches
without copies.

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

- **`../webpc-base/target` is a symlink to this checkout's `target`:** a build there overwrites
  this checkout's `webpc_core.wasm` (hard-linked). Copy each build's wasm aside and check them with
  `sha256sum` before an A/B; rebuild here after building there.
- **A Node gain may not reach Chromium:** scalar `UQSUB` inline took 9.5% off compress in Node in
  two pairs and nothing measurable in Chromium (n12). Confirm in Chromium before claiming.

- **In round-robin SMP one JIT cache serves every vCPU** (it moves between their `jit.cache`,
  `vm.rs`), while each has its own TLB. State derived from the cache but kept per vCPU must
  notice the cache's changes per vCPU: a one-shot "dropped" flag was consumed by whichever vCPU ran
  next, the others ran dropped blocks (CI's `maint.bin` under JIT-stress panicked, and
  `pause.test.ts` hung for 21 minutes). `Cache::drops` against `Tlb::xdrops` is the fix.

- **Counting in JIT code without new counters:** a measurement-only build that bumps
  `Tlb::stats.misses` / `.flushes` from wasm (an `i64` load, add, store at their `Vcpu` offsets)
  shows up in `userprof.ts`'s TLB columns. How the transfer cache's misses were found.
- **`tests/trim.test.ts` failed about 1 run in 40 under load, in either memory mode:** it sent
  each command when the console ended with `# `, and the remount's kernel message sometimes
  landed after the prompt. It counts prompt lines now (0 failures in 80 loaded runs). A test that
  waits for a shell should never match the console's end.
- **LLVM deletes an `alloc`/`dealloc` pair nothing uses** (Rust allocations are elidable): the
  heap reserve did nothing until its pointer went through `core::hint::black_box`.
- `memory.buffer.byteLength` and `memory.grow(0)` agree after a grow from wasm in Node; check the
  memory's size with them rather than trusting an export's return.
- **`/tmp` is a 6.9 GB tmpfs:** keep `perf record` data out of the scratchpad (a few profiles
  filled it); `bench/results/local/perf/` is on disk. `bench/run.ts --out /dev/null` writes
  `dev/null` in the repo, and `--only` takes one benchmark.
- **`tsc` checks `bench/results/local/` too:** ad-hoc `.ts` there that isn't strict-clean fails
  CI; keep such scripts in the scratchpad while CI runs.
- **A `sed` replacement with `&` in it** (a URL query) inserts the matched text: pass such values
  through a file or a script, not `sed`.
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
