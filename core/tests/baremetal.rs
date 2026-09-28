//! Runs the bare-metal EL1 tests (`tests/baremetal/*.bin`, built by its
//! `build.sh`) on a whole VM: each boots at 0x4000_0000 in EL1h, prints
//! `exit <code>` on the PL011 and powers off through PSCI SYSTEM_OFF with x1 =
//! the same code, 0 for a pass. A test with `// smp: N` in its source boots N vCPUs.

use webpc_core::mem::Mem;
use webpc_core::vm::{RAM_BASE, Vm, VmConfig, exit};

const RAM_SIZE: usize = 16 << 20;
const BUDGET: u64 = 50_000_000;

/// Boots `image` and returns the SYSTEM_OFF code and the console output, or why it never got there.
fn boot(image: &[u8], ncpus: u64) -> Result<(u64, String), String> {
    let mut ram = vec![0u128; RAM_SIZE / 16];
    // SAFETY: ram is 16-byte aligned, RAM_SIZE bytes long, and outlives the Vm.
    let mem = unsafe { Mem::new(ram.as_mut_ptr() as *mut u8, RAM_SIZE as u64) };
    // The crypto extensions, as the hosts give them by default (M6.5 loop 7).
    let cfg = VmConfig {
        features: webpc_core::cpu::FEATURE_CRYPTO,
        ncpus,
        ..VmConfig::default()
    };
    let mut vm = Vm::new(mem, cfg);
    for (k, b) in image.iter().enumerate() {
        vm.mem.write(RAM_BASE + k as u64, 1, *b as u64).unwrap();
    }
    let mut out = Vec::new();
    let mut left = BUDGET;
    while left > 0 {
        let kind = vm.run(left);
        left -= vm.exit.retired;
        while let Some(b) = vm.shared.console.tx.pop() {
            out.push(b);
        }
        let out = || String::from_utf8_lossy(&out).into_owned();
        match kind {
            exit::BUDGET => break,
            exit::TX_FULL => {}
            exit::PSCI if vm.exit.x[0] == 0x8400_0008 => return Ok((vm.exit.x[1], out())),
            _ => {
                let pcs: Vec<_> = vm
                    .vcpus
                    .iter()
                    .map(|v| format!("{:#x}", v.cpu.pc))
                    .collect();
                return Err(format!(
                    "exit {kind} ({:#x}) on vCPU {}, pcs {pcs:?}; console: {}",
                    vm.exit.value,
                    vm.exit.cpu,
                    out()
                ));
            }
        }
    }
    let c = &vm.vcpus[0].cpu;
    Err(format!(
        "no SYSTEM_OFF after {BUDGET} steps: pc={:#x} esr={:#x} elr={:#x} far={:#x}; console: {}",
        c.pc,
        c.esr_el1,
        c.elr_el1,
        c.far_el1,
        String::from_utf8_lossy(&out)
    ))
}

/// The vCPUs a test asks for in its source (`// smp: N`), 1 without.
fn smp_of(bin: &std::path::Path) -> u64 {
    let src = std::fs::read_to_string(bin.with_extension("c")).unwrap_or_default();
    src.lines()
        .find_map(|l| l.strip_prefix("// smp: ")?.trim().parse().ok())
        .unwrap_or(1)
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
        match boot(&std::fs::read(bin).unwrap(), smp_of(bin)) {
            Ok((code, out)) if !out.ends_with(&format!("exit {code}\n")) => {
                failed.push(format!("{name}: exit {code}, but the console says {out:?}"))
            }
            Ok((0, _)) => eprintln!("pass {name}"),
            Ok((code, out)) => failed.push(format!("{name}: check {code} failed; console: {out}")),
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
    assert_eq!(boot(&image, 1), Ok((5, String::new())));
}
