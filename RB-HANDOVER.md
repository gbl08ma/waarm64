# RB: rebinding a module's tails once their blocks are compiled (handover)

The user's brief (2026-11-05): work on the backlog's untried idea for tails into code that was cold when its
predecessor was compiled, rebinding by instantiating a module again (docs/backlog.md, the cold tails' item).

## State

- **Built** on branch `wip/rebind` (ABI 61; docs/jit.md "Rebinding", docs/abi.md): a tail to a successor not compiled
  yet is a site (an imported function, its length global, by VA a host address global); the cache binds it when the
  block is compiled (or at once, by VA, to a head already compiled there) and logs a rebinding, which each table
  applies by instantiating the module again (`env.jit_rebind`). Tests: three in `tests/jit.test.ts` (a lap's
  transfers through the table counted, the drop, by VA with a remap), four planted bugs caught. `scripts/ci.sh`
  passes (567 s).
- **A limit found while testing:** a loop through several modules keeps one indirect edge a lap (an instance imports
  only instances that exist), so the gain is on chains, not 2-cycles.
- **Open:** the first CI run's parallel litmus and stress (4 vCPUs, JIT, Chromium) timed out at 300 s; not
  reproduced in 30 runs alone (idle and under 6 busy loops) nor in the second CI run. Watch for it.
- `WEBPC_NO_REBIND=1 scripts/build-wasm.sh` builds a core without sites (the A/B's base arm, same ABI and host).

## Next

1. A/B: Firefox's pages session on the Mac (`bench/results/local/xfer/mac-ab.sh`, arms `target/ab/rb-off.wasm` and
   `rb-on.wasm`, 3 rounds), the same in the VM (`bench/gpu/ab.sh`, RSS), Alpine's boot and userspace benchmark
   (`bench/run.ts`). Counter words 121–123 say how many rebindings and their cost.
2. Kept only if it wins past the noise on the Mac; then the review, the gates, PLAN.md's row, and merge on the
   user's call.
