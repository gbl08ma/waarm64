//! The run loop end to end on small programs; the bare-metal tests
//! (tests/baremetal) cover the devices from real guest code.

use super::*;
use crate::gicv3::{Group, Icc};
use crate::snapshot::{self, Error};

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
fn smccc_says_the_spectre_workarounds_are_not_required() {
    let mut t = T::new(&[HVC; 6], VmConfig::default());
    let mut call = |f: u64, a: u64| {
        (t.cpu().x[0], t.cpu().x[1]) = (f, a);
        t.vm.run(1);
        t.cpu().x[0]
    };
    assert_eq!(call(0x8000_0000, 0), 0x1_0001); // SMCCC_VERSION: 1.1
    for w in [0x8000_8000, 0x8000_7fff, 0x8000_3fff] {
        assert_eq!(call(0x8000_0001, w), -2i64 as u64); // ARCH_FEATURES(ARCH_WORKAROUND_n)
    }
    assert_eq!(call(0x8000_0001, 0x8000_0001), 0);
    assert_eq!(call(0x8000_0001, 0x8000_1234), -1i64 as u64); // an unknown function
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
    // the state of what it waited for.
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

#[test]
fn the_rtc_counts_host_time_in_realtime_mode_only() {
    const LDR_W2_X0: u32 = 0xb940_0002; // ldr w2, [x0]
    const STR_W1_X0_8: u32 = 0xb900_0801; // str w1, [x0, #8] (LR)
    let prog = [LDR_W2_X0, STR_W1_X0_8, 0xb940_0003, B_SELF]; // …, ldr w3, [x0]
    let cfg = VmConfig {
        deterministic: 0,
        rtc: 1_700_000_000_000,
        ..VmConfig::default()
    };
    let mut t = T::new(&prog, cfg);
    (t.cpu().x[0], t.cpu().x[1]) = (RTC, 1000);
    t.vm.run(3);
    let c = &t.vm.vcpus[0].cpu;
    assert_eq!(c.pc, RAM_BASE + 12);
    assert!(
        (1_700_000_000..1_700_000_010).contains(&c.x[2]),
        "{}",
        c.x[2]
    );
    assert!((1000..1010).contains(&c.x[3]), "after the load: {}", c.x[3]);
    // Deterministic: no RTC, so the read is an external abort (the sync vector).
    let cfg = VmConfig {
        rtc: 1_700_000_000_000,
        ..VmConfig::default()
    };
    let mut t = T::new(&prog, cfg);
    t.cpu().x[0] = RTC;
    t.vm.run(2);
    assert_eq!(t.vm.vcpus[0].cpu.pc, VBAR + 0x200);
}

// Snapshots (M8 phase C, `state.rs`).

/// A device with one queue of 8 at slot 0 (IRQ 48).
const DEV: DeviceEntry = DeviceEntry {
    device_id: 4,
    features: 0,
    queues: 1,
    queue_size: 8,
    config_len: 0,
};
const DESC: u64 = RAM_BASE + 0x4000;
const AVAIL: u64 = RAM_BASE + 0x5000;
const USED: u64 = RAM_BASE + 0x6000;
const BUF: u64 = RAM_BASE + 0x8000;

impl T {
    /// The VM's saved state, once the devices are quiet.
    fn save(&mut self) -> Vec<u8> {
        let n = self.vm.snapshot_size();
        assert!(n != 0 && n != u64::MAX, "snapshot_size {n:#x}");
        let s = self.vm.snapshot_save().unwrap();
        assert_eq!(s.len() as u64, n);
        s
    }

    /// A new VM of `cfg` and `devices` on a copy of this one's RAM, restored from `state`.
    fn restore(
        &self,
        state: &[u8],
        cfg: VmConfig,
        devices: &[DeviceEntry],
    ) -> (T, snapshot::Result<()>) {
        let mut ram = self._ram.clone();
        // SAFETY: ram is 16-byte aligned, 1 MiB, and lives as long as the Vm.
        let mem = unsafe { Mem::new(ram.as_mut_ptr() as *mut u8, 1 << 20) };
        let mut vm = Vm::with_devices(mem, cfg, devices);
        let r = vm.snapshot_restore(state);
        (T { _ram: ram, vm }, r)
    }

    /// A register write to transport 0, as a driver's.
    fn dev(&mut self, off: u64, v: u64) {
        let (mem, sh) = (&self.vm.mem, &self.vm.shared.devices[0]);
        let ev = self.vm.plat.get_mut().virtio[0].write(off, 4, v, mem, sh);
        sh.events.fetch_or(ev.unwrap(), Ordering::Relaxed);
    }

    fn tx(&self) -> Vec<u8> {
        core::iter::from_fn(|| self.vm.shared.console.tx.pop()).collect()
    }
}

/// A machine with something of everything: the main loop counts in x5; every
/// 1000 ticks the timer's interrupt prints a `T`, acknowledges the device and
/// moves the timer on. The device has its driver up and two chains offered:
/// the backend answered head 1 and holds head 2.
fn machine() -> T {
    machine_of(VmConfig::default())
}

/// [`machine`] under `cfg` (a run mode).
fn machine_of(cfg: VmConfig) -> T {
    let prog = [
        0x9100_04a5, // add x5, x5, #1
        0x17ff_ffff, // b .-4
    ];
    let handler = [
        0xd538_cc00u32, // mrs x0, icc_iar1_el1
        0xb900_0043,    // str w3, [x2]: the UART's DR
        0xb900_00e6,    // str w6, [x7]: the device's InterruptACK
        0xd53b_e341,    // mrs x1, cntv_cval_el0
        0x910f_a021,    // add x1, x1, #1000
        0xd51b_e341,    // msr cntv_cval_el0, x1
        0xd518_cc20,    // msr icc_eoir1_el1, x0
        0xd69f_03e0,    // eret
    ];
    let mut t = T::with_devices(&prog, cfg, &[DEV]);
    for (k, w) in handler.iter().enumerate() {
        let pa = VBAR + 0x280 + 4 * k as u64;
        t.vm.mem.write(pa, 4, *w as u64).unwrap();
    }
    t.vtimer_at(500);
    let g = &mut t.vm.plat.get_mut().gic;
    g.dist_write(0x84, 4, 1 << 16).unwrap(); // IRQ 48: group 1,
    g.dist_write(0x104, 4, 1 << 16).unwrap(); // enabled
    let c = t.cpu();
    (c.x[2], c.x[3], c.x[6], c.x[7]) = (UART, b'T' as u64, 3, virtio::MMIO_BASE + 0x64);
    c.pstate &= !PSTATE_I;
    // The driver: VERSION_1, queue 0 of 8, DRIVER_OK, two receive buffers.
    t.dev(0x070, 3);
    t.dev(0x024, 1);
    t.dev(0x020, 1);
    t.dev(0x070, 3 | 8);
    t.dev(0x038, 8);
    for (off, pa) in [(0x080, DESC), (0x090, AVAIL), (0x0a0, USED)] {
        t.dev(off, pa);
    }
    t.dev(0x044, 1);
    t.dev(0x070, 3 | 8 | 4);
    for (k, head) in [1u64, 2].into_iter().enumerate() {
        let d = DESC + 16 * head;
        t.vm.mem.write(d, 8, BUF + 0x100 * head).unwrap();
        t.vm.mem.write(d + 8, 4, 64).unwrap();
        t.vm.mem.write(d + 12, 2, 2).unwrap(); // WRITE
        t.vm.mem.write(AVAIL + 4 + 2 * k as u64, 2, head).unwrap();
    }
    t.vm.mem.write(AVAIL + 2, 2, 2).unwrap();
    t.dev(0x050, 0);
    // The backend takes both and answers the first.
    let sh = &t.vm.shared.devices[0];
    assert_eq!(sh.events.swap(0, Ordering::Relaxed), 5);
    let r: Vec<_> = core::iter::from_fn(|| sh.req.pop_request()).collect();
    assert_eq!((r.len(), r[0].w0, r[1].w0), (2, 1, 2));
    assert!(sh.cpl.push(&[1, 7]));
    t.vm.signal(SIGNAL_DEVICE);
    t
}

/// The backend answers the chain it holds (head 2).
fn answer(t: &T) {
    assert!(t.vm.shared.devices[0].cpl.push(&[2, 9]));
    t.vm.signal(SIGNAL_DEVICE);
}

#[test]
fn a_restored_vm_runs_on_as_the_one_that_was_saved() {
    let mut a = machine();
    assert_eq!(a.vm.run(7_777), exit::BUDGET);
    let state = a.save();
    let (mut b, r) = a.restore(&state, VmConfig::default(), &[DEV]);
    assert_eq!(r, Ok(()));
    // The chain the backend held is in the new VM's request ring, for the new backend.
    let sh = &b.vm.shared.devices[0];
    assert_eq!(sh.events.swap(0, Ordering::Relaxed), virtio::EV_REQUEST);
    let r = sh.req.pop_request().unwrap();
    let buf = (BUF + 0x200 - RAM_BASE) as u32;
    assert_eq!((r.w0, r.write, r.read), (2, vec![(buf, 64)], vec![]));
    assert!(sh.req.pop_request().is_none());
    // Saving changed nothing: the restored VM saves the same bytes.
    assert!(b.save() == state, "the restored VM's state differs");
    // Both run on, through timer interrupts and the device's, to the same state.
    // What the host hadn't taken from the console when it saved is in the state.
    let printed = a.tx();
    assert_eq!(printed, b"TTTTTTTT");
    for t in [&mut a, &mut b] {
        assert_eq!(t.vm.run(2_500), exit::BUDGET);
        answer(t);
        assert_eq!(t.vm.run(1_234), exit::BUDGET);
        assert_eq!(t.vm.run(100_000), exit::BUDGET);
    }
    assert_eq!(a.vm.vcpus[0].cpu, b.vm.vcpus[0].cpu);
    assert_eq!((a.vm.steps, a.vm.now()), (b.vm.steps, b.vm.now()));
    assert_eq!(b.vm.steps, 7_777 + 2_500 + 1_234 + 100_000);
    assert_eq!(
        b.vm.shared.cpus[0].counters.retired.load(Ordering::Relaxed),
        b.vm.steps
    );
    assert_eq!(
        String::from_utf8([printed, a.tx()].concat()),
        String::from_utf8(b.tx())
    );
    assert!(a.save() == b.save(), "the states differ after running on");
    assert!(a._ram == b._ram, "RAM differs");
    assert_eq!(a.vm.mem.read(USED + 2, 2), Ok(2), "both chains used");
    // The same from a save at every one of 300 consecutive steps (in the
    // handler, at its ERET, on the WFI-less loop, before and after the device's interrupt).
    let mut a = machine();
    a.vm.run(900);
    for k in 0..300 {
        let state = a.save();
        let (mut b, r) = a.restore(&state, VmConfig::default(), &[DEV]);
        assert_eq!(r, Ok(()), "step {k}");
        let mut c = machine();
        c.vm.run(900 + k);
        for t in [&mut b, &mut c] {
            t.vm.run(2_000);
        }
        assert_eq!(b.vm.vcpus[0].cpu, c.vm.vcpus[0].cpu, "step {k}");
        assert_eq!((b.vm.steps, b.tx()), (c.vm.steps, c.tx()), "step {k}");
        a.vm.run(1);
    }
}

#[test]
fn a_vm_idle_in_wfi_is_saved_waiting() {
    // WFI with the timer armed far ahead: the restored VM jumps to the same deadline.
    let mut a = T::new(&[WFI, NOP, WFI, B_SELF], VmConfig::default());
    a.vtimer_at(1_000_000);
    assert_eq!(a.vm.run(1), exit::BUDGET);
    let state = a.save();
    let (mut b, r) = a.restore(&state, VmConfig::default(), &[]);
    assert_eq!(r, Ok(()));
    for t in [&mut a, &mut b] {
        assert_eq!(t.vm.run(2), exit::BUDGET);
        assert_eq!((t.cpu().pc, t.vm.now()), (RAM_BASE + 12, 1_000_003));
    }
    // Idle with nothing armed: still idle, the PC on the WFI.
    let mut a = T::new(&[NOP, WFI], VmConfig::default());
    assert_eq!(a.vm.run(10), exit::IDLE);
    let state = a.save();
    let (mut b, _) = a.restore(&state, VmConfig::default(), &[]);
    assert_eq!(b.vm.run(10), exit::IDLE);
    assert_eq!((b.cpu().pc, b.vm.steps), (RAM_BASE + 4, 1));
}

#[test]
fn a_state_is_refused_by_another_version_or_machine() {
    let mut a = machine();
    a.vm.run(3_000);
    let state = a.save();
    let cfg = VmConfig::default();
    let restore = |s: &[u8], cfg, devs: &[DeviceEntry]| a.restore(s, cfg, devs).1;
    assert_eq!(restore(&state, cfg, &[DEV]), Ok(()));
    // Not a state, or another version's.
    for bad in [
        &b""[..],
        b"WPC",
        b"WPCS",
        b"XPCS\x01\0\0\0",
        b"WPCS\x02\0\0\0",
    ] {
        assert_eq!(restore(bad, cfg, &[DEV]), Err(Error::Format), "{bad:?}");
    }
    let mut other = state.clone();
    other[4] += 1;
    assert_eq!(restore(&other, cfg, &[DEV]), Err(Error::Format));
    // Another machine: its CPUs, its timer, its mode, its features, its devices.
    let config = Err(Error::Config);
    let c = |f: &dyn Fn(&mut VmConfig)| {
        let mut c = cfg;
        f(&mut c);
        c
    };
    assert_eq!(restore(&state, c(&|c| c.ncpus = 2), &[DEV]), config);
    assert_eq!(
        restore(&state, c(&|c| c.ticks_per_insn = 2), &[DEV]),
        config
    );
    assert_eq!(
        restore(&state, c(&|c| c.cntfrq = 1_000_000), &[DEV]),
        config
    );
    assert_eq!(restore(&state, c(&|c| c.deterministic = 0), &[DEV]), config);
    assert_eq!(restore(&state, c(&|c| c.features = 1), &[DEV]), config);
    assert_eq!(restore(&state, c(&|c| c.fb_width = 1), &[DEV]), config);
    assert_eq!(restore(&state, cfg, &[]), config);
    assert_eq!(restore(&state, cfg, &[DEV, DEV]), config);
    let wider = DeviceEntry {
        queue_size: 16,
        ..DEV
    };
    assert_eq!(restore(&state, cfg, &[wider]), config);
    // The tier is free: the state is the same machine's under the JIT.
    assert_eq!(restore(&state, c(&|c| c.jit = 1), &[DEV]), Ok(()));
}

#[test]
fn no_state_panics_the_core() {
    // A snapshot is a file a user chose. Every prefix is refused; a state with
    // any byte changed is refused or is another machine, which runs without a panic.
    let mut a = machine();
    a.vm.run(3_333);
    let state = a.save();
    let cfg = VmConfig::default();
    for n in 0..state.len() {
        let r = a.restore(&state[..n], cfg, &[DEV]).1;
        let want = if n < 8 { Error::Format } else { Error::Corrupt };
        assert_eq!(r, Err(want), "{n} bytes");
    }
    let mut extra = state.clone();
    extra.push(0);
    assert_eq!(a.restore(&extra, cfg, &[DEV]).1, Err(Error::Corrupt));
    let (mut refused, mut ran) = (0, 0);
    for at in 0..state.len() {
        for flip in [1 << (at % 8), 0xff] {
            let mut s = state.clone();
            s[at] ^= flip;
            let (mut b, r) = a.restore(&s, cfg, &[DEV]);
            if r.is_err() {
                refused += 1;
                continue;
            }
            ran += 1;
            // The new backend takes the chain posted again, and answers it.
            let sh = &b.vm.shared.devices[0];
            sh.events.store(0, Ordering::Relaxed);
            while sh.req.pop_request().is_some() {}
            answer(&b);
            for _ in 0..4 {
                b.vm.run(700);
                b.tx();
            }
            // And it can be saved again, unless the guest it now is has news
            // for the backend or broke its queue.
            let n = b.vm.snapshot_size();
            assert_eq!(
                n != 0 && n != u64::MAX,
                b.vm.snapshot_save().is_some(),
                "byte {at}"
            );
        }
    }
    assert!(refused > 100 && ran > 1000, "{refused} refused, {ran} ran");
}

/// FNV-1a.
fn hash(b: &[u8]) -> u64 {
    b.iter().fold(0xcbf2_9ce4_8422_2325, |h, &b| {
        (h ^ b as u64).wrapping_mul(0x100_0000_01b3)
    })
}

#[test]
fn the_saved_bytes_are_pinned_to_the_version() {
    // The state of a fixed machine, with every part there is: when this fails,
    // a saved field changed. Bump `snapshot::VERSION` (old snapshots are then
    // refused instead of misread), then pin the new bytes here.
    let cfg = VmConfig {
        ncpus: 2,
        firmware: 1,
        flash_size: crate::flash::BLOCK,
        rtc: 1_788_220_800_000,
        ..VmConfig::default()
    };
    let mut t = T::with_devices(&[NOP, WFI], cfg, &[DEV, DEV]);
    t.vm.plat.get_mut().fw_cfg = Some(FwCfg::new(vec![("opt/x".into(), b"y".to_vec())]).unwrap());
    t.vtimer_at(123_456);
    t.vm.shared.console.rx.push(b'k');
    assert_eq!(t.vm.run(5), exit::BUDGET);
    let state = t.save();
    assert_eq!(snapshot::VERSION, 1);
    assert_eq!(
        (state.len(), hash(&state)),
        (266_473, 6_318_216_817_579_332_712),
        "the layout moved"
    );
}

#[test]
fn a_realtime_clock_continues_and_the_rtc_shows_the_hosts_time() {
    const LDR_W2_X0: u32 = 0xb940_0002; // ldr w2, [x0]
    let cfg = VmConfig {
        deterministic: 0,
        rtc: 1_700_000_000_000,
        ..VmConfig::default()
    };
    let mut a = T::new(&[WFI, LDR_W2_X0, B_SELF], cfg);
    a.vtimer_at(a.vm.now() + 62_500_000 / 20); // 50 ms ahead
    a.cpu().x[0] = RTC;
    assert_eq!(a.vm.run(10), exit::IDLE);
    std::thread::sleep(std::time::Duration::from_millis(20));
    let before = a.vm.now();
    let state = a.save();
    // The saved VM's clock is held at the saved reading until it runs on.
    std::thread::sleep(std::time::Duration::from_millis(20));
    let held = a.vm.now();
    assert!(
        held >= before && held - before < 62_500_000 / 100,
        "{before} -> {held}"
    );
    // The file sat for an hour (the new host's clock says so); the VM's own clock
    // starts again from 0 underneath.
    std::thread::sleep(std::time::Duration::from_millis(5));
    let later = VmConfig {
        rtc: cfg.rtc + 3_600_000,
        ..cfg
    };
    let (mut b, r) = a.restore(&state, later, &[]);
    assert_eq!(r, Ok(()));
    // The counter goes on from where it was: no jump back, none forward, and it
    // stands still until a vCPU runs (the host's setup isn't the guest's time).
    let now = b.vm.now();
    assert!(
        now >= before && now - before < 62_500_000 / 100,
        "{before} -> {now}"
    );
    std::thread::sleep(std::time::Duration::from_millis(40));
    assert_eq!(b.vm.now(), now, "the clock moved before the VM ran");
    // The timer is still ~30 ms away: the vCPU idles for that long, then wakes.
    assert_eq!(b.vm.run(10), exit::IDLE);
    let ns = b.vm.exit.value;
    assert!(
        (15_000_000..=30_000_000).contains(&ns),
        "{ns} ns to the deadline"
    );
    std::thread::sleep(std::time::Duration::from_nanos(ns));
    assert_eq!(b.vm.run(2), exit::BUDGET);
    // The RTC reads the new host's time.
    let s = b.cpu().x[2];
    assert!((1_700_003_600..1_700_003_602).contains(&s), "{s}");
    // A realtime state restores under either run mode (one saved form).
    let par = VmConfig { smp: 1, ..later };
    let (c, r) = a.restore(&state, par, &[]);
    assert_eq!(r, Ok(()));
    let now = c.vm.now();
    std::thread::sleep(std::time::Duration::from_millis(20));
    assert_eq!(c.vm.now(), now, "the clock moved before a vCPU ran");
}

/// Parallel mode, realtime, on `ncpus`.
fn par(ncpus: u64) -> VmConfig {
    VmConfig {
        deterministic: 0,
        ncpus,
        smp: 1,
        ..VmConfig::default()
    }
}

#[test]
fn a_parallel_vm_is_saved_with_its_power_states_and_cpu_on_requests() {
    // vCPU 0 asks for vCPU 1 (CPU_ON), then waits; vCPU 1's thread hasn't taken the request.
    const ENTRY: u64 = RAM_BASE + 0x100;
    let mut a = T::new(&[HVC, WFI, B_SELF], par(2));
    for k in 0..4 {
        a.vm.mem.write(ENTRY + 4 * k, 4, NOP as u64).unwrap();
    }
    let c = a.cpu();
    (c.x[0], c.x[1], c.x[2], c.x[3]) = (0xc400_0003, 1, ENTRY, 0x77);
    // SAFETY: this thread is the only one, and runs one vCPU at a time.
    assert_eq!(unsafe { a.vm.run_cpu(0, 10) }, exit::IDLE);
    assert_eq!(
        (a.cpu().x[0], a.cpu().pc),
        (0, RAM_BASE + 4),
        "CPU_ON, then the WFI"
    );
    let state = a.save();
    // In parallel: vCPU 1 is still to start, and does when its thread runs; vCPU 0 waits on.
    let (mut b, r) = a.restore(&state, par(2), &[]);
    assert_eq!(r, Ok(()));
    assert_eq!(b.vm.power(1), Power::On, "on, or starting");
    // SAFETY: as above.
    unsafe {
        assert_eq!(b.vm.run_cpu(0, 10), exit::IDLE);
        assert_eq!(b.vm.run_cpu(1, 2), exit::BUDGET);
    }
    let c1 = &b.vm.vcpus[1].cpu;
    assert_eq!((c1.pc, c1.x[0]), (ENTRY + 8, 0x77));
    assert_eq!(b.cpu().pc, RAM_BASE + 4, "on its WFI");
    assert!(b.save() != state, "vCPU 1 is on now");
    // Round-robin (the same state: realtime saves one form): started within the restore.
    let rr = VmConfig { smp: 0, ..par(2) };
    let (mut c, r) = a.restore(&state, rr, &[]);
    assert_eq!(r, Ok(()));
    assert_eq!(c.vm.power(1), Power::On);
    assert_eq!(c.vm.run(2), exit::BUDGET);
    let c1 = &c.vm.vcpus[1].cpu;
    assert_eq!(
        (c1.pc, c1.x[0], c.vm.vcpus[0].cpu.pc),
        (ENTRY + 8, 0x77, RAM_BASE + 4)
    );
    // And back: a round-robin state with vCPU 0 in WFI and vCPU 1 running, in parallel.
    let state = c.save();
    let (mut d, r) = c.restore(&state, par(2), &[]);
    assert_eq!(r, Ok(()));
    // SAFETY: as above.
    unsafe {
        assert_eq!(d.vm.run_cpu(0, 10), exit::IDLE);
        assert_eq!(d.vm.run_cpu(1, 1), exit::BUDGET);
    }
    assert_eq!(
        (d.cpu().pc, d.vm.vcpus[1].cpu.pc),
        (RAM_BASE + 4, ENTRY + 12)
    );
    // A vCPU that is off stays off.
    let mut a = T::new(&[B_SELF], par(2));
    let state = a.save();
    let (b, _) = a.restore(&state, par(2), &[]);
    assert_eq!((b.vm.power(0), b.vm.power(1)), (Power::On, Power::Off));
    // SAFETY: as above.
    assert_eq!(unsafe { b.vm.run_cpu(1, 10) }, exit::IDLE);
}

#[test]
fn a_restored_parallel_vcpu_has_its_timer_and_interrupt_lines() {
    // The timer fired (IRQs masked): its line is high in the GIC when the VM is saved.
    let mut a = T::new(&[B_SELF], par(1));
    a.vtimer_at(0);
    // SAFETY: this thread is the only one, and runs vCPU 0 only.
    assert_eq!(unsafe { a.vm.run_cpu(0, 10) }, exit::BUDGET);
    assert!(a.vm.plat.get_mut().gic.level(0, IRQ_VTIMER));
    let state = a.save();
    let (mut b, r) = a.restore(&state, par(1), &[]);
    assert_eq!(r, Ok(()));
    assert!(b.vm.plat.get_mut().gic.level(0, IRQ_VTIMER));
    // The guest disables the timer: the restored vCPU knows the line was high, and lowers it.
    b.cpu().cntv_ctl_el0 = 0;
    // SAFETY: as above.
    assert_eq!(unsafe { b.vm.run_cpu(0, 10) }, exit::BUDGET);
    assert!(
        !b.vm.plat.get_mut().gic.level(0, IRQ_VTIMER),
        "the line is stuck high"
    );

    // A device's interrupt raised by the save itself (the completion it took):
    // the restored vCPU's published IRQ line has it, though no timer line changes.
    let mut a = machine_of(par(1));
    // SAFETY: as above.
    unsafe { a.vm.run_cpu(0, 3_000) };
    a.cpu().cntv_ctl_el0 = 0;
    // SAFETY: as above.
    unsafe { a.vm.run_cpu(0, 100) };
    let taken = a.vm.shared.cpus[0].counters.irqs.load(Ordering::Relaxed);
    answer(&a);
    let state = a.save();
    let (b, r) = a.restore(&state, par(1), &[DEV]);
    assert_eq!(r, Ok(()));
    // SAFETY: as above.
    unsafe {
        assert_eq!(a.vm.run_cpu(0, 100), exit::BUDGET);
        assert_eq!(b.vm.run_cpu(0, 100), exit::BUDGET);
    }
    let irqs = |t: &T| t.vm.shared.cpus[0].counters.irqs.load(Ordering::Relaxed);
    assert_eq!(
        (irqs(&a), irqs(&b)),
        (taken + 1, 1),
        "the device's interrupt, in both"
    );
}

const MRS_X0_RNDR: u32 = 0xd53b_2400;
const MRS_X1_RNDRRS: u32 = 0xd53b_2421;
const MRS_X2_ISAR0: u32 = 0xd538_0602;

fn rng(cfg: VmConfig) -> VmConfig {
    VmConfig {
        features: crate::cpu::FEATURE_RNG,
        ..cfg
    }
}

#[test]
fn rndr_reads_the_vcpus_stream_at_el0_and_el1() {
    let prog = [MRS_X0_RNDR, MRS_X1_RNDRRS, MRS_X2_ISAR0];
    // A deterministic VM keys its streams with zeros, whatever the host passed.
    let cfg = rng(VmConfig {
        rng_seed: [1, 2, 3, 4],
        ..VmConfig::default()
    });
    for el0 in [false, true] {
        let mut s = crate::rng::Rng::new([0; 4], 0);
        let mut t = T::new(&prog, cfg);
        if el0 {
            t.cpu().pstate = crate::cpu::M_EL0T;
        }
        t.cpu().nzcv = 0xf000_0000;
        assert_eq!(t.vm.run(2), exit::BUDGET);
        assert_eq!(t.cpu().nzcv, 0, "success: NZCV 0000");
        let (a, b) = (s.draw(), s.draw());
        assert_eq!((t.cpu().x[0], t.cpu().x[1]), (a, b), "EL0 {el0}");
        assert_eq!((t.cpu().pc, t.vm.steps), (RAM_BASE + 8, 2));
        if !el0 {
            t.vm.run(1);
            assert_eq!(t.cpu().x[2] >> 60, 1, "ID_AA64ISAR0_EL1.RNDR");
        }
    }
    // A realtime VM's key is the host's.
    let mut t = T::new(
        &prog,
        VmConfig {
            deterministic: 0,
            ..cfg
        },
    );
    t.vm.run(1);
    assert_eq!(t.cpu().x[0], crate::rng::Rng::new([1, 2, 3, 4], 0).draw());
    // Without FEAT_RNG: UNDEFINED, at EL1 to the current EL's SPx vector, and not advertised.
    let mut t = T::new(&prog, VmConfig::default());
    t.vm.run(1);
    assert_eq!(t.cpu().pc, VBAR + 0x200);
    assert_eq!(t.cpu().esr_el1 >> 26, 0, "EC 0: unknown");
    let mut t = T::new(&[MRS_X2_ISAR0], VmConfig::default());
    t.vm.run(1);
    assert_eq!(t.cpu().x[2] >> 60, 0);
}

#[test]
fn a_restored_vm_goes_on_with_its_rndr_stream() {
    let prog = [MRS_X0_RNDR, MRS_X0_RNDR, MRS_X1_RNDRRS];
    for realtime in [false, true] {
        let cfg = rng(VmConfig {
            deterministic: !realtime as u64,
            rng_seed: [5, 6, 7, 8],
            ..VmConfig::default()
        });
        let mut a = T::new(&prog, cfg);
        a.vm.run(2);
        let state = a.save();
        // Restored under the same key (the same deterministic VM), or a new one.
        let again = VmConfig {
            rng_seed: [9, 9, 9, 9],
            ..cfg
        };
        let (mut b, r) = a.restore(&state, again, &[]);
        assert_eq!(r, Ok(()));
        a.vm.run(1);
        b.vm.run(1);
        let key = if realtime { [9; 4] } else { [0; 4] };
        let mut s = crate::rng::Rng::new(key, 0);
        s.counter = 2;
        assert_eq!(b.cpu().x[1], s.draw(), "realtime {realtime}");
        assert_eq!(a.cpu().x[1] == b.cpu().x[1], !realtime);
        // A VM without FEAT_RNG is another machine.
        let other = VmConfig { features: 0, ..cfg };
        assert_eq!(a.restore(&state, other, &[]).1, Err(Error::Config));
    }
}

#[test]
fn id_aa64mmfr2_says_e0pd_with_the_feature() {
    const MRS_X2_MMFR2: u32 = 0xd538_0742;
    for (features, e0pd) in [(0, 0), (crate::cpu::FEATURE_E0PD, 1)] {
        let mut t = T::new(
            &[MRS_X2_MMFR2],
            VmConfig {
                features,
                ..VmConfig::default()
            },
        );
        t.cpu().x[2] = !0;
        t.vm.run(1);
        assert_eq!(t.cpu().x[2], e0pd << 60);
    }
}
