# XF: indirect transfers and what a busy vCPU spends in Firefox (handover)

The user's brief (2026-11-04/05): re-profile Firefox's pages session to check the backlog's CPU, interpreter, JIT
and SMP items, then work on the indirect transfers and the other most promising items; anything that wins on busy
MIPS or memory gets an out-of-context review whose findings are addressed. Measurements in `bench/boot/REPORT.md`
from "Where a busy vCPU's time goes in Firefox, again" (2026-11-04) to "Guest calls as host calls, again"
(2026-11-05).

## State

- **Measured and closed** (REPORT.md, backlog and jit.md updated): the profile again; the indirect entries by kind
  (returns 49%); selective relinking (loses in the VM and on the Mac); what a function's size costs (3.5% for +20%
  code in the VM, nothing on the Mac: size cuts aren't a lever for users); typed tables and `call_ref` (no
  better); Chromium's own share by its callers (mostly the idle path, outside busy time); a Mac profile with
  `sample`.
- **Open, promising: guest calls as host calls** on branch `wip/host-calls` (pushed; October's patch from
  `bench/boot/results/m8-calls/` ported to main at `517ef961`). Firefox's pages session on the Mac host: **busy
  MIPS 332, 336 against 302, 305 (+10%), every page 6-19% faster, 4% more wasm** (`bench/boot/results/m9-hostcalls/mac/`);
  in the dev VM 236 against 215, 210 (+11%) in the session that ran through, RSS no higher (`vm/`).
  Not mergeable yet:
  - **In the dev VM Firefox lost its process** in one of two sessions with that core (`a2272932`'s; the guest's
    kernel and sway ran on, the pages timed out at 900 s); the other and the Mac's two ran through: an intermittent
    correctness bug the boots, the differential test and lockstep don't catch. First thing to find.
  - The port's own bug, fixed: its `DEPTH` local (118) was `FZOK`'s since October, so an FP guard overwrote the
    call depth and a `ret` at depth 0 returned as a host call's (the exact-step boots caught it: steps inflated).
    `DEPTH` is local 128 now (placeholder bytes up to 255, compacted under 128), asserted past the others.
  - The review (out of context, on `a2272932`; its findings in the branch's last commit message): **2** fixed (a
    host return's continuation calls the stale-code checker), **1** tested but not fixed (an entry at a member is
    checked against the head's spans in `Cache::install`, yet the test still finds no trap: why is open), **3**
    (a region using every local index: 129 > 128 now; fall back instead of panicking), **4** (`MAX_DEPTH` 64's host
    stack unmeasured in Chromium, helpers like `jit_hot` → install running on top), **5** (assert table indices
    stay under 2^24 in `Cache::new`) open.
- The Mac host as an A/B target: `bench/gpu/sway-mac.sh` with `SCRIPT=firefox-load.ts WASM=<core>
  FROM_SNAPSHOT=<file>`, looped with `bench/gpu/mac-leftovers.sh --kill` after each session (the loop used tonight
  is `bench/results/local/xfer/mac-ab.sh`, local: worth committing as a tool if the Mac stays the ranking host).

## Next

1. Reproduce the Firefox loss in the VM with the branch's current core (`337228d7`): a pages session from the
   snapshot; if it reproduces, narrow it (MAX_DEPTH 0 keeps the entries but no host calls; entries off keeps the
   calls) before reading code.
2. Finding 1's open question, then 3-5; the branch's docs (jit.md "Calls" for the mechanism, out of "Tried and not
   kept"), ABI note if any export changes (none so far).
3. Then the gates (`scripts/ci.sh`, ci-debian, ci-graphics, ci-machines), the Mac A/B again and the VM's, and the
   merge.
