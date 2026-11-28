# PERF loop 94: the settling emissions emit only the members whose entry states changed (2026-11-28)

The data behind `bench/boot/REPORT.md` "PERF loop 94". Base 78d0bf39 (ABI 74); `new` is the commit's
`core/src/jit/block.rs` (`block::redo`, `Emission::edges`, the partial emissions; `looped` and `entries` once a
region). The cores are not committed (`bench/results/local/perf94/`, `cores.sha256`). M4 Mac mini, macOS, Chrome for
Testing 158.0.8127.88; the dev VM's Chromium 155.0.8059.84 for the counts.

- `counts/`: `diag.py` applied to the base (a diagnostic core) on the dev VM (`node bench/ab.ts --min 2 --cap 2`, the
  diagnostic core as both arms): per region of several blocks, the members whose inputs changed each settle
  iteration, what re-emitting only those would cost, and how many of the unsettled regions settle given 8 or 16
  iterations (Jacobi, whole emissions, counting only). `counts.py` reads `ab.json` (`counts.txt`). Its "changed"
  counts a member whose successors' flag states changed too (a superset of the rule kept) and assumes the first
  settling emission partial; `plain` changing makes it whole, which the second diagnostic counts.
- `words/`: `diag2.py` applied to the change: the guest instructions emitted (an emission of a member counts its
  words) by whole emissions, by the partial ones and skipped there, and the last emissions the base would have kept;
  `words.py` (`words.txt`).
- `check/`: base, new and `check` (the change with `Emission::found`'s check an `assert!` in release: every partial
  emission checked against a whole one) on `boot`, `user`, `node` and `smp` in the dev VM's Chromium, 2 pairs; no
  assertion failed; `counters.txt` from `python3 ../perf69/counters.py check/ab.json` (the VM's `emitNs`). The `new`
  arm's file was rebuilt during the run (`looped` and `entries` found once), so its later pairs are the kept core's.
- `dump.txt`: `bench/jit/dump-modules.ts` on Buildroot's boot (43 modules) and Alpine's (300), base against new:
  every module identical but three, which differ only in one constant, the CRC32 table's address in the core's
  memory (`i32.load offset=…`, 128 bytes later in the new core's data).
- `node/`, `smp/`: `bench/ab-mac.sh` on `node` (6 pairs) and on `smp` (`WORKLOADS=smp CAP=8`); `gates/`:
  `WORKLOADS=user,boot`. `counters.txt` from `python3 ../perf69/counters.py <dir>/ab.json`.
- `boots/`: the parallel boots, 3 rounds alternated (`ARMS="base new" PREFIX=p94 gates.sh 3 smp_alpine_jit
  smp_user_jit_4`, a copy of loop 71's), `summary.txt` from `python3 ../region64/summary.py boots p94 base new`, the
  Chrome processes' peak RSS in `rss/`.
- `pages/`: Firefox's pages session cut to two pages (`PAGES=wiki,mdn bench/gpu/ab-mac.sh <dir> 3 new=… base=…`, the
  first arm alternating), `pages-summary.txt` from `node bench/gpu/ab-summary.ts`.
