//! AdvSIMD integer instructions, vector and scalar: three same, three
//! different, two-register misc, across lanes, shift by immediate, by element,
//! permutes, EXT and table lookups.
//!
//! Each encoding group is decoded from its fields (U 29, size 23:22, opcode);
//! the decoder has already classified the word, so only the field checks that
//! make an encoding reserved happen here. Lane values are computed as `i128`,
//! which holds every intermediate (sums, doubled products, shifted values)
//! without overflow before saturation.

use super::simd::{elem, set_elem};
use super::{Exit, R, bit, bits};
use crate::cpu::Cpu;
use crate::decode::Op;

const QC: u64 = 1 << 27;

#[inline]
fn ones(esize: u32) -> u64 {
    u64::MAX >> (64 - esize)
}

/// Lane value as an integer: zero- or sign-extended from `esize` bits.
#[inline]
fn int(x: u64, esize: u32, unsigned: bool) -> i128 {
    if unsigned {
        x as i128
    } else {
        ((x << (64 - esize)) as i64 >> (64 - esize)) as i128
    }
}

/// SatQ: `x` clamped to the signed or unsigned `esize`-bit range, and whether it saturated.
fn sat(x: i128, esize: u32, unsigned: bool) -> (u64, bool) {
    let (lo, hi) = if unsigned {
        (0, (1i128 << esize) - 1)
    } else {
        (-(1i128 << (esize - 1)), (1i128 << (esize - 1)) - 1)
    };
    let y = x.clamp(lo, hi);
    (y as u64 & ones(esize), y != x)
}

/// `x` shifted left by `s` (right if negative, rounding if asked), for the
/// shift-by-register and shift-by-immediate forms. Large shifts are clamped to
/// amounts with the same result.
fn shift(x: i128, s: i32, esize: u32, round: bool) -> i128 {
    if s >= esize as i32 {
        // Every bit leaves the lane; only the sign matters to saturation.
        x.signum() << 100
    } else if s >= 0 {
        x << s
    } else {
        let r = (-s).min(66) as u32;
        let rc = if round { 1i128 << (r - 1) } else { 0 };
        (x + rc) >> r
    }
}

/// Results of a lane loop: the value and whether any lane saturated (FPSR.QC).
struct Out {
    v: u128,
    sat: bool,
}

impl Out {
    fn new() -> Out {
        Out { v: 0, sat: false }
    }
    fn set(&mut self, e: u32, esize: u32, x: u64) {
        self.v = set_elem(self.v, e, esize, x);
    }
    fn set_sat(&mut self, e: u32, esize: u32, (x, s): (u64, bool)) {
        self.set(e, esize, x);
        self.sat |= s;
    }
}

/// Writes a result: 64-bit (`!q`) results clear the top half; sets FPSR.QC on saturation.
fn write(c: &mut Cpu, rd: usize, o: Out, q: bool) {
    c.v[rd] = if q { o.v } else { o.v as u64 as u128 };
    if o.sat {
        c.fpsr |= QC;
    }
}

/// Writes a narrowed 64-bit result: to the low half (clearing the top), or with
/// Q (the "2" forms) to the top half, keeping the low half.
fn write_narrow(c: &mut Cpu, rd: usize, o: Out, q: bool) {
    c.v[rd] = if q {
        (c.v[rd] as u64 as u128) | o.v << 64
    } else {
        o.v as u64 as u128
    };
    if o.sat {
        c.fpsr |= QC;
    }
}

/// Undefined unless `ok`.
#[inline]
fn need(ok: bool) -> R {
    if ok { Ok(()) } else { Err(Exit::Undefined) }
}

/// The handler for an integer AdvSIMD class, if `op` is one.
pub(super) fn handler(op: Op) -> Option<fn(&mut Cpu, u32) -> R> {
    use Op::*;
    Some(match op {
        SHADD | SQADD_2 | SRHADD | SHSUB | SQSUB_2 | CMGT_reg_2 | CMGE_reg_2 | SSHL_2
        | SQSHL_reg_2 | SRSHL_2 | SQRSHL_2 | SMAX | SMIN | SABD | SABA | ADD_vector | CMTST_2
        | MLA_vec | MUL_vec | SMAXP | SMINP | SQDMULH_vec_2 | ADDP_vec | AND_asimd
        | BIC_asimd_reg | ORR_asimd_reg | ORN_asimd | UHADD | UQADD_2 | URHADD | UHSUB
        | UQSUB_2 | CMHI_2 | CMHS_2 | USHL_2 | UQSHL_reg_2 | URSHL_2 | UQRSHL_2 | UMAX | UMIN
        | UABD | UABA | SUB_2 | CMEQ_reg_2 | MLS_vec | PMUL | UMAXP | UMINP | SQRDMULH_vec_2
        | EOR_asimd | BSL | BIT | BIF | SQADD_1 | SQSUB_1 | CMGT_reg_1 | CMGE_reg_1 | SSHL_1
        | SQSHL_reg_1 | SRSHL_1 | SQRSHL_1 | ADD_1 | CMTST_1 | SQDMULH_vec_1 | UQADD_1
        | UQSUB_1 | CMHI_1 | CMHS_1 | USHL_1 | UQSHL_reg_1 | URSHL_1 | UQRSHL_1 | SUB_1
        | CMEQ_reg_1 | SQRDMULH_vec_1 => three_same,
        SADDL | SADDW | SSUBL | SSUBW | ADDHN | SABAL | SUBHN | SABDL | SMLAL_vec | SMLSL_vec
        | SMULL_vec | PMULL | UADDL | UADDW | USUBL | USUBW | RADDHN | UABAL | RSUBHN | UABDL
        | UMLAL_vec | UMLSL_vec | UMULL_vec | SQDMLAL_vec_2 | SQDMLSL_vec_2 | SQDMULL_vec_2
        | SQDMLAL_vec_1 | SQDMLSL_vec_1 | SQDMULL_vec_1 => three_diff,
        REV64_asimd | REV16_asimd | SADDLP | SUQADD_2 | CLS_asimd | CNT | SADALP | SQABS_2
        | CMGT_zero_2 | CMEQ_zero_2 | CMLT_2 | ABS_2 | XTN | SQXTN_2 | REV32_asimd | UADDLP
        | USQADD_2 | CLZ_asimd | UADALP | SQNEG_2 | CMGE_zero_2 | CMLE_2 | NEG_2 | SQXTUN_2
        | SHLL | UQXTN_2 | NOT | RBIT_asimd | SUQADD_1 | SQABS_1 | CMGT_zero_1 | CMEQ_zero_1
        | CMLT_1 | ABS_1 | SQXTN_1 | USQADD_1 | SQNEG_1 | CMGE_zero_1 | CMLE_1 | NEG_1
        | SQXTUN_1 | UQXTN_1 => two_misc,
        SADDLV | SMAXV | SMINV | ADDV | UADDLV | UMAXV | UMINV => across,
        ADDP_pair => addp_scalar,
        SSHR_2 | SSRA_2 | SRSHR_2 | SRSRA_2 | SHL_2 | SQSHL_imm_2 | SHRN | RSHRN | SQSHRN_2
        | SQRSHRN_2 | SSHLL | USHR_2 | USRA_2 | URSHR_2 | URSRA_2 | SRI_2 | SLI_2 | SQSHLU_2
        | UQSHL_imm_2 | SQSHRUN_2 | SQRSHRUN_2 | UQSHRN_2 | UQRSHRN_2 | USHLL | SSHR_1 | SSRA_1
        | SRSHR_1 | SRSRA_1 | SHL_1 | SQSHL_imm_1 | SQSHRN_1 | SQRSHRN_1 | USHR_1 | USRA_1
        | URSHR_1 | URSRA_1 | SRI_1 | SLI_1 | SQSHLU_1 | UQSHL_imm_1 | SQSHRUN_1 | SQRSHRUN_1
        | UQSHRN_1 | UQRSHRN_1 => shift_imm,
        SMLAL_elt | SQDMLAL_elt_2 | SMLSL_elt | SQDMLSL_elt_2 | MUL_elt | SMULL_elt
        | SQDMULL_elt_2 | SQDMULH_elt_2 | SQRDMULH_elt_2 | MLA_elt | UMLAL_elt | MLS_elt
        | UMLSL_elt | UMULL_elt | SQDMLAL_elt_1 | SQDMLSL_elt_1 | SQDMULL_elt_1 | SQDMULH_elt_1
        | SQRDMULH_elt_1 => by_element,
        UZP1 | TRN1 | ZIP1 | UZP2 | TRN2 | ZIP2 => permute,
        EXT => ext,
        TBL | TBX => table,
        _ => return None,
    })
}

/// Common fields: rd, rn, rm, Q, U, size, scalar (bit 28).
fn fields(i: u32) -> (usize, usize, usize, bool, bool, u32, bool) {
    (
        bits(i, 4, 0) as usize,
        bits(i, 9, 5) as usize,
        bits(i, 20, 16) as usize,
        bit(i, 30),
        bit(i, 29),
        bits(i, 23, 22),
        bit(i, 28),
    )
}

/// Lanes in a `q`-sized vector, or 1 for a scalar.
fn lanes(q: bool, esize: u32, scalar: bool) -> u32 {
    if scalar {
        1
    } else if q {
        128 / esize
    } else {
        64 / esize
    }
}

fn three_same(c: &mut Cpu, i: u32) -> R {
    let (rd, rn, rm, q, u, size, scalar) = fields(i);
    let opc = bits(i, 15, 11);
    if opc == 0b00011 {
        // Logical: size picks AND/BIC/ORR/ORN (U=0) or EOR/BSL/BIT/BIF (U=1).
        let (a, b, d) = (c.v[rn], c.v[rm], c.v[rd]);
        let v = match (u, size) {
            (false, 0) => a & b,
            (false, 1) => a & !b,
            (false, 2) => a | b,
            (false, _) => a | !b,
            (true, 0) => a ^ b,
            (true, 1) => (d & a) | (!d & b),
            (true, 2) => (d & !b) | (a & b),
            (true, _) => (d & b) | (a & !b),
        };
        c.v[rd] = if q { v } else { v as u64 as u128 };
        return Ok(());
    }
    let q128 = !(size == 3 && !q);
    need(if scalar {
        match opc {
            0b00001 | 0b00101 | 0b01001 | 0b01011 => true,
            0b10110 => size == 1 || size == 2,
            _ => size == 3,
        }
    } else {
        match opc {
            0b10011 if u => size == 0,
            0b10110 => size == 1 || size == 2,
            0b00000
            | 0b00010
            | 0b00100
            | 0b01100..=0b01111
            | 0b10010
            | 0b10011
            | 0b10100
            | 0b10101 => size != 3,
            _ => q128,
        }
    })?;
    same(c, rd, c.v[rn], c.v[rm], q, u, size, opc, scalar);
    Ok(())
}

/// Three-same arithmetic on lanes of `a` and `b` (also used by the by-element forms).
#[allow(clippy::too_many_arguments)]
fn same(
    c: &mut Cpu,
    rd: usize,
    a: u128,
    b: u128,
    q: bool,
    u: bool,
    size: u32,
    opc: u32,
    scalar: bool,
) {
    let esize = 8 << size;
    let n = lanes(q, esize, scalar);
    let d = c.v[rd];
    let mask = |t: bool| if t { ones(esize) } else { 0 };
    let mut o = Out::new();
    for e in 0..n {
        let (x, y) = if matches!(opc, 0b10100 | 0b10101 | 0b10111) {
            // Pairwise: lanes of the concatenation b:a, two at a time.
            let src = if 2 * e < n { a } else { b };
            let k = (2 * e) % n;
            (elem(src, k, esize), elem(src, k + 1, esize))
        } else {
            (elem(a, e, esize), elem(b, e, esize))
        };
        let (sx, sy) = (int(x, esize, u), int(y, esize, u));
        let de = elem(d, e, esize);
        match opc {
            0b00000 => o.set(e, esize, ((sx + sy) >> 1) as u64),
            0b00001 => o.set_sat(e, esize, sat(sx + sy, esize, u)),
            0b00010 => o.set(e, esize, ((sx + sy + 1) >> 1) as u64),
            0b00100 => o.set(e, esize, ((sx - sy) >> 1) as u64),
            0b00101 => o.set_sat(e, esize, sat(sx - sy, esize, u)),
            0b00110 => o.set(e, esize, mask(sx > sy)),
            0b00111 => o.set(e, esize, mask(sx >= sy)),
            0b01000..=0b01011 => {
                // SSHL/SQSHL/SRSHL/SQRSHL: the shift is the signed low byte of y.
                let v = shift(sx, y as i8 as i32, esize, opc & 2 != 0);
                if opc & 1 == 1 {
                    o.set_sat(e, esize, sat(v, esize, u));
                } else {
                    o.set(e, esize, v as u64);
                }
            }
            0b01100 | 0b10100 => o.set(e, esize, sx.max(sy) as u64),
            0b01101 | 0b10101 => o.set(e, esize, sx.min(sy) as u64),
            0b01110 => o.set(e, esize, (sx - sy).unsigned_abs() as u64),
            0b01111 => o.set(e, esize, de.wrapping_add((sx - sy).unsigned_abs() as u64)),
            0b10000 if u => o.set(e, esize, x.wrapping_sub(y)),
            0b10000 => o.set(e, esize, x.wrapping_add(y)),
            0b10001 if u => o.set(e, esize, mask(x == y)),
            0b10001 => o.set(e, esize, mask(x & y != 0)),
            0b10010 if u => o.set(e, esize, de.wrapping_sub(x.wrapping_mul(y))),
            0b10010 => o.set(e, esize, de.wrapping_add(x.wrapping_mul(y))),
            0b10011 if u => o.set(e, esize, crate::crypto::clmul8(x, y)),
            0b10011 => o.set(e, esize, x.wrapping_mul(y)),
            0b10110 => {
                // SQDMULH / SQRDMULH (U): high half of the doubled product.
                let (sx, sy) = (int(x, esize, false), int(y, esize, false));
                let rc = if u { 1i128 << (esize - 1) } else { 0 };
                o.set_sat(e, esize, sat((2 * sx * sy + rc) >> esize, esize, false));
            }
            _ => o.set(e, esize, x.wrapping_add(y)), // ADDP (0b10111)
        }
    }
    write(c, rd, o, q || scalar);
}

pub(super) fn three_diff(c: &mut Cpu, i: u32) -> R {
    let (rd, rn, rm, q, u, size, scalar) = fields(i);
    let opc = bits(i, 15, 12);
    need(match opc {
        // PMULL with size 3 is FEAT_PMULL's 64×64 → 128-bit product (M6.5).
        0b1110 => size == 0 || size == 3,
        0b1001 | 0b1011 | 0b1101 => size == 1 || size == 2,
        _ => size != 3,
    })?;
    if size == 3 {
        let half = |v: u128| (if q { v >> 64 } else { v }) as u64;
        c.v[rd] = crate::crypto::clmul64(half(c.v[rn]), half(c.v[rm]));
        return Ok(());
    }
    diff(c, rd, c.v[rn], c.v[rm], q, u, size, opc, scalar);
    Ok(())
}

/// Three-different arithmetic: long (2×esize results) and narrowing (…HN) forms.
#[allow(clippy::too_many_arguments)]
fn diff(
    c: &mut Cpu,
    rd: usize,
    a: u128,
    b: u128,
    q: bool,
    u: bool,
    size: u32,
    opc: u32,
    scalar: bool,
) {
    let esize = 8 << size;
    let w = 2 * esize;
    let n = if scalar { 1 } else { 64 / esize };
    let half = |v: u128| if q && !scalar { v >> 64 } else { v };
    let d = c.v[rd];
    let mut o = Out::new();
    if opc == 0b0100 || opc == 0b0110 {
        // ADDHN/SUBHN, RADDHN/RSUBHN (U): the high half of each wide sum.
        for e in 0..n {
            let (x, y) = (elem(a, e, w) as u128, elem(b, e, w) as u128);
            let s = if opc == 0b0100 {
                x + y
            } else {
                x.wrapping_sub(y)
            };
            let rc = if u { 1u128 << (esize - 1) } else { 0 };
            o.set(e, esize, (s.wrapping_add(rc) >> esize) as u64);
        }
        write_narrow(c, rd, o, q);
        return;
    }
    for e in 0..n {
        let x = if opc == 0b0001 || opc == 0b0011 {
            int(elem(a, e, w), w, u) // …W: the first operand is already wide
        } else {
            int(elem(half(a), e, esize), esize, u)
        };
        let xn = elem(half(a), e, esize);
        let y = int(elem(half(b), e, esize), esize, u);
        let de = elem(d, e, w);
        let dx = int(de, w, false);
        let v = match opc {
            0b0000 | 0b0001 => x + y,
            0b0010 | 0b0011 => x - y,
            0b0101 => de as i128 + (x - y).abs(),
            0b0111 => (x - y).abs(),
            0b1000 => de as i128 + x * y,
            0b1010 => de as i128 - x * y,
            0b1100 => x * y,
            0b1110 => crate::crypto::clmul8(xn, elem(half(b), e, esize)) as i128,
            _ => {
                // SQDMLAL / SQDMLSL / SQDMULL: saturate the doubled product, then the sum.
                let (p, s1) = sat(2 * x * y, w, false);
                let p = int(p, w, false);
                let (r, s2) = match opc {
                    0b1001 => sat(dx + p, w, false),
                    0b1011 => sat(dx - p, w, false),
                    _ => (p as u64 & ones(w), false),
                };
                o.set_sat(e, w, (r, s1 || s2));
                continue;
            }
        };
        o.set(e, w, v as u64);
    }
    write(c, rd, o, true);
}

fn two_misc(c: &mut Cpu, i: u32) -> R {
    let (rd, rn, _, q, u, size, scalar) = fields(i);
    let opc = bits(i, 16, 12);
    let q128 = !(size == 3 && !q);
    need(if scalar {
        match opc {
            0b01000..=0b01011 => size == 3,
            0b10010 | 0b10100 => size != 3,
            _ => true, // SUQADD, USQADD, SQABS, SQNEG
        }
    } else {
        match (opc, u) {
            (0b00000, false) => size != 3, // REV64
            (0b00001, false) => size == 0, // REV16
            (0b00000, true) => size < 2,   // REV32
            (0b00101, false) => size == 0, // CNT
            (0b00101, true) => size < 2,   // NOT, RBIT
            (0b00010 | 0b00110 | 0b00100 | 0b10010..=0b10100, _) => size != 3,
            _ => q128,
        }
    })?;
    let esize = 8 << size;
    let n = lanes(q, esize, scalar);
    let (a, d) = (c.v[rn], c.v[rd]);
    let mut o = Out::new();
    match opc {
        0b00000 | 0b00001 => {
            // REV64/REV32/REV16: reverse the esize lanes within each container.
            let cont = match (opc, u) {
                (0, false) => 64,
                (0, true) => 32,
                _ => 16,
            };
            let per = cont / esize;
            for e in 0..n {
                let src = e - e % per + (per - 1 - e % per);
                o.set(e, esize, elem(a, src, esize));
            }
            write(c, rd, o, q);
        }
        0b00010 | 0b00110 => {
            // SADDLP/UADDLP, SADALP/UADALP: pairwise add long (and accumulate).
            let w = 2 * esize;
            for e in 0..n / 2 {
                let s =
                    int(elem(a, 2 * e, esize), esize, u) + int(elem(a, 2 * e + 1, esize), esize, u);
                let acc = if opc == 0b00110 { elem(d, e, w) } else { 0 };
                o.set(e, w, acc.wrapping_add(s as u64));
            }
            write(c, rd, o, q);
        }
        0b00100 => {
            for e in 0..n {
                let x = elem(a, e, esize);
                // CLZ (U), or CLS: sign-extended to 64 bits, bit k of s ^ (s << 1) says
                // whether bits k and k-1 differ.
                let s = if u { x } else { int(x, esize, false) as u64 };
                let r = if u {
                    s.leading_zeros()
                } else {
                    ((s ^ (s << 1)) | 1).leading_zeros()
                } - (64 - esize);
                o.set(e, esize, r as u64);
            }
            write(c, rd, o, q);
        }
        0b00101 => {
            // CNT, NOT, RBIT: bytes, whatever the size field (it tells NOT from RBIT).
            for e in 0..lanes(q, 8, false) {
                let x = elem(a, e, 8) as u8;
                let r = match (u, size) {
                    (false, _) => x.count_ones() as u8,
                    (true, 0) => !x,
                    _ => x.reverse_bits(),
                };
                o.set(e, 8, r as u64);
            }
            write(c, rd, o, q);
        }
        0b00011 | 0b00111 | 0b01011 => {
            for e in 0..n {
                let x = elem(a, e, esize);
                let r = match (opc, u) {
                    // SUQADD: signed accumulator + unsigned operand; USQADD the reverse.
                    (0b00011, false) => sat(
                        int(elem(d, e, esize), esize, false) + int(x, esize, true),
                        esize,
                        false,
                    ),
                    (0b00011, true) => sat(
                        int(elem(d, e, esize), esize, true) + int(x, esize, false),
                        esize,
                        true,
                    ),
                    (0b00111, false) => sat(int(x, esize, false).abs(), esize, false),
                    (0b00111, true) => sat(-int(x, esize, false), esize, false),
                    (_, false) => (
                        int(x, esize, false).unsigned_abs() as u64 & ones(esize),
                        false,
                    ),
                    (_, true) => (x.wrapping_neg() & ones(esize), false),
                };
                o.set_sat(e, esize, r);
            }
            write(c, rd, o, q || scalar);
        }
        0b01000..=0b01010 => {
            // CMGT/CMGE (U), CMEQ/CMLE (U), CMLT against zero.
            for e in 0..n {
                let x = int(elem(a, e, esize), esize, false);
                let t = match (opc, u) {
                    (0b01000, false) => x > 0,
                    (0b01000, true) => x >= 0,
                    (0b01001, false) => x == 0,
                    (0b01001, true) => x <= 0,
                    _ => x < 0,
                };
                o.set(e, esize, if t { ones(esize) } else { 0 });
            }
            write(c, rd, o, q || scalar);
        }
        0b10011 => {
            // SHLL: widen and shift left by esize.
            let half = if q { a >> 64 } else { a };
            for e in 0..64 / esize {
                o.set(e, 2 * esize, elem(half, e, esize) << esize);
            }
            write(c, rd, o, true);
        }
        _ => {
            // XTN, SQXTN/UQXTN (10100), SQXTUN (10010, U): narrow from 2×esize.
            let w = 2 * esize;
            let n = if scalar { 1 } else { 64 / esize };
            for e in 0..n {
                let x = elem(a, e, w);
                let r = match (opc, u) {
                    (0b10010, false) => (x & ones(esize), false),
                    (0b10010, true) => sat(int(x, w, false), esize, true),
                    (_, false) => sat(int(x, w, false), esize, false),
                    (_, true) => sat(x as i128, esize, true),
                };
                o.set_sat(e, esize, r);
            }
            if scalar {
                write(c, rd, o, true);
            } else {
                write_narrow(c, rd, o, q);
            }
        }
    }
    Ok(())
}

fn across(c: &mut Cpu, i: u32) -> R {
    let (rd, rn, _, q, u, size, _) = fields(i);
    need(size != 3 && !(size == 2 && !q))?;
    let esize = 8 << size;
    let a = c.v[rn];
    let xs = (0..lanes(q, esize, false)).map(|e| int(elem(a, e, esize), esize, u));
    let (v, w) = match bits(i, 16, 12) {
        0b00011 => (xs.sum::<i128>(), 2 * esize), // SADDLV/UADDLV
        0b01010 => (xs.max().unwrap(), esize),
        0b11010 => (xs.min().unwrap(), esize),
        _ => (xs.sum::<i128>(), esize), // ADDV
    };
    c.v[rd] = (v as u64 & ones(w)) as u128;
    Ok(())
}

fn addp_scalar(c: &mut Cpu, i: u32) -> R {
    let (rd, rn, ..) = fields(i);
    need(bits(i, 23, 22) == 3)?;
    let a = c.v[rn];
    c.v[rd] = (a as u64).wrapping_add((a >> 64) as u64) as u128;
    Ok(())
}

fn shift_imm(c: &mut Cpu, i: u32) -> R {
    let (rd, rn, _, q, u, _, scalar) = fields(i);
    let (immh, opc) = (bits(i, 22, 19), bits(i, 15, 11));
    let immhb = bits(i, 22, 16) as i32;
    need(immh != 0)?;
    let hsb = 31 - immh.leading_zeros();
    let esize = 8u32 << hsb;
    let (a, d) = (c.v[rn], c.v[rd]);
    let mut o = Out::new();
    if opc >= 0b10000 {
        // Narrowing (from 2×esize) and SSHLL/USHLL (to 2×esize): immh<3> is reserved.
        need(immh & 8 == 0)?;
        let w = 2 * esize;
        if opc == 0b10100 {
            need(!scalar)?;
            let half = if q { a >> 64 } else { a };
            for e in 0..64 / esize {
                let x = int(elem(half, e, esize), esize, u);
                o.set(e, w, (x << (immhb - esize as i32)) as u64);
            }
            write(c, rd, o, true);
            return Ok(());
        }
        let s = 2 * esize as i32 - immhb;
        let round = opc & 1 == 1;
        for e in 0..if scalar { 1 } else { 64 / esize } {
            let x = elem(a, e, w);
            let r = match (opc & !1, u) {
                (0b10000, false) => ((shift(x as i128, -s, w, round) as u64) & ones(esize), false),
                (0b10000, true) => sat(shift(int(x, w, false), -s, w, round), esize, true), // SQ(R)SHRUN
                (_, u) => sat(shift(int(x, w, u), -s, w, round), esize, u), // SQ(R)SHRN, UQ(R)SHRN
            };
            o.set_sat(e, esize, r);
        }
        if scalar {
            write(c, rd, o, true);
        } else {
            write_narrow(c, rd, o, q);
        }
        return Ok(());
    }
    need(if scalar {
        matches!(opc, 0b01100 | 0b01110) || hsb == 3
    } else {
        !(hsb == 3 && !q)
    })?;
    let right = 2 * esize as i32 - immhb;
    let left = immhb - esize as i32;
    for e in 0..lanes(q, esize, scalar) {
        let x = elem(a, e, esize);
        let sx = int(x, esize, u);
        let de = elem(d, e, esize);
        match opc {
            0b00000..=0b00110 => {
                // SSHR, SSRA, SRSHR, SRSRA and the unsigned forms.
                let v = shift(sx, -right, esize, opc & 0b00100 != 0) as u64;
                let acc = if opc & 0b00010 != 0 { de } else { 0 };
                o.set(e, esize, acc.wrapping_add(v));
            }
            0b01000 => {
                // SRI: shifted-in bits keep the destination's top bits.
                let m = if right as u32 == esize {
                    0
                } else {
                    ones(esize) >> right
                };
                o.set(e, esize, (de & !m) | (x >> right.min(63)) & m);
            }
            0b01010 => {
                let v = x << left;
                let m = if u { ones(esize) << left } else { u64::MAX };
                o.set(e, esize, (de & !m) | (v & m)); // SHL, SLI (U)
            }
            0b01100 => o.set_sat(e, esize, sat(int(x, esize, false) << left, esize, true)), // SQSHLU
            _ => o.set_sat(e, esize, sat(sx << left, esize, u)), // SQSHL/UQSHL
        }
    }
    write(c, rd, o, q || scalar);
    Ok(())
}

fn by_element(c: &mut Cpu, i: u32) -> R {
    let (rd, rn, _, q, u, size, scalar) = fields(i);
    let (l, m, h) = (bit(i, 21) as u32, bit(i, 20) as u32, bit(i, 11) as u32);
    let (index, rm) = match size {
        1 => (h << 2 | l << 1 | m, bits(i, 19, 16) as usize),
        2 => (h << 1 | l, bits(i, 20, 16) as usize),
        _ => return Err(Exit::Undefined),
    };
    let esize = 8 << size;
    let y = elem(c.v[rm], index, esize);
    let b = (0..128 / esize).fold(0, |acc, e| set_elem(acc, e, esize, y));
    let a = c.v[rn];
    match (bits(i, 15, 12), u) {
        (0b1000, false) => same(c, rd, a, b, q, false, size, 0b10011, scalar), // MUL
        (0b0000, true) => same(c, rd, a, b, q, false, size, 0b10010, scalar),  // MLA
        (0b0100, true) => same(c, rd, a, b, q, true, size, 0b10010, scalar),   // MLS
        (0b1100, _) => same(c, rd, a, b, q, false, size, 0b10110, scalar),     // SQDMULH
        (0b1101, _) => same(c, rd, a, b, q, true, size, 0b10110, scalar),      // SQRDMULH
        // Long forms map onto the three-different opcodes.
        (opc, u) => {
            let dopc = match opc {
                0b0010 => 0b1000, // SMLAL/UMLAL
                0b0110 => 0b1010, // SMLSL/UMLSL
                0b1010 => 0b1100, // SMULL/UMULL
                0b0011 => 0b1001, // SQDMLAL
                0b0111 => 0b1011, // SQDMLSL
                _ => 0b1101,      // SQDMULL
            };
            diff(c, rd, a, b, q, u, size, dopc, scalar);
        }
    }
    Ok(())
}

/// FEAT_DotProd's SDOT and UDOT, vector and by element (the caller checks the
/// feature and the size): each 32-bit lane of Vd adds the four products of the
/// bytes it covers in Vn and in Vm, or in Vm's lane `index`, modulo 2^32.
pub(super) fn dot(c: &mut Cpu, i: u32) -> R {
    let (rd, rn, rm, q, u, _, _) = fields(i);
    let by_element = bit(i, 24);
    let index = (bit(i, 11) as u32) << 1 | bit(i, 21) as u32;
    let (a, b, d) = (c.v[rn], c.v[rm], c.v[rd]);
    let mut o = Out::new();
    for e in 0..lanes(q, 32, false) {
        let m = if by_element { index } else { e };
        let sum = (0..4).fold(elem(d, e, 32) as i128, |acc, k| {
            let x = int(elem(a, 4 * e + k, 8), 8, u);
            acc + x * int(elem(b, 4 * m + k, 8), 8, u)
        });
        o.set(e, 32, sum as u64 & ones(32));
    }
    write(c, rd, o, q);
    Ok(())
}

fn permute(c: &mut Cpu, i: u32) -> R {
    let (rd, rn, rm, q, _, size, _) = fields(i);
    need(!(size == 3 && !q))?;
    let esize = 8 << size;
    let n = lanes(q, esize, false);
    let (a, b) = (c.v[rn], c.v[rm]);
    let opc = bits(i, 14, 12);
    let part = opc >> 2;
    let mut o = Out::new();
    for e in 0..n {
        let x = match opc & 3 {
            // UZP: even (odd) lanes of b:a.
            1 => {
                let k = 2 * e + part;
                if k < n {
                    elem(a, k, esize)
                } else {
                    elem(b, k - n, esize)
                }
            }
            // TRN: lane pairs from a and b.
            2 => {
                let k = e - e % 2 + part;
                elem(if e % 2 == 0 { a } else { b }, k, esize)
            }
            // ZIP: interleave the low (high) halves.
            _ => elem(if e % 2 == 0 { a } else { b }, part * n / 2 + e / 2, esize),
        };
        o.set(e, esize, x);
    }
    write(c, rd, o, q);
    Ok(())
}

fn ext(c: &mut Cpu, i: u32) -> R {
    let (rd, rn, rm, q, ..) = fields(i);
    let pos = bits(i, 14, 11);
    need(q || pos < 8)?;
    let (a, b) = (c.v[rn], c.v[rm]);
    c.v[rd] = if pos == 0 {
        if q { a } else { a as u64 as u128 }
    } else if q {
        (a >> (8 * pos)) | (b << (128 - 8 * pos))
    } else {
        ((((b as u64 as u128) << 64) | a as u64 as u128) >> (8 * pos)) as u64 as u128
    };
    Ok(())
}

fn table(c: &mut Cpu, i: u32) -> R {
    let (rd, rn, rm, q, ..) = fields(i);
    let regs = bits(i, 14, 13) as usize + 1;
    let tbx = bit(i, 12);
    let idx = c.v[rm];
    let d = c.v[rd];
    let mut o = Out::new();
    for k in 0..if q { 16 } else { 8 } {
        let j = elem(idx, k, 8) as usize;
        let x = if j < 16 * regs {
            elem(c.v[(rn + j / 16) % 32], (j % 16) as u32, 8)
        } else if tbx {
            elem(d, k, 8)
        } else {
            0
        };
        o.set(k, 8, x);
    }
    write(c, rd, o, q);
    Ok(())
}
