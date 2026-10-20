//! Tier-1 JIT: guest A64 blocks → WebAssembly (docs/jit.md).
//!
//! Generated modules import the core's memory, its function table and its
//! helper exports. The host compiles each module synchronously in the vCPU
//! worker and puts its functions into the core's table (`env.jit_install`), so
//! the run loop calls a block through a function pointer, which on wasm32 is a
//! table index. A VM's vCPUs share one [`Cache`]; each thread's table installs
//! its modules, the same bytes in the same slots, so V8 compiles each once
//! (docs/jit.md "Sharing"). Natively there's no wasm engine: [`install`] fails
//! and everything runs in the interpreter.

pub mod block;
pub mod emit;
pub mod wasm;

use std::collections::{HashMap, VecDeque};
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use crate::cpu::sctlr;
use crate::interp::{self, Exit};
use crate::mem::Mem;
use crate::mmu::{Flat, Mmu, Vcpu};
use crate::vm::Lock;

/// A compiled block: `f(vcpu, acc, left) -> acc + retired`, equivalent to
/// `interp::steps` for its length and the blocks it chains to within `left`
/// steps (docs/jit.md): if fewer than all their instructions retired,
/// the one that didn't left its exit in [`State::exit`] and the PC on it.
pub type Block = unsafe extern "C" fn(*mut Vcpu, u32, u32) -> u32;

/// Per-vCPU JIT state, before the TLB in [`Vcpu`]. The helpers use the first
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
    /// The jump cache and the hot words of the table the vCPU runs on (blocks
    /// read them through these: `emit::JC_PTR`, `emit::HOT_PTR`), set by
    /// [`steps`].
    pub jc: *mut Jc,
    pub hot: *mut u32,
    pub cache: Option<Box<Jit>>,
}

/// Compile policy (the knobs docs/jit.md "Compile policy" describes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Config {
    /// Dispatches of a block key before it joins the pending batch (0: on first
    /// sight), while the code cache has room: [`Cache::retune`] raises it
    /// up to `threshold_max` as the cache fills and after flushes (equal or
    /// below: fixed).
    pub threshold: u32,
    pub threshold_max: u32,
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
    /// The wasm memory's fixed size in pages (`VmConfig.mem_pages`), which
    /// modules import as exact limits: V8 then loads its size once per
    /// function, not after every call (docs/v8.md "Bounds checks"). 0: growable.
    pub pages: u32,
    /// Micro-ops each table's decoded blocks hold (`interp::block::BUDGET`
    /// shared out among a VM's tables).
    pub decoded: u32,
    /// A forward region also takes a successor in reach that has run this
    /// many dispatches but isn't compiled or in the batch (0: the batch's
    /// blocks only), so the edge into it stays in the function instead of a
    /// jump-cache probe and an indirect call (docs/jit.md "Compile policy").
    pub warm: u32,
}

impl Config {
    pub const DEFAULT: Config = Config {
        // Since the block interpreter, raised with the cache's pressure
        // (docs/jit.md "Compile policy").
        threshold: 50,
        threshold_max: 1000,
        batch: 512,
        capacity: 262_144,
        max_bytes: MAX_BYTES,
        check: false,
        region_after: REGION_AFTER,
        pages: 0,
        decoded: interp::block::MAX_BUDGET as u32,
        warm: WARM,
    };
    /// Compile everything on first sight, one block per module, and flush
    /// constantly: room for 4 regions besides the miss functions.
    pub const STRESS: Config = Config {
        threshold: 0,
        threshold_max: 0,
        batch: 1,
        capacity: 4 + MISS_SLOTS,
        max_bytes: u64::MAX,
        check: true,
        region_after: 1,
        pages: 0,
        decoded: interp::block::MAX_BUDGET as u32,
        warm: 0,
    };
    /// JIT-check: compile everything on first sight into a full-size cache,
    /// with the stale-code checker. JIT-stress's 4-region cache evicts most
    /// blocks before they're entered again, which hides stale ones (M7 loop 4:
    /// code rewritten by another vCPU).
    pub const CHECK: Config = Config {
        threshold: 0,
        threshold_max: 0,
        batch: 1,
        max_bytes: u64::MAX,
        check: true,
        region_after: 0,
        warm: 0,
        ..Config::DEFAULT
    };
    /// The dispatcher without compiling: everything in the block interpreter
    /// (`VmConfig.jit` 4, ABI 33; what the dispatcher does natively, where
    /// there's no wasm engine).
    pub const INTERP: Config = Config {
        threshold: u32::MAX,
        threshold_max: u32::MAX,
        ..Config::DEFAULT
    };
}

/// [`Config::DEFAULT`]'s `max_bytes`: the wasm bytes V8 may hold for a whole VM
/// (~6-10× that in memory once full: ~2-3 GiB), whose vCPUs share the code.
/// Twice the 160 MiB it was: Firefox's page loads fit without a flush
/// (docs/jit.md "Memory"; `bench/boot/REPORT.md` "M8: the carry timed, and a
/// larger code cache").
pub const MAX_BYTES: u64 = 320 << 20;

/// The eighths of `Config::max_bytes` the live modules fill before the compile
/// threshold starts to rise ([`Cache::retune`]).
pub const PRESSURE_KNEE: u64 = 2;

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
    /// Instructions the block interpreter ran (`interp::block`, ABI 33), the
    /// blocks it decoded, and the times its cache started over (full).
    pub dec_steps: u64,
    pub decoded: u64,
    pub dec_clears: u64,
    /// Modules installed once the compile worker had compiled them, and
    /// ones compiled here after [`OVERDUE_NS`] without it (ABI 36).
    pub worker_installs: u64,
    pub overdue: u64,
    /// Modules the worker had compiled that the host didn't have yet (its
    /// copy of the compiled module still on the way), and runs ended early
    /// so that it arrives (ABI 37, [`Table::parked`]).
    pub parks: u64,
    pub park_exits: u64,
}

/// Multiply-shift over the block key: std's SipHash costs too much on every dispatch.
#[derive(Default)]
pub(crate) struct KeyHasher(u64);

/// Maps keyed by block key.
pub(crate) type KeyBuild = BuildHasherDefault<KeyHasher>;

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
/// Each table has its own: an entry names a slot of that table.
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

/// The invalidated pages the cache keeps for tables to catch up with
/// (`Cache::ival_log`): Chromium in Debian issues ~4,000 ICs a second warm
/// and ~68,000 in a cold render (bench/apps/REPORT.md), and a
/// vCPU waiting in WFI doesn't catch up (4,096 entries cleared the tables'
/// decoded blocks ~35 times a render).
const IVAL_LOG: usize = 1 << 16;

/// The slots of the transfer cache's miss functions.
const MISS_SLOTS: u32 = 2;

/// Steps the pending batch's blocks have run in the interpreter since they
/// joined it at which it's emitted: blocks that run often get compiled soon,
/// and lukewarm ones wait for company, so the modules are fewer and larger
/// (V8 spends ~16 KB on a module besides its functions: docs/jit.md "Memory").
pub const BATCH_STEPS: u64 = 50_000;

/// Steps after the first block joins a pending batch before it's emitted
/// anyway, so a lukewarm block doesn't wait forever.
pub const BATCH_TIMEOUT: u64 = 64_000_000;

/// [`Config::DEFAULT`]'s `warm`.
pub const WARM: u32 = 16;

/// The code cache a VM's vCPUs share (docs/jit.md "Sharing"): the blocks, the
/// pending batch, the slot allocator, and the modules installed since the
/// last flush, which every [`Table`] installs in the same slots, in order.
/// Behind a lock ([`Jit`]); a module's bytes are the same in every table, so
/// V8 compiles it once and the tables share its code.
pub struct Cache {
    pub cfg: Config,
    /// The vCPUs' `Cpu::features`, which the emitted code may assume (a VM
    /// sets it from its config; user-mode vCPUs have them all).
    pub features: u64,
    map: Map<Info>,
    /// The keys in `map` by physical page, for `IC IVAU`.
    pages: Map<Vec<u64>>,
    /// The compiled blocks that chain to a key (step 7), dropped with it.
    linkers: Map<Vec<u64>>,
    /// Each compiled region's blocks as (PA, length), for the stale-code checker.
    spans: Map<Vec<(u64, u32)>>,
    /// The loop regions compiled for heads compiled alone ([`Cache::tier_up`]),
    /// by head: when the head gets hot in another table, it redirects there.
    tiers: Map<Tier>,
    /// (key, VA) of blocks waiting to be compiled.
    pending: Vec<(u64, u64)>,
    /// Steps the pending blocks have been dispatched for since they joined it
    /// ([`BATCH_STEPS`]).
    pending_steps: u64,
    /// Pending batches emitted or dropped so far: a table times the wait of
    /// the one pending from when it first saw it ([`Table::since`]).
    batch: u64,
    /// The next free slot.
    next: u32,
    /// The bytes of the modules installed since the last flush (`Config::max_bytes`).
    live_bytes: u64,
    /// The compile threshold now, and the one it starts from after a flush
    /// ([`Cache::retune`]).
    threshold: u32,
    floor: u32,
    /// No JIT host (natively, or before `jit.bind`): interpret everything.
    off: bool,
    /// The stale-code checker counts stale blocks instead of panicking
    /// (parallel SMP: code another vCPU rewrote is legal to run until this
    /// one drains that vCPU's IC at a context synchronization event).
    pub tolerant: bool,
    /// The RAM the blocks were compiled for (flat blocks embed its layout).
    ram: Option<(usize, u64, u64)>,
    /// How many times blocks were dropped. A table whose count differs
    /// catches up ([`Table::sync`]) before its vCPU runs a block, and so do
    /// that vCPU's transfer cache (`mmu::Tlb::xc`, by `Tlb::xdrops`): in
    /// round-robin SMP one table serves every vCPU, each with its own
    /// transfer cache. Read without the lock ([`Jit::fresh`]).
    drops: Arc<AtomicU64>,
    /// The pages `IC IVAU` named (`u64::MAX`: `IC IALLU`) since entry
    /// `ival_base`, for the tables' decoded blocks (`interp::block`), which
    /// are dropped by page and not with compiled ones (a decoded block
    /// doesn't link to others, and it outlives flushes). Every IC is logged,
    /// since a table may have decoded a page the cache has no keys for; the
    /// entries every table has seen are dropped, and past [`IVAL_LOG`] the
    /// oldest (a table that missed one starts over).
    ival_log: VecDeque<u64>,
    ival_base: u64,
    /// `ival_base` + the log's length, read without the lock ([`Jit::fresh`]).
    ivals: Arc<AtomicU64>,
    /// Flushes (and `IC IALLU`s) so far: each starts the slots over.
    epoch: u64,
    /// The modules installed since then, in order; and how many of them
    /// every table has (their bytes are dropped).
    log: Vec<Logged>,
    freed: usize,
    /// The next module's number for the host's compile worker (from 1; 0:
    /// the host took none, so a table installs it at once), and the word
    /// the worker sets to the number up to which it has compiled them all
    /// (docs/jit.md "Sharing": a table installs a module only then, from
    /// V8's cache, and interprets its blocks meanwhile).
    seq: u32,
    ready: Arc<AtomicU32>,
    /// Each table's progress, by [`Table::id`].
    tables: Vec<Seen>,
    /// The table index of slot 0 (the transfer cache's miss function for EL0;
    /// EL1's follows), once a table has installed it: the same in every
    /// table, as is every slot's.
    xmiss: Option<u32>,
    /// What the host reads of the cache without its lock, and its limit ([`Gauge`]).
    gauge: Arc<Gauge>,
}

/// The cache's state for the host, read without the lock (`vm_jit_gauge`,
/// ABI 45; docs/jit.md "The page's memory signal"): words [`G_LIVE_BYTES`],
/// [`G_LIVE_MODULES`], [`G_BUDGET`], [`G_EPOCHS`], and [`G_LIMIT`], which the
/// host writes.
#[repr(C)]
#[derive(Default)]
pub struct Gauge(pub [AtomicU64; GAUGE_WORDS]);
pub const GAUGE_WORDS: usize = 5;
/// The wasm bytes and the modules installed since the last flush: what V8
/// holds code and metadata for (until its GC collects a flushed epoch's).
pub const G_LIVE_BYTES: usize = 0;
pub const G_LIVE_MODULES: usize = 1;
/// The byte budget now ([`Cache::budget`]).
pub const G_BUDGET: usize = 2;
/// Flushes and `IC IALLU`s so far.
pub const G_EPOCHS: usize = 3;
/// The host's limit on the budget, bytes (0: none; never below
/// [`MIN_LIMIT`]): the page sets it when its memory signal says the device is
/// short of memory, and the cache flushes at it.
pub const G_LIMIT: usize = 4;
/// The least budget the host's limit leaves.
pub const MIN_LIMIT: u64 = 16 << 20;

/// A module installed since the last flush.
struct Logged {
    slot: u32,
    /// Its functions, and its number for the compile worker (0: none).
    n: u32,
    seq: u32,
    /// Emptied once every table has it.
    bytes: Vec<u8>,
    /// The hot words of its loop heads compiled alone (their slots).
    tiers: Vec<u32>,
}

/// A table's progress, as the cache records it.
#[derive(Default)]
struct Seen {
    /// The modules of `Cache::log` it has installed.
    installed: usize,
    /// Keys dropped since it last caught up, for its jump cache (`all`: too
    /// many to list, the whole jump cache).
    dropped: Vec<u64>,
    all: bool,
    /// The entries of `Cache::ival_log` it has seen (an absolute index).
    ival: u64,
}

/// A loop region compiled for a head compiled alone: its table index, the
/// head's hot word, and the hot words of members that stop counting.
struct Tier {
    idx: u32,
    word: u32,
    quiet: Vec<u32>,
}

impl Cache {
    pub fn new(cfg: Config) -> Cache {
        assert!(cfg.batch >= 1 && cfg.capacity >= cfg.batch + MISS_SLOTS);
        Cache {
            cfg,
            features: crate::cpu::FEATURES,
            map: HashMap::default(),
            pages: HashMap::default(),
            linkers: HashMap::default(),
            spans: HashMap::default(),
            tiers: HashMap::default(),
            pending: Vec::new(),
            pending_steps: 0,
            batch: 0,
            next: MISS_SLOTS,
            live_bytes: 0,
            threshold: cfg.threshold,
            floor: cfg.threshold,
            off: false,
            tolerant: false,
            ram: None,
            drops: Arc::new(AtomicU64::new(1)),
            ival_log: VecDeque::new(),
            ival_base: 0,
            ivals: Arc::new(AtomicU64::new(0)),
            epoch: 0,
            log: Vec::new(),
            freed: 0,
            seq: 1,
            ready: Arc::new(AtomicU32::new(0)),
            tables: Vec::new(),
            xmiss: None,
            gauge: Arc::new(Gauge::default()),
        }
        .gauged()
    }

    /// The byte budget: the configured one, or the host's limit when that is
    /// lower ([`G_LIMIT`]).
    fn budget(&self) -> u64 {
        match self.gauge.0[G_LIMIT].load(Ordering::Relaxed) {
            0 => self.cfg.max_bytes,
            l => l.max(MIN_LIMIT).min(self.cfg.max_bytes),
        }
    }

    /// Publishes the cache's state to its [`Gauge`].
    fn publish(&self) {
        let g = &self.gauge.0;
        g[G_LIVE_BYTES].store(self.live_bytes, Ordering::Relaxed);
        g[G_LIVE_MODULES].store(self.log.len() as u64, Ordering::Relaxed);
        g[G_BUDGET].store(self.budget(), Ordering::Relaxed);
        g[G_EPOCHS].store(self.epoch, Ordering::Relaxed);
    }

    fn gauged(self) -> Cache {
        self.publish();
        self
    }

    /// `n` consecutive slots for a module; flushes the cache first if they
    /// don't fit (counted in `s`).
    fn alloc(&mut self, n: u32, s: &mut Stats) -> u32 {
        if self.next + n > self.cfg.capacity || self.live_bytes >= self.budget() {
            self.flush(s);
        }
        self.next += n;
        self.next - n
    }

    /// Drops every block (their slots are reused; the modules are left to the
    /// GC) and the pending batch.
    pub fn flush(&mut self, s: &mut Stats) {
        self.drop_all();
        s.flushes += 1;
        if self.cfg.threshold_max > self.cfg.threshold {
            self.floor = self.floor.saturating_mul(2).min(self.cfg.threshold_max);
            self.retune();
        }
    }

    /// The compile threshold for the cache's pressure: `floor` (the
    /// configured threshold, doubled at each flush up to `threshold_max`)
    /// while the modules' bytes are under [`PRESSURE_KNEE`] eighths of the
    /// budget, doubled at each eighth past that, up to `threshold_max`. So
    /// code that fits is compiled early, and a working set that doesn't fit
    /// fills the budget's rest with code that runs more often.
    fn retune(&mut self) {
        let max = self.cfg.threshold_max;
        if max <= self.cfg.threshold {
            return;
        }
        let eighths = self.live_bytes / (self.cfg.max_bytes / 8).max(1);
        let shift = eighths.saturating_sub(PRESSURE_KNEE).min(31) as u32;
        self.threshold = self.floor.checked_shl(shift).unwrap_or(max).min(max);
    }

    fn drop_all(&mut self) {
        self.drops.fetch_add(1, Ordering::Relaxed);
        self.map.clear();
        self.pages.clear();
        self.linkers.clear();
        self.spans.clear();
        self.tiers.clear();
        self.pending.clear();
        self.pending_steps = 0;
        self.batch += 1;
        self.next = MISS_SLOTS;
        self.live_bytes = 0;
        self.retune();
        self.epoch += 1;
        self.log.clear();
        self.freed = 0;
        for t in &mut self.tables {
            *t = Seen {
                ival: t.ival,
                ..Seen::default()
            };
        }
        self.publish();
    }

    /// `IC IVAU` on `pa` drops the blocks of its page; `IC IALLU` (`u64::MAX`)
    /// all of them (counted in `s`).
    pub fn invalidate(&mut self, pa: u64, s: &mut Stats) {
        self.ival_log
            .push_back(if pa == u64::MAX { pa } else { pa >> 12 });
        if self.ival_log.len() > IVAL_LOG {
            self.ival_log.pop_front();
            self.ival_base += 1;
        }
        let end = self.ival_base + self.ival_log.len() as u64;
        self.ivals.store(end, Ordering::Relaxed);
        if pa == u64::MAX {
            self.drop_all();
        } else if let Some(mut keys) = self.pages.remove(&(pa >> 12)) {
            // With the blocks that chain to them, transitively: their code
            // calls the dropped functions directly.
            while let Some(k) = keys.pop() {
                self.map.remove(&k);
                self.spans.remove(&k);
                self.tiers.remove(&k);
                for t in self.tables.iter_mut().filter(|t| !t.all) {
                    if t.dropped.len() < JC / 16 {
                        t.dropped.push(k);
                    } else {
                        (t.all, t.dropped) = (true, Vec::new());
                    }
                }
                self.pending.retain(|p| p.0 != k);
                keys.extend(self.linkers.remove(&k).unwrap_or_default());
            }
        } else {
            return;
        }
        self.drops.fetch_add(1, Ordering::Relaxed);
        s.invalidations += 1;
    }

    /// The entry for `key`, created (and filed under its page) if new.
    fn info(&mut self, key: u64, len: impl FnOnce() -> u32) -> &mut Info {
        info(&mut self.map, &mut self.pages, key, len)
    }

    /// The stale-code checker at a region's entry: all its blocks' words.
    /// False for a stale block in a tolerant cache (counted in `s`); a stale
    /// block in any other panics. A block another vCPU's IC dropped since this
    /// one's table caught up passes: running it is legal until this vCPU's
    /// own context synchronization (a tolerant cache's window).
    fn check(&mut self, key: u64, mem: &Mem, s: &mut Stats) -> bool {
        if self.tolerant && !self.spans.contains_key(&key) {
            return true;
        }
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
        s.stale += 1;
        false
    }

    /// Not in table `t`'s jump cache (which has caught up): look it up, count
    /// `n` dispatches (the ones its decoded block counted since it last
    /// reported, and this one), queue it and emit the batch when due. Also
    /// returns how many dispatches its decoded block may count before it
    /// reports again: at most [`interp::block::REPORT`], and none past the
    /// threshold, so the block joins the batch at the dispatch that reaches
    /// it (as the blocks a forward region takes from the batch did when every
    /// dispatch reported: counting 16 at a time scattered them over batches,
    /// and Alpine's boot made 30% more, smaller regions and ran 8% slower).
    fn miss(
        &mut self,
        t: &mut Table,
        key: u64,
        va: u64,
        mem: &Mem,
        n: u32,
        len: Option<u32>,
    ) -> (Result<(u32, u32), u32>, u32) {
        let info = info(&mut self.map, &mut self.pages, key, || {
            len.unwrap_or_else(|| block::form(mem, key & !3).len() as u32)
        });
        if info.idx == 0 && !self.off && info.len > 0 {
            info.hits = info.hits.saturating_add(n);
            if info.hits > self.threshold && !info.queued {
                info.queued = true;
                self.pending.push((key, va));
            } else if info.queued {
                self.pending_steps += info.len as u64 * n as u64;
            }
            self.emit_if_due(t, mem);
        }
        let report = interp::block::REPORT;
        match self.map.get(&key) {
            // The jump cache gets it once the table has installed it ([`Jit::miss`]).
            Some(&Info { idx, len, .. }) if idx != 0 => (Ok((idx, len)), report),
            Some(i) if !i.queued && !self.off => (
                Err(i.len.max(1)),
                report.min(self.threshold.saturating_sub(i.hits)),
            ),
            Some(i) => (Err(i.len.max(1)), report),
            None => (Err(1), 0), // flushed by the emit
        }
    }

    /// Emits the pending batch when it's full, its blocks have run
    /// [`BATCH_STEPS`] interpreted, or it has waited [`BATCH_TIMEOUT`] (by
    /// table `t`'s clock), into `t`.
    fn emit_if_due(&mut self, t: &mut Table, mem: &Mem) {
        if self.pending.is_empty() {
            return;
        }
        if t.since.0 != self.batch {
            t.since = (self.batch, t.clock);
        }
        if self.pending.len() >= self.cfg.batch as usize
            || t.clock - t.since.1 >= BATCH_TIMEOUT
            || self.pending_steps >= BATCH_STEPS
        {
            let regions = self.plan(mem);
            self.batch += 1;
            self.install(t, regions, mem);
        }
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
        self.pending_steps = 0;
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
                    r.tier = Some(0); // its word once it has a slot
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
                        None => {
                            let warm = self.cfg.warm;
                            (all || warm > 0
                                && self.map.get(&k).is_some_and(|i| {
                                    i.idx == 0 && !i.queued && i.len > 0 && i.hits >= warm
                                }))
                                && !heads_loop(&self.region(k, 0, mem))
                        }
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

    /// A loop head compiled alone got hot in table `t` (`jit_hot`, which runs
    /// inside JIT code: never a flush here): compiles its loop region in its
    /// own module, or finds it compiled already (it got hot in another table
    /// first), and points the head's hot word in `t` at it.
    fn tier_up(&mut self, t: &mut Table, key: u64, va: u64, mem: &Mem) {
        if let Some(r) = self.tiers.get(&key) {
            r.quiet.iter().for_each(|&w| t.quiet(w));
            t.redirect(r.word, r.idx, key);
            return;
        }
        let Some(word) = self.map.get(&key).map(|i| i.word).filter(|&w| w != 0) else {
            return;
        };
        // Never a flush here: JIT code is running (the head's prologue), and
        // what it goes on to call must stay in the cache. Without room, the
        // head stays alone until the next flush drops it.
        let r = self.region(key, va, mem);
        if r.blocks.len() < 2 || self.next >= self.cfg.capacity || self.live_bytes >= self.budget()
        {
            return;
        }
        // Members that are loop heads compiled alone stop counting: this
        // region runs their loop now, unless they head an inner loop (an
        // edge back to them leaves the region).
        let quiet: Vec<u32> = r
            .inner_free()
            .into_iter()
            .filter_map(|m| self.map.get(&m).map(|i| i.word).filter(|&w| w != 0))
            .collect();
        quiet.iter().for_each(|&w| t.quiet(w));
        // The pending batch goes along (a module fewer, V8's per-module cost:
        // docs/jit.md "Memory"), the region first so `idx` is its index.
        let mut regions = vec![r];
        if !self.pending.is_empty()
            && self.next + 1 + self.pending.len() as u32 <= self.cfg.capacity
        {
            regions.extend(self.plan(mem));
            self.batch += 1;
        }
        let Some(idx) = self.install(t, regions, mem) else {
            return;
        };
        t.redirect(word, idx, key);
        self.tiers.insert(key, Tier { idx, word, quiet });
        t.stats.tier_ups += 1;
    }

    /// Compiles `regions` into one module and logs it; the table index of its
    /// first function. Table `t` installs it after the lock is released
    /// ([`Jit::install`]: a compile in V8 under the lock would hold up every
    /// vCPU's misses). Counted in `t`.
    fn install(
        &mut self,
        t: &mut Table,
        mut regions: Vec<block::Region>,
        mem: &Mem,
    ) -> Option<u32> {
        let (base, phys) = mem.base();
        let ram = (base as usize, phys, mem.size());
        assert!(
            *self.ram.get_or_insert(ram) == ram,
            "a JIT vCPU runs on one RAM"
        );
        if regions.is_empty() {
            return None;
        }
        let n = regions.len() as u32;
        let slot = self.alloc(n, &mut t.stats);
        t.miss_functions(self, mem);
        let xmiss = self.xmiss.filter(|_| !self.off)?;
        let mut tiers = Vec::new();
        for (k, r) in regions.iter_mut().enumerate() {
            if r.tier.is_some() {
                let w = slot + k as u32;
                r.tier = Some(w);
                tiers.push(w);
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
            &self.cfg,
            true,
            self.features,
            Some(xmiss),
        );
        let len = bytes.len() as u64;
        let seq = self.seq;
        let seq = if compile(&bytes, seq, self.epoch as u32, &self.ready) {
            self.seq = seq.wrapping_add(1).max(1);
            seq
        } else {
            0
        };
        self.log.push(Logged {
            slot,
            n,
            seq,
            bytes,
            tiers,
        });
        let idx = xmiss + slot;
        self.live_bytes += len;
        self.retune();
        self.publish();
        let s = &mut t.stats;
        s.flags_stored += counts.flags_stored;
        s.flags_elided += counts.flags_elided;
        s.cond_direct += counts.cond_direct;
        s.cond_computed += counts.cond_computed;
        s.cond_memory += counts.cond_memory;
        (s.modules, s.blocks, s.bytes) = (s.modules + 1, s.blocks + n as u64, s.bytes + len);
        for (k, ((r, inl), links)) in regions.iter().zip(inl).zip(links).enumerate() {
            let size: u32 = r.blocks.iter().map(|b| b.words.len() as u32).sum();
            let s = &mut t.stats;
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

/// A function table's side of the JIT: a thread's (each vCPU worker's in
/// parallel SMP; round-robin's one, which every vCPU uses). The modules of
/// the shared [`Cache`] it has installed, the jump cache and the hot words
/// its blocks read (through `State::jc` and `State::hot`, so a module's bytes
/// don't depend on the table), the helper calls and its own counts.
pub struct Table {
    /// Its index in `Cache::tables`.
    id: usize,
    /// The cache's (fixed).
    cfg: Config,
    jc: Box<[Jc; JC]>,
    /// The jump-cache entries filled since it was last cleared whole (up to
    /// `JC / 16`; more, and it's cleared whole): JIT-stress flushes every few
    /// compiles, and clearing all 65,536 entries each time was a fifth of an
    /// Alpine boot under it.
    jc_used: Vec<u32>,
    /// One hot word per slot ([`emit::tier_up`]).
    hot: Box<[u32]>,
    /// The cache's epoch its slots hold, how many of that epoch's
    /// modules it has installed, the cache's `drops` when it last caught up,
    /// and whether it has the transfer cache's miss functions (slots 0 and 1).
    epoch: u64,
    installed: usize,
    drops: u64,
    xmiss: bool,
    /// The miss functions' table index (slot 0's), once it has them.
    base: u32,
    /// Modules taken from the log under the lock and not installed yet
    /// ([`Jit::install`]), in order.
    todo: Vec<Todo>,
    /// The table index up to which this epoch's modules are installed: a
    /// block at or past it is interpreted here until it is ([`Jit::miss`]).
    limit: u32,
    /// Tier-up redirects (hot word, region, head) waiting for their region
    /// to be installed ([`Table::redirect`]).
    redirects: Vec<(u32, u32, u64)>,
    /// When the first module of `todo` was found not compiled yet, or not
    /// yet in the host (ns; 0: it wasn't).
    waiting: u64,
    /// The `seq` of the first module of `todo` when the host said it hasn't
    /// received the worker's compiled module yet (0: it didn't): asked again
    /// only after the vCPU has been out of the core ([`Jit::unpark`]), whose
    /// run ends early for it ([`Jit::park_exit`]).
    parked: u32,
    park_exit: bool,
    /// Helper calls by instruction class (step 10: the input to M6), and
    /// the last report of them ([`Table::helper_report`]).
    helper_ops: Vec<u64>,
    report: String,
    /// Steps dispatched so far (the batch timeout's clock), and the cache's
    /// pending batch and this clock when this table first saw it pending.
    clock: u64,
    since: (u64, u64),
    /// What this table's vCPUs ran and what it compiled, flushed and
    /// invalidated (`vm::Counters` sums the tables').
    pub stats: Stats,
    /// The blocks the dispatcher interprets, decoded (`interp::block`), and
    /// the entries of `Cache::ival_log` they have caught up with.
    dec: interp::block::Cache,
    ivals: u64,
}

impl Table {
    /// A new table of cache `c`, which it hasn't caught up with yet.
    fn new(c: &mut Cache) -> Table {
        c.tables.push(Seen {
            ival: c.ival_base + c.ival_log.len() as u64,
            ..Seen::default()
        });
        Table {
            id: c.tables.len() - 1,
            cfg: c.cfg,
            jc: vec![JC_EMPTY; JC]
                .into_boxed_slice()
                .try_into()
                .ok()
                .expect("JC entries"),
            jc_used: Vec::new(),
            hot: vec![0; c.cfg.capacity as usize].into_boxed_slice(),
            epoch: c.epoch,
            installed: 0,
            drops: 0,
            xmiss: false,
            base: 0,
            todo: Vec::new(),
            parked: 0,
            park_exit: false,
            limit: 0,
            redirects: Vec::new(),
            waiting: 0,
            helper_ops: vec![0; crate::decode::Op::ALL.len()],
            report: String::new(),
            clock: 0,
            since: (u64::MAX, 0),
            stats: Stats::default(),
            dec: interp::block::Cache::new(c.cfg.decoded as usize),
            ivals: c.ival_base + c.ival_log.len() as u64,
        }
    }

    /// The transfer cache's miss functions, in slots 0 and 1 (once per table;
    /// two small functions, installed under the lock).
    fn miss_functions(&mut self, c: &mut Cache, mem: &Mem) {
        if self.xmiss || c.off {
            return;
        }
        match install(&block::miss_module(mem, c.cfg.check, c.cfg.pages), 0) {
            Some(i) => {
                let first = *c.xmiss.get_or_insert(i);
                assert_eq!(first, i, "slot 0 is the same table index in every table");
                (self.xmiss, self.base) = (true, i);
            }
            None => c.off = true,
        }
    }

    /// Catches up with cache `c` (under its lock): the miss functions, a new
    /// epoch's slots from the start (a flush: the jump cache is cleared), the
    /// keys dropped since (out of the jump cache), and the modules logged
    /// since, copied into `todo` for [`Jit::install`] to install in order
    /// once the lock is released (each may import the ones before it). Within
    /// an epoch this only adds functions in free slots, so JIT code may be
    /// running (`jit_hot`); across one it replaces them, so only the
    /// dispatcher calls it then.
    fn sync(&mut self, c: &mut Cache, mem: &Mem) {
        self.miss_functions(c, mem);
        let seen = &mut c.tables[self.id];
        if self.epoch != c.epoch || seen.all {
            if self.epoch != c.epoch {
                (self.epoch, self.installed) = (c.epoch, 0);
                (self.limit, self.waiting) = (0, 0);
                self.todo.clear();
                self.redirects.clear();
            }
            self.clear_jc();
        } else {
            for k in seen.dropped.drain(..) {
                let e = &mut self.jc[jc_index(k)];
                if e.key == k {
                    *e = JC_EMPTY;
                }
            }
        }
        (seen.all, seen.dropped) = (false, Vec::new());
        // The decoded blocks of the pages invalidated since (all of them if
        // the log has dropped some this table hadn't seen).
        let end = c.ival_base + c.ival_log.len() as u64;
        if seen.ival < c.ival_base {
            self.dec.clear();
        } else {
            for &p in c.ival_log.range((seen.ival - c.ival_base) as usize..) {
                if p == u64::MAX {
                    self.dec.clear();
                } else {
                    self.dec.drop_page(p);
                }
            }
        }
        seen.ival = end;
        self.ivals = end;
        let oldest = c.tables.iter().map(|t| t.ival).min().unwrap_or(end);
        while c.ival_base < oldest {
            c.ival_log.pop_front();
            c.ival_base += 1;
        }
        if self.xmiss {
            for l in &c.log[self.installed..] {
                self.todo.push(Todo {
                    slot: l.slot,
                    n: l.n,
                    seq: l.seq,
                    bytes: l.bytes.clone(),
                    tiers: l.tiers.clone(),
                });
            }
            self.installed = c.log.len();
        }
        c.tables[self.id].installed = self.installed;
        // The modules every table has taken: their bytes aren't needed again.
        let all = c.tables.iter().map(|t| t.installed).min().unwrap_or(0);
        for l in c.log.get_mut(c.freed..all).into_iter().flatten() {
            l.bytes = Vec::new();
        }
        c.freed = c.freed.max(all);
        self.drops = c.drops.load(Ordering::Relaxed);
    }

    /// Installs the modules of `todo` that the compile worker has compiled
    /// (`ready`: up to which), in order (after [`Table::sync`], without the
    /// lock), and the tier-up redirects they complete. One it hasn't, after
    /// [`OVERDUE_NS`], installs anyway (it compiles here).
    fn install(&mut self, ready: u32) {
        let ns = now_ns();
        let mut k = self
            .todo
            .iter()
            .take_while(|m| reached(ready, m.seq))
            .count();
        let parked = self.parked != 0 && self.todo.first().is_some_and(|m| m.seq == self.parked);
        let mut overdue = false;
        if k < self.todo.len() || parked {
            if self.waiting == 0 {
                self.waiting = ns.max(1);
            } else if ns.saturating_sub(self.waiting) >= OVERDUE_NS {
                (k, overdue) = (self.todo.len(), true);
            }
        }
        if k == 0 || parked && !overdue {
            return;
        }
        let mut done = 0;
        for m in &self.todo[..k] {
            // The host takes the worker's compiled module, or compiles the
            // bytes itself (seq 0: no worker, or waited too long).
            let at = match install_seq(&m.bytes, m.slot, if overdue { 0 } else { m.seq }) {
                Err(NotYet) => {
                    self.parked = m.seq;
                    self.park_exit = true;
                    self.stats.parks += 1;
                    break;
                }
                Ok(at) => at,
            };
            if m.seq != 0 {
                if reached(ready, m.seq) && !overdue {
                    self.stats.worker_installs += 1;
                } else {
                    self.stats.overdue += 1;
                }
            }
            assert_eq!(
                at,
                Some(self.base + m.slot),
                "a module's slots are the same in every table"
            );
            for &w in &m.tiers {
                self.hot[w as usize] = self.cfg.region_after;
            }
            self.limit = self.base + m.slot + m.n;
            done += 1;
        }
        self.todo.drain(..done);
        if done == k {
            self.waiting = 0;
        }
        if done > 0 {
            self.redirected();
        }
        self.stats.compile_ns += now_ns() - ns;
    }

    /// Applies the waiting redirects whose regions are installed now.
    fn redirected(&mut self) {
        let (limit, mut redirects) = (self.limit, core::mem::take(&mut self.redirects));
        redirects.retain(|&(word, idx, key)| {
            if idx < limit {
                self.hot[word as usize - 1] = emit::REDIRECT | idx;
                self.repoint(key, idx);
            }
            idx >= limit
        });
        self.redirects = redirects;
    }

    /// Hot word `word - 1` redirects to the region at `idx` (a tier-up of
    /// head `key`), and the jump cache's entry for the head with it, once
    /// this table has installed the region.
    fn redirect(&mut self, word: u32, idx: u32, key: u64) {
        if idx < self.limit {
            self.hot[word as usize - 1] = emit::REDIRECT | idx;
            self.repoint(key, idx);
        } else {
            self.redirects.push((word, idx, key));
        }
    }

    fn clear_jc(&mut self) {
        if self.jc_used.len() < JC / 16 {
            for &i in &self.jc_used {
                self.jc[i as usize] = JC_EMPTY;
            }
        } else {
            self.jc.fill(JC_EMPTY);
        }
        self.jc_used.clear();
    }

    /// Puts a compiled block in the jump cache.
    fn fill(&mut self, key: u64, idx: u32, len: u32) {
        self.jc[jc_index(key)] = Jc { key, idx, len };
        if self.jc_used.len() < JC / 16 {
            self.jc_used.push(jc_index(key) as u32);
        }
    }

    /// The block at `key` is the function at `idx` now (a tier-up), if the
    /// jump cache has it.
    fn repoint(&mut self, key: u64, idx: u32) {
        let j = &mut self.jc[jc_index(key)];
        if j.key == key {
            j.idx = idx;
        }
    }

    /// Hot word `word - 1` stops counting (its head's loop is in a region
    /// now), unless it redirects already: its region stays.
    fn quiet(&mut self, word: u32) {
        let h = &mut self.hot[word as usize - 1];
        if *h & emit::REDIRECT == 0 {
            *h = 0;
        }
    }

    /// The jump cache and the hot words, for `State::jc` and `State::hot`.
    fn ptrs(&mut self) -> (*mut Jc, *mut u32) {
        (self.jc.as_mut_ptr(), self.hot.as_mut_ptr())
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
}

/// A vCPU's JIT (`State::cache`): a table and the cache it shares. A VM has
/// one cache; round-robin SMP has one table, which moves between its vCPUs
/// with this, and parallel SMP a table per vCPU ([`Jit::join`]).
pub struct Jit {
    pub table: Table,
    cache: Arc<Lock<Cache>>,
    /// The cache's `drops`, `ivals` and `ready`, read without its lock.
    drops: Arc<AtomicU64>,
    ivals: Arc<AtomicU64>,
    ready: Arc<AtomicU32>,
    gauge: Arc<Gauge>,
}

impl Jit {
    pub fn new(cache: Cache) -> Jit {
        let (drops, ivals, ready) = (
            cache.drops.clone(),
            cache.ivals.clone(),
            cache.ready.clone(),
        );
        let gauge = cache.gauge.clone();
        let cache = Arc::new(Lock::new(cache));
        let table = Table::new(&mut cache.lock());
        Jit {
            table,
            cache,
            drops,
            ivals,
            ready,
            gauge,
        }
    }

    /// The cache's [`Gauge`]: its words, read without the lock.
    pub fn gauge(&self) -> *const u64 {
        self.gauge.0.as_ptr() as *const u64
    }

    /// The code cache's byte budget (`Config::max_bytes`).
    pub fn max_bytes(&self) -> u64 {
        self.cache.lock().cfg.max_bytes
    }

    /// Another table on the same cache (another thread's).
    pub fn join(&self) -> Jit {
        Jit {
            table: Table::new(&mut self.cache.lock()),
            cache: self.cache.clone(),
            drops: self.drops.clone(),
            ivals: self.ivals.clone(),
            ready: self.ready.clone(),
            gauge: self.gauge.clone(),
        }
    }

    /// The compiled block for `key` as (table index, length), or else how many
    /// instructions to interpret: the would-be block's length, so the next
    /// lookup is at a block start again (0: its decoded block, which counted
    /// this dispatch; the cache hears of it later).
    #[inline(always)]
    fn enter(&mut self, key: u64, va: u64, mem: &Mem) -> Result<(u32, u32), u32> {
        let j = self.table.jc[jc_index(key)];
        if j.key == key {
            return Ok((j.idx, j.len));
        }
        if self.table.dec.count(key) {
            return Err(0);
        }
        self.miss(key, va, mem)
    }

    #[inline(never)]
    fn miss(&mut self, key: u64, va: u64, mem: &Mem) -> Result<(u32, u32), u32> {
        // A block new to this table is decoded now, outside the lock, and its
        // length spares the cache forming it (only a block decoded now: one
        // decoded earlier may be from words an IC has dropped since).
        let len = self.table.dec.decode(key, mem);
        let mut c = self.cache.lock();
        // The table catches up after the miss, which may have compiled (or
        // flushed): an entry it fills now and a catch-up then clears is only
        // a later miss. What it returns is installed before any block runs.
        let n = self.table.dec.counted(key) + 1;
        let (r, quota) = c.miss(&mut self.table, key, va, mem, n, len);
        self.table.dec.quota(key, quota);
        self.table.sync(&mut c, mem);
        drop(c);
        self.install();
        match r {
            Ok((idx, len)) if idx < self.table.limit => {
                self.table.fill(key, idx, len);
                Ok((idx, len))
            }
            // Compiled, and not installed here yet: interpreted meanwhile.
            Ok((_, len)) => Err(len.max(1)),
            Err(n) => Err(n),
        }
    }

    /// The vCPU has been out of the core (its host's event loop may have
    /// delivered the module the table is parked on): asks the host again.
    pub fn unpark(&mut self) {
        self.table.parked = 0;
    }

    /// Whether the table parked on a module since this last said so: the
    /// run returns to the host, which goes through its event loop
    /// (`web/vcpu-worker.ts`), where the worker's compiled module arrives.
    pub fn park_exit(&mut self) -> bool {
        let p = core::mem::take(&mut self.table.park_exit);
        self.table.stats.park_exits += p as u64;
        p
    }

    /// Installs what the table took from the log and the compile worker
    /// has compiled, outside the lock.
    fn install(&mut self) {
        if !self.table.todo.is_empty() {
            self.table.install(self.ready.load(Ordering::Acquire));
        }
    }

    /// Catches up with the cache if it dropped blocks or an IC invalidated
    /// a page since (before a block runs, from the dispatcher only:
    /// [`Table::sync`]).
    #[inline(always)]
    fn fresh(&mut self, mem: &Mem) {
        if self.drops.load(Ordering::Relaxed) != self.table.drops
            || self.ivals.load(Ordering::Relaxed) != self.table.ivals
        {
            self.sync(mem);
        } else if let Some(m) = self.table.todo.first()
            && reached(self.ready.load(Ordering::Acquire), m.seq)
        {
            self.install();
        }
    }

    #[inline(never)]
    fn sync(&mut self, mem: &Mem) {
        let mut c = self.cache.lock();
        self.table.sync(&mut c, mem);
        drop(c);
        self.install();
    }

    /// [`Cache::invalidate`].
    pub fn invalidate(&mut self, pa: u64) {
        self.cache.lock().invalidate(pa, &mut self.table.stats);
    }

    /// [`Cache::flush`], and this table's decoded blocks too (the code
    /// changed: `jit_flush`).
    pub fn flush(&mut self) {
        self.cache.lock().flush(&mut self.table.stats);
        self.table.dec.clear();
    }

    fn check(&mut self, key: u64, mem: &Mem) -> bool {
        self.cache.lock().check(key, mem, &mut self.table.stats)
    }

    /// [`Cache::tier_up`], unless this table's slots are an epoch behind
    /// (the cache flushed since its vCPU entered JIT code): the head stays
    /// alone until the next.
    fn tier_up(&mut self, key: u64, va: u64, mem: &Mem) {
        let mut c = self.cache.lock();
        if self.table.epoch != c.epoch {
            return;
        }
        // The hot words it sets are read only when this returns, by then
        // with their region installed.
        c.tier_up(&mut self.table, key, va, mem);
        self.table.sync(&mut c, mem);
        drop(c);
        self.install();
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
/// `v` has a JIT (`jit.cache`).
///
/// # Safety
/// `v` is valid and nothing else references it while this runs.
pub unsafe fn steps(v: *mut Vcpu, mem: &Mem, n: u64) -> (u64, Option<Exit>) {
    // SAFETY: guaranteed by the caller.
    let vr = unsafe { &mut *v };
    let jit = vr.jit.cache.as_deref_mut().expect("a JIT vCPU");
    (vr.jit.jc, vr.jit.hot) = jit.table.ptrs();
    let mut done = 0;
    while done < n {
        let left = n - done;
        // SAFETY: guaranteed by the caller; the reference ends before a block runs.
        let vr = unsafe { &mut *v };
        vr.jit.mem = mem;
        let (pc, key) = (vr.cpu.pc, key(vr, mem));
        let jit = vr.jit.cache.as_deref_mut().expect("a JIT vCPU");
        jit.fresh(mem);
        let r = key.map_or(Err(1), |k| jit.enter(k, pc, mem));
        if vr.tlb.xdrops != jit.table.drops {
            vr.tlb.xdrops = jit.table.drops;
            vr.tlb.bump();
        }
        if let Ok((idx, len)) = r
            && len as u64 <= left
        {
            let key = key.expect("compiled");
            if jit.table.cfg.check && !jit.check(key, mem) {
                // Tolerated (parallel SMP): drop it and compile the code as it is now.
                jit.invalidate(key & !0xfff);
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
            let jit = vr.jit.cache.as_deref_mut().expect("a JIT vCPU");
            let e = vr.jit.exit.take();
            let s = &mut jit.table.stats;
            let ran = k + e.is_some_and(Exit::retired) as u64;
            s.dispatches += 1;
            s.steps += ran;
            s.inline_steps += ran - (vr.jit.helper_steps - helped);
            jit.table.clock += k;
            done += k;
            if e.is_some() {
                return (done, e);
            }
        } else {
            let m = match r {
                Ok((_, len)) | Err(len) => len.max(1) as u64,
            };
            let crate::mmu::Vcpu { cpu, tlb, .. } = vr;
            let t = &mut jit.table;
            // The block decoded and the ones after it (`interp::block`);
            // without one (no key, or no instructions there), one instruction
            // at a time.
            let r = match key {
                Some(k) if k & block::KEY_MMU != 0 => {
                    interpret(cpu, &mut Mmu::new(mem, Some(&mut *tlb)), t, mem, k, left)
                }
                Some(k) => interpret(cpu, &mut Flat(mem), t, mem, k, left),
                None => None,
            };
            let (k, e) = r.unwrap_or_else(|| interp::steps(cpu, mem, Some(tlb), m.min(left)));
            t.clock += k;
            done += k;
            if e.is_some() {
                return (done, e);
            }
        }
    }
    (n, None)
}

/// The bus a run of decoded blocks goes through, and how it finds the key of
/// the block at a PC (as [`key`] does; `None`: the dispatcher's to find).
trait Regime: crate::mmu::Bus {
    fn key(&mut self, c: &crate::cpu::Cpu, pc: u64) -> Option<u64>;
}

impl Regime for Flat<'_> {
    #[inline(always)]
    fn key(&mut self, c: &crate::cpu::Cpu, pc: u64) -> Option<u64> {
        (pc & 3 == 0).then_some(pc | c.el() & 1)
    }
}

impl Regime for Mmu<'_> {
    #[inline(always)]
    fn key(&mut self, c: &crate::cpu::Cpu, pc: u64) -> Option<u64> {
        if pc & 3 != 0 {
            return None;
        }
        let p = self.fetch_ptr(c, pc).ok()?;
        Some(self.mem.pa(p) | c.el() & 1 | block::KEY_MMU)
    }
}

/// Runs the decoded block at `key` (its dispatch counted: [`Jit::enter`]),
/// at the PC, and then the blocks after it for as long as each is decoded
/// already, counts its dispatch without reporting it, isn't compiled, and the
/// one before it ended on a branch or ran out (not on an instruction run
/// generically, which may have changed the regime), within `left` steps.
/// Returns what [`interp::steps`] would for those steps; `None` if the first
/// block would have no instructions. Blocks in another page are found through
/// the instruction TLB, as the dispatcher finds them; a block in the same page
/// as the one before has the same translation (a block ends after any
/// instruction that could change it).
#[inline(never)]
fn interpret<B: Regime>(
    cpu: &mut crate::cpu::Cpu,
    m: &mut B,
    t: &mut Table,
    mem: &Mem,
    mut key: u64,
    left: u64,
) -> Option<(u64, Option<Exit>)> {
    let mut done = 0;
    let r = loop {
        let pc = cpu.pc;
        let Some(b) = t.dec.get(key, mem) else {
            if done == 0 {
                return None;
            }
            break (done, None);
        };
        let b = &b[..b.len().min((left - done) as usize)];
        let chains = b.last().is_some_and(interp::block::Uop::chains);
        let (k, e) = interp::block::run(cpu, m, b, pc);
        t.stats.dec_steps += k + e.is_some_and(Exit::retired) as u64;
        done += k;
        if e.is_some() || done >= left || !chains {
            break (done, e);
        }
        let next = cpu.pc;
        key = if (next ^ pc) < 0x1000 && next & 3 == 0 {
            key & !0xfff | next & 0xffc | key & 3
        } else {
            match m.key(cpu, next) {
                Some(k) => k,
                None => break (done, None),
            }
        };
        if t.jc[jc_index(key)].key == key || !t.dec.count(key) {
            break (done, None);
        }
    };
    (t.stats.decoded, t.stats.dec_clears) = (t.dec.decoded, t.dec.clears);
    Some(r)
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
    if let Some(j) = j.cache.as_deref_mut() {
        j.table.helper_ops[crate::decode::decode(insn) as usize] += 1;
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
    v.jit
        .cache
        .as_deref_mut()
        .expect("a JIT vCPU")
        .tier_up(key, pc, mem);
}

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    /// Compiles and instantiates the module at `ptr..ptr + len` and puts its
    /// exports `f0`, `f1`, … into the core's table from JIT slot `slot` on.
    /// Returns the table index of `f0`, or -1 if the host has no JIT.
    fn jit_install(ptr: *const u8, len: usize, slot: u32, seq: u32) -> i32;
    /// Hands the module at `ptr..ptr + len` to the host's compile worker as
    /// number `seq` of epoch `epoch`; the worker stores into the u32 at
    /// `ready` the number up to which it has compiled every module. Returns
    /// 0 if the host has no compile worker.
    fn jit_compile(
        ptr: *const u8,
        len: usize,
        seq: u32,
        epoch: u32,
        ready: *const AtomicU32,
    ) -> i32;
}

/// [`jit_compile`]: whether the host's compile worker took `module`.
fn compile(module: &[u8], seq: u32, epoch: u32, ready: &AtomicU32) -> bool {
    #[cfg(target_arch = "wasm32")]
    // SAFETY: the host reads `module` and later writes `ready` (atomically),
    // which the cache keeps alive (an `Arc`) for as long as any table.
    return unsafe { jit_compile(module.as_ptr(), module.len(), seq, epoch, ready) } != 0;
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = (module, seq, epoch, ready);
        false
    }
}

/// Whether a module numbered `seq` is compiled when the worker has done
/// all up to `ready` (0: no worker took it).
fn reached(ready: u32, seq: u32) -> bool {
    seq == 0 || ready.wrapping_sub(seq) as i32 >= 0
}

/// A module of the log that a table takes ([`Table::sync`]) and installs.
struct Todo {
    slot: u32,
    n: u32,
    seq: u32,
    bytes: Vec<u8>,
    /// The hot words of its loop heads compiled alone.
    tiers: Vec<u32>,
}

/// How long a table waits for the compile worker before it compiles a
/// module itself (a backstop: the worker takes milliseconds).
pub const OVERDUE_NS: u64 = 1_000_000_000;

/// Installs `module`'s functions at JIT table slots `slot..`; returns
/// function `f0`'s table index, or `None` without a JIT host.
pub fn install(module: &[u8], slot: u32) -> Option<u32> {
    install_seq(module, slot, 0).unwrap_or(None)
}

/// The host hasn't received the compile worker's copy of module `seq` yet.
#[derive(Debug)]
pub struct NotYet;

/// [`install`] of the module the compile worker compiled as number `seq`
/// (0: compile `module` here): the host instantiates the worker's compiled
/// module, which it receives through its event loop, without compiling or
/// even validating the bytes again; [`NotYet`] if it hasn't received it.
pub fn install_seq(module: &[u8], slot: u32, seq: u32) -> Result<Option<u32>, NotYet> {
    #[cfg(target_arch = "wasm32")]
    // SAFETY: the host reads `module` and touches only its own table.
    let i = unsafe { jit_install(module.as_ptr(), module.len(), slot, seq) };
    #[cfg(not(target_arch = "wasm32"))]
    let i = {
        let _ = (module, slot, seq);
        -1
    };
    match i {
        -2 => Err(NotYet),
        i => Ok((i >= 0).then_some(i as u32)),
    }
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
            threshold_max: 0,
            batch: 4,
            capacity: 10,
            max_bytes: 1000,
            check: false,
            region_after: 0,
            pages: 0,
            decoded: 0,
            warm: 0,
        });
        let s = &mut Stats::default();
        c.map.insert(0x100, Info::default());
        // After the miss functions' slots.
        assert_eq!((c.alloc(4, s), c.alloc(4, s)), (2, 6));
        assert_eq!((s.flushes, c.epoch), (0, 0));
        assert_eq!(c.alloc(3, s), 2); // 10 + 3 > 10: flushed, from slot 2 again
        assert_eq!((s.flushes, c.epoch), (1, 1));
        assert!(c.map.is_empty());
        assert_eq!((c.alloc(4, s), c.alloc(1, s)), (5, 9));
        assert_eq!(s.flushes, 1);
        c.flush(s);
        assert_eq!((c.alloc(1, s), s.flushes), (2, 2));
        // The byte budget flushes too, at the next slots after the modules' bytes reach it.
        c.live_bytes = 999;
        assert_eq!((c.alloc(1, s), s.flushes), (3, 2));
        c.live_bytes = 1000;
        assert_eq!((c.alloc(1, s), s.flushes), (2, 3));
        assert_eq!(c.live_bytes, 0);
    }

    /// The gauge follows the cache (ABI 45), and the host's limit lowers the
    /// budget (never under `MIN_LIMIT`, never over the configured one).
    #[test]
    fn the_gauge_and_the_hosts_limit() {
        let mut c = Cache::new(Config {
            batch: 4,
            capacity: 100,
            max_bytes: 64 << 20,
            ..Config::DEFAULT
        });
        let s = &mut Stats::default();
        let g = |c: &Cache, w: usize| c.gauge.0[w].load(Ordering::Relaxed);
        assert_eq!((g(&c, G_BUDGET), g(&c, G_LIVE_BYTES)), (64 << 20, 0));
        for (limit, budget) in [
            (0, 64 << 20),
            (20 << 20, 20 << 20),
            (1, MIN_LIMIT),
            (100 << 20, 64 << 20),
        ] {
            c.gauge.0[G_LIMIT].store(limit, Ordering::Relaxed);
            assert_eq!(c.budget(), budget, "limit {limit}");
        }
        // At the limit the next slots flush, and the gauge says so.
        c.gauge.0[G_LIMIT].store(20 << 20, Ordering::Relaxed);
        c.live_bytes = (20 << 20) - 1;
        assert_eq!((c.alloc(1, s), s.flushes), (MISS_SLOTS, 0));
        c.live_bytes = 20 << 20;
        c.alloc(1, s);
        assert_eq!(
            (
                s.flushes,
                g(&c, G_EPOCHS),
                g(&c, G_BUDGET),
                g(&c, G_LIVE_BYTES)
            ),
            (1, 1, 20 << 20, 0)
        );
    }

    /// The threshold rises with the live modules' bytes past the knee, and
    /// its floor with each flush; a fixed one stays.
    #[test]
    fn the_threshold_follows_the_pressure() {
        let mut c = Cache::new(Config {
            max_bytes: 800,
            ..Config::DEFAULT
        });
        let s = &mut Stats::default();
        let at = |c: &mut Cache, live| {
            c.live_bytes = live;
            c.retune();
            c.threshold
        };
        let want = [50, 50, 50, 100, 200, 400, 800, 1000, 1000];
        for (e, w) in want.into_iter().enumerate() {
            assert_eq!(at(&mut c, e as u64 * 100 + 99), w, "{e} eighths");
        }
        c.flush(s);
        assert_eq!((c.threshold, at(&mut c, 300)), (100, 200));
        (0..5).for_each(|_| c.flush(s));
        assert_eq!((c.threshold, at(&mut c, 300)), (1000, 1000));
        for t in [0, 500, u32::MAX] {
            let mut c = Cache::new(Config {
                threshold: t,
                threshold_max: t,
                max_bytes: 800,
                ..Config::DEFAULT
            });
            c.flush(s);
            assert_eq!(at(&mut c, 799), t);
        }
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
        let mut c = Cache::new(Config {
            warm: 0,
            ..Config::DEFAULT
        });
        // Every block was dispatched and is pending, but 0x118 (not queued).
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

    /// A successor that has run `warm` dispatches but isn't in the batch is
    /// taken as a member; one that ran fewer, a loop head and a compiled
    /// block aren't.
    #[test]
    fn a_forward_region_takes_a_warm_successor() {
        let mut ram = vec![0u128; 0x1000 / 16];
        // SAFETY: `ram` outlives `mem` and is 16-byte aligned.
        let mem = unsafe { Mem::new(ram.as_mut_ptr().cast(), 0x1000) };
        // 0x100: cbz x1, 0x10c
        // 0x104: add x2, x2, #1; b 0x114
        // 0x10c: add x2, x2, #2; ret
        // 0x114: subs x6, x6, #1; b.ne 0x114 (a loop of one); ret
        #[rustfmt::skip]
        let words = [
            0xb4000061u32, 0x91000442, 0x14000003, 0x91000842, 0xd65f03c0, 0xf10004c6, 0x54ffffe1, 0xd65f03c0,
        ];
        for (k, w) in words.into_iter().enumerate() {
            mem.write(0x100 + 4 * k as u64, 4, w as u64).unwrap();
        }
        let plan = |hits: [u32; 3], idx10c: u32| {
            let mut c = Cache::new(Config::DEFAULT);
            let i = c.info(0x100, || 1);
            (i.hits, i.queued) = (51, true);
            c.pending.push((0x100, 0x100));
            for (k, h) in [0x104, 0x10c, 0x114].into_iter().zip(hits) {
                let i = c.info(k, || 1);
                i.hits = h;
                if k == 0x10c {
                    i.idx = idx10c;
                }
            }
            let r = c.plan(&mem);
            let keys: Vec<u64> = r[0].blocks.iter().map(|b| b.key).collect();
            (keys, c.map[&0x104].hits, c.map[&0x104].queued)
        };
        assert_eq!(plan([WARM - 1, WARM - 1, WARM], 0).0, [0x100]);
        // 0x114 heads a loop: never a member.
        assert_eq!(
            plan([WARM, WARM, WARM], 0),
            (vec![0x100, 0x104, 0x10c], 0, false)
        );
        assert_eq!(plan([WARM, WARM, WARM], 7).0, [0x100, 0x104]);
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
        v.jit.cache = Some(Box::new(Jit::new(Cache::new(Config::STRESS))));
        let want = interp::run(&mut c, &mem, 1000);
        let got = unsafe { run(&mut *v, &mem, 1000) };
        assert_eq!((got, &v.cpu), (want, &c));
        assert_eq!(want, (301, Err(Exit::Brk(0))));
        let cache = v.jit.cache.as_deref().unwrap().cache.lock();
        assert!(cache.off && cache.map.len() == 3); // mov, the loop, brk
    }

    /// Invalidation drops the blocks from the cache at once, and from each
    /// table's jump cache when that table catches up.
    #[test]
    fn invalidation_by_page_and_all() {
        let mut ram = vec![0u128; 0x1000 / 16];
        // SAFETY: `ram` outlives `mem` and is 16-byte aligned.
        let mem = unsafe { Mem::new(ram.as_mut_ptr().cast(), 0x1000) };
        let mut c = Cache::new(Config::DEFAULT);
        let (mut t, mut u) = (Table::new(&mut c), Table::new(&mut c));
        let s = &mut Stats::default();
        for k in [0x1000, 0x1ff8 | block::KEY_EL1, 0x2000, 0x3000, 0x4000] {
            c.info(k, || 1).idx = 7;
            t.fill(k, 7, 1);
            u.fill(k, 7, 1);
        }
        // 0x3000 chains to 0x1000, and 0x4000 to 0x3000: both go with page 1.
        c.linkers.insert(0x1000, vec![0x3000]);
        c.linkers.insert(0x3000, vec![0x4000]);
        c.info(0x1004, || 1).queued = true;
        c.pending.push((0x1004, 0));
        let drops = c.drops.load(Ordering::Relaxed);
        c.invalidate(0x1ab0, s); // IC IVAU on page 1
        assert_eq!(c.map.keys().copied().collect::<Vec<_>>(), [0x2000]);
        assert!(c.linkers.is_empty() && c.drops.load(Ordering::Relaxed) == drops + 1);
        assert_eq!(c.pending, []);
        assert_eq!(s.invalidations, 1);
        // A table drops the keys when it catches up.
        let jc = |t: &Table, k: u64| t.jc[jc_index(k)].key;
        assert_eq!(jc(&t, 0x1000), 0x1000);
        t.sync(&mut c, &mem);
        assert!(
            jc(&t, 0x1000) == u64::MAX && jc(&t, 0x4000) == u64::MAX && jc(&t, 0x2000) == 0x2000
        );
        assert_eq!(t.drops, drops + 1);
        c.invalidate(0x5000, s); // no code there
        assert_eq!(s.invalidations, 1);
        c.invalidate(u64::MAX, s); // IC IALLU: a new epoch
        assert!(c.map.is_empty() && c.pages.is_empty());
        assert_eq!((s.invalidations, s.flushes), (2, 0));
        u.sync(&mut c, &mem);
        assert!(jc(&u, 0x1000) == u64::MAX && jc(&u, 0x2000) == u64::MAX && u.epoch == c.epoch);
    }

    /// Decoded blocks go when an IC names their page, in every table and
    /// after a flush too (the cache then has no keys there), and not with the
    /// compiled blocks that linked to a dropped one.
    #[test]
    fn decoded_blocks_go_with_their_page() {
        let mut ram = vec![0u128; 0x4000 / 16];
        // SAFETY: `ram` outlives `mem` and is 16-byte aligned.
        let mem = unsafe { Mem::new(ram.as_mut_ptr().cast(), 0x4000) };
        for pa in [0x1000, 0x2000] {
            mem.write(pa, 4, 0x9100_0400).unwrap(); // add x0, x0, #1
            mem.write(pa + 4, 4, 0xd65f_03c0).unwrap(); // ret
        }
        let mut c = Cache::new(Config::DEFAULT);
        let (mut t, mut u) = (Table::new(&mut c), Table::new(&mut c));
        let s = &mut Stats::default();
        for x in [&mut t, &mut u] {
            for k in [0x1000, 0x2000] {
                assert_eq!(x.dec.get(k, &mem).map(<[_]>::len), Some(2));
            }
        }
        // Compiled 0x2000 links to compiled 0x1000: an IC on page 1 drops both
        // compiled blocks, and only page 1's decoded one.
        c.info(0x1000, || 2).idx = 7;
        c.info(0x2000, || 2).idx = 8;
        c.linkers.insert(0x1000, vec![0x2000]);
        c.invalidate(0x1040, s);
        assert!(c.map.is_empty());
        t.sync(&mut c, &mem);
        assert!(!t.dec.has(0x1000) && t.dec.has(0x2000));
        assert!(u.dec.has(0x1000), "until it catches up");
        // After a flush the cache knows no keys on page 2; the IC still reaches the tables.
        c.flush(s);
        c.invalidate(0x2000, s);
        for x in [&mut t, &mut u] {
            x.sync(&mut c, &mem);
            assert!(!x.dec.has(0x1000) && !x.dec.has(0x2000));
        }
        assert!(c.ival_log.is_empty(), "both tables have seen it all");
        // A table that missed entries the log dropped starts over.
        t.dec.get(0x1000, &mem);
        for _ in 0..=IVAL_LOG {
            c.invalidate(0x3000, s);
        }
        t.sync(&mut c, &mem);
        assert!(!t.dec.has(0x1000));
        assert_eq!(t.dec.clears, 1);
    }

    /// A decoded block counts dispatches locally and reports them, but the
    /// dispatch that reaches the threshold reports itself: the block joins
    /// the batch at the same dispatch as when every dispatch reported.
    #[test]
    fn a_decoded_block_reports_at_the_threshold() {
        let mut ram = vec![0u128; 0x2000 / 16];
        // SAFETY: `ram` outlives `mem` and is 16-byte aligned.
        let mem = unsafe { Mem::new(ram.as_mut_ptr().cast(), 0x2000) };
        mem.write(0x1000, 4, 0x9100_0400).unwrap(); // add x0, x0, #1
        mem.write(0x1004, 4, 0xd65f_03c0).unwrap(); // ret
        let mut c = Cache::new(Config {
            threshold: 50,
            threshold_max: 50,
            ..Config::DEFAULT
        });
        let mut t = Table::new(&mut c);
        let (key, mut reports) = (0x1000, 0);
        for d in 1..=200 {
            if t.dec.count(key) {
                continue;
            }
            // Jit::miss, without the lock.
            let len = t.dec.decode(key, &mem);
            let n = t.dec.counted(key) + 1;
            let (r, quota) = c.miss(&mut t, key, 0, &mem, n, len);
            t.dec.quota(key, quota);
            assert_eq!(r, Err(2));
            reports += 1;
            let i = c.map[&key];
            assert_eq!(i.hits, d, "every dispatch counted");
            assert_eq!(i.queued, d > 50, "queued at dispatch 51, not {d}");
        }
        assert!(reports < 200 / 8, "{reports} reports for 200 dispatches");
    }

    /// A member's hot word stops counting when an enclosing region is
    /// compiled, but one that redirects keeps its region: another table may
    /// replay the enclosing tier-up after its own member tiered up.
    #[test]
    fn a_quieted_hot_word_keeps_its_redirect() {
        let mut c = Cache::new(Config::DEFAULT);
        let mut t = Table::new(&mut c);
        (t.hot[3], t.hot[4]) = (37, emit::REDIRECT | 9);
        t.quiet(4);
        t.quiet(5);
        assert_eq!((t.hot[3], t.hot[4]), (0, emit::REDIRECT | 9));
    }

    /// A tier-up's redirect waits for its region in a table that hasn't
    /// installed it (the compile worker: docs/jit.md "Sharing"), and its
    /// jump-cache entry with it.
    #[test]
    fn a_redirect_waits_for_its_region() {
        let mut c = Cache::new(Config::DEFAULT);
        let mut t = Table::new(&mut c);
        let key = 0x1000;
        t.fill(key, 5, 2);
        t.limit = 10;
        t.redirect(4, 12, key);
        assert_eq!(
            (t.hot[3], t.jc[jc_index(key)].idx),
            (0, 5),
            "not installed yet"
        );
        t.redirect(6, 8, 0x2000);
        assert_eq!(t.hot[5], emit::REDIRECT | 8, "installed: at once");
        t.limit = 13;
        t.redirected();
        assert_eq!(
            (t.hot[3], t.jc[jc_index(key)].idx),
            (emit::REDIRECT | 12, 12)
        );
        assert!(t.redirects.is_empty());
    }

    /// Module numbers wrap (u32), and 0 is a module the worker didn't take.
    #[test]
    fn the_ready_word_compares_with_wrapping() {
        assert!(reached(0, 0) && reached(5, 5) && reached(5, 1));
        assert!(!reached(5, 6) && !reached(0, 1));
        assert!(reached(3, u32::MAX) && !reached(u32::MAX, 3));
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
