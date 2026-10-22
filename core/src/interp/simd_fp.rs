//! AdvSIMD floating point, vector and scalar: three same, two-register misc
//! (including conversions, estimates and FCVTN/FCVTL/FCVTXN), pairwise, across
//! lanes, by element, and fixed-point conversions by immediate. Lanes are
//! single or double (sz, bit 22); half-precision arithmetic is FEAT_FP16 and
//! UNDEFINED (interp.rs lists those classes).

use super::simd::{elem, set_elem};
use super::{Exit, R, bit, bits};
use crate::cpu::Cpu;
use crate::decode::Op;
use crate::fp::{self, D, Fmt, Fpu, H, Rounding, S};
use core::cmp::Ordering;

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
    let f = fmt(i);
    let n = lanes(i, f)?;
    let (rd, rn, rm) = regs(i);
    let key = (bit(i, 29), bit(i, 23), bits(i, 15, 11));
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

fn two_misc(c: &mut Cpu, i: u32) -> R {
    use Rounding::*;
    let f = fmt(i);
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
    let f = fmt(i);
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

/// FMAXV, FMINV, FMAXNMV, FMINNMV: 4S only, reduced as a tree like ARM's Reduce().
fn across(c: &mut Cpu, i: u32) -> R {
    if bit(i, 22) || !bit(i, 30) {
        return Err(Exit::Undefined);
    }
    let (rd, rn, _) = regs(i);
    let a = c.v[rn];
    let mut fpu = Fpu::with_fpsr(c.fpcr, c.fpsr);
    let (nm, is_max) = (bits(i, 16, 12) == 0b01100, !bit(i, 23));
    let mut op = |x, y| {
        if nm {
            fpu.maxnum(S, x, y, is_max)
        } else {
            fpu.max(S, x, y, is_max)
        }
    };
    let l = op(elem(a, 0, 32), elem(a, 1, 32));
    let h = op(elem(a, 2, 32), elem(a, 3, 32));
    let v = op(l, h);
    finish(c, rd, v as u128, 32, fpu);
    Ok(())
}

fn by_element(c: &mut Cpu, i: u32) -> R {
    let f = fmt(i);
    let n = lanes(i, f)?;
    let (rd, rn, _) = regs(i);
    let (l, h) = (bit(i, 21) as u32, bit(i, 11) as u32);
    let index = if f == D {
        if l == 1 {
            return Err(Exit::Undefined);
        }
        h
    } else {
        h << 1 | l
    };
    let w = f.bits();
    let y = elem(c.v[bits(i, 20, 16) as usize], index, w);
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
        _ => return Err(Exit::Undefined), // 16-bit lanes are FEAT_FP16
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
