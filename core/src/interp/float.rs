//! Scalar floating point: data processing (1, 2 and 3 source), compares,
//! conditional compare and select, precision conversions and conversions to and
//! from integers and fixed point. The arithmetic is `crate::fp`; this module
//! decodes, moves operands and accumulates FPSR flags.

use super::simd::elem;
use super::{Exit, R, bit, bits, cond_holds};
use crate::cpu::Cpu;
use crate::decode::Op;
use crate::fp::{D, Fmt, Fpu, H, Rounding, S};

/// The format in ftype (23:22): single or double. Half precision needs FEAT_FP16.
fn ftype(i: u32) -> R<Fmt> {
    match bits(i, 23, 22) {
        0 => Ok(S),
        1 => Ok(D),
        _ => Err(Exit::Undefined),
    }
}

/// FCVT's ftype/opc encoding, where half precision is v8.0.
fn cvt_type(t: u32) -> R<Fmt> {
    match t {
        0 => Ok(S),
        1 => Ok(D),
        3 => Ok(H),
        _ => Err(Exit::Undefined),
    }
}

/// FPNeg: flips the sign bit, NaNs included.
fn neg(f: Fmt, x: u64) -> u64 {
    x ^ f.zero(true)
}

pub(super) fn exec(c: &mut Cpu, i: u32, op: Op) -> R {
    use Op::*;
    let (rd, rn, rm, ra) = (
        bits(i, 4, 0) as usize,
        bits(i, 9, 5) as usize,
        bits(i, 20, 16) as usize,
        bits(i, 14, 10) as usize,
    );
    let mut fpu = Fpu::with_fpsr(c.fpcr, c.fpsr);
    let rmode = fpu.rounding();
    let f = &mut fpu;
    match op {
        FCVT_float => {
            let (from, to) = (cvt_type(bits(i, 23, 22))?, cvt_type(bits(i, 16, 15))?);
            if from == to {
                return Err(Exit::Undefined);
            }
            let x = elem(c.v[rn], 0, from.bits());
            c.v[rd] = f.convert(from, to, x, rmode) as u128;
        }
        // FEAT_JSCVT (the caller checks the feature): NZCV = 0Z00.
        FJCVTZS => {
            let (r, z) = f.to_int_js(elem(c.v[rn], 0, 64));
            c.set_reg(rd as u32, r as u64);
            c.nzcv = (z as u64) << 30;
        }
        SCVTF_float_int | UCVTF_float_int | SCVTF_float_fix | UCVTF_float_fix => {
            let t = ftype(i)?;
            let (width, fbits) = int_width(i, op == SCVTF_float_fix || op == UCVTF_float_fix)?;
            let unsigned = matches!(op, UCVTF_float_int | UCVTF_float_fix);
            c.v[rd] = f.from_fixed(t, c.reg(rn as u32), fbits, unsigned, width, rmode) as u128;
        }
        FCVTNS_float | FCVTNU_float | FCVTAS_float | FCVTAU_float | FCVTPS_float | FCVTPU_float
        | FCVTMS_float | FCVTMU_float | FCVTZS_float_int | FCVTZU_float_int | FCVTZS_float_fix
        | FCVTZU_float_fix => {
            let t = ftype(i)?;
            let fix = matches!(op, FCVTZS_float_fix | FCVTZU_float_fix);
            let (width, fbits) = int_width(i, fix)?;
            // opcode<0> (16) is unsigned; opcode<2> (18) is the ties-away pair.
            let rm = match (bit(i, 18), bits(i, 20, 19)) {
                (true, _) => Rounding::TieAway,
                (_, 0) => Rounding::TieEven,
                (_, 1) => Rounding::PosInf,
                (_, 2) => Rounding::NegInf,
                _ => Rounding::Zero,
            };
            let x = elem(c.v[rn], 0, t.bits());
            let r = f.to_fixed(t, x, fbits, bit(i, 16), width, rm);
            c.set_reg(rd as u32, r);
        }
        _ => {
            let t = ftype(i)?;
            let w = t.bits();
            let (x, y) = (elem(c.v[rn], 0, w), elem(c.v[rm], 0, w));
            match op {
                FCMP_float | FCMPE_float => {
                    let y = if bit(i, 3) { 0 } else { y };
                    c.nzcv = f.compare(t, x, y, op == FCMPE_float);
                }
                FCCMP_float | FCCMPE_float => {
                    c.nzcv = if cond_holds(c.nzcv, bits(i, 15, 12)) {
                        f.compare(t, x, y, op == FCCMPE_float)
                    } else {
                        (bits(i, 3, 0) as u64) << 28
                    };
                }
                FCSEL_float => {
                    let r = if cond_holds(c.nzcv, bits(i, 15, 12)) {
                        x
                    } else {
                        y
                    };
                    c.v[rd] = r as u128;
                }
                _ => {
                    let r = match op {
                        FABS_float => x & !t.zero(true),
                        FNEG_float => neg(t, x),
                        FSQRT_float => f.sqrt(t, x),
                        // FEAT_FRINTTS (the caller checks it): opcode<1> (16) is
                        // 64 bits, opcode<0> (15) the FPCR's mode (X) or zero (Z).
                        FRINT32X_float | FRINT64X_float | FRINT32Z_float | FRINT64Z_float => {
                            let rm = if bit(i, 15) { rmode } else { Rounding::Zero };
                            f.round_int_n(t, x, rm, if bit(i, 16) { 64 } else { 32 })
                        }
                        FRINTN_float | FRINTP_float | FRINTM_float | FRINTZ_float
                        | FRINTA_float | FRINTX_float | FRINTI_float => {
                            let rm = match bits(i, 17, 15) {
                                0 => Rounding::TieEven,
                                1 => Rounding::PosInf,
                                2 => Rounding::NegInf,
                                3 => Rounding::Zero,
                                4 => Rounding::TieAway,
                                _ => rmode, // FRINTX (6), FRINTI (7)
                            };
                            f.round_int(t, x, rm, op == FRINTX_float)
                        }
                        FMUL_float => f.mul(t, x, y),
                        FNMUL_float => neg(t, f.mul(t, x, y)),
                        FDIV_float => f.div(t, x, y),
                        FADD_float => f.add(t, x, y),
                        FSUB_float => f.sub(t, x, y),
                        FMAX_float => f.max(t, x, y, true),
                        FMIN_float => f.max(t, x, y, false),
                        FMAXNM_float => f.maxnum(t, x, y, true),
                        FMINNM_float => f.maxnum(t, x, y, false),
                        FMADD_float | FMSUB_float | FNMADD_float | FNMSUB_float => {
                            // o1 (21) negates the addend, o1 != o0 (15) the first factor.
                            let a = elem(c.v[ra], 0, w);
                            let (o1, o0) = (bit(i, 21), bit(i, 15));
                            let a = if o1 { neg(t, a) } else { a };
                            let x = if o1 != o0 { neg(t, x) } else { x };
                            f.muladd(t, a, x, y)
                        }
                        _ => unreachable!("{op:?}"),
                    };
                    c.v[rd] = r as u128;
                }
            }
        }
    }
    c.fpsr |= fpu.flags;
    Ok(())
}

/// Integer width from sf (31) and, for fixed point, fbits from scale (15:10).
fn int_width(i: u32, fixed: bool) -> R<(u32, u32)> {
    let width = if bit(i, 31) { 64 } else { 32 };
    if !fixed {
        return Ok((width, 0));
    }
    let scale = bits(i, 15, 10);
    if width == 32 && scale < 32 {
        return Err(Exit::Undefined);
    }
    Ok((width, 64 - scale))
}
