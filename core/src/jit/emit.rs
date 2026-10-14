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

mod crypto;
mod float;

pub use crypto::{CONSTS, Consts};
mod simd;

use core::mem::offset_of;
use core::ops::{Deref, DerefMut};

use super::wasm::{Code, F64, I32, I64, V128};
use crate::cpu::Cpu;
use crate::decode::Op;
use crate::interp::sys::DCZID_BS;
use crate::interp::{adr_imm, bit, bit_masks, bits, sext, trunc};
use crate::mmu::{TLB_ENTRIES, Tlb, Vcpu, XC_ENTRIES};

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
/// A v128 scratch local (AdvSIMD reductions, M6 loop 4).
pub const VTMP: u32 = 124;
/// More v128 scratch locals (vector FP, M6 loop 6).
pub const VT: [u32; 4] = [119, 120, 121, 122];
/// The block's FP guard (i32; `float::fpa_guard`, M6 loop 5).
pub const FPOK: u32 = 123;
/// f64 scratch locals (the double FMA's exact product and sums).
pub const FT: [u32; 8] = [97, 98, 99, 113, 114, 115, 116, 117];
/// The V registers' v128 locals, in order of first use: 49..=79, then 96
/// (between the register locals and SHA's, and after SHA's).
const VREGS: core::ops::RangeInclusive<u32> = 49..=79;
const VREG_LAST: u32 = 96;

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
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Regs {
    valid: u64,
    dirty: u64,
}

impl Regs {
    /// The state a region block entered from both `self` and `o` starts in
    /// (step 8): every register valid on either side, dirty if dirty on
    /// either; each edge conforms to it ([`Func::conform`]). Registers in
    /// `plain` never have a local.
    pub fn merge(self, o: Regs, plain: u64) -> Regs {
        Regs {
            valid: (self.valid | o.valid) & !plain,
            dirty: (self.dirty | o.dirty) & !plain,
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
    /// The block's previous and next words (0 past its ends), and whether the
    /// instruction just emitted consumed the next one too: a fused AES round
    /// and mix, or SHA256H and SHA256H2 (M6.5, `crypto`).
    pub prev: u32,
    pub next: u32,
    pub fused: bool,
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
        self.c.compact_locals(&[VCPU, ACC, LEFT], |i| {
            if (6..=9).contains(&i)
                || (13..=16).contains(&i)
                || i == TAKEN
                || i == FPOK
                || crypto::I32_LOCALS.contains(&i)
            {
                I32
            } else if FT.contains(&i) {
                F64
            } else if i == VTMP || VT.contains(&i) || VREGS.contains(&i) || i == VREG_LAST {
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

    /// Pushes register `n` (31 is SP) as an i64; from 32, V register n − 32
    /// as a v128.
    fn reg(&mut self, n: u32) {
        self.reused |= self.read & 1 << n;
        self.read |= 1 << n;
        if self.plain & 1 << n != 0 {
            self.load_cpu(n);
        } else if self.regs.valid & 1 << n != 0 {
            let l = self.local[n as usize / 32][n as usize % 32];
            self.c.local_get(l);
        } else {
            let l = self.local(n);
            self.load_cpu(n);
            self.c.local_tee(l);
            self.regs.valid |= 1 << n;
        }
    }

    /// Pushes Vn.
    pub fn vget(&mut self, n: u32) {
        self.reg(32 + n);
    }

    /// Pushes lane `lane` of Vn's `esize`-bit lanes (32 or 64) as an i32 or
    /// i64: from its local, or with a scalar load if Vn has none (`plain`).
    pub fn vlane(&mut self, n: u32, esize: u32, lane: u32) {
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
        let l = self.local(n);
        self.c.local_set(l);
        self.regs.valid |= 1 << n;
        self.regs.dirty |= 1 << n;
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
        self.touched.get_or_insert(true);
        if let Flags::Lazy { kind, sf, .. } = self.flags {
            self.c.local_get(VCPU);
            nzcv_of(self, kind, sf);
            self.c.i64_extend_i32_u().i64_store(NZCV);
            if let Flags::Lazy { stored, .. } = &mut self.flags {
                *stored = true;
            }
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
    pub fn ret(&mut self, k: u32) {
        self.c.local_get(ACC);
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
    /// what is valid there but not here.
    pub fn conform(&mut self, to: Regs) {
        let mut d = self.regs.dirty & !to.dirty;
        while d != 0 {
            let n = d.trailing_zeros();
            d &= d - 1;
            self.store_cpu(n);
        }
        self.regs.dirty &= to.dirty;
        self.reload(to.valid);
    }

    /// Loads the registers in `mask` whose locals aren't valid.
    fn reload(&mut self, mask: u64) {
        let mut m = mask & !self.regs.valid;
        while m != 0 {
            let n = m.trailing_zeros();
            m &= m - 1;
            self.load(n);
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
    let sf = bit(i, 31);
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let here = 4 * k as i64;
    match op {
        ADR => set(c, true, rd, |c| pc_plus(c, here + adr_imm(i) as i64)),
        ADRP => set(c, true, rd, |c| {
            pc_plus(c, here);
            c.i64_const(!0xfff).i64_and();
            c.i64_const((adr_imm(i) << 12) as i64).i64_add();
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
            let (tx, ty, tr) = add_with_carry(c, sf, |c| get(c, sf, rn), y, sub);
            let carry = if sub { Carry::One } else { Carry::Zero };
            add_nzcv(c, sf, tx, ty, tr, carry);
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
        BR | BLR | RET => {
            c.local_get(VCPU);
            get(c, true, rn);
            c.i64_store(PC);
            if op == BLR {
                set(c, true, 30, |c| pc_plus(c, here + 4));
            }
        }
        // Hints that are NOPs here (docs/cpu.md) and don't end a block.
        NOP | HINT | XPAC_2 | PACIA_2 | PACIB_2 | AUTIA_2 | AUTIB_2 | BTI | ESB | PSB | TSB
        | CSDB | DGH => {}
        // Barriers order nothing for vCPUs sharing a thread (one vCPU or
        // round-robin), and don't end a block. In parallel SMP every flavor is
        // a full fence (`dmb ish` on arm64; stronger than DMB LD/ST need), and
        // DSB is the helper's (it ends the chunk).
        DSB if cx.parallel => return false,
        DMB | SSBB | PSSBB if cx.parallel => {
            c.atomic_fence();
        }
        DMB | DSB | SSBB | PSSBB => {}
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
        | LDTRSW | LDXR | LDAXR | STXR | STLXR | CAS | CASB | CASH | LDADDB | LDCLRB | LDEORB
        | LDSETB | SWPB | LDADDH | LDCLRH | LDEORH | LDSETH | SWPH | LDADD | LDCLR | LDEOR
        | LDSET | SWP => {
            return ldst(c, cx, i, op, k);
        }
        LDR_lit_fpsimd | STP_LDP_fpsimd | STNP_LDNP_fpsimd | STR_imm_fpsimd_2
        | LDR_imm_fpsimd_2 | STUR_fpsimd | LDUR_fpsimd | STR_imm_fpsimd_1 | LDR_imm_fpsimd_1
        | STR_reg_fpsimd | LDR_reg_fpsimd => return ldst_fp(c, cx, i, op, k),
        LDx_mult_1 | LDx_mult_2 | STx_mult_1 | STx_mult_2 => return ld1_st1(c, cx, i, k),
        LD1_sngl_1 | LD1_sngl_2 | ST1_sngl_1 | ST1_sngl_2 => return ld1_st1_lane(c, cx, i, k),
        // The shift amount is Rm modulo the width, as wasm shifts take it.
        LSLV | LSRV | ASRV | RORV => set(c, sf, rd, |c| {
            get(c, sf, rn);
            get(c, sf, rm);
            arith(c, sf, [SHL, SHR_U, SHR_S, ROTR][bits(i, 11, 10) as usize]);
        }),
        // AdvSIMD and SIMD&FP moves (M6 loop 4), after the block's FP check;
        // nothing emitted for the rest.
        _ => {
            let snap = (c.c.mark(), c.flags, c.touched, c.fp_ok, c.fpa_ok, c.regs);
            fp_guard(c, cx, i, k);
            if !(cx.crypto && crypto::inline(c, i, op))
                && !simd::inline(c, i, op)
                && !float::inline(c, cx, i, op, k)
                && !float::vector(c, cx, i, op, k)
            {
                let (mark, flags, touched, fp_ok, fpa_ok, regs) = snap;
                c.c.rewind(mark);
                (c.flags, c.touched, c.fp_ok, c.fpa_ok, c.regs) =
                    (flags, touched, fp_ok, fpa_ok, regs);
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
    /// Parallel SMP (`cpu::FEATURE_PARALLEL`): DSB is the helper's, which
    /// ends the chunk there.
    pub parallel: bool,
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
/// return).
pub fn indirect(
    c: &mut Func,
    regime: u64,
    miss: Option<u32>,
    len: u32,
    ty: u32,
    check: Option<u32>,
) {
    const KEY: u32 = BASE; // i64 scratch
    c.local_get(VCPU).i64_load(PC).local_tee(ADDR);
    c.i64_const(3).op(AND + W).op(EQZ + WC); // aligned
    if let Some(miss) = miss {
        via_xc(c, regime, len, ty, check);
        c.local_get(VCPU);
        c.local_get(ACC).i32_const(len as i32).op(ADD);
        c.local_get(LEFT).i32_const(len as i32).op(SUB);
        c.return_call(miss);
        return;
    }
    c.local_get(ADDR);
    if regime != 0 {
        c.i64_const(regime as i64).op(OR + W);
    }
    c.local_set(KEY);
    via_jc(c, None, len, ty, check);
}

/// The transfer cache probe of [`indirect`], for the VA in `ADDR` and an i32
/// condition on the stack: the entry's tag, its generation and its length.
fn via_xc(c: &mut Func, regime: u64, len: u32, ty: u32, check: Option<u32>) {
    const TO: u32 = BASE; // i64 scratch
    // The entry, `vcpu + ((va >> 2) & (XC - 1)) * 16`, in one shift and mask.
    xc_entry(c);
    c.i64_load(XC);
    c.local_get(ADDR);
    if regime != 0 {
        c.i64_const(regime as i64).op(OR + W);
    }
    c.op(EQ + WC).op(AND);
    c.local_get(TLBE).i64_load(XC + 8).local_tee(TO);
    c.i64_const(48).op(SHR_U + W);
    c.local_get(VCPU).i64_load(xgen(regime)).op(EQ + WC).op(AND);
    // left >= len + its length
    c.local_get(LEFT);
    c.local_get(TO).i64_const(32).op(SHR_U + W).i32_wrap_i64();
    c.i32_const(0xffff).op(AND).i32_const(len as i32).op(ADD);
    c.op(GE_U).op(AND).hint(true).if_();
    if let Some(chk) = check {
        c.local_get(VCPU).i64_const(-1).call(chk);
    }
    c.local_get(VCPU);
    c.local_get(ACC).i32_const(len as i32).op(ADD);
    c.local_get(LEFT).i32_const(len as i32).op(SUB);
    c.local_get(TO)
        .i32_wrap_i64()
        .return_call_indirect(ty)
        .end();
}

/// The `Vcpu` offsets of the pointers to its table's jump cache and hot words
/// (`jit::State`): a module reads them there, so its bytes are the same for
/// every table it's installed in (docs/jit.md "Sharing").
pub const JC_PTR: u32 = (offset_of!(Vcpu, jit) + offset_of!(super::State, jc)) as u32;
pub const HOT_PTR: u32 = (offset_of!(Vcpu, jit) + offset_of!(super::State, hot)) as u32;

/// The transfer cache's offset in the `Vcpu`.
const XC: u32 = (offset_of!(Vcpu, tlb) + offset_of!(Tlb, xc)) as u32;

/// The `Vcpu` offset of the transfer cache generation of `regime`'s EL.
fn xgen(regime: u64) -> u32 {
    (offset_of!(Vcpu, tlb) + offset_of!(Tlb, xgen)) as u32 + 8 * (regime as u32 & 1)
}

/// Pushes the `Vcpu`-relative address of the VA in `ADDR`'s transfer cache
/// entry (its offset in the `Vcpu` to add), keeping it in `TLBE`.
fn xc_entry(c: &mut Func) {
    c.local_get(ADDR).i32_wrap_i64().i32_const(2).op(SHL);
    c.i32_const((XC_ENTRIES as i32 - 1) << 4).op(AND);
    c.local_get(VCPU).op(ADD).local_tee(TLBE);
}

/// A transfer cache miss in `regime` (MMU on), a function of a block's type
/// that a JIT cache has one of per regime (`block::miss_module`; [`indirect`]
/// tail-calls it, with the block retired): finds the PC's
/// block as the dispatcher would, through the instruction TLB of the
/// regime's EL (`tlb`: its array, and RAM's host base and guest PA) and the
/// jump cache ([`JC_PTR`]), and if it's there and `left` covers it, fills the
/// entry and tail-calls the block (after `check`). Otherwise returns `acc`.
pub fn xmiss(regime: u64, tlb: (u32, u64, u64), ty: u32, check: Option<u32>) -> Func {
    const KEY: u32 = BASE; // i64 scratch
    const JCE: u32 = HOST; // i32 scratch
    let mut c = Func::default();
    let (arr, base, phys) = tlb;
    c.local_get(VCPU).i64_load(PC).local_tee(ADDR);
    c.i64_const(3).op(AND + W).op(EQZ + WC); // aligned
    c.local_get(ADDR).i64_const(8).op(SHR_U + W).i32_wrap_i64();
    c.i32_const((TLB_ENTRIES as i32 - 1) << 4).op(AND);
    c.local_get(VCPU).op(ADD).local_tee(TLBE).i64_load(arr);
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
    c.local_get(LEFT)
        .local_get(JCE)
        .i32_load(12)
        .op(GE_U)
        .op(AND);
    c.hint(true).if_();
    // The entry: tag, then idx | len << 32 | gen << 48.
    xc_entry(&mut c);
    c.local_get(ADDR)
        .i64_const(regime as i64)
        .op(OR + W)
        .i64_store(XC);
    c.local_get(TLBE);
    c.local_get(JCE).i64_load(8); // idx, len
    c.local_get(VCPU)
        .i64_load(xgen(regime))
        .i64_const(48)
        .op(SHL + W)
        .op(OR + W);
    c.i64_store(XC + 8);
    if let Some(chk) = check {
        c.local_get(VCPU).local_get(KEY).call(chk);
    }
    c.local_get(VCPU).local_get(ACC).local_get(LEFT);
    c.local_get(JCE).i32_load(8).return_call_indirect(ty).end();
    c.local_get(ACC).end();
    c
}

/// The jump-cache tail of [`indirect`], also for a static successor that
/// wasn't compiled when this block was (`key`: its key; else the key is in
/// the i64 scratch local). With an i32 condition on the stack, tail-calls the
/// block the entry holds if the condition holds, its key matches and `left`
/// covers both blocks; otherwise falls through.
pub fn via_jc(c: &mut Func, key: Option<u64>, len: u32, ty: u32, check: Option<u32>) {
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
    // left >= len + its length
    c.local_get(LEFT)
        .local_get(JCE)
        .i32_load(12)
        .i32_const(len as i32)
        .op(ADD);
    c.op(GE_U).op(AND).hint(true).if_();
    if let Some(chk) = check {
        c.local_get(VCPU);
        match key {
            Some(k) => c.i64_const(k as i64),
            None => c.local_get(KEY),
        };
        c.call(chk);
    }
    c.local_get(VCPU);
    c.local_get(ACC).i32_const(len as i32).op(ADD);
    c.local_get(LEFT).i32_const(len as i32).op(SUB);
    c.local_get(JCE).i32_load(8).return_call_indirect(ty).end();
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
    c.local_get(VCPU).local_get(ACC).local_get(LEFT);
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
    c.local_tee(ADDR).i64_const(8).op(SHR_U + W).i32_wrap_i64();
    c.i32_const((TLB_ENTRIES as i32 - 1) << 4).op(AND);
    c.local_get(VCPU).op(ADD).local_tee(TLBE).i64_load(arr);
    c.local_get(ADDR).i64_const(0xfff).op(OR + W).op(EQ + WC);
    c.local_get(TLBE)
        .i64_load(arr + 8)
        .local_get(ADDR)
        .i64_add();
    c.i64_const(host as i64).op(EQ + WC).op(AND);
}

/// The `Vcpu` offset of TLB array `3 * el + u` (read 0, write 1).
pub fn tlb_array(el: u64, u: u64) -> u32 {
    (core::mem::offset_of!(Vcpu, tlb) + (3 * el + u) as usize * TLB_ENTRIES * 16) as u32
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

/// Loads, stores and pairs, acquire/release, exclusives of one register and
/// LSE atomics, whose handlers can't fail for other reasons than the access
/// itself. Exclusive pairs, CASP, LSE min/max, unprivileged and FP accesses
/// stay helper calls (FP ones: [`ldst_fp`]).
fn ldst(c: &mut Func, cx: &Ctx, i: u32, op: Op, k: usize) -> bool {
    use Op::*;
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
        PRFM_lit => {}
        PRFM_imm | PRFM_unscaled_imm => {
            if rn == 31 {
                return false; // SP's alignment check
            }
        }
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
                    return rn != 31; // PRFM: nothing but SP's alignment check
                }
                _ if size == 3 || (size == 2 && opc == 3) => return false, // UNDEFINED
                _ => (false, true, opc == 3),
            };
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
                        c.memarg(STORE[size as usize], 0, off);
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
            base(c);
            c.local_get(BASE);
            if mode != 1 {
                c.i64_const(off).i64_add();
            }
            c.local_set(ADDR);
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
                            c.memarg(STORE[len.trailing_zeros() as usize], 0, o);
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
                    c.atomic(ATOMIC_STORE[size as usize], size, off);
                } else {
                    set(c, true, rt, |c| {
                        c.local_get(HOST)
                            .atomic(ATOMIC_LOAD[size as usize], size, off);
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
                const MON: u32 = offset_of!(Cpu, monitor) as u32;
                const VAL: u32 = offset_of!(Cpu, monitor.val) as u32;
                const MON_SIZE: u32 = offset_of!(Cpu, monitor.size) as u32;
                if load {
                    c.local_get(HOST)
                        .atomic(ATOMIC_LOAD[size as usize], size, off)
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
                    c.local_get(VCPU).i64_load(MON).local_get(ADDR).op(EQ + WC);
                    c.local_get(VCPU).i64_load(MON_SIZE).i64_const(len as i64);
                    c.op(EQ + WC).op(AND).if_t(I64);
                    c.local_get(HOST)
                        .local_get(VCPU)
                        .i64_load(VAL)
                        .local_get(VALUE);
                    c.atomic(RMW_CMPXCHG + RMW_SIZE[size as usize], size, off);
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
        // unsigned min/max have no wasm op and stay helper calls, as CASP does.
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
                        c.atomic(rmw, size, off);
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
            access(c, cx, i, here, 64, true, &[guard], 0, |c, off| {
                for k in 0..8 {
                    c.local_get(HOST)
                        .i64_const(0)
                        .memarg(STORE[3], 0, off + 8 * k);
                }
            });
        }
        _ => return false,
    }
    true
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
    c.store_flags();
    // acc + k, plus one if the helper retired it after all.
    c.local_get(VCPU).i32_const(i as i32);
    pc_plus(c, 4 * k as i64);
    c.call(cx.helper).op(EQZ).local_get(ACC).op(ADD);
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
            get_sp(c, true, rn);
            c.local_tee(BASE);
            if mode != 1 {
                c.i64_const(off).i64_add();
            }
            c.local_set(ADDR);
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

/// Vt = the `len` bytes at the host address (+ `off`), zero-extended to 128 bits.
fn vload(c: &mut Func, t: u32, off: u32, len: u32) {
    match len {
        16 | 8 | 4 => {
            let op =
                [V128_LOAD32_ZERO, V128_LOAD64_ZERO, V128_LOAD][len.trailing_zeros() as usize - 2];
            c.local_get(HOST).simd_mem(op, 0, off);
            c.vset(t);
        }
        _ => c.vset_scalar(t, 32, |c| {
            c.local_get(HOST)
                .memarg(LOAD32_U[len.trailing_zeros() as usize], 0, off);
        }),
    }
}

/// LD1/ST1 (multiple structures) of one to four registers (M6 loop 7): one
/// contiguous access of 8 or 16 bytes per register (the element size doesn't
/// matter, little-endian), through the fast path of [`access`], after the
/// block's [`fp_guard`]. LD2–LD4 and ST2–ST4 interleave and stay helper calls.
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

/// LD1/ST1 (single structure): one lane of Vt, the other lanes kept
/// (`interp::ldst_fp::single_structure`).
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
    if bit(i, 21) || bit(i, 13) {
        return false; // LD2/LD4, LD3 and the replicating forms
    }
    let (rt, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let wb = bit(i, 23);
    let lg = len.trailing_zeros() as usize;
    let index = index as u8;
    fp_guard(c, cx, i, k);
    get_sp(c, true, rn);
    c.local_tee(BASE).local_set(ADDR);
    let written = if wb { 1 << rn } else { 0 } | if load { vbit(rt) } else { 0 };
    access(
        c,
        cx,
        i,
        4 * k as i64,
        len,
        !load,
        &[Guard::sp(rn)],
        written,
        |c, off| {
            // Lane ops by log2 size: i8x16.replace_lane … i64x2.replace_lane,
            // the extract_lane_u forms.
            const REPLACE: [u32; 4] = [0x17, 0x1a, 0x1c, 0x1e];
            const EXTRACT: [u32; 4] = [0x16, 0x19, 0x1b, 0x1d];
            if load {
                c.vget(rt);
                c.local_get(HOST);
                if lg == 3 {
                    c.i64_load(off);
                } else {
                    c.memarg(LOAD32_U[lg], 0, off);
                }
                c.simd_lane(REPLACE[lg], index);
                c.vset(rt);
            } else {
                c.local_get(HOST);
                c.vget(rt);
                c.simd_lane(EXTRACT[lg], index);
                c.memarg(if lg == 3 { STORE[3] } else { STORE32[lg] }, 0, off);
            }
            if wb && rm == 31 {
                writeback(c, rn, len as i64);
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
            c.simd_mem(V128_STORE, 0, off);
        }
        8 => {
            c.vlane(t, 64, 0);
            c.memarg(STORE[3], 0, off);
        }
        _ => {
            c.vlane(t, 32, 0);
            c.memarg(STORE32[len.trailing_zeros() as usize], 0, off);
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
            c.memarg([0x2c, 0x2e][lg], 0, off).i64_extend_i32_u();
        } else {
            c.memarg(if sign { LOAD_S[lg] } else { LOAD_U[lg] }, 0, off);
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
    body: impl FnOnce(&mut Func, u32),
) {
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
            let arr = read + if write { (TLB_ENTRIES * 16) as u32 } else { 0 };
            // The entry's offset, index × 16, in one shift and mask.
            c.local_get(ADDR).i64_const(8).op(SHR_U + W).i32_wrap_i64();
            c.i32_const((TLB_ENTRIES as i32 - 1) << 4).op(AND);
            c.local_get(VCPU).op(ADD).local_tee(TLBE).i64_load(arr);
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
            let arr = read + if write { (TLB_ENTRIES * 16) as u32 } else { 0 };
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
    fallback(c, cx, i, here, before, written);
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
    let fast = c.regs;
    c.else_();
    c.regs = before;
    c.flush();
    c.local_get(VCPU).i32_const(i as i32);
    pc_plus(c, here);
    c.call(cx.helper).hint(false).if_();
    c.store_flags();
    c.ret((here / 4) as u32);
    c.end();
    c.forget(written);
    c.reload(fast.valid);
    // Clean here, maybe dirty there: the merge is dirty (a clean write-back is harmless).
    c.regs = fast;
    c.end();
}

/// MRS of a register [`sys::plain`] reads inline at the block's EL (M6 loop
/// 1); false for the rest (timers, `ISR_EL1`, traps: helper calls).
fn mrs(c: &mut Func, cx: &Ctx, i: u32, k: usize) -> bool {
    use crate::interp::sys::{Plain, plain};
    let (rt, key) = (bits(i, 4, 0), bits(i, 20, 5));
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

/// MSR of a register [`sys::plain_write`] names, and DAIFSet, inline at the
/// block's EL (M6 loop 7); false for the rest (helper calls, which end the
/// block unless [`sys::msr_continues`]).
///
/// [`sys::plain_write`]: crate::interp::sys::plain_write
/// [`sys::msr_continues`]: crate::interp::sys::msr_continues
fn msr(c: &mut Func, cx: &Ctx, i: u32, k: usize) -> bool {
    use crate::cpu::{DAIF, PSTATE_I};
    use crate::interp::sys::{PlainWrite, plain_write};
    const P: u32 = PSTATE as u32;
    let rt = bits(i, 4, 0);
    if bits(i, 20, 19) == 0 {
        // MSR (immediate): DAIFSet at EL1 only masks (EL0 may trap).
        if !cx.el1 || (bits(i, 18, 16), bits(i, 7, 5)) != (3, 6) {
            return false;
        }
        c.local_get(VCPU).local_get(VCPU).i64_load(P);
        c.i64_const((bits(i, 11, 8) as i64) << 6)
            .op(OR + W)
            .i64_store(P);
        return true;
    }
    let Some(p) = plain_write(bits(i, 20, 5), cx.el1) else {
        return false;
    };
    let here = 4 * k as i64;
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
            // VALUE = the new PSTATE; stored unless it unmasks IRQs (the
            // helper's `Exit::Resync` then lets the run loop take one).
            c.local_get(VCPU)
                .i64_load(P)
                .i64_const(!DAIF as i64)
                .i64_and();
            get(c, true, rt);
            c.i64_const(DAIF as i64)
                .i64_and()
                .op(OR + W)
                .local_set(VALUE);
            c.local_get(VCPU).i64_load(P).local_get(VALUE);
            c.i64_const(-1).op(XOR + W).i64_and();
            c.i64_const(PSTATE_I as i64)
                .i64_and()
                .op(EQZ + WC)
                .hint(true)
                .if_();
            let before = c.regs;
            c.local_get(VCPU).local_get(VALUE).i64_store(P);
            fallback(c, cx, i, here, before, 0);
        }
    }
    true
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

/// A binary or unary arithmetic op at the operation size.
fn arith(c: &mut Func, sf: bool, op32: u8) {
    c.op(if sf { op32 + W } else { op32 });
}

/// A comparison at the operation size (an i32 result either way).
fn cmp(c: &mut Func, sf: bool, op32: u8) {
    c.op(if sf { op32 + WC } else { op32 });
}

/// The carry into an addition: none, one (a subtraction), or `NZCV.C` in an i32 local.
#[derive(Clone, Copy)]
enum Carry {
    Zero,
    One,
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

/// AddWithCarry(x, sub ? !y : y, sub) into scratch locals (x, y, result).
fn add_with_carry(
    c: &mut Func,
    sf: bool,
    x: impl FnOnce(&mut Func),
    y: impl FnOnce(&mut Func),
    sub: bool,
) -> (u32, u32, u32) {
    let (tx, ty, tr) = (tmp(sf, 0), tmp(sf, 1), tmp(sf, 2));
    x(c);
    c.local_set(tx);
    y(c);
    if sub {
        konst(c, sf, u64::MAX);
        arith(c, sf, XOR);
    }
    c.local_set(ty);
    c.local_get(tx).local_get(ty);
    arith(c, sf, ADD);
    if sub {
        konst(c, sf, 1);
        arith(c, sf, ADD);
    }
    c.local_set(tr);
    (tx, ty, tr)
}

/// Pushes AddWithCarry's NZCV as an i32 for `r` = `x` + `y` + carry (locals
/// of the operation size): C is `r < x` unsigned, or `r <= x` with a carry
/// in; V is the sign of `(x ^ r) & (y ^ r)`.
fn add_nzcv(c: &mut Func, sf: bool, x: u32, y: u32, r: u32, carry: Carry) {
    nz(c, sf, r);
    c.local_get(r).local_get(x);
    match carry {
        Carry::Zero => cmp(c, sf, LT_U),
        Carry::One => cmp(c, sf, LE_U),
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

/// Pushes the NZCV of a lazy setter as an i32 (scratch: `tmp(sf, 1..=2)`).
fn nzcv_of(c: &mut Func, kind: Kind, sf: bool) {
    let (x, y, r) = flag_locals(sf);
    let (ty, tr) = (tmp(sf, 1), tmp(sf, 2));
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
            // x + !y + 1
            c.local_get(y);
            konst(c, sf, u64::MAX);
            arith(c, sf, XOR);
            c.local_tee(ty).local_get(x);
            arith(c, sf, ADD);
            konst(c, sf, 1);
            arith(c, sf, ADD);
            c.local_set(tr);
            add_nzcv(c, sf, x, ty, tr, Carry::One);
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
        parallel: false,
    };

    fn emit(i: u32, k: usize) -> Option<Vec<u8>> {
        emit_in(i, k, &FLAT)
    }

    fn emit_in(i: u32, k: usize, cx: &Ctx) -> Option<Vec<u8>> {
        let mut c = Func::default();
        inline(&mut c, i, decode(i), k, cx).then_some(c.c.b)
    }

    /// As [`emit`], the registers written back after (as at a block's end).
    fn emit_flushed(i: u32) -> Vec<u8> {
        let mut c = Func::default();
        assert!(inline(&mut c, i, decode(i), 0, &FLAT));
        c.flush();
        c.c.b
    }

    /// `needle` occurs in `hay`.
    fn has(hay: &[u8], needle: &[u8]) -> bool {
        hay.windows(needle.len()).any(|w| w == needle)
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
        // mrs x1, currentel: a constant; mrs x1, cntvct_el0: the platform.
        assert_eq!(emit_in(0xd5384241, 0, &EL1).unwrap(), [0x42, 4, 0x21, 17]);
        assert_eq!(emit_in(0xd53be041, 0, &EL1), None);
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
        // mul v0.16b (no i8x16.mul) and pmul: helper calls, nothing emitted.
        assert_eq!(emit(0x4e229c20, 0), None);
        assert_eq!(emit(0x6e229c20, 0), None);
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
        // odd's i64x2.shr_s (0xcc) and f64x2.ne (0x48), i64x2.all_true.
        let b = emit(0x4e62cc20, 0).unwrap();
        assert!(has(&b, &[0xfd, 0xcc, 1]) && has(&b, &[0xfd, 0x48]) && has(&b, &[0xfd, 0xc3, 1]));
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
        // adrp x1, .+0x1000 as instruction 0: (entry & !0xfff) + 0x1000
        #[rustfmt::skip]
        let want = [
            0x20, 1, 0x42, 0x80, 0x60, 0x83, 0x42, 0x80, 0x20, 0x7c, 0x21, 17,
        ];
        assert_eq!(emit(0xb0000001, 0).unwrap(), want);
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
        // lsr x0, x1, #4 (ubfm x0, x1, #4, #63): rotr 4, then the masks
        let mut want = vec![0x20, 0, 0x29, 3, 8, 0x22, 17, 0x42, 4, 0x8a, 0x42];
        crate::jit::wasm::sleb(&mut want, 0x0fff_ffff_ffff_ffff);
        want.extend([0x83, 0x21, 18]);
        assert_eq!(emit(0xd344fc20, 0).unwrap(), want);
        // sxtw x0, w1 (sbfm x0, x1, #0, #31): shl 32, shr_s 32
        #[rustfmt::skip]
        let want = [0x20, 0, 0x29, 3, 8, 0x22, 17, 0x42, 32, 0x86, 0x42, 32, 0x87, 0x21, 18];
        assert_eq!(emit(0x93407c20, 0).unwrap(), want);
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
        // blr x30: the PC from x30 before x30 is written
        #[rustfmt::skip]
        let want = [
            0x20, 0, 0x20, 0, 0x29, 3, 0xf0, 1, 0x22, 17, 0x37, 3, 0x80, 2,
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
            0x20, 0, 0x29, 3, 8, 0x22, 17, 0x21, 3, // BASE = x1 (loaded into local 17)
            0x20, 3, 0x42, 8, 0x7c, 0x21, 2,        // ADDR = BASE + 8
            0x20, 2, 0x22, 4, 0x42, 0xf8, 0x1f, 0x58, // OFF = ADDR; OFF <= 0x1000 - 8
            0x04, 0x40, 0x20, 4, 0xa7, 0x21, 6,     // if: HOST = OFF
            0x20, 6, 0x29, 0, 0x80, 0x80, 4, 0x21, 18, // x0 (local 18) = [HOST + base]
            0x05, 0x20, 0, 0x41,                    // else: helper(vcpu, insn, pc)
        ];
        sleb(&mut want, insn as i32 as i64);
        // if it didn't retire: return acc + 0
        want.extend([0x20, 1, 0x10, 0, 0x04, 0x40, 0x20, ACC as u8, 0x0f, 0x0b]);
        // After the helper, x0 (written) is reloaded; x1 (only read) stays in its local.
        want.extend([0x20, 0, 0x29, 3, 0, 0x21, 18, 0x0b]);
        assert_eq!(emit(insn, 0).unwrap(), want);
        // Through the TLB at EL1: the tag at the entry, then the addend at + 8.
        let read = tlb_array(1, 0);
        let tlb = Ctx {
            helper: 0,
            bus: Bus::Tlb { read },
            el1: true,
            crypto: true,
            parallel: false,
        };
        let b = emit_in(insn, 0, &tlb).unwrap();
        for off in [read, read + 8] {
            let mut load = vec![0x29, 3];
            uleb(&mut load, off as u64);
            assert!(b.windows(load.len()).any(|w| w == load), "{off:#x}");
        }
        // A store uses the write array; an SP base checks SP's alignment first.
        let mut load = vec![0x29, 3];
        uleb(&mut load, (read + 0x10000) as u64);
        let b = emit_in(0xf90007e0, 0, &tlb).unwrap(); // str x0, [sp, #8]
        assert!(b.windows(load.len()).any(|w| w == load));
        assert!(
            b.windows(7)
                .any(|w| w == [0x20, 3, 0x42, 15, 0x83, 0x50, 0x71])
        );
        // PRFM: nothing, unless its base is SP; with a reserved option, a helper.
        assert_eq!(emit(0xf9800020, 0).unwrap(), []); // prfm pldl1keep, [x1]
        assert_eq!(emit(0xf98003e0, 0), None); // prfm pldl1keep, [sp]
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
        assert_eq!(emit(0xc87f0020, 0), None); // ldxp x0, x0, [x1]: likewise
    }
}
