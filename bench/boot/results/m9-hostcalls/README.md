# Guest calls as host calls, again (2026-11-05)

`bench/boot/REPORT.md` "Guest calls as host calls, again: +10% on the Mac, Firefox lost in the VM"; the code on
branch `wip/host-calls` (XF-HANDOVER.md).

- `mac/`: the Mac host's sessions (`bench/gpu/sway-mac.sh`, `head-*` HEAD, `hc-*` host calls at `a2272932`):
  results, busy MIPS (`stalls.json`), the JIT's counters; `summary.txt`.
- `vm/`: the dev VM's (`bench/gpu/ab.sh`), with the renderer's RSS; `hc-1` lost Firefox (its `log.txt` kept),
  `hc-2` ran through (the A/B's own bound cut its post-processing: summarized by hand).
