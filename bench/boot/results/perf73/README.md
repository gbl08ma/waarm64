# PERF loop 73: the TLB's sibling fill, a collapsed TLBI queue's nG flush, the jump cache's size (2026-11-24)

The data behind `bench/boot/REPORT.md` "PERF loop 73". Hosts: the counts' Node runs on the dev VM (Node 26.7.0); the
rest on the Mac (M4, macOS 26.6.2, Chrome for Testing 158.0.8127.88).

- `diag.patch`: PERF loop 72's counters (`../perf72/README.md` names the slots) on this loop's commit, with three
  slots more in the TLB's (`Tlb::dg` 48-50: sibling fills at a read's walk and at a write's, and those over an entry)
  and two in the queues' (`tally::Q` 23, 24: collapsed queues of user-half VAs and ASIDs only, and of those the drains
  whose TLB held a low global entry). Built with `CARGO_TARGET_DIR=target/diag scripts/build-wasm.sh --features diag`.
  `report.py` labels every slot (`ops.json`: the helper histogram's).
- The counts, one run each, against `../perf72/`'s (the same workloads, the same counters, the tree before):
  `gates-vm.json` and `gates-vm-report.txt` (`node bench/boot/preempt-counts.ts --json … boot user smp-user4`: Alpine's
  boot, its userspace benchmark by phase, `smp_user_jit_4`'s guest on 4 vCPUs in parallel mode);
  `pages/` (one Firefox pages session from `target/snapbench/pages.waarm64snap`, `bench/gpu/ab-mac.sh <dir> 1
  diag=…`; `jit-last.json` is the last line of `jit.jsonl.gz`). `summary.py` → `summary.txt`: before → after.
- `gates-vm-jc131072.json`, `gates-vm-jc262144.json`: the same Node runs with `JC` at 131,072 and 262,144 (the jump
  cache's fills are slots 224-226).
- `node/`: `bench/ab-mac.sh` on `node`, 12 pairs: `base` (the tree before), `sib` (the sibling fill alone), `jc131`
  and `jc262` (the base with `JC` 131,072 and 262,144). `ab.json` has every sample, `verdict.txt` the verdict.
- `pages-ab/`: `bench/gpu/ab-mac.sh <dir> 3 base=… both=…` (the tree before; the sibling fill and the queue's change),
  three rounds alternated: each session's `results.json`, `counts.json`, `stalls.json`, `wall.txt`, and
  `summary.txt` (`node bench/gpu/ab-summary.ts`), `summary.json` (`--json`).
- `gates/`: `WORKLOADS=user,boot bench/ab-mac.sh` for `base` and `both`: the one-vCPU gates.
