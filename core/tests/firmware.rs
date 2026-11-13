//! The firmware configuration (M8 phase B, docs/abi.md): EDK2's
//! ArmVirtQemuKernel (target/images/edk2/, `images/build.sh edk2`) boots the
//! UEFI Shell from the test disk (shell.img), whose startup.nsh prints a
//! variable, sets it in the flash bank and powers off; a second boot with the
//! same flash bytes prints it. Both take tests/steps.txt's counts (the Node
//! runs in tests/boot-node-suite.ts too). Ignored by default (they need the
//! image and a release build); scripts/ci.sh runs them with `--ignored`.

mod common;

use common::{FIRMWARE_EPOCH_MS, Firmware};

const FLASH: u64 = 1 << 20;

fn edk2(flash: Option<&[u8]>) -> common::Run {
    let fw = common::image("edk2/QEMU_EFI.fd");
    let devices = [common::Dev::Blk(common::disk("edk2/shell.img"), None)];
    let r = common::boot(&common::Boot {
        devices: &devices,
        ram_size: 512 << 20,
        max_steps: 4_000_000_000,
        firmware: Some(Firmware {
            flash_size: FLASH,
            flash,
            fw_cfg: &[],
            rtc: FIRMWARE_EPOCH_MS,
        }),
        ..common::Boot::new(&fw, "")
    });
    eprintln!("{}", r.summary);
    assert!(r.powered_off(), "{}", r.console);
    r
}

/// The console without the Shell's colours and cursor moves.
fn plain(s: &str) -> String {
    let mut out = String::new();
    let mut esc = false;
    for c in s.chars() {
        match (esc, c) {
            (false, '\x1b') => esc = true,
            (false, c) => out.push(c),
            (true, c) if c.is_ascii_alphabetic() => esc = false,
            _ => {}
        }
    }
    out
}

#[test]
#[ignore]
fn edk2_boots_the_shell_and_keeps_a_variable() {
    let r = edk2(None);
    let con = plain(&r.console);
    assert!(
        con.contains("waarm64: before\nsetvar: Unable to get") && con.contains("waarm64: done"),
        "{con}"
    );
    assert_eq!(r.steps, common::steps("edk2-shell"));
    let r2 = edk2(Some(&r.flash));
    let con = plain(&r2.console);
    assert!(
        con.contains(
            "Waarm64Test - 0012 Bytes\n70 00 65 00 72 00 73 00 69 00 73 00 74 00 65 00 64 00"
        ),
        "{con}"
    );
    assert_eq!(r2.steps, common::steps("edk2-shell-again"));
}
