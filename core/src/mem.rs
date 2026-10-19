//! Guest physical memory. [`Mem::host`] turns a guest physical address into a
//! host pointer; the MMU (`crate::mmu::Bus`, the one accessor the interpreter and
//! later JIT helpers use) translates virtual addresses and caches the host
//! pointer in its TLB. The access primitives here work on host pointers.
//!
//! RAM is one block at guest physical `phys..phys + size`, which on wasm32 sits
//! in the shared linear memory after the core state (layout A), and optionally
//! **spill memories** past it (docs/plans/spill-memories.md): more RAM, each in
//! its own memory, which the core reaches through an accessor ([`Spill`]). A
//! host address ([`Host`]) names its memory in its top byte: 0 is a plain
//! pointer into memory 0, the only kind the fast paths ever hold.

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

/// A host address: the memory's index in bits 63:56 (0: memory 0, where the
/// rest is a pointer), the offset in that memory below.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Host(pub u64);

/// Where a [`Host`] keeps its memory's index.
pub const MEM_SHIFT: u32 = 56;

/// The most spill memories a [`Mem`] takes (memories 1 to 8).
pub const MAX_SPILL: usize = 8;

impl Host {
    #[inline(always)]
    pub fn ptr(p: *mut u8) -> Self {
        Host(p as usize as u64)
    }

    /// The memory's index: 0 for memory 0.
    #[inline(always)]
    pub fn mem(self) -> usize {
        (self.0 >> MEM_SHIFT) as usize
    }

    /// The offset in a spill memory.
    #[inline(always)]
    pub fn off(self) -> u64 {
        self.0 & ((1 << MEM_SHIFT) - 1)
    }

    /// The pointer, if it's in memory 0.
    #[inline(always)]
    pub fn as_ptr(self) -> Option<*mut u8> {
        (self.mem() == 0).then_some(self.0 as usize as *mut u8)
    }

    #[inline(always)]
    pub fn plus(self, n: u64) -> Self {
        Host(self.0.wrapping_add(n))
    }
}

/// A spill memory: guest RAM at `phys..phys + size` in memory `index + 1`.
#[derive(Clone, Copy, Debug)]
pub struct Spill {
    pub phys: u64,
    pub size: u64,
    /// Natively, its bytes (16-byte aligned; on wasm the core can't address
    /// another memory, and the `ram` imports reach it: null).
    pub base: *mut u8,
}

/// Guest RAM, shared by all vCPUs.
pub struct Mem {
    base: *mut u8,
    size: u64,
    /// Guest physical address of the first RAM byte: 0 for user-mode hosts,
    /// 0x4000_0000 for a VM (the `virt` memory map, docs/platform.md).
    phys: u64,
    /// Memories 1 and up, in order, at increasing guest PAs past memory 0's.
    spill: Vec<Spill>,
    /// Serializes the 128-bit atomics (CASP, LDXP/STXP of two X registers)
    /// on the same 16 bytes: wasm has no 128-bit compare-and-swap. Hashed by
    /// address, a cache line each, so per-CPU pairs don't contend. Boxed: JIT
    /// code takes them at their address ([`Mem::pair_locks`]), which moving
    /// the `Mem` mustn't change.
    pair_locks: Box<[PairLock; PAIR_LOCKS]>,
}

pub(crate) const PAIR_LOCKS: usize = 16;

/// A pair lock's size (and stride): 0 free, 1 taken.
pub(crate) const PAIR_LOCK_SIZE: usize = 128;

#[repr(align(128))]
struct PairLock(AtomicU32);

// SAFETY: every access to the RAM is atomic (load, store and the atomics
// below); races between them are the guest's, as on hardware.
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
            spill: Vec::new(),
            pair_locks: Box::new([const { PairLock(AtomicU32::new(0)) }; PAIR_LOCKS]),
        }
    }

    /// Places the RAM at guest physical address `phys`.
    pub fn at(self, phys: u64) -> Self {
        Mem { phys, ..self }
    }

    /// Adds spill memories (memories 1 and up), each past the RAM before it.
    ///
    /// # Safety
    /// Natively, each `base..base + size` is as for [`Mem::new`]; on wasm,
    /// memory `k + 1` holds `spill[k].size` bytes for the life of the `Mem`.
    pub unsafe fn with_spill(self, spill: &[Spill]) -> Self {
        assert!(spill.len() <= MAX_SPILL, "too many spill memories");
        let mut end = self.phys + self.size;
        for s in spill {
            assert!(s.phys >= end && s.size <= 1 << 32, "spill memory {s:?}");
            end = s.phys + s.size;
        }
        Mem {
            spill: spill.to_vec(),
            ..self
        }
    }

    /// Memory 0's RAM size.
    pub fn size(&self) -> u64 {
        self.size
    }

    /// The spill memories, memory 1 first.
    pub fn spill(&self) -> &[Spill] {
        &self.spill
    }

    /// The host address of the pair locks: the one for the 16 bytes at host
    /// address `p` is at `(p >> 4) % PAIR_LOCKS * PAIR_LOCK_SIZE` from it (the
    /// JIT's inline CASP).
    pub fn pair_locks(&self) -> *const u8 {
        self.pair_locks.as_ptr() as *const u8
    }

    /// The host address of the first RAM byte, and its guest PA (the JIT's flat fast path).
    pub fn base(&self) -> (*mut u8, u64) {
        (self.base, self.phys)
    }

    /// Memory 0's host pointer for `len` bytes at `pa`, if they're there.
    #[inline(always)]
    pub fn host0(&self, pa: u64, len: u64) -> Option<*mut u8> {
        let off = pa.wrapping_sub(self.phys);
        match off.checked_add(len) {
            // SAFETY: off + len <= size, so the result is inside the RAM block.
            Some(end) if end <= self.size => Some(unsafe { self.base.add(off as usize) }),
            _ => None,
        }
    }

    /// Guest physical address to host address for `len` bytes of RAM, which
    /// lie in one memory.
    #[inline]
    pub fn host(&self, pa: u64, len: u64, access: Access) -> Result<Host, Fault> {
        match self.host0(pa, len) {
            Some(p) => Ok(Host::ptr(p)),
            None => self.host_spill(pa, len, access),
        }
    }

    #[inline(never)]
    fn host_spill(&self, pa: u64, len: u64, access: Access) -> Result<Host, Fault> {
        for (k, s) in self.spill.iter().enumerate() {
            let off = pa.wrapping_sub(s.phys);
            if off.checked_add(len).is_some_and(|end| end <= s.size) {
                return Ok(Host(((k as u64 + 1) << MEM_SHIFT) | off));
            }
        }
        Err(Fault {
            addr: pa,
            access,
            kind: FaultKind::Bus,
        })
    }

    /// Where `len` bytes at `pa` are as devices name them: (memory, offset),
    /// memory 0's offset from its first byte or a spill memory's in it.
    pub fn ram_offset(&self, pa: u64, len: u64) -> Option<(usize, u64)> {
        let h = self.host(pa, len, Access::Read).ok()?;
        Some(match h.mem() {
            0 => (0, pa - self.phys),
            m => (m, h.off()),
        })
    }

    /// The guest PA of a device's (memory, offset), [`Mem::ram_offset`]'s inverse.
    pub fn ram_pa(&self, m: usize, off: u64) -> u64 {
        match m {
            0 => self.phys + off,
            m => self.spill[m - 1].phys + off,
        }
    }

    /// The guest physical address of `h`, a host address in the RAM ([`Mem::host`]'s inverse).
    #[inline]
    pub fn pa(&self, h: Host) -> u64 {
        match h.mem() {
            0 => (h.0 as usize - self.base as usize) as u64 + self.phys,
            m => self.spill[m - 1].phys + h.off(),
        }
    }

    /// Physical little-endian read of 1, 2, 4 or 8 bytes (loaders, table walks, tests).
    pub fn read(&self, pa: u64, size: u32) -> Result<u64, Fault> {
        let h = self.host(pa, size as u64, Access::Read)?;
        // SAFETY: host() checked that `size` bytes at h are guest RAM.
        Ok(unsafe { self.load(h, size) })
    }

    /// Physical little-endian write of the low 1, 2, 4 or 8 bytes of `val`.
    pub fn write(&self, pa: u64, size: u32, val: u64) -> Result<(), Fault> {
        let h = self.host(pa, size as u64, Access::Write)?;
        // SAFETY: as in read.
        unsafe { self.store(h, size, val) };
        Ok(())
    }

    /// [`load`] at a host address of any memory.
    ///
    /// # Safety
    /// `h..h + size` is guest RAM ([`Mem::host`]).
    #[inline(always)]
    pub(crate) unsafe fn load(&self, h: Host, size: u32) -> u64 {
        match h.as_ptr() {
            // SAFETY: guaranteed by the caller.
            Some(p) => unsafe { load(p, size) },
            None => self.spill_load(h, size),
        }
    }

    /// [`store`] at a host address of any memory.
    ///
    /// # Safety
    /// As for [`Mem::load`].
    #[inline(always)]
    pub(crate) unsafe fn store(&self, h: Host, size: u32, val: u64) {
        match h.as_ptr() {
            // SAFETY: guaranteed by the caller.
            Some(p) => unsafe { store(p, size, val) },
            None => self.spill_store(h, size, val),
        }
    }

    /// [`load_atomic`] at a host address of any memory.
    ///
    /// # Safety
    /// As for [`Mem::load`], and `h` is aligned to `size`.
    #[inline(always)]
    pub(crate) unsafe fn load_atomic(&self, h: Host, size: u32) -> u64 {
        match h.as_ptr() {
            // SAFETY: guaranteed by the caller.
            Some(p) => unsafe { load_atomic(p, size) },
            None => self.acc_load(h, size),
        }
    }

    /// [`store_atomic`] at a host address of any memory.
    ///
    /// # Safety
    /// As for [`Mem::load_atomic`].
    #[inline(always)]
    pub(crate) unsafe fn store_atomic(&self, h: Host, size: u32, val: u64) {
        match h.as_ptr() {
            // SAFETY: guaranteed by the caller.
            Some(p) => unsafe { store_atomic(p, size, val) },
            None => self.acc_store(h, size, val),
        }
    }

    /// [`cas`] at a host address of any memory.
    ///
    /// # Safety
    /// As for [`Mem::load_atomic`].
    #[inline(always)]
    pub(crate) unsafe fn cas(&self, h: Host, size: u32, expected: u64, new: u64) -> u64 {
        match h.as_ptr() {
            // SAFETY: guaranteed by the caller.
            Some(p) => unsafe { cas(p, size, expected, new) },
            None => self.acc_cas(h, size, expected, new),
        }
    }

    /// A spill memory's load, in naturally aligned pieces as [`load`]'s.
    #[inline(never)]
    fn spill_load(&self, h: Host, size: u32) -> u64 {
        let (mut v, mut k) = (0, 0);
        while k < size {
            let q = h.plus(k as u64);
            let n = piece_at(q.off(), size - k);
            v |= self.acc_load(q, n) << (8 * k);
            k += n;
        }
        v
    }

    /// A spill memory's store, in naturally aligned pieces.
    #[inline(never)]
    fn spill_store(&self, h: Host, size: u32, val: u64) {
        let mut k = 0;
        while k < size {
            let q = h.plus(k as u64);
            let n = piece_at(q.off(), size - k);
            self.acc_store(q, n, val >> (8 * k));
            k += n;
        }
    }

    /// LDXP of two X registers: the 16 aligned bytes at `h`, atomic with
    /// respect to [`Mem::cas_pair`].
    ///
    /// # Safety
    /// `h` is 16 bytes of this RAM, 16-byte aligned.
    pub(crate) unsafe fn read_pair(&self, h: Host) -> [u64; 2] {
        // SAFETY: guaranteed by the caller.
        unsafe { self.pair_op(h, |_| None) }
    }

    /// CASP and STXP of two X registers: compare-and-swap of the 16 aligned
    /// bytes at `p`. Returns the old pair; the swap happened iff it equals
    /// `expected`.
    ///
    /// # Safety
    /// As for [`Mem::read_pair`].
    pub(crate) unsafe fn cas_pair(&self, h: Host, expected: [u64; 2], new: [u64; 2]) -> [u64; 2] {
        // SAFETY: guaranteed by the caller.
        unsafe { self.pair_op(h, |old| (old == expected).then_some(new)) }
    }

    /// Reads the pair at `p` and writes what `f` returns for it, if anything,
    /// under the pair's lock (docs/cpu.md "Memory accesses and atomics").
    ///
    /// # Safety
    /// As for [`Mem::read_pair`].
    unsafe fn pair_op(&self, p: Host, f: impl Fn([u64; 2]) -> Option<[u64; 2]>) -> [u64; 2] {
        let hi = p.plus(8);
        // The JIT's inline CASP hashes memory-0 pointers the same way.
        let lock = &self.pair_locks[(p.0 as usize >> 4) % PAIR_LOCKS].0;
        while lock.swap(1, Ordering::Acquire) != 0 {
            core::hint::spin_loop();
        }
        // SAFETY (the loads and CASes): guaranteed by the caller.
        let old = loop {
            let old = unsafe { [self.load_atomic(p, 8), self.load_atomic(hi, 8)] };
            // lo unchanged across the read of hi: the pair held `old` then.
            if unsafe { self.load_atomic(p, 8) } != old[0] {
                continue;
            }
            let Some(new) = f(old) else { break old };
            // Plain and 64-bit accesses don't take the lock, so each half is a
            // CAS against what was read: a store to lo since then fails the
            // first before anything is written (again); a store to hi since
            // then is ordered after this pair op, and kept.
            if unsafe { self.cas(p, 8, old[0], new[0]) } != old[0] {
                continue;
            }
            unsafe { self.cas(hi, 8, old[1], new[1]) };
            break old;
        };
        lock.store(0, Ordering::Release);
        old
    }
}

/// Little-endian load of 1, 2, 4 or 8 bytes, zero-extended. Unaligned is fine.
///
/// Guest RAM is shared with vCPUs on other threads, so every access is a
/// relaxed atomic (a plain one would be a data race: UB in Rust). An aligned
/// access is one single-copy-atomic access, as the architecture requires; an
/// unaligned one is naturally aligned pieces (the architecture asks only for
/// bytes then: we don't advertise LSE2).
///
/// # Safety
/// `p..p + size` is guest RAM.
#[inline(always)]
pub(crate) unsafe fn load(p: *const u8, size: u32) -> u64 {
    if p as usize & (size as usize - 1) == 0 {
        // SAFETY: guaranteed by the caller; aligned.
        unsafe { load_relaxed(p, size) }
    } else {
        // SAFETY: guaranteed by the caller.
        unsafe { load_split(p, size) }
    }
}

/// [`load`] of an unaligned access, in naturally aligned pieces.
///
/// # Safety
/// As for [`load`].
#[inline(never)]
unsafe fn load_split(p: *const u8, size: u32) -> u64 {
    let (mut v, mut k) = (0, 0);
    while k < size {
        let q = p.wrapping_add(k as usize);
        let n = piece(q, size - k);
        // SAFETY: q..q + n is inside p..p + size, and aligned to n.
        v |= unsafe { load_relaxed(q, n) } << (8 * k);
        k += n;
    }
    v
}

/// Little-endian store of the low 1, 2, 4 or 8 bytes of `val`. Unaligned is
/// fine; atomic as for [`load`].
///
/// # Safety
/// As for [`load`].
#[inline(always)]
pub(crate) unsafe fn store(p: *mut u8, size: u32, val: u64) {
    if p as usize & (size as usize - 1) == 0 {
        // SAFETY: guaranteed by the caller; aligned.
        unsafe { store_relaxed(p, size, val) }
    } else {
        // SAFETY: guaranteed by the caller.
        unsafe { store_split(p, size, val) }
    }
}

/// [`store`] of an unaligned access, in naturally aligned pieces.
///
/// # Safety
/// As for [`load`].
#[inline(never)]
unsafe fn store_split(p: *mut u8, size: u32, val: u64) {
    let mut k = 0;
    while k < size {
        let q = p.wrapping_add(k as usize);
        let n = piece(q, size - k);
        // SAFETY: as in load_split.
        unsafe { store_relaxed(q, n, val >> (8 * k)) };
        k += n;
    }
}

/// The largest naturally aligned access at `p` of at most `left` bytes.
#[inline]
fn piece(p: *const u8, left: u32) -> u32 {
    piece_at(p as usize as u64, left)
}

/// [`piece`] at an offset (a spill memory's: memories start aligned).
#[inline]
fn piece_at(off: u64, left: u32) -> u32 {
    1 << off.trailing_zeros().min(left.ilog2())
}

// The spill accessor: aligned single-copy-atomic accesses by (memory, offset).
// Natively each spill memory is a pointer; on wasm a module the host makes
// imports the spill memories and exports these (web/spill.ts).
#[cfg(target_arch = "wasm32")]
mod acc {
    #[link(wasm_import_module = "ram")]
    unsafe extern "C" {
        pub fn load(m: u32, off: u32, size: u32) -> u64;
        pub fn store(m: u32, off: u32, size: u32, val: u64);
        pub fn cas(m: u32, off: u32, size: u32, expected: u64, new: u64) -> u64;
    }
}

impl Mem {
    #[cfg(target_arch = "wasm32")]
    fn acc_load(&self, h: Host, size: u32) -> u64 {
        // SAFETY: the import traps out of bounds; `h` is aligned (the callers').
        unsafe { acc::load(h.mem() as u32, h.off() as u32, size) }
    }

    #[cfg(target_arch = "wasm32")]
    fn acc_store(&self, h: Host, size: u32, val: u64) {
        // SAFETY: as in acc_load.
        unsafe { acc::store(h.mem() as u32, h.off() as u32, size, val) }
    }

    #[cfg(target_arch = "wasm32")]
    fn acc_cas(&self, h: Host, size: u32, expected: u64, new: u64) -> u64 {
        // SAFETY: as in acc_load.
        unsafe { acc::cas(h.mem() as u32, h.off() as u32, size, expected, new) }
    }

    /// Natively, any host address's pointer (the native runners' backends).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn native_ptr(&self, h: Host) -> *mut u8 {
        match h.as_ptr() {
            Some(p) => p,
            None => self.spill[h.mem() - 1].base.wrapping_add(h.off() as usize),
        }
    }

    /// Natively, a spill address's pointer.
    #[cfg(not(target_arch = "wasm32"))]
    fn acc_ptr(&self, h: Host, size: u32) -> *mut u8 {
        let s = &self.spill[h.mem() - 1];
        assert!(h.off() + size as u64 <= s.size && h.off().is_multiple_of(size as u64));
        s.base.wrapping_add(h.off() as usize)
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn acc_load(&self, h: Host, size: u32) -> u64 {
        // SAFETY: acc_ptr checked the bounds and alignment (with_spill's contract).
        unsafe { load_atomic(self.acc_ptr(h, size), size) }
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn acc_store(&self, h: Host, size: u32, val: u64) {
        // SAFETY: as in acc_load.
        unsafe { store_atomic(self.acc_ptr(h, size), size, val) }
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn acc_cas(&self, h: Host, size: u32, expected: u64, new: u64) -> u64 {
        // SAFETY: as in acc_load.
        unsafe { cas(self.acc_ptr(h, size), size, expected, new) }
    }
}

/// Relaxed atomic load, zero-extended.
///
/// # Safety
/// As for [`load`], and `p` is aligned to `size`.
#[inline(always)]
unsafe fn load_relaxed(p: *const u8, size: u32) -> u64 {
    const O: Ordering = Ordering::Relaxed;
    let p = p as *mut u8;
    // SAFETY: guaranteed by the caller.
    unsafe {
        match size {
            1 => AtomicU8::from_ptr(p).load(O) as u64,
            2 => u16::from_le(AtomicU16::from_ptr(p as *mut u16).load(O)) as u64,
            4 => u32::from_le(AtomicU32::from_ptr(p as *mut u32).load(O)) as u64,
            8 => u64::from_le(AtomicU64::from_ptr(p as *mut u64).load(O)),
            _ => unreachable!("access size {size}"),
        }
    }
}

/// Relaxed atomic store of the low `size` bytes of `val`.
///
/// # Safety
/// As for [`load_relaxed`].
#[inline(always)]
unsafe fn store_relaxed(p: *mut u8, size: u32, val: u64) {
    const O: Ordering = Ordering::Relaxed;
    // SAFETY: guaranteed by the caller.
    unsafe {
        match size {
            1 => AtomicU8::from_ptr(p).store(val as u8, O),
            2 => AtomicU16::from_ptr(p as *mut u16).store((val as u16).to_le(), O),
            4 => AtomicU32::from_ptr(p as *mut u32).store((val as u32).to_le(), O),
            8 => AtomicU64::from_ptr(p as *mut u64).store(val.to_le(), O),
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
        _spill: Vec<Vec<u128>>,
        pub mem: Mem,
    }

    impl TestRam {
        pub fn new(size: usize) -> Self {
            Self::with_spill(size, &[])
        }

        /// Memory 0 of `size` bytes at PA 0 and a spill memory per `(phys, size)`.
        pub fn with_spill(size: usize, spill: &[(u64, usize)]) -> Self {
            let mut buf = vec![0u128; size.div_ceil(16)];
            let mut bufs: Vec<Vec<u128>> = spill
                .iter()
                .map(|&(_, n)| vec![0u128; n.div_ceil(16)])
                .collect();
            let regions: Vec<Spill> = spill
                .iter()
                .zip(&mut bufs)
                .map(|(&(phys, size), b)| Spill {
                    phys,
                    size: size as u64,
                    base: b.as_mut_ptr() as *mut u8,
                })
                .collect();
            // SAFETY: every buffer is 16-byte aligned, as long as its size, and
            // lives as long as mem (moving a Vec doesn't move its heap buffer).
            let mem =
                unsafe { Mem::new(buf.as_mut_ptr() as *mut u8, size as u64).with_spill(&regions) };
            TestRam {
                _buf: buf,
                _spill: bufs,
                mem,
            }
        }
    }

    #[test]
    fn spill_memories() {
        let r = TestRam::with_spill(0x1000, &[(0x4000, 0x1000), (0x8000, 0x2000)]);
        let m = &r.mem;
        // Each memory's addresses, and back.
        let h = m.host(0x4010, 8, Access::Read).unwrap();
        assert_eq!((h.mem(), h.off()), (1, 0x10));
        assert_eq!(m.pa(h), 0x4010);
        let h = m.host(0x9ff8, 8, Access::Read).unwrap();
        assert_eq!((h.mem(), h.off(), m.pa(h)), (2, 0x1ff8, 0x9ff8));
        assert_eq!(m.host(0x10, 8, Access::Read).unwrap().mem(), 0);
        assert_eq!(m.host0(0x4010, 8), None);
        // Holes, ends and accesses across a memory's end fault.
        for (pa, len) in [
            (0x1000, 1),
            (0x4ffc, 8),
            (0x5000, 1),
            (0x3fff, 2),
            (0xa000, 1),
        ] {
            assert_eq!(
                m.read(pa, len).map_err(|f| f.kind),
                Err(FaultKind::Bus),
                "{pa:#x}"
            );
        }
        // Unaligned, every size, against bytes (pieces through the accessor).
        for size in [2, 4, 8] {
            for off in 0x8100..0x8110 {
                let v = 0x0102_0304_0506_0708u64.wrapping_mul(off + size as u64);
                m.write(off, size, v).unwrap();
                let want = v & (u64::MAX >> (64 - 8 * size));
                assert_eq!(m.read(off, size).unwrap(), want, "{size} at {off:#x}");
                for k in 0..size as u64 {
                    assert_eq!(m.read(off + k, 1).unwrap(), want >> (8 * k) & 0xff);
                }
            }
        }
        // Atomics and pairs.
        let h = m.host(0x4020, 16, Access::Write).unwrap();
        // SAFETY: 16 aligned bytes of spill RAM.
        unsafe {
            m.store_atomic(h, 8, 5);
            assert_eq!(m.cas(h, 8, 4, 9), 5);
            assert_eq!(m.cas(h, 8, 5, 9), 5);
            assert_eq!(m.load_atomic(h, 8), 9);
            assert_eq!(m.cas_pair(h, [9, 0], [1, 2]), [9, 0]);
            assert_eq!(m.read_pair(h), [1, 2]);
        }
        assert_eq!(m.read(0x4028, 8), Ok(2));
    }

    #[test]
    fn little_endian_unaligned() {
        let r = TestRam::new(64);
        r.mem.write(3, 8, 0x1122_3344_5566_7788).unwrap();
        assert_eq!(r.mem.read(3, 1).unwrap(), 0x88);
        assert_eq!(r.mem.read(4, 4).unwrap(), 0x4455_6677);
        assert_eq!(r.mem.read(3, 8).unwrap(), 0x1122_3344_5566_7788);
        // Every size at every offset in a 16-byte window, against bytes.
        for size in [2, 4, 8] {
            for off in 16..32 {
                let v = 0x0102_0304_0506_0708u64.wrapping_mul(off + size as u64);
                r.mem.write(off, size, v).unwrap();
                let want = v & (u64::MAX >> (64 - 8 * size));
                assert_eq!(r.mem.read(off, size).unwrap(), want, "{size} at {off}");
                for k in 0..size as u64 {
                    assert_eq!(r.mem.read(off + k, 1).unwrap(), want >> (8 * k) & 0xff);
                }
            }
        }
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
