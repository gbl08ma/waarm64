//! TestFloat 3e vectors against `webpc_core::fp` (PLAN.md §4 item 5).
//!
//! Runs when TESTFLOAT_GEN points at a `testfloat_gen` binary; `scripts/testfloat.sh`
//! builds it under target/ and runs this in release mode. Every function runs in
//! each rounding mode it supports, with tininess detected before rounding (as
//! ARM does), and each case is checked under all four FPCR.FZ/DN combinations:
//! - DN=1: a NaN result must be the default NaN. DN=0: any NaN (TestFloat's
//!   payloads follow x86; the ARM NaN rules are covered by unit tests and the
//!   golden corpus).
//! - FZ=1: denormal single/double inputs become zero (with Input Denormal),
//!   and results that were tiny before rounding become zero with Underflow and
//!   without Inexact. The reference for flushed inputs is our FZ=0 result for
//!   the flushed operands, which TestFloat checks directly.
//! - Out-of-range float-to-integer conversions saturate (NaN gives 0), as on ARM.

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use webpc_core::fp::{self, D, Fmt, Fpu, H, Rounding, S};

/// A rounding mode, its testfloat_gen option and its FPCR.RMode value.
type Mode = (Rounding, &'static str, u64);

const MODES: [Mode; 4] = [
    (Rounding::TieEven, "-rnear_even", 0),
    (Rounding::PosInf, "-rmax", 1),
    (Rounding::NegInf, "-rmin", 2),
    (Rounding::Zero, "-rminMag", 3),
];
const AWAY: Mode = (Rounding::TieAway, "-rnear_maxMag", 0);
const ODD: Mode = (Rounding::Odd, "-rodd", 0);

/// SoftFloat flags (invalid 0x10, infinite 0x08, overflow 0x04, underflow 0x02, inexact 0x01) as FPSR bits.
fn flags(sf: u64) -> u64 {
    [
        (0x10, fp::IOC),
        (0x08, fp::DZC),
        (0x04, fp::OFC),
        (0x02, fp::UFC),
        (0x01, fp::IXC),
    ]
    .iter()
    .filter(|(b, _)| sf & b != 0)
    .fold(0, |a, (_, f)| a | f)
}

#[derive(Clone, Copy, PartialEq)]
enum Ty {
    F(Fmt),
    I { width: u32, unsigned: bool },
    Bool,
}

fn ty(name: &str) -> Ty {
    match name {
        "f16" => Ty::F(H),
        "f32" => Ty::F(S),
        "f64" => Ty::F(D),
        "i32" => Ty::I {
            width: 32,
            unsigned: false,
        },
        "i64" => Ty::I {
            width: 64,
            unsigned: false,
        },
        "ui32" => Ty::I {
            width: 32,
            unsigned: true,
        },
        "ui64" => Ty::I {
            width: 64,
            unsigned: true,
        },
        _ => panic!("type {name}"),
    }
}

/// One TestFloat function: its operand and result types and how we compute it.
struct Func {
    name: String,
    args: Vec<Ty>,
    out: Ty,
    rm: Rounding,
    exact: bool,
}

impl Func {
    fn eval(&self, fpcr: u64, x: &[u64]) -> (u64, u64) {
        let mut f = Fpu::new(fpcr);
        let n = &self.name;
        let op = n.split_once('_').map_or("", |p| p.1);
        let r = match (self.args[0], self.out) {
            (Ty::F(a), Ty::F(o)) if a != o => f.convert(a, o, x[0], self.rm),
            (Ty::F(a), Ty::F(_)) => match op {
                "add" => f.add(a, x[0], x[1]),
                "sub" => f.sub(a, x[0], x[1]),
                "mul" => f.mul(a, x[0], x[1]),
                "div" => f.div(a, x[0], x[1]),
                "sqrt" => f.sqrt(a, x[0]),
                "mulAdd" => f.muladd(a, x[2], x[0], x[1]),
                "roundToInt" => f.round_int(a, x[0], self.rm, self.exact),
                _ => panic!("{n}"),
            },
            (Ty::F(a), Ty::I { width, unsigned }) => {
                f.to_fixed(a, x[0], 0, unsigned, width, self.rm)
            }
            (Ty::I { width, unsigned }, Ty::F(o)) => {
                f.from_fixed(o, x[0], 0, unsigned, width, self.rm)
            }
            (Ty::F(a), Ty::Bool) => {
                let signal = matches!(op, "eq_signaling" | "le" | "lt");
                let nzcv = f.compare(a, x[0], x[1], signal);
                let (lt, eq) = (nzcv == 0x8000_0000, nzcv == 0x6000_0000);
                (match op {
                    "eq" | "eq_signaling" => eq,
                    "le" | "le_quiet" => lt || eq,
                    _ => lt,
                }) as u64
            }
            _ => panic!("{n}"),
        };
        (r, f.flags)
    }
}

fn is_denormal(t: Ty, x: u64) -> bool {
    match t {
        Ty::F(f) if f != H => {
            x & !(u64::MAX << (f.e + f.f)) != 0 && (x >> f.f) & ((1 << f.e) - 1) == 0
        }
        _ => false,
    }
}

/// What the case must give under `fpcr`, from TestFloat's result (`want`, `wflags`).
fn expected(func: &Func, fpcr: u64, x: &[u64], want: u64, wflags: u64) -> (u64, u64) {
    let (fz, dn) = (fpcr & (1 << 24) != 0, fpcr & (1 << 25) != 0);
    let mut want = (want, wflags);
    if let Ty::I { width, unsigned } = func.out {
        // Invalid conversions: ARM saturates, and NaN converts to 0.
        if wflags & fp::IOC != 0 {
            let Ty::F(a) = func.args[0] else {
                unreachable!()
            };
            let neg = x[0] >> (a.e + a.f) & 1 == 1;
            let max = if unsigned { u64::MAX } else { u64::MAX >> 1 } >> (64 - width);
            let min = if unsigned {
                0
            } else {
                (1u64 << (width - 1)) & (u64::MAX >> (64 - width))
            };
            want.0 = if a.is_nan(x[0]) {
                0
            } else if neg {
                min
            } else {
                max
            };
        }
    }
    if fz {
        let flushed: Vec<u64> = x
            .iter()
            .zip(&func.args)
            .map(|(&v, &t)| match t {
                Ty::F(f) if is_denormal(t, v) => v & f.zero(true),
                _ => v,
            })
            .collect();
        let idc = flushed != x;
        if idc {
            want = func.eval(fpcr & !(1 << 24), &flushed);
        }
        if let Ty::F(o) = func.out {
            let tiny = want.1 & fp::UFC != 0 || is_denormal(func.out, want.0);
            if o != H && tiny {
                want = (
                    want.0 & o.zero(true),
                    want.1 & !(fp::IXC | fp::UFC) | fp::UFC,
                );
            }
        }
        if idc {
            want.1 |= fp::IDC;
        }
    }
    if let (Ty::F(o), true) = (func.out, dn)
        && o.is_nan(want.0)
    {
        want.0 = o.default_nan();
    }
    want
}

fn run(
    func: &Func,
    tfgen: &str,
    mode_arg: &str,
    extra: &[&str],
    fpcr_rm: u64,
) -> (u64, Vec<String>) {
    let mut cmd = Command::new(tfgen);
    cmd.args(["-tininessbefore", mode_arg])
        .args(extra)
        .arg(&func.name);
    let mut child = cmd.stdout(Stdio::piped()).spawn().expect("testfloat_gen");
    let out = BufReader::new(child.stdout.take().unwrap());
    let (mut n, mut errs) = (0, Vec::new());
    for line in out.lines() {
        let line = line.unwrap();
        let v: Vec<u64> = line
            .split(' ')
            .map(|w| u64::from_str_radix(w, 16).unwrap())
            .collect();
        let (x, want, wflags) = (&v[..v.len() - 2], v[v.len() - 2], flags(v[v.len() - 1]));
        for (fz, dn) in [(false, false), (true, false), (false, true), (true, true)] {
            let fpcr = fpcr_rm << 22 | (fz as u64) << 24 | (dn as u64) << 25;
            let got = func.eval(fpcr, x);
            let want = expected(func, fpcr, x, want, wflags);
            let nan_ok = matches!(func.out, Ty::F(o) if !dn && o.is_nan(want.0) && o.is_nan(got.0));
            if ((got.0 != want.0 && !nan_ok) || got.1 != want.1) && errs.len() < 10 {
                errs.push(format!(
                        "{} {mode_arg} {extra:?} fz={fz} dn={dn} {line}: got {:x} flags {:#x}, want {:x} flags {:#x}",
                        func.name, got.0, got.1, want.0, want.1
                    ));
            }
        }
        n += 1;
    }
    assert!(child.wait().unwrap().success());
    (n, errs)
}

#[test]
fn testfloat() {
    let Ok(tfgen) = std::env::var("TESTFLOAT_GEN") else {
        eprintln!("TESTFLOAT_GEN not set: skipping (scripts/testfloat.sh runs this)");
        return;
    };
    // (function, rounding modes, extra args); rounding modes come in with the FPCR bits.
    let mut jobs: Vec<(Func, Mode, Vec<&str>)> = Vec::new();
    let func = |name: String, rm: Rounding, exact: bool| {
        let (args, out) = if let Some((a, b)) = name.split_once("_to_") {
            (vec![ty(a)], ty(b))
        } else {
            let (t, op) = name.split_once('_').unwrap();
            let n = match op {
                "sqrt" | "roundToInt" => 1,
                "mulAdd" => 3,
                _ => 2,
            };
            let out = if matches!(
                op,
                "eq" | "le" | "lt" | "eq_signaling" | "le_quiet" | "lt_quiet"
            ) {
                Ty::Bool
            } else {
                ty(t)
            };
            (vec![ty(t); n], out)
        };
        Func {
            name,
            args,
            out,
            rm,
            exact,
        }
    };
    for t in ["f32", "f64"] {
        for op in ["add", "sub", "mul", "div", "sqrt", "mulAdd"] {
            for m in MODES {
                jobs.push((func(format!("{t}_{op}"), m.0, false), m, vec![]));
            }
        }
        for op in ["eq", "le", "lt", "eq_signaling", "le_quiet", "lt_quiet"] {
            jobs.push((
                func(format!("{t}_{op}"), Rounding::TieEven, false),
                MODES[0],
                vec![],
            ));
        }
        for m in MODES.into_iter().chain([AWAY]) {
            for (exact, arg) in [(true, "-exact"), (false, "-notexact")] {
                jobs.push((func(format!("{t}_roundToInt"), m.0, exact), m, vec![arg]));
            }
            for i in ["i32", "i64", "ui32", "ui64"] {
                jobs.push((func(format!("{t}_to_{i}"), m.0, true), m, vec!["-exact"]));
            }
        }
        for m in MODES {
            for i in ["i32", "i64", "ui32", "ui64"] {
                jobs.push((func(format!("{i}_to_{t}"), m.0, false), m, vec![]));
            }
        }
    }
    for m in MODES {
        for conv in [
            "f32_to_f64",
            "f64_to_f32",
            "f16_to_f32",
            "f16_to_f64",
            "f32_to_f16",
            "f64_to_f16",
        ] {
            jobs.push((func(conv.into(), m.0, false), m, vec![]));
        }
    }
    jobs.push((func("f64_to_f32".into(), Rounding::Odd, false), ODD, vec![]));

    let results: Vec<(String, u64, Vec<String>)> = std::thread::scope(|s| {
        let handles: Vec<_> = jobs
            .iter()
            .map(|(f, m, extra)| {
                let tfgen = &tfgen;
                s.spawn(move || {
                    let (n, e) = run(f, tfgen, m.1, extra, m.2);
                    (format!("{} {} {}", f.name, m.1, extra.join(" ")), n, e)
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let total: u64 = results.iter().map(|r| r.1).sum();
    let bad: Vec<&String> = results.iter().flat_map(|r| &r.2).collect();
    eprintln!(
        "testfloat: {} runs, {total} cases × 4 FZ/DN combinations",
        results.len()
    );
    for b in bad.iter().take(40) {
        eprintln!("{b}");
    }
    assert!(
        bad.is_empty(),
        "{} runs had mismatches",
        results.iter().filter(|r| !r.2.is_empty()).count()
    );
}
