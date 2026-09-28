//! The litmus image (images/build.sh litmus, M7) on 4 vCPUs through the
//! interpreter, deterministic round-robin and parallel (a thread per vCPU):
//! herdtools7's litmus7 tests, none of which may observe a final state herd7's
//! aarch64.cat forbids (images/litmus/check.awk), then the atomics stress
//! (images/litmus/stress.c, LSE and LL/SC), whose totals must be exact. The
//! round-robin run takes exactly tests/steps.txt's `litmus-4cpu` steps.
//! `WEBPC_LITMUS` and `WEBPC_STRESS` override the options (commas for spaces).
//! Ignored by default (they need the image and a release build); scripts/ci.sh
//! runs them.

mod common;

fn litmus(parallel: bool, litmus: &str, stress: &str) -> common::Run {
    let kernel = common::image("linux/Image");
    let initrd = common::image("litmus/initramfs.cpio");
    let opt = |var, default: &str| std::env::var(var).unwrap_or(default.into());
    let cmdline = format!(
        "console=ttyAMA0 panic=-1 webpc.litmus={} webpc.stress={}",
        opt("WEBPC_LITMUS", litmus),
        opt("WEBPC_STRESS", stress)
    );
    let r = common::boot(&common::Boot {
        initrd: Some(&initrd),
        ncpus: 4,
        parallel,
        max_steps: 500_000_000_000,
        ..common::Boot::new(&kernel, &cmdline)
    });
    eprintln!("\n[{}]", r.summary);
    for l in r.console.lines().filter(|l| l.starts_with("stress: spin")) {
        eprintln!("{l}");
    }
    assert!(r.powered_off(), "no SYSTEM_OFF:\n{}", r.console);
    assert!(
        r.console.contains("webpc: litmus on 4 CPUs")
            && r.console
                .contains("litmus: all ok, 0 skipped\nwebpc: stress on 4 CPUs")
            && r.console.contains("\nwebpc: test ok\n"),
        "{}",
        r.console
    );
    r
}

#[test]
#[ignore = "needs target/images/litmus (images/build.sh linux litmus) and --release"]
fn litmus_round_robin() {
    let r = litmus(false, "-s,100,-r,1", "-n,20000");
    if std::env::var_os("WEBPC_LITMUS").is_none() && std::env::var_os("WEBPC_STRESS").is_none() {
        assert_eq!(r.steps, common::steps("litmus-4cpu"));
    }
}

#[test]
#[ignore = "needs target/images/litmus (images/build.sh linux litmus) and --release"]
fn litmus_parallel() {
    litmus(true, "-s,1000,-r,10", "-n,100000");
}
