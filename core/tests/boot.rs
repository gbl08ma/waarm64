//! Boots the Buildroot guest (target/images/linux/, from images/build.sh) with
//! virtio-console, virtio-rng and its root filesystem on virtio-blk: Linux runs
//! /test.sh and powers off; the console must show the test passed. Once in
//! deterministic mode and once in realtime mode, and once with the arm64
//! defconfig kernel (Image-defconfig). And twice with the root filesystem
//! writable through one overlay: the second boot finds what the first wrote.
//! And with the test devices: net, 9p, the framebuffer, input. The deterministic
//! boots take exactly tests/steps.txt's counts. Ignored by default (they need
//! the images and a release build); scripts/ci.sh runs it with
//! `cargo test --release --test boot -- --ignored`.

mod common;

fn boot(realtime: bool) -> common::Run {
    boot_kernel("linux/Image", realtime)
}

fn boot_kernel(image: &str, realtime: bool) -> common::Run {
    let kernel = common::image(image);
    let devices = common::guest_devices("buildroot/rootfs.ext4", None);
    let r = common::boot(&common::Boot {
        devices: &devices,
        realtime,
        echo: true,
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
