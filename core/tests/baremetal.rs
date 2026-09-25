//! Runs the bare-metal EL1 tests (`tests/baremetal/*.bin`, built by its
//! `build.sh`): each boots at 0x4000_0000 in EL1h and must power off through
//! PSCI SYSTEM_OFF with x1 = 0.

use webpc_core::cpu::Cpu;
use webpc_core::interp::{Exit, run_system};
use webpc_core::mem::Mem;
use webpc_core::mmu::Vcpu;

const RAM_BASE: u64 = 0x4000_0000;
const RAM_SIZE: usize = 16 << 20;
const BUDGET: u64 = 50_000_000;

const PSCI_VERSION: u64 = 0x8400_0000;
const PSCI_SYSTEM_OFF: u64 = 0x8400_0008;
const PSCI_NOT_SUPPORTED: u64 = -1i64 as u64;

/// Boots `image` and returns the SYSTEM_OFF code, or why it never got there.
fn boot(image: &[u8]) -> Result<u64, String> {
    let mut ram = vec![0u128; RAM_SIZE / 16];
    // SAFETY: ram is 16-byte aligned, RAM_SIZE bytes long, and outlives mem.
    let mem = unsafe { Mem::new(ram.as_mut_ptr() as *mut u8, RAM_SIZE as u64) }.at(RAM_BASE);
    for (k, b) in image.iter().enumerate() {
        mem.write(RAM_BASE + k as u64, 1, *b as u64).unwrap();
    }
    let mut v = Vcpu::new(Cpu {
        pc: RAM_BASE,
        ..Cpu::reset()
    });
    let mut left = BUDGET;
    while left > 0 {
        let (done, r) = run_system(&mut v, &mem, left);
        left -= done;
        match r {
            Ok(()) => break,
            // ponytail: the minimal PSCI a test needs; step 4 brings the real one.
            Err(Exit::Hvc(_)) => match v.cpu.x[0] {
                PSCI_SYSTEM_OFF => return Ok(v.cpu.x[1]),
                PSCI_VERSION => v.cpu.x[0] = 1 << 16, // 1.0
                _ => v.cpu.x[0] = PSCI_NOT_SUPPORTED,
            },
            Err(e) => return Err(format!("{e:?} at pc={:#x}", v.cpu.pc)),
        }
    }
    let c = &v.cpu;
    Err(format!(
        "no SYSTEM_OFF after {BUDGET} steps: pc={:#x} esr={:#x} elr={:#x} far={:#x}",
        c.pc, c.esr_el1, c.elr_el1, c.far_el1
    ))
}

#[test]
fn baremetal() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/baremetal");
    let mut bins: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "bin"))
        .collect();
    bins.sort();
    assert!(!bins.is_empty(), "no tests in {dir}");
    let mut failed = Vec::new();
    for bin in &bins {
        let name = bin.file_stem().unwrap().to_string_lossy();
        match boot(&std::fs::read(bin).unwrap()) {
            Ok(0) => eprintln!("pass {name}"),
            Ok(code) => failed.push(format!("{name}: check {code} failed")),
            Err(e) => failed.push(format!("{name}: {e}")),
        }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}

/// The runner itself: a failing check must surface as its code.
#[test]
fn reports_failure_codes() {
    // mov x1, #5; movz x0, #0x8400, lsl #16; movk x0, #8; hvc #0
    let prog: [u32; 4] = [0xd28000a1, 0xd2b08000, 0xf2800100, 0xd4000002];
    let image: Vec<u8> = prog.iter().flat_map(|w| w.to_le_bytes()).collect();
    assert_eq!(boot(&image), Ok(5));
}
