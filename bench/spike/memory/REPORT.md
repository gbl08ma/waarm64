# M0.5 report: memory architecture decision

**Host:** AMD Ryzen 7 5800X3D (Zen 3, x86_64), 47 GiB, Linux 7.2 (THP `always`), Chromium 152.0.7977.75 headless.
**Date:** 2026-09-25. **Raw data:** `results/chromium-linux-x86_64-*` (capacity JSON, cost JSON per V8 config, disassembly per tier), `results/chromium-darwin-arm64-*` (capacity, cost) and `results/chromium-linux-arm64-machine-code-*`.
**Reproduce (any host, one command):** `node bench/spike/memory/run-all.ts`. It builds the Rust side and writes
`results/chromium-<os>-<arch>-{capacity,cost-<config>}.json` (plus `cost-default-nothp.json` and `machine-code-<tier>.txt` on Linux).
Tables: `node bench/spike/memory/tables.ts <cost json>`.

**arm64:** Apple M4 (macOS 26.6, 24 GiB), Chrome for Testing 153.0.8010.12 headless (Playwright's build), same wasm bytes as x86_64. arm64 machine code comes from the same Chromium build in the Debian 13 arm64 VM on that Mac. See §5. §1–§4 are the x86_64 numbers.
Firefox wasn't measured: project rule, it is the user's daily browser.

## Decision

**Adopt A: one wasm32 memory holds core state and guest RAM (guest RAM ≤ ~3.5 GiB). The Rust core stays wasm32.**
By the rule, no >4 GiB-capable layout came within 5% of A on the realistic mixed kernel:

| mixed kernel, cost vs A (default config) | random, 8 MiB | sequential, 64 MiB | pointer chase, 8 MiB | Rust core (interpreter) |
|---|---|---|---|---|
| B: RAM in memory 1, predictable (`B2_spec_one`) | +11.7% | +14.0% | −0.2% | +29% (accessor calls) |
| C: one memory64, Rust core built wasm64 | **+6.4%** | +20.1% | +2.1% | +11% |
| D: wasm32 core + memory64 RAM | +18.8% | +27.9% | +0.3% | +30% (accessor calls) |
| **A + spill memory** (`AB_spec_one`, memory-0 pages) | **±0%** (identical machine code) | ±0% | ±0% | ±0% |

- **C is the near miss:** +6.4% on random access, but +20% on sequential, and every Rust load and store in the core gets an explicit bounds check (+8–11%). Liftoff and TurboFan-only runs are worse (+9–11%).
- **The recorded gap is 6–28% on JIT code and 11–30% on the core**, depending on the candidate. Revisit when V8 changes the lowering described in §3: either memory64 bounds checks go away, or non-zero memory bases get hoisted.
- **arm64 (M4, §5) confirms A.** V8 emits the same lowering there. C's JIT-code gap is wider (+17.5% random, +18.9% sequential), even though its wasm64 core is free on arm64. B (+31–40%) and D (+26–32%) are also worse than on x86_64.
- **Upgrade path without regressions: "A + spill memories" (the NUMA follow-up).** Keep A. Put guest RAM beyond memory 0 in additional wasm32 memories, and fold the memory index into the TLB tag. Memory-0 pages then run **byte-identical code** to A (verified in the disassembly). Spill pages go through the slow path. That costs +120% when half the pages are spill pages, so Linux must be steered to keep hot data in memory 0. Describing each spill memory as a CPU-less NUMA node does that. This adds nothing to the fast path and changes no layout decision made now, only the TLB tag format (see §4).

## 1. Capacity (Chromium 152, x86_64 Linux)

`results/chromium-linux-x86_64-capacity.json`. Allocations were capped at 24 GiB of `initial` size in total, and touched memory stayed under 2 GiB.

**Per memory:**

| | max `initial` / grow | JS `maximum` limit | over the limit | module-declared max |
|---|---|---|---|---|
| wasm32, shared or not | **4 GiB** (65536 pages), allocates and grows to it | 65536 | `RangeError` (constructor and `grow`) | 65536; 65537 → `CompileError` "larger than implementation limit" |
| memory64, shared or not | **16 GiB** (262144 pages), allocates and grows to it | 262144 | `RangeError` | 262144; 262145 or 2^48 → `CompileError` |

The memory64 JS API takes BigInt `initial`/`maximum` with `address: 'i64'`. A plain number throws a `TypeError`.

**Many memories, workers, address space:**
- **Total size:** six shared 4 GiB memories (24 GiB, the cap) allocate fine in one page, each touched for 64 MiB. So do 2 × 4 GiB in the page plus 4 × 4 GiB in four dedicated workers. Workers run in the page's renderer process: their touched pages show up in that renderer's RSS. So total guest RAM is bounded by host RAM, not by per-memory limits. Nothing was pushed past 24 GiB.
- **Reservations:** V8 places every wasm memory inside its sandbox, a ~1 TiB virtual cage the renderer reserves up front, so VSZ doesn't move when memories are allocated. A wasm32 memory costs 8 GiB of the cage (4 GiB plus guard), shared or not. A memory64 costs 16 GiB. **About 124 wasm32 memories or 62 memory64 memories** fit, then `RangeError: could not allocate memory` (catchable). **The budget is per renderer:** page plus 4 workers together reach the same 124. A single VM using a handful of memories is nowhere near it.

**Lazy commit** (renderer RSS):

| step | RSS |
|---|---|
| baseline | 132 MiB |
| + shared wasm32 4 GiB, untouched | 137 MiB |
| touch 256 MiB / 1 GiB of it | 381 / 1149 MiB |
| + shared memory64 16 GiB, untouched | 1149 MiB |
| touch 256 MiB at offset 8 GiB of it | 1407 MiB |
| drop all + `gc()` | 203 MiB |
| worker allocates 1 GiB and touches 512 MiB | 642 MiB (same renderer pid) |

Commit is fully lazy. Only touched pages are resident, and dropping the memory returns them.

**Failure modes:**
- Asking for too much (size or reservations) → a catchable `RangeError` / `CompileError`.
- Running out of physical memory → **the renderer is OOM-killed ("Aw, Snap", Playwright: `Target crashed`), with no catchable error.** Measured with the browser in a systemd scope (`MemoryMax=2G`, no swap, `OOMPolicy=continue`):
  - allocating 8 GiB memory64 plus 4 GiB wasm32 succeeds;
  - touching pages kills the renderer at ~1.8 GiB;
  - the browser survives.

  An emulator must therefore size guest RAM against host RAM itself. The browser won't refuse up front.

**Features** (all supported):
- shared memory64: its buffer is a `SharedArrayBuffer`;
- JS typed arrays and `Atomics` over a >4 GiB buffer, at offsets above 4 GiB;
- wasm atomics (`rmw.add`, `wait32`/`notify`) on memory index 1 (wasm32) and on memory index 2 (shared memory64, above 4 GiB), racing a worker (10M increments, no lost updates) and waking it;
- `memory.copy` between a wasm32 and a memory64 memory.

## 2. Cost

`results/chromium-linux-x86_64-cost-{default,turbofan-only,liftoff-only,bounds-checks}.json`.

**How it was measured:**
- **Kernels** (`kernels.ts`) are shaped like the planned JIT output. One loop iteration is one guest block: address generation, `ldr x1,[va]`, `ldr x2,[va,#8]`, four ALU ops, `str x4,[va,#16]`, loop. That's 13 guest instructions for random access and 9 for the chase, i.e. 1 memory op per 3–4.
- **Every access** does an inline TLB lookup: direct-mapped, 4096 entries, separate read and write TLBs, and a tag compare that also rejects misaligned accesses. Hits access RAM inline. Misses call a slow path that refills and performs the access.
- **Patterns:**
  - `rand`: independent LCG addresses;
  - `chase`: a dependent pointer chase, a single random cycle;
  - `seq`: 64-byte stride;
  - `bare`: address generation plus one load.
- **Sampling:** 15 rounds per group, with layouts shuffled per round and an untimed run before each sample. Medians are reported; IQRs are in the JSON (typically ±0.02–0.1 ns).
- **Memories:** all shared. The kernels' checksums (loads and stores) are identical across layouts: `tests/memory-kernels.test.ts`.

**Candidate variants:**
- `A2`: A plus an unused second memory.
- `AB`: A plus a spill memory, memory index in the TLB tag.
- `B1`: RAM alone in memory 1.
- `Bswap`: RAM in memory 0, TLB in memory 1.
- `B2`: RAM split over memories 1 and 2, with three select strategies:
  - `spec`: specialize on the first RAM memory, index folded into the tag;
  - `brtable`: `br_table` on the entry's index;
  - `helper`: call an accessor module.

  Each runs with the mapping `one` (every page in the first memory) and `alt` (pages alternate).
- `Dhigh`: D with guest RAM above 4 GiB in the memory64.

**Default config (dynamic tiering), cost vs A.** 1 GiB working sets are in the appendix.

| layout | rand 8 MiB mixed | chase 8 MiB mixed | seq 64 MiB mixed | rand 8 MiB bare | chase 8 MiB bare |
|---|---|---|---|---|---|
| **A** | 5.66 ns | 14.65 ns | 3.06 ns | 2.46 ns | 14.36 ns |
| A2 | −0.1% | +0.1% | +0.4% | +0.0% | −0.1% |
| AB spec, one | −0.0% | +0.0% | −0.2% | +1.7% | −0.8% |
| AB spec, alt | +119.7% | +33.8% | +112.6% | +190.6% | +27.8% |
| B1 | +11.9% | −0.2% | +14.6% | +18.0% | −0.5% |
| Bswap | +8.9% | +1.1% | +22.8% | +25.7% | −0.3% |
| B2 brtable, one | +22.2% | +1.1% | +39.9% | +21.8% | −0.2% |
| B2 brtable, alt | +92.7% | +46.1% | +58.5% | +140.4% | +45.1% |
| B2 spec, one | +11.7% | −0.2% | +14.0% | +15.9% | −0.8% |
| B2 spec, alt | +129.3% | +34.6% | +114.0% | +193.3% | +29.7% |
| B2 helper, one | +168.0% | +9.4% | +319.4% | +125.0% | +4.9% |
| B2 helper, alt | +274.2% | +38.7% | +364.7% | +249.6% | +45.8% |
| C | +6.4% | +2.1% | +20.1% | +19.8% | +0.1% |
| D | +18.8% | +0.3% | +27.9% | +21.8% | +0.1% |
| Dhigh | +18.8% | +0.3% | +36.0% | +21.5% | −0.0% |

**Across V8 configs** (rand 8 MiB mixed / seq 64 MiB mixed, cost vs A):

| layout | default | TurboFan only | Liftoff only | `--wasm-enforce-bounds-checks` |
|---|---|---|---|---|
| A (absolute) | 5.66 / 3.06 ns | 5.76 / 2.80 ns | 7.33 / 4.62 ns | 6.18 / 3.75 ns |
| AB spec, one | −0.0 / −0.2% | −0.2 / −0.1% | −0.1 / −0.9% | −0.7 / −1.9% |
| B2 spec, one | +11.7 / +14.0% | +10.6 / +19.6% | +17.6 / +14.0% | +23.9 / +17.9% |
| C | +6.4 / +20.1% | +9.1 / +26.3% | +11.4 / +14.1% | −3.5 / −0.3% |
| D | +18.8 / +27.9% | +21.5 / +29.0% | +15.0 / +23.3% | +23.6 / +23.6% |

**What the kernels show:**
- **Non-zero memories are asymmetric** (B1, and B2 predictable): +11–15% on throughput-bound code, ~0% on the latency-bound chase. The base-address reload (§3) is off the critical path, so an out-of-order core hides it in the chase.
- **Declaring a second memory costs nothing** (A2 = A).
- **Memory-select strategies, with a predictable index:**
  - specialization costs nothing over a single non-zero memory (B2 spec ≈ B1);
  - `br_table` adds about 10 points;
  - an accessor call is 2.5–4× slower.
- **With an alternating index** (random 50/50), every strategy is bad:
  - `br_table` +93% (mispredicts);
  - specialization +129% (half the accesses take the slow path);
  - helper +274%.

  Spill memories only make sense if hot data stays in one memory. That's the case for NUMA placement.
- **C's cost is the bounds check.** With checks forced everywhere, C ≈ A (−3.5%). V8's trap handler covers wasm32 memories but not memory64 (§3).
- **Guest RAM above 4 GiB (Dhigh) is no slower than D** on 8 MiB sets.

**Rust side** (`rust/`: a toy interpreter with a CPU struct, decode, a software TLB, and the same mixed guest loop; plus a DMA-style copy into a core buffer):

| | A (wasm32, direct) | B (wasm32 + accessor to wasm32 RAM) | C (wasm64 build, direct) | D (wasm32 + accessor to memory64 RAM) |
|---|---|---|---|---|
| interpreter ns/guest insn (default) | 2.45 | 3.17 (+29%) | 2.72 (+11%) | 3.18 (+30%) |
| same, Liftoff only / TurboFan only | 3.85 / 2.45 | +26% / +31% | +8% / +8% | +24% / +29% |
| DMA copy, 4 KiB chunks | 70.1 GB/s | −7% | −2% | −4% |
| DMA copy, 64 KiB chunks | 60.5 GB/s | +1% | ±0% | +1% |

- **Reaching RAM the core can't address** costs an imported call per guest access, about +30% on an interpreter. Bulk copies (`memory.copy` across memories in the accessor) cost the same as a local copy.
- **The wasm64 core** pays for its bounds checks on every Rust memory access (§3): +8–11%.

### Appendix: 1 GiB working sets (not used for the decision)

`rand`/`chase` over 1 GiB (256 Ki pages, TLB-miss heavy) were measured in all configs, and with transparent huge pages disabled for Chromium (`no-thp.sh`, `cost-default-nothp.json`).

**These numbers are dominated by the host, not the layout:**
- A, A2 and AB-spec-one compile to **byte-identical** machine code, yet land up to +84% apart in these groups, varying between runs.
- The effect comes from physical placement, THP coverage and host page-walk state of each 1 GiB region. It persists after prefaulting, per-round shuffling and full-length warm-up.
- The chase across 256 Ki pages touches only 16 MiB of lines, which fits the 96 MiB L3. It measures host TLB and page-walk cost, not DRAM.

C/D/Dhigh (RAM in the 16 GiB memory64 region) were consistently slower here (+33–168% across the five runs), but that's confounded with the backing mapping. Re-measure with real guest traces in M5, preferably on a quiet machine.

## 3. Machine-code evidence

- **Method:** Chromium with `--no-sandbox --js-flags="--perf-prof --perf-prof-path=… (--no-liftoff | --liftoff-only)"`. `machine-code.ts` parses V8's jitdump file directly and disassembles each named function with `objdump` (no `perf` needed; jitdump is Linux-only).
- **Files:**
  - `results/chromium-linux-x86_64-machine-code-{turbofan,liftoff}.txt` hold every kernel, some slow paths, and the Rust interpreter `run`;
  - `run-3` is the wasm64 build, and `run-9` is the wasm32 build (its indices are offset by 6 accessor imports).

**TurboFan, x86_64, one guest load (`rand_bare`, TLB-hit path):**

```
A   (memory 0, wasm32)       mov  rbx,[rsi+0x1f]            ; memory-0 base: once, before the loop
                             ... mov r9,[rbx+r11+0x8]        ; addend
                             add rsi,r9 ; mov esi,esi        ; wrap to i32
                             mov rsi,[rbx+rsi]               ; the access: no bounds check (guard regions)
B1  (memory 1, wasm32)       mov  r11d,[rsi+0x47]            ; memory-1 base, reloaded at every access:
                             or   r11,[r13+0x2b8]            ;   decompress the pointer from the instance,
                             mov  r11,[r11+0x17]             ;   then load the base
                             mov  rdi,[r11+rdi]              ; no bounds check
C   (memory64)               movabs r12,0x3fffffff9          ; 16 GiB - 7: the whole memory64 reservation
                             cmp  r11,r12 ; jae <trap>       ; explicit check on EVERY access, TLB loads included
                             mov  r15,[rbx+r11]
D   (memory 1, memory64)     cmp  + jae                      ; both costs: the explicit check ...
                             mov edi,[rsi+0x47] ; or ; mov   ; ... and the base reload
```

- **Memory 0's base stays in a register** for the whole function. Accesses have no bounds checks (V8 guard regions / trap handler).
- **A non-zero memory's base is reloaded at every access** via three dependent loads (compressed pointer → decompress → base). TurboFan CSEs it within one basic block (Bswap, TLB in memory 1) but never hoists it out of the loop. This is the asymmetric cost behind B's +11–15%.
- **memory64 gets an explicit `cmp`/`jae` per access.** The compare is against the fixed 16 GiB reservation (an immediate, no memory load), and the trap handler covers the rest. So the check is cheap, but it occurs on every core access in C. In the mixed kernel that's 9 extra checks per iteration.
- **Liftoff** reloads even memory 0's base from the instance at each access. It adds the same decompress chain for non-zero memories and the same immediate compare for memory64.
- **Rust core built wasm64** (`run-3`): 151 `jae` trap branches for 716 memory operands. The wasm32 build (`run-9`, three RAM variants inlined) has none on memory accesses.
- **AB spec one vs A:** the kernels' disassembly is byte-identical apart from the name. Folding the memory index into the TLB tag is free for memory-0 pages.

## 4. What this fixes for M1+

- **The Rust core targets wasm32.** One shared memory: core state first, guest RAM after it. The guest RAM size is chosen at VM start (≤ ~3.5 GiB, depending on the core's footprint). Guest physical addresses stay independent of that placement (the TLB translates).
- **TLB entry:** a 64-bit tag (page VA, low alignment bits) plus a host addend. **Keep bits 3–11 of the tag reserved for a memory index**, 0 = memory 0. That keeps "A + spill memories" a pure addition: the M5 emitter specializes on memory 0 with the index folded into the compare (zero cost), and everything else takes the slow path.
- **Every guest RAM access goes through one lowering function** in the emitter, and one RAM accessor in the core, as PLAN.md §1 already requires. It is the single switch point if a later engine makes B/C/D free.
- **Size guest RAM against host RAM up front.** Overcommitting ends in a renderer OOM kill, not an exception.
- **The NUMA follow-up applies** (B's cost is asymmetric). It's validated in M3 once Linux boots, and only if >3.5 GiB guests are wanted.

## 5. arm64 (Apple M4)

**Setup:**
- **Host:** Apple M4, 10 cores, 24 GiB, macOS 26.6.2.
- **Browser:** Chrome for Testing 153.0.8010.12 headless (Playwright `chromium-1243`). There's no system Chromium on the Mac, and x86_64 ran Arch's 152.
- **wasm:** the x86_64 build copied over (`run-all.ts --no-build`), so both hosts ran identical bytes.
- **Raw data:** `results/chromium-darwin-arm64-{capacity,cost-<config>}.json`.
- **Machine code:** V8 writes jitdump only on Linux, so it comes from the same Chromium build (linux-arm64) in the Debian 13 arm64 VM (Lima `oracle`, Virtualization.framework) on that Mac. It's in `results/chromium-linux-arm64-machine-code-{turbofan,liftoff}.txt`.

**Capacity:** the same as x86_64 (§1).
- Per-memory limits: 4 GiB wasm32, 16 GiB memory64, with the same errors.
- Six 4 GiB memories (24 GiB) fit, including memories created in workers.
- Commit is lazy, and dropping a memory returns its pages.
- 125 shared wasm32 reservations fit before `RangeError`. The cage is ~1.8 TiB of VSZ.
- Every feature check passes.
- The OOM experiment was skipped: it needs a Linux cgroup.

**Cost vs A, mixed kernels** (`tables.ts results/chromium-darwin-arm64-cost-<config>.json`):

| layout | default: rand 8 MiB / seq 64 MiB / chase 8 MiB | TurboFan only (rand / seq) | Liftoff only | `--wasm-enforce-bounds-checks` |
|---|---|---|---|---|
| A (absolute) | 2.05 / 1.67 / 10.81 ns | 2.08 / 1.61 ns | 2.88 / 2.81 ns | 2.59 / 2.25 ns |
| AB spec, one | −0.7 / +12.5\* / −0.8% | −3.7 / +0.0% | +1.8 / +0.3% | +0.0 / −0.4% |
| B1 | +37.6 / +31.5 / +1.5% | +36.9 / +44.2% | +20.1 / +25.0% | +33.5 / +23.7% |
| B2 spec, one | +39.7 / +31.3 / +1.5% | +35.7 / +36.6% | +19.2 / +23.2% | +34.2 / +23.7% |
| **C** | **+17.5 / +18.9** / −3.1% | +28.5 / +22.8% | +13.1 / +9.0% | +2.7 / −1.3% |
| D | +25.8 / +31.7 / −2.7% | +23.4 / +37.3% | +21.3 / +23.9% | +27.3 / +21.7% |

\* AB spec one compiles to code byte-identical to A on arm64 as well (the disassembly matches once absolute addresses are masked). Its seq gap shows up only under dynamic tiering and has a tight IQR (±0.003 ns). Under TurboFan only it is +0.0%. So this is a tiering artifact, not a layout cost. IQRs on the other decision rows are ±0.002–0.09 ns, far below the gaps.

**Rust core, interpreter ns/guest insn** (default; TurboFan only; Liftoff only):
- A: 1.67; 1.67; 2.95.
- B: +10.6%; +9.1%; +6.7%.
- **C (wasm64): −0.1%; −0.5%; +0.1%.**
- D: +10.0%; +9.0%; +5.4%.

DMA copies are within ±5%, except the Liftoff 4 KiB case, where A is the slow one.

**Machine code** (TurboFan, arm64; same structure as §3):

```
A   (memory 0)      ldur x1,[x7,#23]                        ; memory-0 base: once, before the loop
                    ldr  x2,[x1,x2]                         ; the access: no bounds check (trap handler)
B1  (memory 1)      mov x8,#0x3f ; ldr w8,[x7,x8]           ; memory-1 base reloaded at every access:
                    ldr x16,[x26,#520] ; orr x8,x8,x16      ;   compressed pointer, decompress,
                    ldur x8,[x8,#23] ; ldr x2,[x8,x2]       ;   base, then the access
C   (memory64)      tst x2,#0xfffffffc00000000 ; b.ne trap  ; explicit check on every access (16 GiB reservation), TLB loads included
D   (memory 1, m64) tst + b.ne, then the base reload
```

- **Non-zero memories:** same three-load base reload as x86_64, never hoisted. It costs more on the M4 (+31–40% vs +12–14%). A likely reason is that the rest of the loop runs faster there, so the reload is a bigger share. That's untested.
- **memory64:** a one-instruction `tst` against the 16 GiB reservation plus a branch, per access.
  - **The wasm64 core** has only 38 such checks for 634 memory operands in `run-3`, vs 151 `jae` for 716 on x86_64. The reason for the difference wasn't investigated. The measured core cost is ~0%.
  - **The JIT kernels** index RAM with values V8 can't bound (TLB addends), so every guest access keeps its check.

**Verdict:** the rule needs C ≤ 5% on the random and sequential mixed kernels **and** on the core. On arm64 C passes the core (−0.1%) but fails both JIT kernels (+17.5%, +18.9%). **A stands on both hosts.**

**Not measured on arm64:** the OOM kill (no cgroups on macOS), and the no-THP 1 GiB run (Linux-only). The 1 GiB groups in the JSON have the same host-placement noise as on x86_64 (A2 = A code, +111% in one group), and aren't used.

## 6. memory64 re-measured (VK4 T19, 2026-10-29)

**Why:** T19 (VK4-KICKOFF.md) weighed taking the renderer off memory 0, and the backlog asked whether memory64 had
become cheap enough to replace layout A + spill memories with one memory64 (one node up to 16 GiB, a wasm64 core, no
memory index in the TLB tag, no spill arm). **Verdict: no. memory64 costs about +15–20% on the userspace benchmark on
macOS. The user set it aside, and T19 took the renderer off memory 0 into memory 1 instead.**

Data: `results/t19/`. Hosts: the dev VM (Linux arm64 under Lima on the M4, Chromium 153.0.8010.52) and the Mac host
itself (macOS, Chrome for Testing 153.0.8010.12, `bench/run-mac.sh`).

**What memory64's check is now.** Trap handling for memory64 is on (`--wasm-memory64-trap-handling`, V8's default),
but it can't make the check free. A 64-bit index can reach anything, so V8 still compares it against the reservation
(16 GiB) and lets the guard region and signal handler cover only what lies below. That makes one compare and branch
per access, on both arm64 and x86_64. M0.5's disassembly (§3) already shows this form. Two further findings
(`m64-checks.ts`, `results/t19/node-linux-arm64-m64-checks.txt`, TurboFan in Node 26):
- **One check per access**, even for accesses through the same index value. V8 drops a check only when an earlier
  one has the same index and the same offset.
- **With a constant offset**, V8 materializes `16 GiB − offset − size` in three instructions (`mov`/`movk`/`movk`),
  then `cmp` and `b.cs`. The JIT reads `Vcpu` fields at many distinct offsets.

**The microkernels (§2) on the dev VM:** C at +2% (rand 8 MiB), −3 to −6% (seq) and +6.4% (the Rust interpreter as
wasm64), where M0.5 measured +17.5% and +18.9% on the M4 under macOS. **This is the host, not V8.** Linux arm64 has no
wasm trap handler (docs/v8.md "Bounds checks"), so the VM's wasm32 baseline carries explicit checks too. Code that is
byte-identical (A against AB spec one, `results/t19/chromium-linux-arm64-vm-machine-code-turbofan.txt`) also differed
by 15% in one group, so these kernels don't resolve differences under ~10–15% on this VM. And they carry about one
access per 4 guest instructions, where the JIT's blocks also touch the `Vcpu` register file for most instructions.

**The userspace benchmark** (`alpine_user_jit`, three rounds alternated, median totals; every arm's rounds clear of
the base's; step counts identical). The arms:
- **enforce:** `--wasm-enforce-bounds-checks`, which checks every access, in the core and in JIT code. On a
  fixed-size memory 0, V8 loads the size once per function, so each check is a compare against a register and a
  branch. That is the same bounds-check lowering memory64 gets, with the same elimination, so it is the closest
  stand-in for C.
- **probe 1:** a compare and branch emitted (`if … unreachable`) at each read of the JIT's address locals (`VCPU`,
  each TLB entry address, each host address; `results/t19/probe1.patch`).
- **probe 2:** the same before every memory instruction the JIT emits, on its own index operand, with a constant
  per offset.

| arm | Mac: total | Mac: compress / Lua / churn / SQLite | dev VM: total |
|---|---|---|---|
| base | 11,857 ms | 1,711 / 2,838 / 924 / 2,060 ms | 13,716–13,757 ms |
| enforce | **+18.4%** | +20.6 / +10.0 / +30.3 / +19.4% | +11.7% |
| probe 1 (JIT only) | +9.2% | +7.0 / +3.7 / +17.0 / +7.9% | +10.3% |
| probe 2 (JIT only) | +21.6% | +19.3 / +8.3 / +47.5 / +19.3% | +22% (one trial) |

- **The probes aren't estimates.** Probe 2 costs more than enforce, which checks the core as well. Its wasm `if`
  splits blocks where V8's own check doesn't. Probe 1 checks far fewer accesses than memory64 would.
- **C on macOS is about +15–20%.** That is enforce's +18.4%, give or take two differences. memory64 materializes a
  constant per offset where enforce reuses a register, and a wasm64 core's wider pointers add a little.
- **x86_64 wasn't measured** (the desktop is the user's). M0.5 found C's gap in JIT code wider there than on the M4.
- **Process churn pays most** (+30%): it compiles the most, and checks make every module bigger.
- **The dev VM's numbers understate the gap**, since its baseline is checked too. Measure memory64 on the Mac host
  or x86_64, never in the VM.

**Against the alternatives.** Layout A's memory 0 has no checks on macOS and x86_64. A spill page reached through the
JIT's arm runs at 1.0–1.6× on Debian's workloads and 1.06–1.18× on copies (docs/spill-memories.md), and only the
accesses to that memory pay it. One memory64 would charge ~15–20% to every access of every machine to remove that
uneven cost. **A single memory64 is not worth it while V8 checks each access.** Revisit if V8 gains range analysis for
memory64 indexes or hoists checks out of loops. The core builds for wasm64 unchanged (`cargo build --target
wasm64-unknown-unknown -p webpc-core`), so a prototype would mainly need the JIT's addresses in i64 and the host's
pointer arguments as BigInt.
