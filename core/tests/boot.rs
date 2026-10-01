//! Boots the Buildroot guest (target/images/linux/, from images/build.sh) with
//! virtio-console, virtio-rng and its root filesystem on virtio-blk: Linux runs
//! /test.sh and powers off; the console must show the test passed. Once in
//! deterministic mode and once in realtime mode, and once with the arm64
//! defconfig kernel (Image-defconfig). And twice with the root filesystem
//! writable through one overlay: the second boot finds what the first wrote.
//! And with the test devices: net, 9p, the framebuffer, input. And with a
//! shell on the console reading what the host sends (the PL011's RX path,
//! M8). The deterministic
//! boots take exactly tests/steps.txt's counts, on one vCPU and on 2 and 4
//! (M7: deterministic round-robin), and on 1, 2 and 4 in parallel (a thread
//! per vCPU, realtime), repeated. Ignored by default (they need
//! the images and a release build); scripts/ci.sh runs it with
//! `cargo test --release --test boot -- --ignored`.

mod common;

fn boot(realtime: bool) -> common::Run {
    boot_kernel("linux/Image", realtime)
}

fn boot_kernel(image: &str, realtime: bool) -> common::Run {
    boot_smp(image, realtime, 1)
}

fn boot_smp(image: &str, realtime: bool, ncpus: u64) -> common::Run {
    boot_mode(image, realtime, ncpus, false)
}

fn boot_mode(image: &str, realtime: bool, ncpus: u64, parallel: bool) -> common::Run {
    let kernel = common::image(image);
    let devices = common::guest_devices("buildroot/rootfs.ext4", None);
    let r = common::boot(&common::Boot {
        devices: &devices,
        realtime,
        echo: !parallel,
        ncpus,
        parallel,
        ..common::Boot::new(&kernel, common::GUEST_CMDLINE)
    });
    eprintln!("\n[{}]", r.summary);
    assert!(r.powered_off(), "no SYSTEM_OFF");
    let out = &r.console;
    assert!(
        out.contains("webpc: test ok\n") && out.contains("webpc: test exit 0\n"),
        "test script failed"
    );
    assert!(out.contains("answer: 42\n"));
    // virtio: 16 bytes read from virtio-rng, a line written to virtio-console,
    // the root filesystem and a raw read from virtio-blk.
    let rng = out.lines().find_map(|l| l.strip_prefix("hwrng: "));
    assert!(
        rng.is_some_and(|h| h.len() == 32 && h.bytes().all(|b| b.is_ascii_hexdigit())),
        "hwrng: {rng:?}"
    );
    assert_eq!(r.hvc, "webpc: hvc0 ok\n");
    assert!(out.contains("/dev/root / ext4 ro,"), "root filesystem");
    assert!(out.contains("vda magic: 53ef\n"));
    r
}

#[test]
#[ignore = "needs target/images (images/build.sh) and --release"]
fn linux_boots_and_runs_the_test_script() {
    assert_eq!(boot(false).steps, common::steps("buildroot"));
}

#[test]
#[ignore = "needs target/images (images/build.sh) and --release"]
fn linux_boots_on_2_and_4_vcpus() {
    for n in [2, 4] {
        let r = boot_smp("linux/Image", false, n);
        assert!(
            r.console
                .contains(&format!("smp: Brought up 1 node, {n} CPUs"))
        );
        assert_eq!(
            r.steps,
            common::steps(&format!("buildroot-{n}cpu")),
            "{n} vCPUs"
        );
    }
}

/// Parallel SMP isn't reproducible: `WEBPC_PARALLEL_RUNS` boots each (default 2).
#[test]
#[ignore = "needs target/images (images/build.sh) and --release"]
fn linux_boots_in_parallel_on_1_2_and_4_vcpus() {
    let runs = std::env::var("WEBPC_PARALLEL_RUNS").map_or(2, |v| v.parse().unwrap());
    for n in [1, 2, 4] {
        for _ in 0..runs {
            let r = boot_mode("linux/Image", true, n, true);
            let up = format!("smp: Brought up 1 node, {n} CPU");
            assert!(r.console.contains(&up), "{n} vCPUs: {}", r.console);
        }
    }
}

#[test]
#[ignore = "needs target/images (images/build.sh) and --release"]
fn linux_boots_in_realtime_mode() {
    boot(true);
}

#[test]
#[ignore = "needs target/images (images/build.sh) and --release"]
fn defconfig_kernel_boots() {
    boot_kernel("linux/Image-defconfig", false);
}

#[test]
#[ignore = "needs target/images (images/build.sh) and --release"]
fn root_is_writable_through_an_overlay_across_boots() {
    let kernel = common::image("linux/Image");
    let devices = common::guest_devices("buildroot/rootfs.ext4", Some(common::Overlay::new()));
    let cmdline = format!("{} -- /test-rw.sh", common::GUEST_CMDLINE);
    let mut hashes = Vec::new();
    for n in 1..=2 {
        let r = common::boot(&common::Boot {
            devices: &devices,
            ..common::Boot::new(&kernel, &cmdline)
        });
        eprintln!(
            "[boot {n}: {}]\n{}",
            r.summary,
            r.console
                .lines()
                .filter(|l| l.starts_with("rw: "))
                .collect::<Vec<_>>()
                .join("\n")
        );
        let out = &r.console;
        assert!(r.powered_off() && out.contains("webpc: test ok\n"), "{out}");
        assert!(out.contains(&format!("rw: boot {n}\n")), "{out}");
        let verb = if n == 1 { "rw: wrote " } else { "rw: kept " };
        hashes.push(
            out.lines()
                .find_map(|l| l.strip_prefix(verb))
                .expect(verb)
                .to_owned(),
        );
    }
    assert_eq!(hashes[0], hashes[1]);
}

/// Boots the Buildroot guest with the device test's devices (net with the
/// loopback adapter, 9p, keyboard, tablet) and a 640×480 framebuffer, running `script`.
fn boot_devices(script: &str) -> common::Run {
    let kernel = common::image("linux/Image");
    let devices = common::test_devices("buildroot/rootfs.ext4");
    let cmdline = format!("{} -- {script}", common::GUEST_CMDLINE);
    let r = common::boot(&common::Boot {
        devices: &devices,
        fb: (640, 480),
        ..common::Boot::new(&kernel, &cmdline)
    });
    eprintln!("[{}]\n{}", r.summary, r.console);
    assert!(
        r.powered_off() && r.console.contains("webpc: test ok\n"),
        "test script failed"
    );
    r
}

#[test]
#[ignore = "needs target/images (images/build.sh) and --release"]
fn net_9p_and_framebuffer_work() {
    let r = boot_devices("/test-devices.sh");
    assert_eq!(r.steps, common::steps("devices"));
    let out = &r.console;
    for want in [
        "net: mac 52:54:00:12:34:56\n",
        "3 packets transmitted, 3 packets received, 0% packet loss\n",
        "9p: hello from the host\n",
        "9p: b some text 10 -rw-r--r--\n",
        "9p: big 200000 ok\n",
        "9p: ls b big l \n",
        "9p: after rm b \n",
        "9p: top from-guest hello.txt \n",
        "fb: 0 simple 640,480\n",
    ] {
        assert!(out.contains(want), "missing {want:?}");
    }
    // Row 0 red, row 1 grey, the rest untouched (x8r8g8b8: B, G, R, X in memory).
    let px = |x: usize, y: usize| &r.fb[(y * 640 + x) * 4..][..3];
    assert_eq!((px(0, 0), px(639, 0)), (&[0, 0, 255][..], &[0, 0, 255][..]));
    assert_eq!(px(5, 1), [64, 64, 64]);
    assert_eq!(px(5, 2), [0, 0, 0]);
}

#[test]
#[ignore = "needs target/images (images/build.sh) and --release"]
fn input_events_reach_the_guest() {
    let r = boot_devices("/test-input.sh");
    let out = &r.console;
    for want in [
        "N: Name=\"webpc keyboard\"\n",
        "B: EV=120003\n",
        "B: LED=7\n",
        "N: Name=\"webpc tablet\"\n",
        "B: EV=f\n",
        "B: REL=100\n",
        "B: ABS=3\n",
        "input3: 1 30 1\n",
        "input3: 1 30 0\n",
        "input4: 3 0 16384\n",
        "input4: 3 1 8192\n",
        "input4: 1 272 1\n",
        "input4: 1 272 0\n",
    ] {
        assert!(out.contains(want), "missing {want:?}");
    }
}

#[test]
#[ignore = "needs target/images (images/build.sh) and --release"]
fn console_input_reaches_a_shell() {
    let kernel = common::image("linux/Image");
    let devices = common::guest_devices("buildroot/rootfs.ext4", None);
    let cmdline = format!("{} -- /bin/sh", common::GUEST_CMDLINE);
    let input = common::console_input();
    let r = common::boot(&common::Boot {
        devices: &devices,
        input: Some((common::CONSOLE_INPUT_STEP, &input)),
        max_steps: 200_000_000, // lost input leaves the shell waiting
        ..common::Boot::new(&kernel, &cmdline)
    });
    eprintln!("[{}]\n{}", r.summary, r.console);
    assert!(r.powered_off(), "no SYSTEM_OFF");
    assert!(r.console.contains(common::CONSOLE_INPUT_WANT), "no echo");
    assert!(r.console.contains("webpc: test exit 0\n"));
    assert_eq!(r.steps, common::steps("console-input"));
}

/// M8 phase C: the VM saved, thrown away and restored from its state at each
/// of `at` (steps) takes the steps of an unbroken boot and prints the same.
fn boot_through_snapshots(ncpus: u64, name: &str, at: &[u64]) {
    let kernel = common::image("linux/Image");
    let devices = common::guest_devices("buildroot/rootfs.ext4", None);
    let run = |snapshots: &[u64]| {
        common::boot(&common::Boot {
            devices: &devices,
            ncpus,
            snapshots,
            ..common::Boot::new(&kernel, common::GUEST_CMDLINE)
        })
    };
    let (whole, r) = (run(&[]), run(at));
    eprintln!(
        "[{}] snapshots (bytes, held chains): {:?}",
        r.summary, r.snapshots
    );
    assert_eq!(r.snapshots.len(), at.len(), "every snapshot taken");
    assert!(r.powered_off(), "no SYSTEM_OFF");
    assert_eq!(r.steps, common::steps(name));
    assert_eq!(r.console, whole.console);
    assert_eq!(r.hvc, whole.hvc);
}

#[test]
#[ignore = "needs target/images (images/build.sh) and --release"]
fn linux_boots_through_snapshots() {
    // In the early boot, around the devices' probes, in userspace, near the end.
    let at = [
        1_000_000, 9_000_000, 20_000_000, 25_000_000, 30_000_000, 33_333_333, 38_000_000,
        40_000_000,
    ];
    boot_through_snapshots(1, "buildroot", &at);
    // Every 2 M steps: 20 of them.
    let every: Vec<u64> = (1..=20).map(|k| k * 2_000_000).collect();
    boot_through_snapshots(1, "buildroot", &every);
}

#[test]
#[ignore = "needs target/images (images/build.sh) and --release"]
fn linux_boots_through_snapshots_on_2_and_4_vcpus() {
    // Round-robin's place (the vCPU running, the rest of its quantum, each
    // vCPU's power and WFI) is in the state.
    for n in [2, 4] {
        let total = common::steps(&format!("buildroot-{n}cpu"));
        let at: Vec<u64> = (1..=12).map(|k| k * total / 13 + k * 7919).collect();
        boot_through_snapshots(n, &format!("buildroot-{n}cpu"), &at);
    }
}

#[test]
#[ignore = "needs target/images (images/build.sh) and --release"]
fn the_device_test_runs_through_snapshots() {
    // Net and input buffers are held by the backends when the VM is saved,
    // and 9p, the rng and the disk are mid-conversation.
    let kernel = common::image("linux/Image");
    let devices = common::test_devices("buildroot/rootfs.ext4");
    let cmdline = format!("{} -- /test-devices.sh", common::GUEST_CMDLINE);
    let total = common::steps("devices");
    let at: Vec<u64> = (1..=40).map(|k| k * total / 41).collect();
    let r = common::boot(&common::Boot {
        devices: &devices,
        fb: (640, 480),
        snapshots: &at,
        ..common::Boot::new(&kernel, &cmdline)
    });
    eprintln!(
        "[{}] snapshots (bytes, held chains): {:?}",
        r.summary, r.snapshots
    );
    assert!(
        r.powered_off() && r.console.contains("webpc: test ok\n"),
        "{}",
        r.console
    );
    assert_eq!(r.snapshots.len(), at.len());
    assert!(
        r.snapshots.iter().any(|&(_, held)| held >= 256),
        "no snapshot with the net card's receive buffers held"
    );
    assert_eq!(r.steps, total);
    for want in [
        "3 packets transmitted, 3 packets received, 0% packet loss\n",
        "9p: big 200000 ok\n",
        "9p: top from-guest hello.txt \n",
    ] {
        assert!(r.console.contains(want), "missing {want:?}");
    }
}

#[test]
#[ignore = "needs target/images (images/build.sh) and --release"]
fn console_input_survives_snapshots() {
    // Around the input: bytes wait in the PL011's RX ring (and behind it, in
    // the host's queue) when the VM is saved.
    let kernel = common::image("linux/Image");
    let devices = common::guest_devices("buildroot/rootfs.ext4", None);
    let cmdline = format!("{} -- /bin/sh", common::GUEST_CMDLINE);
    let input = common::console_input();
    let s = common::CONSOLE_INPUT_STEP;
    let at = [
        s - 1_000_000,
        s,
        s + 1,
        s + 20_000,
        s + 300_000,
        s + 2_000_000,
    ];
    let r = common::boot(&common::Boot {
        devices: &devices,
        input: Some((s, &input)),
        max_steps: 200_000_000,
        snapshots: &at,
        ..common::Boot::new(&kernel, &cmdline)
    });
    eprintln!("[{}]\n{}", r.summary, r.console);
    assert!(r.powered_off(), "no SYSTEM_OFF");
    assert!(r.console.contains(common::CONSOLE_INPUT_WANT), "no echo");
    assert_eq!(r.snapshots.len(), at.len());
    assert_eq!(r.steps, common::steps("console-input"));
}

/// Parallel SMP through snapshots (M8 phase C loop 2): each stretch runs a
/// thread per vCPU; between them the VM is saved with every vCPU out of the
/// core and a new one restored (power states, CPU_ON requests, WFI, the timer
/// lines and the clock go through the state). Not reproducible:
/// `WEBPC_PARALLEL_RUNS` boots each (default 2).
#[test]
#[ignore = "needs target/images (images/build.sh) and --release"]
fn linux_boots_in_parallel_through_snapshots() {
    let runs = std::env::var("WEBPC_PARALLEL_RUNS").map_or(2, |v| v.parse().unwrap());
    let kernel = common::image("linux/Image");
    let devices = common::guest_devices("buildroot/rootfs.ext4", None);
    for n in [1, 2, 4] {
        for run in 0..runs as u64 {
            // Through the secondaries' CPU_ON, the devices' probes and userspace.
            let at: Vec<u64> = (1..=30).map(|k| k * 1_500_000 + run * 333_333).collect();
            let r = common::boot(&common::Boot {
                devices: &devices,
                ncpus: n,
                parallel: true,
                snapshots: &at,
                ..common::Boot::new(&kernel, common::GUEST_CMDLINE)
            });
            eprintln!("[{n} vCPUs: {}] {} snapshots", r.summary, r.snapshots.len());
            assert!(r.powered_off(), "{n} vCPUs: no SYSTEM_OFF\n{}", r.console);
            let out = &r.console;
            assert!(
                out.contains(&format!("smp: Brought up 1 node, {n} CPU")),
                "{out}"
            );
            assert!(out.contains("webpc: test ok\n") && out.contains("webpc: test exit 0\n"));
            assert_eq!(r.hvc, "webpc: hvc0 ok\n");
            assert!(r.snapshots.len() >= 20, "{} snapshots", r.snapshots.len());
        }
    }
}
