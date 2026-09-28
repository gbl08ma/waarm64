//! Boots the distro images (target/images/{alpine,debian}, images/build.sh) on
//! 1 GiB of RAM, with their own kernel and initrd and the root filesystem on
//! virtio-blk (Debian's a compressed qcow2, writable through an in-memory
//! overlay; Alpine's read-only, with the step 6 devices and a framebuffer
//! too): each runs a test and powers off.
//! Ignored by default (they need the images and a release build, and take
//! minutes); scripts/ci.sh says which of them it runs.

mod common;

use common::{Boot, Dev, Distro, Overlay, Run};

fn boot(d: &Distro, devices: &[Dev], fb: (u64, u64), max_steps: u64) -> Run {
    boot_n(d, devices, fb, max_steps, 1)
}

fn boot_n(d: &Distro, devices: &[Dev], fb: (u64, u64), max_steps: u64, ncpus: u64) -> Run {
    let (kernel, initrd) = (common::image(d.kernel), common::image(d.initrd));
    let r = common::boot(&Boot {
        initrd: Some(&initrd),
        devices,
        ram_size: 1 << 30,
        max_steps,
        echo: true,
        fb,
        ncpus,
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
    // With the step 6 devices too, for linux-virt's modules.
    let devices = common::test_devices(common::ALPINE.disk);
    let r = boot(&common::ALPINE, &devices, (640, 480), 50_000_000_000);
    let out = &r.console;
    assert!(out.contains("webpc: alpine 3.24.2 6.18.53-0-virt\n"));
    assert!(out.contains("/dev/vda / ext4 ro,"), "root filesystem");
    assert!(out.contains("webpc: modules ext4 virtio_blk virtio_mmio \n"));
    assert!(out.contains("1 packets transmitted, 1 packets received"));
    assert!(out.contains("webpc: 9p hello from the host\n"));
    assert!(out.contains("N: Name=\"webpc keyboard\"\nN: Name=\"webpc tablet\"\n"));
    assert!(out.contains("webpc: drm 640x480\n"));
    assert_eq!(r.steps, common::steps("alpine"));
}

/// Alpine on `WEBPC_NCPUS` vCPUs (default 2), deterministic round-robin (M7).
#[test]
#[ignore = "needs target/images/alpine (images/build.sh alpine) and --release"]
fn alpine_smp() {
    let n: u64 = std::env::var("WEBPC_NCPUS").map_or(2, |v| v.parse().unwrap());
    let devices = common::test_devices(common::ALPINE.disk);
    let r = boot_n(&common::ALPINE, &devices, (640, 480), 50_000_000_000, n);
    assert!(
        r.console
            .contains(&format!("smp: Brought up 1 node, {n} CPUs")),
        "not all CPUs up"
    );
    assert!(r.console.contains(
        "webpc: alpine 3.24.2 6.18.53-0-virt
"
    ));
}

#[test]
#[ignore = "needs target/images/debian (images/build.sh debian) and --release"]
fn debian_boots_read_write_and_runs_a_command() {
    let devices = common::guest_devices(common::DEBIAN.disk, Some(Overlay::new()));
    let r = boot(&common::DEBIAN, &devices, (0, 0), 500_000_000_000);
    assert!(r.console.contains("webpc: debian\n13."), "{}", r.console);
    assert!(
        r.console.contains("\n6.12.107+deb13-arm64\nrw,"),
        "root not read-write"
    );
}
