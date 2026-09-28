//! Floating point with ARM semantics (docs/cpu.md "Floating point").
//!
//! The slow path is a software implementation of the ARM pseudocode (FPUnpack,
//! FPRound, FPProcessNaNs, FPMulAdd, FPToFixed, FPRoundInt, FPConvert) over one
//! generic format description: values are unpacked to `mant × 2^exp` with an
//! integer mantissa, computed exactly (or with a sticky bit) in `u128`, and
//! rounded once. It handles every rounding mode, FPCR.FZ and FPCR.DN, and
//! raises exact FPSR flags. TestFloat vectors check it (`core/tests/testfloat.rs`).
//!
//! The fast paths (single and double add, sub, mul, div, sqrt) use host
//! arithmetic only where it is exactly right: round-to-nearest-even, normal
//! inputs and a normal result, so no NaN, denormal or FZ question comes up. The
//! inexact flag comes from an exact error computation. Everything else,
//! including every NaN, falls back to the slow path: host and wasm NaN
//! behavior never reaches the guest.

use core::cmp::Ordering;

/// FPSR cumulative flags.
pub const IOC: u64 = 1;
pub const DZC: u64 = 2;
pub const OFC: u64 = 4;
pub const UFC: u64 = 8;
pub const IXC: u64 = 16;
pub const IDC: u64 = 128;

/// A binary floating-point format: exponent and fraction widths.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Fmt {
    pub e: u32,
    pub f: u32,
}

pub const H: Fmt = Fmt { e: 5, f: 10 };
pub const S: Fmt = Fmt { e: 8, f: 23 };
pub const D: Fmt = Fmt { e: 11, f: 52 };

impl Fmt {
    pub fn bits(self) -> u32 {
        1 + self.e + self.f
    }
    fn exp_ones(self) -> u64 {
        (1 << self.e) - 1
    }
    fn bias(self) -> i32 {
        (1 << (self.e - 1)) - 1
    }
    /// Exponent of the smallest normal number.
    fn min_exp(self) -> i32 {
        1 - self.bias()
    }
    fn sign(self) -> u64 {
        1 << (self.e + self.f)
    }
    fn qbit(self) -> u64 {
        1 << (self.f - 1)
    }
    fn frac_mask(self) -> u64 {
        (1 << self.f) - 1
    }
    pub fn zero(self, sign: bool) -> u64 {
        if sign { self.sign() } else { 0 }
    }
    pub fn inf(self, sign: bool) -> u64 {
        self.zero(sign) | self.exp_ones() << self.f
    }
    fn max_normal(self, sign: bool) -> u64 {
        self.inf(sign) - 1
    }
    pub fn default_nan(self) -> u64 {
        self.exp_ones() << self.f | self.qbit()
    }
    pub fn is_nan(self, x: u64) -> bool {
        (x >> self.f) & self.exp_ones() == self.exp_ones() && x & self.frac_mask() != 0
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Rounding {
    TieEven,
    PosInf,
    NegInf,
    Zero,
    TieAway,
    /// Von Neumann rounding (FCVTXN).
    Odd,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Class {
    Zero,
    /// Normal or denormal: `mant × 2^exp`, `mant` nonzero.
    Num,
    Inf,
    QNaN,
    SNaN,
}

#[derive(Clone, Copy, Debug)]
struct Val {
    class: Class,
    sign: bool,
    exp: i32,
    mant: u64,
}

impl Val {
    fn nan(&self) -> bool {
        matches!(self.class, Class::QNaN | Class::SNaN)
    }
}

/// Where the discarded part of a rounded value lies, in units of the last place kept.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Rest {
    Zero,
    Below,
    Half,
    Above,
}

/// `m` shifted right by `sh`, and what was shifted out (plus a sticky bit below `m`).
fn shift_rest(m: u128, sh: i32, sticky: bool) -> (u128, Rest) {
    if sh <= 0 {
        // Callers keep the value under 2^127, so this can't overflow.
        return (m << -sh, if sticky { Rest::Below } else { Rest::Zero });
    }
    if sh >= 128 {
        // m < 2^127: the value is under half a unit.
        return (
            0,
            if m != 0 || sticky {
                Rest::Below
            } else {
                Rest::Zero
            },
        );
    }
    let rem = m & ((1u128 << sh) - 1);
    let half = 1u128 << (sh - 1);
    let rest = match rem.cmp(&half) {
        _ if rem == 0 && !sticky => Rest::Zero,
        Ordering::Less => Rest::Below,
        Ordering::Equal if !sticky => Rest::Half,
        _ => Rest::Above,
    };
    (m >> sh, rest)
}

/// Whether rounding the magnitude `q` (with `rest` discarded) goes up by one.
fn round_up(rm: Rounding, rest: Rest, q_odd: bool, sign: bool) -> bool {
    match rm {
        Rounding::TieEven => rest == Rest::Above || (rest == Rest::Half && q_odd),
        Rounding::TieAway => matches!(rest, Rest::Half | Rest::Above),
        Rounding::PosInf => rest != Rest::Zero && !sign,
        Rounding::NegInf => rest != Rest::Zero && sign,
        Rounding::Zero | Rounding::Odd => false,
    }
}

/// Floating-point context for one instruction: FPCR in, FPSR flags out.
pub struct Fpu {
    pub fpcr: u64,
    /// Flags raised so far (OR them into FPSR).
    pub flags: u64,
}

impl Fpu {
    pub fn new(fpcr: u64) -> Fpu {
        Fpu { fpcr, flags: 0 }
    }

    /// FPCR.RMode.
    pub fn rounding(&self) -> Rounding {
        match (self.fpcr >> 22) & 3 {
            0 => Rounding::TieEven,
            1 => Rounding::PosInf,
            2 => Rounding::NegInf,
            _ => Rounding::Zero,
        }
    }
    fn fz(&self, f: Fmt) -> bool {
        // FZ applies to single and double; half precision would need FZ16.
        self.fpcr & (1 << 24) != 0 && f != H
    }
    fn dn(&self) -> bool {
        self.fpcr & (1 << 25) != 0
    }
    fn ahp(&self) -> bool {
        self.fpcr & (1 << 26) != 0
    }
    /// The fast paths apply: round to nearest even (FZ and DN only matter off them).
    fn fast(&self) -> bool {
        (self.fpcr >> 22) & 3 == 0
    }

    /// FPUnpack. `ahp`: half precision in the alternative format (no infinities or NaNs).
    fn unpack_with(&mut self, f: Fmt, x: u64, ahp: bool) -> Val {
        let sign = x & f.sign() != 0;
        let ex = (x >> f.f) & f.exp_ones();
        let fr = x & f.frac_mask();
        let (class, exp, mant) = if ex == 0 {
            if fr == 0 {
                (Class::Zero, 0, 0)
            } else if self.fz(f) {
                self.flags |= IDC;
                (Class::Zero, 0, 0)
            } else {
                (Class::Num, f.min_exp() - f.f as i32, fr)
            }
        } else if ex == f.exp_ones() && !ahp {
            let c = if fr == 0 {
                Class::Inf
            } else if fr & f.qbit() != 0 {
                Class::QNaN
            } else {
                Class::SNaN
            };
            (c, 0, 0)
        } else {
            (Class::Num, ex as i32 - f.bias() - f.f as i32, fr | 1 << f.f)
        };
        Val {
            class,
            sign,
            exp,
            mant,
        }
    }

    fn unpack(&mut self, f: Fmt, x: u64) -> Val {
        self.unpack_with(f, x, false)
    }

    /// FPProcessNaN: quiet an SNaN (raising Invalid Operation); the default NaN under DN.
    fn process_nan(&mut self, f: Fmt, v: &Val, x: u64) -> u64 {
        if v.class == Class::SNaN {
            self.flags |= IOC;
        }
        if self.dn() {
            f.default_nan()
        } else {
            x | f.qbit()
        }
    }

    /// FPProcessNaNs: the first SNaN, else the first QNaN, in operand order.
    fn process_nans(&mut self, f: Fmt, ops: &[(Val, u64)]) -> Option<u64> {
        let pick = ops
            .iter()
            .find(|(v, _)| v.class == Class::SNaN)
            .or_else(|| ops.iter().find(|(v, _)| v.class == Class::QNaN));
        pick.map(|(v, x)| self.process_nan(f, v, *x))
    }

    fn invalid(&mut self, f: Fmt) -> u64 {
        self.flags |= IOC;
        f.default_nan()
    }

    /// FPRound (FPRoundBase): rounds `(mant + sticky) × 2^exp`, `mant` nonzero.
    pub(crate) fn round(
        &mut self,
        f: Fmt,
        sign: bool,
        mut exp: i32,
        mut mant: u128,
        mut sticky: bool,
        rm: Rounding,
    ) -> u64 {
        self.round_with(f, sign, &mut exp, &mut mant, &mut sticky, rm, false)
    }

    #[allow(clippy::too_many_arguments)]
    fn round_with(
        &mut self,
        f: Fmt,
        sign: bool,
        exp: &mut i32,
        mant: &mut u128,
        sticky: &mut bool,
        rm: Rounding,
        ahp: bool,
    ) -> u64 {
        debug_assert!(*mant != 0);
        if mant.leading_zeros() == 0 {
            *sticky |= *mant & 1 != 0;
            *mant >>= 1;
            *exp += 1;
        }
        // The value is in [2^exponent, 2^(exponent + 1)).
        let exponent = 127 - mant.leading_zeros() as i32 + *exp;
        let ff = f.f as i32;
        if self.fz(f) && exponent < f.min_exp() {
            // Flush to zero: Underflow, but not Inexact.
            self.flags |= UFC;
            return f.zero(sign);
        }
        let biased = (exponent - f.min_exp() + 1).max(0);
        let ee = if biased == 0 { f.min_exp() } else { exponent };
        let (q, rest) = shift_rest(*mant, ee - ff - *exp, *sticky);
        let mut q = q as u64;
        let mut be = biased as u64;
        if biased == 0 && rest != Rest::Zero {
            self.flags |= UFC;
        }
        if round_up(rm, rest, q & 1 == 1, sign) {
            q += 1;
        }
        if rm == Rounding::Odd && rest != Rest::Zero {
            q |= 1;
        }
        if q >= 2 << ff {
            q >>= 1;
            be += 1;
        } else if be == 0 && q >= 1 << ff {
            be = 1;
        }
        let mut inexact = rest != Rest::Zero;
        let r = if !ahp {
            if be >= f.exp_ones() {
                self.flags |= OFC;
                inexact = true;
                let to_inf = match rm {
                    Rounding::TieEven | Rounding::TieAway => true,
                    Rounding::PosInf => !sign,
                    Rounding::NegInf => sign,
                    Rounding::Zero | Rounding::Odd => false,
                };
                if to_inf {
                    f.inf(sign)
                } else {
                    f.max_normal(sign)
                }
            } else {
                f.zero(sign) | be << f.f | (q & f.frac_mask())
            }
        } else if be > f.exp_ones() {
            // Alternative half precision has no infinity: saturate, Invalid Operation.
            self.flags |= IOC;
            inexact = false;
            f.zero(sign) | (f.sign() - 1)
        } else {
            f.zero(sign) | be << f.f | (q & f.frac_mask())
        };
        if inexact {
            self.flags |= IXC;
        }
        r
    }

    /// An exact sum rounded, or the zero whose sign the rounding mode picks.
    fn round_sum(&mut self, f: Fmt, s: Sum) -> u64 {
        if s.mant == 0 {
            f.zero(self.rounding() == Rounding::NegInf)
        } else {
            let rm = self.rounding();
            self.round(f, s.sign, s.exp, s.mant, s.sticky, rm)
        }
    }

    // Arithmetic.

    pub fn add(&mut self, f: Fmt, a: u64, b: u64) -> u64 {
        if let Some(r) = self.fast2(f, a, b, Op2::Add) {
            return r;
        }
        self.add_slow(f, a, b, false)
    }

    pub fn sub(&mut self, f: Fmt, a: u64, b: u64) -> u64 {
        if let Some(r) = self.fast2(f, a, b, Op2::Sub) {
            return r;
        }
        self.add_slow(f, a, b, true)
    }

    fn add_slow(&mut self, f: Fmt, a: u64, b: u64, sub: bool) -> u64 {
        let (va, mut vb) = (self.unpack(f, a), self.unpack(f, b));
        if let Some(r) = self.process_nans(f, &[(va, a), (vb, b)]) {
            return r;
        }
        vb.sign ^= sub;
        let (ia, ib) = (va.class == Class::Inf, vb.class == Class::Inf);
        if ia && ib && va.sign != vb.sign {
            return self.invalid(f);
        }
        if ia || ib {
            return f.inf(if ia { va.sign } else { vb.sign });
        }
        if va.class == Class::Zero && vb.class == Class::Zero && va.sign == vb.sign {
            return f.zero(va.sign);
        }
        let s = add_exact(term(&va), term(&vb));
        self.round_sum(f, s)
    }

    pub fn mul(&mut self, f: Fmt, a: u64, b: u64) -> u64 {
        if let Some(r) = self.fast2(f, a, b, Op2::Mul) {
            return r;
        }
        let (va, vb) = (self.unpack(f, a), self.unpack(f, b));
        if let Some(r) = self.process_nans(f, &[(va, a), (vb, b)]) {
            return r;
        }
        self.mul_vals(f, va, vb)
    }

    /// FPMul on unpacked non-NaN operands.
    fn mul_vals(&mut self, f: Fmt, va: Val, vb: Val) -> u64 {
        let sign = va.sign ^ vb.sign;
        let (ia, ib) = (va.class == Class::Inf, vb.class == Class::Inf);
        let (za, zb) = (va.class == Class::Zero, vb.class == Class::Zero);
        if (ia && zb) || (za && ib) {
            return self.invalid(f);
        }
        if ia || ib {
            return f.inf(sign);
        }
        if za || zb {
            return f.zero(sign);
        }
        let rm = self.rounding();
        self.round(
            f,
            sign,
            va.exp + vb.exp,
            va.mant as u128 * vb.mant as u128,
            false,
            rm,
        )
    }

    /// FMULX: FPMul, except infinity × zero is 2 with the product's sign.
    pub fn mulx(&mut self, f: Fmt, a: u64, b: u64) -> u64 {
        let (va, vb) = (self.unpack(f, a), self.unpack(f, b));
        if let Some(r) = self.process_nans(f, &[(va, a), (vb, b)]) {
            return r;
        }
        let (ia, ib) = (va.class == Class::Inf, vb.class == Class::Inf);
        let (za, zb) = (va.class == Class::Zero, vb.class == Class::Zero);
        if (ia && zb) || (za && ib) {
            return f.zero(va.sign ^ vb.sign) | (f.bias() as u64 + 1) << f.f;
        }
        self.mul_vals(f, va, vb)
    }

    pub fn div(&mut self, f: Fmt, a: u64, b: u64) -> u64 {
        if let Some(r) = self.fast2(f, a, b, Op2::Div) {
            return r;
        }
        let (va, vb) = (self.unpack(f, a), self.unpack(f, b));
        if let Some(r) = self.process_nans(f, &[(va, a), (vb, b)]) {
            return r;
        }
        let sign = va.sign ^ vb.sign;
        let (ia, ib) = (va.class == Class::Inf, vb.class == Class::Inf);
        let (za, zb) = (va.class == Class::Zero, vb.class == Class::Zero);
        if (ia && ib) || (za && zb) {
            return self.invalid(f);
        }
        if ia || zb {
            if !ia {
                self.flags |= DZC;
            }
            return f.inf(sign);
        }
        if za || ib {
            return f.zero(sign);
        }
        // Enough quotient bits (at least 70) that the remainder only matters as a sticky bit.
        let sh = 125 - (63 - va.mant.leading_zeros() as i32);
        let n = (va.mant as u128) << sh;
        let (q, r) = (n / vb.mant as u128, n % vb.mant as u128);
        let rm = self.rounding();
        self.round(f, sign, va.exp - sh - vb.exp, q, r != 0, rm)
    }

    pub fn sqrt(&mut self, f: Fmt, a: u64) -> u64 {
        if let Some(r) = self.fast_sqrt(f, a) {
            return r;
        }
        let va = self.unpack(f, a);
        if va.nan() {
            return self.process_nan(f, &va, a);
        }
        match va.class {
            Class::Zero => return f.zero(va.sign),
            _ if va.sign => return self.invalid(f),
            Class::Inf => return f.inf(false),
            _ => {}
        }
        // mant × 2^exp with exp even and mant around 2^120, so the root has 60 bits.
        let mut sh = 120 - (63 - va.mant.leading_zeros() as i32);
        if (va.exp - sh) & 1 != 0 {
            sh += 1;
        }
        let m = (va.mant as u128) << sh;
        let r = isqrt(m);
        let rm = self.rounding();
        self.round(f, false, (va.exp - sh) / 2, r, r * r != m, rm)
    }

    /// FPMulAdd: `addend + a × b` with a single rounding.
    pub fn muladd(&mut self, f: Fmt, addend: u64, a: u64, b: u64) -> u64 {
        let (vc, va, vb) = (self.unpack(f, addend), self.unpack(f, a), self.unpack(f, b));
        let (ia, ib) = (va.class == Class::Inf, vb.class == Class::Inf);
        let (za, zb) = (va.class == Class::Zero, vb.class == Class::Zero);
        let nan = self.process_nans(f, &[(vc, addend), (va, a), (vb, b)]);
        // A quiet-NaN addend doesn't hide the Invalid Operation of infinity × zero.
        if vc.class == Class::QNaN && ((ia && zb) || (za && ib)) {
            return self.invalid(f);
        }
        if let Some(r) = nan {
            return r;
        }
        let sp = va.sign ^ vb.sign;
        let (ic, ip, zc, zp) = (
            vc.class == Class::Inf,
            ia || ib,
            vc.class == Class::Zero,
            za || zb,
        );
        if (ia && zb) || (za && ib) || (ic && ip && vc.sign != sp) {
            return self.invalid(f);
        }
        if ic || ip {
            return f.inf(if ic { vc.sign } else { sp });
        }
        if zc && zp && vc.sign == sp {
            return f.zero(vc.sign);
        }
        let p = if zp {
            Term::ZERO
        } else {
            Term {
                sign: sp,
                exp: va.exp + vb.exp,
                mant: va.mant as u128 * vb.mant as u128,
            }
        };
        let s = add_exact(term(&vc), p);
        self.round_sum(f, s)
    }

    /// FPMax / FPMin.
    pub fn max(&mut self, f: Fmt, a: u64, b: u64, is_max: bool) -> u64 {
        let (va, vb) = (self.unpack(f, a), self.unpack(f, b));
        if let Some(r) = self.process_nans(f, &[(va, a), (vb, b)]) {
            return r;
        }
        let first = match cmp(&va, &vb) {
            Ordering::Greater => is_max,
            Ordering::Less => !is_max,
            Ordering::Equal => false,
        };
        let v = if first { va } else { vb };
        match v.class {
            Class::Inf => f.inf(v.sign),
            Class::Zero => f.zero(if is_max {
                va.sign && vb.sign
            } else {
                va.sign || vb.sign
            }),
            _ => {
                let rm = self.rounding();
                self.round(f, v.sign, v.exp, v.mant as u128, false, rm)
            }
        }
    }

    /// FPMaxNum / FPMinNum: one quiet NaN loses to a number.
    pub fn maxnum(&mut self, f: Fmt, a: u64, b: u64, is_max: bool) -> u64 {
        let (va, vb) = (self.unpack(f, a), self.unpack(f, b));
        let loser = f.inf(is_max);
        let (a, b) = match (va.class == Class::QNaN, vb.class == Class::QNaN) {
            (true, false) => (loser, b),
            (false, true) => (a, loser),
            _ => (a, b),
        };
        self.max(f, a, b, is_max)
    }

    /// FPCompare: NZCV (in bits 31:28). `signal`: quiet NaNs raise Invalid Operation too (FCMPE).
    pub fn compare(&mut self, f: Fmt, a: u64, b: u64, signal: bool) -> u64 {
        let (va, vb) = (self.unpack(f, a), self.unpack(f, b));
        if va.nan() || vb.nan() {
            if signal || va.class == Class::SNaN || vb.class == Class::SNaN {
                self.flags |= IOC;
            }
            return 0x3000_0000;
        }
        match cmp(&va, &vb) {
            Ordering::Equal => 0x6000_0000,
            Ordering::Less => 0x8000_0000,
            Ordering::Greater => 0x2000_0000,
        }
    }

    /// FPCompareEQ/GE/GT for the AdvSIMD compares: `None` if unordered.
    pub fn compare_ord(&mut self, f: Fmt, a: u64, b: u64, signal: bool) -> Option<Ordering> {
        let (va, vb) = (self.unpack(f, a), self.unpack(f, b));
        if va.nan() || vb.nan() {
            if signal || va.class == Class::SNaN || vb.class == Class::SNaN {
                self.flags |= IOC;
            }
            return None;
        }
        Some(cmp(&va, &vb))
    }

    /// FPRoundInt (FRINT*). `exact` raises Inexact (FRINTX).
    pub fn round_int(&mut self, f: Fmt, a: u64, rm: Rounding, exact: bool) -> u64 {
        let va = self.unpack(f, a);
        match va.class {
            Class::QNaN | Class::SNaN => return self.process_nan(f, &va, a),
            Class::Inf => return f.inf(va.sign),
            Class::Zero => return f.zero(va.sign),
            Class::Num => {}
        }
        if va.exp >= 0 {
            return a; // already an integer
        }
        let (q, rest) = shift_rest(va.mant as u128, -va.exp, false);
        let q = q as u64 + round_up(rm, rest, q & 1 == 1, va.sign) as u64;
        if rest != Rest::Zero && exact {
            self.flags |= IXC;
        }
        if q == 0 {
            f.zero(va.sign)
        } else {
            self.round(f, va.sign, 0, q as u128, false, Rounding::Zero)
        }
    }

    /// FPToFixed: `a × 2^fbits` rounded to a `width`-bit integer, saturating.
    pub fn to_fixed(
        &mut self,
        f: Fmt,
        a: u64,
        fbits: u32,
        unsigned: bool,
        width: u32,
        rm: Rounding,
    ) -> u64 {
        let va = self.unpack(f, a);
        let (mag, rest) = match va.class {
            Class::QNaN | Class::SNaN => {
                self.flags |= IOC;
                return 0;
            }
            Class::Zero => (0, Rest::Zero),
            Class::Inf => (u128::MAX, Rest::Zero),
            Class::Num => {
                let e = va.exp + fbits as i32;
                if e > 64 {
                    (u128::MAX, Rest::Zero)
                } else {
                    shift_rest(va.mant as u128, -e, false)
                }
            }
        };
        let mag = mag.saturating_add(round_up(rm, rest, mag & 1 == 1, va.sign) as u128);
        let (lo, hi): (i128, i128) = if unsigned {
            (0, (1i128 << width) - 1)
        } else {
            (-(1i128 << (width - 1)), (1i128 << (width - 1)) - 1)
        };
        let v = if mag > i128::MAX as u128 {
            if va.sign { i128::MIN } else { i128::MAX }
        } else if va.sign {
            -(mag as i128)
        } else {
            mag as i128
        };
        let r = v.clamp(lo, hi);
        if r != v {
            self.flags |= IOC;
        } else if rest != Rest::Zero {
            self.flags |= IXC;
        }
        r as u64 & (u64::MAX >> (64 - width))
    }

    /// FixedToFP: the `width`-bit integer `x` divided by 2^fbits, rounded.
    pub fn from_fixed(
        &mut self,
        f: Fmt,
        x: u64,
        fbits: u32,
        unsigned: bool,
        width: u32,
        rm: Rounding,
    ) -> u64 {
        let x = x & (u64::MAX >> (64 - width));
        let (sign, mag) = if !unsigned && x >> (width - 1) & 1 == 1 {
            (true, (x ^ (u64::MAX >> (64 - width))) as u128 + 1)
        } else {
            (false, x as u128)
        };
        if mag == 0 {
            return f.zero(false);
        }
        self.round(f, sign, -(fbits as i32), mag, false, rm)
    }

    /// FPConvert between formats (FCVT). Half precision honors FPCR.AHP.
    pub fn convert(&mut self, from: Fmt, to: Fmt, a: u64, rm: Rounding) -> u64 {
        let alt = self.ahp();
        let va = self.unpack_with(from, a, from == H && alt);
        let alt_out = to == H && alt;
        match va.class {
            Class::QNaN | Class::SNaN => {
                if va.class == Class::SNaN {
                    self.flags |= IOC;
                }
                if alt_out {
                    if va.class == Class::QNaN {
                        self.flags |= IOC;
                    }
                    to.zero(va.sign)
                } else if self.dn() {
                    to.default_nan()
                } else {
                    // FPConvertNaN: keep the top fraction bits, quieted.
                    let frac = a & from.frac_mask();
                    let frac = if to.f >= from.f {
                        frac << (to.f - from.f)
                    } else {
                        frac >> (from.f - to.f)
                    };
                    to.inf(va.sign) | to.qbit() | frac
                }
            }
            Class::Inf if alt_out => {
                self.flags |= IOC;
                to.zero(va.sign) | (to.sign() - 1)
            }
            Class::Inf => to.inf(va.sign),
            Class::Zero => to.zero(va.sign),
            Class::Num => {
                let (mut exp, mut mant, mut sticky) = (va.exp, va.mant as u128, false);
                self.round_with(to, va.sign, &mut exp, &mut mant, &mut sticky, rm, alt_out)
            }
        }
    }
}

// Reciprocal and reciprocal square root: steps and estimates (AdvSIMD).
impl Fpu {
    /// FPRecipStepFused (FRECPS, `2 - a × b`) and FPRSqrtStepFused (FRSQRTS, `(3 - a × b) / 2`).
    pub fn step(&mut self, f: Fmt, a: u64, b: u64, rsqrt: bool) -> u64 {
        let na = a ^ f.sign(); // FPNeg(op1), NaN included
        let (va, vb) = (self.unpack(f, na), self.unpack(f, b));
        if let Some(r) = self.process_nans(f, &[(va, na), (vb, b)]) {
            return r;
        }
        let (ia, ib) = (va.class == Class::Inf, vb.class == Class::Inf);
        let (za, zb) = (va.class == Class::Zero, vb.class == Class::Zero);
        let bias = f.bias() as u64;
        if (ia && zb) || (za && ib) {
            // 1.5 or 2.0.
            return if rsqrt {
                bias << f.f | f.qbit()
            } else {
                (bias + 1) << f.f
            };
        }
        if ia || ib {
            return f.inf(va.sign ^ vb.sign);
        }
        let p = if za || zb {
            Term::ZERO
        } else {
            Term {
                sign: va.sign ^ vb.sign,
                exp: va.exp + vb.exp,
                mant: va.mant as u128 * vb.mant as u128,
            }
        };
        let c = Term {
            sign: false,
            exp: 0,
            mant: if rsqrt { 3 } else { 2 },
        };
        let mut s = add_exact(c, p);
        if rsqrt {
            s.exp -= 1;
        }
        self.round_sum(f, s)
    }

    /// The fraction (as 52 bits) and biased exponent fields of a single or double.
    fn fields52(f: Fmt, x: u64) -> (u64, i32) {
        let frac = (x & f.frac_mask()) << (52 - f.f);
        (frac, ((x >> f.f) & f.exp_ones()) as i32)
    }

    /// Packs a single or double from sign, biased exponent and a 52-bit fraction.
    fn pack52(f: Fmt, sign: bool, exp: i32, frac: u64) -> u64 {
        f.zero(sign) | (exp as u64 & f.exp_ones()) << f.f | frac >> (52 - f.f)
    }

    /// FPRecipEstimate (FRECPE).
    pub fn recip_estimate(&mut self, f: Fmt, x: u64) -> u64 {
        let v = self.unpack(f, x);
        match v.class {
            Class::QNaN | Class::SNaN => return self.process_nan(f, &v, x),
            Class::Inf => return f.zero(v.sign),
            Class::Zero => {
                self.flags |= DZC;
                return f.inf(v.sign);
            }
            Class::Num => {}
        }
        let top = v.exp + 63 - v.mant.leading_zeros() as i32; // floor(log2 |value|)
        let (lo, hi, base) = if f == S {
            (-128, 126, 253)
        } else {
            (-1024, 1022, 2045)
        };
        if top < lo {
            self.flags |= OFC | IXC;
            let to_inf = match self.rounding() {
                Rounding::PosInf => !v.sign,
                Rounding::NegInf => v.sign,
                Rounding::Zero => false,
                _ => true,
            };
            return if to_inf {
                f.inf(v.sign)
            } else {
                f.max_normal(v.sign)
            };
        }
        if self.fz(f) && top >= hi {
            self.flags |= UFC;
            return f.zero(v.sign);
        }
        let (mut frac, mut exp) = Self::fields52(f, x);
        if exp == 0 {
            if frac >> 51 == 0 {
                exp = -1;
                frac <<= 2;
            } else {
                frac <<= 1;
            }
            frac &= (1 << 52) - 1;
        }
        let est = recip_estimate_int(256 | (frac >> 44) as u32) as u64;
        let mut rexp = base - exp;
        let mut frac = (est & 0xff) << 44;
        if rexp == 0 {
            frac = 1 << 51 | frac >> 1;
        } else if rexp == -1 {
            frac = 1 << 50 | frac >> 2;
            rexp = 0;
        }
        Self::pack52(f, v.sign, rexp, frac)
    }

    /// FPRSqrtEstimate (FRSQRTE).
    pub fn rsqrt_estimate(&mut self, f: Fmt, x: u64) -> u64 {
        let v = self.unpack(f, x);
        match v.class {
            Class::QNaN | Class::SNaN => return self.process_nan(f, &v, x),
            Class::Zero => {
                self.flags |= DZC;
                return f.inf(v.sign);
            }
            _ if v.sign => return self.invalid(f),
            Class::Inf => return f.zero(false),
            Class::Num => {}
        }
        let (mut frac, mut exp) = Self::fields52(f, x);
        if exp == 0 {
            while frac >> 51 == 0 {
                frac <<= 1;
                exp -= 1;
            }
            frac = (frac << 1) & ((1 << 52) - 1);
        }
        // Even exponent: 0.5 <= scaled < 1; odd: 0.25 <= scaled < 0.5 (units of 1/512).
        let scaled = if exp & 1 == 0 {
            256 | (frac >> 44)
        } else {
            128 | (frac >> 45)
        };
        let est = rsqrt_estimate_int(scaled as u32) as u64;
        let rexp = (if f == S { 380 } else { 3068 } - exp) / 2;
        Self::pack52(f, false, rexp, (est & 0xff) << 44)
    }

    /// FPRecpX (FRECPX): the exponent inverted, fraction zero.
    pub fn recpx(&mut self, f: Fmt, x: u64) -> u64 {
        let v = self.unpack(f, x);
        if v.nan() {
            return self.process_nan(f, &v, x);
        }
        let exp = (x >> f.f) & f.exp_ones();
        let e = if exp == 0 {
            f.exp_ones() - 1
        } else {
            !exp & f.exp_ones()
        };
        f.zero(v.sign) | e << f.f
    }
}

/// RecipEstimate: `a` in 256..512 (0.5 <= a/512 < 1) to 256..512 (1 <= r/256 < 2).
fn recip_estimate_int(a: u32) -> u32 {
    let a = a * 2 + 1;
    let b = (1 << 19) / a;
    b.div_ceil(2)
}

/// RecipSqrtEstimate: `a` in 128..512 to 256..512.
fn rsqrt_estimate_int(a: u32) -> u32 {
    // In units of 1/512 (below 0.5) or 1/256 (above), rounded to nearest.
    let a = if a < 256 {
        a * 2 + 1
    } else {
        (((a >> 1) << 1) + 1) * 2
    } as u64;
    // The largest b with b < 2^14 / sqrt(a).
    let mut b = 512u64;
    while a * (b + 1) * (b + 1) < 1 << 28 {
        b += 1;
    }
    b.div_ceil(2) as u32
}

/// UnsignedRecipEstimate (URECPE).
pub fn urecpe(x: u32) -> u32 {
    if x >> 31 == 0 {
        u32::MAX
    } else {
        recip_estimate_int(x >> 23) << 23
    }
}

/// UnsignedRSqrtEstimate (URSQRTE).
pub fn ursqrte(x: u32) -> u32 {
    if x >> 30 == 0 {
        u32::MAX
    } else {
        rsqrt_estimate_int(x >> 23) << 23
    }
}

/// A signed exact value `mant × 2^exp` (mant may be 0).
#[derive(Clone, Copy)]
struct Term {
    sign: bool,
    exp: i32,
    mant: u128,
}

impl Term {
    const ZERO: Term = Term {
        sign: false,
        exp: 0,
        mant: 0,
    };
}

fn term(v: &Val) -> Term {
    Term {
        sign: v.sign,
        exp: v.exp,
        mant: v.mant as u128,
    }
}

/// A sum with a sticky bit: `(mant + sticky) × 2^exp`.
struct Sum {
    sign: bool,
    exp: i32,
    mant: u128,
    sticky: bool,
}

/// `a + b`, exact except for bits far below the larger operand (a sticky bit).
/// With both mantissas normalized to bit 120, an operand shifted by 2 or more
/// can cancel at most one bit, so the sticky bit never matters to more than
/// the last of 119 kept bits.
fn add_exact(a: Term, b: Term) -> Sum {
    let norm = |t: Term| {
        if t.mant == 0 {
            return t;
        }
        let sh = 120 - (127 - t.mant.leading_zeros() as i32);
        Term {
            sign: t.sign,
            exp: t.exp - sh,
            mant: t.mant << sh,
        }
    };
    let (mut a, mut b) = (norm(a), norm(b));
    if b.mant != 0 && (a.mant == 0 || (b.exp, b.mant) > (a.exp, a.mant)) {
        core::mem::swap(&mut a, &mut b);
    }
    if b.mant == 0 {
        return Sum {
            sign: a.sign,
            exp: a.exp,
            mant: a.mant,
            sticky: false,
        };
    }
    let d = (a.exp - b.exp) as u32;
    let (bm, sticky) = if d >= 128 {
        (0, true)
    } else {
        (b.mant >> d, b.mant & ((1u128 << d) - 1) != 0)
    };
    let mant = if a.sign == b.sign {
        a.mant + bm
    } else {
        // Subtracting a value with a sticky tail: borrow one, keep the sticky bit.
        a.mant - bm - sticky as u128
    };
    Sum {
        sign: a.sign,
        exp: a.exp,
        mant,
        sticky,
    }
}

/// Orders two non-NaN values (zeros compare equal).
fn cmp(a: &Val, b: &Val) -> Ordering {
    let key = |v: &Val| match v.class {
        Class::Zero => 0,
        Class::Inf => 2,
        _ => 1,
    };
    let mag = |a: &Val, b: &Val| match key(a).cmp(&key(b)) {
        Ordering::Equal if a.class == Class::Num => {
            let ta = a.exp + 63 - a.mant.leading_zeros() as i32;
            let tb = b.exp + 63 - b.mant.leading_zeros() as i32;
            ta.cmp(&tb).then_with(|| {
                (a.mant << a.mant.leading_zeros()).cmp(&(b.mant << b.mant.leading_zeros()))
            })
        }
        o => o,
    };
    let sa = a.sign && a.class != Class::Zero;
    let sb = b.sign && b.class != Class::Zero;
    match (sa, sb) {
        (false, true) => Ordering::Greater,
        (true, false) => Ordering::Less,
        (false, false) => mag(a, b),
        (true, true) => mag(b, a),
    }
}

/// Integer square root: the largest r with r² ≤ m.
fn isqrt(m: u128) -> u128 {
    if m == 0 {
        return 0;
    }
    // Newton from above converges down to the floor.
    let mut x = 1u128 << (128 - m.leading_zeros()).div_ceil(2);
    loop {
        let y = (x + m / x) / 2;
        if y >= x {
            return x;
        }
        x = y;
    }
}

// Fast paths: host arithmetic for round-to-nearest-even with normal inputs and
// a normal result; `None` sends the operation to the slow path.

#[derive(Clone, Copy)]
enum Op2 {
    Add,
    Sub,
    Mul,
    Div,
}

/// Normal (not zero, denormal, infinite or NaN).
fn normal(f: Fmt, x: u64) -> bool {
    let ex = (x >> f.f) & f.exp_ones();
    ex != 0 && ex != f.exp_ones()
}

/// A result the fast path can return: normal and above the smallest normal
/// binade. A result there may have been tiny before rounding, which ARM
/// detects (Underflow, and flush to zero under FZ).
fn fast_result(f: Fmt, x: u64) -> bool {
    normal(f, x) && (x >> f.f) & f.exp_ones() > 1
}

/// Mantissa with the implicit bit, and its exponent, of a normal number.
fn parts(f: Fmt, x: u64) -> (u128, i32) {
    let ex = (x >> f.f) & f.exp_ones();
    (
        (x & f.frac_mask() | 1 << f.f) as u128,
        ex as i32 - f.bias() - f.f as i32,
    )
}

/// Whether `a × b == c` exactly, for normal doubles.
fn exact_product_f64(a: f64, b: f64, c: f64) -> bool {
    let ((ma, ea), (mb, eb), (mc, ec)) = (
        parts(D, a.to_bits()),
        parts(D, b.to_bits()),
        parts(D, c.to_bits()),
    );
    if (a.is_sign_negative() ^ b.is_sign_negative()) != c.is_sign_negative() {
        return false;
    }
    let p = ma * mb;
    let (tp, tc) = (p.trailing_zeros(), mc.trailing_zeros());
    p >> tp == mc >> tc && ea + eb + tp as i32 == ec + tc as i32
}

impl Fpu {
    fn fast2(&mut self, f: Fmt, a: u64, b: u64, op: Op2) -> Option<u64> {
        if !self.fast() || !normal(f, a) || !normal(f, b) {
            return None;
        }
        let (r, inexact) = if f == S {
            let (x, y) = (f32::from_bits(a as u32), f32::from_bits(b as u32));
            let (xd, yd) = (x as f64, y as f64);
            let r = match op {
                Op2::Add => x + y,
                Op2::Sub => x - y,
                Op2::Mul => x * y,
                Op2::Div => x / y,
            };
            // Products of two singles are exact in double; sums use TwoSum.
            let inexact = match op {
                Op2::Add | Op2::Sub => {
                    let y = if matches!(op, Op2::Sub) { -y } else { y };
                    let bv = r - x;
                    (x - (r - bv)) + (y - bv) != 0.0
                }
                Op2::Mul => r as f64 != xd * yd,
                Op2::Div => r as f64 * yd != xd,
            };
            (r.to_bits() as u64, inexact)
        } else if f == D {
            let (x, y) = (f64::from_bits(a), f64::from_bits(b));
            let r = match op {
                Op2::Add => x + y,
                Op2::Sub => x - y,
                Op2::Mul => x * y,
                Op2::Div => x / y,
            };
            if !fast_result(D, r.to_bits()) {
                return None;
            }
            let inexact = match op {
                // TwoSum: the rounding error of r = x + y, exactly.
                Op2::Add | Op2::Sub => {
                    let y = if matches!(op, Op2::Sub) { -y } else { y };
                    let bv = r - x;
                    (x - (r - bv)) + (y - bv) != 0.0
                }
                Op2::Mul => !exact_product_f64(x, y, r),
                Op2::Div => !exact_product_f64(r, y, x),
            };
            (r.to_bits(), inexact)
        } else {
            return None;
        };
        if !fast_result(f, r) {
            return None;
        }
        if inexact {
            self.flags |= IXC;
        }
        Some(r)
    }

    fn fast_sqrt(&mut self, f: Fmt, a: u64) -> Option<u64> {
        if !self.fast() || !normal(f, a) || a & f.sign() != 0 {
            return None;
        }
        let (r, inexact) = if f == S {
            let r = f32::from_bits(a as u32).sqrt();
            let rd = r as f64;
            (
                r.to_bits() as u64,
                rd * rd != f32::from_bits(a as u32) as f64,
            )
        } else if f == D {
            let x = f64::from_bits(a);
            let r = x.sqrt();
            (r.to_bits(), !exact_product_f64(r, r, x))
        } else {
            return None;
        };
        if inexact {
            self.flags |= IXC;
        }
        Some(r)
    }
}

#[cfg(test)]
mod tests;
