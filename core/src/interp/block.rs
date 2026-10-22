//! The block interpreter: the interpreter's second form, for code the JIT
//! hasn't compiled (docs/cpu.md "Interpreter").
//!
//! A block (the JIT's: `jit::block::form`, the same key) is decoded once into
//! micro-ops with their operand fields pulled out, and kept: running it again
//! costs no fetch, no decode and no field extraction. The common integer,
//! branch and load/store forms have their own handlers; every other
//! instruction is a generic micro-op that runs the interpreter's own handler
//! ([`super::exec_at_op`]) with the decoded [`Op`]. A micro-op retires one
//! instruction, so the step accounting and the exits are the interpreter's:
//! [`run`] returns what `interp::steps` would for the same instructions.
//!
//! The blocks follow the JIT's rules for code that changes: they are the
//! words seen when the block was decoded, and `IC IVAU`/`IC IALLU` drop them
//! (`jit::Table::sync`). A block lies within one page and ends after every
//! branch and every system instruction that can change the regime or the
//! translation, so its instructions need one instruction-TLB lookup, the
//! dispatcher's.

use super::{
    Exit, R, add_with_carry, base_reg, bit, bit_masks, bits, cond_holds, extend, ror, sext, shift,
    trunc,
};
use crate::cpu::{Cpu, sctlr};
use crate::decode::Op;
use crate::mem::{self, Host, Mem};
use crate::mmu::{Bus, Entry, Flat, Mmu, Slots, TLB_ENTRIES, Use};
use std::collections::HashMap;

/// Micro-op kinds. Field use is listed per kind; `x` holds flags packed as
/// noted, `imm` a pre-computed immediate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum K {
    /// Any instruction: `x` is the word, `imm` its `Op` (as an index of `Op::ALL`).
    Generic,
    /// Does nothing (NOP-space hints, PRFM without an SP base).
    Nop,
    /// `Xd|SP = Xn|SP + imm` (ADD/SUB immediate without flags; SUB negated).
    AddI64,
    /// `Wd|WSP = Wn|WSP + imm`, zero-extended.
    AddI32,
    /// ADDS/SUBS immediate: `x` bit 0 sf, bit 1 carry in; `imm` the operand (inverted for SUBS).
    AddsI,
    /// ADD/SUB(S) shifted register: `x` = type | amount << 2 | sf << 8 | S << 9 | sub << 10.
    AddR,
    /// ADD/SUB(S) extended register: `x` = option | amount << 3 | sf << 8 | S << 9 | sub << 10.
    AddX,
    /// `Xd|SP = imm` (MOVZ, MOVN, ORR immediate from XZR; `d` 31 is SP).
    MovI,
    /// MOVK: `imm` the shifted field, `m` its shift, `x` sf.
    Movk,
    /// ORR from XZR, unshifted: `Xd = Xm` (`x` sf).
    Mov,
    /// AND/ORR/EOR/ANDS immediate: `imm` the mask, `x` = opc | sf << 2.
    LogI,
    /// Logical shifted register: `x` = type | amount << 2 | opc << 8 | invert << 10 | sf << 11.
    LogR,
    /// UBFM: `Xd = ROR(Xn, immr) & imm` (`m` immr, `x` sf).
    Ubfm,
    /// SBFM: `m` immr, `x` = imms | sf << 8.
    Sbfm,
    /// LSLV/LSRV/ASRV/RORV: `x` = type | sf << 2.
    ShiftV,
    /// CSEL/CSINC/CSINV/CSNEG: `x` = cond | op << 4 | sf << 6.
    Csel,
    /// CCMP/CCMN: `m` Rm or imm5, `x` = cond | imm << 4 | sub << 5 | sf << 6 | nzcv << 8.
    Ccmp,
    /// MADD/MSUB: `x` = Ra | sub << 5 | sf << 6.
    Madd,
    /// `Xd = PC + imm`.
    Adr,
    /// `Xd = PC[63:12] + imm`.
    Adrp,
    /// B: `imm` the offset.
    B,
    /// BL.
    Bl,
    /// B.cond: `d` the condition.
    Bcond,
    /// CBZ/CBNZ on `Xd`: `x` = sf | nonzero << 1.
    Cbz,
    /// TBZ/TBNZ of bit `m` of `Xd`: `x` = nonzero.
    Tbz,
    /// BR/RET to `Xn`.
    Br,
    /// BLR.
    Blr,
    /// Single-register load: `d` Rt, `n` Rn, `m` Rm; `x` = log2 size | mode << 2
    /// | ext << 4 | option << 8 | amount << 12. Mode 0 base + imm, 1 pre-index,
    /// 2 post-index, 3 register offset; ext 0 zero-extend, 1 to 64 bits, 2 to 32.
    Ld,
    /// Single-register store, as `Ld` without ext.
    St,
    /// `Ld` of 4 or 8 bytes at base + imm, zero-extended (`x` as `Ld`'s: mode
    /// 0, ext 0); [`hot`] runs it without `Ld`'s choices.
    LdO,
    /// `St` likewise.
    StO,
    /// LDP/LDNP/LDPSW: `d` Rt, `m` Rt2, `x` = size | signed << 4 | mode << 8
    /// (24:23: 0 or 2 offset, 1 post-index, 3 pre-index).
    Ldp,
    /// STP/STNP.
    Stp,
    /// UMADDL/SMADDL/UMSUBL/SMSUBL: `x` = Ra | sub << 5 | signed << 6.
    Maddl,
    /// EXTR: `x` = lsb | sf << 8.
    Extr,
    /// RBIT, REV16, REV32, REV, CLZ (`x` 0 to 4) | sf << 8.
    Bit1,
    /// SIMD&FP LDR/STR (unsigned offset, unscaled, pre- and post-index) and
    /// LDP/STP: `d` Rt, `n` Rn, `m` Rt2; `x` = log2 bytes | mode << 3 (0 offset,
    /// 1 pre-index, 2 post-index) | load << 5 | pair << 6; `imm` the offset (low
    /// 32 bits, signed) and the word (high 32: [`run`] runs it generically).
    Fp,
    /// LD<op> and SWP of a W or X register: `d` Rt, `n` Rn, `m` Rs; `x` = sf |
    /// op << 1 (bits 15:12); `imm` the word ([`run`] runs it generically).
    Lse,
    /// LDXR, LDAXR (`x` bit 2: they arm the monitor) and LDAR: `d` Rt, `n`
    /// Rn; `x` = log2 size | exclusive << 2; `imm` the word ([`run`] runs it
    /// generically).
    Ldx,
    /// STXR, STLXR (`x` bit 2) and STLR: `d` Rt, `n` Rn, `m` Rs; `x` and `imm`
    /// as `Ldx`'s.
    Stx,
    /// DMB: `imm` the word.
    Dmb,
    /// DC ZVA of `Xd`'s 64-byte block: `imm` the word.
    Zva,
    /// CAS, CASB, CASH and their acquire/release forms: `d` Rt, `n` Rn, `m` Rs;
    /// `imm` the word (the size in it; [`run`] runs it generically).
    Cas,
    /// ADC/ADCS/SBC/SBCS: `x` = sf | S << 1 | sub << 2.
    Adc,
    /// UDIV/SDIV: `x` = sf | signed << 1.
    Div,
    /// UMULH/SMULH: `x` = signed.
    Mulh,
    /// BFM: `m` immr, `x` = imms | sf << 8.
    Bfm,
    /// LDR (literal) of `x` bytes (bit 4: LDRSW).
    LdLit,
    /// MRS of a register `sys::plain` reads at the block's EL (made by `uop_el`, after
    /// the kinds the random blocks draw): `x` 0 the u64 at offset `imm` in the `Cpu`,
    /// 1 the constant `imm`, 2 `pstate & imm`, 3 NZCV, 4 SP_EL0 (`sp_other` while
    /// SPSel is 1).
    Mrs,
    /// MSR of what `sys::plain_write` writes at the block's EL, and DAIFSet at EL1
    /// (made by `uop_el`): `d` Rt; `x` 0 the u64 at offset `imm >> 32` in the `Cpu`,
    /// 1 SP_EL0 while SPSel is 1, 2 DAIF unless it unmasks IRQs, 3 DAIFSet (`imm >>
    /// 32` the mask); `imm`'s low half the word ([`run`] runs it generically).
    Msr,
}

/// Marks each MovI with the number of MovIs right after it, and each LdO or
/// StO followed by another with bit 16 of `x` (pairs from the block's
/// start): [`hot`] runs them in its dispatch; [`run`] ignores the marks.
pub fn mov_runs(b: &mut [Wide]) {
    let mut n = 0;
    for k in (0..b.len()).rev() {
        if b[k].k == K::MovI {
            b[k].x = n;
            n += 1;
        } else {
            n = 0;
        }
    }
    // A compare (CMP and SUBS & co, immediate or shifted register; TST and
    // ANDS) right before its B.cond: the compare's handler branches too.
    for k in 0..b.len().saturating_sub(1) {
        if b[k + 1].k == K::Bcond {
            match b[k].k {
                K::AddsI => b[k].x |= 4,
                K::AddR if b[k].x >> 9 & 1 != 0 => b[k].x |= 1 << 11,
                K::LogI if b[k].x & 3 == 3 => b[k].x |= 8,
                K::LogR if b[k].x >> 8 & 3 == 3 => b[k].x |= 1 << 12,
                _ => {}
            }
        }
    }
    let o = |u: &Wide| matches!(u.k, K::LdO | K::StO);
    let mut k = 0;
    while k + 1 < b.len() {
        if o(&b[k]) && o(&b[k + 1]) {
            b[k].x |= 1 << 16;
            k += 2;
        } else {
            k += 1;
        }
    }
}

/// One instruction, decoded: what [`uop_el`] makes, and [`run`] runs
/// ([`pack`] stores it as a [`Uop`]).
#[derive(Clone, Copy, Debug)]
pub struct Wide {
    k: K,
    d: u8,
    n: u8,
    m: u8,
    x: u32,
    imm: u64,
}

impl Wide {
    fn new(k: K, d: u32, n: u32, m: u32, x: u32, imm: u64) -> Wide {
        Wide {
            k,
            d: d as u8,
            n: n as u8,
            m: m as u8,
            x,
            imm,
        }
    }
}

/// One instruction as a block holds it: a [`Wide`] in 8 bytes, its `x` and
/// `imm` packed into `w` and the register bytes its kind doesn't use, as
/// [`pack`] says. A 64-bit immediate that doesn't fit (a bitmask, an MRS
/// constant, an FP access's word and offset) is a slot of the same array
/// after its block's micro-ops, `w` its distance from the micro-op
/// ([`konst`]: [`hot`] holds the micro-op's pointer, not the arena's).
#[derive(Clone, Copy, Debug)]
#[repr(C, align(8))]
pub struct Uop {
    w: u32,
    d: u8,
    n: u8,
    m: u8,
    /// A [`K`] (a constant's slot is never run as a micro-op).
    k: u8,
}

impl Uop {
    /// Whether the block may go on to its successor after this, its last
    /// instruction, retired: anything but an instruction run generically
    /// (which may have changed the regime: an MSR, ERET).
    #[inline(always)]
    pub fn chains(&self) -> bool {
        self.k != K::Generic as u8
    }

    #[inline(always)]
    fn kind(&self) -> K {
        // SAFETY: a micro-op's `k` is a `K` (`pack`); constants' slots are
        // past their block's micro-ops, never run.
        unsafe { core::mem::transmute::<u8, K>(self.k) }
    }

    /// A constant's slot.
    fn of(v: u64) -> Uop {
        // SAFETY: 8 bytes, every one of their values valid (`k` is a u8).
        unsafe { core::mem::transmute::<u64, Uop>(v) }
    }

    /// A constant's value.
    fn bits(&self) -> u64 {
        // SAFETY: as in `of`.
        unsafe { core::mem::transmute::<Uop, u64>(*self) }
    }

    /// The [`Wide`] that `b[i]` packs (its constant further on in `b`).
    fn wide(b: &[Uop], i: usize) -> Wide {
        let u = &b[i];
        let k = u.kind();
        let (d, n, m, w) = (u.d as u32, u.n as u32, u.m as u32, u.w);
        let s = w as i32 as i64 as u64;
        let c = || b[i + w as usize].bits();
        let off16 = (w as i32 >> 16) as i64 as u64;
        let (d, n, m, x, imm) = match k {
            K::Generic => (0, 0, 0, w, (d | n << 8) as u64),
            K::Nop | K::Dmb | K::Zva => (d, n, m, 0, w as u64),
            K::AddI64 | K::AddI32 | K::Adr | K::B | K::Bl => (d, n, m, 0, s),
            K::Bcond => (d, 0, 0, 0, s),
            K::Csel | K::Ccmp => (d, n, m, w & 0xffff, 0),
            K::AddsI | K::Cbz | K::LdLit => (d, n, 0, m, s),
            K::Adrp => (d, n, m, 0, s << 12),
            K::Tbz => (d, 0, m, n, s),
            K::AddR
            | K::AddX
            | K::LogR
            | K::Sbfm
            | K::ShiftV
            | K::Madd
            | K::Maddl
            | K::Extr
            | K::Bit1
            | K::Mov
            | K::Br
            | K::Blr
            | K::Adc
            | K::Div
            | K::Mulh
            | K::Bfm => (d, n, m, w, 0),
            K::Cas => (d, n, m, 0, w as u64),
            K::MovI => (
                d,
                0,
                0,
                n,
                if m & 0x80 != 0 { c() } else { rot_val(u.m, w) },
            ),
            K::Movk => (d, 0, m, n, (w as u64) << (m & 63)),
            K::LogI => (d, n, 0, m, c()),
            K::Ubfm => (d, n, m, w & 1, ubfm_mask(w)),
            K::Ld | K::St | K::LdO | K::StO => (d, n, m, w & 0x7fff | (w >> 15 & 1) << 16, off16),
            K::Ldp | K::Stp => (d, n, m, w & 0xffff, off16),
            K::Fp => {
                let v = c();
                let off = ((v as i64) >> 40) as u64;
                (
                    d,
                    n,
                    m,
                    (v >> 32) as u8 as u32,
                    off as u32 as u64 | (v as u32 as u64) << 32,
                )
            }
            K::Lse => (d, n, m, w >> 30 & 1 | (w >> 12 & 15) << 1, w as u64),
            K::Ldx | K::Stx => (d, n, m, w >> 30 | ((w >> 23 & 1) ^ 1) << 2, w as u64),
            K::Mrs => (
                d,
                0,
                0,
                n,
                if matches!(n, 0 | 3 | 4) {
                    w as u64
                } else {
                    c()
                },
            ),
            K::Msr => (d & 31, 0, 0, d >> 5, w as u64 | ((n | m << 8) as u64) << 32),
        };
        Wide::new(k, d, n, m, x, imm)
    }
}

/// The constant of the micro-op at `u` (its `w`).
///
/// # Safety
/// `u` is in an arena (or a [`pack`]ed block) and its `w` the distance to
/// its constant there.
#[inline(always)]
unsafe fn konst(u: *const Uop) -> u64 {
    // SAFETY: guaranteed by the caller (8-byte slots, aligned).
    unsafe { (u.add((*u).w as usize) as *const u64).read() }
}

/// The value of the MovI at `u` in [`hot`].
///
/// # Safety
/// As for [`konst`].
#[inline(always)]
unsafe fn movi(u: *const Uop) -> u64 {
    // SAFETY: guaranteed by the caller.
    unsafe {
        let o = &*u;
        if o.m & 0x80 != 0 {
            konst(u)
        } else {
            rot_val(o.m, o.w)
        }
    }
}

/// `v` as `ror(ext(w), rot)`: the `m` byte (`rot | zero-extended << 6`) and
/// `w`; covers MOVZ and MOVN at every shift and most bitmasks.
fn rot_form(v: u64) -> Option<(u8, u32)> {
    (0..64).find_map(|r| {
        let c = v.rotate_left(r);
        if c >> 32 == 0 {
            Some((r as u8 | 0x40, c as u32))
        } else if c as i32 as i64 as u64 == c {
            Some((r as u8, c as u32))
        } else {
            None
        }
    })
}

/// Condition `cond` as a mask of the NZCV values (bit `nzcv`) it holds for.
fn cond_mask(cond: u32) -> u16 {
    (0..16).fold(0, |a, f| {
        a | (cond_holds((f as u64) << 28, cond) as u16) << f
    })
}

/// Whether NZCV `nzcv` (bits 31:28) is in condition mask `mask` ([`cond_mask`]).
#[inline(always)]
fn holds(mask: u32, nzcv: u64) -> bool {
    mask >> (nzcv >> 28 & 15) & 1 != 0
}

/// A branch's offset (`w`, sign-extended) in [`hot`], read where it's taken:
/// a load LLVM can't hoist keeps the guest's branch a host branch, which the
/// host predicts, rather than a select that makes the next block's lookup
/// wait for the condition (−30% on the small guests as a select).
///
/// # Safety
/// `u` is a micro-op.
#[inline(always)]
unsafe fn taken_imm(u: *const Uop) -> u64 {
    // SAFETY: guaranteed by the caller.
    (unsafe { core::ptr::read_volatile(&(*u).w) }) as i32 as i64 as u64
}

/// [`rot_form`]'s value.
#[inline(always)]
fn rot_val(m: u8, w: u32) -> u64 {
    let e = if m & 0x40 != 0 {
        w as u64
    } else {
        w as i32 as i64 as u64
    };
    e.rotate_right((m & 63) as u32)
}

/// An Ubfm's mask, a run of ones (`w` bits 1-7 its length, 8-13 its lowest bit).
#[inline(always)]
fn ubfm_mask(w: u32) -> u64 {
    let (len, lsb) = (w >> 1 & 127, w >> 8 & 63);
    (u64::MAX >> ((64 - len) & 63)) << lsb
}

/// Packs a block's micro-ops: its [`Uop`]s, then the constants they need. Per kind, what goes where (the
/// rest as in [`Wide`]):
/// - `w` the immediate (sign-extended): ADD/SUB immediate, ADR, B, BL, B.cond;
///   ADRP's shifted right 12; AddsI, CBZ, LdLit with `x` in `m`; TBZ with `x` in `n`;
/// - `w` = `x`: the register forms, Ubfm (its mask's length and lowest bit
///   in bits 1-13), Sbfm, Mov, BR, BLR;
/// - MovI: `n` its run, `m` and `w` [`rot_form`] or a constant;
///   Movk: `n` sf, `w` the 16 bits; LogI: `m` its `x`, `w` the mask's constant;
/// - loads and stores: `x` in bits 0-15 (bit 15 the LdO/StO pair), the offset
///   in 16-31; LDP/STP likewise;
/// - Fp: a constant (the word, `x` << 32, the offset << 40);
/// - Lse, Ldx, Stx, DMB, DC ZVA: `w` the word (their `x` is in it); Generic:
///   the word, and `d` and `n` its `Op`; Mrs: `n` its `x`, `w` the offset or
///   a constant.
pub fn pack(b: &[Wide]) -> Vec<Uop> {
    let mut out = Vec::with_capacity(b.len());
    let mut consts = Vec::new();
    for (i, u) in b.iter().enumerate() {
        let mut kv = |v: u64| {
            consts.push(v);
            (b.len() + consts.len() - 1 - i) as u32
        };
        let p = |d: u8, n: u8, m: u8, w: u32| Uop {
            k: u.k as u8,
            d,
            n,
            m,
            w,
        };
        let i32w = |v: u64| {
            debug_assert_eq!(v as i32 as i64 as u64, v, "{u:?}");
            v as u32
        };
        let i16w = |v: u64| {
            debug_assert_eq!(v as i16 as i64 as u64, v, "{u:?}");
            (v as u16 as u32) << 16
        };
        let (d, n, m) = (u.d, u.n, u.m);
        out.push(match u.k {
            K::Generic => p(u.imm as u8, (u.imm >> 8) as u8, 0, u.x),
            K::Nop | K::Dmb | K::Zva => p(d, n, m, u.imm as u32),
            K::AddI64 | K::AddI32 | K::Adr | K::B | K::Bl => p(d, n, m, i32w(u.imm)),
            K::Bcond => {
                let mask = cond_mask(d as u32);
                p(d, mask as u8, (mask >> 8) as u8, i32w(u.imm))
            }
            K::AddsI | K::Cbz | K::LdLit => p(d, n, u.x as u8, i32w(u.imm)),
            K::Adrp => p(d, n, m, i32w((u.imm as i64 >> 12) as u64)),
            K::Tbz => p(d, u.x as u8, m, i32w(u.imm)),
            K::AddR
            | K::AddX
            | K::LogR
            | K::Sbfm
            | K::ShiftV
            | K::Madd
            | K::Maddl
            | K::Extr
            | K::Bit1
            | K::Mov
            | K::Br
            | K::Blr
            | K::Adc
            | K::Div
            | K::Mulh
            | K::Bfm => p(d, n, m, u.x),
            K::Csel | K::Ccmp => p(d, n, m, u.x | (cond_mask(u.x & 15) as u32) << 16),
            K::MovI => {
                let run = u.x.min(255) as u8;
                match rot_form(u.imm) {
                    Some((r, w)) => p(d, run, r, w),
                    None => p(d, run, 0x80, kv(u.imm)),
                }
            }
            K::Movk => p(d, u.x as u8, m, (u.imm >> (m & 63)) as u32),
            K::LogI => p(d, n, u.x as u8, kv(u.imm)),
            K::Ubfm => {
                // (A W form's mask is replicated: its low half is the run.)
                let mask = if u.x & 1 != 0 {
                    u.imm
                } else {
                    u.imm as u32 as u64
                };
                let (len, lsb) = (mask.count_ones(), mask.trailing_zeros());
                debug_assert!(len > 0 && ubfm_mask(len << 1 | lsb << 8) == mask, "{u:?}");
                p(d, n, m, u.x | len << 1 | lsb << 8)
            }
            K::Ld | K::St | K::LdO | K::StO => {
                p(d, n, m, u.x & 0x7fff | (u.x >> 16 & 1) << 15 | i16w(u.imm))
            }
            K::Ldp | K::Stp => p(d, n, m, u.x & 0xffff | i16w(u.imm)),
            K::Fp => {
                let off = u.imm as u32 as i32 as i64;
                debug_assert!((-1 << 23..1 << 23).contains(&off), "{u:?}");
                p(
                    d,
                    n,
                    m,
                    kv(u.imm >> 32 | (u.x as u64) << 32 | (off as u64) << 40),
                )
            }
            K::Lse | K::Ldx | K::Stx | K::Cas => p(d, n, m, u.imm as u32),
            K::Msr => {
                let a = u.imm >> 32;
                p(d | (u.x as u8) << 5, a as u8, (a >> 8) as u8, u.imm as u32)
            }
            K::Mrs => match u.x {
                0 | 3 | 4 => p(d, u.x as u8, 0, u.imm as u32),
                x => p(d, x as u8, 0, kv(u.imm)),
            },
        });
    }
    out.extend(consts.into_iter().map(Uop::of));
    out
}

/// [`uop_op`] at the block's EL (`el1`): an MRS of a register `sys::plain`
/// knows at that EL is a [`K::Mrs`] (the rest are as `uop_op` makes them).
pub(crate) fn uop_el(w: u32, op: Op, el1: bool) -> Wide {
    use super::sys::Plain;
    if op == Op::MRS {
        let (rt, key) = (bits(w, 4, 0), bits(w, 20, 5));
        let (x, imm) = match super::sys::plain(key, el1) {
            Some(Plain::Field(off)) => (0, off as u64),
            Some(Plain::Const(v)) => (1, v),
            Some(Plain::Pstate(m)) => (2, m),
            Some(Plain::Nzcv) => (3, 0),
            Some(Plain::SpEl0) => (4, 0),
            _ => return uop_op(w, op),
        };
        return Wide::new(K::Mrs, rt, 0, 0, x, imm);
    }
    if op == Op::MSR_reg {
        use super::sys::PlainWrite;
        let (rt, key) = (bits(w, 4, 0), bits(w, 20, 5));
        let (x, a) = match super::sys::plain_write(key, el1) {
            Some(PlainWrite::Field(off)) => (0, off as u64),
            Some(PlainWrite::SpEl0) => (1, 0),
            Some(PlainWrite::Daif) => (2, 0),
            None => return uop_op(w, op),
        };
        return Wide::new(K::Msr, rt, 0, 0, x, w as u64 | a << 32);
    }
    // DAIFSet: it only masks.
    if op == Op::MSR_imm && el1 && (bits(w, 18, 16), bits(w, 7, 5)) == (3, 6) {
        return Wide::new(K::Msr, 0, 0, 0, 3, w as u64 | (bits(w, 11, 8) as u64) << 38);
    }
    uop_op(w, op)
}

/// MRS (`K::Mrs`) of what `x` and `imm` say.
#[inline(always)]
fn mrs(c: &Cpu, x: u32, imm: u64) -> u64 {
    match x {
        // SAFETY: `imm` is the offset of a u64 field of `Cpu` (`sys::plain`).
        0 => unsafe {
            (c as *const Cpu as *const u8)
                .add(imm as usize % (core::mem::size_of::<Cpu>() - 7))
                .cast::<u64>()
                .read_unaligned()
        },
        1 => imm,
        2 => c.pstate & imm,
        3 => c.nzcv,
        _ => c.sp_other,
    }
}

/// Decodes one instruction (blocks are decoded through `jit::block::form_with`).
#[cfg(test)]
pub fn uop(w: u32) -> Wide {
    uop_op(w, crate::decode::decode(w))
}

/// [`uop`] of `w`, whose class is `op`.
fn uop_op(w: u32, op: Op) -> Wide {
    use Op::*;
    let (rd, rn, rm) = (bits(w, 4, 0), bits(w, 9, 5), bits(w, 20, 16));
    let sf = bit(w, 31);
    let generic = Wide::new(K::Generic, 0, 0, 0, w, op as u16 as u64);
    let u = |k, x, imm| Wide::new(k, rd, rn, rm, x, imm);
    let branch = |hi, lo, n| sext((bits(w, hi, lo) << 2) as u64, n);
    match op {
        ADR => u(K::Adr, 0, super::adr_imm(w)),
        ADRP => u(K::Adrp, 0, super::adr_imm(w) << 12),

        ADD_imm | ADDS_imm | SUB_imm | SUBS_imm => {
            let imm = bits(w, 21, 10) as u64;
            let imm = match bits(w, 23, 22) {
                0 => imm,
                1 => imm << 12,
                _ => return generic,
            };
            let (sub, s) = (bit(w, 30), bit(w, 29));
            match (s, sf) {
                (false, true) => u(K::AddI64, 0, if sub { imm.wrapping_neg() } else { imm }),
                (false, false) => u(K::AddI32, 0, if sub { imm.wrapping_neg() } else { imm }),
                (true, _) => u(
                    K::AddsI,
                    sf as u32 | (sub as u32) << 1,
                    if sub { !imm } else { imm },
                ),
            }
        }
        ADD_shift | ADDS_shift | SUB_shift | SUBS_shift => {
            let (ty, amt) = (bits(w, 23, 22), bits(w, 15, 10));
            if ty == 3 || (!sf && amt >= 32) {
                return generic;
            }
            let x = ty | amt << 2 | (sf as u32) << 8 | bits(w, 30, 29) << 9;
            u(K::AddR, x, 0)
        }
        ADD_ext | ADDS_ext | SUB_ext | SUBS_ext => {
            let amt = bits(w, 12, 10);
            if amt > 4 {
                return generic;
            }
            let x = bits(w, 15, 13) | amt << 3 | (sf as u32) << 8 | bits(w, 30, 29) << 9;
            u(K::AddX, x, 0)
        }

        AND_imm | ORR_imm | EOR_imm | ANDS_imm => {
            let n = bits(w, 22, 22);
            if !sf && n == 1 {
                return generic;
            }
            let Some((imm, _)) = bit_masks(n, bits(w, 15, 10), bits(w, 21, 16), true) else {
                return generic;
            };
            let opc = bits(w, 30, 29);
            if opc == 1 && rn == 31 {
                // MOV (bitmask immediate): Rd 31 is SP here.
                return u(K::MovI, 0, trunc(imm, sf));
            }
            u(K::LogI, opc | (sf as u32) << 2, imm)
        }
        AND_shift | BIC_shift | ORR_shift | ORN_shift | EOR_shift | EON | ANDS_shift | BICS => {
            let (ty, amt) = (bits(w, 23, 22), bits(w, 15, 10));
            if !sf && amt >= 32 {
                return generic;
            }
            let (opc, invert) = (bits(w, 30, 29), bit(w, 21));
            if opc == 1 && !invert && rn == 31 && amt == 0 {
                return if rd == 31 {
                    u(K::Nop, 0, 0)
                } else {
                    u(K::Mov, sf as u32, 0)
                };
            }
            let x = ty | amt << 2 | opc << 8 | (invert as u32) << 10 | (sf as u32) << 11;
            u(K::LogR, x, 0)
        }

        MOVN | MOVZ | MOVK => {
            let hw = bits(w, 22, 21);
            if !sf && hw >= 2 {
                return generic;
            }
            let (sh, imm) = (hw * 16, bits(w, 20, 5) as u64);
            match op {
                MOVK => Wide::new(K::Movk, rd, 0, sh, sf as u32, imm << sh),
                _ if rd == 31 => u(K::Nop, 0, 0),
                MOVN => u(K::MovI, 0, trunc(!(imm << sh), sf)),
                _ => u(K::MovI, 0, imm << sh),
            }
        }

        SBFM | BFM | UBFM | ASR_1 | ASR_2 | SXTB_1 | SXTB_2 | SXTH_1 | SXTH_2 | SXTW => {
            let (n, immr, imms) = (bits(w, 22, 22), bits(w, 21, 16), bits(w, 15, 10));
            if (sf && n != 1) || (!sf && (n != 0 || immr >= 32 || imms >= 32)) {
                return generic;
            }
            let Some((wmask, tmask)) = bit_masks(n, imms, immr, false) else {
                return generic;
            };
            match bits(w, 30, 29) {
                0 => Wide::new(K::Sbfm, rd, rn, immr, imms | (sf as u32) << 8, 0),
                1 => Wide::new(K::Bfm, rd, rn, immr, imms | (sf as u32) << 8, 0),
                2 => Wide::new(K::Ubfm, rd, rn, immr, sf as u32, wmask & tmask),
                _ => generic,
            }
        }

        LSLV | LSRV | ASRV | RORV => u(K::ShiftV, bits(w, 11, 10) | (sf as u32) << 2, 0),
        CSEL | CSINC | CSINV | CSNEG => {
            let op2 = bit(w, 30) as u32 * 2 + bit(w, 10) as u32;
            u(K::Csel, bits(w, 15, 12) | op2 << 4 | (sf as u32) << 6, 0)
        }
        CCMN_reg | CCMP_reg | CCMN_imm | CCMP_imm => {
            let x = bits(w, 15, 12)
                | (bit(w, 11) as u32) << 4
                | (bit(w, 30) as u32) << 5
                | (sf as u32) << 6
                | bits(w, 3, 0) << 8;
            u(K::Ccmp, x, 0)
        }
        SMADDL | SMSUBL | UMADDL | UMSUBL => u(
            K::Maddl,
            bits(w, 14, 10)
                | (bit(w, 15) as u32) << 5
                | (matches!(op, SMADDL | SMSUBL) as u32) << 6,
            0,
        ),
        EXTR => {
            let lsb = bits(w, 15, 10);
            if bit(w, 22) != sf || (!sf && lsb >= 32) {
                return generic;
            }
            u(K::Extr, lsb | (sf as u32) << 8, 0)
        }
        RBIT_int | REV16_int | REV32_int | REV | CLZ_int => {
            let k = match op {
                RBIT_int => 0,
                REV16_int => 1,
                REV32_int => 2,
                REV => {
                    if sf != bit(w, 10) {
                        return generic;
                    }
                    3
                }
                _ => 4,
            };
            u(K::Bit1, k | (sf as u32) << 8, 0)
        }
        MADD | MSUB => u(
            K::Madd,
            bits(w, 14, 10) | (bit(w, 15) as u32) << 5 | (sf as u32) << 6,
            0,
        ),

        B_uncond => u(K::B, 0, branch(25, 0, 28)),
        BL => u(K::Bl, 0, branch(25, 0, 28)),
        B_cond => Wide::new(K::Bcond, bits(w, 3, 0), 0, 0, 0, branch(23, 5, 21)),
        CBZ | CBNZ => u(
            K::Cbz,
            sf as u32 | ((op == CBNZ) as u32) << 1,
            branch(23, 5, 21),
        ),
        TBZ | TBNZ => {
            let b = bits(w, 31, 31) << 5 | bits(w, 23, 19);
            Wide::new(K::Tbz, rd, 0, b, (op == TBNZ) as u32, branch(18, 5, 16))
        }
        BR | RET => u(K::Br, 0, 0),
        BLR => u(K::Blr, 0, 0),

        NOP | HINT | XPAC_2 | PACIA_2 | PACIB_2 | AUTIA_2 | AUTIB_2 | BTI | ESB | PSB | TSB
        | CSDB | DGH | PRFM_lit => u(K::Nop, 0, 0),
        // The base register is read (an SP base may fault) before the hint.
        PRFM_imm | PRFM_unscaled_imm if rn != 31 => u(K::Nop, 0, 0),

        LDR_lit_gen | LDRSW_lit => {
            let size = match (op, bit(w, 30)) {
                (LDRSW_lit, _) => 4 | 16,
                (_, false) => 4,
                (_, true) => 8,
            };
            u(K::LdLit, size, branch(23, 5, 21))
        }
        STRx_LDRx_imm_2 | STURx_LDURx | STRx_LDRx_imm_1 | STRx_reg | LDRx_reg => {
            let (size, opc) = (bits(w, 31, 30), bits(w, 23, 22));
            let (mode, imm, option, amt) = match op {
                STRx_LDRx_imm_2 => (0, (bits(w, 21, 10) as u64) << size, 0, 0),
                STURx_LDURx => (0, sext(bits(w, 20, 12) as u64, 9), 0, 0),
                STRx_LDRx_imm_1 => (
                    if bit(w, 11) { 1 } else { 2 },
                    sext(bits(w, 20, 12) as u64, 9),
                    0,
                    0,
                ),
                _ => {
                    let option = bits(w, 15, 13);
                    if option & 2 == 0 {
                        return generic;
                    }
                    (3, 0, option, if bit(w, 12) { size } else { 0 })
                }
            };
            let (k, ext) = match opc {
                0 => (K::St, 0),
                1 => (K::Ld, 0),
                _ if size == 3 || (size == 2 && opc == 3) => return generic,
                2 => (K::Ld, 1),
                _ => (K::Ld, 2),
            };
            let k = match k {
                K::Ld if mode == 0 && ext == 0 && size >= 2 => K::LdO,
                K::St if mode == 0 && size >= 2 => K::StO,
                k => k,
            };
            u(
                k,
                size | mode << 2 | ext << 4 | option << 8 | amt << 12,
                imm,
            )
        }
        STR_imm_fpsimd_2 | LDR_imm_fpsimd_2 | STUR_fpsimd | LDUR_fpsimd | STR_imm_fpsimd_1
        | LDR_imm_fpsimd_1 | STP_LDP_fpsimd | STNP_LDNP_fpsimd => {
            let pair = matches!(op, STP_LDP_fpsimd | STNP_LDNP_fpsimd);
            let log = if pair {
                match bits(w, 31, 30) {
                    3 => return generic,
                    opc => 2 + opc,
                }
            } else {
                match (bits(w, 31, 30), bit(w, 23)) {
                    (0, true) => 4,
                    (s, false) => s,
                    _ => return generic,
                }
            };
            let (mode, off) = match op {
                STR_imm_fpsimd_2 | LDR_imm_fpsimd_2 => (0, (bits(w, 21, 10) as u64) << log),
                STUR_fpsimd | LDUR_fpsimd => (0, sext(bits(w, 20, 12) as u64, 9)),
                STR_imm_fpsimd_1 | LDR_imm_fpsimd_1 => (
                    if bit(w, 11) { 1 } else { 2 },
                    sext(bits(w, 20, 12) as u64, 9),
                ),
                _ => (
                    match bits(w, 24, 23) {
                        1 => 2,
                        3 => 1,
                        _ => 0,
                    },
                    sext(bits(w, 21, 15) as u64, 7) << log,
                ),
            };
            let x = log | mode << 3 | (bit(w, 22) as u32) << 5 | (pair as u32) << 6;
            Wide::new(
                K::Fp,
                rd,
                rn,
                bits(w, 14, 10),
                x,
                off as u32 as u64 | (w as u64) << 32,
            )
        }
        LDADD | LDCLR | LDEOR | LDSET | LDSMAX | LDSMIN | LDUMAX | LDUMIN | SWP
            if bits(w, 31, 30) >= 2 && bits(w, 15, 12) <= 8 =>
        {
            u(K::Lse, bit(w, 30) as u32 | bits(w, 15, 12) << 1, w as u64)
        }
        LDXR | LDAXR | LDAR => u(
            K::Ldx,
            bits(w, 31, 30) | ((op != LDAR) as u32) << 2,
            w as u64,
        ),
        STXR | STLXR | STLR => u(
            K::Stx,
            bits(w, 31, 30) | ((op != STLR) as u32) << 2,
            w as u64,
        ),
        DMB => u(K::Dmb, 0, w as u64),
        CAS | CASB | CASH => u(K::Cas, 0, w as u64),
        ADC | ADCS | SBC | SBCS => u(
            K::Adc,
            sf as u32 | (bit(w, 29) as u32) << 1 | (bit(w, 30) as u32) << 2,
            0,
        ),
        UDIV | SDIV => u(K::Div, sf as u32 | ((op == SDIV) as u32) << 1, 0),
        UMULH | SMULH => u(K::Mulh, (op == SMULH) as u32, 0),
        DC_ZVA => u(K::Zva, 0, w as u64),
        STP_LDP_gen | STNP_LDNP_gen => {
            let (opc, load) = (bits(w, 31, 30), bit(w, 22));
            let (size, signed) = match (opc, load) {
                (0, _) => (4, false),
                (2, _) => (8, false),
                (1, true) if op == STP_LDP_gen => (4, true),
                _ => return generic,
            };
            let imm = sext(bits(w, 21, 15) as u64, 7).wrapping_mul(size as u64);
            let k = if load { K::Ldp } else { K::Stp };
            let x = size | (signed as u32) << 4 | bits(w, 24, 23) << 8;
            Wide::new(k, rd, rn, bits(w, 14, 10), x, imm)
        }
        _ => generic,
    }
}

/// Runs the first `len` micro-ops of `b` (a prefix of a block: at most what's
/// left of the chunk; `b` goes on past them to their constants) at `pc`.
/// Returns what [`super::steps`] would for those instructions: how many
/// retired before one that didn't (or that retired with an internal exit),
/// and that exit.
#[inline(never)]
pub fn run(c: &mut Cpu, m: &mut impl Bus, b: &[Uop], len: usize, pc: u64) -> (u64, Option<Exit>) {
    let mut pc = pc;
    for k in 0..len {
        // A generic one first, without unpacking it (the word and its `Op`).
        let g = &b[k];
        if g.kind() == K::Generic {
            let op = Op::ALL[(g.d as u16 | (g.n as u16) << 8) as usize];
            if let Err(e) = super::exec_at_op(c, m, g.w, pc, op) {
                return (k as u64, Some(e));
            }
            if k + 1 == len {
                // It may have branched (ERET, an MSR's exit): the PC is its.
                return (len as u64, None);
            }
            pc = pc.wrapping_add(4);
            continue;
        }
        let u = &Uop::wide(b, k);
        let (d, n) = (u.d as u32, u.n as u32);
        let sf = u.x & 1 != 0;
        match u.k {
            K::Generic => unreachable!("run above"),
            K::Nop => {}
            K::AddI64 => c.x[d as usize] = c.x[n as usize].wrapping_add(u.imm),
            K::AddI32 => c.x[d as usize] = c.x[n as usize].wrapping_add(u.imm) as u32 as u64,
            K::AddsI => {
                let (r, f) = add_with_carry(c.x[n as usize], u.imm, u.x & 2 != 0, sf);
                c.nzcv = f;
                c.set_reg(d, r);
            }
            K::AddR => {
                let sf = u.x >> 8 & 1 != 0;
                let y = shift(c.reg(u.m as u32), u.x & 3, u.x >> 2 & 63, sf);
                addsub(c, u.x, d, c.reg(n), y, sf, false);
            }
            K::AddX => {
                let sf = u.x >> 8 & 1 != 0;
                let y = extend(c.reg(u.m as u32), u.x & 7, u.x >> 3 & 7);
                addsub(c, u.x, d, c.x[n as usize], y, sf, true);
            }
            K::MovI => c.x[d as usize] = u.imm,
            K::Movk => {
                let v = (c.reg(d) & !(0xffff << u.m)) | u.imm;
                c.set_reg(d, trunc(v, sf));
            }
            K::Mov => c.x[d as usize] = trunc(c.reg(u.m as u32), sf),
            K::LogI => {
                let opc = u.x & 3;
                logical(c, opc, d, op(opc, c.reg(n), u.imm), u.x & 4 != 0, true);
            }
            K::LogR => {
                let sf = u.x >> 11 & 1 != 0;
                let y = shift(c.reg(u.m as u32), u.x & 3, u.x >> 2 & 63, sf);
                let y = if u.x >> 10 & 1 != 0 { !y } else { y };
                let opc = u.x >> 8 & 3;
                logical(c, opc, d, op(opc, c.reg(n), y), sf, false);
            }
            K::Ubfm => c.set_reg(d, ror(trunc(c.reg(n), sf), u.m as u32, sf) & u.imm),
            K::Sbfm => {
                let (r, s, sf) = (u.m as u32, u.x & 63, u.x >> 8 & 1 != 0);
                let src = c.reg(n);
                let v = if s >= r {
                    sext(src >> r, s - r + 1)
                } else {
                    sext(src, s + 1) << (if sf { 64 } else { 32 } - r)
                };
                c.set_reg(d, trunc(v, sf));
            }
            K::ShiftV => {
                let sf = u.x & 4 != 0;
                let amt = (c.reg(u.m as u32) % if sf { 64 } else { 32 }) as u32;
                c.set_reg(d, shift(c.reg(n), u.x & 3, amt, sf));
            }
            K::Csel => {
                let r = if cond_holds(c.nzcv, u.x & 15) {
                    c.reg(n)
                } else {
                    let y = c.reg(u.m as u32);
                    match u.x >> 4 & 3 {
                        0 => y,
                        1 => y.wrapping_add(1),
                        2 => !y,
                        _ => y.wrapping_neg(),
                    }
                };
                c.set_reg(d, trunc(r, u.x >> 6 & 1 != 0));
            }
            K::Ccmp => {
                c.nzcv = if cond_holds(c.nzcv, u.x & 15) {
                    let y = if u.x >> 4 & 1 != 0 {
                        u.m as u64
                    } else {
                        c.reg(u.m as u32)
                    };
                    let sub = u.x >> 5 & 1 != 0;
                    let y = if sub { !y } else { y };
                    add_with_carry(c.reg(n), y, sub, u.x >> 6 & 1 != 0).1
                } else {
                    ((u.x >> 8 & 15) as u64) << 28
                };
            }
            K::Madd => {
                let p = c.reg(n).wrapping_mul(c.reg(u.m as u32));
                let a = c.reg(u.x & 31);
                let r = if u.x >> 5 & 1 != 0 {
                    a.wrapping_sub(p)
                } else {
                    a.wrapping_add(p)
                };
                c.set_reg(d, trunc(r, u.x >> 6 & 1 != 0));
            }
            K::Maddl => {
                let v = maddl(u.x, c.reg(n), c.reg(u.m as u32), c.reg(u.x & 31));
                c.set_reg(d, v);
            }
            K::Extr => c.set_reg(d, extr(u.x, c.reg(n), c.reg(u.m as u32))),
            K::Bit1 => c.set_reg(d, bit1(u.x, c.reg(n))),
            // SP_EL0 with SPSel 0 is UNDEFINED: the interpreter's MRS (its word).
            K::Mrs if u.x == 4 && c.pstate & 1 == 0 => {
                let w = 0xd538_4100 | d;
                if let Err(e) = super::exec_at_op(c, m, w, pc, crate::decode::decode(w)) {
                    return (k as u64, Some(e));
                }
            }
            K::Mrs => c.set_reg(d, mrs(c, u.x, u.imm)),
            K::Fp => {
                let w = (u.imm >> 32) as u32;
                if let Err(e) = super::exec_at_op(c, m, w, pc, crate::decode::decode(w)) {
                    return (k as u64, Some(e));
                }
            }
            K::Adc => {
                let v = adc(c, u.x, c.reg(n), c.reg(u.m as u32));
                c.set_reg(d, v)
            }
            K::Div => c.set_reg(d, div(u.x, c.reg(n), c.reg(u.m as u32))),
            K::Mulh => c.set_reg(d, mulh(u.x, c.reg(n), c.reg(u.m as u32))),
            K::Bfm => c.set_reg(d, bfm(u.m as u32, u.x, c.reg(d), c.reg(n))),
            K::Lse | K::Ldx | K::Stx | K::Dmb | K::Zva | K::Msr | K::Cas => {
                let w = u.imm as u32;
                if let Err(e) = super::exec_at_op(c, m, w, pc, crate::decode::decode(w)) {
                    return (k as u64, Some(e));
                }
            }
            K::Adr => c.set_reg(d, pc.wrapping_add(u.imm)),
            K::Adrp => c.set_reg(d, (pc & !0xfff).wrapping_add(u.imm)),
            K::B => return taken(c, len, pc.wrapping_add(u.imm)),
            K::Bl => {
                c.x[30] = pc.wrapping_add(4);
                return taken(c, len, pc.wrapping_add(u.imm));
            }
            K::Bcond => {
                let t = cond_holds(c.nzcv, d);
                return taken(c, len, pc.wrapping_add(if t { u.imm } else { 4 }));
            }
            K::Cbz => {
                let t = (trunc(c.reg(d), sf) != 0) == (u.x & 2 != 0);
                return taken(c, len, pc.wrapping_add(if t { u.imm } else { 4 }));
            }
            K::Tbz => {
                let t = (c.reg(d) >> u.m & 1 != 0) == (u.x != 0);
                return taken(c, len, pc.wrapping_add(if t { u.imm } else { 4 }));
            }
            K::Br => return taken(c, len, c.reg(n)),
            K::Blr => {
                let to = c.reg(n);
                c.x[30] = pc.wrapping_add(4);
                return taken(c, len, to);
            }
            K::Ld | K::St | K::LdO | K::StO => {
                if let Err(e) = single(c, m, u) {
                    c.pc = pc;
                    return (k as u64, Some(e));
                }
            }
            K::Ldp | K::Stp => {
                if let Err(e) = pair(c, m, u) {
                    c.pc = pc;
                    return (k as u64, Some(e));
                }
            }
            K::LdLit => {
                let size = u.x & 15;
                match m.read(c, pc.wrapping_add(u.imm), size) {
                    Ok(v) => c.set_reg(d, if u.x & 16 != 0 { v as i32 as u64 } else { v }),
                    Err(f) => {
                        c.pc = pc;
                        return (k as u64, Some(Exit::Fault(f)));
                    }
                }
            }
        }
        pc = pc.wrapping_add(4);
    }
    c.pc = pc;
    (len as u64, None)
}

/// A bus's inline paths for [`hot`]: no call and no panic on any path, so
/// that V8 keeps the loop's state in registers (it spills every value live
/// across a call at its definition, docs/v8.md "Spills"). `None`: the slow
/// path's, outside the loop.
pub trait Fast: Bus {
    /// What [`Fast::fast_in`] needs that can't change while [`hot`] runs
    /// (anything that could change it runs generically, outside the loop).
    type Ctx: Copy;
    /// The context for `c` as it stands.
    fn ctx(&self, c: &Cpu) -> Self::Ctx;
    /// The host address of `size` bytes of RAM at `va` for `u`, if the TLB
    /// (or the flat map) has it, as [`Bus::fast`], in a context from
    /// [`Fast::ctx`] with nothing in between that changes its inputs.
    fn fast_in(&mut self, x: Self::Ctx, va: u64, size: u32, u: Use) -> Option<*mut u8>;
    /// The block key of the instruction at `pc` (aligned), if the instruction
    /// TLB has it: `jit::key`'s.
    fn ikey(&mut self, c: &Cpu, pc: u64) -> Option<u64>;
}

impl Fast for Flat<'_> {
    type Ctx = ();

    #[inline(always)]
    fn ctx(&self, _: &Cpu) {}

    #[inline(always)]
    fn fast_in(&mut self, _: (), va: u64, size: u32, _: Use) -> Option<*mut u8> {
        self.0.host0(va, size as u64)
    }

    #[inline(always)]
    fn ikey(&mut self, c: &Cpu, pc: u64) -> Option<u64> {
        Some(pc | c.el() & 1)
    }
}

impl Fast for Mmu<'_> {
    /// The EL's first array in the TLB's first slots, or null: the slow path
    /// (SCTLR_EL1.A, alignment faults, or the MMU off, or no TLB).
    type Ctx = *const Entry;

    #[inline(always)]
    fn ctx(&self, c: &Cpu) -> *const Entry {
        match self.tlb.as_deref() {
            // EL0 and EL1 only (masked), as `Mmu::fast`.
            Some(t) if c.sctlr_el1 & (sctlr::M | sctlr::A) == sctlr::M => {
                // SAFETY: entry 3 × EL of the first slots, in the array.
                unsafe { (t.e.as_ptr() as *const Entry).add(3 * (c.el() & 1) as usize) }
            }
            _ => core::ptr::null(),
        }
    }

    #[inline(always)]
    fn fast_in(&mut self, x: *const Entry, va: u64, size: u32, u: Use) -> Option<*mut u8> {
        if x.is_null() {
            return None;
        }
        let i = (va >> 12) as usize & (TLB_ENTRIES - 1);
        // SAFETY: `x` is in the TLB's first slots (`ctx`), which `self.tlb`
        // borrows; slot `i` (masked) is `i` slots on, entry `u` of the EL's
        // three in it.
        let e = unsafe {
            *x.byte_add(i * core::mem::size_of::<Slots>())
                .add(u as usize)
        };
        (e.tag == va.wrapping_add(size as u64 - 1) | 0xfff)
            .then(|| va.wrapping_add(e.addend) as usize as *mut u8)
    }

    #[inline(always)]
    fn ikey(&mut self, c: &Cpu, pc: u64) -> Option<u64> {
        if c.sctlr_el1 & sctlr::M == 0 {
            return None;
        }
        let el = c.el() & 1;
        let e = self.tlb.as_ref()?.e[(pc >> 12) as usize & (TLB_ENTRIES - 1)].0
            [3 * el as usize + Use::Exec as usize];
        if e.tag != pc.wrapping_add(3) | 0xfff {
            return None;
        }
        let pa = self.mem.pa0(Host(pc.wrapping_add(e.addend)))?;
        Some(pa | el | crate::jit::block::KEY_MMU)
    }
}

/// Where a run of decoded blocks stands between [`hot`]'s returns.
pub struct Run {
    /// The micro-op to run next, and the end of its block's prefix (the
    /// micro-ops that fit in the steps left).
    u: *const Uop,
    end: *const Uop,
    /// The PC of `u`'s instruction.
    pub pc: u64,
    /// The block's key and the PC of its first instruction.
    pub key: u64,
    pub bpc: u64,
    /// The steps retired once the block's prefix has run, and at most.
    pub done: u64,
    pub left: u64,
}

impl Run {
    /// A run of `left` steps, before its first block.
    pub fn new(left: u64) -> Run {
        Run {
            u: core::ptr::null(),
            end: core::ptr::null(),
            pc: 0,
            key: 0,
            bpc: 0,
            done: 0,
            left,
        }
    }

    /// Enters block `b` (`key`) at `pc`: its prefix that fits in the steps left.
    pub fn enter(&mut self, b: &[Uop], key: u64, pc: u64) {
        let n = b.len().min((self.left - self.done) as usize);
        self.u = b.as_ptr();
        // SAFETY: n <= b.len().
        self.end = unsafe { self.u.add(n) };
        (self.pc, self.key, self.bpc) = (pc, key, pc);
        self.done += n as u64;
    }

    /// The steps retired before the micro-op [`hot`] stopped at.
    pub fn retired(&self) -> u64 {
        // SAFETY: both point into the block's micro-ops, `u` <= `end`.
        self.done - (unsafe { self.end.offset_from(self.u) }) as u64
    }

    /// What the slow path runs where [`hot`] stopped ([`SLOW`]): that
    /// micro-op and the ones right after it in the prefix that `hot` never
    /// runs (generic, literal loads), so a run of them costs one exit from
    /// `hot`, not one each. Their number, the last of them, and whether it's
    /// the prefix's last.
    pub fn stretch(&self) -> (usize, Uop, bool) {
        let mut n = 1;
        // SAFETY: `u` + `n` <= `end`, into the arena, which nothing changed since.
        unsafe {
            while self.u.add(n) != self.end
                && matches!((*self.u.add(n)).kind(), K::Generic | K::LdLit)
            {
                n += 1;
            }
            (n, *self.u.add(n - 1), self.u.add(n) == self.end)
        }
    }

    /// The micro-op [`hot`] stopped at, as an index of `arena` (its).
    pub fn at(&self, arena: &[Uop]) -> usize {
        // SAFETY: `u` is in `arena`.
        (unsafe { self.u.offset_from(arena.as_ptr()) }) as usize
    }

    /// Past the `n` micro-ops of a [`Run::stretch`], which retired (not its
    /// prefix's last).
    pub fn step(&mut self, n: usize) {
        // SAFETY: `u` + `n` < `end`.
        self.u = unsafe { self.u.add(n) };
        self.pc = self.pc.wrapping_add(4 * n as u64);
    }
}

/// [`hot`] stopped: the run ends here, `c.pc` set.
pub const STOP: u32 = 0;
/// [`hot`] stopped at a micro-op it can't run inline ([`Run::stretch`] at
/// [`Run::pc`], `c.pc` not set): a generic one, a literal load, or a load or
/// store whose fast path missed.
pub const SLOW: u32 = 1;
/// [`hot`] ran its block's prefix out (`c.pc` the next instruction's) and
/// found no next block inline: its caller looks for one.
pub const NEXT: u32 = 2;

#[inline(always)]
fn rd(c: &Cpu, n: u32) -> u64 {
    if n == 31 { 0 } else { c.x[(n & 31) as usize] }
}

#[inline(always)]
fn wr(c: &mut Cpu, n: u32, v: u64) {
    if n != 31 {
        c.x[(n & 31) as usize] = v;
    }
}

/// Register `n`, 31 the SP.
#[inline(always)]
fn rsp(c: &Cpu, n: u32) -> u64 {
    c.x[(n & 31) as usize]
}

#[inline(always)]
fn wsp(c: &mut Cpu, n: u32, v: u64) {
    c.x[(n & 31) as usize] = v;
}

/// In [`hot`], after a flag setter whose B.cond follows it ([`mov_runs`]):
/// that B.cond too, if it's in the block's prefix (`$u` < `$end`), with the
/// flags `$nzcv`; it ends the block (`$l`).
macro_rules! and_bcond {
    ($l:lifetime, $u:ident, $end:ident, $pc:ident, $nzcv:expr) => {
        // SAFETY: $u < $end.
        if unsafe { $u.add(1) } != $end {
            // SAFETY: $u + 1 < $end, a B.cond.
            $u = unsafe { $u.add(1) };
            $pc = $pc.wrapping_add(4);
            let b = unsafe { &*$u };
            let t = holds(b.n as u32 | (b.m as u32) << 8, $nzcv);
            // SAFETY: as above.
            break $l $pc.wrapping_add(if t { unsafe { taken_imm($u) } } else { 4 });
        }
    };
}

/// Runs decoded blocks from `r` as [`run`] does, chaining from each to the
/// next as `jit::interpret` does, and returns at what needs a call: a
/// micro-op the inline paths can't run ([`SLOW`]), a next block not in its
/// slot or a key the instruction TLB doesn't have ([`NEXT`]); or where the
/// run ends ([`STOP`]: the steps ran out, or the next block is `compiled` or
/// due to report its dispatches). Nothing in it calls, so its state stays in
/// registers; `r` holds it between calls.
#[inline(never)]
pub fn hot<B: Fast>(
    c: &mut Cpu,
    m: &mut B,
    dec: &mut Cache,
    compiled: impl Fn(u64) -> bool,
    r: &mut Run,
) -> u32 {
    let (mut u, mut end, mut pc, mut key, mut bpc) = (r.u, r.end, r.pc, r.key, r.bpc);
    // The steps it may still enter blocks for (one value live, not two).
    let mut rest = r.left - r.done;
    let arena = dec.arena.as_ptr();
    let fx = m.ctx(c);
    let status = 'run: loop {
        // The block's prefix, to the PC after it.
        let next = 'block: loop {
            if u == end {
                break 'block pc;
            }
            // SAFETY: u < end, in the arena.
            let o = unsafe { &*u };
            let (d, n, w) = (o.d as u32, o.n as u32, o.w);
            match o.kind() {
                K::Generic | K::LdLit => break 'run SLOW,
                K::Lse => {
                    let base = rsp(c, n);
                    if n == 31 && base & 15 != 0 {
                        break 'run SLOW;
                    }
                    let sf = w >> 30 & 1 != 0;
                    let size = if sf { 8 } else { 4 };
                    let Some(p) = m.fast_in(fx, base, size, Use::Write) else {
                        break 'run SLOW;
                    };
                    if p as usize & (size as usize - 1) != 0 {
                        break 'run SLOW;
                    }
                    let v = rd(c, o.m as u32) & if sf { u64::MAX } else { u32::MAX as u64 };
                    let op = w >> 12 & 15;
                    // SAFETY: `fast_in` found `size` bytes of RAM at `p`, aligned (checked).
                    let old = match unsafe { mem::rmw(p, size, op, v) } {
                        Some(old) => old,
                        // Min and max: a CAS loop.
                        // SAFETY: as above.
                        None => unsafe {
                            const O: core::sync::atomic::Ordering =
                                core::sync::atomic::Ordering::SeqCst;
                            let f = |old| mem::lse(op, old, v, 8 * size);
                            if sf {
                                let a = core::sync::atomic::AtomicU64::from_ptr(p as *mut u64);
                                let mut old = a.load(O);
                                while let Err(seen) = a.compare_exchange(old, f(old), O, O) {
                                    old = seen;
                                }
                                old
                            } else {
                                let a = core::sync::atomic::AtomicU32::from_ptr(p as *mut u32);
                                let mut old = a.load(O) as u64;
                                while let Err(seen) =
                                    a.compare_exchange(old as u32, f(old) as u32, O, O)
                                {
                                    old = seen as u64;
                                }
                                old
                            }
                        },
                    };
                    wr(c, d, old);
                }
                K::Ldx => {
                    let base = rsp(c, n);
                    let size = 1u32 << (w >> 30);
                    if n == 31 && base & 15 != 0 || base & (size as u64 - 1) != 0 {
                        break 'run SLOW;
                    }
                    let Some(p) = m.fast_in(fx, base, size, Use::Read) else {
                        break 'run SLOW;
                    };
                    if p as usize & (size as usize - 1) != 0 {
                        break 'run SLOW;
                    }
                    // SAFETY: `fast_in` found `size` bytes of RAM at `p`, aligned (checked).
                    let v = unsafe { load_sc(p, size) };
                    if w >> 23 & 1 == 0 {
                        c.monitor = crate::cpu::Monitor {
                            addr: base,
                            size: size as u64,
                            val: [v, 0],
                        };
                    }
                    wr(c, d, v);
                }
                K::Stx => {
                    let base = rsp(c, n);
                    let size = 1u32 << (w >> 30);
                    if n == 31 && base & 15 != 0 || base & (size as u64 - 1) != 0 {
                        break 'run SLOW;
                    }
                    let mon = c.monitor;
                    let (excl, armed) = (
                        w >> 23 & 1 == 0,
                        mon.addr == base && mon.size == size as u64,
                    );
                    if !excl || armed {
                        let Some(p) = m.fast_in(fx, base, size, Use::Write) else {
                            break 'run SLOW;
                        };
                        if p as usize & (size as usize - 1) != 0 {
                            break 'run SLOW;
                        }
                        let v = rd(c, d);
                        // SAFETY: as for `Ldx`.
                        unsafe {
                            if excl {
                                let ok = cas_sc(p, size, mon.val[0], v);
                                c.monitor.size = 0;
                                wr(c, o.m as u32, !ok as u64);
                            } else {
                                store_sc(p, size, v);
                            }
                        }
                    } else {
                        // Not armed for it: fails, with no access.
                        c.monitor.size = 0;
                        wr(c, o.m as u32, 1);
                    }
                }
                K::Dmb => core::sync::atomic::fence(core::sync::atomic::Ordering::SeqCst),
                K::Zva => {
                    if c.el() == 0 && c.sctlr_el1 & sctlr::DZE == 0 {
                        break 'run SLOW;
                    }
                    let Some(p) = m.fast_in(fx, rd(c, d) & !63, 64, Use::Write) else {
                        break 'run SLOW;
                    };
                    if p as usize & 7 != 0 {
                        break 'run SLOW;
                    }
                    for k in 0..8 {
                        // SAFETY: `fast_in` found 64 bytes of RAM at `p`, aligned (checked).
                        unsafe { mem::store_aligned(p.add(8 * k), 8, 0) };
                    }
                }
                K::Fp => {
                    // FPEN, as `interp::fp_enabled`; then the SP's alignment.
                    let en = c.cpacr_el1 >> 20 & 3;
                    if en != 3 && !(en == 1 && c.el() == 1) {
                        break 'run SLOW;
                    }
                    let base = rsp(c, n);
                    if n == 31 && base & 15 != 0 {
                        break 'run SLOW;
                    }
                    // SAFETY: an Fp's `w` is its constant's distance.
                    let kv = unsafe { konst(u) };
                    let x = (kv >> 32) as u32 & 0xff;
                    let (log, mode) = (x & 7, x >> 3 & 3);
                    let off = ((kv as i64) >> 40) as u64;
                    let addr = if mode == 2 {
                        base
                    } else {
                        base.wrapping_add(off)
                    };
                    let (bytes, pair, load) = (1u32 << log, x >> 6 & 1 != 0, x >> 5 & 1 != 0);
                    let a2 = addr.wrapping_add(bytes as u64);
                    let w = if load { Use::Read } else { Use::Write };
                    let Some(p1) = m.fast_in(fx, addr, bytes, w) else {
                        break 'run SLOW;
                    };
                    let p2 = if pair {
                        match m.fast_in(fx, a2, bytes, w) {
                            Some(p) => p,
                            None => break 'run SLOW,
                        }
                    } else {
                        p1
                    };
                    // One access, or two of 8 bytes for a Q register, each aligned.
                    let a = (bytes as usize).min(8) - 1;
                    if (p1 as usize | p2 as usize) & a != 0 {
                        break 'run SLOW;
                    }
                    let (rt, rt2) = ((d & 31) as usize, (o.m & 31) as usize);
                    // SAFETY: `fast_in` found `bytes` bytes of RAM at each, aligned
                    // as each access needs (checked).
                    unsafe {
                        let ld = |p: *mut u8| -> u128 {
                            if bytes == 16 {
                                mem::load_aligned(p, 8).unwrap_or(0) as u128
                                    | (mem::load_aligned(p.add(8), 8).unwrap_or(0) as u128) << 64
                            } else {
                                mem::load_aligned(p, bytes).unwrap_or(0) as u128
                            }
                        };
                        let st = |p: *mut u8, v: u128| {
                            if bytes == 16 {
                                mem::store_aligned(p.add(8), 8, (v >> 64) as u64);
                                mem::store_aligned(p, 8, v as u64);
                            } else {
                                mem::store_aligned(p, bytes, v as u64);
                            }
                        };
                        if load {
                            let v1 = ld(p1);
                            let v2 = if pair { ld(p2) } else { 0 };
                            c.v[rt] = v1;
                            if pair {
                                c.v[rt2] = v2;
                            }
                        } else {
                            st(p1, c.v[rt]);
                            if pair {
                                st(p2, c.v[rt2]);
                            }
                        }
                    }
                    if mode != 0 {
                        wsp(c, n, base.wrapping_add(off));
                    }
                }
                K::Mrs => {
                    let imm = if matches!(n, 0 | 3 | 4) {
                        w as u64
                    } else {
                        // SAFETY: its `w` is its constant's distance.
                        unsafe { konst(u) }
                    };
                    if n == 4 && c.pstate & 1 == 0 {
                        break 'run SLOW;
                    }
                    wr(c, d, mrs(c, n, imm))
                }
                K::Msr => {
                    let (rt, a) = (d & 31, n | (o.m as u32) << 8);
                    let v = rd(c, rt);
                    match d >> 5 {
                        // SAFETY: `a` is the offset of a u64 field of `Cpu` (`sys::plain_write`).
                        0 => unsafe {
                            (c as *mut Cpu as *mut u8)
                                .add(a as usize % (core::mem::size_of::<Cpu>() - 7))
                                .cast::<u64>()
                                .write_unaligned(v)
                        },
                        1 => {
                            if c.pstate & 1 == 0 {
                                break 'run SLOW;
                            }
                            c.sp_other = v;
                        }
                        2 => {
                            let p = c.pstate & !crate::cpu::DAIF | v & crate::cpu::DAIF;
                            // Unmasking IRQs leaves (`Exit::Resync`): the interpreter's.
                            if c.pstate & !p & crate::cpu::PSTATE_I != 0 {
                                break 'run SLOW;
                            }
                            c.pstate = p;
                        }
                        _ => c.pstate |= a as u64,
                    }
                }
                K::Maddl => wr(c, d, maddl(w, rd(c, n), rd(c, o.m as u32), rd(c, w & 31))),
                K::Extr => wr(c, d, extr(w, rd(c, n), rd(c, o.m as u32))),
                K::Bit1 => wr(c, d, bit1(w, rd(c, n))),
                K::Adc => {
                    let v = adc(c, w, rd(c, n), rd(c, o.m as u32));
                    wr(c, d, v)
                }
                K::Div => wr(c, d, div(w, rd(c, n), rd(c, o.m as u32))),
                K::Mulh => wr(c, d, mulh(w, rd(c, n), rd(c, o.m as u32))),
                K::Bfm => wr(c, d, bfm(o.m as u32, w, rd(c, d), rd(c, n))),
                K::Cas => {
                    let base = rsp(c, n);
                    let size = 1u32 << (w >> 30);
                    if n == 31 && base & 15 != 0 || base & (size as u64 - 1) != 0 {
                        break 'run SLOW;
                    }
                    let Some(p) = m.fast_in(fx, base, size, Use::Write) else {
                        break 'run SLOW;
                    };
                    if p as usize & (size as usize - 1) != 0 {
                        break 'run SLOW;
                    }
                    let mask = u64::MAX >> (64 - 8 * size);
                    let (rs, rt) = (o.m as u32, d);
                    let (old, new) = (rd(c, rs) & mask, rd(c, rt) & mask);
                    // SAFETY: `fast_in` found `size` bytes of RAM at `p`, aligned (checked).
                    let seen = unsafe { cas_old(p, size, old, new) };
                    wr(c, rs, seen);
                }
                K::Nop => {}
                K::AddI64 => wsp(c, d, rsp(c, n).wrapping_add(w as i32 as i64 as u64)),
                K::AddI32 => wsp(
                    c,
                    d,
                    rsp(c, n).wrapping_add(w as i32 as i64 as u64) as u32 as u64,
                ),
                K::AddsI => {
                    let (x, imm) = (o.m as u32, w as i32 as i64 as u64);
                    let (v, f) = add_with_carry(rsp(c, n), imm, x & 2 != 0, x & 1 != 0);
                    c.nzcv = f;
                    wr(c, d, v);
                    if x & 4 != 0 {
                        and_bcond!('block, u, end, pc, f);
                    }
                }
                K::AddR => {
                    let sf = w >> 8 & 1 != 0;
                    let y = shift(rd(c, o.m as u32), w & 3, w >> 2 & 63, sf);
                    addsub_h(c, w, d, rd(c, n), y, sf, false);
                    if w & 1 << 11 != 0 {
                        and_bcond!('block, u, end, pc, c.nzcv);
                    }
                }
                K::AddX => {
                    let sf = w >> 8 & 1 != 0;
                    let y = extend(rd(c, o.m as u32), w & 7, w >> 3 & 7);
                    addsub_h(c, w, d, rsp(c, n), y, sf, true);
                }
                K::MovI => {
                    // SAFETY: a MovI's `w` is its constant's distance if `m` says so.
                    wsp(c, d, unsafe { movi(u) });
                    // SAFETY: u < end, both in the block's micro-ops.
                    let k = (n as usize).min(unsafe { end.offset_from(u) } as usize - 1);
                    for j in 1..=k {
                        // SAFETY: u + j < end, a MovI.
                        unsafe { wsp(c, (*u.add(j)).d as u32, movi(u.add(j))) };
                    }
                    // SAFETY: as above.
                    u = unsafe { u.add(k) };
                    pc = pc.wrapping_add(4 * k as u64);
                }
                K::Movk => {
                    let sh = o.m & 63;
                    let v = (rd(c, d) & !(0xffff << sh)) | (w as u64) << sh;
                    wr(c, d, trunc(v, n & 1 != 0));
                }
                K::Mov => wsp(c, d, trunc(rd(c, o.m as u32), w & 1 != 0)),
                K::LogI => {
                    let x = o.m as u32;
                    let opc = x & 3;
                    // SAFETY: a LogI's `w` is its constant's distance.
                    let imm = unsafe { konst(u) };
                    logical_h(c, opc, d, op(opc, rd(c, n), imm), x & 4 != 0, true);
                    if x & 8 != 0 {
                        and_bcond!('block, u, end, pc, c.nzcv);
                    }
                }
                K::LogR => {
                    let sf = w >> 11 & 1 != 0;
                    let y = shift(rd(c, o.m as u32), w & 3, w >> 2 & 63, sf);
                    let y = if w >> 10 & 1 != 0 { !y } else { y };
                    let opc = w >> 8 & 3;
                    logical_h(c, opc, d, op(opc, rd(c, n), y), sf, false);
                    if w & 1 << 12 != 0 {
                        and_bcond!('block, u, end, pc, c.nzcv);
                    }
                }
                K::Ubfm => {
                    let sf = w & 1 != 0;
                    wr(
                        c,
                        d,
                        ror(trunc(rd(c, n), sf), o.m as u32 & 63, sf) & ubfm_mask(w),
                    )
                }
                K::Sbfm => {
                    let (rr, s, sf) = (o.m as u32 & 63, w & 63, w >> 8 & 1 != 0);
                    let src = rd(c, n);
                    let v = if s >= rr {
                        sext(src >> rr, s - rr + 1)
                    } else {
                        sext(src, s + 1) << ((if sf { 64 } else { 32 } - rr) & 63)
                    };
                    wr(c, d, trunc(v, sf));
                }
                K::ShiftV => {
                    let sf = w & 4 != 0;
                    let amt = (rd(c, o.m as u32) & if sf { 63 } else { 31 }) as u32;
                    wr(c, d, shift(rd(c, n), w & 3, amt, sf));
                }
                K::Csel => {
                    let v = if holds(w >> 16, c.nzcv) {
                        rd(c, n)
                    } else {
                        let y = rd(c, o.m as u32);
                        match w >> 4 & 3 {
                            0 => y,
                            1 => y.wrapping_add(1),
                            2 => !y,
                            _ => y.wrapping_neg(),
                        }
                    };
                    wr(c, d, trunc(v, w >> 6 & 1 != 0));
                }
                K::Ccmp => {
                    c.nzcv = if holds(w >> 16, c.nzcv) {
                        let y = if w >> 4 & 1 != 0 {
                            o.m as u64
                        } else {
                            rd(c, o.m as u32)
                        };
                        let sub = w >> 5 & 1 != 0;
                        let y = if sub { !y } else { y };
                        add_with_carry(rd(c, n), y, sub, w >> 6 & 1 != 0).1
                    } else {
                        ((w >> 8 & 15) as u64) << 28
                    };
                }
                K::Madd => {
                    let p = rd(c, n).wrapping_mul(rd(c, o.m as u32));
                    let a = rd(c, w & 31);
                    let v = if w >> 5 & 1 != 0 {
                        a.wrapping_sub(p)
                    } else {
                        a.wrapping_add(p)
                    };
                    wr(c, d, trunc(v, w >> 6 & 1 != 0));
                }
                K::Adr => wr(c, d, pc.wrapping_add(w as i32 as i64 as u64)),
                K::Adrp => wr(
                    c,
                    d,
                    (pc & !0xfff).wrapping_add((w as i32 as i64 as u64) << 12),
                ),
                // Branches end their block.
                K::B => break 'block pc.wrapping_add(w as i32 as i64 as u64),
                K::Bl => {
                    c.x[30] = pc.wrapping_add(4);
                    break 'block pc.wrapping_add(w as i32 as i64 as u64);
                }
                // SAFETY (the three): `u` is the micro-op.
                K::Bcond => {
                    let t = holds(n | (o.m as u32) << 8, c.nzcv);
                    break 'block pc.wrapping_add(if t { unsafe { taken_imm(u) } } else { 4 });
                }
                K::Cbz => {
                    let x = o.m;
                    let t = (trunc(rd(c, d), x & 1 != 0) != 0) == (x & 2 != 0);
                    break 'block pc.wrapping_add(if t { unsafe { taken_imm(u) } } else { 4 });
                }
                K::Tbz => {
                    let t = (rd(c, d) >> (o.m & 63) & 1 != 0) == (n != 0);
                    break 'block pc.wrapping_add(if t { unsafe { taken_imm(u) } } else { 4 });
                }
                K::Br => break 'block rd(c, n),
                K::Blr => {
                    let to = rd(c, n);
                    c.x[30] = pc.wrapping_add(4);
                    break 'block to;
                }
                K::LdO | K::StO => {
                    if !single_h(c, m, fx, o) {
                        break 'run SLOW;
                    }
                    // Its pair, if in the prefix.
                    // SAFETY: u < end.
                    if w & 0x8000 != 0 && unsafe { u.add(1) } != end {
                        // SAFETY: u + 1 < end.
                        u = unsafe { u.add(1) };
                        pc = pc.wrapping_add(4);
                        // SAFETY: as above.
                        if !single_h(c, m, fx, unsafe { &*u }) {
                            break 'run SLOW;
                        }
                    }
                }
                K::Ld | K::St => {
                    let base = rsp(c, n);
                    if n == 31 && base & 15 != 0 {
                        break 'run SLOW;
                    }
                    let imm = (w as i32 >> 16) as i64 as u64;
                    let (addr, wb) = match w >> 2 & 3 {
                        0 => (base.wrapping_add(imm), None),
                        1 => {
                            let a = base.wrapping_add(imm);
                            (a, Some(a))
                        }
                        2 => (base, Some(base.wrapping_add(imm))),
                        _ => {
                            let off = extend(rd(c, o.m as u32), w >> 8 & 7, w >> 12 & 7);
                            (base.wrapping_add(off), None)
                        }
                    };
                    let bytes = 1 << (w & 3);
                    if o.k == K::St as u8 {
                        let Some(p) = m.fast_in(fx, addr, bytes, Use::Write) else {
                            break 'run SLOW;
                        };
                        // SAFETY: `fast_in` found `bytes` bytes of RAM at `p`.
                        if !unsafe { mem::store_aligned(p, bytes, rd(c, d)) } {
                            break 'run SLOW;
                        }
                    } else {
                        let Some(p) = m.fast_in(fx, addr, bytes, Use::Read) else {
                            break 'run SLOW;
                        };
                        // SAFETY: as for the store.
                        let Some(v) = (unsafe { mem::load_aligned(p, bytes) }) else {
                            break 'run SLOW;
                        };
                        let v = match w >> 4 & 3 {
                            0 => v,
                            1 => sext(v, 8 * bytes),
                            _ => sext(v, 8 * bytes) as u32 as u64,
                        };
                        wr(c, d, v);
                    }
                    if let Some(wb) = wb {
                        wsp(c, n, wb);
                    }
                }
                K::Ldp | K::Stp => {
                    if !pair_h(c, m, fx, o) {
                        break 'run SLOW;
                    }
                }
            }
            // SAFETY: u < end.
            u = unsafe { u.add(1) };
            pc = pc.wrapping_add(4);
        };
        // The block's prefix ran: on to the next, as `jit::interpret` goes.
        (pc, u) = (next, end);
        if rest == 0 {
            break 'run STOP;
        }
        let k = if (next ^ bpc) < 0x1000 && next & 3 == 0 {
            key & !0xfff | next & 0xffc | key & 3
        } else if next & 3 == 0
            && let Some(k) = m.ikey(c, next)
        {
            k
        } else {
            break 'run NEXT;
        };
        if compiled(k) {
            break 'run STOP;
        }
        let s = &mut dec.slots[slot(k)];
        if s.key != k {
            break 'run NEXT;
        }
        if s.hits >= s.quota as u16 {
            break 'run STOP;
        }
        s.hits += 1;
        let n = (s.len as u64).min(rest);
        // SAFETY: a slotted block's micro-ops are in the arena.
        u = unsafe { arena.add(s.start as usize) };
        // SAFETY: n <= its length.
        end = unsafe { u.add(n as usize) };
        rest -= n;
        (key, bpc) = (k, next);
    };
    (r.u, r.end, r.pc, r.key, r.bpc, r.done) = (u, end, pc, key, bpc, r.left - rest);
    if status != SLOW {
        c.pc = pc;
    }
    status
}

/// [`run`] through [`hot`], as `jit::interpret` drives it, for the first `n`
/// micro-ops of `all` (a block [`pack`]ed at 0: its constants after it; the tests).
#[cfg(test)]
pub fn run_hot(
    c: &mut Cpu,
    m: &mut impl Fast,
    all: &[Uop],
    n: usize,
    pc: u64,
) -> (u64, Option<Exit>) {
    let mut dec = Cache::new(1 << 10);
    dec.arena = all.to_vec();
    let mut r = Run::new(n as u64);
    r.enter(&dec.arena[..n], 0, pc);
    loop {
        if hot(c, m, &mut dec, |_| false, &mut r) != SLOW {
            return (r.done, None);
        }
        let (n, _, last) = r.stretch();
        let before = r.retired();
        let (k, e) = run(c, m, &dec.arena[r.at(&dec.arena)..], n, r.pc);
        if e.is_some() {
            return (before + k, e);
        }
        if last {
            return (r.done, None);
        }
        r.step(n);
    }
}

/// A sequentially consistent load of `size` bytes (1, 2, 4 or 8) at `p`,
/// as `mem::load_atomic` without its panic for another size.
///
/// # Safety
/// `p` is `size` bytes of RAM, aligned to `size`.
#[inline(always)]
unsafe fn load_sc(p: *mut u8, size: u32) -> u64 {
    use core::sync::atomic::{AtomicU8, AtomicU16, AtomicU32, AtomicU64, Ordering::SeqCst};
    // SAFETY: guaranteed by the caller.
    unsafe {
        match size {
            1 => AtomicU8::from_ptr(p).load(SeqCst) as u64,
            2 => AtomicU16::from_ptr(p as *mut u16).load(SeqCst) as u64,
            4 => AtomicU32::from_ptr(p as *mut u32).load(SeqCst) as u64,
            _ => AtomicU64::from_ptr(p as *mut u64).load(SeqCst),
        }
    }
}

/// [`load_sc`]'s store.
///
/// # Safety
/// As for [`load_sc`].
#[inline(always)]
unsafe fn store_sc(p: *mut u8, size: u32, v: u64) {
    use core::sync::atomic::{AtomicU8, AtomicU16, AtomicU32, AtomicU64, Ordering::SeqCst};
    // SAFETY: guaranteed by the caller.
    unsafe {
        match size {
            1 => AtomicU8::from_ptr(p).store(v as u8, SeqCst),
            2 => AtomicU16::from_ptr(p as *mut u16).store(v as u16, SeqCst),
            4 => AtomicU32::from_ptr(p as *mut u32).store(v as u32, SeqCst),
            _ => AtomicU64::from_ptr(p as *mut u64).store(v, SeqCst),
        }
    }
}

/// [`load_sc`]'s compare-and-swap of `size` bytes: whether `p` held `old`
/// (then it holds `new`).
///
/// # Safety
/// As for [`load_sc`].
#[inline(always)]
unsafe fn cas_sc(p: *mut u8, size: u32, old: u64, new: u64) -> bool {
    use core::sync::atomic::{AtomicU8, AtomicU16, AtomicU32, AtomicU64, Ordering::SeqCst};
    // SAFETY: guaranteed by the caller.
    unsafe {
        match size {
            1 => AtomicU8::from_ptr(p)
                .compare_exchange(old as u8, new as u8, SeqCst, SeqCst)
                .is_ok(),
            2 => AtomicU16::from_ptr(p as *mut u16)
                .compare_exchange(old as u16, new as u16, SeqCst, SeqCst)
                .is_ok(),
            4 => AtomicU32::from_ptr(p as *mut u32)
                .compare_exchange(old as u32, new as u32, SeqCst, SeqCst)
                .is_ok(),
            _ => AtomicU64::from_ptr(p as *mut u64)
                .compare_exchange(old, new, SeqCst, SeqCst)
                .is_ok(),
        }
    }
}

/// [`cas_sc`] that returns the value it found (`old` if it swapped).
///
/// # Safety
/// As for [`load_sc`].
#[inline(always)]
unsafe fn cas_old(p: *mut u8, size: u32, old: u64, new: u64) -> u64 {
    use core::sync::atomic::{AtomicU8, AtomicU16, AtomicU32, AtomicU64, Ordering::SeqCst};
    // SAFETY: guaranteed by the caller.
    unsafe {
        match size {
            1 => match AtomicU8::from_ptr(p).compare_exchange(old as u8, new as u8, SeqCst, SeqCst)
            {
                Ok(v) | Err(v) => v as u64,
            },
            2 => match AtomicU16::from_ptr(p as *mut u16)
                .compare_exchange(old as u16, new as u16, SeqCst, SeqCst)
            {
                Ok(v) | Err(v) => v as u64,
            },
            4 => match AtomicU32::from_ptr(p as *mut u32)
                .compare_exchange(old as u32, new as u32, SeqCst, SeqCst)
            {
                Ok(v) | Err(v) => v as u64,
            },
            _ => {
                match AtomicU64::from_ptr(p as *mut u64).compare_exchange(old, new, SeqCst, SeqCst)
                {
                    Ok(v) | Err(v) => v,
                }
            }
        }
    }
}

/// An LdO or StO on [`hot`]'s inline paths; false (and nothing done) where
/// it needs the slow path.
#[inline(always)]
fn single_h<B: Fast>(c: &mut Cpu, m: &mut B, fx: B::Ctx, o: &Uop) -> bool {
    let (d, n) = (o.d as u32, o.n as u32);
    let base = rsp(c, n);
    if n == 31 && base & 15 != 0 {
        return false;
    }
    let addr = base.wrapping_add((o.w as i32 >> 16) as i64 as u64);
    let bytes = 4 << (o.w & 1);
    if o.k == K::StO as u8 {
        let Some(p) = m.fast_in(fx, addr, bytes, Use::Write) else {
            return false;
        };
        // SAFETY: `fast_in` found `bytes` bytes of RAM at `p`.
        unsafe { mem::store_aligned(p, bytes, rd(c, d)) }
    } else {
        let Some(p) = m.fast_in(fx, addr, bytes, Use::Read) else {
            return false;
        };
        // SAFETY: as for the store.
        let Some(v) = (unsafe { mem::load_aligned(p, bytes) }) else {
            return false;
        };
        wr(c, d, v);
        true
    }
}

/// An LDP or STP (`K::Ldp`, `K::Stp`) on [`hot`]'s inline paths; false (and
/// nothing done) where it needs the slow path.
#[inline(always)]
fn pair_h<B: Fast>(c: &mut Cpu, m: &mut B, fx: B::Ctx, o: &Uop) -> bool {
    let (d, n) = (o.d as u32, o.n as u32);
    let base = rsp(c, n);
    if n == 31 && base & 15 != 0 {
        return false;
    }
    let (size, mode) = (o.w & 15, o.w >> 8 & 3);
    let imm = (o.w as i32 >> 16) as i64 as u64;
    let addr = if mode == 1 {
        base
    } else {
        base.wrapping_add(imm)
    };
    let a2 = addr.wrapping_add(size as u64);
    let (rt, rt2) = (d, o.m as u32);
    let ldp = o.k == K::Ldp as u8;
    let w = if ldp { Use::Read } else { Use::Write };
    let (Some(p1), Some(p2)) = (m.fast_in(fx, addr, size, w), m.fast_in(fx, a2, size, w)) else {
        return false;
    };
    if (p1 as usize | p2 as usize) & (size as usize - 1) != 0 {
        return false;
    }
    if ldp {
        // SAFETY: `fast_in` found RAM at both, aligned (checked).
        let (v1, v2) = unsafe {
            (
                mem::load_aligned(p1, size).unwrap_or(0),
                mem::load_aligned(p2, size).unwrap_or(0),
            )
        };
        let ext = |v: u64| if o.w & 16 != 0 { v as i32 as u64 } else { v };
        wr(c, rt, ext(v1));
        wr(c, rt2, ext(v2));
    } else {
        let (v1, v2) = (rd(c, rt), rd(c, rt2));
        // SAFETY: as for the loads.
        unsafe {
            mem::store_aligned(p1, size, v1);
            mem::store_aligned(p2, size, v2);
        }
    }
    if mode & 1 == 1 {
        wsp(c, n, base.wrapping_add(imm));
    }
    true
}

/// [`addsub`] through the inline register accessors.
#[inline(always)]
fn addsub_h(c: &mut Cpu, f: u32, d: u32, x: u64, y: u64, sf: bool, sp_dest: bool) {
    let (sub, s) = (f >> 10 & 1 != 0, f >> 9 & 1 != 0);
    let (r, fl) = add_with_carry(x, if sub { !y } else { y }, sub, sf);
    if s {
        c.nzcv = fl;
        wr(c, d, r);
    } else if sp_dest {
        wsp(c, d, r);
    } else {
        wr(c, d, r);
    }
}

/// [`logical`] through the inline register accessors.
#[inline(always)]
fn logical_h(c: &mut Cpu, opc: u32, d: u32, r: u64, sf: bool, sp_dest: bool) {
    let r = trunc(r, sf);
    if opc == 3 {
        let n = r >> (if sf { 63 } else { 31 }) & 1 == 1;
        c.nzcv = super::nzcv(n, r == 0, false, false);
        wr(c, d, r);
    } else if sp_dest {
        wsp(c, d, r);
    } else {
        wr(c, d, r);
    }
}

/// UMADDL & co (`K::Maddl`): `f` its `x`.
#[inline(always)]
fn maddl(f: u32, n: u64, m: u64, a: u64) -> u64 {
    let (x, y) = if f >> 6 & 1 != 0 {
        (n as i32 as u64, m as i32 as u64)
    } else {
        (n as u32 as u64, m as u32 as u64)
    };
    let p = x.wrapping_mul(y);
    if f >> 5 & 1 != 0 {
        a.wrapping_sub(p)
    } else {
        a.wrapping_add(p)
    }
}

/// EXTR (`K::Extr`) of `hi:lo`, `f` its `x` (no u128: compiler-rt's shifts are calls).
#[inline(always)]
fn extr(f: u32, hi: u64, lo: u64) -> u64 {
    let lsb = f & 63;
    if f >> 8 & 1 != 0 {
        if lsb == 0 {
            lo
        } else {
            lo >> lsb | hi << (64 - lsb)
        }
    } else {
        ((hi as u32 as u64) << 32 | lo as u32 as u64) >> lsb & 0xffff_ffff
    }
}

/// RBIT, REV16, REV32, REV, CLZ (`K::Bit1`), `f` its `x`.
#[inline(always)]
fn bit1(f: u32, x: u64) -> u64 {
    let sf = f >> 8 & 1 != 0;
    match f & 7 {
        0 if sf => x.reverse_bits(),
        0 => (x as u32).reverse_bits() as u64,
        1 => {
            let m8 = 0x00ff_00ff_00ff_00ff;
            trunc(((x & m8) << 8) | ((x >> 8) & m8), sf)
        }
        2 => (x as u32).swap_bytes() as u64 | (((x >> 32) as u32).swap_bytes() as u64) << 32,
        3 if sf => x.swap_bytes(),
        3 => (x as u32).swap_bytes() as u64,
        _ if sf => x.leading_zeros() as u64,
        _ => (x as u32).leading_zeros() as u64,
    }
}

/// ADC & co (`K::Adc`, `f` its `x`) of `x` and `y`: the result (the flags set if S).
#[inline(always)]
fn adc(c: &mut Cpu, f: u32, x: u64, y: u64) -> u64 {
    let y = if f & 4 != 0 { !y } else { y };
    let (r, fl) = add_with_carry(x, y, c.nzcv >> 29 & 1 != 0, f & 1 != 0);
    if f & 2 != 0 {
        c.nzcv = fl;
    }
    r
}

/// UDIV/SDIV (`K::Div`, `f` its `x`): 0 for a divisor of 0.
#[inline(always)]
fn div(f: u32, x: u64, y: u64) -> u64 {
    let sf = f & 1 != 0;
    let (x, y) = (trunc(x, sf), trunc(y, sf));
    match (f >> 1 & 1 != 0, sf) {
        _ if y == 0 => 0,
        (false, _) => x / y,
        (true, true) => (x as i64).wrapping_div(y as i64) as u64,
        (true, false) => (x as u32 as i32).wrapping_div(y as u32 as i32) as u32 as u64,
    }
}

/// UMULH/SMULH (`K::Mulh`, `f` its `x`), in 32-bit halves (a u128 product is
/// a call to compiler-rt in wasm).
#[inline(always)]
fn mulh(f: u32, x: u64, y: u64) -> u64 {
    let (x0, x1, y0, y1) = (x & 0xffff_ffff, x >> 32, y & 0xffff_ffff, y >> 32);
    let (p00, p01, p10) = (x0 * y0, x0 * y1, x1 * y0);
    let mid = (p00 >> 32) + (p01 & 0xffff_ffff) + (p10 & 0xffff_ffff);
    let hi = (x1 * y1)
        .wrapping_add(p01 >> 32)
        .wrapping_add(p10 >> 32)
        .wrapping_add(mid >> 32);
    if f & 1 == 0 {
        hi
    } else {
        // Signed: less the other operand for each negative one.
        hi.wrapping_sub(if (x as i64) < 0 { y } else { 0 })
            .wrapping_sub(if (y as i64) < 0 { x } else { 0 })
    }
}

/// BFM (`K::Bfm`): `r` immr, `f` its `x`, into `dst` from `src` (the masks
/// `bit_masks` makes, over the datasize: the result is truncated to it).
#[inline(always)]
fn bfm(r: u32, f: u32, dst: u64, src: u64) -> u64 {
    let (r, s, sf) = (r & 63, f & 63, f >> 8 & 1 != 0);
    let ones = |k: u32| if k >= 64 { u64::MAX } else { (1u64 << k) - 1 };
    let wmask = ror(ones(s + 1), r, sf);
    let tmask = ones((s.wrapping_sub(r) & if sf { 63 } else { 31 }) + 1);
    let bot = ror(trunc(src, sf), r, sf) & wmask;
    trunc((dst & !tmask) | (((dst & !wmask) | bot) & tmask), sf)
}

/// A branch (always a block's last instruction) to `to`.
#[inline(always)]
fn taken(c: &mut Cpu, n: usize, to: u64) -> (u64, Option<Exit>) {
    c.pc = to;
    (n as u64, None)
}

/// AND, ORR, EOR, AND by `opc`.
#[inline(always)]
fn op(opc: u32, x: u64, y: u64) -> u64 {
    match opc {
        1 => x | y,
        2 => x ^ y,
        _ => x & y,
    }
}

/// The result `r` of a logical operation (`opc` 3 sets the flags; without,
/// Rd 31 is SP if `sp_dest`).
#[inline(always)]
fn logical(c: &mut Cpu, opc: u32, d: u32, r: u64, sf: bool, sp_dest: bool) {
    let r = trunc(r, sf);
    if opc == 3 {
        let n = r >> (if sf { 63 } else { 31 }) & 1 == 1;
        c.nzcv = super::nzcv(n, r == 0, false, false);
        c.set_reg(d, r);
    } else if sp_dest {
        c.x[d as usize] = r;
    } else {
        c.set_reg(d, r);
    }
}

/// ADD/SUB(S) of `x` and `y` (`f` as [`uop`] packs it: S in bit 9, sub in
/// bit 10).
#[inline(always)]
fn addsub(c: &mut Cpu, f: u32, d: u32, x: u64, y: u64, sf: bool, sp_dest: bool) {
    let (sub, s) = (f >> 10 & 1 != 0, f >> 9 & 1 != 0);
    let (r, fl) = add_with_carry(x, if sub { !y } else { y }, sub, sf);
    if s {
        c.nzcv = fl;
        c.set_reg(d, r);
    } else if sp_dest {
        c.x[d as usize] = r;
    } else {
        c.set_reg(d, r);
    }
}

/// A load through the bus's fast path ([`Bus::fast`]), else its `read`.
#[inline(always)]
fn load(c: &Cpu, m: &mut impl Bus, va: u64, size: u32) -> Result<u64, crate::mem::Fault> {
    match m.fast(c, va, size, Use::Read) {
        // SAFETY: `fast` found `size` bytes of RAM at `p`.
        Some(p) => Ok(unsafe { mem::load(p, size) }),
        None => m.read(c, va, size),
    }
}

/// A store through the bus's fast path, else its `write`.
#[inline(always)]
fn store(c: &Cpu, m: &mut impl Bus, va: u64, size: u32, v: u64) -> Result<(), crate::mem::Fault> {
    match m.fast(c, va, size, Use::Write) {
        Some(p) => {
            // SAFETY: as in `load`.
            unsafe { mem::store(p, size, v) };
            Ok(())
        }
        None => m.write(c, va, size, v),
    }
}

/// A single-register load or store (`K::Ld`, `K::St`), as `ldst::single`.
#[inline(always)]
fn single(c: &mut Cpu, m: &mut impl Bus, u: &Wide) -> R {
    let base = base_reg(c, u.n as u32)?;
    let (size, mode) = (u.x & 3, u.x >> 2 & 3);
    let (addr, wb) = match mode {
        0 => (base.wrapping_add(u.imm), None),
        1 => {
            let a = base.wrapping_add(u.imm);
            (a, Some(a))
        }
        2 => (base, Some(base.wrapping_add(u.imm))),
        _ => {
            let off = extend(c.reg(u.m as u32), u.x >> 8 & 7, u.x >> 12 & 7);
            (base.wrapping_add(off), None)
        }
    };
    let bytes = 1 << size;
    if matches!(u.k, K::St | K::StO) {
        store(c, m, addr, bytes, c.reg(u.d as u32))?;
    } else {
        let v = load(c, m, addr, bytes)?;
        let v = match u.x >> 4 & 3 {
            0 => v,
            1 => sext(v, 8 * bytes),
            _ => sext(v, 8 * bytes) as u32 as u64,
        };
        c.set_reg(u.d as u32, v);
    }
    if let Some(wb) = wb {
        c.x[u.n as usize] = wb;
    }
    Ok(())
}

/// LDP/STP and the non-temporal pairs, as `ldst::exec`.
#[inline(always)]
fn pair(c: &mut Cpu, m: &mut impl Bus, u: &Wide) -> R {
    let base = base_reg(c, u.n as u32)?;
    let (size, mode) = (u.x & 15, u.x >> 8 & 3);
    let addr = if mode == 1 {
        base
    } else {
        base.wrapping_add(u.imm)
    };
    let a2 = addr.wrapping_add(size as u64);
    let (rt, rt2) = (u.d as u32, u.m as u32);
    if u.k == K::Ldp {
        let (v1, v2) = (load(c, m, addr, size)?, load(c, m, a2, size)?);
        let ext = |v: u64| if u.x & 16 != 0 { v as i32 as u64 } else { v };
        c.set_reg(rt, ext(v1));
        c.set_reg(rt2, ext(v2));
    } else {
        store(c, m, addr, size, c.reg(rt))?;
        store(c, m, a2, size, c.reg(rt2))?;
    }
    if mode & 1 == 1 {
        c.x[u.n as usize] = base.wrapping_add(u.imm);
    }
    Ok(())
}

/// Micro-ops the tables' caches of a VM hold in all (8 bytes each, and their
/// blocks' constants: 128 MiB),
/// shared out among them up to [`MAX_BUDGET`] a table: each starts over when
/// its share is full (`jit::Config::decoded`). 2M micro-ops a table, four
/// tables re-decoded ~3.5M blocks a Chromium render; 4M made the warm renders
/// 5–7% faster; 8M ran the core's 1 GiB heap out on 4 tables
/// (bench/apps/REPORT.md).
pub const BUDGET: usize = 1 << 24;
pub const MAX_BUDGET: usize = 1 << 23;

/// A table's share of [`BUDGET`] among `tables`.
pub fn budget(tables: usize) -> usize {
    (BUDGET / tables.max(1)).min(MAX_BUDGET)
}
/// Direct-mapped entries in front of the map.
const SLOTS: usize = 16384;

/// Micro-ops of a table's budget per key its map holds before it starts
/// over, at most [`MAX_KEYS`]: blocks of one micro-op (or none: an SVC at a
/// block's start, kept with length 0) would fill the map long before the
/// arena, at 17 B a bucket of it (and 17 a page of the page index).
pub const KEY_UOPS: usize = 4;

/// The keys a table's map holds at most (and it starts over when it would
/// double past the table that holds them, `jit::grows_past`: an IC's
/// tombstones fill it): under the
/// 917,504 that 2^20 buckets hold (17 MiB), so it never doubles past them.
pub const MAX_KEYS: usize = 900_000;

/// Dispatches a decoded block counts, at most, before the dispatcher reports
/// them to the JIT's cache (a lock and a map lookup: `jit::Cache::miss`),
/// which compiles the block once they reach its threshold (the dispatch that
/// reaches it reports: [`Cache::quota`]).
pub const REPORT: u32 = 16;

/// [`REPORT`] for a cache that never compiles (no JIT, or `VmConfig.jit` 4):
/// as many as a slot's quota holds. Only there: in the JIT, counts reported
/// later than every 16 delay the batches and shrink the regions (forward
/// regions take members by the counts the cache has seen: Alpine's boot
/// interpreted 2.5× the steps with 255; bench/interp/REPORT.md "M8-INTERP loop 2").
pub const REPORT_IDLE: u32 = 255;

#[derive(Clone, Copy)]
struct Slot {
    key: u64,
    start: u32,
    len: u8,
    /// The dispatches it may count before it reports ([`Cache::quota`]),
    /// and the ones it counted since it last reported.
    quota: u8,
    hits: u16,
}

/// A decoded block in [`Cache`]'s map: where its micro-ops are (start << 6 |
/// length), the dispatches it counted and the quota it had while out of the
/// slots (one put back counts on: a report takes the JIT cache's lock), and
/// the next key of its page by its low 12 bits ([`Cache`]'s `pages`; its own
/// at the list's end).
#[derive(Clone, Copy)]
struct Known {
    at: u32,
    next: u16,
    hits: u8,
    quota: u8,
}

impl Known {
    fn new(start: u32, len: u32, next: u16) -> Known {
        debug_assert!(start < 1 << 26 && len < 64);
        Known {
            at: start << 6 | len,
            next,
            hits: 0,
            quota: 0,
        }
    }

    fn start(&self) -> u32 {
        self.at >> 6
    }

    fn len(&self) -> u32 {
        self.at & 63
    }
}

const EMPTY: Slot = Slot {
    key: u64::MAX,
    start: 0,
    len: 0,
    quota: 0,
    hits: 0,
};

/// A table's decoded blocks, by JIT block key (`jit::Table`): a direct-mapped
/// front, a map of every block, and the micro-ops in one arena. A dropped
/// block's micro-ops stay in the arena until it's full, and then everything
/// starts over.
pub struct Cache {
    slots: Box<[Slot; SLOTS]>,
    /// The slots filled since the last clear (up to `SLOTS / 16`; past it,
    /// all of them are cleared): JIT-stress flushes every few compiles.
    used: Vec<u32>,
    /// Every block. A key with no instructions is kept too, with length 0
    /// (never a block to run).
    map: HashMap<u64, Known, crate::jit::KeyBuild>,
    /// The keys in `map` by physical page, for `IC IVAU`: the low 12 bits
    /// of the page's last key inserted, the head of its list through
    /// [`Known::next`].
    pages: HashMap<u64, u16, crate::jit::KeyBuild>,
    arena: Vec<Uop>,
    /// The micro-ops it holds before it starts over, and the keys
    /// ([`KEY_UOPS`]).
    budget: usize,
    keys: usize,
    /// Blocks decoded, times the cache started over, and times it freed
    /// its memory because the heap had no room for it to grow (`jit::Stats`).
    pub decoded: u64,
    pub clears: u64,
    pub rescues: u64,
}

#[inline(always)]
fn slot(key: u64) -> usize {
    (key >> 2) as usize & (SLOTS - 1)
}

impl Cache {
    /// A cache of `budget` micro-ops.
    pub fn new(budget: usize) -> Cache {
        Cache {
            slots: match vec![EMPTY; SLOTS].into_boxed_slice().try_into() {
                Ok(s) => s,
                Err(_) => unreachable!(),
            },
            used: Vec::new(),
            map: HashMap::default(),
            pages: HashMap::default(),
            arena: Vec::new(),
            budget,
            keys: (budget / KEY_UOPS).clamp(1, MAX_KEYS),
            decoded: 0,
            clears: 0,
            rescues: 0,
        }
    }

    /// The block at `key` (a JIT block key: its PA and regime bits), decoded
    /// from `mem` if new; `None` if it would have no instructions.
    #[inline(always)]
    pub fn get(&mut self, key: u64, mem: &Mem) -> Option<&[Uop]> {
        let s = self.slots[slot(key)];
        let (start, len) = if s.key == key {
            (s.start, s.len as u32)
        } else {
            self.miss(key, mem)?
        };
        Some(&self.arena[start as usize..(start + len) as usize])
    }

    #[inline(never)]
    fn miss(&mut self, key: u64, mem: &Mem) -> Option<(u32, u32)> {
        match self.map.get(&key) {
            Some(e) if e.len() == 0 => return None,
            Some(_) => {}
            None => {
                let mut wide = crate::jit::block::form_with(mem, key & !3, |w, op| {
                    uop_el(w, op, key & 1 != 0)
                });
                mov_runs(&mut wide);
                let len = wide.len();
                // Its micro-ops, then its constants.
                let uops = pack(&wide);
                // Full (its micro-ops, or its keys: blocks of one or none
                // fill the map before the arena), it starts over; with no
                // room in the heap for it to grow, it frees its memory too.
                // (`capacity` is its keys plus the room left before it
                // grows: an IC's tombstones take room, so with none left and
                // half its keys in it, it would double past them.)
                let n = self.map.len();
                if n >= self.keys
                    || self.map.capacity() == n && n > crate::jit::grows_past(self.keys)
                    || len != 0 && self.arena.len() + uops.len() > self.budget
                {
                    self.clear();
                }
                if self.map.try_reserve(1).is_err()
                    || self.pages.try_reserve(1).is_err()
                    || self.arena.try_reserve(uops.len()).is_err()
                {
                    self.rescue();
                }
                let low = (key & 0xfff) as u16;
                let next = self.pages.insert(key >> 12, low).unwrap_or(low);
                if len == 0 {
                    self.map.insert(key, Known::new(0, 0, next));
                    return None;
                }
                let start = self.arena.len() as u32;
                self.arena.extend(uops);
                self.decoded += 1;
                self.map.insert(key, Known::new(start, len as u32, next));
            }
        }
        Some(self.slot_in(key))
    }

    /// Puts decoded block `key` in its slot, with the dispatches it counted
    /// and the quota it had left while out of it; the block it
    /// replaces keeps its own in the map.
    fn slot_in(&mut self, key: u64) -> (u32, u32) {
        let e = self.map.get_mut(&key).expect("decoded");
        let hits = core::mem::take(&mut e.hits) as u16;
        let quota = core::mem::take(&mut e.quota);
        let (start, len) = (e.start(), e.len());
        let old = self.slots[slot(key)];
        if (old.hits != 0 || old.quota != 0)
            && let Some(e) = self.map.get_mut(&old.key)
        {
            // (Never more than its quota, a u8.)
            (e.hits, e.quota) = (old.hits as u8, old.quota);
        }
        self.slots[slot(key)] = Slot {
            key,
            start,
            len: len as u8,
            quota,
            hits,
        };
        if self.used.len() < SLOTS / 16 {
            self.used.push(slot(key) as u32);
        }
        (start, len)
    }

    /// Decodes the block at `key` if it isn't yet, and returns its length
    /// then (0: no instructions; `None`: it was decoded before, maybe from
    /// words an IC has since dropped that this table hasn't caught up with).
    pub fn decode(&mut self, key: u64, mem: &Mem) -> Option<u32> {
        if self.map.contains_key(&key) {
            return None;
        }
        Some(self.miss(key, mem).map_or(0, |(_, len)| len))
    }

    /// Counts a dispatch of the block at `key` if it's decoded and hasn't
    /// counted its quota since it last reported.
    #[inline(always)]
    pub fn count(&mut self, key: u64) -> bool {
        let s = &mut self.slots[slot(key)];
        if s.key == key {
            if s.hits < s.quota as u16 {
                s.hits += 1;
                return true;
            }
            return false;
        }
        self.count_out(key)
    }

    /// [`Cache::count`] for a block out of its slot: put back with the
    /// quota it had left, it counts on without reporting.
    #[inline(never)]
    fn count_out(&mut self, key: u64) -> bool {
        match self.map.get(&key) {
            Some(e) if e.len() != 0 && e.hits < e.quota => {}
            _ => return false,
        }
        self.slot_in(key);
        let s = &mut self.slots[slot(key)];
        s.hits += 1;
        true
    }

    /// The dispatches the block at `key` may count before it reports again
    /// (`jit::Cache::miss` says, at most [`REPORT`]), in its slot or out of it.
    pub fn quota(&mut self, key: u64, n: u32) {
        let s = &mut self.slots[slot(key)];
        if s.key == key {
            s.quota = n.min(REPORT_IDLE) as u8;
        } else if let Some(e) = self.map.get_mut(&key)
            && e.len() != 0
        {
            // (Never a key with no instructions: it isn't a block to run.)
            e.quota = n.min(REPORT_IDLE) as u8;
        }
    }

    /// The dispatches the block at `key` counted since it last reported,
    /// which it reports now.
    pub fn counted(&mut self, key: u64) -> u32 {
        let s = &mut self.slots[slot(key)];
        if s.key == key {
            return core::mem::take(&mut s.hits) as u32;
        }
        self.map
            .get_mut(&key)
            .map_or(0, |e| core::mem::take(&mut e.hits) as u32)
    }

    /// Whether `key` was decoded and has no instructions.
    pub fn empty(&self, key: u64) -> bool {
        self.map.get(&key).is_some_and(|e| e.len() == 0)
    }

    /// Every block's micro-ops and constants (the slow path's [`run`] reads
    /// the constants).
    pub fn arena(&self) -> &[Uop] {
        &self.arena
    }

    #[cfg(test)]
    pub fn slotted(&self, key: u64) -> bool {
        self.slots[slot(key)].key == key
    }

    #[cfg(test)]
    pub fn capacity(&self) -> usize {
        self.map.capacity()
    }

    #[cfg(test)]
    pub fn has(&self, key: u64) -> bool {
        self.map.contains_key(&key)
    }

    /// Drops the blocks of physical page `page` (`IC IVAU`).
    pub fn drop_page(&mut self, page: u64) {
        let Some(mut low) = self.pages.remove(&page) else {
            return;
        };
        loop {
            let key = page << 12 | low as u64;
            let next = self.map.remove(&key).expect("a page's key").next;
            let s = &mut self.slots[slot(key)];
            if s.key == key {
                *s = EMPTY;
            }
            if next == low {
                break;
            }
            low = next;
        }
    }

    /// The heap bytes it takes: the arena, the map and the page index.
    pub fn bytes(&self) -> u64 {
        use crate::jit::table_bytes;
        (self.arena.capacity() * size_of::<Uop>()) as u64
            + table_bytes(self.map.capacity(), size_of::<(u64, Known)>())
            + table_bytes(self.pages.capacity(), size_of::<(u64, u16)>())
    }

    /// Drops every block and frees the memory the maps and the arena hold
    /// (a clear keeps it).
    #[cold]
    #[inline(never)]
    pub fn rescue(&mut self) {
        self.clear();
        self.map = HashMap::default();
        self.pages = HashMap::default();
        self.arena = Vec::new();
        self.rescues += 1;
    }

    /// Drops every block.
    pub fn clear(&mut self) {
        if self.used.len() < SLOTS / 16 {
            for &i in &self.used {
                self.slots[i as usize] = EMPTY;
            }
        } else {
            self.slots.fill(EMPTY);
        }
        self.used.clear();
        self.map.clear();
        self.pages.clear();
        self.arena.clear();
        self.clears += 1;
    }
}

#[cfg(test)]
mod tests;
