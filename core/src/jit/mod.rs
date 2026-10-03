//! Tier-1 JIT: guest A64 blocks → WebAssembly (docs/jit.md).
//!
//! Generated modules import the core's memory, its function table and its
//! helper exports. The host compiles each module synchronously in the vCPU
//! worker and puts its functions into the core's table (`env.jit_install`), so
//! the run loop calls a block through a function pointer, which on wasm32 is a
//! table index. Natively there's no wasm engine: [`install`] fails and
//! everything runs in the interpreter.

pub mod block;
pub mod emit;
pub mod wasm;

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

use crate::cpu::sctlr;
use crate::interp::{self, Exit};
use crate::mem::Mem;
use crate::mmu::{Flat, Mmu, Vcpu};

/// A compiled block: `f(vcpu, acc, left) -> acc + retired`, equivalent to
/// `interp::steps` for its length and the blocks it chains to within `left`
/// steps (docs/jit.md): if fewer than all their instructions retired,
/// the one that didn't left its exit in [`State::exit`] and the PC on it.
pub type Block = unsafe extern "C" fn(*mut Vcpu, u32, u32) -> u32;

/// Per-vCPU JIT state, after the TLB in [`Vcpu`]. The helpers use the first
/// two fields; the cache exists only while the JIT is on.
#[repr(C)]
#[derive(Default)]
pub struct State {
    /// Guest RAM; the run loop sets it before it enters a block.
    pub mem: *const Mem,
    /// Why the last block stopped early (the instruction that didn't retire).
    pub exit: Option<Exit>,
    /// Instructions the helpers retired (so JIT steps minus these ran inline).
    pub helper_steps: u64,
    pub cache: Option<Box<Cache>>,
}

/// Compile policy (the knobs docs/jit.md "Compile policy" describes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Config {
    /// Dispatches of a block key before it joins the pending batch (0: on first sight).
    pub threshold: u32,
    /// Blocks per module.
    pub batch: u32,
    /// Code cache size in blocks (= table slots); everything is flushed when it's full.
    pub capacity: u32,
    /// The wasm bytes of the modules installed since the last flush at which the
    /// cache flushes too (V8 spends ~10× a module's bytes on its code and
    /// metadata, docs/jit.md "Memory").
    pub max_bytes: u64,
    /// The stale-code checker: hash each block's words when it's compiled and
    /// again at every entry, and panic on a mismatch (code changed without an
    /// `IC` invalidating it).
    pub check: bool,
    /// Entries of a loop head, compiled alone, before its loop region is
    /// (step 8.3; 0: the region at once).
    pub region_after: u32,
}

impl Config {
    /// [`Config::DEFAULT`] for a VM with `caches` JIT caches (one per vCPU in parallel SMP, else one):
    /// they share the byte budget.
    pub fn for_vcpus(caches: u64) -> Config {
        Config {
            max_bytes: (MAX_BYTES / caches.max(1)).max(MIN_BYTES),
            ..Config::DEFAULT
        }
    }
    pub const DEFAULT: Config = Config {
        threshold: 50,
        batch: 512,
        capacity: 262_144,
        max_bytes: MAX_BYTES,
        check: false,
        region_after: REGION_AFTER,
    };
    /// Compile everything on first sight, one block per module, and flush
    /// constantly: room for 4 regions besides the miss functions.
    pub const STRESS: Config = Config {
        threshold: 0,
        batch: 1,
        capacity: 4 + MISS_SLOTS,
        max_bytes: u64::MAX,
        check: true,
        region_after: 1,
    };
    /// JIT-check: compile everything on first sight into a full-size cache,
    /// with the stale-code checker. JIT-stress's 4-region cache evicts most
    /// blocks before they're entered again, which hides stale ones (M7 loop 4:
    /// code rewritten by another vCPU).
    pub const CHECK: Config = Config {
        threshold: 0,
        batch: 1,
        max_bytes: u64::MAX,
        check: true,
        region_after: 0,
        ..Config::DEFAULT
    };
}

/// [`Config::DEFAULT`]'s `max_bytes`: the wasm bytes V8 may hold for a whole VM
/// (~10× that in memory: ~1.6 GiB). A VM with a cache per vCPU divides it
/// ([`Config::for_vcpus`]).
pub const MAX_BYTES: u64 = 160 << 20;
/// The least a vCPU's share of [`MAX_BYTES`] gets: Debian's boot on 4 vCPUs
/// compiles ~31 MiB in each.
pub const MIN_BYTES: u64 = 32 << 20;

/// [`Config::DEFAULT`]'s `region_after`.
pub const REGION_AFTER: u32 = 1000;

/// What the JIT did (`vm::Counters` publishes them).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub blocks: u64,
    pub modules: u64,
    pub bytes: u64,
    pub compile_ns: u64,
    /// Instructions retired in JIT code.
    pub steps: u64,
    /// Block calls from the run loop.
    pub dispatches: u64,
    pub invalidations: u64,
    pub flushes: u64,
    /// Instructions compiled inline, and as helper calls (ABI 12).
    pub inline: u64,
    pub helpers: u64,
    /// Inline instructions run (step 7: the steps in JIT code that no helper retired).
    pub inline_steps: u64,
    /// Static flag counts over the compiled code (ABI 13, `emit::Counts`):
    /// lazy flag setters whose NZCV is stored somewhere, and never; conditions
    /// computed directly from a lazy setter's operands, from NZCV computed in
    /// registers, and from NZCV in memory.
    pub flags_stored: u64,
    pub flags_elided: u64,
    pub cond_direct: u64,
    pub cond_computed: u64,
    pub cond_memory: u64,
    /// Blocks in the compiled regions (ABI 15, step 8: `blocks` counts
    /// regions, one function each).
    pub region_blocks: u64,
    /// Edges back to a region's head, compiled as wasm loop branches (ABI 16, static).
    pub back_edges: u64,
    /// Loop regions compiled for a hot head that was compiled alone (ABI 17).
    pub tier_ups: u64,
    /// Stale blocks the checker found in a tolerant cache (ABI 25: parallel
    /// SMP, where another vCPU may rewrite code before its IC reaches this one).
    pub stale: u64,
}

/// Multiply-shift over the block key: std's SipHash costs too much on every dispatch.
#[derive(Default)]
struct KeyHasher(u64);

impl Hasher for KeyHasher {
    fn write(&mut self, _: &[u8]) {
        unreachable!("block keys are u64s");
    }
    fn write_u64(&mut self, k: u64) {
        let h = k.wrapping_mul(0x9e37_79b9_7f4a_7c15);
        self.0 = h ^ (h >> 32);
    }
    fn finish(&self) -> u64 {
        self.0
    }
}

/// A block key's state.
#[derive(Clone, Copy, Debug, Default)]
struct Info {
    /// Dispatches while not compiled.
    hits: u32,
    /// Table index once compiled (0 is never a JIT block: the table's null entry).
    idx: u32,
    /// The block's length (0: it would have none, so it's never compiled).
    len: u32,
    /// In the pending batch.
    queued: bool,
    /// The compiled words' hash, for the stale-code checker.
    hash: u64,
    /// A loop head compiled alone: its hot word's index + 1 (step 8.3).
    word: u32,
}

/// A jump cache entry: the compiled block for a key. Blocks read it too
/// (indirect branches, step 7: `emit::indirect`), so its layout is fixed.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Jc {
    key: u64,
    idx: u32,
    len: u32,
}

/// Direct-mapped jump cache in front of the map (as QEMU's `tb_jmp_cache`).
pub const JC: usize = 65536;
const JC_EMPTY: Jc = Jc {
    key: u64::MAX,
    idx: 0,
    len: 0,
};

fn jc_index(key: u64) -> usize {
    (key >> 2) as usize & (JC - 1)
}

/// The slots of the transfer cache's miss functions.
const MISS_SLOTS: u32 = 2;

/// Steps after the first block joins a pending batch before it's emitted
/// anyway, so a lone hot block doesn't wait for a full batch.
pub const BATCH_TIMEOUT: u64 = 1_000_000;

/// The block cache, the pending batch and the code cache's slot allocator.
pub struct Cache {
    pub cfg: Config,
    /// The vCPU's `Cpu::features`, which the emitted code may assume (a VM
    /// sets it from its config; user-mode vCPUs have them all).
    pub features: u64,
    map: Map<Info>,
    /// The keys in `map` by physical page, for `IC IVAU`.
    pages: Map<Vec<u64>>,
    /// The compiled blocks that chain to a key (step 7), dropped with it.
    linkers: Map<Vec<u64>>,
    /// Each compiled region's blocks as (PA, length), for the stale-code checker.
    spans: Map<Vec<(u64, u32)>>,
    jc: Box<[Jc; JC]>,
    /// The jump-cache entries filled since the last flush (up to `JC / 16`;
    /// more, and a flush clears it whole): JIT-stress flushes every few
    /// compiles, and clearing all 65,536 entries each time was a fifth of an
    /// Alpine boot under it.
    jc_used: Vec<u32>,
    /// One hot word per slot, at a fixed address ([`emit::tier_up`]).
    hot: Box<[u32]>,
    /// Helper calls by instruction class (step 10: the input to M6), and
    /// the last report of them ([`Cache::helper_report`]).
    helper_ops: Vec<u64>,
    report: String,
    /// (key, VA) of blocks waiting to be compiled.
    pending: Vec<(u64, u64)>,
    /// `clock` when the first pending block was queued.
    since: u64,
    /// Steps dispatched so far (the batch timeout's clock).
    clock: u64,
    /// The next free slot.
    next: u32,
    /// The bytes of the modules installed since the last flush (`Config::max_bytes`).
    live_bytes: u64,
    /// No JIT host (natively, or before `jit.bind`): interpret everything.
    off: bool,
    /// The stale-code checker counts stale blocks instead of panicking
    /// (parallel SMP: code another vCPU rewrote is legal to run until this
    /// one drains that vCPU's IC at a context synchronization event).
    pub tolerant: bool,
    /// The RAM the blocks were compiled for (flat blocks embed its layout).
    ram: Option<(usize, u64, u64)>,
    /// How many times blocks were dropped. A vCPU's transfer cache
    /// (`mmu::Tlb::xc`) whose count (`Tlb::xdrops`) differs drops its
    /// entries ([`steps`], before a block runs): in round-robin SMP one cache
    /// serves every vCPU, each with its own transfer cache.
    pub drops: u64,
    /// The table index of the transfer cache's miss function for EL0 (EL1's
    /// follows), once installed ([`block::miss_module`]): in slots 0 and 1,
    /// which flushes keep.
    xmiss: Option<u32>,
    pub stats: Stats,
}

impl Cache {
    pub fn new(cfg: Config) -> Cache {
        assert!(cfg.batch >= 1 && cfg.capacity >= cfg.batch + MISS_SLOTS);
        Cache {
            cfg,
            map: HashMap::default(),
            pages: HashMap::default(),
            linkers: HashMap::default(),
            spans: HashMap::default(),
            jc: vec![JC_EMPTY; JC]
                .into_boxed_slice()
                .try_into()
                .ok()
                .expect("JC entries"),
            jc_used: Vec::new(),
            hot: vec![0; cfg.capacity as usize].into_boxed_slice(),
            helper_ops: vec![0; crate::decode::Op::ALL.len()],
            report: String::new(),
            pending: Vec::new(),
            since: 0,
            clock: 0,
            next: 0,
            live_bytes: 0,
            off: false,
            tolerant: false,
            ram: None,
            drops: 1,
            xmiss: None,
            stats: Stats::default(),
            features: crate::cpu::FEATURES,
        }
    }

    /// `n` consecutive slots for a module; flushes the cache first if they don't fit.
    fn alloc(&mut self, n: u32) -> u32 {
        if self.next + n > self.cfg.capacity || self.live_bytes >= self.cfg.max_bytes {
            self.flush();
        }
        self.next += n;
        self.next - n
    }

    /// Drops every block (their slots are reused; the modules are left to the
    /// GC) and the pending batch.
    pub fn flush(&mut self) {
        self.drop_all();
        self.stats.flushes += 1;
    }

    fn drop_all(&mut self) {
        self.drops += 1;
        self.map.clear();
        self.pages.clear();
        self.linkers.clear();
        self.spans.clear();
        if self.jc_used.len() < JC / 16 {
            for &i in &self.jc_used {
                self.jc[i as usize] = JC_EMPTY;
            }
        } else {
            self.jc.fill(JC_EMPTY);
        }
        self.jc_used.clear();
        self.pending.clear();
        self.next = if self.xmiss.is_some() { MISS_SLOTS } else { 0 };
        self.live_bytes = 0;
    }

    /// `IC IVAU` on `pa` drops the blocks of its page; `IC IALLU` (`u64::MAX`) all of them.
    pub fn invalidate(&mut self, pa: u64) {
        if pa == u64::MAX {
            self.drop_all();
        } else if let Some(mut keys) = self.pages.remove(&(pa >> 12)) {
            // With the blocks that chain to them, transitively: their code
            // calls the dropped functions directly.
            while let Some(k) = keys.pop() {
                self.map.remove(&k);
                self.spans.remove(&k);
                if self.jc[jc_index(k)].key == k {
                    self.jc[jc_index(k)] = JC_EMPTY;
                }
                self.pending.retain(|p| p.0 != k);
                keys.extend(self.linkers.remove(&k).unwrap_or_default());
            }
        } else {
            return;
        }
        self.drops += 1;
        self.stats.invalidations += 1;
    }

    /// The entry for `key`, created (and filed under its page) if new.
    fn info(&mut self, key: u64, len: impl FnOnce() -> u32) -> &mut Info {
        info(&mut self.map, &mut self.pages, key, len)
    }

    /// The helper calls so far by instruction class, most frequent first,
    /// one `<Op> <calls>` per line, NUL-terminated.
    pub fn helper_report(&mut self) -> *const u8 {
        let mut ops: Vec<(u64, crate::decode::Op)> = self
            .helper_ops
            .iter()
            .zip(crate::decode::Op::ALL)
            .filter(|(n, _)| **n != 0)
            .map(|(&n, op)| (n, op))
            .collect();
        ops.sort_by_key(|a| core::cmp::Reverse(a.0));
        self.report = ops.iter().map(|(n, op)| format!("{op:?} {n}\n")).collect();
        self.report.push('\0');
        self.report.as_ptr()
    }

    /// The stale-code checker at a region's entry: all its blocks' words.
    /// False for a stale block in a tolerant cache (counted); a stale block
    /// in any other panics.
    fn check(&mut self, key: u64, mem: &Mem) -> bool {
        let words: Vec<u32> = self.spans[&key]
            .iter()
            .flat_map(|&(pa, n)| block::read(mem, pa, n as usize))
            .collect();
        if block::hash(&words) == self.map[&key].hash {
            return true;
        }
        assert!(
            self.tolerant,
            "stale JIT block at PA {:#x}: its code changed without an IC",
            key & !3
        );
        self.stats.stale += 1;
        false
    }

    /// The compiled block for `key` as (table index, length), or else how many
    /// instructions to interpret: the would-be block's length, so the next
    /// lookup is at a block start again.
    #[inline(always)]
    fn enter(&mut self, key: u64, va: u64, mem: &Mem) -> Result<(u32, u32), u32> {
        let j = self.jc[jc_index(key)];
        if j.key == key {
            return Ok((j.idx, j.len));
        }
        self.miss(key, va, mem)
    }

    /// Not in the jump cache: look it up, count a hit, queue it and emit the
    /// batch when due.
    #[inline(never)]
    fn miss(&mut self, key: u64, va: u64, mem: &Mem) -> Result<(u32, u32), u32> {
        let info = info(&mut self.map, &mut self.pages, key, || {
            block::form(mem, key & !3).len() as u32
        });
        if info.idx == 0 && !self.off && info.len > 0 {
            info.hits += 1;
            if info.hits > self.cfg.threshold && !info.queued {
                info.queued = true;
                if self.pending.is_empty() {
                    self.since = self.clock;
                }
                self.pending.push((key, va));
            }
            self.emit_if_due(mem);
        }
        match self.map.get(&key) {
            Some(&Info { idx, len, .. }) if idx != 0 => {
                self.jc[jc_index(key)] = Jc { key, idx, len };
                if self.jc_used.len() < JC / 16 {
                    self.jc_used.push(jc_index(key) as u32);
                }
                Ok((idx, len))
            }
            Some(i) => Err(i.len.max(1)),
            None => Err(1), // flushed by the emit
        }
    }

    /// Emits the pending batch when it's full or has waited long enough.
    fn emit_if_due(&mut self, mem: &Mem) {
        if self.pending.len() >= self.cfg.batch as usize
            || (!self.pending.is_empty() && self.clock - self.since >= BATCH_TIMEOUT)
        {
            self.emit(mem);
        }
    }

    /// Compiles the pending batch into one module and installs it.
    fn emit(&mut self, mem: &Mem) {
        let regions = self.plan(mem);
        self.install(regions, mem);
    }

    /// The pending batch as regions. A head whose region is a loop is
    /// compiled alone, with a hot word, until it's hot ([`Cache::tier_up`]).
    /// The other blocks are grouped into forward regions
    /// ([`block::forward`]): each takes the batch's blocks that static edges
    /// reach from it (loop heads apart), so a block is compiled once, as a
    /// head or as a member. A member has no function of its own: entered
    /// from elsewhere (a branch from outside its region, a return into it,
    /// the dispatcher after its region ran out of steps), it is a block not
    /// compiled yet, counted from zero again and compiled as a head once
    /// that has happened often enough.
    fn plan(&mut self, mem: &Mem) -> Vec<block::Region> {
        let pending = core::mem::take(&mut self.pending);
        let all = self.cfg.threshold == 0 && self.cfg.region_after == 0;
        let loops: Vec<block::Region> = pending
            .iter()
            .map(|&(key, va)| self.region(key, va, mem))
            .collect();
        // The batch's keys: a loop head, taken (a head, or a member of an
        // earlier region), or free to be a member.
        const FREE: u8 = 0;
        const LOOP: u8 = 1;
        const TAKEN: u8 = 2;
        let mut batch: Map<u8> = pending
            .iter()
            .zip(&loops)
            .map(|(p, r)| (p.0, if heads_loop(r) { LOOP } else { FREE }))
            .collect();
        // The batch's blocks by the VA they were seen at (and their regime
        // bits): how a region finds a successor in another page, whose key
        // isn't its own plus an offset. Another address space may have
        // another block at that VA: the edge checks the mapping when it runs.
        let at: Map<u64> = pending.iter().map(|&(k, va)| (va | k & 3, k)).collect();
        let mut regions = Vec::with_capacity(pending.len());
        for ((key, va), mut r) in pending.into_iter().zip(loops) {
            if batch[&key] == TAKEN {
                continue;
            }
            batch.insert(key, TAKEN);
            if r.blocks.len() > 1 {
                if self.cfg.region_after > 0 {
                    r.blocks.truncate(1);
                    r.tier = Some(0); // its word's address once it has a slot
                }
            } else if !r.blocks.is_empty() && !r.looped() {
                r = block::forward(mem, key, va, &|va, near| {
                    // With the MMU off a VA is its PA.
                    let flat = key & block::KEY_MMU == 0;
                    let k = match near {
                        Some(k) => k,
                        None if flat => va | key & 3,
                        None => *at.get(&(va | key & 3))?,
                    };
                    let free = match batch.get(&k) {
                        Some(&state) => state == FREE,
                        // Everything at once (the differential tests): any
                        // block in reach that heads no loop.
                        None => all && !heads_loop(&self.region(k, 0, mem)),
                    };
                    free.then_some(k)
                });
                // (No blocks at all if another vCPU rewrote the head's code
                // since `loops` read it: parallel SMP.)
                for b in r.blocks.iter().skip(1) {
                    batch.insert(b.key, TAKEN);
                    if let Some(i) = self.map.get_mut(&b.key) {
                        (i.queued, i.hits) = (false, 0);
                    }
                }
            }
            if let Some(i) = self.map.get_mut(&key) {
                (i.queued, i.len) = (false, r.blocks.first().map_or(0, |b| b.words.len() as u32));
            }
            if !r.blocks.is_empty() {
                regions.push(r);
            }
        }
        regions
    }

    /// The region headed by `key`: its members are the blocks the dispatcher
    /// has seen (so they ran at least once); when everything is compiled at
    /// once (threshold 0 and regions at once: the forced mode of the
    /// differential tests), any. Not in JIT-stress: regions of every block in
    /// reach, compiled on every miss into a 4-block cache, ran its boots 42×
    /// slower than step 7 (kvm-unit-tests `gic active`: 522 s vs 12.5 s).
    fn region(&self, key: u64, va: u64, mem: &Mem) -> block::Region {
        let all = self.cfg.threshold == 0 && self.cfg.region_after == 0;
        let map = &self.map;
        block::region(mem, key, va, &|k| all || map.contains_key(&k))
    }

    /// A loop head compiled alone got hot (`jit_hot`): compiles its region
    /// and points the head's hot word at it.
    fn tier_up(&mut self, key: u64, va: u64, mem: &Mem) {
        let Some(word) = self.map.get(&key).map(|i| i.word).filter(|&w| w != 0) else {
            return;
        };
        // Never a flush here: JIT code is running (the head's prologue), and
        // what it goes on to call must stay in the cache. Without room, the
        // head stays alone until the next flush drops it.
        let r = self.region(key, va, mem);
        if r.blocks.len() < 2
            || self.next >= self.cfg.capacity
            || self.live_bytes >= self.cfg.max_bytes
        {
            return;
        }
        // Members that are loop heads compiled alone stop counting: this
        // region runs their loop now, unless they head an inner loop (an
        // edge back to them leaves the region).
        for m in r.inner_free() {
            if let Some(w) = self.map.get(&m).map(|i| i.word).filter(|&w| w != 0) {
                self.hot[w as usize - 1] &= emit::REDIRECT;
            }
        }
        let Some(idx) = self.install(vec![r], mem) else {
            return;
        };
        self.hot[word as usize - 1] = emit::REDIRECT | idx;
        let j = &mut self.jc[jc_index(key)];
        if j.key == key {
            j.idx = idx;
        }
        self.stats.tier_ups += 1;
    }

    /// Compiles `regions` into one module and installs it; the table index
    /// of its first function.
    fn install(&mut self, mut regions: Vec<block::Region>, mem: &Mem) -> Option<u32> {
        let (base, phys) = mem.base();
        let ram = (base as usize, phys, mem.size());
        assert!(
            *self.ram.get_or_insert(ram) == ram,
            "a JIT vCPU runs on one RAM"
        );
        if regions.is_empty() {
            return None;
        }
        if self.xmiss.is_none() {
            // The first install: the cache's slots start here.
            let slot = self.alloc(MISS_SLOTS);
            assert_eq!(slot, 0, "the miss functions come first");
            let jc = self.jc.as_ptr() as usize as u32;
            let Some(idx) = install(&block::miss_module(mem, self.cfg.check, jc), slot) else {
                self.off = true;
                return None;
            };
            self.xmiss = Some(idx);
        }
        let n = regions.len() as u32;
        let slot = self.alloc(n);
        for (k, r) in regions.iter_mut().enumerate() {
            if r.tier.is_some() {
                let w = slot as usize + k;
                self.hot[w] = self.cfg.region_after;
                r.tier = Some(self.hot[w..].as_ptr() as usize as u32);
            }
        }
        let map = &self.map;
        let compiled = |k| map.get(&k).filter(|i| i.idx != 0).map(|i| (i.idx, i.len));
        let block::Emitted {
            bytes,
            inl,
            links,
            counts,
        } = block::module(
            &regions,
            mem,
            compiled,
            self.cfg.check,
            self.jc.as_ptr() as usize as u32,
            self.features,
            self.xmiss,
        );
        let t = now_ns();
        let Some(idx) = install(&bytes, slot) else {
            self.off = true;
            return None;
        };
        let s = &mut self.stats;
        s.compile_ns += now_ns() - t;
        s.flags_stored += counts.flags_stored;
        s.flags_elided += counts.flags_elided;
        s.cond_direct += counts.cond_direct;
        s.cond_computed += counts.cond_computed;
        s.cond_memory += counts.cond_memory;
        self.live_bytes += bytes.len() as u64;
        let s = &mut self.stats;
        (s.modules, s.blocks, s.bytes) = (
            s.modules + 1,
            s.blocks + n as u64,
            s.bytes + bytes.len() as u64,
        );
        for (k, ((r, inl), links)) in regions.iter().zip(inl).zip(links).enumerate() {
            let size: u32 = r.blocks.iter().map(|b| b.words.len() as u32).sum();
            let s = &mut self.stats;
            (s.inline, s.helpers) = (s.inline + inl as u64, s.helpers + (size - inl) as u64);
            s.region_blocks += r.blocks.len() as u64;
            s.back_edges += r.back_edges() as u64;
            let (key, len) = (r.blocks[0].key, r.blocks[0].words.len() as u32);
            let words: Vec<u32> = r
                .blocks
                .iter()
                .flat_map(|b| b.words.iter().copied())
                .collect();
            let word = if r.tier.is_some() {
                slot + k as u32 + 1
            } else {
                0
            };
            let i = self.info(key, || 0);
            (i.idx, i.len, i.hash, i.word) = (idx + k as u32, len, block::hash(&words), word);
            if self.cfg.check {
                let spans = r.blocks.iter().map(|b| (b.key & !3, b.words.len() as u32));
                self.spans.insert(key, spans.collect());
            }
            for t in links {
                self.linkers.entry(t).or_default().push(key);
            }
            // A region goes with any of its pages (`invalidate`).
            for b in r.blocks.iter().skip(1) {
                if (b.key ^ key) >> 12 != 0 {
                    let keys = self.pages.entry(b.key >> 12).or_default();
                    if !keys.contains(&key) {
                        keys.push(key);
                    }
                }
            }
        }
        Some(idx)
    }
}

type Map<V> = HashMap<u64, V, BuildHasherDefault<KeyHasher>>;

/// Whether the head's region ([`Cache::region`]) is a loop, of several
/// blocks or of the head onto itself.
fn heads_loop(r: &block::Region) -> bool {
    r.blocks.len() > 1 || (r.blocks.len() == 1 && r.looped())
}

/// `Cache::info`, over the fields it needs.
fn info<'a>(
    map: &'a mut Map<Info>,
    pages: &mut Map<Vec<u64>>,
    key: u64,
    len: impl FnOnce() -> u32,
) -> &'a mut Info {
    use std::collections::hash_map::Entry;
    match map.entry(key) {
        Entry::Occupied(e) => e.into_mut(),
        Entry::Vacant(e) => {
            pages.entry(key >> 12).or_default().push(key);
            e.insert(Info {
                len: len(),
                ..Info::default()
            })
        }
    }
}

fn now_ns() -> u64 {
    #[cfg(target_arch = "wasm32")]
    // SAFETY: a host function with no preconditions.
    return (unsafe { crate::vm::now_ms() } * 1e6) as u64;
    #[cfg(not(target_arch = "wasm32"))]
    0
}

/// The block key for the PC: its PA (through the instruction TLB when the
/// MMU copy runs) and the regime bits; `None` if the fetch would fault, which
/// the interpreter then raises, or alignment checking is on.
#[inline(always)]
fn key(v: &mut Vcpu, mem: &Mem) -> Option<u64> {
    let c = &v.cpu;
    let (pc, el) = (c.pc, c.el() & 1);
    // Inline loads and stores don't check alignment: with SCTLR_EL1.A set
    // (Linux never sets it) everything runs in the interpreter.
    if pc & 3 != 0 || c.sctlr_el1 & sctlr::A != 0 {
        return None;
    }
    if c.sctlr_el1 & (sctlr::M | sctlr::A) == 0 {
        return Some(pc | el);
    }
    let p = Mmu::new(mem, Some(&mut v.tlb)).fetch_ptr(c, pc).ok()?;
    Some(mem.pa(p) | el | block::KEY_MMU)
}

/// Runs up to `n` instructions exactly as [`interp::steps`] does (same
/// result, same exits), through compiled blocks where the cache has them and
/// they fit in what's left of `n`, and through the interpreter otherwise.
/// `v` has a cache (`jit.cache`).
///
/// # Safety
/// `v` is valid and nothing else references it while this runs.
pub unsafe fn steps(v: *mut Vcpu, mem: &Mem, n: u64) -> (u64, Option<Exit>) {
    let mut done = 0;
    while done < n {
        let left = n - done;
        // SAFETY: guaranteed by the caller; the reference ends before a block runs.
        let vr = unsafe { &mut *v };
        vr.jit.mem = mem;
        let (pc, key) = (vr.cpu.pc, key(vr, mem));
        let cache = vr.jit.cache.as_deref_mut().expect("a JIT vCPU");
        let r = key.map_or(Err(1), |k| cache.enter(k, pc, mem));
        if vr.tlb.xdrops != cache.drops {
            vr.tlb.xdrops = cache.drops;
            vr.tlb.bump();
        }
        if let Ok((idx, len)) = r
            && len as u64 <= left
        {
            let key = key.expect("compiled");
            if cache.cfg.check && !cache.check(key, mem) {
                // Tolerated (parallel SMP): drop it and compile the code as it is now.
                cache.invalidate(key & !0xfff);
                continue;
            }
            if key & block::KEY_MMU != 0 {
                vr.tlb.xc_fill(pc, key & 3, idx, len);
            }
            let helped = vr.jit.helper_steps;
            // SAFETY: `idx` is a compiled block (the cache drops blocks, and
            // the blocks chained to them, before it reuses their slots), and no
            // reference into `*v` is live: the block and its helpers use the
            // raw pointer. `mem` isn't in `*v`.
            let k = unsafe { block(idx)(v, 0, left.min(i32::MAX as u64) as u32) } as u64;
            // SAFETY: the block has returned.
            let vr = unsafe { &mut *v };
            let cache = vr.jit.cache.as_deref_mut().expect("a JIT vCPU");
            let e = vr.jit.exit.take();
            let s = &mut cache.stats;
            let ran = k + e.is_some_and(Exit::retired) as u64;
            s.dispatches += 1;
            s.steps += ran;
            s.inline_steps += ran - (vr.jit.helper_steps - helped);
            cache.clock += k;
            done += k;
            if e.is_some() {
                return (done, e);
            }
        } else {
            let m = match r {
                Ok((_, len)) | Err(len) => len as u64,
            };
            let (k, e) = interp::steps(&mut vr.cpu, mem, Some(&mut vr.tlb), m.min(left));
            if let Some(c) = vr.jit.cache.as_deref_mut() {
                c.clock += k;
            }
            done += k;
            if e.is_some() {
                return (done, e);
            }
        }
    }
    (n, None)
}

/// [`interp::run`] through the JIT, for user-mode hosts (the corpus, the benchmarks).
///
/// # Safety
/// As for [`steps`].
pub unsafe fn run(v: *mut Vcpu, mem: &Mem, n: u64) -> (u64, Result<(), Exit>) {
    let mut done = 0;
    while done < n {
        // SAFETY: guaranteed by the caller.
        let (k, e) = unsafe { steps(v, mem, n - done) };
        done += k;
        // SAFETY: no block is running.
        let c = unsafe { &mut (*v).cpu };
        match e {
            None => {}
            Some(Exit::Resync) => done += 1,
            Some(Exit::Invalidate(pa)) => {
                done += 1;
                // SAFETY: no block is running.
                if let Some(j) = unsafe { &mut (*v).jit.cache } {
                    j.invalidate(pa);
                }
            }
            Some(Exit::Wfi) => {
                c.pc = c.pc.wrapping_add(4);
                done += 1;
            }
            Some(e) => return (done, Err(e)),
        }
    }
    (n, Ok(()))
}

/// Runs one instruction of a block compiled for the flat bus (MMU and
/// alignment checks off), as the interpreter would after fetching it at `pc`:
/// returns 0 if it retired, else 1 with its exit in [`State::exit`].
///
/// # Safety
/// `v` is the vCPU a block was called with, `v.jit.mem` its RAM, and nothing
/// holds a reference into either.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jit_exec_flat(v: *mut Vcpu, insn: u32, pc: u64) -> u32 {
    // SAFETY: guaranteed by the caller.
    let (mem, v) = unsafe { (&*(*v).jit.mem, &mut *v) };
    let r = interp::exec_at(&mut v.cpu, &mut Flat(mem), insn, pc);
    count(&mut v.jit, insn);
    status(&mut v.jit, r)
}

/// As [`jit_exec_flat`], through the MMU and the vCPU's TLB.
///
/// # Safety
/// As for [`jit_exec_flat`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jit_exec_mmu(v: *mut Vcpu, insn: u32, pc: u64) -> u32 {
    // SAFETY: guaranteed by the caller.
    let (mem, v) = unsafe { (&*(*v).jit.mem, &mut *v) };
    let mut m = Mmu::new(mem, Some(&mut v.tlb));
    let r = interp::exec_at(&mut v.cpu, &mut m, insn, pc);
    count(&mut v.jit, insn);
    status(&mut v.jit, r)
}

/// Counts a helper call by instruction class.
fn count(j: &mut State, insn: u32) {
    if let Some(c) = j.cache.as_deref_mut() {
        c.helper_ops[crate::decode::decode(insn) as usize] += 1;
    }
}

fn status(j: &mut State, r: Result<(), Exit>) -> u32 {
    match r {
        Ok(()) => {
            j.helper_steps += 1;
            0
        }
        Err(e) => {
            j.helper_steps += e.retired() as u64;
            j.exit = Some(e);
            1
        }
    }
}

/// The stale-code checker at a chained entry into the block at `key` (blocks
/// compiled with `jit::Config::check` call it before they chain); `u64::MAX`:
/// the block at the PC (a transfer cache hit, which knows no key).
///
/// # Safety
/// As for [`jit_exec_flat`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jit_check(v: *mut Vcpu, key: u64) {
    // SAFETY: guaranteed by the caller.
    let (mem, v) = unsafe { (&*(*v).jit.mem, &mut *v) };
    let key = match key {
        u64::MAX => self::key(v, mem).expect("a block's PC"),
        k => k,
    };
    // A tolerant cache only counts a stale block here, mid-chain: it's
    // dropped when the run loop next enters it.
    v.jit
        .cache
        .as_deref_mut()
        .expect("a JIT vCPU")
        .check(key, mem);
}

/// A loop head compiled alone got hot (step 8.3, [`emit::tier_up`]): its
/// loop region is compiled now, at the head's entry (`pc`: its VA).
///
/// # Safety
/// As for [`jit_exec_flat`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jit_hot(v: *mut Vcpu, key: u64, pc: u64) {
    // SAFETY: guaranteed by the caller.
    let (mem, v) = unsafe { (&*(*v).jit.mem, &mut *v) };
    let cache = v.jit.cache.as_deref_mut().expect("a JIT vCPU");
    cache.tier_up(key, pc, mem);
}

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    /// Compiles and instantiates the module at `ptr..ptr + len` and puts its
    /// exports `f0`, `f1`, … into the core's table from JIT slot `slot` on.
    /// Returns the table index of `f0`, or -1 if the host has no JIT.
    fn jit_install(ptr: *const u8, len: usize, slot: u32) -> i32;
}

/// Installs `module`'s functions at JIT table slots `slot..`; returns
/// function `f0`'s table index, or `None` without a JIT host.
pub fn install(module: &[u8], slot: u32) -> Option<u32> {
    #[cfg(target_arch = "wasm32")]
    // SAFETY: the host reads `module` and touches only its own table.
    let i = unsafe { jit_install(module.as_ptr(), module.len(), slot) };
    #[cfg(not(target_arch = "wasm32"))]
    let i = {
        let _ = (module, slot);
        -1
    };
    (i >= 0).then_some(i as u32)
}

/// The block at table index `idx` (from [`install`]).
///
/// # Safety
/// `idx` came from [`install`] for a function of type [`Block`], and its slot
/// hasn't been reused since.
pub unsafe fn block(idx: u32) -> Block {
    // SAFETY: on wasm32 a function pointer is a table index, and the caller
    // guarantees the entry's type; there are no other targets with a JIT.
    unsafe { core::mem::transmute::<usize, Block>(idx as usize) }
}

/// The step 1 plumbing check: a module with one block that adds `imm` to
/// X`reg` and returns 1.
pub fn add_module(reg: u32, imm: i64) -> Vec<u8> {
    use wasm::{Code, I32, Module};
    let mut m = Module::default();
    m.import_memory("env", "memory", 0, 65536);
    let t = m.ty(&[I32, I32, I32], &[I32]);
    let mut c = Code::default();
    let off = 8 * reg;
    c.local_get(0).local_get(0).i64_load(off);
    c.i64_const(imm).i64_add().i64_store(off).i32_const(1).end();
    m.func(t, &[], &c, "add");
    m.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cpu::Cpu;

    #[test]
    fn cpu_size() {
        // tests/jit-lockstep.test.ts compares this many bytes (`CPU_BYTES`).
        assert_eq!(size_of::<Cpu>(), 1072);
    }

    #[test]
    fn slots_and_flush() {
        let mut c = Cache::new(Config {
            threshold: 0,
            batch: 4,
            capacity: 10,
            max_bytes: 1000,
            check: false,
            region_after: 0,
        });
        c.map.insert(0x100, Info::default());
        assert_eq!((c.alloc(4), c.alloc(4)), (0, 4));
        assert_eq!(c.stats.flushes, 0);
        assert_eq!(c.alloc(3), 0); // 8 + 3 > 10: flushed, from slot 0 again
        assert_eq!(c.stats.flushes, 1);
        assert!(c.map.is_empty());
        assert_eq!((c.alloc(4), c.alloc(3)), (3, 7));
        assert_eq!(c.stats.flushes, 1);
        c.flush();
        assert_eq!((c.alloc(1), c.stats.flushes), (0, 2));
        // The byte budget flushes too, at the next slots after the modules' bytes reach it.
        c.live_bytes = 999;
        assert_eq!((c.alloc(1), c.stats.flushes), (1, 2));
        c.live_bytes = 1000;
        assert_eq!((c.alloc(1), c.stats.flushes), (0, 3));
        assert_eq!(c.live_bytes, 0);
    }

    /// A batch's blocks are compiled once each: a loop head alone (with its
    /// hot word), the rest as forward regions over the batch's own blocks.
    #[test]
    fn a_batch_is_planned_as_forward_regions_and_loop_heads() {
        let mut ram = vec![0u128; 0x1000 / 16];
        // SAFETY: `ram` outlives `mem` and is 16-byte aligned.
        let mem = unsafe { Mem::new(ram.as_mut_ptr().cast(), 0x1000) };
        // 0x100: cbz x1, 0x10c
        // 0x104: add x2, x2, #1; b 0x110
        // 0x10c: add x2, x2, #2
        // 0x110: add x3, x3, #1; cbnz x3, 0x120
        // 0x118: ret
        // 0x120: subs x5, x5, #1; cbz x5, 0x12c
        // 0x128: b 0x120 (a loop of two blocks)
        // 0x12c: subs x6, x6, #1; b.ne 0x12c (a loop of one); ret
        #[rustfmt::skip]
        let words = [
            0xb4000061u32, 0x91000442, 0x14000002, 0x91000842, 0x91000463, 0xb5000063, 0xd65f03c0, 0,
            0xf10004a5, 0xb4000045, 0x17fffffe, 0xf10004c6, 0x54ffffe1, 0xd65f03c0,
        ];
        for (k, w) in words.into_iter().enumerate() {
            mem.write(0x100 + 4 * k as u64, 4, w as u64).unwrap();
        }
        let mut c = Cache::new(Config::DEFAULT);
        // Every block was dispatched and is pending, but 0x118 (seen once).
        for k in [0x110, 0x100, 0x104, 0x10c, 0x120, 0x128, 0x12c, 0x118] {
            let i = c.info(k, || 1);
            (i.hits, i.queued) = (51, k != 0x118);
            if k != 0x118 {
                c.pending.push((k, k));
            }
        }
        let regions = c.plan(&mem);
        let keys: Vec<Vec<u64>> = regions
            .iter()
            .map(|r| r.blocks.iter().map(|b| b.key).collect())
            .collect();
        // 0x110 came first: a head (its successors: a loop head, and a block
        // that isn't in the batch). 0x100 takes both its sides; 0x104
        // doesn't take 0x110, which is a head already. The loop's blocks
        // are heads, alone until they're hot (either may be entered first),
        // and 0x120 doesn't take its way out, the loop of one, which is
        // compiled as that at once.
        #[rustfmt::skip]
        assert_eq!(keys, [vec![0x110], vec![0x100, 0x104, 0x10c], vec![0x120], vec![0x128], vec![0x12c]]);
        let tiers: Vec<_> = regions.iter().map(|r| r.tier).collect();
        assert_eq!(tiers, [None, None, Some(0), Some(0), None]);
        // The members start counting again, and aren't queued.
        for k in [0x104, 0x10c] {
            assert_eq!(
                (c.map[&k].hits, c.map[&k].queued, c.map[&k].idx),
                (0, false, 0)
            );
        }
        assert!(c.pending.is_empty() && !c.map[&0x100].queued);
    }

    #[test]
    fn without_a_jit_host_the_dispatcher_interprets() {
        let mut ram = vec![0u128; 0x1000 / 16];
        // SAFETY: `ram` outlives `mem` and is 16-byte aligned.
        let mem = unsafe { Mem::new(ram.as_mut_ptr().cast(), 0x1000) };
        // mov x0, #0; 1: add x0, x0, #1; cmp x0, #100; b.ne 1b; brk #0
        for (k, w) in [
            0xd2800000u32,
            0x91000400,
            0xf101901f,
            0x54ffffc1,
            0xd4200000,
        ]
        .into_iter()
        .enumerate()
        {
            mem.write(0x100 + 4 * k as u64, 4, w as u64).unwrap();
        }
        let mut c = Cpu {
            pc: 0x100,
            ..Cpu::default()
        };
        let mut v = Vcpu::new(c.clone());
        v.jit.cache = Some(Box::new(Cache::new(Config::STRESS)));
        let want = interp::run(&mut c, &mem, 1000);
        let got = unsafe { run(&mut *v, &mem, 1000) };
        assert_eq!((got, &v.cpu), (want, &c));
        assert_eq!(want, (301, Err(Exit::Brk(0))));
        let cache = v.jit.cache.as_deref().unwrap();
        assert!(cache.off && cache.map.len() == 3); // mov, the loop, brk
    }

    #[test]
    fn invalidation_by_page_and_all() {
        let mut c = Cache::new(Config::DEFAULT);
        for k in [0x1000, 0x1ff8 | block::KEY_EL1, 0x2000, 0x3000, 0x4000] {
            c.info(k, || 1).idx = 7;
            c.jc[jc_index(k)] = Jc {
                key: k,
                idx: 7,
                len: 1,
            };
        }
        // 0x3000 chains to 0x1000, and 0x4000 to 0x3000: both go with page 1.
        c.linkers.insert(0x1000, vec![0x3000]);
        c.linkers.insert(0x3000, vec![0x4000]);
        c.info(0x1004, || 1).queued = true;
        c.pending.push((0x1004, 0));
        c.invalidate(0x1ab0); // IC IVAU on page 1
        assert_eq!(c.map.keys().copied().collect::<Vec<_>>(), [0x2000]);
        assert!(c.jc[jc_index(0x1000)].key == u64::MAX && c.jc[jc_index(0x2000)].key == 0x2000);
        assert!(c.jc[jc_index(0x4000)].key == u64::MAX && c.linkers.is_empty());
        assert_eq!(c.pending, []);
        assert_eq!(c.stats.invalidations, 1);
        c.invalidate(0x5000); // no code there
        assert_eq!(c.stats.invalidations, 1);
        c.invalidate(u64::MAX); // IC IALLU
        assert!(c.map.is_empty() && c.pages.is_empty());
        assert_eq!((c.stats.invalidations, c.stats.flushes), (2, 0));
    }

    #[test]
    fn helpers_retire_or_exit_like_the_interpreter() {
        let mut ram = vec![0u128; 0x1000 / 16];
        // SAFETY: `ram` outlives `mem` and is 16-byte aligned.
        let mem = unsafe { Mem::new(ram.as_mut_ptr().cast(), 0x1000) };
        let mut v = Vcpu::new(Cpu::default());
        v.jit.mem = &mem;
        v.cpu.x[2] = 5;
        let p: *mut Vcpu = &mut *v;
        // add x1, x2, #3 at 0x40: retires, PC past it.
        assert_eq!(unsafe { jit_exec_flat(p, 0x91000c41, 0x40) }, 0);
        assert_eq!((v.cpu.x[1], v.cpu.pc, v.jit.exit), (8, 0x44, None));
        // ldr x0, [x2] with x2 past RAM: a fault, PC back on it.
        v.cpu.x[2] = 0x10_0000;
        let p: *mut Vcpu = &mut *v;
        assert_eq!(unsafe { jit_exec_mmu(p, 0xf9400040, 0x44) }, 1);
        assert!(matches!(v.jit.exit, Some(Exit::Fault(_))));
        assert_eq!(v.cpu.pc, 0x44);
    }
}
