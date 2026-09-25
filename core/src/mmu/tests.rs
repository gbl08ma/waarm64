//! Walks over hand-built tables, the TLB, and the Bus accessors.

use super::*;
use crate::cpu::M_EL0T;
use crate::mem::tests::TestRam;

const RAM: usize = 4 << 20;
const ROOT0: u64 = 0x10_0000;
const ROOT1: u64 = 0x10_1000;
/// Descriptor bits: valid, table/page, AF, AP[2:1].
const VALID: u64 = 1;
const TABLE: u64 = 3;
const PAGE: u64 = 3 | AF;
const BLOCK: u64 = 1 | AF;
const AF: u64 = 1 << 10;
const AP_EL0_RW: u64 = 1 << 6;
const AP_RO: u64 = 2 << 6;
const AP_EL0_RO: u64 = 3 << 6;
const PXN: u64 = 1 << 53;
const UXN: u64 = 1 << 54;

/// RAM at PA 0 with a bump allocator for tables above ROOT1.
struct Pt {
    r: TestRam,
    next: u64,
}

impl Pt {
    fn new() -> Pt {
        Pt {
            r: TestRam::new(RAM),
            next: ROOT1 + 0x1000,
        }
    }

    /// Maps `va` with the leaf descriptor `desc` (output address included) at
    /// `leaf`, from a table at `root` at level `start`; `table_bits` go on every
    /// table descriptor created or passed.
    fn map_with(&mut self, root: u64, start: u32, va: u64, leaf: u32, desc: u64, table_bits: u64) {
        let mut t = root;
        for level in start..leaf {
            let slot = t + 8 * ((va >> (12 + 9 * (3 - level))) & 511);
            let mut d = self.r.mem.read(slot, 8).unwrap();
            if d & 1 == 0 {
                d = self.next | TABLE;
                self.next += 0x1000;
            }
            self.r.mem.write(slot, 8, d | table_bits).unwrap();
            t = d & OA_MASK;
        }
        let slot = t + 8 * ((va >> (12 + 9 * (3 - leaf))) & 511);
        self.r.mem.write(slot, 8, desc).unwrap();
    }

    fn map(&mut self, va: u64, leaf: u32, desc: u64) {
        let root = if va >> 55 & 1 == 1 { ROOT1 } else { ROOT0 };
        self.map_with(root, 0, va, leaf, desc, 0);
    }

    fn walk(&self, c: &Cpu, va: u64) -> Result<Walk, FaultKind> {
        walk(c, &self.r.mem, va)
    }
}

/// EL1h, MMU on, 48-bit VAs both halves, 40-bit IPS, MAIR attr 0 = 0xff.
fn cpu() -> Cpu {
    Cpu {
        sctlr_el1: sctlr::RES1 | sctlr::M,
        tcr_el1: 16 | 16 << 16 | 2 << 32,
        ttbr0_el1: ROOT0,
        ttbr1_el1: ROOT1,
        mair_el1: 0x44ff,
        ..Cpu::reset()
    }
}

#[test]
fn pages_and_blocks() {
    let mut p = Pt::new();
    p.map(0x1234_5000, 3, 0x20_3000 | PAGE | 1 << 2 | 3 << 8); // AttrIndx 1, inner shareable
    p.map(0x4000_0000, 1, (0x40_0000_0000 - 0x4000_0000) | BLOCK); // 1 GiB at level 1
    p.map(0x8020_0000, 2, 0x60_0000 | BLOCK); // 2 MiB at level 2
    let c = cpu();
    let w = p.walk(&c, 0x1234_5678).unwrap();
    assert_eq!((w.pa, w.level, w.attr, w.sh), (0x20_3678, 3, 0x44, 3));
    assert_eq!(p.walk(&c, 0x7fff_fff8).unwrap().pa, 0x3f_ffff_fff8);
    let w = p.walk(&c, 0x803f_fff0).unwrap();
    assert_eq!((w.pa, w.level, w.attr), (0x7f_fff0, 2, 0xff));
    // T0SZ = 25 (39-bit VAs): the walk starts at level 1.
    let mut p = Pt::new();
    p.map_with(ROOT0, 1, 0x40_1000, 3, 0x9000 | PAGE, 0);
    let c = Cpu {
        tcr_el1: 25,
        ..cpu()
    };
    assert_eq!(p.walk(&c, 0x40_1abc).unwrap().pa, 0x9abc);
    assert_eq!(p.walk(&c, 1 << 39), Err(FaultKind::Translation(0))); // past 39 bits
}

#[test]
fn walk_faults() {
    let mut p = Pt::new();
    p.map(0x1000, 3, 0x5000 | VALID | 2); // AF clear
    p.map(0x2000, 3, 0x5000 | 1 | AF); // 0b01 at level 3: reserved
    p.map(0x3000, 3, (1 << 40) | PAGE); // past the 40-bit PA size
    p.map(0x80_0000_0000, 0, BLOCK); // no level 0 blocks with 4K pages
    let c = cpu();
    assert_eq!(p.walk(&c, 0x1000), Err(FaultKind::AccessFlag(3)));
    assert_eq!(p.walk(&c, 0x2000), Err(FaultKind::Translation(3)));
    assert_eq!(p.walk(&c, 0x3000), Err(FaultKind::AddressSize(3)));
    assert_eq!(p.walk(&c, 0x80_0000_0000), Err(FaultKind::Translation(0)));
    assert_eq!(p.walk(&c, 0x4000), Err(FaultKind::Translation(3))); // empty slot
    assert_eq!(p.walk(&c, 0x4000_0000), Err(FaultKind::Translation(1))); // empty L1 slot
    // Non-canonical, and EPD0.
    assert_eq!(
        p.walk(&c, 0x0001_0000_0000_1000),
        Err(FaultKind::Translation(0))
    );
    let c2 = Cpu {
        tcr_el1: c.tcr_el1 | 1 << 7,
        ..c.clone()
    };
    assert_eq!(p.walk(&c2, 0x1000), Err(FaultKind::Translation(0)));
    // A table outside RAM: external abort on the walk at the next level.
    p.r.mem
        .write(ROOT0 + 8, 8, (0x80_0000_0000 - 0x1000) | TABLE)
        .unwrap(); // PA 0x7f_ffff_f000
    assert_eq!(p.walk(&c, 0x80_0000_0000), Err(FaultKind::WalkBus(1)));
}

#[test]
fn ttbr1_and_tbi() {
    let mut p = Pt::new();
    p.map(0xffff_0000_1234_5000, 3, 0x6000 | PAGE);
    p.map(0x1234_5000, 3, 0x7000 | PAGE);
    let c = cpu();
    assert_eq!(p.walk(&c, 0xffff_0000_1234_5008).unwrap().pa, 0x6008);
    // A tagged pointer only translates with TBI0.
    let tagged = 0x5a00_0000_1234_5010;
    assert_eq!(p.walk(&c, tagged), Err(FaultKind::Translation(0)));
    let tbi = Cpu {
        tcr_el1: c.tcr_el1 | 1 << 37,
        ..c.clone()
    };
    assert_eq!(p.walk(&tbi, tagged).unwrap().pa, 0x7010);
    // Bit 55 still picks TTBR1 under TBI1.
    let tbi1 = Cpu {
        tcr_el1: c.tcr_el1 | 1 << 38,
        ..c
    };
    assert_eq!(p.walk(&tbi1, 0x12ff_0000_1234_5000).unwrap().pa, 0x6000);
}

#[test]
fn permissions() {
    let mut p = Pt::new();
    p.map(0x1000, 3, 0x9000 | PAGE); // EL1 RW only
    p.map(0x2000, 3, 0x9000 | PAGE | AP_EL0_RW); // EL0 RW: EL1 can't execute
    p.map(0x3000, 3, 0x9000 | PAGE | AP_EL0_RO | UXN);
    p.map(0x4000, 3, 0x9000 | PAGE | AP_RO | PXN);
    let c = cpu();
    let perms = |va: u64, c: &Cpu| {
        let w = p.walk(c, va).unwrap();
        let mut s = String::new();
        for el in 0..2 {
            for (u, ch) in [(Use::Read, 'r'), (Use::Write, 'w'), (Use::Exec, 'x')] {
                s.push(if w.allows(el, u) { ch } else { '-' });
            }
        }
        s
    };
    assert_eq!(perms(0x1000, &c), "--xrwx"); // EL0 may execute what it can't read
    assert_eq!(perms(0x2000, &c), "rwxrw-");
    assert_eq!(perms(0x3000, &c), "r--r-x");
    assert_eq!(perms(0x4000, &c), "--xr--");
    let wxn = Cpu {
        sctlr_el1: c.sctlr_el1 | sctlr::WXN,
        ..c.clone()
    };
    assert_eq!(perms(0x1000, &wxn), "--xrw-");
    // APTable[0] (no EL0) and APTable[1] (no writes), and UXNTable, on the way down.
    let mut p = Pt::new();
    p.map_with(
        ROOT0,
        0,
        0x5000,
        3,
        0x9000 | PAGE | AP_EL0_RW,
        1 << 61 | 1 << 60,
    );
    let w = p.walk(&c, 0x5000).unwrap();
    assert!(!w.allows(0, Use::Read) && !w.allows(0, Use::Exec) && w.allows(1, Use::Write));
    let mut p = Pt::new();
    p.map_with(ROOT0, 0, 0x5000, 3, 0x9000 | PAGE | AP_EL0_RW, 1 << 62);
    let w = p.walk(&c, 0x5000).unwrap();
    assert!(w.allows(0, Use::Read) && !w.allows(0, Use::Write) && !w.allows(1, Use::Write));
}

#[test]
fn bus_translates_faults_and_caches() {
    let mut p = Pt::new();
    p.map(0x1000, 3, 0x9000 | PAGE | AP_EL0_RO);
    p.r.mem.write(0x9010, 8, 0x1122).unwrap();
    let mut c = cpu();
    let mut v = Vcpu::new(c.clone());
    let mut b = Bus::new(&p.r.mem, Some(&mut v.tlb));
    assert_eq!(b.read(&c, 0x1010, 8), Ok(0x1122));
    fn fault<T>(addr: u64, access: Access, kind: FaultKind) -> Result<T, Fault> {
        Err(Fault { addr, access, kind })
    }
    assert_eq!(
        b.write(&c, 0x1010, 8, 1),
        fault(0x1010, Access::Write, FaultKind::Permission(3))
    );
    assert_eq!(
        b.read(&c, 0x7008, 4),
        fault(0x7008, Access::Read, FaultKind::Translation(3))
    );
    assert_eq!(b.fetch(&c, 0x1000), Ok(0)); // EL1 may execute what EL0 can't write
    assert_eq!(
        b.fetch(&c, 0x7000),
        fault(0x7000, Access::Read, FaultKind::Translation(3))
    );
    c.set_pstate(M_EL0T);
    assert_eq!(b.read(&c, 0x1010, 8), Ok(0x1122));
    // Remap 0x1000 from PA 0x9000 to 0xa000: the TLB keeps the old
    // translation until a TLBI.
    p.r.mem.write(0x9010, 8, 0x3344).unwrap();
    p.r.mem.write(0xa010, 8, 0x5566).unwrap();
    let l3 = {
        let l0 = p.r.mem.read(ROOT0, 8).unwrap() & OA_MASK;
        let l1 = p.r.mem.read(l0, 8).unwrap() & OA_MASK;
        p.r.mem.read(l1, 8).unwrap() & OA_MASK
    };
    p.r.mem.write(l3 + 8, 8, 0xa000 | PAGE | AP_EL0_RO).unwrap();
    assert_eq!(b.read(&c, 0x1010, 8), Ok(0x3344)); // cached
    b.flush_va(0x1000);
    assert_eq!(b.read(&c, 0x1010, 8), Ok(0x5566));
    // Without a TLB, every access walks.
    let mut nb = Bus::new(&p.r.mem, None);
    p.r.mem.write(l3 + 8, 8, 0x9000 | PAGE | AP_EL0_RO).unwrap();
    assert_eq!(nb.read(&c, 0x1010, 8), Ok(0x3344));
}

#[test]
fn page_crossing() {
    let mut p = Pt::new();
    // Two adjacent VA pages on non-adjacent PA pages.
    p.map(0x1000, 3, 0xb000 | PAGE);
    p.map(0x2000, 3, 0x8000 | PAGE);
    let c = cpu();
    let mut v = Vcpu::new(c.clone());
    let mut b = Bus::new(&p.r.mem, Some(&mut v.tlb));
    b.write(&c, 0x1ffc, 8, 0x8877_6655_4433_2211).unwrap();
    assert_eq!(p.r.mem.read(0xbffc, 4), Ok(0x4433_2211));
    assert_eq!(p.r.mem.read(0x8000, 4), Ok(0x8877_6655));
    assert_eq!(b.read(&c, 0x1ffe, 4), Ok(0x6655_4433));
    // The second page faulting leaves the first untouched.
    let fault = Err(Fault {
        addr: 0x3000,
        access: Access::Write,
        kind: FaultKind::Translation(3),
    });
    assert_eq!(b.write(&c, 0x2ffc, 8, 0), fault);
    assert_eq!(p.r.mem.read(0x8ffc, 4), Ok(0));
    // SCTLR_EL1.A makes every misaligned access fault first.
    let a = Cpu {
        sctlr_el1: c.sctlr_el1 | sctlr::A,
        ..c
    };
    let r = b.read(&a, 0x1ffe, 4).unwrap_err();
    assert_eq!((r.addr, r.kind), (0x1ffe, FaultKind::Align));
    assert_eq!(b.read(&a, 0x1ff8, 8), Ok(0x4433_2211 << 32));
}

#[test]
fn address_translation_instruction() {
    let mut p = Pt::new();
    p.map(0x1000, 3, 0x9000 | PAGE | AP_EL0_RO | 1 << 2 | 3 << 8);
    let c = cpu();
    assert_eq!(
        at(&c, &p.r.mem, 0x1234, 1, Use::Read),
        0x44 << 56 | 0x9000 | 3 << 7 | 1 << 11
    );
    assert_eq!(
        at(&c, &p.r.mem, 0x1234, 0, Use::Write),
        0x0f << 1 | 1 << 11 | 1
    ); // permission, level 3
    assert_eq!(
        at(&c, &p.r.mem, 0x2000, 1, Use::Read),
        0x07 << 1 | 1 << 11 | 1
    ); // translation, level 3
    let off = Cpu {
        sctlr_el1: sctlr::RES1,
        ..c
    };
    assert_eq!(
        at(&off, &p.r.mem, 0x1234, 1, Use::Read),
        0x1000 | 2 << 7 | 1 << 11
    );
}

#[test]
fn asid_follows_a1_and_as() {
    let mut c = cpu();
    (c.ttbr0_el1, c.ttbr1_el1) = (0x1234 << 48 | ROOT0, 0x5678 << 48 | ROOT1);
    assert_eq!(asid(&c), 0x34);
    c.tcr_el1 |= 1 << 36; // 16-bit ASIDs
    assert_eq!(asid(&c), 0x1234);
    c.tcr_el1 |= 1 << 22; // A1: from TTBR1
    assert_eq!(asid(&c), 0x5678);
}

#[test]
fn atomics_mmu_off() {
    let r = TestRam::new(64);
    let c = Cpu::default();
    let mut b = Bus::new(&r.mem, None);
    for size in [1, 2, 4, 8] {
        let a = 4 * size as u64;
        let top = u64::MAX >> (64 - 8 * size);
        assert_eq!(b.cas(&c, a, size, 1, 5).unwrap(), 0); // fails, old = 0
        assert_eq!(b.cas(&c, a, size, 0, top).unwrap(), 0);
        assert_eq!(b.read_atomic(&c, a, size).unwrap(), top);
        assert_eq!(
            b.rmw(&c, a, size, |v| v.wrapping_add(2) & top).unwrap(),
            top
        );
        assert_eq!(b.read(&c, a, size).unwrap(), 1);
    }
    assert_eq!(b.cas_pair(&c, 48, 8, [0, 0], [7, 9]).unwrap(), [0, 0]);
    assert_eq!(b.cas_pair(&c, 48, 8, [7, 0], [1, 1]).unwrap(), [7, 9]);
    assert_eq!(b.read_pair(&c, 48, 8).unwrap(), [7, 9]);
    let align = |addr, access| {
        Err(Fault {
            addr,
            access,
            kind: FaultKind::Align,
        })
    };
    assert_eq!(b.read_atomic(&c, 4, 8), align(4, Access::Read));
    assert_eq!(b.rmw(&c, 4, 8, |v| v), align(4, Access::Write));
    assert_eq!(
        b.cas_pair(&c, 8, 8, [0; 2], [1; 2]).map(|_| 0),
        align(8, Access::Write)
    );
}
