//! FEAT_FP16's half-precision arithmetic and FEAT_FHM's FMLAL/FMLSL inline
//! (PERF loop 10, docs/jit.md "Half precision"). Wasm has no f16: the lanes
//! go to singles exactly ([`widen`]), the operation runs in f32, and the
//! result comes back to half by integer rounding to nearest even ([`pack`]).
//! That's ARM's result: a half's product is exact in a single (22 bits), so
//! FMA forms are a multiply and one rounded add; FADD, FSUB, FMUL, FDIV and
//! FSQRT round twice, which is innocuous at 24 ≥ 2 × 11 + 2 bits (Figueroa),
//! while an FMA's single sum is tested off a half's midpoint, where a second
//! rounding could go the wrong way. Under the block's guards (FPOK: nearest
//! even and IXC set, so Inexact needs no test; FZ16 clear: `HOK`), with no
//! infinite or NaN operand (the widening makes those finite) and a single
//! result that rounds to a half above the smallest normal binade and below
//! infinity, or an exact zero (a zero sum, product or quotient of halves is
//! exact in singles), nothing else can be raised. The compares, FMAX/FMIN and
//! FMAXNM/FMINNM work on the halves' bits (no rounding, no flags without a
//! NaN), FABS, FNEG and FMOV are bits. The rest are helpers (the list in
//! docs/jit.md).

use core::mem::offset_of;

use super::float::{denormal_any, fpa_guard, guarded, under_fz_bad};
use super::{AND, Ctx, EQZ, FPOK, Func, HOK, HT, VCPU, VT, WC, get, set, vbit};
use crate::cpu::Cpu;
use crate::decode::Op;
use crate::interp::{bit, bits};

mod op {
    pub const AND: u32 = 0x4e;
    pub const ANDNOT: u32 = 0x4f;
    pub const OR: u32 = 0x50;
    pub const XOR: u32 = 0x51;
    pub const BITSELECT: u32 = 0x52;
    pub const I16X8_EXTRACT_U: u32 = 0x19;
    pub const I16X8_EQ: u32 = 0x2d;
    pub const I16X8_LT_S: u32 = 0x2f;
    pub const I16X8_LT_U: u32 = 0x30;
    pub const I16X8_GT_S: u32 = 0x31;
    pub const I16X8_GT_U: u32 = 0x32;
    pub const I16X8_LE_S: u32 = 0x33;
    pub const I16X8_LE_U: u32 = 0x34;
    pub const I16X8_GE_S: u32 = 0x35;
    pub const I16X8_GE_U: u32 = 0x36;
    pub const I32X4_EQ: u32 = 0x37;
    pub const I32X4_LT_U: u32 = 0x3a;
    pub const F32X4_EQ: u32 = 0x41;
    pub const I16X8_ALL_TRUE: u32 = 0x83;
    pub const I16X8_NARROW_S: u32 = 0x85;
    pub const I16X8_SHL: u32 = 0x8b;
    pub const I16X8_SHR_S: u32 = 0x8c;
    pub const I16X8_SUB: u32 = 0x91;
    pub const I16X8_MIN_S: u32 = 0x96;
    pub const I16X8_MAX_S: u32 = 0x98;
    pub const I16X8_MAX_U: u32 = 0x99;
    pub const I32X4_ALL_TRUE: u32 = 0xa3;
    /// i32x4.extend_low/high_i16x8_s.
    pub const EXTEND_S: [u32; 2] = [0xa7, 0xa8];
    pub const I32X4_SHL: u32 = 0xab;
    pub const I32X4_SHR_U: u32 = 0xad;
    pub const I32X4_ADD: u32 = 0xae;
    pub const I32X4_SUB: u32 = 0xb1;
    pub const F32X4_ABS: u32 = 0xe0;
    pub const F32X4_NEG: u32 = 0xe1;
    pub const F32X4_SQRT: u32 = 0xe3;
    /// f32x4 add, sub, mul, div.
    pub const F32X4: [u32; 4] = [0xe4, 0xe5, 0xe6, 0xe7];
}

/// `x` in every 16-bit lane.
fn s16(x: u16) -> u128 {
    (0..8).fold(0, |v, k| v | (x as u128) << (16 * k))
}

/// `x` in every 32-bit lane.
fn s32(x: u32) -> u128 {
    (0..4).fold(0, |v, k| v | (x as u128) << (32 * k))
}

/// The 16-bit lanes past the first `n` (all ones): lanes a form doesn't use,
/// ORed into its masks.
fn unused16(n: u32) -> Option<u128> {
    (n < 8).then(|| u128::MAX << (16 * n))
}

/// A v128 of halves (an operand: a V register, maybe shuffled or negated).
type Src<'a> = &'a dyn Fn(&mut Func);

/// Once a block, before its first half-precision fast path: HOK = FPCR.FZ16
/// is clear (FZ16 flushes denormal halves, which these paths take as
/// singles). Like FPOK, it holds to the block's end. Emitted outside any branch.
fn half_guard(c: &mut Func) {
    if c.fp16_ok {
        return;
    }
    c.fp16_ok = true;
    c.local_get(VCPU)
        .i64_load(offset_of!(Cpu, fpcr) as u32)
        .i64_const(1 << 19)
        .i64_and()
        .op(EQZ + WC)
        .local_set(HOK);
}

/// Pushes the f32x4 of `src`'s halves 0..3 (`hi`: 4..7), exactly: each
/// sign-extended and shifted into a single's fields (bits 30:28 cleared) is
/// its value × 2^-112, denormals too, so a multiply by 2^112 converts it. An
/// all-ones exponent comes out finite (from 2^16): [`finite`] rejects those.
fn widen(c: &mut Func, src: Src, hi: bool) {
    src(c);
    c.simd(op::EXTEND_S[hi as usize]);
    c.i32_const(13).simd(op::I32X4_SHL);
    c.v128_const(s32(0x8fff_ffff)).simd(op::AND);
    c.v128_const(s32(0x7780_0000)).simd(op::F32X4[2]); // × 2^112
}

/// Pushes an i16x8 mask: all ones where no `srcs` lane has an all-ones
/// exponent (∞ or NaN; `inf`: NaN only): the lanes shifted left once (the sign
/// gone), their unsigned maximum below 0x7c00's (or at most).
fn finite(c: &mut Func, srcs: &[Src], inf: bool) {
    for (j, s) in srcs.iter().enumerate() {
        s(c);
        c.i32_const(1).simd(op::I16X8_SHL);
        if j > 0 {
            c.simd(op::I16X8_MAX_U);
        }
    }
    c.v128_const(s16(0xf800))
        .simd(if inf { op::I16X8_LE_U } else { op::I16X8_LT_U });
}

/// Pushes an i32x4 mask: the singles in local `r` round to a half from the
/// second binade (2^-13) to the largest finite (|r| < 65520), or are ±0
/// (exact: see the module's comment); with `fma`, not on a half's midpoint
/// (low 13 bits 0x1000), where the second rounding could differ.
fn fast(c: &mut Func, r: u32, fma: bool) {
    c.local_get(r).i32_const(1).simd(op::I32X4_SHL);
    c.v128_const(s32(114 << 24)).simd(op::I32X4_SUB);
    c.v128_const(s32((0x477f_f000u32 << 1) - (114 << 24)))
        .simd(op::I32X4_LT_U);
    if fma {
        c.local_get(r).v128_const(s32(0x1fff)).simd(op::AND);
        c.v128_const(s32(0x1000))
            .simd(op::I32X4_EQ)
            .simd(op::ANDNOT);
    }
    c.local_get(r).v128_const(0).simd(op::F32X4_EQ).simd(op::OR);
}

/// Pushes the i32x4 of the halves' magnitudes the singles in local `r` round
/// to (nearest even), for lanes [`fast`] accepts: × 2^-112 (exact, still
/// normal) puts the half's exponent in the single's field, so the rounded
/// magnitude is (m + 0xfff + (m >> 13 & 1)) >> 13, and a zero stays 0.
/// Scratch: HT[3].
fn mags(c: &mut Func, r: u32) {
    let t = HT[3];
    c.local_get(r)
        .v128_const(s32(0x0780_0000))
        .simd(op::F32X4[2]); // × 2^-112
    c.simd(op::F32X4_ABS).local_tee(t);
    c.local_get(t).i32_const(13).simd(op::I32X4_SHR_U);
    c.v128_const(s32(1)).simd(op::AND).simd(op::I32X4_ADD);
    c.v128_const(s32(0xfff)).simd(op::I32X4_ADD);
    c.i32_const(13).simd(op::I32X4_SHR_U);
}

/// Each i32 lane's low (`hi` false) or high 16 bits, of the first v128 on the
/// stack, then the second's.
fn halves16(hi: bool) -> [u8; 16] {
    core::array::from_fn(|b| (b as u8 / 2) * 4 + b as u8 % 2 + 2 * hi as u8)
}

/// Pushes the i16x8 of the halves the singles in locals `lo` (lanes 0..3) and
/// `hi` (4..7, if any) round to: their magnitudes ([`mags`]) with the
/// singles' signs.
fn pack(c: &mut Func, lo: u32, hi: Option<u32>) {
    mags(c, lo);
    match hi {
        Some(h) => mags(c, h),
        None => {
            c.v128_const(0);
        }
    }
    c.shuffle(halves16(false));
    c.local_get(lo);
    match hi {
        Some(h) => {
            c.local_get(h);
        }
        None => {
            c.v128_const(0);
        }
    }
    c.shuffle(halves16(true));
    c.v128_const(s16(0x7fff)).simd(op::BITSELECT);
}

/// Vd = the halves in local `l`: `n` lanes (8; 4, the top half cleared; 1,
/// a scalar: the rest cleared).
fn put(c: &mut Func, rd: u32, n: u32, l: u32) {
    c.local_get(l);
    match n {
        8 => {}
        4 => {
            c.i64_const(0).simd_lane(0x1e, 1); // i64x2.replace_lane 1
        }
        _ => {
            c.v128_const(0xffff).simd(op::AND);
        }
    }
    c.vset(rd);
}

/// Reduces the i16x8 lane mask on the stack to an i32 (the first `n` lanes
/// all ones), ANDed with HOK (and FPOK with `fpok`).
fn all16(c: &mut Func, n: u32, fpok: bool) {
    if let Some(m) = unused16(n) {
        c.v128_const(m).simd(op::OR);
    }
    c.simd(op::I16X8_ALL_TRUE).local_get(HOK).op(AND);
    if fpok {
        c.local_get(FPOK).op(AND);
    }
}

/// What an arithmetic form computes from its widened operands.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    /// add, sub, mul, div (0..=3), then `abs` (FABD) or negated (FNMUL).
    Bin {
        kk: usize,
        abs: bool,
        neg: bool,
    },
    Sqrt,
    /// a × b + c, `na` and `nc` negating a and c first (ARM's FPMulAdd order).
    Fma {
        na: bool,
        nc: bool,
    },
}

/// The arithmetic forms on `n` lanes (1, 4 or 8) of halves: `a` and `b` (and
/// `acc` for FMA) push the operands; by element, `b` is the element in every
/// lane, widened once.
#[allow(clippy::too_many_arguments)]
fn arith(
    c: &mut Func,
    cx: &Ctx,
    i: u32,
    k: usize,
    (n, rd): (u32, u32),
    kind: Kind,
    a: Src,
    b: Src,
    acc: Option<Src>,
    by_element: bool,
) {
    fpa_guard(c);
    half_guard(c);
    let r = [VT[0], VT[1]];
    let wb = HT[0];
    if by_element && kind != Kind::Sqrt {
        widen(c, b, false);
        c.local_set(wb);
    }
    let parts: &[bool] = if n == 8 { &[false, true] } else { &[false] };
    for &hi in parts {
        widen(c, a, hi);
        let wide_b = |c: &mut Func| {
            if by_element {
                c.local_get(wb);
            } else {
                widen(c, b, hi);
            }
        };
        match kind {
            Kind::Bin { kk, abs, neg } => {
                wide_b(c);
                c.simd(op::F32X4[kk]);
                if abs {
                    c.simd(op::F32X4_ABS);
                }
                if neg {
                    c.simd(op::F32X4_NEG);
                }
            }
            Kind::Sqrt => {
                c.simd(op::F32X4_SQRT);
            }
            Kind::Fma { na, nc } => {
                if na {
                    c.simd(op::F32X4_NEG);
                }
                wide_b(c);
                c.simd(op::F32X4[2]); // exact
                c.local_tee(HT[4 + hi as usize]);
                widen(c, acc.unwrap(), hi);
                if nc {
                    c.simd(op::F32X4_NEG);
                }
                c.local_tee(HT[6 + hi as usize]);
                c.simd(op::F32X4[0]); // the one rounding to single
            }
        }
        c.local_set(r[hi as usize]);
    }
    let fma = matches!(kind, Kind::Fma { .. });
    // No ∞ or NaN operand, and fast results in every lane used.
    let mut srcs: Vec<Src> = vec![a];
    if kind != Kind::Sqrt {
        srcs.push(b);
    }
    if let Some(x) = acc {
        srcs.push(x);
    }
    let test = |c: &mut Func, exact: bool| {
        finite(c, &srcs, false);
        for hi in [false, true] {
            if hi && n != 8 {
                c.v128_const(u128::MAX);
                continue;
            }
            let r = r[hi as usize];
            fast(c, r, fma && !exact);
            if exact {
                // A single sum on a half's midpoint is fine when it's exact (the one
                // rounding is the half's): s - p == c and s - c == p (as Fast2Sum's
                // error, from whichever is larger).
                let (p, a) = (HT[4 + hi as usize], HT[6 + hi as usize]);
                c.local_get(r).v128_const(s32(0x1fff)).simd(op::AND);
                c.v128_const(s32(0x1000)).simd(op::I32X4_EQ);
                c.local_get(r).local_get(p).simd(op::F32X4[1]);
                c.local_get(a).simd(op::F32X4_EQ);
                c.local_get(r).local_get(a).simd(op::F32X4[1]);
                c.local_get(p).simd(op::F32X4_EQ).simd(op::AND);
                c.simd(op::ANDNOT).simd(op::ANDNOT);
            }
        }
        c.simd(op::I16X8_NARROW_S).simd(op::AND);
        all16(c, n, true);
    };
    test(c, false);
    if fma {
        // Exact sums of short significands land on midpoints often: then, in a
        // branch, the test again with those that are exact let through.
        c.if_t(super::I32).i32_const(1).else_();
        test(c, true);
        c.end();
    }
    let out = HT[1];
    guarded(c, cx, i, k, vbit(rd), |c| {
        pack(c, r[0], (n == 8).then_some(r[1]));
        c.local_set(out);
        put(c, rd, n, out);
    });
}

/// Pushes the i16x8 of `src`'s halves as signed magnitudes (±0 alike), which
/// order as the values do without NaNs: (m ^ s) - s, m the magnitude, s the
/// sign spread. Scratch: `t`.
fn signed_mag(c: &mut Func, src: Src, t: u32) {
    src(c);
    c.local_tee(t);
    c.v128_const(s16(0x7fff)).simd(op::AND);
    c.local_get(t)
        .i32_const(15)
        .simd(op::I16X8_SHR_S)
        .local_tee(t);
    c.simd(op::XOR).local_get(t).simd(op::I16X8_SUB);
}

/// Pushes the i16x8 of `src`'s halves mapped to integers that order as the
/// values do with -0 below +0 (FMAX/FMIN's order): x ^ (s & 0x7fff), its
/// own inverse. Scratch: `t`.
fn key(c: &mut Func, t: u32) {
    c.local_tee(t);
    c.local_get(t).i32_const(15).simd(op::I16X8_SHR_S);
    c.v128_const(s16(0x7fff)).simd(op::AND).simd(op::XOR);
}

/// The compares (`cmp`: an i16x8 compare of signed magnitudes, or of plain
/// magnitudes for FACGE/FACGT) of `a` with `b` (or zero): no NaN operand,
/// FZ16 clear; no rounding or flags otherwise.
#[allow(clippy::too_many_arguments)]
fn compare(
    c: &mut Func,
    cx: &Ctx,
    i: u32,
    k: usize,
    (n, rd): (u32, u32),
    cmp: u32,
    abs: bool,
    a: Src,
    b: Option<Src>,
) {
    half_guard(c);
    let (ta, tb, r) = (HT[0], HT[1], HT[2]);
    let operand = |c: &mut Func, s: Src, t: u32| {
        if abs {
            s(c);
            c.v128_const(s16(0x7fff)).simd(op::AND);
        } else {
            signed_mag(c, s, t);
        }
    };
    operand(c, a, ta);
    match b {
        Some(b) => operand(c, b, tb),
        None => {
            c.v128_const(0);
        }
    }
    c.simd(cmp).local_set(r);
    let srcs: Vec<Src> = match b {
        Some(b) => vec![a, b],
        None => vec![a],
    };
    finite(c, &srcs, true);
    all16(c, n, false);
    let out = HT[3];
    guarded(c, cx, i, k, vbit(rd), |c| {
        c.local_get(r).local_set(out);
        put(c, rd, n, out);
    });
}

/// FMAX/FMIN (and FMAXNM/FMINNM, the same without NaNs) of `a` and `b`: the
/// larger or smaller [`key`], mapped back; no NaN operand, FZ16 clear.
#[allow(clippy::too_many_arguments)]
fn minmax(
    c: &mut Func,
    cx: &Ctx,
    i: u32,
    k: usize,
    (n, rd): (u32, u32),
    max: bool,
    a: Src,
    b: Src,
) {
    half_guard(c);
    let (ta, r) = (HT[0], HT[2]);
    a(c);
    key(c, ta);
    b(c);
    key(c, ta);
    c.simd(if max {
        op::I16X8_MAX_S
    } else {
        op::I16X8_MIN_S
    });
    key(c, ta);
    c.local_set(r);
    finite(c, &[a, b], true);
    all16(c, n, false);
    guarded(c, cx, i, k, vbit(rd), |c| put(c, rd, n, r));
}

/// Emits FEAT_FP16 instruction `i` inline if it's one this covers (the
/// caller checks the vCPU has it); false (nothing emitted) otherwise.
pub(super) fn inline(c: &mut Func, cx: &Ctx, i: u32, op: Op, k: usize) -> bool {
    use Op::*;
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let scalar_fp = matches!(
        op,
        FADD_float
            | FSUB_float
            | FMUL_float
            | FDIV_float
            | FNMUL_float
            | FSQRT_float
            | FABS_float
            | FNEG_float
            | FMAX_float
            | FMIN_float
            | FMAXNM_float
            | FMINNM_float
            | FMADD_float
            | FMSUB_float
            | FNMADD_float
            | FNMSUB_float
            | FMOV_float
            | FMOV_float_imm
            | FMOV_float_gen
    );
    if scalar_fp {
        if bits(i, 23, 22) != 3 {
            return false;
        }
        return scalar(c, cx, i, op, k);
    }
    let q = bit(i, 30);
    // The AdvSIMD scalar forms (bit 28) take lane 0.
    let n = if bit(i, 28) {
        1
    } else if q {
        8
    } else {
        4
    };
    let va = move |c: &mut Func| c.vget(rn);
    let vb = move |c: &mut Func| c.vget(rm);
    let vd = move |c: &mut Func| c.vget(rd);
    match op {
        FADD_1 | FSUB_1 | FMUL_vec_1 | FDIV_1 | FABD_1 | FABD_3 | FMULX_vec_1 | FMULX_vec_3 => {
            // FMULX's ∞ × 0 is 2, never met: no infinite operand.
            let kk = match op {
                FADD_1 => 0,
                FSUB_1 | FABD_1 | FABD_3 => 1,
                FDIV_1 => 3,
                _ => 2,
            };
            let abs = matches!(op, FABD_1 | FABD_3);
            let kind = Kind::Bin {
                kk,
                abs,
                neg: false,
            };
            arith(c, cx, i, k, (n, rd), kind, &va, &vb, None, false);
        }
        FMLA_vec_1 | FMLS_vec_1 => {
            let kind = Kind::Fma {
                na: op == FMLS_vec_1,
                nc: false,
            };
            arith(c, cx, i, k, (n, rd), kind, &va, &vb, Some(&vd), false);
        }
        // By element: Vm is 4 bits (19:16), the index H:L:M.
        FMLA_elt_1 | FMLA_elt_3 | FMLS_elt_1 | FMLS_elt_3 | FMUL_elt_1 | FMUL_elt_3
        | FMULX_elt_1 | FMULX_elt_3 => {
            let index = (bit(i, 11) as u8) << 2 | (bit(i, 21) as u8) << 1 | bit(i, 20) as u8;
            let rm = bits(i, 19, 16);
            let elt = move |c: &mut Func| {
                c.vget(rm);
                c.vget(rm);
                c.shuffle(core::array::from_fn(|b| 2 * index + b as u8 % 2));
            };
            let kind = match op {
                FMLA_elt_1 | FMLA_elt_3 => Kind::Fma {
                    na: false,
                    nc: false,
                },
                FMLS_elt_1 | FMLS_elt_3 => Kind::Fma {
                    na: true,
                    nc: false,
                },
                _ => Kind::Bin {
                    kk: 2,
                    abs: false,
                    neg: false,
                },
            };
            let acc = matches!(kind, Kind::Fma { .. }).then_some(&vd as Src);
            arith(c, cx, i, k, (n, rd), kind, &va, &elt, acc, true);
        }
        FSQRT_1 => arith(c, cx, i, k, (n, rd), Kind::Sqrt, &va, &va, None, false),
        FMAX_1 | FMIN_1 | FMAXNM_1 | FMINNM_1 => {
            minmax(
                c,
                cx,
                i,
                k,
                (n, rd),
                matches!(op, FMAX_1 | FMAXNM_1),
                &va,
                &vb,
            );
        }
        FCMEQ_reg_1 | FCMEQ_reg_3 => {
            compare(c, cx, i, k, (n, rd), op::I16X8_EQ, false, &va, Some(&vb))
        }
        FCMGE_reg_1 | FCMGE_reg_3 => {
            compare(c, cx, i, k, (n, rd), op::I16X8_GE_S, false, &va, Some(&vb))
        }
        FCMGT_reg_1 | FCMGT_reg_3 => {
            compare(c, cx, i, k, (n, rd), op::I16X8_GT_S, false, &va, Some(&vb))
        }
        FACGE_1 | FACGE_3 => compare(c, cx, i, k, (n, rd), op::I16X8_GE_U, true, &va, Some(&vb)),
        FACGT_1 | FACGT_3 => compare(c, cx, i, k, (n, rd), op::I16X8_GT_U, true, &va, Some(&vb)),
        FCMEQ_zero_1 | FCMEQ_zero_3 => {
            compare(c, cx, i, k, (n, rd), op::I16X8_EQ, false, &va, None)
        }
        FCMGE_zero_1 | FCMGE_zero_3 => {
            compare(c, cx, i, k, (n, rd), op::I16X8_GE_S, false, &va, None)
        }
        FCMGT_zero_1 | FCMGT_zero_3 => {
            compare(c, cx, i, k, (n, rd), op::I16X8_GT_S, false, &va, None)
        }
        FCMLE_1 | FCMLE_3 => compare(c, cx, i, k, (n, rd), op::I16X8_LE_S, false, &va, None),
        FCMLT_1 | FCMLT_3 => compare(c, cx, i, k, (n, rd), op::I16X8_LT_S, false, &va, None),
        // Bits: no flags, any operand.
        FABS_1 | FNEG_1 => {
            let out = HT[0];
            c.vget(rn);
            if op == FABS_1 {
                c.v128_const(s16(0x7fff)).simd(op::AND);
            } else {
                c.v128_const(s16(0x8000)).simd(op::XOR);
            }
            c.local_set(out);
            put(c, rd, n, out);
        }
        FMOV_3 => {
            let imm = crate::interp::simd::vfp_expand_imm(bits(i, 18, 16) << 5 | bits(i, 9, 5), 16);
            let out = HT[0];
            c.v128_const(s16(imm as u16)).local_set(out);
            put(c, rd, n, out);
        }
        _ => return false,
    }
    true
}

/// The scalar FP forms with ftype 3: lane 0 of the vector rules (`arith`,
/// `minmax`), and the bit forms.
fn scalar(c: &mut Func, cx: &Ctx, i: u32, op: Op, k: usize) -> bool {
    use Op::*;
    let (rd, rn, rm, ra) = (
        bits(i, 4, 0),
        bits(i, 9, 5),
        bits(i, 20, 16),
        bits(i, 14, 10),
    );
    let va = move |c: &mut Func| c.vget(rn);
    let vb = move |c: &mut Func| c.vget(rm);
    let vacc = move |c: &mut Func| c.vget(ra);
    let s = (1, rd);
    match op {
        FADD_float | FSUB_float | FMUL_float | FDIV_float | FNMUL_float => {
            let kk = match op {
                FADD_float => 0,
                FSUB_float => 1,
                FDIV_float => 3,
                _ => 2,
            };
            let kind = Kind::Bin {
                kk,
                abs: false,
                neg: op == FNMUL_float,
            };
            arith(c, cx, i, k, s, kind, &va, &vb, None, false);
        }
        FSQRT_float => arith(c, cx, i, k, s, Kind::Sqrt, &va, &va, None, false),
        // o1 (21) negates the addend, o1 != o0 (15) the first factor.
        FMADD_float | FMSUB_float | FNMADD_float | FNMSUB_float => {
            let (o1, o0) = (bit(i, 21), bit(i, 15));
            let kind = Kind::Fma {
                na: o1 != o0,
                nc: o1,
            };
            arith(c, cx, i, k, s, kind, &va, &vb, Some(&vacc), false);
        }
        FMAX_float | FMIN_float | FMAXNM_float | FMINNM_float => {
            minmax(
                c,
                cx,
                i,
                k,
                s,
                matches!(op, FMAX_float | FMAXNM_float),
                &va,
                &vb,
            );
        }
        FABS_float | FNEG_float | FMOV_float => {
            let out = HT[0];
            c.vget(rn);
            match op {
                FABS_float => {
                    c.v128_const(0x7fff).simd(op::AND);
                }
                FNEG_float => {
                    c.v128_const(0x8000).simd(op::XOR);
                }
                _ => {}
            }
            c.local_set(out);
            put(c, rd, 1, out);
        }
        FMOV_float_imm => {
            let imm = crate::interp::simd::vfp_expand_imm(bits(i, 20, 13), 16);
            let out = HT[0];
            c.v128_const(imm as u128).local_set(out);
            put(c, rd, 1, out);
        }
        // FMOV Wd/Xd, Hn (zero-extended) and Hd, Wn/Xn (the low 16 bits).
        FMOV_float_gen => {
            let (sf, rmode, to_v) = (bit(i, 31), bits(i, 20, 19), bit(i, 16));
            if rmode != 0 || bits(i, 18, 17) != 3 {
                return false;
            }
            if to_v {
                let out = HT[0];
                c.v128_const(0);
                get(c, false, rn);
                c.i32_const(0xffff).op(AND);
                c.simd_lane(0x1c, 0); // i32x4.replace_lane 0
                c.local_set(out);
                put(c, rd, 1, out);
            } else {
                set(c, sf, rd, |c| {
                    c.vget(rn);
                    c.simd_lane(op::I16X8_EXTRACT_U, 0);
                    if sf {
                        c.i64_extend_i32_u();
                    }
                });
            }
        }
        _ => return false,
    }
    true
}

/// FEAT_FHM (the caller checks the vCPU has it): FMLAL, FMLSL and the "2"
/// forms, vector and by element. The halves widened exactly, FMLSL's first
/// negated, their product exact in a single, plus Vd's singles: one rounding,
/// FPMulAddH's. So the single FMA's rules: FPOK, a fast single result or an
/// exact zero (a zero sum of the exact product and the addend), under FZ no
/// denormal addend; the halves finite, FZ16 clear.
pub(super) fn fhm(c: &mut Func, cx: &Ctx, i: u32, op: Op, k: usize) -> bool {
    use Op::*;
    let by_element = match op {
        FMLAL_vec_1 | FMLSL_vec_1 | FMLAL_vec_2 | FMLSL_vec_2 => false,
        FMLAL_elt_1 | FMLAL_elt_2 | FMLSL_elt_1 | FMLSL_elt_2 => true,
        _ => return false,
    };
    if bit(i, 22) {
        return false;
    }
    let (rd, rn) = (bits(i, 4, 0), bits(i, 9, 5));
    let (q, part) = (bit(i, 30), bit(i, 29));
    let sub = if by_element { bit(i, 14) } else { bit(i, 23) };
    // The halves used: lanes 0..n of Vn (and Vm), or with "2" the next n.
    let n = if q { 4 } else { 2 };
    let first = if part { n } else { 0 };
    // Q = 1's "2" half is lanes 4..7 (widened as the high half); Q = 0's
    // lanes 2 and 3 move to 0 and 1.
    let shift = part && !q;
    let src = move |c: &mut Func, r: u32| {
        c.vget(r);
        if shift {
            c.vget(r);
            c.shuffle(core::array::from_fn(|b| (4 + b as u8) % 16));
        }
    };
    let rm = if by_element {
        bits(i, 19, 16)
    } else {
        bits(i, 20, 16)
    };
    let index = (bit(i, 11) as u8) << 2 | (bit(i, 21) as u8) << 1 | bit(i, 20) as u8;
    let va = move |c: &mut Func| src(c, rn);
    let vb = move |c: &mut Func| {
        if by_element {
            c.vget(rm);
            c.vget(rm);
            c.shuffle(core::array::from_fn(|b| 2 * index + b as u8 % 2));
        } else {
            src(c, rm);
        }
    };
    let vd = move |c: &mut Func| c.vget(rd);
    let hi = part && q;
    fpa_guard(c);
    half_guard(c);
    let r = VT[0];
    widen(c, &va, hi);
    if sub {
        c.simd(op::F32X4_NEG);
    }
    widen(c, &vb, hi);
    c.simd(op::F32X4[2]); // exact
    vd(c);
    c.simd(op::F32X4[0]).local_set(r);
    // The halves used are finite: Vn's (and vector Vm's) lanes first..first + n
    // as they are, by element the element (in every lane).
    let raw_a = move |c: &mut Func| c.vget(rn);
    let raw_b = move |c: &mut Func| {
        if by_element {
            vb(c);
        } else {
            c.vget(rm);
        }
    };
    finite(c, &[&raw_a, &raw_b], false);
    let used = ((1u128 << (16 * n)) - 1) << (16 * first);
    c.v128_const(!used).simd(op::OR);
    c.simd(op::I16X8_ALL_TRUE);
    // A fast single (exponent field 2 up, not all ones) or ±0, under FZ no
    // denormal addend; Q = 0 ignores lanes 2 and 3.
    c.local_get(r).i32_const(1).simd(op::I32X4_SHL);
    c.v128_const(s32(2 << 24)).simd(op::I32X4_SUB);
    c.v128_const(s32(0xfd << 24)).simd(op::I32X4_LT_U);
    c.local_get(r).v128_const(0).simd(op::F32X4_EQ).simd(op::OR);
    under_fz_bad(c, |c| denormal_any(c, false, &[&vd]));
    if !q {
        c.v128_const(u128::MAX << 64).simd(op::OR);
    }
    c.simd(op::I32X4_ALL_TRUE).op(AND);
    c.local_get(HOK).op(AND).local_get(FPOK).op(AND);
    guarded(c, cx, i, k, vbit(rd), |c| {
        c.local_get(r);
        if !q {
            c.i64_const(0).simd_lane(0x1e, 1);
        }
        c.vset(rd);
    });
    true
}
