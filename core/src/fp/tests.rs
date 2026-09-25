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
