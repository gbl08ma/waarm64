//! The litmus image (images/build.sh litmus, M7) on 4 vCPUs through the
//! interpreter, deterministic round-robin and parallel (a thread per vCPU):
//! herdtools7's litmus7 tests, none of which may observe a final state herd7's
//! aarch64.cat forbids (images/litmus/check.awk), then the atomics stress
//! (images/litmus/stress.c, LSE and LL/SC), whose totals must be exact. The
//! round-robin run takes exactly tests/steps.txt's `litmus-4cpu` steps.
//! `WAARM64_LITMUS` and `WAARM64_STRESS` override the options (commas for spaces).
//! Ignored by default (they need the image and a release build); scripts/ci.sh
//! runs them.

mod common;

fn litmus(parallel: bool, litmus: &str, stress: &str, snapshots: &[u64]) -> common::Run {
    let kernel = common::image("linux/Image");
    let initrd = common::image("litmus/initramfs.cpio");
    let opt = |var, default: &str| std::env::var(var).unwrap_or(default.into());
    let cmdline = format!(
        "console=ttyAMA0 panic=-1 waarm64.litmus={} waarm64.stress={}",
        opt("WAARM64_LITMUS", litmus),
        opt("WAARM64_STRESS", stress)
    );
    let r = common::boot(&common::Boot {
        initrd: Some(&initrd),
        ncpus: 4,
        parallel,
        snapshots,
        max_steps: 500_000_000_000,
        ..common::Boot::new(&kernel, &cmdline)
    });
    eprintln!("\n[{}]", r.summary);
    for l in r.console.lines().filter(|l| l.starts_with("stress: spin")) {
        eprintln!("{l}");
    }
    assert!(r.powered_off(), "no SYSTEM_OFF:\n{}", r.console);
    assert!(
        r.console.contains("waarm64: litmus on 4 CPUs")
            && r.console
                .contains("litmus: all ok, 0 skipped\nwaarm64: stress on 4 CPUs")
            && r.console.contains("\nwaarm64: test ok\n"),
        "{}",
        r.console
    );
    r
}

#[test]
#[ignore = "needs target/images/litmus (images/build.sh linux litmus) and --release"]
fn litmus_round_robin() {
    let r = litmus(false, "-s,100,-r,1", "-n,20000", &[]);
    if std::env::var_os("WAARM64_LITMUS").is_none() && std::env::var_os("WAARM64_STRESS").is_none()
    {
        assert_eq!(r.steps, common::steps("litmus-4cpu"));
    }
}

#[test]
#[ignore = "needs target/images/litmus (images/build.sh linux litmus) and --release"]
fn litmus_parallel() {
    litmus(true, "-s,1000,-r,10", "-n,100000", &[]);
}

/// M8 phase C: the litmus tests and the stress go on in a VM restored from a
/// snapshot, 12 times in a run. Round-robin, the run takes the unbroken one's
/// steps; in parallel (a thread per vCPU), the tests' verdicts and the
/// stress's exact totals hold across the saves (the exclusive monitors, the
/// vCPUs' power and WFI states, and the clock are in the state).
#[test]
#[ignore = "needs target/images/litmus (images/build.sh linux litmus) and --release"]
fn litmus_round_robin_through_snapshots() {
    let total = common::steps("litmus-4cpu");
    let at: Vec<u64> = (1..=12).map(|k| k * total / 13 + k).collect();
    let r = litmus(false, "-s,100,-r,1", "-n,20000", &at);
    assert_eq!(r.snapshots.len(), at.len());
    if std::env::var_os("WAARM64_LITMUS").is_none() && std::env::var_os("WAARM64_STRESS").is_none()
    {
        assert_eq!(r.steps, total);
    }
}

#[test]
#[ignore = "needs target/images/litmus (images/build.sh linux litmus) and --release"]
fn litmus_parallel_through_snapshots() {
    let at: Vec<u64> = (1..=12).map(|k| k * 60_000_000).collect();
    let r = litmus(true, "-s,100,-r,1", "-n,20000", &at);
    eprintln!("{} snapshots in {} steps", r.snapshots.len(), r.steps);
    assert!(r.snapshots.len() >= 6, "{} snapshots", r.snapshots.len());
}
