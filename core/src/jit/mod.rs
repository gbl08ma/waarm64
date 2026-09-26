//! Tier-1 JIT: guest A64 blocks → WebAssembly (PLAN.md §7 M5).
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
/// steps (PLAN.md §2 "JIT ABI"): if fewer than all their instructions retired,
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
    /// The key a block passes to its module's static probe (`emit::probe_static`).
    pub probe_key: u64,
    pub cache: Option<Box<Cache>>,
}

/// Compile policy (the knobs PLAN.md §2 "JIT ABI" names).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Config {
    /// Dispatches of a block key before it joins the pending batch (0: on first sight).
    pub threshold: u32,
    /// Blocks per module.
    pub batch: u32,
    /// Code cache size in blocks (= table slots); everything is flushed when it's full.
    pub capacity: u32,
    /// The stale-code checker: hash each block's words when it's compiled and
    /// again at every entry, and panic on a mismatch (code changed without an
    /// `IC` invalidating it).
    pub check: bool,
}

impl Config {
    pub const DEFAULT: Config = Config {
        threshold: 50,
        batch: 32,
        capacity: 65536,
        check: false,
    };
    /// Compile everything on first sight, one block per module, and flush constantly.
    pub const STRESS: Config = Config {
        threshold: 0,
        batch: 1,
        capacity: 4,
        check: true,
    };
}

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

/// Steps after the first block joins a pending batch before it's emitted
/// anyway, so a lone hot block doesn't wait for a full batch.
pub const BATCH_TIMEOUT: u64 = 100_000;

/// The block cache, the pending batch and the code cache's slot allocator.
pub struct Cache {
    pub cfg: Config,
    map: Map<Info>,
    /// The keys in `map` by physical page, for `IC IVAU`.
    pages: Map<Vec<u64>>,
    /// The compiled blocks that chain to a key (step 7), dropped with it.
    linkers: Map<Vec<u64>>,
    jc: Box<[Jc; JC]>,
    /// (key, VA) of blocks waiting to be compiled.
    pending: Vec<(u64, u64)>,
    /// `clock` when the first pending block was queued.
    since: u64,
    /// Steps dispatched so far (the batch timeout's clock).
    clock: u64,
    /// The next free slot.
    next: u32,
    /// No JIT host (natively, or before `jit.bind`): interpret everything.
    off: bool,
    /// The RAM the blocks were compiled for (flat blocks embed its layout).
    ram: Option<(usize, u64, u64)>,
    pub stats: Stats,
}

impl Cache {
    pub fn new(cfg: Config) -> Cache {
        assert!(cfg.batch >= 1 && cfg.capacity >= cfg.batch);
        Cache {
            cfg,
            map: HashMap::default(),
            pages: HashMap::default(),
            linkers: HashMap::default(),
            jc: vec![JC_EMPTY; JC]
                .into_boxed_slice()
                .try_into()
                .ok()
                .expect("JC entries"),
            pending: Vec::new(),
            since: 0,
            clock: 0,
            next: 0,
            off: false,
            ram: None,
            stats: Stats::default(),
        }
    }

    /// `n` consecutive slots for a module; flushes the cache first if they don't fit.
    fn alloc(&mut self, n: u32) -> u32 {
        if self.next + n > self.cfg.capacity {
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
        self.map.clear();
        self.pages.clear();
        self.linkers.clear();
        self.jc.fill(JC_EMPTY);
        self.pending.clear();
        self.next = 0;
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
                if self.jc[jc_index(k)].key == k {
                    self.jc[jc_index(k)] = JC_EMPTY;
                }
                self.pending.retain(|p| p.0 != k);
                keys.extend(self.linkers.remove(&k).unwrap_or_default());
            }
        } else {
            return;
        }
        self.stats.invalidations += 1;
    }

    /// The entry for `key`, created (and filed under its page) if new.
    fn info(&mut self, key: u64, len: impl FnOnce() -> u32) -> &mut Info {
        info(&mut self.map, &mut self.pages, key, len)
    }

    /// The stale-code checker at a block's entry.
    fn check(&self, key: u64, mem: &Mem) {
        let i = &self.map[&key];
        let words = block::read(mem, key & !3, i.len as usize);
        assert!(
            block::hash(&words) == i.hash,
            "stale JIT block at PA {:#x}: its code changed without an IC",
            key & !3
        );
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
        let (base, phys) = mem.base();
        let ram = (base as usize, phys, mem.size());
        assert!(
            *self.ram.get_or_insert(ram) == ram,
            "a JIT vCPU runs on one RAM"
        );
        let pending = core::mem::take(&mut self.pending);
        let mut blocks = Vec::with_capacity(pending.len());
        for (key, va) in pending {
            let words = block::form(mem, key & !3);
            if let Some(i) = self.map.get_mut(&key) {
                (i.queued, i.len) = (false, words.len() as u32);
            }
            if !words.is_empty() {
                blocks.push(block::Block { key, va, words });
            }
        }
        if blocks.is_empty() {
            return;
        }
        let n = blocks.len() as u32;
        let slot = self.alloc(n);
        let map = &self.map;
        let compiled = |k| map.get(&k).filter(|i| i.idx != 0).map(|i| (i.idx, i.len));
        let block::Emitted {
            bytes,
            inl,
            links,
            counts,
        } = block::module(
            &blocks,
            mem,
            compiled,
            self.cfg.check,
            self.jc.as_ptr() as usize as u32,
        );
        let t = now_ns();
        let Some(idx) = install(&bytes, slot) else {
            self.off = true;
            return;
        };
        let s = &mut self.stats;
        s.compile_ns += now_ns() - t;
        s.flags_stored += counts.flags_stored;
        s.flags_elided += counts.flags_elided;
        s.cond_direct += counts.cond_direct;
        s.cond_computed += counts.cond_computed;
        s.cond_memory += counts.cond_memory;
        (s.modules, s.blocks, s.bytes) = (
            s.modules + 1,
            s.blocks + n as u64,
            s.bytes + bytes.len() as u64,
        );
        for (k, ((b, inl), links)) in blocks.iter().zip(inl).zip(links).enumerate() {
            let len = b.words.len() as u32;
            let s = &mut self.stats;
            (s.inline, s.helpers) = (s.inline + inl as u64, s.helpers + (len - inl) as u64);
            let i = self.info(b.key, || 0);
            (i.idx, i.len, i.hash) = (idx + k as u32, len, block::hash(&b.words));
            for t in links {
                self.linkers.entry(t).or_default().push(b.key);
            }
        }
    }
}

type Map<V> = HashMap<u64, V, BuildHasherDefault<KeyHasher>>;

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
        if let Ok((idx, len)) = r
            && len as u64 <= left
        {
            if cache.cfg.check {
                cache.check(key.expect("compiled"), mem);
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
    status(&mut v.jit, r)
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
/// compiled with `jit::Config::check` call it before they chain).
///
/// # Safety
/// As for [`jit_exec_flat`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jit_check(v: *mut Vcpu, key: u64) {
    // SAFETY: guaranteed by the caller.
    let (mem, v) = unsafe { (&*(*v).jit.mem, &*v) };
    v.jit.cache.as_deref().expect("a JIT vCPU").check(key, mem);
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
        assert_eq!(size_of::<Cpu>(), 1056);
    }

    #[test]
    fn slots_and_flush() {
        let mut c = Cache::new(Config {
            threshold: 0,
            batch: 4,
            capacity: 10,
            check: false,
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
