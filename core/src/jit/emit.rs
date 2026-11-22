//! Inline emission (M5 steps 4–6): simple integer instructions, branches,
//! loads and stores straight to wasm. Everything else stays a helper call.
//!
//! The rule: [`inline`] takes an instruction only if it can't fail, decided
//! from the word alone (an encoding whose handler could return `Undefined`
//! stays a helper call), and emits its exact interpreter semantics. 32-bit
//! (`sf` = 0) operations run on i32 and zero-extend into the X register.
//!
//! Guest registers live in i64 locals for the length of a block (step 6): a
//! register is loaded from the `Cpu` (at `8n`, SP at 248 as `x[31]`) on first
//! use, and the dirty ones are written back where memory must be current:
//! before a helper call and before the block returns ([`Func::flush`]). The PC
//! (256) stays in memory.
//!
//! The V registers likewise (v128 locals; the `Cpu` holds them at `V +
//! 16n`): in the same masks, bits 32..=63 (see [`Regs`]).
//!
//! NZCV (264) is lazy: a flag-setting instruction keeps its operands (or its
//! result) in the flag locals and records how its flags would be computed
//! ([`Flags`]); conditions are computed from those directly where the kind
//! allows (`cmp x, y; b.lt` is `i64.lt_s`), and NZCV is stored only before a
//! helper call, on a load/store's failure return and at the block's end. A
//! setter whose flags the next setter replaces first emits no flag code.

mod bf16;
mod crypto;
mod float;
mod half;

pub use crypto::{CONSTS, Consts};
mod simd;
mod simd_lane;

use core::mem::offset_of;
use core::ops::{Deref, DerefMut};

use super::wasm::{Code, F32, F64, I32, I64, V128};
use crate::cpu::Cpu;
use crate::decode::Op;
use crate::interp::sys::DCZID_BS;
use crate::interp::{adr_imm, bit, bit_masks, bits, sext, trunc};
use crate::mem::{PAIR_LOCK_SIZE, PAIR_LOCKS};
use crate::mmu::{TLB_ENTRIES, TLB_SLOTS, Tlb, Vcpu, XC_ENTRIES};

/// A block function's locals after its parameter (local 0, the vCPU), as
/// emitted: the entry PC (local 1), scratch (i64 in 2..=5, i32 in 6..=9), the
/// flag locals (x, y, result: i64 in 10..=12, i32 in 13..=15; the carry in,
/// 16), then one i64 per guest register the block uses, in order of first
/// use. [`Func::locals`] keeps only the ones used.
const FIRST_REG: u32 = 17;
const FC: u32 = 16;
const VCPU: u32 = 0;
const ENTRY: u32 = 1;
/// The other parameters (step 7): the instructions retired by the blocks
/// chained before this one, and the steps left for this one and its
/// successors. As emitted they're locals 126 and 127 ([`Func::locals`] makes
/// them parameters 1 and 2); 125 (i32) holds a conditional branch's outcome.
pub const ACC: u32 = 126;
pub const LEFT: u32 = 127;
pub const TAKEN: u32 = 125;
/// In a region with edges ([`Func::sum`]): `acc + left` at entry (i32), which
/// the edges keep, so they update only `left` and `acc` is `SUM - left`.
pub const SUM: u32 = 138;
/// The last parameter: how many host calls deep the function runs (0 from
/// the dispatcher). A guest call (BL, BLR) below [`MAX_DEPTH`] is a wasm
/// `call` with the depth + 1, and a `ret` at a depth above 0 a wasm `return`
/// with [`RETURNED`] set in the result, so the host's own return predicts it
/// and the caller's continuation stays in its function ([`call`]). Local 128
/// as emitted ([`Func::locals`] makes it parameter 3), past the 0..=127 the
/// other locals take: at 118 it was FPCR.FZ's ([`FZOK`]), which an FP guard
/// overwrote, and a `ret` at depth 0 then returned as a host call's.
pub const DEPTH: u32 = 128;
const _: () = assert!(DEPTH >= 128, "the other locals take 0..=127");
/// A function's result with this bit: it ended on a `ret` at a depth above 0
/// (the PC in the `Cpu` is the return's target); without it, it stopped (an
/// exit, the budget, a block not compiled) and every caller returns too.
pub const RETURNED: u32 = 1 << 31;
/// The deepest host call: frames past it would risk the host's stack (a
/// guest's deep recursion), so a call there is a tail call as before.
pub const MAX_DEPTH: u32 = 64;
/// The i32 scratch local that holds a call's result ([`call`]).
const RESULT: u32 = 9;
/// A v128 scratch local (AdvSIMD reductions, M6 loop 4).
pub const VTMP: u32 = 124;
/// More v128 scratch locals (vector FP, M6 loop 6).
pub const VT: [u32; 4] = [119, 120, 121, 122];
/// The block's FP guard (i32; `float::fpa_guard`, M6 loop 5).
pub const FPOK: u32 = 123;
/// FPCR.FZ is clear (i32; `float::fpa_guard`).
pub const FZOK: u32 = 118;
/// FPCR.FZ16 is clear (i32; `half::half_guard`, PERF loop 10): past the 0..=127
/// of the rest, as [`DEPTH`] is (indices are one byte until `Func::locals`).
pub const HOK: u32 = 129;
/// v128 scratch locals of the half-precision paths (`half`).
pub const HT: [u32; 8] = [130, 131, 132, 133, 134, 135, 136, 137];
/// f64 scratch locals (the double FMA's exact product and sums).
pub const FT: [u32; 8] = [97, 98, 99, 113, 114, 115, 116, 117];
/// The V registers' v128 locals, in order of first use: 49..=79, then 96
/// (between the register locals and SHA's, and after SHA's).
const VREGS: core::ops::RangeInclusive<u32> = 49..=79;
const VREG_LAST: u32 = 96;
/// The V registers' scalar shadows ([`Regs`]): Vn's f64 at `SH64 + n`, its f32
/// at `SH32 + n`, past the rest (indices are one byte until `Func::locals`).
const SH64: u32 = 139;
const SH32: u32 = 171;
/// A scalar FP result before its write (f64, f32): the fast arm's, so the
/// destination's shadow keeps its value until the result passes its check.
pub const FR: u32 = 203;
pub const FR32: u32 = 204;
const _: () = assert!(SUM < SH64 && FR32 < 256);

/// Vn's scalar shadow of `esize` bits (32 or 64).
fn shadow(n: u32, esize: u32) -> u32 {
    if esize == 64 { SH64 + n } else { SH32 + n }
}

/// Vn's bit in a register mask ([`Regs`]).
pub fn vbit(n: u32) -> u64 {
    1 << (32 + n)
}

/// Offsets in the `Cpu`.
pub const PC: u32 = 256;
const NZCV: u32 = 264;
const PSTATE: usize = offset_of!(Cpu, pstate);

/// Which register locals hold the register's value (`valid`), and which of
/// those are newer than the `Cpu` (`dirty`); bit 31 is SP, bits 32..=63 are
/// V0..=V31 ([`vbit`]).
///
/// A V register can also be held in its scalar shadows (`s32`, `s64`: an f32
/// or f64 local, [`SH32`], [`SH64`]), which scalar FP reads and writes
/// without lane ops (docs/jit.md "Scalar shadows"): a shadow holds lane 0 of
/// the register's value at its width. With the v128 local valid too, that is
/// all it says; without it (shadow-only), the register is the shadow
/// zero-extended when dirty (a scalar write zeroes the rest), and the `Cpu`'s
/// value when clean. A vector reader of a shadow-only register builds the
/// v128 (dirty) or loads it (clean); a store of one writes the shadow and
/// zeros above it (a dirty one has nothing else). No register is held in
/// both shadows without its v128 ([`Regs::sound`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Regs {
    valid: u64,
    dirty: u64,
    s32: u64,
    s64: u64,
}

impl Regs {
    /// The registers held in some local.
    pub fn held(self) -> u64 {
        self.valid | self.s32 | self.s64
    }

    /// The state a region block entered from both `self` and `o` starts in
    /// (step 8): every register held on either side, dirty if dirty on
    /// either; each edge conforms to it ([`Func::conform`]). Registers in
    /// `plain` never have a local. A V register stays shadow-only when each
    /// side holds it in that shadow alone or not at all; it is dirty (the
    /// shadow zero-extended) only when both sides hold it dirty so, else
    /// clean (a clean or absent side's `Cpu` value isn't known to be the
    /// shadow zero-extended): an edge where it is dirty stores it, the shadow
    /// with zeros above. A loop-carried scalar then stays in its shadow
    /// across the head, which the function's entry also reaches. Any other
    /// register is held as a v128, with the shadows both sides hold.
    pub fn merge(self, o: Regs, plain: u64) -> Regs {
        debug_assert!(self.sound() && o.sound());
        let (ha, hb) = (self.held(), o.held());
        let ((a32, a64), (b32, b64)) = (self.only(), o.only());
        let only = |s: u64, t: u64| (s | !ha) & (t | !hb) & (ha | hb);
        let (o32, o64) = (only(a32, b32), only(a64, b64));
        let valid = (ha | hb) & !(o32 | o64);
        let dirty = (self.dirty | o.dirty) & valid | self.dirty & o.dirty & (o32 | o64);
        Regs {
            valid: valid & !plain,
            dirty: dirty & !plain,
            s32: (o32 | self.s32 & o.s32 & valid) & !plain,
            s64: (o64 | self.s64 & o.s64 & valid) & !plain,
        }
    }

    /// The V registers held in a shadow alone: `(s32, s64)`.
    fn only(self) -> (u64, u64) {
        let so = !self.valid;
        (self.s32 & so, self.s64 & so)
    }

    /// No register is held in both shadows without its v128 (every writer
    /// of a shadow alone clears the other; a reader of the other width
    /// takes the shadow's bits or the `Cpu`'s without holding them).
    fn sound(self) -> bool {
        self.s32 & self.s64 & !self.valid == 0
    }

    /// `self` with no register dirty in a shadow alone (made clean: each
    /// edge into it stores such a register first): a state any edge can
    /// conform to, for a region whose entry states didn't settle.
    pub fn loose(self) -> Regs {
        let (o32, o64) = self.only();
        Regs {
            dirty: self.dirty & !(o32 | o64),
            ..self
        }
    }
}

/// Where NZCV is: in the `Cpu`, or to be computed from the last flag setter's
/// kind and flag locals (`stored`: stored somewhere already, so it counts as
/// materialized; `current`: the `Cpu` holds it on this path too).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Flags {
    #[default]
    Mem,
    Lazy {
        kind: Kind,
        sf: bool,
        stored: bool,
        current: bool,
    },
}

/// A lazy flag setter: x + y (ADDS: x, y in the flag locals), x − y (SUBS),
/// x + y + carry (ADCS/SBCS: y already inverted for SBCS, the result and the
/// carry in too), or a logical result (ANDS/BICS: the result only).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Add,
    Sub,
    Adc,
    Logic,
}

/// The flag locals (x, y, result) of the operation size.
fn flag_locals(sf: bool) -> (u32, u32, u32) {
    if sf { (10, 11, 12) } else { (13, 14, 15) }
}

/// Static counts over the emitted code (`jit::Stats`, ABI 13): lazy flag
/// setters whose NZCV was stored somewhere or never; conditions (B.cond,
/// CSEL & co, CCMP, ADC's carry) computed directly from a lazy setter's
/// operands, from its NZCV computed in registers, or from NZCV in memory.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub flags_stored: u64,
    pub flags_elided: u64,
    pub cond_direct: u64,
    pub cond_computed: u64,
    pub cond_memory: u64,
}

impl core::ops::AddAssign for Counts {
    fn add_assign(&mut self, o: Counts) {
        self.flags_stored += o.flags_stored;
        self.flags_elided += o.flags_elided;
        self.cond_direct += o.cond_direct;
        self.cond_computed += o.cond_computed;
        self.cond_memory += o.cond_memory;
    }
}

/// A block function under construction: its code, its register locals and
/// where its flags are.
#[derive(Default)]
pub struct Func {
    pub c: Code,
    /// Each register's local (0: none yet), the V registers' from 32.
    local: [[u32; 32]; 2],
    nregs: u32,
    nvregs: u32,
    pub regs: Regs,
    pub flags: Flags,
    pub counts: Counts,
    /// Registers read at least once, and read more than once or written; and
    /// the registers to read straight from the `Cpu` without a local: a first
    /// emission of the block finds them, and registers read once and never
    /// written are `plain` in the second (a local costs Liftoff more than it
    /// saves them). Bit masks, not counts: rustc nightly-2026-09-24 with
    /// simd128 miscompiles a `[u8; 32]` compared into a u32 mask (docs/backlog.md).
    pub read: u64,
    pub reused: u64,
    pub plain: u64,
    /// The block's offset from the function's entry PC (local 1): a region's
    /// blocks (step 8) share the head's.
    pub base: i64,
    /// The entry PC's offset in its 4 KiB page: the same for every VA that
    /// runs the function (its key is a PA, and a VA keeps a PA's page offset
    /// at every granule), so ADRP's page is the entry PC plus a constant.
    pub page: i64,
    /// ADDR holds the PC the block's last instruction (BR, BLR, RET) stored,
    /// for [`indirect`]: nothing between them writes ADDR.
    pub pc_in_addr: bool,
    /// Whether NZCV was live at the block's entry, once known (step 8.4):
    /// false if a setter came first, true if a condition, a helper, a
    /// possible exit (a load/store's failure path, the block's end) or a
    /// commit did. A region member that sets flags before anything else
    /// needs none from its edges.
    pub touched: Option<bool>,
    /// The block's branch leaves the PC to its exits (step 8.5): a
    /// successor is a region member (since M6: either side of a conditional
    /// branch), so only the paths that leave store it; a conditional branch
    /// keeps just its outcome in `TAKEN`.
    pub defer_pc: bool,
    /// The block checked already that SIMD&FP instructions may run
    /// ([`fp_guard`]); false at each block's start.
    pub fp_ok: bool,
    /// The block computed its FP guard already (`float::fpa_guard`); false at
    /// each block's start.
    pub fpa_ok: bool,
    /// The block computed its FZ16 guard already (`half::half_guard`); false
    /// at each block's start.
    pub fp16_ok: bool,
    /// `float::vector` is emitting an AdvSIMD scalar form (`Some(d)`: of
    /// doubles if `d`): lane 0 counts, and the rest of Vd is cleared.
    pub vsc: Option<bool>,
    /// The block's previous and next words (0 past its ends), and whether the
    /// instruction just emitted consumed the next one too: a fused AES round
    /// and mix, or SHA256H and SHA256H2 (M6.5, `crypto`).
    pub prev: u32,
    pub next: u32,
    pub fused: bool,
    /// The registers the instruction being emitted has read so far ([`Func::reg`]):
    /// what a load's or store's helper reads, flushed before its call ([`fallback_chain`]).
    pub ireads: u64,
    /// The open chain of load and store failure exits ([`Chain`]).
    chain: Option<Chain>,
    /// The block's words and the groups of accesses that share one TLB probe
    /// ([`plan`]), by instruction; the group open, and the registers its span
    /// has read and written so far ([`access`]).
    pub words: Vec<u32>,
    pub plan: Vec<Role>,
    /// [`scalar_uses`] of `words` once a load asks (emptied with each new
    /// block: [`Func::new_block`]).
    scalar: Vec<(u32, u32)>,
    group: Option<Open>,
    /// [`close`] emits a group's span again (a spill arm).
    replay: bool,
    sreads: u64,
    swrites: u64,
    /// The module's NZCV helpers ([`nzcv_helper`], by [`nzcv_index`]), which
    /// the failure chains call instead of computing NZCV inline.
    pub nzcv: Option<[u32; NZCV_HELPERS]>,
    pub nzcv_used: bool,
    /// `acc` is `SUM - left` ([`SUM`]).
    pub sum: bool,
    /// Parallel SMP's code (`jit::Config::polled`): no step budget. `left` is
    /// neither checked nor kept (a transfer passes 0); what can close a cycle
    /// ([`poll`]'s points) compares `acc` with the vCPU's stop word instead.
    pub polled: bool,
    /// The instruction being emitted (its index in `words`).
    pub at: usize,
    /// The bytes a SIMD&FP load about to call [`access`] writes into each of
    /// its V registers, zero-extended (0: a write that may set more, or none):
    /// what [`Func::chain_open`] needs of a register a segment stores from a
    /// shadow.
    vzx: u32,
    /// The diagnostic build's tally (`crate::tally`) the next transfer cache or jump cache hit bumps, if not its
    /// own ([`dslot`]).
    #[cfg(feature = "diag")]
    dslot: Option<u32>,
}

/// The diagnostic build only (`crate::tally`): code that bumps the vCPU's tally `i`. Nothing in a normal build.
pub fn dbump(c: &mut Func, i: u32) {
    #[cfg(feature = "diag")]
    {
        let o = (offset_of!(Vcpu, diag) + 8 * i as usize) as u32;
        c.local_get(VCPU)
            .local_get(VCPU)
            .i64_load(o)
            .i64_const(1)
            .i64_add()
            .i64_store(o);
    }
    #[cfg(not(feature = "diag"))]
    let _ = (c, i);
}

/// The diagnostic build only: the tally the next cache hit ([`via_xc`], [`via_jc`]) bumps instead of its own.
pub fn dslot(c: &mut Func, i: u32) {
    #[cfg(feature = "diag")]
    {
        c.dslot = Some(i);
    }
    #[cfg(not(feature = "diag"))]
    let _ = (c, i);
}

/// Bumps the tally [`dslot`] chose, or `own`.
fn dhit(c: &mut Func, own: u32) {
    #[cfg(feature = "diag")]
    {
        let i = c.dslot.take().unwrap_or(own);
        dbump(c, i);
    }
    #[cfg(not(feature = "diag"))]
    let _ = (c, own);
}

/// Load and store failure exits that share their write-backs (docs/jit.md
/// "Loads and stores"). A load's or store's slow arm writes back only the
/// registers its helper reads or writes; if the helper doesn't retire, the
/// arm branches (with its retired count) to its segment's end, which stores
/// the registers dirty at that site that no earlier site's segment stores,
/// and falls through the earlier segments' ends to the shared return. So each
/// register is stored once per chain, not once per site. The segments are
/// nested `block (result i32)`s opened at the sites, at the instruction
/// level, inside a `block` that the code falling through branches past at
/// the chain's close. A site joins the open chain only while every register
/// the chain stores is still valid there (a helper call that drops the
/// locals ends it) and its lazy flags are the chain's kind and size, which
/// the return stores once; [`Func::chain_close`] ends it at the block's end.
#[derive(Clone, Default)]
struct Chain {
    /// Each segment's registers, outermost first, and of those the V
    /// registers it stores from their f32 or their f64 shadow ([`Regs::only`]):
    /// the form they were in at its site.
    segs: Vec<(u64, u64, u64)>,
    /// Their union.
    cum: u64,
    /// The union of the segments' shadow forms.
    o32: u64,
    o64: u64,
    /// The kind and size of the lazy flags every site has, stored once on the
    /// way to the return from the flag locals, which hold the setter of the
    /// failing site's (setters of one kind and size share them); none if the
    /// `Cpu` holds NZCV at every site.
    flags: Option<(Kind, bool)>,
}

impl Deref for Func {
    type Target = Code;
    fn deref(&self) -> &Code {
        &self.c
    }
}

impl DerefMut for Func {
    fn deref_mut(&mut self) -> &mut Code {
        &mut self.c
    }
}

impl Func {
    /// Renumbers the function's locals to the ones it uses (i64s, then
    /// i32s) and returns their declarations, for `Module::func`.
    pub fn locals(&mut self) -> Vec<(u32, u8)> {
        self.c.compact_locals(&[VCPU, ACC, LEFT, DEPTH], |i| {
            if (6..=9).contains(&i)
                || i == DEPTH
                || (13..=16).contains(&i)
                || i == TAKEN
                || i == SUM
                || i == FPOK
                || i == FZOK
                || i == HOK
                || crypto::I32_LOCALS.contains(&i)
            {
                I32
            } else if FT.contains(&i) || (SH64..SH64 + 32).contains(&i) || i == FR {
                F64
            } else if (SH32..SH32 + 32).contains(&i) || i == FR32 {
                F32
            } else if i == VTMP
                || VT.contains(&i)
                || HT.contains(&i)
                || VREGS.contains(&i)
                || i == VREG_LAST
            {
                V128
            } else {
                I64
            }
        })
    }

    /// Register `n`'s local (31 is SP, 32 + k is Vk).
    fn local(&mut self, n: u32) -> u32 {
        let l = &mut self.local[n as usize / 32][n as usize % 32];
        if *l == 0 {
            if n < 32 {
                *l = FIRST_REG + self.nregs;
                self.nregs += 1;
            } else {
                let k = self.nvregs;
                *l = if k <= VREGS.end() - VREGS.start() {
                    VREGS.start() + k
                } else {
                    VREG_LAST
                };
                self.nvregs += 1;
            }
        }
        *l
    }

    /// Pushes register `n`'s value in the `Cpu` (an X register, SP or, from
    /// 32, a V register).
    fn load_cpu(&mut self, n: u32) {
        self.c.local_get(VCPU);
        if n < 32 {
            self.c.i64_load(8 * n);
        } else {
            self.c.simd_mem(V128_LOAD, 0, V + 16 * (n - 32));
        }
    }

    /// Stores register `n`'s local to the `Cpu`.
    fn store_cpu(&mut self, n: u32) {
        let (o32, o64) = self.regs.only();
        self.store_as(n, o32 & 1 << n != 0, o64 & 1 << n != 0);
    }

    /// Stores register `n` to the `Cpu` from its local, or (a V register
    /// dirty in a shadow alone) from its f32 or f64 shadow, zeros above it.
    fn store_as(&mut self, n: u32, s32: bool, s64: bool) {
        if s32 || s64 {
            let (k, off) = (n - 32, V + 16 * (n - 32));
            self.c
                .local_get(VCPU)
                .local_get(shadow(k, if s64 { 64 } else { 32 }));
            if s64 {
                self.c.memarg(0x39, 3, off); // f64.store
            } else {
                self.c.memarg(0x38, 2, off); // f32.store
                self.c.local_get(VCPU).i32_const(0).memarg(0x36, 2, off + 4); // i32.store
            }
            self.c.local_get(VCPU).i64_const(0).i64_store(off + 8);
            return;
        }
        let l = self.local[n as usize / 32][n as usize % 32];
        self.c.local_get(VCPU).local_get(l);
        if n < 32 {
            self.c.i64_store(8 * n);
        } else {
            self.c.simd_mem(V128_STORE, 0, V + 16 * (n - 32));
        }
    }

    /// Loads register `n` from the `Cpu` into its local.
    fn load(&mut self, n: u32) -> u32 {
        let l = self.local(n);
        self.load_cpu(n);
        self.c.local_set(l);
        self.regs.valid |= 1 << n;
        l
    }

    /// Loads register `n` from the `Cpu` into its local, or into its f32 or
    /// f64 shadow (a V register).
    fn load_as(&mut self, n: u32, s32: bool, s64: bool) {
        if !(s32 || s64) {
            self.load(n);
            return;
        }
        let (k, e) = (n - 32, if s64 { 64 } else { 32 });
        self.load_shadow(k, e);
        self.c.local_set(shadow(k, e));
        let m = if s64 {
            &mut self.regs.s64
        } else {
            &mut self.regs.s32
        };
        *m |= 1 << n;
    }

    /// Pushes lane 0 of Vk's value in the `Cpu` as an f32 or f64 (`esize`).
    fn load_shadow(&mut self, k: u32, esize: u32) {
        self.c.local_get(VCPU);
        if esize == 64 {
            self.c.memarg(0x2b, 3, V + 16 * k); // f64.load
        } else {
            self.c.memarg(0x2a, 2, V + 16 * k); // f32.load
        }
    }

    /// Counts a read of register `n` ([`Func::read`] and the rest).
    fn note_read(&mut self, n: u32) {
        self.reused |= self.read & 1 << n;
        self.read |= 1 << n;
        self.ireads |= 1 << n;
        self.sreads |= 1 << n;
    }

    /// Pushes register `n` (31 is SP) as an i64; from 32, V register n − 32
    /// as a v128 (built from its shadow if it is dirty in one alone).
    fn reg(&mut self, n: u32) {
        self.note_read(n);
        if self.plain & 1 << n != 0 {
            self.load_cpu(n);
        } else if self.regs.valid & 1 << n != 0 {
            let l = self.local[n as usize / 32][n as usize % 32];
            self.c.local_get(l);
        } else {
            let l = self.local(n);
            if !self.build(n) {
                self.load_cpu(n);
            }
            self.c.local_tee(l);
            self.regs.valid |= 1 << n;
        }
    }

    /// Pushes V register `n` − 32 as a v128 from its shadow, zero-extended, if
    /// it is dirty in one alone (true); else nothing (false).
    fn build(&mut self, n: u32) -> bool {
        let (o32, o64) = self.regs.only();
        if (o32 | o64) & self.regs.dirty & 1 << n == 0 {
            return false;
        }
        let s64 = o64 & 1 << n != 0;
        self.c.v128_const(0);
        self.c.local_get(shadow(n - 32, if s64 { 64 } else { 32 }));
        // f64x2/f32x4.replace_lane 0
        self.c.simd_lane(if s64 { 0x22 } else { 0x20 }, 0);
        true
    }

    /// Whether Vn's `esize`-bit shadow holds its lane 0.
    pub fn has_shadow(&self, n: u32, esize: u32) -> bool {
        let m = if esize == 64 {
            self.regs.s64
        } else {
            self.regs.s32
        };
        m & vbit(n) != 0 && self.plain & vbit(n) == 0
    }

    /// Pushes Vn as a v128 whose lane 0 (of `esize` bits) is Vn's, the rest
    /// any value: a splat of its shadow where it is in one alone (one lane op,
    /// where building the register takes two), else Vn.
    pub fn vget_lo(&mut self, n: u32, esize: u32) {
        let b = 32 + n;
        if self.regs.valid & 1 << b == 0 && self.has_shadow(n, esize) {
            self.note_read(b);
            self.c.local_get(shadow(n, esize));
            self.c.simd(if esize == 64 { 0x14 } else { 0x13 }); // f64x2/f32x4.splat
        } else {
            self.reg(b);
        }
    }

    /// Vn = the f32 or f64 (`esize` 32 or 64) `value` pushes, zero-extended:
    /// into its shadow alone (the v128 dropped), so a scalar reader takes it
    /// as it is and a flush stores it with no lane op ([`Regs`]).
    pub fn vset_f(&mut self, n: u32, esize: u32, value: impl FnOnce(&mut Func)) {
        let b = 32 + n;
        value(self);
        self.c.local_set(shadow(n, esize));
        self.reused |= 1 << b;
        self.swrites |= 1 << b;
        self.regs.valid &= !(1 << b);
        self.regs.s32 &= !(1 << b);
        self.regs.s64 &= !(1 << b);
        if esize == 64 {
            self.regs.s64 |= 1 << b;
        } else {
            self.regs.s32 |= 1 << b;
        }
        self.regs.dirty |= 1 << b;
    }

    /// Whether the next instruction of the block that names Vt reads its low
    /// `esize` bits as a scalar FP operand a shadow serves without lane ops
    /// (arithmetic, a store), so a load into Vt goes to its shadow; any other
    /// use, or none in the block, keeps the v128 (a vector reader of a shadow
    /// pays to build it). Only a hint: either form is exact. From
    /// [`scalar_uses`]'s table of the block, made at its first such load.
    fn scalar_next(&mut self, t: u32, esize: u32) -> bool {
        if self.scalar.is_empty() {
            self.scalar = scalar_uses(&self.words);
        }
        self.scalar
            .get(self.at)
            .is_some_and(|&(m32, m64)| (if esize == 64 { m64 } else { m32 }) & 1 << t != 0)
    }

    /// Starts a block's `words`; its [`scalar_uses`] are made when a load
    /// first asks.
    pub fn new_block(&mut self, words: &[u32]) {
        self.words.clear();
        self.words.extend_from_slice(words);
        self.scalar.clear();
    }

    /// Pushes Vn.
    pub fn vget(&mut self, n: u32) {
        self.reg(32 + n);
    }

    /// Pushes lane `lane` of Vn's `esize`-bit lanes (32 or 64) as an i32 or
    /// i64: from its local, or with a scalar load if Vn has none (`plain`).
    pub fn vlane(&mut self, n: u32, esize: u32, lane: u32) {
        let b = 32 + n;
        if self.plain & 1 << b == 0
            && self.regs.valid & 1 << b == 0
            && (self.regs.s32 | self.regs.s64) & 1 << b != 0
        {
            // In a shadow alone: from it, with no state change (a test in a
            // branch reads lanes too).
            self.note_read(b);
            self.shadow_lane(n, esize, lane);
            return;
        }
        self.vlane_held(n, esize, lane);
    }

    /// [`Func::vlane`] of a V register held in a shadow alone: the shadow's
    /// bits, zero-extended (dirty), or the `Cpu`'s lane (clean).
    fn shadow_lane(&mut self, n: u32, esize: u32, lane: u32) {
        let b = 32 + n;
        {
            if lane == 0 && self.has_shadow(n, esize) {
                self.c.local_get(shadow(n, esize));
                self.c.op(if esize == 64 { 0xbd } else { 0xbc }); // i64/i32.reinterpret
            } else if self.regs.dirty & 1 << b != 0 {
                // The shadow zero-extended.
                let s64 = self.regs.s64 & 1 << b != 0;
                let (w, at) = (if s64 { 64 } else { 32 }, esize * lane);
                if at >= w {
                    if esize == 64 {
                        self.c.i64_const(0);
                    } else {
                        self.c.i32_const(0);
                    }
                } else {
                    self.c.local_get(shadow(n, w));
                    if s64 {
                        self.c.op(0xbd); // i64.reinterpret
                        if esize == 32 {
                            if at > 0 {
                                self.c.i64_const(at as i64).op(SHR_U + W);
                            }
                            self.c.i32_wrap_i64();
                        }
                    } else {
                        self.c.op(0xbc); // i32.reinterpret
                        if esize == 64 {
                            self.c.i64_extend_i32_u();
                        }
                    }
                }
            } else {
                let off = V + 16 * n + esize / 8 * lane;
                self.c.local_get(VCPU);
                if esize == 64 {
                    self.c.i64_load(off);
                } else {
                    self.c.i32_load(off);
                }
            }
        }
    }

    fn vlane_held(&mut self, n: u32, esize: u32, lane: u32) {
        let b = 32 + n;
        if self.plain & 1 << b != 0 {
            self.reused |= self.read & 1 << b;
            self.read |= 1 << b;
            let off = V + 16 * n + esize / 8 * lane;
            self.c.local_get(VCPU);
            if esize == 64 {
                self.c.i64_load(off);
            } else {
                self.c.i32_load(off);
            }
        } else {
            self.reg(b);
            let op = if esize == 64 { 0x1d } else { 0x1b }; // i64x2/i32x4.extract_lane
            self.c.simd_lane(op, lane as u8);
        }
    }

    /// Pushes Vn's low 32 or 64 bits (`esize`) as an f32 or f64: lane 0
    /// extracted as a float (one lane op on arm64, where its bits through an
    /// integer took two), or loaded if Vn has no local.
    pub fn vlanef(&mut self, n: u32, esize: u32) {
        let b = 32 + n;
        if self.has_shadow(n, esize) {
            self.note_read(b);
            self.c.local_get(shadow(n, esize));
            return;
        }
        if self.plain & 1 << b == 0 && self.regs.valid & 1 << b == 0 {
            // In the other shadow alone (its bits, no state change), or not
            // held: loaded into the shadow (the `Cpu` holds it).
            if (self.regs.s32 | self.regs.s64) & 1 << b != 0 {
                self.vlane(n, esize, 0);
                self.c.op(if esize == 64 { 0xbf } else { 0xbe }); // f64/f32.reinterpret
                return;
            }
            self.note_read(b);
            self.load_shadow(n, esize);
            self.c.local_tee(shadow(n, esize));
            let m = if esize == 64 {
                &mut self.regs.s64
            } else {
                &mut self.regs.s32
            };
            *m |= 1 << b;
            return;
        }
        if self.plain & 1 << b != 0 {
            self.reused |= self.read & 1 << b;
            self.read |= 1 << b;
            self.c.local_get(VCPU);
            if esize == 64 {
                self.c.memarg(0x2b, 3, V + 16 * n); // f64.load
            } else {
                self.c.memarg(0x2a, 2, V + 16 * n); // f32.load
            }
        } else {
            // Kept in the shadow too: a scalar reader again takes it as it is.
            self.reg(b);
            // f64x2/f32x4.extract_lane 0
            self.c.simd_lane(if esize == 64 { 0x21 } else { 0x1f }, 0);
            self.c.local_tee(shadow(n, esize));
            let m = if esize == 64 {
                &mut self.regs.s64
            } else {
                &mut self.regs.s32
            };
            *m |= 1 << b;
        }
    }

    /// Pops a v128 into Vn.
    pub fn vset(&mut self, n: u32) {
        self.set_reg(32 + n);
    }

    /// Vn = the i32 or i64 (`esize` 32 or 64) `value` pushes, zero-extended.
    pub fn vset_scalar(&mut self, n: u32, esize: u32, value: impl FnOnce(&mut Func)) {
        self.c.v128_const(0);
        value(self);
        // i64x2/i32x4.replace_lane 0
        self.c.simd_lane(if esize == 64 { 0x1e } else { 0x1c }, 0);
        self.vset(n);
    }

    /// Pops an i64 into register `n` (31 is SP; from 32, a v128 into a V register).
    fn set_reg(&mut self, n: u32) {
        self.reused |= 1 << n;
        self.swrites |= 1 << n;
        let l = self.local(n);
        self.c.local_set(l);
        self.regs.valid |= 1 << n;
        self.regs.dirty |= 1 << n;
        self.regs.s32 &= !(1 << n);
        self.regs.s64 &= !(1 << n);
    }

    /// Writes the dirty registers back to the `Cpu`.
    pub fn flush(&mut self) {
        let mut d = self.regs.dirty;
        while d != 0 {
            let n = d.trailing_zeros();
            d &= d - 1;
            self.store_cpu(n);
        }
        self.regs.dirty = 0;
    }

    /// Drops the locals of the registers in `mask` (clean: flushed first),
    /// which something else may have written in the `Cpu`.
    pub fn forget(&mut self, mask: u64) {
        debug_assert_eq!(self.regs.dirty & mask, 0);
        self.regs.valid &= !mask;
        self.regs.s32 &= !mask;
        self.regs.s64 &= !mask;
    }

    /// A new flag setter replaces the current one.
    fn set_flags(&mut self, kind: Kind, sf: bool) {
        self.touched.get_or_insert(false);
        self.retire_flags();
        self.flags = Flags::Lazy {
            kind,
            sf,
            stored: false,
            current: false,
        };
    }

    /// Counts the lazy setter's fate as it goes.
    fn retire_flags(&mut self) {
        if let Flags::Lazy { stored, .. } = self.flags {
            if stored {
                self.counts.flags_stored += 1;
            } else {
                self.counts.flags_elided += 1;
            }
        }
        self.flags = Flags::Mem;
    }

    /// Stores lazy flags to the `Cpu` on a path that returns (a load/store's
    /// failure path), leaving them lazy for the other one.
    pub fn store_flags(&mut self) {
        self.store_flags_in(false);
    }

    /// [`Func::store_flags`] on a cold path (a slow arm, a trap): through the
    /// module's NZCV helper where there is one ([`Func::nzcv`]).
    pub fn store_flags_cold(&mut self) {
        self.store_flags_in(true);
    }

    fn store_flags_in(&mut self, cold: bool) {
        self.touched.get_or_insert(true);
        if let Flags::Lazy { kind, sf, .. } = self.flags {
            self.c.local_get(VCPU);
            self.push_nzcv(kind, sf, cold);
            self.c.i64_extend_i32_u().i64_store(NZCV);
            if let Flags::Lazy { stored, .. } = &mut self.flags {
                *stored = true;
            }
        }
    }

    /// Pushes a lazy setter's NZCV ([`nzcv_of`]); on a cold path, a call of
    /// the module's helper for it instead of its ~70 bytes inline.
    fn push_nzcv(&mut self, kind: Kind, sf: bool, cold: bool) {
        match (self.nzcv.filter(|_| cold), nzcv_index(kind, sf)) {
            (Some(f), Some(k)) => {
                let (x, y, _) = flag_locals(sf);
                self.c.local_get(x).local_get(y).call(f[k]);
                self.nzcv_used = true;
            }
            _ => nzcv_of(self, kind, sf),
        }
    }

    /// Makes NZCV in the `Cpu` current on this path, the flags staying lazy
    /// for the conditions that follow. The block does it before its last
    /// instruction when that is a branch: the same NZCV computed after the
    /// branch's `select` of the next PC ran 35% slower under TurboFan
    /// (`bench/interp/REPORT.md` "M5 step 6").
    pub fn commit_flags(&mut self) {
        self.touched.get_or_insert(true);
        if let Flags::Lazy { current: false, .. } = self.flags {
            self.store_flags();
            if let Flags::Lazy { current, .. } = &mut self.flags {
                *current = true;
            }
        }
    }

    /// Makes NZCV in the `Cpu` current and drops the lazy state (before a
    /// helper call, which may read or write it, and at the block's end).
    pub fn sync_flags(&mut self) {
        self.commit_flags();
        self.retire_flags();
    }

    /// Returns the chain's retired count with `k` more of this block's
    /// instructions retired (the registers and flags already in the `Cpu`).
    /// Pushes `acc`: the parameter, or `SUM - left` in a region with edges.
    pub fn acc(&mut self) {
        if self.sum {
            self.c.local_get(SUM).local_get(LEFT).op(0x6b); // i32.sub
        } else {
            self.c.local_get(ACC);
        }
    }

    pub fn ret(&mut self, k: u32) {
        self.acc();
        if k != 0 {
            self.c.i32_const(k as i32).op(0x6a); // i32.add
        }
        self.c.return_();
    }

    /// Starts a region member (step 8.4) with its edges' lazy flags (the
    /// flag locals hold them; the `Cpu` may not), or with NZCV in memory
    /// (or dead: nothing reads it before a setter replaces it).
    pub fn enter_flags(&mut self, lazy: Option<(Kind, bool)>) {
        self.touched = None;
        self.flags = match lazy {
            Some((kind, sf)) => Flags::Lazy {
                kind,
                sf,
                stored: false,
                current: false,
            },
            None => Flags::Mem,
        };
    }

    /// The lazy setter's kind and size, if the flags are lazy.
    pub fn lazy(&self) -> Option<(Kind, bool)> {
        match self.flags {
            Flags::Lazy { kind, sf, .. } => Some((kind, sf)),
            Flags::Mem => None,
        }
    }

    /// Brings the register state to `to` on an edge into a region block
    /// (step 8): writes back what is dirty here but not there, and loads
    /// what is valid there but not here. A register `to` holds dirty in a
    /// shadow alone (the shadow zero-extended) must be so here, in the same
    /// shadow: nothing else makes its upper bits zero. [`Regs::merge`] makes
    /// that form only where every edge has it, and a region whose states
    /// didn't settle drops it ([`Regs::loose`]).
    pub fn conform(&mut self, to: Regs) {
        let mut d = self.regs.dirty & !to.dirty;
        while d != 0 {
            let n = d.trailing_zeros();
            d &= d - 1;
            self.store_cpu(n);
        }
        self.regs.dirty &= to.dirty;
        let ((t32, t64), (h32, h64)) = (to.only(), self.regs.only());
        let dirty = self.regs.dirty & !self.plain;
        debug_assert!(
            to.dirty & (t32 & !(h32 & dirty) | t64 & !(h64 & dirty)) == 0,
            "an edge into a dirty shadow-only form it doesn't hold: {:?} to {to:?}",
            self.regs
        );
        self.reload(to);
    }

    /// Opens a load's or store's failure segment, before its fast path's `if`
    /// ([`Chain`]): in the open chain if every register it stores is still
    /// valid, else in a new one.
    fn chain_open(&mut self, written: u64) {
        let flags = match self.flags {
            Flags::Lazy {
                kind,
                sf,
                current: false,
                ..
            } => Some((kind, sf)),
            _ => None,
        };
        // The registers the chain stores must be in the form its segments
        // store them from; and one this instruction writes that a segment
        // stores from a shadow must come back exactly in it (a failure
        // reloads it from the `Cpu`): a zero-extended write that fits.
        let (o32, o64) = self.regs.only();
        let fits = |ch: &Chain| {
            let v = ch.cum & !(ch.o32 | ch.o64);
            let z = self.vzx;
            let wide = written
                & (if z == 0 || z > 4 { ch.o32 } else { 0 }
                    | if z == 0 || z > 8 { ch.o64 } else { 0 });
            v & !self.regs.valid == 0 && ch.o32 & !o32 == 0 && ch.o64 & !o64 == 0 && wide == 0
        };
        if !matches!(&self.chain, Some(ch) if fits(ch) && ch.flags == flags) {
            self.chain_close();
            self.c.block();
            self.chain = Some(Chain {
                flags,
                ..Chain::default()
            });
        }
        self.c.block_t(I32);
        if let Some(ch) = &mut self.chain {
            ch.segs.push((0, 0, 0));
        }
    }

    /// Closes the open chain, if any, where the code falls through at the
    /// instruction level: it branches past the segments' ends, each storing
    /// its registers, and the shared return of acc + the retired count the
    /// failing site passed.
    pub fn chain_close(&mut self) {
        debug_assert!(self.group.is_none(), "a group open at the chain's close");
        let Some(ch) = self.chain.take() else {
            return;
        };
        self.c.br(ch.segs.len() as u32);
        for &(d, s32, s64) in ch.segs.iter().rev() {
            self.c.end();
            let mut d = d;
            while d != 0 {
                let n = d.trailing_zeros();
                d &= d - 1;
                self.store_as(n, s32 & 1 << n != 0, s64 & 1 << n != 0);
            }
        }
        if let Some((kind, sf)) = ch.flags {
            self.c.local_get(VCPU);
            self.push_nzcv(kind, sf, true);
            self.c.i64_extend_i32_u().i64_store(NZCV);
        }
        self.acc();
        self.c.op(0x6a).return_(); // i32.add
        self.c.end();
    }

    /// Drops the address a load or store `k` computed since `m` (the code's
    /// mark and the registers then) if it follows in a group, whose HOST it
    /// takes ([`access`]), and the code left the registers as they were; BASE
    /// stays set for a writeback.
    fn skip_addr(&mut self, k: usize, rn: u32, wb: bool, m: ((usize, usize, usize), Regs)) {
        let skip = match self.plan.get(k) {
            Some(Role::Follow { .. }) => true,
            Some(Role::Lead { .. }) => self.replay,
            _ => false,
        };
        if !skip || self.regs != m.1 {
            return;
        }
        self.c.rewind(m.0);
        if wb {
            get_sp(self, true, rn);
            self.c.local_set(BASE);
        }
    }

    /// Whether a group is open (the span's instructions are all inline).
    pub fn grouped(&self) -> bool {
        self.group.is_some()
    }

    /// Brings each register `to` holds into the locals it holds it in: the
    /// v128 built from a dirty shadow or loaded, a shadow extracted from the
    /// v128 or loaded (where this side is clean: [`Regs`]).
    fn reload(&mut self, to: Regs) {
        debug_assert!(to.sound());
        let mut m = to.valid & !self.regs.valid;
        while m != 0 {
            let n = m.trailing_zeros();
            m &= m - 1;
            let l = self.local(n);
            if !self.build(n) {
                self.load_cpu(n);
            }
            self.c.local_set(l);
            self.regs.valid |= 1 << n;
        }
        for e in [64, 32] {
            let (want, have) = if e == 64 {
                (to.s64, self.regs.s64)
            } else {
                (to.s32, self.regs.s32)
            };
            let mut m = want & !have;
            while m != 0 {
                let n = m.trailing_zeros();
                m &= m - 1;
                let k = n - 32;
                if self.regs.valid & 1 << n != 0 {
                    let l = self.local[1][k as usize];
                    self.c.local_get(l);
                    // f64x2/f32x4.extract_lane 0
                    self.c.simd_lane(if e == 64 { 0x21 } else { 0x1f }, 0);
                } else {
                    // Not held, or clean in the other shadow (`conform`
                    // stored it): the `Cpu` holds it.
                    debug_assert_eq!(self.regs.dirty & 1 << n, 0);
                    self.load_shadow(k, e);
                }
                self.c.local_set(shadow(k, e));
                if e == 64 {
                    self.regs.s64 |= 1 << n;
                } else {
                    self.regs.s32 |= 1 << n;
                }
            }
        }
    }
}

/// The `k`-th scratch local of the operation size.
fn tmp(sf: bool, k: u32) -> u32 {
    if sf { 2 + k } else { 6 + k }
}

/// Pushes register `n` at the operation size; 31 is XZR.
fn get(c: &mut Func, sf: bool, n: u32) {
    if n == 31 {
        konst(c, sf, 0);
    } else {
        get_sp(c, sf, n);
    }
}

/// Pushes register `n` at the operation size; 31 is SP.
fn get_sp(c: &mut Func, sf: bool, n: u32) {
    c.reg(n);
    if !sf {
        c.i32_wrap_i64();
    }
}

fn konst(c: &mut Func, sf: bool, v: u64) {
    if sf {
        c.i64_const(v as i64);
    } else {
        c.i32_const(v as i32);
    }
}

/// Sets register `rd` to what `value` pushes (at the operation size,
/// zero-extended); 31 is XZR, so nothing is emitted.
fn set(c: &mut Func, sf: bool, rd: u32, value: impl FnOnce(&mut Func)) {
    if rd != 31 {
        set_sp(c, sf, rd, value);
    }
}

/// As [`set`], with 31 as SP.
fn set_sp(c: &mut Func, sf: bool, rd: u32, value: impl FnOnce(&mut Func)) {
    value(c);
    if !sf {
        c.i64_extend_i32_u();
    }
    c.set_reg(rd);
}

/// Pushes the block's entry PC + `off`.
pub fn pc_plus(c: &mut Func, off: i64) {
    let off = off + c.base;
    c.local_get(ENTRY);
    if off != 0 {
        c.i64_const(off).i64_add();
    }
}

/// A function entered at the member `off` bytes after its head: the entry
/// PC (local 1, read from the `Cpu`) becomes the head's.
pub fn enter_at(c: &mut Func, off: i64) {
    c.local_get(ENTRY).i64_const(off).op(0x7d).local_set(ENTRY); // i64.sub
}

/// Stores the entry PC + `off` to `Cpu::pc`.
pub fn set_pc(c: &mut Func, off: i64) {
    c.local_get(VCPU);
    pc_plus(c, off);
    c.i64_store(PC);
}

/// The index of the module's mutable i64 global that holds 0 (parallel SMP
/// only: `Module::zero_global`, defined first).
pub const ZERO_GLOBAL: u32 = 0;

/// Emits instruction `i` (the `k`-th of its block) inline if this step covers
/// it; false (and nothing emitted) if it stays a helper call.
pub fn inline(c: &mut Func, i: u32, op: Op, k: usize, cx: &Ctx) -> bool {
    use Op::*;
    c.ireads = 0;
    c.at = k;
    c.vzx = 0;
    c.pc_in_addr = false;
    let sf = bit(i, 31);
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let here = 4 * k as i64;
    match op {
        ADR => set(c, true, rd, |c| pc_plus(c, here + adr_imm(i) as i64)),
        // (entry + off) & !0xfff = entry + off - (its page offset), known here.
        ADRP => set(c, true, rd, |c| {
            let at = c.page.wrapping_add(c.base).wrapping_add(here) & 0xfff;
            pc_plus(c, (here - at).wrapping_add((adr_imm(i) << 12) as i64));
        }),
        MOVN | MOVZ | MOVK => {
            let hw = bits(i, 22, 21);
            if !sf && hw >= 2 {
                return false;
            }
            let (sh, imm) = (hw * 16, bits(i, 20, 5) as u64);
            match op {
                MOVN => set(c, true, rd, |c| {
                    c.i64_const(trunc(!(imm << sh), sf) as i64);
                }),
                MOVZ => set(c, true, rd, |c| {
                    c.i64_const((imm << sh) as i64);
                }),
                _ => set(c, sf, rd, |c| {
                    get(c, sf, rd);
                    mask(c, sf, !(0xffff << sh));
                    konst(c, sf, imm << sh);
                    arith(c, sf, OR);
                }),
            }
        }
        ADD_imm | ADDS_imm | SUB_imm | SUBS_imm => {
            let imm = bits(i, 21, 10) as u64;
            let imm = match bits(i, 23, 22) {
                0 => imm,
                1 => imm << 12,
                _ => return false,
            };
            addsub(c, i, |c| get_sp(c, sf, rn), |c| konst(c, sf, imm), true);
        }
        // EOR or SUB of a register with itself is zero, but in parallel SMP an
        // address dependency through it must survive (litmus MP+dmb.sy+addr;
        // Linux's arch_counter_enforce_ordering): V8's optimizing tier folds
        // `x ^ x` and `x - x` to 0 and then the host may reorder the loads.
        // `x & ZERO_GLOBAL` is zero, yet V8 can't fold it (jit.md "Atomics").
        EOR_shift | SUB_shift
            if cx.parallel
                && rn == rm
                && rn != 31
                && bits(i, 15, 10) == 0
                && bits(i, 23, 22) != 3 =>
        {
            set(c, sf, rd, |c| {
                get(c, sf, rn);
                c.global_get(ZERO_GLOBAL);
                if !sf {
                    c.i32_wrap_i64();
                }
                arith(c, sf, AND);
            });
        }
        ADD_shift | ADDS_shift | SUB_shift | SUBS_shift => {
            if bits(i, 23, 22) == 3 || (!sf && bits(i, 15, 10) >= 32) {
                return false;
            }
            addsub(c, i, |c| get(c, sf, rn), |c| shifted(c, i), false);
        }
        ADD_ext | ADDS_ext | SUB_ext | SUBS_ext => {
            if bits(i, 12, 10) > 4 {
                return false;
            }
            addsub(c, i, |c| get_sp(c, sf, rn), |c| extended(c, i), true);
        }
        ADC | ADCS | SBC | SBCS => {
            // With S, into the flag locals (after the carry in is read from
            // the current flags); without, into scratch.
            let s = bit(i, 29);
            let (x, y, r) = if s {
                flag_locals(sf)
            } else {
                (tmp(sf, 0), tmp(sf, 1), tmp(sf, 2))
            };
            let cin = if s { FC } else { tmp(false, 3) };
            carry(c);
            c.local_set(cin);
            get(c, sf, rn);
            c.local_set(x);
            get(c, sf, rm);
            if bit(i, 30) {
                konst(c, sf, u64::MAX);
                arith(c, sf, XOR);
            }
            c.local_set(y);
            c.local_get(x).local_get(y);
            arith(c, sf, ADD);
            c.local_get(cin);
            if sf {
                c.i64_extend_i32_u();
            }
            arith(c, sf, ADD);
            c.local_set(r);
            set(c, sf, rd, |c| {
                c.local_get(r);
            });
            if s {
                c.set_flags(Kind::Adc, sf);
            }
        }
        AND_imm | ORR_imm | EOR_imm | ANDS_imm => {
            let n = bits(i, 22, 22);
            if !sf && n == 1 {
                return false;
            }
            let Some((imm, _)) = bit_masks(n, bits(i, 15, 10), bits(i, 21, 16), true) else {
                return false;
            };
            logical(
                c,
                i,
                Some(&|c: &mut Func| get(c, sf, rn)),
                |c| konst(c, sf, imm),
                true,
            );
        }
        AND_shift | BIC_shift | ORR_shift | ORN_shift | EOR_shift | EON | ANDS_shift | BICS => {
            if !sf && bits(i, 15, 10) >= 32 {
                return false;
            }
            let y = |c: &mut Func| {
                shifted(c, i);
                if bit(i, 21) {
                    konst(c, sf, u64::MAX);
                    arith(c, sf, XOR);
                }
            };
            // MOV and MVN: ORR/ORN with XZR.
            let x = |c: &mut Func| get(c, sf, rn);
            let x: Option<&dyn Fn(&mut Func)> = (rn != 31 || bits(i, 30, 29) != 1).then_some(&x);
            logical(c, i, x, y, false);
        }
        SBFM | BFM | UBFM | ASR_1 | ASR_2 | SXTB_1 | SXTB_2 | SXTH_1 | SXTH_2 | SXTW => {
            let (n, immr, imms) = (bits(i, 22, 22), bits(i, 21, 16), bits(i, 15, 10));
            if (sf && n != 1) || (!sf && (n != 0 || immr >= 32 || imms >= 32)) {
                return false;
            }
            let Some((wmask, tmask)) = bit_masks(n, imms, immr, false) else {
                return false;
            };
            let w = if sf { 64 } else { 32 };
            match bits(i, 30, 29) {
                // SBFX/ASR/SXT* (imms >= immr): the field imms:immr, sign-extended;
                // SBFIZ: the field imms:0 sign-extended, shifted left to immr.
                // SXTB, SXTH, SXTW: wasm's sign extensions.
                0 if immr == 0 && (imms == 7 || imms == 15 || (sf && imms == 31)) => {
                    set(c, sf, rd, |c| {
                        get(c, sf, rn);
                        c.op(match (sf, imms) {
                            (false, 7) => 0xc0, // i32.extend8_s
                            (false, _) => 0xc1, // i32.extend16_s
                            (true, 7) => 0xc2,  // i64.extend8_s
                            (true, 15) => 0xc3, // i64.extend16_s
                            _ => 0xc4,          // i64.extend32_s
                        });
                    })
                }
                0 => set(c, sf, rd, |c| {
                    get(c, sf, rn);
                    shift(c, sf, SHL, w - 1 - imms);
                    if imms >= immr {
                        shift(c, sf, SHR_S, w - 1 - imms + immr);
                    } else {
                        shift(c, sf, SHR_S, w - 1 - imms);
                        shift(c, sf, SHL, w - immr);
                    }
                }),
                // BFM: Rd with the rotated source inserted, as the pseudocode.
                1 => set(c, sf, rd, |c| {
                    let d = tmp(sf, 0);
                    get(c, sf, rd);
                    c.local_tee(d);
                    mask(c, sf, !wmask);
                    get(c, sf, rn);
                    shift(c, sf, ROTR, immr);
                    mask(c, sf, wmask);
                    arith(c, sf, OR);
                    mask(c, sf, tmask);
                    c.local_get(d);
                    mask(c, sf, !tmask);
                    arith(c, sf, OR);
                }),
                // UBFM: the rotated source under both masks (LSL, LSR, UBFX, UXT*).
                // LSR: the source shifted right, no mask.
                2 if imms == w - 1 => set(c, sf, rd, |c| {
                    get(c, sf, rn);
                    shift(c, sf, SHR_U, immr);
                }),
                // LSL: the source shifted left, no mask.
                2 if imms + 1 == immr => set(c, sf, rd, |c| {
                    get(c, sf, rn);
                    shift(c, sf, SHL, w - immr);
                }),
                2 => set(c, sf, rd, |c| {
                    get(c, sf, rn);
                    shift(c, sf, ROTR, immr);
                    mask(c, sf, wmask & tmask);
                }),
                _ => return false,
            }
        }
        EXTR => {
            let lsb = bits(i, 15, 10);
            if bit(i, 22) != sf || (!sf && lsb >= 32) {
                return false;
            }
            let w = if sf { 64 } else { 32 };
            set(c, sf, rd, |c| {
                get(c, sf, rm);
                if lsb != 0 {
                    shift(c, sf, SHR_U, lsb);
                    get(c, sf, rn);
                    shift(c, sf, SHL, w - lsb);
                    arith(c, sf, OR);
                }
            });
        }
        // CSET and CSETM: the condition's inverse as 1 or all ones.
        CSINC | CSINV if rn == 31 && rm == 31 => set(c, sf, rd, |c| {
            cond(c, bits(i, 15, 12));
            if op == CSINC {
                c.op(0x45); // i32.eqz
                if sf {
                    c.i64_extend_i32_u();
                }
            } else {
                // cond - 1: 0 or all ones.
                c.op(0x45).op(0x45);
                if sf {
                    c.i64_extend_i32_u();
                }
                konst(c, sf, 1);
                arith(c, sf, SUB);
            }
        }),
        CSEL | CSINC | CSINV | CSNEG => set(c, sf, rd, |c| {
            get(c, sf, rn);
            if op == CSNEG {
                konst(c, sf, 0);
            }
            get(c, sf, rm);
            match op {
                CSINC => {
                    konst(c, sf, 1);
                    arith(c, sf, ADD);
                }
                CSINV => {
                    konst(c, sf, u64::MAX);
                    arith(c, sf, XOR);
                }
                CSNEG => arith(c, sf, SUB),
                _ => {}
            }
            cond(c, bits(i, 15, 12));
            c.select();
        }),
        CCMN_reg | CCMP_reg | CCMN_imm | CCMP_imm => {
            // NZCV = cond ? AddWithCarry's flags : nzcv (3:0).
            let sub = bit(i, 30);
            c.local_get(VCPU);
            let y = |c: &mut Func| {
                if bit(i, 11) {
                    konst(c, sf, rm as u64);
                } else {
                    get(c, sf, rm);
                }
            };
            let (tx, ty, tr) = (tmp(sf, 0), tmp(sf, 1), tmp(sf, 2));
            get(c, sf, rn);
            c.local_set(tx);
            y(c);
            c.local_set(ty);
            c.local_get(tx).local_get(ty);
            arith(c, sf, if sub { SUB } else { ADD });
            c.local_set(tr);
            if sub {
                sub_nzcv(c, sf, tx, ty, tr);
            } else {
                add_nzcv(c, sf, tx, ty, tr, Carry::Zero);
            }
            c.i32_const((bits(i, 3, 0) << 28) as i32);
            cond(c, bits(i, 15, 12));
            c.select().i64_extend_i32_u().i64_store(NZCV);
            c.retire_flags();
        }
        // Branches end their block: they store the PC, and the block returns.
        B_uncond | BL => {
            if op == BL {
                set(c, true, 30, |c| pc_plus(c, here + 4));
            }
            if !c.defer_pc {
                set_pc(c, here + sext((bits(i, 25, 0) << 2) as u64, 28) as i64);
            }
        }
        B_cond | CBZ | CBNZ | TBZ | TBNZ => {
            let off = match op {
                TBZ | TBNZ => sext((bits(i, 18, 5) << 2) as u64, 16),
                _ => sext((bits(i, 23, 5) << 2) as u64, 21),
            };
            if !c.defer_pc {
                c.local_get(VCPU);
                pc_plus(c, here + off as i64);
                pc_plus(c, here + 4);
            }
            match op {
                B_cond => cond(c, bits(i, 3, 0)),
                CBZ | CBNZ => {
                    get(c, sf, rd);
                    cmp(c, sf, EQZ);
                    if op == CBNZ {
                        c.op(EQZ);
                    }
                }
                _ => {
                    let b = (bits(i, 31, 31) << 5) | bits(i, 23, 19);
                    get(c, true, rd);
                    mask(c, true, 1 << b);
                    cmp(c, true, EQZ);
                    if op == TBNZ {
                        c.op(EQZ);
                    }
                }
            }
            // The outcome, for the block's chaining to the successor (step 7).
            if c.defer_pc {
                c.local_set(TAKEN);
            } else {
                c.local_tee(TAKEN).select().i64_store(PC);
            }
        }
        // The target stays in ADDR for `indirect`, which then needn't load
        // the PC back (V8 doesn't forward the store).
        BR | BLR | RET => {
            c.local_get(VCPU);
            get(c, true, rn);
            c.local_tee(ADDR).i64_store(PC);
            c.pc_in_addr = true;
            if op == BLR {
                set(c, true, 30, |c| pc_plus(c, here + 4));
            }
        }
        // Hints that are NOPs here (docs/cpu.md) and don't end a block.
        NOP | HINT | XPAC_2 | PACIA_2 | PACIB_2 | AUTIA_2 | AUTIB_2 | BTI | ESB | PSB | TSB
        | CSDB | DGH => {}
        // FEAT_SB: a NOP, as in the interpreter.
        SB if cx.features & crate::cpu::FEATURE_SB != 0 => {}
        // FEAT_LRCPC: LDAPR* as LDAR (the same fields: size 31:30, Rn, Rt).
        LDAPRB | LDAPRH | LDAPR if cx.features & crate::cpu::FEATURE_RCPC != 0 => {
            return ldst(c, cx, i, LDAR, k);
        }
        // FEAT_LRCPC2: LDAPUR* and STLUR* as LDAR and STLR at base + imm9.
        STLUR_gen | LDAPUR_gen | LDAPURS_gen if crate::cpu::has_rcpc2(cx.features) => {
            return ldst(c, cx, i, op, k);
        }
        // Barriers order nothing for vCPUs sharing a thread (one vCPU or
        // round-robin), and don't end a block. In parallel SMP every flavor is
        // a full fence (`dmb ish` on arm64; stronger than DMB LD/ST need), and
        // DSB is the helper's (it ends the chunk).
        DSB if cx.parallel => return false,
        DMB | SSBB | PSSBB if cx.parallel => {
            c.atomic_fence();
        }
        DMB | DSB | SSBB | PSSBB => {}
        // ISB likewise (the interpreter's does nothing there); it still ends
        // the block (`block::end`). In parallel SMP it's the helper's, which ends
        // the chunk unless finished in place (`jit::State::fast`).
        ISB if !cx.parallel => {}
        MRS => return mrs(c, cx, i, k),
        MSR_reg | MSR_imm => return msr(c, cx, i, k),
        MADD | MSUB => set(c, sf, rd, |c| {
            get(c, sf, bits(i, 14, 10));
            get(c, sf, rn);
            get(c, sf, rm);
            arith(c, sf, MUL);
            arith(c, sf, if op == MADD { ADD } else { SUB });
        }),
        SMADDL | SMSUBL | UMADDL | UMSUBL => set(c, true, rd, |c| {
            // Wn and Wm extended (i64.extend_i32_s or _u), multiplied, into Xa.
            let ext = if matches!(op, SMADDL | SMSUBL) {
                0xac
            } else {
                0xad
            };
            get(c, true, bits(i, 14, 10));
            get(c, false, rn);
            c.op(ext);
            get(c, false, rm);
            c.op(ext);
            arith(c, true, MUL);
            arith(c, true, if bit(i, 15) { SUB } else { ADD });
        }),
        SMULH | UMULH => set(c, true, rd, |c| mulh(c, op == SMULH, rn, rm)),
        UDIV | SDIV => set(c, sf, rd, |c| {
            // x / 0 is 0, and INT_MIN / -1 wraps (wasm traps on both).
            let (x, y) = (tmp(sf, 0), tmp(sf, 1));
            get(c, sf, rn);
            c.local_set(x);
            get(c, sf, rm);
            c.local_tee(y);
            cmp(c, sf, EQZ);
            let ty = if sf { I64 } else { I32 };
            c.hint(false).if_t(ty);
            konst(c, sf, 0);
            c.else_();
            if op == SDIV {
                c.local_get(y);
                konst(c, sf, u64::MAX);
                cmp(c, sf, EQ);
                c.hint(false).if_t(ty);
                konst(c, sf, 0);
                c.local_get(x);
                arith(c, sf, SUB);
                c.else_();
            }
            c.local_get(x).local_get(y);
            arith(c, sf, if op == SDIV { DIV_S } else { DIV_U });
            if op == SDIV {
                c.end();
            }
            c.end();
        }),
        RBIT_int => set(c, sf, rd, |c| {
            get(c, sf, rn);
            swap(c, sf, 1, 0x5555_5555_5555_5555);
            swap(c, sf, 2, 0x3333_3333_3333_3333);
            swap(c, sf, 4, 0x0f0f_0f0f_0f0f_0f0f);
            bswap(c, sf);
        }),
        REV16_int => set(c, sf, rd, |c| {
            get(c, sf, rn);
            swap(c, sf, 8, 0x00ff_00ff_00ff_00ff);
        }),
        // Bytes reversed in each word, at 64 bits whatever sf says (as the interpreter).
        REV32_int => set(c, true, rd, |c| {
            get(c, true, rn);
            swap(c, true, 8, 0x00ff_00ff_00ff_00ff);
            swap(c, true, 16, 0x0000_ffff_0000_ffff);
        }),
        REV => {
            if sf != bit(i, 10) {
                return false;
            }
            set(c, sf, rd, |c| {
                get(c, sf, rn);
                bswap(c, sf);
            });
        }
        CLZ_int => set(c, sf, rd, |c| {
            get(c, sf, rn);
            arith(c, sf, CLZ);
        }),
        CLS_int => set(c, sf, rd, |c| {
            // clz((x ^ x >> 1) & MAX >> 1) - 1
            let x = tmp(sf, 0);
            get(c, sf, rn);
            c.local_tee(x).local_get(x);
            shift(c, sf, SHR_U, 1);
            arith(c, sf, XOR);
            mask(c, sf, u64::MAX >> 1 >> if sf { 0 } else { 32 });
            arith(c, sf, CLZ);
            konst(c, sf, 1);
            arith(c, sf, SUB);
        }),
        LDR_lit_gen | LDRSW_lit | PRFM_lit | PRFM_imm | PRFM_unscaled_imm | STRx_LDRx_imm_2
        | STURx_LDURx | STRx_reg | LDRx_reg | STRx_LDRx_imm_1 | STP_LDP_gen | STNP_LDNP_gen
        | LDAR | STLR | DC_ZVA | STTRB | LDTRB | LDTRSB | STTRH | LDTRH | LDTRSH | STTR | LDTR
        | LDTRSW | LDXR | LDAXR | STXR | STLXR | LDXP | LDAXP | STXP | STLXP | CAS | CASB
        | CASH | LDADDB | LDCLRB | LDEORB | LDSETB | SWPB | LDADDH | LDCLRH | LDEORH | LDSETH
        | SWPH | LDADD | LDCLR | LDEOR | LDSET | SWP | CASP => {
            return ldst(c, cx, i, op, k);
        }
        LDR_lit_fpsimd | STP_LDP_fpsimd | STNP_LDNP_fpsimd | STR_imm_fpsimd_2
        | LDR_imm_fpsimd_2 | STUR_fpsimd | LDUR_fpsimd | STR_imm_fpsimd_1 | LDR_imm_fpsimd_1
        | STR_reg_fpsimd | LDR_reg_fpsimd => return ldst_fp(c, cx, i, op, k),
        LDx_mult_1 | LDx_mult_2 | STx_mult_1 | STx_mult_2 => {
            return ld1_st1(c, cx, i, k) || ldn_stn(c, cx, i, k);
        }
        LD1_sngl_1 | LD1_sngl_2 | ST1_sngl_1 | ST1_sngl_2 | LD2_sngl_1 | LD2_sngl_2
        | ST2_sngl_1 | ST2_sngl_2 | LD3_sngl_1 | LD3_sngl_2 | ST3_sngl_1 | ST3_sngl_2
        | LD4_sngl_1 | LD4_sngl_2 | ST4_sngl_1 | ST4_sngl_2 => return ld1_st1_lane(c, cx, i, k),
        LD1R_1 | LD1R_2 | LD2R_1 | LD2R_2 | LD3R_1 | LD3R_2 | LD4R_1 | LD4R_2 => {
            return ldnr(c, cx, i, k);
        }
        // The shift amount is Rm modulo the width, as wasm shifts take it.
        CRC32 | CRC32C => return crc32(c, i, op == CRC32),
        LSLV | LSRV | ASRV | RORV => set(c, sf, rd, |c| {
            get(c, sf, rn);
            get(c, sf, rm);
            arith(c, sf, [SHL, SHR_U, SHR_S, ROTR][bits(i, 11, 10) as usize]);
        }),
        // AdvSIMD and SIMD&FP moves (M6 loop 4), after the block's FP check;
        // nothing emitted for the rest.
        _ => {
            let snap = (
                c.c.mark(),
                c.flags,
                c.touched,
                c.fp_ok,
                (c.fpa_ok, c.fp16_ok),
                c.regs,
            );
            let chain = c.chain.clone();
            fp_guard(c, cx, i, k);
            if !(cx.crypto && crypto::inline(c, i, op))
                && !(cx.sha3 && crypto::inline_sha3(c, i, op))
                && !(cx.features & crate::cpu::FEATURE_DOTPROD != 0 && simd::inline_dot(c, i, op))
                && !(cx.features & crate::cpu::FEATURE_I8MM != 0 && simd::inline_i8mm(c, i, op))
                && !(cx.features & crate::cpu::FEATURE_RDM != 0
                    && (simd::inline_rdm(c, i, op) || simd_lane::inline_rdm(c, i, op)))
                && !(cx.features & crate::cpu::FEATURE_FP16 != 0 && half::inline(c, cx, i, op, k))
                && !(crate::cpu::has_fhm(cx.features) && half::fhm(c, cx, i, op, k))
                && !(cx.features & crate::cpu::FEATURE_BF16 != 0 && bf16::inline(c, cx, i, op, k))
                && !simd::inline(c, i, op)
                && !simd_lane::inline(c, i, op)
                && !float::inline(c, cx, i, op, k)
                && !float::vector(c, cx, i, op, k)
            {
                let (mark, flags, touched, fp_ok, (fpa_ok, fp16_ok), regs) = snap;
                c.c.rewind(mark);
                (c.flags, c.touched, c.fp_ok, c.fpa_ok, c.fp16_ok, c.regs) =
                    (flags, touched, fp_ok, fpa_ok, fp16_ok, regs);
                c.chain = chain;
                return false;
            }
        }
    }
    true
}

/// How a block's inline loads and stores reach guest RAM, and the helper that
/// re-executes an instruction whose fast path doesn't apply.
#[derive(Clone, Copy, Debug)]
pub struct Ctx {
    pub helper: u32,
    pub bus: Bus,
    /// The block runs at EL1 (its key says; else EL0).
    pub el1: bool,
    /// The vCPU has the crypto extensions (`cpu::FEATURE_CRYPTO`, fixed for its
    /// life): without them the helper runs those words (UNDEFINED).
    pub crypto: bool,
    /// The vCPU has FEAT_SHA512 and FEAT_SHA3 (`cpu::has_sha3`, fixed for its
    /// life): without them the helper runs those words (UNDEFINED).
    pub sha3: bool,
    /// The vCPU has FEAT_JSCVT (`cpu::FEATURE_JSCVT`, fixed for its life):
    /// without it the helper runs `FJCVTZS` (UNDEFINED).
    pub jscvt: bool,
    /// The vCPU's features (`cpu::FEATURE_*`, fixed for its life), for the
    /// instructions that have no flag of their own above: without one, the
    /// helper runs its words (UNDEFINED).
    pub features: u64,
    /// The host's relaxed-SIMD `madd` fuses (`jit::Config::fma`): the FMA forms use it ([`float`]).
    pub fma: bool,
    /// Parallel SMP (`cpu::FEATURE_PARALLEL`): DSB is the helper's, which
    /// ends the chunk there.
    pub parallel: bool,
    /// The wasm address of the RAM's pair locks ([`crate::mem::Mem::pair_locks`]),
    /// which CASP takes in parallel SMP.
    pub pair_locks: u32,
    /// The host clock (`env.now_ms`, imported by a parallel SMP module with a
    /// counter read): CNTVCT and CNTPCT read inline ([`counter`]).
    pub clock: Option<u32>,
    /// Spill memories 1 to `spill` have a load's or store's arm inline
    /// ([`access`]): the module imports them as memories 1 to `spill`.
    pub spill: u32,
    /// Accesses off one base share a TLB probe ([`plan`]; with the MMU on).
    pub groups: bool,
    /// The span helper (`jit_exec_span`), for a group's cold arm ([`close`]).
    pub span: u32,
}

#[derive(Clone, Copy, Debug)]
pub enum Bus {
    /// MMU and alignment checks off (VA = PA): `size` bytes of RAM at guest
    /// PA `phys`, at `base` in the wasm memory.
    Flat { base: u32, phys: u64, size: u64 },
    /// MMU on, alignment checks off: the TLB's read array for the block's EL
    /// at this offset in the `Vcpu` (its write array follows).
    Tlb { read: u32 },
}

/// The end of a block that branched to a register (BR, BLR, RET; step 7), or
/// a by-VA link: the compiled block for the PC. With the MMU on it's in the
/// vCPU's transfer cache (`mmu::Tlb::xc`), keyed by the VA and `regime` (the
/// key's low bits); on a miss, the block tail-calls `miss` (the cache's
/// [`xmiss`] for the regime, imported) with this block retired. With the MMU off
/// (`miss` is `None`) it's in the jump cache ([`JC_PTR`]), by its key (the PC and
/// `regime`). If it's there and `left` covers this block's `len` and its
/// length, tail-calls it through the table (type `ty`), after `check` (the
/// stale-code checker) if given. Otherwise falls through (to the block's
/// return). The PC is the `Cpu`'s, or ADDR's when the branch left it there
/// ([`Func::pc_in_addr`]). Polled code checks no `left`: it [`poll`]s if
/// `poll` (a branch to a register, a by-VA link backward) instead.
#[allow(clippy::too_many_arguments)]
pub fn indirect(
    c: &mut Func,
    regime: u64,
    miss: Option<u32>,
    len: u32,
    ty: u32,
    check: Option<u32>,
    x: Xfer,
    poll: bool,
) {
    const KEY: u32 = BASE; // i64 scratch
    if core::mem::take(&mut c.pc_in_addr) {
        c.local_get(ADDR);
    } else {
        c.local_get(VCPU).i64_load(PC).local_tee(ADDR);
    }
    c.i64_const(3).op(AND + W).op(EQZ + WC); // aligned
    if let Some(miss) = miss {
        via_xc(c, regime, len, ty, check, x, poll);
        // A miss is a tail call even in a call (rare once the cache is warm).
        transfer(c, Xfer::Tail, len, ty, To::Func(miss, 0), 0);
        return;
    }
    c.local_get(ADDR);
    if regime != 0 {
        c.i64_const(regime as i64).op(OR + W);
    }
    c.local_set(KEY);
    via_jc(c, None, len, ty, check, x, poll);
}

/// How a block leaves for another function: a tail call, or for a guest
/// call below [`MAX_DEPTH`] a host call ([`DEPTH`]) whose result goes to
/// [`RESULT`], followed by a `br` to the label this many levels out from
/// where the transfer's probe starts (where the caller handles the result);
/// at the limit, a tail call.
#[derive(Clone, Copy)]
pub enum Xfer {
    Tail,
    Call(u32),
}

/// What a transfer goes to: a function, or the table index in the low half
/// of an i64 local, or an i32 loaded from an i32 local plus an offset (a
/// jump or transfer cache entry's word: the table index, and the entry at
/// [`super::ENTRY_SHIFT`]); a function is entered at entry `.1`.
#[derive(Clone, Copy)]
pub enum To {
    Func(u32, u32),
    Wrap(u32),
    Load(u32, u32),
}

impl To {
    /// Pushes the cache entry's word.
    fn word(self, c: &mut Func) {
        match self {
            To::Func(..) => {}
            To::Wrap(l) => {
                c.local_get(l).i32_wrap_i64();
            }
            To::Load(l, o) => {
                c.local_get(l).i32_load(o);
            }
        }
    }
}

/// Pushes a transfer's arguments: the vCPU, `acc` and `left` with this
/// block's `len` retired (`left` 0 in polled code), and the depth plus
/// `deeper` with the entry of `to` above [`ENTRY_BIT`]; then the table index
/// for an indirect transfer.
fn args(c: &mut Func, len: u32, deeper: bool, to: To) {
    c.local_get(VCPU);
    c.acc();
    c.i32_const(len as i32).op(ADD);
    if c.polled {
        c.i32_const(0);
    } else {
        c.local_get(LEFT).i32_const(len as i32).op(SUB);
    }
    c.local_get(DEPTH);
    if deeper {
        c.i32_const(1).op(ADD);
    }
    match to {
        To::Func(_, 0) => {}
        To::Func(_, e) => {
            c.i32_const((e << ENTRY_BIT) as i32).op(OR);
        }
        _ => {
            // (word >> ENTRY_SHIFT) << ENTRY_BIT
            to.word(c);
            c.i32_const((super::ENTRY_SHIFT - ENTRY_BIT) as i32)
                .op(SHR_U);
            c.i32_const(!((1 << ENTRY_BIT) - 1)).op(AND).op(OR);
            to.word(c);
            c.i32_const(super::IDX_MASK as i32).op(AND);
        }
    }
}

/// The transfer of a block of `len` to `to` (`ty`: the block type); `inner`:
/// the blocks opened since the probe started.
pub fn transfer(c: &mut Func, x: Xfer, len: u32, ty: u32, to: To, inner: u32) {
    if let Xfer::Call(label) = x {
        c.local_get(DEPTH)
            .i32_const(MAX_DEPTH as i32)
            .op(LT_U)
            .hint(true)
            .if_();
        dbump(c, crate::tally::HOST_CALL);
        args(c, len, true, to);
        match to {
            To::Func(f, _) => c.call(f),
            _ => c.call_indirect(ty),
        };
        c.local_set(RESULT).br(label + inner + 1).end();
    }
    args(c, len, false, to);
    match to {
        To::Func(f, _) => c.return_call(f),
        _ => c.return_call_indirect(ty),
    };
}

/// Where a function's entry number sits in its [`DEPTH`] parameter: a
/// region entered at a member other than its head (a call's continuation,
/// docs/jit.md "Calls") gets it there, and clears it.
pub const ENTRY_BIT: u32 = 16;

/// A `ret` at a depth above 0 (a host call's, [`DEPTH`]): returns the
/// block's retired count with [`RETURNED`] (the PC is in the `Cpu`).
///
/// Polled code polls there first: a callee's return lands back in its caller
/// with no transfer, so calls forward to the same callee from a run of call
/// sites, nested, would run steps multiplying with the depth and never poll
/// (docs/jit.md "Preemption"). A failed poll returns the count without
/// [`RETURNED`] (stopped, the PC the return's target), so every caller
/// returns it in turn to the dispatcher.
pub fn ret_up(c: &mut Func, len: u32) {
    c.local_get(DEPTH).if_();
    dbump(c, crate::tally::HOST_RET);
    if c.polled {
        poll(c, false);
        c.hint(true).if_();
    }
    c.acc();
    c.i32_const(len as i32).op(ADD);
    c.i32_const(RETURNED as i32).op(OR).return_();
    if c.polled {
        c.end();
        c.acc();
        c.i32_const(len as i32).op(ADD).return_();
    }
    c.end();
}

/// After a guest call's host call ([`Xfer::Call`]), with its result in
/// [`RESULT`]: opens an `if` the callee returned ([`RETURNED`]), in which it
/// sets `acc` and `left` to what they'd be at the calling block's entry
/// (`len`: its length) had the callee's steps been the caller's, so the code
/// after can retire the block again, and leaves an i32 on the stack, non-zero
/// iff the PC is the entry PC + `off` (the call's continuation). [`unreturned`]
/// closes it.
pub fn returned(c: &mut Func, len: u32, off: i64) {
    c.local_get(RESULT).i32_const(0).op(LT_S).hint(true).if_();
    // left += acc - (result - len); acc = result - len, the flag dropped.
    c.local_get(RESULT).i32_const(!RETURNED as i32).op(AND);
    c.i32_const(len as i32).op(SUB).local_set(RESULT);
    if c.sum {
        // acc + left stays SUM.
        c.local_get(SUM).local_get(RESULT).op(SUB).local_set(LEFT);
    } else {
        // Polled code reads no `left`: `acc` alone.
        if !c.polled {
            c.local_get(LEFT).local_get(ACC).op(ADD);
            c.local_get(RESULT).op(SUB).local_set(LEFT);
        }
        c.local_get(RESULT).local_set(ACC);
    }
    c.local_get(VCPU).i64_load(PC);
    pc_plus(c, off);
    c.op(EQ + WC);
}

/// Closes [`returned`]'s `if` (whose code returned) and returns the callee's
/// result: it stopped (an exit, the budget, a block not compiled), so every
/// caller does.
pub fn unreturned(c: &mut Func) {
    c.end();
    c.local_get(RESULT).return_();
}

/// The transfer cache probe of [`indirect`], for the VA in `ADDR` and an i32
/// condition on the stack: the entry's tag, its generation and its length
/// (polled code: the [`poll`] if `poll`).
fn via_xc(c: &mut Func, regime: u64, len: u32, ty: u32, check: Option<u32>, x: Xfer, poll: bool) {
    const TO: u32 = BASE; // i64 scratch
    // The entry, `vcpu + XC + ((va >> 2) & (XC_ENTRIES - 1)) * 16`.
    xc_entry(c);
    c.i64_load(XC_LO);
    c.local_get(ADDR);
    if regime != 0 {
        c.i64_const(regime as i64).op(OR + W);
    }
    c.op(EQ + WC).op(AND);
    c.local_get(TLBE).i64_load(XC_LO + 8).local_tee(TO);
    c.i64_const(48).op(SHR_U + W);
    c.local_get(VCPU).i64_load(xgen(regime)).op(EQ + WC).op(AND);
    if c.polled {
        if poll {
            self::poll(c, false);
            c.op(AND);
        }
    } else {
        // left >= len + its length
        c.local_get(LEFT);
        c.local_get(TO).i64_const(32).op(SHR_U + W).i32_wrap_i64();
        c.i32_const(0xffff).op(AND).i32_const(len as i32).op(ADD);
        c.op(GE_U).op(AND);
    }
    c.hint(true).if_();
    dhit(c, crate::tally::XC_HIT);
    if let Some(chk) = check {
        c.local_get(VCPU).i64_const(-1).call(chk);
    }
    transfer(c, x, len, ty, To::Wrap(TO), 1);
    c.end();
}

/// The `Vcpu` offsets of the pointers to its table's jump cache and hot words
/// (`jit::State`): a module reads them there, so its bytes are the same for
/// every table it's installed in (docs/jit.md "Sharing").
pub const JC_PTR: u32 = (offset_of!(Vcpu, jit) + offset_of!(super::State, jc)) as u32;
pub const HOT_PTR: u32 = (offset_of!(Vcpu, jit) + offset_of!(super::State, hot)) as u32;
/// The `Vcpu` offset of its stop word (`jit::State::stop`).
pub const STOP: u32 = (offset_of!(Vcpu, jit) + offset_of!(super::State, stop)) as u32;

/// Polled code's check where a cycle can close (docs/jit.md "Preemption"):
/// pushes an i32, non-zero while `acc` is under the vCPU's stop word (the run
/// loop stores the chunk's steps there, and whatever has news for the vCPU
/// stores 0, so the transfer isn't taken and the block returns to the
/// dispatcher). Points: a region's edges and static chains to a VA at or
/// before their block's start (every cycle of static transfers to fixed
/// targets has one), branches to a register (the transfer cache's probe, the
/// MMU-off jump cache's), every by-VA link, a host call's return ([`ret_up`])
/// and the transfer cache's miss function.
///
/// `fresh`: an `i32.atomic.load`, for the edges of a looped region (one is on
/// every lap of its wasm `loop`); elsewhere a plain `i32.load`, at a transfer
/// that leaves the function's invocation when the poll passes. The memory
/// model lets V8 merge racy plain reads, and it does inside a loop (across its
/// unrolled laps, or out of it altogether), but it reads memory again in each
/// invocation and after every call; an atomic load costs an alignment check,
/// an address add and an acquire besides (PERF loop 34: per function arm64
/// −1.4% instructions, x64 −2.1%). A read gone stale can only be the chunk's
/// steps or 0, so the chunk's bound holds whatever V8 merges.
pub fn poll(c: &mut Func, fresh: bool) {
    const I32_ATOMIC_LOAD: u8 = 0x10;
    dbump(c, crate::tally::POLL);
    c.acc();
    c.local_get(VCPU);
    if fresh {
        c.atomic(I32_ATOMIC_LOAD, 2, STOP);
    } else {
        c.i32_load(STOP);
    }
    c.op(LT_U);
}

/// The transfer cache's offset in the `Vcpu`, split: [`xc_entry`] ORs the
/// high part (a multiple of the cache's size) into the entry's index, and its
/// loads take the low part, small enough for V8 to fold into them.
const XC: u32 = (offset_of!(Vcpu, tlb) + offset_of!(Tlb, xc)) as u32;
const XC_SIZE: u32 = (XC_ENTRIES * 16) as u32;
pub const XC_LO: u32 = XC % XC_SIZE;
const _: () = assert!(XC_SIZE.is_power_of_two() && XC_LO < 0x1000);

/// The `Vcpu` offset of the transfer cache generation of `regime`'s EL.
fn xgen(regime: u64) -> u32 {
    (offset_of!(Vcpu, tlb) + offset_of!(Tlb, xgen)) as u32 + 8 * (regime as u32 & 1)
}

/// Pushes the `Vcpu`-relative address of the VA in `ADDR`'s transfer cache
/// entry less [`XC_LO`] (the offset its loads take), keeping it in `TLBE`.
fn xc_entry(c: &mut Func) {
    c.local_get(ADDR).i32_wrap_i64().i32_const(2).op(SHL);
    c.i32_const((XC_ENTRIES as i32 - 1) << 4).op(AND);
    c.i32_const((XC - XC_LO) as i32).op(OR);
    c.local_get(VCPU).op(ADD).local_tee(TLBE);
}

/// A transfer cache miss in `regime` (MMU on), a function of a block's type
/// that a JIT cache has one of per regime (`block::miss_module`; [`indirect`]
/// tail-calls it, with the block retired): finds the PC's
/// block as the dispatcher would, through the instruction TLB of the
/// regime's EL (`tlb`: its array, and RAM's host base and guest PA) and the
/// jump cache ([`JC_PTR`]), and if it's there and `left` covers it (`polled`:
/// its [`poll`] passes), fills the entry and tail-calls the block (after
/// `check`). Otherwise returns `acc`.
pub fn xmiss(regime: u64, tlb: (u32, u64, u64), ty: u32, check: Option<u32>, polled: bool) -> Func {
    const KEY: u32 = BASE; // i64 scratch
    const JCE: u32 = HOST; // i32 scratch
    let mut c = Func {
        polled,
        ..Func::default()
    };
    let (arr, base, phys) = tlb;
    dbump(&mut c, crate::tally::XC_MISS);
    c.local_get(VCPU).i64_load(PC).local_tee(ADDR);
    c.i64_const(3).op(AND + W).op(EQZ + WC); // aligned
    c.local_get(ADDR);
    tlb_entry(&mut c);
    c.i64_load(arr);
    c.local_get(ADDR)
        .i64_const(0xfff)
        .op(OR + W)
        .op(EQ + WC)
        .op(AND);
    // key = host - base + phys | regime, host = addend + VA
    c.local_get(TLBE)
        .i64_load(arr + 8)
        .local_get(ADDR)
        .i64_add();
    c.i64_const(phys.wrapping_sub(base) as i64).i64_add();
    c.i64_const(regime as i64).op(OR + W).local_set(KEY);
    // The jump cache entry, `jc + ((key >> 2) & (JC - 1)) * 16`.
    c.local_get(KEY).i32_wrap_i64().i32_const(2).op(SHL);
    c.i32_const((super::JC as i32 - 1) << 4).op(AND);
    c.local_get(VCPU)
        .i32_load(JC_PTR)
        .op(ADD)
        .local_tee(JCE)
        .i64_load(0);
    c.local_get(KEY).op(EQ + WC).op(AND);
    if polled {
        poll(&mut c, false);
    } else {
        c.local_get(LEFT).local_get(JCE).i32_load(12).op(GE_U);
    }
    c.op(AND);
    c.hint(true).if_();
    // The entry: tag, then idx | len << 32 | gen << 48.
    xc_entry(&mut c);
    c.local_get(ADDR)
        .i64_const(regime as i64)
        .op(OR + W)
        .i64_store(XC_LO);
    c.local_get(TLBE);
    c.local_get(JCE).i64_load(8); // idx, len
    c.local_get(VCPU)
        .i64_load(xgen(regime))
        .i64_const(48)
        .op(SHL + W)
        .op(OR + W);
    c.i64_store(XC_LO + 8);
    if let Some(chk) = check {
        c.local_get(VCPU).local_get(KEY).call(chk);
    }
    transfer(&mut c, Xfer::Tail, 0, ty, To::Load(JCE, 8), 1);
    c.end();
    c.local_get(ACC).end();
    c
}

/// The jump-cache tail of [`indirect`], also for a static successor that
/// wasn't compiled when this block was (`key`: its key; else the key is in
/// the i64 scratch local). With an i32 condition on the stack, tail-calls the
/// block the entry holds if the condition holds, its key matches and `left`
/// covers both blocks (polled code: its [`poll`] passes if `poll`);
/// otherwise falls through.
pub fn via_jc(
    c: &mut Func,
    key: Option<u64>,
    len: u32,
    ty: u32,
    check: Option<u32>,
    x: Xfer,
    poll: bool,
) {
    const KEY: u32 = BASE; // i64 scratch
    const JCE: u32 = HOST; // i32 scratch
    match key {
        // The entry's offset, `((key >> 2) & (JC - 1)) * 16`, in one shift and mask.
        None => {
            c.local_get(KEY).i32_wrap_i64().i32_const(2).op(SHL);
            c.i32_const((super::JC as i32 - 1) << 4).op(AND);
            c.local_get(VCPU)
                .i32_load(JC_PTR)
                .op(ADD)
                .local_tee(JCE)
                .i64_load(0)
                .local_get(KEY);
        }
        Some(k) => {
            let e = (((k >> 2) as u32) & (super::JC as u32 - 1)) * 16;
            c.local_get(VCPU).i32_load(JC_PTR).i32_const(e as i32);
            c.op(ADD).local_tee(JCE).i64_load(0).i64_const(k as i64);
        }
    }
    c.op(EQ + WC).op(AND);
    if c.polled {
        if poll {
            self::poll(c, false);
            c.op(AND);
        }
    } else {
        // left >= len + its length
        c.local_get(LEFT)
            .local_get(JCE)
            .i32_load(12)
            .i32_const(len as i32)
            .op(ADD);
        c.op(GE_U).op(AND);
    }
    c.hint(true).if_();
    dhit(c, crate::tally::JC_HIT);
    if let Some(chk) = check {
        c.local_get(VCPU);
        match key {
            Some(k) => c.i64_const(k as i64),
            None => c.local_get(KEY),
        };
        c.call(chk);
    }
    transfer(c, x, len, ty, To::Load(JCE, 8), 1);
    c.end();
}

/// Pushes an i32 that is non-zero iff X30 is the entry PC + `off`: a return
/// that goes where the region predicted (`block::Region::returns`).
pub fn returns_to(c: &mut Func, off: i64) {
    c.reg(30);
    pc_plus(c, off);
    c.op(EQ + WC);
}

/// The tier-up prologue of a loop head compiled alone (step 8.3): hot word
/// `word` (of the vCPU's table, [`HOT_PTR`]) counts its entries down; the entry that takes it from 1 to
/// 0 calls `hot(vcpu, key, pc)`, which compiles the head's loop region and
/// then stores `REDIRECT | its table index` in the word; from then on every
/// entry tail-calls the region (entries through links compiled before it).
/// 0 stays 0: the region wasn't compiled.
pub fn tier_up(c: &mut Func, word: u32, key: u64, ty: u32, hot: u32) {
    const V: u32 = 6; // i32 scratch
    const H: u32 = TLBE; // i32 scratch: the hot words
    let off = 4 * word;
    c.local_get(VCPU).i32_load(HOT_PTR).local_tee(H);
    c.i32_load(off).local_tee(V);
    c.i32_const(0).op(LT_S).if_();
    c.local_get(VCPU).local_get(ACC);
    if c.polled {
        c.i32_const(0);
    } else {
        c.local_get(LEFT);
    }
    c.local_get(DEPTH);
    c.local_get(V).i32_const(!REDIRECT as i32).op(AND);
    c.return_call_indirect(ty).end();
    c.local_get(V).if_();
    c.local_get(H).local_get(V).i32_const(1).op(SUB);
    c.memarg(0x36, 2, off); // i32.store
    c.local_get(V).i32_const(1).op(EQ).if_();
    c.local_get(VCPU)
        .i64_const(key as i64)
        .local_get(ENTRY)
        .call(hot);
    c.end().end();
}

/// A hot word holding a region's table index (below this bit).
pub const REDIRECT: u32 = 1 << 31;

/// Pushes an i32 that is non-zero iff the instruction at the entry PC + `off`
/// hits the TLB array at `arr` (the block's EL's instruction TLB) and maps to
/// `host` (a successor's page, in another guest page than the block: step 7).
pub fn maps_to(c: &mut Func, off: i64, arr: u32, host: u64) {
    pc_plus(c, off);
    c.local_tee(ADDR);
    tlb_entry(c);
    c.i64_load(arr);
    c.local_get(ADDR).i64_const(0xfff).op(OR + W).op(EQ + WC);
    c.local_get(TLBE)
        .i64_load(arr + 8)
        .local_get(ADDR)
        .i64_add();
    c.i64_const(host as i64).op(EQ + WC).op(AND);
}

/// The `Vcpu` offset of TLB array `3 * el + u` (read 0, write 1) at index 0:
/// the offset its loads take from [`tlb_entry`]'s pointer (`mmu::Tlb`: the
/// arrays are interleaved, so it's small enough for V8 to fold).
pub const fn tlb_array(el: u64, u: u64) -> u32 {
    TLB_E + (3 * el + u) as u32 * 16
}

const TLB_E: u32 = (offset_of!(Vcpu, tlb) + offset_of!(Tlb, e)) as u32;
// Every offset JIT code loads from the `Vcpu` at is one V8 folds into the load
// (docs/jit.md "Functions").
const _: () = assert!(TLB_E + 6 * 16 <= 0x800 && JC_PTR < 0x800 && HOT_PTR < 0x800 && STOP < 0x800);
const _: () = assert!(
    offset_of!(Vcpu, jit) + size_of::<super::State>() <= 0x800,
    "State::ticks"
);
const _: () = assert!((offset_of!(Vcpu, tlb) + offset_of!(Tlb, xgen) + 16) <= 0x800);

/// Turns the VA (i64) on the stack into the `Vcpu`-relative pointer to its TLB
/// index's entries (i32), kept in `TLBE`: index × 128 in one shift and mask.
fn tlb_entry(c: &mut Func) {
    const _: () = assert!(TLB_SLOTS * 16 == 1 << 7);
    c.i64_const(5).op(SHR_U + W).i32_wrap_i64();
    c.i32_const((TLB_ENTRIES as i32 - 1) << 7).op(AND);
    c.local_get(VCPU).op(ADD).local_tee(TLBE);
}

// Load/store scratch: the address and base (i64), the RAM offset or entry
// pointer (flat: i64 offset; TLB: i32 entry), the host address (i32).
const ADDR: u32 = 2;
const BASE: u32 = 3;
const OFF: u32 = 4;
const TLBE: u32 = 7;
const HOST: u32 = 6;
/// An i64 the access's fast path keeps across a nested `if` (exclusives).
const VALUE: u32 = 5;

/// Loads, stores and pairs, acquire/release, exclusives (of one register and
/// pairs) and LSE atomics with CASP, whose handlers can't fail for other
/// reasons than the access itself. LSE min/max and FP accesses stay helper
/// calls (FP ones: [`ldst_fp`]).
fn ldst(c: &mut Func, cx: &Ctx, i: u32, op: Op, k: usize) -> bool {
    use Op::*;
    const MON: u32 = offset_of!(Cpu, monitor) as u32;
    const VAL: u32 = offset_of!(Cpu, monitor.val) as u32;
    const MON_SIZE: u32 = offset_of!(Cpu, monitor.size) as u32;
    // Pushes whether the monitor is armed for ADDR and `len` bytes (an i32).
    let armed = |c: &mut Func, len: u32| {
        c.local_get(VCPU).i64_load(MON).local_get(ADDR).op(EQ + WC);
        c.local_get(VCPU).i64_load(MON_SIZE).i64_const(len as i64);
        c.op(EQ + WC).op(AND);
    };
    let (rt, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let here = 4 * k as i64;
    let (size, opc) = (bits(i, 31, 30), bits(i, 23, 22));
    // The base register, with SP's alignment check left to the helper.
    let base = |c: &mut Func| {
        get_sp(c, true, rn);
        c.local_set(BASE);
    };
    match op {
        LDR_lit_gen | LDRSW_lit => {
            let (len, sign) = match (op, bit(i, 30)) {
                (LDRSW_lit, _) => (4, true),
                (_, b) => (if b { 8 } else { 4 }, false),
            };
            pc_plus(c, here + sext((bits(i, 23, 5) << 2) as u64, 21) as i64);
            c.local_set(ADDR);
            access(c, cx, i, here, len, false, &[], xmask(rt), |c, off| {
                load_reg(c, rt, off, len, sign, false)
            });
        }
        PRFM_lit | PRFM_imm | PRFM_unscaled_imm => {} // no SP alignment check
        STRx_LDRx_imm_2 | STURx_LDURx | STRx_reg | LDRx_reg | STRx_LDRx_imm_1 | STTRB | LDTRB
        | LDTRSB | STTRH | LDTRH | LDTRSH | STTR | LDTR | LDTRSW => {
            if matches!(op, STRx_reg | LDRx_reg) && bits(i, 15, 13) & 2 == 0 {
                return false; // UNDEFINED, PRFM included
            }
            let len = 1 << size;
            // Unprivileged (LDTR & co): unscaled, with EL0's permissions, so
            // at EL1 through EL0's TLB arrays (M6 loop 7).
            let unpriv = matches!(
                op,
                STTRB | LDTRB | LDTRSB | STTRH | LDTRH | LDTRSH | STTR | LDTR | LDTRSW
            );
            let ucx;
            let cx = match cx.bus {
                Bus::Tlb { .. } if unpriv && cx.el1 => {
                    ucx = Ctx {
                        bus: Bus::Tlb {
                            read: tlb_array(0, 0),
                        },
                        ..*cx
                    };
                    &ucx
                }
                _ => cx,
            };
            let prfm = op != STRx_LDRx_imm_1 && !unpriv;
            let (store, sign, to32) = match opc {
                0 => (true, false, false),
                1 => (false, false, false),
                2 if size == 3 && prfm => {
                    return true; // PRFM: nothing (no SP alignment check)
                }
                _ if size == 3 || (size == 2 && opc == 3) => return false, // UNDEFINED
                _ => (false, true, opc == 3),
            };
            let m = (c.c.mark(), c.regs);
            base(c);
            let mut wb = false;
            match op {
                STRx_LDRx_imm_2 => {
                    c.local_get(BASE);
                    c.i64_const(((bits(i, 21, 10) as u64) << size) as i64)
                        .i64_add();
                }
                _ if op == STURx_LDURx || unpriv => {
                    c.local_get(BASE);
                    c.i64_const(sext(bits(i, 20, 12) as u64, 9) as i64)
                        .i64_add();
                }
                STRx_reg | LDRx_reg => {
                    let amt = if bit(i, 12) { size } else { 0 };
                    c.local_get(BASE);
                    extend(c, true, rm, bits(i, 15, 13), amt);
                    c.i64_add();
                }
                _ => {
                    // Pre-index (bit 11) accesses base + imm9, post-index the
                    // base; both write base + imm9 back.
                    wb = true;
                    c.local_get(BASE);
                    if bit(i, 11) {
                        c.i64_const(sext(bits(i, 20, 12) as u64, 9) as i64)
                            .i64_add();
                    }
                }
            }
            c.local_set(ADDR);
            c.skip_addr(k, rn, wb, m);
            let imm9 = sext(bits(i, 20, 12) as u64, 9) as i64;
            let written = if store { 0 } else { xmask(rt) } | if wb { 1 << rn } else { 0 };
            access(
                c,
                cx,
                i,
                here,
                len,
                store,
                &[Guard::sp(rn)],
                written,
                |c, off| {
                    if store {
                        c.local_get(HOST);
                        get(c, true, rt);
                        c.ram(STORE[size as usize], 0, off);
                    } else {
                        load_reg(c, rt, off, len, sign, to32);
                    }
                    if wb {
                        writeback(c, rn, imm9);
                    }
                },
            );
        }
        STP_LDP_gen | STNP_LDNP_gen => {
            let load = bit(i, 22);
            let (len, sign) = match (bits(i, 31, 30), load) {
                (0, _) => (4, false),
                (2, _) => (8, false),
                (1, true) if op == STP_LDP_gen => (4, true), // LDPSW
                _ => return false,                           // STGP, or reserved
            };
            let rt2 = bits(i, 14, 10);
            let off = sext(bits(i, 21, 15) as u64, 7).wrapping_mul(len as u64) as i64;
            // 24:23 is 01 post-index, 11 pre-index, 10 (or 00 for the non-temporal forms) offset.
            let mode = bits(i, 24, 23);
            let m = (c.c.mark(), c.regs);
            base(c);
            c.local_get(BASE);
            if mode != 1 {
                c.i64_const(off).i64_add();
            }
            c.local_set(ADDR);
            c.skip_addr(k, rn, mode & 1 == 1, m);
            let written = if load { xmask(rt) | xmask(rt2) } else { 0 }
                | if mode & 1 == 1 { 1 << rn } else { 0 };
            access(
                c,
                cx,
                i,
                here,
                2 * len,
                !load,
                &[Guard::sp(rn)],
                written,
                |c, o| {
                    if load {
                        load_reg(c, rt, o, len, sign, false);
                        load_reg(c, rt2, o + len, len, sign, false);
                    } else {
                        for (r, o) in [(rt, o), (rt2, o + len)] {
                            c.local_get(HOST);
                            get(c, true, r);
                            c.ram(STORE[len.trailing_zeros() as usize], 0, o);
                        }
                    }
                    if mode & 1 == 1 {
                        writeback(c, rn, off);
                    }
                },
            );
        }
        // Acquire/release: atomic accesses (the interpreter's too, and M7's
        // vCPUs need them), which must be aligned (M6 loop 1).
        LDAR | STLR => {
            let len = 1 << size;
            base(c);
            c.local_get(BASE).local_set(ADDR);
            let store = op == STLR;
            let guard = if rn == 31 { Guard::Sp } else { Guard::Aligned };
            let written = if store { 0 } else { xmask(rt) };
            access(c, cx, i, here, len, store, &[guard], written, |c, off| {
                if store {
                    c.local_get(HOST);
                    get(c, true, rt);
                    c.ram_atomic(ATOMIC_STORE[size as usize], size, off);
                } else {
                    set(c, true, rt, |c| {
                        c.local_get(HOST)
                            .ram_atomic(ATOMIC_LOAD[size as usize], size, off);
                    });
                }
            });
        }
        // FEAT_LRCPC2 (the caller checks it): LDAR's and STLR's access at
        // base + imm9 (aligned, so Sp and Aligned both for an SP base), the
        // loads extended as LDUR's; the unallocated sizes to the helper.
        STLUR_gen | LDAPUR_gen | LDAPURS_gen => {
            let (store, sign, to32) = match opc {
                0 => (true, false, false),
                1 => (false, false, false),
                _ if size == 3 || (size == 2 && opc == 3) => return false,
                _ => (false, true, opc == 3),
            };
            let len = 1 << size;
            base(c);
            c.local_get(BASE)
                .i64_const(sext(bits(i, 20, 12) as u64, 9) as i64)
                .i64_add()
                .local_set(ADDR);
            let guards: &[Guard] = if rn == 31 {
                &[Guard::Sp, Guard::Aligned]
            } else {
                &[Guard::Aligned]
            };
            let written = if store { 0 } else { xmask(rt) };
            access(c, cx, i, here, len, store, guards, written, |c, off| {
                if store {
                    c.local_get(HOST);
                    get(c, true, rt);
                    c.ram_atomic(ATOMIC_STORE[size as usize], size, off);
                } else {
                    set(c, true, rt, |c| {
                        c.local_get(HOST)
                            .ram_atomic(ATOMIC_LOAD[size as usize], size, off);
                        if sign {
                            // i64.extend8_s, extend16_s, extend32_s
                            c.op(0xc2 + size as u8);
                        }
                        if to32 {
                            c.i64_const(0xffff_ffff).op(AND + W);
                        }
                    });
                }
            });
        }
        // Exclusives of one register (M6 loop 7), with the interpreter's
        // compare-and-swap semantics and its monitor in the `Cpu`: LDXR arms it
        // with the address, size and value read; STXR stores (a cmpxchg against
        // that value) only if it's armed for this address and size, and
        // disarms it. Both must be aligned.
        LDXR | LDAXR | STXR | STLXR => {
            let len = 1 << size;
            base(c);
            c.local_get(BASE).local_set(ADDR);
            let load = matches!(op, LDXR | LDAXR);
            let rs = bits(i, 20, 16);
            let guard = if rn == 31 { Guard::Sp } else { Guard::Aligned };
            let written = xmask(if load { rt } else { rs });
            access(c, cx, i, here, len, !load, &[guard], written, |c, off| {
                if load {
                    c.local_get(HOST)
                        .ram_atomic(ATOMIC_LOAD[size as usize], size, off)
                        .local_set(VALUE);
                    c.local_get(VCPU).local_get(ADDR).i64_store(MON);
                    c.local_get(VCPU).i64_const(len as i64).i64_store(MON_SIZE);
                    c.local_get(VCPU).local_get(VALUE).i64_store(VAL);
                    c.local_get(VCPU).i64_const(0).i64_store(VAL + 8);
                    set(c, true, rt, |c| {
                        c.local_get(VALUE);
                    });
                } else {
                    // VALUE = the status: 0 stored, 1 not.
                    get(c, true, rt);
                    c.local_set(VALUE);
                    armed(c, len);
                    c.if_t(I64);
                    c.local_get(HOST)
                        .local_get(VCPU)
                        .i64_load(VAL)
                        .local_get(VALUE);
                    c.ram_atomic(RMW_CMPXCHG + RMW_SIZE[size as usize], size, off);
                    c.local_get(VCPU)
                        .i64_load(VAL)
                        .op(NE + WC)
                        .i64_extend_i32_u();
                    c.else_().i64_const(1).end().local_set(VALUE);
                    c.local_get(VCPU).i64_const(0).i64_store(MON_SIZE);
                    set(c, true, rs, |c| {
                        c.local_get(VALUE);
                    });
                }
            });
        }
        // LSE atomics (M6 loop 7): LDADD, LDCLR (an AND with the complement),
        // LDEOR, LDSET and SWP as one wasm atomic.rmw, CAS as a cmpxchg of the
        // masked expected value, every size and ordering (wasm atomics are
        // sequentially consistent). Rt (CAS: Rs) = the old value,
        // zero-extended; with XZR the result is dropped (ST<op>). Signed and
        // unsigned min/max have no wasm op and stay helper calls.
        CAS | CASB | CASH | LDADDB | LDCLRB | LDEORB | LDSETB | SWPB | LDADDH | LDCLRH | LDEORH
        | LDSETH | SWPH | LDADD | LDCLR | LDEOR | LDSET | SWP => {
            let cas = matches!(op, CAS | CASB | CASH);
            let rs = bits(i, 20, 16);
            let rmw = match bits(i, 15, 12) {
                _ if cas => RMW_CMPXCHG,
                0 => RMW_ADD,
                1 => RMW_AND,
                2 => RMW_XOR,
                3 => RMW_OR,
                8 => RMW_XCHG,
                _ => return false,
            } + RMW_SIZE[size as usize];
            let len = 1 << size;
            base(c);
            c.local_get(BASE).local_set(ADDR);
            let guard = if rn == 31 { Guard::Sp } else { Guard::Aligned };
            let dest = if cas { rs } else { rt };
            access(
                c,
                cx,
                i,
                here,
                len,
                true,
                &[guard],
                xmask(dest),
                |c, off| {
                    let value = |c: &mut Func| {
                        c.local_get(HOST);
                        get(c, true, rs);
                        if cas {
                            if size < 3 {
                                c.i64_const((u64::MAX >> (64 - 8 * len)) as i64).i64_and();
                            }
                            get(c, true, rt);
                        } else if bits(i, 15, 12) == 1 {
                            c.i64_const(-1).op(XOR + W);
                        }
                        c.ram_atomic(rmw, size, off);
                    };
                    if dest == 31 {
                        value(c);
                        c.op(DROP);
                    } else {
                        set(c, true, dest, value);
                    }
                },
            );
        }
        // CASP (M8): the W pair is one 64-bit cmpxchg of Ws:Ws+1 (low half
        // first) against Wt:Wt+1. The X pair is `Mem::cas_pair`'s protocol
        // inline: under the 16 bytes' pair lock (parallel SMP only: on one
        // thread nothing else runs a pair op meanwhile), read both halves
        // (again while the low half changed under the read); if they're Xs:Xs+1,
        // a cmpxchg of each half against what was read, the low half's failing
        // starting over. Xs:Xs+1 = the old pair either way. Odd registers are
        // UNDEFINED (the helper's).
        CASP => {
            let rs = bits(i, 20, 16);
            if rs & 1 == 1 || rt & 1 == 1 {
                return false;
            }
            let x = bit(i, 30);
            let len = if x { 16 } else { 8 };
            base(c);
            c.local_get(BASE).local_set(ADDR);
            let guard = if rn == 31 { Guard::Sp } else { Guard::Aligned };
            let written = xmask(rs) | xmask(rs + 1);
            let pcx = *cx;
            access(c, cx, i, here, len, true, &[guard], written, |c, off| {
                if !x {
                    // VALUE = the old pair.
                    let join = |c: &mut Func, r: u32| {
                        get(c, true, r);
                        c.i64_const(u32::MAX as i64).i64_and();
                        get(c, true, r + 1);
                        c.i64_const(32).op(SHL + W).op(OR + W);
                    };
                    c.local_get(HOST);
                    join(c, rs);
                    join(c, rt);
                    c.ram_atomic(RMW_CMPXCHG + RMW_SIZE[3], 3, off)
                        .local_set(VALUE);
                    set(c, true, rs, |c| {
                        c.local_get(VALUE).i64_const(u32::MAX as i64).i64_and();
                    });
                    set(c, true, rs + 1, |c| {
                        c.local_get(VALUE).i64_const(32).op(SHR_U + W);
                    });
                    return;
                }
                // The operands' locals, loaded before the loop: a register's
                // first read in a branch would leave it unloaded on the others.
                for r in [rs, rs + 1, rt, rt + 1] {
                    get(c, true, r);
                    c.op(DROP);
                }
                pair_lock(c, &pcx, off);
                // VALUE:BASE = the old pair.
                c.block().loop_();
                read_pair(c, off);
                c.local_get(VALUE);
                get(c, true, rs);
                c.op(NE + WC).local_get(BASE);
                get(c, true, rs + 1);
                c.op(NE + WC).op(OR).br_if(1);
                c.local_get(HOST).local_get(VALUE);
                get(c, true, rt);
                c.ram_atomic(RMW_CMPXCHG + RMW_SIZE[3], 3, off);
                c.local_get(VALUE).op(NE + WC).hint(false).br_if(0);
                c.local_get(HOST).local_get(BASE);
                get(c, true, rt + 1);
                c.ram_atomic(RMW_CMPXCHG + RMW_SIZE[3], 3, off + 8).op(DROP);
                c.end().end();
                pair_unlock(c, &pcx);
                set(c, true, rs, |c| {
                    c.local_get(VALUE);
                });
                set(c, true, rs + 1, |c| {
                    c.local_get(BASE);
                });
            });
        }
        // Exclusive pairs (M8), as the interpreter's. The W pair is an 8-byte
        // exclusive of Wt:Wt2 (Wt the low half). The X pair: LDXP reads the
        // 16 bytes as CASP does and arms the monitor with them; STXP, if it's
        // armed for this address and 16 bytes, is CASP of the monitor's pair
        // against Xt:Xt2 (both under the pair lock in parallel SMP). Rs = 0
        // if stored, else 1; the monitor is disarmed either way.
        LDXP | LDAXP | STXP | STLXP => {
            let (x, rs, rt2) = (bit(i, 30), bits(i, 20, 16), bits(i, 14, 10));
            let len = if x { 16 } else { 8 };
            let load = matches!(op, LDXP | LDAXP);
            base(c);
            c.local_get(BASE).local_set(ADDR);
            let guard = if rn == 31 { Guard::Sp } else { Guard::Aligned };
            let written = if load {
                xmask(rt) | xmask(rt2)
            } else {
                xmask(rs)
            };
            let pcx = *cx;
            access(c, cx, i, here, len, !load, &[guard], written, |c, off| {
                // VALUE:BASE differs from the monitor's pair (an i32).
                let differs = |c: &mut Func| {
                    c.local_get(VALUE).local_get(VCPU).i64_load(VAL).op(NE + WC);
                    c.local_get(BASE).local_get(VCPU).i64_load(VAL + 8);
                    c.op(NE + WC).op(OR);
                };
                if load {
                    // VALUE:BASE = the pair (W: VALUE the 8 bytes, BASE 0).
                    if x {
                        pair_lock(c, &pcx, off);
                        c.loop_();
                        read_pair(c, off);
                        c.end();
                        pair_unlock(c, &pcx);
                    } else {
                        c.local_get(HOST)
                            .ram_atomic(ATOMIC_LOAD[3], 3, off)
                            .local_set(VALUE);
                        c.i64_const(0).local_set(BASE);
                    }
                    c.local_get(VCPU).local_get(ADDR).i64_store(MON);
                    c.local_get(VCPU).i64_const(len as i64).i64_store(MON_SIZE);
                    c.local_get(VCPU).local_get(VALUE).i64_store(VAL);
                    c.local_get(VCPU).local_get(BASE).i64_store(VAL + 8);
                    set(c, true, rt, |c| {
                        c.local_get(VALUE);
                        if !x {
                            c.i64_const(u32::MAX as i64).i64_and();
                        }
                    });
                    set(c, true, rt2, |c| {
                        c.local_get(if x { BASE } else { VALUE });
                        if !x {
                            c.i64_const(32).op(SHR_U + W);
                        }
                    });
                    return;
                }
                // The operands' locals, loaded before the branches.
                for r in [rt, rt2] {
                    get(c, true, r);
                    c.op(DROP);
                }
                // VALUE = the status.
                if x {
                    armed(c, len);
                    c.if_t(I64);
                    pair_lock(c, &pcx, off);
                    c.block().loop_();
                    read_pair(c, off);
                    differs(c);
                    c.br_if(1);
                    c.local_get(HOST).local_get(VALUE);
                    get(c, true, rt);
                    c.ram_atomic(RMW_CMPXCHG + RMW_SIZE[3], 3, off);
                    c.local_get(VALUE).op(NE + WC).hint(false).br_if(0);
                    c.local_get(HOST).local_get(BASE);
                    get(c, true, rt2);
                    c.ram_atomic(RMW_CMPXCHG + RMW_SIZE[3], 3, off + 8).op(DROP);
                    c.end().end();
                    pair_unlock(c, &pcx);
                    differs(c);
                    c.i64_extend_i32_u();
                } else {
                    get(c, true, rt);
                    c.i64_const(u32::MAX as i64).i64_and();
                    get(c, true, rt2);
                    c.i64_const(32).op(SHL + W).op(OR + W).local_set(VALUE);
                    armed(c, len);
                    c.if_t(I64);
                    c.local_get(HOST)
                        .local_get(VCPU)
                        .i64_load(VAL)
                        .local_get(VALUE);
                    c.ram_atomic(RMW_CMPXCHG + RMW_SIZE[3], 3, off);
                    c.local_get(VCPU)
                        .i64_load(VAL)
                        .op(NE + WC)
                        .i64_extend_i32_u();
                }
                c.else_().i64_const(1).end().local_set(VALUE);
                c.local_get(VCPU).i64_const(0).i64_store(MON_SIZE);
                set(c, true, rs, |c| {
                    c.local_get(VALUE);
                });
            });
        }
        // Zeroes the aligned 64 bytes (DCZID_EL0's block) at Xt; from EL0 only
        // while SCTLR_EL1.DZE allows it (else the helper traps).
        DC_ZVA => {
            get(c, true, rt);
            c.i64_const(!63).i64_and().local_set(ADDR);
            let guard = if cx.el1 {
                Guard::None
            } else {
                Guard::Bits(offset_of!(Cpu, sctlr_el1) as u32, crate::cpu::sctlr::DZE)
            };
            // A block that is zero already isn't stored to (`interp::sys`'s DC ZVA: RAM
            // the guest never touched stays uncommitted on the host).
            access(c, cx, i, here, 64, true, &[guard], 0, |c, off| {
                c.local_get(HOST).ram(LOAD_U[3], 0, off);
                for k in 1..8 {
                    c.local_get(HOST).ram(LOAD_U[3], 0, off + 8 * k).op(OR + W);
                }
                c.op(EQZ + WC).op(EQZ).if_();
                for k in 0..8 {
                    c.local_get(HOST).i64_const(0).ram(STORE[3], 0, off + 8 * k);
                }
                c.end();
            });
        }
        _ => return false,
    }
    true
}

/// Takes the pair lock of the 16 bytes at HOST + `off` in parallel SMP (with
/// vCPUs sharing a thread no other pair op runs meanwhile); TLBE = its offset
/// from the locks ([`crate::mem::Mem::pair_locks`]).
fn pair_lock(c: &mut Func, cx: &Ctx, off: u32) {
    if !cx.parallel {
        return;
    }
    c.local_get(HOST);
    if off != 0 {
        c.i32_const(off as i32).op(ADD);
    }
    c.i32_const(4).op(SHR_U);
    c.i32_const(PAIR_LOCKS as i32 - 1).op(AND);
    c.i32_const(PAIR_LOCK_SIZE.trailing_zeros() as i32)
        .op(SHL)
        .local_set(TLBE);
    c.loop_().local_get(TLBE).i32_const(1);
    c.atomic(RMW_XCHG, 2, cx.pair_locks)
        .hint(false)
        .br_if(0)
        .end();
}

/// Releases [`pair_lock`]'s lock.
fn pair_unlock(c: &mut Func, cx: &Ctx) {
    if cx.parallel {
        c.local_get(TLBE).i32_const(0);
        c.atomic(I32_ATOMIC_STORE, 2, cx.pair_locks);
    }
}

/// VALUE:BASE = the 16 bytes at HOST + `off`, inside a `loop` that starts over
/// while the low half changed across the read of the high one (`Mem::pair_op`'s read).
fn read_pair(c: &mut Func, off: u32) {
    c.local_get(HOST)
        .ram_atomic(ATOMIC_LOAD[3], 3, off)
        .local_set(VALUE);
    c.local_get(HOST)
        .ram_atomic(ATOMIC_LOAD[3], 3, off + 8)
        .local_set(BASE);
    c.local_get(HOST).ram_atomic(ATOMIC_LOAD[3], 3, off);
    c.local_get(VALUE).op(NE + WC).hint(false).br_if(0);
}

/// Before a block's first inline SIMD&FP instruction (the `k`-th, `i`):
/// checks that CPACR_EL1.FPEN lets it run (11 at EL0, x1 at EL1). If not,
/// the helper runs it (it traps) and the block returns. Nothing later in the
/// block can change FPEN (an MSR ends a block), so the rest need no check.
pub fn fp_guard(c: &mut Func, cx: &Ctx, i: u32, k: usize) {
    if c.fp_ok {
        return;
    }
    c.fp_ok = true;
    let m = if cx.el1 { 1 << 20 } else { 3 << 20 };
    c.local_get(VCPU)
        .i64_load(offset_of!(Cpu, cpacr_el1) as u32);
    c.i64_const(m)
        .i64_and()
        .i64_const(m)
        .op(NE + WC)
        .hint(false)
        .if_();
    let saved = c.regs;
    c.flush();
    c.store_flags_cold();
    // acc + k, plus one if the helper retired it after all.
    c.local_get(VCPU).i32_const(i as i32);
    pc_plus(c, 4 * k as i64);
    c.call(cx.helper).op(EQZ);
    c.acc();
    c.op(ADD);
    c.i32_const(k as i32).op(ADD).return_();
    c.end();
    c.regs = saved;
}

/// SIMD&FP loads and stores of one register or a pair, every addressing form
/// (M6 loop 2): the fast path of [`access`], after the block's [`fp_guard`] and, for an SP base,
/// behind SP's alignment. Structure loads and stores (LD1 & co)
/// stay helper calls.
fn ldst_fp(c: &mut Func, cx: &Ctx, i: u32, op: Op, k: usize) -> bool {
    use Op::*;
    let (rt, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let here = 4 * k as i64;
    let load = bit(i, 22);
    // The access size: S/D/Q for the literal and pair forms, B/H/S/D/Q (Q:
    // size 0 with opc<1>) for the rest; the other encodings are UNDEFINED.
    let len = match op {
        LDR_lit_fpsimd | STP_LDP_fpsimd | STNP_LDNP_fpsimd => match bits(i, 31, 30) {
            3 => return false,
            o => 4 << o,
        },
        _ => match (bits(i, 31, 30), bit(i, 23)) {
            (0, true) => 16,
            (s, false) => 1 << s,
            _ => return false,
        },
    };
    if matches!(op, STR_reg_fpsimd | LDR_reg_fpsimd) && bits(i, 15, 13) & 2 == 0 {
        return false;
    }
    let imm9 = sext(bits(i, 20, 12) as u64, 9) as i64;
    fp_guard(c, cx, i, k);
    if load && len <= 8 {
        c.vzx = len;
    }
    match op {
        LDR_lit_fpsimd => {
            pc_plus(c, here + sext((bits(i, 23, 5) << 2) as u64, 21) as i64);
            c.local_set(ADDR);
            access(c, cx, i, here, len, false, &[], vbit(rt), |c, off| {
                vload(c, rt, off, len)
            });
        }
        STP_LDP_fpsimd | STNP_LDNP_fpsimd => {
            let rt2 = bits(i, 14, 10);
            let off = sext(bits(i, 21, 15) as u64, 7).wrapping_mul(len as u64) as i64;
            // 24:23 is 01 post-index, 11 pre-index, 10 (or 00 for the non-temporal forms) offset.
            let mode = bits(i, 24, 23);
            let m = (c.c.mark(), c.regs);
            get_sp(c, true, rn);
            c.local_tee(BASE);
            if mode != 1 {
                c.i64_const(off).i64_add();
            }
            c.local_set(ADDR);
            c.skip_addr(k, rn, mode & 1 == 1, m);
            let wb = mode & 1 == 1;
            let guards = [Guard::sp(rn)];
            access(
                c,
                cx,
                i,
                here,
                2 * len,
                !load,
                &guards,
                if wb { 1 << rn } else { 0 } | if load { vbit(rt) | vbit(rt2) } else { 0 },
                |c, o| {
                    for (r, o) in [(rt, o), (rt2, o + len)] {
                        if load {
                            vload(c, r, o, len);
                        } else {
                            vstore(c, r, o, len);
                        }
                    }
                    if wb {
                        writeback(c, rn, off);
                    }
                },
            );
        }
        _ => {
            let m = (c.c.mark(), c.regs);
            get_sp(c, true, rn);
            c.local_tee(BASE);
            let wb = matches!(op, STR_imm_fpsimd_1 | LDR_imm_fpsimd_1);
            match op {
                STR_imm_fpsimd_2 | LDR_imm_fpsimd_2 => {
                    c.i64_const(bits(i, 21, 10) as i64 * len as i64).i64_add();
                }
                STUR_fpsimd | LDUR_fpsimd => {
                    c.i64_const(imm9).i64_add();
                }
                STR_reg_fpsimd | LDR_reg_fpsimd => {
                    let amt = if bit(i, 12) { len.trailing_zeros() } else { 0 };
                    extend(c, true, rm, bits(i, 15, 13), amt);
                    c.i64_add();
                }
                // Pre-index (bit 11) accesses base + imm9, post-index the base.
                _ => {
                    if bit(i, 11) {
                        c.i64_const(imm9).i64_add();
                    }
                }
            }
            c.local_set(ADDR);
            c.skip_addr(k, rn, wb, m);
            let guards = [Guard::sp(rn)];
            access(
                c,
                cx,
                i,
                here,
                len,
                !load,
                &guards,
                if wb { 1 << rn } else { 0 } | if load { vbit(rt) } else { 0 },
                |c, off| {
                    if load {
                        vload(c, rt, off, len);
                    } else {
                        vstore(c, rt, off, len);
                    }
                    if wb {
                        writeback(c, rn, imm9);
                    }
                },
            );
        }
    }
    true
}

/// The V registers' offset in the `Cpu`.
const V: u32 = offset_of!(Cpu, v) as u32;

// SIMD memory opcodes (0xfd-prefixed).
const V128_LOAD: u8 = 0;
const V128_STORE: u8 = 11;
const V128_LOAD32_ZERO: u8 = 92;
const V128_LOAD64_ZERO: u8 = 93;

/// Vt = the `len` bytes at the host address (+ `off`), zero-extended to 128 bits:
/// a single or double into Vt's shadow when a scalar reader comes next
/// ([`Func::scalar_next`]).
fn vload(c: &mut Func, t: u32, off: u32, len: u32) {
    if matches!(len, 4 | 8) && c.scalar_next(t, 8 * len) {
        return c.vset_f(t, 8 * len, |c| {
            c.local_get(HOST);
            if len == 8 {
                c.ram(0x2b, 0, off); // f64.load
            } else {
                c.ram(0x2a, 0, off); // f32.load
            }
        });
    }
    match len {
        16 | 8 | 4 => {
            let op =
                [V128_LOAD32_ZERO, V128_LOAD64_ZERO, V128_LOAD][len.trailing_zeros() as usize - 2];
            c.local_get(HOST).ram_simd(op, 0, off);
            c.vset(t);
        }
        _ => c.vset_scalar(t, 32, |c| {
            c.local_get(HOST)
                .ram(LOAD32_U[len.trailing_zeros() as usize], 0, off);
        }),
    }
}

/// LD1/ST1 (multiple structures) of one to four registers (M6 loop 7): one
/// contiguous access of 8 or 16 bytes per register (the element size doesn't
/// matter, little-endian), through the fast path of [`access`], after the
/// block's [`fp_guard`]. LD2–LD4 and ST2–ST4 are [`ldn_stn`].
fn ld1_st1(c: &mut Func, cx: &Ctx, i: u32, k: usize) -> bool {
    let n = match bits(i, 15, 12) {
        0b0111 => 1,
        0b1010 => 2,
        0b0110 => 3,
        0b0010 => 4,
        _ => return false,
    };
    let (rt, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let (load, wb) = (bit(i, 22), bit(i, 23));
    let len = if bit(i, 30) { 16 } else { 8 };
    let here = 4 * k as i64;
    fp_guard(c, cx, i, k);
    get_sp(c, true, rn);
    c.local_tee(BASE).local_set(ADDR);
    let mut written = if wb { 1 << rn } else { 0 };
    if load {
        written |= (0..n).map(|r| vbit((rt + r) % 32)).fold(0, |a, b| a | b);
    }
    access(
        c,
        cx,
        i,
        here,
        n * len,
        !load,
        &[Guard::sp(rn)],
        written,
        |c, off| {
            for r in 0..n {
                let (t, o) = ((rt + r) % 32, off + r * len);
                if load {
                    vload(c, t, o, len);
                } else {
                    vstore(c, t, o, len);
                }
            }
            // Post-index: by the bytes transferred, or by Xm.
            if wb && rm == 31 {
                writeback(c, rn, (n * len) as i64);
            } else if wb {
                set_sp(c, true, rn, |c| {
                    c.local_get(BASE);
                    get(c, true, rm);
                    c.i64_add();
                });
            }
        },
    );
    true
}

/// LD1–LD4/ST1–ST4 (single structure): one lane of each of one to four
/// registers, the other lanes kept (`interp::ldst_fp::single_structure`).
fn ld1_st1_lane(c: &mut Func, cx: &Ctx, i: u32, k: usize) -> bool {
    let (q, load, s, size) = (bit(i, 30), bit(i, 22), bit(i, 12), bits(i, 11, 10));
    let q_s = (q as u32) << 1 | s as u32;
    let (len, index): (u32, u32) = match bits(i, 15, 13) >> 1 {
        0 => (1, q_s << 2 | size),
        1 if size & 1 == 0 => (2, q_s << 1 | size >> 1),
        2 if size == 0 => (4, q_s),
        2 if size == 1 && !s => (8, q as u32),
        _ => return false,
    };
    // LD1–LD4: one to four consecutive elements, one per register.
    let n = ((bit(i, 13) as u32) << 1 | bit(i, 21) as u32) + 1;
    let (rt, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let wb = bit(i, 23);
    let lg = len.trailing_zeros() as usize;
    let index = index as u8;
    fp_guard(c, cx, i, k);
    get_sp(c, true, rn);
    c.local_tee(BASE).local_set(ADDR);
    let mut written = if wb { 1 << rn } else { 0 };
    if load {
        written |= (0..n).map(|r| vbit((rt + r) % 32)).fold(0, |a, b| a | b);
    }
    access(
        c,
        cx,
        i,
        4 * k as i64,
        n * len,
        !load,
        &[Guard::sp(rn)],
        written,
        |c, off| {
            // Lane ops by log2 size: i8x16.replace_lane … i64x2.replace_lane,
            // the extract_lane_u forms.
            const REPLACE: [u32; 4] = [0x17, 0x1a, 0x1c, 0x1e];
            const EXTRACT: [u32; 4] = [0x16, 0x19, 0x1b, 0x1d];
            for r in 0..n {
                let (t, off) = ((rt + r) % 32, off + r * len);
                if load {
                    c.vget(t);
                    c.local_get(HOST);
                    if lg == 3 {
                        c.ram(0x29, 3, off);
                    } else {
                        c.ram(LOAD32_U[lg], 0, off);
                    }
                    c.simd_lane(REPLACE[lg], index);
                    c.vset(t);
                } else {
                    c.local_get(HOST);
                    c.vget(t);
                    c.simd_lane(EXTRACT[lg], index);
                    c.ram(if lg == 3 { STORE[3] } else { STORE32[lg] }, 0, off);
                }
            }
            if wb && rm == 31 {
                writeback(c, rn, (n * len) as i64);
            } else if wb {
                set_sp(c, true, rn, |c| {
                    c.local_get(BASE);
                    get(c, true, rm);
                    c.i64_add();
                });
            }
        },
    );
    true
}

/// LD2–LD4/ST2–ST4 (multiple structures): `n` registers interleaved element
/// by element in `n × len` contiguous bytes (`interp::ldst_fp::multiple`). One
/// access; the bytes move between memory and the registers through shuffles
/// ([`gather`]), the memory side in 16-byte chunks held in `VT`.
fn ldn_stn(c: &mut Func, cx: &Ctx, i: u32, k: usize) -> bool {
    let n = match bits(i, 15, 12) {
        0b0000 => 4,
        0b0100 => 3,
        0b1000 => 2,
        _ => return false,
    };
    let (q, size) = (bit(i, 30), bits(i, 11, 10));
    if size == 3 && !q {
        return false;
    }
    let (rt, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let (load, wb) = (bit(i, 22), bit(i, 23));
    let (len, eb) = (if q { 16 } else { 8 }, 1u32 << size);
    let total = n * len;
    fp_guard(c, cx, i, k);
    get_sp(c, true, rn);
    c.local_tee(BASE).local_set(ADDR);
    let mut written = if wb { 1 << rn } else { 0 };
    if load {
        written |= (0..n).map(|r| vbit((rt + r) % 32)).fold(0, |a, b| a | b);
    }
    // Byte `j` of register `r` is memory byte `at(r, j)`.
    let at = move |r: u32, j: u32| (j / eb * n + r) * eb + j % eb;
    access(
        c,
        cx,
        i,
        4 * k as i64,
        total,
        !load,
        &[Guard::sp(rn)],
        written,
        |c, off| {
            let chunks = total.div_ceil(16);
            if load {
                for m in 0..chunks {
                    let op = if 16 * m + 8 == total {
                        V128_LOAD64_ZERO
                    } else {
                        V128_LOAD
                    };
                    c.local_get(HOST).ram_simd(op, 0, off + 16 * m);
                    c.local_set(VT[m as usize]);
                }
                for r in 0..n {
                    let src: [u32; 16] = std::array::from_fn(|j| at(r, j as u32 % len));
                    gather(c, &src, |c, m| {
                        c.local_get(VT[m as usize]);
                    });
                    if !q {
                        c.i64_const(0).simd_lane(0x1e, 1);
                    }
                    c.vset((rt + r) % 32);
                }
            } else {
                for m in 0..chunks {
                    // Memory byte `a` is byte `a / eb / n × eb + a % eb` of
                    // register `a / eb % n`.
                    let src: [u32; 16] = std::array::from_fn(|j| {
                        let a = (16 * m + j as u32).min(total - 1);
                        (a / eb % n) * 16 + a / eb / n * eb + a % eb
                    });
                    c.local_get(HOST);
                    gather(c, &src, |c, r| {
                        c.vget((rt + r) % 32);
                    });
                    if 16 * m + 8 == total {
                        c.simd_lane(0x1d, 0).ram(STORE[3], 0, off + 16 * m);
                    } else {
                        c.ram_simd(V128_STORE, 0, off + 16 * m);
                    }
                }
            }
            if wb && rm == 31 {
                writeback(c, rn, total as i64);
            } else if wb {
                set_sp(c, true, rn, |c| {
                    c.local_get(BASE);
                    get(c, true, rm);
                    c.i64_add();
                });
            }
        },
    );
    true
}

/// Pushes a v128 whose byte `j` is byte `src[j] % 16` of source `src[j] / 16`
/// (up to four sources, pushed by `push`): one shuffle when the bytes come
/// from at most two sources of the same pair, else one per pair and a third
/// to merge them.
fn gather(c: &mut Func, src: &[u32; 16], push: impl Fn(&mut Func, u32)) {
    let used = src.iter().fold(0u32, |a, &s| a | 1 << (s / 16));
    let pair = |c: &mut Func, p: u32| {
        // Sources 2p and 2p + 1; bytes from the other pair don't matter.
        push(c, 2 * p);
        push(c, 2 * p + 1);
        c.shuffle(std::array::from_fn(|j| {
            let s = src[j];
            if s / 32 == p { (s % 32) as u8 } else { 0 }
        }));
    };
    if used & 0b1100 == 0 {
        pair(c, 0);
    } else if used & 0b0011 == 0 {
        pair(c, 1);
    } else {
        pair(c, 0);
        pair(c, 1);
        c.shuffle(std::array::from_fn(|j| {
            (j as u32 + 16 * (src[j] / 32)) as u8
        }));
    }
}

/// LD1R–LD4R: one element per register, replicated to its lanes
/// (`interp::ldst_fp::single_structure`), through the `v128.loadN_splat` ops.
fn ldnr(c: &mut Func, cx: &Ctx, i: u32, k: usize) -> bool {
    if !bit(i, 22) || bit(i, 12) {
        return false;
    }
    let n = ((bit(i, 13) as u32) << 1 | bit(i, 21) as u32) + 1;
    let (q, size) = (bit(i, 30), bits(i, 11, 10));
    let (rt, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let wb = bit(i, 23);
    let eb = 1u32 << size;
    fp_guard(c, cx, i, k);
    get_sp(c, true, rn);
    c.local_tee(BASE).local_set(ADDR);
    let mut written = if wb { 1 << rn } else { 0 };
    written |= (0..n).map(|r| vbit((rt + r) % 32)).fold(0, |a, b| a | b);
    access(
        c,
        cx,
        i,
        4 * k as i64,
        n * eb,
        false,
        &[Guard::sp(rn)],
        written,
        |c, off| {
            // v128.load8_splat … v128.load64_splat.
            const SPLAT: [u8; 4] = [7, 8, 9, 10];
            for r in 0..n {
                c.local_get(HOST)
                    .ram_simd(SPLAT[size as usize], 0, off + r * eb);
                if !q {
                    c.i64_const(0).simd_lane(0x1e, 1);
                }
                c.vset((rt + r) % 32);
            }
            if wb && rm == 31 {
                writeback(c, rn, (n * eb) as i64);
            } else if wb {
                set_sp(c, true, rn, |c| {
                    c.local_get(BASE);
                    get(c, true, rm);
                    c.i64_add();
                });
            }
        },
    );
    true
}

/// The low `len` bytes of Vt to the host address (+ `off`).
fn vstore(c: &mut Func, t: u32, off: u32, len: u32) {
    c.local_get(HOST);
    match len {
        16 => {
            c.vget(t);
            c.ram_simd(V128_STORE, 0, off);
        }
        8 | 4 if c.has_shadow(t, 8 * len) => {
            c.vlanef(t, 8 * len);
            c.ram(if len == 8 { 0x39 } else { 0x38 }, 0, off); // f64/f32.store
        }
        8 => {
            c.vlane(t, 64, 0);
            c.ram(STORE[3], 0, off);
        }
        _ => {
            c.vlane(t, 32, 0);
            c.ram(STORE32[len.trailing_zeros() as usize], 0, off);
        }
    }
}

// i64 atomic loads (zero-extending) and stores by log2 size (0xfe-prefixed).
const ATOMIC_LOAD: [u8; 4] = [0x14, 0x15, 0x16, 0x11];
const ATOMIC_STORE: [u8; 4] = [0x1b, 0x1c, 0x1d, 0x18];
// i32 atomic read-modify-writes (0xfe-prefixed); plus `RMW_SIZE` by log2 size,
// the zero-extending i64 forms.
const RMW_ADD: u8 = 0x1e;
const RMW_AND: u8 = 0x2c;
const RMW_OR: u8 = 0x33;
const RMW_XOR: u8 = 0x3a;
const RMW_XCHG: u8 = 0x41;
const RMW_CMPXCHG: u8 = 0x48;
const RMW_SIZE: [u8; 4] = [4, 5, 6, 1];
const I32_ATOMIC_STORE: u8 = 0x17;

// i64 loads by log2 size, zero- and sign-extending, and i64 stores.
const LOAD_U: [u8; 4] = [0x31, 0x33, 0x35, 0x29];
const LOAD_S: [u8; 4] = [0x30, 0x32, 0x34, 0x29];
const STORE: [u8; 4] = [0x3c, 0x3d, 0x3e, 0x37];
// i32 loads (zero-extending) and stores by log2 size, up to 4 bytes.
const LOAD32_U: [u8; 3] = [0x2d, 0x2f, 0x28];
const STORE32: [u8; 3] = [0x3a, 0x3b, 0x36];

/// Loads `len` bytes at the host address (+ `off`) into Xt: zero-extended,
/// sign-extended to 64 bits, or (`to32`) sign-extended to 32 and zero-extended.
fn load_reg(c: &mut Func, rt: u32, off: u32, len: u32, sign: bool, to32: bool) {
    let lg = len.trailing_zeros() as usize;
    set(c, true, rt, |c| {
        c.local_get(HOST);
        if to32 {
            // i32.load8_s / i32.load16_s
            c.ram([0x2c, 0x2e][lg], 0, off).i64_extend_i32_u();
        } else {
            c.ram(if sign { LOAD_S[lg] } else { LOAD_U[lg] }, 0, off);
        }
    });
}

/// Rn (31: SP) = the base + `imm`.
fn writeback(c: &mut Func, rn: u32, imm: i64) {
    set_sp(c, true, rn, |c| {
        c.local_get(BASE).i64_const(imm).i64_add();
    });
}

/// The register-mask bit of Xt, none for XZR.
fn xmask(rt: u32) -> u64 {
    if rt == 31 { 0 } else { 1 << rt }
}

/// What else an access's fast path requires.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Guard {
    None,
    /// An SP base (in `BASE`) is 16-byte aligned (else an SP alignment fault).
    Sp,
    /// The address (in `ADDR`) is aligned to the access (acquire/release).
    Aligned,
    /// The u64 at this `Cpu` offset has every bit of the mask set (DC ZVA at
    /// EL0: SCTLR_EL1.DZE; SIMD&FP accesses: CPACR_EL1.FPEN).
    Bits(u32, u64),
}

impl Guard {
    /// `Sp` for base register 31, else nothing.
    fn sp(rn: u32) -> Guard {
        if rn == 31 { Guard::Sp } else { Guard::None }
    }
}

/// The fast path of an access of `len` bytes at the address in `ADDR`: if it
/// is RAM (flat: in bounds; MMU: a TLB hit for the page, which the access
/// doesn't leave) and the `guards` hold, `body`
/// runs with the host address in `HOST`, to be used with the memarg offset
/// it gets. Otherwise the helper re-executes the instruction (exact faults,
/// MMIO through `vm::Io`, page-crossing accesses) and the block returns if it
/// didn't retire; the registers are written back before the call, and after
/// it the ones in `written` (the instruction's destinations), and any the fast
/// path loaded, are reloaded, so both arms leave the fast path's register state.
///
/// With the MMU on and spill memories inline (`cx.spill`), a TLB entry for
/// the page in spill memory k (its tag differs from memory 0's in the
/// memory bits alone, `mmu`) runs `body` again in a nested arm before the
/// helper, its guest RAM accesses naming memory k ([`Code::ram`]): the same
/// registers as the fast path's, so it leaves the same state
/// (docs/spill-memories.md "The JIT's spill arm").
#[allow(clippy::too_many_arguments)]
fn access(
    c: &mut Func,
    cx: &Ctx,
    i: u32,
    here: i64,
    len: u32,
    write: bool,
    guards: &[Guard],
    written: u64,
    body: impl Fn(&mut Func, u32),
) {
    let k = (here / 4) as usize;
    match c.plan.get(k).copied().unwrap_or_default() {
        Role::None => {}
        // A spill arm's span ([`close`]): HOST is set.
        Role::Lead { off, .. } | Role::Follow { off } if c.replay => return body(c, off),
        Role::Lead {
            last,
            lo,
            span,
            off,
            fp,
            store,
        } => {
            return lead(
                c,
                cx,
                i,
                k,
                store,
                guards,
                written,
                (last, lo, span, off, fp),
                body,
            );
        }
        Role::Follow { off } => {
            // HOST holds the group's lowest address: nothing between changes it.
            c.swrites |= written;
            body(c, off);
            let g = c.group.expect("a follower's group is open");
            if g.last == k {
                close(c, cx, g, here);
            }
            return;
        }
    }
    c.chain_open(written);
    c.vzx = 0;
    let off = match cx.bus {
        Bus::Flat { base, phys, size } => {
            c.local_get(ADDR);
            if phys != 0 {
                c.i64_const(phys as i64).op(SUB + W);
            }
            c.local_tee(OFF);
            c.i64_const(size.saturating_sub(len as u64) as i64)
                .op(LE_U + WC);
            base
        }
        Bus::Tlb { read } => {
            let arr = read + if write { 16 } else { 0 };
            c.local_get(ADDR);
            tlb_entry(c);
            c.i64_load(arr);
            c.local_get(ADDR);
            if len > 1 {
                c.i64_const(len as i64 - 1).i64_add();
            }
            c.i64_const(0xfff).op(OR + W).op(EQ + WC);
            0
        }
    };
    for &g in guards {
        guard(c, g, len);
    }
    c.hint(true).if_();
    match cx.bus {
        Bus::Flat { .. } => c.local_get(OFF).i32_wrap_i64(),
        Bus::Tlb { read } => {
            let arr = read + if write { 16 } else { 0 };
            c.local_get(TLBE)
                .i64_load(arr + 8)
                .local_get(ADDR)
                .i64_add()
                .i32_wrap_i64()
        }
    };
    c.local_set(HOST);
    let before = c.regs;
    body(c, off);
    let Bus::Tlb { read } = cx.bus else {
        return fallback_chain(c, cx, i, here, before, written);
    };
    let arr = read + if write { 16 } else { 0 };
    let fast = c.regs;
    c.else_();
    c.note(super::wasm::NOTE_SLOW, k as u64, k as u64);
    c.regs = before;
    // The arms run the body again: the masks of what it reads count the
    // fast path's reads alone (a register read once stays `plain`).
    let (read_, reused) = (c.read, c.reused);
    for k in 1..=cx.spill {
        // tag ^ ((va + len - 1) | 0xfff) is k << 3 (stored inverted, memory 0 all ones).
        c.local_get(TLBE).i64_load(arr).local_get(ADDR);
        if len > 1 {
            c.i64_const(len as i64 - 1).i64_add();
        }
        c.i64_const(0xfff).op(OR + W).op(XOR + W);
        c.i64_const((k as i64) << 3).op(EQ + WC);
        for &g in guards {
            guard(c, g, len);
        }
        c.if_();
        c.local_get(TLBE)
            .i64_load(arr + 8)
            .local_get(ADDR)
            .i64_add()
            .i32_wrap_i64()
            .local_set(HOST);
        c.ram_mem = k;
        body(c, off);
        c.ram_mem = 0;
        debug_assert_eq!(c.regs, fast, "a spill arm's registers");
        c.else_();
        c.regs = before;
    }
    c.read = read_;
    c.reused = reused;
    fallback_arm(c, cx, i, here, written, fast, 2 + cx.spill);
    for _ in 0..cx.spill {
        c.end();
    }
    c.regs = fast;
    c.note(super::wasm::NOTE_SLOW_END, 0, 0);
    c.end();
}

/// [`access`] for a group's leader `i` (the `k`-th instruction): one probe
/// for the group's span (`g`: its [`Role::Lead`]'s fields) from the lowest
/// address, into `ADDR`, and the leader's body in the fast arm, which stays
/// open over the span (HOST the lowest address's host address) until the last
/// access closes it ([`close`]). `write`: a store in the span, so the write
/// array's entry answers for all of it (a page's write permission implies read).
#[allow(clippy::too_many_arguments)]
fn lead(
    c: &mut Func,
    cx: &Ctx,
    i: u32,
    k: usize,
    write: bool,
    guards: &[Guard],
    written: u64,
    g: (usize, i64, u32, u32, bool),
    body: impl Fn(&mut Func, u32),
) {
    let (last, lo, span, off, fp) = g;
    let Bus::Tlb { read } = cx.bus else {
        unreachable!("groups need the TLB");
    };
    if fp {
        // Here, not at a SIMD&FP access in the span (whose check would leave
        // through its helper): the helper runs the leader if FP is off.
        fp_guard(c, cx, i, k);
    }
    // The span's SIMD&FP loads and the bytes each writes: a segment storing
    // one of those registers from a shadow narrower than that starts a new
    // chain.
    let (vw, vz) = if fp {
        span_vloads(&c.words[k..=last])
    } else {
        (0, 0)
    };
    c.vzx = vz;
    c.chain_open(written | vw);
    let arr = read + if write { 16 } else { 0 };
    c.local_get(ADDR);
    if lo != 0 {
        c.i64_const(lo).i64_add().local_tee(ADDR);
    }
    tlb_entry(c);
    c.i64_load(arr).local_get(ADDR);
    c.i64_const(span as i64 - 1).i64_add();
    c.i64_const(0xfff).op(OR + W).op(EQ + WC);
    for &g in guards {
        guard(c, g, span);
    }
    c.hint(true).if_();
    c.local_get(TLBE)
        .i64_load(arr + 8)
        .local_get(ADDR)
        .i64_add()
        .i32_wrap_i64()
        .local_set(HOST);
    debug_assert!(guards.len() <= 1);
    c.group = Some(Open {
        first: k,
        last,
        before: c.regs,
        arr,
        span,
        guard: guards.first().copied().unwrap_or(Guard::None),
    });
    c.sreads = c.ireads;
    c.swrites = written;
    body(c, off);
}

/// Closes group `g` after its last access (at `here`): the probe's `else`,
/// where the span helper runs the span's instructions in turn, the block
/// returning at the first that doesn't retire (to the leader's segment of
/// the failure chain), with what the span reads or writes written back
/// before and what it writes reloaded after, as [`fallback_arm`] for one.
/// The words go as constants, in calls of [`SPAN_WORDS`].
fn close(c: &mut Func, cx: &Ctx, g: Open, here: i64) {
    debug_assert_eq!(g.last, (here / 4) as usize);
    c.group = None;
    let fast = c.regs;
    c.else_();
    c.note(super::wasm::NOTE_SLOW, g.first as u64, g.last as u64);
    c.regs = g.before;
    // The span again for each spill memory, its accesses naming it (as
    // `access`'s arms): in the `else`, ADDR, BASE and TLBE are still the
    // leader's, the fast arm not having run.
    let (read_, reused) = (c.read, c.reused);
    let (sreads, written) = (c.sreads, c.swrites);
    for m in 1..=cx.spill {
        c.local_get(TLBE).i64_load(g.arr).local_get(ADDR);
        c.i64_const(g.span as i64 - 1).i64_add();
        c.i64_const(0xfff).op(OR + W).op(XOR + W);
        c.i64_const((m as i64) << 3).op(EQ + WC);
        guard(c, g.guard, g.span);
        c.if_();
        c.local_get(TLBE)
            .i64_load(g.arr + 8)
            .local_get(ADDR)
            .i64_add()
            .i32_wrap_i64()
            .local_set(HOST);
        c.ram_mem = m;
        c.replay = true;
        for j in g.first..=g.last {
            let w = c.words[j];
            let ok = inline(c, w, crate::decode::decode(w), j, cx);
            debug_assert!(ok, "a group's instruction again");
        }
        c.replay = false;
        c.ram_mem = 0;
        debug_assert_eq!(c.regs, fast, "a group's spill arm's registers");
        c.else_();
        c.regs = g.before;
    }
    (c.read, c.reused, c.sreads, c.swrites) = (read_, reused, sreads, written);
    let mut need = (c.sreads | written) & c.regs.dirty;
    c.regs.dirty &= !need;
    while need != 0 {
        let n = need.trailing_zeros();
        need &= need - 1;
        c.store_cpu(n);
    }
    let dirty = c.regs.dirty;
    let (o32, o64) = c.regs.only();
    let ch = c.chain.as_mut().expect("the leader opens a chain");
    let d = dirty & !ch.cum;
    *ch.segs.last_mut().expect("a segment") = (d, d & o32, d & o64);
    ch.cum |= d;
    ch.o32 |= d & o32;
    ch.o64 |= d & o64;
    let (c32, c64) = (ch.o32, ch.o64);
    // Earlier sites' segments store their registers from the locals: those
    // the span wrote take what the helper left in the `Cpu` (as a single
    // access's arm does, `fallback_arm`).
    let stale = written & ch.cum;
    for from in (g.first..=g.last).step_by(SPAN_WORDS) {
        let to = (from + SPAN_WORDS).min(g.last + 1);
        c.local_get(VCPU);
        pc_plus(c, 4 * from as i64);
        c.i32_const((to - from) as i32);
        for p in 0..SPAN_WORDS / 2 {
            let word = |q: usize| c.words.get(from + q).filter(|_| from + q < to).copied();
            let w = word(2 * p).unwrap_or(0) as u64 | (word(2 * p + 1).unwrap_or(0) as u64) << 32;
            c.i64_const(w as i64);
        }
        c.call(cx.span).local_tee(HOST);
        c.i32_const((to - from) as i32).op(NE).hint(false).if_();
        let mut m = stale;
        while m != 0 {
            let n = m.trailing_zeros();
            m &= m - 1;
            c.load_as(n, c32 & 1 << n != 0, c64 & 1 << n != 0);
        }
        c.local_get(HOST).i32_const(from as i32).op(ADD);
        c.br(2 + cx.spill);
        c.end();
    }
    c.touched.get_or_insert(true);
    if let Flags::Lazy { stored, .. } = &mut c.flags {
        *stored = true;
    }
    c.forget(written);
    c.reload(fast);
    for _ in 0..cx.spill {
        c.end();
    }
    c.regs = fast;
    c.note(super::wasm::NOTE_SLOW_END, 0, 0);
    c.end();
}

/// Groups of accesses share one TLB probe (docs/jit.md "Loads and stores").
pub const GROUPS: bool = true;

/// A group's span (from its lowest byte to past its highest), at most.
const SPAN_MAX: i64 = 256;

/// The instructions a call of the span helper takes (`jit_exec_span`).
pub const SPAN_WORDS: usize = 6;

/// The instructions a group may hold besides its accesses.
const OTHERS: usize = 4;

/// Loads and stores share a group.
const MIXED: bool = true;

/// An instruction's part in a group of accesses ([`plan`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Role {
    #[default]
    None,
    /// The first access: its probe covers the group's `span` bytes from its
    /// address + `lo`, the lowest the group accesses, its own at `off` from
    /// there; the group ends at instruction `last`; `fp`: an access is SIMD&FP;
    /// `store`: an access is a store (the probe's array).
    Lead {
        last: usize,
        lo: i64,
        span: u32,
        off: u32,
        fp: bool,
        store: bool,
    },
    /// A later access, at `off` from the group's lowest address.
    Follow { off: u32 },
}

/// The open group ([`access`]): its first instruction, last, and the
/// register state at its probe's `if`.
#[derive(Clone, Copy)]
struct Open {
    first: usize,
    last: usize,
    before: Regs,
    /// The leader's TLB array, span and guard, for the spill arms.
    arr: u32,
    span: u32,
    guard: Guard,
}

/// A load or store a group can take: the base register, the address's
/// offset from it, the bytes accessed, a store, the base's change after it
/// (writeback), SIMD&FP, and the X registers it loads.
struct Shape {
    rn: u32,
    off: i64,
    len: u32,
    write: bool,
    wb: i64,
    fp: bool,
    loads: u64,
}

/// The [`Shape`] of a load or store with an immediate offset ([`ldst`],
/// [`ldst_fp`]), none for the rest: what they emit inline (their reasons to
/// leave a word to the helper are this one's for none).
fn shape(i: u32) -> Option<Shape> {
    use Op::*;
    let (rt, rn, rt2) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 14, 10));
    let size = bits(i, 31, 30);
    let imm9 = sext(bits(i, 20, 12) as u64, 9) as i64;
    let op = crate::decode::decode(i);
    // Pre-index (bit 11) accesses base + imm9, post-index the base.
    let indexed = || (if bit(i, 11) { imm9 } else { 0 }, imm9);
    // Pairs: 24:23 is 01 post-index, 11 pre-index, 10 (or 00) offset.
    let pair = |off: i64| {
        let mode = bits(i, 24, 23);
        (
            if mode != 1 { off } else { 0 },
            if mode & 1 == 1 { off } else { 0 },
        )
    };
    let s = match op {
        STRx_LDRx_imm_2 | STURx_LDURx | STRx_LDRx_imm_1 => {
            let opc = bits(i, 23, 22);
            if opc >= 2 && (size == 3 || (size == 2 && opc == 3)) {
                return None; // PRFM, or UNDEFINED
            }
            let ((off, wb), write) = match op {
                STRx_LDRx_imm_2 => (((bits(i, 21, 10) << size) as i64, 0), opc == 0),
                STURx_LDURx => ((imm9, 0), opc == 0),
                _ => (indexed(), opc == 0),
            };
            let loads = if write { 0 } else { xmask(rt) };
            Shape {
                rn,
                off,
                len: 1 << size,
                write,
                wb,
                fp: false,
                loads,
            }
        }
        STP_LDP_gen | STNP_LDNP_gen => {
            let load = bit(i, 22);
            let len = match (size, load) {
                (0, _) => 4,
                (2, _) => 8,
                (1, true) if op == STP_LDP_gen => 4,
                _ => return None,
            };
            let (off, wb) = pair(sext(bits(i, 21, 15) as u64, 7) as i64 * len as i64);
            let loads = if load { xmask(rt) | xmask(rt2) } else { 0 };
            Shape {
                rn,
                off,
                len: 2 * len as u32,
                write: !load,
                wb,
                fp: false,
                loads,
            }
        }
        STP_LDP_fpsimd | STNP_LDNP_fpsimd => {
            if size == 3 {
                return None;
            }
            let len = 4i64 << size;
            let (off, wb) = pair(sext(bits(i, 21, 15) as u64, 7) as i64 * len);
            Shape {
                rn,
                off,
                len: 2 * len as u32,
                write: !bit(i, 22),
                wb,
                fp: true,
                loads: 0,
            }
        }
        STR_imm_fpsimd_2 | LDR_imm_fpsimd_2 | STUR_fpsimd | LDUR_fpsimd | STR_imm_fpsimd_1
        | LDR_imm_fpsimd_1 => {
            let len = match (size, bit(i, 23)) {
                (0, true) => 16,
                (s, false) => 1 << s,
                _ => return None,
            };
            let (off, wb) = match op {
                STR_imm_fpsimd_2 | LDR_imm_fpsimd_2 => (bits(i, 21, 10) as i64 * len as i64, 0),
                STUR_fpsimd | LDUR_fpsimd => (imm9, 0),
                _ => indexed(),
            };
            Shape {
                rn,
                off,
                len,
                write: !bit(i, 22),
                wb,
                fp: true,
                loads: 0,
            }
        }
        _ => return None,
    };
    Some(s)
}

/// The V registers a group's span (`words`) loads into, and the most bytes
/// one of its SIMD&FP loads writes into each of its registers, zero-extended
/// ([`Func::chain_open`]'s `vzx`).
fn span_vloads(words: &[u32]) -> (u64, u32) {
    let (mut vw, mut vz) = (0, 0);
    for &w in words {
        if let Some(s) = shape(w).filter(|s| s.fp && !s.write) {
            let pair = matches!(
                crate::decode::decode(w),
                Op::STP_LDP_fpsimd | Op::STNP_LDNP_fpsimd
            );
            vw |= vbit(bits(w, 4, 0)) | if pair { vbit(bits(w, 14, 10)) } else { 0 };
            vz = vz.max(if pair { s.len / 2 } else { s.len });
        }
    }
    (vw, vz)
}

/// How instruction `w` (`op`) uses Vt, if it names it: as a scalar FP operand of
/// `Some(esize)` bits a shadow serves without lane ops (arithmetic, a
/// store), or `Some(0)` for any other use of a SIMD&FP instruction or
/// load/store ([`Func::scalar_next`]).
fn scalar_use(w: u32, op: Op, t: u32) -> Option<u32> {
    use Op::*;
    let (d, n, m, a) = (
        bits(w, 4, 0),
        bits(w, 9, 5),
        bits(w, 20, 16),
        bits(w, 14, 10),
    );
    let ty = if bits(w, 23, 22) == 1 { 64 } else { 32 };
    let arith = if bits(w, 23, 22) < 2 { ty } else { 0 };
    match op {
        FADD_float | FSUB_float | FMUL_float | FDIV_float | FNMUL_float if n == t || m == t => {
            return Some(arith);
        }
        FSQRT_float | FABS_float | FNEG_float if n == t => return Some(arith),
        STR_imm_fpsimd_1 | STR_imm_fpsimd_2 | STUR_fpsimd | STR_reg_fpsimd if d == t => {
            return Some(if bit(w, 23) { 0 } else { 8 << bits(w, 31, 30) });
        }
        STP_LDP_fpsimd | STNP_LDNP_fpsimd if !bit(w, 22) && (d == t || a == t) => {
            return Some(32 << bits(w, 31, 30));
        }
        _ => {}
    }
    let simd = bits(w, 28, 25) & 7 == 7 || bits(w, 27, 25) & 5 == 4 && bit(w, 26);
    (simd && (d == t || n == t || m == t || a == t)).then_some(0)
}

/// For each instruction of a block, the V registers whose next use after it
/// is as a single's and as a double's scalar operand ([`scalar_use`]): one
/// backward pass, where a scan from each load was quadratic in the block.
pub fn scalar_uses(words: &[u32]) -> Vec<(u32, u32)> {
    let mut out = vec![(0, 0); words.len()];
    let (mut m32, mut m64) = (0u32, 0u32);
    for (k, &w) in words.iter().enumerate().rev() {
        out[k] = (m32, m64);
        let op = crate::decode::decode(w);
        for t in [
            bits(w, 4, 0),
            bits(w, 9, 5),
            bits(w, 20, 16),
            bits(w, 14, 10),
        ] {
            if let Some(e) = scalar_use(w, op, t) {
                let b = 1 << t;
                m32 = if e == 32 { m32 | b } else { m32 & !b };
                m64 = if e == 64 { m64 | b } else { m64 & !b };
            }
        }
    }
    out
}

/// Whether a block has the two accesses a group needs ([`plan`]).
pub fn may_group(words: &[u32]) -> bool {
    words
        .iter()
        .filter(|&&w| shape(w).is_some())
        .nth(1)
        .is_some()
}

/// Whether instruction `i` may sit between a group's accesses: an integer
/// operation without flags that is inline and leaves `HOST` alone; a write to
/// the base `rn` must add an immediate to it (into `delta`), any other ends the
/// group.
fn between(i: u32, k: usize, cx: &Ctx, rn: u32, delta: &mut i64) -> bool {
    use Op::*;
    let op = crate::decode::decode(i);
    let (rd, rs) = (bits(i, 4, 0), bits(i, 9, 5));
    // Rd 31 is SP for these, XZR for the rest.
    let sp = matches!(
        op,
        ADD_imm | SUB_imm | ADD_ext | SUB_ext | AND_imm | ORR_imm | EOR_imm
    );
    let ok = matches!(
        op,
        MOVZ | MOVN
            | MOVK
            | ADR
            | ADRP
            | ADD_imm
            | SUB_imm
            | ADD_shift
            | SUB_shift
            | ADD_ext
            | SUB_ext
            | AND_imm
            | ORR_imm
            | EOR_imm
            | AND_shift
            | BIC_shift
            | ORR_shift
            | ORN_shift
            | EOR_shift
            | EON
            | SBFM
            | BFM
            | UBFM
            | ASR_1
            | ASR_2
            | SXTB_1
            | SXTB_2
            | SXTH_1
            | SXTH_2
            | SXTW
            | EXTR
            | MADD
            | MSUB
            | NOP
    );
    if !ok || !pure(i, k, cx) {
        return false;
    }
    if op == NOP || rd != rn || (rd == 31 && !sp) {
        return true;
    }
    let imm = match bits(i, 23, 22) {
        0 => bits(i, 21, 10) as i64,
        _ => (bits(i, 21, 10) as i64) << 12,
    };
    match op {
        ADD_imm if rs == rn && bit(i, 31) => *delta = delta.wrapping_add(imm),
        SUB_imm if rs == rn && bit(i, 31) => *delta = delta.wrapping_sub(imm),
        _ => return false,
    }
    true
}

/// Whether instruction `i` (the `k`-th of its block) is inline, leaving the
/// flags, the failure chain and `HOST` alone: emitted once on its own.
fn pure(i: u32, k: usize, cx: &Ctx) -> bool {
    let mut c = Func::default();
    let flags = c.flags;
    inline(&mut c, i, crate::decode::decode(i), k, cx)
        && c.flags == flags
        && c.chain.is_none()
        && !c.c.uses_local(HOST)
}

/// The groups of a block's loads and stores that share one TLB probe: each
/// one of two or more accesses off the same base register, unchanged between
/// them but by writebacks and immediates added to it, over a span within
/// [`SPAN_MAX`] bytes, with at most [`OTHERS`] [`between`] instructions among
/// them. The leader's probe covers the whole span; on a miss, the span's
/// instructions run through the span helper ([`access`]).
pub fn plan(words: &[u32], cx: &Ctx) -> Vec<Role> {
    let mut roles = vec![Role::None; words.len()];
    if !cx.groups || !matches!(cx.bus, Bus::Tlb { .. }) {
        return roles;
    }
    let mut k = 0;
    while k < words.len() {
        k = group(words, k, cx, &mut roles) + 1;
    }
    roles
}

/// The group led by instruction `first`, if any, into `roles`; returns its last
/// instruction (`first` if none).
fn group(words: &[u32], first: usize, cx: &Ctx, roles: &mut [Role]) -> usize {
    let Some(s) = shape(words[first]) else {
        return first;
    };
    if s.loads & 1 << s.rn != 0 {
        return first;
    }
    let rn = s.rn;
    let (mut lo, mut hi) = (s.off, s.off + s.len as i64);
    let (mut fp, mut store) = (s.fp, s.write);
    let mut delta = s.wb;
    // Each access's address from the leader's base, and the best end so far.
    let mut at = vec![(first, s.off)];
    let (mut others, mut best) = (0, None);
    for (k, &w) in words.iter().enumerate().skip(first + 1) {
        let Some(t) = shape(w) else {
            if !between(w, k, cx, rn, &mut delta) {
                break;
            }
            others += 1;
            continue;
        };
        if t.rn != rn || (!MIXED && t.write != s.write) || (rn == 31 && delta % 16 != 0) {
            break;
        }
        let a = delta.wrapping_add(t.off);
        let (l, h) = (lo.min(a), hi.max(a.saturating_add(t.len as i64)));
        if h - l > SPAN_MAX {
            break;
        }
        (lo, hi, fp, store) = (l, h, fp || t.fp, store || t.write);
        at.push((k, a));
        if others <= OTHERS {
            best = Some((at.len(), lo, hi, fp, store));
        }
        delta = delta.wrapping_add(t.wb);
        if t.loads & 1 << rn != 0 {
            break;
        }
    }
    let Some((n, lo, hi, fp, store)) = best else {
        return first;
    };
    let last = at[n - 1].0;
    roles[first] = Role::Lead {
        last,
        lo: lo - s.off,
        span: (hi - lo) as u32,
        off: (s.off - lo) as u32,
        fp,
        store,
    };
    for &(k, a) in &at[1..n] {
        roles[k] = Role::Follow {
            off: (a - lo) as u32,
        };
    }
    last
}

/// ANDs the condition of `g` into the i32 on the stack (an access of `len` bytes).
fn guard(c: &mut Func, g: Guard, len: u32) {
    match g {
        Guard::None => {}
        Guard::Sp | Guard::Aligned => {
            let (l, m) = if g == Guard::Sp {
                (BASE, 15)
            } else {
                (ADDR, len as i64 - 1)
            };
            c.local_get(l).i64_const(m).i64_and().op(EQZ + WC).op(AND);
        }
        Guard::Bits(off, m) => {
            c.local_get(VCPU)
                .i64_load(off)
                .i64_const(m as i64)
                .i64_and();
            c.i64_const(m as i64).op(EQ + WC).op(AND);
        }
    }
}

/// Ends the fast arm of an `if` (its register state in `c`, `before` it at
/// the `if`) with an `else` in which the helper runs instruction `i`, the
/// block returning if it didn't retire; the registers are written back before
/// the call and, after it, the ones in `written` (the instruction's
/// destinations) and any the fast arm loaded are reloaded, so both arms leave
/// the fast arm's register state. Closes the `if`.
fn fallback(c: &mut Func, cx: &Ctx, i: u32, here: i64, before: Regs, written: u64) {
    fallback_with(c, cx, i, here, before, written, |_| {}, |_| {});
}

/// [`fallback`], with `pre` emitted before the helper call and `post` after
/// it returns (the instruction done): for helpers that read or write NZCV.
#[allow(clippy::too_many_arguments)]
fn fallback_with(
    c: &mut Func,
    cx: &Ctx,
    i: u32,
    here: i64,
    before: Regs,
    written: u64,
    pre: impl FnOnce(&mut Func),
    post: impl FnOnce(&mut Func),
) {
    let fast = c.regs;
    c.else_();
    c.note(super::wasm::NOTE_SLOW, (here / 4) as u64, (here / 4) as u64);
    c.regs = before;
    c.flush();
    pre(c);
    c.local_get(VCPU).i32_const(i as i32);
    pc_plus(c, here);
    c.call(cx.helper).hint(false).if_();
    c.store_flags_cold();
    c.ret((here / 4) as u32);
    c.end();
    post(c);
    c.forget(written);
    c.reload(fast);
    // Clean here, maybe dirty there: the merge is dirty (a clean write-back is harmless).
    c.regs = fast;
    c.note(super::wasm::NOTE_SLOW_END, 0, 0);
    c.end();
}

/// [`fallback`] for a load or store ([`access`], whose segment of the open
/// [`Chain`] holds the `if`): only the dirty registers the instruction reads
/// (its fast path's reads so far) or writes are written back before the
/// helper; if it doesn't retire, the arm branches to its segment with the
/// retired count, the segment storing the dirty registers no earlier site's
/// stores (and the chain the lazy flags). The helper reads and writes no
/// other register, and the run loop takes its exception after the block
/// returns, so the rest stay in their locals on both arms. A helper that
/// reports an exit may still have retired the instruction (a device access
/// `Vm::fast` ran, its exit left for the run loop): the registers it writes
/// that an earlier segment stores are reloaded from the `Cpu` on the way.
fn fallback_chain(c: &mut Func, cx: &Ctx, i: u32, here: i64, before: Regs, written: u64) {
    let fast = c.regs;
    c.else_();
    c.note(super::wasm::NOTE_SLOW, (here / 4) as u64, (here / 4) as u64);
    c.regs = before;
    fallback_arm(c, cx, i, here, written, fast, 2);
    c.regs = fast;
    c.note(super::wasm::NOTE_SLOW_END, 0, 0);
    c.end();
}

/// The failure arm of [`fallback_chain`], in its `else` with the registers
/// as they were at the access's `if`, `depth` - 1 `if`s inside the segment;
/// leaves the fast arm's register state `fast`.
fn fallback_arm(c: &mut Func, cx: &Ctx, i: u32, here: i64, written: u64, fast: Regs, depth: u32) {
    let mut need = (c.ireads | written) & c.regs.dirty;
    c.regs.dirty &= !need;
    while need != 0 {
        let n = need.trailing_zeros();
        need &= need - 1;
        c.store_cpu(n);
    }
    let dirty = c.regs.dirty;
    let (o32, o64) = c.regs.only();
    let ch = c.chain.as_mut().expect("access opens a chain");
    let d = dirty & !ch.cum;
    *ch.segs.last_mut().expect("a segment") = (d, d & o32, d & o64);
    ch.cum |= d;
    ch.o32 |= d & o32;
    ch.o64 |= d & o64;
    let (c32, c64) = (ch.o32, ch.o64);
    // Earlier sites' segments store their registers from the locals: those
    // this instruction writes take what the helper left in the `Cpu`, which
    // holds them (stored above, or clean) unless the access retired there and
    // left an exit for the run loop (`Vm::fast`'s device accesses).
    let stale = written & ch.cum;
    c.local_get(VCPU).i32_const(i as i32);
    pc_plus(c, here);
    c.call(cx.helper).hint(false).if_();
    let regs = c.regs;
    let mut m = stale;
    while m != 0 {
        let n = m.trailing_zeros();
        m &= m - 1;
        c.load_as(n, c32 & 1 << n != 0, c64 & 1 << n != 0);
    }
    c.regs = regs;
    // The chain stores lazy flags on the way (its sites share them).
    c.touched.get_or_insert(true);
    if let Flags::Lazy { stored, .. } = &mut c.flags {
        *stored = true;
    }
    // Inside the `if`s of the fast path (and the spill arms) and of the
    // failure: the segment is `depth` out.
    c.i32_const((here / 4) as i32).br(depth);
    c.end();
    c.forget(written);
    c.reload(fast);
    c.regs = fast;
}

/// MRS of a register [`sys::plain`] reads inline at the block's EL (M6 loop
/// 1); false for the rest (timers, `ISR_EL1`, traps: helper calls).
fn mrs(c: &mut Func, cx: &Ctx, i: u32, k: usize) -> bool {
    use crate::interp::sys::{Plain, is_counter_mrs, plain};
    let (rt, key) = (bits(i, 4, 0), bits(i, 20, 5));
    if let Some(now) = cx.clock
        && is_counter_mrs(i)
    {
        counter(c, cx, now, i, k);
        return true;
    }
    if !c.polled && is_counter_mrs(i) {
        step_counter(c, cx, i, k);
        return true;
    }
    if !c.polled
        && cx.el1
        && let Some(t) = crate::interp::sys::timer_reg(key)
    {
        timer_mrs(c, cx, i, k, t);
        return true;
    }
    let Some(p) = plain(key, cx.el1) else {
        return false;
    };
    let field = |c: &mut Func, off: usize| {
        c.local_get(VCPU).i64_load(off as u32);
    };
    match p {
        Plain::Field(off) => set(c, true, rt, |c| field(c, off)),
        Plain::Const(v) => set(c, true, rt, |c| konst(c, true, v)),
        Plain::Pstate(m) => set(c, true, rt, |c| {
            field(c, PSTATE);
            c.i64_const(m as i64).i64_and();
        }),
        Plain::Nzcv => {
            c.commit_flags();
            set(c, true, rt, |c| field(c, NZCV as usize));
        }
        Plain::Dczid0 => set(c, true, rt, |c| {
            // DZP (bit 4) = !SCTLR_EL1.DZE (bit 14), with the block size.
            field(c, offset_of!(Cpu, sctlr_el1));
            c.i64_const(10).op(SHR_U + W).i64_const(16).i64_and();
            c.i64_const(16 | DCZID_BS as i64).op(XOR + W);
        }),
        Plain::SpEl0 => {
            // sp_other while SPSel is 1; else UNDEFINED, which the helper raises.
            field(c, PSTATE);
            c.i32_wrap_i64().i32_const(1).op(AND).hint(true).if_();
            let before = c.regs;
            set(c, true, rt, |c| field(c, offset_of!(Cpu, sp_other)));
            fallback(c, cx, i, 4 * k as i64, before, xmask(rt));
        }
    }
    true
}

/// MRS of CNTVCT_EL0 or CNTPCT_EL0 with the host clock `now` (parallel SMP):
/// `Vm::now`'s reading from the vCPU's [`Counter`](super::Counter), without
/// the helper's call into the core. The helper reads it while the counter is
/// off (`last` 0) and at EL0 without CNTKCTL_EL1's enable (it traps).
fn counter(c: &mut Func, cx: &Ctx, now: u32, i: u32, k: usize) {
    use super::{Counter, State};
    const K: usize = offset_of!(Vcpu, jit) + offset_of!(State, counter);
    const T0: u32 = (K + offset_of!(Counter, t0)) as u32;
    const SCALE: u32 = (K + offset_of!(Counter, scale)) as u32;
    const BASE: u32 = (K + offset_of!(Counter, base)) as u32;
    const LAST: u32 = (K + offset_of!(Counter, last)) as u32;
    const F64_LOAD: u8 = 0x2b;
    let rt = bits(i, 4, 0);
    // Scratch: the reading (i64 2), the last one (i64 3), `last`'s address (i32 6).
    let (t, old, last) = (2, 3, 6);
    c.local_get(VCPU).i32_load(LAST).local_tee(last);
    c.op(EQZ).op(EQZ);
    counter_el0(c, cx, i);
    c.hint(true).if_();
    let before = c.regs;
    c.call(now).local_get(VCPU).memarg(F64_LOAD, 3, T0).op(0xa1); // f64.sub
    c.local_get(VCPU).memarg(F64_LOAD, 3, SCALE).op(0xa2); // f64.mul
    c.op(0xfc).op(7); // i64.trunc_sat_f64_u
    c.local_get(VCPU).i64_load(BASE).op(ADD + W).local_set(t);
    // Raise `last` to it, or read the later reading another vCPU left there.
    c.block().loop_();
    c.local_get(last)
        .atomic(ATOMIC_LOAD[3], 3, 0)
        .local_tee(old)
        .local_get(t)
        .op(GE_U + WC)
        .if_();
    c.local_get(old).local_set(t).br(2);
    c.end();
    c.local_get(last).local_get(old).local_get(t);
    c.atomic(RMW_CMPXCHG + RMW_SIZE[3], 3, 0);
    c.local_get(old).op(NE + WC).hint(false).br_if(0);
    c.end().end();
    set(c, true, rt, |c| {
        c.local_get(t);
    });
    fallback(c, cx, i, 4 * k as i64, before, xmask(rt));
}

/// Pushes whether a counter read at the block's EL may retire inline: at EL0
/// CNTKCTL_EL1's enable (EL0VCTEN, bit 1, for CNTVCT; EL0PCTEN, bit 0, for
/// CNTPCT), without it the read traps; `ok`, an i32 already pushed.
fn counter_el0(c: &mut Func, cx: &Ctx, i: u32) {
    if !cx.el1 {
        let en = if bits(i, 20, 5) == crate::interp::sys::CNTVCT {
            2
        } else {
            1
        };
        c.local_get(VCPU)
            .i64_load(offset_of!(Cpu, cntkctl_el1) as u32);
        c.i64_const(en).i64_and().op(EQZ + WC).op(EQZ).op(AND);
    }
}

/// MRS of CNTVCT_EL0 or CNTPCT_EL0 in counted code (round-robin; PERF loop
/// 47): deterministic time's reading from the chunk's [`StepClock`](super::StepClock),
/// `end - (left - k)` (`left` the steps left at the block's entry, `k` the
/// instructions before this one), what the helper's exit would read; the
/// helper while `end` is 0 (realtime, the xHCI with an event due) and at EL0
/// without CNTKCTL_EL1's enable (it traps).
fn step_counter(c: &mut Func, cx: &Ctx, i: u32, k: usize) {
    let rt = bits(i, 4, 0);
    let t = 2; // i64 scratch: `end`
    c.local_get(VCPU)
        .i64_load(STEP_END)
        .local_tee(t)
        .op(EQZ + WC)
        .op(EQZ);
    counter_el0(c, cx, i);
    c.hint(true).if_();
    let before = c.regs;
    set(c, true, rt, |c| step_now(c, t, k));
    fallback(c, cx, i, 4 * k as i64, before, xmask(rt));
}

/// The step clock's `end` ([`StepClock`](super::StepClock)) in the vCPU.
const STEP_END: u32 = (offset_of!(Vcpu, jit)
    + offset_of!(super::State, ticks)
    + offset_of!(super::StepClock, end)) as u32;

/// Pushes the counter at instruction `k` of the member from the step clock's
/// `end` in local `t`: `end - (left - k)` ([`step_counter`]).
fn step_now(c: &mut Func, t: u32, k: usize) {
    c.local_get(t).local_get(LEFT);
    if k != 0 {
        c.i32_const(k as i32).op(SUB);
    }
    c.i64_extend_i32_u().op(SUB + W);
}

/// MRS of a timer's CTL, CVAL or TVAL at EL1 in counted code (round-robin;
/// PERF loop 49): what `interp::platform` reads at the counter
/// [`step_now`] gives (CTL's ISTATUS: enabled and the count at CVAL or past;
/// TVAL: CVAL less the count, 32 bits); the helper's exit while the step
/// clock's `end` is 0 (realtime, another `ticks_per_insn`, the xHCI with an
/// event due).
fn timer_mrs(c: &mut Func, cx: &Ctx, i: u32, k: usize, t: crate::interp::sys::TimerReg) {
    use crate::interp::sys::Timer;
    let rt = bits(i, 4, 0);
    let (ctl, cval) = (t.ctl as u32, t.cval as u32);
    let end = 2; // i64 scratch
    c.local_get(VCPU)
        .i64_load(STEP_END)
        .local_tee(end)
        .op(EQZ + WC)
        .op(EQZ)
        .hint(true)
        .if_();
    let before = c.regs;
    set(c, true, rt, |c| match t.reg {
        Timer::Cval => {
            c.local_get(VCPU).i64_load(cval);
        }
        Timer::Ctl => {
            c.local_get(VCPU).i64_load(ctl);
            step_now(c, end, k);
            c.local_get(VCPU).i64_load(cval).op(GE_U + WC);
            c.local_get(VCPU).i64_load(ctl).i32_wrap_i64().op(AND);
            c.i32_const(1).op(AND).i64_extend_i32_u();
            c.i64_const(2).op(SHL + W).op(OR + W);
        }
        Timer::Tval => {
            c.local_get(VCPU).i64_load(cval);
            step_now(c, end, k);
            c.op(SUB + W).i64_const(0xffff_ffff).i64_and();
        }
    });
    fallback(c, cx, i, 4 * k as i64, before, xmask(rt));
}

/// MSR of a timer's CTL, CVAL or TVAL at EL1 in counted code (round-robin;
/// PERF loop 49): the write stays in the block when the step clock's `end`
/// is set and the timer's new state doesn't fire before it (disabled,
/// masked, or CVAL at `end` or later). The run loop cut the chunk at the
/// timers' deadlines as they were, so nothing fires within it, and the
/// IRQ lines the write would change (masking a timer that fired) the run
/// loop drives into the GIC when the chunk returns, before its exit or the
/// next look at an IRQ (`StepClock::wrote`). Else the helper's exit.
fn timer_msr(c: &mut Func, cx: &Ctx, i: u32, k: usize, t: crate::interp::sys::TimerReg) {
    use crate::interp::sys::Timer;
    const WROTE: u32 = (offset_of!(Vcpu, jit)
        + offset_of!(super::State, ticks)
        + offset_of!(super::StepClock, wrote)) as u32;
    let rt = bits(i, 4, 0);
    let (ctl, cval) = (t.ctl as u32, t.cval as u32);
    // i64 scratch: `end`, the register's new value.
    let (end, new) = (2, 3);
    c.local_get(VCPU).i64_load(STEP_END).local_set(end);
    get(c, true, rt);
    match t.reg {
        Timer::Ctl => {
            c.i64_const(3).i64_and().local_set(new);
        }
        Timer::Cval => {
            c.local_set(new);
        }
        Timer::Tval => {
            c.i32_wrap_i64().op(0xac); // i64.extend_i32_s
            step_now(c, end, k);
            c.op(ADD + W).local_set(new);
        }
    }
    // `end` set, and the new CTL not enabled-unmasked or the new CVAL at `end` or later.
    c.local_get(end).op(EQZ + WC).op(EQZ);
    if t.reg == Timer::Ctl {
        c.local_get(new);
    } else {
        c.local_get(VCPU).i64_load(ctl).i64_const(3).i64_and();
    }
    c.i64_const(1).op(NE + WC);
    if t.reg == Timer::Ctl {
        c.local_get(VCPU).i64_load(cval);
    } else {
        c.local_get(new);
    }
    c.local_get(end).op(GE_U + WC).op(OR).op(AND);
    c.hint(true).if_();
    let before = c.regs;
    c.local_get(VCPU).local_get(new);
    c.i64_store(if t.reg == Timer::Ctl { ctl } else { cval });
    c.local_get(VCPU).i32_const(1).i32_store(WROTE);
    fallback(c, cx, i, 4 * k as i64, before, 0);
}

/// MSR of a register [`sys::plain_write`] names, DAIFSet, DAIFClr and DIT
/// inline at the block's EL (M6 loop 7, PERF loop 8); false for the rest
/// (helper calls, which end the block unless [`sys::msr_continues`]). A DAIF
/// write that unmasks IRQs stays inline while [`unmask_ok`]; else the helper's
/// `Exit::Resync` lets the run loop take one.
///
/// [`sys::plain_write`]: crate::interp::sys::plain_write
/// [`sys::msr_continues`]: crate::interp::sys::msr_continues
fn msr(c: &mut Func, cx: &Ctx, i: u32, k: usize) -> bool {
    use crate::cpu::{DAIF, PSTATE_DIT};
    use crate::interp::sys::{PlainWrite, plain_write};
    const P: u32 = PSTATE as u32;
    let rt = bits(i, 4, 0);
    let here = 4 * k as i64;
    if bits(i, 20, 19) == 0 {
        let crm = bits(i, 11, 8) as i64;
        match (bits(i, 18, 16), bits(i, 7, 5)) {
            // DAIFSet only masks; DAIFClr at EL1 (EL0 may trap).
            (3, 6) if cx.el1 => {
                c.local_get(VCPU).local_get(VCPU).i64_load(P);
                c.i64_const(crm << 6).op(OR + W).i64_store(P);
            }
            (3, 7) if cx.el1 => {
                c.local_get(VCPU).i64_load(P);
                c.i64_const(!(crm << 6)).i64_and().local_set(VALUE);
                daif(c, cx, i, here);
            }
            (3, 2) if cx.features & crate::cpu::FEATURE_DIT != 0 => {
                c.local_get(VCPU).local_get(VCPU).i64_load(P);
                c.i64_const(!(PSTATE_DIT as i64)).i64_and();
                c.i64_const((crm & 1) << 24).op(OR + W).i64_store(P);
            }
            _ => return false,
        }
        return true;
    }
    if !c.polled
        && cx.el1
        && let Some(t) = crate::interp::sys::timer_reg(bits(i, 20, 5))
    {
        timer_msr(c, cx, i, k, t);
        return true;
    }
    let Some(p) = plain_write(bits(i, 20, 5), cx.el1) else {
        return false;
    };
    match p {
        PlainWrite::Field(off) => {
            c.local_get(VCPU);
            get(c, true, rt);
            c.i64_store(off as u32);
        }
        PlainWrite::SpEl0 => {
            // sp_other while SPSel is 1; else UNDEFINED, which the helper raises.
            c.local_get(VCPU).i64_load(P).i32_wrap_i64();
            c.i32_const(1).op(AND).hint(true).if_();
            let before = c.regs;
            c.local_get(VCPU);
            get(c, true, rt);
            c.i64_store(offset_of!(Cpu, sp_other) as u32);
            fallback(c, cx, i, here, before, 0);
        }
        PlainWrite::Daif => {
            c.local_get(VCPU)
                .i64_load(P)
                .i64_const(!DAIF as i64)
                .i64_and();
            get(c, true, rt);
            c.i64_const(DAIF as i64)
                .i64_and()
                .op(OR + W)
                .local_set(VALUE);
            daif(c, cx, i, here);
        }
    }
    true
}

/// Stores VALUE, the new PSTATE of DAIF write `i`, unless it unmasks IRQs
/// while not [`unmask_ok`] (then the helper runs `i`).
fn daif(c: &mut Func, cx: &Ctx, i: u32, here: i64) {
    use crate::cpu::PSTATE_I;
    const P: u32 = PSTATE as u32;
    c.local_get(VCPU).i64_load(P).local_get(VALUE);
    c.i64_const(-1).op(XOR + W).i64_and();
    c.i64_const(PSTATE_I as i64).i64_and().op(EQZ + WC);
    unmask_ok(c, cx);
    c.op(OR).hint(true).if_();
    let before = c.regs;
    c.local_get(VCPU).local_get(VALUE).i64_store(P);
    fallback(c, cx, i, here, before, 0);
}

/// Pushes whether an MSR that unmasks IRQs may retire inline ([`super::Unmask`]):
/// `ok`, and the byte at `irq` zero (parallel SMP: no IRQ signalled on the
/// vCPU's line; round-robin: no host signal pending) and in parallel SMP no
/// maintenance queued for it (as `Vm::fast` would decide).
fn unmask_ok(c: &mut Func, cx: &Ctx) {
    use super::{State, Unmask};
    const K: usize = offset_of!(Vcpu, jit) + offset_of!(State, unmask);
    const OK: u32 = (K + offset_of!(Unmask, ok)) as u32;
    const IRQ: u32 = (K + offset_of!(Unmask, irq)) as u32;
    const PENDING: u32 = (K + offset_of!(Unmask, pending)) as u32;
    const I32_ATOMIC_LOAD8_U: u8 = 0x12;
    c.local_get(VCPU).i32_load(OK);
    let bytes: &[u32] = if cx.parallel { &[IRQ, PENDING] } else { &[IRQ] };
    for &at in bytes {
        c.local_get(VCPU)
            .i32_load(at)
            .atomic(I32_ATOMIC_LOAD8_U, 0, 0)
            .op(EQZ)
            .op(AND);
    }
}

// i32 opcodes. The i64 twin of an arithmetic one is `W` higher, of a
// comparison `WC` higher.
const W: u8 = 0x12;
const WC: u8 = 0xb;
const CLZ: u8 = 0x67;
const ADD: u8 = 0x6a;
const SUB: u8 = 0x6b;
const MUL: u8 = 0x6c;
const DIV_S: u8 = 0x6d;
const DIV_U: u8 = 0x6e;
const AND: u8 = 0x71;
const OR: u8 = 0x72;
const XOR: u8 = 0x73;
const SHL: u8 = 0x74;
const SHR_S: u8 = 0x75;
const SHR_U: u8 = 0x76;
const ROTR: u8 = 0x78;
const DROP: u8 = 0x1a;
const EQZ: u8 = 0x45;
const EQ: u8 = 0x46;
const NE: u8 = 0x47;
const LT_S: u8 = 0x48;
const LT_U: u8 = 0x49;
const GT_S: u8 = 0x4a;
const GT_U: u8 = 0x4b;
const LE_S: u8 = 0x4c;
const LE_U: u8 = 0x4d;
const GE_S: u8 = 0x4e;
const GE_U: u8 = 0x4f;

/// CRC-32 (reflected, 0xedb88320) and CRC-32C (0x82f63b78) byte tables, the
/// JIT's [`crc32`] reads them in the core's memory (`interp`'s CRC32 is bitwise).
static CRC_TABLES: [[u32; 256]; 2] = [crc_table(0xedb8_8320), crc_table(0x82f6_3b78)];

const fn crc_table(poly: u32) -> [u32; 256] {
    let mut t = [0; 256];
    let mut n = 0;
    while n < 256 {
        let mut x = n as u32;
        let mut k = 0;
        while k < 8 {
            x = (x >> 1) ^ (poly & (x & 1).wrapping_neg());
            k += 1;
        }
        t[n] = x;
        n += 1;
    }
    t
}

/// CRC32B/H/W/X, CRC32CB/H/W/X: a table lookup per byte of Rm, the table's
/// address as the load's offset (the JIT's modules share the core's memory).
fn crc32(c: &mut Func, i: u32, ieee: bool) -> bool {
    let (rd, rn, rm, sz) = (
        bits(i, 4, 0),
        bits(i, 9, 5),
        bits(i, 20, 16),
        bits(i, 11, 10),
    );
    if bit(i, 31) != (sz == 3) {
        return false;
    }
    let table = CRC_TABLES[!ieee as usize].as_ptr() as usize as u32;
    const ACC: u32 = 6;
    const DATA: [u32; 2] = [7, 8];
    get(c, false, rn);
    c.local_set(ACC);
    if sz == 3 {
        get(c, true, rm);
        c.local_tee(2).i32_wrap_i64().local_set(DATA[0]);
        c.local_get(2)
            .i64_const(32)
            .op(SHR_U + W)
            .i32_wrap_i64()
            .local_set(DATA[1]);
    } else {
        get(c, false, rm);
        c.local_set(DATA[0]);
    }
    for b in 0..1u32 << sz {
        // acc = table[(acc ^ byte) & 0xff] ^ acc >> 8
        c.local_get(DATA[b as usize / 4]);
        if b % 4 != 0 {
            c.i32_const(8 * (b % 4) as i32).op(SHR_U);
        }
        c.local_get(ACC).op(XOR).i32_const(0xff).op(AND);
        c.i32_const(2).op(SHL).i32_load(table);
        c.local_get(ACC)
            .i32_const(8)
            .op(SHR_U)
            .op(XOR)
            .local_set(ACC);
    }
    set(c, false, rd, |c| {
        c.local_get(ACC);
    });
    true
}

/// A binary or unary arithmetic op at the operation size.
fn arith(c: &mut Func, sf: bool, op32: u8) {
    c.op(if sf { op32 + W } else { op32 });
}

/// A comparison at the operation size (an i32 result either way).
fn cmp(c: &mut Func, sf: bool, op32: u8) {
    c.op(if sf { op32 + WC } else { op32 });
}

/// The carry into an addition: none, or `NZCV.C` in an i32 local.
#[derive(Clone, Copy)]
enum Carry {
    Zero,
    Dynamic(u32),
}

/// ADD/ADDS/SUB/SUBS (op in bit 30, S in bit 29) of what `x` and `y` push.
/// Without S, Rd 31 is SP if `sp_dest`.
fn addsub(
    c: &mut Func,
    i: u32,
    x: impl FnOnce(&mut Func),
    y: impl FnOnce(&mut Func),
    sp_dest: bool,
) {
    let (sf, sub, s, rd) = (bit(i, 31), bit(i, 30), bit(i, 29), bits(i, 4, 0));
    if !s {
        let v = |c: &mut Func| {
            x(c);
            y(c);
            arith(c, sf, if sub { SUB } else { ADD });
        };
        if sp_dest {
            set_sp(c, sf, rd, v);
        } else {
            set(c, sf, rd, v);
        }
        return;
    }
    let (fx, fy, _) = flag_locals(sf);
    x(c);
    c.local_set(fx);
    y(c);
    c.local_set(fy);
    set(c, sf, rd, |c| {
        c.local_get(fx).local_get(fy);
        arith(c, sf, if sub { SUB } else { ADD });
    });
    c.set_flags(if sub { Kind::Sub } else { Kind::Add }, sf);
}

/// Pushes AddWithCarry's NZCV as an i32 for `r` = `x` + `y` + carry (locals
/// of the operation size): C is `r < x` unsigned, or `r <= x` with a carry
/// in; V is the sign of `(x ^ r) & (y ^ r)`. A subtraction has [`sub_nzcv`].
fn add_nzcv(c: &mut Func, sf: bool, x: u32, y: u32, r: u32, carry: Carry) {
    nz(c, sf, r);
    c.local_get(r).local_get(x);
    match carry {
        Carry::Zero => cmp(c, sf, LT_U),
        Carry::Dynamic(cin) => {
            cmp(c, sf, LT_U);
            c.local_get(r).local_get(x);
            cmp(c, sf, EQ);
            c.local_get(cin).op(AND).op(OR);
        }
    }
    c.i32_const(29).op(SHL).op(OR);
    c.local_get(x).local_get(r);
    arith(c, sf, XOR);
    c.local_get(y).local_get(r);
    arith(c, sf, XOR);
    arith(c, sf, AND);
    sign_to(c, sf, 28);
    c.op(OR);
}

/// Pushes AddWithCarry(x, !y, 1)'s NZCV as an i32 for `r` = `x` - `y` (locals
/// of the operation size): C is `x >= y` unsigned; V is the sign of
/// `(x ^ y) & (x ^ r)`.
fn sub_nzcv(c: &mut Func, sf: bool, x: u32, y: u32, r: u32) {
    nz(c, sf, r);
    c.local_get(x).local_get(y);
    cmp(c, sf, GE_U);
    c.i32_const(29).op(SHL).op(OR);
    c.local_get(x).local_get(y);
    arith(c, sf, XOR);
    c.local_get(x).local_get(r);
    arith(c, sf, XOR);
    arith(c, sf, AND);
    sign_to(c, sf, 28);
    c.op(OR);
}

/// The NZCV helpers a module has ([`nzcv_helper`]): SUBS and ADDS, 32 and 64 bits.
pub const NZCV_HELPERS: usize = 4;

/// Which NZCV helper computes a lazy setter's NZCV: none for ADC (its
/// carry in) and the logical setters (short already).
fn nzcv_index(kind: Kind, sf: bool) -> Option<usize> {
    match kind {
        Kind::Sub => Some(sf as usize),
        Kind::Add => Some(2 + sf as usize),
        Kind::Adc | Kind::Logic => None,
    }
}

/// NZCV helper `k` ([`nzcv_index`]): a function `(x, y) -> nzcv` of the
/// operation size's type, returning SUBS's or ADDS's NZCV as [`nzcv_of`]
/// pushes it; its body and its one local (the result).
pub fn nzcv_helper(k: usize) -> (bool, Code, u8) {
    let (sub, sf) = (k < 2, k % 2 == 1);
    let mut c = Func::default();
    c.local_get(0).local_get(1);
    arith(&mut c, sf, if sub { SUB } else { ADD });
    c.local_set(2);
    if sub {
        sub_nzcv(&mut c, sf, 0, 1, 2);
    } else {
        add_nzcv(&mut c, sf, 0, 1, 2, Carry::Zero);
    }
    c.end();
    (sf, c.c, if sf { I64 } else { I32 })
}

/// Pushes the NZCV of a lazy setter as an i32 (scratch: `tmp(sf, 2)`).
fn nzcv_of(c: &mut Func, kind: Kind, sf: bool) {
    let (x, y, r) = flag_locals(sf);
    let tr = tmp(sf, 2);
    match kind {
        Kind::Logic => nz(c, sf, r),
        Kind::Adc => add_nzcv(c, sf, x, y, r, Carry::Dynamic(FC)),
        Kind::Add => {
            c.local_get(x).local_get(y);
            arith(c, sf, ADD);
            c.local_set(tr);
            add_nzcv(c, sf, x, y, tr, Carry::Zero);
        }
        Kind::Sub => {
            c.local_get(x).local_get(y);
            arith(c, sf, SUB);
            c.local_set(tr);
            sub_nzcv(c, sf, x, y, tr);
        }
    }
}

/// Pushes an i32 that is non-zero iff condition `cond` holds for the current
/// flags: from a lazy setter's operands where its kind has a direct form,
/// else from its NZCV computed in registers or from NZCV in memory.
fn cond(c: &mut Func, cond: u32) {
    if cond >> 1 == 7 {
        c.i32_const(1);
        return;
    }
    c.touched.get_or_insert(true);
    match c.flags {
        Flags::Mem => {
            c.counts.cond_memory += 1;
            c.local_get(VCPU).i32_load(NZCV);
            holds(c, cond);
        }
        Flags::Lazy { kind, sf, .. } => {
            if direct(c, kind, sf, cond) {
                c.counts.cond_direct += 1;
            } else {
                c.counts.cond_computed += 1;
                nzcv_of(c, kind, sf);
                holds(c, cond);
            }
        }
    }
}

/// The comparison that is false exactly where `op` is true.
fn negate(op: u8) -> u8 {
    match op {
        EQ => NE,
        NE => EQ,
        LT_S => GE_S,
        GE_S => LT_S,
        LT_U => GE_U,
        GE_U => LT_U,
        GT_S => LE_S,
        LE_S => GT_S,
        GT_U => LE_U,
        LE_U => GT_U,
        _ => unreachable!(),
    }
}

/// Emits `cond` (not AL/NV) as one comparison on a lazy setter's operands, if
/// its kind has one: SUBS compares x with y (EQ `x == y`, CS `x >= y`
/// unsigned, HI `x > y` unsigned, GE and GT signed), ADDS and the logical
/// setters test the result (EQ, MI; ADDS's CS is `x + y < x` unsigned; the
/// logical ones have C = V = 0). False (nothing emitted) otherwise.
fn direct(c: &mut Func, kind: Kind, sf: bool, cond: u32) -> bool {
    let (x, y, r) = flag_locals(sf);
    let inv = cond & 1 == 1;
    let result = |c: &mut Func| {
        match kind {
            Kind::Logic => drop(c.local_get(r)),
            _ => {
                c.local_get(x).local_get(y);
                arith(c, sf, if kind == Kind::Sub { SUB } else { ADD });
            }
        }
        konst(c, sf, 0);
    };
    let op = match (kind, cond >> 1) {
        (Kind::Adc, _) => return false,
        (Kind::Sub, 0 | 1 | 4 | 5 | 6) => {
            c.local_get(x).local_get(y);
            [EQ, GE_U, 0, 0, GT_U, GE_S, GT_S][(cond >> 1) as usize]
        }
        (Kind::Add, 1) => {
            c.local_get(x).local_get(y);
            arith(c, sf, ADD);
            c.local_get(x);
            LT_U
        }
        (_, 0) => {
            result(c);
            EQ
        }
        (_, 2) => {
            result(c);
            LT_S
        }
        // Logical: C and V clear, so CS, VS and HI never hold; GE is N clear,
        // GT is N and Z clear.
        (Kind::Logic, 1 | 3 | 4) => {
            c.i32_const(inv as i32);
            return true;
        }
        (Kind::Logic, 5) => {
            result(c);
            GE_S
        }
        (Kind::Logic, 6) => {
            result(c);
            GT_S
        }
        _ => return false,
    };
    cmp(c, sf, if inv { negate(op) } else { op });
    true
}

/// Pushes C (0 or 1) of the current flags, for ADC and SBC.
fn carry(c: &mut Func) {
    c.touched.get_or_insert(true);
    match c.flags {
        Flags::Mem => {
            c.counts.cond_memory += 1;
            c.local_get(VCPU).i32_load(NZCV).i32_const(29).op(SHR_U);
            c.i32_const(1).op(AND);
        }
        Flags::Lazy {
            kind: Kind::Adc,
            sf,
            ..
        } => {
            c.counts.cond_computed += 1;
            nzcv_of(c, Kind::Adc, sf);
            c.i32_const(29).op(SHR_U).i32_const(1).op(AND);
        }
        Flags::Lazy { kind, sf, .. } => {
            c.counts.cond_direct += 1;
            // CS, a comparison: 0 or 1.
            assert!(direct(c, kind, sf, 2));
        }
    }
}

/// Pushes an i32 that is non-zero iff condition `cond` (not AL/NV) holds for
/// the NZCV on the stack (ConditionHolds): GE and GT line N up with V
/// (`n ^ n << 3`) and Z (`n << 1`) in the sign bit.
fn holds(c: &mut Func, cond: u32) {
    let n = tmp(false, 3);
    let invert = cond & 1 == 1;
    match cond >> 1 {
        b @ 0..=3 => {
            c.i32_const([0x4000_0000, 0x2000_0000, 0x8000_0000u32 as i32, 0x1000_0000][b as usize]);
            c.op(AND);
            if invert {
                c.op(EQZ);
            }
        }
        4 => {
            // HI: C set and Z clear.
            c.i32_const(0x6000_0000).op(AND).i32_const(0x2000_0000);
            c.op(if invert { NE } else { EQ });
        }
        b => {
            c.local_tee(n).local_get(n).i32_const(3).op(SHL).op(XOR);
            if b == 6 {
                c.local_get(n).i32_const(1).op(SHL).op(OR);
            }
            c.i32_const(0).op(if invert { LT_S } else { GE_S });
        }
    }
}

/// Pushes N and Z of the result in local `r`, in place in an i32.
fn nz(c: &mut Func, sf: bool, r: u32) {
    c.local_get(r);
    sign_to(c, sf, 31);
    c.local_get(r);
    cmp(c, sf, EQZ);
    c.i32_const(30).op(SHL).op(OR);
}

/// Turns the value on the stack into an i32 holding just its sign bit, moved to bit `p`.
fn sign_to(c: &mut Func, sf: bool, p: u32) {
    if sf {
        c.i64_const(63 - p as i64).op(SHR_U + W).i32_wrap_i64();
    } else if p < 31 {
        c.i32_const(31 - p as i32).op(SHR_U);
    }
    c.i32_const((1u32 << p) as i32).op(AND);
}

/// AND/ORR/EOR/ANDS (opc in 30:29) of what `x` (none: zero) and `y` push.
/// Without S, Rd 31 is SP if `sp_dest`; ANDS sets N and Z and clears C and V.
fn logical(
    c: &mut Func,
    i: u32,
    x: Option<&dyn Fn(&mut Func)>,
    y: impl FnOnce(&mut Func),
    sp_dest: bool,
) {
    let (sf, rd, opc) = (bit(i, 31), bits(i, 4, 0), bits(i, 30, 29));
    let v = |c: &mut Func| {
        let Some(x) = x else {
            return y(c); // ORR with zero
        };
        x(c);
        y(c);
        arith(c, sf, [AND, OR, XOR, AND][opc as usize]);
    };
    if opc != 3 {
        return if sp_dest {
            set_sp(c, sf, rd, v)
        } else {
            set(c, sf, rd, v)
        };
    }
    let (_, _, r) = flag_locals(sf);
    v(c);
    c.local_set(r);
    set(c, sf, rd, |c| {
        c.local_get(r);
    });
    c.set_flags(Kind::Logic, sf);
}

/// A shift of the value on the stack by a constant; nothing for 0.
fn shift(c: &mut Func, sf: bool, op32: u8, amt: u32) {
    if amt != 0 {
        konst(c, sf, amt as u64);
        arith(c, sf, op32);
    }
}

/// Pushes the shifted-register operand (Rm, shift type 23:22, amount 15:10).
fn shifted(c: &mut Func, i: u32) {
    let (sf, amt) = (bit(i, 31), bits(i, 15, 10));
    get(c, sf, bits(i, 20, 16));
    shift(
        c,
        sf,
        [SHL, SHR_U, SHR_S, ROTR][bits(i, 23, 22) as usize],
        amt,
    );
}

/// Pushes the extended-register operand (Rm, option 15:13, left shift 12:10 ≤ 4).
fn extended(c: &mut Func, i: u32) {
    let sf = bit(i, 31);
    extend(c, sf, bits(i, 20, 16), bits(i, 15, 13), bits(i, 12, 10));
}

/// Pushes ExtendReg(Rm, `option`, `amt`) at the operation size.
fn extend(c: &mut Func, sf: bool, rm: u32, option: u32, amt: u32) {
    get(c, sf, rm);
    match (option, sf) {
        (0, _) => mask(c, sf, 0xff),
        (1, _) => mask(c, sf, 0xffff),
        (2, true) => mask(c, sf, 0xffff_ffff),
        // i32/i64.extend8_s, extend16_s, i64.extend32_s.
        (4, _) => drop(c.op(if sf { 0xc2 } else { 0xc0 })),
        (5, _) => drop(c.op(if sf { 0xc3 } else { 0xc1 })),
        (6, true) => drop(c.op(0xc4)),
        _ => {} // UXTW/SXTW at 32 bits, UXTX/SXTX
    }
    shift(c, sf, SHL, amt);
}

/// Swaps the adjacent `sh`-bit fields of the value on the stack: `m` selects
/// the low field of each pair.
fn swap(c: &mut Func, sf: bool, sh: u32, m: u64) {
    let x = tmp(sf, 3);
    c.local_tee(x);
    shift(c, sf, SHR_U, sh);
    mask(c, sf, m);
    c.local_get(x);
    mask(c, sf, m);
    shift(c, sf, SHL, sh);
    arith(c, sf, OR);
}

/// Reverses the bytes of the value on the stack.
fn bswap(c: &mut Func, sf: bool) {
    swap(c, sf, 8, 0x00ff_00ff_00ff_00ff);
    if sf {
        swap(c, sf, 16, 0x0000_ffff_0000_ffff);
    }
    shift(c, sf, ROTR, if sf { 32 } else { 16 });
}

/// Pushes the high 64 bits of Xn × Xm, from 32-bit halves; signed, it
/// subtracts `b` if `a` < 0 and `a` if `b` < 0 from the unsigned result.
fn mulh(c: &mut Func, signed: bool, rn: u32, rm: u32) {
    let (a, b, u, w) = (2, 3, 4, 5);
    let lo = |c: &mut Func, v: u32| {
        c.local_get(v);
        mask(c, true, 0xffff_ffff);
    };
    let hi = |c: &mut Func, v: u32| {
        c.local_get(v);
        shift(c, true, SHR_U, 32);
    };
    get(c, true, rn);
    c.local_set(a);
    get(c, true, rm);
    c.local_set(b);
    // u = hi(a) lo(b) + (lo(a) lo(b) >> 32)
    hi(c, a);
    lo(c, b);
    arith(c, true, MUL);
    lo(c, a);
    lo(c, b);
    arith(c, true, MUL);
    shift(c, true, SHR_U, 32);
    arith(c, true, ADD);
    c.local_set(u);
    // w = lo(u) + lo(a) hi(b)
    lo(c, u);
    lo(c, a);
    hi(c, b);
    arith(c, true, MUL);
    arith(c, true, ADD);
    c.local_set(w);
    // hi(a) hi(b) + hi(u) + hi(w)
    hi(c, a);
    hi(c, b);
    arith(c, true, MUL);
    hi(c, u);
    arith(c, true, ADD);
    hi(c, w);
    arith(c, true, ADD);
    if signed {
        for (s, v) in [(a, b), (b, a)] {
            c.local_get(s);
            shift(c, true, SHR_S, 63);
            c.local_get(v);
            arith(c, true, AND);
            arith(c, true, SUB);
        }
    }
}

fn mask(c: &mut Func, sf: bool, m: u64) {
    konst(c, sf, m);
    arith(c, sf, AND);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::decode;

    const FLAT: Ctx = Ctx {
        helper: 0,
        bus: Bus::Flat {
            base: 0x10000,
            phys: 0,
            size: 0x1000,
        },
        el1: false,
        crypto: true,
        sha3: true,
        jscvt: true,
        features: crate::cpu::FEATURES,
        fma: false,
        parallel: false,
        pair_locks: 0x100,
        clock: None,
        spill: 0,
        groups: true,
        span: 0,
    };

    /// Through the TLB at EL1.
    const TLB: Ctx = Ctx {
        bus: Bus::Tlb {
            read: tlb_array(1, 0),
        },
        el1: true,
        ..FLAT
    };

    /// [`Regs::merge`]'s shadow forms (docs/jit.md "Scalar shadows"): V0 in
    /// each pair of side forms, the merged form.
    #[test]
    fn merged_shadow_forms() {
        let b = vbit(0);
        let (none, v128) = (
            Regs::default(),
            Regs {
                valid: b,
                dirty: b,
                ..Regs::default()
            },
        );
        let s = |w: u32, dirty: bool| Regs {
            s32: if w == 32 { b } else { 0 },
            s64: if w == 64 { b } else { 0 },
            dirty: if dirty { b } else { 0 },
            ..Regs::default()
        };
        // Dirty in one shadow on both sides: kept so (the shadow zero-extended).
        assert_eq!(s(64, true).merge(s(64, true), 0), s(64, true));
        assert_eq!(s(32, true).merge(s(32, true), 0), s(32, true));
        // Against a clean side or the function's entry (not held): clean in
        // the shadow, the dirty edge storing it.
        assert_eq!(s(64, true).merge(none, 0), s(64, false));
        assert_eq!(none.merge(s(64, true), 0), s(64, false));
        assert_eq!(s(32, false).merge(s(32, true), 0), s(32, false));
        // The two shadows, or a v128: a v128, dirty if either side is.
        assert_eq!(s(32, true).merge(s(64, true), 0), v128);
        assert_eq!(
            s(64, false).merge(s(32, false), 0),
            Regs {
                valid: b,
                ..Regs::default()
            }
        );
        let both = Regs { s64: b, ..v128 };
        assert_eq!(s(64, true).merge(both, 0), both);
        assert_eq!(s(64, true).merge(v128, 0), v128);
        assert_eq!(s(64, true).merge(s(64, true), b), none);
        // Loosened: clean in the shadow; a v128 stays dirty.
        assert_eq!(s(64, true).loose(), s(64, false));
        assert_eq!(both.loose(), both);
        assert!(
            !Regs {
                s32: b,
                s64: b,
                ..Regs::default()
            }
            .sound()
        );
    }

    /// [`scalar_uses`] gives, after each instruction, the V registers whose
    /// next use is a scalar operand of each size.
    #[test]
    fn next_scalar_uses() {
        // ldr d1, [x9]; ldr s2, [x9]; fadd d5, d5, d1; str s2, [x9]; ldr d3, [x9];
        // add v3.2d, v3.2d, v3.2d; ldr d4, [x9] (a load's or store's base, an
        // X register, and any field of the word, count as naming a V register
        // of that number: only a hint).
        let w = [
            0xfd400121, 0xbd400122, 0x1e6128a5, 0xbd000122, 0xfd400123, 0x4ee38463, 0xfd400124,
        ];
        let u = scalar_uses(&w);
        assert_eq!(u[0], (0, 0b100010));
        assert_eq!(u[1], (0b100, 0b100010));
        assert_eq!(u[2], (0b100, 0));
        assert_eq!(u[3], (0, 0));
        assert_eq!(u[4], (0, 0));
        // The backward pass agrees with a scan forward from each instruction,
        // on blocks of the words it cares about with few registers.
        let mut x = 0x9e37_79b9_7f4a_7c15u64;
        let mut rand = || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x as u32
        };
        let pool = [
            0x1e612800, 0x1e212800, 0x1e61c000, 0xfd400000, 0xbd000000, 0x2d000000, 0x4ee08400,
        ];
        for _ in 0..200 {
            let w: Vec<u32> = (0..24)
                .map(|_| pool[rand() as usize % pool.len()] | (rand() & 0x0003_7c63))
                .collect();
            let u = scalar_uses(&w);
            for at in 0..w.len() {
                for t in 0..32 {
                    let next = w[at + 1..]
                        .iter()
                        .find_map(|&v| scalar_use(v, decode(v), t));
                    let (m32, m64) = u[at];
                    assert_eq!(next == Some(32), m32 & 1 << t != 0, "{w:x?} at {at}, V{t}");
                    assert_eq!(next == Some(64), m64 & 1 << t != 0, "{w:x?} at {at}, V{t}");
                }
            }
        }
        assert_eq!(u[6], (0, 0));
    }

    #[test]
    fn groups_of_accesses() {
        use Role::*;
        let lead = |last, lo, span, off| Lead {
            last,
            lo,
            span,
            off,
            fp: false,
            store: false,
        };
        let stores = |last, lo, span, off| Lead {
            last,
            lo,
            span,
            off,
            fp: false,
            store: true,
        };
        // ldr x2, [x15]; ldr x1, [x15, #8]; ldur x0, [x15, #-8]; ubfx; ldr x3, [x17, x18, lsl #3]
        let w = [0xf94001e2, 0xf94005e1, 0xf85f81e0, 0xd3432df2, 0xf8727a23];
        assert_eq!(
            plan(&w, &TLB),
            [
                lead(2, -8, 24, 8),
                Follow { off: 16 },
                Follow { off: 0 },
                None,
                None
            ]
        );
        // Nothing with the MMU off, or switched off.
        assert!(plan(&w, &FLAT).iter().all(|&r| r == None));
        assert!(
            plan(
                &w,
                &Ctx {
                    groups: false,
                    ..TLB
                }
            )
            .iter()
            .all(|&r| r == None)
        );
        // ldr x0, [x15], #8; add x15, x15, #8; ldr x1, [x15]; ldur x2, [x15, #-16]:
        // the base moves by 16 before the second access.
        let w = [0xf84085e0, 0x910021ef, 0xf94001e1, 0xf85f01e2];
        assert_eq!(
            plan(&w, &TLB),
            [
                lead(3, 0, 24, 0),
                None,
                Follow { off: 16 },
                Follow { off: 0 }
            ]
        );
        // Up to OTHERS instructions among the accesses; past them the group ends.
        assert_eq!(
            plan(&w[..3], &TLB),
            [lead(2, 0, 24, 0), None, Follow { off: 16 }]
        );
        let add = 0x91000421; // add x1, x1, #1
        let w = [0xf9400002, add, add, add, add, 0xf9400403];
        assert_eq!(plan(&w, &TLB)[5], Follow { off: 8 });
        let w = [0xf9400002, add, add, add, add, add, 0xf9400403];
        assert!(plan(&w, &TLB).iter().all(|&r| r == None));
        // ldr x1, [x0, #8]; ldr x0, [x0]; ldr x2, [x0]: a load of the base ends the group.
        let w = [0xf9400401, 0xf9400000, 0xf9400002];
        assert_eq!(
            plan(&w, &TLB),
            [lead(1, -8, 16, 8), Follow { off: 0 }, None]
        );
        // Loads and stores together (the write array's probe); another base apart:
        // str x1, [x0]; ldr x2, [x0, #8]; ldr x3, [x0, #16]; ldr x4, [x5]
        let w = [0xf9000001, 0xf9400402, 0xf9400803, 0xf94000a4];
        assert_eq!(
            plan(&w, &TLB),
            [
                stores(2, 0, 24, 0),
                Follow { off: 8 },
                Follow { off: 16 },
                None
            ]
        );
        // stp x29, x30, [sp, #-32]!; mov x29, sp; stp x19, x20, [sp, #16]: the
        // prologue, SP's writeback a multiple of 16.
        let w = [0xa9be7bfd, 0x910003fd, 0xa90153f3, 0xa9025bf5];
        assert_eq!(
            plan(&w, &TLB),
            [
                stores(3, 0, 48, 0),
                None,
                Follow { off: 16 },
                Follow { off: 32 }
            ]
        );
        // SIMD&FP members: ldp q0, q1, [x1]; ldp q2, q3, [x1, #32]
        let w = [0xad400420, 0xad410c22];
        assert_eq!(
            plan(&w, &TLB),
            [
                Lead {
                    last: 1,
                    lo: 0,
                    span: 64,
                    off: 0,
                    fp: true,
                    store: false
                },
                Follow { off: 32 }
            ]
        );
    }

    fn emit(i: u32, k: usize) -> Option<Vec<u8>> {
        emit_in(i, k, &FLAT)
    }

    fn emit_in(i: u32, k: usize, cx: &Ctx) -> Option<Vec<u8>> {
        let mut c = Func::default();
        let ok = inline(&mut c, i, decode(i), k, cx);
        c.chain_close();
        ok.then_some(c.c.b)
    }

    /// As [`emit`], the registers written back after (as at a block's end).
    fn emit_flushed(i: u32) -> Vec<u8> {
        let mut c = Func::default();
        assert!(inline(&mut c, i, decode(i), 0, &FLAT));
        c.chain_close();
        c.flush();
        c.c.b
    }

    /// `needle` occurs in `hay`.
    fn has(hay: &[u8], needle: &[u8]) -> bool {
        hay.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn counter_reads_inline_with_the_clock() {
        use crate::jit::wasm::uleb;
        // MRS X3, CNTVCT_EL0: a helper call in polled code without the clock.
        let mrs = 0xd53be043;
        let mut polled = Func {
            polled: true,
            ..Func::default()
        };
        assert!(!inline(&mut polled, mrs, decode(mrs), 0, &FLAT));
        let par = Ctx {
            clock: Some(9),
            parallel: true,
            ..FLAT
        };
        let has = |b: &[u8], w: &[u8]| b.windows(w.len()).any(|x| x == w);
        // CNTKCTL_EL1's offset, as the EL0 check loads it.
        let mut kctl = vec![0x29, 3];
        uleb(&mut kctl, offset_of!(Cpu, cntkctl_el1) as u64);
        let el0 = emit_in(mrs, 0, &par).unwrap();
        assert!(has(&el0, &[0x10, 9]), "the clock's call");
        assert!(has(&el0, &kctl), "EL0 checks EL0VCTEN");
        let el1 = emit_in(mrs, 0, &Ctx { el1: true, ..par }).unwrap();
        assert!(has(&el1, &[0x10, 9]) && !has(&el1, &kctl));
        // CNTFRQ_EL0 isn't the counter.
        assert!(!has(
            &emit_in(0xd53be003, 0, &par).unwrap_or_default(),
            &[0x10, 9]
        ));
    }

    /// Counted code reads the deterministic counter from the chunk's
    /// `StepClock` (PERF loop 47): `end - (left - k)`, no clock.
    #[test]
    fn counter_reads_inline_from_the_step_clock() {
        use crate::jit::wasm::uleb;
        use crate::jit::{State, StepClock};
        let mrs = 0xd53be043; // MRS X3, CNTVCT_EL0
        let at = |f: usize| {
            let mut b = vec![0x29, 3]; // i64.load
            uleb(
                &mut b,
                (offset_of!(Vcpu, jit) + offset_of!(State, ticks) + f) as u64,
            );
            b
        };
        let end = at(offset_of!(StepClock, end));
        let mut kctl = vec![0x29, 3];
        uleb(&mut kctl, offset_of!(Cpu, cntkctl_el1) as u64);
        let el0 = emit_in(mrs, 5, &FLAT).unwrap();
        assert!(has(&el0, &end), "the step clock");
        assert!(has(&el0, &kctl), "EL0 checks EL0VCTEN");
        // end - (left - 5), left extended.
        assert!(has(&el0, &[0x20, LEFT as u8, 0x41, 5, 0x6b, 0xad, 0x7d]));
        let el1 = emit_in(mrs, 0, &Ctx { el1: true, ..FLAT }).unwrap();
        assert!(has(&el1, &end) && !has(&el1, &kctl));
        assert!(
            has(&el1, &[0x20, LEFT as u8, 0xad, 0x7d]),
            "k 0: left alone"
        );
        // CNTFRQ_EL0 isn't the counter.
        assert!(!has(
            &emit_in(0xd53be003, 0, &FLAT).unwrap_or_default(),
            &end
        ));
    }

    /// Counted code reads and writes the timers' CTL, CVAL and TVAL at EL1
    /// from the chunk's `StepClock` (PERF loop 49); the helper at EL0.
    #[test]
    fn timer_registers_inline_from_the_step_clock() {
        use crate::jit::wasm::uleb;
        use crate::jit::{State, StepClock};
        const EL1: Ctx = Ctx { el1: true, ..FLAT };
        let op = |code: u8, align: u8, off: usize| {
            let mut b = vec![code, align];
            uleb(&mut b, off as u64);
            b
        };
        let ticks = offset_of!(Vcpu, jit) + offset_of!(State, ticks);
        let end = op(0x29, 3, ticks + offset_of!(StepClock, end));
        let wrote = op(0x36, 2, ticks + offset_of!(StepClock, wrote));
        let (ctl, cval) = (
            offset_of!(Cpu, cntv_ctl_el0),
            offset_of!(Cpu, cntv_cval_el0),
        );
        let pctl = offset_of!(Cpu, cntp_ctl_el0);
        // MRS X3, CNTV_CTL_EL0: ISTATUS from `end - (left - 2)` against CVAL.
        let r = emit_in(0xd53be323, 2, &EL1).unwrap();
        assert!(has(&r, &end) && has(&r, &op(0x29, 3, ctl)) && has(&r, &op(0x29, 3, cval)));
        assert!(has(&r, &[0x20, LEFT as u8, 0x41, 2, 0x6b, 0xad, 0x7d]));
        assert!(!has(&r, &wrote));
        // MSR CNTV_CVAL_EL0, X3: CVAL stored, CTL only read; the run loop told.
        let w = emit_in(0xd51be343, 0, &EL1).unwrap();
        assert!(has(&w, &end) && has(&w, &op(0x37, 3, cval)) && has(&w, &wrote));
        assert!(!has(&w, &op(0x37, 3, ctl)));
        // MSR CNTV_CTL_EL0, X3: CTL stored.
        let w = emit_in(0xd51be323, 0, &EL1).unwrap();
        assert!(has(&w, &op(0x37, 3, ctl)) && !has(&w, &op(0x37, 3, cval)));
        // MSR CNTP_TVAL_EL0, X3: the physical timer's CVAL from the counter.
        let w = emit_in(0xd51be203, 1, &EL1).unwrap();
        let pcval = op(0x37, 3, offset_of!(Cpu, cntp_cval_el0));
        assert!(has(&w, &pcval) && has(&w, &op(0x29, 3, pctl)));
        // At EL0 (CNTKCTL_EL1 may trap them), the helper; and the MSRs don't end a block.
        assert_eq!(emit_in(0xd53be323, 0, &FLAT), None);
        assert_eq!(emit_in(0xd51be343, 0, &FLAT), None);
        for w in [0xd51be323, 0xd51be343, 0xd51be303, 0xd51be203] {
            assert_eq!(crate::jit::block::end(w), crate::jit::block::End::No);
        }
    }

    #[test]
    fn system_register_reads() {
        const EL1: Ctx = Ctx { el1: true, ..FLAT };
        // mrs x1, tpidr_el1 at EL1: vcpu; i64.load 992; local.set x1.
        assert_eq!(
            emit_in(0xd538d081, 0, &EL1).unwrap(),
            [0x20, 0, 0x29, 3, 0xe0, 7, 0x21, 17]
        );
        // At EL0 it's UNDEFINED: the helper raises it.
        assert_eq!(emit(0xd538d081, 0), None);
        // mrs x1, currentel: a constant (cntvct_el0: counter_reads_inline_from_the_step_clock).
        assert_eq!(emit_in(0xd5384241, 0, &EL1).unwrap(), [0x42, 4, 0x21, 17]);
        // mrs x1, sp_el0 at EL1: sp_other (840) under `if pstate & 1`, the helper otherwise.
        let b = emit_in(0xd5384101, 0, &EL1).unwrap();
        assert!(has(&b, &[0x20, 0, 0x29, 3, 0xc0, 6])); // pstate
        assert!(has(&b, &[0x20, 0, 0x29, 3, 0xc8, 6])); // sp_other
        assert!(has(&b, &[0x10, 0])); // call helper 0
        // Barriers: nothing on one thread; in parallel SMP an atomic.fence
        // (DSB: the helper).
        assert_eq!(emit(0xd5033bbf, 0).unwrap(), []); // dmb ish
        assert_eq!(emit(0xd5033f9f, 0).unwrap(), []); // dsb sy
        let par = Ctx {
            parallel: true,
            ..FLAT
        };
        assert_eq!(emit_in(0xd5033bbf, 0, &par).unwrap(), [0xfe, 3, 0]); // dmb ish
        assert_eq!(emit_in(0xd50339bf, 0, &par).unwrap(), [0xfe, 3, 0]); // dmb ishld
        assert_eq!(emit_in(0xd5033f9f, 0, &par), None); // dsb sy
    }

    #[test]
    fn casp_inline() {
        // The pair lock's xchg (i32.atomic.rmw.xchg, align 2, offset 0x100).
        let xchg = [0xfe, RMW_XCHG, 2, 0x80, 2];
        let par = Ctx {
            parallel: true,
            ..FLAT
        };
        // casp x0, x1, x2, x3, [x4]: under the lock in parallel SMP only.
        let b = emit(0x48207c82, 0).unwrap();
        assert!(!b.windows(5).any(|w| w == xchg));
        let b = emit_in(0x48207c82, 0, &par).unwrap();
        assert!(b.windows(5).any(|w| w == xchg));
        // casp w0, w1, w2, w3, [x4]: one 64-bit cmpxchg, no lock.
        let b = emit_in(0x08207c82, 0, &par).unwrap();
        assert!(!b.windows(5).any(|w| w == xchg));
        let cmpxchg = [0xfe, RMW_CMPXCHG + RMW_SIZE[3], 3];
        assert_eq!(b.windows(3).filter(|w| *w == cmpxchg).count(), 1);
        // Odd registers are UNDEFINED: the helper's.
        assert_eq!(emit(0x48217c82, 0), None); // Rs = x1
        assert_eq!(emit(0x48207c83, 0), None); // Rt = x3
    }

    #[test]
    fn exclusive_pairs_inline() {
        let xchg = [0xfe, RMW_XCHG, 2, 0x80, 2];
        let cmpxchg = [0xfe, RMW_CMPXCHG + RMW_SIZE[3], 3];
        let par = Ctx {
            parallel: true,
            ..FLAT
        };
        // ldxp x0, x1, [x2]; stxp w3, x0, x1, [x2]: under the lock in parallel
        // SMP only, the store a cmpxchg of each half.
        for w in [0xc87f0440, 0xc8230440] {
            assert!(!emit(w, 0).unwrap().windows(5).any(|b| b == xchg));
            assert!(emit_in(w, 0, &par).unwrap().windows(5).any(|b| b == xchg));
        }
        let b = emit(0xc8230440, 0).unwrap();
        assert_eq!(b.windows(3).filter(|w| *w == cmpxchg).count(), 2);
        // ldaxp w0, w1, [x2]; stlxp w3, w0, w1, [x2]: one 8-byte access, no lock.
        for w in [0x887f8440, 0x88238440] {
            assert!(!emit_in(w, 0, &par).unwrap().windows(5).any(|b| b == xchg));
        }
        let b = emit(0x88238440, 0).unwrap();
        assert_eq!(b.windows(3).filter(|w| *w == cmpxchg).count(), 1);
    }

    #[test]
    fn opaque_self_zero_in_parallel() {
        let par = Ctx {
            parallel: true,
            ..FLAT
        };
        // eor w2, w0, w0; sub x2, x0, x0: in parallel SMP, x0 & the zero global
        // (global.get 0); on one thread, a plain xor/sub.
        for (i, op) in [(0x4a000002, XOR), (0xcb000002, SUB + W)] {
            assert!(has(&emit_in(i, 0, &par).unwrap(), &[0x23, 0]), "{i:#x}");
            let one = emit(i, 0).unwrap();
            assert!(!has(&one, &[0x23, 0]) && one.contains(&op), "{i:#x}");
        }
        // Not for other registers or a shift: eor w2, w0, w1; eor w2, w0, w0, lsl #1.
        assert!(!has(&emit_in(0x4a010002, 0, &par).unwrap(), &[0x23, 0]));
        assert!(!has(&emit_in(0x4a000402, 0, &par).unwrap(), &[0x23, 0]));
    }

    #[test]
    fn simd_fp_loads_and_stores() {
        // ldr q1, [x2]: behind CPACR_EL1.FPEN = 11 at EL0 (896, mask 3 << 20);
        // v128.load from the host address into V1's local, written back to
        // V1 (304 + 16) at the end.
        let b = emit_flushed(0x3dc00041);
        assert!(has(
            &b,
            &[0x20, 0, 0x29, 3, 0x80, 7, 0x42, 0x80, 0x80, 0xc0, 1, 0x83]
        ));
        assert!(has(&b, &[0xfd, 0, 0, 0x80, 0x80, 4, 0x21]));
        assert!(has(&b, &[0xfd, 11, 0, 0xc0, 2]));
        // At EL1 only FPEN bit 20.
        let b = emit_in(0x3dc00041, 0, &Ctx { el1: true, ..FLAT }).unwrap();
        assert!(has(&b, &[0x42, 0x80, 0x80, 0xc0, 0, 0x83]));
        // ldr s1, [x2]: v128.load32_zero; ldr d1: v128.load64_zero (RAM at 0x10000).
        assert!(has(
            &emit(0xbd400041, 0).unwrap(),
            &[0xfd, 92, 0, 0x80, 0x80, 4, 0x21]
        ));
        assert!(has(
            &emit(0xfd400041, 0).unwrap(),
            &[0xfd, 93, 0, 0x80, 0x80, 4, 0x21]
        ));
        // ldr h1, [x2]: i32.load16_u into lane 0 of a zero vector.
        let b = emit(0x7d400041, 0).unwrap();
        assert!(has(&b, &[0x2f, 0, 0x80, 0x80, 4, 0xfd, 0x1c, 0, 0x21]));
        // str d1, [x2]: V1 (into its local, 49) is its low lane, i64.store;
        // str q1: v128 both ways.
        assert!(has(
            &emit(0xfd000041, 0).unwrap(),
            &[
                0xfd, 0, 0, 0xc0, 2, 0x22, 49, 0xfd, 0x1d, 0, 0x37, 0, 0x80, 0x80, 4
            ]
        ));
        assert!(has(
            &emit(0x3d800041, 0).unwrap(),
            &[0xfd, 0, 0, 0xc0, 2, 0x22, 49, 0xfd, 11, 0, 0x80, 0x80, 4]
        ));
        // ldp q1, q2, [x3]: the second 16 bytes on.
        let b = emit_flushed(0xad400861);
        assert!(has(&b, &[0xfd, 0, 0, 0x90, 0x80, 4, 0x21]));
        assert!(has(&b, &[0xfd, 11, 0, 0xd0, 2]));
        // ldr q1 with size 1 and opc<1> (UNDEFINED): the helper.
        assert_eq!(emit(0x7dc00041, 0), None);
    }

    #[test]
    fn advsimd_integer() {
        // add v0.4s, v1.4s, v2.4s: V1, V2 loaded into their locals (49, 50);
        // i32x4.add into V0's (51), written back to V0 at the end.
        let b = emit_flushed(0x4ea28420);
        assert!(has(
            &b,
            &[
                0x20, 0, 0xfd, 0, 0, 0xc0, 2, 0x22, 49, 0x20, 0, 0xfd, 0, 0, 0xd0, 2, 0x22, 50,
                0xfd, 0xae, 1, 0x21, 51
            ]
        ));
        assert!(has(&b, &[0xfd, 11, 0, 0xb0, 2]));
        // The block's FP check comes first: CPACR_EL1 (896).
        assert!(b.starts_with(&[0x20, 0, 0x29, 3, 0x80, 7]));
        // add v0.2s: the top half cleared (i64.const 0; i64x2.replace_lane 1).
        assert!(has(
            &emit(0x0ea28420, 0).unwrap(),
            &[0x42, 0, 0xfd, 0x1e, 1, 0x21]
        ));
        // ushr v0.4s, v1.4s, #32: 0 (the lane width, which wasm would take as 0).
        assert!(has(
            &emit(0x6f200420, 0).unwrap(),
            &[0xfd, 0x0c, 0, 0, 0, 0]
        ));
        // dup v0.16b, w1: i8x16.splat of the 32-bit register.
        assert!(has(&emit(0x4e010c20, 0).unwrap(), &[0xfd, 0x0f]));
        // mul v0.16b (no i8x16.mul): the 16-bit products' even bytes
        // (i16x8.extmul_low_i8x16_u, …, i8x16.shuffle 0, 2, 4 …).
        let b = emit(0x4e229c20, 0).unwrap();
        assert!(has(&b, &[0xfd, 0x9e, 1]));
        assert!(has(&b, &[0xfd, 0x0d, 0, 2, 4, 6]));
        // pmul v0.16b: shifted partial products (i8x16.shl).
        assert!(has(&emit(0x6e229c20, 0).unwrap(), &[0xfd, 0x6b]));
        // ld2 {v0.4s, v1.4s}, [x1]: two v128.loads, then shuffles of lanes 0, 2,
        // 4, 6 (bytes 0–3, 8–11 …) and 1, 3, 5, 7.
        let b = emit_flushed(0x4c408820);
        assert!(has(&b, &[0xfd, 0x0d, 0, 1, 2, 3, 8, 9, 10, 11]));
        assert!(has(&b, &[0xfd, 0x0d, 4, 5, 6, 7, 12, 13, 14, 15]));
        // crc32cb w0, w1, w2: one table lookup, at CRC-32C's table.
        let b = emit(0x1ac25020, 0).unwrap();
        let mut load = vec![0x28, 2];
        crate::jit::wasm::uleb(&mut load, CRC_TABLES[1].as_ptr() as usize as u32 as u64);
        assert!(has(&b, &load));
    }

    #[test]
    fn bf16() {
        // bfdot v0.4s, v1.8h, v2.8h: f32x4.mul of the widened lanes, the masks' i8x16.all_true.
        let b = emit(0x6e42fc20, 0).unwrap();
        assert!(has(&b, &[0xfd, 0xe6, 1]) && has(&b, &[0xfd, 0x63]));
        // bfcvtn: the lanes' high halves packed beside a zero.
        let b = emit(0x0ea16820, 0).unwrap();
        assert!(has(&b, &[0xfd, 0x0d, 2, 3, 6, 7, 10, 11, 14, 15, 16]));
        // Without the feature: the helper (bfcvt, bfcvtn2, bfdot by element, bfmmla, bfmlalb, bfmlalt by element).
        let off = Ctx {
            features: crate::cpu::FEATURES & !crate::cpu::FEATURE_BF16,
            ..FLAT
        };
        for i in [
            0x1e634020, 0x4ea16820, 0x6e42fc20, 0x4f62f020, 0x6e42ec20, 0x2ec2fc20, 0x4ff2f020,
        ] {
            assert!(emit(i, 0).is_some(), "{i:08x}");
            assert_eq!(emit_in(i, 0, &off), None, "{i:08x}");
        }
    }

    #[test]
    fn i8mm() {
        // usdot v0.4s, v1.16b, v2.16b: Vn widened unsigned, Vm signed, i16x8.mul,
        // then SDOT's shuffles and signed extadd_pairwise.
        let b = emit(0x4e829c20, 0).unwrap();
        assert!(has(&b, &[0xfd, 0x89, 1]) && has(&b, &[0xfd, 0x8a, 1]));
        assert!(has(&b, &[0xfd, 0x87, 1]) && has(&b, &[0xfd, 0x88, 1]));
        assert!(has(&b, &[0xfd, 0x95, 1]) && has(&b, &[0xfd, 0x7e]));
        assert!(has(&b, &[0xfd, 0x0d, 0, 1, 2, 3, 8, 9, 10, 11]));
        // sudot by element: Vm's lane splat; the 64-bit form clears the top.
        let b = emit(0x0f02f820, 0).unwrap();
        assert!(has(&b, &[0xfd, 0x0d, 8, 9, 10, 11, 8, 9, 10, 11]));
        assert!(!has(&b, &[0xfd, 0x8a, 1]) && has(&b, &[0x42, 0, 0xfd, 0x1e, 1, 0x21]));
        // smmla: extmuls with Vm and its halves swapped; ummla unsigned ones,
        // summed unsigned; usmmla widens both; all reduce in two ADDP levels.
        let b = emit(0x4e82a420, 0).unwrap();
        assert!(has(&b, &[0xfd, 0x9c, 1]) && has(&b, &[0xfd, 0x9d, 1]));
        assert!(has(
            &b,
            &[0xfd, 0x0d, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3]
        ));
        assert!(has(
            &b,
            &[0xfd, 0x0d, 0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19]
        ));
        assert!(has(
            &b,
            &[0xfd, 0x0d, 0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19]
        ));
        let b = emit(0x6e82a420, 0).unwrap();
        assert!(has(&b, &[0xfd, 0x9e, 1]) && has(&b, &[0xfd, 0x7f]) && !has(&b, &[0xfd, 0x7e]));
        let b = emit(0x4e82ac20, 0).unwrap();
        assert!(
            has(&b, &[0xfd, 0x89, 1]) && has(&b, &[0xfd, 0x88, 1]) && has(&b, &[0xfd, 0x95, 1])
        );
        // Without the feature: the helper.
        let off = Ctx {
            features: crate::cpu::FEATURES & !crate::cpu::FEATURE_I8MM,
            ..FLAT
        };
        for i in [0x4e829c20, 0x0f02f820, 0x4e82a420, 0x6e82a420, 0x4e82ac20] {
            assert_eq!(emit_in(i, 0, &off), None);
        }
    }

    #[test]
    fn rdm() {
        // sqrdmlah v0.8h: q15mulr_sat_s, then add_sat_s and (MIN × MIN's 1) sub_sat_s.
        let b = emit(0x6e428420, 0).unwrap();
        assert!(has(&b, &[0xfd, 0x82, 1]) && has(&b, &[0xfd, 0x8f, 1]));
        assert!(has(&b, &[0xfd, 0x92, 1]) && !has(&b, &[0xfd, 0x95, 1]));
        // sqrdmlsh v0.8h: the products' low halves for the ties.
        assert!(has(&emit(0x6e428c20, 0).unwrap(), &[0xfd, 0x95, 1]));
        // sqrdmlah v0.4s: i64 extmuls of both halves, i64x2.ne; v0.2s the low one.
        let b = emit(0x6e828420, 0).unwrap();
        assert!(has(&b, &[0xfd, 0xdc, 1]) && has(&b, &[0xfd, 0xdd, 1]));
        assert!(has(&b, &[0xfd, 0xd7, 1]));
        assert!(!has(&emit(0x2e828420, 0).unwrap(), &[0xfd, 0xdd, 1]));
        // By element: Vm's lane in every lane.
        let b = emit(0x6f72d820, 0).unwrap();
        assert!(has(&b, &[0xfd, 0x0d, 14, 15, 14, 15, 14, 15]));
        // Scalar, and scalar by element: lane code.
        for i in [0x7e428420, 0x7e828c20, 0x7f52d020] {
            assert!(emit(i, 0).is_some(), "{i:#x}");
        }
        // The reserved sizes, and without the feature: the helper.
        for i in [0x6e028420, 0x6ec28420, 0x7e028420, 0x6f32d820] {
            assert_eq!(emit(i, 0), None, "{i:#x}");
        }
        let off = Ctx {
            features: crate::cpu::FEATURES & !crate::cpu::FEATURE_RDM,
            ..FLAT
        };
        for i in [0x6e428420, 0x6e828c20, 0x7e428420, 0x6f72d820] {
            assert_eq!(emit_in(i, 0, &off), None);
        }
    }

    #[test]
    fn lrcpc2() {
        // ldapursw x1, [x2, #4]: an atomic load, sign-extended; stlurh w1, [x2, #2] an
        // atomic store; ldapursb w1 extended to 32 bits, then masked.
        let b = emit(0x99804041, 0).unwrap();
        assert!(has(&b, &[0xfe, 0x16]) && has(&b, &[0xc4]));
        assert!(has(&emit(0x59002041, 0).unwrap(), &[0xfe, 0x1c]));
        let b = emit(0x19c01041, 0).unwrap();
        assert!(has(&b, &[0xfe, 0x14]) && has(&b, &[0xc2]) && has(&b, &[0x83]));
        // The unallocated sizes, and without the feature (or FEAT_LRCPC): the helper.
        for i in [0xd9800041, 0x99c00041] {
            assert_eq!(emit(i, 0), None, "{i:#x}");
        }
        for f in [crate::cpu::FEATURE_RCPC2, crate::cpu::FEATURE_RCPC] {
            let off = Ctx {
                features: crate::cpu::FEATURES & !f,
                ..FLAT
            };
            assert_eq!(emit_in(0xd95f8041, 0, &off), None);
        }
    }

    #[test]
    fn dotprod() {
        // sdot v0.4s, v1.16b, v2.16b: signed extmuls of both halves, the even
        // and odd 32-bit lanes' shuffles, each extadd_pairwise_i16x8_s, two adds.
        let b = emit(0x4e829420, 0).unwrap();
        assert!(has(&b, &[0xfd, 0x9c, 1]) && has(&b, &[0xfd, 0x9d, 1]));
        assert!(has(&b, &[0xfd, 0x7e]));
        assert!(has(&b, &[0xfd, 0x0d, 0, 1, 2, 3, 8, 9, 10, 11]));
        assert!(has(&b, &[0xfd, 0x0d, 4, 5, 6, 7, 12, 13, 14, 15]));
        // udot: unsigned; a by element form splats Vm's lane first.
        assert!(has(&emit(0x6e829420, 0).unwrap(), &[0xfd, 0x9f, 1]));
        let b = emit(0x4fa2e820, 0).unwrap();
        assert!(has(&b, &[0xfd, 0x0d, 12, 13, 14, 15, 12, 13, 14, 15]));
        // sdot v0.2s: the low half only, the top cleared.
        let b = emit(0x0e829420, 0).unwrap();
        assert!(!has(&b, &[0xfd, 0x9d, 1]));
        assert!(has(&b, &[0x42, 0, 0xfd, 0x1e, 1, 0x21]));
        // Reserved sizes and a vCPU without the feature: the helper.
        assert_eq!(emit(0x4e429420, 0), None);
        assert_eq!(emit(0x4f62e820, 0), None);
        let off = Ctx {
            features: crate::cpu::FEATURES & !crate::cpu::FEATURE_DOTPROD,
            ..FLAT
        };
        assert_eq!(emit_in(0x4e829420, 0, &off), None);
    }

    #[test]
    fn scalar_fp() {
        // fadd s0, s1, s2: the block's guard (FPCR.RMode, FPSR.IXC) into FPOK,
        // f32.add, then FPOK && normal operands && a fast result, or the helper.
        let b = emit(0x1e222820, 0).unwrap();
        assert!(has(&b, &[0x21, FPOK as u8])); // local.set FPOK
        assert!(has(&b, &[0x92])); // f32.add
        assert!(has(&b, &[0x20, FPOK as u8])); // local.get FPOK
        assert!(has(&b, &[0x10, 0])); // the helper, on the other arm
        // fmadd d0: Veltkamp's split (f64.const 2^27 + 1), the round to odd's
        // select; fmadd s0: through f64 (mul, add, demote).
        let b = emit(0x1f420c20, 0).unwrap();
        assert!(has(&b, &[0x44, 0, 0, 0, 2, 0, 0, 0xa0, 0x41]) && has(&b, &[0x1b]));
        let b = emit(0x1f020c20, 0).unwrap();
        assert!(has(&b, &[0xa2]) && has(&b, &[0xa0]) && has(&b, &[0xb6]));
        // On a fused host: relaxed `madd` (0x105 single, 0x107 double) on lane 0,
        // no split, no sum through f64; FNMADD's `nmadd` over a negated addend.
        let fused = |w| emit_in(w, 0, &Ctx { fma: true, ..FLAT }).unwrap();
        let b = fused(0x1f420c20);
        assert!(has(&b, &[0xfd, 0x87, 2]) && !has(&b, &[0x44, 0, 0, 0, 2, 0, 0, 0xa0, 0x41]));
        let b = fused(0x1f020c20);
        assert!(has(&b, &[0xfd, 0x85, 2]) && !has(&b, &[0xb6]));
        let b = fused(0x1f620c20);
        assert!(has(&b, &[0xfd, 0x88, 2]) && has(&b, &[0xfd, 0xed, 1]));
        // fneg d0, d1: a bit flip, no guard.
        let b = emit(0x1e614020, 0).unwrap();
        assert!(!has(&b, &[0x21, FPOK as u8]));
        assert!(has(
            &b,
            &[
                0x42, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x7f, 0x85
            ]
        ));
    }

    #[test]
    fn vector_fp() {
        // fmla v0.4s, v1.4s, v2.4s: f64x2.promote_low_f32x4 (0x5f), f64x2 mul
        // (0xf2) and add (0xf0), demote (0x5e), lanes checked (i32x4.all_true, 0xa3).
        let b = emit(0x4e22cc20, 0).unwrap();
        for op in [[0xfd, 0x5f], [0xfd, 0xf2], [0xfd, 0xf0], [0xfd, 0x5e]] {
            assert!(has(&b, &op));
        }
        assert!(has(&b, &[0xfd, 0xa3, 1]));
        // fmla v0.2d: the scalar double FMA's algorithm on f64x2: the round to
        // odd's i64x2.shr_s (0xcc), f64x2.abs (0xec) and f64x2.gt (0x4a),
        // i64x2.all_true.
        let b = emit(0x4e62cc20, 0).unwrap();
        assert!(has(&b, &[0xfd, 0xcc, 1]) && has(&b, &[0xfd, 0xec, 1]) && has(&b, &[0xfd, 0x4a]));
        assert!(has(&b, &[0xfd, 0xc3, 1]));
        // On a fused host: `madd`, FMLS's `nmadd`, nothing through f64x2.
        let fused = |w| emit_in(w, 0, &Ctx { fma: true, ..FLAT }).unwrap();
        let b = fused(0x4e22cc20);
        assert!(has(&b, &[0xfd, 0x85, 2]) && !has(&b, &[0xfd, 0x5f]));
        assert!(has(&fused(0x4ea2cc20), &[0xfd, 0x86, 2]));
        assert!(has(&fused(0x4e62cc20), &[0xfd, 0x87, 2]));
        assert!(has(&fused(0x4ee2cc20), &[0xfd, 0x88, 2]));
        // fadd v0.2d: f64x2.add, i64x2.all_true (0xc3).
        let b = emit(0x4e62d420, 0).unwrap();
        assert!(has(&b, &[0xfd, 0xf0, 1]) && has(&b, &[0xfd, 0xc3, 1]));
        // scvtf v0.4s, v1.4s: f32x4.convert_i32x4_s (0xfa); scvtf s0, s1 and
        // ucvtf d0, d1 (the integer in Vn): f32.convert_i32_s, f64.convert_i64_u.
        assert!(has(&emit(0x4e21d820, 0).unwrap(), &[0xfd, 0xfa, 1]));
        assert!(has(&emit(0x5e21d820, 0).unwrap(), &[0xb2]));
        assert!(has(&emit(0x7e61d820, 0).unwrap(), &[0xba]));
    }

    #[test]
    fn fcma() {
        let fused = |w| emit_in(w, 0, &Ctx { fma: true, ..FLAT });
        // fcmla v0.4s, v1.4s, v2.4s, #0: Vn's real parts twice (a shuffle), `madd`.
        let b = fused(0x6e82c420).unwrap();
        let re = [
            0xfd, 0x0d, 0, 1, 2, 3, 0, 1, 2, 3, 8, 9, 10, 11, 8, 9, 10, 11,
        ];
        assert!(has(&b, &re) && has(&b, &[0xfd, 0x85, 2]) && !has(&b, &[0xfd, 0x51]));
        // #90: the imaginary parts, Vm's pairs swapped, their first lanes negated (v128.xor).
        let b = fused(0x6e82cc20).unwrap();
        let im = [
            0xfd, 0x0d, 4, 5, 6, 7, 4, 5, 6, 7, 12, 13, 14, 15, 12, 13, 14, 15,
        ];
        let swap = [
            0xfd, 0x0d, 4, 5, 6, 7, 0, 1, 2, 3, 12, 13, 14, 15, 8, 9, 10, 11,
        ];
        assert!(has(&b, &im) && has(&b, &swap) && has(&b, &[0xfd, 0x51]));
        // #180: `nmadd`, no sign flip.
        let b = fused(0x6e82d420).unwrap();
        assert!(has(&b, &[0xfd, 0x86, 2]) && !has(&b, &[0xfd, 0x51]));
        // Doubles fused (0x107); emulated: the double FMA's algorithm, and the single's through f64x2.
        assert!(has(&fused(0x6ec2dc20).unwrap(), &[0xfd, 0x87, 2]));
        assert!(has(&emit(0x6ec2dc20, 0).unwrap(), &[0xfd, 0xcc, 1]));
        assert!(has(&emit(0x6e82cc20, 0).unwrap(), &[0xfd, 0x5f]));
        // By element (pair 1, #0): Vm's lanes 2 and 3 in every pair.
        let b = fused(0x6f821820).unwrap();
        assert!(has(
            &b,
            &[
                0xfd, 0x0d, 8, 9, 10, 11, 12, 13, 14, 15, 8, 9, 10, 11, 12, 13, 14, 15
            ]
        ));
        // fcadd v0.4s, #90: f32x4.add of Vn and Vm swapped, negated.
        let b = emit(0x6e82e420, 0).unwrap();
        assert!(has(&b, &swap) && has(&b, &[0xfd, 0x51]) && has(&b, &[0xfd, 0xe4, 1]));
        assert!(has(&emit(0x6ec2f420, 0).unwrap(), &[0xfd, 0xf0, 1]));
        // The half forms (FEAT_FP16), reserved sizes, doubles without Q, by element
        // L = 1 or Q = 0, and without the feature: the helper.
        for i in [
            0x6e42c420, 0x6e02c420, 0x2ec2c420, 0x6e42e420, 0x6fa21020, 0x2f821020, 0x6fc21020,
        ] {
            assert_eq!(fused(i), None, "{i:#x}");
        }
        let off = Ctx {
            features: crate::cpu::FEATURES & !crate::cpu::FEATURE_FCMA,
            fma: true,
            ..FLAT
        };
        for i in [0x6e82c420, 0x6ec2c420, 0x6e82e420, 0x6f821020] {
            assert_eq!(emit_in(i, 0, &off), None, "{i:#x}");
        }
    }

    #[test]
    fn acquire_release_and_dc_zva() {
        // ldar x0, [x1]: an aligned atomic load (0xfe 0x11, alignment 3) behind
        // the address's alignment check (& 7 == 0).
        let b = emit(0xc8dffc20, 0).unwrap();
        assert!(has(&b, &[0xfe, 0x11, 3]));
        assert!(has(&b, &[0x42, 7, 0x83, 0x50]));
        // stlrb w0, [x1]: an 8-bit atomic store.
        assert!(has(&emit(0x089ffc20, 0).unwrap(), &[0xfe, 0x1b, 0]));
        // dc zva, x1: & !63, eight i64 stores of 0; at EL0 behind SCTLR_EL1.DZE (888).
        let b = emit(0xd50b7421, 0).unwrap();
        assert!(has(&b, &[0x42, 0x40, 0x83]));
        assert_eq!(b.windows(3).filter(|w| *w == [0x42, 0, 0x37]).count(), 8);
        assert!(has(&b, &[0x20, 0, 0x29, 3, 0xf8, 6]));
        let el1 = emit_in(0xd50b7421, 0, &Ctx { el1: true, ..FLAT }).unwrap();
        assert!(!has(&el1, &[0x20, 0, 0x29, 3, 0xf8, 6]));
    }

    #[test]
    fn moves() {
        // movz x1, #5, lsl #16: i64.const 0x50000; local.set x1 (the first register local, 17)
        assert_eq!(
            emit(0xd2a000a1, 0).unwrap(),
            [0x42, 0x80, 0x80, 0x14, 0x21, 17]
        );
        // movk w2, #1: x2 loaded into its local (vcpu; i64.load 16; local.tee), wrapped;
        // i32.const !0xffff; and; i32.const 1; or; i64.extend_i32_u; local.set
        #[rustfmt::skip]
        let want = [
            0x20, 0, 0x29, 3, 16, 0x22, 17, 0xa7, 0x41, 0x80, 0x80, 0x7c, 0x71, 0x41, 1, 0x72,
            0xad, 0x21, 17,
        ];
        assert_eq!(emit(0x72800022, 0).unwrap(), want);
        assert_eq!(emit(0xd280001f, 0).unwrap(), []); // movz xzr: nothing to do
        assert_eq!(emit(0x52c00000, 0), None); // movz w0, #0, lsl #32: UNDEFINED, a helper
        // mov x3, x4 (orr x3, xzr, x4): x4 loaded (local 17), set into x3 (local 18)
        assert_eq!(
            emit(0xaa0403e3, 0).unwrap(),
            [0x20, 0, 0x29, 3, 32, 0x22, 17, 0x21, 18]
        );
        // orr x3, xzr, x4, lsl #4: the shift, no or
        assert_eq!(
            emit(0xaa0413e3, 0).unwrap(),
            [0x20, 0, 0x29, 3, 32, 0x22, 17, 0x42, 4, 0x86, 0x21, 18]
        );
    }

    #[test]
    fn pc_relative() {
        // adr x0, .+8 as instruction 2: entry; i64.const 16; add; local.set x0
        assert_eq!(
            emit(0x10000040, 2).unwrap(),
            [0x20, 1, 0x42, 16, 0x7c, 0x21, 17]
        );
        // adrp x1, .+0x1000 as instruction 0 at a page's start: entry + 0x1000
        let want = [0x20, 1, 0x42, 0x80, 0x20, 0x7c, 0x21, 17];
        assert_eq!(emit(0xb0000001, 0).unwrap(), want);
        // The same as instruction 1 of a region member 0x10 past an entry at
        // 0x7f8 in its page (the instruction at 0x80c): its page is entry - 0x7f8,
        // so entry + 0x808 (i64.const 0x808)
        let mut c = Func {
            page: 0x7f8,
            base: 0x10,
            ..Func::default()
        };
        assert!(inline(&mut c, 0xb0000001, decode(0xb0000001), 1, &FLAT));
        assert_eq!(c.c.b, [0x20, 1, 0x42, 0x88, 0x10, 0x7c, 0x21, 17]);
    }

    #[test]
    fn add_sub() {
        // add x0, sp, #16: SP loaded (i64.load 248) into local 10; add; local.set x0
        assert_eq!(
            emit(0x910043e0, 0).unwrap(),
            [
                0x20, 0, 0x29, 3, 0xf8, 1, 0x22, 17, 0x42, 16, 0x7c, 0x21, 18
            ]
        );
        // sub w0, w1, w2, uxtb #2: w1 - ((w2 & 0xff) << 2), zero-extended
        #[rustfmt::skip]
        let want = [
            0x20, 0, 0x29, 3, 8, 0x22, 17, 0xa7, 0x20, 0, 0x29, 3, 16, 0x22, 18, 0xa7,
            0x41, 0xff, 1, 0x71, 0x41, 2, 0x74, 0x6b, 0xad, 0x21, 19,
        ];
        assert_eq!(emit(0x4b220820, 0).unwrap(), want);
        // cmp x1, x2 (subs xzr, x1, x2): the operands into the i64 flag locals
        // (10, 11), nothing stored: the flags are lazy.
        #[rustfmt::skip]
        let want = [
            0x20, 0, 0x29, 3, 8, 0x22, 17, 0x21, 10, 0x20, 0, 0x29, 3, 16, 0x22, 18, 0x21, 11,
        ];
        assert_eq!(emit(0xeb02003f, 0).unwrap(), want);
        assert_eq!(emit(0x91c00000, 0), None); // add x0, x0, #0, lsl #24: reserved shift
        assert_eq!(emit(0x8b221400, 0), None); // add x0, x0, w2, uxtb #5: reserved amount
    }

    #[test]
    fn logical_bitfield_shifts() {
        // lsr x0, x1, #4 (ubfm x0, x1, #4, #63): shr_u 4
        let want = [0x20, 0, 0x29, 3, 8, 0x22, 17, 0x42, 4, 0x88, 0x21, 18];
        assert_eq!(emit(0xd344fc20, 0).unwrap(), want);
        // lsl x0, x1, #4 (ubfm x0, x1, #60, #59): shl 4
        let want = [0x20, 0, 0x29, 3, 8, 0x22, 17, 0x42, 4, 0x86, 0x21, 18];
        assert_eq!(emit(0xd37cec20, 0).unwrap(), want);
        // ubfx x0, x1, #4, #8 (ubfm x0, x1, #4, #11): rotr 4, then the masks
        let want = [
            0x20, 0, 0x29, 3, 8, 0x22, 17, 0x42, 4, 0x8a, 0x42, 0xff, 0x01, 0x83, 0x21, 18,
        ];
        assert_eq!(emit(0xd3442c20, 0).unwrap(), want);
        // sxtw x0, w1 (sbfm x0, x1, #0, #31): i64.extend32_s
        let want = [0x20, 0, 0x29, 3, 8, 0x22, 17, 0xc4, 0x21, 18];
        assert_eq!(emit(0x93407c20, 0).unwrap(), want);
        // sxtb w0, w1 (sbfm w0, w1, #0, #7): i32.extend8_s, zero-extended
        let want = [0x20, 0, 0x29, 3, 8, 0x22, 17, 0xa7, 0xc0, 0xad, 0x21, 18];
        assert_eq!(emit(0x13001c20, 0).unwrap(), want);
        // sbfx x0, x1, #4, #8 (sbfm x0, x1, #4, #11): shl 52, shr_s 56
        let want = [
            0x20, 0, 0x29, 3, 8, 0x22, 17, 0x42, 52, 0x86, 0x42, 56, 0x87, 0x21, 18,
        ];
        assert_eq!(emit(0x93442c20, 0).unwrap(), want);
        // lslv w0, w1, w2: i32.shl takes the amount modulo 32
        #[rustfmt::skip]
        let want = [
            0x20, 0, 0x29, 3, 8, 0x22, 17, 0xa7, 0x20, 0, 0x29, 3, 16, 0x22, 18, 0xa7, 0x74, 0xad,
            0x21, 19,
        ];
        assert_eq!(emit(0x1ac22020, 0).unwrap(), want);
        // tst w1, #1 (ands wzr, w1, #1): the result into the i32 flag local 15
        let want = [0x20, 0, 0x29, 3, 8, 0x22, 17, 0xa7, 0x41, 1, 0x71, 0x21, 15];
        assert_eq!(emit(0x7200003f, 0).unwrap(), want);
        assert_eq!(emit(0x92400000 | 0x3f << 10, 0), None); // and x0, x0, #<all ones>: reserved
        assert_eq!(emit(0x13400000, 0), None); // sbfm w0, w0, #0, #0 with N = 1: UNDEFINED
    }

    #[test]
    fn conditional() {
        // csel x0, x1, x2, eq: x1, x2, NZCV & Z, select
        #[rustfmt::skip]
        let want = [
            0x20, 0, 0x29, 3, 8, 0x22, 17, 0x20, 0, 0x29, 3, 16, 0x22, 18,
            0x20, 0, 0x28, 2, 0x88, 2, 0x41, 0x80, 0x80, 0x80, 0x80, 0x04, 0x71, 0x1b, 0x21, 19,
        ];
        assert_eq!(emit(0x9a820020, 0).unwrap(), want);
        // ccmp x1, #3, #4, ne: the flags or #4 << 28, selected, stored to NZCV
        let b = emit(0xfa431824, 0).unwrap();
        assert!(b.ends_with(&[0x45, 0x1b, 0xad, 0x37, 3, 0x88, 2]));
    }

    #[test]
    fn branches() {
        // b .+8 as instruction 1: pc = entry + 12
        assert_eq!(
            emit(0x14000002, 1).unwrap(),
            [0x20, 0, 0x20, 1, 0x42, 12, 0x7c, 0x37, 3, 0x80, 2]
        );
        // bl .-4 as instruction 0: x30 = entry + 4, pc = entry - 4
        #[rustfmt::skip]
        let want = [
            0x20, 1, 0x42, 4, 0x7c, 0x21, 17,
            0x20, 0, 0x20, 1, 0x42, 0x7c, 0x7c, 0x37, 3, 0x80, 2,
        ];
        assert_eq!(emit(0x97ffffff, 0).unwrap(), want);
        // cbnz w3, .+16: the target, the next PC, w3 != 0, select
        #[rustfmt::skip]
        let want = [
            0x20, 0, 0x20, 1, 0x42, 16, 0x7c, 0x20, 1, 0x42, 4, 0x7c,
            0x20, 0, 0x29, 3, 24, 0x22, 17, 0xa7, 0x45, 0x45,
            0x22, TAKEN as u8, 0x1b, 0x37, 3, 0x80, 2, // the outcome kept for chaining
        ];
        assert_eq!(emit(0x35000083, 0).unwrap(), want);
        // blr x30: the PC from x30 before x30 is written, kept in ADDR (2)
        #[rustfmt::skip]
        let want = [
            0x20, 0, 0x20, 0, 0x29, 3, 0xf0, 1, 0x22, 17, 0x22, 2, 0x37, 3, 0x80, 2,
            0x20, 1, 0x42, 4, 0x7c, 0x21, 17,
        ];
        assert_eq!(emit(0xd63f03c0, 0).unwrap(), want);
    }

    #[test]
    fn multiply_divide_bits() {
        // mul x0, x1, x2 (madd x0, x1, x2, xzr)
        #[rustfmt::skip]
        let want = [
            0x42, 0, 0x20, 0, 0x29, 3, 8, 0x22, 17, 0x20, 0, 0x29, 3, 16, 0x22, 18, 0x7e, 0x7c,
            0x21, 19,
        ];
        assert_eq!(emit(0x9b027c20, 0).unwrap(), want);
        // udiv w0, w1, w2: w2 == 0 ? 0 : w1 / w2
        #[rustfmt::skip]
        let want = [
            0x20, 0, 0x29, 3, 8, 0x22, 17, 0xa7, 0x21, 6, 0x20, 0, 0x29, 3, 16, 0x22, 18, 0xa7,
            0x22, 7, 0x45, 0x04, I32, 0x41, 0, 0x05, 0x20, 6, 0x20, 7, 0x6e, 0x0b, 0xad, 0x21, 19,
        ];
        assert_eq!(emit(0x1ac20820, 0).unwrap(), want);
        // clz x0, x1
        assert_eq!(
            emit(0xdac01020, 0).unwrap(),
            [0x20, 0, 0x29, 3, 8, 0x22, 17, 0x79, 0x21, 18]
        );
        assert_eq!(emit(0x5ac00c20, 0), None); // rev w0 with opc 11: UNDEFINED
        assert_eq!(emit(0xd503201f, 0).unwrap(), []); // nop
    }

    #[test]
    fn loads_and_stores() {
        use crate::jit::wasm::{sleb, uleb};
        // ldr x0, [x1, #8], flat: base, address, bounds check, load or helper.
        let insn = 0xf9400420u32;
        #[rustfmt::skip]
        let mut want = vec![
            0x20, 0, 0x29, 3, 8, 0x22, 17, 0x22, 3, // BASE = x1 (loaded into local 17), teed
            0x42, 8, 0x7c, 0x21, 2,                 // ADDR = BASE + 8
            0x02, 0x40, 0x02, I32,                  // the failure chain's block and this site's segment
            0x20, 2, 0x22, 4, 0x42, 0xf8, 0x1f, 0x58, // OFF = ADDR; OFF <= 0x1000 - 8
            0x04, 0x40, 0x20, 4, 0xa7, 0x22, 6,     // if: HOST = OFF, teed
            0x29, 0, 0x80, 0x80, 4, 0x21, 18,       // x0 (local 18) = [HOST + base]
            0x05, 0x20, 0, 0x41,                    // else: helper(vcpu, insn, pc)
        ];
        sleb(&mut want, insn as i32 as i64);
        // if it didn't retire: to the segment with 0 retired
        want.extend([0x20, 1, 0x10, 0, 0x04, 0x40, 0x41, 0, 0x0c, 2, 0x0b]);
        // After the helper, x0 (written) is reloaded; x1 (only read) stays in its local.
        want.extend([0x20, 0, 0x29, 3, 0, 0x21, 18, 0x0b]);
        // The chain's close: past the segment, which stores nothing; the return of acc + the count.
        want.extend([0x0c, 1, 0x0b, 0x20, ACC as u8, 0x6a, 0x0f, 0x0b]);
        assert_eq!(emit(insn, 0).unwrap(), want);
        // Through the TLB at EL1: the tag at the entry, then the addend at + 8.
        let read = tlb_array(1, 0);
        let tlb = Ctx {
            helper: 0,
            bus: Bus::Tlb { read },
            el1: true,
            crypto: true,
            sha3: true,
            jscvt: true,
            features: crate::cpu::FEATURES,
            fma: false,
            parallel: false,
            pair_locks: 0x100,
            clock: None,
            spill: 0,
            groups: true,
            span: 0,
        };
        let b = emit_in(insn, 0, &tlb).unwrap();
        for off in [read, read + 8] {
            let mut load = vec![0x29, 3];
            uleb(&mut load, off as u64);
            assert!(b.windows(load.len()).any(|w| w == load), "{off:#x}");
        }
        // A store uses the write array; an SP base checks SP's alignment first.
        let mut load = vec![0x29, 3];
        uleb(&mut load, tlb_array(1, 1) as u64);
        let b = emit_in(0xf90007e0, 0, &tlb).unwrap(); // str x0, [sp, #8]
        assert!(b.windows(load.len()).any(|w| w == load));
        assert!(
            b.windows(7)
                .any(|w| w == [0x20, 3, 0x42, 15, 0x83, 0x50, 0x71])
        );
        // PRFM: nothing, SP base included (no SP alignment check); with a
        // reserved option, a helper.
        assert_eq!(emit(0xf9800020, 0).unwrap(), []); // prfm pldl1keep, [x1]
        assert_eq!(emit(0xf98003e0, 0).unwrap(), []); // prfm pldl1keep, [sp]
        assert_eq!(emit(0xf8a16be0, 0).unwrap(), []); // prfm pldl1keep, [sp, x1]
        assert_eq!(emit(0xf8a10820, 0), None); // prfm pldl1keep, [x1, w1, uxtb]: UNDEFINED
        // LDTR and STTR at EL1 go through EL0's arrays (loads: read; stores: write).
        for (insn, arr) in [(0xf8408820, tlb_array(0, 0)), (0xf8008840, tlb_array(0, 1))] {
            let b = emit_in(insn, 0, &tlb).unwrap(); // ldtr x0, [x1, #8]; sttr x0, [x2, #8]
            let mut load = vec![0x29, 3];
            uleb(&mut load, arr as u64);
            assert!(b.windows(load.len()).any(|w| w == load), "{insn:#x}");
        }
        assert!(emit(0xc85f7c20, 0).is_some()); // ldxr x0, [x1] (M6 loop 7)
        assert!(emit(0xf8200020, 0).is_some()); // ldadd x0, x0, [x1]
        assert_eq!(emit(0xf8204020, 0), None); // ldsmax x0, x0, [x1]: a helper
        // With spill memory 1 inline, a second arm: the tag differing in the
        // memory bits alone (i64.const 8, i64.eq), then the body again, its
        // load naming memory 1 (align with bit 6, memory 1, offset 0: HOST has
        // the whole address). The
        // fast path is as without it.
        let spill = Ctx { spill: 1, ..tlb };
        let ldr = 0xf9400420; // ldr x0, [x1, #8]
        let (b0, b1) = (
            emit_in(ldr, 0, &tlb).unwrap(),
            emit_in(ldr, 0, &spill).unwrap(),
        );
        let mem1 = [LOAD_U[3], 0x40, 1, 0];
        assert!(!b0.windows(4).any(|w| w == mem1));
        assert_eq!(b1.windows(4).filter(|w| *w == mem1).count(), 1);
        assert!(b1.windows(3).any(|w| w == [0x42, 8, 0x51]));
        let fast = b0.windows(2).position(|w| w == [0x05, 0x20]).unwrap(); // the fast arm, up to its `else`
        assert_eq!(b0[..fast], b1[..fast]);
        assert!(emit(0xc87f0020, 0).is_some()); // ldxp x0, x0, [x1] (M8)
    }
}
