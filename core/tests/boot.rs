//! Boots the Buildroot guest (target/images/linux/, from images/build.sh) with
//! virtio-console, virtio-rng and its root filesystem on virtio-blk: Linux runs
//! /test.sh and powers off; the console must show the test passed. Once in
//! deterministic mode and once in realtime mode, and once with the arm64
//! defconfig kernel (Image-defconfig). And twice with the root filesystem
//! writable through one overlay: the second boot finds what the first wrote. Ignored by default (it needs
//! the images and a release build); scripts/ci.sh runs it with
//! `cargo test --release --test boot -- --ignored`.

mod common;

fn boot(realtime: bool) {
    boot_kernel("linux/Image", realtime);
}

fn boot_kernel(image: &str, realtime: bool) {
    let kernel = common::image(image);
    let devices = common::guest_devices("linux/rootfs.ext4", None);
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

#[test]
#[ignore = "needs target/images (images/build.sh) and --release"]
fn root_is_writable_through_an_overlay_across_boots() {
    let kernel = common::image("linux/Image");
    let devices = common::guest_devices("linux/rootfs.ext4", Some(common::Overlay::new()));
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
