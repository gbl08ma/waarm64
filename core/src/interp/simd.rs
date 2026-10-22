//! AdvSIMD and FP register moves: DUP, INS, UMOV/SMOV, FMOV (general,
//! register, immediate) and the modified-immediate group (MOVI, MVNI, ORR, BIC,
//! FMOV vector).

use super::{Exit, R, bit, bits, sext};
use crate::cpu::Cpu;
use crate::decode::Op;

/// Element `e` of `esize` bits (at most 64: an element is within one 64-bit
/// half, so no `u128` shift by a variable, a call to compiler-rt in wasm).
#[inline]
pub(super) fn elem(v: u128, e: u32, esize: u32) -> u64 {
    let sh = e * esize;
    let half = if sh >= 64 { (v >> 64) as u64 } else { v as u64 };
    (half >> (sh & 63)) & (u64::MAX >> (64 - esize))
}

/// `v` with element `e` of `esize` bits replaced by the low bits of `x` (as
/// [`elem`], within one half).
#[inline]
pub(super) fn set_elem(v: u128, e: u32, esize: u32, x: u64) -> u128 {
    let (m, sh) = (u64::MAX >> (64 - esize), e * esize);
    let (lo, hi) = (v as u64, (v >> 64) as u64);
    let put = |h: u64| (h & !(m << (sh & 63))) | ((x & m) << (sh & 63));
    let (lo, hi) = if sh >= 64 {
        (lo, put(hi))
    } else {
        (put(lo), hi)
    };
    lo as u128 | (hi as u128) << 64
}

/// `x` replicated across `bytes` bytes, from an `esize`-bit element.
fn replicate(x: u64, esize: u32, bytes: u32) -> u128 {
    (0..8 * bytes / esize).fold(0, |acc, e| set_elem(acc, e, esize, x))
}

/// The value written to a vector register with Q: a 64-bit result clears the top half.
#[inline]
fn vq(v: u128, q: bool) -> u128 {
    if q { v } else { v as u64 as u128 }
}

/// Element size (log2 bytes) and index from imm5 (20:16): the lowest set bit picks the size.
fn imm5(i: u32) -> R<(u32, u32)> {
    let imm5 = bits(i, 20, 16);
    let size = imm5.trailing_zeros();
    if size > 3 {
        return Err(Exit::Undefined);
    }
    Ok((size, imm5 >> (size + 1)))
}

/// VFPExpandImm for single (`n` = 32) or double (64) precision.
pub(crate) fn vfp_expand_imm(imm8: u32, n: u32) -> u64 {
    let (sign, b6, rest) = (
        (imm8 >> 7) as u64,
        (imm8 >> 6) & 1 == 1,
        (imm8 & 0x3f) as u64,
    );
    let e = if n == 32 { 8 } else { 11 };
    // exp = NOT(b):Replicate(b, E-3):imm8<5:4>; frac = imm8<3:0>:Zeros.
    let exp =
        ((!b6 as u64) << (e - 1)) | (if b6 { (1 << (e - 3)) - 1 } else { 0 } << 2) | rest >> 4;
    sign << (n - 1) | exp << (n - 1 - e) | (rest & 15) << (n - 1 - e - 4)
}

/// AdvSIMDExpandImm: the 64-bit pattern for op (29), cmode (15:12) and imm8 (a:b:c at 18:16, d–h at 9:5).
pub(crate) fn adv_simd_expand_imm(op: bool, cmode: u32, imm8: u32, q: bool) -> R<u64> {
    let imm = imm8 as u64;
    let rep32 = |x: u64| x | x << 32;
    let rep16 = |x: u64| rep32(x | x << 16);
    Ok(match cmode >> 1 {
        0..=3 => rep32(imm << (8 * (cmode >> 1))),
        4 | 5 => rep16(imm << (8 * ((cmode >> 1) & 1))),
        6 if cmode & 1 == 0 => rep32(imm << 8 | 0xff),
        6 => rep32(imm << 16 | 0xffff),
        _ => match (cmode & 1, op) {
            (0, false) => imm * 0x0101_0101_0101_0101,
            (0, true) => (0..8).fold(0, |acc, k| acc | (((imm >> k) & 1) * 0xff) << (8 * k)),
            (_, false) => rep32(vfp_expand_imm(imm8, 32)),
            (_, true) if q => vfp_expand_imm(imm8, 64),
            _ => return Err(Exit::Undefined),
        },
    })
}

pub(super) fn exec(c: &mut Cpu, i: u32, op: Op) -> R {
    use Op::*;
    let (rd, rn) = (bits(i, 4, 0) as usize, bits(i, 9, 5));
    let q = bit(i, 30);
    match op {
        DUP_elt_1 | DUP_elt_2 => {
            let (size, index) = imm5(i)?;
            let esize = 8 << size;
            let x = elem(c.v[rn as usize], index, esize);
            c.v[rd] = if op == DUP_elt_1 {
                x as u128
            } else if size == 3 && !q {
                return Err(Exit::Undefined);
            } else {
                replicate(x, esize, if q { 16 } else { 8 })
            };
        }
        DUP_gen => {
            let (size, _) = imm5(i)?;
            if size == 3 && !q {
                return Err(Exit::Undefined);
            }
            c.v[rd] = replicate(c.reg(rn), 8 << size, if q { 16 } else { 8 });
        }
        SMOV | UMOV => {
            let (size, index) = imm5(i)?;
            // SMOV: Wd from B/H, Xd from B/H/S. UMOV: Wd from B/H/S, Xd from D.
            let ok = match (op, q) {
                (SMOV, false) => size < 2,
                (SMOV, true) => size < 3,
                (_, false) => size < 3,
                (_, true) => size == 3,
            };
            if !ok {
                return Err(Exit::Undefined);
            }
            let esize = 8 << size;
            let x = elem(c.v[rn as usize], index, esize);
            let x = if op == SMOV { sext(x, esize) } else { x };
            c.set_reg(rd as u32, if q { x } else { x as u32 as u64 });
        }
        INS_gen => {
            let (size, index) = imm5(i)?;
            c.v[rd] = set_elem(c.v[rd], index, 8 << size, c.reg(rn));
        }
        INS_elt => {
            let (size, dst) = imm5(i)?;
            let src = bits(i, 14, 11) >> size;
            let esize = 8 << size;
            c.v[rd] = set_elem(c.v[rd], dst, esize, elem(c.v[rn as usize], src, esize));
        }
        MOVI | FMOV_2 => {
            let (op1, cmode) = (bit(i, 29), bits(i, 15, 12));
            let imm8 = bits(i, 18, 16) << 5 | bits(i, 9, 5);
            let imm = adv_simd_expand_imm(op1, cmode, imm8, q)?;
            let imm = imm as u128 | (imm as u128) << 64;
            // cmode 0xx1 and 10x1 are ORR (op 0) and BIC (op 1); the rest MOVI/MVNI/FMOV.
            let logical = cmode & 1 == 1 && cmode < 12;
            let v = match (logical, op1) {
                (true, false) => c.v[rd] | imm,
                (true, true) => c.v[rd] & !imm,
                (false, true) if cmode < 14 => !imm,
                _ => imm,
            };
            c.v[rd] = vq(v, q);
        }
        FMOV_float_gen => {
            // sf (31), ftype (23:22), rmode (20:19), opcode<0> (16): 1 is to the vector register.
            let (sf, ftype, rmode, to_v) =
                (bit(i, 31), bits(i, 23, 22), bits(i, 20, 19), bit(i, 16));
            match (sf, ftype, rmode) {
                (false, 0, 0) | (true, 1, 0) => {
                    let w = if sf { 64 } else { 32 };
                    if to_v {
                        c.v[rd] = (c.reg(rn) & (u64::MAX >> (64 - w))) as u128;
                    } else {
                        c.set_reg(rd as u32, elem(c.v[rn as usize], 0, w));
                    }
                }
                (true, 2, 1) => {
                    if to_v {
                        c.v[rd] = set_elem(c.v[rd], 1, 64, c.reg(rn));
                    } else {
                        c.set_reg(rd as u32, elem(c.v[rn as usize], 1, 64));
                    }
                }
                // Half precision needs FEAT_FP16, which we don't advertise.
                _ => return Err(Exit::Undefined),
            }
        }
        FMOV_float => {
            let w = match bits(i, 23, 22) {
                0 => 32,
                1 => 64,
                _ => return Err(Exit::Undefined),
            };
            c.v[rd] = elem(c.v[rn as usize], 0, w) as u128;
        }
        FMOV_float_imm => {
            let n = match bits(i, 23, 22) {
                0 => 32,
                1 => 64,
                _ => return Err(Exit::Undefined),
            };
            c.v[rd] = vfp_expand_imm(bits(i, 20, 13), n) as u128;
        }
        _ => unreachable!("{op:?}"),
    }
    Ok(())
}
