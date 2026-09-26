//! Guest physical memory. [`Mem::host`] turns a guest physical address into a
//! host pointer; the MMU (`crate::mmu::Bus`, the one accessor the interpreter and
//! later JIT helpers use) translates virtual addresses and caches the host
//! pointer in its TLB. The access primitives here work on host pointers.
//!
//! RAM is one block at guest physical `phys..phys + size`, which on wasm32 sits
//! in the shared linear memory after the core state (layout A).

use core::ptr;
use core::sync::atomic::{AtomicU8, AtomicU16, AtomicU32, AtomicU64, Ordering};

/// A guest memory access that didn't complete.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fault {
    /// The address the access used (virtual when the MMU translated it).
    pub addr: u64,
    pub access: Access,
    pub kind: FaultKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Read,
    /// Also read-modify-writes, which report WnR = 1 (Linux relies on it for CoW).
    Write,
    /// Cache maintenance by VA (ESR CM = 1, WnR = 1).
    Maint,
}

/// What went wrong; the level is the translation table level.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FaultKind {
    /// No RAM (or, from step 4, device) at the physical address: synchronous external abort.
    Bus,
    Align,
    AddressSize(u8),
    Translation(u8),
    AccessFlag(u8),
    Permission(u8),
    /// External abort on a translation table walk.
    WalkBus(u8),
}

impl FaultKind {
    /// The ESR DFSC/IFSC and PAR_EL1.FST encoding.
    pub fn fsc(self) -> u32 {
        match self {
            FaultKind::Bus => 0x10,
            FaultKind::Align => 0x21,
            FaultKind::AddressSize(l) => l as u32,
            FaultKind::Translation(l) => 0x04 | l as u32,
            FaultKind::AccessFlag(l) => 0x08 | l as u32,
            FaultKind::Permission(l) => 0x0c | l as u32,
            FaultKind::WalkBus(l) => 0x14 | l as u32,
        }
    }
}

/// Guest RAM, shared by all vCPUs.
pub struct Mem {
    base: *mut u8,
    size: u64,
    /// Guest physical address of the first RAM byte: 0 for user-mode hosts,
    /// 0x4000_0000 for a VM (the `virt` memory map, PLAN.md M3).
    phys: u64,
    /// Serializes 128-bit atomics (CASP, STXP of two X registers): wasm has no
    /// 128-bit compare-and-swap.
    // ponytail: pair atomics aren't atomic against a concurrent 64-bit atomic on
    // the same bytes from another vCPU; M7 must make those take this lock too (or
    // stop the world) if litmus tests show it.
    pair_lock: AtomicU32,
}

// SAFETY: all access to the RAM goes through atomics or through
// ptr::read/write_unaligned of at most 8 bytes, which the guest memory model
// allows to race (single-copy atomicity for aligned accesses comes from wasm's
// and the host ISA's plain loads/stores).
unsafe impl Sync for Mem {}
unsafe impl Send for Mem {}

impl Mem {
    /// # Safety
    /// `base..base + size` must stay valid for reads and writes for the life of the
    /// `Mem`, be used only as guest RAM, and be 16-byte aligned.
    pub unsafe fn new(base: *mut u8, size: u64) -> Self {
        assert!(
            (base as usize).is_multiple_of(16),
            "guest RAM must be 16-byte aligned"
        );
        Mem {
            base,
            size,
            phys: 0,
            pair_lock: AtomicU32::new(0),
        }
    }

    /// Places the RAM at guest physical address `phys`.
    pub fn at(self, phys: u64) -> Self {
        Mem { phys, ..self }
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    /// Guest physical address to host pointer for `len` bytes of RAM.
    #[inline]
    pub fn host(&self, pa: u64, len: u64, access: Access) -> Result<*mut u8, Fault> {
        let off = pa.wrapping_sub(self.phys);
        match off.checked_add(len) {
            // SAFETY: off + len <= size, so the result is inside the RAM block.
            Some(end) if end <= self.size => Ok(unsafe { self.base.add(off as usize) }),
            _ => Err(Fault {
                addr: pa,
                access,
                kind: FaultKind::Bus,
            }),
        }
    }

    /// The guest physical address of `p`, a pointer into the RAM ([`Mem::host`]'s inverse).
    #[inline]
    pub fn pa(&self, p: *const u8) -> u64 {
        (p as usize - self.base as usize) as u64 + self.phys
    }

    /// Physical little-endian read of 1, 2, 4 or 8 bytes (loaders, table walks, tests).
    pub fn read(&self, pa: u64, size: u32) -> Result<u64, Fault> {
        let p = self.host(pa, size as u64, Access::Read)?;
        // SAFETY: host() checked that `size` bytes at p are guest RAM.
        Ok(unsafe { load(p, size) })
    }

    /// Physical little-endian write of the low 1, 2, 4 or 8 bytes of `val`.
    pub fn write(&self, pa: u64, size: u32, val: u64) -> Result<(), Fault> {
        let p = self.host(pa, size as u64, Access::Write)?;
        // SAFETY: as in read.
        unsafe { store(p, size, val) };
        Ok(())
    }

    /// Runs `f` on the naturally aligned pair of `size`-byte values at `p` under
    /// `pair_lock`, and writes back what it returns, if anything.
    ///
    /// # Safety
    /// `p` points at 2×`size` bytes of this RAM.
    pub(crate) unsafe fn pair_locked(
        &self,
        p: *mut u8,
        size: u32,
        f: impl FnOnce([u64; 2]) -> ([u64; 2], Option<[u64; 2]>),
    ) -> [u64; 2] {
        let hi = p.wrapping_add(size as usize);
        while self.pair_lock.swap(1, Ordering::Acquire) != 0 {
            core::hint::spin_loop();
        }
        // SAFETY: guaranteed by the caller.
        let (ret, new) = f(unsafe { [load(p, size), load(hi, size)] });
        if let Some([lo_v, hi_v]) = new {
            // SAFETY: as above.
            unsafe {
                store(p, size, lo_v);
                store(hi, size, hi_v);
            }
        }
        self.pair_lock.store(0, Ordering::Release);
        ret
    }
}

/// Little-endian load of 1, 2, 4 or 8 bytes, zero-extended. Unaligned is fine.
///
/// # Safety
/// `p..p + size` is guest RAM.
#[inline]
pub(crate) unsafe fn load(p: *const u8, size: u32) -> u64 {
    // SAFETY: guaranteed by the caller.
    unsafe {
        match size {
            1 => *p as u64,
            2 => u16::from_le(ptr::read_unaligned(p as *const u16)) as u64,
            4 => u32::from_le(ptr::read_unaligned(p as *const u32)) as u64,
            8 => u64::from_le(ptr::read_unaligned(p as *const u64)),
            _ => unreachable!("access size {size}"),
        }
    }
}

/// Little-endian store of the low 1, 2, 4 or 8 bytes of `val`. Unaligned is fine.
///
/// # Safety
/// As for [`load`].
#[inline]
pub(crate) unsafe fn store(p: *mut u8, size: u32, val: u64) {
    // SAFETY: guaranteed by the caller.
    unsafe {
        match size {
            1 => *p = val as u8,
            2 => ptr::write_unaligned(p as *mut u16, (val as u16).to_le()),
            4 => ptr::write_unaligned(p as *mut u32, (val as u32).to_le()),
            8 => ptr::write_unaligned(p as *mut u64, val.to_le()),
            _ => unreachable!("access size {size}"),
        }
    }
}

/// Single-copy-atomic load.
///
/// # Safety
/// As for [`load`], and `p` is aligned to `size`.
pub(crate) unsafe fn load_atomic(p: *mut u8, size: u32) -> u64 {
    const O: Ordering = Ordering::SeqCst;
    // SAFETY: guaranteed by the caller.
    unsafe {
        match size {
            1 => AtomicU8::from_ptr(p).load(O) as u64,
            2 => AtomicU16::from_ptr(p as *mut u16).load(O) as u64,
            4 => AtomicU32::from_ptr(p as *mut u32).load(O) as u64,
            8 => AtomicU64::from_ptr(p as *mut u64).load(O),
            _ => unreachable!("access size {size}"),
        }
    }
}

/// Single-copy-atomic store.
///
/// # Safety
/// As for [`load_atomic`].
pub(crate) unsafe fn store_atomic(p: *mut u8, size: u32, val: u64) {
    const O: Ordering = Ordering::SeqCst;
    // SAFETY: guaranteed by the caller.
    unsafe {
        match size {
            1 => AtomicU8::from_ptr(p).store(val as u8, O),
            2 => AtomicU16::from_ptr(p as *mut u16).store(val as u16, O),
            4 => AtomicU32::from_ptr(p as *mut u32).store(val as u32, O),
            8 => AtomicU64::from_ptr(p as *mut u64).store(val, O),
            _ => unreachable!("access size {size}"),
        }
    }
}

/// Atomic compare-and-swap. Returns the old value; the swap happened iff it equals `expected`.
///
/// # Safety
/// As for [`load_atomic`].
pub(crate) unsafe fn cas(p: *mut u8, size: u32, expected: u64, new: u64) -> u64 {
    const O: Ordering = Ordering::SeqCst;
    // Ok and Err both carry the old value.
    let old = |r: Result<u64, u64>| r.unwrap_or_else(|v| v);
    // SAFETY: guaranteed by the caller.
    unsafe {
        match size {
            1 => old(AtomicU8::from_ptr(p)
                .compare_exchange(expected as u8, new as u8, O, O)
                .map(u64::from)
                .map_err(u64::from)),
            2 => old(AtomicU16::from_ptr(p as *mut u16)
                .compare_exchange(expected as u16, new as u16, O, O)
                .map(u64::from)
                .map_err(u64::from)),
            4 => old(AtomicU32::from_ptr(p as *mut u32)
                .compare_exchange(expected as u32, new as u32, O, O)
                .map(u64::from)
                .map_err(u64::from)),
            8 => old(AtomicU64::from_ptr(p as *mut u64).compare_exchange(expected, new, O, O)),
            _ => unreachable!("access size {size}"),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Owns zeroed, 16-byte-aligned RAM for native tests.
    pub struct TestRam {
        _buf: Vec<u128>,
        pub mem: Mem,
    }

    impl TestRam {
        pub fn new(size: usize) -> Self {
            let mut buf = vec![0u128; size.div_ceil(16)];
            // SAFETY: buf is 16-byte aligned, `size` bytes long, and lives as long as mem.
            let mem = unsafe { Mem::new(buf.as_mut_ptr() as *mut u8, size as u64) };
            TestRam { _buf: buf, mem }
        }
    }

    #[test]
    fn little_endian_unaligned() {
        let r = TestRam::new(64);
        r.mem.write(3, 8, 0x1122_3344_5566_7788).unwrap();
        assert_eq!(r.mem.read(3, 1).unwrap(), 0x88);
        assert_eq!(r.mem.read(4, 4).unwrap(), 0x4455_6677);
        assert_eq!(r.mem.read(3, 8).unwrap(), 0x1122_3344_5566_7788);
    }

    #[test]
    fn bounds_and_phys_base() {
        let bus = |addr, access| {
            Err(Fault {
                addr,
                access,
                kind: FaultKind::Bus,
            })
        };
        let r = TestRam::new(64);
        assert_eq!(r.mem.read(57, 8), bus(57, Access::Read));
        assert_eq!(r.mem.read(u64::MAX, 2), bus(u64::MAX, Access::Read));
        assert_eq!(r.mem.write(60, 8, 0).map(|_| 0), bus(60, Access::Write));
        assert!(r.mem.read(56, 8).is_ok());
        let mut t = TestRam::new(64);
        t.mem.phys = 0x4000_0000;
        t.mem.write(0x4000_0038, 8, 7).unwrap();
        assert_eq!(t.mem.read(0x4000_0038, 8), Ok(7));
        assert_eq!(t.mem.read(0x3fff_fff8, 8), bus(0x3fff_fff8, Access::Read));
    }
}
