//! Boots the Buildroot guest (target/images/linux/, from images/build.sh) with
//! virtio-console, virtio-rng and its root filesystem on virtio-blk: Linux runs
//! /test.sh and powers off; the console must show the test passed. Once in
//! deterministic mode and once in realtime mode, and once with the arm64
//! defconfig kernel (Image-defconfig). Ignored by default (it needs
//! the images and a release build); scripts/ci.sh runs it with
//! `cargo test --release --test boot -- --ignored`.

mod common;

fn boot(realtime: bool) {
    boot_kernel("linux/Image", realtime);
}

fn boot_kernel(image: &str, realtime: bool) {
    let kernel = common::image(image);
    let devices = common::guest_devices("linux/rootfs.ext4");
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
}

#[test]
#[ignore = "needs target/images (images/build.sh) and --release"]
fn linux_boots_and_runs_the_test_script() {
    boot(false);
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
