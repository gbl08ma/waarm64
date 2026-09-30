# BUG1: "vCPU 1: RuntimeError: unreachable" under a 4-vCPU stress load

**Status:** not reproduced as the DSB panic. A related intermittent hang *is* reproduced: the page's machine worker freezes during Debian's boot ("A frozen machine worker" at the end). The JIT's memory is bounded (a byte budget that flushes the cache), the DSB wait no longer trips on the waiter's own stalls, and a stress test exists. **Next: the user's manual test on this build ("For the manual test" at the end), and the machine-worker freeze.**
investigates next; delete it in the commit that fixes the bug (or update it with what was found).

## What happened

In Chromium, `npm run serve`, core built from 9e0209b (the wasm in
`target/wasm32-unknown-unknown/release/webpc_core.wasm`, built 2026-09-29 09:15). The VM had 4
vCPUs (parallel SMP, a worker per vCPU), and Debian was on the tailnet (M8 phase C networking). All 4
vCPUs were pegged: a Python busy loop, two `dd if=/dev/urandom` (one piped to `sha256sum`), and
**compiling Go packages** (many threads; heavy mmap/munmap/mprotect, so many TLBI IS). The page reported:

```
Error: vCPU 1: RuntimeError: unreachable
    at ...__rust_abort ... rust_panic ... panic_fmt
    at webpc_core.wasm.<Vm>::handle_par (wasm-function[229]:0x4031a)
    at webpc_core.wasm.<Vm>::run_cpu    (wasm-function[240]:0x42fff)
    at ended (web/vm.ts:573) ...
```

## HIGH PRIORITY NEXT: a long-running stress test in Chromium (the user, 2026-09-30)

The user is no longer convinced SSH matters. A fifth symptom (seen twice): **the VM keeps answering
over SSH, but the page's display freezes and every metric (MIPS, JIT blocks, IRQ/s, uptime) stops
updating.** So the vCPU, device and Tailscale workers go on while whatever draws the page and
polls the counters (the main thread, or web/app's worker) stops for good. Together with BUG1's
panic, the guest's hard lockup (a vCPU worker stalled 10–20 s), the slowdown beforehand, the steady
JIT growth and the 6 GB tab, this reads like host-side stalls or starvation that get worse over a
long session. Hypotheses 3 and 5 above, and docs/backlog.md's JIT-growth and tab-bloat entries.

**The next step is a long-running stress test under headless Chromium**, not more tailnet-specific
testing. It was planned for the end of an earlier milestone and postponed until the system was
complete enough; now it is. Scope:
- The real page (web/app) or the same stack, parallel SMP with 4 vCPUs, the JIT, Debian, for hours.
- A mixed guest load: compiles (Go if the image can have it, else C), busy loops, fork/exec and
  mmap churn, disk and console I/O, optionally network.
- Sampled throughout: every metric the page shows, per-worker liveness (the longest gap between
  chunks per vCPU; the page's and coordinator's update cadence), JIT blocks, modules and table
  size, renderer and worker memory (CDP `Performance.getMetrics`, `performance.measureUserAgentSpecificMemory`),
  and the guest's dmesg (lockup and RCU-stall reports).
- It must detect and report: a panic (with the dump, see above), a frozen page with a live guest,
  a stalled vCPU, memory growth, a slowdown. Reuse `bench/results/local/stress-debian.ts` (the
  first attempt, 500 s) as the start.
- Bounded runs under CLAUDE.md's rules. A multi-hour run goes in chunks under the tool's cap, or
  runs detached with a timeout and a log you check.

Uncommitted in the working tree when the tailnet-CI agent stopped (43e3b25 is its last commit;
NET-CI-HANDOVER.md has its state): changes to tests/net-tailnet.test.ts, tests/net/tailnet.sh and
tests/browser/tailnet{.html,-worker.ts}, probably the start of an SSH-into-guest test. Finish or drop
it; lower priority than the stress test.

## Where the panic is: the DSB deadlock assert (certain)

The release wasm carries DWARF, so the site can be read off the binary that crashed. **llvm-symbolizer
takes the file offset from the stack trace as is**; don't subtract the code section's base:

```sh
llvm-symbolizer --obj=target/wasm32-unknown-unknown/release/webpc_core.wasm -i -f 0x4031a
#   sync        core/src/vm/parallel.rs:589:13
#   handle_par  core/src/vm/parallel.rs:335:22   (Exit::Resync => self.sync(...))
```

`parallel.rs:589` is the assert in `Vm::sync`:

```rust
assert!(self.clock.ns() - t0 < DSB_LIMIT_NS,
        "vCPU {c}: DSB waited 10 s for TLBI IS on {:?}", own.waits);
```

vCPU 1 broadcast a TLBI IS, then hit a DSB/ISB/ERET, and for 10 s at least one other vCPU `t` kept
`par.state == RUN` with `par.applied < seq`. So `t` never reached `drain`. The message names `t`
(`own.waits`), but **the core has no panic hook**, so it was lost: wasm32-unknown-unknown's default
hook prints nothing.

What's ruled out:
- **The clock going backwards:** `t0` and the later readings come from the same thread
  (`performance.now()` plus a fixed per-worker base, `web/vm.ts:42`).
- **A vCPU blocked in the host while `RUN`:** `ring()` and the TX_FULL and IDLE waits
  (`web/vcpu-worker.ts`) all happen after `run_cpu` returned, which CASes `RUN`→`OUT`.
- **A worker that threw with `RUN` stuck:** `error ??=` in `web/vm.ts` `ended` keeps the first
  error, so the throwing vCPU would have been reported, not vCPU 1.

## Hypotheses: what kept `t` in `RUN` without draining

`t` drains at the top of every `run_loop` iteration, which comes around after every chunk, IRQ and
WFI completion. So either `t` stayed inside one chunk (or one `handle_par`) for 10 s, or its
`applied` couldn't reach `seq`. In rough order of likelihood:

1. **A chunk that never ends** (JIT or interpreter): some loop that skips the step-budget check (a
   self-chaining block, a chained back-edge, an exclusive-store retry, a helper that loops, WFE/YIELD
   handled inline). That alone hangs `t` without the guest noticing within 10 s: the soft-lockup and
   RCU-stall reports take ≥20 s. Add a guest dependency (`t` spins on a lock that vCPU 1 holds
   while vCPU 1 waits in the DSB for `t`) and it's a hard deadlock that only the assert breaks.
   Go's runtime spins a lot (`procyield`, spinning Ms, `osyield`), so Go workloads are the likeliest
   to find such a loop.
2. **`t` blocked on `Vm::plat`'s mutex for 10 s** (`plat_of`): a holder slow under the lock
   (virtio `io`/`complete` doing unexpectedly heavy work, the new virtio-net or SIGNAL_RX refresh
   paths), or starvation under heavy contention: 4 vCPUs, IPIs (ICC_SGI1R), timer PPIs and network
   IRQs all take the lock. `PAR_LOCK_WAIT_NS` counts the wait.
3. **`t` stuck in a host import inside the chunk:** `jit_install` compiles and instantiates
   synchronously, and grows the table. A GC pause or memory pressure in that worker, with a lot of
   code churn (Go compiles make IC invalidations, flushes and many modules), would need to be
   pathological to last 10 s. `JIT_COMPILE_NS` and `JIT_MODULES` per vCPU would show it.
4. **Bookkeeping:** a `waits` entry that can't be satisfied: `queued` or `applied` reset on some
   path (CPU_ON's `*own = Own{..}` resets `own` but not the queue; check every writer of
   `Queue::queued` and `CpuPar::applied`), or a `pending` lost between `broadcast` and `drain`. My
   reading of the `broadcast`/`drain` ordering found no hole, but it wasn't exhaustive.
5. **A host stall of ≥10 s** (machine sleep, the debugger paused): would be a spurious assert.
   Unlikely: the user was watching the load.

## Suggested plan (cheapest first)

1. **Make the next occurrence self-diagnosing** (worth committing whatever else happens):
   - A panic hook in the core that hands the message to the host (an `env` import, or a
     buffer the vCPU worker reads after the `unreachable`), and `web/` putting it in the error. That
     takes an ABI bump (docs/abi.md).
   - At the DSB timeout, before panicking, report for each `(t, seq)` in `own.waits`:
     `state`, `applied`, `queue.queued`, `pending`, the retired count and PC that `publish_cpu`
     published (`counters.retired`, `counters.pc`) at the wait's start and at its end, and whether
     `plat` is locked (`try_lock`). **If `t`'s retired count moved, it's hypothesis 4; if it froze, 1 to 3**
     (the PC then points at the loop, or at the code that took the lock).
2. **Reproduce without the network** where the loop is cheap:
   - Bare metal (tests/baremetal, the native parallel runner `baremetal_parallel` and the wasm
     parallel path): vCPU A takes a spinlock, TLBI VAE1IS, DSB, releases it; vCPUs B to D spin on the
     lock in tight loops without WFE (`ldr; cbnz`, and LDAXR/STXR loops, YIELD loops). Check that
     every spinning chunk ends at the budget and drains.
   - Debian or Alpine, 4 vCPUs, JIT, in Chromium or Node workers: a local stress with no network,
     mixing fork/exec storms, mmap/munmap/mprotect loops (a few lines of C or a shell script)
     and busy loops. If there's no compiler in the image, a Go or C test binary built in Podman
     (`images/`) and put on the disk.
3. Read the JIT's budget enforcement (core/src/jit) against hypothesis 1: every back-edge and
   chained branch, and every helper that can loop.

Constraints (CLAUDE.md): `timeout` and the systemd-run memory cap on every run; guests under the JIT
only; no Firefox; headless Playwright only. The crashed binary's analysis is above, so **rebuilding the wasm is fine now**.

## Second occurrence (2026-09-30): it follows SSH over the tailnet

Same site with the ABI 27 build (`llvm-symbolizer ... 0x40e55` gives `sync` at parallel.rs:591),
this time on vCPU 2. The workload was only a Go compile across all vCPUs. **Every crash so far came
while the user was SSHed into the guest over the tailnet**: not at connect, but minutes into a
session, seemingly under CPU load. So the network path is the prime suspect now: virtio-net
RX/TX under `Vm::plat`'s lock (SIGNAL_RX `refresh`, SIGNAL_DEVICE `complete`, `io`), the device
worker, and the Tailscale worker competing for host CPU. That favors hypotheses 2 (the plat lock)
and 5 (a starved vCPU worker) over 1.

The page still showed no dump: `withPanic` changed `err.message`, but the worker reports
`err.stack`, which V8 had fixed already (something read it first). Fixed in ace25a6 (the stack now
carries it, and the test reads the stack first). The next occurrence should show the dump.

Third occurrence (the same day, the same site, vCPU 2): the user saw **a general slowdown before
the crash**. The page still had no message after ace25a6, although a vCPU thread instance does get
it in Node (`bench/results/local/panic-thread.ts`). 8488331 makes the coordinator read the buffer
itself and say what the buffer held when it's empty, so the next occurrence tells which part failed.

Related (in docs/backlog.md, not chased): the JIT block count grows steadily in these long
sessions, and the crashed tab stays over 6 GB and ~10× slower even after a reload. JIT growth
(host compiles, table growth, GC) is a way for one vCPU's worker to stall (hypothesis 3), and would
explain the slowdown before the crash.

**Fourth occurrence (2026-09-30 00:52): no panic, but the guest saw the stall.** Debian printed
"watchdog: Watchdog detected hard LOCKUP on cpu 1" (the buddy detector: no hrtimer interrupts on
CPU 1 for ~10 s) and an RCU stall on CPU 1 (5255 jiffies, ~21 s at 250 Hz), then carried on. The
NMI backtrace (an IPI here) arrived ~4 s later, in an ordinary user data abort (`el0_da`, ESR
0x92000007, the Go `compile` process, DAIF clear): no kernel loop. A guest livelock (a stale TLB
entry re-faulting, say) would still take timer interrupts. So **vCPU 1's host thread made no
progress for 10–20 s, then resumed.** No panic this time: other vCPUs' TLBI IS weren't for its ASID,
so nothing waited on it, or it stalled outside `run_cpu`. **Working theory: BUG1's assert is a
symptom; the bug is a vCPU worker stalling ≥10 s**, with the slowdown, JIT growth and a 6 GB tab
beforehand (hypotheses 3 and 5: GC, compiles or table growth in the worker, host memory pressure,
the Tailscale worker's load). Next evidence to get: Chromium's task manager (per-worker memory) and
host swapping while it's slow; a per-vCPU "longest gap between chunks" counter would prove it.

A repro needs the tailnet in the loop: CI's tailnet tests (`tests/net/tailnet.sh`, headscale and a
peer in Podman) plus a peer that SSHes into the guest and keeps traffic flowing (for example
`yes | ssh guest cat > /dev/null`, or an interactive-like trickle) while the guest compiles on all
vCPUs.

## Progress

### Step 1 done: the next occurrence is self-diagnosing (ABI 27)
- `core/src/diag.rs`: a panic hook (installed by `vm_new`) keeps the first panic's message in a
  static; `panic_message()` exports its address (docs/abi.md "Panic message"). `web/vm.ts`
  `panicMessage`/`withPanic` put it in the error, in the vCPU worker (`web/vcpu-worker.ts`) and in
  the round-robin `run`. So the page's error now reads `vCPU 1: RuntimeError: unreachable: core
  panic: <message>`.
- `Vm::sync` at the DSB timeout panics with `Vm::dsb_report`: per waited vCPU its state (0 off,
  1 run, 2 out), `applied`, waited-for seq, `queued`, queue sizes, `pending`, `waiting`, retired
  count and PC at the wait's start and at the timeout, and whether the platform lock is held. Read
  it as the plan says: retired moved = hypothesis 4; frozen = 1 to 3 (PC = where the last chunk
  ended; lock held = 2).
- Tests: `a_dsb_timeout_reports_the_vcpu_it_waited_for` (core/src/vm/tests.rs; `Vm::dsb_limit_ns`
  is lowered for it), `core/tests/panic_hook.rs`, and `tests/core-wasm.test.ts` (a wasm panic
  through `vm_run_cpu` on a round-robin VM arrives with its message).
- `scripts/ci.sh` passes with `WEBPC_TAILNET=0`. The `net-tailnet` exit-node step (curl to the
  host's IPv4 through the exit node, exit 28) fails in this VM on the pre-change commit b4d4dab too
  (checked with a stash), so it's environmental (the peer in rootless Podman can't reach the Lima
  VM's own address), not from this work.

### Step 2, part 1: bare-metal spin vs TLBI IS: no reproduction
`tests/baremetal/tlbi_spin.c` (4 vCPUs; CPU 0: lock, TLBI VMALLE1IS, DSB ISH, unlock, 100 rounds;
CPUs 1 to 3 spin in a plain load loop, a LDAXR/STXR acquire-release loop and a YIELD loop, never
WFE). It passes on the native parallel runner (x5, twice), in Node workers under the JIT (10 runs)
and JIT-check (10 runs; JIT-check is slow, 15 s a run at 300 rounds, hence 100 rounds). So a tight
spin does drain at the step budget in both tiers, at least in this shape.

### Step 3 (reading, not exhaustive)
Budget enforcement in `jit::steps` and the region code: chained tail calls, indirect (jump cache)
calls and loop back-edges each test `left >= len (+ next len)` and take `len` from it
(core/src/jit/emit.rs "left >= len + its length", block.rs region edges, unit tests of the
back-edge). I found no unbudgeted loop. Not checked: a helper that loops in the core, WFE/YIELD
inline paths (bare-metal test above covers YIELD).

### Step 2, part 2: Debian on 4 parallel vCPUs in headless Chromium: no reproduction
`bench/results/local/stress-debian.ts [seconds]` boots the page (`?machine=debian&ncpus=4`, JIT,
realtime), logs in on the serial terminal and starts: two busy loops, a `/bin/true` + `ls` fork/exec
storm, `seq | sort -R` (mmap/munmap churn), `urandom | sha256sum`, and `find /usr | wc`. It reports
a page state other than `running` and any console line matching panic/error/DSB. Two runs (240 s
and 500 s) stayed `running` throughout. Not covered: the original load's Go compiler (many threads,
heavy mprotect), the Tailscale wasm client and network traffic sharing the host's cores (a host
stall or CPU starvation of one vCPU's worker, hypothesis 5, is not excluded).

## What's left
- Wait for an occurrence with the new build: the error now carries `core panic: vCPU N: DSB waited
  10 s ...` with the per-vCPU dump. Decide from the dump (see "Step 1"): retired moved =
  bookkeeping (hyp. 4); frozen with the lock held = hyp. 2; frozen at a PC in a guest loop =
  hyp. 1 (then look at that PC's block in the JIT); frozen at a PC unchanged for the whole wait
  with the lock free and state RUN = a host stall or `jit_install` (hyp. 3, 5; compare
  `JIT_COMPILE_NS`).
- A heavier local stress: a Go (or C) mmap/mprotect/thread-churn binary built in Podman and run in
  Debian under the same load, and with the Tailscale client running for host contention.
- Not done: reviewing every core helper for loops, and a host-stall test (pausing a vCPU worker
  from the test harness while another waits in a DSB: the wait should end at 10 s with the report).

## Progress, 2026-09-30 session 2

- **Audit (read only) of hypotheses 1, 2 and 4: nothing found.** No unbounded loop in the core
  reachable from a chunk. The only spin, `Mem::pair_op`, has no cross-vCPU dependency. The
  `broadcast`/`drain`/`applied` bookkeeping has no unsatisfiable `waits` entry, CPU_ON/OFF included.
  `Vm::plat` is taken only on vCPU threads, for microseconds, never together with a queue lock or
  inside `sync`. **The assert measured wall time:** a waiter whose *own* worker stalled 10 s fired
  on resume, whatever the waited vCPU did.
- **The DSB wait counts waiting, not the waiter's stalls** (900127e, `DsbBudget` in
  core/src/vm/parallel.rs). Passes over 100 ms are the waiter's own stall; they're reported apart,
  with a wall backstop of 10 limits. `tests/hoststall.test.ts` stalls a worker in RUN (the clock
  import, `jit_install`), in OUT, and the waiter itself. It checks the report fields; the waiter case
  fails on the old logic. `jit_install` is inside RUN; its worst case in a Debian boot was 12.6 ms.
- **The stress test** (6565e97, docs/testing.md "The stress test"). It runs the real page with 4
  vCPUs, the JIT, Debian and a mixed load (`--guest-cmd` adds more). It logs JSONL: page metrics,
  memory, per-vCPU liveness (`web/liveness.ts`: the longest `vm_run_cpu` call and the host-side exit
  handling), the status cadence, main-thread lag, and dmesg probes. It detects crash, freeze,
  vcpu-stall, loop-stall, memory-growth, slowdown, guest-lockup and guest-unresponsive; the
  detectors are unit-tested. Blind spot: while the machine worker is frozen, the console and the
  liveness data can't be read.
- **Go load** (e8a23ae, 7c44448, docs/images.md): `gostress`/`cstress` come in a variant initrd
  (`--initrd`). A trimmed GOROOT is on a read-only second disk (`?disk2=`, `--disk2`). A cold
  `net/http` build takes 349 s alone on 4 vCPUs, and doesn't finish in 300 s under the full load.
- **Short runs (≤ 400 s, several contended): no panic, no lockup, no DSB timeout.** The longest
  `vm_run_cpu` call was 2.6 s under the Go load.
- **The tab's memory** (5145861, docs/jit.md "Memory"). V8 spends ~10× a JIT module's bytes, and
  each vCPU worker compiled its own copy with no bound but the region cap, so the tab went past
  5 GB in ~6 minutes of Go builds. A 160 MiB wasm budget per VM now flushes the cache, the table
  drops flushed slots, and a GC nudge after the flush makes V8 free the code. The tab now holds at
  ~3.3 GB; with the flush alone it peaked at 9.6 GB. The "bloated after reload" case didn't
  reproduce: a panic and a reload return the tab to ~1.2 GB. docs/backlog.md has coldest-first
  eviction (FIFO failed, below), sharing modules across vCPU workers, and V8's per-region overhead.
- The tailnet SSH test (uncommitted in the tree) is parked: it runs inside the exit-node phase,
  which fails in this VM, and its full-length run timed out under load.
- **A one-off hang in CI (unexplained; watch for it).** The first `scripts/ci.sh` on the merged
  tree hung for 40 min in `tests/browser.test.ts` while other Chromium runs loaded the VM. It stuck
  after "input events..." passed, so in `alpine boots from virtio-blk in a worker, deterministic
  mode, JIT`. That test passes alone in 11 s, and the file and CI pass on a quiet machine.
  Contention slows a boot, it shouldn't stop one: it may be the same host-side stall as BUG1.

## Session 2, continued: eviction, harness fixes, and a frozen machine worker

- **FIFO module eviction: built, collapsed, removed.** It's on the local branch
  `fifo-evict-attempt`, not pushed. Under the 4-vCPU Go load it collapsed the guest within 3 min:
  - ~1200 MIPS fell to 4–100;
  - the guest reported hard and soft lockups (up to 97 s);
  - single `vm_run_cpu` calls ran up to 112 s with every vCPU thread busy;
  - the renderer grew to 6.8 GB.

  FIFO evicts the hottest code, the drop cascades through `linkers`, and the budget stays full.
  **These are the user's symptoms (a slowdown, then lockups, and a tab past 6 GB), so a JIT that
  thrashes, with the vCPU inside one long `vm_run_cpu` call recompiling hot code, is a candidate
  for the original BUG1 too.** The main branch keeps the whole-cache flush (5145861). It ran the
  same load for 21 min at 600–1100 MIPS, and for 5 more min with no findings. Coldest-first
  eviction is in docs/backlog.md.
- **Harness fixes** (bench/stress):
  - The load's start is checked against the shell's output, not its echo.
  - A boot that never reaches login dumps the machine's state twice, 10 s apart.
  - An unanswered probe logs the console's tail.
  - Probes are logged once settled. Before this, `summarize.ts` read every probe as unanswered: the
    "0/66 answered" of a Go-load run was this bug, not the guest. The run's own report was right.
- **Under the Go load, single `vm_run_cpu` calls of 2–5 s are routine** (a call is up to 100 M steps,
  and the flush build recompiled 10 M blocks in 21 min). Use `--stall-ms 6000` for that load.
- **A frozen machine worker, three times today, all after 5145861 (the JIT budget).** Earlier runs
  in this session had none; the pre-budget build hasn't been checked for it:
  1. The first CI run stuck 40 min in the Alpine deterministic-JIT boot of tests/browser.test.ts.
  2. The first 4-hour stress attempt: Debian's console went silent ~25 s into the boot.
  3. CI's `page-network` test: after 180 s the page still said "booting · up 0:00:50".
  "up" is host time from the machine worker's once-a-second `setInterval`, so that worker's
  event loop stopped. The main thread still answered. Cases 2 and 3 stop at the same boot point:
  after `regulatory.db` and the virtio input devices, just before the switch to the root disk.
  It didn't reproduce in 6 plain 2-vCPU boots, 2 `page-network` runs alone, or 5 under a
  concurrent Go load. The machine worker's waits are all `Atomics.waitAsync` (web/vm.ts `wait`),
  so something else blocks it or keeps it busy. **This matches the user's symptom 5 (a frozen page
  with a live guest)**, and BUG1's stalls may be the same thing seen from a vCPU. Next: when it
  happens, pause the machine worker and take its JS stack (DevTools by hand; in the harness,
  CDP `Target.setAutoAttach` plus `Debugger.pause` on the worker target, not built yet).

## For the manual test

`npm start` (or `npm run serve`), with Debian on 4 vCPUs and the usual load (Go compiles, the tailnet, SSH).
- Memory should level off around 3–3.5 GB. docs/jit.md "Memory" has the numbers.
- The page's status carries per-vCPU liveness. In the page's console:
  `JSON.parse(document.getElementById('status').dataset.status)`:
  - `vcpus[i].maxRunMs`: the longest `vm_run_cpu` call
  - `loopAgeMs`: time since the machine worker's run loop last went round
  - `uptime`: host time since boot
  If "up" stops advancing, the machine worker is frozen.
- **If the page freezes:** DevTools → Sources → Threads, select the machine worker
  (web/app/worker.ts), and pause it. Copy the call stack, and also the vCPU workers' stacks.
  Before reloading, note the tab's memory (Chromium's task manager).
- A vCPU panic now reads `core panic: vCPU N: DSB waited 10 s ...`, with the per-vCPU dump
  (see "Step 1").
