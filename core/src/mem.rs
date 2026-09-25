//! Guest memory. Every guest access, from the interpreter and later from JIT
//! helpers and devices, goes through [`Mem::host`]: that is where the M3 MMU/TLB
//! and the "A + spill memories" memory index (TLB tag bits 3–11,
//! `bench/spike/memory/REPORT.md` §4) will hook in.
//!
//! M1 memory is flat: guest address = offset into one RAM block, which on wasm32
//! sits in the shared linear memory after the core state (layout A).

use core::ptr;
use core::sync::atomic::{AtomicU8, AtomicU16, AtomicU32, AtomicU64, Ordering};

/// A guest memory access that didn't complete.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    /// Nothing is mapped at `addr` (external abort in M1; a translation fault once the MMU exists).
    Bus { addr: u64, write: bool },
    /// Misaligned exclusive, acquire/release or atomic access.
    Align { addr: u64, write: bool },
}

/// Guest RAM, shared by all vCPUs.
pub struct Mem {
    base: *mut u8,
    size: u64,
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
            pair_lock: AtomicU32::new(0),
        }
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    /// The one translation point: guest address to host pointer for `len` bytes.
    #[inline]
    fn host(&self, addr: u64, len: u64, write: bool) -> Result<*mut u8, Fault> {
        match addr.checked_add(len) {
            // SAFETY: addr + len <= size, so the result is inside the RAM block.
            Some(end) if end <= self.size => Ok(unsafe { self.base.add(addr as usize) }),
            _ => Err(Fault::Bus { addr, write }),
        }
    }

    #[inline]
    fn host_aligned(&self, addr: u64, len: u64, write: bool) -> Result<*mut u8, Fault> {
        if !addr.is_multiple_of(len) {
            return Err(Fault::Align { addr, write });
        }
        self.host(addr, len, write)
    }

    /// Little-endian read of 1, 2, 4 or 8 bytes, zero-extended. Unaligned is allowed.
    // ponytail: flat memory, so no page-crossing split; M3 adds it where host() learns pages.
    #[inline]
    pub fn read(&self, addr: u64, size: u32) -> Result<u64, Fault> {
        let p = self.host(addr, size as u64, false)?;
        // SAFETY: host() checked that `size` bytes at p are guest RAM.
        Ok(unsafe {
            match size {
                1 => *p as u64,
                2 => u16::from_le(ptr::read_unaligned(p as *const u16)) as u64,
                4 => u32::from_le(ptr::read_unaligned(p as *const u32)) as u64,
                8 => u64::from_le(ptr::read_unaligned(p as *const u64)),
                _ => unreachable!("access size {size}"),
            }
        })
    }

    /// Little-endian write of the low 1, 2, 4 or 8 bytes of `val`. Unaligned is allowed.
    #[inline]
    pub fn write(&self, addr: u64, size: u32, val: u64) -> Result<(), Fault> {
        let p = self.host(addr, size as u64, true)?;
        // SAFETY: host() checked that `size` bytes at p are guest RAM.
        unsafe {
            match size {
                1 => *p = val as u8,
                2 => ptr::write_unaligned(p as *mut u16, (val as u16).to_le()),
                4 => ptr::write_unaligned(p as *mut u32, (val as u32).to_le()),
                8 => ptr::write_unaligned(p as *mut u64, val.to_le()),
                _ => unreachable!("access size {size}"),
            }
        }
        Ok(())
    }

    /// Aligned single-copy-atomic read (acquire loads, exclusives).
    pub fn read_atomic(&self, addr: u64, size: u32) -> Result<u64, Fault> {
        let p = self.host_aligned(addr, size as u64, false)?;
        // SAFETY: p is aligned and in bounds (host_aligned, 16-byte-aligned base).
        Ok(unsafe {
            match size {
                1 => AtomicU8::from_ptr(p).load(Ordering::SeqCst) as u64,
                2 => AtomicU16::from_ptr(p as *mut u16).load(Ordering::SeqCst) as u64,
                4 => AtomicU32::from_ptr(p as *mut u32).load(Ordering::SeqCst) as u64,
                8 => AtomicU64::from_ptr(p as *mut u64).load(Ordering::SeqCst),
                _ => unreachable!("access size {size}"),
            }
        })
    }

    /// Aligned single-copy-atomic write (release stores).
    pub fn write_atomic(&self, addr: u64, size: u32, val: u64) -> Result<(), Fault> {
        let p = self.host_aligned(addr, size as u64, true)?;
        // SAFETY: as in read_atomic.
        unsafe {
            match size {
                1 => AtomicU8::from_ptr(p).store(val as u8, Ordering::SeqCst),
                2 => AtomicU16::from_ptr(p as *mut u16).store(val as u16, Ordering::SeqCst),
                4 => AtomicU32::from_ptr(p as *mut u32).store(val as u32, Ordering::SeqCst),
                8 => AtomicU64::from_ptr(p as *mut u64).store(val, Ordering::SeqCst),
                _ => unreachable!("access size {size}"),
            }
        }
        Ok(())
    }

    /// Atomic compare-and-swap. Returns the old value; the swap happened iff it equals `expected`.
    /// Faults report a write, as a read-modify-write's must (Linux relies on it for CoW).
    pub fn cas(&self, addr: u64, size: u32, expected: u64, new: u64) -> Result<u64, Fault> {
        let p = self.host_aligned(addr, size as u64, true)?;
        const O: Ordering = Ordering::SeqCst;
        // Ok and Err both carry the old value.
        let old = |r: Result<u64, u64>| r.unwrap_or_else(|v| v);
        // SAFETY: as in read_atomic.
        Ok(unsafe {
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
        })
    }

    /// Atomic read-modify-write (LSE LDADD & co, SWP). Returns the old value.
    pub fn rmw(&self, addr: u64, size: u32, op: impl Fn(u64) -> u64) -> Result<u64, Fault> {
        // ponytail: generic CAS loop; add/and/or/xor/xchg map to single wasm
        // atomic.rmw ops if a profile ever shows this.
        self.host_aligned(addr, size as u64, true)?; // fault as a write
        let mut old = self.read_atomic(addr, size)?;
        loop {
            let seen = self.cas(addr, size, old, op(old))?;
            if seen == old {
                return Ok(old);
            }
            old = seen;
        }
    }

    /// 2×`size` read of a naturally aligned pair, atomic with respect to [`Mem::cas_pair`] (LDXP).
    pub fn read_pair(&self, addr: u64, size: u32) -> Result<[u64; 2], Fault> {
        self.pair_locked(addr, size, false, |old| (old, None))
    }

    /// 2×`size` compare-and-swap of a naturally aligned pair (CASP, STXP).
    /// Returns the old pair; the swap happened iff it equals `expected`.
    pub fn cas_pair(
        &self,
        addr: u64,
        size: u32,
        expected: [u64; 2],
        new: [u64; 2],
    ) -> Result<[u64; 2], Fault> {
        self.pair_locked(addr, size, true, |old| {
            (old, (old == expected).then_some(new))
        })
    }

    /// Runs `f` on the pair at `addr` under `pair_lock`; writes back what it returns, if anything.
    fn pair_locked(
        &self,
        addr: u64,
        size: u32,
        write: bool,
        f: impl FnOnce([u64; 2]) -> ([u64; 2], Option<[u64; 2]>),
    ) -> Result<[u64; 2], Fault> {
        self.host_aligned(addr, 2 * size as u64, write)?;
        let hi = addr + size as u64;
        while self.pair_lock.swap(1, Ordering::Acquire) != 0 {
            core::hint::spin_loop();
        }
        // In bounds: host_aligned checked both halves.
        let (ret, new) = f([self.read(addr, size).unwrap(), self.read(hi, size).unwrap()]);
        if let Some([lo_v, hi_v]) = new {
            self.write(addr, size, lo_v).unwrap();
            self.write(hi, size, hi_v).unwrap();
        }
        self.pair_lock.store(0, Ordering::Release);
        Ok(ret)
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
    fn bounds_and_alignment() {
        let r = TestRam::new(64);
        let bus = |addr, write| Err(Fault::Bus { addr, write });
        let align = |addr, write| Err(Fault::Align { addr, write });
        assert_eq!(r.mem.read(57, 8), bus(57, false));
        assert_eq!(r.mem.read(u64::MAX, 2), bus(u64::MAX, false));
        assert_eq!(r.mem.write(60, 8, 0).map(|_| 0), bus(60, true));
        assert!(r.mem.read(56, 8).is_ok());
        assert_eq!(r.mem.read_atomic(4, 8), align(4, false));
        assert_eq!(r.mem.rmw(4, 8, |v| v), align(4, true));
        assert_eq!(
            r.mem.cas_pair(8, 8, [0; 2], [1; 2]).map(|_| 0),
            align(8, true)
        );
    }

    #[test]
    fn atomics() {
        let r = TestRam::new(64);
        for size in [1, 2, 4, 8] {
            let a = 4 * size as u64;
            let top = u64::MAX >> (64 - 8 * size);
            assert_eq!(r.mem.cas(a, size, 1, 5).unwrap(), 0); // fails, old = 0
            assert_eq!(r.mem.cas(a, size, 0, top).unwrap(), 0);
            assert_eq!(r.mem.read_atomic(a, size).unwrap(), top);
            assert_eq!(
                r.mem.rmw(a, size, |v| v.wrapping_add(2) & top).unwrap(),
                top
            );
            assert_eq!(r.mem.read(a, size).unwrap(), 1);
        }
        assert_eq!(r.mem.cas_pair(48, 8, [0, 0], [7, 9]).unwrap(), [0, 0]);
        assert_eq!(r.mem.cas_pair(48, 8, [7, 0], [1, 1]).unwrap(), [7, 9]);
        assert_eq!(r.mem.read_pair(48, 8).unwrap(), [7, 9]);
        assert_eq!(
            (r.mem.read(48, 8).unwrap(), r.mem.read(56, 8).unwrap()),
            (7, 9)
        );
    }
}
