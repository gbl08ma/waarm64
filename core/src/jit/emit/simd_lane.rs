//! AdvSIMD integer forms SIMD128 has no lane operation for (M8): shifts by
//! register, saturation on 32- and 64-bit lanes, leading-bit counts, the
//! saturating accumulates, and the scalar forms. Lane by lane, after
//! `interp::simd_int`: each lane is extracted sign- or zero-extended to i64,
//! computed in i64 arithmetic (exact for lanes up to 32 bits, with the
//! interpreter's i128 results reproduced by overflow checks on 64-bit lanes),
//! and replaced in the result, which starts as zero or as Vd. Encodings the
//! interpreter rejects are left to the helper. Callers run
//! [`super::fp_guard`] first.

use core::mem::offset_of;

use super::Func;
use super::VCPU;
use crate::cpu::Cpu;
use crate::decode::Op;
use crate::interp::{bit, bits};

// Scratch locals (emit.rs: i64 in 2..=5, i32 in 6..=9).
const X: u32 = 2;
const Y: u32 = 3;
const T: u32 = 4;
const D: u32 = 5;
const SAT: u32 = 9;
const OV: u32 = 8;

// i64 and i32 opcodes.
const ADD: u8 = 0x7c;
const SUB: u8 = 0x7d;
const MUL: u8 = 0x7e;
const AND: u8 = 0x83;
const OR: u8 = 0x84;
const XOR: u8 = 0x85;
const SHL: u8 = 0x86;
const SHR_S: u8 = 0x87;
const SHR_U: u8 = 0x88;
const CLZ: u8 = 0x79;
const EQ: u8 = 0x51;
const NE: u8 = 0x52;
const LT_S: u8 = 0x53;
const LT_U: u8 = 0x54;
const GT_S: u8 = 0x55;
const GT_U: u8 = 0x56;
const LE_S: u8 = 0x57;
const GE_S: u8 = 0x59;
const GE_U: u8 = 0x5a;
const I32_AND: u8 = 0x71;
const I32_OR: u8 = 0x72;
const EXTEND_S: u8 = 0xac;
const EXTEND_U: u8 = 0xad;
const EXTEND8_S: u8 = 0xc2;
const WRAP: u8 = 0xa7;

// Lane ops by log2 lane size.
const EXTRACT_S: [u32; 4] = [0x15, 0x18, 0x1b, 0x1d];
const EXTRACT_U: [u32; 4] = [0x16, 0x19, 0x1b, 0x1d];
const REPLACE: [u32; 4] = [0x17, 0x1a, 0x1c, 0x1e];

/// FPSR.QC.
const QC: i64 = 1 << 27;

/// Emits `i` lane by lane if it's one of the forms here; false (nothing
/// emitted) otherwise.
pub(super) fn inline(c: &mut Func, i: u32, op: Op) -> bool {
    use Op::*;
    match op {
        SQADD_2 | UQADD_2 | SQSUB_2 | UQSUB_2 | SSHL_2 | USHL_2 | SRSHL_2 | URSHL_2
        | SQSHL_reg_2 | UQSHL_reg_2 | SQRSHL_2 | UQRSHL_2 | SSHL_1 | USHL_1 | SRSHL_1 | URSHL_1
        | SQSHL_reg_1 | UQSHL_reg_1 | SQRSHL_1 | UQRSHL_1 | ADD_1 | SUB_1 | CMGT_reg_1
        | CMGE_reg_1 | CMHI_1 | CMHS_1 | CMEQ_reg_1 | CMTST_1 | SQDMULH_vec_1 | SQRDMULH_vec_1 => {
            three_same(c, i)
        }
        CLS_asimd | CLZ_asimd | SUQADD_2 | USQADD_2 | SQABS_2 | SQNEG_2 | SQXTN_2 | SQXTUN_2
        | UQXTN_2 | SUQADD_1 | USQADD_1 | SQABS_1 | SQNEG_1 | ABS_1 | NEG_1 | CMGT_zero_1
        | CMGE_zero_1 | CMEQ_zero_1 | CMLE_1 | CMLT_1 | SQXTN_1 | SQXTUN_1 | UQXTN_1 => {
            two_misc(c, i)
        }
        SSHR_1 | SSRA_1 | SRSHR_1 | SRSRA_1 | SHL_1 | SQSHL_imm_1 | SQSHRN_1 | SQRSHRN_1
        | USHR_1 | USRA_1 | URSHR_1 | URSRA_1 | SRI_1 | SLI_1 | SQSHLU_1 | UQSHL_imm_1
        | SQSHRUN_1 | SQRSHRUN_1 | UQSHRN_1 | UQRSHRN_1 | SQSHL_imm_2 | UQSHL_imm_2 | SQSHLU_2
        | SHRN | RSHRN | SQSHRN_2 | SQRSHRN_2 | SQSHRUN_2 | SQRSHRUN_2 | UQSHRN_2 | UQRSHRN_2
        | SRSHR_2 | URSHR_2 | SRSRA_2 | URSRA_2 => shift_imm(c, i),
        SQDMLAL_vec_1 | SQDMLSL_vec_1 | SQDMULL_vec_1 | SQDMLAL_vec_2 | SQDMLSL_vec_2
        | SQDMULL_vec_2 => three_diff(c, i),
        SQDMLAL_elt_1 | SQDMLSL_elt_1 | SQDMULL_elt_1 | SQDMULH_elt_1 | SQRDMULH_elt_1
        | SQDMLAL_elt_2 | SQDMLSL_elt_2 | SQDMULL_elt_2 => by_element(c, i),
        ADDP_pair => {
            if bits(i, 23, 22) != 3 {
                return false;
            }
            let (rd, rn) = (bits(i, 4, 0), bits(i, 9, 5));
            c.vset_scalar(rd, 64, |c| {
                c.vlane(rn, 64, 0);
                c.vlane(rn, 64, 1);
                c.op(ADD);
            });
            true
        }
        _ => false,
    }
}

/// FEAT_RDM's SQRDMLAH and SQRDMLSH, scalar and scalar by element (the vector
/// forms are `simd::inline_rdm`'s): Vd + ((±xy + 2^(esize − 2)) >> (esize − 1)),
/// exact in i64, clamped. False for anything else.
pub(super) fn inline_rdm(c: &mut Func, i: u32, op: Op) -> bool {
    use Op::*;
    let (by_element, sub) = match op {
        SQRDMLAH_vec_1 => (false, false),
        SQRDMLSH_vec_1 => (false, true),
        SQRDMLAH_elt_1 => (true, false),
        SQRDMLSH_elt_1 => (true, true),
        _ => return false,
    };
    let (rd, rn, size) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 23, 22) as usize);
    let (l, m, h) = (bit(i, 21) as u32, bit(i, 20) as u32, bit(i, 11) as u32);
    let (index, rm) = match (size, by_element) {
        (1 | 2, false) => (0, bits(i, 20, 16)),
        (1, true) => (h << 2 | l << 1 | m, bits(i, 19, 16)),
        (2, true) => (h << 1 | l, bits(i, 20, 16)),
        _ => return false,
    };
    let esize = 8u32 << size;
    sat_begin(c);
    lanes(c, rd, false, size, 1, 0, |c, _| {
        get(c, rd, size, 0, false);
        if sub {
            c.i64_const(1 << (esize - 2));
        }
        get(c, rn, size, 0, false);
        get(c, rm, size, index, false);
        c.op(MUL);
        if sub {
            c.op(SUB);
        } else {
            c.i64_const(1 << (esize - 2)).op(ADD);
        }
        c.i64_const(i64::from(esize - 1)).op(SHR_S).op(ADD);
        clamp(c, range(esize, false));
    });
    sat_end(c);
    true
}

/// Pushes lane `e` of Vn's `8 << size`-bit lanes as an i64, sign- or (`u`)/// Pushes lane `e` of Vn's `8 << size`-bit lanes as an i64, sign- or (`u`)
/// zero-extended.
fn get(c: &mut Func, n: u32, size: usize, e: u32, u: bool) {
    c.vget(n);
    if size == 3 {
        c.simd_lane(EXTRACT_S[3], e as u8);
    } else {
        let op = if u { EXTRACT_U } else { EXTRACT_S }[size];
        c.simd_lane(op, e as u8);
        c.op(if u { EXTEND_U } else { EXTEND_S });
    }
}

/// Vd = lanes `at..at + n` of `8 << size` bits, each the i64 `f(e)` pushes
/// (truncated), in Vd (`keep`) or zero.
fn lanes(
    c: &mut Func,
    rd: u32,
    keep: bool,
    size: usize,
    n: u32,
    at: u32,
    mut f: impl FnMut(&mut Func, u32),
) {
    if keep {
        c.vget(rd);
    } else {
        c.v128_const(0);
    }
    for e in 0..n {
        f(c, e);
        if size < 3 {
            c.op(WRAP);
        }
        c.simd_lane(REPLACE[size], (at + e) as u8);
    }
    c.vset(rd);
}

fn sat_begin(c: &mut Func) {
    c.i32_const(0).local_set(SAT);
}

/// FPSR.QC |= SAT.
fn sat_end(c: &mut Func) {
    c.local_get(SAT).if_();
    let fpsr = offset_of!(Cpu, fpsr) as u32;
    c.local_get(VCPU).local_get(VCPU).i64_load(fpsr);
    c.i64_const(QC).op(OR).i64_store(fpsr);
    c.end();
}

/// The signed or (`u`) unsigned range of `esize` (< 64) bits.
fn range(esize: u32, u: bool) -> (i64, i64) {
    if u {
        (0, (1i64 << esize) - 1)
    } else {
        (-(1i64 << (esize - 1)), (1i64 << (esize - 1)) - 1)
    }
}

/// The exact i64 on the stack clamped to `lo..=hi`, SAT set if it was outside.
fn clamp(c: &mut Func, (lo, hi): (i64, i64)) {
    c.local_set(T);
    c.local_get(SAT);
    c.local_get(T).i64_const(lo).op(LT_S).op(I32_OR);
    c.local_get(T).i64_const(hi).op(GT_S).op(I32_OR);
    c.local_set(SAT);
    c.i64_const(hi)
        .local_get(T)
        .local_get(T)
        .i64_const(hi)
        .op(GT_S)
        .select();
    c.local_set(T);
    c.i64_const(lo)
        .local_get(T)
        .local_get(T)
        .i64_const(lo)
        .op(LT_S)
        .select();
}

/// Pushes all ones if the i32 on the stack is set, else 0.
fn mask(c: &mut Func) {
    c.op(EXTEND_U);
    c.local_set(T);
    c.i64_const(0).local_get(T).op(SUB);
}

/// SAT |= the i32 on the stack.
fn or_sat(c: &mut Func) {
    c.local_get(SAT).op(I32_OR).local_set(SAT);
}

/// X >> k for `k` in 1..=65 (local `k`, i64) on an `esize`-bit lane value:
/// arithmetic, or (`u`, 64-bit lanes) logical with 0 from 64 on.
fn shr(c: &mut Func, k: u32, esize: u32, u: bool, minus_one: bool) {
    let amount = |c: &mut Func| {
        c.local_get(k);
        if minus_one {
            c.i64_const(1).op(SUB);
        }
    };
    if u && esize == 64 {
        c.local_get(X);
        amount(c);
        c.op(SHR_U);
        c.i64_const(0);
        amount(c);
        c.i64_const(64).op(LT_S);
        c.select();
    } else {
        // Arithmetic by min(k, 63): X >> 63 is X's sign, like any larger shift
        // (and 0 for a zero-extended lane under 64 bits).
        c.local_get(X);
        amount(c);
        c.local_tee(D)
            .i64_const(63)
            .local_get(D)
            .i64_const(63)
            .op(LT_S)
            .select();
        c.op(SHR_S);
    }
}

/// X shifted right by local `k` (1..=65), rounding if asked, without
/// overflow: (X >> k) + (X >> (k − 1) & 1).
fn shr_round(c: &mut Func, k: u32, esize: u32, u: bool, round: bool) {
    shr(c, k, esize, u, false);
    if round {
        shr(c, k, esize, u, true);
        c.i64_const(1).op(AND).op(ADD);
    }
}

/// The saturated value of a 64-bit signed overflow from X: MAX if X ≥ 0, else MIN.
fn sat64(c: &mut Func, u: bool, positive: bool) {
    if u {
        c.i64_const(if positive { -1 } else { 0 });
    } else {
        c.local_get(X)
            .i64_const(63)
            .op(SHR_S)
            .i64_const(i64::MAX)
            .op(XOR);
    }
}

/// `interp::simd_int::shift` on X by the signed byte in Y (`esize`-bit lanes),
/// then SatQ (`sat`) or truncation.
fn shift_reg(c: &mut Func, esize: u32, u: bool, round: bool, sat: bool) {
    let e = esize as i64;
    // T = clamp(−Y, 1, 65): the right shift (65 rounds a 64-bit lane to 0, as 66 does).
    c.i64_const(0).local_get(Y).op(SUB).local_set(T);
    c.i64_const(65)
        .local_get(T)
        .local_get(T)
        .i64_const(65)
        .op(GT_S)
        .select()
        .local_set(T);
    c.i64_const(1)
        .local_get(T)
        .local_get(T)
        .i64_const(1)
        .op(LT_S)
        .select()
        .local_set(T);
    if esize == 64 && sat {
        // Left: OV = the shift loses bits; Y ≥ 64 overflows unless X is 0.
        c.local_get(X).i64_const(0).op(NE);
        c.local_get(X).local_get(Y).op(SHL).local_get(Y);
        c.op(if u { SHR_U } else { SHR_S });
        c.local_get(X).op(NE);
        c.local_get(Y).i64_const(64).op(GE_S).select();
        c.local_get(Y).i64_const(0).op(GE_S).op(I32_AND);
        c.local_tee(OV);
        or_sat(c);
        sat64(c, u, true);
        // Not saturated: Y ≥ 64 (X is 0), X << Y, or the right shift.
        c.i64_const(0);
        c.local_get(X).local_get(Y).op(SHL);
        c.local_get(Y).i64_const(64).op(GE_S).select();
        shr_round_t(c, esize, u, round);
        c.local_get(Y).i64_const(0).op(GE_S).select();
        c.local_get(OV).select();
        return;
    }
    // Y ≥ esize: everything leaves the lane (for SatQ only X's sign matters).
    if sat {
        c.i64_const(1 << 62);
        c.i64_const(-(1 << 62)).i64_const(0);
        c.local_get(X).i64_const(0).op(LT_S).select();
        c.local_get(X).i64_const(0).op(GT_S).select();
    } else {
        c.i64_const(0);
    }
    // 0 ≤ Y < esize: exact in i64 below 64 bits, wrapping (and truncated) at 64.
    c.local_get(X).local_get(Y).op(SHL);
    shr_round_t(c, esize, u, round);
    c.local_get(Y).i64_const(0).op(GE_S).select();
    c.local_get(Y).i64_const(e).op(GE_S).select();
    if sat {
        clamp(c, range(esize, u));
    }
}

/// [`shr_round`] by local T.
fn shr_round_t(c: &mut Func, esize: u32, u: bool, round: bool) {
    shr_round(c, T, esize, u, round);
}

/// X + Y or X − Y on 64-bit lanes, saturated (SAT set on overflow).
fn add_sat64(c: &mut Func, u: bool, sub: bool) {
    c.local_get(X)
        .local_get(Y)
        .op(if sub { SUB } else { ADD })
        .local_set(D);
    match (u, sub) {
        (true, false) => c.local_get(D).local_get(X).op(LT_U),
        (true, true) => c.local_get(X).local_get(Y).op(LT_U),
        (false, false) => {
            c.local_get(X).local_get(D).op(XOR);
            c.local_get(Y).local_get(D).op(XOR).op(AND);
            c.i64_const(0).op(LT_S)
        }
        (false, true) => {
            c.local_get(X).local_get(Y).op(XOR);
            c.local_get(X).local_get(D).op(XOR).op(AND);
            c.i64_const(0).op(LT_S)
        }
    };
    c.local_tee(OV);
    or_sat(c);
    sat64(c, u, !sub);
    c.local_get(D).local_get(OV).select();
}

fn three_same(c: &mut Func, i: u32) -> bool {
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let (q, u, size, opc, scalar) = (
        bit(i, 30),
        bit(i, 29),
        bits(i, 23, 22) as usize,
        bits(i, 15, 11),
        bit(i, 28),
    );
    let esize = 8u32 << size;
    let ok = if scalar {
        match opc {
            0b00001 | 0b00101 => false, // inline already (simd::sat_scalar)
            0b01001 | 0b01011 => true,
            0b10110 => size == 1 || size == 2,
            0b01000 | 0b01010 | 0b00110 | 0b00111 | 0b10000 | 0b10001 => size == 3,
            _ => false,
        }
    } else {
        match opc {
            0b00001 | 0b00101 => size >= 2 && !(size == 3 && !q),
            0b01000..=0b01011 => !(size == 3 && !q),
            _ => false,
        }
    };
    if !ok {
        return false;
    }
    let n = if scalar {
        1
    } else if q {
        128 / esize
    } else {
        64 / esize
    };
    let saturates = matches!(opc, 0b00001 | 0b00101 | 0b01001 | 0b01011 | 0b10110);
    if saturates {
        sat_begin(c);
    }
    lanes(c, rd, false, size, n, 0, |c, e| {
        let signed_ops = opc == 0b10110;
        get(c, rn, size, e, u && !signed_ops);
        c.local_set(X);
        get(c, rm, size, e, u && !signed_ops);
        if (0b01000..=0b01011).contains(&opc) {
            c.op(EXTEND8_S);
        }
        c.local_set(Y);
        match opc {
            0b00001 | 0b00101 if size == 3 => add_sat64(c, u, opc == 0b00101),
            0b00001 | 0b00101 => {
                c.local_get(X).local_get(Y);
                c.op(if opc == 0b00101 { SUB } else { ADD });
                clamp(c, range(esize, u));
            }
            0b01000..=0b01011 => shift_reg(c, esize, u, opc & 2 != 0, opc & 1 != 0),
            0b00110 | 0b00111 => {
                c.local_get(X).local_get(Y);
                c.op(match (opc, u) {
                    (0b00110, false) => GT_S,
                    (0b00110, true) => GT_U,
                    (_, false) => GE_S,
                    (_, true) => GE_U,
                });
                mask(c);
            }
            0b10000 => {
                c.local_get(X).local_get(Y).op(if u { SUB } else { ADD });
            }
            0b10001 if u => {
                c.local_get(X).local_get(Y).op(EQ);
                mask(c);
            }
            0b10001 => {
                c.local_get(X).local_get(Y).op(AND).i64_const(0).op(NE);
                mask(c);
            }
            _ => {
                // SQDMULH / SQRDMULH (U): (2xy + round) >> esize as (xy + round / 2) >> (esize − 1).
                c.local_get(X).local_get(Y).op(MUL);
                if u {
                    c.i64_const(1 << (esize - 2)).op(ADD);
                }
                c.i64_const(i64::from(esize - 1)).op(SHR_S);
                clamp(c, range(esize, false));
            }
        }
    });
    if saturates {
        sat_end(c);
    }
    true
}

fn two_misc(c: &mut Func, i: u32) -> bool {
    let (rd, rn) = (bits(i, 4, 0), bits(i, 9, 5));
    let (q, u, size, opc, scalar) = (
        bit(i, 30),
        bit(i, 29),
        bits(i, 23, 22) as usize,
        bits(i, 16, 12),
        bit(i, 28),
    );
    let esize = 8u32 << size;
    let q128 = !(size == 3 && !q);
    let ok = match opc {
        0b00100 => !scalar && size != 3, // CLS, CLZ (U)
        0b00011 | 0b00111 => {
            if scalar {
                true
            } else {
                q128
            }
        } // SUQADD/USQADD, SQABS/SQNEG
        0b01000..=0b01011 => scalar && size == 3, // compares with zero, ABS/NEG
        0b10010 => u && size != 3 && (scalar || size == 2), // SQXTUN
        0b10100 => size != 3 && (scalar || size == 2), // SQXTN, UQXTN (U)
        _ => false,
    };
    // SUQADD/USQADD on 64-bit lanes: left to the helper.
    if !ok || (opc == 0b00011 && size == 3) {
        return false;
    }
    let narrowing = opc == 0b10010 || opc == 0b10100;
    let saturates = matches!(opc, 0b00011 | 0b00111) || narrowing;
    if saturates {
        sat_begin(c);
    }
    if narrowing {
        // From 2 × esize: to the low half (clearing the top), or the top half (Q).
        let n = if scalar { 1 } else { 64 / esize };
        let high = q && !scalar;
        lanes(c, rd, high, size, n, if high { n } else { 0 }, |c, e| {
            let ws = size + 1;
            get(c, rn, ws, e, u && opc == 0b10100);
            if ws == 3 && u && opc == 0b10100 {
                // UQXTN from 64 bits: unsigned compare.
                c.local_tee(X).i64_const((1i64 << esize) - 1).op(GT_U);
                c.local_tee(OV);
                or_sat(c);
                c.i64_const((1i64 << esize) - 1)
                    .local_get(X)
                    .local_get(OV)
                    .select();
            } else {
                clamp(c, range(esize, u));
            }
        });
        sat_end(c);
        return true;
    }
    let n = if scalar {
        1
    } else if q {
        128 / esize
    } else {
        64 / esize
    };
    lanes(c, rd, false, size, n, 0, |c, e| {
        match opc {
            0b00100 if u => {
                // CLZ: of the zero-extended lane, less the 64 − esize bits above it.
                get(c, rn, size, e, true);
                c.op(CLZ).i64_const(i64::from(64 - esize)).op(SUB);
            }
            0b00100 => {
                // CLS: clz((s ^ s << 1) | 1) of the sign-extended lane, less 64 − esize.
                get(c, rn, size, e, false);
                c.local_tee(X).local_get(X).i64_const(1).op(SHL).op(XOR);
                c.i64_const(1).op(OR).op(CLZ);
                c.i64_const(i64::from(64 - esize)).op(SUB);
            }
            0b00011 => {
                // SUQADD: signed Vd + unsigned Vn, signed result; USQADD (U) the reverse.
                get(c, rd, size, e, u);
                get(c, rn, size, e, !u);
                c.op(ADD);
                clamp(c, range(esize, u));
            }
            0b00111 if size == 3 => {
                // SQABS / SQNEG (U) on 64 bits: only MIN saturates.
                get(c, rn, 3, e, false);
                c.local_tee(X).i64_const(i64::MIN).op(EQ).local_tee(OV);
                or_sat(c);
                c.i64_const(i64::MAX);
                if u {
                    c.i64_const(0).local_get(X).op(SUB);
                } else {
                    c.i64_const(0).local_get(X).op(SUB).local_get(X);
                    c.local_get(X).i64_const(0).op(LT_S).select();
                }
                c.local_get(OV).select();
            }
            0b00111 => {
                get(c, rn, size, e, false);
                c.local_set(X);
                c.i64_const(0).local_get(X).op(SUB);
                if !u {
                    c.local_get(X).local_get(X).i64_const(0).op(LT_S).select();
                }
                clamp(c, range(esize, false));
            }
            _ => {
                get(c, rn, 3, e, false);
                c.local_set(X);
                match (opc, u) {
                    (0b01011, false) => {
                        // ABS
                        c.i64_const(0).local_get(X).op(SUB).local_get(X);
                        c.local_get(X).i64_const(0).op(LT_S).select();
                    }
                    (0b01011, true) => {
                        c.i64_const(0).local_get(X).op(SUB);
                    }
                    _ => {
                        c.local_get(X).i64_const(0);
                        c.op(match (opc, u) {
                            (0b01000, false) => GT_S,
                            (0b01000, true) => GE_S,
                            (0b01001, false) => EQ,
                            (0b01001, true) => LE_S,
                            _ => LT_S,
                        });
                        mask(c);
                    }
                }
            }
        }
    });
    if saturates {
        sat_end(c);
    }
    true
}

fn shift_imm(c: &mut Func, i: u32) -> bool {
    let (rd, rn) = (bits(i, 4, 0), bits(i, 9, 5));
    let (q, u, immh, opc, scalar) = (
        bit(i, 30),
        bit(i, 29),
        bits(i, 22, 19),
        bits(i, 15, 11),
        bit(i, 28),
    );
    if immh == 0 {
        return false;
    }
    let immhb = bits(i, 22, 16) as i64;
    let size = (31 - immh.leading_zeros()) as usize;
    let esize = 8u32 << size;
    let e = esize as i64;
    if opc >= 0b10000 {
        if immh & 8 != 0 || opc == 0b10100 || opc > 0b10011 {
            return false; // reserved, or SSHLL/USHLL (inline in simd)
        }
        // Narrowing from 2 × esize by s = 2 × esize − immhb (1..=esize).
        let (w, ws) = (2 * esize, size + 1);
        let s = 2 * e - immhb;
        let round = opc & 1 == 1;
        let n = if scalar { 1 } else { 64 / esize };
        let high = q && !scalar;
        let (src_u, dst_u, saturates) = match (opc & !1, u) {
            (0b10000, false) => (true, true, false), // SHRN, RSHRN
            (0b10000, true) => (false, true, true),  // SQSHRUN, SQRSHRUN
            (_, u) => (u, u, true),                  // SQSHRN, UQSHRN (U)
        };
        if !saturates && scalar {
            return false;
        }
        if saturates {
            sat_begin(c);
        }
        lanes(c, rd, high, size, n, if high { n } else { 0 }, |c, k| {
            get(c, rn, ws, k, src_u);
            c.local_set(X);
            c.i64_const(s).local_set(T);
            shr_round(c, T, w, src_u, round);
            // 2^64 - 1 rounded by one is 2^63, negative to `clamp`'s compares.
            if saturates && src_u && w == 64 && round && s == 1 {
                c.local_set(T);
                c.i64_const(i64::MAX).local_get(T);
                c.local_get(T).i64_const(0).op(LT_S).select();
            }
            if saturates {
                clamp(c, range(esize, dst_u));
            }
        });
        if saturates {
            sat_end(c);
        }
        return true;
    }
    let ok = if scalar {
        matches!(opc, 0b01100 | 0b01110) || size == 3
    } else {
        !(size == 3 && !q)
    };
    let right = 2 * e - immhb; // 1..=esize
    let left = immhb - e; // 0..esize
    let saturates = matches!(opc, 0b01100 | 0b01110);
    // Vector forms other than these are inline in simd.
    let vector_here = saturates || matches!(opc, 0b00100 | 0b00110);
    if !ok
        || (!scalar && !vector_here)
        || !matches!(
            opc,
            0b00000 | 0b00010 | 0b00100 | 0b00110 | 0b01000 | 0b01010 | 0b01100 | 0b01110
        )
        || (opc == 0b01000 && !u)
        || (opc == 0b01100 && !u)
    {
        return false;
    }
    let n = if scalar {
        1
    } else if q {
        128 / esize
    } else {
        64 / esize
    };
    if saturates {
        sat_begin(c);
    }
    lanes(c, rd, false, size, n, 0, |c, k| {
        match opc {
            0b00000..=0b00110 => {
                // SSHR, SSRA, SRSHR, SRSRA and the unsigned forms.
                get(c, rn, size, k, u);
                c.local_set(X);
                c.i64_const(right).local_set(T);
                shr_round(c, T, esize, u, opc & 0b00100 != 0);
                if opc & 0b00010 != 0 {
                    get(c, rd, size, k, true);
                    c.op(ADD);
                }
            }
            0b01000 => {
                // SRI: Vd's bits above the shifted-in ones kept (all of them for a full shift).
                let m = if right as u32 == esize {
                    0
                } else {
                    (u64::MAX >> (64 - esize)) >> right
                };
                get(c, rd, size, k, true);
                c.i64_const(!m as i64).op(AND);
                get(c, rn, size, k, true);
                c.i64_const(right.min(63)).op(SHR_U);
                c.i64_const(m as i64).op(AND).op(OR);
            }
            0b01010 => {
                // SHL, SLI (U): Vd's bits below the shift kept.
                get(c, rn, size, k, true);
                c.i64_const(left).op(SHL);
                if u {
                    let m = (u64::MAX >> (64 - esize)) << left;
                    c.i64_const(m as i64).op(AND);
                    get(c, rd, size, k, true);
                    c.i64_const(!m as i64).op(AND).op(OR);
                }
            }
            _ => {
                // SQSHLU (01100, from signed), SQSHL/UQSHL (01110).
                let src_u = opc == 0b01110 && u;
                let dst_u = opc == 0b01100 || u;
                get(c, rn, size, k, src_u);
                c.local_set(X);
                if esize < 64 {
                    c.local_get(X).i64_const(left).op(SHL);
                    clamp(c, range(esize, dst_u));
                } else {
                    // OV: the shift loses bits, or SQSHLU of a negative X.
                    // (SQSHLU's unsigned result may use bit 63: compare logically.)
                    c.local_get(X).i64_const(left).op(SHL).i64_const(left);
                    c.op(if src_u || opc == 0b01100 {
                        SHR_U
                    } else {
                        SHR_S
                    });
                    c.local_get(X).op(NE);
                    if opc == 0b01100 {
                        c.local_get(X).i64_const(0).op(LT_S).op(I32_OR);
                    }
                    c.local_tee(OV);
                    or_sat(c);
                    // Saturated: SQSHLU 0 below and all ones above, SQSHL by sign, UQSHL all ones.
                    if opc == 0b01100 {
                        c.i64_const(0).i64_const(-1);
                        c.local_get(X).i64_const(0).op(LT_S).select();
                    } else {
                        sat64(c, src_u, true);
                    }
                    c.local_get(X).i64_const(left).op(SHL);
                    c.local_get(OV).select();
                }
            }
        }
    });
    if saturates {
        sat_end(c);
    }
    true
}

/// SQDMULL, SQDMLAL, SQDMLSL (`opc` 1101, 1001, 1011) on X, Y (16- or 32-bit
/// lanes, signed) into a 2 × esize lane, the accumulator in local D.
fn doubling_long(c: &mut Func, esize: u32, opc: u32) {
    let w = 2 * esize;
    // P = 2xy, saturated: only MIN × MIN overflows.
    c.local_get(X).local_get(Y).op(MUL).local_set(T);
    let top = 1i64 << (2 * esize - 2);
    c.local_get(T).i64_const(top).op(EQ).local_tee(OV);
    or_sat(c);
    let max = if w == 64 {
        i64::MAX
    } else {
        (1i64 << (w - 1)) - 1
    };
    c.i64_const(max);
    c.local_get(T).local_get(T).op(ADD);
    c.local_get(OV).select();
    if opc == 0b1101 {
        return;
    }
    if w < 64 {
        c.local_set(T);
        c.local_get(D)
            .local_get(T)
            .op(if opc == 0b1011 { SUB } else { ADD });
        clamp(c, range(w, false));
    } else {
        // 64-bit saturating D ± P.
        c.local_set(Y);
        c.local_get(D).local_set(X);
        add_sat64(c, false, opc == 0b1011);
    }
}

fn three_diff(c: &mut Func, i: u32) -> bool {
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let (q, size, opc, scalar) = (
        bit(i, 30),
        bits(i, 23, 22) as usize,
        bits(i, 15, 12),
        bit(i, 28),
    );
    if !(size == 1 || size == 2) || !matches!(opc, 0b1001 | 0b1011 | 0b1101) || bit(i, 29) {
        return false;
    }
    long(c, rd, rn, q, size, opc, scalar, |c, e| {
        get(c, rm, size, e, false)
    });
    true
}

/// The doubling long forms: lanes of Vn's low (high, Q) half, Y from `y(e)`.
#[allow(clippy::too_many_arguments)]
fn long(
    c: &mut Func,
    rd: u32,
    rn: u32,
    q: bool,
    size: usize,
    opc: u32,
    scalar: bool,
    mut y: impl FnMut(&mut Func, u32),
) {
    let esize = 8u32 << size;
    let n = if scalar { 1 } else { 64 / esize };
    let base = if q && !scalar { n } else { 0 };
    sat_begin(c);
    lanes(c, rd, false, size + 1, n, 0, |c, e| {
        if opc != 0b1101 {
            get(c, rd, size + 1, e, false);
            c.local_set(D);
        }
        get(c, rn, size, base + e, false);
        c.local_set(X);
        y(c, base + e);
        c.local_set(Y);
        doubling_long(c, esize, opc);
    });
    sat_end(c);
}

fn by_element(c: &mut Func, i: u32) -> bool {
    let (rd, rn) = (bits(i, 4, 0), bits(i, 9, 5));
    let (q, u, size, scalar) = (bit(i, 30), bit(i, 29), bits(i, 23, 22) as usize, bit(i, 28));
    let (l, m, h) = (bit(i, 21) as u32, bit(i, 20) as u32, bit(i, 11) as u32);
    let (index, rm) = match size {
        1 => (h << 2 | l << 1 | m, bits(i, 19, 16)),
        2 => (h << 1 | l, bits(i, 20, 16)),
        _ => return false,
    };
    let opc = bits(i, 15, 12);
    let esize = 8u32 << size;
    match opc {
        0b1100 | 0b1101 if scalar => {
            // SQDMULH / SQRDMULH (by element), scalar.
            sat_begin(c);
            lanes(c, rd, false, size, 1, 0, |c, _| {
                get(c, rn, size, 0, false);
                get(c, rm, size, index, false);
                c.op(MUL);
                if opc == 0b1101 {
                    c.i64_const(1 << (esize - 2)).op(ADD);
                }
                c.i64_const(i64::from(esize - 1)).op(SHR_S);
                clamp(c, range(esize, false));
            });
            sat_end(c);
            true
        }
        0b0011 | 0b0111 | 0b1011 if !u => {
            let dopc = match opc {
                0b0011 => 0b1001,
                0b0111 => 0b1011,
                _ => 0b1101,
            };
            long(c, rd, rn, q, size, dopc, scalar, |c, _| {
                get(c, rm, size, index, false)
            });
            true
        }
        _ => false,
    }
}
