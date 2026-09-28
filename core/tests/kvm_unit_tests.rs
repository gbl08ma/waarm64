//! Runs kvm-unit-tests' arm64 tests (target/images/kvm-unit-tests/, from
//! images/build.sh) on a whole VM, one CPU and 256 MiB, with each test's
//! arguments from arm/unittests.cfg. A test reports `EXIT: STATUS=<2*code+1>`
//! on the UART before PSCI SYSTEM_OFF (there's no chr-testdev); code 0 is a pass.
//! Ignored by default; scripts/ci.sh runs it in release mode when the image exists.
//!
//! Every test in unittests.cfg is listed, with the reason for those we skip.

mod common;

/// Runnable tests: (unittests.cfg name, file, arguments, GIC version (0: the
/// default), the checks expected to FAIL).
const RUN: &[(&str, &str, &str, u64, &[&str])] = &[
    ("selftest-setup", "selftest", "setup smp=1 mem=256", 0, &[]),
    (
        "selftest-vectors-kernel",
        "selftest",
        "vectors-kernel",
        0,
        &[],
    ),
    ("selftest-vectors-user", "selftest", "vectors-user", 0, &[]),
    // The test expects SPI targets to hold CPU 0's bit; on a uniprocessor GIC
    // the GICv2 spec makes ITARGETSR RAZ/WI, and QEMU TCG fails these two
    // checks the same way.
    (
        "gicv2-mmio-up",
        "gic",
        "mmio",
        2,
        &[
            "gicv2: mmio: ITARGETSR: register content preserved",
            "gicv2: mmio: ITARGETSR: byte writes successful",
        ],
    ),
    ("gicv2-active", "gic", "active", 2, &[]),
    ("gicv3-active", "gic", "active", 3, &[]),
    ("timer", "timer", "", 0, &[]),
    ("cache", "cache", "", 0, &[]),
];

/// Skipped: (name or prefix, reason).
pub const SKIP: &[(&str, &str)] = &[
    ("selftest-smp", "SMP (M7)"),
    (
        "psci",
        "every check needs 2+ CPUs; on one it skips them all (M7)",
    ),
    ("gicv2-ipi", "SMP (M7)"),
    ("gicv2-mmio", "the SMP variants of gicv2-mmio-up (M7)"),
    ("gicv2-mmio-3p", "SMP (M7)"),
    ("gicv3-ipi", "SMP (M7)"),
    ("its-", "no GICv3 ITS"),
    ("pmu-", "no PMU (ID_AA64DFR0_EL1.PMUVer = 0)"),
    ("pci-test", "no PCI"),
    ("micro-bench", "accel = kvm only"),
    ("fpu-context", "accel = kvm only, and SMP"),
    (
        "debug-",
        "no debug exceptions (docs/backlog.md, self-hosted debug)",
    ),
    ("mte-", "no MTE (docs/cpu.md)"),
];

#[test]
#[ignore = "needs target/images (images/build.sh) and --release"]
fn kvm_unit_tests() {
    // Every unittests.cfg entry is either run or skipped with a reason.
    let cfg = String::from_utf8(common::image("kvm-unit-tests/unittests.cfg")).unwrap();
    for name in cfg
        .lines()
        .filter_map(|l| l.strip_prefix('[')?.strip_suffix(']'))
    {
        let known = RUN.iter().any(|r| r.0 == name)
            || SKIP
                .iter()
                .any(|(p, _)| name == *p || p.ends_with('-') && name.starts_with(p));
        assert!(
            known,
            "unittests.cfg has {name}: run it or give a reason to skip it"
        );
    }
    let mut failed = Vec::new();
    for (name, file, args, gic, expect_fail) in RUN {
        let flat = common::image(&format!("kvm-unit-tests/{file}.flat"));
        let r = common::boot(&common::Boot {
            max_steps: 5_000_000_000,
            gic: *gic,
            ..common::Boot::new(&flat, args)
        });
        let status = r
            .console
            .lines()
            .find_map(|l| l.strip_prefix("EXIT: STATUS="))
            .and_then(|s| s.trim().parse::<u32>().ok());
        let summary = r
            .console
            .lines()
            .find(|l| l.starts_with("SUMMARY:"))
            .unwrap_or("no SUMMARY");
        let fails: Vec<&str> = r
            .console
            .lines()
            .filter_map(|l| l.strip_prefix("FAIL: "))
            .collect();
        // Exactly the expected failures: code 0, or 1 with only those listed.
        let pass = r.powered_off()
            && fails == *expect_fail
            && status == Some(if expect_fail.is_empty() { 1 } else { 3 });
        eprintln!(
            "{} {name}: {summary} [{}]",
            if pass { "PASS" } else { "FAIL" },
            r.summary
        );
        if !pass {
            failed.push(format!("--- {name} ({status:?}):\n{}", r.console));
        }
    }
    for (p, why) in SKIP {
        eprintln!("SKIP {p}: {why}");
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}
