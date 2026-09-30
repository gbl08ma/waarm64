//! The run loop end to end on small programs; the bare-metal tests
//! (tests/baremetal) cover the devices from real guest code.

use super::*;
use crate::gicv3::{Group, Icc};

const B_SELF: u32 = 0x1400_0000; // b .
const WFI: u32 = 0xd503_207f;
const NOP: u32 = 0xd503_201f;
const HVC: u32 = 0xd400_0002; // hvc #0
const STR_W1_X0: u32 = 0xb900_0001; // str w1, [x0]
const VBAR: u64 = RAM_BASE + 0x1000;

struct T {
    _ram: Vec<u128>,
    vm: Vm,
}

impl T {
    fn new(prog: &[u32], cfg: VmConfig) -> T {
        T::with_devices(prog, cfg, &[])
    }

    fn with_devices(prog: &[u32], cfg: VmConfig, devices: &[DeviceEntry]) -> T {
        let mut ram = vec![0u128; 1 << 16];
        // SAFETY: ram is 16-byte aligned, 1 MiB, and lives as long as the Vm.
        let mem = unsafe { Mem::new(ram.as_mut_ptr() as *mut u8, 1 << 20) };
        let mut vm = Vm::with_devices(mem, cfg, devices);
        for (k, w) in prog.iter().enumerate() {
            vm.mem.write(RAM_BASE + 4 * k as u64, 4, *w as u64).unwrap();
        }
        // Every vector spins, so where the PC ends up says what was taken.
        for k in 0..16 {
            vm.mem.write(VBAR + 0x80 * k, 4, B_SELF as u64).unwrap();
        }
        vm.vcpus[0].cpu.vbar_el1 = VBAR;
        T { _ram: ram, vm }
    }

    fn cpu(&mut self) -> &mut Cpu {
        &mut self.vm.vcpus[0].cpu
    }

    /// The GIC on (group 1, CPU 0's redistributor awake, the CPU interface
    /// open) with the virtual timer PPI enabled.
    fn gic_on(&mut self) {
        let g = &mut self.vm.plat.get_mut().gic;
        g.dist_write(0, 4, 2).unwrap();
        g.redist_write(0x14, 4, 0).unwrap();
        g.redist_write(0x1_0080, 4, !0).unwrap();
        g.redist_write(0x1_0100, 4, 1 << IRQ_VTIMER).unwrap();
        g.icc(0, Icc::Igrpen(Group::G1), Some(1));
        g.icc(0, Icc::Pmr, Some(0xff));
    }

    /// [`T::gic_on`], and the timer armed at `cval`.
    fn vtimer_at(&mut self, cval: u64) {
        self.gic_on();
        (self.cpu().cntv_ctl_el0, self.cpu().cntv_cval_el0) = (1, cval);
    }
}

#[test]
fn psci_in_the_core_and_system_off() {
    let mut t = T::new(&[HVC, HVC, HVC, HVC, HVC, HVC, HVC], VmConfig::default());
    t.cpu().x[0] = 0x8400_0000; // PSCI_VERSION
    assert_eq!(t.vm.run(1), exit::BUDGET);
    assert_eq!(t.cpu().x[0], 1 << 16);
    (t.cpu().x[0], t.cpu().x[1]) = (0x8400_000a, 0xc400_0003); // FEATURES(CPU_ON)
    t.vm.run(1);
    assert_eq!(t.cpu().x[0], 0);
    (t.cpu().x[0], t.cpu().x[1]) = (0x8400_000a, 0x8400_0001); // FEATURES(CPU_SUSPEND)
    t.vm.run(1);
    assert_eq!(t.cpu().x[0], u64::MAX);
    (t.cpu().x[0], t.cpu().x[1]) = (0xc400_0003, 1); // CPU_ON(1): there's no CPU 1
    t.vm.run(1);
    assert_eq!(t.cpu().x[0], -2i64 as u64);
    (t.cpu().x[0], t.cpu().x[1]) = (0xc400_0003, 0); // CPU_ON(0): itself
    t.vm.run(1);
    assert_eq!(t.cpu().x[0], -4i64 as u64);
    (t.cpu().x[0], t.cpu().x[1]) = (0xc400_0004, 0); // AFFINITY_INFO(0)
    t.vm.run(1);
    assert_eq!(t.cpu().x[0], 0);
    (t.cpu().x[0], t.cpu().x[1]) = (0x8400_0008, 7); // SYSTEM_OFF
    assert_eq!(t.vm.run(100), exit::PSCI);
    assert_eq!(t.vm.exit.x[..2], [0x8400_0008, 7]);
    assert_eq!((t.vm.exit.retired, t.cpu().pc), (1, RAM_BASE + 28));
}

#[test]
fn uart_tx_through_io_and_full_ring() {
    let mut t = T::new(&[STR_W1_X0, B_SELF], VmConfig::default());
    (t.cpu().x[0], t.cpu().x[1]) = (UART, b'A' as u64);
    assert_eq!(t.vm.run(2), exit::BUDGET);
    let tx = &t.vm.shared.console.tx;
    assert_eq!((tx.pop(), t.vm.vcpus[0].cpu.pc), (Some(b'A'), RAM_BASE + 4));
    // With the ring full, the store waits for the host.
    t.cpu().pc = RAM_BASE;
    for _ in 0..crate::pl011::RING {
        t.vm.shared.console.tx.push(0);
    }
    assert_eq!(t.vm.run(10), exit::TX_FULL);
    assert_eq!((t.vm.exit.retired, t.vm.vcpus[0].cpu.pc), (0, RAM_BASE));
    t.vm.shared.console.tx.pop();
    t.vm.run(1);
    assert_eq!(t.vm.vcpus[0].cpu.pc, RAM_BASE + 4);
}

#[test]
fn unmapped_pa_is_still_an_external_abort() {
    let mut t = T::new(&[STR_W1_X0], VmConfig::default());
    t.cpu().x[0] = 0x0b00_0000;
    t.vm.run(1);
    let c = t.cpu();
    assert_eq!(
        (c.pc, c.esr_el1, c.far_el1),
        (VBAR + 0x200, 0x9600_0050, 0x0b00_0000)
    );
    assert_eq!(
        t.vm.shared.cpus[0].counters.exceptions[0x25].load(Ordering::Relaxed),
        1
    );
}

#[test]
fn timer_irq_fires_on_its_tick() {
    let cfg = VmConfig {
        ticks_per_insn: 3,
        ..VmConfig::default()
    };
    let mut t = T::new(&[B_SELF], cfg);
    t.vtimer_at(300);
    t.cpu().pstate &= !PSTATE_I;
    assert_eq!(t.vm.run(10_000), exit::BUDGET);
    let c = &t.vm.vcpus[0].cpu;
    // Taken after 100 steps (tick 300), from EL1h, before the branch.
    assert_eq!((c.pc, c.elr_el1), (VBAR + 0x280, RAM_BASE));
    assert_eq!(t.vm.shared.cpus[0].counters.irqs.load(Ordering::Relaxed), 1);
    assert_eq!(t.vm.now(), 3 * 10_000);
    let iar = t.vm.plat.get_mut().gic.icc(0, Icc::Iar(Group::G1), None);
    assert_eq!(iar, IRQ_VTIMER as u64);
}

#[test]
fn wfi_jumps_to_the_deadline_or_idles() {
    // IRQs masked: WFI still wakes, and the handler isn't entered.
    let mut t = T::new(&[WFI, NOP, WFI], VmConfig::default());
    t.vtimer_at(1_000_000);
    assert_eq!(t.vm.run(2), exit::BUDGET);
    assert_eq!(t.vm.vcpus[0].cpu.pc, RAM_BASE + 8);
    assert_eq!(t.vm.now(), 1_000_002);
    // The timer has fired and the GIC signals it, so the next WFI completes at once.
    assert_eq!(t.vm.run(1), exit::BUDGET);
    // Nothing armed: idle, PC on the WFI.
    let mut t = T::new(&[WFI], VmConfig::default());
    assert_eq!(t.vm.run(10), exit::IDLE);
    assert_eq!(
        (t.vm.vcpus[0].cpu.pc, t.vm.exit.value),
        (RAM_BASE, u64::MAX)
    );
}

#[test]
fn counter_and_timer_registers() {
    let prog = [
        NOP,
        NOP,
        0xd53b_e040, // mrs x0, cntvct_el0
        0xd51b_e321, // msr cntv_ctl_el0, x1
        0xd53b_e300, // mrs x0, cntv_tval_el0
        0xd538_c103, // mrs x3, isr_el1
    ];
    let mut t = T::new(&prog, VmConfig::default());
    t.gic_on();
    t.cpu().x[1] = 1;
    t.cpu().cntv_cval_el0 = 3;
    t.vm.run(3);
    assert_eq!(t.cpu().x[0], 2, "counter at the third instruction");
    t.vm.run(2);
    assert_eq!(
        t.cpu().x[0],
        3u64.wrapping_sub(4) as u32 as u64,
        "TVAL = CVAL - count"
    );
    t.vm.run(1);
    assert_eq!(t.cpu().x[3], 0x80, "ISR_EL1.I: the timer fired");
}

#[test]
fn stop_signal() {
    let mut t = T::new(&[B_SELF], VmConfig::default());
    t.vm.shared.signal.fetch_or(SIGNAL_STOP, Ordering::Relaxed);
    assert_eq!(t.vm.run(10), exit::STOP);
    assert_eq!(t.vm.run(10), exit::BUDGET, "a stop is consumed");
}

#[test]
fn virtio_register_write_exits_to_the_host() {
    let rng = DeviceEntry {
        device_id: 4,
        queues: 1,
        queue_size: 8,
        ..DeviceEntry::default()
    };
    let mut t = T::with_devices(&[STR_W1_X0, STR_W1_X0, B_SELF], VmConfig::default(), &[rng]);
    (t.cpu().x[0], t.cpu().x[1]) = (virtio::MMIO_BASE + 0x70, 0); // Status = 0: reset
    assert_eq!(t.vm.run(10), exit::DEVICE);
    assert_eq!(
        (t.vm.exit.retired, t.vm.exit.value),
        (1, (virtio::EV_STATUS as u64) << 8)
    );
    assert_eq!(
        (
            t.cpu().pc,
            t.vm.shared.devices[0].events.swap(0, Ordering::Relaxed)
        ),
        (RAM_BASE + 4, virtio::EV_STATUS)
    );
    // A completion signal with nothing to complete runs on.
    t.vm.shared
        .signal
        .fetch_or(SIGNAL_DEVICE, Ordering::Relaxed);
    t.cpu().x[0] = virtio::MMIO_BASE + 0x200; // slot 1: no device
    assert_eq!(t.vm.run(1), exit::BUDGET);
    assert_eq!(t.vm.shared.signal.load(Ordering::Relaxed), 0);
    assert_eq!(
        (t.cpu().pc, t.cpu().far_el1),
        (VBAR + 0x200, virtio::MMIO_BASE + 0x200),
        "external abort"
    );
}

#[test]
fn realtime_wfi_idles_until_the_deadline() {
    let cfg = VmConfig {
        deterministic: 0,
        ..VmConfig::default()
    };
    let mut t = T::new(&[WFI, B_SELF], cfg);
    let cval = t.vm.now() + 125_000; // 2 ms at 62.5 MHz
    t.vtimer_at(cval);
    assert_eq!(t.vm.run(10), exit::IDLE);
    let ns = t.vm.exit.value;
    assert!(ns > 0 && ns <= 2_000_000, "{ns} ns to the deadline");
    assert_eq!(t.cpu().pc, RAM_BASE, "on the WFI");
    std::thread::sleep(std::time::Duration::from_nanos(ns));
    assert!(t.vm.now() >= cval);
    t.vm.run(1);
    assert_eq!(t.cpu().pc, RAM_BASE + 4, "the timer woke it (IRQs masked)");
}

#[test]
fn a_timer_is_pending_or_a_deadline_at_one_instant() {
    // WFI decides from one counter reading (M6.5: in realtime mode a timer
    // due between two readings was neither, and the host slept for good).
    let mut t = T::new(&[B_SELF], VmConfig::default());
    t.vtimer_at(1000);
    for now in [998, 999, 1000, 1001] {
        t.vm.lines_at(now);
        let (pending, deadline) = (t.vm.plat.get_mut().gic.irq(0), t.vm.next_deadline_at(now));
        assert!(
            pending != deadline.is_some(),
            "now {now}: pending {pending}, deadline {deadline:?}"
        );
    }
}

#[test]
#[should_panic(expected = "vCPU 1: state 1 applied 0 waited-for 1 queued 1")]
fn a_dsb_timeout_reports_the_vcpu_it_waited_for() {
    // vCPU 0: TLBI VMALLE1IS; DSB ISH. vCPU 1 is marked running and never
    // drains, as if stuck in one chunk: the wait times out and panics with
    // the state of what it waited for (BUG1-HANDOVER.md).
    const TLBI_VMALLE1IS: u32 = 0xd508_831f;
    const DSB_ISH: u32 = 0xd503_3b9f;
    let cfg = VmConfig {
        ncpus: 2,
        smp: 1,
        ..VmConfig::default()
    };
    let mut t = T::new(&[TLBI_VMALLE1IS, DSB_ISH, B_SELF], cfg);
    t.vm.dsb_limit_ns = 20_000_000;
    t.vm.shared.cpus[1].par.state.store(1, Ordering::SeqCst);
    // SAFETY: this thread is the only one, and runs vCPU 0 only.
    unsafe { t.vm.run_cpu(0, 1000) };
}

#[test]
fn a_dsb_budget_counts_waiting_not_the_waiters_own_stalls() {
    use super::parallel::DsbBudget;
    const MS: u64 = 1_000_000;
    // 10 s of 1 ms passes: a deadlock, the wait gives up right at the limit.
    let mut b = DsbBudget::new(10_000 * MS, 100 * MS);
    let mut passes = 0;
    while !b.pass(MS) {
        passes += 1;
    }
    assert_eq!(passes, 9_999);
    // A waiter whose own thread stalled for 15 s in the middle of a wait: the
    // pass counts nothing, the wait carries on and can still end normally...
    let mut b = DsbBudget::new(10_000 * MS, 100 * MS);
    for _ in 0..500 {
        assert!(!b.pass(MS));
    }
    assert!(
        !b.pass(15_000 * MS),
        "a 15 s stalled pass is not 15 s of waiting"
    );
    assert!(
        b.line().contains("waiter: 500 ms waiting of 15500 ms wall"),
        "{}",
        b.line()
    );
    assert!(
        b.line().contains("15000 ms, longest pass 15000 ms"),
        "{}",
        b.line()
    );
    // ...and a deadlock behind it still ends after the rest of the limit.
    let mut more = 0;
    while !b.pass(MS) {
        more += 1;
    }
    assert_eq!(more, 9_499);
    // Always stalled (every pass over the bound): the wall-time backstop, 10 limits.
    let mut b = DsbBudget::new(10_000 * MS, 100 * MS);
    let mut n = 0;
    while !b.pass(200 * MS) {
        n += 1;
    }
    assert_eq!(n, 499); // 500 passes of 200 ms = 100 s
}

#[test]
#[should_panic(expected = "waiter: 0 ms waiting of")]
fn a_dsb_wait_of_stalled_passes_ends_at_the_wall_backstop_with_a_note() {
    // Every pass counts as a stall of the waiter's own thread (the bound is 1 ns),
    // so nothing counts as waiting: it ends at 10 limits of wall time, and says so.
    let cfg = VmConfig {
        ncpus: 2,
        smp: 1,
        ..VmConfig::default()
    };
    let mut t = T::new(&[0xd508_831f, 0xd503_3b9f, B_SELF], cfg);
    t.vm.dsb_limit_ns = 5_000_000;
    t.vm.dsb_pass_max_ns = 1;
    t.vm.shared.cpus[1].par.state.store(1, Ordering::SeqCst);
    // SAFETY: this thread is the only one, and runs vCPU 0 only.
    unsafe { t.vm.run_cpu(0, 1000) };
}
