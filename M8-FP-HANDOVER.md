# M8 JIT: floating point MIPS, handover for the dev VM (2026-10-17)

A side track asked for by the user: what more can raise floating point MIPS in the JIT. A cloud session
read the FP code at `3bf4473` (the double FMA round-to-odd fix `ed20c9f` included) and measured where the
FP guest's time goes; nothing was changed. **Nothing here is approved yet: show the user the plan (or the
first item's numbers) before keeping anything.** Read first: docs/jit.md "Floating point (`emit/float.rs`)",
`bench/interp/REPORT.md` "M8: inline FMA", docs/backlog.md "The vector FP fast paths' lane checks".

## Where the FP guest's time goes

`jit_fp_mips` retires 100% of its steps inline (no helper calls), so what's left is the inline code.
Ceiling experiments are deliberately wrong patches that skip work and show what it costs. These ran in
the cloud container (Xeon @ 2.8 GHz, 4 cores, Playwright's Chromium), `node bench/run.ts --page
bench/interp/index.html --only jit_fp_mips`, eight placements, the medians of two runs each. **Not the
dev VM's numbers: re-measure there before trusting the split.**

| build | FP guest (MIPS) | what it skips |
|---|---|---|
| main | 242.0, 238.4 | |
| single FMA without TwoSum + round to odd | 313.8, 308.7 | the single forms' exact sum (+29%) |
| every FMA form unfused (`a*b + c`) | 342.8, 341.7 | also the double emulation (another +10%) |
| fast-path checks dropped (`guarded`'s condition forced true), FMA as on main | 435.9, 439.2 | every operand, result and lane test (+80%) |
| checks dropped and FMA unfused | 1023.2, 1030.4 | both (4.2×) |

The integer guest on the same host is 1994 (5175 on the M4, where the FP guest is ~710), so the
FP/integer gap is about the same as in the dev VM. The checks cost more once FMA is cheaper (342 → 1027).

## The plan, ranked by gain against effort

1. **Single FMA: a midpoint test instead of round to odd** (ceiling +29%, small). The single forms
   (vector FMLA/FMLS and by element, scalar FMADD & co. with sz = 0) form the exact product in f64,
   then run TwoSum (6 ops) and the integer round to odd (~8) so the demote rounds once. Instead, take
   the plain RNE f64 sum and send the instruction to the helper when its low 29 bits are exactly
   `1 << 28` (an f32 midpoint). RN followed by RN can only round wrong when the first rounding lands
   exactly on a midpoint of the narrower format, which on real data is about one sum in 2^29. One
   `and` + `eq` per lane, folded into the lane mask. Check it with the `core/src/fp/tests.rs` models
   (rewrite the single model to the new algorithm), jit-diff's midpoint cases, a planted bug (drop the
   midpoint test: they must fail). Gates: `jit_fp_mips`, `gl_llvmpipe_jit` (single-FMLA heavy).
2. **FP instructions that are still helpers** (not measured, small to medium each): scalar
   FCMP/FCMPE, FCCMP, FCSEL, scalar FCVT (single↔double), FMAX/FMIN/FMAXNM/FMINNM (scalar and
   vector), the scalar FRINT* (only the vector FRINTs are inline). The FP guest never runs them, but
   compiled code branches on FCMP constantly. **Count first:** `jit_helper_report` on the desktop
   guest's Firefox (`bench/gpu/firefox-load.ts` or the JIT track's sessions) and one FP app; build only
   what shows up. FCMP never rounds (Invalid only on NaNs), so it needs no FPOK and can set NZCV the
   way integer compares do; FCSEL is bit work. Consider an FCMP/FCSEL/FCVT kernel in
   `bench/interp/guest-fp.c` so the benchmark sees them.
3. **Fewer fast-path checks** (ceiling +80% now; medium to large). The real gain is a fraction of the
   ceiling, since some checks must stay:
   - *Known-good values within a block* (new): a value an inline FP op wrote whose result check
     passed is normal (or an accepted zero) until that register is written again, so a later FP op
     reading it can skip its operand test and keep only the result test. Emit-time bookkeeping (a
     mask per V register, cleared on any other write and at the fallback's join). Medium.
   - *Cheaper masks* (backlog): float compares on `|x|` against the smallest normal and infinity
     instead of shift/and/sub/compare. Small; gain guessed.
   - *One check for a run* (backlog): AND the masks along a run, branch once, replay the run from
     saved inputs. The most gain and the most work.
4. **Double FMA through a host fused op** (ceiling ~+10% on this guest; risky). Only relaxed-simd's
   `f64x2.relaxed_madd`, which may not fuse depending on the host and V8's tier: it would need a probe
   and a guarantee that Liftoff and TurboFan agree. Leave it unless a double-heavy workload needs it.
5. **Scalar FP without the v128 round trip** (guessed, medium): scalar ops read Vn with `extract_lane`
   and write Vd with `v128.const 0` + `replace_lane` (`vlane`/`vset_scalar` in emit.rs). A scalar
   shadow local per register would cut that from chains like n-body and Horner. Run a ceiling test first.

Not FP MIPS levers: the interpreter's FP (cold code only), advertising FP16/FHM/BF16/JSCVT.

## Docs to fix along the way

docs/jit.md claims FCSEL (the "FABS, FNEG, FMOV, FCSEL" line) and scalar FCVT ("Conversions") are
inline; neither is in `emit/float.rs`. Its "What still runs through helpers" still names "f64 FMA",
which has been inline since 2026-10-14.

## Rules that apply

Per CLAUDE.md: A/B in one session, alternating, eight placements, result JSON committed behind the
report (`bench/interp/REPORT.md`); `scripts/ci.sh` before any item counts as done; step counts don't
move (none of this is guest-visible); a planted bug per new JIT rule, then restore and rebuild the wasm.
