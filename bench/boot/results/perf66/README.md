# PERF loop 66: `REGION_AFTER` on the Mac (2026-11-23)

The data behind `bench/boot/REPORT.md` "PERF loop 66". Base 8505db4a (ABI 74); every core built from it with only
`jit::REGION_AFTER` changed (1000 the base, 250, 0), and `ra0t` with `taken.patch` too (`region_after` 0 and a loop
region's members, inner loops' heads apart, taken in the batch so no forward region compiles them). M4, macOS, Chrome
for Testing 158.0.8127.88.

- `diag.patch`: the diagnostic core (`--features diag`) behind the counts. Compiled code tallies the entries into a
  loop head compiled alone that go through its redirected hot word, and those while it still counts down; the cache
  tallies the heads compiled alone, the blocks of tier-up regions and the blocks compiled again (compiled before since
  the last flush or their page's IC, or twice in one module). It publishes them in the static flag counters' words;
  `counts.py <ab.json>` names them.
- `diag/`: `bench/ab-mac.sh` with the diagnostic cores (`MIN=2 CAP=2 WORKLOADS=node,user,boot`), `counts.txt` from
  `counts.py`. Their times are the diagnostic cores' (not a verdict).
- `node/`, `gates/`: `bench/ab-mac.sh` on `node` (ra1000, ra250, ra0, ra0t) and `WORKLOADS=user,boot` (ra1000,
  ra250); `counters.txt` from `python3 ../perf65/counters.py <ab.json>`.
- `smp/`: the parallel boots `smp_alpine_jit` and `smp_user_jit_4`, ra1000 against ra250, 3 rounds alternated
  (`PREFIX=p66 gates.sh 3 smp_alpine_jit smp_user_jit_4`; `p66-<arm>-r<round>-<bench>.json`, the Chrome processes'
  peak RSS in `rss/`); `summary.txt` from `python3 ../region64/summary.py smp p66 ra1000 ra250` (the change is
  ra250's median of the rounds' medians over ra1000's).
- `pages/`: Firefox's pages session cut to two pages (`PAGES=wiki,mdn bench/gpu/ab-mac.sh pages 3 ra250=… ra1000=…`),
  `summary.txt` from `node bench/gpu/ab-summary.ts`. `pages-diag/`: one session of each diagnostic core (the counts in
  the last line of `jit.jsonl.gz`, the words as in `counts.py`).
