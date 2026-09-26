//! Tier-1 JIT: guest A64 blocks → WebAssembly (PLAN.md §7 M5).
//!
//! Generated modules import the core's memory, its function table and its
//! helper exports. The host compiles each module synchronously in the vCPU
//! worker and puts its functions into the core's table (`env.jit_install`), so
//! the run loop calls a block through a function pointer, which on wasm32 is a
//! table index. Natively there's no wasm engine: [`install`] fails and
//! everything runs in the interpreter.

pub mod wasm;

use crate::cpu::Cpu;

/// A compiled block: `f(cpu) -> status`.
// ponytail: step 1's shape; step 2 settles the real signature (JIT ABI note).
pub type Block = unsafe extern "C" fn(*mut Cpu) -> u32;

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
