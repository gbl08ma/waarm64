//! Stage 1 MMU for the EL1&0 regime (4K granule, up to 48-bit VAs, TTBR0/TTBR1,
//! TBI, software-managed access flag) and the per-vCPU software TLB.
//!
//! [`Bus`] is the one virtual-address accessor: the interpreter (and later the
//! JIT's slow paths) do every guest access through it. [`Mmu`] returns host
//! pointers from the TLB or from a walk; [`Mem`] only knows physical addresses.
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
//! Entries carry no ASID: the arrays only ever hold global entries and the
//! current ASID's non-global (nG) ones. An ASID change or `TLBI ASIDE1` drops
//! the nG entries alone, found through a list of the slots they were filled
//! into (`Tlb::ng`), so the kernel's global entries survive context switches
//! (M6 loop 9: Alpine's boot refilled 3.2M of them after 5,700 whole flushes).
// ponytail: the nG entries of the previous ASID are dropped, not kept for when
// it's current again (per-ASID stashes; 0.3M nG refills in Alpine's boot).

use crate::cpu::{Cpu, sctlr};
use crate::mem::{self, Access, Fault, FaultKind, Mem};

pub const TLB_ENTRIES: usize = 4096;
/// Capacity of the nG slot list; past it, dropping the nG entries flushes all.
const NG_SLOTS: usize = 1024;
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
    /// Slots (`array * TLB_ENTRIES + index`) filled with nG entries since the
    /// last flush, `ng_len` of them; `ng_len` past `NG_SLOTS` means the list
    /// overflowed. A slot may since hold another entry: dropping it then is an
    /// over-invalidation, which is always allowed.
    ng: [u16; NG_SLOTS],
    ng_len: u32,
    pub stats: TlbStats,
}

/// Counted in the slow paths; the VM run loop publishes them (`vm::Counters`).
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct TlbStats {
    /// Lookups with the MMU on that missed (each walks the tables).
    pub misses: u64,
    /// Walks that reached a page with the access permitted.
    pub walks: u64,
    /// Whole-TLB, nG and by-VA invalidations (TLBI, ASID and MMU-enable
    /// changes).
    pub flushes: u64,
}

impl Tlb {
    pub(crate) fn flush_all(&mut self) {
        self.stats.flushes += 1;
        for a in &mut self.e {
            a.fill(Entry::default());
        }
        self.ng_len = 0;
    }

    /// Drops every nG entry: the global ones match any ASID.
    pub(crate) fn flush_ng(&mut self) {
        let n = self.ng_len as usize;
        if n > NG_SLOTS {
            return self.flush_all();
        }
        self.stats.flushes += 1;
        for &s in &self.ng[..n] {
            self.e[s as usize / TLB_ENTRIES][s as usize % TLB_ENTRIES] = Entry::default();
        }
        self.ng_len = 0;
    }

    fn fill(&mut self, array: usize, va: u64, addend: u64, ng: bool) {
        self.e[array][index(va)] = Entry {
            tag: va | 0xfff,
            addend,
        };
        if ng {
            let n = self.ng_len as usize;
            if n < NG_SLOTS {
                self.ng[n] = (array * TLB_ENTRIES + index(va)) as u16;
            }
            self.ng_len = (n + 1).min(NG_SLOTS + 1) as u32;
        }
    }

    /// Drops the page holding `va` from every array, whatever its top byte (TBI).
    pub(crate) fn flush_va(&mut self, va: u64) {
        self.stats.flushes += 1;
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

/// A vCPU: architectural state, the JIT's vector constants, then its TLB,
/// then its JIT state. `repr(C)` with `cpu` first, so a `*mut Vcpu` is also a
/// `*mut Cpu` with the host ABI offsets; JIT blocks get this pointer
/// (docs/jit.md).
#[repr(C)]
pub struct Vcpu {
    pub cpu: Cpu,
    /// Constants JIT code loads at fixed offsets from the vCPU pointer
    /// (`jit::emit::crypto`, M6.5): one `ldr q` each, where V8 would build a
    /// `v128.const` from sixteen bytes of immediates every time.
    pub consts: crate::jit::emit::Consts,
    pub tlb: Tlb,
    pub jit: crate::jit::State,
}

impl Vcpu {
    /// Boxed: the TLB is 384 KiB.
    pub fn new(cpu: Cpu) -> Box<Vcpu> {
        let mut v = Box::<Vcpu>::new_zeroed();
        let p = v.as_mut_ptr();
        // SAFETY: `cpu`, `consts` and `jit` are written here; the TLB is plain integers,
        // valid zeroed (and empty).
        unsafe {
            (&raw mut (*p).cpu).write(cpu);
            (&raw mut (*p).consts).write(crate::jit::emit::CONSTS);
            (&raw mut (*p).jit).write(Default::default());
            v.assume_init()
        }
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
    /// Not global: the translation belongs to the current ASID only.
    pub ng: bool,
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
            ng: desc >> 11 & 1 == 1,
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

/// Guest virtual memory as the interpreter sees it. Two implementations, and
/// the interpreter is compiled once for each: [`Flat`] while the MMU and
/// alignment checks are off, [`Mmu`] otherwise. The run loop picks one per
/// instruction from `SCTLR_EL1`. Keeping the flat copy free of any MMU code
/// is worth ~15% in V8 (bench/interp/REPORT.md, M3).
pub trait Bus {
    fn mem(&self) -> &Mem;
    /// Little-endian read of 1, 2, 4 or 8 bytes, zero-extended, with `el`'s
    /// permissions (0 for LDTR at EL1).
    fn read_el(&mut self, c: &Cpu, va: u64, size: u32, el: u64) -> Result<u64, Fault>;
    /// Little-endian write of the low 1, 2, 4 or 8 bytes of `val` with `el`'s permissions.
    fn write_el(&mut self, c: &Cpu, va: u64, size: u32, val: u64, el: u64) -> Result<(), Fault>;
    /// Instruction fetch (PC alignment is the caller's).
    fn fetch(&mut self, c: &Cpu, pc: u64) -> Result<u32, Fault>;
    /// Cache maintenance by VA: translates and checks permission (write for
    /// `DC IVAC`, read otherwise), and faults like a data access with CM set.
    /// Returns the PA (for `IC IVAU`, which invalidates JIT blocks).
    fn maint(&mut self, c: &Cpu, va: u64, write: bool) -> Result<u64, Fault>;
    /// Host pointer for an access by the atomics, which must be aligned to `len`.
    fn host_aligned(
        &mut self,
        c: &Cpu,
        va: u64,
        len: u64,
        access: Access,
    ) -> Result<*mut u8, Fault>;
    fn flush_all(&mut self) {}
    fn flush_va(&mut self, _va: u64) {}
    /// Drops the non-global entries (ASID changes, `TLBI ASIDE1`).
    fn flush_ng(&mut self) {}

    #[inline(always)]
    fn read(&mut self, c: &Cpu, va: u64, size: u32) -> Result<u64, Fault> {
        self.read_el(c, va, size, c.el())
    }

    #[inline(always)]
    fn write(&mut self, c: &Cpu, va: u64, size: u32, val: u64) -> Result<(), Fault> {
        self.write_el(c, va, size, val, c.el())
    }

    /// Aligned single-copy-atomic read (acquire loads, exclusives).
    fn read_atomic(&mut self, c: &Cpu, va: u64, size: u32) -> Result<u64, Fault> {
        let p = self.host_aligned(c, va, size as u64, Access::Read)?;
        // SAFETY: aligned RAM (host_aligned).
        Ok(unsafe { mem::load_atomic(p, size) })
    }

    /// Aligned single-copy-atomic write (release stores).
    fn write_atomic(&mut self, c: &Cpu, va: u64, size: u32, val: u64) -> Result<(), Fault> {
        let p = self.host_aligned(c, va, size as u64, Access::Write)?;
        // SAFETY: as in read_atomic.
        unsafe { mem::store_atomic(p, size, val) };
        Ok(())
    }

    /// Atomic compare-and-swap. Returns the old value; the swap happened iff it
    /// equals `expected`. Faults report a write.
    fn cas(&mut self, c: &Cpu, va: u64, size: u32, expected: u64, new: u64) -> Result<u64, Fault> {
        let p = self.host_aligned(c, va, size as u64, Access::Write)?;
        // SAFETY: as in read_atomic.
        Ok(unsafe { mem::cas(p, size, expected, new) })
    }

    /// Atomic read-modify-write (LSE LDADD & co, SWP). Returns the old value.
    fn rmw(&mut self, c: &Cpu, va: u64, size: u32, op: impl Fn(u64) -> u64) -> Result<u64, Fault> {
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

    /// 2×`size` read of a naturally aligned pair, atomic with respect to `cas_pair` (LDXP).
    fn read_pair(&mut self, c: &Cpu, va: u64, size: u32) -> Result<[u64; 2], Fault> {
        let p = self.host_aligned(c, va, 2 * size as u64, Access::Read)?;
        // SAFETY: 2×size aligned bytes of RAM.
        Ok(unsafe { self.mem().pair_locked(p, size, |old| (old, None)) })
    }

    /// 2×`size` compare-and-swap of a naturally aligned pair (CASP, STXP).
    /// Returns the old pair; the swap happened iff it equals `expected`.
    fn cas_pair(
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
            self.mem()
                .pair_locked(p, size, |old| (old, (old == expected).then_some(new)))
        })
    }
}

fn misaligned(va: u64, access: Access) -> Fault {
    Fault {
        addr: va,
        access,
        kind: FaultKind::Align,
    }
}

/// MMU and `SCTLR_EL1.A` off: VA = PA, no permissions, no page splits.
pub struct Flat<'a>(pub &'a Mem);

impl Bus for Flat<'_> {
    #[inline(always)]
    fn mem(&self) -> &Mem {
        self.0
    }

    #[inline(always)]
    fn read_el(&mut self, _: &Cpu, va: u64, size: u32, _: u64) -> Result<u64, Fault> {
        self.0.read(va, size)
    }

    #[inline(always)]
    fn write_el(&mut self, _: &Cpu, va: u64, size: u32, val: u64, _: u64) -> Result<(), Fault> {
        self.0.write(va, size, val)
    }

    #[inline(always)]
    fn fetch(&mut self, _: &Cpu, pc: u64) -> Result<u32, Fault> {
        self.0.read(pc, 4).map(|v| v as u32)
    }

    fn maint(&mut self, _: &Cpu, va: u64, _: bool) -> Result<u64, Fault> {
        self.0.host(va, 1, Access::Maint).map(|_| va)
    }

    #[inline(always)]
    fn host_aligned(
        &mut self,
        _: &Cpu,
        va: u64,
        len: u64,
        access: Access,
    ) -> Result<*mut u8, Fault> {
        if !va.is_multiple_of(len) {
            return Err(misaligned(va, access));
        }
        self.0.host(va, len, access)
    }
}

/// One host pointer, or two for a page-crossing access (the second with the
/// number of bytes that go to the first).
type Span = (*mut u8, Option<(*mut u8, u64)>);

/// Stage 1 translation through the vCPU's TLB. Without a TLB (unit tests)
/// every access walks. With the MMU off but `SCTLR_EL1.A` on, VA = PA.
pub struct Mmu<'a> {
    pub mem: &'a Mem,
    pub tlb: Option<&'a mut Tlb>,
}

impl<'a> Mmu<'a> {
    pub fn new(mem: &'a Mem, tlb: Option<&'a mut Tlb>) -> Self {
        Mmu { mem, tlb }
    }

    /// Host pointer for `len` bytes at `va`, which must not cross a page.
    #[inline(always)]
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
        if let Some(t) = &self.tlb {
            let e = t.e[3 * el as usize + u as usize][index(va)];
            if e.tag == va.wrapping_add(len - 1) | 0xfff {
                return Ok(va.wrapping_add(e.addend) as usize as *mut u8);
            }
        }
        self.miss(c, va, len, access, u, el)
    }

    /// The host pointer of the instruction at `pc` (aligned), through the
    /// instruction TLB; the JIT keys blocks by its PA (`Mem::pa`).
    #[inline(always)]
    pub fn fetch_ptr(&mut self, c: &Cpu, pc: u64) -> Result<*mut u8, Fault> {
        self.host(c, pc, 4, Access::Read, Use::Exec, c.el())
    }

    /// TLB miss: walk, check permissions, and fill the TLB if the page is RAM.
    #[inline(never)]
    fn miss(
        &mut self,
        c: &Cpu,
        va: u64,
        len: u64,
        access: Access,
        u: Use,
        el: u64,
    ) -> Result<*mut u8, Fault> {
        let fault = |kind| Fault {
            addr: va,
            access,
            kind,
        };
        if let Some(t) = &mut self.tlb {
            t.stats.misses += 1;
        }
        let w = walk(c, self.mem, va).map_err(fault)?;
        if !w.allows(el, u) {
            return Err(fault(FaultKind::Permission(w.level)));
        }
        if let Some(t) = &mut self.tlb {
            t.stats.walks += 1;
        }
        let p = self
            .mem
            .host(w.pa, len, access)
            .map_err(|f| Fault { addr: va, ..f })?;
        if let Some(t) = &mut self.tlb
            && let Ok(page) = self.mem.host(w.pa & !0xfff, 0x1000, access)
        {
            let addend = (page as usize as u64).wrapping_sub(va & !0xfff);
            t.fill(3 * el as usize + u as usize, va, addend, w.ng);
        }
        Ok(p)
    }

    /// Host pointers for the two pages of a page-crossing access, both
    /// translated before either is touched, and the byte count in the first.
    /// `SCTLR_EL1.A` makes every misaligned access fault first.
    #[inline(always)]
    fn span(
        &mut self,
        c: &Cpu,
        va: u64,
        size: u32,
        access: Access,
        u: Use,
        el: u64,
    ) -> Result<Span, Fault> {
        if c.sctlr_el1 & sctlr::A != 0 && !va.is_multiple_of(size as u64) {
            return Err(misaligned(va, access));
        }
        let first = 0x1000 - (va & 0xfff);
        if size as u64 <= first {
            return Ok((self.host(c, va, size as u64, access, u, el)?, None));
        }
        let p1 = self.host(c, va, first, access, u, el)?;
        let p2 = self.host(
            c,
            va.wrapping_add(first),
            size as u64 - first,
            access,
            u,
            el,
        )?;
        Ok((p1, Some((p2, first))))
    }
}

impl Bus for Mmu<'_> {
    fn mem(&self) -> &Mem {
        self.mem
    }

    fn read_el(&mut self, c: &Cpu, va: u64, size: u32, el: u64) -> Result<u64, Fault> {
        Ok(match self.span(c, va, size, Access::Read, Use::Read, el)? {
            // SAFETY: host() checked the bytes are RAM.
            (p, None) => unsafe { mem::load(p, size) },
            (p1, Some((p2, first))) => (0..size as u64).fold(0, |v, k| {
                // SAFETY: the first `first` bytes are at p1, the rest at p2, all RAM.
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

    fn write_el(&mut self, c: &Cpu, va: u64, size: u32, val: u64, el: u64) -> Result<(), Fault> {
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

    fn fetch(&mut self, c: &Cpu, pc: u64) -> Result<u32, Fault> {
        let p = self.fetch_ptr(c, pc)?;
        // SAFETY: host() checked 4 bytes of RAM.
        Ok(unsafe { mem::load(p, 4) } as u32)
    }

    fn maint(&mut self, c: &Cpu, va: u64, write: bool) -> Result<u64, Fault> {
        let u = if write { Use::Write } else { Use::Read };
        let p = self.host(c, va, 1, Access::Maint, u, c.el())?;
        Ok(self.mem.pa(p))
    }

    fn host_aligned(
        &mut self,
        c: &Cpu,
        va: u64,
        len: u64,
        access: Access,
    ) -> Result<*mut u8, Fault> {
        if !va.is_multiple_of(len) {
            return Err(misaligned(va, access));
        }
        let u = if access == Access::Read {
            Use::Read
        } else {
            Use::Write
        };
        self.host(c, va, len, access, u, c.el())
    }

    fn flush_all(&mut self) {
        if let Some(t) = &mut self.tlb {
            t.flush_all();
        }
    }

    fn flush_va(&mut self, va: u64) {
        if let Some(t) = &mut self.tlb {
            t.flush_va(va);
        }
    }

    fn flush_ng(&mut self) {
        if let Some(t) = &mut self.tlb {
            t.flush_ng();
        }
    }
}

#[cfg(test)]
mod tests;
