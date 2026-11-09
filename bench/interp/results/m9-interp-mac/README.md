# The block interpreter on the Mac host (2026-11-09)

bench/interp/REPORT.md "The block interpreter on the Mac, loop 1". The M4 Mac mini (macOS 26.6.2), Chrome for Testing
157.0.8103.38; base `86c6ddf3`.

- `diag/`: counters through Firefox's pages session from `pages.webpcsnap` (`bench/gpu/sway-mac.sh`, `SCRIPT=firefox-load.ts
  PHASES=pages`). `diag.patch` is the diagnostic core (against `86c6ddf3`; not for commit): per table, why `hot` returns and
  what `jit::interpret` and the dispatcher do then, dumped as `webpc-slow diag2` lines every 20 s (`web/vm.ts` gets a
  `diag_log` import); `SLOTS_LOG2` and `SLOT_XOR` at build time size the slots and fold the hash; the `g_*` counters
  (why loads and stores leave `hot`) are process-wide statics that every table prints, so their sums over tables count
  each ~4 times. `diag2.ts.txt` sums a session's last line per table (rename to `.ts`). `counts.txt`: 16 K slots
  (main's); `counts-s14x1.txt` 16 K with the folded hash; `counts-s16x0.txt` and `counts-s16x1.txt` 64 K without and
  with it; `counts3.txt` the load/store causes.
- `nocall/`: main against the build without calls in `hot`, `bench/interp/ab-mac.sh nc 3 main=… nocall=… -- dec_mips
  vm_dec_mmu_mips boot_alpine_dec`, rounds alternated (`nc-r<round>-<arm>-<bench>.json`).
- `diag/counts4-s18.txt`, `diag/diag4.patch`: the counting core with 262,144 slots (`SLOTS_LOG2=18`) and the misaligned
  stores counted apart (`g_o_align_st`, `g_s_align_st`; `g_o_align` and `g_s_align` are then the loads).
- `slots/`: main (`a1ae06f4`) against 262,144 slots. `sl-<arm>-r<round>.json` and `.jit.jsonl.gz`: Firefox's pages
  session from the snapshot with `PHASE_S=1` (`ab-pages.sh.txt`, rename to `.sh`; `pages-summary.txt` its lines: each
  page's Firefox start + load, s, and their sum); `sg-r<round>-<arm>-<bench>.json`: the block-interpreter guests and the
  JIT gates (`bench/interp/ab-mac.sh sg 3 … -- dec_mips vm_dec_mmu_mips boot_alpine_dec alpine_user_jit
  boot_alpine_jit`).
