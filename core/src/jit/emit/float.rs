//! Scalar floating point on the fast paths docs/jit.md "Floating point"
//! describes (M6 loop 5): under the block's FP guard (FPCR.RMode round to
//! nearest even, FPCR.FZ clear, FPSR.IXC set already: [`fpa_guard`]), with a
//! result that is normal and above the smallest normal binade, the host's IEEE
//! operation gives the interpreter's result and leaves FPSR as it is.
//! Anything else runs the helper. FABS and FNEG are bit operations, inline
//! always. Operands are the V registers' low 32 or 64 bits ([`Func::vlane`]),
//! results go back zero-extended. Callers run [`super::fp_guard`] first.

use core::mem::offset_of;

use super::{
    AND, Ctx, EQZ, FPOK, FZOK, Func, Kind, LT_U, NZCV, Regs, SHR_U, SUB, VCPU, W, WC, XOR, cond,
    fallback, fallback_with, flag_locals, get, set, vbit, xmask,
};
use crate::cpu::Cpu;
use crate::decode::Op;
use crate::interp::{bit, bits};

/// FPSR.IXC.
const IXC: i64 = 16;

/// Before a block's first FP instruction on a fast path: FPOK = FPCR.RMode is
/// round to nearest even and FPSR.IXC is set, and FZOK = FPCR.FZ is clear.
/// They hold for the rest of the block (an MSR, which ends it, is the only
/// thing that changes them). Without FZ, the host's IEEE operations take
/// denormal operands as ARM does (exactly, and with no IDC), and a NaN or
/// infinite operand makes the result a NaN or infinite, which the result
/// checks reject: the fast paths test results, and operands only under FZ
/// ([`under_fz`]; docs/jit.md "Floating point"). Emitted outside any branch.
pub(super) fn fpa_guard(c: &mut Func) {
    if c.fpa_ok {
        return;
    }
    c.fpa_ok = true;
    let (fpcr, fpsr) = (offset_of!(Cpu, fpcr) as u32, offset_of!(Cpu, fpsr) as u32);
    c.local_get(VCPU)
        .i64_load(fpcr)
        .i64_const(1 << 24)
        .i64_and()
        .op(EQZ + WC)
        .local_set(FZOK);
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
        c.vlane(n, self.esize(), 0);
    }
    fn esize(self) -> u32 {
        if self.d { 64 } else { 32 }
    }
    /// Reinterprets the integer on the stack as this format's float, or back.
    fn to_float(self, c: &mut Func) {
        c.op(if self.d { 0xbf } else { 0xbe });
    }
    fn to_int(self, c: &mut Func) {
        c.op(if self.d { 0xbd } else { 0xbc });
    }
    /// The float opcode of `op`: 0 add, 1 sub, 2 mul, 3 div, 4 min, 5 max; sqrt, neg.
    fn arith(self, k: u8) -> u8 {
        if self.d { 0xa0 + k } else { 0x92 + k }
    }
    fn sqrt(self) -> u8 {
        if self.d { 0x9f } else { 0x91 }
    }
    fn neg(self) -> u8 {
        if self.d { 0x9a } else { 0x8c }
    }
    /// nearest, floor, ceil, trunc.
    fn round(self, k: u8) -> u8 {
        let b = if self.d { 0x9e } else { 0x90 };
        [b, b - 2, b - 3, b - 1][k as usize]
    }
    /// Pushes this format's +0 as an integer.
    fn zero(self, c: &mut Func) {
        if self.d {
            c.i64_const(0);
        } else {
            c.i32_const(0);
        }
    }
    /// Pushes an i32: the floats in integer locals `x` and `y` compare
    /// `k`: 0 equal, 1 less, 2 greater, 3 less or equal, 4 greater or equal.
    fn compare(self, c: &mut Func, x: u32, y: u32, k: u8) {
        c.local_get(x);
        self.to_float(c);
        c.local_get(y);
        self.to_float(c);
        c.op(if self.d { 0x61 } else { 0x5b } + [0, 2, 3, 4, 5][k as usize]);
    }
    /// Pushes an i32: either float in integer locals `x` and `y` is a NaN.
    fn unordered(self, c: &mut Func, x: u32, y: u32) {
        let ne = if self.d { 0x62 } else { 0x5c };
        for l in [x, y] {
            c.local_get(l);
            self.to_float(c);
            c.local_get(l);
            self.to_float(c);
            c.op(ne);
        }
        c.op(0x72); // i32.or
    }
    /// Scratch local `k` of this format's integer width.
    fn tmp(self, k: u32) -> u32 {
        super::tmp(self.d, k)
    }
}

/// Pushes an i32: the float bits in local `l` have their exponent field in
/// `lo..max` (normal: 1..all ones; a fast result: 2..all ones): the bits
/// shifted left once (the sign gone, the exponent on top) less `lo`'s,
/// unsigned below the range's length.
fn exp_in(c: &mut Func, f: F, l: u32, lo: i64) {
    let (sh, ones) = f.exp();
    let sh = sh + 1;
    c.local_get(l);
    if f.d {
        c.i64_const(1).op(0x86); // i64.shl
        c.i64_const(lo << sh)
            .op(SUB + W)
            .i64_const((ones - lo) << sh)
            .op(LT_U + WC);
    } else {
        c.i32_const(1).op(0x74); // i32.shl
        c.i32_const((lo << sh) as i32)
            .op(SUB)
            .i32_const(((ones - lo) << sh) as i32)
            .op(LT_U);
    }
}

/// Vd = the integer in local `r` of format `f`, zero-extended to 128 bits.
fn put(c: &mut Func, f: F, rd: u32, r: u32) {
    c.vset_scalar(rd, f.esize(), |c| {
        c.local_get(r);
    });
}

/// `if cond { fast } else { the helper runs instruction i }`, with `cond` an
/// i32 already on the stack.
fn guarded(c: &mut Func, cx: &Ctx, i: u32, k: usize, written: u64, fast: impl FnOnce(&mut Func)) {
    c.hint(true).if_();
    let before: Regs = c.regs;
    fast(c);
    fallback(c, cx, i, 4 * k as i64, before, written);
}

/// [`guarded`] with hooks around the helper call ([`super::fallback_with`]).
#[allow(clippy::too_many_arguments)]
fn guarded_with(
    c: &mut Func,
    cx: &Ctx,
    i: u32,
    k: usize,
    written: u64,
    fast: impl FnOnce(&mut Func),
    pre: impl FnOnce(&mut Func),
    post: impl FnOnce(&mut Func),
) {
    c.hint(true).if_();
    let before: Regs = c.regs;
    fast(c);
    fallback_with(c, cx, i, 4 * k as i64, before, written, pre, post);
}

/// Pushes an i32: the float bits in local `l` aren't a NaN (`nan`: or are a
/// quiet one, when `quiet`), nor, under FZ ([`under_fz`]), a denormal (FZ
/// would flush it, raising IDC).
fn scalar_plain(c: &mut Func, f: F, l: u32, nan: bool, quiet: bool) {
    fpa_guard(c);
    let (w, wc) = if f.d { (W, WC) } else { (0, 0) };
    let (sign, inf, qbit) = if f.d {
        (1u64 << 63, 0x7ffu64 << 52, 1u64 << 51)
    } else {
        (1 << 31, 0xff << 23, 1 << 22)
    };
    let k = |c: &mut Func, v: u64| {
        if f.d {
            c.i64_const(v as i64);
        } else {
            c.i32_const(v as i32);
        }
    };
    // |x| ≤ ∞: no NaN.
    c.local_get(l);
    k(c, !sign);
    c.op(AND + w);
    k(c, inf);
    c.op(0x4d + wc); // le_u
    if nan && quiet {
        // Or the quiet bit set.
        c.local_get(l);
        k(c, qbit);
        c.op(AND + w).op(EQZ + wc).op(EQZ);
        c.op(0x72); // i32.or
    } else if nan {
        c.op(0x1a).i32_const(1); // drop: any NaN
    }
    under_fz(c, |c| no_denormal(c, f, &[l]));
}

/// ANDs the operand test `test` pushes (an i32: no operand FZ would flush)
/// into the i32 on the stack, run only when FPCR.FZ is set (FZOK clear; a
/// branch the block takes the same way every time). `test` may only read
/// what the instruction read before it (a register's first read in a branch
/// would leave its local unset on the other path).
fn under_fz(c: &mut Func, test: impl FnOnce(&mut Func)) {
    c.local_get(FZOK).if_t(super::I32);
    c.i32_const(1);
    c.else_();
    test(c);
    c.end();
    c.op(AND);
}

/// [`under_fz`] for lane masks: clears the lanes of the mask `test` pushes
/// (the lanes FZ would flush: [`denormal_any`]) in the one on the stack,
/// none without FZ, so one reduction tests both. The mask goes through VTMP,
/// so without FZ it costs no lane op (an `andnot` of a zero did: SIMD ops
/// are what the FP paths are bound by, bench/interp/REPORT.md "M8: the FP
/// fast paths' SIMD ops").
fn under_fz_bad(c: &mut Func, test: impl FnOnce(&mut Func)) {
    c.local_set(VTMP);
    c.local_get(FZOK).if_t(super::V128);
    c.local_get(VTMP);
    c.else_();
    c.local_get(VTMP);
    test(c);
    c.simd(op::ANDNOT);
    c.end();
}

/// Pushes a lane mask: all ones where a lane of any of the v128s `xs` push is
/// a denormal. A lane's bits shifted left once (the sign gone) less one, as an
/// integer, are below the smallest normal's so shifted less one, unsigned (a
/// zero wraps to all ones): singles take the lanes' unsigned minimum over the
/// operands before one compare; doubles (no 64-bit unsigned minimum) compare
/// each, signed with the sign bits flipped (the flip folded into the
/// subtraction's constant). Two ops a single (with a `min_u` per operand past
/// the first), three a double, where an `and`, a subtraction and a compare
/// (and doubles' flip) each took one more, and a constant each (V8
/// rematerializes one per use: a `movi`, a SIMD op too).
fn denormal_any(c: &mut Func, d: bool, xs: &[&dyn Fn(&mut Func)]) {
    let s = 1u64 << 63;
    for (k, x) in xs.iter().enumerate() {
        x(c);
        if d {
            c.i32_const(1).simd(op::I64X2_SHL);
            c.v128_const(splat(true, 1 ^ s)).simd(op::I64X2_SUB);
            c.v128_const(splat(true, ((1u64 << 53) - 1) ^ s))
                .simd(op::I64X2_LT_S);
            if k > 0 {
                c.simd(op::OR);
            }
        } else {
            c.i32_const(1).simd(op::I32X4_SHL);
            c.v128_const(splat(false, 1)).simd(op::I32X4_SUB);
            if k > 0 {
                c.simd(op::I32X4_MIN_U);
            }
        }
    }
    if !d {
        c.v128_const(splat(false, (1 << 24) - 1))
            .simd(op::I32X4_LT_U);
    }
}

/// Pushes an i32: the float bits in local `l` are a denormal: |x| - 1, as an
/// integer, below the smallest normal's - 1, unsigned.
fn scalar_denormal(c: &mut Func, f: F, l: u32) {
    c.local_get(l);
    if f.d {
        c.i64_const(i64::MAX).op(AND + W).i64_const(1).op(SUB + W);
        c.i64_const((1 << 52) - 1).op(LT_U + WC);
    } else {
        c.i32_const(i32::MAX).op(AND).i32_const(1).op(SUB);
        c.i32_const((1 << 23) - 1).op(LT_U);
    }
}

/// Pushes an i32: none of the float bits in locals `ls` are a denormal.
fn no_denormal(c: &mut Func, f: F, ls: &[u32]) {
    for (k, &l) in ls.iter().enumerate() {
        scalar_denormal(c, f, l);
        if k > 0 {
            c.op(0x72); // i32.or
        }
    }
    c.op(EQZ);
}

/// Pushes an i32: the float bits in local `l` are ±0.
fn is_zero(c: &mut Func, f: F, l: u32) {
    c.local_get(l);
    if f.d {
        c.i64_const(1).op(0x86).op(EQZ + WC); // i64.shl
    } else {
        c.i32_const(1).op(0x74).op(EQZ); // i32.shl
    }
}

/// f64 add, sub, mul.
const F_ADD: u8 = 0xa0;
const F_SUB: u8 = 0xa1;
const F_MUL: u8 = 0xa2;

/// A double's bits below a single's last place, and their value on a
/// single's midpoint. Single FMA: RN32(RN64(a·b + c)), the product exact,
/// rounds twice but correctly unless the double sum is a single midpoint
/// (docs/jit.md "Floating point"); there the sum is rounded to odd instead.
const MID_MASK: i64 = (1 << 29) - 1;
const MID: i64 = 1 << 28;

/// TwoSum of f64 locals `u` and `w` (Knuth): s = RN(u + w) into local `s`,
/// and pushes the error, u + w - s exactly: (u - (s - bb)) + (w - bb), bb = s - u.
fn two_sum(c: &mut Func, u: u32, w: u32, s: u32, bb: u32) {
    c.local_get(u).local_get(w).op(F_ADD).local_tee(s);
    c.local_get(u).op(F_SUB).local_set(bb);
    c.local_get(u)
        .local_get(s)
        .local_get(bb)
        .op(F_SUB)
        .op(F_SUB);
    c.local_get(w).local_get(bb).op(F_SUB).op(F_ADD);
}

/// Pops the error [`two_sum`] pushed (into f64 local `e`) and pushes the
/// bits of the sum, in f64 local `s`, rounded to odd (`sb` an i64 scratch):
/// s, or (inexact and s even) s's other neighbour, toward the error: s's
/// bits ± 1, + when the signs agree.
fn to_odd(c: &mut Func, s: u32, e: u32, sb: u32) {
    c.local_set(e);
    c.local_get(s).op(0xbd).local_tee(sb); // i64.reinterpret
    c.local_get(sb).local_get(e).op(0xbd).op(XOR + W);
    c.i64_const(63).op(0x87).i64_const(1).op(0x84); // i64.shr_s, i64.or
    c.i64_const(0);
    // f64.abs, f64.gt: inexact (false for a NaN error, an overflowed sum's:
    // s infinite, which stepping toward a NaN's host-dependent sign could
    // turn into the largest finite double).
    c.local_get(e).op(0x99).f64_const(0.0).op(0x64);
    c.local_get(sb)
        .op(0xa7)
        .i32_const(1)
        .op(AND)
        .op(EQZ)
        .op(AND); // and even
    c.op(0x1b).op(0x7c); // select, i64.add
}

/// A rounding to integral: FPCR's (nearest even, under FPOK), toward -∞, +∞
/// or zero, or to nearest with ties away (FRINTA, FCVTA*).
#[derive(Clone, Copy, PartialEq)]
enum Round {
    Nearest,
    Floor,
    Ceil,
    Trunc,
    Away,
}

/// Pushes the float in integer local `x` (format `f`) rounded to integral by
/// `mode`, as an `f`. Ties away (no wasm op): t = trunc(x), and t + copysign(1,
/// x) where |x - t| ≥ 0.5 (both exact: for singles in f64), else t (keeping
/// -0); for an infinity the difference is a NaN and t stays.
fn round(c: &mut Func, f: F, x: u32, mode: Round) {
    let promote = |c: &mut Func| {
        c.local_get(x);
        f.to_float(c);
        if !f.d {
            c.op(0xbb); // f64.promote_f32
        }
    };
    if mode != Round::Away {
        c.local_get(x);
        f.to_float(c);
        c.op(f.round(match mode {
            Round::Floor => 1,
            Round::Ceil => 2,
            Round::Trunc => 3,
            _ => 0,
        }));
        return;
    }
    let t = super::FT[0];
    promote(c);
    c.op(0x9d).local_tee(t); // f64.trunc
    c.f64_const(1.0);
    promote(c);
    c.op(0xa6).op(0xa0); // f64.copysign, f64.add
    c.local_get(t);
    promote(c);
    c.local_get(t).op(0xa1).op(0x99); // f64.sub, f64.abs
    c.f64_const(0.5).op(0x66); // f64.ge
    c.select();
    if !f.d {
        c.op(0xb6); // f32.demote_f64 (exact: an integer below 2^25)
    }
}

/// FRECPE (`rsqrt` false) or FRSQRTE of the float bits in local `x` (format
/// `f`) into local `r` (of `f`'s width), pushing an i32: the operand is one the
/// estimate takes without flags. FRECPE: a normal operand below the FZ range
/// (|x| < 2^126, 2^1022), so the result is normal; FRSQRTE: a positive normal
/// one. Then the ARM ARM's estimates (without FEAT_RPRES), in i32 arithmetic:
/// FRECPE's b = 2^19 / (2a + 1) for the 9-bit a = 1:fraction<F-1:F-8>, and
/// exponent 2·bias - 1 - e; FRSQRTE's least b ≥ 512 with a·(b + 1)² ≥ 2^28,
/// which is ceil(√(2^28 / a)) - 1 (the root of a non-square, at least ~2^-22
/// from an integer: f64's √ decides it), its a 2·(a & !1) + 2 or 2a + 1 by the
/// exponent's parity, and exponent (3·bias - 1 - e) / 2. The 8-bit estimate
/// (b + 1) / 2 is the fraction's top. Scratch: i32 `tmp(false, 1..=3)` (`x`
/// may be a single's `tmp(false, 0)`, `r` its `tmp(false, 3)`), FT[0].
fn estimate(c: &mut Func, f: F, x: u32, r: u32, rsqrt: bool) {
    let (sh, ones) = f.exp();
    let (e, s8, v) = (
        super::tmp(false, 1),
        super::tmp(false, 2),
        super::tmp(false, 3),
    );
    let w = if f.d { W } else { 0 };
    // Pushes (x >> k) as an i32.
    let field = |c: &mut Func, k: i64| {
        c.local_get(x);
        if f.d {
            c.i64_const(k).op(SHR_U + W).op(0xa7); // i32.wrap_i64
        } else {
            c.i32_const(k as i32).op(SHR_U);
        }
    };
    field(c, sh);
    c.i32_const(ones as i32).op(AND).local_set(e);
    if !rsqrt {
        field(c, sh - 8);
        c.i32_const(0xff).op(AND).i32_const(0x100).op(0x72); // i32.or
        c.i32_const(1).op(0x74).i32_const(1).op(0x72).local_set(s8); // 2a + 1
        c.i32_const(1 << 19).local_get(s8).op(0x6e); // i32.div_u (a ≥ 513)
    } else {
        // Odd exponent: 2a + 1 for a = 01:fraction<F-1:F-7>; even: 2·(a & !1) + 2 for 1:fraction<F-1:F-8>.
        field(c, sh - 7);
        c.i32_const(0x7f).op(AND).i32_const(0x80).op(0x72);
        c.i32_const(1).op(0x74).i32_const(1).op(0x72);
        field(c, sh - 8);
        c.i32_const(0xfe).op(AND).i32_const(0x100).op(0x72);
        c.i32_const(1).op(0x72).i32_const(1).op(0x74);
        c.local_get(e).i32_const(1).op(AND);
        c.select();
        // b = max(512, ceil(√(2^28 / a)) - 1)
        c.op(0xb8); // f64.convert_i32_u
        c.local_set(super::FT[0]);
        c.f64_const(268435456.0).local_get(super::FT[0]).op(0xa3); // f64.div
        c.op(0x9f).op(0x9b).f64_const(1.0).op(F_SUB); // f64.sqrt, f64.ceil
        c.f64_const(512.0).op(0xa5); // f64.max
        c.op(0xfc).op(3); // i32.trunc_sat_f64_u
    }
    // The estimate: ((b + 1) >> 1) & 0xff, into s8.
    c.i32_const(1).op(0x6a).i32_const(1).op(SHR_U);
    c.i32_const(0xff).op(AND).local_set(s8);
    // The exponent, into v.
    let bias = (ones >> 1) as i32;
    if rsqrt {
        c.i32_const(3 * bias - 1)
            .local_get(e)
            .op(SUB)
            .i32_const(1)
            .op(SHR_U);
    } else {
        c.i32_const(2 * bias - 1).local_get(e).op(SUB);
    }
    c.local_set(v);
    // r = sign (FRECPE) | v << F | s8 << (F - 8), in f's width.
    let widen = |c: &mut Func, l: u32, k: i64| {
        c.local_get(l);
        if f.d {
            c.op(0xad).i64_const(k).op(0x86); // i64.extend_i32_u, i64.shl
        } else {
            c.i32_const(k as i32).op(0x74);
        }
    };
    widen(c, v, sh);
    widen(c, s8, sh - 8);
    let or = 0x72 + if f.d { 0x12 } else { 0 };
    c.op(or);
    if !rsqrt {
        c.local_get(x);
        if f.d {
            c.i64_const(i64::MIN);
        } else {
            c.i32_const(i32::MIN);
        }
        c.op(AND + w).op(or);
    }
    c.local_set(r);
    // The operand check.
    if rsqrt {
        // Positive normal: x - min_normal < (all-ones exponent - 1) << F, unsigned.
        c.local_get(x);
        if f.d {
            c.i64_const(1 << 52)
                .op(SUB + W)
                .i64_const(0x7fe << 52)
                .op(LT_U + WC);
        } else {
            c.i32_const(1 << 23).op(SUB).i32_const(0xfe << 23).op(LT_U);
        }
    } else {
        // 1 ≤ e < 2·bias - 1 (2^126 and up is FZ's flush range).
        c.local_get(e)
            .i32_const(1)
            .op(SUB)
            .i32_const(2 * bias - 2)
            .op(LT_U);
    }
}

/// FCVTXN's rounding: the double in i64 local `x` to a single rounded to
/// odd, into i32 local `r`; pushes an i32, the RNE demote's exponent from
/// the second binade up and finite (then neither rounding over- or
/// underflows). Inexact (the demote's double isn't x), it steps the bits
/// toward zero where the demote went away from it, then sets the odd bit.
fn to_odd_single(c: &mut Func, x: u32, r: u32) {
    let rne = super::tmp(false, 2);
    c.local_get(x).op(0xbf).op(0xb6).op(0xbc).local_set(rne); // f64.reinterpret, f32.demote, i32.reinterpret
    // (rne - away) | 1, or rne where exact.
    c.local_get(rne);
    c.local_get(rne).op(0xbe).op(0xbb).op(0x99); // |promote(rne)|
    c.local_get(x).op(0xbf).op(0x99).op(0x64); // > |x|: f64.gt
    c.op(SUB).i32_const(1).op(0x72); // i32.or
    c.local_get(rne);
    c.local_get(rne).op(0xbe).op(0xbb);
    c.local_get(x).op(0xbf).op(0x62); // f64.ne: inexact
    c.select().local_set(r);
    exp_in(c, F { d: false }, rne, 2);
}

/// FCVT to or from half precision (scalar). Half to single or double is exact
/// without flags but for an all-ones exponent (infinities and NaNs; FZ
/// doesn't apply to half, and without that exponent FPCR.AHP's format reads
/// the same): the magnitude shifted into a single's fields is the value ×
/// 2^-112, denormals too. Single or double to half rounds to nearest even in
/// integer arithmetic, straight from the operand's fraction (no double
/// rounding), under FPOK, for a zero or an operand from the half's smallest
/// normal binade up whose result is finite (no Underflow, Overflow or IDC).
fn fcvt_half(c: &mut Func, cx: &Ctx, i: u32, k: usize) -> bool {
    let (rd, rn) = (bits(i, 4, 0), bits(i, 9, 5));
    let to = match bits(i, 16, 15) {
        0 => Some(F { d: false }),
        1 => Some(F { d: true }),
        3 => None,
        _ => return false,
    };
    let from = match bits(i, 23, 22) {
        0 => Some(F { d: false }),
        1 => Some(F { d: true }),
        3 => None,
        _ => return false,
    };
    match (from, to) {
        (None, Some(t)) => {
            let (h, r32) = (super::tmp(false, 0), super::tmp(false, 3));
            c.vlane(rn, 32, 0);
            c.i32_const(0xffff).op(AND).local_tee(h);
            c.i32_const(0x7fff).op(AND).i32_const(13).op(0x74); // i32.shl
            c.op(0xbe).f32_const(f32::from_bits(0x7780_0000)).op(0x94); // × 2^112
            c.op(0xbc).local_get(h).i32_const(0x8000).op(AND);
            c.i32_const(16).op(0x74).op(0x72).local_set(r32); // sign: i32.shl, i32.or
            c.local_get(h)
                .i32_const(0x7c00)
                .op(AND)
                .i32_const(0x7c00)
                .op(0x47); // i32.ne
            if t.d {
                let r64 = super::tmp(true, 3);
                guarded(c, cx, i, k, vbit(rd), |c| {
                    c.local_get(r32).op(0xbe).op(0xbb).op(0xbd).local_set(r64);
                    put(c, t, rd, r64);
                });
            } else {
                guarded(c, cx, i, k, vbit(rd), |c| put(c, t, rd, r32));
            }
        }
        (Some(f), None) => {
            fpa_guard(c);
            // a = |x|; h = (a + half - 1 + (a >> s & 1)) >> s, rebiased (s: the
            // fraction bits the half drops); r = (a == 0 ? 0 : h) | sign.
            let (s, bias, min) = if f.d {
                (42, (1023 - 15) << 10, (1023 - 14) << 52)
            } else {
                (13, (127 - 15) << 10, (127 - 14) << 23)
            };
            let (w, wc) = if f.d { (W, WC) } else { (0, 0) };
            let (a, hh, r32) = (f.tmp(0), f.tmp(1), super::tmp(false, 3));
            let kk = |c: &mut Func, v: i64| {
                if f.d {
                    c.i64_const(v);
                } else {
                    c.i32_const(v as i32);
                }
            };
            f.load(c, rn);
            kk(c, if f.d { i64::MAX } else { 0x7fff_ffff });
            c.op(AND + w).local_tee(a);
            kk(c, (1 << (s - 1)) - 1);
            c.op(0x6a + if f.d { 0x12 } else { 0 }); // add
            c.local_get(a);
            kk(c, s);
            c.op(SHR_U + w);
            kk(c, 1);
            c.op(AND + w).op(0x6a + if f.d { 0x12 } else { 0 });
            kk(c, s);
            c.op(SHR_U + w);
            kk(c, bias);
            c.op(SUB + w).local_set(hh);
            // r = (a == 0 ? 0 : h) | sign, as an i32.
            let wrap = |c: &mut Func| {
                if f.d {
                    c.op(0xa7); // i32.wrap_i64
                }
            };
            c.i32_const(0);
            c.local_get(hh);
            wrap(c);
            c.local_get(a).op(EQZ + wc);
            c.select();
            f.load(c, rn);
            kk(c, if f.d { 48 } else { 16 });
            c.op(SHR_U + w);
            wrap(c);
            c.i32_const(0x8000).op(AND).op(0x72).local_set(r32); // i32.or
            // valid: FPOK, and a == 0 or (a from the smallest normal half up and h < 0x7c00).
            c.local_get(FPOK);
            c.local_get(a);
            kk(c, min);
            c.op(0x4f + wc); // ge_u (a's sign is clear)
            c.local_get(hh);
            kk(c, 0x7c00);
            c.op(LT_U + wc).op(AND);
            c.local_get(a).op(EQZ + wc).op(0x72).op(AND); // i32.or
            guarded(c, cx, i, k, vbit(rd), |c| put(c, F { d: false }, rd, r32));
        }
        _ => return false,
    }
    true
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
    if op == FCVT_float && (bits(i, 23, 22) == 3 || bits(i, 16, 15) == 3) {
        return fcvt_half(c, cx, i, k);
    }
    // The AdvSIMD scalar forms take their size from bit 22 (23 is the opcode's).
    let simd = matches!(
        op,
        FCMEQ_reg_2
            | FCMGE_reg_2
            | FCMGT_reg_2
            | FACGE_2
            | FACGT_2
            | FCMEQ_zero_2
            | FCMGE_zero_2
            | FCMGT_zero_2
            | FCMLE_2
            | FCMLT_2
            | FCVTNS_2
            | FCVTNU_2
            | FCVTMS_2
            | FCVTMU_2
            | FCVTAS_2
            | FCVTAU_2
            | FCVTPS_2
            | FCVTPU_2
            | FCVTZS_int_2
            | FCVTZU_int_2
            | FCVTXN_1
            | FRECPX_2
            | FRECPE_2
            | FRSQRTE_2
    );
    let f = match (simd, bits(i, 23, 22)) {
        (true, _) => F { d: bit(i, 22) },
        (_, 0) => F { d: false },
        (_, 1) => F { d: true },
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
            // The operands as floats; their bits (x, y) are read again only
            // where a test needs them, in branches: lane ops are what these
            // paths are bound by (bench/interp/REPORT.md "M8: the FP fast
            // paths' SIMD ops").
            c.vlanef(rn, f.esize());
            if op == FSQRT_float {
                c.op(f.sqrt());
            } else {
                c.vlanef(rm, f.esize());
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
            // FPOK, then FSQRT: a fast result (√ of a negative is a NaN); the
            // rest: a fast result or an exact zero: a zero sum is always exact
            // (a nonzero exact sum rounds to a nonzero result), a zero product
            // or quotient only with a zero operand (the dividend), tested
            // when the result is zero. A zero divisor needs no test: x / 0 is
            // infinite and 0 / 0 a NaN.
            // Pushes an i32 (a test of the operands' bits, `x` and `y`: just
            // Vn's, `one`), the bits loaded first.
            let bits = |c: &mut Func, one: bool, test: &dyn Fn(&mut Func, &[u32])| {
                let ops = [(x, rn), (y, rm)];
                let ops = &ops[..if one { 1 } else { 2 }];
                for &(l, n) in ops {
                    f.load(c, n);
                    c.local_set(l);
                }
                test(c, &[x, y][..ops.len()]);
            };
            c.local_get(FPOK);
            exp_in(c, f, r, 2);
            if op != FSQRT_float {
                is_zero(c, f, r);
                if !matches!(op, FADD_float | FSUB_float) {
                    c.hint(false).if_t(super::I32);
                    bits(c, op == FDIV_float, &|c, ls| {
                        for (k, &l) in ls.iter().enumerate() {
                            is_zero(c, f, l);
                            if k > 0 {
                                c.op(0x72); // i32.or
                            }
                        }
                    });
                    c.else_().i32_const(0).end();
                }
                c.op(0x72); // i32.or
            }
            c.op(AND);
            under_fz(c, |c| {
                bits(c, op == FSQRT_float, &|c, ls| no_denormal(c, f, ls));
            });
            guarded(c, cx, i, k, vbit(rd), |c| put(c, f, rd, r));
        }
        // FMA: the exact product, its sum with the addend rounded to odd, then
        // the final rounding (docs/jit.md "Floating point"). Single precision:
        // the product is exact in double, and RN32 of the double sum rounded to
        // odd is correct (53 ≥ 24 + 2 bits). Double precision: Boldo and
        // Melquiond's emulated FMA, p + pl = a·b exactly (Veltkamp's split,
        // Dekker's product), th + tl = c + p exactly, z = RN(th + RO(tl + pl)):
        // exact while the product's error is (a zero factor or a product from
        // 2^-900 up), with no denormal factor. An overflow anywhere makes z
        // infinite or a NaN, which the result check sends to the helper.
        //
        // On a host whose relaxed `madd` fuses (`Ctx::fma`): that op on lane 0,
        // one rounding, of ±Vn·Vm + ±Va, negated before it: ARM's result, and
        // the result check is what the emulated form's says of it. Only the
        // emulation needs the factors' bound; a zero result isn't taken in
        // either. Under FZ, the operands' test stays.
        FMADD_float | FMSUB_float | FNMADD_float | FNMSUB_float if cx.fma => {
            fpa_guard(c);
            let (o1, o0) = (bit(i, 21), bit(i, 15));
            c.vget(rn);
            c.vget(rm);
            c.vget(ra);
            if o1 {
                c.simd(if f.d { op::F64X2_NEG } else { op::F32X4_NEG });
            }
            c.simd(op::MADD[f.d as usize][(o1 != o0) as usize]);
            c.simd_lane(if f.d { 0x1d } else { 0x1b }, 0); // i64x2/i32x4.extract_lane
            c.local_set(r);
            c.local_get(FPOK);
            under_fz(c, |c| {
                for (l, n) in [(x, rn), (y, rm), (a, ra)] {
                    f.load(c, n);
                    c.local_set(l);
                }
                no_denormal(c, f, &[a, x, y]);
            });
            exp_in(c, f, r, 2);
            c.op(AND);
            guarded(c, cx, i, k, vbit(rd), |c| put(c, f, rd, r));
        }
        FMADD_float | FMSUB_float | FNMADD_float | FNMSUB_float => {
            fpa_guard(c);
            // o1 (21) negates the addend, o1 != o0 (15) the first factor.
            let (o1, o0) = (bit(i, 21), bit(i, 15));
            for (l, n, neg) in [(x, rn, o1 != o0), (y, rm, false), (a, ra, o1)] {
                f.load(c, n);
                if neg {
                    if f.d {
                        c.i64_const(1 << 63).op(XOR + W);
                    } else {
                        c.i32_const(1 << 31).op(XOR);
                    }
                }
                c.local_set(l);
            }
            let [fa, fb, fc, g, ah, al, bh, bl] = super::FT;
            if f.d {
                for (l, d) in [(x, fa), (y, fb), (a, fc)] {
                    c.local_get(l).op(0xbf).local_set(d); // f64.reinterpret
                }
                // Veltkamp: g = (2^27 + 1)·v, h = g - (g - v), l = v - h.
                for (v, h, l) in [(fa, ah, al), (fb, bh, bl)] {
                    c.f64_const(134217729.0).local_get(v).op(F_MUL).local_tee(g);
                    c.local_get(g).local_get(v).op(F_SUB).op(F_SUB).local_set(h);
                    c.local_get(v).local_get(h).op(F_SUB).local_set(l);
                }
                // p = a·b (into fa), pl = ((ah·bh - p) + ah·bl + al·bh) + al·bl (into fb).
                let (p, pl) = (fa, fb);
                c.local_get(fa).local_get(fb).op(F_MUL).local_set(p);
                c.local_get(ah)
                    .local_get(bh)
                    .op(F_MUL)
                    .local_get(p)
                    .op(F_SUB);
                c.local_get(ah).local_get(bl).op(F_MUL).op(F_ADD);
                c.local_get(al).local_get(bh).op(F_MUL).op(F_ADD);
                c.local_get(al)
                    .local_get(bl)
                    .op(F_MUL)
                    .op(F_ADD)
                    .local_set(pl);
                let (th, tl, s) = (ah, al, bh);
                two_sum(c, fc, p, th, g);
                c.local_set(tl);
                two_sum(c, tl, pl, s, g);
                to_odd(c, s, g, r);
                c.op(0xbf).local_get(th).op(F_ADD).op(0xbd).local_set(r); // z = th + v
            } else {
                for (l, d) in [(x, fa), (y, fb), (a, fc)] {
                    c.local_get(l).op(0xbe).op(0xbb).local_set(d); // f32 → f64
                }
                // s = RN(p + c) (into fb), p = a·b (into fa); on a single
                // midpoint (its low 29 bits 1 << 28), s rounded to odd.
                c.local_get(fa).local_get(fb).op(F_MUL).local_tee(fa);
                c.local_get(fc).op(F_ADD).local_tee(fb);
                c.op(0xbd).i64_const(MID_MASK).op(AND + W); // i64.reinterpret
                c.i64_const(MID).op(0x51).hint(false).if_(); // i64.eq
                two_sum(c, fa, fc, fb, g);
                to_odd(c, fb, g, super::tmp(true, 0));
                c.op(0xbf).local_set(fb); // f64.reinterpret
                c.end();
                c.local_get(fb).op(0xb6).op(0xbc).local_set(r); // f32.demote, reinterpret
            }
            // FPOK and a fast result; doubles: also no denormal factor (the
            // emulation's exactness is argued for normal ones; a NaN or infinite
            // one makes z a NaN or infinite; any addend: TwoSum is exact) and the
            // product from 2^-900 (biased exponents ea + eb ≥ 1146), or a zero
            // factor: with e' = e - 1, (e'a | e'b) ≥ 0 and e'a + e'b ≥ 1144.
            c.local_get(FPOK);
            // Under FZ, no operand it would flush (a zero factor's partner too;
            // before the factors' test, which reuses `a`).
            under_fz(c, |c| no_denormal(c, f, &[a, x, y]));
            if f.d {
                let e1 = |c: &mut Func, l: u32| {
                    c.local_get(l)
                        .i64_const(1)
                        .op(0x86)
                        .i64_const(53)
                        .op(SHR_U + W); // i64.shl
                    c.i64_const(1).op(SUB + W);
                };
                e1(c, x);
                c.local_tee(a);
                e1(c, y);
                c.op(0x7c).i64_const(1144).op(0x59); // i64.add, i64.ge_s
                c.local_get(a);
                e1(c, y);
                c.op(0x84).i64_const(0).op(0x59).op(AND); // i64.or, i64.ge_s
                for l in [x, y] {
                    c.local_get(l).i64_const(1).op(0x86).op(EQZ + WC).op(0x72); // i64.shl, i32.or
                }
                c.op(AND);
            }
            exp_in(c, f, r, 2);
            c.op(AND);
            guarded(c, cx, i, k, vbit(rd), |c| put(c, f, rd, r));
        }
        // SCVTF/UCVTF from a general register: wasm's converts round to nearest
        // even, and an integer's float is never infinite or denormal.
        // The fixed-point forms (fbits = 64 - scale) then × 2^-fbits, exact
        // (never below 2^-64).
        SCVTF_float_int | UCVTF_float_int | SCVTF_float_fix | UCVTF_float_fix => {
            if matches!(op, SCVTF_float_fix | UCVTF_float_fix) && !bit(i, 31) && !bit(i, 15) {
                return false; // 32 bits, scale < 32: UNDEFINED
            }
            fpa_guard(c);
            let wide = bit(i, 31);
            let unsigned = matches!(op, UCVTF_float_int | UCVTF_float_fix);
            let fix = matches!(op, SCVTF_float_fix | UCVTF_float_fix);
            // f32.convert_i32_s 0xb2 … f64.convert_i64_u 0xba.
            let conv = match (f.d, wide) {
                (false, false) => 0xb2,
                (false, true) => 0xb4,
                (true, false) => 0xb7,
                (true, true) => 0xb9,
            } + unsigned as u8;
            get(c, wide, rn);
            c.op(conv);
            if fix {
                let p = 2f64.powi(bits(i, 15, 10) as i32 - 64);
                if f.d {
                    c.f64_const(p).op(F_MUL);
                } else {
                    c.f32_const(p as f32).op(0x94); // f32.mul
                }
            }
            f.to_int(c);
            c.local_set(r);
            c.local_get(FPOK);
            guarded(c, cx, i, k, vbit(rd), |c| put(c, f, rd, r));
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
            guarded(c, cx, i, k, vbit(rd), |c| put(c, f, rd, r));
        }
        // FJCVTZS (FEAT_JSCVT): Wd = ToInt32(Dn), NZCV = 0Z00, on one 64-bit
        // truncation, whose low half is the result for any |Dn| < 2^63 (the
        // check that also refuses NaNs and infinities, the helper's with the
        // rest, Invalid). Past int32 it raises Invalid alone, set here, so
        // those don't need FPOK; in int32 an inexact one raises Inexact, which
        // FPOK has set already (under FZ a denormal is the helper's, for IDC).
        // Z, exact in int32 and not -0, is only computed for NZCV, lazy as a
        // 32-bit logical result of !Z: code that ignores it doesn't pay for
        // the conversion back.
        FJCVTZS if cx.jscvt => {
            fpa_guard(c);
            let (v, n, fits, fr) = (super::FT[1], y, super::tmp(false, 0), flag_locals(false).2);
            let exact = |c: &mut Func| {
                c.local_get(n).op(0xb9).local_get(v).op(0x61); // f64.convert_i64_s, f64.eq
            };
            f.load(c, rn);
            c.local_tee(x);
            f.to_float(c);
            c.local_tee(v);
            c.op(0xfc).op(6).local_set(n); // i64.trunc_sat_f64_s
            c.local_get(n).local_get(n).op(0xc4).op(0x51); // i64.extend32_s, i64.eq
            c.local_set(fits);
            c.local_get(v)
                .op(0x99)
                .f64_const(9223372036854775808.0)
                .op(0x63); // f64.abs, f64.lt
            under_fz(c, |c| no_denormal(c, f, &[x]));
            c.local_get(FPOK).if_t(super::I32);
            c.i32_const(1);
            c.else_();
            c.local_get(fits).op(EQZ);
            exact(c);
            c.op(0x72); // i32.or
            c.end();
            c.op(AND);
            guarded_with(
                c,
                cx,
                i,
                k,
                xmask(rd),
                |c| {
                    set(c, false, rd, |c| {
                        c.local_get(n).op(0xa7); // i32.wrap_i64
                    });
                    let fpsr = offset_of!(Cpu, fpsr) as u32;
                    // Tested with IOC itself, which is sticky: whether a value
                    // fits is a coin toss in `>>> 0` of hashes, and this
                    // branch is then taken once.
                    c.local_get(VCPU).i64_load(fpsr).op(0xa7); // i32.wrap_i64
                    c.i32_const(1).op(AND).local_get(fits).op(0x72).op(EQZ); // i32.or
                    c.hint(false).if_();
                    c.local_get(VCPU).local_get(VCPU).i64_load(fpsr);
                    c.i64_const(1).op(0x84).i64_store(fpsr); // i64.or: IOC
                    c.end();
                    c.local_get(fits);
                    exact(c);
                    c.op(AND);
                    c.local_get(x).i64_const(i64::MIN).op(0x52); // i64.ne
                    c.op(AND).op(EQZ).local_set(fr);
                },
                |_| {},
                |c| {
                    // The helper's Z.
                    c.local_get(VCPU).i32_load(NZCV);
                    c.i32_const(1 << 30).op(AND).op(EQZ).local_set(fr);
                },
            );
            c.set_flags(Kind::Logic, false);
        }
        // FCVT{N,M,A,P,Z}{S,U} to a general register or (the AdvSIMD scalar
        // forms) to Vd, as wide as the float: the operand rounded in the
        // instruction's mode (FRINTA's sum for ties away), then a normal or
        // zero operand whose rounded value fits (FPOK: Inexact is set
        // already); the saturating truncation never traps, and the check
        // decides whether it's used.
        FCVTNS_float | FCVTNU_float | FCVTMS_float | FCVTMU_float | FCVTAS_float | FCVTAU_float
        | FCVTPS_float | FCVTPU_float | FCVTZS_float_int | FCVTZU_float_int | FCVTZS_float_fix
        | FCVTZU_float_fix | FCVTNS_2 | FCVTNU_2 | FCVTMS_2 | FCVTMU_2 | FCVTAS_2 | FCVTAU_2
        | FCVTPS_2 | FCVTPU_2 | FCVTZS_int_2 | FCVTZU_int_2 => {
            if matches!(op, FCVTZS_float_fix | FCVTZU_float_fix) && !bit(i, 31) && !bit(i, 15) {
                return false; // 32 bits, scale < 32: UNDEFINED
            }
            fpa_guard(c);
            let gpr = !simd;
            let (wide, unsigned) = if gpr {
                (
                    bit(i, 31),
                    matches!(
                        op,
                        FCVTNU_float
                            | FCVTMU_float
                            | FCVTAU_float
                            | FCVTPU_float
                            | FCVTZU_float_int
                            | FCVTZU_float_fix
                    ),
                )
            } else {
                (f.d, bit(i, 29))
            };
            let mode = match op {
                FCVTNS_float | FCVTNU_float | FCVTNS_2 | FCVTNU_2 => Round::Nearest,
                FCVTMS_float | FCVTMU_float | FCVTMS_2 | FCVTMU_2 => Round::Floor,
                FCVTPS_float | FCVTPU_float | FCVTPS_2 | FCVTPU_2 => Round::Ceil,
                FCVTAS_float | FCVTAU_float | FCVTAS_2 | FCVTAU_2 => Round::Away,
                _ => Round::Trunc,
            };
            f.load(c, rn);
            c.local_set(x);
            // The rounded value, as a float, into scratch FT[1] (f64; singles
            // promoted, exactly). Fixed point (fbits = 64 - scale): × 2^fbits
            // in f64 first (exact, or an infinity the range check rejects).
            let v = super::FT[1];
            if matches!(op, FCVTZS_float_fix | FCVTZU_float_fix) {
                c.local_get(x);
                f.to_float(c);
                if !f.d {
                    c.op(0xbb); // f64.promote_f32
                }
                c.f64_const(2f64.powi(64 - bits(i, 15, 10) as i32))
                    .op(F_MUL)
                    .op(0x9d); // f64.trunc
            } else {
                round(c, f, x, mode);
                if !f.d {
                    c.op(0xbb); // f64.promote_f32
                }
            }
            c.local_set(v);
            // FPOK, and it fits: lo ≤ v < hi, integers exact in a double (a NaN
            // or an infinity doesn't; a denormal rounds as ARM's does without FZ).
            c.local_get(FPOK);
            let w = if wide { 64 } else { 32 };
            let hi = 2f64.powi(if unsigned { w } else { w - 1 });
            let lo = if unsigned { 0.0 } else { -hi };
            c.local_get(v).f64_const(lo).op(0x66).op(AND); // f64.ge
            c.local_get(v).f64_const(hi).op(0x63).op(AND); // f64.lt
            under_fz(c, |c| no_denormal(c, f, &[x]));
            // i32/i64.trunc_sat_f64_s/u: 0xfc 2, 3, 6, 7.
            let sat = (wide as u8) * 4 + 2 + unsigned as u8;
            let out = |c: &mut Func| {
                c.local_get(v).op(0xfc).op(sat);
            };
            if gpr {
                guarded(c, cx, i, k, xmask(rd), |c| set(c, wide, rd, out));
            } else {
                guarded(c, cx, i, k, vbit(rd), |c| {
                    c.vset_scalar(rd, f.esize(), out);
                });
            }
        }
        // AdvSIMD scalar compares (all ones or zero in Vd): as the vector ones,
        // no NaN operand under FZOK, no rounding, so no FPOK.
        FCMEQ_reg_2 | FCMGE_reg_2 | FCMGT_reg_2 | FACGE_2 | FACGT_2 | FCMEQ_zero_2
        | FCMGE_zero_2 | FCMGT_zero_2 | FCMLE_2 | FCMLT_2 => {
            let zero = !matches!(
                op,
                FCMEQ_reg_2 | FCMGE_reg_2 | FCMGT_reg_2 | FACGE_2 | FACGT_2
            );
            let abs = matches!(op, FACGE_2 | FACGT_2);
            let sign = if f.d { 1u64 << 63 } else { 1 << 31 };
            for (l, n) in [(x, rn), (y, rm)] {
                if l == y && zero {
                    f.zero(c);
                } else {
                    f.load(c, n);
                    if abs {
                        if f.d {
                            c.i64_const(!sign as i64).op(AND + W);
                        } else {
                            c.i32_const(!(sign as u32) as i32).op(AND);
                        }
                    }
                }
                c.local_set(l);
            }
            // eq 0, lt 1, gt 2, le 3, ge 4.
            let k_cmp = match op {
                FCMEQ_reg_2 | FCMEQ_zero_2 => 0,
                FCMLT_2 => 1,
                FCMGT_reg_2 | FACGT_2 | FCMGT_zero_2 => 2,
                FCMLE_2 => 3,
                _ => 4,
            };
            if f.d {
                c.i64_const(-1).i64_const(0);
            } else {
                c.i32_const(-1).i32_const(0);
            }
            f.compare(c, x, y, k_cmp);
            c.select().local_set(r);
            scalar_plain(c, f, x, false, false);
            if !zero {
                scalar_plain(c, f, y, false, false);
                c.op(AND);
            }
            guarded(c, cx, i, k, vbit(rd), |c| put(c, f, rd, r));
        }
        // FCVTXN (scalar): double to single rounded to odd, from the RNE
        // demote: inexact, it steps toward zero when it rounded away, then
        // takes the odd bit. FPOK (Inexact is set already), and an RNE result
        // from the second binade up and finite (no Overflow or Underflow either
        // way), or a zero operand.
        FCVTXN_1 if f.d => {
            fpa_guard(c);
            let (xd, r32) = (super::tmp(true, 0), super::tmp(false, 3));
            f.load(c, rn);
            c.local_set(xd);
            to_odd_single(c, xd, r32);
            is_zero(c, f, xd);
            c.op(0x72); // i32.or: a zero converts exactly
            c.local_get(FPOK).op(AND);
            under_fz(c, |c| no_denormal(c, f, &[xd]));
            guarded(c, cx, i, k, vbit(rd), |c| put(c, F { d: false }, rd, r32));
        }
        // FRECPX: bits (the sign, the exponent inverted, or the largest finite
        // one for a zero exponent; no fraction), with no flags but for a NaN
        // (Invalid when signaling, its propagation) or a denormal (FZ's IDC).
        FRECPX_2 => {
            let (sh, ones) = f.exp();
            let w = if f.d { W } else { 0 };
            let kk = |c: &mut Func, v: i64| {
                if f.d {
                    c.i64_const(v);
                } else {
                    c.i32_const(v as i32);
                }
            };
            f.load(c, rn);
            c.local_tee(x);
            kk(c, sh);
            c.op(SHR_U + w);
            kk(c, ones);
            c.op(AND + w).local_set(y); // the exponent
            kk(c, ones - 1);
            c.local_get(y);
            kk(c, ones);
            c.op(XOR + w); // ~e & ones
            c.local_get(y);
            if f.d {
                c.op(EQZ + WC);
            } else {
                c.op(EQZ);
            }
            c.select();
            kk(c, sh);
            c.op(0x74 + if f.d { 0x12 } else { 0 }); // shl
            c.local_get(x);
            kk(c, if f.d { i64::MIN } else { i32::MIN as i64 });
            c.op(AND + w)
                .op(0x72 + if f.d { 0x12 } else { 0 })
                .local_set(r); // or
            // A zero fraction, or an exponent neither zero nor all ones.
            c.local_get(x);
            kk(c, (1 << sh) - 1);
            c.op(AND + w);
            if f.d {
                c.op(EQZ + WC);
            } else {
                c.op(EQZ);
            }
            exp_in(c, f, x, 1);
            c.op(0x72); // i32.or
            guarded(c, cx, i, k, vbit(rd), |c| put(c, f, rd, r));
        }
        // FRECPE, FRSQRTE (scalar): `estimate`; no flags, no FPOK.
        FRECPE_2 | FRSQRTE_2 => {
            f.load(c, rn);
            c.local_set(x);
            estimate(c, f, x, r, op == FRSQRTE_2);
            guarded(c, cx, i, k, vbit(rd), |c| put(c, f, rd, r));
        }
        // FCSEL: bits, no flags.
        FCSEL_float => {
            f.load(c, rn);
            f.load(c, rm);
            cond(c, bits(i, 15, 12));
            c.select().local_set(r);
            put(c, f, rd, r);
        }
        // FCMP/FCMPE (with Vm or zero): no flags without a denormal operand
        // (FZ would flush it, raising IDC), a NaN for FCMPE or a signaling
        // one for FCMP (Invalid). NZCV stays lazy: an ordered result's is a
        // 32-bit SUBS of (gt, lt) (1 - 0: 0010, 0 - 0: 0110, 0 - 1: 1000), an
        // unordered one's (0011) SUBS of (i32::MIN, 1).
        FCMP_float | FCMPE_float => {
            let (e, zero) = (op == FCMPE_float, bit(i, 3));
            f.load(c, rn);
            c.local_set(x);
            if zero {
                f.zero(c);
            } else {
                f.load(c, rm);
            }
            c.local_set(y);
            scalar_plain(c, f, x, !e, true);
            if !zero {
                scalar_plain(c, f, y, !e, true);
                c.op(AND);
            }
            let (fx, fy, _) = flag_locals(false);
            guarded_with(
                c,
                cx,
                i,
                k,
                0,
                |c| {
                    c.i32_const(i32::MIN);
                    f.compare(c, x, y, 2);
                    f.unordered(c, x, y);
                    c.select().local_set(fx);
                    c.i32_const(1);
                    f.compare(c, x, y, 1);
                    f.unordered(c, x, y);
                    c.select().local_set(fy);
                },
                |_| {},
                |c| {
                    // The helper's NZCV as the same operands: V ? (MIN, 1) : (!N & !Z, N).
                    let t = super::tmp(false, 0);
                    c.local_get(VCPU).i32_load(NZCV).local_set(t);
                    c.i32_const(i32::MIN);
                    c.local_get(t)
                        .i32_const(0xc000_0000u32 as i32)
                        .op(AND)
                        .op(EQZ);
                    c.local_get(t).i32_const(1 << 28).op(AND);
                    c.select().local_set(fx);
                    c.i32_const(1);
                    c.local_get(t).i32_const(31).op(SHR_U);
                    c.local_get(t).i32_const(1 << 28).op(AND);
                    c.select().local_set(fy);
                },
            );
            c.set_flags(Kind::Sub, false);
        }
        // FCCMP/FCCMPE: NZCV = cond ? the compare's : nzcv (3:0), stored (an
        // immediate like 0100 has no lazy form); FCMP's operand rules (on both
        // paths: simpler, and rare otherwise). The helper reads NZCV, so its
        // path stores lazy flags first.
        FCCMP_float | FCCMPE_float => {
            let e = op == FCCMPE_float;
            f.load(c, rn);
            c.local_set(x);
            f.load(c, rm);
            c.local_set(y);
            scalar_plain(c, f, x, !e, true);
            scalar_plain(c, f, y, !e, true);
            c.op(AND);
            guarded_with(
                c,
                cx,
                i,
                k,
                0,
                |c| {
                    c.local_get(VCPU);
                    // un ? 0011 : eq ? 0110 : lt ? 1000 : 0010.
                    c.i32_const(0x3 << 28);
                    c.i32_const(0x6 << 28);
                    c.i32_const(i32::MIN); // 1000
                    c.i32_const(0x2 << 28);
                    f.compare(c, x, y, 1);
                    c.select();
                    f.compare(c, x, y, 0);
                    c.select();
                    f.unordered(c, x, y);
                    c.select();
                    c.i32_const((bits(i, 3, 0) << 28) as i32);
                    cond(c, bits(i, 15, 12));
                    c.select().i64_extend_i32_u().i64_store(NZCV);
                },
                |c| c.store_flags(),
                |_| {},
            );
            c.retire_flags();
        }
        // FCVT between single and double: widening is exact (no FPOK) for an
        // operand that isn't a NaN, under FZOK; narrowing rounds (FPOK): a fast
        // result, or a zero from a zero. Half precision: `fcvt_half`.
        FCVT_float => {
            let t = match bits(i, 16, 15) {
                0 => F { d: false },
                1 => F { d: true },
                _ => return false,
            };
            if t.d == f.d {
                return false;
            }
            f.load(c, rn);
            c.local_tee(x);
            f.to_float(c);
            if t.d {
                c.op(0xbb); // f64.promote_f32
            } else {
                fpa_guard(c);
                c.op(0xb6); // f32.demote_f64
            }
            t.to_int(c);
            let r = t.tmp(3);
            c.local_set(r);
            if t.d {
                scalar_plain(c, f, x, false, false);
            } else {
                c.local_get(FPOK);
                exp_in(c, t, r, 2);
                is_zero(c, f, x);
                c.op(0x72).op(AND); // i32.or
                under_fz(c, |c| no_denormal(c, f, &[x]));
            }
            guarded(c, cx, i, k, vbit(rd), |c| put(c, t, rd, r));
        }
        // FMAX/FMIN, FMAXNM/FMINNM (the same without a NaN): no flags with no
        // NaN operand under FZOK; wasm's max and min order -0 below +0 as ARM
        // does.
        FMAX_float | FMIN_float | FMAXNM_float | FMINNM_float => {
            f.load(c, rn);
            c.local_set(x);
            f.load(c, rm);
            c.local_set(y);
            c.local_get(x);
            f.to_float(c);
            c.local_get(y);
            f.to_float(c);
            let max = matches!(op, FMAX_float | FMAXNM_float);
            c.op(f.arith(if max { 5 } else { 4 }));
            f.to_int(c);
            c.local_set(r);
            scalar_plain(c, f, x, false, false);
            scalar_plain(c, f, y, false, false);
            c.op(AND);
            guarded(c, cx, i, k, vbit(rd), |c| put(c, f, rd, r));
        }
        // FRINTN/M/P/Z, FRINTA (ties away: trunc(x), ± 1 when |x - trunc(x)|
        // ≥ 0.5, both exact), FRINTI/X in the FPCR's mode (nearest even under
        // FPOK; FRINTX's Inexact is set already): no NaN operand, under FZOK.
        FRINTN_float | FRINTM_float | FRINTP_float | FRINTZ_float | FRINTA_float | FRINTI_float
        | FRINTX_float => {
            let fpcr_mode = matches!(op, FRINTI_float | FRINTX_float);
            if fpcr_mode {
                fpa_guard(c);
            }
            f.load(c, rn);
            c.local_set(x);
            round(
                c,
                f,
                x,
                match op {
                    FRINTA_float => Round::Away,
                    FRINTM_float => Round::Floor,
                    FRINTP_float => Round::Ceil,
                    FRINTZ_float => Round::Trunc,
                    _ => Round::Nearest,
                },
            );
            f.to_int(c);
            c.local_set(r);
            scalar_plain(c, f, x, false, false);
            if fpcr_mode {
                c.local_get(FPOK).op(AND);
            }
            guarded(c, cx, i, k, vbit(rd), |c| put(c, f, rd, r));
        }
        // FRINT32Z/X, FRINT64Z/X (FEAT_FRINTTS; opcode<1> (16) is 64 bits,
        // opcode<0> (15) the FPCR's mode): FRINTZ's or FRINTI's rounding
        // (nearest even under FPOK), then a rounded value in the integer's
        // range (a NaN or an infinity isn't), under FPOK (Inexact), and no NaN
        // or, under FZ, denormal operand. The rest (Invalid) is the helper's.
        FRINT32X_float | FRINT64X_float | FRINT32Z_float | FRINT64Z_float
            if cx.features & crate::cpu::FEATURE_FRINTTS != 0 =>
        {
            fpa_guard(c);
            f.load(c, rn);
            c.local_set(x);
            round(
                c,
                f,
                x,
                if bit(i, 15) {
                    Round::Nearest
                } else {
                    Round::Trunc
                },
            );
            f.to_int(c);
            c.local_set(r);
            in_int_range(c, f, r, if bit(i, 16) { 64 } else { 32 });
            scalar_plain(c, f, x, false, false);
            c.op(AND).local_get(FPOK).op(AND);
            guarded(c, cx, i, k, vbit(rd), |c| put(c, f, rd, r));
        }
        _ => return false,
    }
    true
}

/// Pushes an i32: the integral float bits in local `l` lie in [-2^(n-1), 2^(n-1)).
fn in_int_range(c: &mut Func, f: F, l: u32, n: i32) {
    let lim = 2f64.powi(n - 1);
    for (v, cmp) in [(-lim, 0), (lim, 1)] {
        c.local_get(l);
        f.to_float(c);
        if f.d {
            c.f64_const(v).op([0x66, 0x63][cmp]); // f64.ge, f64.lt
        } else {
            c.f32_const(v as f32).op([0x60, 0x5d][cmp]); // f32.ge, f32.lt
        }
    }
    c.op(AND);
}

// Vector FP (M6 loop 6): the same rules lane by lane; any lane off the fast
// path sends the whole instruction to the helper.

use super::{VT, VTMP};

/// SIMD opcodes (0xfd-prefixed).
mod op {
    pub const AND: u32 = 0x4e;
    pub const OR: u32 = 0x50;
    pub const XOR: u32 = 0x51;
    pub const ANDNOT: u32 = 0x4f;
    pub const I32X4_ALL_TRUE: u32 = 0xa3;
    pub const I64X2_ALL_TRUE: u32 = 0xc3;
    pub const I32X4_SHR_U: u32 = 0xad;
    pub const I32X4_SUB: u32 = 0xb1;
    pub const I32X4_LT_U: u32 = 0x3a;
    pub const I32X4_MIN_U: u32 = 0xb7;
    pub const I64X2_SHR_U: u32 = 0xcd;
    pub const I64X2_SUB: u32 = 0xd1;
    pub const I64X2_LT_S: u32 = 0xd8;
    pub const I64X2_EQ: u32 = 0xd6;
    pub const I64X2_SHL: u32 = 0xcb;
    pub const I64X2_SHR_S: u32 = 0xcc;
    pub const I64X2_ADD: u32 = 0xce;
    pub const F64X2_NEG: u32 = 0xed;
    pub const F64X2_NE: u32 = 0x48;
    pub const F64X2_GT: u32 = 0x4a;
    pub const ANY_TRUE: u32 = 0x53;
    pub const F64X2_ABS: u32 = 0xec;
    /// f32x4 add, sub, mul, div; f64x2 likewise.
    pub const F32X4: [u32; 4] = [0xe4, 0xe5, 0xe6, 0xe7];
    pub const F64X2: [u32; 4] = [0xf0, 0xf1, 0xf2, 0xf3];
    pub const F32X4_NEG: u32 = 0xe1;
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
    pub const I64X2_GE_S: u32 = 0xdb;
    /// i32x4.extend_low/high_i16x8_u.
    pub const EXTEND_U16: [u32; 2] = [0xa9, 0xaa];
    pub const BITSELECT: u32 = 0x52;
    /// eq, lt, gt, le, ge: f32x4, f64x2.
    pub const CMP: [[u32; 5]; 2] = [
        [0x41, 0x43, 0x44, 0x45, 0x46],
        [0x47, 0x49, 0x4a, 0x4b, 0x4c],
    ];
    /// Relaxed SIMD: [madd, nmadd] of f32x4, of f64x2.
    pub const MADD: [[u32; 2]; 2] = [[0x105, 0x106], [0x107, 0x108]];
    /// abs: f32x4, f64x2.
    pub const ABS: [u32; 2] = [0xe0, 0xec];
    /// min, max: f32x4, f64x2.
    pub const MINMAX: [[u32; 2]; 2] = [[0xe8, 0xe9], [0xf4, 0xf5]];
    pub const F64X2_SPLAT: u32 = 0x14;
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
/// exponent field is in `lo`..all ones (1: normal; 2: a fast result), as
/// [`exp_in`]: three ops a lane.
fn lanes_in(c: &mut Func, d: bool, lo: u64) {
    if d {
        // Unsigned `<`, as signed with the sign bits flipped: the flip folded
        // into the subtraction's constant (`lo << 53` has no sign bit).
        let s = 1u64 << 63;
        c.i32_const(1).simd(op::I64X2_SHL);
        c.v128_const(splat(true, (lo << 53) ^ s))
            .simd(op::I64X2_SUB);
        c.v128_const(splat(true, ((0x7ff - lo) << 53) ^ s))
            .simd(op::I64X2_LT_S);
    } else {
        c.i32_const(1).simd(op::I32X4_SHL);
        c.v128_const(splat(false, lo << 24)).simd(op::I32X4_SUB);
        c.v128_const(splat(false, (0xff - lo) << 24))
            .simd(op::I32X4_LT_U);
    }
}

/// Pushes Vn.
fn vreg(c: &mut Func, n: u32) {
    c.vget(n);
}

/// Vd = the v128 in local `l`, its top half cleared unless `q` (an AdvSIMD
/// scalar form: all but its low element).
fn vput(c: &mut Func, rd: u32, q: bool, l: u32) {
    c.local_get(l);
    match c.vsc {
        Some(false) => {
            c.v128_const(0xffff_ffff).simd(op::AND);
        }
        // i64x2.replace_lane 1
        Some(true) => {
            c.i64_const(0).simd_lane(0x1e, 1);
        }
        None if !q => {
            c.i64_const(0).simd_lane(0x1e, 1);
        }
        None => {}
    }
    c.vset(rd);
}

/// Replaces the v128 on the stack with a lane mask: all ones where the lane is
/// ±0 (a float compare with zero: a NaN isn't).
fn zero_lanes(c: &mut Func, d: bool) {
    c.v128_const(0).simd(op::CMP[d as usize][0]);
}

/// Replaces the v128 on the stack with a lane mask: all ones where the lane
/// isn't a NaN, nor, under FZ, a denormal (FZ would flush it, raising IDC).
/// Scratch: VT[3].
fn plain_lanes(c: &mut Func, d: bool) {
    fpa_guard(c);
    let tt = VT[3];
    c.local_tee(tt).local_get(tt);
    c.simd(op::CMP[d as usize][0]); // x == x
    under_fz_bad(c, |c| {
        denormal_any(
            c,
            d,
            &[&|c| {
                c.local_get(tt);
            }],
        );
    });
}

/// An FMA form's first factor negated (FMLS, FRECPS, FRSQRTS), the addend's
/// pusher (Vd, or FRECPS's 2 and FRSQRTS's 3 in every lane) and whether the
/// sum is halved (FRSQRTS: (3 - n·m) / 2, rounded once). Their ∞ × 0 cases
/// never meet the fast path (no infinite operand).
fn fma_kind(op: Op, d: bool, rd: u32) -> (bool, impl Fn(&mut Func), bool) {
    use Op::*;
    let step = match op {
        FRECPS_4 | FRECPS_2 => Some(2.0),
        FRSQRTS_4 | FRSQRTS_2 => Some(3.0),
        _ => None,
    };
    let neg = step.is_some() || matches!(op, FMLS_vec_2 | FMLS_elt_4 | FMLS_elt_2);
    let acc = move |c: &mut Func| match step {
        Some(v) if d => {
            c.v128_const(splat(true, f64::to_bits(v)));
        }
        Some(v) => {
            c.v128_const(splat(false, (v as f32).to_bits() as u64));
        }
        None => vreg(c, rd),
    };
    (neg, acc, step == Some(3.0))
}

/// The fixed-point forms' scale (`sign` 1: 2^fbits, to integer; -1:
/// 2^-fbits, from integer) in every lane, as a v128 constant: Some(None) for
/// the integer forms, None for an encoding that isn't ours (16-bit lanes).
/// fbits = 2 × the lane's bits - immh:immb.
fn fixed(op: Op, i: u32, d: bool, sign: i32) -> Option<Option<u128>> {
    use Op::*;
    if !matches!(
        op,
        FCVTZS_fix_2
            | FCVTZU_fix_2
            | FCVTZS_fix_1
            | FCVTZU_fix_1
            | SCVTF_fix_2
            | UCVTF_fix_2
            | SCVTF_fix_1
            | UCVTF_fix_1
    ) {
        return Some(None);
    }
    if !d && !bit(i, 21) {
        return None; // immh 001x: half precision
    }
    let fbits = if d { 128 } else { 64 } - bits(i, 22, 16) as i32;
    let p = 2f64.powi(sign * fbits);
    Some(Some(if d {
        splat(true, p.to_bits())
    } else {
        splat(false, (p as f32).to_bits() as u64)
    }))
}

/// Pushes Vn, its lanes × `scale` (the fixed-point forms) if there's one.
fn vscaled(c: &mut Func, d: bool, rn: u32, scale: Option<u128>) {
    vreg(c, rn);
    if let Some(m) = scale {
        c.v128_const(m)
            .simd(if d { op::F64X2[2] } else { op::F32X4[2] });
    }
}

/// A vector form's lanes (doubles if `d`), Q, and Vd.
type Shape = (bool, bool, u32);

/// FADD, FSUB (`kk` 1), FMUL (2), FDIV (3) on the lanes `a` and `b` push
/// (FABD: `abs` of the difference; FMULX: FMUL, its ∞ × 0 is a NaN here, which
/// the check rejects): the host's lane operation under FPOK (any operand: see
/// [`fpa_guard`]), and a fast result or an exact zero: a zero sum is always
/// exact, a zero product or quotient when an operand is zero.
#[allow(clippy::too_many_arguments)]
fn arith(
    c: &mut Func,
    cx: &Ctx,
    i: u32,
    k: usize,
    (d, q, rd): Shape,
    kk: usize,
    abs: bool,
    a: &dyn Fn(&mut Func),
    b: &dyn Fn(&mut Func),
) {
    let tr = VT[2];
    fpa_guard(c);
    a(c);
    b(c);
    c.simd(if d { op::F64X2[kk] } else { op::F32X4[kk] });
    if abs {
        c.simd(op::ABS[d as usize]);
    }
    c.local_set(tr);
    // A fast result, or a zero one that's exact: any sum's; a product's with a
    // zero factor, a quotient's with a zero dividend (0 × ∞ and 0 / 0 are NaNs).
    c.local_get(tr);
    lanes_in(c, d, 2);
    if kk < 2 {
        c.local_get(tr);
        zero_lanes(c, d);
        c.simd(op::OR);
        under_fz_bad(c, |c| denormal_any(c, d, &[a, b]));
        all_lanes(c, d, q, 1);
    } else {
        // Products and quotients: the zero clause in a branch on some lane not
        // being a fast result, as the scalar forms', so a block of plain lanes
        // pays one reduction and no zero tests. The fast lanes' mask is kept
        // (`m`): the branch adds the exact zero lanes to it.
        let m = VT[0];
        under_fz_bad(c, |c| denormal_any(c, d, &[a, b]));
        c.local_tee(m);
        every_lane(c, d, q, 1);
        c.if_t(super::I32).i32_const(1).else_();
        c.local_get(tr);
        zero_lanes(c, d);
        a(c);
        zero_lanes(c, d);
        if kk == 2 {
            b(c);
            zero_lanes(c, d);
            c.simd(op::OR);
        }
        c.simd(op::AND);
        under_fz_bad(c, |c| denormal_any(c, d, &[a, b]));
        c.local_get(m).simd(op::OR);
        every_lane(c, d, q, 1);
        c.end();
        c.local_get(FPOK).op(AND);
    }
    guarded(c, cx, i, k, vbit(rd), |c| vput(c, rd, q, tr));
}

/// FMAX/FMIN, FMAXNM/FMINNM (the same without NaNs) on the lanes `a` and `b`
/// push: wasm's lane min and max with no NaN lanes, under FZOK (-0 below +0,
/// as ARM); no flags, no FPOK.
#[allow(clippy::too_many_arguments)]
fn minmax(
    c: &mut Func,
    cx: &Ctx,
    i: u32,
    k: usize,
    (d, q, rd): Shape,
    max: bool,
    a: &dyn Fn(&mut Func),
    b: &dyn Fn(&mut Func),
) {
    let tr = VT[2];
    fpa_guard(c);
    a(c);
    b(c);
    c.simd(op::MINMAX[d as usize][max as usize]).local_tee(tr);
    // wasm's min and max give a NaN where either operand is one: the
    // result's lanes are the operands' NaN test; under FZ, neither operand
    // a denormal.
    c.local_get(tr).simd(op::CMP[d as usize][0]);
    under_fz_bad(c, |c| {
        denormal_any(c, d, &[a, b]);
    });
    every_lane(c, d, q, 1);
    guarded(c, cx, i, k, vbit(rd), |c| vput(c, rd, q, tr));
}

/// Pushes the lanes `src` pushes (doubles if `d`, else singles) rounded to integral by
/// `mode`, ties away as the scalar [`round`]: t = trunc(x), and t ± 1 (x's
/// sign) where |x - t| ≥ 0.5. Scratch: VT[0] and VT[3].
fn vround(c: &mut Func, d: bool, src: &dyn Fn(&mut Func), mode: Round) {
    let r = |k: usize| op::ROUND[d as usize][k];
    if mode != Round::Away {
        src(c);
        c.simd(r(match mode {
            Round::Floor => 1,
            Round::Ceil => 2,
            Round::Trunc => 3,
            _ => 0,
        }));
        return;
    }
    let (t, tt) = (VT[0], VT[3]);
    let (one, sign) = if d {
        (1f64.to_bits(), 1u64 << 63)
    } else {
        (1f32.to_bits() as u64, 1 << 31)
    };
    let (add, sub) = if d {
        (op::F64X2[0], op::F64X2[1])
    } else {
        (op::F32X4[0], op::F32X4[1])
    };
    src(c);
    c.simd(r(3)).local_set(t);
    // t + copysign(1, x)
    src(c);
    c.v128_const(splat(d, one)).v128_const(splat(d, sign));
    c.simd(op::BITSELECT).local_get(t).simd(add);
    c.local_get(t);
    // |x - t| ≥ 0.5
    src(c);
    c.local_get(t)
        .simd(sub)
        .simd(op::ABS[d as usize])
        .local_set(tt);
    c.local_get(tt);
    if d {
        c.f64_const(0.5).simd(op::F64X2_SPLAT);
    } else {
        c.f32_const(0.5).simd(op::F32X4_SPLAT);
    }
    c.simd(op::CMP[d as usize][4]).simd(op::BITSELECT);
}

/// ANDs lane masks into one i32 with FPOK: every lane of the masks all ones
/// (with Q = 0, lanes 2 and 3 of 32-bit masks don't count; an AdvSIMD scalar
/// form's, only lane 0).
fn all_lanes(c: &mut Func, d: bool, q: bool, masks: usize) {
    every_lane(c, d, q, masks);
    c.local_get(FPOK).op(AND);
}

/// [`all_lanes`] without FPOK, for what neither rounds nor can be inexact.
fn every_lane(c: &mut Func, d: bool, q: bool, masks: usize) {
    for _ in 1..masks {
        c.simd(op::AND);
    }
    // An AdvSIMD scalar form: lane 0 alone.
    match c.vsc {
        Some(true) => {
            c.v128_const(u128::MAX << 64).simd(op::OR);
        }
        Some(false) => {
            c.v128_const(u128::MAX << 32).simd(op::OR);
        }
        None if !q && !d => {
            c.v128_const(u128::MAX << 64).simd(op::OR);
        }
        None => {}
    }
    c.simd(if d {
        op::I64X2_ALL_TRUE
    } else {
        op::I32X4_ALL_TRUE
    });
}

/// Emits vector FP instruction `i` inline if it's one this covers; false
/// (and nothing emitted) otherwise. The AdvSIMD scalar forms listed here run
/// the vector rules on lane 0 alone (`Func::vsc`).
pub(super) fn vector(c: &mut Func, cx: &Ctx, i: u32, op: Op, k: usize) -> bool {
    use Op::*;
    if bit(i, 28) {
        if !matches!(
            op,
            FMLA_elt_2
                | FMLS_elt_2
                | FMUL_elt_2
                | FMULX_elt_2
                | FABD_2
                | FMULX_vec_2
                | FRECPS_2
                | FRSQRTS_2
                | FADDP_pair_2
                | FMAXP_pair_2
                | FMINP_pair_2
                | FMAXNMP_pair_2
                | FMINNMP_pair_2
                | FCVTZS_fix_1
                | FCVTZU_fix_1
                | SCVTF_fix_1
                | UCVTF_fix_1
        ) {
            return false;
        }
        // The fixed-point forms' size is immh's top bit (22 too); their 16-bit form isn't ours.
        c.vsc = Some(bit(i, 22));
    }
    let done = lanes(c, cx, i, op, k);
    c.vsc = None;
    done
}

fn lanes(c: &mut Func, cx: &Ctx, i: u32, op: Op, k: usize) -> bool {
    use Op::*;
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let sc = c.vsc.is_some();
    let (q, d) = (bit(i, 30) && !sc, bit(i, 22));
    if d && !q && !sc && !matches!(op, FCVTL | FCVTN | FCVTXN_2) {
        return false; // a vector of doubles needs Q
    }
    let [ta, tb, tr, tt] = VT;
    // The multiplier: Vm, or (by element) its lane `index` in every lane.
    let by_element = matches!(
        op,
        FMLA_elt_4
            | FMLS_elt_4
            | FMUL_elt_4
            | FMULX_elt_4
            | FMLA_elt_2
            | FMLS_elt_2
            | FMUL_elt_2
            | FMULX_elt_2
    );
    let index = if d {
        bit(i, 11) as u8
    } else {
        (bit(i, 11) as u8) << 1 | bit(i, 21) as u8
    };
    if by_element && d && bit(i, 21) {
        return false;
    }
    let lb: u8 = if d { 8 } else { 4 };
    // A v128 shuffle that puts lane `map[j % map.len()]` in lane j.
    let lane_map = |map: &[u8]| -> [u8; 16] {
        core::array::from_fn(|b| map[(b as u8 / lb) as usize % map.len()] * lb + b as u8 % lb)
    };
    // FEAT_FCMA (docs/jit.md "Floating point"): FCMLA is the FMA forms with Vn's
    // real (rot 0°, 180°) or imaginary element in both lanes of a pair and Vm's
    // pair (by element, the index's), swapped for 90° and 270°, a lane of it
    // negated (180°: both, through `neg`); FCADD is FADD of Vn and Vm's pairs
    // swapped, one lane negated. The fast paths' checks then test the lanes the
    // instruction multiplies and adds, as they are.
    let fcma = matches!(op, FCMLA_vec | FCMLA_elt | FCADD_vec);
    if fcma {
        let size = bits(i, 23, 22);
        let allocated = if op == FCMLA_elt {
            size == 2 && q && !bit(i, 21)
        } else {
            size == 2 || size == 3 && q
        };
        if cx.features & crate::cpu::FEATURE_FCMA == 0 || !allocated {
            return false;
        }
    }
    let rot = match op {
        FCMLA_elt => bits(i, 14, 13),
        FCMLA_vec => bits(i, 12, 11),
        // FCADD's 90° and 270° negate as FCMLA's do.
        FCADD_vec => 1 + 2 * bit(i, 12) as u32,
        _ => 0,
    };
    let pair = 2 * bit(i, 11) as u8;
    // Vn's lanes (FCMLA: the pairs' real or imaginary element twice).
    let nshuf = (op == FCMLA_vec || op == FCMLA_elt).then(|| {
        lane_map(&[
            rot as u8 & 1,
            rot as u8 & 1,
            2 | rot as u8 & 1,
            2 | rot as u8 & 1,
        ])
    });
    // Vm's lanes: FMLA's by element the element, FCMLA's the pair (swapped
    // for 90° and 270°), FCADD's swapped.
    let mshuf = match op {
        _ if by_element => Some(lane_map(&[index])),
        FCMLA_elt if rot & 1 == 0 => Some(lane_map(&[pair, pair + 1])),
        FCMLA_elt => Some(lane_map(&[pair + 1, pair])),
        FCMLA_vec | FCADD_vec if rot & 1 == 1 => Some(lane_map(&[1, 0, 3, 2])),
        _ => None,
    };
    // The negated lanes of Vm's: 90° the pairs' first, 270° their second.
    let sign = |hi: bool| -> u128 {
        if d {
            1 << (63 + 64 * hi as u32)
        } else {
            let s = 1u128 << (31 + 32 * hi as u32);
            s | s << 64
        }
    };
    let msign = match rot {
        _ if !fcma => None,
        1 => Some(sign(false)),
        3 => Some(sign(true)),
        _ => None,
    };
    // FCMLA's 180°: both factors' lanes negated, as FMLS's first.
    let fneg = op != FCADD_vec && fcma && rot == 2;
    let nsrc = |c: &mut Func| {
        vreg(c, rn);
        if let Some(sh) = nshuf {
            vreg(c, rn);
            c.shuffle(sh);
        }
    };
    let factor = |c: &mut Func| {
        vreg(c, rm);
        if let Some(sh) = mshuf {
            vreg(c, rm);
            c.shuffle(sh);
        }
        if let Some(m) = msign {
            c.v128_const(m).simd(op::XOR);
        }
    };
    // The factor isn't Vm itself: a shuffle or a sign flip, held in a local
    // where it's read more than once. Its halves are alike by element.
    let held_factor = mshuf.is_some() || msign.is_some();
    let same_halves = by_element || op == FCMLA_elt;
    match op {
        // FADD, FSUB, FMUL, FDIV, FMUL by element, FABD, FMULX: `arith`.
        FADD_2 | FSUB_2 | FMUL_vec_2 | FDIV_2 | FMUL_elt_4 | FMUL_elt_2 | FMULX_vec_4
        | FMULX_vec_2 | FMULX_elt_4 | FMULX_elt_2 | FABD_4 | FABD_2 | FCADD_vec => {
            let kk = match op {
                FADD_2 | FCADD_vec => 0,
                FSUB_2 | FABD_4 | FABD_2 => 1,
                FDIV_2 => 3,
                _ => 2,
            };
            let abs = matches!(op, FABD_4 | FABD_2);
            arith(c, cx, i, k, (d, q, rd), kk, abs, &nsrc, &factor);
        }
        // Pairwise (Vm:Vn's adjacent lanes; the scalar forms Vn's two): the even
        // lanes and the odd ones side by side, then the lane rules.
        FADDP_vec_2 | FMAXP_vec_2 | FMINP_vec_2 | FMAXNMP_vec_2 | FMINNMP_vec_2 | FADDP_pair_2
        | FMAXP_pair_2 | FMINP_pair_2 | FMAXNMP_pair_2 | FMINNMP_pair_2 => {
            let (lb, n) = if d {
                (8u8, 2u8)
            } else {
                (4, if q { 4 } else { 2 })
            };
            // Lane j of the pairs' first (`odd` 0) or second operands: lane 2j + odd of Vm:Vn.
            let pick = |odd: u8| -> [u8; 16] {
                core::array::from_fn(|b| {
                    let (j, byte) = (b as u8 / lb, b as u8 % lb);
                    let e = if sc { odd } else { 2 * (j % n) + odd };
                    // Vn's lanes, then Vm's (16 bytes on).
                    let lane = if e < n { e } else { e - n + 16 / lb };
                    lane * lb + byte
                })
            };
            for (odd, t) in [(0, ta), (1, tb)] {
                vreg(c, rn);
                vreg(c, if sc { rn } else { rm });
                c.shuffle(pick(odd));
                c.local_set(t);
            }
            let pa = &|c: &mut Func| {
                c.local_get(ta);
            };
            let pb = &|c: &mut Func| {
                c.local_get(tb);
            };
            match op {
                FADDP_vec_2 | FADDP_pair_2 => arith(c, cx, i, k, (d, q, rd), 0, false, pa, pb),
                _ => {
                    let max = matches!(
                        op,
                        FMAXP_vec_2 | FMAXNMP_vec_2 | FMAXP_pair_2 | FMAXNMP_pair_2
                    );
                    minmax(c, cx, i, k, (d, q, rd), max, pa, pb);
                }
            }
        }
        // FMAXV/FMINV, FMAXNMV/FMINNMV (four singles): lanes 0 and 1 against
        // 2 and 3, then the two (the order doesn't matter without NaNs).
        FMAXV_2 | FMINV_2 | FMAXNMV_2 | FMINNMV_2 if q && !d => {
            let mm = op::MINMAX[0][matches!(op, FMAXV_2 | FMAXNMV_2) as usize];
            vreg(c, rn);
            vreg(c, rn);
            vreg(c, rn);
            c.shuffle(core::array::from_fn(|b| 8 + b as u8 % 8));
            c.simd(mm).local_tee(tr).local_get(tr).local_get(tr);
            c.shuffle(core::array::from_fn(|b| 4 + b as u8 % 4));
            c.simd(mm)
                .v128_const(0xffff_ffff)
                .simd(op::AND)
                .local_set(tr);
            vreg(c, rn);
            plain_lanes(c, false);
            every_lane(c, false, true, 1);
            guarded(c, cx, i, k, vbit(rd), |c| {
                c.local_get(tr);
                c.vset(rd);
            });
        }
        // Fused on a host whose relaxed `madd` fuses (`Ctx::fma`): that op, one
        // rounding, its first factor negated in the op itself (`nmadd` is
        // madd(-a, b, c)). Doubles: a fast result (the factors' bound is the
        // emulation's). Singles take an exact zero too, as the emulated form
        // does, but there's no double sum to read it from.
        FMLA_vec_2 | FMLS_vec_2 | FMLA_elt_4 | FMLS_elt_4 | FMLA_elt_2 | FMLS_elt_2 | FRECPS_4
        | FRECPS_2 | FRSQRTS_4 | FRSQRTS_2 | FCMLA_vec | FCMLA_elt
            if cx.fma =>
        {
            fpa_guard(c);
            let (neg, acc, half) = fma_kind(op, d, rd);
            let neg = neg || fneg;
            nsrc(c);
            factor(c);
            acc(c);
            c.simd(op::MADD[d as usize][neg as usize]);
            if half {
                // FRSQRTS: exact, or a denormal the check rejects.
                let k = if d {
                    splat(true, 0.5f64.to_bits())
                } else {
                    splat(false, 0.5f32.to_bits() as u64)
                };
                c.v128_const(k)
                    .simd(if d { op::F64X2[2] } else { op::F32X4[2] });
            }
            c.local_set(tr);
            let fz = |c: &mut Func| {
                under_fz_bad(c, |c| {
                    denormal_any(c, d, &[&nsrc, &factor, &acc]);
                })
            };
            c.local_get(tr);
            lanes_in(c, d, 2);
            fz(c);
            if d {
                all_lanes(c, d, q, 1);
            } else {
                // Without a lane outside the fast results, nothing more: one
                // reduction. Else a zero lane may be fine: it's exact with a zero
                // factor (then the addend is the zero result) or an addend from
                // 2^-100 up: a nonzero exact sum is then a multiple of 2^-148
                // (the addend's last place, and the product's: a product near
                // 2^-100 has 48 bits), which rounds to no zero. Anything else may
                // be a tiny sum rounded to zero, with Underflow: the helper.
                every_lane(c, d, q, 1);
                c.if_t(super::I32).i32_const(1).else_();
                c.local_get(tr);
                lanes_in(c, d, 2);
                c.local_get(tr);
                zero_lanes(c, d);
                nsrc(c);
                zero_lanes(c, d);
                factor(c);
                zero_lanes(c, d);
                acc(c);
                c.simd(op::ABS[0]);
                c.v128_const(splat(false, 2f32.powi(-100).to_bits() as u64))
                    .simd(op::CMP[0][4]);
                c.simd(op::OR).simd(op::OR).simd(op::AND).simd(op::OR);
                fz(c);
                every_lane(c, d, q, 1);
                c.end();
                c.local_get(FPOK).op(AND);
            }
            guarded(c, cx, i, k, vbit(rd), |c| vput(c, rd, q, tr));
        }
        // Fused, double precision: the scalar double FMA's algorithm on f64x2
        // (Veltkamp, Dekker, TwoSum, round to odd, docs/jit.md "Floating
        // point"), its guard lane by lane. Five v128 scratch locals: the low
        // halves of the splits are recomputed from the operands.
        FMLA_vec_2 | FMLS_vec_2 | FMLA_elt_4 | FMLS_elt_4 | FMLA_elt_2 | FMLS_elt_2 | FRECPS_4
        | FRECPS_2 | FRSQRTS_4 | FRSQRTS_2 | FCMLA_vec | FCMLA_elt
            if d =>
        {
            fpa_guard(c);
            let (neg, acc, half) = fma_kind(op, d, rd);
            let neg = neg || fneg;
            let (p, ah, bh, pl) = (ta, tb, tt, VTMP);
            let (add, sub, mul) = (op::F64X2[0], op::F64X2[1], op::F64X2[2]);
            let va = |c: &mut Func| {
                nsrc(c);
                if neg {
                    c.simd(op::F64X2_NEG);
                }
            };
            // A by-element factor is a shuffle: made once, in `tr` (free until
            // TwoSum's), then in `bh` for the guard (V8 doesn't merge the
            // shuffles: one `dup` each).
            let held = |l: u32| {
                move |c: &mut Func| {
                    if held_factor {
                        c.local_get(l);
                    } else {
                        factor(c);
                    }
                }
            };
            if held_factor {
                factor(c);
                c.local_set(tr);
            }
            let fb = held(tr);
            va(c);
            fb(c);
            c.simd(mul).local_set(p);
            // Veltkamp: h = g - (g - v), g = (2^27 + 1)·v; l = v - h on the fly
            // (g in `pl`, set only after).
            let k27 = splat(true, 134217729f64.to_bits());
            for (h, v) in [(ah, &va as &dyn Fn(&mut Func)), (bh, &fb)] {
                c.v128_const(k27);
                v(c);
                c.simd(mul).local_tee(pl).local_get(pl);
                v(c);
                c.simd(sub).simd(sub).local_set(h);
            }
            let low = |c: &mut Func, h: u32, v: &dyn Fn(&mut Func)| {
                v(c);
                c.local_get(h).simd(sub);
            };
            // pl = ((ah·bh - p) + ah·bl + al·bh) + al·bl.
            c.local_get(ah)
                .local_get(bh)
                .simd(mul)
                .local_get(p)
                .simd(sub);
            c.local_get(ah);
            low(c, bh, &fb);
            c.simd(mul).simd(add);
            low(c, ah, &va);
            c.local_get(bh).simd(mul).simd(add);
            low(c, ah, &va);
            low(c, bh, &fb);
            c.simd(mul).simd(add).local_set(pl);
            // TwoSum(c, p): th (into ah), tl (into tr); bb in bh.
            let (th, tl, bb) = (ah, tr, bh);
            acc(c);
            c.local_get(p).simd(add).local_tee(th);
            acc(c);
            c.simd(sub).local_set(bb);
            acc(c);
            c.local_get(th).local_get(bb).simd(sub).simd(sub);
            c.local_get(p)
                .local_get(bb)
                .simd(sub)
                .simd(add)
                .local_set(tl);
            // TwoSum(tl, pl): s (into p), the error (into pl).
            let s = p;
            c.local_get(tl).local_get(pl).simd(add).local_tee(s);
            c.local_get(tl).simd(sub).local_set(bb);
            c.local_get(tl)
                .local_get(s)
                .local_get(bb)
                .simd(sub)
                .simd(sub);
            c.local_get(pl)
                .local_get(bb)
                .simd(sub)
                .simd(add)
                .local_set(pl);
            // v = s rounded to odd: + (((s ^ e) >> 63) | 1) where inexact and s even.
            c.local_get(s);
            c.local_get(s).local_get(pl).simd(op::XOR);
            c.i32_const(63).simd(op::I64X2_SHR_S);
            c.v128_const(splat(true, 1)).simd(op::OR);
            // Inexact: |e| > 0, false for a NaN error (as the scalar to_odd).
            c.local_get(pl).simd(op::F64X2_ABS);
            c.v128_const(0).simd(op::F64X2_GT);
            c.local_get(s).v128_const(splat(true, 1)).simd(op::AND);
            c.v128_const(0)
                .simd(op::I64X2_EQ)
                .simd(op::AND)
                .simd(op::AND);
            c.simd(op::I64X2_ADD);
            c.local_get(th).simd(add); // z = th + v
            if half {
                c.v128_const(splat(true, 0.5f64.to_bits())).simd(mul); // exact, or a denormal the check rejects
            }
            c.local_set(tr);
            // As the scalar form: no denormal factor, a product from 2^-900, or
            // a zero factor (e' = e - 1: (e'a | e'b) ≥ 0, e'a + e'b ≥ 1144); a
            // fast result.
            if held_factor {
                factor(c);
                c.local_set(bh);
            }
            let fb = held(bh);
            for (v, t) in [(&va as &dyn Fn(&mut Func), ta), (&fb, tb)] {
                v(c);
                c.i32_const(1).simd(op::I64X2_SHL);
                c.i32_const(53).simd(op::I64X2_SHR_U);
                c.v128_const(splat(true, 1))
                    .simd(op::I64X2_SUB)
                    .local_set(t);
            }
            c.local_get(ta).local_get(tb).simd(op::I64X2_ADD);
            c.v128_const(splat(true, 1144)).simd(op::I64X2_GE_S);
            c.local_get(ta).local_get(tb).simd(op::OR);
            c.v128_const(0).simd(op::I64X2_GE_S).simd(op::AND);
            nsrc(c);
            zero_lanes(c, true);
            fb(c);
            zero_lanes(c, true);
            c.simd(op::OR).simd(op::OR);
            c.local_get(tr);
            lanes_in(c, true, 2);
            under_fz_bad(c, |c| {
                denormal_any(c, true, &[&nsrc, &fb, &acc]);
            });
            all_lanes(c, true, q, 2);
            guarded(c, cx, i, k, vbit(rd), |c| vput(c, rd, q, tr));
        }
        // Fused, single precision (docs/jit.md "Floating point"): each half
        // through f64x2, the product exact, its sum with the addend rounded to
        // nearest, then demoted: correct off the singles' midpoints; with a sum
        // on one, the sums rounded to odd (TwoSum, as the scalar form).
        FMLA_vec_2 | FMLS_vec_2 | FMLA_elt_4 | FMLS_elt_4 | FMLA_elt_2 | FMLS_elt_2 | FRECPS_4
        | FRECPS_2 | FRSQRTS_4 | FRSQRTS_2 | FCMLA_vec | FCMLA_elt => {
            fpa_guard(c);
            let (neg, acc, half) = fma_kind(op, d, rd);
            let neg = neg || fneg;
            let halves: &[bool] = if q { &[false, true] } else { &[false] };
            let (add, sub) = (op::F64X2[0], op::F64X2[1]);
            let (p, a) = (VTMP, tr);
            // The sums of each half into ta and tb: RN, or (`odd`) rounded to odd.
            let sums = |c: &mut Func, odd: bool| {
                // By element, both halves of the factor are the element: promoted
                // once, into tb until the second half's sum.
                if same_halves {
                    factor(c);
                    c.simd(op::PROMOTE).local_set(tb);
                }
                for (&hi, &t) in halves.iter().zip(&[ta, tb]) {
                    // p = promote(half of Vn (negated for FMLS)) × promote(half of
                    // the factor), a = promote(half of Vd).
                    for step in 0..3 {
                        if step == 1 && same_halves {
                            c.local_get(tb).simd(op::F64X2[2]).local_set(p);
                            continue;
                        }
                        match step {
                            0 => nsrc(c),
                            1 => factor(c),
                            _ => acc(c),
                        }
                        if step == 0 && neg {
                            c.simd(op::F32X4_NEG);
                        }
                        if hi {
                            c.local_tee(tt).local_get(tt);
                            c.shuffle(core::array::from_fn(|b| 8 + b as u8 % 8));
                        }
                        c.simd(op::PROMOTE);
                        match step {
                            1 => c.simd(op::F64X2[2]).local_set(p),
                            2 => c.local_set(a),
                            _ => c,
                        };
                    }
                    c.local_get(p).local_get(a).simd(add);
                    if !odd {
                        c.local_set(t);
                        continue;
                    }
                    // TwoSum: s = p + a (into t), bb = s - p (in tt), the error
                    // (into a) = (p - (s - bb)) + (a - bb).
                    c.local_tee(t);
                    c.local_get(p).simd(sub).local_set(tt);
                    c.local_get(p)
                        .local_get(t)
                        .local_get(tt)
                        .simd(sub)
                        .simd(sub);
                    c.local_get(a)
                        .local_get(tt)
                        .simd(sub)
                        .simd(add)
                        .local_set(a);
                    // t rounded to odd: + (((s ^ e) >> 63) | 1) where inexact and s even.
                    c.local_get(t);
                    c.local_get(t).local_get(a).simd(op::XOR);
                    c.i32_const(63).simd(op::I64X2_SHR_S);
                    c.v128_const(splat(true, 1)).simd(op::OR);
                    c.local_get(a).v128_const(0).simd(op::F64X2_NE);
                    c.local_get(t).v128_const(splat(true, 1)).simd(op::AND);
                    c.v128_const(0)
                        .simd(op::I64X2_EQ)
                        .simd(op::AND)
                        .simd(op::AND);
                    c.simd(op::I64X2_ADD).local_set(t);
                }
            };
            sums(c, false);
            // A sum on a single midpoint (the sums' low words side by side, their
            // low 29 bits 1 << 28): every sum again, rounded to odd.
            c.local_get(ta).local_get(if q { tb } else { ta });
            c.shuffle(core::array::from_fn(|b| (b as u8 / 4) * 8 + b as u8 % 4));
            // Low 29 bits 1 << 28: shifted left by 3, the sign bit alone.
            c.i32_const(3).simd(op::I32X4_SHL);
            c.v128_const(splat(false, (MID as u64) << 3))
                .simd(op::I32X4_EQ);
            c.simd(op::ANY_TRUE).hint(false).if_();
            sums(c, true);
            c.end();
            // r = the demoted halves side by side (FRSQRTS: halved first, exactly).
            for (t, on) in [(ta, true), (tb, q)] {
                if !on {
                    continue;
                }
                c.local_get(t);
                if half {
                    c.v128_const(splat(true, 0.5f64.to_bits()))
                        .simd(op::F64X2[2]);
                }
                c.simd(op::DEMOTE);
            }
            if !q {
                c.v128_const(0);
            }
            c.shuffle(core::array::from_fn(|b| {
                if b < 8 { b as u8 } else { 8 + b as u8 }
            }));
            c.local_set(tr);
            // A fast result, or an exact zero: a double sum that's zero (the
            // product is exact in a double, and a nonzero exact sum can't round
            // to zero there; a tiny one demotes to a zero with Underflow, and
            // 0 × ∞ is a NaN). The sums' lanes, as singles: their low words.
            c.local_get(tr);
            lanes_in(c, false, 2);
            for t in [ta, if q { tb } else { ta }] {
                c.local_get(t);
                zero_lanes(c, true);
            }
            c.shuffle(core::array::from_fn(|b| (b as u8 / 4) * 8 + b as u8 % 4));
            c.simd(op::OR);
            under_fz_bad(c, |c| {
                denormal_any(c, false, &[&nsrc, &factor, &acc]);
            });
            all_lanes(c, false, q, 1);
            guarded(c, cx, i, k, vbit(rd), |c| vput(c, rd, q, tr));
        }
        // SCVTF/UCVTF: wasm's converts round to nearest even (FPOK); 64-bit
        // lanes one at a time (no i64x2 convert).
        SCVTF_int_4 | UCVTF_int_4 | SCVTF_fix_2 | UCVTF_fix_2 | SCVTF_fix_1 | UCVTF_fix_1 => {
            let Some(scale) = fixed(op, i, d, -1) else {
                return false;
            };
            fpa_guard(c);
            let u = bit(i, 29);
            if d {
                c.v128_const(0);
                for lane in 0..2 {
                    vreg(c, rn);
                    c.simd_lane(0x1d, lane); // i64x2.extract_lane
                    c.op(0xb9 + u as u8); // f64.convert_i64_s/u
                    c.simd_lane(0x22, lane); // f64x2.replace_lane
                }
            } else {
                vreg(c, rn);
                c.simd(op::CONVERT_I32X4[u as usize]);
            }
            // Fixed point: × 2^-fbits, exact (never below 2^-64).
            if let Some(m) = scale {
                c.v128_const(m)
                    .simd(if d { op::F64X2[2] } else { op::F32X4[2] });
            }
            c.local_set(tr);
            c.local_get(FPOK);
            guarded(c, cx, i, k, vbit(rd), |c| vput(c, rd, q, tr));
        }
        // FCVT{N,M,A,P,Z}{S,U}: each lane rounded in the instruction's mode
        // (ties away as FRINTA), then lanes whose rounded value fits (FPOK:
        // Inexact is set already; a NaN or ∞ doesn't) go through the saturating
        // truncation; 64-bit lanes one at a time (no i64x2 truncation).
        FCVTNS_4 | FCVTNU_4 | FCVTMS_4 | FCVTMU_4 | FCVTAS_4 | FCVTAU_4 | FCVTPS_4 | FCVTPU_4
        | FCVTZS_int_4 | FCVTZU_int_4 | FCVTZS_fix_2 | FCVTZU_fix_2 | FCVTZS_fix_1
        | FCVTZU_fix_1 => {
            let Some(scale) = fixed(op, i, d, 1) else {
                return false;
            };
            fpa_guard(c);
            let u = bit(i, 29);
            let mode = match op {
                FCVTNS_4 | FCVTNU_4 => Round::Nearest,
                FCVTMS_4 | FCVTMU_4 => Round::Floor,
                FCVTPS_4 | FCVTPU_4 => Round::Ceil,
                FCVTAS_4 | FCVTAU_4 => Round::Away,
                _ => Round::Trunc,
            };
            // Fixed point: × 2^fbits first (exact, or an infinity the range check rejects).
            vround(c, d, &|c| vscaled(c, d, rn, scale), mode);
            c.local_set(ta);
            if d {
                c.v128_const(0);
                for lane in 0..2 {
                    c.local_get(ta).simd_lane(0x21, lane); // f64x2.extract_lane
                    c.op(0xfc).op(6 + u as u8); // i64.trunc_sat_f64_s/u
                    c.simd_lane(0x1e, lane); // i64x2.replace_lane
                }
            } else {
                c.local_get(ta).simd(op::TRUNC_SAT_F32X4[u as usize]);
            }
            c.local_set(tr);
            let hi = 2f64.powi(if d { 64 } else { 32 } - !u as i32);
            let lo = if u { 0.0 } else { -hi };
            for (bound, cmp) in [(lo, 4), (hi, 1)] {
                c.local_get(ta);
                if d {
                    c.f64_const(bound).simd(op::F64X2_SPLAT);
                } else {
                    c.f32_const(bound as f32).simd(op::F32X4_SPLAT);
                }
                c.simd(op::CMP[d as usize][cmp]); // ge, lt
            }
            under_fz_bad(c, |c| {
                denormal_any(c, d, &[&|c| vreg(c, rn)]);
            });
            all_lanes(c, d, q, 2);
            guarded(c, cx, i, k, vbit(rd), |c| vput(c, rd, q, tr));
        }
        // FMAX/FMIN, FMAXNM/FMINNM: `minmax`.
        FMAX_2 | FMIN_2 | FMAXNM_2 | FMINNM_2 => {
            let max = matches!(op, FMAX_2 | FMAXNM_2);
            minmax(c, cx, i, k, (d, q, rd), max, &|c| vreg(c, rn), &|c| {
                vreg(c, rm)
            });
        }
        // FRINTA: ties away as the scalar form (`round`), lane by lane; no NaN
        // or denormal lanes, no flags.
        FRINTA_2 => {
            vround(c, d, &|c| vreg(c, rn), Round::Away);
            c.local_set(tr);
            vreg(c, rn);
            plain_lanes(c, d);
            every_lane(c, d, q, 1);
            guarded(c, cx, i, k, vbit(rd), |c| vput(c, rd, q, tr));
        }
        // FCVTXN(2): each double to a single rounded to odd as the scalar form
        // (`to_odd_single`), into Vd's low half (top cleared) or, FCVTXN2, its
        // top half (the low half kept).
        FCVTXN_2 if d => {
            fpa_guard(c);
            let (xd, r32) = (super::tmp(true, 0), super::tmp(false, 3));
            if q {
                vreg(c, rd);
            } else {
                c.v128_const(0);
            }
            c.local_set(tr);
            c.local_get(FPOK);
            for lane in 0..2u8 {
                vreg(c, rn);
                c.simd_lane(0x1d, lane).local_set(xd); // i64x2.extract_lane
                to_odd_single(c, xd, r32);
                is_zero(c, F { d: true }, xd);
                c.op(0x72).op(AND); // i32.or, and
                c.local_get(tr).local_get(r32);
                c.simd_lane(0x1c, lane + 2 * q as u8).local_set(tr); // i32x4.replace_lane
            }
            under_fz(c, |c| {
                denormal_any(c, true, &[&|c| vreg(c, rn)]);
                c.simd(op::ANY_TRUE).op(EQZ);
            });
            guarded(c, cx, i, k, vbit(rd), |c| vput(c, rd, true, tr));
        }
        // FRECPE, FRSQRTE: `estimate` lane by lane; no flags, no FPOK.
        FRECPE_4 | FRSQRTE_4 => {
            let f = F { d };
            let (x, r) = (f.tmp(0), f.tmp(3));
            let n = if d {
                2
            } else if q {
                4
            } else {
                2
            };
            c.v128_const(0).local_set(tr);
            c.i32_const(1);
            for lane in 0..n {
                vreg(c, rn);
                c.simd_lane(if d { 0x1d } else { 0x1b }, lane).local_set(x); // extract_lane
                estimate(c, f, x, r, op == FRSQRTE_4);
                c.op(AND);
                c.local_get(tr).local_get(r);
                c.simd_lane(if d { 0x1e } else { 0x1c }, lane).local_set(tr); // replace_lane
            }
            guarded(c, cx, i, k, vbit(rd), |c| vput(c, rd, q, tr));
        }
        // FABS, FNEG: bit operations, no flags.        // FABS, FNEG: bit operations, no flags.
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
        // The scalar FCVT's rule lane by lane. FCVTL(2), single to double:
        // exact, so no FPOK; any lane but a NaN (or, under FZ, a denormal).
        // FCVTN(2), double to single: under FPOK, a fast result or a zero
        // from a zero (a NaN or infinite source makes a result the test
        // rejects; a denormal or tiny one, a zero or denormal result that
        // isn't a zero's). Half precision (sz = 0) and FCVTXN stay helper
        // calls.
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
                plain_lanes(c, false);
                every_lane(c, false, false, 1);
                guarded(c, cx, i, k, vbit(rd), |c| vput(c, rd, true, tr));
            } else {
                vreg(c, rn);
                c.simd(op::DEMOTE).local_tee(ta);
                lanes_in(c, false, 2);
                // The source's zero lanes, narrowed to the result's two.
                vreg(c, rn);
                zero_lanes(c, true);
                c.v128_const(0);
                c.shuffle(core::array::from_fn(|b| match b {
                    0..4 => b as u8,
                    4..8 => 4 + b as u8,
                    _ => 16,
                }));
                c.simd(op::OR);
                all_lanes(c, false, false, 1);
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
                guarded(c, cx, i, k, vbit(rd), |c| vput(c, rd, true, tr));
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
            guarded(c, cx, i, k, vbit(rd), |c| vput(c, rd, q, tr));
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
            guarded(c, cx, i, k, vbit(rd), |c| vput(c, rd, q, tr));
        }
        // FRINT32Z/X, FRINT64Z/X (FEAT_FRINTTS; U (29) is the FPCR's mode,
        // opcode<0> (12) 64 bits): the scalar forms' rule lane by lane.
        FRINT32X_1 | FRINT64X_1 | FRINT32Z_1 | FRINT64Z_1
            if cx.features & crate::cpu::FEATURE_FRINTTS != 0 =>
        {
            fpa_guard(c);
            vreg(c, rn);
            c.simd(op::ROUND[d as usize][if bit(i, 29) { 0 } else { 3 }])
                .local_set(tr);
            vreg(c, rn);
            plain_lanes(c, d);
            let lim = 2f64.powi(if bit(i, 12) { 63 } else { 31 });
            let bits = |v: f64| {
                if d {
                    v.to_bits()
                } else {
                    (v as f32).to_bits() as u64
                }
            };
            for (v, cmp) in [(-lim, 4), (lim, 1)] {
                c.local_get(tr).v128_const(splat(d, bits(v)));
                c.simd(op::CMP[d as usize][cmp]); // ge, lt
            }
            all_lanes(c, d, q, 3);
            guarded(c, cx, i, k, vbit(rd), |c| vput(c, rd, q, tr));
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
            guarded(c, cx, i, k, vbit(rd), |c| vput(c, rd, true, tr));
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
            guarded(c, cx, i, k, vbit(rd), |c| vput(c, rd, true, tr));
        }
        _ => return false,
    }
    true
}
