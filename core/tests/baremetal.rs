//! Runs the bare-metal EL1 tests (`tests/baremetal/*.bin`, built by its
//! `build.sh`) on a whole VM: each boots at 0x4000_0000 in EL1h, prints
//! `exit <code>` on the PL011 and powers off through PSCI SYSTEM_OFF with x1 =
//! the same code, 0 for a pass. A test with `// smp: N` in its source boots N vCPUs;
//! one with `// input: <text>` gets that line on its serial console once it
//! waits (round-robin: at its first idle; parallel: once it printed "ready");
//! one with `// flash` runs in the firmware configuration (M8 phase B: the
//! variable store's flash bank). `baremetal_parallel` runs them all again with a thread per vCPU (parallel
//! SMP, realtime), several times: those runs aren't reproducible; but not one with `// round-robin` (it checks what
//! holds in round-robin only).

mod common;

use webpc_core::mem::Mem;
use webpc_core::vm::{RAM_BASE, Vm, VmConfig, exit};

const RAM_SIZE: usize = 16 << 20;
const BUDGET: u64 = 50_000_000;

/// Boots `image` and returns the SYSTEM_OFF code and the console output, or why it never got there.
fn boot(image: &[u8], ncpus: u64) -> Result<(u64, String), String> {
    boot_mode(image, ncpus, false, None, false, false)
}

/// Steps (of all vCPUs) before the `k`th snapshot of a test that runs through
/// them: close together at first (the tests are short, and set the machine up
/// at their start), then further apart.
fn slice(k: u32) -> u64 {
    (300.0 * 1.3f64.powi(k.min(40) as i32)) as u64
}

/// Saves `vm` (no vCPU is in the core) and puts in its place a new VM
/// restored from the state on a copy of its RAM (M8 phase C).
fn through_snapshot(vm: &mut Vm, ram: &mut Vec<u128>, cfg: VmConfig) {
    let n = vm.snapshot_size();
    assert!(n != 0 && n != u64::MAX, "snapshot_size {n:#x}");
    let state = vm.snapshot_save().unwrap();
    let mut ram2 = ram.clone();
    // SAFETY: ram2 is 16-byte aligned, RAM_SIZE bytes long, and outlives the Vm.
    let mem = unsafe { Mem::new(ram2.as_mut_ptr() as *mut u8, RAM_SIZE as u64) };
    let mut vm2 = Vm::new(mem, cfg);
    vm2.snapshot_restore(&state).expect("a state just saved");
    *vm = vm2;
    *ram = ram2;
    SNAPSHOTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

/// Snapshots taken so far (by every test of the process).
static SNAPSHOTS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// [`boot`], round-robin or `parallel`, in the firmware configuration with
/// `flash`; with `snapshots`, the VM is saved and replaced by one restored
/// from its state every [`slice`] steps.
fn boot_mode(
    image: &[u8],
    ncpus: u64,
    parallel: bool,
    input: Option<&[u8]>,
    flash: bool,
    snapshots: bool,
) -> Result<(u64, String), String> {
    let mut ram = vec![0u128; RAM_SIZE / 16];
    // SAFETY: ram is 16-byte aligned, RAM_SIZE bytes long, and outlives the Vm.
    let mem = unsafe { Mem::new(ram.as_mut_ptr() as *mut u8, RAM_SIZE as u64) };
    // The crypto extensions, as the hosts give them by default (M6.5 loop 7); not FEAT_RNG and
    // FEAT_E0PD, which the hosts also give: `exceptions` checks the ID registers without them.
    let cfg = VmConfig {
        features: webpc_core::cpu::FEATURE_CRYPTO,
        ncpus,
        deterministic: !parallel as u64,
        smp: parallel as u64,
        firmware: flash as u64,
        flash_size: if flash { 1 << 20 } else { 0 },
        rtc: if flash { common::FIRMWARE_EPOCH_MS } else { 0 },
        jit: std::env::var("WEBPC_NATIVE_JIT").map_or(0, |v| v.parse().unwrap()),
        ..VmConfig::default()
    };
    let mut vm = Vm::new(mem, cfg);
    for (k, b) in image.iter().enumerate() {
        vm.mem.write(RAM_BASE + k as u64, 1, *b as u64).unwrap();
    }
    if parallel {
        let limit = std::time::Duration::from_secs(60);
        let mut input = input;
        let (mut console, mut steps, mut k) = (Vec::new(), 0, 0);
        let r = loop {
            // The marker may have shown as the last stretch ended.
            let seen = String::from_utf8_lossy(&console).contains("ready\n");
            let marker = if seen { "" } else { "ready\n" };
            let budget = if snapshots { slice(k) } else { BUDGET * ncpus };
            k += 1;
            let r = common::run_parallel(
                &vm,
                limit,
                budget,
                false,
                &|_| {},
                input.map(|i| (marker, i)),
            );
            console.extend(&r.console);
            steps += r.steps;
            if r.input_given {
                input = None;
            }
            if r.kind == exit::BUDGET && snapshots && steps < BUDGET * ncpus {
                through_snapshot(&mut vm, &mut ram, cfg);
                continue;
            }
            break common::ParallelRun {
                console,
                steps,
                ..r
            };
        };
        let out = String::from_utf8_lossy(&r.console).into_owned();
        let pcs: Vec<_> = vm
            .vcpus
            .iter()
            .map(|v| format!("{:#x}", v.cpu.pc))
            .collect();
        return match (r.kind, r.exit.x[0]) {
            (exit::PSCI, 0x8400_0008) => Ok((r.exit.x[1], out)),
            (k, _) => Err(format!(
                "exit {k} ({:#x}) on vCPU {} after {} steps, pcs {pcs:?}; console: {out}",
                r.exit.value, r.exit.cpu, r.steps
            )),
        };
    }
    let mut out = Vec::new();
    let mut left = BUDGET;
    let mut input = input;
    let mut k = 0;
    while left > 0 {
        let budget = if snapshots { left.min(slice(k)) } else { left };
        k += 1;
        let kind = vm.run(budget);
        left -= vm.exit.retired;
        while let Some(b) = vm.shared.console.tx.pop() {
            out.push(b);
        }
        let out = || String::from_utf8_lossy(&out).into_owned();
        match kind {
            exit::BUDGET if left > 0 => through_snapshot(&mut vm, &mut ram, cfg),
            exit::BUDGET => break,
            exit::TX_FULL => {}
            // Waiting with no deadline: the input, then on.
            exit::IDLE if input.is_some() => {
                for &b in input.take().unwrap() {
                    assert!(vm.shared.console.rx.push(b), "input over the RX ring");
                }
                vm.signal(webpc_core::vm::SIGNAL_RX);
            }
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

/// A test's `// input: <text>` line, with a newline.
fn input_of(bin: &std::path::Path) -> Option<Vec<u8>> {
    let src = std::fs::read_to_string(bin.with_extension("c")).unwrap_or_default();
    src.lines()
        .find_map(|l| l.strip_prefix("// input: "))
        .map(|l| format!("{l}\n").into_bytes())
}

/// Whether a test asks for the firmware configuration's flash bank (`// flash`).
fn flash_of(bin: &std::path::Path) -> bool {
    let src = std::fs::read_to_string(bin.with_extension("c")).unwrap_or_default();
    src.lines().any(|l| l == "// flash")
}

/// The vCPUs a test asks for in its source (`// smp: N`), 1 without.
fn smp_of(bin: &std::path::Path) -> u64 {
    let src = std::fs::read_to_string(bin.with_extension("c")).unwrap_or_default();
    src.lines()
        .find_map(|l| l.strip_prefix("// smp: ")?.trim().parse().ok())
        .unwrap_or(1)
}

/// Whether a test checks what holds in round-robin only (`// round-robin`: an IRQ's latency after an unmask), so
/// `run_all` doesn't run it in parallel SMP.
fn round_robin(bin: &std::path::Path) -> bool {
    let src = std::fs::read_to_string(bin.with_extension("c")).unwrap_or_default();
    src.lines().any(|l| l == "// round-robin")
}

/// Whether a test needs a host-visible window and a host that drives its phases (`// window`: [`window_watch`]).
fn window_of(bin: &std::path::Path) -> bool {
    let src = std::fs::read_to_string(bin.with_extension("c")).unwrap_or_default();
    src.lines().any(|l| l.starts_with("// window"))
}

/// The pages `watch.c` writes in each phase (docs/devices.md "virtio-gpu"): the pages the watch reports at each
/// look must be these exactly.
const WATCH_PHASES: [&[u64]; 7] = [
    &[1, 2, 3],
    &[5],
    &[1],
    &[3, 7, 8],
    &[9, 10],
    &[
        20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42,
        43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65,
        66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88,
        89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99,
    ],
    &[110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120],
];
const WATCH_MAILBOX: u64 = RAM_BASE + (8 << 20);

/// `watch.c` round-robin (the interpreter, and the block interpreter: JIT code itself runs only in wasm,
/// tests/window-watch.test.ts) and in parallel mode, where the vCPU spins on its own thread while the host bumps
/// the generation, waits for its ack and looks.
#[test]
fn window_watch() {
    let image = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/baremetal/watch.bin"
    ))
    .unwrap();
    for (jit, parallel) in [(0, false), (4, false), (0, true), (4, true)] {
        // The window in memory 1, past 64 KiB of the renderer's (docs/devices.md "The host-visible window").
        let (window, window_at) = (2u64 << 20, 1u64 << 16);
        let mut ram = vec![0u128; RAM_SIZE / 16];
        let mut mem1 = vec![0u128; (window_at + window) as usize / 16];
        // SAFETY: both are 16-byte aligned, as long as RAM and memory 1, and outlive the Vm.
        let mem = unsafe {
            Mem::new(ram.as_mut_ptr() as *mut u8, RAM_SIZE as u64).with_window(
                webpc_core::mem::Spill {
                    phys: RAM_BASE + RAM_SIZE as u64,
                    size: window,
                    off: window_at,
                    base: mem1.as_mut_ptr() as *mut u8,
                },
            )
        };
        let cfg = VmConfig {
            ram_size: RAM_SIZE as u64,
            window,
            window_at,
            jit,
            deterministic: !parallel as u64,
            smp: parallel as u64,
            ..VmConfig::default()
        };
        let mut vm = Vm::new(mem, cfg);
        for (k, b) in image.iter().enumerate() {
            vm.mem.write(RAM_BASE + k as u64, 1, *b as u64).unwrap();
        }
        let look = |vm: &Vm, n: usize, waits: bool| {
            let w = vm.mem.watch().unwrap();
            let g = w.bump();
            let t0 = std::time::Instant::now();
            while waits && w.acked(0) != g {
                assert!(
                    t0.elapsed().as_secs() < 10,
                    "jit {jit}: the vCPU never acked"
                );
                std::thread::yield_now();
            }
            assert_eq!(
                w.take(),
                WATCH_PHASES[n - 1],
                "jit {jit} parallel {parallel}: phase {n}"
            );
            vm.mem.write(WATCH_MAILBOX + 8, 8, n as u64).unwrap();
        };
        if parallel {
            std::thread::scope(|s| {
                let vm = &vm;
                let guest = s.spawn(move || {
                    loop {
                        // SAFETY: only this thread runs vCPU 0, the VM outlives it.
                        let kind = unsafe { vm.run_cpu(0, 1 << 20) };
                        if kind != exit::BUDGET && kind != exit::IDLE {
                            return (kind, vm.vcpus[0].cpu.x[1]);
                        }
                    }
                });
                for n in 1..=WATCH_PHASES.len() {
                    let t0 = std::time::Instant::now();
                    while vm.mem.read(WATCH_MAILBOX, 8) != Ok(n as u64) {
                        assert!(
                            t0.elapsed().as_secs() < 30,
                            "jit {jit}: phase {n} never came"
                        );
                        std::thread::yield_now();
                    }
                    look(vm, n, true);
                }
                assert_eq!(
                    guest.join().unwrap(),
                    (exit::PSCI, 0),
                    "jit {jit}: watch.c's checks"
                );
            });
        } else {
            let mut n = 1;
            let kind = loop {
                let kind = vm.run(100_000);
                if kind != exit::BUDGET {
                    break kind;
                }
                if vm.mem.read(WATCH_MAILBOX, 8) == Ok(n as u64) {
                    look(&vm, n, false);
                    n += 1;
                }
            };
            assert_eq!(
                (kind, vm.exit.x[1], n),
                (exit::PSCI, 0, WATCH_PHASES.len() + 1),
                "jit {jit}"
            );
        }
    }
}

#[test]
fn baremetal() {
    run_all(false, 1, false);
}

/// Every test again with the VM saved and restored into a new one every
/// [`slice`] steps (M8 phase C): round-robin, where the guest can't tell, and
/// in parallel (`WEBPC_PARALLEL_RUNS` times, default 2).
#[test]
fn baremetal_through_snapshots() {
    run_all(false, 1, true);
}

#[test]
fn baremetal_parallel_through_snapshots() {
    let runs = std::env::var("WEBPC_PARALLEL_RUNS").map_or(2, |v| v.parse().unwrap());
    run_all(true, runs, true);
}

/// Every test in parallel SMP (a thread per vCPU), `WEBPC_PARALLEL_RUNS`
/// times (default 5).
#[test]
fn baremetal_parallel() {
    let runs = std::env::var("WEBPC_PARALLEL_RUNS").map_or(5, |v| v.parse().unwrap());
    run_all(true, runs, false);
}

fn run_all(parallel: bool, runs: usize, snapshots: bool) {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/baremetal");
    let mut bins: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.extension().is_some_and(|x| x == "bin")
                && !window_of(p)
                && !(parallel && round_robin(p))
        })
        .collect();
    bins.sort();
    assert!(!bins.is_empty(), "no tests in {dir}");
    let mut failed = Vec::new();
    for bin in bins.iter().flat_map(|b| std::iter::repeat_n(b, runs)) {
        let name = bin.file_stem().unwrap().to_string_lossy();
        let input = input_of(bin);
        match boot_mode(
            &std::fs::read(bin).unwrap(),
            smp_of(bin),
            parallel,
            input.as_deref(),
            flash_of(bin),
            snapshots,
        ) {
            Ok((code, out)) if !out.ends_with(&format!("exit {code}\n")) => {
                failed.push(format!("{name}: exit {code}, but the console says {out:?}"))
            }
            Ok((0, _)) => eprintln!(
                "pass {name} ({} snapshots so far)",
                SNAPSHOTS.load(std::sync::atomic::Ordering::Relaxed)
            ),
            Ok((code, out)) => failed.push(format!("{name}: check {code} failed; console: {out}")),
            Err(e) => failed.push(format!("{name}: {e}")),
        }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}

/// tests/baremetal/review/run.sh: what the review's candidates do here.
#[test]
#[ignore]
fn review_observations() {
    let image = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/baremetal/review/review.bin"
    ))
    .unwrap();
    let text = match boot(&image, 1) {
        Ok((_, out)) => out,
        Err(e) => e,
    };
    std::fs::write(std::env::var("REVIEW_OUT").unwrap(), text).unwrap();
}

/// The runner itself: a failing check must surface as its code.
#[test]
fn reports_failure_codes() {
    // mov x1, #5; movz x0, #0x8400, lsl #16; movk x0, #8; hvc #0
    let prog: [u32; 4] = [0xd28000a1, 0xd2b08000, 0xf2800100, 0xd4000002];
    let image: Vec<u8> = prog.iter().flat_map(|w| w.to_le_bytes()).collect();
    assert_eq!(boot(&image, 1), Ok((5, String::new())));
}
