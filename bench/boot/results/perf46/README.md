# PERF loop 46: what an epoch's modules keep alive (2026-11-22)

The data behind `bench/boot/REPORT.md` "PERF loop 46".

- `diag.patch`: the diagnostic against e938b630: the code cache records each module of the epoch (its slots, bytes and
  the slots it imports, from its links), and samples every 1024 installs, before each flush or `IC IALLU` and at each
  helper report: which functions the block map still names (a head or an entry), which unnamed ones are loop heads
  compiled alone that tiered up (`Cache::tiers`' words), the modules with every function unnamed (freeable, or still
  imported by a module that is named, transitively) and those with some unnamed (their bytes, and the unnamed share by
  function count, all of it and the invalidated part). Reported as `D:` lines of `jit_helper_report`; the page's
  status carries them (`diag`) and `bench/gpu/guest-session.ts` writes them to `mem.jsonl`.
- `mods.ts`: runs Alpine's boot and userspace (deterministic, 1 vCPU) and `smp_alpine_jit`'s boot and `smp_user_jit_4`
  (parallel realtime, 4 vCPUs) in Node with the diag core (`target/mods`); `alpine.json` its output (`marks`: the
  samples at each guest mark; `end`: at the last).
- `pages/`: Firefox's pages session from `target/snapbench/pages.waarm64snap` (cda6cfa7's core) on the Mac (M4,
  Chrome for Testing), `MEMLOG=10 MEMLOG_UASM=0 bench/gpu/ab-mac.sh <dir> 1 diag=<diag core>`, one session; the
  screenshots dropped. `pages-summary.txt`: `node memsum.ts pages` (every 10 s, the last sample's values).
  `pages-first/`: an earlier session with the patch before the tiered-head split (the same counts otherwise).
