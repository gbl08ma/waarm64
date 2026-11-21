# Lazy NZCV at loop heads, and the branch outcome at a loop's exit: counted (2026-11-21)

A cloud session's exploration (x86_64 container, Node v26.13.1, V8 14.6.202.34-node.40, Playwright's Chromium
153.0.8010.12; docs/cloud.md): counts, V8's machine code and a noisy paired A/B. Nothing here is a speed claim: the
Mac's gates decide (PERF-HANDOVER.md). The write-up is bench/boot/REPORT.md "Lazy NZCV at loop heads, counted".

- `experiment.patch` (on 4b24f2d4's core, not for merging): two tallies in the diagnostic core (`tally::FLAG_COLD`,
  `FLAG_HOT`: a region's edge taken whose block stored lazy NZCV for the member it enters, split by whether only that
  member's cold paths need it before its first setter: `Func::touched_hot`), and two features that change the code:
  `flagx` (such a member's flags count as dead: **unsound**, a cold path's exception saves a stale NZCV; it bounds a
  fix) and `takenx` (an exit computes a lazy B.cond's outcome again instead of reading `TAKEN`: sound as far as it
  goes, partial).
- `tools/counts.mjs`: the tallies on bench/interp's EL1 guest in Node. `tools/debian-page.mjs` with
  `tools/worker-heap-diag.patch`: the tallies over Debian's boot on the page (`debian-boot-1cpu.json`).
- `tools/paired.mjs`: arms side by side in one Node process on the small guests and on the introduction's capture
  guest (`paired-node-x64*.json`; percent over the base in the same iteration, median [quartiles]).
- `tools/loopcode.mjs`: TurboFan's code for the capture guest's loops under a core (`loops-x64.txt`).

Builds: `CARGO_TARGET_DIR=target/diag scripts/build-wasm.sh --features diag`, likewise `flagx`, `takenx`,
`takenx,flagx`.
