# Testing

Layered, cheapest first; `scripts/ci.sh` runs every layer and must pass before any piece of work
is done. **New behavior comes with tests at the cheapest layer that catches it.** Instruction
semantics need golden-corpus coverage; JIT changes must pass the differential test, lockstep
and the exact-step boots.

## Where each thing runs

| Layer | Runner | What it covers |
|---|---|---|
| Unit tests | `cargo test` (native) | decoder, ALU/flags, bitfields, FP core, crypto KATs, MMU walker, GIC, virtio rings, run loop, DTB, the JIT's structure (block formation, liveness, encoder bytes) |
| TestFloat | `scripts/testfloat.sh` | `fp.rs` against TestFloat 3e, every op and FZ/DN combination (51.2M cases) |
| Golden corpus | `core/tests/corpus.rs` (native interpreter); `tests/corpus-wasm.test.ts` (wasm: interpreter, JIT forced, JIT stress) | ~50,000 instruction tests with results from the M4 |
| JIT differential | `tests/jit-diff.test.ts` | JIT vs interpreter on random words per inlined class, from 8 random states each, plus multi-instruction sequences and region shapes (branches, loops) |
| Lockstep | `tests/jit-lockstep.test.ts` | the integer and FP guests (user mode) and the integer guest at EL1 (MMU off and on), JIT and JIT-stress vs interpreter, `Cpu` + RAM checksum every chunk; 20M steps per JIT case in CI |
| Core instances on one memory | `tests/threads.test.ts` (Node workers); `tests/browser.test.ts` (Chromium workers) | three concurrent instances (interpreter, JIT, JIT) with their own stack, TLS and table run the integer guest to the reference's exact state (M7) |
| JIT plumbing | `tests/jit.test.ts` | install, IC IVAU invalidation (also across chains), the stale-code checker, call/return chaining, tier-up |
| Bare-metal EL1 tests | `core/tests/baremetal.rs`; `tests/boot-node.test.ts` (interpreter, JIT, JIT-stress) | exceptions, MMU, GICv3, timer, UART, SMP (4 vCPUs: CPU_ON, SGI ping-pong, per-CPU timers, CPU_OFF), broadcast maintenance (`maint`, 4 vCPUs: every TLBI …IS flavor, IC IVAU and IALLUIS on code the others run; its IC planted out, JIT-check's stale-code checker must trap) |
| kvm-unit-tests | `core/tests/kvm_unit_tests.rs`; `tests/boot-node.test.ts` | selftest (incl. smp), psci, gicv3-ipi, gicv3-active, timer, cache |
| Buildroot boot and device test | `core/tests/boot.rs`; `tests/boot-node.test.ts`; `tests/browser.test.ts` | Linux boots, virtio console/rng/blk/net/9p/input, framebuffer, realtime mode, writable overlay |
| LTP subset + arm64 kselftests | `core/tests/ltp.rs` (interpreter, each result against its table); `tests/boot-node.test.ts` (JIT) | 93 syscall tests; `syscall-abi`, `ptrace`, `hwcap`, `tpidr2`, `tags_test`, signal tests |
| Crypto test kernel | `tests/boot-node.test.ts` (JIT; interpreter with `WEBPC_INTERP=1`) | the arm64 CE drivers' full self-tests, lib/crypto's SHA KUnit suites |
| Distros | `core/tests/distros.rs` (interpreter: Alpine; Debian with `WEBPC_DEBIAN_NATIVE=1`); `tests/boot-node.test.ts` (Alpine, Alpine userspace, JIT); `tests/browser.test.ts` (Alpine, Debian, JIT) | real distro boots from virtio-blk |
| Browser-only | `tests/browser.test.ts` | cross-origin isolation, the device worker, sync XHR ranges, OPFS, the canvas, DOM input, the spike page |
| Host code | `tests/{devices,overlay,qcow2,serve,wasm-encoder,core-wasm,memory-kernels}.test.ts` | 9p server, loopback adapter, input config, overlay, qcow2 fixtures, the dev server, the encoder |
| Decoder sweep | `core/fuzz` (not in CI) | every 2³² word vs Capstone |
| virtqueue fuzzing | `cargo fuzz run virtqueue` (not in CI) | the transport and split-queue parser |

Rules behind that matrix:
- **Interpreter runs of long guests happen natively** (Rust release builds are fast and need no
  engine): Buildroot, the device test, LTP and Alpine. Node runs the **JIT** on every guest and
  the interpreter only on the short ones (where the JIT run must print exactly the interpreter's
  console). Chromium tests what only a browser has, plus JIT boots of the distros. **Don't boot
  complex guests under the interpreter in Node or Chromium**: it costs minutes and tests nothing
  the native run doesn't.
- `WEBPC_DISTROS` (comma list: `alpine,alpine-user,debian`) picks the distro tests; `ci.sh`
  defaults to the current images of all three. Debian boots in Chromium under the JIT by default
  (~45 s); its native interpreted boot (~2.5 min) also needs `WEBPC_DEBIAN_NATIVE=1` (before a
  guest-visible change and at milestone ends).
- Guest-image tests skip loudly when `target/images/<name>` is missing or stale
  (`images/build.sh --check`).

## Step counts

**Every deterministic guest takes the same number of steps (instructions retired plus exceptions
taken) natively, in Node and in Chromium, under the interpreter and the JIT**, on N vCPUs too
(deterministic round-robin: `buildroot-2cpu`, `buildroot-4cpu`). The guest images'
counts are in `tests/steps.txt`, read by every runner (`core/tests/common` `steps()`,
`tests/steps.ts`). A mismatch is a bug unless the change is guest-visible; then the counts move
**once**, in the same commit, with the reason in its message. Guest-visible changes so far: ERET
ending the chunk (M6), the crypto extensions advertised (M6.5), the GICv3 as the default GIC and
its driver in the test kernels (M7).

Realtime runs and the rw-overlay boots aren't step-exact.

## The golden corpus (`tests/corpus/`)

- **Oracles:** QEMU user mode (`qemu-aarch64`, installed in the dev VM) for day-to-day growth, and
  **real hardware, authoritative:** the Lima VM `oracle` on the M4 Mac mini (Debian 13 arm64, 4
  vCPUs, 8 GiB, 60 GiB, 4K pages; created with `limactl create --name=oracle --vm-type=vz --cpus=4
  --memory=8 --disk=60 --plain template:debian-13`), reached with `ssh macmini.lan
  /opt/homebrew/bin/limactl shell oracle <cmd>`. EL0 code runs natively there. The corpus is
  re-validated on it whenever it grows or QEMU and we disagree. The oracles are only needed when
  the corpus grows; CI compares against the committed files.
- **Format (`webpc-corpus 1`):** `tests/corpus/<group>.txt`, line-oriented. Each test has `code`, a
  `seed` (splitmix64 expands to X0–X30, SP, NZCV, the 8 KiB data region, then V0–V31 as low/high
  u64 pairs; FPCR and FPSR start at 0), `in` overrides, then the oracle's `out` (changed registers,
  `v0=0x<32 hex>`, `fpcr=`, `fpsr=`), `mem` (changed bytes) and `exit` (`end`, or
  `sigill`/`sigbus`/`sigsegv`/`sigtrap` with PC offset, `si_code` and fault address). `note qemu: …`
  records a QEMU result that differs from the M4's. New keys are additive; anything else bumps the
  version. Fixed VAs: code at `0x100000` followed by `brk #0`, data at `0x200000`, harness at
  `0x400000`.
- **Tooling:** `tests/harness/harness.c` (static, freestanding; state loaded by an asm trampoline
  including FPCR/FPSR/V0–V31, dumped from the signal `ucontext` and its `fpsimd_context` on an
  alternate stack), `tools/corpus/gen.ts` (deterministic generator), `tools/corpus/run.ts` (runs
  the oracles and writes the golden files: `node tools/corpus/run.ts [--oracle qemu|m4|both]
  [group…]`), `core/tests/corpus.rs` (the comparator). `WEBPC_CORPUS=<groups>` filters the wasm run.
- **Groups:** branch, dp_imm, dp_reg, ldst, excl, lse, sys, fp_scalar, ldst_fp, simd_same,
  simd_diff, simd_fp, simd_misc, simd_move, simd_perm, simd_shift, crypto.
- The generator avoids CONSTRAINED UNPREDICTABLE and IMPLEMENTATION DEFINED cases (e.g. `LDP`
  with `Rt == Rt2`, writeback with `Rn == Rt`), where the oracles legitimately disagree.
- **Known oracle behavior** (the generator avoids it):
  - Both oracles implement **FEAT_LSE2**: misaligned exclusives, LDAR/STLR and LSE atomics only
    fault across a 16-byte granule. We keep the v8.0 rule (wasm atomics need natural alignment
    anyway).
  - QEMU's `max` CPU has MTE (`ADDG`/`SUBG`, `STGP` execute); the M4 raises SIGILL, as we do.
    QEMU's `DC ZVA` block is 512 bytes; the M4's and ours 64.
  - **Apple's hypervisor filters ID registers** but the M4 guest still runs v8.x/v9 features we
    leave out: PAC (`paca pacg`: `PACIASP` really signs, where we NOP), BTI, `sb flagm2 frint i8mm
    bf16 afp dit`, `lrcpc ilrcpc dcpop dcpodp flagm uscat sha3 sha512 asimddp asimdrdm fphp
    jscvt fcma`, FP16 (incl. FP16 FMOV and fixed-point conversions with immh = 001x), BF16 (BFCVT
    is the FCVT encoding with ftype 01, opc 10), FHM, RDM, DotProd, I8MM, FCMA, JSCVT, FRINTTS. The
    generator emits none of them.
  - Corpus depth: some FP flag paths are thin (only 8 `fp_scalar` tests raise Divide-by-Zero).

## System-level oracles

- `qemu-system-aarch64 -M virt,gic-version=2` (TCG) for behavioral comparison, and Homebrew QEMU
  (11.1) on the Mac with `-accel hvf` for real Apple hardware at EL1 (MMU, exceptions; devices are
  QEMU's). The Sail ARM model for disputed corner cases.
- **Findings:** QEMU TCG raises no SP alignment faults (hvf does, as do we); QEMU under hvf makes
  unassigned PAs RAZ/WI (TCG aborts, as do we); HVF can't emulate a GICv2 (moot since we dropped
  ours). **hvf does give a GICv3** (`-M
  virt,gic-version=3`): kvm-unit-tests' `gicv3-ipi`, `gicv3-active`, `selftest-smp`, `psci` and
  `timer` pass there at 4 CPUs. **It's Apple's in-kernel vGIC** (the default, and with
  `kernel-irqchip=on`): its `GICR_TYPER` reads 0 through 32-bit halves, QEMU's own model
  (`kernel-irqchip=off`) doesn't, so the interrupt controller has a hardware oracle.

## Bare-metal tests (`tests/baremetal/`)

`start.S` (stack, vectors calling `on_exception(frame, vector)`, FP on, `run_el0()` to drop to EL0
and come back through SVC #1) plus one C file per test (all on a GICv3, `lib.h` `gic_init()`; `// smp: N` boots N
vCPUs, on the oracles too), built with host clang and lld by
`build.sh` into committed flat `.bin`s loaded at `0x4000_0000`. Pass = PSCI SYSTEM_OFF with
x1 = 0; `power_off` also prints `exit <code>`. `oracle.sh` runs the `-DORACLE` builds
(implementation-specific checks left out) on QEMU TCG, `oracle.sh --hvf` the `-DORACLE -DHVF`
builds on the Mac (`gic-version=3`: Apple's in-kernel vGIC); every test runs on both. Left out
of the HVF build: two `gicv3` checks that are ours and QEMU's but not Apple's
(`ID_AA64PFR0_EL1.GIC`, `GICR_ICFGR0`: [platform.md](platform.md) "The GIC"), and `smp`'s second
CPU_ON (QEMU's PSCI races it against the target's start: another answer ~1 in 5 under hvf). Tests mustn't rely on
UNKNOWN or IMPLEMENTATION DEFINED reset values and must pick addresses unmapped on `virt` too (its
flash covers `0x0`–`0x0800_0000`). **Rebuild all of them together** when one changes (different clangs build different bytes;
they were last rebuilt together on the M4 VM in M7 loop 3b).

## kvm-unit-tests

Commit `5a221342a025`, booted with one CPU and 256 MiB; `EXIT: STATUS=` from the UART. Every
`unittests.cfg` entry is run or skipped with a reason, and the runner fails if a new one appears.
Pass: `selftest-setup`, `selftest-smp`, `selftest-vectors-kernel`, `selftest-vectors-user`,
`psci` (with the concurrent cpu-on check enabled), `gicv3-ipi` and `gicv3-active` (4 vCPUs),
`timer`, `cache`. Skipped: `gicv2-*` (no GICv2), `its-*`, `pmu-*`, `pci-test`, `micro-bench`, `fpu-context` (KVM only), `debug-*`,
`mte-*`; `sieve` (not in `unittests.cfg`; too slow interpreted).

**The SMP set on QEMU TCG** (11.1, `-M virt,gic-version=3 -cpu max -smp S`), the oracle for M7:
`selftest-setup` (smp 2), `selftest-smp` (4 and 8), `gicv3-ipi` (4, 8), `gicv3-active` and `psci`
(4) pass. `psci` skips its concurrent cpu-on check unless the environment (passed as
an initrd, `ERRATA_6c7a5dce22b3=y`) enables it; enabled, QEMU fails it (several CPUs racing to
start one target must get ALREADY_ON or ON_PENDING).

## The JIT's tests

- **Differential** (`tests/jit-diff.test.ts`): `WEBPC_JIT_DIFF=<n>` words per class. Classes seed
  FP with NaNs, denormals, infinities, zeros and FPCR/FPSR states, and crypto with the FIPS
  vectors' states a third of the time. Flat bus only (the MMU path is lockstep's and the boots').
  A new class shifts the shared seed for later classes: a failure elsewhere may be harness state.
  It caught all three rustc/LLVM `simd128` miscompiles.
- **Lockstep:** `WEBPC_LOCKSTEP_STEPS=300000000` for the long run, done at the end of every loop
  that touches semantics (stress runs a tenth).
- **JIT-stress** (threshold 0, batch 1, a 4-region cache, tier-up after one entry, the stale-code
  checker) runs in CI on the bare-metal tests, kvm-unit-tests `cache` and the corpus.
  `WEBPC_JIT_STRESS=1` runs every Node boot under it (hours with LTP and Alpine). **The long
  stress runs aren't routine**: they ran once at M5's end (Alpine 4.25 h, LTP 2.9 h) and found
  nothing the short runs, the differential test and the exact-step boots hadn't. Run them only
  when a change targets eviction or invalidation; for coverage per minute prefer short variants
  (a tiny cache with the default threshold, compile-on-sight with a big cache, tier-up after one
  entry).
- **JIT-check** (`VmConfig.jit` 3: compile on sight into the full-size cache, with the checker)
  finds stale blocks JIT-stress's 4-region cache evicts before they're entered again; the `maint`
  test uses it (code rewritten by another vCPU).
- **Planted bugs:** every new emitter rule gets deliberately broken once (a carry, a condition, a
  write-back, a fusion taken when the registers differ, a swapped swizzle operand, …) and the
  tests must fail. After a planted-bug experiment, restore the source **and rebuild the wasm**,
  and check the build actually compiled before trusting a "caught" result. Every real bug found
  gets a regression test.

## Decoder sweep (`core/fuzz`)

A separate workspace, so Capstone never reaches the core's builds. `cargo run --release --bin
sweep` (from `core/fuzz/`) runs every 2³² word on a scratch vCPU (no panics) and compares "valid
instruction" with Capstone 5.0 (~3 min); `sweep -- sys` covers the system space
(`0xd500_0000..0xd540_0000`) at EL1 in seconds: a register Capstone names must work unless its
feature is one we leave out (`SYS_NOT_OURS`), an unnamed one must be UNDEFINED except the ID space
(reads as zero). `core/fuzz/src/check.rs` lists the expected differences (features we leave out,
CONSTRAINED UNPREDICTABLE encodings Capstone rejects, should-be-one fields the M4 ignores). Both
report 0 mismatch classes. Not in `ci.sh` (it builds Capstone from C): rerun it when the decoder
changes. `cargo fuzz run decode` (from `core/`) is the libFuzzer target.

## Litmus tests (`images/build.sh litmus`, M7)

herdtools7's tools, built and run in the images container ([images.md](images.md)): 42 tests
from our own list of cycles (`images/litmus/tests.txt`), each with herd7's allowed final states
under `aarch64.cat`. `run.sh` runs each program and **`check.awk` fails a test if it observes
any final state herd7 doesn't allow** (the general form of "forbidden outcomes never appear");
each test prints `litmus: <test> ok model=<herd7's verdict on its condition> seen=<litmus7's
observation>`. A test with more threads than the machine has CPUs prints nothing and counts as
skipped (on one vCPU only `CoRW1`, `CoWR`, `CoWW` run).
- **The M4 reference** (`tests/litmus/m4-reference.txt`: the oracle VM, 4 vCPUs, 10⁸ outcomes
  per test): no forbidden outcome; 16 of the 20 allowed relaxations appear (R and SB ~60–70 per
  million, MP ~47, IRIW 1.5, WRC 0.1), never `LB`, `2+2W+dmb.sy+po`, `S+dmb.sy+po`. With
  litmus7's default settings the M4 showed almost nothing (SB never in 2M): the image uses
  herdtools7's Arm settings (stride 1, `userfence` barriers, `incr0` affinity, 5k × 200).
- The checker was checked by removing SB's allowed states (it fails, listing each state).

## Planned layers

- **Memory model and SMP** (M7): the litmus tests above in the guest at N vCPUs, atomics stress,
  kvm-unit-tests' SMP tests.
- **In-guest suites** not yet run: more LTP areas (need `mkfs` tools and a scratch disk), the
  kselftests `fp` and the generic suites, language test suites (Python), guest JITs (Node/V8,
  LuaJIT) for code invalidation.
