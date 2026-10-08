//! Scalar floating point on the fast paths docs/jit.md "Floating point"
//! describes (M6 loop 5): under the block's FP guard (FPCR.RMode round to
//! nearest even, FPSR.IXC set already: [`fpa_guard`]), with normal operands
//! and a result that is normal and above the smallest normal binade, the host's
//! IEEE operation gives the interpreter's result and leaves FPSR as it is.
//! Anything else runs the helper. FABS and FNEG are bit operations, inline
//! always. Operands come from the `Cpu`'s V registers (their low 32 or 64
//! bits), results go back zero-extended. Callers run [`super::fp_guard`] first.

use core::mem::offset_of;

use super::{
    AND, Ctx, EQZ, FPOK, Func, LT_U, Regs, SHR_U, SUB, V, VCPU, W, WC, XOR, fallback, get, set,
    xmask,
};
use crate::cpu::Cpu;
use crate::decode::Op;
use crate::interp::{bit, bits};

/// FPSR.IXC.
const IXC: i64 = 16;

/// Before a block's first FP instruction on a fast path: FPOK = FPCR.RMode is
/// round to nearest even and FPSR.IXC is set. Both hold for the rest of the
/// block (an MSR, which ends it, is the only thing that changes them).
pub(super) fn fpa_guard(c: &mut Func) {
    if c.fpa_ok {
        return;
    }
    c.fpa_ok = true;
    let (fpcr, fpsr) = (offset_of!(Cpu, fpcr) as u32, offset_of!(Cpu, fpsr) as u32);
    c.local_get(VCPU)
        .i64_load(fpcr)
        .i64_const(3 << 22)
        .i64_and()
        .op(EQZ + WC);
    c.local_get(VCPU)
        .i64_load(fpsr)
        .i64_const(IXC)
        .i64_and()
        .op(EQZ + WC)
        .op(EQZ);
    c.op(AND).local_set(FPOK);
}

/// A scalar format: single (`d` false) or double.
#[derive(Clone, Copy)]
struct F {
    d: bool,
}

impl F {
    /// Exponent field shift, all-ones value.
    fn exp(self) -> (i64, i64) {
        if self.d { (52, 0x7ff) } else { (23, 0xff) }
    }
    /// Pushes Vn's low 32 or 64 bits as an integer.
    fn load(self, c: &mut Func, n: u32) {
        c.local_get(VCPU);
        if self.d {
            c.i64_load(V + 16 * n);
        } else {
            c.i32_load(V + 16 * n);
        }
    }
    /// Reinterprets the integer on the stack as this format's float, or back.
    fn to_float(self, c: &mut Func) {
        c.op(if self.d { 0xbf } else { 0xbe });
    }
    fn to_int(self, c: &mut Func) {
        c.op(if self.d { 0xbd } else { 0xbc });
    }
    /// The float opcode of `op`: 0 add, 1 sub, 2 mul, 3 div; sqrt, neg.
    fn arith(self, k: u8) -> u8 {
        if self.d { 0xa0 + k } else { 0x92 + k }
    }
    fn sqrt(self) -> u8 {
        if self.d { 0x9f } else { 0x91 }
    }
    fn neg(self) -> u8 {
        if self.d { 0x9a } else { 0x8c }
    }
    /// Scratch local `k` of this format's integer width.
    fn tmp(self, k: u32) -> u32 {
        super::tmp(self.d, k)
    }
}

/// Pushes an i32: the float bits in local `l` have their exponent field in
/// `lo..max` (normal: 1..all ones; a fast result: 2..all ones).
fn exp_in(c: &mut Func, f: F, l: u32, lo: i64) {
    let (sh, ones) = f.exp();
    let w = if f.d { W } else { 0 };
    c.local_get(l);
    if f.d {
        c.i64_const(sh).op(SHR_U + w).i64_const(ones).op(AND + w);
        c.i64_const(lo)
            .op(SUB + w)
            .i64_const(ones - lo)
            .op(LT_U + WC);
    } else {
        c.i32_const(sh as i32)
            .op(SHR_U)
            .i32_const(ones as i32)
            .op(AND);
        c.i32_const(lo as i32)
            .op(SUB)
            .i32_const((ones - lo) as i32)
            .op(LT_U);
    }
}

/// Vd = the integer in local `r` of format `f`, zero-extended to 128 bits.
fn put(c: &mut Func, f: F, rd: u32, r: u32) {
    c.local_get(VCPU).local_get(r);
    if !f.d {
        c.op(0xad); // i64.extend_i32_u
    }
    c.i64_store(V + 16 * rd);
    c.local_get(VCPU).i64_const(0).i64_store(V + 16 * rd + 8);
}

/// `if cond { fast } else { the helper runs instruction i }`, with `cond` an
/// i32 already on the stack.
fn guarded(c: &mut Func, cx: &Ctx, i: u32, k: usize, written: u32, fast: impl FnOnce(&mut Func)) {
    c.hint(true).if_();
    let before: Regs = c.regs;
    fast(c);
    fallback(c, cx, i, 4 * k as i64, before, written);
}

/// Emits scalar FP instruction `i` inline if it's one this covers; false
/// (and nothing emitted) otherwise.
pub(super) fn inline(c: &mut Func, cx: &Ctx, i: u32, op: Op, k: usize) -> bool {
    use Op::*;
    let (rd, rn, rm, ra) = (
        bits(i, 4, 0),
        bits(i, 9, 5),
        bits(i, 20, 16),
        bits(i, 14, 10),
    );
    let f = match bits(i, 23, 22) {
        0 => F { d: false },
        1 => F { d: true },
        _ => return false, // half precision: FEAT_FP16 isn't advertised
    };
    let (x, y, a, r) = (f.tmp(0), f.tmp(1), f.tmp(2), f.tmp(3));
    match op {
        // Bit operations: no flags, any operand.
        FABS_float | FNEG_float => {
            let sign = if f.d { 1 << 63 } else { 1 << 31 };
            f.load(c, rn);
            if f.d {
                c.i64_const(if op == FNEG_float { sign } else { !sign });
                c.op(if op == FNEG_float { XOR + W } else { AND + W });
            } else {
                let sign = sign as i32;
                c.i32_const(if op == FNEG_float { sign } else { !sign });
                c.op(if op == FNEG_float { XOR } else { AND });
            }
            c.local_set(r);
            put(c, f, rd, r);
        }
        FADD_float | FSUB_float | FMUL_float | FDIV_float | FNMUL_float | FSQRT_float => {
            fpa_guard(c);
            f.load(c, rn);
            c.local_tee(x);
            f.to_float(c);
            if op == FSQRT_float {
                c.op(f.sqrt());
            } else {
                f.load(c, rm);
                c.local_tee(y);
                f.to_float(c);
                let k = match op {
                    FADD_float => 0,
                    FSUB_float => 1,
                    FDIV_float => 3,
                    _ => 2,
                };
                c.op(f.arith(k));
                if op == FNMUL_float {
                    c.op(f.neg());
                }
            }
            f.to_int(c);
            c.local_set(r);
            // FPOK, normal operands (a positive one for FSQRT), a fast result.
            c.local_get(FPOK);
            exp_in(c, f, x, 1);
            c.op(AND);
            if op == FSQRT_float {
                // The sign bit clear.
                c.local_get(x);
                if f.d {
                    c.i64_const(0).op(0x59).op(AND); // i64.ge_s
                } else {
                    c.i32_const(0).op(0x4e).op(AND); // i32.ge_s
                }
            } else {
                exp_in(c, f, y, 1);
                c.op(AND);
            }
            exp_in(c, f, r, 2);
            c.op(AND);
            guarded(c, cx, i, k, 0, |c| put(c, f, rd, r));
        }
        // Single precision: the product is exact in double, t = RN64(p + a),
        // and RN32(t) is the correctly rounded sum unless t is halfway between
        // two singles. Double precision stays a helper call (docs/jit.md "Floating point").
        FMADD_float | FMSUB_float | FNMADD_float | FNMSUB_float if !f.d => {
            fpa_guard(c);
            // o1 (21) negates the addend, o1 != o0 (15) the first factor.
            let (o1, o0) = (bit(i, 21), bit(i, 15));
            let sign = 1i32 << 31;
            for (l, n, neg) in [(x, rn, o1 != o0), (y, rm, false), (a, ra, o1)] {
                f.load(c, n);
                if neg {
                    c.i32_const(sign).op(XOR);
                }
                c.local_set(l);
            }
            let t = super::tmp(true, 0);
            c.local_get(x).op(0xbe).op(0xbb); // f32 → f64
            c.local_get(y).op(0xbe).op(0xbb).op(0xa2); // f64.mul
            c.local_get(a).op(0xbe).op(0xbb).op(0xa0); // f64.add
            c.op(0xbd).local_tee(t); // i64.reinterpret
            c.op(0xbf).op(0xb6).op(0xbc).local_set(r); // f32.demote, reinterpret
            c.local_get(FPOK);
            for l in [x, y, a] {
                exp_in(c, f, l, 1);
                c.op(AND);
            }
            exp_in(c, f, r, 2);
            c.op(AND);
            // t's low 29 fraction bits aren't 1 followed by zeros.
            c.local_get(t).i64_const(0x1fff_ffff).op(AND + W);
            c.i64_const(0x1000_0000).op(0x52).op(AND); // i64.ne
            guarded(c, cx, i, k, 0, |c| put(c, f, rd, r));
        }
        // SCVTF/UCVTF from a general register: wasm's converts round to nearest
        // even, and an integer's float is never infinite or denormal.
        SCVTF_float_int | UCVTF_float_int => {
            fpa_guard(c);
            let wide = bit(i, 31);
            let unsigned = op == UCVTF_float_int;
            // f32.convert_i32_s 0xb2 … f64.convert_i64_u 0xba.
            let conv = match (f.d, wide) {
                (false, false) => 0xb2,
                (false, true) => 0xb4,
                (true, false) => 0xb7,
                (true, true) => 0xb9,
            } + unsigned as u8;
            get(c, wide, rn);
            c.op(conv);
            f.to_int(c);
            c.local_set(r);
            c.local_get(FPOK);
            guarded(c, cx, i, k, 0, |c| put(c, f, rd, r));
        }
        // SCVTF/UCVTF (scalar, the integer in Vn): as from a general register,
        // the integer as wide as the float.
        SCVTF_int_2 | UCVTF_int_2 => {
            fpa_guard(c);
            f.load(c, rn);
            // f32.convert_i32_s/u, f64.convert_i64_s/u.
            c.op(if f.d { 0xb9 } else { 0xb2 } + (op == UCVTF_int_2) as u8);
            f.to_int(c);
            c.local_set(r);
            c.local_get(FPOK);
            guarded(c, cx, i, k, 0, |c| put(c, f, rd, r));
        }
        // FCVTZS/FCVTZU to a general register (toward zero whatever FPCR
        // says): a normal operand whose integer part fits; the saturating
        // truncation never traps, and the check decides whether it's used.
        FCVTZS_float_int | FCVTZU_float_int => {
            fpa_guard(c);
            let (wide, unsigned) = (bit(i, 31), op == FCVTZU_float_int);
            f.load(c, rn);
            c.local_set(x);
            c.local_get(FPOK);
            exp_in(c, f, x, 1);
            c.op(AND);
            // The integer part fits: lo ≤ x (or lo < x) and x < hi, the bounds
            // exact in the operand's format. Signed: -2^(w-1) ≤ x, except a
            // double to 32 bits, where -2^31 - 1 < x is exact; unsigned: -1 < x.
            let w = if wide { 64 } else { 32 };
            let hi = 2f64.powi(if unsigned { w } else { w - 1 });
            let (lo, inclusive) = match (unsigned, f.d && !wide) {
                (true, _) => (-1.0, false),
                (false, true) => (-2147483649.0, false),
                (false, false) => (-hi, true),
            };
            // f32/f64 ge, gt, lt.
            let (ge, gt, lt) = if f.d {
                (0x66, 0x64, 0x63)
            } else {
                (0x60, 0x5e, 0x5d)
            };
            for (bound, cmp) in [(lo, if inclusive { ge } else { gt }), (hi, lt)] {
                c.local_get(x);
                f.to_float(c);
                if f.d {
                    c.f64_const(bound);
                } else {
                    c.f32_const(bound as f32);
                }
                c.op(cmp).op(AND);
            }
            // i32/i64.trunc_sat_f32/f64_s/u: 0xfc 0..7.
            let sat = (wide as u8) * 4 + (f.d as u8) * 2 + unsigned as u8;
            guarded(c, cx, i, k, xmask(rd), |c| {
                set(c, wide, rd, |c| {
                    c.local_get(x);
                    f.to_float(c);
                    c.op(0xfc).op(sat);
                });
            });
        }
        _ => return false,
    }
    true
}

// Vector FP (M6 loop 6): the same rules lane by lane; any lane off the fast
// path sends the whole instruction to the helper.

use super::VT;

/// SIMD opcodes (0xfd-prefixed).
mod op {
    pub const LOAD: u32 = 0x00;
    pub const AND: u32 = 0x4e;
    pub const OR: u32 = 0x50;
    pub const XOR: u32 = 0x51;
    pub const ANY_TRUE: u32 = 0x53;
    pub const I32X4_ALL_TRUE: u32 = 0xa3;
    pub const I64X2_ALL_TRUE: u32 = 0xc3;
    pub const I32X4_SHR_U: u32 = 0xad;
    pub const I32X4_SUB: u32 = 0xb1;
    pub const I32X4_LT_U: u32 = 0x3a;
    pub const I64X2_SHR_U: u32 = 0xcd;
    pub const I64X2_SUB: u32 = 0xd1;
    pub const I64X2_LT_S: u32 = 0xd8;
    pub const I64X2_EQ: u32 = 0xd6;
    /// f32x4 add, sub, mul, div; f64x2 likewise.
    pub const F32X4: [u32; 4] = [0xe4, 0xe5, 0xe6, 0xe7];
    pub const F64X2: [u32; 4] = [0xf0, 0xf1, 0xf2, 0xf3];
    pub const F32X4_NEG: u32 = 0xe1;
    pub const F32X4_GT: u32 = 0x44;
    pub const F32X4_LT: u32 = 0x43;
    pub const F32X4_GE: u32 = 0x46;
    pub const F32X4_SPLAT: u32 = 0x13;
    pub const TRUNC_SAT_F32X4: [u32; 2] = [0xf8, 0xf9];
    pub const CONVERT_I32X4: [u32; 2] = [0xfa, 0xfb];
    pub const DEMOTE: u32 = 0x5e;
    pub const PROMOTE: u32 = 0x5f;
    pub const I32X4_SHL: u32 = 0xab;
    pub const I32X4_ADD: u32 = 0xae;
    pub const I32X4_EQ: u32 = 0x37;
    pub const I32X4_NE: u32 = 0x38;
    pub const I32X4_LT_S: u32 = 0x39;
    pub const I32X4_GE_S: u32 = 0x3f;
    pub const I32X4_LE_S: u32 = 0x3d;
    pub const I64X2_LE_S: u32 = 0xda;
    pub const I64X2_GE_S: u32 = 0xdb;
    /// i32x4.extend_low/high_i16x8_u.
    pub const EXTEND_U16: [u32; 2] = [0xa9, 0xaa];
    pub const BITSELECT: u32 = 0x52;
    /// eq, lt, gt, le, ge: f32x4, f64x2.
    pub const CMP: [[u32; 5]; 2] = [
        [0x41, 0x43, 0x44, 0x45, 0x46],
        [0x47, 0x49, 0x4a, 0x4b, 0x4c],
    ];
    /// abs: f32x4, f64x2.
    pub const ABS: [u32; 2] = [0xe0, 0xec];
    /// nearest, floor, ceil, trunc: f32x4, f64x2.
    pub const ROUND: [[u32; 4]; 2] = [[0x6a, 0x68, 0x67, 0x69], [0x94, 0x75, 0x74, 0x7a]];
}

/// `x` in every 32-bit (`d` false) or 64-bit lane.
fn splat(d: bool, x: u64) -> u128 {
    if d {
        x as u128 | (x as u128) << 64
    } else {
        let x = x as u32 as u128;
        x | x << 32 | x << 64 | x << 96
    }
}

/// Replaces the v128 on the stack with a lane mask: all ones where the lane's
/// exponent field is in `lo`..all ones (1: normal; 2: a fast result).
fn lanes_in(c: &mut Func, d: bool, lo: u64) {
    if d {
        c.i32_const(52).simd(op::I64X2_SHR_U);
        c.v128_const(splat(true, 0x7ff)).simd(op::AND);
        c.v128_const(splat(true, lo)).simd(op::I64X2_SUB);
        // Unsigned `< 0x7ff - lo`, as signed with the sign bits flipped.
        let s = 1u64 << 63;
        c.v128_const(splat(true, s)).simd(op::XOR);
        c.v128_const(splat(true, (0x7ff - lo) ^ s))
            .simd(op::I64X2_LT_S);
    } else {
        c.i32_const(23).simd(op::I32X4_SHR_U);
        c.v128_const(splat(false, 0xff)).simd(op::AND);
        c.v128_const(splat(false, lo)).simd(op::I32X4_SUB);
        c.v128_const(splat(false, 0xff - lo)).simd(op::I32X4_LT_U);
    }
}

/// Pushes Vn.
fn vreg(c: &mut Func, n: u32) {
    c.local_get(VCPU).simd_mem(op::LOAD as u8, 0, V + 16 * n);
}

/// Vd = the v128 in local `l`, its top half cleared unless `q`.
fn vput(c: &mut Func, rd: u32, q: bool, l: u32) {
    c.local_get(VCPU).local_get(l);
    if !q {
        c.i64_const(0).simd_lane(0x1e, 1); // i64x2.replace_lane 1
    }
    c.simd_mem(11, 0, V + 16 * rd); // v128.store
}

/// Replaces the v128 on the stack with a lane mask: all ones where the lane is ±0.
fn zero_lanes(c: &mut Func, d: bool) {
    let sign = if d { 1u64 << 63 } else { 1 << 31 };
    c.v128_const(splat(d, !sign)).simd(op::AND).v128_const(0);
    c.simd(if d { op::I64X2_EQ } else { op::I32X4_EQ });
}

/// Replaces the v128 on the stack with a lane mask: all ones where the lane is
/// normal or ±0.
fn normal_or_zero(c: &mut Func, d: bool) {
    c.local_tee(VT[3]);
    lanes_in(c, d, 1);
    c.local_get(VT[3]);
    zero_lanes(c, d);
    c.simd(op::OR);
}

/// Replaces the v128 on the stack with a lane mask: all ones where the lane is
/// zero, normal or infinite (no NaN, no denormal: what FZ would flush).
fn plain_lanes(c: &mut Func, d: bool) {
    let tt = VT[3];
    let (sign, min, inf) = if d {
        (1u64 << 63, 1u64 << 52, 0x7ffu64 << 52)
    } else {
        (1 << 31, 1 << 23, 0xff << 23)
    };
    let (eq, ge, le) = if d {
        (op::I64X2_EQ, op::I64X2_GE_S, op::I64X2_LE_S)
    } else {
        (op::I32X4_EQ, op::I32X4_GE_S, op::I32X4_LE_S)
    };
    c.v128_const(splat(d, !sign)).simd(op::AND).local_tee(tt);
    c.v128_const(splat(d, min)).simd(ge);
    c.local_get(tt)
        .v128_const(splat(d, inf))
        .simd(le)
        .simd(op::AND);
    c.local_get(tt).v128_const(0).simd(eq).simd(op::OR);
}

/// ANDs lane masks into one i32 with FPOK: every lane of the masks all ones
/// (with Q = 0, lanes 2 and 3 of 32-bit masks don't count).
fn all_lanes(c: &mut Func, d: bool, q: bool, masks: usize) {
    every_lane(c, d, q, masks);
    c.local_get(FPOK).op(AND);
}

/// [`all_lanes`] without FPOK, for what neither rounds nor can be inexact.
fn every_lane(c: &mut Func, d: bool, q: bool, masks: usize) {
    for _ in 1..masks {
        c.simd(op::AND);
    }
    if !q && !d {
        c.v128_const(u128::MAX << 64).simd(op::OR);
    }
    c.simd(if d {
        op::I64X2_ALL_TRUE
    } else {
        op::I32X4_ALL_TRUE
    });
}

/// Emits vector FP instruction `i` inline if it's one this covers; false
/// (and nothing emitted) otherwise.
pub(super) fn vector(c: &mut Func, cx: &Ctx, i: u32, op: Op, k: usize) -> bool {
    use Op::*;
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let (q, d) = (bit(i, 30), bit(i, 22));
    if bit(i, 28) || (d && !q && !matches!(op, FCVTL | FCVTN)) {
        return false; // scalar forms; a vector of doubles needs Q
    }
    let [ta, tb, tr, tt] = VT;
    // The multiplier: Vm, or (by element) its lane `index` in every lane.
    let by_element = matches!(op, FMLA_elt_4 | FMLS_elt_4 | FMUL_elt_4);
    let index = if d {
        bit(i, 11) as u8
    } else {
        (bit(i, 11) as u8) << 1 | bit(i, 21) as u8
    };
    if by_element && d && bit(i, 21) {
        return false;
    }
    let factor = |c: &mut Func| {
        vreg(c, rm);
        if by_element {
            vreg(c, rm);
            let lb = if d { 8 } else { 4 };
            c.shuffle(core::array::from_fn(|b| index * lb + (b as u8 % lb)));
        }
    };
    match op {
        // FADD, FSUB (a = 1), FMUL, FDIV, and FMUL by element: the host's
        // lane operation, normal or zero operands (a normal divisor), and a
        // fast result or an exact zero: a zero sum is always exact, a zero
        // product or quotient when an operand is zero.
        FADD_2 | FSUB_2 | FMUL_vec_2 | FDIV_2 | FMUL_elt_4 => {
            if op == FMUL_elt_4 && bit(i, 29) {
                return false; // FMULX
            }
            fpa_guard(c);
            let kk = match op {
                FADD_2 => 0,
                FSUB_2 => 1,
                FDIV_2 => 3,
                _ => 2,
            };
            vreg(c, rn);
            factor(c);
            c.simd(if d { op::F64X2[kk] } else { op::F32X4[kk] })
                .local_set(tr);
            vreg(c, rn);
            normal_or_zero(c, d);
            factor(c);
            if kk == 3 {
                lanes_in(c, d, 1);
            } else {
                normal_or_zero(c, d);
            }
            c.local_get(tr);
            lanes_in(c, d, 2);
            if kk < 2 {
                c.local_get(tr);
            } else {
                vreg(c, rn);
            }
            zero_lanes(c, d);
            if kk == 2 {
                factor(c);
                zero_lanes(c, d);
                c.simd(op::OR);
            }
            c.simd(op::OR);
            all_lanes(c, d, q, 3);
            guarded(c, cx, i, k, 0, |c| vput(c, rd, q, tr));
        }
        // Fused, single precision (docs/jit.md "Floating point"): each half through f64x2,
        // t = a × b + d, a lane with t halfway between two singles to the helper.
        FMLA_vec_2 | FMLS_vec_2 | FMLA_elt_4 | FMLS_elt_4 if !d => {
            fpa_guard(c);
            let neg = matches!(op, FMLS_vec_2 | FMLS_elt_4);
            let halves: &[bool] = if q { &[false, true] } else { &[false] };
            for (&hi, &t) in halves.iter().zip(&[ta, tb]) {
                // promote(half of Vn (negated for FMLS)) × promote(half of the
                // factor) + promote(half of Vd).
                for step in 0..3 {
                    match step {
                        0 => vreg(c, rn),
                        1 => factor(c),
                        _ => vreg(c, rd),
                    }
                    if step == 0 && neg {
                        c.simd(op::F32X4_NEG);
                    }
                    if hi {
                        c.local_tee(tt).local_get(tt);
                        c.shuffle(core::array::from_fn(|b| 8 + b as u8 % 8));
                    }
                    c.simd(op::PROMOTE);
                    // × after the factor, + after the addend.
                    match step {
                        1 => c.simd(op::F64X2[2]),
                        2 => c.simd(op::F64X2[0]),
                        _ => c,
                    };
                }
                c.local_set(t);
            }
            // r = the demoted halves side by side.
            c.local_get(ta).simd(op::DEMOTE);
            if q {
                c.local_get(tb).simd(op::DEMOTE);
            } else {
                c.v128_const(0);
            }
            c.shuffle(core::array::from_fn(|b| {
                if b < 8 { b as u8 } else { 8 + b as u8 }
            }));
            c.local_set(tr);
            // Normal or zero operands; a fast result, or an exact zero (a zero
            // product and addend); then no midpoint (a zero t isn't one).
            vreg(c, rn);
            normal_or_zero(c, false);
            factor(c);
            normal_or_zero(c, false);
            vreg(c, rd);
            normal_or_zero(c, false);
            c.local_get(tr);
            lanes_in(c, false, 2);
            vreg(c, rn);
            zero_lanes(c, false);
            factor(c);
            zero_lanes(c, false);
            c.simd(op::OR);
            vreg(c, rd);
            zero_lanes(c, false);
            c.simd(op::AND).simd(op::OR);
            all_lanes(c, false, q, 4);
            for &t in &[ta, tb][..halves.len()] {
                c.local_get(t)
                    .v128_const(splat(true, 0x1fff_ffff))
                    .simd(op::AND);
                c.v128_const(splat(true, 0x1000_0000)).simd(op::I64X2_EQ);
                c.simd(op::ANY_TRUE).op(EQZ).op(AND);
            }
            guarded(c, cx, i, k, 0, |c| vput(c, rd, q, tr));
        }
        // SCVTF/UCVTF, 32-bit lanes: wasm's converts round to nearest even.
        SCVTF_int_4 | UCVTF_int_4 if !d => {
            fpa_guard(c);
            vreg(c, rn);
            c.simd(op::CONVERT_I32X4[(op == UCVTF_int_4) as usize])
                .local_set(tr);
            c.local_get(FPOK);
            guarded(c, cx, i, k, 0, |c| vput(c, rd, q, tr));
        }
        // FCVTZS/FCVTZU, 32-bit lanes: normal and in range, then truncated.
        FCVTZS_int_4 | FCVTZU_int_4 if !d => {
            fpa_guard(c);
            let u = op == FCVTZU_int_4;
            vreg(c, rn);
            c.simd(op::TRUNC_SAT_F32X4[u as usize]).local_set(tr);
            vreg(c, rn);
            lanes_in(c, false, 1);
            let (lo, lo_cmp) = if u {
                (-1.0f32, op::F32X4_GT)
            } else {
                (-2147483648.0, op::F32X4_GE)
            };
            let hi = if u { 4294967296.0f32 } else { 2147483648.0 };
            for (bound, cmp) in [(lo, lo_cmp), (hi, op::F32X4_LT)] {
                vreg(c, rn);
                c.f32_const(bound).simd(op::F32X4_SPLAT).simd(cmp);
            }
            all_lanes(c, false, q, 3);
            guarded(c, cx, i, k, 0, |c| vput(c, rd, q, tr));
        }
        // FABS, FNEG: bit operations, no flags.
        FABS_2 | FNEG_2 => {
            let sign = splat(d, if d { 1 << 63 } else { 1 << 31 });
            vreg(c, rn);
            if op == FNEG_2 {
                c.v128_const(sign).simd(op::XOR);
            } else {
                c.v128_const(!sign).simd(op::AND);
            }
            c.local_set(tr);
            vput(c, rd, q, tr);
        }
        // FCVTL(2), single to double (exact): normal operands. FCVTN(2),
        // double to single: normal operands, fast results. Half precision
        // (sz = 0) and FCVTXN stay helper calls.
        FCVTL | FCVTN if d && !bit(i, 29) => {
            fpa_guard(c);
            if op == FCVTL {
                vreg(c, rn);
                if q {
                    c.local_tee(tt).local_get(tt);
                    c.shuffle(core::array::from_fn(|b| 8 + b as u8 % 8));
                }
                c.local_tee(ta).simd(op::PROMOTE).local_set(tr);
                c.local_get(ta);
                lanes_in(c, false, 1);
                all_lanes(c, false, false, 1);
                guarded(c, cx, i, k, 0, |c| vput(c, rd, true, tr));
            } else {
                vreg(c, rn);
                c.simd(op::DEMOTE).local_set(ta);
                vreg(c, rn);
                lanes_in(c, true, 1);
                all_lanes(c, true, true, 1);
                c.local_get(ta);
                lanes_in(c, false, 2);
                all_lanes(c, false, false, 1);
                c.op(AND);
                // FCVTN2 keeps Vd's low half.
                if q {
                    vreg(c, rd);
                    c.local_get(ta);
                    c.shuffle(core::array::from_fn(|b| {
                        if b < 8 { b as u8 } else { 8 + b as u8 }
                    }));
                } else {
                    c.local_get(ta);
                }
                c.local_set(tr);
                guarded(c, cx, i, k, 0, |c| vput(c, rd, true, tr));
            }
        }
        // Compares: no NaN lanes, no denormal ones (FZ flushes them, raising
        // IDC); the host's compare gives the all-ones lanes. No rounding, so
        // no FPOK.
        FCMEQ_reg_4 | FCMGE_reg_4 | FCMGT_reg_4 | FACGE_4 | FACGT_4 | FCMEQ_zero_4
        | FCMGE_zero_4 | FCMGT_zero_4 | FCMLE_4 | FCMLT_4 => {
            let zero = !matches!(
                op,
                FCMEQ_reg_4 | FCMGE_reg_4 | FCMGT_reg_4 | FACGE_4 | FACGT_4
            );
            let abs = matches!(op, FACGE_4 | FACGT_4);
            // eq, lt, gt, le, ge
            let cmp = op::CMP[d as usize][match op {
                FCMEQ_reg_4 | FCMEQ_zero_4 => 0,
                FCMLT_4 => 1,
                FCMGT_reg_4 | FACGT_4 | FCMGT_zero_4 => 2,
                FCMLE_4 => 3,
                _ => 4,
            }];
            vreg(c, rn);
            if abs {
                c.simd(op::ABS[d as usize]);
            }
            if zero {
                c.v128_const(0);
            } else {
                vreg(c, rm);
                if abs {
                    c.simd(op::ABS[d as usize]);
                }
            }
            c.simd(cmp).local_set(tr);
            vreg(c, rn);
            plain_lanes(c, d);
            if !zero {
                vreg(c, rm);
                plain_lanes(c, d);
            }
            every_lane(c, d, q, if zero { 1 } else { 2 });
            guarded(c, cx, i, k, 0, |c| vput(c, rd, q, tr));
        }
        // FRINTN/M/P/Z, and FRINTI/X in the FPCR's mode (round to nearest
        // even under FPOK; FRINTX's Inexact is set already): no NaN or
        // denormal lanes. FRINTA (ties away) has no wasm op.
        FRINTN_2 | FRINTM_2 | FRINTP_2 | FRINTZ_2 | FRINTI_2 | FRINTX_2 => {
            let k_round = match op {
                FRINTM_2 => 1,
                FRINTP_2 => 2,
                FRINTZ_2 => 3,
                _ => 0,
            };
            let fpcr_mode = matches!(op, FRINTI_2 | FRINTX_2);
            if fpcr_mode {
                fpa_guard(c);
            }
            vreg(c, rn);
            c.simd(op::ROUND[d as usize][k_round]).local_set(tr);
            vreg(c, rn);
            plain_lanes(c, d);
            if fpcr_mode {
                all_lanes(c, d, q, 1);
            } else {
                every_lane(c, d, q, 1);
            }
            guarded(c, cx, i, k, 0, |c| vput(c, rd, q, tr));
        }
        // FCVTL(2), half to single: exact and without flags but for NaNs (FZ
        // doesn't apply to half precision); with an all-ones exponent excluded,
        // FPCR.AHP's format reads the same. The magnitude shifted into a single's fields is the
        // value × 2^-112 (denormals too), so a multiply by 2^112 converts it.
        FCVTL if !d => {
            vreg(c, rn);
            c.simd(op::EXTEND_U16[q as usize]).local_tee(ta);
            c.v128_const(splat(false, 0x7fff)).simd(op::AND);
            c.i32_const(13).simd(op::I32X4_SHL);
            c.v128_const(splat(false, 0x7780_0000)).simd(op::F32X4[2]); // × 2^112
            c.local_get(ta)
                .v128_const(splat(false, 0x8000))
                .simd(op::AND);
            c.i32_const(16)
                .simd(op::I32X4_SHL)
                .simd(op::OR)
                .local_set(tr);
            // No lane with an all-ones exponent (infinities are exact too,
            // but rare).
            c.local_get(ta)
                .v128_const(splat(false, 0x7c00))
                .simd(op::AND);
            c.v128_const(splat(false, 0x7c00)).simd(op::I32X4_NE);
            every_lane(c, false, true, 1);
            guarded(c, cx, i, k, 0, |c| vput(c, rd, true, tr));
        }
        // FCVTN(2), single to half: zero lanes, or normal ones from the half's
        // smallest normal binade up whose rounded result is finite (so no
        // Underflow, Overflow or IDC, and AHP's format gives the same bits),
        // rounded to nearest even in integer arithmetic.
        FCVTN if !d && !bit(i, 29) => {
            fpa_guard(c);
            vreg(c, rn);
            c.v128_const(splat(false, 0x7fff_ffff))
                .simd(op::AND)
                .local_tee(ta);
            // h = (a + 0xfff + (a >> 13 & 1)) >> 13, rebiased.
            c.local_get(ta).i32_const(13).simd(op::I32X4_SHR_U);
            c.v128_const(splat(false, 1))
                .simd(op::AND)
                .simd(op::I32X4_ADD);
            c.v128_const(splat(false, 0xfff)).simd(op::I32X4_ADD);
            c.i32_const(13).simd(op::I32X4_SHR_U);
            c.v128_const(splat(false, 112 << 10))
                .simd(op::I32X4_SUB)
                .local_set(tb);
            // r = (a == 0 ? 0 : h) | sign
            c.v128_const(0).local_get(tb);
            c.local_get(ta)
                .v128_const(0)
                .simd(op::I32X4_EQ)
                .simd(op::BITSELECT);
            vreg(c, rn);
            c.i32_const(16).simd(op::I32X4_SHR_U);
            c.v128_const(splat(false, 0x8000))
                .simd(op::AND)
                .simd(op::OR)
                .local_set(tr);
            // valid: a == 0, or a >= 2^-14 and h < 0x7c00 (signed: a's sign is clear).
            c.local_get(ta)
                .v128_const(splat(false, 113 << 23))
                .simd(op::I32X4_GE_S);
            c.local_get(tb)
                .v128_const(splat(false, 0x7c00))
                .simd(op::I32X4_LT_S);
            c.simd(op::AND);
            c.local_get(ta)
                .v128_const(0)
                .simd(op::I32X4_EQ)
                .simd(op::OR);
            all_lanes(c, false, true, 1);
            // The halves' low 16 bits, into Vd's low half (top cleared) or,
            // FCVTN2, its top half (the low half kept).
            let low: [u8; 8] = core::array::from_fn(|b| (b as u8 / 2) * 4 + b as u8 % 2);
            if q {
                vreg(c, rd);
                c.local_get(tr);
                c.shuffle(core::array::from_fn(|b| {
                    if b < 8 { b as u8 } else { 16 + low[b - 8] }
                }));
            } else {
                c.local_get(tr).v128_const(0);
                c.shuffle(core::array::from_fn(|b| if b < 8 { low[b] } else { 16 }));
            }
            c.local_set(tr);
            guarded(c, cx, i, k, 0, |c| vput(c, rd, true, tr));
        }
        _ => return false,
    }
    true
}
