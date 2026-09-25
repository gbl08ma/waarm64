//! Boots the Buildroot guest (target/images/linux/, from images/build.sh):
//! Linux runs the initramfs's /test.sh and powers off; the console must show
//! the test passed. Ignored by default (it needs the images and a release
//! build); scripts/ci.sh runs it with `cargo test --release --test boot -- --ignored`.

use std::time::Instant;
use webpc_core::mem::Mem;
use webpc_core::vm::{RAM_BASE, Vm, VmConfig, exit};

const RAM_SIZE: u64 = 256 << 20;
const KERNEL: u64 = RAM_BASE + (2 << 20);
const INITRD: u64 = RAM_BASE + (128 << 20);
const CMDLINE: &str = "console=ttyAMA0 earlycon panic=-1";
const MAX_STEPS: u64 = 20_000_000_000;

#[test]
#[ignore = "needs target/images (images/build.sh) and --release"]
fn linux_boots_and_runs_the_test_script() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/images/linux");
    let read =
        |f: &str| std::fs::read(format!("{dir}/{f}")).unwrap_or_else(|e| panic!("{dir}/{f}: {e}"));
    let (image, initrd) = (read("Image"), read("rootfs.cpio"));

    let mut ram = vec![0u128; RAM_SIZE as usize / 16];
    // SAFETY: ram is 16-byte aligned, RAM_SIZE bytes long, and outlives the Vm.
    let mem = unsafe { Mem::new(ram.as_mut_ptr() as *mut u8, RAM_SIZE) };
    let mut vm = Vm::new(mem, VmConfig::default());
    let load = |vm: &Vm, pa: u64, b: &[u8]| {
        let p = vm
            .mem
            .host(pa, b.len() as u64, webpc_core::mem::Access::Write)
            .unwrap();
        // SAFETY: host() checked the range is guest RAM.
        unsafe { std::ptr::copy_nonoverlapping(b.as_ptr(), p, b.len()) };
    };
    load(&vm, KERNEL, &image);
    load(&vm, INITRD, &initrd);
    vm.boot(KERNEL, Some((INITRD, initrd.len() as u64)), CMDLINE)
        .unwrap();

    let t = Instant::now();
    let mut out = Vec::new();
    let mut steps = 0;
    let kind = loop {
        let kind = vm.run(100_000_000);
        steps += vm.exit.retired;
        let start = out.len();
        while let Some(b) = vm.shared.console.tx.pop() {
            out.push(b);
        }
        eprint!("{}", String::from_utf8_lossy(&out[start..])); // shown with --nocapture
        match kind {
            exit::BUDGET | exit::TX_FULL if steps < MAX_STEPS => {}
            _ => break kind,
        }
    };
    let secs = t.elapsed().as_secs_f64();
    let c = &vm.vcpu.cpu;
    eprintln!(
        "\n[{steps} steps, virtual {:.2} s, {secs:.1} s wall, {:.0} MIPS; exit {kind} value {:#x} pc {:#x}]",
        vm.now() as f64 / 62.5e6,
        steps as f64 / secs / 1e6,
        vm.exit.value,
        c.pc
    );
    let out = String::from_utf8_lossy(&out).replace("\r\n", "\n"); // the tty maps \n to \r\n
    assert_eq!(
        (kind, vm.exit.x[0]),
        (exit::PSCI, 0x8400_0008),
        "no SYSTEM_OFF"
    );
    assert!(
        out.contains("webpc: test ok\n") && out.contains("webpc: test exit 0\n"),
        "test script failed"
    );
    assert!(out.contains("answer: 42\n"));
}
