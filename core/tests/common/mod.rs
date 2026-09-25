//! Shared by the guest-image runners (boot.rs, kvm_unit_tests.rs): boot a
//! kernel on a whole VM and run it until it powers off.

use std::time::Instant;
use webpc_core::mem::{Access, Mem};
use webpc_core::vm::{RAM_BASE, Vm, VmConfig, exit};

pub const RAM_SIZE: u64 = 256 << 20;
/// Where the runners put the kernel and initrd (web/vm.ts does the same).
const KERNEL: u64 = RAM_BASE + (2 << 20);
const INITRD: u64 = RAM_BASE + (128 << 20);

pub fn image(rel: &str) -> Vec<u8> {
    let path = format!("{}/../target/images/{rel}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e} (run images/build.sh)"))
}

pub struct Run {
    /// The exit kind that ended it, and ExitInfo.x0 (the PSCI function for a PSCI exit).
    pub kind: u32,
    pub x0: u64,
    /// Console output with the tty's \r\n turned back into \n.
    pub console: String,
    pub summary: String,
}

impl Run {
    pub fn powered_off(&self) -> bool {
        (self.kind, self.x0) == (exit::PSCI, 0x8400_0008)
    }
}

/// Boots `kernel` (and `initrd`) with `cmdline` and runs up to `max_steps`.
/// With `echo`, the console goes to stderr as it comes (seen with --nocapture).
pub fn boot(
    kernel: &[u8],
    initrd: Option<&[u8]>,
    cmdline: &str,
    max_steps: u64,
    echo: bool,
) -> Run {
    let mut ram = vec![0u128; RAM_SIZE as usize / 16];
    // SAFETY: ram is 16-byte aligned, RAM_SIZE bytes long, and outlives the Vm.
    let mem = unsafe { Mem::new(ram.as_mut_ptr() as *mut u8, RAM_SIZE) };
    let mut vm = Vm::new(mem, VmConfig::default());
    let load = |vm: &Vm, pa: u64, b: &[u8]| {
        let p = vm.mem.host(pa, b.len() as u64, Access::Write).unwrap();
        // SAFETY: host() checked the range is guest RAM.
        unsafe { std::ptr::copy_nonoverlapping(b.as_ptr(), p, b.len()) };
    };
    load(&vm, KERNEL, kernel);
    if let Some(rd) = initrd {
        load(&vm, INITRD, rd);
    }
    vm.boot(KERNEL, initrd.map(|rd| (INITRD, rd.len() as u64)), cmdline)
        .unwrap();

    let t = Instant::now();
    let (mut out, mut steps) = (Vec::new(), 0);
    let kind = loop {
        let kind = vm.run(100_000_000);
        steps += vm.exit.retired;
        let start = out.len();
        while let Some(b) = vm.shared.console.tx.pop() {
            out.push(b);
        }
        if echo {
            eprint!("{}", String::from_utf8_lossy(&out[start..]));
        }
        match kind {
            exit::BUDGET | exit::TX_FULL if steps < max_steps => {}
            _ => break kind,
        }
    };
    let secs = t.elapsed().as_secs_f64();
    Run {
        kind,
        x0: vm.exit.x[0],
        console: String::from_utf8_lossy(&out).replace("\r\n", "\n"),
        summary: format!(
            "{steps} steps, virtual {:.2} s, {secs:.1} s wall, {:.0} MIPS; exit {kind} value {:#x} pc {:#x}",
            vm.now() as f64 / 62.5e6,
            steps as f64 / secs / 1e6,
            vm.exit.value,
            vm.vcpu.cpu.pc
        ),
    }
}
