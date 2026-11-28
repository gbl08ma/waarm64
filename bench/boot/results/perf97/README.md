# PERF loop 97: per-ASID stashes of nG TLB entries, counted (2026-11-28)

The data behind `bench/boot/REPORT.md` "PERF loop 97". Tree 43696a9b (ABI 74). The dev VM's Node v26.7.0 and Chromium
155.0.8059.84; the Mac's Firefox pages session on M4, macOS, Chrome for Testing 158.0.8127.88.

- `diag.patch` (applies to 43696a9b): the `diag` tallies grown to 120 words; `mmu::P97`, a model of per-ASID stashes
  beside the real TLB (core/src/mmu.rs), counted in words 80-113 (`p97.py`'s names): at an ASID switch the live nG
  entries are kept for the old ASID (strict: only those; generous: with what was kept before), a walk's nG fill that
  matches the current ASID's stash is served; TLBI by VA, ASIDE1 (its ASID carried by a thread-local hint, and in
  parallel mode's queue in place of the VA) and everything drop from the stashes. It also counts the ASIDE1s of
  another ASID and the entries they drop and get refilled. Built with `CARGO_TARGET_DIR=target/diag
  scripts/build-wasm.sh --features diag`; the web/ part sums the words into `stats.jit.diag`.
- `preempt-counts.json`: `bench/boot/preempt-counts.ts boot user smp-user4` with that core in the dev VM's Node.
- `counts/`: `node bench/ab.ts --workloads node,smp --min 2 --cap 2 --warm none` with the diagnostic core as both arms
  in the dev VM's Chromium (counts only; its verdict means nothing).
- `pages-diag/`: one Firefox pages session with that core (`bench/gpu/ab-mac.sh <dir> 1 diag=<core>`); `jit.jsonl.gz`'s
  last line has the totals.
- `p97.py <jit.jsonl.gz | ab.json>`: the counts; `bound.py` (run here) writes `bound.txt`, the bound per workload.
