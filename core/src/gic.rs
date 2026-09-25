//! GICv2 distributor and CPU interface for one vCPU, without the Security
//! Extensions: every interrupt is group 0 and signals IRQ (`GICD_IGROUPR` is
//! RAZ/WI, FIQ is never raised). Written from the GICv2 architecture
//! specification (IHI 0048B); QEMU's model was a behavioral reference only.
//!
//! 64 interrupt IDs: SGIs 0–15, PPIs 16–31 (the timers use 27 and 30), SPIs
//! 32–63 (the PL011 is 33). Per-interrupt state is one bit in a `u64` mask.
//! Priorities keep all 8 bits. `GICD_ITARGETSR` is RAZ/WI, as the spec has it
//! for a uniprocessor GIC (and QEMU does); M7 needs real targets.
// ponytail: 64 IDs is all M3's devices need; widen the masks for virtio in M4.

pub const NIRQ: usize = 64;
pub const SPURIOUS: u32 = 1023;
/// `GICC_CTLR.EOImode` (bit 9 without the Security Extensions): EOIR only
/// drops priority, and GICC_DIR deactivates.
const EOIMODE: u32 = 1 << 9;

pub struct Gic {
    dctlr: u32,
    cctlr: u32,
    pmr: u32,
    bpr: u32,
    abpr: u32,
    enabled: u64,
    /// Pending state latched by an edge, a GICD_ISPENDR write or an SGI.
    latch: u64,
    /// Input lines from the devices; a level-sensitive interrupt is pending while its line is high.
    level: u64,
    /// ICFGR: edge-triggered (SGIs always are).
    edge: u64,
    active: u64,
    /// Acknowledged and not yet EOId: these set the running priority.
    in_service: u64,
    prio: [u8; NIRQ],
}

impl Default for Gic {
    fn default() -> Self {
        Gic {
            dctlr: 0,
            cctlr: 0,
            pmr: 0,
            bpr: 0,
            abpr: 0,
            enabled: 0,
            latch: 0,
            level: 0,
            edge: 0xffff,
            active: 0,
            in_service: 0,
            prio: [0; NIRQ],
        }
    }
}

/// Word `n` of a 64-bit per-interrupt mask, and the mask bits a write of `v` to it covers.
fn word(m: u64, n: usize) -> u32 {
    if n < NIRQ / 32 {
        (m >> (32 * n)) as u32
    } else {
        0
    }
}

fn bits_of(v: u32, n: usize) -> u64 {
    if n < NIRQ / 32 {
        (v as u64) << (32 * n)
    } else {
        0
    }
}

impl Gic {
    /// Drives device line `irq` (a PPI or SPI) high or low.
    pub fn set_level(&mut self, irq: usize, high: bool) {
        let b = 1u64 << irq;
        if high && self.level & b == 0 && self.edge & b != 0 {
            self.latch |= b;
        }
        self.level = if high {
            self.level | b
        } else {
            self.level & !b
        };
    }

    fn pending(&self) -> u64 {
        self.latch | (self.level & !self.edge)
    }

    /// The highest-priority (then lowest-numbered) enabled, pending and inactive interrupt.
    fn best(&self) -> Option<usize> {
        let mut m = self.enabled & self.pending() & !self.active;
        let mut best: Option<usize> = None;
        while m != 0 {
            let i = m.trailing_zeros() as usize;
            m &= m - 1;
            if best.is_none_or(|b| self.prio[i] < self.prio[b]) {
                best = Some(i);
            }
        }
        best
    }

    /// Running priority: the highest priority among acknowledged interrupts not yet EOId.
    fn running(&self) -> Option<u8> {
        let mut m = self.in_service;
        let mut r: Option<u8> = None;
        while m != 0 {
            let i = m.trailing_zeros() as usize;
            m &= m - 1;
            r = Some(r.map_or(self.prio[i], |r| r.min(self.prio[i])));
        }
        r
    }

    /// The interrupt the CPU interface would signal: forwarding and signaling
    /// enabled, above the priority mask, and preempting the running priority
    /// (compared by group priority, GICC_BPR).
    fn signaled(&self) -> Option<usize> {
        if self.dctlr & 1 == 0 || self.cctlr & 1 == 0 {
            return None;
        }
        let i = self.best()?;
        let p = self.prio[i] as u32;
        let group = |p: u32| p & (0xff << (self.bpr + 1));
        let preempts = self.running().is_none_or(|r| group(p) < group(r as u32));
        (p < self.pmr && preempts).then_some(i)
    }

    /// The IRQ line into the vCPU.
    pub fn irq(&self) -> bool {
        self.signaled().is_some()
    }

    fn ack(&mut self) -> u32 {
        let Some(i) = self.signaled() else {
            return SPURIOUS;
        };
        let b = 1u64 << i;
        self.active |= b;
        self.in_service |= b;
        self.latch &= !b;
        i as u32 // SGIs report source CPU 0 in bits 12:10
    }

    fn eoi(&mut self, v: u32) {
        let id = (v & 0x3ff) as usize;
        if id < NIRQ {
            self.in_service &= !(1 << id);
            if self.cctlr & EOIMODE == 0 {
                self.active &= !(1 << id);
            }
        }
    }

    /// Distributor register read (`GICD_*`, `off` from 0x0800_0000); `None`
    /// for an access size the register doesn't allow (external abort).
    pub fn dist_read(&self, off: u64, size: u32) -> Option<u32> {
        let w = self.dist_read32(off & !3);
        sub_word(off, size, byte_access(off), w)
    }

    pub fn dist_write(&mut self, off: u64, size: u32, v: u32) -> Option<()> {
        let v = match size {
            4 if off & 3 == 0 => v,
            1 if byte_access(off) => {
                let sh = 8 * (off & 3);
                self.dist_read32(off & !3) & !(0xff << sh) | (v & 0xff) << sh
            }
            _ => return None,
        };
        self.dist_write32(off & !3, v);
        Some(())
    }

    fn dist_read32(&self, off: u64) -> u32 {
        let n = word_index(off);
        match off {
            0x000 => self.dctlr,
            0x004 => (NIRQ / 32 - 1) as u32, // ITLinesNumber; CPUNumber 0 (one CPU)
            0x008 => 0x43b,                  // IIDR: implementer ARM
            0x100..0x200 => word(self.enabled, n),
            0x200..0x300 => word(self.pending(), n),
            0x300..0x400 => word(self.active, n),
            0x400..0x800 => {
                let p = |i: usize| self.prio.get(i).copied().unwrap_or(0);
                u32::from_le_bytes([p(4 * n), p(4 * n + 1), p(4 * n + 2), p(4 * n + 3)])
            }
            0xc00..0xd00 if n < NIRQ / 16 => {
                // Two bits per interrupt; bit 1 of each field is edge-triggered.
                let e = (self.edge >> (16 * n)) & 0xffff;
                (0..16).fold(0, |w, k| w | ((e >> k & 1) as u32) << (2 * k + 1))
            }
            0xfe8 => 2 << 4, // ICPIDR2.ArchRev: GICv2
            _ => 0,
        }
    }

    fn dist_write32(&mut self, off: u64, v: u32) {
        let n = word_index(off);
        let m = bits_of(v, n);
        match off {
            0x000 => self.dctlr = v & 3,
            0x100..0x180 => self.enabled |= m,
            0x180..0x200 => self.enabled &= !m,
            0x200..0x280 => self.latch |= m,
            0x280..0x300 => self.latch &= !m,
            0x300..0x380 => self.active |= m,
            0x380..0x400 => self.active &= !m,
            0x400..0x800 => {
                for (k, b) in v.to_le_bytes().into_iter().enumerate() {
                    if let Some(p) = self.prio.get_mut(4 * n + k) {
                        *p = b;
                    }
                }
            }
            0xc00..0xd00 if n > 0 && n < NIRQ / 16 => {
                // SGIs (field 0) stay edge-triggered.
                let e = (0..16).fold(0u64, |e, k| e | ((v >> (2 * k + 1) & 1) as u64) << k);
                let sh = 16 * n;
                self.edge = self.edge & !(0xffff << sh) | e << sh;
            }
            0xf00 => {
                // GICD_SGIR: filter 0 (the target list) with CPU 0 in it, or 2 (self).
                let filter = v >> 24 & 3;
                if filter == 2 || filter == 0 && v & 1 << 16 != 0 {
                    self.latch |= 1 << (v & 0xf);
                }
            }
            _ => {}
        }
    }

    /// CPU interface register read (`GICC_*`, `off` from 0x0801_0000). Reading
    /// GICC_IAR acknowledges.
    pub fn cpu_read(&mut self, off: u64, size: u32) -> Option<u32> {
        if size != 4 || off & 3 != 0 {
            return None;
        }
        Some(match off {
            0x00 => self.cctlr,
            0x04 => self.pmr,
            0x08 => self.bpr,
            0x0c => self.ack(),
            0x14 => self.running().map_or(0xff, |r| r as u32),
            0x18 => self.best().map_or(SPURIOUS, |i| i as u32),
            0x1c => self.abpr,
            0x20 | 0x28 => SPURIOUS, // AIAR, AHPPIR: nothing is group 1
            0xfc => 0x0002_043b,     // IIDR: architecture v2, implementer ARM
            _ => 0,
        })
    }

    pub fn cpu_write(&mut self, off: u64, size: u32, v: u32) -> Option<()> {
        if size != 4 || off & 3 != 0 {
            return None;
        }
        match off {
            0x00 => self.cctlr = v & 0x7ff,
            0x04 => self.pmr = v & 0xff,
            0x08 => self.bpr = v & 7,
            0x10 => self.eoi(v),
            0x1c => self.abpr = v & 7,
            0x1000 => {
                let id = (v & 0x3ff) as usize;
                if id < NIRQ {
                    self.active &= !(1 << id); // GICC_DIR
                }
            }
            _ => {}
        }
        Some(())
    }
}

/// The word index within the register array at `off`: bit arrays are 0x80
/// bytes apart, IPRIORITYR spans 0x400, ICFGR 0x100.
fn word_index(off: u64) -> usize {
    let base = match off {
        0x400..0x800 => 0x400,
        0xc00..0xd00 => 0xc00,
        _ => off & !0x7f,
    };
    (off - base) as usize / 4
}

/// IPRIORITYR, ITARGETSR (and CPENDSGIR/SPENDSGIR) allow byte accesses; all but the first are RAZ/WI here.
fn byte_access(off: u64) -> bool {
    matches!(off, 0x400..0xc00 | 0xf10..0xf30)
}

/// The `size`-byte part of word `w` at `off`: whole aligned words, or bytes where allowed.
fn sub_word(off: u64, size: u32, bytes_ok: bool, w: u32) -> Option<u32> {
    match size {
        4 if off & 3 == 0 => Some(w),
        1 if bytes_ok => Some(w >> (8 * (off & 3)) & 0xff),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Distributor and CPU interface on, PMR open, as Linux leaves them.
    fn on() -> Gic {
        let mut g = Gic::default();
        g.dist_write(0, 4, 1).unwrap();
        g.cpu_write(0, 4, 1).unwrap();
        g.cpu_write(4, 4, 0xf0).unwrap();
        g
    }

    fn iar(g: &mut Gic) -> u32 {
        g.cpu_read(0x0c, 4).unwrap()
    }

    #[test]
    fn level_interrupt_ack_eoi() {
        let mut g = on();
        g.set_level(27, true);
        assert!(!g.irq(), "disabled");
        g.dist_write(0x100, 4, 1 << 27).unwrap();
        g.dist_write(0x400 + 27, 1, 0xa0).unwrap();
        assert!(g.irq());
        assert_eq!(g.cpu_read(0x18, 4), Some(27)); // HPPIR
        assert_eq!(iar(&mut g), 27);
        assert!(!g.irq(), "active and pending isn't signaled again");
        assert_eq!(g.cpu_read(0x14, 4), Some(0xa0)); // RPR
        assert_eq!(g.dist_read(0x300, 4), Some(1 << 27));
        g.cpu_write(0x10, 4, 27).unwrap();
        assert!(g.irq(), "line still high: pending again");
        g.set_level(27, false);
        assert!(!g.irq());
        assert_eq!(iar(&mut g), SPURIOUS);
    }

    #[test]
    fn priority_mask_and_preemption() {
        let mut g = on();
        g.dist_write(0x104, 4, 0b11).unwrap(); // SPIs 32, 33
        g.dist_write(0x420, 4, 0x80_f0).unwrap(); // 32: 0xf0, 33: 0x80
        g.set_level(32, true);
        assert!(!g.irq(), "0xf0 isn't below PMR 0xf0");
        g.set_level(33, true);
        assert_eq!(iar(&mut g), 33);
        g.cpu_write(4, 4, 0xff).unwrap();
        assert!(!g.irq(), "0xf0 doesn't preempt running 0x80");
        g.cpu_write(0x10, 4, 33).unwrap();
        g.set_level(33, false);
        assert_eq!(iar(&mut g), 32);
    }

    #[test]
    fn edge_sgi_and_split_eoi() {
        let mut g = on();
        g.dist_write(0x100, 4, 0xffff).unwrap();
        g.dist_write(0xf00, 4, 2 << 24 | 5).unwrap(); // SGI 5 to self
        assert_eq!(iar(&mut g), 5);
        assert!(!g.irq(), "edge: acknowledging cleared it");
        g.cpu_write(0, 4, 1 | EOIMODE).unwrap();
        g.cpu_write(0x10, 4, 5).unwrap();
        assert_eq!(
            g.dist_read(0x300, 4),
            Some(1 << 5),
            "EOImode 1: still active"
        );
        g.cpu_write(0x1000, 4, 5).unwrap();
        assert_eq!(g.dist_read(0x300, 4), Some(0));
        // Configure SPI 33 as edge: a held line is one interrupt.
        g.dist_write(0xc08, 4, 2 << 2).unwrap();
        assert_eq!(g.dist_read(0xc08, 4), Some(2 << 2));
        g.dist_write(0x104, 4, 2).unwrap();
        g.set_level(33, true);
        assert_eq!(iar(&mut g), 33);
        g.cpu_write(0x10, 4, 33).unwrap();
        g.cpu_write(0x1000, 4, 33).unwrap();
        assert_eq!(iar(&mut g), SPURIOUS);
    }

    #[test]
    fn register_shapes() {
        let mut g = Gic::default();
        assert_eq!(g.dist_read(4, 4), Some(1));
        assert_eq!(g.dist_read(0xc00, 4), Some(0xaaaa_aaaa)); // SGIs edge
        g.dist_write(0xc00, 4, 0).unwrap();
        assert_eq!(g.dist_read(0xc00, 4), Some(0xaaaa_aaaa), "read-only");
        g.dist_write(0x820, 4, 0xffff_ffff).unwrap();
        assert_eq!(
            g.dist_read(0x821, 1),
            Some(0),
            "uniprocessor: targets RAZ/WI"
        );
        assert_eq!(g.dist_read(0x101, 1), None, "no byte access");
        assert_eq!(g.cpu_read(0x0c, 2), None);
        g.dist_write(0x401, 1, 0x40).unwrap();
        assert_eq!(g.dist_read(0x400, 4), Some(0x4000));
        assert_eq!(g.dist_read(0x480, 4), Some(0), "past the implemented IDs");
        assert_eq!(g.dist_read(0xc80, 4), Some(0));
    }
}
