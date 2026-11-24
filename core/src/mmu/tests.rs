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
    // A fetch from a tagged PC translates, but never fills the instruction
    // TLB (the dispatcher strips the tag: docs/jit.md "Linking"); its data
    // reads do fill the read array.
    p.r.mem.write(0x7010, 4, 0xd503201f).unwrap();
    let mut v = Vcpu::new(tbi.clone());
    let mut b = Mmu::new(&p.r.mem, Some(&mut v.tlb));
    assert_eq!(b.fetch(&tbi, tagged), Ok(0xd503201f));
    assert_eq!(b.fetch(&tbi, tagged), Ok(0xd503201f));
    assert_eq!(b.read(&tbi, tagged, 4), Ok(0xd503201f));
    assert_eq!(b.read(&tbi, tagged, 4), Ok(0xd503201f));
    let t = b.tlb.as_ref().unwrap();
    assert_eq!(t.stats.walks, 3, "two fetches and a read");
    let e = &t.e[index(tagged)].0;
    assert_eq!(
        e[3 + Use::Exec as usize].tag & 0xfff,
        0,
        "no instruction TLB entry"
    );
    assert_eq!(e[3 + Use::Read as usize].tag | 0xfff, tagged | 0xfff);
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
    let mut b = Mmu::new(&p.r.mem, Some(&mut v.tlb));
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
    let mut nb = Mmu::new(&p.r.mem, None);
    p.r.mem.write(l3 + 8, 8, 0x9000 | PAGE | AP_EL0_RO).unwrap();
    assert_eq!(nb.read(&c, 0x1010, 8), Ok(0x3344));
}

/// A TLBI by any VA of a block drops the entries of all its pages (Linux
/// unmaps a transparent huge page with one, at its start).
#[test]
fn flush_by_va_drops_a_whole_block() {
    const VA: u64 = 0x4000_0000;
    let mut p = Pt::new();
    p.map(VA, 2, 0x20_0000 | BLOCK);
    p.map(0x1000, 3, 0x9000 | PAGE);
    for (pa, v) in [
        (0x20_3010, 1),
        (0x20_5010, 2),
        (0x3010, 3),
        (0x5010, 4),
        (0x9010, 5),
    ] {
        p.r.mem.write(pa, 8, v).unwrap();
    }
    let c = cpu();
    let mut v = Vcpu::new(c.clone());
    let mut b = Mmu::new(&p.r.mem, Some(&mut v.tlb));
    let read = |b: &mut Mmu| (b.read(&c, VA + 0x3010, 8), b.read(&c, VA + 0x5010, 8));
    assert_eq!(read(&mut b), (Ok(1), Ok(2)));
    assert_eq!(b.read(&c, 0x1010, 8), Ok(5));
    // Remapped to PA 0: cached until a TLBI, and one at the block's start
    // drops both pages; a TLBI elsewhere drops none.
    let l2 = {
        let l1 = p.r.mem.read(ROOT0, 8).unwrap() & OA_MASK;
        p.r.mem.read(l1 + 8, 8).unwrap() & OA_MASK
    };
    p.r.mem.write(l2, 8, BLOCK).unwrap();
    b.flush_va(VA + 0x20_0000);
    b.flush_va(0x1000);
    assert_eq!(read(&mut b), (Ok(1), Ok(2)));
    b.flush_va(VA);
    assert_eq!(read(&mut b), (Ok(3), Ok(4)));
    // The counts follow entries overwritten and dropped: none left after
    // dropping the block's again.
    b.flush_va(VA + 0x1f_f000);
    assert!(v.tlb.rblk.iter().all(|&n| n == 0));
}

/// `Tlb::rblk` counts a block's live entries in its own bucket: a flush by VA
/// in another block of the class finds 0 there and scans nothing.
#[test]
fn block_counts_follow_their_block() {
    const A: u64 = 0xffff_8000_0040_0000; // a 2 MiB block in the high half
    let k = block_class(A, 2);
    let (a, next) = (rblk_bucket(k, A), rblk_bucket(k, A + 0x20_0000));
    assert_ne!(a, next);
    assert_eq!(rblk_bucket(k, A + 0x1f_f000), a);
    assert_ne!(rblk_bucket(block_class(A, 1), A), a); // the 1 GiB block holding it
    let mut v = Vcpu::new(cpu());
    let t = &mut v.tlb;
    t.fill(
        3 + Use::Read as usize,
        A + 0x5000,
        Host(0x5000),
        false,
        2,
        false,
    );
    t.fill(
        3 + Use::Exec as usize,
        A + 0x6000,
        Host(0x6000),
        false,
        2,
        false,
    );
    assert_eq!((t.rblk[a], t.rblk[next]), (2, 0));
    assert_eq!(t.xblkn, [[0, 0], [0, 1]]); // EL1's instruction TLB, high half
    t.flush_va(A + 0x20_0000);
    assert_eq!(t.rblk[a], 2);
    t.flush_va(A + 0x1f_f000);
    assert!(t.rblk.iter().all(|&n| n == 0));
    assert!(t.blk.iter().all(|&b| b == 0));
    assert_eq!(t.xblkn, [[0; 2]; 2]);
    // With none left, a bump clears the flag that sent flushes there to it.
    assert!(t.xblk[1][1]);
    t.bump();
    assert!(!t.xblk[1][1]);
}

/// The TLB against a fresh walk, on tables remapped at random with the TLBIs
/// Linux would send (one VA of a block for the block, each page's for
/// pages): 1 GiB and 2 MiB blocks and pages in both halves, at VAs whose TLB
/// indices coincide, some read-only (a read's walk must not let a write
/// through, nor a remap to read-only without its TLBI), read, written and
/// fetched at EL1.
#[test]
fn tlb_matches_a_fresh_walk_through_remaps() {
    const REGIONS: [u64; 4] = [
        0x4000_0000,
        0x8000_0000,
        0xffff_0000_4000_0000,
        0xffff_0000_8000_0000,
    ];
    const PAGES: u64 = 8; // an L3 table's pages mapped
    let c = cpu();
    for seed in 0..6u64 {
        let mut rng = crate::rng::Rng::new([seed, 1, 2, 3], 0);
        let mut p = Pt::new();
        // Each region: its L1 slot, its L2 table, two L3 tables; states.
        let mut l1 = [0u64; 4];
        let mut l2 = [0u64; 4];
        let mut l3 = [[0u64; 2]; 4];
        for (r, &base) in REGIONS.iter().enumerate() {
            for j in 0..2 {
                p.map(base + (j << 21), 3, PAGE);
            }
            let root = if base >> 55 & 1 == 1 { ROOT1 } else { ROOT0 };
            let t1 = p.r.mem.read(root + 8 * (base >> 39 & 511), 8).unwrap() & OA_MASK;
            l1[r] = t1 + 8 * (base >> 30 & 511);
            l2[r] = p.r.mem.read(l1[r], 8).unwrap() & OA_MASK;
            for (j, t3) in l3[r].iter_mut().enumerate() {
                *t3 = p.r.mem.read(l2[r] + 8 * j as u64, 8).unwrap() & OA_MASK;
            }
        }
        // Every page's last word says which page it is.
        for pa in (0..RAM as u64).step_by(0x1000) {
            p.r.mem.write(pa + 0xff8, 8, pa | 0x5a).unwrap();
        }
        let mut v = Vcpu::new(c.clone());
        let mut flushes = Vec::new();
        let mut draw = |n: u64| rng.draw() % n;
        for op in 0..3000 {
            let r = draw(4) as usize;
            let base = REGIONS[r];
            let mem = &p.r.mem;
            let d1 = mem.read(l1[r], 8).unwrap();
            let d2 = |j: usize| mem.read(l2[r] + 8 * j as u64, 8).unwrap();
            // The TLBIs that drop what a level 2 slot's mapping cached.
            let drop2 = |j: usize, draw: &mut dyn FnMut(u64) -> u64, f: &mut Vec<u64>| {
                let at = base + ((j as u64) << 21);
                match d2(j) & 3 {
                    1 => f.push(at + (draw(512) << 12)),
                    3 => f.extend((0..PAGES).map(|i| at + (i << 12))),
                    _ => {}
                }
            };
            match draw(8) {
                0 => {
                    // Level 1: invalid, a 1 GiB block at PA 0 or the table.
                    match d1 & 3 {
                        1 => flushes.push(base + (draw(1 << 18) << 12)),
                        3 => (0..2).for_each(|j| drop2(j, &mut draw, &mut flushes)),
                        _ => {}
                    }
                    let d = [0, BLOCK, l2[r] | TABLE][draw(3) as usize];
                    p.r.mem.write(l1[r], 8, d).unwrap();
                }
                1 => {
                    // Level 2: invalid, a 2 MiB block or the L3 table.
                    let j = draw(2) as usize;
                    if d1 & 3 == 3 {
                        drop2(j, &mut draw, &mut flushes);
                    }
                    let d = [0, BLOCK, 0x20_0000 | BLOCK, l3[r][j] | TABLE, BLOCK | AP_RO]
                        [draw(5) as usize];
                    p.r.mem.write(l2[r] + 8 * j as u64, 8, d).unwrap();
                }
                2 => {
                    // A page of an L3 table, to another PA.
                    let (j, i) = (draw(2) as usize, draw(PAGES));
                    if d1 & 3 == 3 && d2(j) & 3 == 3 {
                        flushes.push(base + ((j as u64) << 21) + (i << 12));
                    }
                    let ro = if draw(3) == 0 { AP_RO } else { 0 };
                    let d = draw(RAM as u64 >> 12) << 12 | PAGE | ro;
                    p.r.mem.write(l3[r][j] + 8 * i, 8, d).unwrap();
                }
                _ => {
                    // An access: a mapped page of an L3 table or anywhere
                    // in the first 4 MiB (all of the RAM a block reaches).
                    let off = if draw(2) == 0 {
                        draw(2) << 21 | draw(PAGES) << 12
                    } else {
                        draw(1 << 10) << 12
                    };
                    let va = base + off + 0xff8;
                    let mut b = Mmu::new(&p.r.mem, Some(&mut v.tlb));
                    let mut fresh = Mmu::new(&p.r.mem, None);
                    let (got, want) = match draw(3) {
                        0 => (b.read(&c, va, 8), fresh.read(&c, va, 8)),
                        1 => (
                            b.fetch(&c, va).map(u64::from),
                            fresh.fetch(&c, va).map(u64::from),
                        ),
                        _ => {
                            let w = fresh.read(&c, va, 8).unwrap_or(0);
                            (
                                b.write(&c, va, 8, w).map(|_| w),
                                fresh.write(&c, va, 8, w).map(|_| w),
                            )
                        }
                    };
                    assert_eq!(got, want, "seed {seed}, op {op}, VA {va:#x}");
                }
            }
            let mut b = Mmu::new(&p.r.mem, Some(&mut v.tlb));
            for va in flushes.drain(..) {
                b.flush_va(va);
            }
            if op % 500 == 499 {
                // The counts are the live entries'.
                let t = &v.tlb;
                let mut n = [0u32; RBLK];
                for s in 0..TLB_ENTRIES * TLB_SLOTS {
                    let k = t.blk[s] & CLASS;
                    if k != 0 {
                        n[rblk_bucket(k, t.e[s / TLB_SLOTS].0[s % TLB_SLOTS].tag)] += 1;
                    }
                }
                assert!(
                    n == t.rblk,
                    "seed {seed}, op {op}: the block counts drifted"
                );
            }
        }
    }
}

#[test]
fn page_crossing() {
    let mut p = Pt::new();
    // Two adjacent VA pages on non-adjacent PA pages.
    p.map(0x1000, 3, 0xb000 | PAGE);
    p.map(0x2000, 3, 0x8000 | PAGE);
    let c = cpu();
    let mut v = Vcpu::new(c.clone());
    let mut b = Mmu::new(&p.r.mem, Some(&mut v.tlb));
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
fn device_memory_faults_misaligned_accesses() {
    // MAIR attribute 2 is Device-nGnRnE: a misaligned data access to it is an
    // alignment fault, the first time (the walk) and after (its TLB entry,
    // which no fast path takes); aligned ones, fetches and cache maintenance
    // go through. Normal memory next to it doesn't care.
    const DEV: u64 = 2 << 2;
    let mut p = Pt::new();
    p.map(0x2000, 3, 0x9000 | PAGE);
    p.map(0x3000, 3, 0xa000 | PAGE | DEV);
    p.map(0x4000, 3, (RAM as u64 + 0x1000) | PAGE | DEV); // nothing there (MMIO)
    p.r.mem.write(0xa008, 8, 0x1122_3344_5566_7788).unwrap();
    let c = Cpu {
        mair_el1: 0x44ff,
        ..cpu()
    };
    let mut v = Vcpu::new(c.clone());
    let mut b = Mmu::new(&p.r.mem, Some(&mut v.tlb));
    let align = |addr, access| {
        Err(Fault {
            addr,
            access,
            kind: FaultKind::Align,
        })
    };
    for _ in 0..2 {
        assert_eq!(b.read(&c, 0x3008, 8), Ok(0x1122_3344_5566_7788));
        assert_eq!(b.read(&c, 0x300c, 4), Ok(0x1122_3344));
        assert_eq!(b.read(&c, 0x300a, 4), align(0x300a, Access::Read));
        assert_eq!(
            b.write(&c, 0x3001, 2, 0).map(|_| 0),
            align(0x3001, Access::Write)
        );
        assert!(b.fast(&c, 0x3008, 8, Use::Read).is_none());
    }
    assert_eq!(b.fetch(&c, 0x3008), Ok(0x5566_7788));
    assert_eq!(b.maint(&c, 0x3003, false), Ok(Some(0xa003)));
    // A page-crossing access into or out of Device memory.
    assert_eq!(b.read(&c, 0x2ffc, 8), align(0x2ffc, Access::Read));
    assert_eq!(b.read(&c, 0x3ffe, 4), align(0x3ffe, Access::Read));
    // Normal memory: misaligned is fine, across into Normal memory too.
    assert_eq!(b.read(&c, 0x2001, 2), Ok(0));
    // A device's registers: misaligned faults before the bus is asked.
    assert_eq!(b.read(&c, 0x4002, 4), align(0x4002, Access::Read));
    assert_eq!(
        b.read(&c, 0x4004, 4).map_err(|f| f.kind),
        Err(FaultKind::Bus)
    );
}

#[test]
fn device_pages_are_cached_as_the_bus() {
    // A page with no RAM behind it (a device's registers, or nothing) is cached in the data arrays as one with
    // `MMIO`'s index: the next access goes to the bus without a walk, the entry gives the PA (`mmio_pa`), the
    // fetch array isn't filled, misaligned accesses to Device memory still fault, and a TLBI drops the entry.
    const DEV: u64 = 2 << 2;
    let mut p = Pt::new();
    let mmio = RAM as u64 + 0x5000;
    p.map(0x4000, 3, mmio | PAGE | DEV);
    p.map(0x6000, 3, (mmio + 0x1000) | PAGE); // Normal memory, nothing there
    let c = cpu();
    let mut v = Vcpu::new(c.clone());
    let mut b = Mmu::new(&p.r.mem, Some(&mut v.tlb));
    let bus = |r: Result<u64, Fault>| r.map_err(|f| (f.addr, f.access, f.kind));
    for k in 0..3 {
        assert_eq!(
            bus(b.read(&c, 0x4008, 4)),
            Err((0x4008, Access::Read, FaultKind::Bus))
        );
        assert_eq!(
            b.write(&c, 0x400c, 4, 1)
                .map_err(|f| (f.addr, f.access, f.kind)),
            Err((0x400c, Access::Write, FaultKind::Bus))
        );
        assert_eq!(
            bus(b.read(&c, 0x6002, 4)),
            Err((0x6002, Access::Read, FaultKind::Bus))
        );
        assert_eq!(
            b.tlb.as_ref().unwrap().stats.walks,
            3,
            "walks after round {k}"
        );
    }
    assert_eq!(b.mmio_pa(0x4ff8, 1, Use::Read), Some(mmio + 0xff8));
    assert_eq!(b.mmio_pa(0x4010, 1, Use::Write), Some(mmio + 0x10));
    assert_eq!(b.mmio_pa(0x6000, 1, Use::Read), Some(mmio + 0x1000));
    assert_eq!(b.mmio_pa(0x5000, 1, Use::Read), None);
    assert_eq!(b.mmio_pa(0x4000, 0, Use::Read), None); // EL0's array
    assert!(b.fast(&c, 0x4008, 4, Use::Read).is_none());
    // Device memory: misaligned faults on the entry too; Normal memory goes to the bus.
    assert_eq!(
        bus(b.read(&c, 0x400a, 4)),
        Err((0x400a, Access::Read, FaultKind::Align))
    );
    assert_eq!(
        bus(b.read(&c, 0x6001, 4)),
        Err((0x6001, Access::Read, FaultKind::Bus))
    );
    // A fetch walks (no entry) and faults on the bus; maintenance finds no RAM.
    assert_eq!(b.fetch(&c, 0x4000).map_err(|f| f.kind), Err(FaultKind::Bus));
    assert_eq!(b.maint(&c, 0x4000, false), Ok(None));
    assert_eq!(b.mmio_pa(0x4000, 1, Use::Exec), None);
    // Remapped and flushed: the new PA.
    p.map(0x4000, 3, (mmio + 0x2000) | PAGE | DEV);
    let mut b = Mmu::new(&p.r.mem, Some(&mut v.tlb));
    b.flush_va(0x4000);
    assert_eq!(b.mmio_pa(0x4000, 1, Use::Read), None);
    assert!(b.read(&c, 0x4000, 4).is_err());
    assert_eq!(b.mmio_pa(0x4004, 1, Use::Read), Some(mmio + 0x2004));
}

#[test]
fn cache_maintenance_first_keeps_a_device_page_device() {
    // DC CVAC (the read array) or DC IVAC (the write array) on a Device page
    // before any data access fills its entry: that entry is still a Device
    // page's, so a misaligned access after it is an alignment fault.
    const DEV: u64 = 2 << 2;
    let mut p = Pt::new();
    p.map(0x3000, 3, 0xa000 | PAGE | DEV);
    let c = Cpu {
        mair_el1: 0x44ff,
        ..cpu()
    };
    let mut v = Vcpu::new(c.clone());
    let mut b = Mmu::new(&p.r.mem, Some(&mut v.tlb));
    let align = |addr, access| {
        Err(Fault {
            addr,
            access,
            kind: FaultKind::Align,
        })
    };
    assert_eq!(b.maint(&c, 0x3000, false), Ok(Some(0xa000)));
    assert_eq!(b.read(&c, 0x300a, 4), align(0x300a, Access::Read));
    assert!(b.fast(&c, 0x3008, 8, Use::Read).is_none());
    assert_eq!(b.maint(&c, 0x3000, true), Ok(Some(0xa000)));
    assert_eq!(
        b.write(&c, 0x3001, 2, 0).map(|_| 0),
        align(0x3001, Access::Write)
    );
    assert!(b.fast(&c, 0x3008, 8, Use::Write).is_none());
    // Aligned accesses and the maintenance itself still go through.
    assert_eq!(b.read(&c, 0x3008, 8), Ok(0));
    assert_eq!(b.maint(&c, 0x3003, true), Ok(Some(0xa003)));
}

#[test]
fn past_the_pa_size_with_the_mmu_off() {
    // An address size fault at level 0 (`AArch64.S1DisabledOutput`), through
    // either bus and for every kind of access; below the PA size, nothing
    // there is still an external abort.
    let r = TestRam::new(64);
    let c = Cpu::default();
    let (far, near) = (1 << PA_BITS, (1 << PA_BITS) - 8);
    let kind = |r: Result<u64, Fault>| r.map_err(|f| f.kind);
    let size = Err(FaultKind::AddressSize(0));
    let mut flat = Flat(&r.mem);
    let mut mmu = Mmu::new(&r.mem, None);
    for b in [&mut flat as &mut dyn Bus, &mut mmu] {
        assert_eq!(kind(b.read(&c, far, 8)), size);
        assert_eq!(kind(b.read(&c, u64::MAX - 7, 8)), size);
        assert_eq!(kind(b.write(&c, far, 4, 0).map(|_| 0)), size);
        assert_eq!(kind(b.fetch(&c, far).map(u64::from)), size);
        assert_eq!(kind(b.read_atomic(&c, far, 8)), size);
        assert_eq!(kind(b.maint(&c, far, false).map(|_| 0)), size);
        assert_eq!(kind(b.read(&c, near, 8)), Err(FaultKind::Bus));
        assert_eq!(b.maint(&c, near, false), Ok(None));
    }
    assert_eq!(at(&c, &r.mem, far, 1, Use::Read), 1 << 11 | 1);
}

#[test]
fn atomics_mmu_off() {
    let r = TestRam::new(64);
    let c = Cpu::default();
    let mut b = Mmu::new(&r.mem, None);
    for size in [1, 2, 4, 8] {
        let a = 4 * size as u64;
        let top = u64::MAX >> (64 - 8 * size);
        assert_eq!(b.cas(&c, a, size, 1, 5).unwrap(), 0); // fails, old = 0
        assert_eq!(b.cas(&c, a, size, 0, top).unwrap(), 0);
        assert_eq!(b.read_atomic(&c, a, size).unwrap(), top);
        assert_eq!(b.rmw(&c, a, size, 0, 2).unwrap(), top);
        assert_eq!(b.read(&c, a, size).unwrap(), 1);
    }
    assert_eq!(b.cas_pair(&c, 48, [0, 0], [7, 9]).unwrap(), [0, 0]);
    assert_eq!(b.cas_pair(&c, 48, [7, 0], [1, 1]).unwrap(), [7, 9]);
    assert_eq!(b.read_pair(&c, 48).unwrap(), [7, 9]);
    let align = |addr, access| {
        Err(Fault {
            addr,
            access,
            kind: FaultKind::Align,
        })
    };
    assert_eq!(b.read_atomic(&c, 4, 8), align(4, Access::Read));
    assert_eq!(b.rmw(&c, 4, 8, 8, 0), align(4, Access::Write));
    assert_eq!(
        b.cas_pair(&c, 8, [0; 2], [1; 2]).map(|_| 0),
        align(8, Access::Write)
    );
}

#[test]
fn asid_changes_keep_global_entries() {
    const NG: u64 = 1 << 11;
    let mut p = Pt::new();
    p.map(0x1000, 3, 0x9000 | PAGE); // global
    p.map(0x2000, 3, 0xa000 | PAGE | NG);
    p.r.mem.write(0x9000, 8, 1).unwrap();
    p.r.mem.write(0xa000, 8, 2).unwrap();
    p.r.mem.write(0xb000, 8, 3).unwrap();
    const MANY: u64 = 0x10_0001_0000; // TLB indices from 16: clear of 0x1000 and 0x2000
    for i in 0..NG_SLOTS as u64 + 1 {
        p.map(MANY + (i << 12), 3, 0xa000 | PAGE | NG);
    }
    let c = cpu();
    let mut v = Vcpu::new(c.clone());
    let mut b = Mmu::new(&p.r.mem, Some(&mut v.tlb));
    assert_eq!(
        (b.read(&c, 0x1000, 8), b.read(&c, 0x2000, 8)),
        (Ok(1), Ok(2))
    );
    assert!(b.fetch(&c, 0x2000).is_ok());
    // Remap both to PA 0xb000: only the nG translations are dropped.
    let l3 = {
        let l0 = p.r.mem.read(ROOT0, 8).unwrap() & OA_MASK;
        let l1 = p.r.mem.read(l0, 8).unwrap() & OA_MASK;
        p.r.mem.read(l1, 8).unwrap() & OA_MASK
    };
    p.r.mem.write(l3 + 8, 8, 0xb000 | PAGE).unwrap();
    p.r.mem.write(l3 + 16, 8, 0xb000 | PAGE | NG).unwrap();
    b.flush_ng();
    assert_eq!(
        (b.read(&c, 0x1000, 8), b.read(&c, 0x2000, 8)),
        (Ok(1), Ok(3))
    );
    b.flush_all();
    assert_eq!(b.read(&c, 0x1000, 8), Ok(3));
    // Past the list's capacity, dropping the nG entries still keeps the
    // global ones and finds every nG one, the first filled and the last.
    assert_eq!(b.read(&c, 0x2000, 8), Ok(3));
    for i in 0..NG_SLOTS as u64 + 1 {
        assert_eq!(b.read(&c, MANY + (i << 12), 8), Ok(2));
    }
    let last = MANY + ((NG_SLOTS as u64) << 12);
    p.r.mem.write(l3 + 8, 8, 0x9000 | PAGE).unwrap();
    p.r.mem.write(l3 + 16, 8, 0x9000 | PAGE | NG).unwrap();
    for va in [MANY, last] {
        let mut t = ROOT0;
        for level in 0..3 {
            t =
                p.r.mem
                    .read(t + 8 * (va >> (39 - 9 * level) & 511), 8)
                    .unwrap()
                    & OA_MASK;
        }
        p.r.mem
            .write(t + 8 * (va >> 12 & 511), 8, 0x9000 | PAGE | NG)
            .unwrap();
    }
    b.flush_ng();
    assert_eq!(
        (b.read(&c, 0x1000, 8), b.read(&c, 0x2000, 8)),
        (Ok(3), Ok(1))
    );
    assert_eq!((b.read(&c, MANY, 8), b.read(&c, last, 8)), (Ok(1), Ok(1)));
    b.flush_all();
    assert_eq!(b.read(&c, 0x1000, 8), Ok(1));
}

#[test]
fn unprivileged_accesses_use_el0_permissions() {
    use crate::interp::{Exit, steps};
    let mut p = Pt::new();
    p.map(0x1000, 3, 0x9000 | PAGE | UXN); // code, EL1 only
    p.map(0x2000, 3, 0xa000 | PAGE | AP_EL0_RW | PXN);
    p.map(0x3000, 3, 0xb000 | PAGE); // EL1 only
    p.r.mem.write(0xa008, 8, 0x1234).unwrap();
    p.r.mem.write(0xb008, 8, 0x5678).unwrap();
    // ldtr x0, [x1, #8]; sttr x0, [x2, #8]
    p.r.mem.write(0x9000, 4, 0xf8408820).unwrap();
    p.r.mem.write(0x9004, 4, 0xf8008840).unwrap();
    let mut v = Vcpu::new(cpu());
    let run = |v: &mut Vcpu, x1: u64, x2: u64| {
        (v.cpu.x[0], v.cpu.x[1], v.cpu.x[2], v.cpu.pc) = (0, x1, x2, 0x1000);
        steps(&mut v.cpu, &p.r.mem, Some(&mut v.tlb), 2)
    };
    assert!(matches!(run(&mut v, 0x2000, 0x2000), (2, None)));
    assert_eq!(v.cpu.x[0], 0x1234);
    // EL1 may read and write 0x3000, but LDTR and STTR at EL1 may not.
    let perm = |addr, access| Fault {
        addr,
        access,
        kind: FaultKind::Permission(3),
    };
    assert_eq!(
        run(&mut v, 0x3000, 0x2000),
        (0, Some(Exit::Fault(perm(0x3008, Access::Read))))
    );
    assert_eq!(
        run(&mut v, 0x2000, 0x3000),
        (1, Some(Exit::Fault(perm(0x3008, Access::Write))))
    );
    assert_eq!(p.r.mem.read(0xb008, 8), Ok(0x5678));
}

/// The transfer cache's entries carry their EL's generation when they were
/// filled: flushes start new ones, and one that wraps clears the table.
/// Dropping the nG entries starts an EL's only if its instruction TLB may
/// hold some.
#[test]
fn transfer_cache_entries_die_with_their_generation() {
    let mut v = Vcpu::new(cpu());
    let t = &mut v.tlb;
    let live = |t: &Tlb, va: u64, regime: u64| {
        let e = t.xc[(va >> 2) as usize & (XC_ENTRIES - 1)];
        e.tag == va | regime && e.to >> 48 == t.xgen[regime as usize & 1]
    };
    // A zeroed entry never matches, even for VA 0 in regime 0.
    assert!(t.xgen == [1, 1] && t.xc[0].to >> 48 != t.xgen[0]);
    t.xc_fill(0x1000, 3, 7, 4);
    assert!(live(t, 0x1000, 3) && t.xc[0x400].to & 0xffff_ffff_ffff == 4 << 32 | 7);
    t.xc_fill(0x2000, 2, 7, 4);
    t.flush_all();
    assert!(!live(t, 0x1000, 3) && !live(t, 0x2000, 2));
    // A flush by VA drops its page's entries, whatever their top byte (TBI),
    // once instruction fetches translated it (as they had for any entry).
    t.fetched(1, 0x1000, false);
    t.fetched(0, 0x1000, false);
    t.fetched(1, 0x5000, false);
    t.xc_fill(0x1000, 3, 7, 4);
    t.xc_fill(0x1ffc, 2, 7, 4);
    t.xc_fill(0x2000, 2, 7, 4);
    t.xc_fill(0x5004, 3, 7, 4); // among the page's slots, in another page
    assert!(live(t, 0x1000, 3) && live(t, 0x1ffc, 2));
    t.flush_va(0xab00_0000_0000_1234);
    assert!(!live(t, 0x1000, 3) && !live(t, 0x1ffc, 2));
    assert!(live(t, 0x2000, 2) && live(t, 0x5004, 3));
    // An EL1 entry outlives an ASID change while EL1's instruction TLB
    // holds only global entries; EL0's dies once an nG one was filled there.
    t.xc_fill(0x1000, 3, 7, 4);
    t.xc_fill(0x2000, 2, 7, 4);
    t.fill(Use::Exec as usize, 0x2000, Host(0x2000), true, 3, false);
    t.fill(3 + Use::Read as usize, 0x5000, Host(0x5000), true, 3, false);
    t.flush_ng();
    assert!(live(t, 0x1000, 3) && !live(t, 0x2000, 2));
    t.fill(3 + Use::Exec as usize, 0x1000, Host(0x1000), true, 3, false);
    t.flush_ng();
    assert!(!live(t, 0x1000, 3));
    // Blocks dropped: all of it.
    t.xc_fill(0x1000, 3, 7, 4);
    t.bump();
    assert!(!live(t, 0x1000, 3));
    t.xgen = [5, 0xffff];
    t.xc_fill(0x1000, 3, 7, 4);
    t.bump();
    assert_eq!((t.xgen, t.xc[0x400].to), ([1, 1], 0));
}

/// A flush by VA scans the transfer cache only for a page that instruction
/// fetches translated (`Tlb::xpages`), by EL, global or nG and VA half: the
/// nG pages' marks go with the nG entries, the global ones' with everything,
/// and neither with the transfer cache's entries alone (the TLB's may fill
/// them again without a walk).
#[test]
fn a_flush_by_va_scans_the_transfer_cache_for_fetched_pages() {
    const HI: u64 = 0xffff_0000_0000_3000;
    let mut p = Pt::new();
    p.map(0x1000, 3, 0x9000 | PAGE); // global, EL1
    p.map(0x2000, 3, 0xa000 | PAGE | AP_EL0_RW | PXN | 1 << 11); // EL0, nG
    p.map(HI, 3, 0xb000 | PAGE);
    p.map(0x4000, 3, 0xc000 | PAGE | 1 << 11); // nG, EL1
    let el0 = Cpu {
        pstate: M_EL0T,
        ..cpu()
    };
    let mut v = Vcpu::new(cpu());
    let live = |t: &Tlb, va: u64, regime: u64| {
        let e = t.xc[(va >> 2) as usize & (XC_ENTRIES - 1)];
        e.tag == va | regime && e.to >> 48 == t.xgen[regime as usize & 1]
    };
    // Fetched, filled, flushed: gone.
    let fetch = |v: &mut Vcpu, c: &Cpu, va: u64| {
        Mmu::new(&p.r.mem, Some(&mut v.tlb)).fetch(c, va).unwrap();
    };
    fetch(&mut v, &cpu(), 0x1000);
    fetch(&mut v, &el0, 0x2000);
    fetch(&mut v, &cpu(), HI);
    v.tlb.xc_fill(0x1000, 3, 7, 4);
    v.tlb.xc_fill(0x2004, 2, 7, 4);
    v.tlb.xc_fill(HI, 3, 7, 4);
    v.tlb.flush_va(0x2000);
    v.tlb.flush_va(HI);
    assert!(live(&v.tlb, 0x1000, 3));
    assert!(!live(&v.tlb, 0x2004, 2) && !live(&v.tlb, HI, 3));
    // A page no fetch translated (a data page) isn't scanned: an entry there
    // (which nothing fills) stays.
    v.tlb.xc_fill(0x7000, 3, 7, 4);
    v.tlb.flush_va(0x7000);
    assert!(live(&v.tlb, 0x7000, 3));
    // The other half's page of the same number isn't fetched either.
    v.tlb.xc_fill(0x3000, 3, 7, 4);
    v.tlb.flush_va(0x3000);
    assert!(live(&v.tlb, 0x3000, 3));
    v.tlb.flush_all();
    // Dropping the nG entries keeps the global page's mark (its TLB entry
    // stays, and fills the transfer cache again without a walk), also where
    // they were EL1's and its transfer cache entries went with them.
    fetch(&mut v, &cpu(), 0x1000);
    fetch(&mut v, &cpu(), 0x4000);
    fetch(&mut v, &el0, 0x2000);
    let was = v.tlb.xgen;
    v.tlb.flush_ng();
    assert!(v.tlb.xgen[0] != was[0] && v.tlb.xgen[1] != was[1]);
    fetch(&mut v, &cpu(), 0x1000); // a TLB hit
    v.tlb.xc_fill(0x1000, 3, 7, 4);
    v.tlb.flush_va(0x1000);
    assert!(!live(&v.tlb, 0x1000, 3));
    // Dropping blocks (the transfer cache's entries, not the TLB's) keeps
    // the nG page's.
    fetch(&mut v, &el0, 0x2000);
    v.tlb.bump();
    fetch(&mut v, &el0, 0x2000); // a TLB hit
    v.tlb.xc_fill(0x2004, 2, 7, 4);
    v.tlb.flush_va(0x2000);
    assert!(!live(&v.tlb, 0x2004, 2));
    // Its fetch again, then the nG entries dropped: its mark goes, as its
    // entry and the transfer cache's do.
    fetch(&mut v, &el0, 0x2000);
    v.tlb.flush_ng();
    v.tlb.xc_fill(0x2004, 2, 7, 4); // what nothing fills now
    v.tlb.flush_va(0x2000);
    assert!(live(&v.tlb, 0x2004, 2));
}

/// FEAT_E0PD: TCR_EL1.E0PD1 (E0PD0) makes every EL0 access to the TTBR1
/// (TTBR0) half a level 0 translation fault, whatever the tables allow, AT
/// S1E0* included; EL1 is unaffected. Without the feature the bits do nothing.
#[test]
fn e0pd_faults_el0_accesses_to_its_half() {
    const HI: u64 = 0xffff_0000_0000_1000;
    let mut p = Pt::new();
    p.map(HI, 3, 0x9000 | PAGE | AP_EL0_RW);
    p.map(0x2000, 3, 0xa000 | PAGE | AP_EL0_RW);
    let tr0 = |addr| {
        Err(Fault {
            addr,
            access: Access::Read,
            kind: FaultKind::Translation(0),
        })
    };
    for (features, e0pd, hi_faults, lo_faults) in [
        (crate::cpu::FEATURE_E0PD, 1u64 << 56, true, false),
        (crate::cpu::FEATURE_E0PD, 1 << 55, false, true),
        (crate::cpu::FEATURE_E0PD, 0, false, false),
        (0, 3 << 55, false, false),
    ] {
        let mk = || Cpu {
            features,
            tcr_el1: cpu().tcr_el1 | e0pd,
            ..cpu()
        };
        let (c, mut v) = (mk(), Vcpu::new(mk()));
        let mut m = Mmu::new(&p.r.mem, Some(&mut v.tlb));
        for (va, faults) in [(HI, hi_faults), (0x2000, lo_faults)] {
            let r = m.read_el(&c, va + 8, 8, 0);
            assert_eq!(r.is_err(), faults, "{features} {e0pd:#x} {va:#x}");
            if faults {
                assert_eq!(r, tr0(va + 8));
                // Translation fault, level 0 (FSC 0b000100), PAR_EL1.F.
                assert_eq!(at(&c, &p.r.mem, va, 0, Use::Read), 4 << 1 | 1 << 11 | 1);
                assert_eq!(
                    m.fetch(
                        &Cpu {
                            pstate: M_EL0T,
                            ..c
                        },
                        va
                    )
                    .map_err(|f| f.kind),
                    Err(FaultKind::Translation(0))
                );
            }
            assert!(m.read_el(&c, va + 8, 8, 1).is_ok(), "EL1 reads {va:#x}");
        }
    }
}

#[test]
fn spill_memory_pages() {
    // Memory 0 at PA 0, a spill memory at 16 MiB.
    let mut p = Pt {
        r: TestRam::with_spill(RAM, &[(0x100_0000, 0x10_0000)]),
        next: ROOT1 + 0x1000,
    };
    p.map(0x1000, 3, 0x100_2000 | PAGE);
    p.map(0x2000, 3, 0x9000 | PAGE);
    p.map(0x3000, 3, 0x100_5000 | PAGE);
    let c = cpu();
    let mut v = Vcpu::new(c.clone());
    let mut b = Mmu::new(&p.r.mem, Some(&mut v.tlb));
    b.write(&c, 0x1008, 8, 0x1122_3344_5566_7788).unwrap();
    assert_eq!(p.r.mem.read(0x100_2008, 8), Ok(0x1122_3344_5566_7788));
    // The entry names memory 1 and misses the inline compare (the fast path
    // never sees it), but the miss path takes it without walking again.
    assert_eq!(b.fast(&c, 0x1008, 8, Use::Write), None);
    assert_eq!(b.fast(&c, 0x1008, 8, Use::Read), None);
    let walks = b.tlb.as_ref().unwrap().stats.walks;
    assert_eq!(b.read(&c, 0x1008, 8), Ok(0x1122_3344_5566_7788));
    assert_eq!(b.read(&c, 0x100c, 4), Ok(0x1122_3344));
    assert_eq!(b.read(&c, 0x1008, 1), Ok(0x88));
    assert_eq!(b.tlb.as_ref().unwrap().stats.walks, walks); // the write's walk filled the read array too
    let e = b.tlb.as_ref().unwrap().e[1].0[3 + Use::Read as usize];
    assert_eq!(e.tag & 0xfff, 0xfff ^ 1 << 3);
    // Page-crossing accesses between memory 0 and the spill memory, both ways.
    b.write(&c, 0x1ffc, 8, 0x8877_6655_4433_2211).unwrap();
    assert_eq!(p.r.mem.read(0x100_2ffc, 4), Ok(0x4433_2211));
    assert_eq!(p.r.mem.read(0x9000, 4), Ok(0x8877_6655));
    b.write(&c, 0x2ffe, 4, 0xaabb_ccdd).unwrap();
    assert_eq!(b.read(&c, 0x2ffe, 4), Ok(0xaabb_ccdd));
    assert_eq!(p.r.mem.read(0x100_5000, 2), Ok(0xaabb));
    // Atomics, pairs and instruction fetch.
    assert_eq!(b.cas(&c, 0x1010, 8, 0, 7), Ok(0));
    assert_eq!(b.rmw(&c, 0x1010, 8, 0, 1), Ok(7));
    assert_eq!(b.read_atomic(&c, 0x1010, 8), Ok(8));
    assert_eq!(b.cas_pair(&c, 0x1020, [0, 0], [3, 4]), Ok([0, 0]));
    assert_eq!(b.read_pair(&c, 0x1020), Ok([3, 4]));
    assert_eq!(b.fetch(&c, 0x1020), Ok(3));
    assert_eq!(b.maint(&c, 0x1024, false), Ok(Some(0x100_2024)));
    // A TLBI drops the spill entry like any other: remapped, the next access walks.
    p.r.mem.write(0x100_0000 + 0x2000 + 0x30, 8, 0x55).unwrap();
    b.flush_va(0x1000);
    assert_eq!(b.read(&c, 0x1030, 8), Ok(0x55));
}

/// The window's write-watch (docs/devices.md "virtio-gpu"): a page-crossing store whose second page's write entry
/// overflows the TLB's records (which drops and marks them all, the first page's too) must still leave the first
/// page recorded once both are translated, so a host that looks between the translations and the store (the seam
/// here: `span`, then the look, then `write_el`'s stores) still sees the first page written at its next look.
#[test]
fn watched_page_crossing_store_after_overflow() {
    const WIN: u64 = 0x20_0000;
    const VA: u64 = 0x4000_0000;
    let mut p = Pt {
        r: TestRam::new(RAM).watch(WIN, 0x10_0000),
        next: ROOT1 + 0x1000,
    };
    for k in 0..WATCHED as u64 + 2 {
        p.map(VA + (k << 12), 3, (WIN + (k << 12)) | PAGE);
    }
    let c = cpu();
    let w = p.r.mem.watch().unwrap();
    // Page 63 is new (its record is the 64th, page 64's overflows), or already recorded (a TLB hit, the first record).
    for hit in [false, true] {
        let mut v = Vcpu::new(c.clone());
        let mut b = Mmu::new(&p.r.mem, Some(&mut v.tlb));
        let last = WATCHED as u64 - 1;
        if hit {
            b.write(&c, VA + (last << 12), 8, 0).unwrap();
        }
        for k in 0..last {
            b.write(&c, VA + (k << 12), 8, k).unwrap();
        }
        let _ = w.take();
        let va = VA + ((WATCHED as u64) << 12) - 4;
        let (p1, Some((p2, first))) = b.span(&c, va, 8, Access::Write, Use::Write, 1).unwrap()
        else {
            panic!("crosses a page")
        };
        // The host looks now (the vCPU acked earlier and runs on).
        w.bump();
        let _ = w.take();
        for k in 0..8 {
            let h = if k < first {
                p1.plus(k)
            } else {
                p2.plus(k - first)
            };
            // SAFETY: span found RAM at both.
            unsafe { p.r.mem.store(h, 1, 0xa5) };
        }
        // The next look: the vCPU drops its records at the bump.
        w.bump();
        v.tlb.unwatch(&p.r.mem);
        assert_eq!(w.take(), [last, last + 1], "hit {hit}");
    }
}

/// The debug interpreter's bus: an access translates (its faults first),
/// then a watchpoint is taken before it reaches RAM or a device; an atomic
/// read-modify-write is a load and a store, a store-exclusive a store.
#[test]
fn watchpoints_come_after_translation() {
    use crate::interp::debug::{self, MDSCR_KDE, MDSCR_MDE, Watch};
    const DEV: u64 = 2 << 2;
    let mut p = Pt::new();
    p.map(0x2000, 3, 0x9000 | PAGE | AP_RO);
    p.map(0x4000, 3, (RAM as u64 + 0x1000) | PAGE | DEV); // a device's registers
    p.map(0x3000, 3, 0xa000 | PAGE);
    let mut c = Cpu {
        mdscr_el1: MDSCR_MDE | MDSCR_KDE,
        ..cpu()
    };
    c.set_pstate(crate::cpu::M_EL1H); // PSTATE.D clear
    let mut v = Vcpu::new(c.clone());
    let mut b = Watch(Mmu::new(&p.r.mem, Some(&mut v.tlb)));
    let watch = |c: &mut Cpu, va: u64, lsc: u64| {
        c.dbgwvr[0] = va & !7;
        c.dbgwcr[0] = 0xff << 5 | lsc << 3 | 1 << 1 | 1; // BAS all, LSC, PAC EL1, E
        debug::arm(c);
    };
    let f = |addr, access, kind| Some(Fault { addr, access, kind });
    // Unmapped: the translation fault, for a load, a store and an atomic.
    watch(&mut c, 0x7000, 3);
    assert_eq!(
        b.read(&c, 0x7000, 8).err(),
        f(0x7000, Access::Read, FaultKind::Translation(3))
    );
    assert_eq!(
        b.write(&c, 0x7000, 8, 0).err(),
        f(0x7000, Access::Write, FaultKind::Translation(3))
    );
    assert_eq!(
        b.rmw(&c, 0x7000, 8, 0, 1).err(),
        f(0x7000, Access::Write, FaultKind::Translation(3))
    );
    // Read-only: a store's permission fault; a load takes the watchpoint.
    watch(&mut c, 0x2008, 3);
    assert_eq!(
        b.write(&c, 0x2008, 8, 0).err(),
        f(0x2008, Access::Write, FaultKind::Permission(3))
    );
    assert_eq!(
        b.read(&c, 0x2008, 8).err(),
        f(0x2008, Access::Read, FaultKind::Watch)
    );
    // A device's registers: the watchpoint before the bus (the run loop's `io`).
    watch(&mut c, 0x4008, 2);
    assert_eq!(
        b.read(&c, 0x4008, 4).map_err(|f| f.kind),
        Err(FaultKind::Bus)
    );
    assert_eq!(
        b.write(&c, 0x400c, 4, 0).err(),
        f(0x400c, Access::Write, FaultKind::Watch)
    );
    // An unaligned atomic: the alignment fault.
    assert_eq!(
        b.rmw(&c, 0x4009, 4, 0, 1).err(),
        f(0x4009, Access::Write, FaultKind::Align)
    );
    // RAM: an atomic RMW is a load (WnR 0) for a load watchpoint, a store for
    // a store one; a store-exclusive only a store.
    watch(&mut c, 0x3000, 1);
    let r = |kind| f(0x3000, Access::Read, kind);
    let w = |kind| f(0x3000, Access::Write, kind);
    assert_eq!(b.rmw(&c, 0x3000, 8, 0, 1).err(), r(FaultKind::Watch));
    assert_eq!(b.cas(&c, 0x3000, 8, 5, 1).err(), r(FaultKind::Watch)); // fails: memory is 0
    assert_eq!(
        b.cas_pair(&c, 0x3000, [5, 5], [1, 1]).err(),
        r(FaultKind::Watch)
    );
    assert_eq!(b.store_exclusive(&c, 0x3000, 8, 0, 1), Ok(0));
    watch(&mut c, 0x3000, 2);
    assert_eq!(b.rmw(&c, 0x3000, 8, 0, 1).err(), w(FaultKind::Watch));
    assert_eq!(
        b.store_exclusive(&c, 0x3000, 8, 1, 2).err(),
        w(FaultKind::Watch)
    );
    assert_eq!(
        b.store_exclusive_pair(&c, 0x3000, [1, 0], [2, 2]).err(),
        w(FaultKind::Watch)
    );
}

/// A block's transfer cache entries die with a flush by any VA of the block,
/// also when they were filled again from its instruction TLB entries (a hit,
/// no walk) after the EL's entries were last dropped: by a bump (the JIT
/// dropped blocks), a flush by VA of another page in the half, or the nG
/// entries' drop; and when the page's own entry has since been evicted.
#[test]
fn a_block_flush_drops_transfer_cache_entries_filled_from_hits() {
    const VA: u64 = 0x4000_0000;
    let mut p = Pt::new();
    p.map(VA, 2, 0x20_0000 | BLOCK);
    p.map(0x7000, 3, 0x9000 | PAGE); // a data page in the same half
    p.map(VA + 0x400_3000, 3, 0xb000 | PAGE); // P's TLB index
    p.map(0x1000, 3, 0xa000 | PAGE | 1 << 11); // nG
    let live = |t: &Tlb, va: u64, regime: u64| {
        let e = t.xc[(va >> 2) as usize & (XC_ENTRIES - 1)];
        e.tag == va | regime && e.to >> 48 == t.xgen[regime as usize & 1]
    };
    let fetch = |v: &mut Vcpu, va: u64| {
        Mmu::new(&p.r.mem, Some(&mut v.tlb))
            .fetch(&cpu(), va)
            .unwrap();
    };
    let drops: [&dyn Fn(&mut Vcpu); 3] = [&|v| v.tlb.bump(), &|v| v.tlb.flush_va(0x7000), &|v| {
        fetch(v, 0x1000);
        v.tlb.flush_ng();
    }];
    for (n, drop) in drops.iter().enumerate() {
        for evict in [false, true] {
            let mut v = Vcpu::new(cpu());
            fetch(&mut v, VA + 0x3000);
            drop(&mut v);
            fetch(&mut v, VA + 0x3000); // a TLB hit
            v.tlb.xc_fill(VA + 0x3000, 3, 7, 4);
            if evict {
                // Its entry evicted by a page's: no block entries left, the
                // transfer cache's stays.
                fetch(&mut v, VA + 0x400_3000);
            }
            v.tlb.flush_va(VA); // Linux's one TLBI for the 2 MiB
            assert!(!live(&v.tlb, VA + 0x3000, 3), "drop {n}, evicted {evict}");
        }
    }
}

/// A data access's walk fills the same EL's other data array too, with what the walk permits: a write after a
/// read of a page (or a read after a write) doesn't walk again, a read-only page's write still faults, and a
/// TLBI drops both entries.
#[test]
fn a_walk_fills_the_sibling_data_array() {
    const NG: u64 = 1 << 11;
    const DEV: u64 = 2 << 2;
    let mut p = Pt::new();
    p.map(0x1000, 3, 0x9000 | PAGE); // EL1 RW
    p.map(0x2000, 3, 0xa000 | PAGE | AP_RO); // EL1 RO
    p.map(0x3000, 3, 0xb000 | PAGE | AP_EL0_RO);
    p.map(0x4000, 3, 0xc000 | PAGE | AP_EL0_RW | NG);
    p.map(0x5000, 3, 0xd000 | PAGE | DEV); // Device memory that is RAM
    p.map(0x4000_0000, 2, 0x20_0000 | BLOCK);
    let l3 = {
        let l0 = p.r.mem.read(ROOT0, 8).unwrap() & OA_MASK;
        let l1 = p.r.mem.read(l0, 8).unwrap() & OA_MASK;
        p.r.mem.read(l1, 8).unwrap() & OA_MASK
    };
    let c = cpu();
    let c0 = {
        let mut c = cpu();
        c.set_pstate(M_EL0T);
        c
    };
    let mut v = Vcpu::new(c.clone());
    let mut b = Mmu::new(&p.r.mem, Some(&mut v.tlb));
    let walks = |b: &Mmu| b.tlb.as_ref().unwrap().stats.walks;
    let perm = |addr| {
        Err(Fault {
            addr,
            access: Access::Write,
            kind: FaultKind::Permission(3),
        })
    };
    // A read, then a write without a walk; and the other way around.
    assert_eq!(b.read(&c, 0x1010, 8), Ok(0));
    assert!(b.fast(&c, 0x1010, 8, Use::Write).is_some());
    assert_eq!(b.write(&c, 0x1010, 8, 7), Ok(()));
    assert_eq!(walks(&b), 1);
    b.flush_va(0x1000);
    assert!(
        b.fast(&c, 0x1010, 8, Use::Write).is_none() && b.fast(&c, 0x1010, 8, Use::Read).is_none()
    );
    assert_eq!(b.write(&c, 0x1010, 8, 8), Ok(()));
    assert_eq!((b.read(&c, 0x1010, 8), walks(&b)), (Ok(8), 2));
    // Made read-only between a read and a write, with its TLBI: the write faults.
    b.flush_va(0x1000);
    assert_eq!(b.read(&c, 0x1010, 8), Ok(8));
    p.r.mem.write(l3 + 8, 8, 0x9000 | PAGE | AP_RO).unwrap();
    b.flush_va(0x1000);
    assert_eq!(b.write(&c, 0x1010, 8, 9), perm(0x1010));
    assert_eq!(b.read(&c, 0x1010, 8), Ok(8));
    // A read-only page's read fills no write entry, at either EL; EL0's walk fills no EL1 array.
    assert_eq!(b.read(&c, 0x2010, 8), Ok(0));
    assert!(b.fast(&c, 0x2010, 8, Use::Write).is_none());
    assert_eq!(b.write(&c, 0x2010, 8, 1), perm(0x2010));
    assert_eq!(b.read(&c0, 0x3010, 8), Ok(0));
    assert!(b.fast(&c0, 0x3010, 8, Use::Write).is_none());
    assert_eq!(b.write(&c0, 0x3010, 8, 1), perm(0x3010));
    assert!(b.fast(&c, 0x3010, 8, Use::Read).is_none());
    // EL0's write fills EL0's read array; the entries are nG, and go with the ASID's.
    let n = walks(&b);
    assert_eq!(b.write(&c0, 0x4010, 8, 5), Ok(()));
    assert_eq!((b.read(&c0, 0x4010, 8), walks(&b)), (Ok(5), n + 1));
    p.r.mem
        .write(l3 + 8 * 4, 8, 0xe000 | PAGE | AP_EL0_RW | NG)
        .unwrap();
    b.flush_ng();
    assert_eq!(b.read(&c0, 0x4010, 8), Ok(0));
    assert_eq!(b.write(&c0, 0x4010, 8, 6), Ok(()));
    assert_eq!(p.r.mem.read(0xe010, 8), Ok(6));
    // Device memory: the read's walk leaves the write array alone, so a misaligned write still faults.
    assert_eq!(b.read(&c, 0x5010, 8), Ok(0));
    assert_eq!(v.tlb.e[5].0[3 + Use::Write as usize].tag, 0);
    let mut b = Mmu::new(&p.r.mem, Some(&mut v.tlb));
    assert_eq!(
        b.write(&c, 0x5011, 2, 0).map_err(|f| f.kind),
        Err(FaultKind::Align)
    );
    // Only into an empty slot: a page read and another of the same TLB index written (a copy's source and
    // destination) keep an entry each, and neither access walks again.
    p.map(0x6000 + ((TLB_ENTRIES as u64) << 12), 3, 0x1_0000 | PAGE);
    p.map(0x6000, 3, 0x1_1000 | PAGE);
    let mut b = Mmu::new(&p.r.mem, Some(&mut v.tlb));
    let (src, dst) = (0x6010, 0x6010 + ((TLB_ENTRIES as u64) << 12));
    let n = walks(&b);
    for k in 0..4 {
        assert_eq!(b.read(&c, src, 8), Ok(0));
        assert_eq!(b.write(&c, dst, 8, 0), Ok(()));
        assert_eq!(walks(&b), n + 2, "round {k}");
    }
    // A block's page: both entries are counted, and a TLBI by another VA of the block drops both.
    assert_eq!(b.read(&c, 0x4000_3010, 8), Ok(0));
    assert_eq!(v.tlb.rblk.iter().sum::<u32>(), 2);
    let mut b = Mmu::new(&p.r.mem, Some(&mut v.tlb));
    b.flush_va(0x4010_0000);
    assert!(b.fast(&c, 0x4000_3010, 8, Use::Write).is_none());
    assert!(v.tlb.rblk.iter().all(|&n| n == 0));
}

/// The window's write-watch and the sibling fill: a read's walk fills no write entry for a watched page (a
/// write entry there is always a write's, recorded), so the write that follows is seen; a write's walk fills
/// the read array.
#[test]
fn a_read_fills_no_write_entry_for_a_watched_page() {
    const WIN: u64 = 0x20_0000;
    const VA: u64 = 0x4000_0000;
    let mut p = Pt {
        r: TestRam::new(RAM).watch(WIN, 0x10_0000),
        next: ROOT1 + 0x1000,
    };
    p.map(VA, 3, WIN | PAGE);
    p.map(VA + 0x1000, 3, (WIN + 0x1000) | PAGE);
    let c = cpu();
    let w = p.r.mem.watch().unwrap();
    let mut v = Vcpu::new(c.clone());
    let mut b = Mmu::new(&p.r.mem, Some(&mut v.tlb));
    assert_eq!(b.read(&c, VA + 8, 8), Ok(0));
    assert!(b.fast(&c, VA + 8, 8, Use::Write).is_none());
    assert_eq!(b.tlb.as_ref().unwrap().nwatched, 0);
    assert_eq!(b.write(&c, VA + 8, 8, 1), Ok(()));
    assert_eq!(b.tlb.as_ref().unwrap().nwatched, 1);
    // The second page, written first: its read entry comes with the write's walk.
    assert_eq!(b.write(&c, VA + 0x1008, 8, 2), Ok(()));
    assert!(b.fast(&c, VA + 0x1008, 8, Use::Read).is_some());
    assert_eq!(b.tlb.as_ref().unwrap().stats.walks, 3);
    // The host's look drops the write entries and finds both pages; a read after it brings none back.
    w.bump();
    v.tlb.unwatch(&p.r.mem);
    assert_eq!(w.take(), [0, 1]);
    let mut b = Mmu::new(&p.r.mem, Some(&mut v.tlb));
    assert_eq!(b.read(&c, VA + 8, 8), Ok(1));
    assert!(b.fast(&c, VA + 8, 8, Use::Write).is_none());
    assert_eq!(b.write(&c, VA + 8, 8, 3), Ok(()));
    w.bump();
    v.tlb.unwatch(&p.r.mem);
    assert_eq!(w.take(), [0]);
}
