//! FEAT_BF16 inline (PERF loop 11, docs/jit.md "BFloat16"); BFMLALB/BFMLALT are
//! the single FMA forms on widened lanes (`float::lanes`).
//! - BFCVT, BFCVTN/BFCVTN2: FCVTN's rule, to bfloat16. Under FPOK (nearest even,
//!   IXC set), a lane that's ±0 or a normal single below the largest bfloat16's
//!   rounding boundary (0x7f7f8000) converts with nothing to raise but Inexact:
//!   bfloat16 has a single's exponent range, so a normal single rounds to a
//!   normal bfloat16 (no Underflow, and FZ and DN don't act); the rounding to
//!   nearest even is (u + 0x7fff + (u >> 16 & 1)) >> 16 on the bits, sign and all.
//! - BFDOT (vector, by element) and BFMMLA: BFDotAdd without FEAT_EBF16 (FPCR
//!   ignored, no flags; operands and results below the smallest normal flushed
//!   to zero, NaNs the default NaN, each sum rounded to odd: `fp::bf_dot_add`).
//!   With every bfloat16 operand ±0 or from 2^-56 to below 2^63, the products
//!   are exact singles from 2^-112 (no flush), their sum is exact by TwoSum and
//!   either zero or from 2^-126 up (a multiple of 2^-126: no flush), and finite;
//!   so the first sum is the RNE sum stepped to odd by its error. The second, Vd
//!   plus it, is the same with Vd and the RNE sum ±0 or normal below 2^126 (else
//!   it may need a flush, round to odd short of an infinity, or overflow in
//!   TwoSum's steps). IEEE's zero signs are BFAdd's (x - x is +0 in nearest even).
//!   Anything else, a lane at a time, is the helper's.

use super::{Ctx, Func, HT, VT, vbit};
use crate::decode::Op;
use crate::interp::{bit, bits};

use super::float::{fpa_guard, guarded};
use super::{AND, FPOK};

mod op {
    pub const AND: u32 = 0x4e;
    pub const OR: u32 = 0x50;
    pub const XOR: u32 = 0x51;
    pub const I8X16_ALL_TRUE: u32 = 0x63;
    pub const I16X8_EQ: u32 = 0x2d;
    pub const I16X8_LT_U: u32 = 0x30;
    pub const I16X8_SHL: u32 = 0x8b;
    pub const I16X8_SUB: u32 = 0x91;
    pub const I32X4_LT_U: u32 = 0x3a;
    pub const F32X4_EQ: u32 = 0x41;
    pub const F32X4_NE: u32 = 0x42;
    pub const I32X4_ALL_TRUE: u32 = 0xa3;
    pub const I32X4_SHL: u32 = 0xab;
    pub const I32X4_SHR_S: u32 = 0xac;
    pub const I32X4_SHR_U: u32 = 0xad;
    pub const I32X4_ADD: u32 = 0xae;
    pub const I32X4_SUB: u32 = 0xb1;
    /// f32x4 add, sub, mul.
    pub const F32X4: [u32; 3] = [0xe4, 0xe5, 0xe6];
}

/// `x` in every 16-bit lane.
fn s16(x: u16) -> u128 {
    (0..8).fold(0, |v, k| v | (x as u128) << (16 * k))
}

/// `x` in every 32-bit lane.
fn s32(x: u32) -> u128 {
    (0..4).fold(0, |v, k| v | (x as u128) << (32 * k))
}

/// The bytes of a v128 shuffle that put 32-bit lane `map[j]` in lane j.
fn lanes32(map: [u8; 4]) -> [u8; 16] {
    core::array::from_fn(|b| 4 * map[b / 4] + b as u8 % 4)
}

/// FEAT_BF16's BFCVT, BFCVTN/BFCVTN2, BFDOT and BFMMLA (the caller checks the
/// vCPU has it; BFMLALB/T are `float::lanes`'s).
pub(super) fn inline(c: &mut Func, cx: &Ctx, i: u32, op: Op, k: usize) -> bool {
    use Op::*;
    match op {
        BFCVT | BFCVTN => convert(c, cx, i, op == BFCVT, k),
        BFDOT_vec | BFDOT_element | BFMMLA => dot(c, cx, i, op, k),
        _ => false,
    }
}

/// BFCVT (`scalar`: lane 0 to Hd, the rest cleared), BFCVTN (four lanes to
/// Vd's low half, the high half cleared) and BFCVTN2 (to the high half, the
/// low half kept): see the module's comment.
fn convert(c: &mut Func, cx: &Ctx, i: u32, scalar: bool, k: usize) -> bool {
    let (rd, rn) = (bits(i, 4, 0), bits(i, 9, 5));
    let upper = !scalar && bit(i, 30);
    let r = VT[0];
    fpa_guard(c);
    // The rounded bits: the bfloat16 in each lane's high half.
    c.vget(rn);
    c.vget(rn);
    c.i32_const(16).simd(op::I32X4_SHR_U);
    c.v128_const(s32(1)).simd(op::AND).simd(op::I32X4_ADD);
    c.v128_const(s32(0x7fff)).simd(op::I32X4_ADD).local_set(r);
    // ±0, or a normal magnitude below 0x7f7f8000 (which rounds to infinity):
    // shifted left once, less 2^24's, unsigned below the range's length.
    c.vget(rn);
    c.i32_const(1).simd(op::I32X4_SHL);
    c.v128_const(s32(0x0100_0000)).simd(op::I32X4_SUB);
    c.v128_const(s32(0xfeff_0000 - 0x0100_0000))
        .simd(op::I32X4_LT_U);
    c.vget(rn);
    c.v128_const(0).simd(op::F32X4_EQ).simd(op::OR);
    if scalar {
        c.v128_const(u128::MAX << 32).simd(op::OR);
    }
    c.simd(op::I32X4_ALL_TRUE).local_get(FPOK).op(AND);
    guarded(c, cx, i, k, vbit(rd), |c| {
        // Each lane's high half, packed: into the low half (the rest from a
        // zero), or (BFCVTN2) the high half beside Vd's low.
        let packed: [u8; 8] = [2, 3, 6, 7, 10, 11, 14, 15];
        if upper {
            c.vget(rd);
            c.local_get(r);
            c.shuffle(core::array::from_fn(|b| {
                if b < 8 { b as u8 } else { 16 + packed[b - 8] }
            }));
        } else {
            let n = if scalar { 2 } else { 8 };
            c.local_get(r).v128_const(0);
            c.shuffle(core::array::from_fn(|b| if b < n { packed[b] } else { 16 }));
        }
        c.vset(rd);
    });
    true
}

/// Pushes an i16x8 mask: all ones where the bfloat16 lane of the v128 `src`
/// pushes is ±0 or has a biased exponent from 71 to 189 (2^-56 to below 2^63):
/// shifted left once (the sign gone) less 71 << 8, unsigned below the range's
/// length, or zero. Scratch: HT[7].
fn operand_ok(c: &mut Func, src: &dyn Fn(&mut Func)) {
    let t = HT[7];
    src(c);
    c.i32_const(1).simd(op::I16X8_SHL).local_tee(t);
    c.v128_const(s16(71 << 8)).simd(op::I16X8_SUB);
    c.v128_const(s16((190 - 71) << 8)).simd(op::I16X8_LT_U);
    c.local_get(t).v128_const(0).simd(op::I16X8_EQ).simd(op::OR);
}

/// Pushes an i32x4 mask: all ones where the single lane of the v128 `src`
/// pushes (twice) is ±0 or normal below 2^126 (a biased exponent of 252 at
/// most: added to a sum below 2^127, TwoSum's steps stay finite).
fn single_ok(c: &mut Func, src: &dyn Fn(&mut Func)) {
    src(c);
    c.i32_const(1).simd(op::I32X4_SHL);
    c.v128_const(s32(0x0100_0000)).simd(op::I32X4_SUB);
    c.v128_const(s32(0xfc00_0000)).simd(op::I32X4_LT_U);
    src(c);
    c.v128_const(0).simd(op::F32X4_EQ).simd(op::OR);
}

/// Local `out` = a + b rounded to odd, a and b the singles `a` and `b` push
/// (each several times; neither reads `out` or `rne` after it's set): TwoSum's
/// sum s (into `rne`) and its error e, exact while nothing overflows; where e
/// is nonzero, s's bits less one if s went away from zero (e's sign isn't
/// s's), then the last bit set. Scratch: HT[0], HT[1].
fn add_odd(c: &mut Func, a: &dyn Fn(&mut Func), b: &dyn Fn(&mut Func), rne: u32, out: u32) {
    let (bb, e) = (HT[0], HT[1]);
    let [add, sub, _] = op::F32X4;
    a(c);
    b(c);
    c.simd(add).local_tee(rne);
    a(c);
    c.simd(sub).local_set(bb);
    // e = (a - (s - bb)) + (b - bb)
    a(c);
    c.local_get(rne).local_get(bb).simd(sub).simd(sub);
    b(c);
    c.local_get(bb).simd(sub).simd(add).local_set(e);
    // inexact (into bb), and away = inexact & (s ^ e) >> 31
    c.local_get(e)
        .v128_const(0)
        .simd(op::F32X4_NE)
        .local_tee(bb);
    c.local_get(rne).local_get(e).simd(op::XOR);
    c.i32_const(31).simd(op::I32X4_SHR_S).simd(op::AND);
    c.local_get(rne).simd(op::I32X4_ADD);
    c.local_get(bb)
        .i32_const(31)
        .simd(op::I32X4_SHR_U)
        .simd(op::OR);
    c.local_set(out);
}

/// Locals `p0`, `p1` = the products of the even and the odd bfloat16 lanes of
/// the v128s `n` and `m` push (each pushed twice), widened exactly (a
/// bfloat16 is a single's top half).
fn products(c: &mut Func, n: &dyn Fn(&mut Func), m: &dyn Fn(&mut Func), p0: u32, p1: u32) {
    let mul = op::F32X4[2];
    n(c);
    c.i32_const(16).simd(op::I32X4_SHL);
    m(c);
    c.i32_const(16).simd(op::I32X4_SHL);
    c.simd(mul).local_set(p0);
    n(c);
    c.v128_const(s32(0xffff_0000)).simd(op::AND);
    m(c);
    c.v128_const(s32(0xffff_0000)).simd(op::AND);
    c.simd(mul).local_set(p1);
}

/// BFDOT (vector, by element) and BFMMLA: see the module's comment.
fn dot(c: &mut Func, cx: &Ctx, i: u32, op_: Op, k: usize) -> bool {
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let mmla = op_ == Op::BFMMLA;
    let q = mmla || bit(i, 30);
    let [p0, p1, s, r] = VT;
    let (rne, mask, nk, mk) = (HT[2], HT[3], HT[4], HT[5]);
    // Vm, or (by element) its pair H:L in every lane, in `mk`.
    let by_element = op_ == Op::BFDOT_element;
    if by_element {
        let index = (bit(i, 11) as u8) << 1 | bit(i, 21) as u8;
        c.vget(rm);
        c.vget(rm);
        c.shuffle(lanes32([index; 4])).local_set(mk);
    }
    let vn = move |c: &mut Func| c.vget(rn);
    let vm = move |c: &mut Func| {
        if by_element {
            c.local_get(mk);
        } else {
            c.vget(rm);
        }
    };
    let vd = move |c: &mut Func| c.vget(rd);
    operand_ok(c, &vn);
    operand_ok(c, &vm);
    c.simd(op::AND);
    single_ok(c, &vd);
    c.simd(op::AND).local_set(mask);
    let held = |l: u32| {
        move |c: &mut Func| {
            c.local_get(l);
        }
    };
    let (gs, gr, grne) = (held(s), held(r), held(rne));
    if mmla {
        // Output lane 2i + j: Vn's pairs 2i + k and Vm's 2j + k, k = 0 then 1.
        for kk in 0..2u8 {
            c.vget(rn);
            c.vget(rn);
            c.shuffle(lanes32([kk, kk, 2 + kk, 2 + kk])).local_set(nk);
            c.vget(rm);
            c.vget(rm);
            c.shuffle(lanes32([kk, 2 + kk, kk, 2 + kk])).local_set(mk);
            products(c, &held(nk), &held(mk), p0, p1);
            add_odd(c, &held(p0), &held(p1), rne, s);
            if kk == 0 {
                add_odd(c, &vd, &gs, rne, r);
            } else {
                add_odd(c, &gr, &gs, rne, r);
            }
            single_ok(c, &grne);
            c.local_get(mask).simd(op::AND).local_set(mask);
        }
    } else {
        products(c, &vn, &vm, p0, p1);
        add_odd(c, &held(p0), &held(p1), rne, s);
        add_odd(c, &vd, &gs, rne, r);
        single_ok(c, &grne);
        c.local_get(mask).simd(op::AND).local_set(mask);
    }
    c.local_get(mask);
    if !q {
        c.v128_const(u128::MAX << 64).simd(op::OR);
    }
    c.simd(op::I8X16_ALL_TRUE);
    guarded(c, cx, i, k, vbit(rd), |c| {
        c.local_get(r);
        if !q {
            c.i64_const(0).simd_lane(0x1e, 1); // i64x2.replace_lane 1
        }
        c.vset(rd);
    });
    true
}
