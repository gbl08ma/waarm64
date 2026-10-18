//! Boots the USB test kernel (target/images/linux-usb/, images/build.sh linux-usb: Linux with
//! xhci-plat-hcd and usbtest, a static init and the kernel's testusb, images/usb/init.c) on the
//! machine's xHCI (docs/usb.md):
//! - `usb-hubs`: no device; the guest shows the two root hubs, four ports each.
//! - `usb`: a Gadget Zero at high speed on connector 0 and one at super speed on connector 1 from the
//!   start; testusb runs clean, again until the host unplugs the first one at a step count (mid-test),
//!   and clean once more after the host plugs it in again at a later step.
//!
//! Each in the step count the Node and Chromium runs take (tests/boot-node-suite.ts,
//! tests/browser.test.ts; tests/steps.txt "usb-hubs", "usb"). Ignored by default (needs the image and
//! a release build); scripts/ci.sh runs them.

mod common;

use common::usb::{GzOptions, Speed};
use common::{Boot, UsbBoot};

/// The kernel's command line for the testusb run (tests/usb/guest.ts has the same).
pub const USB_CMDLINE: &str = "console=ttyAMA0 panic=-1 usbtest.pattern=1 usb_devices=2 usb_unplug=1 usb_args=-a,-c,10,-s,1024,-v,512,-g,16";
const HIGH: GzOptions = GzOptions {
    speed: Speed::High,
    pattern: 1,
};
const SUPER: GzOptions = GzOptions {
    speed: Speed::Super,
    pattern: 1,
};

fn steps_env(name: &str, default: u64) -> u64 {
    std::env::var(name).map_or(default, |v| v.parse().unwrap())
}

#[test]
#[ignore = "needs target/images (images/build.sh linux-usb) and --release"]
fn the_usb_guest_sees_two_root_hubs() {
    let kernel = common::image("linux-usb/Image");
    let initrd = common::image("linux-usb/initramfs.cpio");
    let r = common::boot(&Boot {
        initrd: Some(&initrd),
        echo: true,
        usb: Some(UsbBoot::default()),
        ..Boot::new(&kernel, "console=ttyAMA0 panic=-1")
    });
    eprintln!("[{}]", r.summary);
    assert!(r.powered_off(), "no SYSTEM_OFF");
    for want in [
        "usb: hub usb1 480 Mb/s 4 ports, USB 2.00, xHCI Host Controller\n",
        "usb: hub usb2 5000 Mb/s 4 ports, USB 3.00, xHCI Host Controller\n",
        "webpc: usb test ok\n",
    ] {
        assert!(r.console.contains(want), "missing {want:?}");
    }
    assert_eq!(r.steps, common::steps("usb-hubs"));
}

#[test]
#[ignore = "needs target/images (images/build.sh linux-usb) and --release"]
fn testusb_passes_against_gadget_zero_with_a_hot_unplug() {
    let kernel = common::image("linux-usb/Image");
    let initrd = common::image("linux-usb/initramfs.cpio");
    let (unplug, replug) = (
        steps_env("WEBPC_USB_UNPLUG", USB_UNPLUG),
        steps_env("WEBPC_USB_REPLUG", USB_REPLUG),
    );
    let events = [(unplug, 0, None), (replug, 0, Some(HIGH))];
    let cmdline = std::env::var("WEBPC_USB_CMDLINE").unwrap_or(USB_CMDLINE.into());
    let r = common::boot(&Boot {
        initrd: Some(&initrd),
        echo: true,
        usb: Some(UsbBoot {
            attach: &[(0, HIGH), (1, SUPER)],
            events: &events,
        }),
        ..Boot::new(&kernel, &cmdline)
    });
    eprintln!("[{}]", r.summary);
    assert!(r.powered_off(), "no SYSTEM_OFF");
    check_usb_guest(&r.console);
    assert_eq!(r.steps, common::steps("usb"));
}

/// The step counts at which the host unplugs connector 0 and plugs it in again (tests/usb/guest.ts too).
pub const USB_UNPLUG: u64 = 80_000_000;
pub const USB_REPLUG: u64 = 100_000_000;

/// What the guest must have printed (tests/usb/guest.ts `checkUsbGuest`).
fn check_usb_guest(console: &str) {
    for want in [
        "usb: gadget 1-1: Gadget Zero, 480 Mb/s, configuration 3, interface driver usbtest\n",
        "usb: gadget 2-2: Gadget Zero, 5000 Mb/s, configuration 3, interface driver usbtest\n",
        "usb: pass 1: ",
        "usb: plugged in again\n",
        "webpc: usb test ok\n",
    ] {
        assert!(console.contains(want), "missing {want:?}");
    }
    let unplugged = console
        .lines()
        .find_map(|l| l.strip_prefix("usb: unplugged during pass "))
        .expect("no unplug");
    let pass: u32 = unplugged.parse().unwrap();
    // The pass the unplug cut short failed somewhere; the first and the last didn't.
    let line = |p: u32| {
        console
            .lines()
            .find(|l| l.starts_with(&format!("usb: pass {p}: ")))
            .unwrap()
            .to_owned()
    };
    assert!(line(1).ends_with(", 0 failed"), "{}", line(1));
    assert!(
        !line(pass).contains(", 0 failed"),
        "the unplug didn't cut pass {pass}: {}",
        line(pass)
    );
    assert!(line(pass + 1).ends_with(", 0 failed"), "{}", line(pass + 1));
}

#[test]
#[ignore = "needs target/images (images/build.sh linux-usb) and --release"]
fn testusb_passes_in_parallel_smp() {
    // A thread per vCPU (realtime: no exact steps, so no hot-plug at a step): one clean pass, a few times.
    let kernel = common::image("linux-usb/Image");
    let initrd = common::image("linux-usb/initramfs.cpio");
    let cmdline = USB_CMDLINE.replace("usb_unplug=1", "usb_unplug=0");
    for run in 0..3 {
        let r = common::boot(&Boot {
            initrd: Some(&initrd),
            ncpus: 2,
            parallel: true,
            usb: Some(UsbBoot {
                attach: &[(0, HIGH), (1, SUPER)],
                events: &[],
            }),
            ..Boot::new(&kernel, &cmdline)
        });
        eprintln!("[run {run}: {}]", r.summary);
        assert!(r.powered_off(), "run {run}: no SYSTEM_OFF\n{}", r.console);
        assert!(
            r.console.contains("usb: pass 1: 46 lines, 0 failed\n"),
            "run {run}:\n{}",
            r.console
        );
        assert!(r.console.contains("webpc: usb test ok\n"), "run {run}");
    }
}
