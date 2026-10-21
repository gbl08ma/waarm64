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
use crate::mmu::{Bus, Flat, Mmu, TLB_ENTRIES, Use};
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
    /// LDR (literal) of `x` bytes (bit 4: LDRSW).
    LdLit,
}

/// Marks each MovI with the number of MovIs right after it ([`hot`] runs
/// them in its dispatch; [`run`] ignores the count).
pub fn mov_runs(b: &mut [Uop]) {
    let mut n = 0;
    for k in (0..b.len()).rev() {
        if b[k].k == K::MovI {
            b[k].x = n;
            n += 1;
        } else {
            n = 0;
        }
    }
}

/// One instruction, decoded.
#[derive(Clone, Copy, Debug)]
pub struct Uop {
    k: K,
    d: u8,
    n: u8,
    m: u8,
    x: u32,
    imm: u64,
}

impl Uop {
    /// Whether the block may go on to its successor after this, its last
    /// instruction, retired: anything but an instruction run generically
    /// (which may have changed the regime: an MSR, ERET).
    #[inline(always)]
    pub fn chains(&self) -> bool {
        self.k != K::Generic
    }

    fn new(k: K, d: u32, n: u32, m: u32, x: u32, imm: u64) -> Uop {
        Uop {
            k,
            d: d as u8,
            n: n as u8,
            m: m as u8,
            x,
            imm,
        }
    }
}

/// Decodes one instruction (blocks are decoded through `jit::block::form_with`).
#[cfg(test)]
pub fn uop(w: u32) -> Uop {
    uop_op(w, crate::decode::decode(w))
}

/// [`uop`] of `w`, whose class is `op`.
fn uop_op(w: u32, op: Op) -> Uop {
    use Op::*;
    let (rd, rn, rm) = (bits(w, 4, 0), bits(w, 9, 5), bits(w, 20, 16));
    let sf = bit(w, 31);
    let generic = Uop::new(K::Generic, 0, 0, 0, w, op as u16 as u64);
    let u = |k, x, imm| Uop::new(k, rd, rn, rm, x, imm);
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
                MOVK => Uop::new(K::Movk, rd, 0, sh, sf as u32, imm << sh),
                _ if rd == 31 => u(K::Nop, 0, 0),
                MOVN => u(K::MovI, 0, trunc(!(imm << sh), sf)),
                _ => u(K::MovI, 0, imm << sh),
            }
        }

        SBFM | UBFM | ASR_1 | ASR_2 | SXTB_1 | SXTB_2 | SXTH_1 | SXTH_2 | SXTW => {
            let (n, immr, imms) = (bits(w, 22, 22), bits(w, 21, 16), bits(w, 15, 10));
            if (sf && n != 1) || (!sf && (n != 0 || immr >= 32 || imms >= 32)) {
                return generic;
            }
            let Some((wmask, tmask)) = bit_masks(n, imms, immr, false) else {
                return generic;
            };
            match bits(w, 30, 29) {
                0 => Uop::new(K::Sbfm, rd, rn, immr, imms | (sf as u32) << 8, 0),
                2 => Uop::new(K::Ubfm, rd, rn, immr, sf as u32, wmask & tmask),
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
        B_cond => Uop::new(K::Bcond, bits(w, 3, 0), 0, 0, 0, branch(23, 5, 21)),
        CBZ | CBNZ => u(
            K::Cbz,
            sf as u32 | ((op == CBNZ) as u32) << 1,
            branch(23, 5, 21),
        ),
        TBZ | TBNZ => {
            let b = bits(w, 31, 31) << 5 | bits(w, 23, 19);
            Uop::new(K::Tbz, rd, 0, b, (op == TBNZ) as u32, branch(18, 5, 16))
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
            u(
                k,
                size | mode << 2 | ext << 4 | option << 8 | amt << 12,
                imm,
            )
        }
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
            Uop::new(k, rd, rn, bits(w, 14, 10), x, imm)
        }
        _ => generic,
    }
}

/// Runs `b` (a prefix of a block: at most what's left of the chunk) at `pc`.
/// Returns what [`super::steps`] would for those instructions: how many
/// retired before one that didn't (or that retired with an internal exit),
/// and that exit.
#[inline(never)]
pub fn run(c: &mut Cpu, m: &mut impl Bus, b: &[Uop], pc: u64) -> (u64, Option<Exit>) {
    let mut pc = pc;
    for (k, u) in b.iter().enumerate() {
        let (d, n) = (u.d as u32, u.n as u32);
        let sf = u.x & 1 != 0;
        match u.k {
            K::Generic => {
                if let Err(e) = super::exec_at_op(c, m, u.x, pc, Op::ALL[u.imm as usize]) {
                    return (k as u64, Some(e));
                }
                if k + 1 == b.len() {
                    // It may have branched (ERET, an MSR's exit): the PC is its.
                    return (b.len() as u64, None);
                }
            }
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
            K::Adr => c.set_reg(d, pc.wrapping_add(u.imm)),
            K::Adrp => c.set_reg(d, (pc & !0xfff).wrapping_add(u.imm)),
            K::B => return taken(c, b, pc.wrapping_add(u.imm)),
            K::Bl => {
                c.x[30] = pc.wrapping_add(4);
                return taken(c, b, pc.wrapping_add(u.imm));
            }
            K::Bcond => {
                let t = cond_holds(c.nzcv, d);
                return taken(c, b, pc.wrapping_add(if t { u.imm } else { 4 }));
            }
            K::Cbz => {
                let t = (trunc(c.reg(d), sf) != 0) == (u.x & 2 != 0);
                return taken(c, b, pc.wrapping_add(if t { u.imm } else { 4 }));
            }
            K::Tbz => {
                let t = (c.reg(d) >> u.m & 1 != 0) == (u.x != 0);
                return taken(c, b, pc.wrapping_add(if t { u.imm } else { 4 }));
            }
            K::Br => return taken(c, b, c.reg(n)),
            K::Blr => {
                let to = c.reg(n);
                c.x[30] = pc.wrapping_add(4);
                return taken(c, b, to);
            }
            K::Ld | K::St => {
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
    (b.len() as u64, None)
}

/// A bus's inline paths for [`hot`]: no call and no panic on any path, so
/// that V8 keeps the loop's state in registers (it spills every value live
/// across a call at its definition, docs/v8.md "Spills"). `None`: the slow
/// path's, outside the loop.
pub trait Fast: Bus {
    /// The host address of `size` bytes of RAM at `va` for `u`, if the TLB
    /// (or the flat map) has it, as [`Bus::fast`].
    fn fast_ptr(&mut self, c: &Cpu, va: u64, size: u32, u: Use) -> Option<*mut u8>;
    /// The block key of the instruction at `pc` (aligned), if the instruction
    /// TLB has it: `jit::key`'s.
    fn ikey(&mut self, c: &Cpu, pc: u64) -> Option<u64>;
}

impl Fast for Flat<'_> {
    #[inline(always)]
    fn fast_ptr(&mut self, _: &Cpu, va: u64, size: u32, _: Use) -> Option<*mut u8> {
        self.0.host0(va, size as u64)
    }

    #[inline(always)]
    fn ikey(&mut self, c: &Cpu, pc: u64) -> Option<u64> {
        Some(pc | c.el() & 1)
    }
}

impl Fast for Mmu<'_> {
    #[inline(always)]
    fn fast_ptr(&mut self, c: &Cpu, va: u64, size: u32, u: Use) -> Option<*mut u8> {
        // With SCTLR_EL1.A (alignment faults) or the MMU off, the slow path.
        if c.sctlr_el1 & (sctlr::M | sctlr::A) != sctlr::M {
            return None;
        }
        // EL0 and EL1 only (masked: no bounds check), as `Mmu::fast`.
        let e = self.tlb.as_ref()?.e[(va >> 12) as usize & (TLB_ENTRIES - 1)].0
            [3 * (c.el() & 1) as usize + u as usize];
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

    /// The micro-op [`hot`] stopped at ([`SLOW`]), and whether it's its
    /// block prefix's last.
    pub fn uop(&self) -> (Uop, bool) {
        // SAFETY: `u` < `end`, into the arena, which nothing changed since.
        (unsafe { *self.u }, unsafe { self.u.add(1) } == self.end)
    }

    /// Past the micro-op [`hot`] stopped at, which retired (not its block's last).
    pub fn step(&mut self) {
        // SAFETY: `u` < `end`.
        self.u = unsafe { self.u.add(1) };
        self.pc = self.pc.wrapping_add(4);
    }
}

/// [`hot`] stopped: the run ends here, `c.pc` set.
pub const STOP: u32 = 0;
/// [`hot`] stopped at a micro-op it can't run inline ([`Run::uop`] at
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
    let (mut u, mut end, mut pc, mut key, mut bpc, mut done) =
        (r.u, r.end, r.pc, r.key, r.bpc, r.done);
    let left = r.left;
    let arena = dec.arena.as_ptr();
    let status = 'run: loop {
        // The block's prefix, to the PC after it.
        let next = 'block: loop {
            if u == end {
                break 'block pc;
            }
            // SAFETY: u < end, in the arena.
            let o = unsafe { &*u };
            let (d, n) = (o.d as u32, o.n as u32);
            let sf = o.x & 1 != 0;
            match o.k {
                K::Generic | K::LdLit => break 'run SLOW,
                K::Maddl => wr(
                    c,
                    d,
                    maddl(o.x, rd(c, n), rd(c, o.m as u32), rd(c, o.x & 31)),
                ),
                K::Extr => wr(c, d, extr(o.x, rd(c, n), rd(c, o.m as u32))),
                K::Bit1 => wr(c, d, bit1(o.x, rd(c, n))),
                K::Nop => {}
                K::AddI64 => wsp(c, d, rsp(c, n).wrapping_add(o.imm)),
                K::AddI32 => wsp(c, d, rsp(c, n).wrapping_add(o.imm) as u32 as u64),
                K::AddsI => {
                    let (v, f) = add_with_carry(rsp(c, n), o.imm, o.x & 2 != 0, sf);
                    c.nzcv = f;
                    wr(c, d, v);
                }
                K::AddR => {
                    let sf = o.x >> 8 & 1 != 0;
                    let y = shift(rd(c, o.m as u32), o.x & 3, o.x >> 2 & 63, sf);
                    addsub_h(c, o.x, d, rd(c, n), y, sf, false);
                }
                K::AddX => {
                    let sf = o.x >> 8 & 1 != 0;
                    let y = extend(rd(c, o.m as u32), o.x & 7, o.x >> 3 & 7);
                    addsub_h(c, o.x, d, rsp(c, n), y, sf, true);
                }
                K::MovI => {
                    wsp(c, d, o.imm);
                    // SAFETY: u < end, both in the block's micro-ops.
                    let k = (o.x as usize).min(unsafe { end.offset_from(u) } as usize - 1);
                    for j in 1..=k {
                        // SAFETY: u + j < end.
                        let b = unsafe { &*u.add(j) };
                        wsp(c, b.d as u32, b.imm);
                    }
                    // SAFETY: as above.
                    u = unsafe { u.add(k) };
                    pc = pc.wrapping_add(4 * k as u64);
                }
                K::Movk => {
                    let v = (rd(c, d) & !(0xffff << (o.m & 63))) | o.imm;
                    wr(c, d, trunc(v, sf));
                }
                K::Mov => wsp(c, d, trunc(rd(c, o.m as u32), sf)),
                K::LogI => {
                    let opc = o.x & 3;
                    logical_h(c, opc, d, op(opc, rd(c, n), o.imm), o.x & 4 != 0, true);
                }
                K::LogR => {
                    let sf = o.x >> 11 & 1 != 0;
                    let y = shift(rd(c, o.m as u32), o.x & 3, o.x >> 2 & 63, sf);
                    let y = if o.x >> 10 & 1 != 0 { !y } else { y };
                    let opc = o.x >> 8 & 3;
                    logical_h(c, opc, d, op(opc, rd(c, n), y), sf, false);
                }
                K::Ubfm => wr(c, d, ror(trunc(rd(c, n), sf), o.m as u32 & 63, sf) & o.imm),
                K::Sbfm => {
                    let (rr, s, sf) = (o.m as u32 & 63, o.x & 63, o.x >> 8 & 1 != 0);
                    let src = rd(c, n);
                    let v = if s >= rr {
                        sext(src >> rr, s - rr + 1)
                    } else {
                        sext(src, s + 1) << ((if sf { 64 } else { 32 } - rr) & 63)
                    };
                    wr(c, d, trunc(v, sf));
                }
                K::ShiftV => {
                    let sf = o.x & 4 != 0;
                    let amt = (rd(c, o.m as u32) & if sf { 63 } else { 31 }) as u32;
                    wr(c, d, shift(rd(c, n), o.x & 3, amt, sf));
                }
                K::Csel => {
                    let v = if cond_holds(c.nzcv, o.x & 15) {
                        rd(c, n)
                    } else {
                        let y = rd(c, o.m as u32);
                        match o.x >> 4 & 3 {
                            0 => y,
                            1 => y.wrapping_add(1),
                            2 => !y,
                            _ => y.wrapping_neg(),
                        }
                    };
                    wr(c, d, trunc(v, o.x >> 6 & 1 != 0));
                }
                K::Ccmp => {
                    c.nzcv = if cond_holds(c.nzcv, o.x & 15) {
                        let y = if o.x >> 4 & 1 != 0 {
                            o.m as u64
                        } else {
                            rd(c, o.m as u32)
                        };
                        let sub = o.x >> 5 & 1 != 0;
                        let y = if sub { !y } else { y };
                        add_with_carry(rd(c, n), y, sub, o.x >> 6 & 1 != 0).1
                    } else {
                        ((o.x >> 8 & 15) as u64) << 28
                    };
                }
                K::Madd => {
                    let p = rd(c, n).wrapping_mul(rd(c, o.m as u32));
                    let a = rd(c, o.x & 31);
                    let v = if o.x >> 5 & 1 != 0 {
                        a.wrapping_sub(p)
                    } else {
                        a.wrapping_add(p)
                    };
                    wr(c, d, trunc(v, o.x >> 6 & 1 != 0));
                }
                K::Adr => wr(c, d, pc.wrapping_add(o.imm)),
                K::Adrp => wr(c, d, (pc & !0xfff).wrapping_add(o.imm)),
                // Branches end their block.
                K::B => break 'block pc.wrapping_add(o.imm),
                K::Bl => {
                    c.x[30] = pc.wrapping_add(4);
                    break 'block pc.wrapping_add(o.imm);
                }
                K::Bcond => {
                    let t = cond_holds(c.nzcv, d);
                    break 'block pc.wrapping_add(if t { o.imm } else { 4 });
                }
                K::Cbz => {
                    let t = (trunc(rd(c, d), sf) != 0) == (o.x & 2 != 0);
                    break 'block pc.wrapping_add(if t { o.imm } else { 4 });
                }
                K::Tbz => {
                    let t = (rd(c, d) >> (o.m & 63) & 1 != 0) == (o.x != 0);
                    break 'block pc.wrapping_add(if t { o.imm } else { 4 });
                }
                K::Br => break 'block rd(c, n),
                K::Blr => {
                    let to = rd(c, n);
                    c.x[30] = pc.wrapping_add(4);
                    break 'block to;
                }
                K::Ld | K::St => {
                    let base = rsp(c, n);
                    if n == 31 && base & 15 != 0 {
                        break 'run SLOW;
                    }
                    let (addr, wb) = match o.x >> 2 & 3 {
                        0 => (base.wrapping_add(o.imm), None),
                        1 => {
                            let a = base.wrapping_add(o.imm);
                            (a, Some(a))
                        }
                        2 => (base, Some(base.wrapping_add(o.imm))),
                        _ => {
                            let off = extend(rd(c, o.m as u32), o.x >> 8 & 7, o.x >> 12 & 7);
                            (base.wrapping_add(off), None)
                        }
                    };
                    let bytes = 1 << (o.x & 3);
                    if o.k == K::St {
                        let Some(p) = m.fast_ptr(c, addr, bytes, Use::Write) else {
                            break 'run SLOW;
                        };
                        // SAFETY: `fast_ptr` found `bytes` bytes of RAM at `p`.
                        if !unsafe { mem::store_aligned(p, bytes, rd(c, d)) } {
                            break 'run SLOW;
                        }
                    } else {
                        let Some(p) = m.fast_ptr(c, addr, bytes, Use::Read) else {
                            break 'run SLOW;
                        };
                        // SAFETY: as for the store.
                        let Some(v) = (unsafe { mem::load_aligned(p, bytes) }) else {
                            break 'run SLOW;
                        };
                        let v = match o.x >> 4 & 3 {
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
                    let base = rsp(c, n);
                    if n == 31 && base & 15 != 0 {
                        break 'run SLOW;
                    }
                    let (size, mode) = (o.x & 15, o.x >> 8 & 3);
                    let addr = if mode == 1 {
                        base
                    } else {
                        base.wrapping_add(o.imm)
                    };
                    let a2 = addr.wrapping_add(size as u64);
                    let (rt, rt2) = (d, o.m as u32);
                    let w = if o.k == K::Ldp { Use::Read } else { Use::Write };
                    let (Some(p1), Some(p2)) =
                        (m.fast_ptr(c, addr, size, w), m.fast_ptr(c, a2, size, w))
                    else {
                        break 'run SLOW;
                    };
                    if (p1 as usize | p2 as usize) & (size as usize - 1) != 0 {
                        break 'run SLOW;
                    }
                    if o.k == K::Ldp {
                        // SAFETY: `fast_ptr` found RAM at both, aligned (checked).
                        let (v1, v2) = unsafe {
                            (
                                mem::load_aligned(p1, size).unwrap_or(0),
                                mem::load_aligned(p2, size).unwrap_or(0),
                            )
                        };
                        let ext = |v: u64| if o.x & 16 != 0 { v as i32 as u64 } else { v };
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
                        wsp(c, n, base.wrapping_add(o.imm));
                    }
                }
            }
            // SAFETY: u < end.
            u = unsafe { u.add(1) };
            pc = pc.wrapping_add(4);
        };
        // The block's prefix ran: on to the next, as `jit::interpret` goes.
        (pc, u) = (next, end);
        if done >= left {
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
        let n = (s.len as u64).min(left - done);
        // SAFETY: a slotted block's micro-ops are in the arena.
        u = unsafe { arena.add(s.start as usize) };
        // SAFETY: n <= its length.
        end = unsafe { u.add(n as usize) };
        done += n;
        (key, bpc) = (k, next);
    };
    (r.u, r.end, r.pc, r.key, r.bpc, r.done) = (u, end, pc, key, bpc, done);
    if status != SLOW {
        c.pc = pc;
    }
    status
}

/// [`run`] through [`hot`], as `jit::interpret` drives it, for one block (the tests).
#[cfg(test)]
pub fn run_hot(c: &mut Cpu, m: &mut impl Fast, b: &[Uop], pc: u64) -> (u64, Option<Exit>) {
    let mut dec = Cache::new(1 << 10);
    let mut r = Run::new(b.len() as u64);
    r.enter(b, 0, pc);
    loop {
        if hot(c, m, &mut dec, |_| false, &mut r) != SLOW {
            return (r.done, None);
        }
        let (u, last) = r.uop();
        let before = r.retired();
        let (k, e) = run(c, m, core::slice::from_ref(&u), r.pc);
        if e.is_some() {
            return (before + k, e);
        }
        if last {
            return (r.done, None);
        }
        r.step();
    }
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

/// A branch (always a block's last instruction) to `to`.
#[inline(always)]
fn taken(c: &mut Cpu, b: &[Uop], to: u64) -> (u64, Option<Exit>) {
    c.pc = to;
    (b.len() as u64, None)
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
fn single(c: &mut Cpu, m: &mut impl Bus, u: &Uop) -> R {
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
    if u.k == K::St {
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
fn pair(c: &mut Cpu, m: &mut impl Bus, u: &Uop) -> R {
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

/// Micro-ops the tables' caches of a VM hold in all (16 bytes each: 256 MiB),
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
    /// Every block: its micro-ops in `arena` (start, length), and the
    /// dispatches it counted and the quota it had while out of the slots
    /// (one put back counts on: a report takes the JIT cache's lock). A key
    /// with no instructions is kept too, with length 0 (never a block to run).
    map: HashMap<u64, (u32, u32, u16, u8), crate::jit::KeyBuild>,
    /// The keys in `map` by physical page, for `IC IVAU`.
    pages: HashMap<u64, Vec<u64>, crate::jit::KeyBuild>,
    arena: Vec<Uop>,
    /// The micro-ops it holds before it starts over.
    budget: usize,
    /// Blocks decoded, and times the cache started over (`jit::Stats`).
    pub decoded: u64,
    pub clears: u64,
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
            decoded: 0,
            clears: 0,
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
            Some(e) if e.1 == 0 => return None,
            Some(_) => {}
            None => {
                let mut uops = crate::jit::block::form_with(mem, key & !3, uop_op);
                mov_runs(&mut uops);
                if uops.is_empty() {
                    self.map.insert(key, (0, 0, 0, 0));
                    self.pages.entry(key >> 12).or_default().push(key);
                    return None;
                }
                if self.arena.len() + uops.len() > self.budget {
                    self.clear();
                }
                let start = self.arena.len() as u32;
                self.arena.extend_from_slice(&uops);
                self.decoded += 1;
                self.map.insert(key, (start, uops.len() as u32, 0, 0));
                self.pages.entry(key >> 12).or_default().push(key);
            }
        }
        Some(self.slot_in(key))
    }

    /// Puts decoded block `key` in its slot, with the dispatches it counted
    /// and the quota it had left while out of it; the block it
    /// replaces keeps its own in the map.
    fn slot_in(&mut self, key: u64) -> (u32, u32) {
        let e = self.map.get_mut(&key).expect("decoded");
        let hits = core::mem::take(&mut e.2);
        let quota = core::mem::take(&mut e.3);
        let (start, len) = (e.0, e.1);
        let old = self.slots[slot(key)];
        if (old.hits != 0 || old.quota != 0)
            && let Some(e) = self.map.get_mut(&old.key)
        {
            (e.2, e.3) = (old.hits, old.quota);
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
            Some(e) if e.1 != 0 && e.2 < e.3 as u16 => {}
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
            && e.1 != 0
        {
            // (Never a key with no instructions: it isn't a block to run.)
            e.3 = n.min(REPORT_IDLE) as u8;
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
            .map_or(0, |e| core::mem::take(&mut e.2) as u32)
    }

    /// Whether `key` was decoded and has no instructions.
    pub fn empty(&self, key: u64) -> bool {
        self.map.get(&key).is_some_and(|e| e.1 == 0)
    }

    #[cfg(test)]
    pub fn slotted(&self, key: u64) -> bool {
        self.slots[slot(key)].key == key
    }

    #[cfg(test)]
    pub fn has(&self, key: u64) -> bool {
        self.map.contains_key(&key)
    }

    /// Drops the blocks of physical page `page` (`IC IVAU`).
    pub fn drop_page(&mut self, page: u64) {
        for key in self.pages.remove(&page).unwrap_or_default() {
            self.map.remove(&key);
            let s = &mut self.slots[slot(key)];
            if s.key == key {
                *s = EMPTY;
            }
        }
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
