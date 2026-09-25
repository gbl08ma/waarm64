//! Boots the Buildroot guest (target/images/linux/, from images/build.sh) with
//! virtio-console and virtio-rng: Linux runs the initramfs's /test.sh and
//! powers off; the console must show the test passed. Ignored by default (it needs the images and a release
//! build); scripts/ci.sh runs it with `cargo test --release --test boot -- --ignored`.

mod common;

#[test]
#[ignore = "needs target/images (images/build.sh) and --release"]
fn linux_boots_and_runs_the_test_script() {
    let (kernel, initrd) = (
        common::image("linux/Image"),
        common::image("linux/rootfs.cpio"),
    );
    let r = common::boot(
        &kernel,
        Some(&initrd),
        "console=ttyAMA0 earlycon panic=-1",
        common::GUEST_DEVICES,
        20_000_000_000,
        true,
    );
    eprintln!("\n[{}]", r.summary);
    assert!(r.powered_off(), "no SYSTEM_OFF");
    let out = &r.console;
    assert!(
        out.contains("webpc: test ok\n") && out.contains("webpc: test exit 0\n"),
        "test script failed"
    );
    assert!(out.contains("answer: 42\n"));
    // virtio: 16 bytes read from virtio-rng, a line written to virtio-console.
    let rng = out.lines().find_map(|l| l.strip_prefix("hwrng: "));
    assert!(
        rng.is_some_and(|h| h.len() == 32 && h.bytes().all(|b| b.is_ascii_hexdigit())),
        "hwrng: {rng:?}"
    );
    assert_eq!(r.hvc, "webpc: hvc0 ok\n");
}
