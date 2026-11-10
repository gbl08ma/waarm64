//! AdvSIMD floating point, vector and scalar: three same, two-register misc
//! (including conversions, estimates and FCVTN/FCVTL/FCVTXN), pairwise, across
//! lanes, by element, and fixed-point conversions by immediate. Lanes are
//! single or double (sz, bit 22), or half precision: FEAT_FP16's encodings of
//! the same classes ([`fp16`]), UNDEFINED without it (interp.rs lists them).

use super::simd::{elem, set_elem};
use super::{Exit, R, bit, bits};
use crate::cpu::Cpu;
use crate::decode::Op;
use crate::fp::{self, D, Fmt, Fpu, H, Rounding, S};
use core::cmp::Ordering;

/// The handler for an AdvSIMD FP class, if `op` is one (inlined: `simd_int::handler`).
#[inline(always)]
pub(super) fn handler(op: Op) -> Option<fn(&mut Cpu, u32) -> R> {
    use Op::*;
    Some(match op {
        FMULX_vec_2 | FCMEQ_reg_2 | FRECPS_2 | FRSQRTS_2 | FCMGE_reg_2 | FACGE_2 | FABD_2
        | FCMGT_reg_2 | FACGT_2 | FMAXNM_2 | FMLA_vec_2 | FADD_2 | FMAX_2 | FMULX_vec_4
        | FCMEQ_reg_4 | FRECPS_4 | FMINNM_2 | FMLS_vec_2 | FSUB_2 | FMIN_2 | FRSQRTS_4
        | FMAXNMP_vec_2 | FADDP_vec_2 | FMUL_vec_2 | FCMGE_reg_4 | FACGE_4 | FMAXP_vec_2
        | FDIV_2 | FMINNMP_vec_2 | FABD_4 | FCMGT_reg_4 | FACGT_4 | FMINP_vec_2 => three_same,
        FCVTNS_2 | FCVTMS_2 | FCVTAS_2 | SCVTF_int_2 | FCMGT_zero_2 | FCMEQ_zero_2 | FCMLT_2
        | FCVTPS_2 | FCVTZS_int_2 | FRECPE_2 | FRECPX_2 | FCVTNU_2 | FCVTMU_2 | FCVTAU_2
        | UCVTF_int_2 | FCMGE_zero_2 | FCMLE_2 | FCVTPU_2 | FCVTZU_int_2 | FRSQRTE_2 | FRINTN_2
        | FRINTM_2 | FCVTNS_4 | FCVTMS_4 | FCVTAS_4 | SCVTF_int_4 | FCMGT_zero_4 | FCMEQ_zero_4
        | FCMLT_4 | FABS_2 | FRINTP_2 | FRINTZ_2 | FCVTPS_4 | FCVTZS_int_4 | URECPE | FRECPE_4
        | FRINTA_2 | FRINTX_2 | FCVTNU_4 | FCVTMU_4 | FCVTAU_4 | UCVTF_int_4 | FNEG_2
        | FRINTI_2 | FCMGE_zero_4 | FCMLE_4 | FCVTPU_4 | FCVTZU_int_4 | URSQRTE | FRSQRTE_4
        | FSQRT_2 => two_misc,
        FCVTN | FCVTL | FCVTXN_1 | FCVTXN_2 => convert,
        FMAXNMP_pair_2 | FADDP_pair_2 | FMAXP_pair_2 | FMINNMP_pair_2 | FMINP_pair_2 => pair,
        FMAXNMV_2 | FMAXV_2 | FMINNMV_2 | FMINV_2 => across,
        FMLA_elt_2 | FMLS_elt_2 | FMUL_elt_2 | FMULX_elt_2 | FMLA_elt_4 | FMLS_elt_4
        | FMUL_elt_4 | FMULX_elt_4 => by_element,
        SCVTF_fix_1 | FCVTZS_fix_1 | UCVTF_fix_1 | FCVTZU_fix_1 | SCVTF_fix_2 | FCVTZS_fix_2
        | UCVTF_fix_2 | FCVTZU_fix_2 => fixed,
        _ => return None,
    })
}

/// Lane format from sz (22).
fn fmt(i: u32) -> Fmt {
    if bit(i, 22) { D } else { S }
}

/// Whether the vCPU has FEAT_FP16 (its half-precision forms).
fn has_fp16(c: &Cpu) -> bool {
    c.features & crate::cpu::FEATURE_FP16 != 0
}

/// FEAT_FP16's AdvSIMD forms (the caller checks the feature): the v8.0
/// classes' rules on 16-bit lanes. Three same and two-register misc keep the
/// single and double forms' U, a and opcode (three same's 3-bit opcode is the
/// low bits of theirs, 11xxx); by element, the index is H:L:M and Vm 4 bits.
pub(super) fn fp16(c: &mut Cpu, i: u32, op: Op) -> R {
    use Op::*;
    match op {
        FMULX_vec_1 | FCMEQ_reg_1 | FRECPS_1 | FRSQRTS_1 | FCMGE_reg_1 | FACGE_1 | FABD_1
        | FCMGT_reg_1 | FACGT_1 | FMULX_vec_3 | FCMEQ_reg_3 | FRECPS_3 | FRSQRTS_3
        | FCMGE_reg_3 | FACGE_3 | FABD_3 | FCMGT_reg_3 | FACGT_3 | FMAXNM_1 | FMLA_vec_1
        | FADD_1 | FMAX_1 | FMINNM_1 | FMLS_vec_1 | FSUB_1 | FMIN_1 | FMAXNMP_vec_1
        | FADDP_vec_1 | FMUL_vec_1 | FMAXP_vec_1 | FDIV_1 | FMINNMP_vec_1 | FMINP_vec_1 => {
            three_same_f(c, i, H)
        }
        FMAXNMP_pair_1 | FADDP_pair_1 | FMAXP_pair_1 | FMINNMP_pair_1 | FMINP_pair_1 => {
            pair_f(c, i, H)
        }
        FMAXNMV_1 | FMAXV_1 | FMINNMV_1 | FMINV_1 => across_f(c, i, H),
        FMLA_elt_1 | FMLS_elt_1 | FMUL_elt_1 | FMULX_elt_1 | FMLA_elt_3 | FMLS_elt_3
        | FMUL_elt_3 | FMULX_elt_3 => by_element_f(c, i, H),
        FMOV_3 => {
            // FMOV (vector, immediate), half precision: a:b:c (18:16), d:e:f:g:h (9:5).
            let imm = super::simd::vfp_expand_imm(bits(i, 18, 16) << 5 | bits(i, 9, 5), 16);
            let v = (0..8).fold(0u128, |v, e| set_elem(v, e, 16, imm));
            c.v[bits(i, 4, 0) as usize] = if bit(i, 30) { v } else { v as u64 as u128 };
            Ok(())
        }
        _ => two_misc_f(c, i, H),
    }
}

/// Lanes for Q (or one for a scalar); a vector of doubles needs Q.
fn lanes(i: u32, f: Fmt) -> R<u32> {
    let (q, scalar) = (bit(i, 30), bit(i, 28));
    if scalar {
        Ok(1)
    } else if f == D && !q {
        Err(Exit::Undefined)
    } else {
        Ok(if q { 128 } else { 64 } / f.bits())
    }
}

fn regs(i: u32) -> (usize, usize, usize) {
    (
        bits(i, 4, 0) as usize,
        bits(i, 9, 5) as usize,
        bits(i, 20, 16) as usize,
    )
}

/// Writes lanes `v` (a 64-bit result clears the top half) and the flags.
fn finish(c: &mut Cpu, rd: usize, v: u128, bits: u32, fpu: Fpu) {
    // (Bits of 16, 32, 64 or 128: no u128 shift by a variable, a call in wasm.)
    c.v[rd] = match bits {
        128 => v,
        64 => v as u64 as u128,
        _ => (v as u64 & (u64::MAX >> (64 - bits))) as u128,
    };
    c.fpsr |= fpu.flags;
}

fn all_ones(f: Fmt, t: bool) -> u64 {
    if t { u64::MAX >> (64 - f.bits()) } else { 0 }
}

fn abs(f: Fmt, x: u64) -> u64 {
    x & !f.zero(true)
}

/// Three-same lane operation by (U, a, opcode).
fn same_op(fpu: &mut Fpu, f: Fmt, key: (bool, bool, u32), x: u64, y: u64, d: u64) -> u64 {
    let cmp = |fpu: &mut Fpu, x, y, sig, want: fn(Ordering) -> bool| {
        all_ones(f, fpu.compare_ord(f, x, y, sig).is_some_and(want))
    };
    match key {
        (_, false, 24) => fpu.maxnum(f, x, y, true),
        (_, true, 24) => fpu.maxnum(f, x, y, false),
        (false, false, 25) => fpu.muladd(f, d, x, y),
        (false, true, 25) => fpu.muladd(f, d, x ^ f.zero(true), y),
        (_, false, 26) => fpu.add(f, x, y),
        (false, true, 26) => fpu.sub(f, x, y),
        (true, true, 26) => abs(f, fpu.sub(f, x, y)), // FABD
        (false, false, 27) => fpu.mulx(f, x, y),
        (true, false, 27) => fpu.mul(f, x, y),
        (false, false, 28) => cmp(fpu, x, y, false, |o| o == Ordering::Equal),
        (true, false, 28) => cmp(fpu, x, y, true, |o| o != Ordering::Less),
        (true, true, 28) => cmp(fpu, x, y, true, |o| o == Ordering::Greater),
        (true, false, 29) => cmp(fpu, abs(f, x), abs(f, y), true, |o| o != Ordering::Less),
        (true, true, 29) => cmp(fpu, abs(f, x), abs(f, y), true, |o| o == Ordering::Greater),
        (_, false, 30) => fpu.max(f, x, y, true),
        (_, true, 30) => fpu.max(f, x, y, false),
        (false, a, 31) => fpu.step(f, x, y, a),
        (true, false, 31) => fpu.div(f, x, y),
        _ => unreachable!("three same {key:?}"),
    }
}

fn three_same(c: &mut Cpu, i: u32) -> R {
    three_same_f(c, i, fmt(i))
}

fn three_same_f(c: &mut Cpu, i: u32, f: Fmt) -> R {
    let n = lanes(i, f)?;
    let (rd, rn, rm) = regs(i);
    // Half precision: a 3-bit opcode (13:11), the low bits of the others' 11xxx.
    let opc = if f == H {
        0b11000 | bits(i, 13, 11)
    } else {
        bits(i, 15, 11)
    };
    let key = (bit(i, 29), bit(i, 23), opc);
    let pairwise = key.0 && matches!(key.2, 24 | 26 | 30) && !(key.1 && key.2 == 26);
    let (a, b, d) = (c.v[rn], c.v[rm], c.v[rd]);
    let w = f.bits();
    let mut fpu = Fpu::with_fpsr(c.fpcr, c.fpsr);
    let mut r = 0u128;
    for e in 0..n {
        let (x, y) = if pairwise {
            let src = if 2 * e < n { a } else { b };
            let k = (2 * e) % n;
            (elem(src, k, w), elem(src, k + 1, w))
        } else {
            (elem(a, e, w), elem(b, e, w))
        };
        r = set_elem(r, e, w, same_op(&mut fpu, f, key, x, y, elem(d, e, w)));
    }
    finish(c, rd, r, n * w, fpu);
    Ok(())
}

/// FEAT_FRINTTS's vector forms (the caller checks it): U (29) is the FPCR's
/// mode (X) or zero (Z), opcode<0> (12) 64 bits (dynarmic's table names the
/// X forms the other way round).
pub(super) fn frintts(c: &mut Cpu, i: u32) -> R {
    let f = fmt(i);
    let n = lanes(i, f)?;
    let (rd, rn, _) = regs(i);
    let w = f.bits();
    let mut fpu = Fpu::with_fpsr(c.fpcr, c.fpsr);
    let rm = if bit(i, 29) {
        fpu.rounding()
    } else {
        Rounding::Zero
    };
    let intsize = if bit(i, 12) { 64 } else { 32 };
    let src = c.v[rn];
    let mut r = 0u128;
    for e in 0..n {
        r = set_elem(r, e, w, fpu.round_int_n(f, elem(src, e, w), rm, intsize));
    }
    finish(c, rd, r, n * w, fpu);
    Ok(())
}

fn two_misc(c: &mut Cpu, i: u32) -> R {
    two_misc_f(c, i, fmt(i))
}

fn two_misc_f(c: &mut Cpu, i: u32, f: Fmt) -> R {
    use Rounding::*;
    let n = lanes(i, f)?;
    let (rd, rn, _) = regs(i);
    let (u, a2, opc) = (bit(i, 29), bit(i, 23), bits(i, 16, 12));
    let w = f.bits();
    let mut fpu = Fpu::with_fpsr(c.fpcr, c.fpsr);
    let fpcr_rm = fpu.rounding();
    let src = c.v[rn];
    if matches!((u, a2, opc), (_, true, 28)) && f == D {
        return Err(Exit::Undefined); // URECPE/URSQRTE: 32-bit lanes only
    }
    let mut r = 0u128;
    for e in 0..n {
        let x = elem(src, e, w);
        let cmp0 = |fpu: &mut Fpu, x, y, sig, want: fn(Ordering) -> bool| {
            all_ones(f, fpu.compare_ord(f, x, y, sig).is_some_and(want))
        };
        let v = match (u, a2, opc) {
            (false, false, 24) => fpu.round_int(f, x, TieEven, false),
            (false, false, 25) => fpu.round_int(f, x, NegInf, false),
            (false, true, 24) => fpu.round_int(f, x, PosInf, false),
            (false, true, 25) => fpu.round_int(f, x, Zero, false),
            (true, false, 24) => fpu.round_int(f, x, TieAway, false),
            (true, false, 25) => fpu.round_int(f, x, fpcr_rm, true), // FRINTX
            (true, true, 25) => fpu.round_int(f, x, fpcr_rm, false), // FRINTI
            (_, a2, 26..=28) if !(a2 && opc == 28) => {
                // FCVT{N,M,A,P,Z}{S,U} (vector, integer).
                let rm = match (a2, opc) {
                    (false, 26) => TieEven,
                    (false, 27) => NegInf,
                    (false, _) => TieAway,
                    (true, 26) => PosInf,
                    _ => Zero,
                };
                fpu.to_fixed(f, x, 0, u, w, rm)
            }
            (_, false, 29) => fpu.from_fixed(f, x, 0, u, w, fpcr_rm), // SCVTF/UCVTF
            (false, true, 12) => cmp0(&mut fpu, x, 0, true, |o| o == Ordering::Greater),
            (true, true, 12) => cmp0(&mut fpu, x, 0, true, |o| o != Ordering::Less),
            (false, true, 13) => cmp0(&mut fpu, x, 0, false, |o| o == Ordering::Equal),
            (true, true, 13) => cmp0(&mut fpu, 0, x, true, |o| o != Ordering::Less), // FCMLE
            (false, true, 14) => cmp0(&mut fpu, 0, x, true, |o| o == Ordering::Greater), // FCMLT
            (false, true, 15) => abs(f, x),
            (true, true, 15) => x ^ f.zero(true),
            (false, true, 28) => fp::urecpe(x as u32) as u64,
            (true, true, 28) => fp::ursqrte(x as u32) as u64,
            (false, true, 29) => fpu.recip_estimate(f, x),
            (true, true, 29) => fpu.rsqrt_estimate(f, x),
            (false, true, 31) => fpu.recpx(f, x),
            (true, true, 31) => fpu.sqrt(f, x),
            k => unreachable!("two misc {k:?}"),
        };
        r = set_elem(r, e, w, v);
    }
    finish(c, rd, r, n * w, fpu);
    Ok(())
}

/// FCVTN, FCVTXN (narrow, into the top half with Q) and FCVTL (widen, from the top half with Q).
fn convert(c: &mut Cpu, i: u32) -> R {
    let (rd, rn, _) = regs(i);
    let (q, scalar, sz, opc) = (bit(i, 30), bit(i, 28), bit(i, 22), bits(i, 16, 12));
    let mut fpu = Fpu::with_fpsr(c.fpcr, c.fpsr);
    let rm = fpu.rounding();
    let a = c.v[rn];
    let (big, small) = if sz { (D, S) } else { (S, H) };
    let xn = bit(i, 29); // FCVTXN
    if xn && !sz {
        return Err(Exit::Undefined);
    }
    let rm = if xn { Rounding::Odd } else { rm };
    if opc == 0b10111 {
        // FCVTL: widen the low or high half.
        let half = if q { a >> 64 } else { a };
        let mut r = 0u128;
        for e in 0..64 / small.bits() {
            let x = elem(half, e, small.bits());
            r = set_elem(r, e, big.bits(), fpu.convert(small, big, x, rm));
        }
        finish(c, rd, r, 128, fpu);
        return Ok(());
    }
    let n = if scalar { 1 } else { 64 / small.bits() };
    let mut r = 0u128;
    for e in 0..n {
        let x = elem(a, e, big.bits());
        r = set_elem(r, e, small.bits(), fpu.convert(big, small, x, rm));
    }
    c.v[rd] = if scalar || !q {
        r
    } else {
        (c.v[rd] as u64 as u128) | r << 64
    };
    c.fpsr |= fpu.flags;
    Ok(())
}

/// Scalar pairwise (FADDP, FMAXP, FMINP, FMAXNMP, FMINNMP on the two lanes of Vn).
fn pair(c: &mut Cpu, i: u32) -> R {
    pair_f(c, i, fmt(i))
}

fn pair_f(c: &mut Cpu, i: u32, f: Fmt) -> R {
    let (rd, rn, _) = regs(i);
    let w = f.bits();
    let (x, y) = (elem(c.v[rn], 0, w), elem(c.v[rn], 1, w));
    let mut fpu = Fpu::with_fpsr(c.fpcr, c.fpsr);
    let min = bit(i, 23);
    let v = match bits(i, 16, 12) {
        0b01100 => fpu.maxnum(f, x, y, !min),
        0b01101 => fpu.add(f, x, y),
        _ => fpu.max(f, x, y, !min),
    };
    finish(c, rd, v as u128, w, fpu);
    Ok(())
}

/// FMAXV, FMINV, FMAXNMV, FMINNMV: 4S only (half precision: 4H or 8H),
/// reduced as a tree like ARM's Reduce().
fn across(c: &mut Cpu, i: u32) -> R {
    if bit(i, 22) || !bit(i, 30) {
        return Err(Exit::Undefined);
    }
    across_f(c, i, S)
}

fn across_f(c: &mut Cpu, i: u32, f: Fmt) -> R {
    let (rd, rn, _) = regs(i);
    let a = c.v[rn];
    let w = f.bits();
    let n = if bit(i, 30) { 128 } else { 64 } / w;
    let mut fpu = Fpu::with_fpsr(c.fpcr, c.fpsr);
    let (nm, is_max) = (bits(i, 16, 12) == 0b01100, !bit(i, 23));
    let mut op = |x, y| {
        if nm {
            fpu.maxnum(f, x, y, is_max)
        } else {
            fpu.max(f, x, y, is_max)
        }
    };
    // Reduce(): each half reduced, then the two; pairs of adjacent lanes first.
    let mut v: [u64; 8] = core::array::from_fn(|e| elem(a, e as u32 % n, w));
    let mut m = n as usize;
    while m > 1 {
        for e in 0..m / 2 {
            v[e] = op(v[2 * e], v[2 * e + 1]);
        }
        m /= 2;
    }
    finish(c, rd, v[0] as u128, w, fpu);
    Ok(())
}

fn by_element(c: &mut Cpu, i: u32) -> R {
    by_element_f(c, i, fmt(i))
}

fn by_element_f(c: &mut Cpu, i: u32, f: Fmt) -> R {
    let n = lanes(i, f)?;
    let (rd, rn, _) = regs(i);
    let (l, h) = (bit(i, 21) as u32, bit(i, 11) as u32);
    // Half precision: the index is H:L:M, Vm the low 4 bits (19:16).
    let (index, rm) = match f {
        D if l == 1 => return Err(Exit::Undefined),
        D => (h, bits(i, 20, 16)),
        S => (h << 1 | l, bits(i, 20, 16)),
        _ => (h << 2 | l << 1 | bit(i, 20) as u32, bits(i, 19, 16)),
    };
    let w = f.bits();
    let y = elem(c.v[rm as usize], index, w);
    let (a, d) = (c.v[rn], c.v[rd]);
    let mut fpu = Fpu::with_fpsr(c.fpcr, c.fpsr);
    let mut r = 0u128;
    for e in 0..n {
        let x = elem(a, e, w);
        let v = match (bit(i, 29), bits(i, 15, 12)) {
            (_, 0b0001) => fpu.muladd(f, elem(d, e, w), x, y),
            (_, 0b0101) => fpu.muladd(f, elem(d, e, w), x ^ f.zero(true), y),
            (false, _) => fpu.mul(f, x, y),
            (true, _) => fpu.mulx(f, x, y),
        };
        r = set_elem(r, e, w, v);
    }
    finish(c, rd, r, n * w, fpu);
    Ok(())
}

/// SCVTF/UCVTF/FCVTZS/FCVTZU by immediate: fbits from immh:immb.
fn fixed(c: &mut Cpu, i: u32) -> R {
    let immh = bits(i, 22, 19);
    let f = match immh {
        8.. => D,
        4..=7 => S,
        2..=3 if has_fp16(c) => H, // FEAT_FP16
        _ => return Err(Exit::Undefined),
    };
    let w = f.bits();
    let (q, scalar) = (bit(i, 30), bit(i, 28));
    if !scalar && f == D && !q {
        return Err(Exit::Undefined);
    }
    let n = if scalar {
        1
    } else {
        (if q { 128 } else { 64 }) / w
    };
    let fbits = 2 * w - bits(i, 22, 16);
    let (rd, rn, _) = regs(i);
    let u = bit(i, 29);
    let a = c.v[rn];
    let mut fpu = Fpu::with_fpsr(c.fpcr, c.fpsr);
    let rm = fpu.rounding();
    let mut r = 0u128;
    for e in 0..n {
        let x = elem(a, e, w);
        let v = if bits(i, 15, 11) == 0b11100 {
            fpu.from_fixed(f, x, fbits, u, w, rm)
        } else {
            fpu.to_fixed(f, x, fbits, u, w, Rounding::Zero)
        };
        r = set_elem(r, e, w, v);
    }
    finish(c, rd, r, n * w, fpu);
    Ok(())
}

/// Whether FEAT_FCMA's `i` is allocated: size 10 (singles) or, for the vector
/// forms, 11 with Q (doubles); by element, singles with Q and L clear (the
/// index is H). Size 01 is the half form, with FEAT_FP16 (`fp16`): by element
/// its index is H:L, H clear without Q. 00 is reserved.
pub(super) fn fcma_allocated(i: u32, op: Op, fp16: bool) -> bool {
    let (size, q) = (bits(i, 23, 22), bit(i, 30));
    if op == Op::FCMLA_elt {
        size == 2 && q && !bit(i, 21) || size == 1 && fp16 && (q || !bit(i, 11))
    } else {
        size == 2 || size == 3 && q || size == 1 && fp16
    }
}

/// FEAT_FCMA (the caller checks it and [`fcma_allocated`]): on pairs of
/// lanes (real, imaginary), FCMLA adds one half of a complex product to Vd
/// (rot, 14:13 by element, 12:11 vector, in 90° steps: one FPMulAdd a lane,
/// Vn's real or imaginary element by Vm's, either negated, the ARM ARM's
/// element1 to element4), FCADD adds Vm rotated by 90° or 270° (12) to Vn.
pub(super) fn fcma(c: &mut Cpu, i: u32, op: Op) -> R {
    let f = match bits(i, 23, 22) {
        1 => H,
        2 => S,
        _ => D,
    };
    let w = f.bits();
    let n = if bit(i, 30) { 128 } else { 64 } / w;
    let (rd, rn, rm) = regs(i);
    let (a, b, d) = (c.v[rn], c.v[rm], c.v[rd]);
    let neg = |x: u64| x ^ f.zero(true);
    let mut fpu = Fpu::with_fpsr(c.fpcr, c.fpsr);
    let mut r = 0u128;
    for e in (0..n).step_by(2) {
        let (lo, hi) = if op == Op::FCADD_vec {
            // rot 0 (90°): Vn + (-Vm.im, Vm.re); 1 (270°): Vn + (Vm.im, -Vm.re).
            let (re, im) = (elem(b, e, w), elem(b, e + 1, w));
            let (x, y) = if bit(i, 12) {
                (im, neg(re))
            } else {
                (neg(im), re)
            };
            (
                fpu.add(f, elem(a, e, w), x),
                fpu.add(f, elem(a, e + 1, w), y),
            )
        } else {
            // By element, Vm's pair is the index's (H) in every pair.
            let (rot, m) = if op == Op::FCMLA_elt {
                // The pair's index: H (singles) or H:L (halves).
                let index = if f == H {
                    bit(i, 11) as u32 * 2 + bit(i, 21) as u32
                } else {
                    bit(i, 11) as u32
                };
                (bits(i, 14, 13), 2 * index)
            } else {
                (bits(i, 12, 11), e)
            };
            let (re, im) = (elem(b, m, w), elem(b, m + 1, w));
            // Vn's element (its real part for 0° and 180°), and Vm's two.
            let x = elem(a, e + (rot & 1), w);
            let (y0, y1) = match rot {
                0 => (re, im),
                1 => (neg(im), re),
                2 => (neg(re), neg(im)),
                _ => (im, neg(re)),
            };
            (
                fpu.muladd(f, elem(d, e, w), x, y0),
                fpu.muladd(f, elem(d, e + 1, w), x, y1),
            )
        };
        r = set_elem(set_elem(r, e, w, lo), e + 1, w, hi);
    }
    finish(c, rd, r, n * w, fpu);
    Ok(())
}

/// FEAT_FHM (the caller checks it): FMLAL, FMLSL and their "2" forms, vector
/// and by element: single lanes of Vd plus the products of Vn's half lanes
/// (the low half of Vn's 64 or 128 bits, or with "2" its high half) with Vm's
/// (by element, lane H:L:M of the low 16 registers), the first factor negated
/// for FMLSL ([`Fpu::muladd_h`]: one rounding, to single). Vector FMLAL2 is
/// U (29) with opcode 11001, by element U with opcode<3> set; FMLSL is a (23)
/// vector, opcode<2> (14) by element.
pub(super) fn fhm(c: &mut Cpu, i: u32, op: Op) -> R {
    use Op::*;
    let by_element = matches!(op, FMLAL_elt_1 | FMLAL_elt_2 | FMLSL_elt_1 | FMLSL_elt_2);
    let q = bit(i, 30);
    let (part, sub) = (bit(i, 29), if by_element { bit(i, 14) } else { bit(i, 23) });
    let n = if q { 4 } else { 2 };
    let (rd, rn, _) = regs(i);
    // Vpart(n, part) of half the datasize: 32 or 64 bits.
    let a = if part { c.v[rn] >> (16 * n) } else { c.v[rn] };
    let b = if by_element {
        let index = bit(i, 11) as u32 * 4 + bit(i, 21) as u32 * 2 + bit(i, 20) as u32;
        let y = elem(c.v[bits(i, 19, 16) as usize], index, 16) as u128;
        (0..4).fold(0u128, |v, e| v | y << (16 * e))
    } else {
        let b = c.v[bits(i, 20, 16) as usize];
        if part { b >> (16 * n) } else { b }
    };
    let d = c.v[rd];
    let mut fpu = Fpu::with_fpsr(c.fpcr, c.fpsr);
    let mut r = 0u128;
    for e in 0..n {
        let x = elem(a, e, 16);
        let x = if sub { x ^ 0x8000 } else { x };
        let v = fpu.muladd_h(elem(d, e, 32), x, elem(b, e, 16));
        r = set_elem(r, e, 32, v);
    }
    finish(c, rd, r, 32 * n, fpu);
    Ok(())
}

/// FEAT_BF16 (the caller checks the vCPU has it). BFCVT and BFCVTN/BFCVTN2
/// round singles to bfloat16 as FCVT does (FPConvertBF: FPCR's rounding, FZ,
/// DN and the flags); BFMLALB/BFMLALT widen the even or odd bfloat16s of Vn and
/// Vm (or Vm's element) exactly and are FPMulAdd on singles; BFDOT and BFMMLA
/// are BFDotAdd ([`fp::bf_dot_add`]: FPCR ignored, no flags).
pub(super) fn bf16(c: &mut Cpu, i: u32, op: Op) -> R {
    use Op::*;
    let (rd, rn, rm) = regs(i);
    let q = bit(i, 30);
    let (n, d) = (c.v[rn], c.v[rd]);
    let h = |v: u128, e: u32| elem(v, e, 16) as u16;
    let w = |v: u128, e: u32| elem(v, e, 32) as u32;
    match op {
        BFCVT => {
            let mut fpu = Fpu::new(c.fpcr);
            let rm = fpu.rounding();
            let r = fpu.convert(S, fp::BF, n as u32 as u64, rm);
            finish(c, rd, r as u128, 16, fpu);
        }
        BFCVTN => {
            let mut fpu = Fpu::new(c.fpcr);
            let rm = fpu.rounding();
            let mut r = 0u128;
            for e in 0..4 {
                r = set_elem(r, e, 16, fpu.convert(S, fp::BF, w(n, e) as u64, rm));
            }
            // BFCVTN2: the upper half, the lower kept.
            let (r, size) = if q {
                (r << 64 | d as u64 as u128, 128)
            } else {
                (r, 64)
            };
            finish(c, rd, r, size, fpu);
        }
        BFDOT_vec | BFDOT_element | BFMMLA => {
            let m = c.v[rm];
            let mut r = 0u128;
            if op == BFMMLA {
                for (i2, j) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                    let mut sum = w(d, 2 * i2 + j);
                    for k in 0..2 {
                        let a = [h(n, 4 * i2 + 2 * k), h(n, 4 * i2 + 2 * k + 1)];
                        let b = [h(m, 4 * j + 2 * k), h(m, 4 * j + 2 * k + 1)];
                        sum = fp::bf_dot_add(sum, a, b);
                    }
                    r = set_elem(r, 2 * i2 + j, 32, sum as u64);
                }
                c.v[rd] = r;
                return Ok(());
            }
            // By element: Vm's pair H:L (Vm is M:Rm, five bits).
            let index = (bit(i, 11) as u32) << 1 | bit(i, 21) as u32;
            let lanes = if q { 4 } else { 2 };
            for e in 0..lanes {
                let p = if op == BFDOT_element { index } else { e };
                let a = [h(n, 2 * e), h(n, 2 * e + 1)];
                let b = [h(m, 2 * p), h(m, 2 * p + 1)];
                r = set_elem(r, e, 32, fp::bf_dot_add(w(d, e), a, b) as u64);
            }
            c.v[rd] = if q { r } else { r as u64 as u128 };
        }
        BFMLALX_vector | BFMLALX_element => {
            // Q picks the odd (top: BFMLALT) or even (BFMLALB) halves.
            let sel = q as u32;
            let b = if op == BFMLALX_element {
                let index = (bit(i, 11) as u32) << 2 | (bit(i, 21) as u32) << 1 | bit(i, 20) as u32;
                Some(h(c.v[bits(i, 19, 16) as usize], index))
            } else {
                None
            };
            let m = c.v[rm];
            let mut fpu = Fpu::with_fpsr(c.fpcr, c.fpsr);
            let mut r = 0u128;
            for e in 0..4 {
                let x = (h(n, 2 * e + sel) as u64) << 16;
                let y = (b.unwrap_or_else(|| h(m, 2 * e + sel)) as u64) << 16;
                r = set_elem(r, e, 32, fpu.muladd(S, w(d, e) as u64, x, y));
            }
            finish(c, rd, r, 128, fpu);
        }
        _ => unreachable!(),
    }
    Ok(())
}
