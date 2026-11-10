# Where the JIT's wasm bytes go: a static census (2026-10-30)

The data behind the backlog's former "Where the JIT's wasm bytes go" (closed by PERF loop 13: `bench/boot/REPORT.md`, docs/jit.md "Tried and not kept"). A diagnostic core (`diag.patch`, applied to main at
1fbaa7d, not on main) adds a `webpc.diag` custom section to every module the JIT emits: for each function, each guest
instruction's byte range in the body (inline, helper call, a group's leader or follower), the block's failure chain,
its tail (edges, write-backs, the PC, chaining, the return), the prologue and the NZCV commit before a branch, and
nested marks inside those: register stores (`Func::store_cpu`) and reloads (`Func::load`), NZCV stores
(`store_flags`, `chain_close`), PC stores, `block::chain`, `emit::via_jc`, `emit::indirect`, region edges, load/store
slow arms (`fallback_arm`) and TLB probes (`access`, up to `HOST`).

**Workload:** the page's Debian 13 through UEFI (2 vCPUs, unattended, Chromium 153 headless, a cloud session's
x86_64 container), boot to the login prompt, then `tools/capture-debian.ts`'s shell workload (`ls -lR`, `apt-cache
dump`, gzip, sha256sum, find, journalctl, a perl loop). Every module the compile worker received was written out (a
`fetch` to `/__jitdump` from `web/jit-compile-worker.ts`, also in the patch, answered by Playwright's routing): 1,379
modules, 28,661 functions, 35.1 MB of function bodies. **Static counts**: bytes emitted, not weighted by execution;
no timings. Firefox's pages session and Alpine (the ranking workloads) weren't available in that session.

Files (`*.txt` from the tools over the capture, which isn't kept: 62 MB):
- `pieces.txt` (`analyze.py`): bytes by piece, by instruction class, and the opcodes in each piece.
- `nested.txt` (`nested.py`): the nested marks by the piece they sit in.
- `chains.txt` (`chains.py`): `block::chain`'s shapes: a jump-cache tail for a successor not compiled yet (`none+jc`),
  a transfer-cache probe for one in another page not compiled yet (`none+xc`), a direct tail call (`direct`), and a
  direct call behind the instruction-TLB check with the transfer-cache probe after it (`direct+guard+xc`).
- `nzcv.txt` (`nzcv.py`): NZCV stores by size: 74 B (SUBS, 64-bit), 69 (SUBS, 32-bit), 61/66 (ADDS), 23/27 (logical).
- `peephole.txt` (`peephole.py`): adjacent patterns over every body (`local.set N; local.get N`, a 0 added).
- `idioms.txt` (`cands.py`): the bytes shorter forms of single instructions would save (UBFM as LSR/LSL, SXT* as
  `extendN_s`, CSET/CSETM, `ADD #0`).
- `tools/nzcvcheck.py`: SUBS's NZCV as `r = x - y`, `C = x >=u y`, `V = sign((x ^ y) & (x ^ r))` against
  AddWithCarry(x, ~y, 1), both widths, edge values and random ones: equal.
- `tools/wasmdis.py`: the minimal decoder the rest use; `tools/showk.py <dir> <kind> [n] [skip]` disassembles marks.

Run: apply `diag.patch`, `scripts/build-wasm.sh`, `node bench/boot/results/wasm-size/tools/capture-debian.ts <out>`
(needs `node tools/debian.ts` and the firmware), then `python3 -I tools/<x>.py <out>` (`cands.py` needs `analyze.py`'s
`insts.pkl` and the code bytes); restore the source and rebuild the wasm afterwards.
