//! Stage 1 MMU for the EL1&0 regime (4K granule, up to 48-bit VAs, TTBR0/TTBR1,
//! TBI, software-managed access flag) and the per-vCPU software TLB.
//!
//! [`Bus`] is the one virtual-address accessor: the interpreter (and later the
//! JIT's slow paths) do every guest access through it. [`Mmu`] returns host
//! pointers from the TLB or from a walk; [`Mem`] only knows physical addresses.
//!
//! **TLB entry (the shape the M0 spike measured, `bench/spike/REPORT.md` §4):**
//! direct-mapped, `TLB_ENTRIES` × `{tag, addend}` of 16 bytes, one array per
//! (EL, read/write/execute), so permissions need no check on a hit. The arrays
//! are interleaved by index (`e[index][array]`, a 128-byte line an index): every
//! array then starts within 0x800 bytes of the `Vcpu`, an offset V8 folds into
//! the load, where separate arrays took a `mov`+`movk` per tag and addend. The tag is
//! the page's VA with bits 11:0 all ones; the lookup compares it with
//! `(va + size - 1) | 0xfff`, so an access that crosses into the next page misses,
//! and an all-zero entry never matches. Bits 11:3 of the tag are the memory index
//! (`bench/spike/memory/REPORT.md` §4), stored inverted: all ones is memory 0.
//! `host = va + addend`, a [`Host`] (a spill memory's index in its top byte).
//! Every inline compare expects memory 0's all ones, so a spill memory's entry
//! misses there; [`Mmu::miss`] recognises it (docs/spill-memories.md).
//!
//! **The sibling fill:** a data access's walk computes what its EL may do with
//! the page, and [`Mmu::miss`] fills the EL's other data array too (the write
//! array at a read's walk, the read array at a write's) when the walk permits
//! that access and the slot there is empty: a page read and then written (or
//! the other way) walks once. That is a TLB's own behaviour (an entry caches
//! the permissions; a guest that takes one away sends a TLBI, which drops
//! every array's entry), and no walk has state to update (the access flag is
//! software-managed, no DBM). Never over another page's entry (a copy between
//! two pages of one index would then walk at every access), nor for a Device
//! page, nor the write entry of a watched page (`Tlb::fill_watched` records
//! those, at a write).
//!
//! Entries carry no ASID: the arrays only ever hold global entries and the
//! current ASID's non-global (nG) ones. An ASID change or `TLBI ASIDE1` drops
//! the nG entries alone, found through a list of the slots they were filled
//! into (`Tlb::ng`), or past its capacity through their marks in `Tlb::blk`,
//! so the kernel's global entries survive context switches (M6 loop 9:
//! Alpine's boot refilled 3.2M of them after 5,700 whole flushes).
//!
//! A block (a 2 MiB or 1 GiB leaf) is cached as entries for the pages it was
//! accessed through, and a TLBI by VA must drop all of them: Linux unmaps a
//! transparent huge page with one TLBI for the 2 MiB (`__flush_tlb_range`'s
//! stride). `Tlb::blk` marks the slots filled from blocks, by class (VA half
//! and level), and a flush by VA scans a block's indices for each class whose
//! entries the TLB may hold for that block: `Tlb::rblk` counts the live ones
//! by a hash of class and block, so the kernel's 2 MiB entries (live all the
//! time) don't send every flush in their half through 512 indices, nor a
//! 1 GiB block's through all of them.
//!
//! The previous ASID's nG entries are dropped at a switch, not stashed for
//! when it is current again: a stash would serve at most ~1.2% of a Firefox
//! session's busy time before its own costs, under 0.4% elsewhere
//! (docs/cpu.md "ASIDs", bench/boot/REPORT.md "PERF loop 97").
//
// **The transfer cache** (`Tlb::xc`): JIT blocks find the compiled block an
// indirect branch (or a by-VA link) goes to by its VA in one probe, without
// the instruction TLB and the jump cache (docs/jit.md "Linking").
// It holds no translation of its own, only what one implied: the flushes
// above drop its entries, by bumping a generation that the entries carry
// (one per EL), or one page's. Dropping the nG entries drops an EL's only if
// its instruction TLB may hold nG ones, so Linux's kernel entries (global)
// survive context switches as its TLB entries do (the user's, nG, don't); a
// flush by VA (most of Linux's: the user pages it unmaps) drops the page's,
// scanning its slots only if instruction fetches translated it (`Tlb::xpages`:
// nearly all of those flushes are for data pages).

use crate::cpu::{Cpu, sctlr};
use crate::mem::{Access, Fault, FaultKind, Host, MEM_SHIFT, Mem};

pub const TLB_ENTRIES: usize = 16384;
/// In a TLB entry's tag, bit 11 cleared (above the inverted memory index, bits
/// 10:3): a Device page's entry, which every fast path misses, so that
/// [`Mmu::miss`] checks the alignment of each access to it.
const DEVICE: u64 = 1 << 11;
/// The memory index of a device's page in a data entry (no RAM: the "host address" is
/// the PA, [`Mmu::mmio_pa`]): [`Mmu::miss`] sends the access to the bus without a walk.
/// Above every spill memory's ([`crate::mem::MAX_SPILL`]).
const MMIO: u64 = 0xff;
/// The tag's memory index bits, all zero for a device's page ([`MMIO`], inverted).
const MMIO_BITS: u64 = 0x7f8;
/// Entries an index holds, one per array: six used, a power of two for the
/// JIT's shift and mask.
pub const TLB_SLOTS: usize = 8;
/// Capacity of the nG slot list; past it, dropping the nG entries scans
/// `Tlb::blk` for [`NG`] marks instead.
const NG_SLOTS: usize = 1024;
/// In `Tlb::blk`, a slot's mark that it holds an nG entry (above the block
/// class, bits 2:0).
const NG: u8 = 0x80;
/// In `Tlb::blk`, a slot's block class ([`block_class`]; 0 for a page).
const CLASS: u8 = 7;
/// Physical address size we advertise (`ID_AA64MMFR0_EL1.PARange` = 40 bits).
pub const PA_BITS: u32 = 40;
const OA_MASK: u64 = 0x0000_ffff_ffff_f000;
/// Transfer cache entries (`Tlb::xc`).
pub const XC_ENTRIES: usize = 16384;

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

/// A transfer cache entry: the block for the VA in `tag` (with the block
/// key's regime bits), in `to` as `idx | len << 32 | gen << 48`: its table
/// index, its length and its EL's generation when it was filled. JIT code reads it
/// (`jit::emit::indirect`), so its layout is fixed.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Xc {
    pub tag: u64,
    pub to: u64,
}

/// One TLB index's entries, one per array, on a 128-byte line of their own.
#[repr(C, align(128))]
#[derive(Clone, Copy, Default)]
pub struct Slots(pub [Entry; TLB_SLOTS]);

/// The scalars first and the arrays after, so that JIT code reaches the
/// scalars, the TLB arrays and (through `jit::emit::xc_entry`) the transfer
/// cache at offsets V8 folds into the load (docs/jit.md "Functions").
#[repr(C)]
pub struct Tlb {
    /// The current generations of EL0's and EL1's entries, 1 to `0xffff`:
    /// an entry of another one (0 in a zeroed entry) never matches.
    pub xgen: [u64; 2],
    /// The EL's instruction TLB may hold nG entries: some were filled since
    /// its nG entries were last dropped.
    xng: [bool; 2],
    /// The JIT cache's `drops` when the transfer cache last dropped its
    /// entries for them (`jit::steps`).
    pub xdrops: u64,
    /// `ng`'s length; past `NG_SLOTS` the list overflowed.
    ng_len: u32,
    pub stats: TlbStats,
    /// Parallel SMP: it may hold global entries in the TTBR0 half (since
    /// the last flush of everything). A vCPU whose TLB may hold them
    /// publishes `ANY` as its ASID, so every TLBI IS waits for it
    /// (vm/parallel.rs `broadcast`). Linux maps nothing global there; EDK2,
    /// shim and GRUB map everything global there (identity maps in TTBR0).
    pub(crate) low_global: bool,
    /// Parallel SMP: its vCPU's published ASID (`CpuPar::asid`, in the VM's
    /// `Shared`, which outlives the vCPU); null otherwise.
    pub(crate) published: *const core::sync::atomic::AtomicU64,
    /// Arrays in order: EL0 read, write, exec, then EL1 read, write, exec;
    /// interleaved, `e[index].0[array]` (slots 6 and 7 unused).
    pub e: [Slots; TLB_ENTRIES],
    /// The transfer cache, direct-mapped by VA bits 15:2.
    pub xc: [Xc; XC_ENTRIES],
    /// Slots (`index * TLB_SLOTS + array`) filled with nG entries since the
    /// last flush, `ng_len` of them. A slot may since hold another entry:
    /// dropping it then is an over-invalidation, which is always allowed.
    ng: [u32; NG_SLOTS],
    /// Per slot (`index * TLB_SLOTS + array`): its entry's block class
    /// ([`CLASS`]: 0 for an entry from a page, else [`block_class`]) and
    /// whether it is nG ([`NG`]), what `flush_ng` scans for when `ng`
    /// overflowed.
    blk: [u8; TLB_ENTRIES * TLB_SLOTS],
    /// Live entries from blocks, counted by [`rblk_bucket`] of their class and
    /// block: a bucket at 0 has none of that block's, a collision only costs
    /// a flush by VA its scan.
    rblk: [u32; RBLK],
    /// The EL's transfer cache may hold entries for pages of blocks in a VA
    /// half: its instruction TLB held entries from blocks there when the
    /// EL's transfer cache entries were last dropped, or filled some since
    /// (the transfer cache refills from the TLB's entries without a walk,
    /// and outlives the one it was filled from). A flush by VA there drops
    /// them all, as the block's other pages may have some.
    xblk: [[bool; 2]; 2],
    /// The EL's live instruction TLB entries from blocks, by VA half.
    xblkn: [[u32; 2]; 2],
    /// Pages the EL's instruction fetches translated (`Mmu::miss`), hashed
    /// ([`xpage_bit`]), by EL, global or nG and VA half
    /// (`[(el * 2 + ng) * 2 + half]`): a superset of the pages the EL's live
    /// transfer cache entries are for, whose entries are filled only for a
    /// fetch the instruction TLB translated. A flush by VA scans the
    /// transfer cache only for a page with a bit set. The nG maps are cleared
    /// with the EL's nG entries (when its transfer cache's are dropped), all
    /// of them with every entry.
    xpages: [[u64; XPAGE_BITS / 64]; 8],
    /// The write entries it filled for pages of the watched window (`mem::Watch`), `nwatched` of them; their pages
    /// may be written without a miss until [`Tlb::unwatch`] drops them. At the end: JIT code reaches nothing here.
    watched: [Watched; WATCHED],
    nwatched: u32,
    /// The watch's generation this TLB last caught up with (`Tlb::catch_up`).
    pub watch_gen: u32,
}

/// Bits in each of `Tlb::xpages`' maps.
const XPAGE_BITS: usize = 4096;

/// The word and bit of `va`'s page in a `Tlb::xpages` map: its page number
/// (TBI's top byte aside) folded to 12 bits, so that the pages of an aligned
/// 16 MiB never share one (two pages fewer than 4,096 apart across such a
/// boundary may: a collision only costs a flush by VA its scan).
#[inline]
fn xpage_bit(va: u64) -> (usize, u64) {
    let p = (va & VA_PAGE) >> 12;
    let h = (p ^ p >> 12 ^ p >> 24) as usize & (XPAGE_BITS - 1);
    (h / 64, 1 << (h % 64))
}

/// The most watched write entries a TLB records; the next drops them all first.
const WATCHED: usize = 64;

/// A watched write entry: its slot, its tag then (it may since hold another), its page's PA.
#[derive(Clone, Copy, Default)]
struct Watched {
    slot: u32,
    tag: u64,
    pa: u64,
}

/// A block's class, 1 to 4: its VA half and level (1 or 2).
fn block_class(va: u64, level: u8) -> u8 {
    1 + 2 * (va >> 55 & 1) as u8 + (level == 1) as u8
}

/// `Tlb::rblk`'s buckets.
const RBLK: usize = 1024;

/// VA bits 55:12 of a page (the top byte is TBI's; bit 55 picks the half).
const VA_PAGE: u64 = 0x00ff_ffff_ffff_f000;

/// The VA bits a block of class `k` spans: 2 MiB or 1 GiB.
fn block_shift(k: u8) -> u32 {
    if k & 1 == 0 { 30 } else { 21 }
}

/// The `Tlb::rblk` bucket of the block of class `k` that holds `va`: the
/// block's number and class, hashed (Fibonacci) to `RBLK`'s 10 bits.
fn rblk_bucket(k: u8, va: u64) -> usize {
    let block = (va & VA_PAGE) >> block_shift(k) << 2 | (k - 1) as u64;
    (block.wrapping_mul(0x9e37_79b9_7f4a_7c15) >> (64 - RBLK.trailing_zeros())) as usize
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

/// A published ASID (`Tlb::published`) that every TLBI IS waits for.
pub(crate) const ANY_ASID: u64 = u64::MAX;

impl Tlb {
    /// The ASID its vCPU publishes in parallel SMP (vm/parallel.rs
    /// `broadcast`): the current one with the MMU on and no global entry in
    /// the TTBR0 half cached, else [`ANY_ASID`].
    pub(crate) fn asid_to_publish(&self, c: &Cpu) -> u64 {
        if c.sctlr_el1 & sctlr::M != 0 && !self.low_global {
            asid(c)
        } else {
            ANY_ASID
        }
    }

    /// Parallel SMP: publishes [`Tlb::asid_to_publish`] after a write that
    /// changed the ASID or the MMU enable mid-chunk, before anything walks
    /// with it (the order `Mmu::miss`'s `ANY` follows). Without one, a TLBI IS
    /// for the new ASID would read the chunk's old one and skip this vCPU
    /// while it holds entries walked under the new one.
    pub(crate) fn republish(&self, c: &Cpu) {
        // SAFETY: set in parallel mode to the vCPU's word in the VM's
        // `Shared`, which outlives the vCPU (`Tlb::published`).
        if let Some(a) = unsafe { self.published.as_ref() } {
            let asid = self.asid_to_publish(c);
            if a.load(core::sync::atomic::Ordering::Relaxed) != asid {
                a.store(asid, core::sync::atomic::Ordering::SeqCst);
            }
            core::sync::atomic::fence(core::sync::atomic::Ordering::SeqCst);
        }
    }

    /// Drops every transfer cache entry (TLB flushes, and the JIT cache's
    /// dropping blocks).
    pub fn bump(&mut self) {
        self.bump_el(0);
        self.bump_el(1);
    }

    /// Drops EL `el`'s transfer cache entries.
    fn bump_el(&mut self, el: usize) {
        self.xblk[el] = self.xblkn[el].map(|n| n != 0);
        self.xgen[el] += 1;
        if self.xgen[el] > 0xffff {
            self.xc.fill(Xc::default());
            self.xgen = [1, 1];
        }
    }

    /// Records that the block for `va` in `regime` (a block key's low bits)
    /// is at table index `idx`, `len` instructions long (at most a page's).
    #[inline(always)]
    pub fn xc_fill(&mut self, va: u64, regime: u64, idx: u32, len: u32) {
        debug_assert!(len <= 1024);
        self.xc[(va >> 2) as usize & (XC_ENTRIES - 1)] = Xc {
            tag: va | regime,
            to: idx as u64 | (len as u64) << 32 | self.xgen[regime as usize & 1] << 48,
        };
    }

    pub(crate) fn flush_all(&mut self) {
        self.stats.flushes += 1;
        self.bump();
        self.e.fill(Slots::default());
        self.blk.fill(0);
        self.rblk.fill(0);
        self.xblkn = [[0; 2]; 2];
        self.xblk = [[false; 2]; 2];
        self.ng_len = 0;
        self.xng = [false; 2];
        self.xpages = [[0; XPAGE_BITS / 64]; 8];
        self.low_global = false;
    }

    /// Records that EL `el`'s instruction fetches translated `va`'s page
    /// (global unless `ng`), whether or not its entry is cached: the
    /// transfer cache may get entries for it from now on.
    #[inline]
    fn fetched(&mut self, el: usize, va: u64, ng: bool) {
        let (w, b) = xpage_bit(va);
        self.xpages[(el * 2 + ng as usize) * 2 + (va >> 55 & 1) as usize][w] |= b;
        if ng {
            self.xng[el] = true;
        }
    }

    /// Whether the transfer cache may hold entries for `va`'s page.
    #[inline]
    fn xpage(&self, va: u64) -> bool {
        let (w, b) = xpage_bit(va);
        let half = (va >> 55 & 1) as usize;
        (0..4).any(|m| self.xpages[m * 2 + half][w] & b != 0)
    }

    /// Drops every nG entry: the global ones match any ASID.
    pub(crate) fn flush_ng(&mut self) {
        let n = self.ng_len as usize;
        self.stats.flushes += 1;
        for el in 0..2 {
            if core::mem::take(&mut self.xng[el]) {
                self.bump_el(el);
                self.xpages[(el * 2 + 1) * 2] = [0; XPAGE_BITS / 64];
                self.xpages[(el * 2 + 1) * 2 + 1] = [0; XPAGE_BITS / 64];
            }
        }
        if n <= NG_SLOTS {
            for k in 0..n {
                self.drop_slot(self.ng[k] as usize);
            }
        } else {
            // The list overflowed: the marks find every nG slot, eight a word
            // (128 KiB read, where dropping everything wrote 2.3 MiB and
            // lost the global entries).
            for w in 0..self.blk.len() / 8 {
                let b = &self.blk[w * 8..w * 8 + 8];
                let mut m = u64::from_le_bytes(b.try_into().unwrap()) & 0x8080_8080_8080_8080;
                while m != 0 {
                    self.drop_slot(w * 8 + m.trailing_zeros() as usize / 8);
                    m &= m - 1;
                }
            }
        }
        self.ng_len = 0;
    }

    /// Empties slot `s` (`index * TLB_SLOTS + array`).
    #[inline(always)]
    fn drop_slot(&mut self, s: usize) {
        let e = core::mem::take(&mut self.e[s / TLB_SLOTS].0[s % TLB_SLOTS]);
        let k = core::mem::take(&mut self.blk[s]) & CLASS;
        if k != 0 {
            // The tag's bits 55:12 are the VA's.
            self.rblk[rblk_bucket(k, e.tag)] -= 1;
            let a = s % TLB_SLOTS;
            if a % 3 == Use::Exec as usize {
                self.xblkn[a / 3][(k as usize - 1) / 2] -= 1;
            }
        }
    }

    /// Caches `va`'s page in `array`; `level` is the walk's leaf level (below
    /// 3: a page of a block). A `device` page's entry has [`DEVICE`] in its tag.
    fn fill(&mut self, array: usize, va: u64, host: Host, ng: bool, level: u8, device: bool) {
        let s = index(va) * TLB_SLOTS + array;
        self.drop_slot(s);
        self.e[index(va)].0[array] = Entry {
            tag: (va | 0xfff) ^ (host.mem() as u64) << 3 ^ if device { DEVICE } else { 0 },
            addend: host.0.wrapping_sub(va & !0xfff),
        };
        if level < 3 {
            let k = block_class(va, level);
            self.blk[s] = k;
            self.rblk[rblk_bucket(k, va)] += 1;
            if array % 3 == Use::Exec as usize {
                let half = (va >> 55 & 1) as usize;
                self.xblk[array / 3][half] = true;
                self.xblkn[array / 3][half] += 1;
            }
        }
        if ng {
            self.blk[s] |= NG;
            if array % 3 == Use::Exec as usize {
                self.xng[array / 3] = true;
            }
            let n = self.ng_len as usize;
            if n < NG_SLOTS {
                self.ng[n] = (index(va) * TLB_SLOTS + array) as u32;
            }
            self.ng_len = (n + 1).min(NG_SLOTS + 1) as u32;
        }
    }

    /// Caches a write entry for a page of the watched window, recorded: dropping it marks the page written
    /// (docs/devices.md "virtio-gpu"). Every record is dropped before the host looks, so the marks are exactly the
    /// pages that had a write entry since the last look.
    fn fill_watched(&mut self, mem: &Mem, array: usize, va: u64, host: Host, w: &Walk) {
        if self.nwatched as usize == WATCHED {
            self.unwatch(mem);
        }
        self.fill(array, va, host, w.ng, w.level, w.device());
        let slot = (index(va) * TLB_SLOTS + array) as u32;
        let tag = self.e[index(va)].0[array].tag;
        self.watched[self.nwatched as usize] = Watched {
            slot,
            tag,
            pa: w.pa & !0xfff,
        };
        self.nwatched += 1;
    }

    /// Drops the watched write entries it filled, marking their pages written.
    pub fn unwatch(&mut self, mem: &Mem) {
        for k in 0..self.nwatched as usize {
            let w = self.watched[k];
            mem.mark(w.pa);
            let s = w.slot as usize;
            if self.e[s / TLB_SLOTS].0[s % TLB_SLOTS].tag == w.tag {
                self.drop_slot(s);
            }
        }
        self.nwatched = 0;
    }

    /// Catches up with the watch's generation (at a chunk boundary): if the host bumped it, drops the watched write
    /// entries and acks it as vCPU `cpu`.
    #[inline]
    pub fn catch_up(&mut self, mem: &Mem, cpu: usize) {
        if let Some(w) = mem.watch() {
            let g = w.generation();
            if g != self.watch_gen {
                self.unwatch(mem);
                self.watch_gen = g;
                w.ack(cpu, g);
            }
        }
    }

    /// Leaves the run loop as vCPU `cpu`: drops the watched write entries and acks the generation, so the host never
    /// waits for it while it is out (it clears its running word next).
    pub fn leave(&mut self, mem: &Mem, cpu: usize) {
        if let Some(w) = mem.watch() {
            self.unwatch(mem);
            self.watch_gen = w.generation();
            w.ack(cpu, self.watch_gen);
        }
    }

    /// Drops the page holding `va` from every array, whatever its top byte (TBI).
    pub(crate) fn flush_va(&mut self, va: u64) {
        self.stats.flushes += 1;
        // The page's VAs fill 1024 consecutive transfer cache slots, which
        // hold none of its entries unless instruction fetches translated it
        // (most of Linux's flushes are for data pages).
        if self.xpage(va) {
            let first = (va >> 2) as usize & (XC_ENTRIES - 1) & !1023;
            for x in &mut self.xc[first..first + 1024] {
                if (x.tag ^ va) & VA_PAGE == 0 {
                    *x = Xc::default();
                }
            }
        }
        for a in 0..TLB_SLOTS {
            if (self.e[index(va)].0[a].tag ^ va) & VA_PAGE == 0 {
                self.drop_slot(index(va) * TLB_SLOTS + a);
            }
        }
        // The other pages of a block holding `va`: those of each class the TLB
        // may hold for that block, in the indices the block's pages map to.
        let hi = (va >> 55 & 1) as usize;
        for el in 0..2 {
            if self.xblk[el][hi] {
                self.bump_el(el);
            }
        }
        for level in [2, 1] {
            let k = block_class(va, level);
            if self.rblk[rblk_bucket(k, va)] == 0 {
                continue;
            }
            let shift = block_shift(k);
            let mask = VA_PAGE & !((1u64 << shift) - 1);
            let first = index(va & mask);
            for i in 0..(1usize << (shift - 12)).min(TLB_ENTRIES) {
                let x = (first + i) & (TLB_ENTRIES - 1);
                for a in 0..TLB_SLOTS {
                    let s = x * TLB_SLOTS + a;
                    if self.blk[s] & CLASS == k && (self.e[x].0[a].tag ^ va) & mask == 0 {
                        self.drop_slot(s);
                    }
                }
            }
        }
    }
}

#[inline]
fn index(va: u64) -> usize {
    (va >> 12) as usize & (TLB_ENTRIES - 1)
}

/// A vCPU: architectural state, the JIT's vector constants, its JIT state,
/// then its TLB (whose arrays come last). `repr(C)` with `cpu` first, so a `*mut Vcpu` is also a
/// `*mut Cpu` with the host ABI offsets; JIT blocks get this pointer
/// (docs/jit.md).
#[repr(C)]
pub struct Vcpu {
    pub cpu: Cpu,
    /// Constants JIT code loads at fixed offsets from the vCPU pointer
    /// (`jit::emit::crypto`, M6.5): one `ldr q` each, where V8 would build a
    /// `v128.const` from sixteen bytes of immediates every time.
    pub consts: crate::jit::emit::Consts,
    pub jit: crate::jit::State,
    pub tlb: Tlb,
    /// FEAT_RNG's stream (`Vm::with_devices` keys it).
    pub rng: crate::rng::Rng,
    /// The diagnostic build's tallies of compiled code (`crate::tally`), which the code bumps itself.
    #[cfg(feature = "diag")]
    pub diag: [u64; crate::tally::N],
}

impl Vcpu {
    /// Boxed: the TLB is 2.4 MiB.
    pub fn new(cpu: Cpu) -> Box<Vcpu> {
        let mut v = Box::<Vcpu>::new_zeroed();
        let p = v.as_mut_ptr();
        // SAFETY: `cpu`, `consts` and `jit` are written here; the TLB and `rng` are plain
        // integers, valid zeroed (the TLB empty), but for the transfer cache's generation.
        unsafe {
            (&raw mut (*p).cpu).write(cpu);
            (&raw mut (*p).tlb.xgen).write([1, 1]);
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
    /// Device memory (MAIR attribute 0000xxxx).
    pub fn device(&self) -> bool {
        self.attr >> 4 == 0
    }

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

/// FEAT_E0PD: whether an EL0 access to `va` faults (a level 0 translation
/// fault, whatever the tables hold) because TCR_EL1.E0PD0 (bit 55) or E0PD1
/// (bit 56) covers its half. Checked before the walk, and never on a TLB hit:
/// an EL0 array only holds pages an EL0 access was allowed to, and Linux
/// flushes the TLB after setting E0PD1 (`cpu_enable_e0pd`).
#[inline(always)]
pub fn e0pd(c: &Cpu, va: u64) -> bool {
    c.features & crate::cpu::FEATURE_E0PD != 0 && c.tcr_el1 >> (55 + (va >> 55 & 1)) & 1 == 1
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
        // Flat: Device-nGnRnE (ATTR 0), outer shareable; past the PA size, an
        // address size fault at level 0 (FST 0, F).
        if va >> PA_BITS != 0 {
            return (FaultKind::AddressSize(0).fsc() as u64) << 1 | RES1 | 1;
        }
        return va & OA_MASK | 2 << 7 | RES1;
    }
    let r = if el == 0 && e0pd(c, va) {
        Err(FaultKind::Translation(0))
    } else {
        walk(c, mem, va)
    };
    let r = r.and_then(|w| {
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
    /// What's at the address doesn't matter: a device or nothing is no fault.
    /// Returns the PA if it's RAM (for `IC IVAU`, which invalidates JIT blocks).
    fn maint(&mut self, c: &Cpu, va: u64, write: bool) -> Result<Option<u64>, Fault>;
    /// Host address for an access by the atomics, which must be aligned to `len`.
    fn host_aligned(&mut self, c: &Cpu, va: u64, len: u64, access: Access) -> Result<Host, Fault>;
    /// The host pointer for `size` bytes at `va` with the current EL's `u`
    /// permission if it's at hand in memory 0 (the TLB's entry, or RAM with the MMU off),
    /// without a walk or a fault: the block interpreter's fast path, which
    /// takes `read_el`/`write_el` when this has nothing.
    #[inline(always)]
    fn fast(&mut self, _c: &Cpu, _va: u64, _size: u32, _u: Use) -> Option<*mut u8> {
        None
    }
    fn flush_all(&mut self) {}
    fn flush_va(&mut self, _va: u64) {}
    /// Drops the non-global entries (ASID changes, `TLBI ASIDE1`).
    fn flush_ng(&mut self) {}
    /// After a write that changed the ASID or the MMU enable (and the flush
    /// it needed): parallel SMP's published ASID follows ([`Tlb::republish`]).
    fn republish(&mut self, _c: &Cpu) {}

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
        Ok(unsafe { self.mem().load_atomic(p, size) })
    }

    /// Aligned single-copy-atomic write (release stores).
    fn write_atomic(&mut self, c: &Cpu, va: u64, size: u32, val: u64) -> Result<(), Fault> {
        let p = self.host_aligned(c, va, size as u64, Access::Write)?;
        // SAFETY: as in read_atomic.
        unsafe { self.mem().store_atomic(p, size, val) };
        Ok(())
    }

    /// A store-exclusive's swap (STXR, STXP's 8 bytes): [`Self::cas`], but a
    /// store for the watchpoints (`interp::debug::Watch`), where CAS is a
    /// read-modify-write.
    #[inline(always)]
    fn store_exclusive(
        &mut self,
        c: &Cpu,
        va: u64,
        size: u32,
        expected: u64,
        new: u64,
    ) -> Result<u64, Fault> {
        let p = self.host_aligned(c, va, size as u64, Access::Write)?;
        // SAFETY: as in read_atomic.
        Ok(unsafe { self.mem().cas(p, size, expected, new) })
    }

    /// STXP's 16 bytes: [`Self::cas_pair`], a store as in [`Self::store_exclusive`].
    #[inline(always)]
    fn store_exclusive_pair(
        &mut self,
        c: &Cpu,
        va: u64,
        expected: [u64; 2],
        new: [u64; 2],
    ) -> Result<[u64; 2], Fault> {
        let p = self.host_aligned(c, va, 16, Access::Write)?;
        // SAFETY: as in read_pair.
        Ok(unsafe { self.mem().cas_pair(p, expected, new) })
    }

    /// Atomic compare-and-swap. Returns the old value; the swap happened iff it
    /// equals `expected`. Faults report a write.
    fn cas(&mut self, c: &Cpu, va: u64, size: u32, expected: u64, new: u64) -> Result<u64, Fault> {
        let p = self.host_aligned(c, va, size as u64, Access::Write)?;
        // SAFETY: as in read_atomic.
        Ok(unsafe { self.mem().cas(p, size, expected, new) })
    }

    /// Atomic read-modify-write: LSE's LD<op> or SWP, `op` its o3:opc and `v`
    /// its operand (`mem::lse`). Returns the old value.
    fn rmw(&mut self, c: &Cpu, va: u64, size: u32, op: u32, v: u64) -> Result<u64, Fault> {
        let p = self.host_aligned(c, va, size as u64, Access::Write)?;
        // SAFETY: as in read_atomic.
        Ok(unsafe { self.mem().rmw(p, size, op, v) })
    }

    /// 16-byte read of an aligned pair of X registers (LDXP), atomic with
    /// respect to `cas_pair`.
    fn read_pair(&mut self, c: &Cpu, va: u64) -> Result<[u64; 2], Fault> {
        let p = self.host_aligned(c, va, 16, Access::Read)?;
        // SAFETY: 16 aligned bytes of RAM.
        Ok(unsafe { self.mem().read_pair(p) })
    }

    /// 16-byte compare-and-swap of an aligned pair of X registers (CASP,
    /// STXP). Returns the old pair; the swap happened iff it equals `expected`.
    fn cas_pair(
        &mut self,
        c: &Cpu,
        va: u64,
        expected: [u64; 2],
        new: [u64; 2],
    ) -> Result<[u64; 2], Fault> {
        let p = self.host_aligned(c, va, 16, Access::Write)?;
        // SAFETY: as in read_pair.
        Ok(unsafe { self.mem().cas_pair(p, expected, new) })
    }
}

fn misaligned(va: u64, access: Access) -> Fault {
    Fault {
        addr: va,
        access,
        kind: FaultKind::Align,
    }
}

/// With the MMU off, a VA past the PA size is an address size fault at level
/// 0, not an external abort (`AArch64.S1DisabledOutput`; TBI isn't applied
/// there). Only on the way out of a failed access: RAM never gets here.
#[cold]
#[inline(never)]
fn flat_fault(f: Fault) -> Fault {
    if f.kind == FaultKind::Bus && f.addr >> PA_BITS != 0 {
        Fault {
            kind: FaultKind::AddressSize(0),
            ..f
        }
    } else {
        f
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
        self.0.read(va, size).map_err(flat_fault)
    }

    #[inline(always)]
    fn write_el(&mut self, _: &Cpu, va: u64, size: u32, val: u64, _: u64) -> Result<(), Fault> {
        self.0.write(va, size, val).map_err(flat_fault)
    }

    #[inline(always)]
    fn fetch(&mut self, _: &Cpu, pc: u64) -> Result<u32, Fault> {
        self.0.read(pc, 4).map(|v| v as u32).map_err(flat_fault)
    }

    fn maint(&mut self, _: &Cpu, va: u64, _: bool) -> Result<Option<u64>, Fault> {
        match self.0.host(va, 1, Access::Maint) {
            Ok(_) => Ok(Some(va)),
            Err(f) => match flat_fault(f) {
                f if f.kind == FaultKind::Bus => Ok(None),
                f => Err(f),
            },
        }
    }

    #[inline(always)]
    fn fast(&mut self, _: &Cpu, va: u64, size: u32, _: Use) -> Option<*mut u8> {
        self.0.host0(va, size as u64)
    }

    #[inline(always)]
    fn host_aligned(&mut self, _: &Cpu, va: u64, len: u64, access: Access) -> Result<Host, Fault> {
        if !va.is_multiple_of(len) {
            return Err(misaligned(va, access));
        }
        self.0.host(va, len, access).map_err(flat_fault)
    }
}

/// One host address, or two for a page-crossing access (the second with the
/// number of bytes that go to the first).
type Span = (Host, Option<(Host, u64)>);

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

    /// The PA of `va` in a device's page, from its entry in the TLB (array `u` of `el`) if it has one
    /// ([`MMIO`]): the access that missed just filled it, unless that took the walk without a TLB.
    pub fn mmio_pa(&self, va: u64, el: u64, u: Use) -> Option<u64> {
        let e = self.tlb.as_ref()?.e[index(va)].0[3 * el as usize + u as usize];
        ((e.tag ^ (va | 0xfff)) & !0xff8 == 0 && e.tag & MMIO_BITS == 0)
            .then(|| va.wrapping_add(e.addend) & ((1 << MEM_SHIFT) - 1))
    }

    /// Host address for `len` bytes at `va`, which must not cross a page.
    #[inline(always)]
    fn host(
        &mut self,
        c: &Cpu,
        va: u64,
        len: u64,
        access: Access,
        u: Use,
        el: u64,
    ) -> Result<Host, Fault> {
        self.host_in(c, va, len, false, access, u, el)
    }

    /// [`Self::host`] for `len` bytes of a larger access, `split` if it
    /// crosses a page ([`Self::miss`]).
    #[allow(clippy::too_many_arguments)]
    #[inline(always)]
    fn host_in(
        &mut self,
        c: &Cpu,
        va: u64,
        len: u64,
        split: bool,
        access: Access,
        u: Use,
        el: u64,
    ) -> Result<Host, Fault> {
        if c.sctlr_el1 & sctlr::M == 0 {
            return self.mem.host(va, len, access).map_err(flat_fault);
        }
        if let Some(t) = &self.tlb {
            let e = t.e[index(va)].0[3 * el as usize + u as usize];
            if e.tag == va.wrapping_add(len - 1) | 0xfff {
                return Ok(Host(va.wrapping_add(e.addend)));
            }
        }
        self.miss(c, va, len, split, access, u, el)
    }

    /// The host address of the instruction at `pc` (aligned), through the
    /// instruction TLB; the JIT keys blocks by its PA (`Mem::pa`).
    #[inline(always)]
    pub fn fetch_ptr(&mut self, c: &Cpu, pc: u64) -> Result<Host, Fault> {
        self.host(c, pc, 4, Access::Read, Use::Exec, c.el())
    }

    /// TLB miss: walk, check permissions, and fill the TLB if the page is RAM.
    /// `split`: a part of a page-crossing access (misaligned, so on Device
    /// memory an alignment fault).
    #[allow(clippy::too_many_arguments)]
    #[inline(never)]
    fn miss(
        &mut self,
        c: &Cpu,
        va: u64,
        len: u64,
        split: bool,
        access: Access,
        u: Use,
        el: u64,
    ) -> Result<Host, Fault> {
        let fault = |kind| Fault {
            addr: va,
            access,
            kind,
        };
        // A data access to Device memory must be aligned (instruction fetches
        // and cache maintenance have no such check).
        let device_check = u != Use::Exec && access != Access::Maint;
        let misaligned = split || !va.is_multiple_of(len);
        if let Some(t) = &mut self.tlb {
            // A spill memory's entry, or a Device page's: only bits 11:3 differ.
            let e = t.e[index(va)].0[3 * el as usize + u as usize];
            if (e.tag ^ (va.wrapping_add(len - 1) | 0xfff)) & !0xff8 == 0 && e.tag & 0xff8 != 0xff8
            {
                if e.tag & DEVICE == 0 && device_check && misaligned {
                    return Err(fault(FaultKind::Align));
                }
                // A device's page: the access goes to the bus (`vm::Io`), with no walk.
                if e.tag & MMIO_BITS == 0 {
                    return Err(fault(FaultKind::Bus));
                }
                return Ok(Host(va.wrapping_add(e.addend)));
            }
            t.stats.misses += 1;
        }
        if el == 0 && e0pd(c, va) {
            return Err(fault(FaultKind::Translation(0)));
        }
        let w = walk(c, self.mem, va).map_err(fault)?;
        if !w.allows(el, u) {
            return Err(fault(FaultKind::Permission(w.level)));
        }
        if w.device() && device_check && misaligned {
            return Err(fault(FaultKind::Align));
        }
        // The entry is a Device page's whatever filled it (a cache
        // maintenance op too, which shares the data arrays), so the data
        // accesses that hit it later still check alignment; the instruction
        // array, which no data access reads, is filled as Normal.
        let device = w.device() && u != Use::Exec;
        if let Some(t) = &mut self.tlb {
            t.stats.walks += 1;
            // Before any return below that hands out the translation, cached or not.
            if u == Use::Exec {
                t.fetched(el as usize & 1, va, w.ng);
            }
        }
        // Not RAM: a device's page, if anything is there (`vm::Io` finds out). Its data entries
        // ([`MMIO`]) send the next access to the bus without a walk.
        let p = self.mem.host(w.pa, len, access);
        let mmio = matches!(
            p,
            Err(Fault {
                kind: FaultKind::Bus,
                ..
            })
        ) && u != Use::Exec;
        if p.is_err() && !mmio {
            return p.map_err(|f| Fault { addr: va, ..f });
        }
        // In parallel SMP a TLB that holds nothing in the TTBR0 half but its
        // current ASID's lets a TLBI IS for another ASID skip waiting for its
        // vCPU (vm/parallel.rs `broadcast`). The first global entry there
        // ends that: the vCPU publishes `ANY` before the walk whose entry it
        // caches (the order a TTBR write's new ASID follows), so an issuer
        // that stored new tables and then read the old ASID can't meet an
        // entry from the old tables.
        let low_global = !w.ng
            && va >> 55 & 1 == 0
            && c.features & crate::cpu::FEATURE_PARALLEL != 0
            && c.features & crate::cpu::FEATURE_SMP != 0;
        if low_global
            && let Some(t) = &mut self.tlb
            && !t.low_global
        {
            t.low_global = true;
            // SAFETY: set in parallel mode to the vCPU's word in the VM's
            // `Shared`, which outlives the vCPU (`Tlb::published`).
            if let Some(a) = unsafe { t.published.as_ref() } {
                a.store(ANY_ASID, core::sync::atomic::Ordering::SeqCst);
            }
            core::sync::atomic::fence(core::sync::atomic::Ordering::SeqCst);
            return self.miss(c, va, len, split, access, u, el);
        }
        if mmio {
            if let Some(t) = &mut self.tlb {
                let page = Host(MMIO << MEM_SHIFT | w.pa & !0xfff);
                t.fill(
                    3 * el as usize + u as usize,
                    va,
                    page,
                    w.ng,
                    w.level,
                    device,
                );
            }
            return Err(fault(FaultKind::Bus));
        }
        let p = p.map_err(|f| Fault { addr: va, ..f })?;
        // A tagged PC (TBI) never fills the instruction TLB, so it misses
        // every fast path that finds code by VA (the JIT's transfer cache, the
        // block interpreter's next block) and reaches the dispatcher, which
        // strips the tag (docs/jit.md "Linking").
        if u == Use::Exec && c.branch_addr(va) != va {
            return Ok(p);
        }
        if let Some(t) = &mut self.tlb
            && let Ok(page) = self.mem.host(w.pa & !0xfff, 0x1000, access)
        {
            let array = 3 * el as usize + u as usize;
            let watched = self.mem.watched(w.pa);
            if u == Use::Write && watched {
                t.fill_watched(self.mem, array, va, page, &w);
            } else {
                t.fill(array, va, page, w.ng, w.level, device);
            }
            // The sibling: the same EL's other data array, when the walk permits that access too, so a
            // write after a read of the page (or a read after a write) doesn't walk again. Only into an
            // empty slot: over another page's entry, a copy between two pages of one index (a source
            // read, a destination written) would walk at every access, each walk evicting the other
            // page's entry from both arrays. Not a Device page's (rare, and its entries are told apart
            // by what filled them), nor a watched page's write entry, which is filled only by a write,
            // recorded.
            let other = match u {
                Use::Read => Use::Write,
                Use::Write => Use::Read,
                Use::Exec => return Ok(p),
            };
            let sibling = 3 * el as usize + other as usize;
            if !w.device()
                && w.allows(el, other)
                && !(other == Use::Write && watched)
                && t.e[index(va)].0[sibling].tag == 0
            {
                t.fill(sibling, va, page, w.ng, w.level, false);
            }
        }
        Ok(p)
    }

    /// Host pointers for the two pages of a page-crossing access, both
    /// translated before either is touched, and the byte count in the first;
    /// a page of the watched window keeps its record until the store.
    /// `SCTLR_EL1.A` makes every misaligned access fault first.
    #[inline(always)]
    pub(crate) fn span(
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
        let p1 = self.host_in(c, va, first, true, access, u, el)?;
        let n = self.tlb.as_ref().map_or(0, |t| t.nwatched);
        let p2 = self
            .host_in(
                c,
                va.wrapping_add(first),
                size as u64 - first,
                true,
                access,
                u,
                el,
            )
            .map_err(|f| match f.kind {
                // Reported at the access's address, as a whole.
                FaultKind::Align => Fault { addr: va, ..f },
                _ => f,
            })?;
        // The second page's watched write entry overflowed the records (`Tlb::fill_watched`): that dropped the
        // first page's record and marked it before its bytes are stored, so a look in between would miss them.
        // Translating it again records it anew (one record is left, so this one can't overflow).
        if self.tlb.as_ref().is_some_and(|t| t.nwatched < n) {
            return Ok((
                self.host_in(c, va, first, true, access, u, el)?,
                Some((p2, first)),
            ));
        }
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
            (p, None) => unsafe { self.mem.load(p, size) },
            (p1, Some((p2, first))) => (0..size as u64).fold(0, |v, k| {
                let b = if k < first {
                    p1.plus(k)
                } else {
                    p2.plus(k - first)
                };
                // SAFETY: the first `first` bytes are at p1, the rest at p2, all RAM.
                v | unsafe { self.mem.load(b, 1) } << (8 * k)
            }),
        })
    }

    fn write_el(&mut self, c: &Cpu, va: u64, size: u32, val: u64, el: u64) -> Result<(), Fault> {
        match self.span(c, va, size, Access::Write, Use::Write, el)? {
            // SAFETY: host() checked the bytes are RAM.
            (p, None) => unsafe { self.mem.store(p, size, val) },
            (p1, Some((p2, first))) => {
                for k in 0..size as u64 {
                    let b = if k < first {
                        p1.plus(k)
                    } else {
                        p2.plus(k - first)
                    };
                    // SAFETY: as in read_el.
                    unsafe { self.mem.store(b, 1, val >> (8 * k)) };
                }
            }
        }
        Ok(())
    }

    fn fetch(&mut self, c: &Cpu, pc: u64) -> Result<u32, Fault> {
        let p = self.fetch_ptr(c, pc)?;
        // SAFETY: host() checked 4 bytes of RAM.
        Ok(unsafe { self.mem.load(p, 4) } as u32)
    }

    #[inline(always)]
    fn fast(&mut self, c: &Cpu, va: u64, size: u32, u: Use) -> Option<*mut u8> {
        // With SCTLR_EL1.A (alignment faults) or the MMU off, the slow path.
        if c.sctlr_el1 & (sctlr::M | sctlr::A) != sctlr::M {
            return None;
        }
        let e = self.tlb.as_ref()?.e[index(va)].0[3 * c.el() as usize + u as usize];
        (e.tag == va.wrapping_add(size as u64 - 1) | 0xfff)
            .then(|| va.wrapping_add(e.addend) as usize as *mut u8)
    }

    fn maint(&mut self, c: &Cpu, va: u64, write: bool) -> Result<Option<u64>, Fault> {
        let u = if write { Use::Write } else { Use::Read };
        match self.host(c, va, 1, Access::Maint, u, c.el()) {
            Ok(p) => Ok(Some(self.mem.pa(p))),
            Err(f) if f.kind == FaultKind::Bus => Ok(None),
            Err(f) => Err(f),
        }
    }

    fn host_aligned(&mut self, c: &Cpu, va: u64, len: u64, access: Access) -> Result<Host, Fault> {
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

    fn republish(&mut self, c: &Cpu) {
        if let Some(t) = &self.tlb {
            t.republish(c);
        }
    }
}

#[cfg(test)]
mod tests;
