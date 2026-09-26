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
//! NZCV (264) is lazy: a flag-setting instruction keeps its operands (or its
//! result) in the flag locals and records how its flags would be computed
//! ([`Flags`]); conditions are computed from those directly where the kind
//! allows (`cmp x, y; b.lt` is `i64.lt_s`), and NZCV is stored only before a
//! helper call, on a load/store's failure return and at the block's end. A
//! setter whose flags the next setter replaces first emits no flag code.

use core::ops::{Deref, DerefMut};

use super::wasm::{Code, I32, I64};
use crate::decode::Op;
use crate::interp::{adr_imm, bit, bit_masks, bits, sext, trunc};
use crate::mmu::{TLB_ENTRIES, Vcpu};

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

/// Offsets in the `Cpu`.
pub const PC: u32 = 256;
const NZCV: u32 = 264;

/// Which register locals hold the register's value (`valid`), and which of
/// those are newer than the `Cpu` (`dirty`); bit 31 is SP.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Regs {
    valid: u32,
    dirty: u32,
}

impl Regs {
    /// The state a region block entered from both `self` and `o` starts in
    /// (step 8): every register valid on either side, dirty if dirty on
    /// either; each edge conforms to it ([`Func::conform`]). Registers in
    /// `plain` never have a local.
    pub fn merge(self, o: Regs, plain: u32) -> Regs {
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
    /// Each register's local (0: none yet).
    local: [u32; 32],
    nregs: u32,
    pub regs: Regs,
    pub flags: Flags,
    pub counts: Counts,
    /// Registers read at least once, and read more than once or written; and
    /// the registers to read straight from the `Cpu` without a local: a first
    /// emission of the block finds them, and registers read once and never
    /// written are `plain` in the second (a local costs Liftoff more than it
    /// saves them). Bit masks, not counts: rustc nightly-2026-09-24 with
    /// simd128 miscompiles a `[u8; 32]` compared into a u32 mask (PLAN.md M9).
    pub read: u32,
    pub reused: u32,
    pub plain: u32,
    /// The block's offset from the function's entry PC (local 1): a region's
    /// blocks (step 8) share the head's.
    pub base: i64,
    /// Whether NZCV was live at the block's entry, once known (step 8.4):
    /// false if a setter came first, true if a condition, a helper, a
    /// possible exit (a load/store's failure path, the block's end) or a
    /// commit did. A region member that sets flags before anything else
    /// needs none from its edges.
    pub touched: Option<bool>,
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
            if (6..=9).contains(&i) || (13..=16).contains(&i) || i == TAKEN {
                I32
            } else {
                I64
            }
        })
    }

    /// Register `n`'s local (31 is SP).
    fn local(&mut self, n: u32) -> u32 {
        let l = &mut self.local[n as usize];
        if *l == 0 {
            *l = FIRST_REG + self.nregs;
            self.nregs += 1;
        }
        *l
    }

    /// Loads register `n` from the `Cpu` into its local.
    fn load(&mut self, n: u32) -> u32 {
        let l = self.local(n);
        self.c.local_get(VCPU).i64_load(8 * n).local_set(l);
        self.regs.valid |= 1 << n;
        l
    }

    /// Pushes register `n` (31 is SP) as an i64.
    fn reg(&mut self, n: u32) {
        self.reused |= self.read & 1 << n;
        self.read |= 1 << n;
        if self.plain & 1 << n != 0 {
            self.c.local_get(VCPU).i64_load(8 * n);
        } else if self.regs.valid & 1 << n != 0 {
            let l = self.local[n as usize];
            self.c.local_get(l);
        } else {
            let l = self.local(n);
            self.c.local_get(VCPU).i64_load(8 * n).local_tee(l);
            self.regs.valid |= 1 << n;
        }
    }

    /// Pops an i64 into register `n` (31 is SP).
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
            let l = self.local[n as usize];
            self.c.local_get(VCPU).local_get(l).i64_store(8 * n);
        }
        self.regs.dirty = 0;
    }

    /// Drops the locals of the registers in `mask` (clean: flushed first),
    /// which something else may have written in the `Cpu`.
    pub fn forget(&mut self, mask: u32) {
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
            let l = self.local[n as usize];
            self.c.local_get(VCPU).local_get(l).i64_store(8 * n);
        }
        self.regs.dirty &= to.dirty;
        self.reload(to.valid);
    }

    /// Loads the registers in `mask` whose locals aren't valid.
    fn reload(&mut self, mask: u32) {
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
            set_pc(c, here + sext((bits(i, 25, 0) << 2) as u64, 28) as i64);
        }
        B_cond | CBZ | CBNZ | TBZ | TBNZ => {
            let off = match op {
                TBZ | TBNZ => sext((bits(i, 18, 5) << 2) as u64, 16),
                _ => sext((bits(i, 23, 5) << 2) as u64, 21),
            };
            c.local_get(VCPU);
            pc_plus(c, here + off as i64);
            pc_plus(c, here + 4);
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
            c.local_tee(TAKEN).select().i64_store(PC);
        }
        BR | BLR | RET => {
            c.local_get(VCPU);
            get(c, true, rn);
            c.i64_store(PC);
            if op == BLR {
                set(c, true, 30, |c| pc_plus(c, here + 4));
            }
        }
        // Hints that are NOPs here (PLAN.md §1) and don't end a block.
        NOP | HINT | XPAC_2 | PACIA_2 | PACIB_2 | AUTIA_2 | AUTIB_2 | BTI | ESB | PSB | TSB
        | CSDB | DGH => {}
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
            c.if_t(ty);
            konst(c, sf, 0);
            c.else_();
            if op == SDIV {
                c.local_get(y);
                konst(c, sf, u64::MAX);
                cmp(c, sf, EQ);
                c.if_t(ty);
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
        | STURx_LDURx | STRx_reg | LDRx_reg | STRx_LDRx_imm_1 | STP_LDP_gen | STNP_LDNP_gen => {
            return ldst(c, cx, i, op, k);
        }
        // The shift amount is Rm modulo the width, as wasm shifts take it.
        LSLV | LSRV | ASRV | RORV => set(c, sf, rd, |c| {
            get(c, sf, rn);
            get(c, sf, rm);
            arith(c, sf, [SHL, SHR_U, SHR_S, ROTR][bits(i, 11, 10) as usize]);
        }),
        _ => return false,
    }
    true
}

/// How a block's inline loads and stores reach guest RAM, and the helper that
/// re-executes an instruction whose fast path doesn't apply.
#[derive(Clone, Copy, Debug)]
pub struct Ctx {
    pub helper: u32,
    pub bus: Bus,
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

/// The end of a block that branched to a register (BR, BLR, RET; step 7):
/// its target's block key, from the PC through the instruction TLB of the
/// block's EL (`tlb`: its array, and RAM's host base and guest PA) or with
/// the MMU off (`regime`: the key's low bits), looked up in the jump cache at
/// `jc`. If it's there and `left` covers this block's `len` and its length,
/// tail-calls it through the table (type `ty`), after `check` (the stale-code
/// checker) if given. Otherwise falls through (to the block's return).
pub fn indirect(
    c: &mut Func,
    regime: u64,
    tlb: Option<(u32, u64, u64)>,
    jc: u32,
    len: u32,
    ty: u32,
    check: Option<u32>,
) {
    const KEY: u32 = BASE; // i64 scratch
    c.local_get(VCPU).i64_load(PC).local_tee(ADDR);
    c.i64_const(3).op(AND + W).op(EQZ + WC); // aligned
    match tlb {
        Some((arr, base, phys)) => {
            c.local_get(ADDR).i64_const(8).op(SHR_U + W).i32_wrap_i64();
            c.i32_const((TLB_ENTRIES as i32 - 1) << 4).op(AND);
            c.local_get(VCPU).op(ADD).local_tee(TLBE).i64_load(arr);
            c.local_get(ADDR)
                .i64_const(0xfff)
                .op(OR + W)
                .op(EQ + WC)
                .op(AND);
            // PA = host - base + phys, host = addend + VA
            c.local_get(TLBE)
                .i64_load(arr + 8)
                .local_get(ADDR)
                .i64_add();
            c.i64_const(phys.wrapping_sub(base) as i64).i64_add();
        }
        None => drop(c.local_get(ADDR)),
    }
    if regime != 0 {
        c.i64_const(regime as i64).op(OR + W);
    }
    c.local_set(KEY);
    via_jc(c, None, jc, len, ty, check);
}

/// The jump-cache tail of [`indirect`], also for a static successor that
/// wasn't compiled when this block was (`key`: its key; else the key is in
/// the i64 scratch local). With an i32 condition on the stack, tail-calls the
/// block the entry holds if the condition holds, its key matches and `left`
/// covers both blocks; otherwise falls through.
pub fn via_jc(c: &mut Func, key: Option<u64>, jc: u32, len: u32, ty: u32, check: Option<u32>) {
    const KEY: u32 = BASE; // i64 scratch
    const JCE: u32 = HOST; // i32 scratch
    match key {
        // The entry's offset, `((key >> 2) & (JC - 1)) * 16`, in one shift and mask.
        None => {
            c.local_get(KEY).i32_wrap_i64().i32_const(2).op(SHL);
            c.i32_const((super::JC as i32 - 1) << 4).op(AND);
            c.i32_const(jc as i32)
                .op(ADD)
                .local_tee(JCE)
                .i64_load(0)
                .local_get(KEY);
        }
        Some(k) => {
            let e = jc + (((k >> 2) as u32) & (super::JC as u32 - 1)) * 16;
            c.i32_const(e as i32)
                .local_tee(JCE)
                .i64_load(0)
                .i64_const(k as i64);
        }
    }
    c.op(EQ + WC).op(AND);
    // left >= len + its length
    c.local_get(LEFT)
        .local_get(JCE)
        .i32_load(12)
        .i32_const(len as i32)
        .op(ADD);
    c.op(GE_U).op(AND).if_();
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

/// The tier-up prologue of a loop head compiled alone (step 8.3): the hot
/// word at `word` counts its entries down; the entry that takes it from 1 to
/// 0 calls `hot(vcpu, key, pc)`, which compiles the head's loop region and
/// then stores `REDIRECT | its table index` in the word; from then on every
/// entry tail-calls the region (entries through links compiled before it).
/// 0 stays 0: the region wasn't compiled.
pub fn tier_up(c: &mut Func, word: u32, key: u64, ty: u32, hot: u32) {
    const V: u32 = 6; // i32 scratch
    c.i32_const(word as i32).i32_load(0).local_tee(V);
    c.i32_const(0).op(LT_S).if_();
    c.local_get(VCPU).local_get(ACC).local_get(LEFT);
    c.local_get(V).i32_const(!REDIRECT as i32).op(AND);
    c.return_call_indirect(ty).end();
    c.local_get(V).if_();
    c.i32_const(word as i32).local_get(V).i32_const(1).op(SUB);
    c.memarg(0x36, 2, 0); // i32.store
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

/// Loads, stores and pairs whose handlers can't fail for other reasons than
/// the access itself. Exclusives, atomics, unprivileged and FP accesses stay
/// helper calls.
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
            access(c, cx, i, here, len, false, false, xmask(rt), |c, off| {
                load_reg(c, rt, off, len, sign, false)
            });
        }
        PRFM_lit => {}
        PRFM_imm | PRFM_unscaled_imm => {
            if rn == 31 {
                return false; // SP's alignment check
            }
        }
        STRx_LDRx_imm_2 | STURx_LDURx | STRx_reg | LDRx_reg | STRx_LDRx_imm_1 => {
            if matches!(op, STRx_reg | LDRx_reg) && bits(i, 15, 13) & 2 == 0 {
                return false; // UNDEFINED, PRFM included
            }
            let len = 1 << size;
            let prfm = op != STRx_LDRx_imm_1;
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
                STURx_LDURx => {
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
            access(c, cx, i, here, len, store, rn == 31, written, |c, off| {
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
            });
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
            access(c, cx, i, here, 2 * len, !load, rn == 31, written, |c, o| {
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
            });
        }
        _ => return false,
    }
    true
}

// i64 loads by log2 size, zero- and sign-extending, and i64 stores.
const LOAD_U: [u8; 4] = [0x31, 0x33, 0x35, 0x29];
const LOAD_S: [u8; 4] = [0x30, 0x32, 0x34, 0x29];
const STORE: [u8; 4] = [0x3c, 0x3d, 0x3e, 0x37];

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
fn xmask(rt: u32) -> u32 {
    if rt == 31 { 0 } else { 1 << rt }
}

/// The fast path of an access of `len` bytes at the address in `ADDR`: if it
/// is RAM (flat: in bounds; MMU: a TLB hit for the page, which the access
/// doesn't leave) and, for an SP base (`sp`), SP is 16-byte aligned, `body`
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
    sp: bool,
    written: u32,
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
    if sp {
        c.local_get(BASE)
            .i64_const(15)
            .i64_and()
            .op(EQZ + WC)
            .op(AND);
    }
    c.if_();
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
    let fast = c.regs;
    c.else_();
    c.regs = before;
    c.flush();
    c.local_get(VCPU).i32_const(i as i32);
    pc_plus(c, here);
    c.call(cx.helper).if_();
    c.store_flags();
    c.ret((here / 4) as u32);
    c.end();
    c.forget(written);
    c.reload(fast.valid);
    // Clean here, maybe dirty there: the merge is dirty (a clean write-back is harmless).
    c.regs = fast;
    c.end();
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
    };

    fn emit(i: u32, k: usize) -> Option<Vec<u8>> {
        emit_in(i, k, &FLAT)
    }

    fn emit_in(i: u32, k: usize, cx: &Ctx) -> Option<Vec<u8>> {
        let mut c = Func::default();
        inline(&mut c, i, decode(i), k, cx).then_some(c.c.b)
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
        assert_eq!(emit(0xc85f7c20, 0), None); // ldxr x0, [x1]: a helper
    }
}
