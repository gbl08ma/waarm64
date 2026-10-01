//! GICv3 without ITS or LPIs (M7): the distributor, one redistributor per
//! CPU and the system-register CPU interface (`ICC_*_EL1`). Written from the
//! GICv3 architecture specification (IHI 0069); QEMU's model was a behavioral
//! reference only.
//!
//! - **One security state** (`GICD_CTLR.DS` = 1, RAO/WI) and **affinity routing
//!   always on** (`ARE` RAO/WI; no legacy GICv2 interface). Group 1 interrupts
//!   signal IRQ. Group 0 would signal FIQ, which nothing here takes (Linux and
//!   kvm-unit-tests use group 1 only): they can still be acknowledged through
//!   `ICC_IAR0_EL1`.
//! - **5 priority bits** (`ICC_CTLR_EL1.PRIbits` = 4, as QEMU's GICv3 has):
//!   priority fields keep bits 7:3; one active-priorities register per group
//!   (`ICC_AP0R0`/`ICC_AP1R0`, bit = priority >> 3). The others are UNDEFINED.
//! - 96 interrupt IDs, as the GICv2 model: SGIs 0–15 and PPIs 16–31 banked
//!   per CPU in its redistributor, SPIs 32–95 in the distributor, routed by
//!   `GICD_IROUTER` (an affinity, or 1 of N: the lowest-numbered CPU with
//!   group 1 enabled).
//! - CPU *i*'s affinity is Aff1 = i / 16, Aff0 = i % 16 (QEMU `virt`'s GICv3
//!   clustering, so an SGI target list covers 16 CPUs).
//! - `GICR_WAKER.ProcessorSleep` is state only: interrupts are forwarded while
//!   it's set (QEMU does the same; Linux clears it at boot).

use crate::snapshot::{self, Reader, Writer};

pub const NIRQ: usize = 96;
pub const SPURIOUS: u32 = 1023;
/// The distributor's frame and each CPU's redistributor frames (RD_base, then SGI_base).
pub const GICD_SIZE: u64 = 0x1_0000;
pub const GICR_STRIDE: u64 = 0x2_0000;
/// Priority bits kept (5).
const PRIO: u8 = 0xf8;
/// Minimum binary points for 5 priority bits.
const BPR0_MIN: u8 = 2;
const BPR1_MIN: u8 = 3;
const SGIS: u32 = 0xffff;

/// A CPU's redistributor (SGIs and PPIs, bits 0–31) and its CPU interface.
#[derive(Clone)]
struct Cpu {
    /// Aff3.Aff2.Aff1.Aff0 as in `GICR_TYPER` bits 63:32.
    aff: u32,
    enabled: u32,
    latch: u32,
    level: u32,
    edge: u32,
    active: u32,
    group: u32,
    prio: [u8; 32],
    sleep: bool,
    pmr: u8,
    bpr0: u8,
    bpr1: u8,
    /// `ICC_CTLR_EL1`: CBPR (bit 0), EOImode (bit 1).
    ctlr: u32,
    igrpen0: bool,
    igrpen1: bool,
    /// Active priorities, group 0 and group 1 (`ICC_AP0R0`, `ICC_AP1R0`).
    ap: [u32; 2],
}

impl Cpu {
    fn new(i: usize) -> Cpu {
        Cpu {
            aff: mpidr(i) as u32 & 0xff_ffff,
            enabled: 0,
            latch: 0,
            level: 0,
            edge: SGIS,
            active: 0,
            group: 0,
            prio: [0; 32],
            sleep: true,
            pmr: 0,
            bpr0: BPR0_MIN,
            bpr1: BPR1_MIN,
            ctlr: 0,
            igrpen0: false,
            igrpen1: false,
            ap: [0; 2],
        }
    }
}

pub struct Gicv3 {
    /// `GICD_CTLR`: EnableGrp0 (bit 0), EnableGrp1 (bit 1).
    ctlr: u32,
    // SPIs: bits 32–95 (0–31 unused).
    enabled: u128,
    latch: u128,
    level: u128,
    edge: u128,
    active: u128,
    group: u128,
    prio: [u8; NIRQ],
    route: [u64; NIRQ],
    /// The SPIs each CPU receives now (from `route` and the CPUs' group enables).
    targets: Vec<u128>,
    cpus: Vec<Cpu>,
}

/// Which group an access or an interrupt is in.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Group {
    G0,
    G1,
}

/// `ICC_*_EL1` registers (op0 = 3, op1 = 0; the `interp::sys` key of each is
/// `sr(3, 0, crn, crm, op2)`), by CRn:CRm:op2.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Icc {
    Pmr,
    Iar(Group),
    Eoir(Group),
    Hppir(Group),
    Bpr(Group),
    Ap(Group),
    Dir,
    Rpr,
    Sgi1r,
    Asgi1r,
    Sgi0r,
    Ctlr,
    Sre,
    Igrpen(Group),
}

impl Icc {
    /// The register at CRn, CRm, op2 (op0 = 3, op1 = 0), if it's one of ours.
    pub fn decode(crn: u32, crm: u32, op2: u32) -> Option<Icc> {
        use Group::*;
        Some(match (crn, crm, op2) {
            (4, 6, 0) => Icc::Pmr,
            (12, 8, 0) => Icc::Iar(G0),
            (12, 8, 1) => Icc::Eoir(G0),
            (12, 8, 2) => Icc::Hppir(G0),
            (12, 8, 3) => Icc::Bpr(G0),
            (12, 8, 4) => Icc::Ap(G0),
            (12, 9, 0) => Icc::Ap(G1),
            (12, 11, 1) => Icc::Dir,
            (12, 11, 3) => Icc::Rpr,
            (12, 11, 5) => Icc::Sgi1r,
            (12, 11, 6) => Icc::Asgi1r,
            (12, 11, 7) => Icc::Sgi0r,
            (12, 12, 0) => Icc::Iar(G1),
            (12, 12, 1) => Icc::Eoir(G1),
            (12, 12, 2) => Icc::Hppir(G1),
            (12, 12, 3) => Icc::Bpr(G1),
            (12, 12, 4) => Icc::Ctlr,
            (12, 12, 5) => Icc::Sre,
            (12, 12, 6) => Icc::Igrpen(G0),
            (12, 12, 7) => Icc::Igrpen(G1),
            _ => return None,
        })
    }

    /// Whether MRS may read it and MSR may write it (the others are UNDEFINED).
    pub fn readable(self) -> bool {
        !matches!(
            self,
            Icc::Eoir(_) | Icc::Dir | Icc::Sgi1r | Icc::Asgi1r | Icc::Sgi0r
        )
    }

    pub fn writable(self) -> bool {
        !matches!(self, Icc::Iar(_) | Icc::Hppir(_) | Icc::Rpr)
    }
}

/// `MPIDR_EL1` of CPU `i` (bit 31 RES1, U = 0, MT = 0): Aff1 = i / 16, Aff0 = i % 16.
pub fn mpidr(i: usize) -> u64 {
    1 << 31 | (((i / 16) << 8) | (i % 16)) as u64
}

/// The affinity fields of an MPIDR (Aff3 at 39:32, Aff2–Aff0 at 23:0) packed as `GICR_TYPER` has them.
fn aff32(v: u64) -> u32 {
    (v >> 8 & 0xff00_0000 | v & 0xff_ffff) as u32
}

impl Gicv3 {
    pub fn new(ncpus: usize) -> Gicv3 {
        Gicv3 {
            ctlr: 0,
            enabled: 0,
            latch: 0,
            level: 0,
            edge: 0,
            active: 0,
            group: 0,
            prio: [0; NIRQ],
            route: [0; NIRQ],
            targets: vec![0; ncpus],
            cpus: (0..ncpus).map(Cpu::new).collect(),
        }
        .retargeted()
    }

    fn retargeted(mut self) -> Gicv3 {
        self.retarget();
        self
    }

    /// Whether line `irq` of CPU `c` (a PPI) is high.
    pub fn level(&self, c: usize, irq: usize) -> bool {
        self.cpus[c].level & 1 << irq != 0
    }

    /// Saves the distributor, then each CPU's redistributor and CPU interface.
    pub fn save(&self, w: &mut Writer) {
        w.u32(self.ctlr);
        for v in [
            self.enabled,
            self.latch,
            self.level,
            self.edge,
            self.active,
            self.group,
        ] {
            w.u128(v);
        }
        w.raw(&self.prio);
        self.route.iter().for_each(|&r| w.u64(r));
        for c in &self.cpus {
            for v in [c.enabled, c.latch, c.level, c.edge, c.active, c.group] {
                w.u32(v);
            }
            w.raw(&c.prio);
            w.bool(c.sleep);
            w.raw(&[c.pmr, c.bpr0, c.bpr1]);
            w.u32(c.ctlr);
            w.bool(c.igrpen0);
            w.bool(c.igrpen1);
            w.u32(c.ap[0]);
            w.u32(c.ap[1]);
        }
    }

    /// Restores what [`Gicv3::save`] wrote, for the same number of CPUs.
    pub fn restore(&mut self, r: &mut Reader) -> snapshot::Result<()> {
        // What a guest's writes leave: SPI bits only, 5 priority bits, the affinity and IRM of a route.
        const SPIS: u128 = (1 << NIRQ) - (1 << 32);
        self.ctlr = r.u32()? & 3;
        self.enabled = r.u128()? & SPIS;
        self.latch = r.u128()? & SPIS;
        self.level = r.u128()? & SPIS;
        self.edge = r.u128()? & SPIS;
        self.active = r.u128()? & SPIS;
        self.group = r.u128()? & SPIS;
        for (p, &b) in self.prio.iter_mut().zip(r.raw(NIRQ)?) {
            *p = b & PRIO;
        }
        for route in &mut self.route {
            *route = r.u64()? & 0xff_80ff_ffff;
        }
        for c in &mut self.cpus {
            c.enabled = r.u32()?;
            c.latch = r.u32()?;
            c.level = r.u32()?;
            c.edge = r.u32()? | SGIS;
            c.active = r.u32()?;
            c.group = r.u32()?;
            for (p, &b) in c.prio.iter_mut().zip(r.raw(32)?) {
                *p = b & PRIO;
            }
            c.sleep = r.bool()?;
            let b = r.raw(3)?;
            // The binary points index a shift: a guest's writes are clamped the same way.
            (c.pmr, c.bpr0, c.bpr1) = (
                b[0] & PRIO,
                b[1].clamp(BPR0_MIN, 7),
                b[2].clamp(BPR1_MIN, 7),
            );
            c.ctlr = r.u32()? & 3;
            c.igrpen0 = r.bool()?;
            c.igrpen1 = r.bool()?;
            c.ap = [r.u32()?, r.u32()?];
        }
        self.retarget();
        Ok(())
    }

    pub fn ncpus(&self) -> usize {
        self.cpus.len()
    }

    /// Recomputes which CPU each SPI goes to.
    fn retarget(&mut self) {
        let any = self.cpus.iter().position(|c| c.igrpen1).unwrap_or(0);
        self.targets.iter_mut().for_each(|t| *t = 0);
        for i in 32..NIRQ {
            let r = self.route[i];
            let to = if r & 1 << 31 != 0 {
                Some(any)
            } else {
                self.cpus.iter().position(|c| c.aff == aff32(r))
            };
            if let Some(c) = to {
                self.targets[c] |= 1 << i;
            }
        }
    }

    /// Drives line `irq` of CPU `c` (a PPI; `c` is ignored for SPIs) high or low.
    pub fn set_level(&mut self, c: usize, irq: usize, high: bool) {
        if irq < 32 {
            let (cpu, b) = (&mut self.cpus[c], 1u32 << irq);
            if high && cpu.level & b == 0 && cpu.edge & b != 0 {
                cpu.latch |= b;
            }
            cpu.level = if high { cpu.level | b } else { cpu.level & !b };
        } else {
            let b = 1u128 << irq;
            if high && self.level & b == 0 && self.edge & b != 0 {
                self.latch |= b;
            }
            self.level = if high {
                self.level | b
            } else {
                self.level & !b
            };
        }
    }

    /// CPU `c`'s view of an interrupt state: its SGIs and PPIs, and the SPIs routed to it.
    fn view(&self, c: usize, local: u32, spi: u128) -> u128 {
        local as u128 | spi & self.targets[c]
    }

    fn prio_of(&self, c: usize, i: usize) -> u8 {
        if i < 32 {
            self.cpus[c].prio[i]
        } else {
            self.prio[i]
        }
    }

    /// The highest-priority (then lowest-numbered) enabled, pending, inactive
    /// interrupt of group `g` for CPU `c`, with its group enabled at the
    /// distributor and at the CPU interface.
    fn best(&self, c: usize, g: Group) -> Option<usize> {
        let cpu = &self.cpus[c];
        let on = match g {
            Group::G0 => self.ctlr & 1 != 0 && cpu.igrpen0,
            Group::G1 => self.ctlr & 2 != 0 && cpu.igrpen1,
        };
        if !on {
            return None;
        }
        let pend_l = cpu.latch | cpu.level & !cpu.edge;
        let pend_s = self.latch | self.level & !self.edge;
        let grp = self.view(c, cpu.group, self.group);
        let grp = if g == Group::G1 { grp } else { !grp };
        let mut m = self.view(
            c,
            cpu.enabled & pend_l & !cpu.active,
            self.enabled & pend_s & !self.active,
        ) & grp;
        let mut best: Option<usize> = None;
        while m != 0 {
            let i = m.trailing_zeros() as usize;
            m &= m - 1;
            if best.is_none_or(|b| self.prio_of(c, i) < self.prio_of(c, b)) {
                best = Some(i);
            }
        }
        best
    }

    /// The group priority mask for group `g` at CPU `c` (bits 7:n+1 for BPR0,
    /// bits 7:n for BPR1; BPR0 serves both with ICC_CTLR_EL1.CBPR).
    fn gmask(&self, c: usize, g: Group) -> u8 {
        let cpu = &self.cpus[c];
        let shift = match g {
            Group::G1 if cpu.ctlr & 1 == 0 => cpu.bpr1,
            _ => cpu.bpr0 + 1,
        };
        (0xffu32 << shift) as u8
    }

    /// Running priority: the highest active priority (0xff when idle).
    fn running(&self, c: usize) -> u8 {
        let ap = self.cpus[c].ap[0] | self.cpus[c].ap[1];
        if ap == 0 {
            0xff
        } else {
            (ap.trailing_zeros() << 3) as u8
        }
    }

    /// The group `g` interrupt CPU `c` would signal: above the priority mask
    /// and preempting the running priority.
    fn signaled(&self, c: usize, g: Group) -> Option<usize> {
        let i = self.best(c, g)?;
        let p = self.prio_of(c, i);
        (p < self.cpus[c].pmr && p & self.gmask(c, g) < self.running(c)).then_some(i)
    }

    /// The IRQ line into CPU `c` (group 1).
    pub fn irq(&self, c: usize) -> bool {
        self.signaled(c, Group::G1).is_some()
    }

    fn ack(&mut self, c: usize, g: Group) -> u32 {
        let Some(i) = self.signaled(c, g) else {
            return SPURIOUS;
        };
        let bit = (self.prio_of(c, i) & self.gmask(c, g)) >> 3;
        let cpu = &mut self.cpus[c];
        cpu.ap[g as usize] |= 1 << bit;
        if i < 32 {
            cpu.active |= 1 << i;
            cpu.latch &= !(1 << i);
        } else {
            self.active |= 1 << i;
            self.latch &= !(1 << i);
        }
        i as u32
    }

    fn deactivate(&mut self, c: usize, i: usize) {
        if i < 32 {
            self.cpus[c].active &= !(1 << i);
        } else if i < NIRQ {
            self.active &= !(1 << i);
        }
    }

    /// EOIR: drops the highest active priority (if it's this group's), then
    /// deactivates the interrupt unless EOImode splits that off to DIR.
    fn eoi(&mut self, c: usize, g: Group, v: u64) {
        let cpu = &mut self.cpus[c];
        let top = (cpu.ap[0] | cpu.ap[1]).trailing_zeros();
        if top < 32 && cpu.ap[g as usize] & 1 << top != 0 {
            cpu.ap[g as usize] &= !(1 << top);
        }
        if cpu.ctlr & 2 == 0 {
            self.deactivate(c, (v & 0xff_ffff) as usize);
        }
    }

    /// An SGI from CPU `from` (ICC_SGI0R/SGI1R/ASGI1R write `v`) to the CPUs
    /// it names whose SGI is in group `g`.
    fn sgi(&mut self, from: usize, g: Group, v: u64) {
        let id = (v >> 24 & 0xf) as u32;
        let (list, rs) = (v & 0xffff, (v >> 44 & 0xf) as u32);
        let aff = ((v >> 48 & 0xff) << 24 | (v >> 32 & 0xff) << 16 | (v >> 16 & 0xff) << 8) as u32;
        let all = v & 1 << 40 != 0;
        for (c, cpu) in self.cpus.iter_mut().enumerate() {
            let hit = if all {
                c != from
            } else {
                let a0 = cpu.aff & 0xff;
                cpu.aff & !0xff == aff && a0 >> 4 == rs && list >> (a0 & 0xf) & 1 != 0
            };
            let grp = if cpu.group >> id & 1 != 0 {
                Group::G1
            } else {
                Group::G0
            };
            if hit && grp == g {
                cpu.latch |= 1 << id;
            }
        }
    }

    /// An `ICC_*_EL1` access from CPU `c` at EL1: a read returns the value, a
    /// write takes `v`.
    pub fn icc(&mut self, c: usize, r: Icc, write: Option<u64>) -> u64 {
        let v = write.unwrap_or(0);
        match (r, write.is_some()) {
            (Icc::Pmr, false) => return self.cpus[c].pmr as u64,
            (Icc::Pmr, true) => self.cpus[c].pmr = v as u8 & PRIO,
            (Icc::Iar(g), false) => return self.ack(c, g) as u64,
            (Icc::Eoir(g), true) => self.eoi(c, g, v),
            (Icc::Hppir(g), false) => return self.best(c, g).map_or(SPURIOUS, |i| i as u32) as u64,
            (Icc::Bpr(Group::G0), false) => return self.cpus[c].bpr0 as u64,
            (Icc::Bpr(Group::G0), true) => self.cpus[c].bpr0 = (v as u8 & 7).max(BPR0_MIN),
            (Icc::Bpr(Group::G1), false) => {
                let cpu = &self.cpus[c];
                return if cpu.ctlr & 1 != 0 {
                    (cpu.bpr0 + 1).min(7)
                } else {
                    cpu.bpr1
                } as u64;
            }
            (Icc::Bpr(Group::G1), true) if self.cpus[c].ctlr & 1 == 0 => {
                self.cpus[c].bpr1 = (v as u8 & 7).max(BPR1_MIN)
            }
            (Icc::Ap(g), false) => return self.cpus[c].ap[g as usize] as u64,
            (Icc::Ap(g), true) => self.cpus[c].ap[g as usize] = v as u32,
            (Icc::Dir, true) => {
                if self.cpus[c].ctlr & 2 != 0 {
                    self.deactivate(c, (v & 0xff_ffff) as usize);
                }
            }
            (Icc::Rpr, false) => return self.running(c) as u64,
            (Icc::Sgi1r | Icc::Asgi1r, true) => self.sgi(c, Group::G1, v),
            (Icc::Sgi0r, true) => self.sgi(c, Group::G0, v),
            // PRIbits 4 (5 bits), IDbits 0 (16), A3V.
            (Icc::Ctlr, false) => return (self.cpus[c].ctlr | 4 << 8 | 1 << 15) as u64,
            (Icc::Ctlr, true) => self.cpus[c].ctlr = v as u32 & 3,
            // SRE, DFB, DIB: RAO/WI (the system-register interface only).
            (Icc::Sre, false) => return 7,
            (Icc::Igrpen(g), false) => {
                let cpu = &self.cpus[c];
                return if g == Group::G0 {
                    cpu.igrpen0
                } else {
                    cpu.igrpen1
                } as u64;
            }
            (Icc::Igrpen(g), true) => {
                let cpu = &mut self.cpus[c];
                if g == Group::G0 {
                    cpu.igrpen0 = v & 1 != 0
                } else {
                    cpu.igrpen1 = v & 1 != 0
                }
                self.retarget();
            }
            _ => {}
        }
        0
    }

    /// Distributor register read (`off` within its 64 KiB frame, `size` bytes):
    /// `None` for an access size the register doesn't allow (external abort).
    pub fn dist_read(&self, off: u64, size: u32) -> Option<u64> {
        if (0x6000..0x8000).contains(&off) {
            return sub(off, size, self.irouter(off), true);
        }
        let w = self.dist_read32(off & !3) as u64;
        sub(off, size, w, false).filter(|_| size == 4 || size == 1 && dist_bytes(off))
    }

    pub fn dist_write(&mut self, off: u64, size: u32, v: u64) -> Option<()> {
        if (0x6000..0x8000).contains(&off) {
            let i = ((off - 0x6000) / 8) as usize;
            let old = self.irouter(off);
            let new = merge(off, size, old, v, true)?;
            if (32..NIRQ).contains(&i) {
                self.route[i] = new & 0xff_80ff_ffff; // Aff3, IRM, Aff2–Aff0
                self.retarget();
            }
            return Some(());
        }
        if !(size == 4 || size == 1 && dist_bytes(off)) {
            return None;
        }
        let w = merge(off, size, self.dist_read32(off & !3) as u64, v, false)? as u32;
        self.dist_write32(off & !3, w);
        Some(())
    }

    fn irouter(&self, off: u64) -> u64 {
        let i = ((off & !7) - 0x6000) as usize / 8;
        if (32..NIRQ).contains(&i) {
            self.route[i]
        } else {
            0
        }
    }

    fn dist_read32(&self, off: u64) -> u32 {
        let n = word_index(off);
        // Words 0 of the per-interrupt arrays are the redistributors' (RAZ/WI here, ARE = 1).
        let spi = |m: u128| if n == 0 { 0 } else { word(m, n) };
        match off {
            0x000 => self.ctlr | 1 << 4 | 1 << 6, // ARE, DS
            // ITLinesNumber 2 (96 IDs), CPUNumber, IDbits 9 (10 bits), A3V.
            0x004 => 2 | ((self.ncpus().min(8) - 1) as u32) << 5 | 9 << 19 | 1 << 24,
            0x008 => 0x43b,
            0x080..0x100 => spi(self.group),
            0x100..0x200 => spi(self.enabled),
            0x200..0x300 => spi(self.latch | self.level & !self.edge),
            0x300..0x400 => spi(self.active),
            0x400..0x800 if n >= 8 => {
                let p = |i: usize| self.prio.get(i).copied().unwrap_or(0);
                u32::from_le_bytes([p(4 * n), p(4 * n + 1), p(4 * n + 2), p(4 * n + 3)])
            }
            0xc00..0xd00 if (2..NIRQ / 16).contains(&n) => {
                let e = (self.edge >> (16 * n)) & 0xffff;
                (0..16).fold(0, |w, k| w | ((e >> k & 1) as u32) << (2 * k + 1))
            }
            0xffe8 => 0x3b, // PIDR2: ArchRev 3
            _ => 0,
        }
    }

    fn dist_write32(&mut self, off: u64, v: u32) {
        let n = word_index(off);
        let m = if n == 0 { 0 } else { bits_of(v, n) };
        match off {
            0x000 => self.ctlr = v & 3,
            0x080..0x100 => self.group = self.group & !bits_of(!0, n) | m,
            0x100..0x180 => self.enabled |= m,
            0x180..0x200 => self.enabled &= !m,
            0x200..0x280 => self.latch |= m,
            0x280..0x300 => self.latch &= !m,
            0x300..0x380 => self.active |= m,
            0x380..0x400 => self.active &= !m,
            0x400..0x800 if n >= 8 => {
                for (k, b) in v.to_le_bytes().into_iter().enumerate() {
                    if let Some(p) = self.prio.get_mut(4 * n + k) {
                        *p = b & PRIO;
                    }
                }
            }
            0xc00..0xd00 if (2..NIRQ / 16).contains(&n) => {
                let e = (0..16).fold(0u128, |e, k| e | ((v >> (2 * k + 1) & 1) as u128) << k);
                let sh = 16 * n;
                self.edge = self.edge & !(0xffff << sh) | e << sh;
            }
            _ => {}
        }
    }

    /// Redistributor register read (`off` from the first redistributor's
    /// frame: CPU `off / GICR_STRIDE`); `None` past the last CPU's frames or
    /// for a size the register doesn't allow.
    pub fn redist_read(&self, off: u64, size: u32) -> Option<u64> {
        let (c, off) = ((off / GICR_STRIDE) as usize, off % GICR_STRIDE);
        let cpu = self.cpus.get(c)?;
        if off & !7 == 0x8 {
            // GICR_TYPER: affinity, Processor_Number, Last.
            let last = (c + 1 == self.ncpus()) as u64;
            return sub(
                off,
                size,
                (cpu.aff as u64) << 32 | (c as u64) << 8 | last << 4,
                true,
            );
        }
        if off & !7 == 0x70 || off & !7 == 0x78 {
            return sub(off, size, 0, true); // PROPBASER, PENDBASER: no LPIs
        }
        let n = if (0x1_0400..0x1_0420).contains(&off) {
            1
        } else {
            0
        };
        let w = match off & !3 {
            0x4 => 0x43b,
            0x14 => (cpu.sleep as u32) << 1 | (cpu.sleep as u32) << 2, // WAKER
            0xffe8 | 0x1_ffe8 => 0x3b,
            0x1_0080 => cpu.group,
            0x1_0100 | 0x1_0180 => cpu.enabled,
            0x1_0200 | 0x1_0280 => cpu.latch | cpu.level & !cpu.edge,
            0x1_0300 | 0x1_0380 => cpu.active,
            o @ 0x1_0400..0x1_0420 => {
                u32::from_le_bytes(cpu.prio[(o - 0x1_0400) as usize..][..4].try_into().unwrap())
            }
            o @ (0x1_0c00 | 0x1_0c04) => {
                let e = cpu.edge >> (16 * (o - 0x1_0c00) / 4);
                (0..16).fold(0, |w, k| w | (e >> k & 1) << (2 * k + 1))
            }
            _ => 0,
        };
        sub(off, size, w as u64, false).filter(|_| size == 4 || size == 1 && n == 1)
    }

    pub fn redist_write(&mut self, off: u64, size: u32, v: u64) -> Option<()> {
        let (c, off) = ((off / GICR_STRIDE) as usize, off % GICR_STRIDE);
        if c >= self.ncpus() {
            return None;
        }
        if matches!(off & !7, 0x8 | 0x70 | 0x78) {
            return merge(off, size, 0, v, true).map(|_| ());
        }
        let bytes = (0x1_0400..0x1_0420).contains(&off);
        if !(size == 4 || size == 1 && bytes) {
            return None;
        }
        let old = self.redist_read(c as u64 * GICR_STRIDE + (off & !3), 4)?;
        let w = merge(off, size, old, v, false)? as u32;
        let cpu = &mut self.cpus[c];
        match off & !3 {
            0x14 => cpu.sleep = w & 2 != 0,
            0x1_0080 => cpu.group = w,
            0x1_0100 => cpu.enabled |= w,
            0x1_0180 => cpu.enabled &= !w,
            0x1_0200 => cpu.latch |= w,
            0x1_0280 => cpu.latch &= !w,
            0x1_0300 => cpu.active |= w,
            0x1_0380 => cpu.active &= !w,
            o @ 0x1_0400..0x1_0420 => {
                for (k, b) in w.to_le_bytes().into_iter().enumerate() {
                    cpu.prio[(o - 0x1_0400) as usize + k] = b & PRIO;
                }
            }
            0x1_0c04 => {
                // PPIs' configuration (SGIs, ICFGR0, are read-only edge).
                let e = (0..16).fold(0u32, |e, k| e | (w >> (2 * k + 1) & 1) << k);
                cpu.edge = cpu.edge & 0xffff | e << 16;
            }
            _ => {}
        }
        Some(())
    }
}

/// Word `n` of a per-interrupt mask, and the mask bits a write of `v` to it covers.
fn word(m: u128, n: usize) -> u32 {
    if n < NIRQ / 32 {
        (m >> (32 * n)) as u32
    } else {
        0
    }
}

fn bits_of(v: u32, n: usize) -> u128 {
    if n < NIRQ / 32 {
        (v as u128) << (32 * n)
    } else {
        0
    }
}

/// The word index within the distributor array at `off`.
fn word_index(off: u64) -> usize {
    let base = match off {
        0x400..0x800 => 0x400,
        0xc00..0xd00 => 0xc00,
        _ => off & !0x7f,
    };
    (off - base) as usize / 4
}

/// IPRIORITYR and ITARGETSR allow byte accesses.
fn dist_bytes(off: u64) -> bool {
    matches!(off, 0x400..0xc00)
}

/// The `size`-byte part of `w` at `off`: a 64-bit register (`wide`) allows
/// aligned 8- and 4-byte accesses, a 32-bit one aligned words and bytes.
fn sub(off: u64, size: u32, w: u64, wide: bool) -> Option<u64> {
    match size {
        8 if wide && off & 7 == 0 => Some(w),
        4 if off & 3 == 0 => Some(if wide {
            w >> (8 * (off & 4)) & 0xffff_ffff
        } else {
            w & 0xffff_ffff
        }),
        1 if !wide => Some(w >> (8 * (off & 3)) & 0xff),
        _ => None,
    }
}

/// `old` with a `size`-byte write of `v` at `off` merged in (as [`sub`]).
fn merge(off: u64, size: u32, old: u64, v: u64, wide: bool) -> Option<u64> {
    let (sh, mask) = match size {
        8 if wide && off & 7 == 0 => (0, u64::MAX),
        4 if off & 3 == 0 => (if wide { 8 * (off & 4) } else { 0 }, 0xffff_ffff),
        1 if !wide => (8 * (off & 3), 0xff),
        _ => return None,
    };
    Some(old & !(mask << sh) | (v & mask) << sh)
}

#[cfg(test)]
mod tests {
    use super::*;
    use Group::*;

    /// Distributor group 1 on, CPU interface group 1 on, PMR open, as Linux leaves them.
    fn on(n: usize) -> Gicv3 {
        let mut g = Gicv3::new(n);
        g.dist_write(0, 4, 2).unwrap();
        for c in 0..n {
            g.icc(c, Icc::Igrpen(G1), Some(1));
            g.icc(c, Icc::Pmr, Some(0xf0));
            let rd = c as u64 * GICR_STRIDE;
            g.redist_write(rd + 0x14, 4, 0).unwrap();
            g.redist_write(rd + 0x1_0080, 4, !0).unwrap(); // SGIs and PPIs group 1
        }
        g.dist_write(0x84, 4, !0).unwrap(); // SPIs 32-63 group 1
        g.dist_write(0x88, 4, !0).unwrap();
        g
    }

    fn iar(g: &mut Gicv3, c: usize) -> u32 {
        g.icc(c, Icc::Iar(G1), None) as u32
    }

    #[test]
    fn ppi_level_ack_eoi() {
        let mut g = on(1);
        g.set_level(0, 27, true);
        assert!(!g.irq(0), "disabled");
        g.redist_write(0x1_0100, 4, 1 << 27).unwrap();
        g.redist_write(0x1_0400 + 27, 1, 0xa0).unwrap();
        assert!(g.irq(0));
        assert_eq!(g.icc(0, Icc::Hppir(G1), None), 27);
        assert_eq!(iar(&mut g, 0), 27);
        assert!(!g.irq(0), "active");
        assert_eq!(g.icc(0, Icc::Rpr, None), 0xa0);
        assert_eq!(g.icc(0, Icc::Ap(G1), None), 1 << (0xa0 >> 3));
        g.icc(0, Icc::Eoir(G1), Some(27));
        assert_eq!(g.icc(0, Icc::Rpr, None), 0xff);
        assert!(g.irq(0), "line still high");
        g.set_level(0, 27, false);
        assert_eq!(iar(&mut g, 0), SPURIOUS);
    }

    #[test]
    fn spi_routing_priority_and_preemption() {
        let mut g = on(2);
        g.dist_write(0x104, 4, 0b11).unwrap(); // SPIs 32, 33
        g.dist_write(0x420, 4, 0x80_f0).unwrap(); // 32: 0xf0, 33: 0x80
        g.dist_write(0x6000 + 8 * 33, 8, 1).unwrap(); // SPI 33 to CPU 1 (Aff0 1)
        g.set_level(0, 32, true);
        assert!(!g.irq(0), "0xf0 isn't below PMR 0xf0");
        g.set_level(0, 33, true);
        assert!(!g.irq(0), "routed to CPU 1");
        assert_eq!(iar(&mut g, 1), 33);
        g.icc(1, Icc::Pmr, Some(0xff));
        g.dist_write(0x6000 + 8 * 32, 8, 1).unwrap();
        assert!(!g.irq(1), "0xf0 doesn't preempt running 0x80");
        g.icc(1, Icc::Eoir(G1), Some(33));
        g.set_level(0, 33, false);
        assert_eq!(iar(&mut g, 1), 32);
        // 1 of N: the lowest-numbered CPU with group 1 on.
        g.icc(0, Icc::Igrpen(G1), Some(0));
        g.dist_write(0x6000 + 8 * 34, 4, 1 << 31).unwrap();
        g.dist_write(0x104, 4, 0b111).unwrap();
        g.set_level(0, 34, true);
        assert_eq!(iar(&mut g, 1), 34);
    }

    #[test]
    fn sgis_by_affinity_and_split_eoi() {
        let mut g = on(18);
        for c in [0, 3, 17] {
            g.redist_write(c as u64 * GICR_STRIDE + 0x1_0100, 4, SGIS as u64)
                .unwrap();
        }
        // SGI 5 to CPU 3 (Aff1 0, target list bit 3) from CPU 0.
        g.icc(0, Icc::Sgi1r, Some(5 << 24 | 1 << 3));
        assert!(!g.irq(0) && g.irq(3));
        // SGI 6 to CPU 17 (Aff1 1, Aff0 1).
        g.icc(0, Icc::Sgi1r, Some(6 << 24 | 1 << 16 | 1 << 1));
        assert_eq!(iar(&mut g, 17), 6);
        // IRM: everyone but the sender.
        g.icc(3, Icc::Sgi1r, Some(7 << 24 | 1 << 40));
        assert_eq!(iar(&mut g, 0), 7);
        assert!(
            !g.irq(17),
            "SGI 7 not enabled at 17? it is: check the latch"
        );
        g.icc(3, Icc::Ctlr, Some(2)); // EOImode
        assert_eq!(iar(&mut g, 3), 5);
        g.icc(3, Icc::Eoir(G1), Some(5));
        assert_eq!(
            g.redist_read(3 * GICR_STRIDE + 0x1_0300, 4),
            Some(1 << 5),
            "still active"
        );
        g.icc(3, Icc::Dir, Some(5));
        assert_eq!(g.redist_read(3 * GICR_STRIDE + 0x1_0300, 4), Some(0));
    }

    #[test]
    fn register_shapes() {
        let mut g = Gicv3::new(2);
        assert_eq!(g.dist_read(0, 4), Some(0x50), "ARE and DS RAO");
        assert_eq!(
            g.dist_read(4, 4).map(|v| v & 0x1f),
            Some(2),
            "ITLinesNumber: 96 IDs"
        );
        assert_eq!(g.dist_read(0xffe8, 4), Some(0x3b));
        assert_eq!(
            g.redist_read(0x8, 8),
            Some(0),
            "CPU 0: affinity 0, not last"
        );
        assert_eq!(
            g.redist_read(GICR_STRIDE + 0x8, 8),
            Some(1 << 32 | 1 << 8 | 1 << 4)
        );
        assert_eq!(
            g.redist_read(GICR_STRIDE + 0xc, 4),
            Some(1),
            "TYPER's upper half"
        );
        assert_eq!(g.redist_read(2 * GICR_STRIDE, 4), None, "no third CPU");
        assert_eq!(g.redist_read(0x14, 4), Some(6), "asleep at reset");
        assert_eq!(g.redist_read(0x1_0c00, 4), Some(0xaaaa_aaaa), "SGIs edge");
        g.redist_write(0x1_0c00, 4, 0).unwrap();
        assert_eq!(g.redist_read(0x1_0c00, 4), Some(0xaaaa_aaaa), "read-only");
        g.dist_write(0x100, 4, !0).unwrap();
        assert_eq!(
            g.dist_read(0x100, 4),
            Some(0),
            "SGIs/PPIs aren't the distributor's"
        );
        g.dist_write(0x401, 1, 0x47).unwrap();
        assert_eq!(g.dist_read(0x400, 4), Some(0), "nor their priorities");
        g.dist_write(0x421, 1, 0x47).unwrap();
        assert_eq!(g.dist_read(0x420, 4), Some(0x4000), "5 priority bits");
        assert_eq!(g.dist_read(0x101, 1), None, "no byte access");
        g.dist_write(0x6000 + 8 * 40 + 4, 4, 0xab).unwrap();
        assert_eq!(
            g.dist_read(0x6000 + 8 * 40, 8),
            Some(0xab << 32),
            "Aff3 in the upper word"
        );
        assert_eq!(g.icc(0, Icc::Sre, None), 7);
        assert_eq!(g.icc(0, Icc::Bpr(G1), None), 3);
        g.icc(0, Icc::Bpr(G0), Some(0));
        assert_eq!(g.icc(0, Icc::Bpr(G0), None), 2, "clamped to the minimum");
        assert_eq!(g.icc(0, Icc::Ctlr, None) >> 8 & 7, 4, "PRIbits: 5 bits");
        assert_eq!(mpidr(17), 1 << 31 | 1 << 8 | 1);
    }
}
