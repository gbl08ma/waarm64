# VK4 handover

## R5 to R7: one check left (2026-11-01)

Done and committed locally on `main`, **not pushed**: R5, R6, R7, the out-of-context review of them and its fixes
(VENUS-VK4-REVIEW.md, top), and `tests/page-deqp-vk.test.ts` running the list as two machines. `scripts/ci.sh`,
`ci-graphics.sh`, `ci-debian.sh` and `ci-machines.sh` passed on the code as committed (the commit after them touched only
the dEQP-VK test and docs/testing.md). **`scripts/ci-deqp-vk.sh` hasn't passed on the final code**: the runs of it were on
earlier code, or stopped, or killed by memory. Per-group subsets passed: sampling 7,095, memory and bindings 1,458,
`api.info` and vertex input 4,250, all before the review's fixes.

The two machines were killed twice by an 11 GiB `MemoryMax` on the 14 GiB VM, at ~16 min, as the list's memory-heavy stretch
reaches both at once (one's GPU process went 0.9 → 2.3 GiB in two minutes; a shard's RAM of 1,536 MiB didn't save it).
One machine peaks at 8.9 GiB. So the VM is being moved to 18 GiB (oracle to 4 GiB).

Next:
1. Check `free -g` shows ~18 GiB (the test takes two machines past 17 GiB of RAM; `WEBPC_DEQP_VK_SHARDS` overrides), and
   `vk/build.sh` and `scripts/build-wasm.sh`' outputs are there (target/ survives a restart, /tmp doesn't).
2. Run it alone, in the background, with a larger cap than CLAUDE.md's standard 10 GiB:
   `systemd-run --user --scope -q -p MemoryMax=14G -p MemorySwapMax=0 -- timeout 3300 scripts/ci-deqp-vk.sh`.
   14 GiB is an estimate: note the scope's peak (`journalctl --user | grep 'memory peak'`) and the time, against one
   machine's 37-40 min. A run pinned at its cap thrashes for many minutes before it's killed: watch for it.
3. If a case fails, fix it (the review's fixes were never under the whole list). `api.info.image_format_properties2.*` of
   YCbCr formats crash by the watchdog (backlog), and aren't listed.
4. Record the time and peak: docs/testing.md "`scripts/ci-deqp-vk.sh`", the `~40 min` in CLAUDE.md and the script's header, the
   cap needed in CLAUDE.md's "Cap memory on heavy runs" if it differs, and the VM's RAM in CLAUDE.md "Development
   environment" and docs/devenv.md (oracle too).
5. Mark `R7`'s "On the M4 not run" still true or run it, `git fetch`, rebase onto origin/main, push; delete this file then.
