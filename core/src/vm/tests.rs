//! The run loop end to end on small programs; the bare-metal tests
//! (tests/baremetal) cover the devices from real guest code.

use super::*;

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
        vm.vcpu.cpu.vbar_el1 = VBAR;
        T { _ram: ram, vm }
    }

    fn cpu(&mut self) -> &mut Cpu {
        &mut self.vm.vcpu.cpu
    }

    /// GIC on with the virtual timer PPI enabled, and the timer armed at `cval`.
    fn vtimer_at(&mut self, cval: u64) {
        let g = &mut self.vm.gic;
        g.dist_write(0, 4, 1).unwrap();
        g.dist_write(0x100, 4, 1 << IRQ_VTIMER).unwrap();
        g.cpu_write(0, 4, 1).unwrap();
        g.cpu_write(4, 4, 0xff).unwrap();
        (self.cpu().cntv_ctl_el0, self.cpu().cntv_cval_el0) = (1, cval);
    }
}

#[test]
fn psci_in_the_core_and_system_off() {
    let mut t = T::new(&[HVC, HVC, HVC, HVC], VmConfig::default());
    t.cpu().x[0] = 0x8400_0000; // PSCI_VERSION
    assert_eq!(t.vm.run(1), exit::BUDGET);
    assert_eq!(t.cpu().x[0], 1 << 16);
    (t.cpu().x[0], t.cpu().x[1]) = (0x8400_000a, 0xc400_0003); // FEATURES(CPU_ON)
    t.vm.run(1);
    assert_eq!(t.cpu().x[0], u64::MAX);
    (t.cpu().x[0], t.cpu().x[1]) = (0xc400_0004, 0); // AFFINITY_INFO(0)
    t.vm.run(1);
    assert_eq!(t.cpu().x[0], 0);
    (t.cpu().x[0], t.cpu().x[1]) = (0x8400_0008, 7); // SYSTEM_OFF
    assert_eq!(t.vm.run(100), exit::PSCI);
    assert_eq!(t.vm.exit.x[..2], [0x8400_0008, 7]);
    assert_eq!((t.vm.exit.retired, t.cpu().pc), (1, RAM_BASE + 16));
}

#[test]
fn uart_tx_through_io_and_full_ring() {
    let mut t = T::new(&[STR_W1_X0, B_SELF], VmConfig::default());
    (t.cpu().x[0], t.cpu().x[1]) = (UART, b'A' as u64);
    assert_eq!(t.vm.run(2), exit::BUDGET);
    let tx = &t.vm.shared.console.tx;
    assert_eq!((tx.pop(), t.vm.vcpu.cpu.pc), (Some(b'A'), RAM_BASE + 4));
    // With the ring full, the store waits for the host.
    t.cpu().pc = RAM_BASE;
    for _ in 0..crate::pl011::RING {
        t.vm.shared.console.tx.push(0);
    }
    assert_eq!(t.vm.run(10), exit::TX_FULL);
    assert_eq!((t.vm.exit.retired, t.vm.vcpu.cpu.pc), (0, RAM_BASE));
    t.vm.shared.console.tx.pop();
    t.vm.run(1);
    assert_eq!(t.vm.vcpu.cpu.pc, RAM_BASE + 4);
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
        t.vm.shared.counters.exceptions[0x25].load(Ordering::Relaxed),
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
    let c = &t.vm.vcpu.cpu;
    // Taken after 100 steps (tick 300), from EL1h, before the branch.
    assert_eq!((c.pc, c.elr_el1), (VBAR + 0x280, RAM_BASE));
    assert_eq!(t.vm.shared.counters.irqs.load(Ordering::Relaxed), 1);
    assert_eq!(t.vm.now(), 3 * 10_000);
    assert_eq!(t.vm.gic.cpu_read(0x0c, 4), Some(IRQ_VTIMER as u32));
}

#[test]
fn wfi_jumps_to_the_deadline_or_idles() {
    // IRQs masked: WFI still wakes, and the handler isn't entered.
    let mut t = T::new(&[WFI, NOP, WFI], VmConfig::default());
    t.vtimer_at(1_000_000);
    assert_eq!(t.vm.run(2), exit::BUDGET);
    assert_eq!(t.vm.vcpu.cpu.pc, RAM_BASE + 8);
    assert_eq!(t.vm.now(), 1_000_002);
    // The timer has fired and the GIC signals it, so the next WFI completes at once.
    assert_eq!(t.vm.run(1), exit::BUDGET);
    // Nothing armed: idle, PC on the WFI.
    let mut t = T::new(&[WFI], VmConfig::default());
    assert_eq!(t.vm.run(10), exit::IDLE);
    assert_eq!((t.vm.vcpu.cpu.pc, t.vm.exit.value), (RAM_BASE, u64::MAX));
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
    t.vm.gic.dist_write(0, 4, 1).unwrap();
    t.vm.gic.dist_write(0x100, 4, 1 << IRQ_VTIMER).unwrap();
    t.vm.gic.cpu_write(0, 4, 1).unwrap();
    t.vm.gic.cpu_write(4, 4, 0xff).unwrap();
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
