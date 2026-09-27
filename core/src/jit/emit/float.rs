//! Scalar floating point on the fast paths PLAN.md §2 "FP semantics"
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
    c.if_();
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
        // two singles. Double precision stays a helper call (PLAN.md §2).
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
