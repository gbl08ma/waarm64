//! Boots the distro images (target/images/alpine, images/build.sh) on
//! 1 GiB of RAM, with their own kernel and initrd and the root filesystem on
//! virtio-blk (read-only, with the step 6 devices and a framebuffer too): each
//! runs a test and powers off. Debian boots through UEFI on the page, not here.
//! Ignored by default (they need the images and a release build, and take
//! minutes); scripts/ci.sh says which of them it runs.

mod common;

use common::{Boot, Dev, Distro, Run};

fn boot(d: &Distro, devices: &[Dev], fb: (u64, u64), max_steps: u64) -> Run {
    boot_n(d, devices, fb, max_steps, 1)
}

fn boot_n(d: &Distro, devices: &[Dev], fb: (u64, u64), max_steps: u64, ncpus: u64) -> Run {
    boot_mode(d, devices, fb, max_steps, ncpus, false)
}

fn boot_mode(
    d: &Distro,
    devices: &[Dev],
    fb: (u64, u64),
    max_steps: u64,
    ncpus: u64,
    parallel: bool,
) -> Run {
    let (kernel, initrd) = (common::image(d.kernel), common::image(d.initrd));
    let r = common::boot(&Boot {
        initrd: Some(&initrd),
        devices,
        ram_size: 1 << 30,
        max_steps,
        echo: true,
        fb,
        ncpus,
        parallel,
        ..Boot::new(&kernel, d.cmdline)
    });
    eprintln!("\n[{}]", r.summary);
    assert!(r.powered_off(), "no SYSTEM_OFF");
    assert!(r.console.contains("waarm64: test ok\n"), "test failed");
    r
}

#[test]
#[ignore = "needs target/images/alpine (images/build.sh alpine) and --release"]
fn alpine_boots_and_runs_the_test_script() {
    // With the step 6 devices too, for linux-virt's modules.
    let devices = common::test_devices(common::ALPINE.disk);
    let r = boot(&common::ALPINE, &devices, (640, 480), 50_000_000_000);
    let out = &r.console;
    assert!(out.contains("waarm64: alpine 3.24.2 6.18.52-0-virt\n"));
    assert!(out.contains("/dev/vda / ext4 ro,"), "root filesystem");
    assert!(out.contains("waarm64: modules ext4 virtio_blk virtio_mmio \n"));
    assert!(out.contains("1 packets transmitted, 1 packets received"));
    assert!(out.contains("waarm64: 9p hello from the host\n"));
    assert!(out.contains("N: Name=\"waarm64 keyboard\"\nN: Name=\"waarm64 tablet\"\n"));
    assert!(out.contains("waarm64: drm 640x480\n"));
    assert_eq!(r.steps, common::steps("alpine"));
}

/// Alpine's boot through the JIT's dispatcher, natively the block interpreter
/// (`interp::block`): the same steps as the interpreter's.
#[test]
#[ignore = "needs target/images/alpine (images/build.sh alpine) and --release"]
fn alpine_boots_through_the_block_interpreter() {
    let d = &common::ALPINE;
    let (kernel, initrd) = (common::image(d.kernel), common::image(d.initrd));
    let devices = common::test_devices(d.disk);
    let r = common::boot(&Boot {
        initrd: Some(&initrd),
        devices: &devices,
        ram_size: 1 << 30,
        max_steps: 50_000_000_000,
        fb: (640, 480),
        jit: 1,
        ..Boot::new(&kernel, d.cmdline)
    });
    eprintln!("\n[{}]", r.summary);
    assert!(r.console.contains("waarm64: test ok\n"), "test failed");
    assert_eq!(r.steps, common::steps("alpine"));
}

/// Alpine on `WAARM64_NCPUS` vCPUs (default 2), deterministic round-robin
/// (M7), or in parallel with `WAARM64_PARALLEL=1` (a thread per vCPU).
#[test]
#[ignore = "needs target/images/alpine (images/build.sh alpine) and --release"]
fn alpine_smp() {
    let n: u64 = std::env::var("WAARM64_NCPUS").map_or(2, |v| v.parse().unwrap());
    let parallel = std::env::var("WAARM64_PARALLEL").is_ok_and(|v| v == "1");
    let devices = common::test_devices(common::ALPINE.disk);
    let r = boot_mode(
        &common::ALPINE,
        &devices,
        (640, 480),
        50_000_000_000,
        n,
        parallel,
    );
    assert!(
        r.console
            .contains(&format!("smp: Brought up 1 node, {n} CPUs")),
        "not all CPUs up"
    );
    assert!(r.console.contains(
        "waarm64: alpine 3.24.2 6.18.52-0-virt
"
    ));
}

/// M8 phase C: Alpine saved and restored into a new VM at several points of
/// its boot takes the steps of an unbroken boot.
#[test]
#[ignore = "needs target/images/alpine (images/build.sh alpine) and --release"]
fn alpine_boots_through_snapshots() {
    let devices = common::test_devices(common::ALPINE.disk);
    let total = common::steps("alpine");
    let at: Vec<u64> = (1..=8).map(|k| k * total / 9 + k).collect();
    let (kernel, initrd) = (
        common::image(common::ALPINE.kernel),
        common::image(common::ALPINE.initrd),
    );
    let r = common::boot(&Boot {
        initrd: Some(&initrd),
        devices: &devices,
        ram_size: 1 << 30,
        max_steps: 50_000_000_000,
        fb: (640, 480),
        snapshots: &at,
        ..Boot::new(&kernel, common::ALPINE.cmdline)
    });
    eprintln!(
        "[{}] snapshots (bytes, held chains): {:?}",
        r.summary, r.snapshots
    );
    assert!(r.powered_off(), "no SYSTEM_OFF");
    let out = &r.console;
    assert!(out.contains("waarm64: test ok\n"), "{out}");
    assert!(out.contains("1 packets transmitted, 1 packets received"));
    assert!(out.contains("waarm64: 9p hello from the host\n"));
    assert_eq!(r.snapshots.len(), at.len());
    assert_eq!(r.steps, total);
}

/// What a restore is to a guest: the machine with its TLBs emptied. Alpine's
/// userspace benchmark (10.8 G steps) is the guest we have that can tell:
/// through three snapshots it takes 1.1 M fewer steps than unbroken (Linux
/// clears access flags without a TLBI, and faults once the entry is gone), and
/// exactly the steps of a run whose TLBs are only flushed at the same points
/// (`alpine-user-snapshots` in tests/steps.txt; tests/snapshot.test.ts takes
/// them under the JIT). Two runs, ~4 min: on demand, not in ci.sh.
#[test]
#[ignore = "needs target/images/alpine-user (images/build.sh alpine-user) and --release; ~4 min"]
fn userspace_through_snapshots_is_the_run_with_tlb_flushes() {
    let total = common::steps("alpine-user");
    let at = [total / 4, total / 2 + 1, 3 * total / 4 + 2];
    let (kernel, initrd) = (
        common::image(common::ALPINE.kernel),
        common::image(common::ALPINE.initrd),
    );
    let devices = common::guest_devices("alpine-user/rootfs-user.ext4", None);
    let run = |flush_only| {
        let r = common::boot(&Boot {
            initrd: Some(&initrd),
            devices: &devices,
            ram_size: 1 << 30,
            max_steps: 50_000_000_000,
            snapshots: &at,
            flush_only,
            ..Boot::new(&kernel, common::ALPINE.cmdline)
        });
        assert!(r.powered_off(), "no SYSTEM_OFF");
        r.steps
    };
    let (flushed, restored) = std::thread::scope(|s| {
        let a = s.spawn(|| run(true));
        (run(false), a.join().unwrap())
    });
    assert_eq!(restored, flushed);
    assert_eq!(restored, common::steps("alpine-user-snapshots"));
}
