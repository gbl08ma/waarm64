//! Boots the distro images (target/images/{alpine,debian}, images/build.sh) on
//! 1 GiB of RAM, with their own kernel and initrd and the root filesystem on
//! virtio-blk (Debian's a compressed qcow2, writable through an in-memory
//! overlay; Alpine's read-only): each runs a test and powers off.
//! Ignored by default (they need the images and a release build, and take
//! minutes); scripts/ci.sh says which of them it runs.

mod common;

use common::{Boot, Distro, Overlay, Run};

fn boot(d: &Distro, overlay: Option<&'static Overlay>, max_steps: u64) -> Run {
    let (kernel, initrd) = (common::image(d.kernel), common::image(d.initrd));
    let devices = common::guest_devices(d.disk, overlay);
    let r = common::boot(&Boot {
        initrd: Some(&initrd),
        devices: &devices,
        ram_size: 1 << 30,
        max_steps,
        echo: true,
        ..Boot::new(&kernel, d.cmdline)
    });
    eprintln!("\n[{}]", r.summary);
    assert!(r.powered_off(), "no SYSTEM_OFF");
    assert!(r.console.contains("webpc: test ok\n"), "test failed");
    r
}

#[test]
#[ignore = "needs target/images/alpine (images/build.sh alpine) and --release"]
fn alpine_boots_and_runs_the_test_script() {
    let r = boot(&common::ALPINE, None, 50_000_000_000);
    let out = &r.console;
    assert!(out.contains("webpc: alpine 3.24.2 6.18.53-0-virt\n"));
    assert!(out.contains("/dev/vda / ext4 ro,"), "root filesystem");
    assert!(out.contains("webpc: modules ext4 virtio_blk virtio_mmio \n"));
}

#[test]
#[ignore = "needs target/images/debian (images/build.sh debian) and --release"]
fn debian_boots_read_write_and_runs_a_command() {
    let r = boot(&common::DEBIAN, Some(Overlay::new()), 500_000_000_000);
    assert!(r.console.contains("webpc: debian\n13."), "{}", r.console);
    assert!(
        r.console.contains("\n6.12.107+deb13-arm64\nrw,"),
        "root not read-write"
    );
}
