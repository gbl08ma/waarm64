//! Runs kvm-unit-tests' arm64 tests (target/images/kvm-unit-tests/, from
//! images/build.sh) on a whole VM, one CPU and 256 MiB, with each test's
//! arguments from arm/unittests.cfg. A test reports `EXIT: STATUS=<2*code+1>`
//! on the UART before PSCI SYSTEM_OFF (there's no chr-testdev); code 0 is a pass.
//! Ignored by default; scripts/ci.sh runs it in release mode when the image exists.
//!
//! Every test in unittests.cfg is listed, with the reason for those we skip.

mod common;

/// Runnable tests: (unittests.cfg name, file, arguments, vCPUs, the checks
/// expected to FAIL). `psci` runs with the
/// environment (an initrd) that enables its concurrent cpu-on check.
type Test = (
    &'static str,
    &'static str,
    &'static str,
    u64,
    &'static [&'static str],
);
const RUN: &[Test] = &[
    ("selftest-setup", "selftest", "setup smp=1 mem=256", 1, &[]),
    ("selftest-smp", "selftest", "smp", 4, &[]),
    (
        "selftest-vectors-kernel",
        "selftest",
        "vectors-kernel",
        1,
        &[],
    ),
    ("selftest-vectors-user", "selftest", "vectors-user", 1, &[]),
    ("psci", "psci", "", 4, &[]),
    ("gicv3-ipi", "gic", "ipi", 4, &[]),
    ("gicv3-active", "gic", "active", 4, &[]),
    ("timer", "timer", "", 1, &[]),
    ("cache", "cache", "", 1, &[]),
    ("debug-bp", "debug", "bp", 1, &[]),
    ("debug-bp-migration", "debug", "bp-migration", 1, &[]),
    ("debug-wp", "debug", "wp", 1, &[]),
    ("debug-wp-migration", "debug", "wp-migration", 1, &[]),
    ("debug-sstep", "debug", "ss", 1, &[]),
    ("debug-sstep-migration", "debug", "ss-migration", 1, &[]),
];

/// Skipped: (name or prefix, reason).
pub const SKIP: &[(&str, &str)] = &[
    (
        "gicv2-",
        "no GICv2 (the GICv3 only since M7; docs/platform.md)",
    ),
    ("its-", "no GICv3 ITS"),
    ("pmu-", "no PMU (ID_AA64DFR0_EL1.PMUVer = 0)"),
    ("pci-test", "no PCI"),
    ("micro-bench", "accel = kvm only"),
    ("fpu-context", "accel = kvm only, and SMP"),
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
    let env = b"ERRATA_6c7a5dce22b3=y\n";
    for (name, file, args, ncpus, expect_fail) in RUN {
        let flat = common::image(&format!("kvm-unit-tests/{file}.flat"));
        let boot = || common::Boot {
            max_steps: 5_000_000_000,
            ncpus: *ncpus,
            initrd: (*name == "psci").then_some(&env[..]),
            ..common::Boot::new(&flat, args)
        };
        // A migration test waits for a key after "Now migrate the VM": it's
        // queued from the start, and the VM is saved and restored at points
        // spread over a run of the same test (deterministic: the same steps),
        // and close together toward its end, where the debug tests arm.
        let migrate = name.ends_with("-migration");
        let at: Vec<u64> = if migrate {
            let steps = common::boot(&common::Boot {
                input: Some((0, b"\n")),
                ..boot()
            })
            .steps;
            let mut at: Vec<u64> = (1..16).map(|k| steps * k / 16).collect();
            at.extend((0..21).map(|k| steps - (1 << k)));
            at.sort();
            at.dedup();
            at
        } else {
            vec![]
        };
        let r = common::boot(&common::Boot {
            input: migrate.then_some((0, &b"\n"[..])),
            snapshots: &at,
            ..boot()
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
