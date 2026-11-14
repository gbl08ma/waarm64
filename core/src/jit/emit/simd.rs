//! AdvSIMD integer instructions and SIMD&FP register moves as wasm SIMD128
//! (M6 loop 4). Operands and results are the V registers' locals
//! ([`Func::vget`], [`Func::vset`]). Each emitter mirrors
//! its interpreter handler (`interp::simd`, `interp::simd_int`): the same
//! encodings are left to the helper (UNDEFINED, or forms not covered here),
//! and the same lanes are computed; a 64-bit arrangement (Q = 0) clears the
//! top half of the result. Callers run [`super::fp_guard`] first.

use core::mem::offset_of;

use super::{Func, VCPU, VT, VTMP, get, set};
use crate::cpu::Cpu;
use crate::decode::Op;
use crate::interp::simd::{adv_simd_expand_imm, vfp_expand_imm};
use crate::interp::{bit, bits};

// SIMD opcodes (0xfd-prefixed), by lane size where they come in four.
const SPLAT: [u32; 4] = [0x0f, 0x10, 0x11, 0x12];
const EXTRACT_S: [u32; 4] = [0x15, 0x18, 0x1b, 0x1d];
const EXTRACT_U: [u32; 4] = [0x16, 0x19, 0x1b, 0x1d];
const REPLACE: [u32; 4] = [0x17, 0x1a, 0x1c, 0x1e];
const ADD: [u32; 4] = [0x6e, 0x8e, 0xae, 0xce];
const SUB: [u32; 4] = [0x71, 0x91, 0xb1, 0xd1];
// add_sat/sub_sat by lane size (8, 16): [signed, unsigned].
const ADD_SAT: [[u32; 2]; 2] = [[0x6f, 0x70], [0x8f, 0x90]];
const SUB_SAT: [[u32; 2]; 2] = [[0x72, 0x73], [0x92, 0x93]];
const MUL: [u32; 4] = [0, 0x95, 0xb5, 0xd5]; // no i8x16.mul
const SHL: [u32; 4] = [0x6b, 0x8b, 0xab, 0xcb];
const SHR_S: [u32; 4] = [0x6c, 0x8c, 0xac, 0xcc];
const SHR_U: [u32; 4] = [0x6d, 0x8d, 0xad, 0xcd];
const EQ: [u32; 4] = [0x23, 0x2d, 0x37, 0xd6];
const GT_S: [u32; 4] = [0x27, 0x31, 0x3b, 0xd9];
const GE_S: [u32; 4] = [0x2b, 0x35, 0x3f, 0xdb];
const MIN_S: [u32; 3] = [0x76, 0x96, 0xb6];
const MIN_U: [u32; 3] = [0x77, 0x97, 0xb7];
const MAX_S: [u32; 3] = [0x78, 0x98, 0xb8];
const MAX_U: [u32; 3] = [0x79, 0x99, 0xb9];
const NEG: [u32; 4] = [0x61, 0x81, 0xa1, 0xc1];
const ABS: [u32; 4] = [0x60, 0x80, 0xa0, 0xc0];
const VNOT: u32 = 0x4d;
const AND: u32 = 0x4e;
const ANDNOT: u32 = 0x4f;
const OR: u32 = 0x50;
const XOR: u32 = 0x51;
const BITSELECT: u32 = 0x52;
const POPCNT: u32 = 0x62;
const NE: [u32; 4] = [0x24, 0x2e, 0x38, 0xd7];
const LT_U8: u32 = 0x26;
const ANY_TRUE: u32 = 0x53;
const SWIZZLE: u32 = 0x0e;
// Widening, by source lane size: [signed, unsigned] × [low, high].
const EXTEND: [[[u32; 3]; 2]; 2] = [
    [[0x87, 0xa7, 0xc7], [0x88, 0xa8, 0xc8]],
    [[0x89, 0xa9, 0xc9], [0x8a, 0xaa, 0xca]],
];
const EXTMUL: [[[u32; 3]; 2]; 2] = [
    [[0x9c, 0xbc, 0xdc], [0x9d, 0xbd, 0xdd]],
    [[0x9e, 0xbe, 0xde], [0x9f, 0xbf, 0xdf]],
];
// extadd_pairwise, by source lane size (8, 16): [signed, unsigned].
const EXTADD_PAIRWISE: [[u32; 2]; 2] = [[0x7c, 0x7d], [0x7e, 0x7f]];
// Saturating narrows, by destination lane size (8, 16): [signed, unsigned] (from signed lanes).
const NARROW: [[u32; 2]; 2] = [[0x65, 0x66], [0x85, 0x86]];
const Q15MULR_SAT: u32 = 0x82;
const AVGR_U: [u32; 2] = [0x7b, 0x9b];
const SHUFFLE_EVEN: [u8; 16] = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30];
/// FPSR.QC.
const QC: i64 = 1 << 27;

/// Emits AdvSIMD instruction `i` inline if it's one this covers; false (and
/// nothing emitted) otherwise.
pub(super) fn inline(c: &mut Func, i: u32, op: Op) -> bool {
    use Op::*;
    match op {
        ADD_vector | SUB_2 | AND_asimd | BIC_asimd_reg | ORR_asimd_reg | ORN_asimd | EOR_asimd
        | BSL | BIT | BIF | CMEQ_reg_2 | CMTST_2 | CMGT_reg_2 | CMHI_2 | CMGE_reg_2 | CMHS_2
        | MUL_vec | MLA_vec | MLS_vec | SMAX | SMIN | UMAX | UMIN | SQADD_2 | UQADD_2 | SQSUB_2
        | UQSUB_2 | PMUL => three_same(c, i),
        SHADD | UHADD | SRHADD | URHADD | SHSUB | UHSUB | SABD | UABD | SABA | UABA | SMAXP
        | UMAXP | SMINP | UMINP | ADDP_vec | SQDMULH_vec_2 | SQRDMULH_vec_2 => three_same2(c, i),
        MUL_elt | MLA_elt | MLS_elt | SMULL_elt | UMULL_elt | SMLAL_elt | UMLAL_elt | SMLSL_elt
        | UMLSL_elt | SQDMULH_elt_2 | SQRDMULH_elt_2 => by_element(c, i),
        ADDHN | SUBHN | RADDHN | RSUBHN | SABAL | UABAL | SABDL | UABDL | PMULL => {
            three_diff2(c, i)
        }
        SRSHR_2 | URSHR_2 | SRSRA_2 | URSRA_2 | RSHRN | SQSHRN_2 | SQRSHRN_2 | SQSHRUN_2
        | SQRSHRUN_2 | UQSHRN_2 | UQRSHRN_2 | SQSHL_imm_2 | UQSHL_imm_2 | SQSHLU_2 => {
            shift_imm2(c, i)
        }
        SQXTN_2 | SQXTUN_2 | SQABS_2 | SQNEG_2 | SHLL | RBIT_asimd => two_misc2(c, i, op),
        SQADD_1 | UQADD_1 | SQSUB_1 | UQSUB_1 => sat_scalar(c, i),
        SSHR_2 | USHR_2 | SSRA_2 | USRA_2 | SHL_2 | SLI_2 | SRI_2 | SSHLL | USHLL | SHRN => {
            shift_imm(c, i)
        }
        REV16_asimd | REV32_asimd | REV64_asimd | NOT | NEG_2 | ABS_2 | CNT | XTN | SADDLP
        | UADDLP | SADALP | UADALP | UQXTN_2 | CMGT_zero_2 | CMGE_zero_2 | CMEQ_zero_2 | CMLE_2
        | CMLT_2 => two_misc(c, i, op),
        UZP1 | UZP2 | TRN1 | TRN2 | ZIP1 | ZIP2 => permute(c, i),
        SADDL | UADDL | SSUBL | USUBL | SADDW | UADDW | SSUBW | USUBW | SMULL_vec | UMULL_vec
        | SMLAL_vec | UMLAL_vec | SMLSL_vec | UMLSL_vec => three_diff(c, i),
        ADDV | SADDLV | UADDLV | SMAXV | UMAXV | SMINV | UMINV => across(c, i),
        TBL | TBX => table(c, i),
        EXT => ext(c, i),
        DUP_gen | DUP_elt_1 | DUP_elt_2 | INS_gen | INS_elt | UMOV | SMOV | MOVI | FMOV_2
        | FMOV_float_gen | FMOV_float | FMOV_float_imm => moves(c, i, op),
        _ => false,
    }
}

/// FEAT_RDM's SQRDMLAH and SQRDMLSH, vector and by element (the scalar forms
/// are `simd_lane`'s); false for anything else (the reserved sizes among
/// them). Vd ± the doubled product's rounded high half, saturated once, as
/// (Vd << esize ± 2xy + round) >> esize = Vd + ((±xy + round / 2) >> (esize − 1)).
/// Halfwords: `q15mulr_sat_s` is the high half for SQRDMLAH but for MIN × MIN
/// (1.0, which it saturates: the saturating add then adds the missing 1); for
/// SQRDMLSH, whose rounding of −2xy rounds a tie the other way, it's one too
/// many where the product's low 15 bits are a tie (0x4000). Words: the exact
/// products in i64 lanes, the sum saturated where it isn't its low half
/// sign-extended. FPSR.QC from the lanes that saturated.
pub(super) fn inline_rdm(c: &mut Func, i: u32, op: Op) -> bool {
    use Op::*;
    let (by_element, sub) = match op {
        SQRDMLAH_vec_2 => (false, false),
        SQRDMLSH_vec_2 => (false, true),
        SQRDMLAH_elt_2 => (true, false),
        SQRDMLSH_elt_2 => (true, true),
        _ => return false,
    };
    let (rd, rn) = (bits(i, 4, 0), bits(i, 9, 5));
    let (q, size) = (bit(i, 30), bits(i, 23, 22) as usize);
    let (l, m, h) = (bit(i, 21) as u32, bit(i, 20) as u32, bit(i, 11) as u32);
    let (index, rm) = match (size, by_element) {
        (1 | 2, false) => (0, bits(i, 20, 16)),
        (1, true) => (h << 2 | l << 1 | m, bits(i, 19, 16)),
        (2, true) => (h << 1 | l, bits(i, 20, 16)),
        _ => return false,
    };
    let (a, b) = (VT[2], VT[3]);
    vreg(c, rn);
    c.local_set(a);
    vreg(c, rm);
    if by_element {
        vreg(c, rm);
        c.shuffle(gather(1 << size, |_| index));
    }
    c.local_set(b);
    if size == 1 {
        let min = lanes_of(0x8000, 16);
        // k: MIN × MIN lanes (all ones), in VT[0]; r: the high half, one short
        // there (and for SQRDMLSH a tie's one too many taken off), in VT[1].
        c.local_get(a).v128_const(min).simd(EQ[1]);
        c.local_get(b)
            .v128_const(min)
            .simd(EQ[1])
            .simd(AND)
            .local_set(VT[0]);
        c.local_get(a).local_get(b).simd(Q15MULR_SAT);
        if sub {
            c.local_get(a).local_get(b).simd(MUL[1]);
            c.v128_const(lanes_of(0x7fff, 16)).simd(AND);
            c.v128_const(lanes_of(0x4000, 16)).simd(EQ[1]).simd(ADD[1]);
        }
        c.local_set(VT[1]);
        // Vd ± r, then ± 1 more for MIN × MIN (k is −1), saturating.
        let (acc, fix) = if sub {
            (SUB_SAT[1][0], ADD_SAT[1][0])
        } else {
            (ADD_SAT[1][0], SUB_SAT[1][0])
        };
        vreg(c, rd);
        c.local_get(VT[1]).simd(acc).local_get(VT[0]).simd(fix);
        c.local_tee(VTMP);
        // Saturated where it isn't the wrapping sum.
        vreg(c, rd);
        c.local_get(VT[1]);
        c.simd(if sub { SUB[1] } else { ADD[1] });
        c.local_get(VT[0]).simd(if sub { ADD[1] } else { SUB[1] });
        c.simd(NE[1]);
    } else {
        let max = lanes_of(0x7fff_ffff, 64);
        for half in 0..=q as usize {
            // The sum in i64 lanes, in VT[1].
            vreg(c, rd);
            c.simd(EXTEND[0][half][2]);
            if sub {
                c.v128_const(lanes_of(1 << 30, 64));
            }
            c.local_get(a).local_get(b).simd(EXTMUL[0][half][2]);
            if sub {
                c.simd(SUB[3]);
            } else {
                c.v128_const(lanes_of(1 << 30, 64)).simd(ADD[3]);
            }
            c.i32_const(31).simd(SHR_S[3]).simd(ADD[3]).local_tee(VT[1]);
            // MAX or MIN by its sign where the low half sign-extended isn't it.
            c.i32_const(63).simd(SHR_S[3]).v128_const(max).simd(XOR);
            c.local_get(VT[1])
                .local_get(VT[1])
                .i32_const(32)
                .simd(SHL[3]);
            c.i32_const(32).simd(SHR_S[3]).local_get(VT[1]).simd(NE[3]);
            c.local_tee(VT[0]).simd(BITSELECT);
            if half == 1 {
                c.local_get(VTMP).local_get(VT[0]).simd(OR);
            } else {
                c.local_get(VT[0]);
            }
            c.local_set(VTMP);
        }
        if !q {
            c.v128_const(0);
        }
        // The low halves of both.
        c.shuffle(gather(4, |e| 2 * e));
        c.vset(rd);
        c.local_get(VTMP).simd(ANY_TRUE);
        or_qc(c);
        return true;
    }
    if !q {
        c.i64_const(0).simd_lane(REPLACE[3], 1);
    }
    c.simd(ANY_TRUE);
    or_qc(c);
    put(c, rd, q, |c| {
        c.local_get(VTMP);
    });
    true
}

/// FEAT_DotProd's SDOT and UDOT, vector and by element; false for anything else
/// (the reserved sizes among them). The sixteen products as two `extmul`s, the
/// pairs of each 32-bit lane gathered by two shuffles, and two
/// `extadd_pairwise`s, summed before Vd, so Vd sees one add: accumulating both
/// is 3× slower in a sum loop. The other orders lost: bench/boot/REPORT.md
/// "FEAT_DotProd and FEAT_JSCVT, measured".
pub(super) fn inline_dot(c: &mut Func, i: u32, op: Op) -> bool {
    let by_element = match op {
        Op::SDOT_vec | Op::UDOT_vec => false,
        Op::SDOT_elt | Op::UDOT_elt => true,
        _ => return false,
    };
    if bits(i, 23, 22) != 2 {
        return false;
    }
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let (q, u) = (bit(i, 30), bit(i, 29) as usize);
    if by_element {
        let index = (bit(i, 11) as u32) << 1 | bit(i, 21) as u32;
        vreg(c, rm);
        vreg(c, rm);
        c.shuffle(gather(4, |_| index));
        c.local_set(VT[3]);
    }
    for high in 0..=q as usize {
        vreg(c, rn);
        if by_element {
            c.local_get(VT[3]);
        } else {
            vreg(c, rm);
        }
        c.simd(EXTMUL[u][high][0]).local_set(VT[high]);
    }
    let (lo, hi) = (VT[0], VT[q as usize]);
    put(c, rd, q, |c| {
        for part in 0..2 {
            c.local_get(lo).local_get(hi);
            c.shuffle(gather(4, |e| 2 * e + part));
            c.simd(EXTADD_PAIRWISE[1][u]);
        }
        c.simd(ADD[2]);
        vreg(c, rd);
        c.simd(ADD[2]);
    });
    true
}

/// FEAT_I8MM's USDOT (vector and by element), SUDOT (by element), SMMLA,
/// UMMLA and USMMLA; false for anything else. Bytes of mixed signs have no
/// `extmul`: each side is widened to 16 bits by its own sign and multiplied,
/// exactly (a product of an unsigned and a signed byte fits in 16 signed
/// bits). USDOT and SUDOT then sum as SDOT does; a matrix product sums each of
/// its four row-by-column products of eight bytes across, Vd added last.
pub(super) fn inline_i8mm(c: &mut Func, i: u32, op: Op) -> bool {
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    match op {
        Op::USDOT_vec | Op::USDOT_element | Op::SUDOT_element => {
            let by_element = op != Op::USDOT_vec;
            let q = bit(i, 30);
            // [Vn's, Vm's] sign: unsigned (1) or signed (0).
            let (un, um) = if op == Op::SUDOT_element {
                (0, 1)
            } else {
                (1, 0)
            };
            if by_element {
                let index = (bit(i, 11) as u32) << 1 | bit(i, 21) as u32;
                vreg(c, rm);
                vreg(c, rm);
                c.shuffle(gather(4, |_| index));
                c.local_set(VT[3]);
            }
            for high in 0..=q as usize {
                vreg(c, rn);
                c.simd(EXTEND[un][high][0]);
                if by_element {
                    c.local_get(VT[3]);
                } else {
                    vreg(c, rm);
                }
                c.simd(EXTEND[um][high][0]);
                c.simd(MUL[1]).local_set(VT[high]);
            }
            let (lo, hi) = (VT[0], VT[q as usize]);
            put(c, rd, q, |c| {
                for part in 0..2 {
                    c.local_get(lo).local_get(hi);
                    c.shuffle(gather(4, |e| 2 * e + part));
                    c.simd(EXTADD_PAIRWISE[1][0]);
                }
                c.simd(ADD[2]);
                vreg(c, rd);
                c.simd(ADD[2]);
            });
            true
        }
        Op::SMMLA_vec | Op::UMMLA_vec | Op::USMMLA_vec => {
            // P[r][c], Vn's row r by Vm's column c, eight 16-bit products, in
            // VT[2r + c]. With one sign on both sides they're extmuls of Vn
            // with Vm and with Vm's halves swapped (VTMP); UMMLA's products
            // are unsigned 16-bit.
            let u = (op == Op::UMMLA_vec) as usize;
            if op == Op::USMMLA_vec {
                // Vm's columns, then each row of Vn by both (a product
                // replaces the column it's the last to use).
                for col in 0..2 {
                    vreg(c, rm);
                    c.simd(EXTEND[0][col][0]).local_set(VT[2 + col]);
                }
                for row in 0..2 {
                    vreg(c, rn);
                    c.simd(EXTEND[1][row][0]).local_set(VTMP);
                    for col in 0..2 {
                        c.local_get(VTMP).local_get(VT[2 + col]).simd(MUL[1]);
                        c.local_set(VT[2 * row + col]);
                    }
                }
            } else {
                vreg(c, rm);
                vreg(c, rm);
                c.shuffle(gather(8, |e| e ^ 1)).local_set(VTMP);
                for row in 0..2 {
                    vreg(c, rn);
                    vreg(c, rm);
                    c.simd(EXTMUL[u][row][0]).local_set(VT[3 * row]);
                    vreg(c, rn);
                    c.local_get(VTMP);
                    c.simd(EXTMUL[u][row][0]).local_set(VT[1 + row]);
                }
            }
            // Pairs to 32 bits, then the four lanes of each product summed
            // across two levels of shuffles, as an ADDP of ADDPs.
            for p in VT {
                c.local_get(p).simd(EXTADD_PAIRWISE[1][u]).local_set(p);
            }
            let addp = |c: &mut Func, x: u32, y: u32, pick: [[u32; 4]; 2]| {
                for half in pick {
                    c.local_get(x)
                        .local_get(y)
                        .shuffle(gather(4, |e| half[e as usize]));
                }
                c.simd(ADD[2]);
            };
            for pair in 0..2 {
                addp(
                    c,
                    VT[2 * pair],
                    VT[2 * pair + 1],
                    [[0, 1, 4, 5], [2, 3, 6, 7]],
                );
                c.local_set(VT[pair]);
            }
            put(c, rd, true, |c| {
                addp(c, VT[0], VT[1], [[0, 2, 4, 6], [1, 3, 5, 7]]);
                vreg(c, rd);
                c.simd(ADD[2]);
            });
            true
        }
        _ => false,
    }
}

/// Pushes Vn.
fn vreg(c: &mut Func, n: u32) {
    c.vget(n);
}

/// Vd = what `value` pushes, its top half cleared unless `q`.
fn put(c: &mut Func, rd: u32, q: bool, value: impl FnOnce(&mut Func)) {
    value(c);
    if !q {
        c.i64_const(0).simd_lane(REPLACE[3], 1);
    }
    c.vset(rd);
}

/// `x` (the low `esize` bits) in every `esize`-bit lane of a u128.
fn lanes_of(x: u64, esize: u32) -> u128 {
    let x = x as u128 & (u128::MAX >> (128 - esize));
    (0..128 / esize).fold(0, |v, e| v | x << (e * esize))
}

/// The three-same group, vector forms (`interp::simd_int::three_same`).
fn three_same(c: &mut Func, i: u32) -> bool {
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let (q, u, size, opc) = (
        bit(i, 30),
        bit(i, 29),
        bits(i, 23, 22) as usize,
        bits(i, 15, 11),
    );
    if bit(i, 28) {
        return false; // scalar forms
    }
    let q128 = !(size == 3 && !q);
    if opc == 0b00011 {
        // Logical: size picks AND/BIC/ORR/ORN (U=0) or EOR/BSL/BIT/BIF (U=1).
        put(c, rd, q, |c| match (u, size) {
            (false, 0) => ops(c, &[rn, rm], &[AND]),
            (false, 1) => ops(c, &[rn, rm], &[ANDNOT]),
            (false, 2) => ops(c, &[rn, rm], &[OR]),
            (false, _) => {
                vreg(c, rn);
                vreg(c, rm);
                c.simd(VNOT).simd(OR);
            }
            (true, 0) => ops(c, &[rn, rm], &[XOR]),
            // bitselect(a, b, m) = a & m | b & !m
            (true, 1) => ops(c, &[rn, rm, rd], &[BITSELECT]), // BSL: d ? n : m
            (true, 2) => ops(c, &[rn, rd, rm], &[BITSELECT]), // BIT: m ? n : d
            (true, _) => ops(c, &[rd, rn, rm], &[BITSELECT]), // BIF: m ? d : n
        });
        return true;
    }
    let ok = match opc {
        0b10000 | 0b10001 | 0b00110 | 0b00111 => q128,
        0b10010 => size != 3,
        0b10011 => size != 3 && !(u && size != 0), // MUL; PMUL (U) on bytes only
        0b01100 | 0b01101 => size != 3,
        0b00001 | 0b00101 => size < 2 && q128, // no saturating 32/64-bit lanes in wasm
        _ => false,
    };
    if !ok {
        return false;
    }
    if matches!(opc, 0b00001 | 0b00101) {
        // SQADD/UQADD/SQSUB/UQSUB: FPSR.QC is set if the saturated result
        // differs from the wrapped one in any lane.
        let (sat, wrap) = if opc == 0b00001 {
            (ADD_SAT[size][u as usize], ADD[size])
        } else {
            (SUB_SAT[size][u as usize], SUB[size])
        };
        ops(c, &[rn, rm], &[sat]);
        ops(c, &[rn, rm], &[wrap]);
        c.simd(NE[size]);
        if !q {
            c.i64_const(0).simd_lane(REPLACE[3], 1); // the unused top half
        }
        c.simd(ANY_TRUE).if_();
        let fpsr = offset_of!(Cpu, fpsr) as u32;
        c.local_get(VCPU).local_get(VCPU).i64_load(fpsr);
        c.i64_const(QC).op(0x84).i64_store(fpsr); // i64.or
        c.end();
        put(c, rd, q, |c| ops(c, &[rn, rm], &[sat]));
        return true;
    }
    put(c, rd, q, |c| match opc {
        0b10000 => ops(c, &[rn, rm], &[if u { SUB[size] } else { ADD[size] }]),
        // CMEQ (U), CMTST: (n & m) != 0.
        0b10001 if u => ops(c, &[rn, rm], &[EQ[size]]),
        0b10001 => {
            ops(c, &[rn, rm], &[AND]);
            c.v128_const(0).simd(EQ[size]).simd(VNOT);
        }
        // CMGT/CMGE, CMHI/CMHS (U): unsigned 64-bit lanes have no wasm compare,
        // so every unsigned one flips the sign bits and compares signed.
        0b00110 | 0b00111 => {
            let cmp = if opc == 0b00110 {
                GT_S[size]
            } else {
                GE_S[size]
            };
            if u {
                let sign = lanes_of(1 << ((8 << size) - 1), 8 << size);
                vreg(c, rn);
                c.v128_const(sign).simd(XOR);
                vreg(c, rm);
                c.v128_const(sign).simd(XOR).simd(cmp);
            } else {
                ops(c, &[rn, rm], &[cmp]);
            }
        }
        0b10011 if u => pmul(c, rn, rm),
        0b10011 => mul(c, size, rn, rm),
        // MLA, MLS (U): d ± n * m.
        0b10010 => {
            vreg(c, rd);
            mul(c, size, rn, rm);
            c.simd(if u { SUB[size] } else { ADD[size] });
        }
        _ => {
            let t = match (opc, u) {
                (0b01100, false) => MAX_S,
                (0b01100, true) => MAX_U,
                (_, false) => MIN_S,
                (_, true) => MIN_U,
            };
            ops(c, &[rn, rm], &[t[size]]);
        }
    });
    true
}

/// Pushes Vn × Vm on `8 << size`-bit lanes: wasm has no i8x16.mul, so bytes
/// multiply as 16-bit lanes and keep their low bytes.
fn mul(c: &mut Func, size: usize, rn: u32, rm: u32) {
    if size > 0 {
        ops(c, &[rn, rm], &[MUL[size]]);
        return;
    }
    ops(c, &[rn, rm], &[EXTMUL[1][0][0]]);
    ops(c, &[rn, rm], &[EXTMUL[1][1][0]]);
    c.shuffle(SHUFFLE_EVEN);
}

/// Pushes PMUL Vn, Vm: the carry-less products of the bytes, one bit of Vm's at a time.
fn pmul(c: &mut Func, rn: u32, rm: u32) {
    c.v128_const(0);
    for k in 0..8 {
        let bit = lanes_of(1 << k, 8);
        vreg(c, rn);
        c.i32_const(k).simd(SHL[0]);
        vreg(c, rm);
        c.v128_const(bit).simd(AND).v128_const(0).simd(NE[0]);
        c.simd(AND).simd(XOR);
    }
}

/// Pushes the byte indices of lanes `src(e)` (of `eb` bytes) for each result lane.
fn gather(eb: u32, src: impl Fn(u32) -> u32) -> [u8; 16] {
    core::array::from_fn(|b| {
        let b = b as u32;
        (src(b / eb) * eb + b % eb) as u8
    })
}

/// Vd = the lanes in `VT[0]` (2 × `8 << size` bits) saturated to half their
/// size into Vd's low half, the top cleared, or (`q`) into its top half:
/// signed or unsigned (`dst_u`) results from signed lanes, or unsigned ones
/// from unsigned lanes (`src_u`). FPSR.QC set if a lane saturated.
fn sat_narrow(c: &mut Func, rd: u32, q: bool, size: usize, src_u: bool, dst_u: bool) {
    let w = size + 1;
    let max = (1u64 << (8 << size)) - 1;
    // Unsigned lanes become small signed ones first: the narrows read signed lanes.
    c.local_get(VT[0]);
    if src_u {
        c.v128_const(lanes_of(max, 8 << w)).simd(MIN_U[w]);
    }
    c.local_tee(VT[1]).local_get(VT[1]);
    c.simd(NARROW[size][dst_u as usize]).local_set(VT[1]);
    // Saturated if the narrowed lane, widened, isn't the original.
    c.local_get(VT[1]).simd(EXTEND[dst_u as usize][0][size]);
    c.local_get(VT[0]).simd(NE[w]).simd(ANY_TRUE);
    or_qc(c);
    put(c, rd, true, |c| {
        c.local_get(VT[1]);
        if q {
            vreg(c, rd);
            c.shuffle(core::array::from_fn(|b| {
                if b < 8 { 16 + b as u8 } else { b as u8 - 8 }
            }));
        } else {
            c.v128_const(0);
            c.shuffle(core::array::from_fn(|b| if b < 8 { b as u8 } else { 16 }));
        }
    });
}

/// FPSR.QC |= the i32 on the stack.
fn or_qc(c: &mut Func) {
    c.if_();
    let fpsr = offset_of!(Cpu, fpsr) as u32;
    c.local_get(VCPU).local_get(VCPU).i64_load(fpsr);
    c.i64_const(QC).op(0x84).i64_store(fpsr); // i64.or
    c.end();
}

/// Pushes (x >> s) + (x >> (s − 1) & 1) on `8 << size`-bit lanes of VT[0]
/// (s in 1..=esize): the rounded shift, without the overflow of adding first.
/// Arithmetic, or logical (`u`); a shift by the lane width is 0, or the sign.
fn shr_round(c: &mut Func, size: usize, s: u32, u: bool, round: bool) {
    let esize = 8 << size;
    if u && s == esize {
        c.v128_const(0);
    } else {
        c.local_get(VT[0]).i32_const(s.min(esize - 1) as i32);
        c.simd(if u { SHR_U[size] } else { SHR_S[size] });
    }
    if round {
        c.local_get(VT[0]).i32_const(s as i32 - 1);
        c.simd(if u { SHR_U[size] } else { SHR_S[size] });
        c.v128_const(lanes_of(1, esize)).simd(AND).simd(ADD[size]);
    }
}

/// The rest of three same, vector: halving adds and subtracts, absolute
/// differences, pairwise operations, SQDMULH/SQRDMULH.
fn three_same2(c: &mut Func, i: u32) -> bool {
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let (q, u, size, opc) = (
        bit(i, 30),
        bit(i, 29),
        bits(i, 23, 22) as usize,
        bits(i, 15, 11),
    );
    if bit(i, 28) {
        return false;
    }
    let ok = match opc {
        0b10110 => size == 1 || size == 2,
        0b10111 => !(size == 3 && !q),
        _ => size != 3,
    };
    if !ok {
        return false;
    }
    let (eb, shr) = (1u32 << size, if u { SHR_U[size] } else { SHR_S[size] });
    match opc {
        0b10110 => {
            vreg(c, rn);
            c.local_set(VT[2]);
            vreg(c, rm);
            c.local_set(VT[3]);
            doubling_high(c, rd, q, size, u);
            return true;
        }
        0b10100 | 0b10101 | 0b10111 => {
            // Pairwise: lanes 2e and 2e + 1 of Vm:Vn (of their low halves for 64-bit vectors).
            let n = if q { 16 } else { 8 } / eb;
            let at = |j: u32| if j < n { j } else { 16 / eb + j - n };
            let f = match (opc, u) {
                (0b10111, _) => ADD[size],
                (0b10100, false) => MAX_S[size],
                (0b10100, true) => MAX_U[size],
                (_, false) => MIN_S[size],
                (_, true) => MIN_U[size],
            };
            put(c, rd, q, |c| {
                for odd in 0..2 {
                    vreg(c, rn);
                    vreg(c, rm);
                    c.shuffle(gather(eb, |e| at((2 * e + odd) % (2 * n))));
                }
                c.simd(f);
            });
            return true;
        }
        _ => {}
    }
    put(c, rd, q, |c| match opc {
        // SHADD/UHADD: (x & y) + ((x ^ y) >> 1).
        0b00000 => {
            ops(c, &[rn, rm], &[AND]);
            ops(c, &[rn, rm], &[XOR]);
            c.i32_const(1).simd(shr).simd(ADD[size]);
        }
        // URHADD on bytes and halfwords is avgr_u; otherwise (x | y) − ((x ^ y) >> 1).
        0b00010 if u && size < 2 => ops(c, &[rn, rm], &[AVGR_U[size]]),
        0b00010 => {
            ops(c, &[rn, rm], &[OR]);
            ops(c, &[rn, rm], &[XOR]);
            c.i32_const(1).simd(shr).simd(SUB[size]);
        }
        // SHSUB/UHSUB: (x >> 1) − (y >> 1) − (~x & y & 1).
        0b00100 => {
            vreg(c, rn);
            c.i32_const(1).simd(shr);
            vreg(c, rm);
            c.i32_const(1).simd(shr).simd(SUB[size]);
            vreg(c, rm);
            vreg(c, rn);
            c.simd(ANDNOT).v128_const(lanes_of(1, 8 << size)).simd(AND);
            c.simd(SUB[size]);
        }
        // SABD/UABD: max − min; SABA/UABA add it to Vd.
        _ => {
            if opc == 0b01111 {
                vreg(c, rd);
            }
            let (max, min) = if u { (MAX_U, MIN_U) } else { (MAX_S, MIN_S) };
            ops(c, &[rn, rm], &[max[size]]);
            ops(c, &[rn, rm], &[min[size]]);
            c.simd(SUB[size]);
            if opc == 0b01111 {
                c.simd(ADD[size]);
            }
        }
    });
    true
}

/// SQDMULH / SQRDMULH (`round`) of VT[2] and VT[3] into Vd (16- or 32-bit
/// lanes): the high half of the doubled product. Only MIN × MIN saturates.
fn doubling_high(c: &mut Func, rd: u32, q: bool, size: usize, round: bool) {
    let (a, b) = (VT[2], VT[3]);
    let esize = 8u32 << size;
    let min = lanes_of(1 << (esize - 1), esize);
    // The saturating lanes, in VT[0].
    c.local_get(a).v128_const(min).simd(EQ[size]);
    c.local_get(b).v128_const(min).simd(EQ[size]).simd(AND);
    if !q {
        c.i64_const(0).simd_lane(REPLACE[3], 1);
    }
    c.local_tee(VT[0]).simd(ANY_TRUE);
    or_qc(c);
    put(c, rd, q, |c| {
        if size == 1 && round {
            // Exactly q15mulr_sat_s.
            c.local_get(a).local_get(b).simd(Q15MULR_SAT);
            return;
        }
        // The exact products, (p + round) >> (esize − 1), their low halves.
        for ext in &EXTMUL[0] {
            c.local_get(a).local_get(b).simd(ext[size]);
            if round {
                c.v128_const(lanes_of(1 << (esize - 2), 2 * esize))
                    .simd(ADD[size + 1]);
            }
            c.i32_const(esize as i32 - 1).simd(SHR_S[size + 1]);
        }
        c.shuffle(gather(1 << size, |e| 2 * e)).local_set(VTMP);
        // MIN × MIN: MAX.
        c.v128_const(lanes_of((1 << (esize - 1)) - 1, esize));
        c.local_get(VTMP).local_get(VT[0]).simd(BITSELECT);
    });
}

/// MUL, MLA, MLS, the long multiplies and SQDMULH/SQRDMULH by element, vector
/// (`interp::simd_int::by_element`): Vm's lane in every lane, then the vector form.
fn by_element(c: &mut Func, i: u32) -> bool {
    let (rd, rn) = (bits(i, 4, 0), bits(i, 9, 5));
    let (q, u, size) = (bit(i, 30), bit(i, 29), bits(i, 23, 22) as usize);
    if bit(i, 28) {
        return false;
    }
    let (l, m, h) = (bit(i, 21) as u32, bit(i, 20) as u32, bit(i, 11) as u32);
    let (index, rm) = match size {
        1 => (h << 2 | l << 1 | m, bits(i, 19, 16)),
        2 => (h << 1 | l, bits(i, 20, 16)),
        _ => return false,
    };
    let eb = 1u32 << size;
    // Vm's lane `index` in every lane, in VT[3].
    vreg(c, rm);
    vreg(c, rm);
    c.shuffle(gather(eb, |_| index));
    c.local_set(VT[3]);
    match (bits(i, 15, 12), u) {
        (0b1000, false) | (0b0000, true) | (0b0100, true) => {
            // MUL, MLA, MLS: d ± n × m.
            let opc = bits(i, 15, 12);
            put(c, rd, q, |c| {
                if opc != 0b1000 {
                    vreg(c, rd);
                }
                vreg(c, rn);
                c.local_get(VT[3]).simd(MUL[size]);
                match opc {
                    0b0000 => c.simd(ADD[size]),
                    0b0100 => c.simd(SUB[size]),
                    _ => c,
                };
            });
        }
        (0b1100 | 0b1101, _) => {
            vreg(c, rn);
            c.local_set(VT[2]);
            doubling_high(c, rd, q, size, bits(i, 15, 12) == 0b1101);
        }
        (opc @ (0b0010 | 0b0110 | 0b1010), u) => {
            // SMLAL/UMLAL, SMLSL/UMLSL, SMULL/UMULL: from Vn's low (high, Q) half.
            put(c, rd, true, |c| {
                if opc != 0b1010 {
                    vreg(c, rd);
                }
                vreg(c, rn);
                c.local_get(VT[3])
                    .simd(EXTMUL[u as usize][q as usize][size]);
                match opc {
                    0b0010 => c.simd(ADD[size + 1]),
                    0b0110 => c.simd(SUB[size + 1]),
                    _ => c,
                };
            });
        }
        _ => return false,
    }
    true
}

/// The narrowing high-half forms (ADDHN, SUBHN, RADDHN, RSUBHN), the absolute
/// differences long (SABDL/UABDL, SABAL/UABAL) and PMULL on bytes, vector.
fn three_diff2(c: &mut Func, i: u32) -> bool {
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let (q, u, size, opc) = (
        bit(i, 30),
        bit(i, 29),
        bits(i, 23, 22) as usize,
        bits(i, 15, 12),
    );
    if bit(i, 28) || size == 3 {
        return false;
    }
    let (esize, w) = (8u32 << size, size + 1);
    match opc {
        0b0100 | 0b0110 => {
            // The high half of each wide sum or difference, rounded (U).
            narrow(c, rd, q, size, |c| {
                ops(c, &[rn, rm], &[if opc == 0b0100 { ADD[w] } else { SUB[w] }]);
                if u {
                    c.v128_const(lanes_of(1 << (esize - 1), 2 * esize))
                        .simd(ADD[w]);
                }
                c.i32_const(esize as i32).simd(SHR_U[w]);
            });
        }
        0b0101 | 0b0111 => put(c, rd, true, |c| {
            if opc == 0b0101 {
                vreg(c, rd);
            }
            widen(c, rn, size, q, u);
            widen(c, rm, size, q, u);
            c.simd(SUB[w]).simd(ABS[w]);
            if opc == 0b0101 {
                c.simd(ADD[w]);
            }
        }),
        0b1110 if size == 0 && !u => put(c, rd, true, |c| {
            // PMULL.8H: 16-bit lanes of the zero-extended bytes, one bit of Vm's at a time.
            c.v128_const(0);
            for k in 0..8 {
                widen(c, rn, 0, q, true);
                c.i32_const(k).simd(SHL[1]);
                widen(c, rm, 0, q, true);
                c.v128_const(lanes_of(1 << k, 16))
                    .simd(AND)
                    .v128_const(0)
                    .simd(NE[1]);
                c.simd(AND).simd(XOR);
            }
        }),
        _ => return false,
    }
    true
}

/// Rounding shifts right (SRSHR/URSHR, SRSRA/URSRA), the narrowing shifts
/// from 16- and 32-bit lanes (RSHRN and the saturating ones) and the
/// saturating shifts left on bytes and halfwords, vector.
fn shift_imm2(c: &mut Func, i: u32) -> bool {
    let (rd, rn) = (bits(i, 4, 0), bits(i, 9, 5));
    let (q, u, immh, opc) = (bit(i, 30), bit(i, 29), bits(i, 22, 19), bits(i, 15, 11));
    let immhb = bits(i, 22, 16);
    if bit(i, 28) || immh == 0 {
        return false;
    }
    let size = (31 - immh.leading_zeros()) as usize;
    let esize = 8u32 << size;
    match opc {
        0b00100 | 0b00110 => {
            if size == 3 && !q {
                return false;
            }
            let s = 2 * esize - immhb;
            vreg(c, rn);
            c.local_set(VT[0]);
            put(c, rd, q, |c| {
                if opc == 0b00110 {
                    vreg(c, rd);
                }
                shr_round(c, size, s, u, true);
                if opc == 0b00110 {
                    c.simd(ADD[size]);
                }
            });
        }
        0b10000..=0b10011 => {
            // From 2 × esize lanes by s = 2 × esize − immhb (1..=esize).
            if immh & 8 != 0 || size == 2 {
                return false; // reserved, or from 64-bit lanes (simd_lane)
            }
            let w = size + 1;
            let s = 2 * esize - immhb;
            let round = opc & 1 == 1;
            let (src_u, dst_u) = match (opc & !1, u) {
                (0b10000, false) => (true, true),
                (0b10000, true) => (false, true),
                (_, u) => (u, u),
            };
            vreg(c, rn);
            c.local_set(VT[0]);
            if opc & !1 == 0b10000 && !u {
                // RSHRN (SHRN is in shift_imm): truncated.
                narrow(c, rd, q, size, |c| shr_round(c, w, s, true, round));
                return true;
            }
            shr_round(c, w, s, src_u, round);
            c.local_set(VT[0]);
            sat_narrow(c, rd, q, size, src_u, dst_u);
        }
        0b01100 | 0b01110 => {
            // SQSHLU (U), SQSHL/UQSHL (U): bytes and halfwords, shifted at twice the
            // width (exact), then narrowed with saturation.
            if size > 1 || (opc == 0b01100 && !u) {
                return false; // 32- and 64-bit lanes: simd_lane
            }
            let left = (immhb - esize) as i32;
            let (src_u, dst_u) = (opc == 0b01110 && u, opc == 0b01100 || u);
            for high in 0..2 {
                vreg(c, rn);
                c.simd(EXTEND[src_u as usize][high][size]);
                c.i32_const(left).simd(SHL[size + 1]);
                c.local_set(VT[high]);
            }
            // Unsigned lanes become small signed ones first.
            if src_u {
                let max = lanes_of((1 << esize) - 1, 2 * esize);
                for k in 0..2 {
                    c.local_get(VT[k])
                        .v128_const(max)
                        .simd(MIN_U[size + 1])
                        .local_set(VT[2 + k]);
                }
            } else {
                for k in 0..2 {
                    c.local_get(VT[k]).local_set(VT[2 + k]);
                }
            }
            c.local_get(VT[2])
                .local_get(VT[3])
                .simd(NARROW[size][dst_u as usize]);
            c.local_set(VTMP);
            // Q = 0: the low half's lanes only.
            for high in 0..1 + q as usize {
                c.local_get(VTMP).simd(EXTEND[dst_u as usize][high][size]);
                c.local_get(VT[high]).simd(NE[size + 1]).simd(ANY_TRUE);
                if high == 1 {
                    c.op(0x72); // i32.or
                }
            }
            or_qc(c);
            put(c, rd, q, |c| {
                c.local_get(VTMP);
            });
        }
        _ => return false,
    }
    true
}

/// SQXTN/SQXTUN (vector, to bytes and halfwords), SQABS/SQNEG, SHLL, RBIT.
fn two_misc2(c: &mut Func, i: u32, op: Op) -> bool {
    use Op::*;
    let (rd, rn) = (bits(i, 4, 0), bits(i, 9, 5));
    let (q, u, size) = (bit(i, 30), bit(i, 29), bits(i, 23, 22) as usize);
    if bit(i, 28) {
        return false;
    }
    let esize = 8u32 << size;
    match op {
        SQXTN_2 | SQXTUN_2 if size < 2 => {
            vreg(c, rn);
            c.local_set(VT[0]);
            sat_narrow(c, rd, q, size, u && op == SQXTN_2, u);
        }
        SQABS_2 | SQNEG_2 if !(size == 3 && !q) => {
            // abs or neg, MAX where the lane is MIN.
            let min = lanes_of(1 << (esize - 1), esize);
            vreg(c, rn);
            c.v128_const(min).simd(EQ[size]).local_tee(VT[0]);
            if !q {
                c.i64_const(0).simd_lane(REPLACE[3], 1);
            }
            c.simd(ANY_TRUE);
            or_qc(c);
            put(c, rd, q, |c| {
                c.v128_const(lanes_of((1 << (esize - 1)) - 1, esize));
                vreg(c, rn);
                c.simd(if op == SQABS_2 { ABS[size] } else { NEG[size] });
                c.local_get(VT[0]).simd(BITSELECT);
            });
        }
        SHLL if size != 3 => put(c, rd, true, |c| {
            widen(c, rn, size, q, true);
            c.i32_const(esize as i32).simd(SHL[size + 1]);
        }),
        RBIT_asimd if size == 1 => put(c, rd, q, |c| {
            // Each nibble reversed through a table, the nibbles swapped.
            let rev4: [u8; 16] = core::array::from_fn(|n| (n as u8).reverse_bits() >> 4);
            let table = u128::from_le_bytes(rev4);
            c.v128_const(table);
            vreg(c, rn);
            c.v128_const(lanes_of(15, 8)).simd(AND).simd(SWIZZLE);
            c.i32_const(4).simd(SHL[0]);
            c.v128_const(table);
            vreg(c, rn);
            c.i32_const(4).simd(SHR_U[0]).simd(SWIZZLE);
            c.simd(OR);
        }),
        _ => return false,
    }
    true
}

/// Scalar SQADD/UQADD/SQSUB/UQSUB (`interp::simd_int::three_same`, scalar),
/// in i64 arithmetic: Vd = the saturated element, zero-extended, and FPSR.QC
/// set if it saturated. Elements under 64 bits are extended to i64, where the
/// exact result fits and is clamped; 64-bit ones detect the overflow.
fn sat_scalar(c: &mut Func, i: u32) -> bool {
    const A: u32 = 2; // i64 scratch
    const B: u32 = 3;
    const R: u32 = 4;
    const OVF: u32 = 8; // i32 scratch
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let (u, size, sub) = (bit(i, 29), bits(i, 23, 22), bits(i, 15, 11) == 0b00101);
    let esize = 8 << size;
    let (add_or_sub, xor, and, shl, shr_s) =
        (if sub { 0x7d } else { 0x7c }, 0x85, 0x83, 0x86, 0x87);
    for (l, n) in [(A, rn), (B, rm)] {
        c.vlane(n, 64, 0);
        if esize < 64 {
            if u {
                c.i64_const(((1u64 << esize) - 1) as i64).op(and);
            } else {
                let s = i64::from(64 - esize);
                c.i64_const(s).op(shl).i64_const(s).op(shr_s);
            }
        }
        c.local_set(l);
    }
    c.local_get(A).local_get(B).op(add_or_sub).local_set(R);
    if esize < 64 {
        let (lo, hi) = if u {
            (0, (1i64 << esize) - 1)
        } else {
            (-(1i64 << (esize - 1)), (1i64 << (esize - 1)) - 1)
        };
        // OVF = r < lo || r > hi; R = the clamped r.
        c.local_get(R).i64_const(lo).op(0x53); // i64.lt_s
        c.local_get(R)
            .i64_const(hi)
            .op(0x55)
            .op(0x72)
            .local_set(OVF); // i64.gt_s, i32.or
        c.i64_const(hi)
            .local_get(R)
            .local_get(R)
            .i64_const(hi)
            .op(0x55)
            .select();
        c.local_set(R)
            .i64_const(lo)
            .local_get(R)
            .local_get(R)
            .i64_const(lo)
            .op(0x53)
            .select();
        c.i64_const(((1u64 << esize) - 1) as i64)
            .op(and)
            .local_set(R);
    } else {
        // The overflow, and the saturated value it gives.
        match (u, sub) {
            (true, false) => c.local_get(R).local_get(A).op(0x54), // r < a (lt_u)
            (true, true) => c.local_get(A).local_get(B).op(0x54),  // a < b (lt_u)
            // ((a ^ r) & (b ^ r)) < 0, ((a ^ b) & (a ^ r)) < 0
            (false, false) => c
                .local_get(A)
                .local_get(R)
                .op(xor)
                .local_get(B)
                .local_get(R),
            (false, true) => c
                .local_get(A)
                .local_get(B)
                .op(xor)
                .local_get(A)
                .local_get(R),
        };
        if !u {
            c.op(xor).op(and).i64_const(0).op(0x53);
        }
        c.local_set(OVF);
        match (u, sub) {
            (true, false) => c.i64_const(-1),
            (true, true) => c.i64_const(0),
            _ => c
                .local_get(A)
                .i64_const(63)
                .op(shr_s)
                .i64_const(i64::MAX)
                .op(xor),
        };
        c.local_get(R).local_get(OVF).select().local_set(R);
    }
    c.local_get(OVF).if_();
    let fpsr = offset_of!(Cpu, fpsr) as u32;
    c.local_get(VCPU).local_get(VCPU).i64_load(fpsr);
    c.i64_const(QC).op(0x84).i64_store(fpsr); // i64.or
    c.end();
    c.vset_scalar(rd, 64, |c| {
        c.local_get(R);
    });
    true
}

/// Pushes the V registers `regs`, then applies `ops`.
fn ops(c: &mut Func, regs: &[u32], ops: &[u32]) {
    for &r in regs {
        vreg(c, r);
    }
    for &o in ops {
        c.simd(o);
    }
}

/// Shifts by immediate, vector, non-rounding, non-saturating, not narrowing or
/// widening (`interp::simd_int::shift_imm`).
fn shift_imm(c: &mut Func, i: u32) -> bool {
    let (rd, rn) = (bits(i, 4, 0), bits(i, 9, 5));
    let (q, u, immh, opc) = (bit(i, 30), bit(i, 29), bits(i, 22, 19), bits(i, 15, 11));
    let immhb = bits(i, 22, 16);
    if bit(i, 28) || immh == 0 {
        return false;
    }
    let size = (31 - immh.leading_zeros()) as usize;
    let esize = 8u32 << size;
    if opc >= 0b10000 {
        // SSHLL/USHLL(2): widened, then shifted left; SHRN(2): shifted right
        // at 2 × esize, then narrowed. immh<3> is reserved.
        if immh & 8 != 0 {
            return false;
        }
        match (opc, u) {
            (0b10100, _) => put(c, rd, true, |c| {
                widen(c, rn, size, q, u);
                c.i32_const((immhb - esize) as i32).simd(SHL[size + 1]);
            }),
            (0b10000, false) => narrow(c, rd, q, size, |c| {
                vreg(c, rn);
                c.i32_const((2 * esize - immhb) as i32)
                    .simd(SHR_U[size + 1]);
            }),
            _ => return false,
        }
        return true;
    }
    if size == 3 && !q {
        return false;
    }
    let right = 2 * esize - immhb; // 1..=esize
    let left = immhb - esize; // 0..esize
    let all = u64::MAX >> (64 - esize);
    put(c, rd, q, |c| match (opc, u) {
        // SSHR, USHR; SSRA, USRA add to Vd. A shift by the lane width: wasm
        // shifts take it modulo the width, so USHR gives 0 and SSHR shifts by
        // one less (the same sign bits).
        (0b00000 | 0b00010, _) => {
            if opc == 0b00010 {
                vreg(c, rd);
            }
            if u && right == esize {
                c.v128_const(0);
            } else {
                vreg(c, rn);
                c.i32_const(right.min(esize - 1) as i32);
                c.simd(if u { SHR_U[size] } else { SHR_S[size] });
            }
            if opc == 0b00010 {
                c.simd(ADD[size]);
            }
        }
        // SHL.
        (0b01010, false) => {
            vreg(c, rn);
            c.i32_const(left as i32).simd(SHL[size]);
        }
        // SLI: Vd's bits below the shift kept.
        (0b01010, true) => {
            vreg(c, rn);
            c.i32_const(left as i32).simd(SHL[size]);
            vreg(c, rd);
            c.v128_const(lanes_of(all << left, esize)).simd(BITSELECT);
        }
        // SRI: Vd's bits above the shift kept (all of them for a full shift).
        (0b01000, true) => {
            if right == esize {
                vreg(c, rd);
            } else {
                vreg(c, rn);
                c.i32_const(right as i32).simd(SHR_U[size]);
                vreg(c, rd);
                c.v128_const(lanes_of(all >> right, esize)).simd(BITSELECT);
            }
        }
        _ => unreachable!("{i:#x}"),
    });
    true
}

/// The byte shuffle reversing `esize`-bit lanes within each `cont`-bit container.
fn rev(cont: u32, esize: u32) -> [u8; 16] {
    let (cb, eb) = (cont / 8, esize / 8);
    core::array::from_fn(|b| {
        let (b, per) = (b as u32, cb / eb);
        let (base, o) = (b - b % cb, b % cb);
        (base + (per - 1 - o / eb) * eb + o % eb) as u8
    })
}

fn two_misc(c: &mut Func, i: u32, op: Op) -> bool {
    use Op::*;
    let (rd, rn) = (bits(i, 4, 0), bits(i, 9, 5));
    let (q, size) = (bit(i, 30), bits(i, 23, 22) as usize);
    let esize = 8 << size;
    let q128 = !(size == 3 && !q);
    let shuffle = |c: &mut Func, s: [u8; 16]| {
        vreg(c, rn);
        vreg(c, rn);
        c.shuffle(s);
    };
    match op {
        REV64_asimd if size != 3 => put(c, rd, q, |c| shuffle(c, rev(64, esize))),
        REV32_asimd if size < 2 => put(c, rd, q, |c| shuffle(c, rev(32, esize))),
        REV16_asimd if size == 0 => put(c, rd, q, |c| shuffle(c, rev(16, 8))),
        NOT if size == 0 => put(c, rd, q, |c| ops(c, &[rn], &[VNOT])),
        CNT if size == 0 => put(c, rd, q, |c| ops(c, &[rn], &[POPCNT])),
        NEG_2 if q128 && !bit(i, 28) => put(c, rd, q, |c| ops(c, &[rn], &[NEG[size]])),
        ABS_2 if q128 && !bit(i, 28) => put(c, rd, q, |c| ops(c, &[rn], &[ABS[size]])),
        XTN if size != 3 => narrow(c, rd, q, size, |c| vreg(c, rn)),
        // Compares against zero: all-ones lanes where true.
        CMGT_zero_2 | CMGE_zero_2 | CMEQ_zero_2 | CMLE_2 | CMLT_2 if q128 && !bit(i, 28) => {
            put(c, rd, q, |c| {
                // CMLT and CMLE as 0 > x and 0 >= x.
                let swap = matches!(op, CMLT_2 | CMLE_2);
                if swap {
                    c.v128_const(0);
                }
                vreg(c, rn);
                if !swap {
                    c.v128_const(0);
                }
                c.simd(match op {
                    CMGT_zero_2 | CMLT_2 => GT_S[size],
                    CMEQ_zero_2 => EQ[size],
                    _ => GE_S[size],
                });
            });
        }
        // UQXTN(2): unsigned saturation first, FPSR.QC set if a lane saturated.
        // No 64-bit unsigned min in wasm: 64 → 32 stays a helper call.
        UQXTN_2 if size < 2 && !bit(i, 28) => {
            let max = lanes_of((1 << esize) - 1, 2 * esize);
            vreg(c, rn);
            c.v128_const(max).simd(MIN_U[size + 1]);
            vreg(c, rn);
            c.simd(NE[size + 1]).simd(ANY_TRUE).if_();
            let fpsr = offset_of!(Cpu, fpsr) as u32;
            c.local_get(VCPU).local_get(VCPU).i64_load(fpsr);
            c.i64_const(QC).op(0x84).i64_store(fpsr); // i64.or
            c.end();
            narrow(c, rd, q, size, |c| {
                vreg(c, rn);
                c.v128_const(max).simd(MIN_U[size + 1]);
            });
        }
        // SADDLP/UADDLP, SADALP/UADALP: adjacent pairs added into 2 × esize
        // lanes (and added to Vd's).
        SADDLP | UADDLP | SADALP | UADALP if size != 3 => {
            let u = bit(i, 29);
            put(c, rd, q, |c| {
                if matches!(op, SADALP | UADALP) {
                    vreg(c, rd);
                }
                if size < 2 {
                    vreg(c, rn);
                    c.simd(EXTADD_PAIRWISE[size][u as usize]);
                } else {
                    // 32-bit lanes: the even and the odd ones, widened, added.
                    for odd in [0, 4] {
                        vreg(c, rn);
                        vreg(c, rn);
                        c.shuffle(core::array::from_fn(|b| {
                            (b as u8 / 4 * 8 + odd + b as u8 % 4) % 16
                        }));
                        c.simd(EXTEND[u as usize][0][2]);
                    }
                    c.simd(ADD[3]);
                }
                if matches!(op, SADALP | UADALP) {
                    c.simd(ADD[size + 1]);
                }
            });
        }
        _ => return false,
    }
    true
}

/// UZP1/UZP2, TRN1/TRN2, ZIP1/ZIP2 as one shuffle of Vn:Vm
/// (`interp::simd_int::permute`).
fn permute(c: &mut Func, i: u32) -> bool {
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let (q, size) = (bit(i, 30), bits(i, 23, 22));
    if size == 3 && !q {
        return false;
    }
    let (eb, opc) = (1u32 << size, bits(i, 14, 12));
    let n = if q { 16 } else { 8 } / eb;
    let part = opc >> 2;
    // Lane e of the result as (from Vm, lane of the source).
    let src = |e: u32| match opc & 3 {
        1 => (2 * e + part >= n, (2 * e + part) % n),
        2 => (e % 2 == 1, e - e % 2 + part),
        _ => (e % 2 == 1, part * n / 2 + e / 2),
    };
    let lanes = core::array::from_fn(|b| {
        let (b, e) = (b as u32, b as u32 / eb);
        if e >= n {
            return 0; // the top half of a 64-bit result, cleared by `put`
        }
        let (m, k) = src(e);
        (16 * m as u32 + k * eb + b % eb) as u8
    });
    put(c, rd, q, |c| {
        vreg(c, rn);
        vreg(c, rm);
        c.shuffle(lanes);
    });
    true
}

/// Pushes Vn's low (or, with `high`, top) `8 << size`-bit lanes widened to
/// twice that, sign- or (`u`) zero-extended.
fn widen(c: &mut Func, n: u32, size: usize, high: bool, u: bool) {
    vreg(c, n);
    c.simd(EXTEND[u as usize][high as usize][size]);
}

/// Narrows what `value` pushes (lanes of 2 × `8 << size` bits) to their low
/// halves: into Vd's low half, the top cleared, or with `q` (the "2" forms)
/// into its top half, the low half kept (`interp::simd_int::write_narrow`).
fn narrow(c: &mut Func, rd: u32, q: bool, size: usize, value: impl FnOnce(&mut Func)) {
    let eb = 1u8 << size;
    let low: [u8; 8] = core::array::from_fn(|b| (b as u8 / eb) * 2 * eb + b as u8 % eb);
    put(c, rd, true, |c| {
        value(c);
        if q {
            vreg(c, rd);
            // Vd's low 8 bytes (16–23), then the narrowed ones.
            c.shuffle(core::array::from_fn(|b| {
                if b < 8 { 16 + b as u8 } else { low[b - 8] }
            }));
        } else {
            c.v128_const(0);
            c.shuffle(core::array::from_fn(|b| if b < 8 { low[b] } else { 16 }));
        }
    });
}

/// Three-different long and wide forms, vector: ADDL/ADDW/SUBL/SUBW,
/// MULL/MLAL/MLSL, signed and unsigned (`interp::simd_int::three_diff`).
fn three_diff(c: &mut Func, i: u32) -> bool {
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let (q, u, size, opc) = (
        bit(i, 30),
        bit(i, 29),
        bits(i, 23, 22) as usize,
        bits(i, 15, 12),
    );
    if bit(i, 28) || size == 3 || !matches!(opc, 0b0000..=0b0011 | 0b1000 | 0b1010 | 0b1100) {
        return false;
    }
    let w = size + 1;
    put(c, rd, true, |c| match opc {
        0b1000 | 0b1010 | 0b1100 => {
            if opc != 0b1100 {
                vreg(c, rd);
            }
            vreg(c, rn);
            vreg(c, rm);
            c.simd(EXTMUL[u as usize][q as usize][size]);
            if opc != 0b1100 {
                c.simd(if opc == 0b1000 { ADD[w] } else { SUB[w] });
            }
        }
        _ => {
            // …W: the first operand is wide already.
            if opc & 1 == 1 {
                vreg(c, rn);
            } else {
                widen(c, rn, size, q, u);
            }
            widen(c, rm, size, q, u);
            c.simd(if opc & 2 == 0 { ADD[w] } else { SUB[w] });
        }
    });
    true
}

/// Across lanes: ADDV, SMAXV/UMAXV, SMINV/UMINV, SADDLV/UADDLV
/// (`interp::simd_int::across`), as a tree of shuffles.
fn across(c: &mut Func, i: u32) -> bool {
    let (rd, rn) = (bits(i, 4, 0), bits(i, 9, 5));
    let (q, u, size, opc) = (
        bit(i, 30),
        bit(i, 29),
        bits(i, 23, 22) as usize,
        bits(i, 16, 12),
    );
    if size == 3 || (size == 2 && !q) {
        return false;
    }
    let long = opc == 0b00011;
    let rs = if long { size + 1 } else { size };
    let f = match opc {
        0b01010 if u => MAX_U[rs],
        0b01010 => MAX_S[rs],
        0b11010 if u => MIN_U[rs],
        0b11010 => MIN_S[rs],
        _ => ADD[rs],
    };
    put(c, rd, true, |c| {
        // The lanes, 16 bytes of them: widened for the long forms; a 64-bit
        // vector's high half zero for sums, its low half again for min and max.
        match (long, q) {
            (true, true) => {
                widen(c, rn, size, false, u);
                widen(c, rn, size, true, u);
                c.simd(ADD[rs]);
            }
            (true, false) => widen(c, rn, size, false, u),
            (false, true) => vreg(c, rn),
            (false, false) if f == ADD[rs] => {
                vreg(c, rn);
                c.v128_const(u64::MAX as u128).simd(AND);
            }
            (false, false) => {
                vreg(c, rn);
                vreg(c, rn);
                c.shuffle(core::array::from_fn(|b| b as u8 % 8));
            }
        }
        let eb = 1u8 << rs;
        let mut step = 8;
        while step >= eb {
            c.local_tee(VTMP).local_get(VTMP).local_get(VTMP);
            c.shuffle(core::array::from_fn(|b| (b as u8 + step) % 16));
            c.simd(f);
            step /= 2;
        }
        c.v128_const(u128::MAX >> (128 - 8 * eb as u32)).simd(AND);
    });
    true
}

/// TBL/TBX with 1–4 table registers (`interp::simd_int::table`): swizzle
/// gives 0 for indices past 15, so each register's lookup takes the indices
/// less 16 × its place, and the lookups are ORed.
fn table(c: &mut Func, i: u32) -> bool {
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let (q, regs, tbx) = (bit(i, 30), bits(i, 14, 13) + 1, bit(i, 12));
    put(c, rd, q, |c| {
        for k in 0..regs {
            vreg(c, (rn + k) % 32);
            vreg(c, rm);
            if k > 0 {
                c.v128_const(lanes_of(16 * k as u64, 8)).simd(SUB[0]);
            }
            c.simd(SWIZZLE);
            if k > 0 {
                c.simd(OR);
            }
        }
        // TBX: Vd's bytes where the index is out of range.
        if tbx {
            vreg(c, rd);
            vreg(c, rm);
            c.v128_const(lanes_of(16 * regs as u64, 8))
                .simd(LT_U8)
                .simd(BITSELECT);
        }
    });
    true
}

/// EXT: bytes `pos` on of Vm:Vn (`interp::simd_int::ext`).
fn ext(c: &mut Func, i: u32) -> bool {
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let (q, pos) = (bit(i, 30), bits(i, 14, 11) as u8);
    if !q && pos >= 8 {
        return false;
    }
    put(c, rd, q, |c| {
        vreg(c, rn);
        vreg(c, rm);
        c.shuffle(core::array::from_fn(|b| {
            let k = pos + b as u8;
            match (q, k) {
                (true, _) => k,
                // 64-bit: Vn's low 8 bytes, then Vm's.
                (false, 0..8) => k,
                (false, _) => 16 + (k - 8) % 8,
            }
        }));
    });
    true
}

/// Element size (log2 bytes) and index from imm5 (`interp::simd::imm5`).
fn imm5(i: u32) -> Option<(usize, u8)> {
    let imm5 = bits(i, 20, 16);
    let size = imm5.trailing_zeros();
    (size <= 3).then_some((size as usize, (imm5 >> (size + 1)) as u8))
}

/// DUP, INS, UMOV/SMOV, MOVI & co, FMOV (`interp::simd::exec`).
fn moves(c: &mut Func, i: u32, op: Op) -> bool {
    use Op::*;
    let (rd, rn) = (bits(i, 4, 0), bits(i, 9, 5));
    let q = bit(i, 30);
    // Bytes of lane `index` of `esize` bits, repeated in every lane.
    let dup = |size: usize, index: u8| -> [u8; 16] {
        let eb = 1u8 << size;
        core::array::from_fn(|b| index * eb + b as u8 % eb)
    };
    match op {
        DUP_elt_1 | DUP_elt_2 => {
            let Some((size, index)) = imm5(i) else {
                return false;
            };
            if op == DUP_elt_2 && size == 3 && !q {
                return false;
            }
            // The scalar form of a single or double (`mov d0, v1.d[1]`, a
            // reduction's): the lane into Vd's shadow, one lane op, where a
            // scalar reader takes it with none (docs/jit.md "Scalar shadows").
            if op == DUP_elt_1 && size >= 2 {
                let esize = 8 << size;
                c.vset_f(rd, esize, |c| {
                    c.vget(rn);
                    // f64x2/f32x4.extract_lane
                    c.simd_lane(if esize == 64 { 0x21 } else { 0x1f }, index);
                });
                return true;
            }
            // The scalar form (DUP_elt_1) keeps the element alone.
            let (s, keep) = (
                dup(size, index),
                if op == DUP_elt_1 { 1 << size } else { 16 },
            );
            put(c, rd, op == DUP_elt_1 || q, |c| {
                vreg(c, rn);
                c.v128_const(0);
                c.shuffle(core::array::from_fn(|b| if b < keep { s[b] } else { 16 }));
            });
        }
        DUP_gen => {
            let Some((size, _)) = imm5(i) else {
                return false;
            };
            if size == 3 && !q {
                return false;
            }
            put(c, rd, q, |c| {
                get(c, size == 3, rn);
                c.simd(SPLAT[size]);
            });
        }
        INS_gen => {
            let Some((size, index)) = imm5(i) else {
                return false;
            };
            put(c, rd, true, |c| {
                vreg(c, rd);
                get(c, size == 3, rn);
                c.simd_lane(REPLACE[size], index);
            });
        }
        INS_elt => {
            let Some((size, dst)) = imm5(i) else {
                return false;
            };
            let src = (bits(i, 14, 11) >> size) as u8;
            put(c, rd, true, |c| {
                vreg(c, rd);
                vreg(c, rn);
                c.simd_lane(EXTRACT_U[size], src)
                    .simd_lane(REPLACE[size], dst);
            });
        }
        SMOV | UMOV => {
            let Some((size, index)) = imm5(i) else {
                return false;
            };
            let ok = match (op, q) {
                (SMOV, false) => size < 2,
                (SMOV, true) => size < 3,
                (_, false) => size < 3,
                (_, true) => size == 3,
            };
            if !ok {
                return false;
            }
            set(c, q, rd, |c| {
                vreg(c, rn);
                if op == SMOV {
                    c.simd_lane(EXTRACT_S[size], index);
                    if q {
                        c.op(0xac); // i64.extend_i32_s
                    }
                } else {
                    c.simd_lane(EXTRACT_U[size], index);
                }
            });
        }
        MOVI | FMOV_2 => {
            let (op1, cmode) = (bit(i, 29), bits(i, 15, 12));
            let imm8 = bits(i, 18, 16) << 5 | bits(i, 9, 5);
            let Ok(imm) = adv_simd_expand_imm(op1, cmode, imm8, q) else {
                return false;
            };
            let imm = imm as u128 | (imm as u128) << 64;
            // cmode 0xx1 and 10x1 are ORR (op 0) and BIC (op 1); the rest MOVI/MVNI/FMOV.
            let logical = cmode & 1 == 1 && cmode < 12;
            put(c, rd, q, |c| match (logical, op1) {
                (true, false) => {
                    vreg(c, rd);
                    c.v128_const(imm).simd(OR);
                }
                (true, true) => {
                    vreg(c, rd);
                    c.v128_const(!imm).simd(AND);
                }
                (false, true) if cmode < 14 => {
                    c.v128_const(!imm);
                }
                _ => {
                    c.v128_const(imm);
                }
            });
        }
        FMOV_float_gen => {
            // sf (31), ftype (23:22), rmode (20:19), opcode<0> (16): 1 is to the vector register.
            let (sf, ftype, rmode, to_v) =
                (bit(i, 31), bits(i, 23, 22), bits(i, 20, 19), bit(i, 16));
            match (sf, ftype, rmode, to_v) {
                (false, 0, 0, true) | (true, 1, 0, true) => put(c, rd, true, |c| {
                    c.v128_const(0);
                    get(c, sf, rn);
                    if !sf {
                        c.op(0xad); // i64.extend_i32_u
                    }
                    c.simd_lane(REPLACE[3], 0);
                }),
                (false, 0, 0, false) => set(c, false, rd, |c| {
                    vreg(c, rn);
                    c.simd_lane(EXTRACT_U[2], 0);
                }),
                (true, 1, 0, false) | (true, 2, 1, false) => set(c, true, rd, |c| {
                    vreg(c, rn);
                    c.simd_lane(EXTRACT_U[3], (ftype == 2) as u8);
                }),
                (true, 2, 1, true) => put(c, rd, true, |c| {
                    vreg(c, rd);
                    get(c, true, rn);
                    c.simd_lane(REPLACE[3], 1);
                }),
                // Half precision needs FEAT_FP16, which we don't advertise.
                _ => return false,
            }
        }
        FMOV_float => {
            let w = match bits(i, 23, 22) {
                0 => 32,
                1 => 64,
                _ => return false,
            };
            put(c, rd, true, |c| {
                vreg(c, rn);
                c.v128_const(u128::MAX >> (128 - w)).simd(AND);
            });
        }
        FMOV_float_imm => {
            let n = match bits(i, 23, 22) {
                0 => 32,
                1 => 64,
                _ => return false,
            };
            let v = vfp_expand_imm(bits(i, 20, 13), n) as u128;
            put(c, rd, true, |c| {
                c.v128_const(v);
            });
        }
        _ => return false,
    }
    true
}
