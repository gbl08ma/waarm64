# PERF loop 34: what's left of the preemption's cost (2026-11-16)

The data behind `bench/boot/REPORT.md` "PERF loop 34". Base: ce9a22a7 (loop 33's code); new: this loop (plain loads
for the polls but on looped regions' edges).

- `cs-*-forms.json`: `bench/jit/codestats.ts` (arm64, x64) on one set dumped by `dump-modules.ts --parallel 1` from the
  base core (Alpine's boot, parallel SMP on 1 vCPU), and on the same set with its polls rewritten in place by
  `rewrite.mjs` (same length, so the same functions): `plain` (`nop; i32.load`), `zero` (`0 <u word`: the
  `word != 0` form), `plainzero`, `none` (`i32.const 1`: no poll at all, the bound of what polls cost); a second base
  dump as the run-to-run noise.
- `cs-*-final.json`: a set dumped by this loop's core built with a `nop` before each plain poll's load, against the
  same set with those rewritten back to `i32.atomic.load` (`rewrite.mjs … atomic`): the kept change, exactly.
- `cs-*-noacc.json`: `noacc.patch` (measurement only: `acc` a constant 0, no edge bumps, so the poll reads
  `0 < word`; the dispatcher passes 0) dumped twice against the base's dumps (different runs: per-function means).
- `counts-base.json`, `counts-new.json`: `bench/boot/preempt-counts.ts` with each arm's diagnostic core, Node 26.7.0 on
  the dev VM: `smp1`, `smp4`, `smp-user4`.
- `deterministic-modules.json`: the SHA-256 of every module of Alpine's deterministic boot under both cores: 319 each,
  2,651,076,469 steps each, none differing.
- `mac-r<round>-<arm>-<bench>.json`: the Mac A/B (`bench/run-mac.sh` with `WASM=` per arm, Chrome for Testing 157), 5
  rounds, each round's arm order rotated (base, new, noacc; new, noacc, base; …), nothing else running on the dev VM.
  The `noacc` arm ran with `compile-stops.patch` (PERF loop 32's: the compile worker stores 0 in the stop words when
  modules are ready) applied to `web/` for its runs only: its chunks end only at exits and setters, so this keeps the
  installs of compiled modules prompt; its step counts (and MIPS) are wrong by design. `python3 summary.py . mac base
  new` prints each bench's per-round medians as ranges, the change and the overlap.
- `hoist.mjs`, `tailself.mjs`: what TurboFan does with a plain `i32.load` of a shared memory word in a `loop` (loaded
  once before it) and across a direct tail call to itself (inlined four levels, merged, then a real call that loads
  again): `node --no-liftoff --no-wasm-lazy-compilation --print-wasm-code hoist.mjs [atomic]`, `node --print-wasm-code
  tailself.mjs`.
