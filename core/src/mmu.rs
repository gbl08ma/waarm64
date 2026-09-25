//! Stage 1 MMU for the EL1&0 regime (4K granule, up to 48-bit VAs, TTBR0/TTBR1,
//! TBI, software-managed access flag) and the per-vCPU software TLB.
//!
//! [`Bus`] is the one virtual-address accessor: the interpreter (and later the
//! JIT's slow paths) do every guest access through it. It returns host pointers
//! from the TLB or from a walk, and [`Mem`] only knows physical addresses.
//!
//! **TLB entry (the shape the M0 spike measured, `bench/spike/REPORT.md` §4):**
//! direct-mapped, `TLB_ENTRIES` × `{tag, addend}` of 16 bytes, one array per
//! (EL, read/write/execute), so permissions need no check on a hit. The tag is
//! the page's VA with bits 11:0 all ones; the lookup compares it with
//! `(va + size - 1) | 0xfff`, so an access that crosses into the next page misses,
//! and an all-zero entry never matches. Bits 11:3 of the tag are the memory index
//! (`bench/spike/memory/REPORT.md` §4), stored inverted: all ones is memory 0, the
//! only one so far. `host = va + addend`.
//!
//! The TLB holds no ASIDs: it's flushed whenever the effective ASID changes.
// ponytail: flushing on every ASID change drops global (kernel) entries too;
// tag entries with the ASID if the TLB counters (step 8) show refills after
// context switches matter.

use crate::cpu::{Cpu, sctlr};
use crate::mem::{self, Access, Fault, FaultKind, Mem};

pub const TLB_ENTRIES: usize = 4096;
/// Physical address size we advertise (`ID_AA64MMFR0_EL1.PARange` = 40 bits).
pub const PA_BITS: u32 = 40;
const OA_MASK: u64 = 0x0000_ffff_ffff_f000;

/// What an access does with the page, for permissions and the TLB array.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Use {
    Read = 0,
    Write = 1,
    Exec = 2,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Entry {
    pub tag: u64,
    pub addend: u64,
}

/// Arrays in order: EL0 read, write, exec, then EL1 read, write, exec.
#[repr(C)]
pub struct Tlb {
    pub e: [[Entry; TLB_ENTRIES]; 6],
}

impl Tlb {
    fn flush_all(&mut self) {
        for a in &mut self.e {
            a.fill(Entry::default());
        }
    }

    /// Drops the page holding `va` from every array, whatever its top byte (TBI).
    fn flush_va(&mut self, va: u64) {
        let i = index(va);
        for a in &mut self.e {
            if (a[i].tag ^ va) & 0x00ff_ffff_ffff_f000 == 0 {
                a[i] = Entry::default();
            }
        }
    }
}

#[inline]
fn index(va: u64) -> usize {
    (va >> 12) as usize & (TLB_ENTRIES - 1)
}

/// A vCPU: architectural state, then its TLB. `repr(C)` with `cpu` first, so a
/// `*mut Vcpu` is also a `*mut Cpu` with the host ABI offsets.
#[repr(C)]
pub struct Vcpu {
    pub cpu: Cpu,
    pub tlb: Tlb,
}

impl Vcpu {
    /// Boxed: the TLB is 384 KiB.
    pub fn new(cpu: Cpu) -> Box<Vcpu> {
        // SAFETY: all-zero is a valid Vcpu: Cpu is plain integers and a zeroed TLB is empty.
        let mut v = unsafe { Box::<Vcpu>::new_zeroed().assume_init() };
        v.cpu = cpu;
        v
    }
}

/// A successful walk: the output address and what each EL may do with it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Walk {
    pub pa: u64,
    /// Level of the leaf descriptor.
    pub level: u8,
    /// The MAIR_EL1 attribute byte AttrIndx selects.
    pub attr: u8,
    /// Shareability, descriptor bits 9:8.
    pub sh: u8,
    /// Bit `3 * el + use`: EL0 read, write, exec, EL1 read, write, exec.
    perms: u8,
}

impl Walk {
    pub fn allows(&self, el: u64, u: Use) -> bool {
        self.perms >> (3 * el as u32 + u as u32) & 1 == 1
    }
}

/// Walks the stage 1 tables for `va`. Permission faults are the caller's to
/// raise, since they depend on the access.
pub fn walk(c: &Cpu, mem: &Mem, va: u64) -> Result<Walk, FaultKind> {
    let tcr = c.tcr_el1;
    let hi = (va >> 55) & 1 == 1;
    let (tsz, epd, tbi, ttbr) = if hi {
        (
            (tcr >> 16) & 0x3f,
            tcr >> 23 & 1,
            tcr >> 38 & 1,
            c.ttbr1_el1,
        )
    } else {
        (tcr & 0x3f, tcr >> 7 & 1, tcr >> 37 & 1, c.ttbr0_el1)
    };
    // T0SZ/T1SZ outside 16..=39 behave as the nearest limit (a permitted choice).
    let inputsize = 64 - tsz.clamp(16, 39) as u32;
    // Bits inputsize..=top must all equal bit 55; top is 55 with TBI, else 63.
    let n = if tbi == 1 { 56 } else { 64 } - inputsize;
    let ones = (1u64 << n) - 1;
    let field = (va >> inputsize) & ones;
    if field != if hi { ones } else { 0 } || epd == 1 {
        return Err(FaultKind::Translation(0));
    }
    let ips = [32, 36, 40, 42, 44, 48, 48, 48][(tcr >> 32 & 7) as usize];
    let limit = 1u64 << ips.min(PA_BITS);
    let mut level = 4 - (inputsize - 4) / 9;
    let mut bits = inputsize - (12 + 9 * (3 - level)); // index bits at the start level
    let mut table = ttbr & 0x0000_ffff_ffff_fffe & !((8u64 << bits) - 1);
    if table >= limit {
        return Err(FaultKind::AddressSize(0));
    }
    let (mut ap_table, mut uxn_table, mut pxn_table) = (0, 0, 0);
    loop {
        let lv = level as u8;
        let shift = 12 + 9 * (3 - level);
        let idx = (va >> shift) & ((1 << bits) - 1);
        let desc = mem
            .read(table + 8 * idx, 8)
            .map_err(|_| FaultKind::WalkBus(lv))?;
        if desc & 1 == 0 {
            return Err(FaultKind::Translation(lv));
        }
        if desc & 2 != 0 && level < 3 {
            ap_table |= (desc >> 61) & 3;
            uxn_table |= (desc >> 60) & 1;
            pxn_table |= (desc >> 59) & 1;
            table = desc & OA_MASK;
            if table >= limit {
                return Err(FaultKind::AddressSize(lv));
            }
            (level, bits) = (level + 1, 9);
            continue;
        }
        // A block at level 0 (none with 4K pages) or 0b01 at level 3 is reserved.
        if level == 0 || (level == 3 && desc & 2 == 0) {
            return Err(FaultKind::Translation(lv));
        }
        let oa = desc & OA_MASK & !((1u64 << shift) - 1);
        if oa >= limit {
            return Err(FaultKind::AddressSize(lv));
        }
        if desc & (1 << 10) == 0 {
            return Err(FaultKind::AccessFlag(lv));
        }
        // AP[2:1]: 00 EL1 RW; 01 EL0 and EL1 RW; 10 EL1 RO; 11 EL0 and EL1 RO.
        // APTable[0] takes away EL0 access, APTable[1] writes.
        let ap = (desc >> 6) & 3;
        let r0 = ap & 1 == 1 && ap_table & 1 == 0;
        let w0 = ap == 1 && ap_table == 0;
        let w1 = ap & 2 == 0 && ap_table & 2 == 0;
        let wxn = c.sctlr_el1 & sctlr::WXN != 0;
        let x0 = (desc >> 54) & 1 == 0 && uxn_table == 0 && !(wxn && w0);
        // EL1 never executes what EL0 can write.
        let x1 = (desc >> 53) & 1 == 0 && pxn_table == 0 && !w0 && !(wxn && w1);
        let perms = r0 as u8
            | (w0 as u8) << 1
            | (x0 as u8) << 2
            | 1 << 3
            | (w1 as u8) << 4
            | (x1 as u8) << 5;
        return Ok(Walk {
            pa: oa | (va & ((1u64 << shift) - 1)),
            level: lv,
            attr: (c.mair_el1 >> (8 * ((desc >> 2) & 7))) as u8,
            sh: ((desc >> 8) & 3) as u8,
            perms,
        });
    }
}

/// The ASID TTBR0/TTBR1 holds for the current translations (TCR_EL1.A1, AS).
pub fn asid(c: &Cpu) -> u64 {
    let ttbr = if c.tcr_el1 >> 22 & 1 == 1 {
        c.ttbr1_el1
    } else {
        c.ttbr0_el1
    };
    if c.tcr_el1 >> 36 & 1 == 1 {
        ttbr >> 48
    } else {
        (ttbr >> 48) & 0xff
    }
}

/// AT S1E{0,1}{R,W}: translates `va` as an `el` access and returns PAR_EL1.
pub fn at(c: &Cpu, mem: &Mem, va: u64, el: u64, u: Use) -> u64 {
    const RES1: u64 = 1 << 11;
    if c.sctlr_el1 & sctlr::M == 0 {
        // Flat: Device-nGnRnE (ATTR 0), outer shareable.
        return va & OA_MASK | 2 << 7 | RES1;
    }
    let r = walk(c, mem, va).and_then(|w| {
        if w.allows(el, u) {
            Ok(w)
        } else {
            Err(FaultKind::Permission(w.level))
        }
    });
    match r {
        Ok(w) => (w.attr as u64) << 56 | w.pa & OA_MASK | (w.sh as u64) << 7 | RES1,
        Err(k) => (k.fsc() as u64) << 1 | RES1 | 1,
    }
}

/// One host pointer, or two for a page-crossing access (the second with the
/// number of bytes that go to the first).
type Span = (*mut u8, Option<(*mut u8, u64)>);

/// Guest virtual memory as one vCPU sees it: its translation regime and TLB
/// over the shared [`Mem`]. Without a TLB (user-mode hosts, most unit tests)
/// every translation walks; with the MMU off, VA = PA.
pub struct Bus<'a> {
    pub mem: &'a Mem,
    pub tlb: Option<&'a mut Tlb>,
}

impl<'a> Bus<'a> {
    pub fn new(mem: &'a Mem, tlb: Option<&'a mut Tlb>) -> Self {
        Bus { mem, tlb }
    }

    pub fn flush_all(&mut self) {
        if let Some(t) = &mut self.tlb {
            t.flush_all();
        }
    }

    pub fn flush_va(&mut self, va: u64) {
        if let Some(t) = &mut self.tlb {
            t.flush_va(va);
        }
    }

    /// Host pointer for `len` bytes at `va`, which must not cross a page.
    #[inline]
    fn host(
        &mut self,
        c: &Cpu,
        va: u64,
        len: u64,
        access: Access,
        u: Use,
        el: u64,
    ) -> Result<*mut u8, Fault> {
        if c.sctlr_el1 & sctlr::M == 0 {
            // ponytail: no address size fault for VAs past PA_BITS with the MMU
            // off; they aren't RAM, so they fault as external aborts instead.
            return self.mem.host(va, len, access);
        }
        let (k, i) = (3 * el as usize + u as usize, index(va));
        if let Some(t) = &self.tlb {
            let e = t.e[k][i];
            if e.tag == va.wrapping_add(len - 1) | 0xfff {
                return Ok(va.wrapping_add(e.addend) as usize as *mut u8);
            }
        }
        let fault = |kind| Fault {
            addr: va,
            access,
            kind,
        };
        let w = walk(c, self.mem, va).map_err(fault)?;
        if !w.allows(el, u) {
            return Err(fault(FaultKind::Permission(w.level)));
        }
        let p = self
            .mem
            .host(w.pa, len, access)
            .map_err(|f| Fault { addr: va, ..f })?;
        if let Some(t) = &mut self.tlb
            && let Ok(page) = self.mem.host(w.pa & !0xfff, 0x1000, access)
        {
            t.e[k][i] = Entry {
                tag: va | 0xfff,
                addend: (page as usize as u64).wrapping_sub(va & !0xfff),
            };
        }
        Ok(p)
    }

    /// `SCTLR_EL1.A`: every load and store must be aligned to its size.
    #[inline]
    fn check_align(c: &Cpu, va: u64, size: u32, access: Access) -> Result<(), Fault> {
        if c.sctlr_el1 & sctlr::A != 0 && !va.is_multiple_of(size as u64) {
            return Err(Fault {
                addr: va,
                access,
                kind: FaultKind::Align,
            });
        }
        Ok(())
    }

    /// Host pointers for `size` bytes at `va`: one, or one per page when the
    /// access crosses a page (both translated before either is touched), with
    /// the byte count in the first.
    #[inline]
    fn span(
        &mut self,
        c: &Cpu,
        va: u64,
        size: u32,
        access: Access,
        u: Use,
        el: u64,
    ) -> Result<Span, Fault> {
        let first = 0x1000 - (va & 0xfff);
        if size as u64 <= first {
            return Ok((self.host(c, va, size as u64, access, u, el)?, None));
        }
        let p1 = self.host(c, va, first, access, u, el)?;
        let va2 = va.wrapping_add(first);
        let p2 = self.host(c, va2, size as u64 - first, access, u, el)?;
        Ok((p1, Some((p2, first))))
    }

    /// Little-endian read of 1, 2, 4 or 8 bytes, zero-extended, with `el`'s
    /// permissions (0 for LDTR at EL1).
    pub fn read_el(&mut self, c: &Cpu, va: u64, size: u32, el: u64) -> Result<u64, Fault> {
        Self::check_align(c, va, size, Access::Read)?;
        Ok(match self.span(c, va, size, Access::Read, Use::Read, el)? {
            // SAFETY: host() checked the bytes are RAM.
            (p, None) => unsafe { mem::load(p, size) },
            (p1, Some((p2, first))) => (0..size as u64).fold(0, |v, k| {
                // SAFETY: k < first bytes at p1, the rest at p2, all RAM.
                let b = unsafe {
                    *if k < first {
                        p1.add(k as usize)
                    } else {
                        p2.add((k - first) as usize)
                    }
                };
                v | (b as u64) << (8 * k)
            }),
        })
    }

    /// Little-endian write of the low 1, 2, 4 or 8 bytes of `val` with `el`'s permissions.
    pub fn write_el(
        &mut self,
        c: &Cpu,
        va: u64,
        size: u32,
        val: u64,
        el: u64,
    ) -> Result<(), Fault> {
        Self::check_align(c, va, size, Access::Write)?;
        match self.span(c, va, size, Access::Write, Use::Write, el)? {
            // SAFETY: host() checked the bytes are RAM.
            (p, None) => unsafe { mem::store(p, size, val) },
            (p1, Some((p2, first))) => {
                for k in 0..size as u64 {
                    // SAFETY: as in read_el.
                    unsafe {
                        *if k < first {
                            p1.add(k as usize)
                        } else {
                            p2.add((k - first) as usize)
                        } = (val >> (8 * k)) as u8;
                    }
                }
            }
        }
        Ok(())
    }

    #[inline]
    pub fn read(&mut self, c: &Cpu, va: u64, size: u32) -> Result<u64, Fault> {
        self.read_el(c, va, size, c.el())
    }

    #[inline]
    pub fn write(&mut self, c: &Cpu, va: u64, size: u32, val: u64) -> Result<(), Fault> {
        self.write_el(c, va, size, val, c.el())
    }

    /// Instruction fetch (PC alignment is the caller's).
    #[inline]
    pub fn fetch(&mut self, c: &Cpu, pc: u64) -> Result<u32, Fault> {
        let p = self.host(c, pc, 4, Access::Read, Use::Exec, c.el())?;
        // SAFETY: host() checked 4 bytes of RAM.
        Ok(unsafe { mem::load(p, 4) } as u32)
    }

    /// Cache maintenance by VA: translates and checks permission (write for
    /// `DC IVAC`, read otherwise), and faults like a data access with CM set.
    pub fn maint(&mut self, c: &Cpu, va: u64, write: bool) -> Result<(), Fault> {
        let u = if write { Use::Write } else { Use::Read };
        self.host(c, va, 1, Access::Maint, u, c.el()).map(|_| ())
    }

    /// An aligned access for the atomics: host pointer for `len` bytes.
    fn host_aligned(
        &mut self,
        c: &Cpu,
        va: u64,
        len: u64,
        access: Access,
    ) -> Result<*mut u8, Fault> {
        if !va.is_multiple_of(len) {
            return Err(Fault {
                addr: va,
                access,
                kind: FaultKind::Align,
            });
        }
        let u = if access == Access::Read {
            Use::Read
        } else {
            Use::Write
        };
        self.host(c, va, len, access, u, c.el())
    }

    /// Aligned single-copy-atomic read (acquire loads, exclusives).
    pub fn read_atomic(&mut self, c: &Cpu, va: u64, size: u32) -> Result<u64, Fault> {
        let p = self.host_aligned(c, va, size as u64, Access::Read)?;
        // SAFETY: aligned RAM (host_aligned).
        Ok(unsafe { mem::load_atomic(p, size) })
    }

    /// Aligned single-copy-atomic write (release stores).
    pub fn write_atomic(&mut self, c: &Cpu, va: u64, size: u32, val: u64) -> Result<(), Fault> {
        let p = self.host_aligned(c, va, size as u64, Access::Write)?;
        // SAFETY: as in read_atomic.
        unsafe { mem::store_atomic(p, size, val) };
        Ok(())
    }

    /// Atomic compare-and-swap. Returns the old value; the swap happened iff it
    /// equals `expected`. Faults report a write.
    pub fn cas(
        &mut self,
        c: &Cpu,
        va: u64,
        size: u32,
        expected: u64,
        new: u64,
    ) -> Result<u64, Fault> {
        let p = self.host_aligned(c, va, size as u64, Access::Write)?;
        // SAFETY: as in read_atomic.
        Ok(unsafe { mem::cas(p, size, expected, new) })
    }

    /// Atomic read-modify-write (LSE LDADD & co, SWP). Returns the old value.
    pub fn rmw(
        &mut self,
        c: &Cpu,
        va: u64,
        size: u32,
        op: impl Fn(u64) -> u64,
    ) -> Result<u64, Fault> {
        // ponytail: generic CAS loop; add/and/or/xor/xchg map to single wasm
        // atomic.rmw ops if a profile ever shows this.
        let p = self.host_aligned(c, va, size as u64, Access::Write)?;
        // SAFETY: as in read_atomic.
        unsafe {
            let mut old = mem::load_atomic(p, size);
            loop {
                let seen = mem::cas(p, size, old, op(old));
                if seen == old {
                    return Ok(old);
                }
                old = seen;
            }
        }
    }

    /// 2×`size` read of a naturally aligned pair, atomic with respect to [`Bus::cas_pair`] (LDXP).
    pub fn read_pair(&mut self, c: &Cpu, va: u64, size: u32) -> Result<[u64; 2], Fault> {
        let p = self.host_aligned(c, va, 2 * size as u64, Access::Read)?;
        // SAFETY: 2×size aligned bytes of RAM.
        Ok(unsafe { self.mem.pair_locked(p, size, |old| (old, None)) })
    }

    /// 2×`size` compare-and-swap of a naturally aligned pair (CASP, STXP).
    /// Returns the old pair; the swap happened iff it equals `expected`.
    pub fn cas_pair(
        &mut self,
        c: &Cpu,
        va: u64,
        size: u32,
        expected: [u64; 2],
        new: [u64; 2],
    ) -> Result<[u64; 2], Fault> {
        let p = self.host_aligned(c, va, 2 * size as u64, Access::Write)?;
        // SAFETY: as in read_pair.
        Ok(unsafe {
            self.mem
                .pair_locked(p, size, |old| (old, (old == expected).then_some(new)))
        })
    }
}

#[cfg(test)]
mod tests;
