//! Spot checks with hand-worked results. TestFloat (core/tests/testfloat.rs) is the broad check.

use super::*;

const RN: u64 = 0;
const RP: u64 = 1 << 22;
const RM: u64 = 2 << 22;
const RZ: u64 = 3 << 22;
const FZ: u64 = 1 << 24;
const DN: u64 = 1 << 25;

fn s(x: f32) -> u64 {
    x.to_bits() as u64
}
fn d(x: f64) -> u64 {
    x.to_bits()
}

/// Runs `op` with FPCR `fpcr`; returns the result and the flags.
fn run(fpcr: u64, op: impl FnOnce(&mut Fpu) -> u64) -> (u64, u64) {
    let mut f = Fpu::new(fpcr);
    let r = op(&mut f);
    (r, f.flags)
}

#[test]
fn arithmetic_and_flags() {
    assert_eq!(run(RN, |f| f.add(S, s(1.0), s(2.0))), (s(3.0), 0));
    assert_eq!(run(RN, |f| f.add(D, d(0.1), d(0.2))), (d(0.1 + 0.2), IXC));
    // 1 + 2^-60 in single: TwoSum sees the lost bits.
    assert_eq!(
        run(RN, |f| f.add(S, s(1.0), s(2f32.powi(-60)))),
        (s(1.0), IXC)
    );
    assert_eq!(
        run(RP, |f| f.add(S, s(1.0), s(2f32.powi(-60)))),
        (s(1.0) + 1, IXC)
    );
    assert_eq!(run(RM, |f| f.sub(D, d(1.0), d(1.0))), (d(-0.0), 0));
    assert_eq!(run(RN, |f| f.sub(D, d(1.0), d(1.0))), (d(0.0), 0));
    assert_eq!(
        run(RN, |f| f.mul(D, d(f64::MAX), d(2.0))),
        (d(f64::INFINITY), OFC | IXC)
    );
    assert_eq!(
        run(RZ, |f| f.mul(D, d(f64::MAX), d(2.0))),
        (d(f64::MAX), OFC | IXC)
    );
    assert_eq!(
        run(RN, |f| f.div(S, s(1.0), s(0.0))),
        (s(f32::INFINITY), DZC)
    );
    assert_eq!(run(RN, |f| f.div(S, s(1.0), s(3.0))), (s(1.0 / 3.0), IXC));
    assert_eq!(run(RN, |f| f.sqrt(D, d(2.0))), (d(2f64.sqrt()), IXC));
    assert_eq!(run(RN, |f| f.sqrt(S, s(-0.0))), (s(-0.0), 0));
    // Smallest normal / 2: tiny before rounding and exact: a denormal, no Underflow.
    let m = f32::MIN_POSITIVE;
    assert_eq!(run(RN, |f| f.mul(S, s(m), s(0.5))), (s(m / 2.0), 0));
    // Tiny and inexact: Underflow. Under FZ: flushed, Underflow without Inexact.
    assert_eq!(
        run(RN, |f| f.mul(S, s(m), s(1.0 / 3.0))),
        (s(m / 3.0), UFC | IXC)
    );
    assert_eq!(run(FZ, |f| f.mul(S, s(m), s(0.5))), (s(0.0), UFC));
    // Rounds up to the smallest normal but was tiny before rounding.
    let just_below = f32::from_bits(0x007f_ffff) as f64 + 0.75 * 2f64.powi(-149);
    let (r, fl) = run(RN, |f| f.convert(D, S, d(just_below), Rounding::TieEven));
    assert_eq!((r, fl), (s(m), UFC | IXC));
    assert_eq!(
        run(FZ, |f| f.convert(D, S, d(just_below), Rounding::TieEven)),
        (0, UFC)
    );
    // A denormal input under FZ is zero, with Input Denormal.
    assert_eq!(run(FZ, |f| f.add(S, 1, s(1.0))), (s(1.0), IDC));
}

#[test]
fn nans() {
    let (qa, qb, sb) = (0x7fc0_0001u64, 0xffc0_0002u64, 0x7f80_0003u64);
    // The first SNaN wins over an earlier QNaN, quieted, with Invalid Operation.
    assert_eq!(run(RN, |f| f.add(S, qa, sb)), (0x7fc0_0003, IOC));
    assert_eq!(run(RN, |f| f.mul(S, qb, qa)), (qb, 0));
    assert_eq!(run(DN, |f| f.mul(S, qb, qa)), (0x7fc0_0000, 0));
    assert_eq!(
        run(RN, |f| f.mul(S, s(0.0), s(f32::INFINITY))),
        (0x7fc0_0000, IOC)
    );
    // FMA: addend first; a quiet-NaN addend with infinity × zero is Invalid.
    assert_eq!(run(RN, |f| f.muladd(S, qa, qb, s(1.0))), (qa, 0));
    assert_eq!(
        run(RN, |f| f.muladd(S, qa, s(0.0), s(f32::INFINITY))),
        (0x7fc0_0000, IOC)
    );
    // Conversions keep the top payload bits.
    assert_eq!(
        run(RN, |f| f.convert(S, D, 0xff80_0001, Rounding::TieEven)),
        (0xfff8_0000_2000_0000, IOC)
    );
    assert_eq!(
        run(RN, |f| f.convert(
            D,
            H,
            0x7ff8_0400_0000_0000,
            Rounding::TieEven
        )),
        (0x7e01, 0)
    );
}

#[test]
fn fma_is_exact() {
    // (1 + 2^-52)(1 - 2^-52) - 1 = -2^-104 exactly; a separate multiply would give 0.
    let a = d(1.0 + f64::EPSILON);
    let b = d(1.0 - f64::EPSILON);
    assert_eq!(
        run(RN, |f| f.muladd(D, d(-1.0), a, b)),
        (d(-(2f64.powi(-104))), 0)
    );
    // A tiny addend only shows up as the sticky bit.
    let (r, fl) = run(RP, |f| f.muladd(D, d(1e-300), d(1.0), d(1.0)));
    assert_eq!((r, fl), (d(1.0) + 1, IXC));
}

#[test]
fn integer_conversions() {
    let tz = Rounding::Zero;
    assert_eq!(
        run(RN, |f| f.to_fixed(
            D,
            d(-2.5),
            0,
            false,
            32,
            Rounding::TieEven
        )),
        (0xffff_fffe, IXC)
    );
    assert_eq!(
        run(RN, |f| f.to_fixed(
            D,
            d(-2.5),
            0,
            false,
            64,
            Rounding::TieAway
        )),
        (-3i64 as u64, IXC)
    );
    assert_eq!(
        run(RN, |f| f.to_fixed(S, s(1e10), 0, false, 32, tz)),
        (0x7fff_ffff, IOC)
    );
    assert_eq!(
        run(RN, |f| f.to_fixed(S, s(-1.0), 0, true, 64, tz)),
        (0, IOC)
    );
    assert_eq!(
        run(RN, |f| f.to_fixed(S, 0x7fc0_0000, 0, false, 64, tz)),
        (0, IOC)
    );
    assert_eq!(run(RN, |f| f.to_fixed(S, s(1.5), 4, true, 32, tz)), (24, 0));
    assert_eq!(
        run(RN, |f| f.from_fixed(
            S,
            u64::MAX,
            0,
            true,
            64,
            Rounding::TieEven
        )),
        (s(1.8446744e19), IXC)
    );
    assert_eq!(
        run(RN, |f| f.from_fixed(
            D,
            0x8000_0000,
            0,
            false,
            32,
            Rounding::TieEven
        )),
        (d(-2147483648.0), 0)
    );
    assert_eq!(
        run(RN, |f| f.from_fixed(D, 3, 1, false, 32, Rounding::TieEven)),
        (d(1.5), 0)
    );
    assert_eq!(
        run(RN, |f| f.round_int(D, d(2.5), Rounding::TieEven, true)),
        (d(2.0), IXC)
    );
    assert_eq!(
        run(RN, |f| f.round_int(D, d(-0.4), Rounding::TieAway, false)),
        (d(-0.0), 0)
    );
    assert_eq!(
        run(RN, |f| f.round_int(S, s(-1.5), Rounding::TieAway, false)),
        (s(-2.0), 0)
    );
}

#[test]
fn min_max_compare() {
    assert_eq!(run(RN, |f| f.max(S, s(0.0), s(-0.0), true)), (s(0.0), 0));
    assert_eq!(run(RN, |f| f.max(S, s(0.0), s(-0.0), false)), (s(-0.0), 0));
    assert_eq!(
        run(RN, |f| f.maxnum(S, 0x7fc0_0000, s(-3.0), true)),
        (s(-3.0), 0)
    );
    assert_eq!(
        run(RN, |f| f.maxnum(S, 0x7f80_0001, s(-3.0), true)),
        (0x7fc0_0001, IOC)
    );
    assert_eq!(
        run(RN, |f| f.compare(D, d(1.0), d(2.0), false)),
        (0x8000_0000, 0)
    );
    assert_eq!(
        run(RN, |f| f.compare(D, d(-0.0), d(0.0), false)),
        (0x6000_0000, 0)
    );
    assert_eq!(
        run(RN, |f| f.compare(D, d(f64::NAN), d(0.0), false)),
        (0x3000_0000, 0)
    );
    assert_eq!(
        run(RN, |f| f.compare(D, d(f64::NAN), d(0.0), true)),
        (0x3000_0000, IOC)
    );
}

/// The JIT's inline double FMA (jit/emit/float.rs), op for op: `None` where
/// its guard sends the instruction to the helper.
fn fma_inline(c: u64, a: u64, b: u64) -> Option<u64> {
    let e = |x: u64| (x >> 52) & 0x7ff;
    let (ea, eb, ec) = (e(a), e(b), e(c));
    // No denormal operand, a zero factor or a product from 2^-900 up (its
    // error exact). An overflow anywhere ends in an infinite or NaN z.
    let noz = |e: u64, x: u64| (e.wrapping_sub(1) < 0x7fe) | (x << 1 == 0);
    let ok =
        noz(ea, a) & noz(eb, b) & noz(ec, c) & ((ea + eb >= 1146) | (a << 1 == 0) | (b << 1 == 0));
    let (a, b, c) = (f64::from_bits(a), f64::from_bits(b), f64::from_bits(c));
    let split = |x: f64| {
        let g = 134217729.0 * x;
        let h = g - (g - x);
        (h, x - h)
    };
    let two_sum = |x: f64, y: f64| {
        let s = x + y;
        let bb = s - x;
        (s, (x - (s - bb)) + (y - bb))
    };
    let ((ah, al), (bh, bl)) = (split(a), split(b));
    let p = a * b;
    let pl = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
    let (th, tl) = two_sum(c, p);
    // v = tl + pl rounded to odd: RN's result, or its other neighbour when
    // inexact and even (toward the error).
    let (s, err) = two_sum(tl, pl);
    let (sb, eb) = (s.to_bits(), err.to_bits());
    let fix = (eb << 1 != 0) & (sb & 1 == 0);
    let v = f64::from_bits(if fix {
        sb.wrapping_add((((sb ^ eb) as i64 >> 63) | 1) as u64)
    } else {
        sb
    });
    let z = (th + v).to_bits();
    (ok & (e(z).wrapping_sub(2) < 0x7fd)).then_some(z)
}

#[test]
fn inline_fma_is_correctly_rounded() {
    let mut x = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    let (mut fast, mut n) = (0, 0);
    for _ in 0..4_000_000 {
        let r = next();
        // Exponents near each other (cancellation, ties), mantissas with few
        // set bits now and then (exact products, halfway sums).
        let mant = |r: u64, k: u64| match k % 4 {
            0 => r & ((1 << 52) - 1),
            1 => r & 0xffff_f000_0000_0000 >> 12,
            2 => (r & ((1 << 52) - 1)) | 0xf_ffff_ff00_0000,
            _ => r & 0x7_ffff_ffff_ffff & !((1 << (r % 52)) - 1),
        };
        let base = 1023 + (r % 2200) as i64 - 1100;
        let ex = |d: u64| ((base + d as i64 % 64 - 32).clamp(0, 0x7ff) as u64) << 52;
        let (r1, r2, r3) = (next(), next(), next());
        let a = (r1 & 1 << 63) | ex(r1 >> 40) | mant(r1, r2);
        let b = (r2 & 1 << 63) | (((1023 + (r3 % 64) as i64 - 32) as u64) << 52) | mant(r2, r3);
        let mut c = (r3 & 1 << 63) | ex((r3 >> 40).wrapping_add(base as u64)) | mant(r3, r1);
        match r % 5 {
            // c near -ab: massive cancellation.
            0 => c = (-(f64::from_bits(a) * f64::from_bits(b))).to_bits() ^ (r3 & 3),
            // c = the halfway point above RN(ab)'s neighbours.
            1 => {
                c = (f64::from_bits(a) * f64::from_bits(b) * 2f64.powi(54)).to_bits() ^ 1 << 63 & r1
            }
            2 => c = 0,
            4 if r & 32 != 0 => {
                let (a, b) = if r & 64 != 0 {
                    (a & 1 << 63, b)
                } else {
                    (a, b & 1 << 63)
                };
                n += 1;
                if let Some(z) = fma_inline(c, a, b) {
                    fast += 1;
                    assert_eq!(
                        z,
                        run(RN, |f| f.muladd(D, c, a, b)).0,
                        "{a:#x} * {b:#x} + {c:#x}"
                    );
                }
                continue;
            }
            // a·b = 2^k (1 - 2^-2m): RN(ab) = 2^k, its error tiny, and c with
            // ulp 2^(k+1), so c + RN(ab) is a midpoint and a second rounding
            // breaks the tie the wrong way.
            3 => {
                let (m, k) = (27 + r1 % 26, (r2 % 1600) as i64 - 800);
                let s = |x: u64| x & 1 << 63;
                let a = s(r1) | (1f64 + 2f64.powi(-(m as i32))).to_bits();
                let b = s(r2) | ((1.0 - 2f64.powi(-(m as i32))) * 2f64.powi(k as i32)).to_bits();
                let c = s(r3) | ((1023 + k + 53) as u64) << 52 | r3 & ((1 << 52) - 1);
                n += 1;
                if let Some(z) = fma_inline(c, a, b) {
                    fast += 1;
                    assert_eq!(
                        z,
                        run(RN, |f| f.muladd(D, c, a, b)).0,
                        "{a:#x} * {b:#x} + {c:#x}"
                    );
                }
                continue;
            }
            _ => {}
        }
        n += 1;
        if let Some(z) = fma_inline(c, a, b) {
            fast += 1;
            let (want, _) = run(RN, |f| f.muladd(D, c, a, b));
            assert_eq!(z, want, "{a:#x} * {b:#x} + {c:#x}");
        }
    }
    assert!(fast > n / 3, "{fast} of {n} on the fast path");
}

/// The JIT's inline single FMA: the product exact in double, the sum rounded
/// to odd in double, then to single (correct: 53 ≥ 24 + 2 bits).
fn fma32_inline(c: u32, a: u32, b: u32) -> Option<u32> {
    let e = |x: u32| (x >> 23) & 0xff;
    let noz = |x: u32| (e(x).wrapping_sub(1) < 0xfe) | (x << 1 == 0);
    let ok = noz(a) & noz(b) & noz(c);
    let f = |x: u32| f32::from_bits(x) as f64;
    let (p, c) = (f(a) * f(b), f(c));
    let s = p + c;
    let bb = s - p;
    let err = (p - (s - bb)) + (c - bb);
    let (sb, eb) = (s.to_bits(), err.to_bits());
    let fix = (eb << 1 != 0) & (sb & 1 == 0);
    let v = f64::from_bits(if fix {
        sb.wrapping_add((((sb ^ eb) as i64 >> 63) | 1) as u64)
    } else {
        sb
    });
    let z = (v as f32).to_bits();
    (ok & (e(z).wrapping_sub(2) < 0xfd)).then_some(z)
}

#[test]
fn inline_fma32_is_correctly_rounded() {
    let mut x = 0x2545_f491_4f6c_dd1du64;
    let mut next = || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    let (mut fast, mut n) = (0, 0);
    for _ in 0..4_000_000 {
        let r = next();
        let few = |r: u64| (r as u32) & 0x7f_ffff & !((1 << (r % 23)) - 1);
        let (r1, r2, r3) = (next(), next(), next());
        let ex =
            |r: u64, d: u64| ((((r >> 32) % 48) as i64 - 24 + d as i64).clamp(0, 255) as u32) << 23;
        let mut a = (r1 as u32 & 1 << 31) | ex(r1, 127) | few(r1 >> 8);
        let b = (r2 as u32 & 1 << 31) | ex(r2, 127) | few(r2 >> 8);
        let mut c = (r3 as u32 & 1 << 31) | ex(r3, 127 + (r % 40)) | few(r3 >> 8);
        match r % 6 {
            // Small integers × 0.999 + 0.5 (the FP guest's convert): exact
            // double sums on single midpoints.
            0 => {
                a = ((r1 % 25) as f32 - 12.0).to_bits();
                c = 0.5f32.to_bits();
            }
            // The double-rounding case (jit-diff's FP edge): 1 + 2^-23 + 2^-24 - 2^-60.
            1 => {
                a = (1.0 + 2f32.powi(-18)).to_bits() ^ (r1 as u32 & 1 << 31);
                c = (1.0 + 2f32.powi(-23)).to_bits() ^ (r1 as u32 & 1 << 31);
                let b = (2f32.powi(-24) * (1.0 - 2f32.powi(-18))).to_bits();
                check32(&mut n, &mut fast, c, a, b);
                continue;
            }
            2 => c &= 1 << 31,
            _ => {}
        }
        check32(&mut n, &mut fast, c, a, b);
    }
    assert!(fast > n / 3, "{fast} of {n} on the fast path");
}

/// Compares the inline single FMA with the interpreter's where it applies.
fn check32(n: &mut u32, fast: &mut u32, c: u32, a: u32, b: u32) {
    *n += 1;
    if let Some(z) = fma32_inline(c, a, b) {
        *fast += 1;
        let (c, a, b) = (c as u64, a as u64, b as u64);
        assert_eq!(
            z as u64,
            run(RN, |f| f.muladd(S, c, a, b)).0,
            "{a:#x} * {b:#x} + {c:#x}"
        );
    }
}
