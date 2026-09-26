//! Tier-1 JIT: guest A64 blocks → WebAssembly (PLAN.md §7 M5).
//!
//! Generated modules import the core's memory, its function table and its
//! helper exports. The host compiles each module synchronously in the vCPU
//! worker and puts its functions into the core's table (`env.jit_install`), so
//! the run loop calls a block through a function pointer, which on wasm32 is a
//! table index. Natively there's no wasm engine: [`install`] fails and
//! everything runs in the interpreter.

pub mod block;
pub mod wasm;

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

use crate::interp::{self, Exit};
use crate::mem::Mem;
use crate::mmu::{Flat, Mmu, Vcpu};

/// A compiled block: `f(vcpu) -> retired`, equivalent to `interp::steps` for
/// its length (PLAN.md §2 "JIT ABI"): if fewer than all its instructions
/// retired, the one that didn't left its exit in [`State::exit`] and the PC on it.
pub type Block = unsafe extern "C" fn(*mut Vcpu) -> u32;

/// Per-vCPU JIT state, after the TLB in [`Vcpu`]. The helpers use the first
/// two fields; the cache exists only while the JIT is on.
#[repr(C)]
#[derive(Default)]
pub struct State {
    /// Guest RAM; the run loop sets it before it enters a block.
    pub mem: *const Mem,
    /// Why the last block stopped early (the instruction that didn't retire).
    pub exit: Option<Exit>,
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
}

impl Config {
    pub const DEFAULT: Config = Config {
        threshold: 50,
        batch: 32,
        capacity: 16384,
    };
    /// Compile everything on first sight, one block per module, and flush constantly.
    pub const STRESS: Config = Config {
        threshold: 0,
        batch: 1,
        capacity: 4,
    };
}

/// What the JIT did (`vm::Counters` publishes them).
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
#[allow(dead_code)] // the dispatcher (step 2b) reads it
struct Info {
    /// Dispatches while not compiled.
    hits: u32,
    /// Table index once compiled (0 is never a JIT block: the table's null entry).
    idx: u32,
    /// Its length once compiled.
    len: u32,
}

/// The block cache and the code cache's slot allocator.
pub struct Cache {
    pub cfg: Config,
    map: HashMap<u64, Info, BuildHasherDefault<KeyHasher>>,
    /// The next free slot.
    next: u32,
    pub stats: Stats,
}

impl Cache {
    pub fn new(cfg: Config) -> Cache {
        assert!(cfg.batch >= 1 && cfg.capacity >= cfg.batch);
        Cache {
            cfg,
            map: HashMap::default(),
            next: 0,
            stats: Stats::default(),
        }
    }

    /// `n` consecutive slots for a module; flushes the cache first if they don't fit.
    #[allow(dead_code)] // the dispatcher's (step 2b)
    fn alloc(&mut self, n: u32) -> u32 {
        if self.next + n > self.cfg.capacity {
            self.flush();
        }
        self.next += n;
        self.next - n
    }

    /// Drops every block (their slots are reused; the modules are left to the GC).
    pub fn flush(&mut self) {
        self.map.clear();
        self.next = 0;
        self.stats.flushes += 1;
    }
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
    status(
        &mut v.jit.exit,
        interp::exec_at(&mut v.cpu, &mut Flat(mem), insn, pc),
    )
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
    status(
        &mut v.jit.exit,
        interp::exec_at(&mut v.cpu, &mut m, insn, pc),
    )
}

fn status(exit: &mut Option<Exit>, r: Result<(), Exit>) -> u32 {
    match r {
        Ok(()) => 0,
        Err(e) => {
            *exit = Some(e);
            1
        }
    }
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
    let t = m.ty(&[I32], &[I32]);
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
    fn slots_and_flush() {
        let mut c = Cache::new(Config {
            threshold: 0,
            batch: 4,
            capacity: 10,
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
