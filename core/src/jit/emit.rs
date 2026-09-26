//! Inline emission (M5 step 4): simple integer instructions and branches
//! straight to wasm over the `Cpu` in memory (registers at `8n`, SP at 248 as
//! `x[31]`, PC at 256, NZCV at 264). Everything else stays a helper call.
//!
//! The rule: [`inline`] takes an instruction only if it can't fail, decided
//! from the word alone (an encoding whose handler could return `Undefined`
//! stays a helper call), and emits its exact interpreter semantics. 32-bit
//! (`sf` = 0) operations run on i32 and zero-extend into the X register.

use super::wasm::{Code, I32, I64};
use crate::decode::Op;
use crate::interp::{adr_imm, bit, bit_masks, bits, sext, trunc};
use crate::mmu::{TLB_ENTRIES, Vcpu};

/// A block function's locals after its parameter (local 0, the vCPU): the
/// entry PC (local 1), then scratch: i64 in 2..=5, i32 in 6..=9.
pub const LOCALS: &[(u32, u8)] = &[(5, I64), (4, I32)];
const VCPU: u32 = 0;
const ENTRY: u32 = 1;

/// Offsets in the `Cpu`.
pub const PC: u32 = 256;
const NZCV: u32 = 264;

/// The `k`-th scratch local of the operation size.
fn tmp(sf: bool, k: u32) -> u32 {
    if sf { 2 + k } else { 6 + k }
}

/// Pushes register `n` at the operation size; 31 is XZR.
fn get(c: &mut Code, sf: bool, n: u32) {
    if n == 31 {
        konst(c, sf, 0);
    } else {
        get_sp(c, sf, n);
    }
}

/// Pushes register `n` at the operation size; 31 is SP.
fn get_sp(c: &mut Code, sf: bool, n: u32) {
    c.local_get(VCPU);
    if sf {
        c.i64_load(8 * n);
    } else {
        c.i32_load(8 * n);
    }
}

fn konst(c: &mut Code, sf: bool, v: u64) {
    if sf {
        c.i64_const(v as i64);
    } else {
        c.i32_const(v as i32);
    }
}

/// Stores what `value` pushes (at the operation size, zero-extended) to
/// register `rd`; 31 is XZR, so nothing is emitted.
fn set(c: &mut Code, sf: bool, rd: u32, value: impl FnOnce(&mut Code)) {
    if rd != 31 {
        set_sp(c, sf, rd, value);
    }
}

/// As [`set`], with 31 as SP.
fn set_sp(c: &mut Code, sf: bool, rd: u32, value: impl FnOnce(&mut Code)) {
    c.local_get(VCPU);
    value(c);
    if !sf {
        c.i64_extend_i32_u();
    }
    c.i64_store(8 * rd);
}

/// Pushes the entry PC + `off`.
fn pc_plus(c: &mut Code, off: i64) {
    c.local_get(ENTRY);
    if off != 0 {
        c.i64_const(off).i64_add();
    }
}

/// Stores the entry PC + `off` to `Cpu::pc`.
pub fn set_pc(c: &mut Code, off: i64) {
    c.local_get(VCPU);
    pc_plus(c, off);
    c.i64_store(PC);
}

/// Emits instruction `i` (the `k`-th of its block) inline if this step covers
/// it; false (and nothing emitted) if it stays a helper call.
pub fn inline(c: &mut Code, i: u32, op: Op, k: usize, cx: &Ctx) -> bool {
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
            let (x, y, r, cin) = (tmp(sf, 0), tmp(sf, 1), tmp(sf, 2), tmp(false, 3));
            // The carry in: NZCV.C.
            c.local_get(VCPU).i32_load(NZCV).i32_const(29).op(SHR_U);
            c.i32_const(1).op(AND).local_set(cin);
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
            if bit(i, 29) {
                add_flags(c, sf, x, y, r, Carry::Dynamic(cin));
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
                Some(&|c: &mut Code| get(c, sf, rn)),
                |c| konst(c, sf, imm),
                true,
            );
        }
        AND_shift | BIC_shift | ORR_shift | ORN_shift | EOR_shift | EON | ANDS_shift | BICS => {
            if !sf && bits(i, 15, 10) >= 32 {
                return false;
            }
            let y = |c: &mut Code| {
                shifted(c, i);
                if bit(i, 21) {
                    konst(c, sf, u64::MAX);
                    arith(c, sf, XOR);
                }
            };
            // MOV and MVN: ORR/ORN with XZR.
            let x = |c: &mut Code| get(c, sf, rn);
            let x: Option<&dyn Fn(&mut Code)> = (rn != 31 || bits(i, 30, 29) != 1).then_some(&x);
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
            cond_holds(c, bits(i, 15, 12));
            c.select();
        }),
        CCMN_reg | CCMP_reg | CCMN_imm | CCMP_imm => {
            // NZCV = cond ? AddWithCarry's flags : nzcv (3:0).
            let sub = bit(i, 30);
            c.local_get(VCPU);
            let y = |c: &mut Code| {
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
            cond_holds(c, bits(i, 15, 12));
            c.select().i64_extend_i32_u().i64_store(NZCV);
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
                B_cond => cond_holds(c, bits(i, 3, 0)),
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
            c.select().i64_store(PC);
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
fn ldst(c: &mut Code, cx: &Ctx, i: u32, op: Op, k: usize) -> bool {
    use Op::*;
    let (rt, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let here = 4 * k as i64;
    let (size, opc) = (bits(i, 31, 30), bits(i, 23, 22));
    // The base register, with SP's alignment check left to the helper.
    let base = |c: &mut Code| {
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
            access(c, cx, i, here, len, false, false, |c, off| {
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
            access(c, cx, i, here, len, store, rn == 31, |c, off| {
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
            access(c, cx, i, here, 2 * len, !load, rn == 31, |c, o| {
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
fn load_reg(c: &mut Code, rt: u32, off: u32, len: u32, sign: bool, to32: bool) {
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
fn writeback(c: &mut Code, rn: u32, imm: i64) {
    set_sp(c, true, rn, |c| {
        c.local_get(BASE).i64_const(imm).i64_add();
    });
}

/// The fast path of an access of `len` bytes at the address in `ADDR`: if it
/// is RAM (flat: in bounds; MMU: a TLB hit for the page, which the access
/// doesn't leave) and, for an SP base (`sp`), SP is 16-byte aligned, `body`
/// runs with the host address in `HOST`, to be used with the memarg offset
/// it gets. Otherwise the helper re-executes the instruction (exact faults,
/// MMIO through `vm::Io`, page-crossing accesses) and the block returns if it
/// didn't retire.
#[allow(clippy::too_many_arguments)]
fn access(
    c: &mut Code,
    cx: &Ctx,
    i: u32,
    here: i64,
    len: u32,
    write: bool,
    sp: bool,
    body: impl FnOnce(&mut Code, u32),
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
            c.local_get(ADDR).i64_const(12).op(SHR_U + W).i32_wrap_i64();
            c.i32_const(TLB_ENTRIES as i32 - 1)
                .op(AND)
                .i32_const(4)
                .op(SHL);
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
    body(c, off);
    c.else_();
    c.local_get(VCPU).i32_const(i as i32);
    pc_plus(c, here);
    c.call(cx.helper)
        .if_()
        .i32_const((here / 4) as i32)
        .return_()
        .end();
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
const GE_S: u8 = 0x4e;
const LE_U: u8 = 0x4d;

/// A binary or unary arithmetic op at the operation size.
fn arith(c: &mut Code, sf: bool, op32: u8) {
    c.op(if sf { op32 + W } else { op32 });
}

/// A comparison at the operation size (an i32 result either way).
fn cmp(c: &mut Code, sf: bool, op32: u8) {
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
    c: &mut Code,
    i: u32,
    x: impl FnOnce(&mut Code),
    y: impl FnOnce(&mut Code),
    sp_dest: bool,
) {
    let (sf, sub, s, rd) = (bit(i, 31), bit(i, 30), bit(i, 29), bits(i, 4, 0));
    if !s {
        let v = |c: &mut Code| {
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
    let (tx, ty, tr) = add_with_carry(c, sf, x, y, sub);
    set(c, sf, rd, |c| {
        c.local_get(tr);
    });
    let carry = if sub { Carry::One } else { Carry::Zero };
    add_flags(c, sf, tx, ty, tr, carry);
}

/// AddWithCarry(x, sub ? !y : y, sub) into scratch locals (x, y, result).
fn add_with_carry(
    c: &mut Code,
    sf: bool,
    x: impl FnOnce(&mut Code),
    y: impl FnOnce(&mut Code),
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

/// Stores AddWithCarry's NZCV for `r` = `x` + `y` + carry (locals of the
/// operation size): C is `r < x` unsigned, or `r <= x` with a carry in; V is
/// the sign of `(x ^ r) & (y ^ r)`.
fn add_flags(c: &mut Code, sf: bool, x: u32, y: u32, r: u32, carry: Carry) {
    c.local_get(VCPU);
    add_nzcv(c, sf, x, y, r, carry);
    c.i64_extend_i32_u().i64_store(NZCV);
}

/// Pushes [`add_flags`]'s NZCV as an i32.
fn add_nzcv(c: &mut Code, sf: bool, x: u32, y: u32, r: u32, carry: Carry) {
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

/// Pushes an i32 that is non-zero iff condition `cond` holds for NZCV in
/// memory (ConditionHolds): GE and GT line N up with V (`n ^ n << 3`) and Z
/// (`n << 1`) in the sign bit.
fn cond_holds(c: &mut Code, cond: u32) {
    let n = tmp(false, 3);
    let invert = cond & 1 == 1 && cond != 15;
    if cond >> 1 == 7 {
        c.i32_const(1);
        return;
    }
    c.local_get(VCPU).i32_load(NZCV);
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
fn nz(c: &mut Code, sf: bool, r: u32) {
    c.local_get(r);
    sign_to(c, sf, 31);
    c.local_get(r);
    cmp(c, sf, EQZ);
    c.i32_const(30).op(SHL).op(OR);
}

/// Turns the value on the stack into an i32 holding just its sign bit, moved to bit `p`.
fn sign_to(c: &mut Code, sf: bool, p: u32) {
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
    c: &mut Code,
    i: u32,
    x: Option<&dyn Fn(&mut Code)>,
    y: impl FnOnce(&mut Code),
    sp_dest: bool,
) {
    let (sf, rd, opc) = (bit(i, 31), bits(i, 4, 0), bits(i, 30, 29));
    let v = |c: &mut Code| {
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
    let r = tmp(sf, 0);
    v(c);
    c.local_set(r);
    set(c, sf, rd, |c| {
        c.local_get(r);
    });
    c.local_get(VCPU);
    nz(c, sf, r);
    c.i64_extend_i32_u().i64_store(NZCV);
}

/// A shift of the value on the stack by a constant; nothing for 0.
fn shift(c: &mut Code, sf: bool, op32: u8, amt: u32) {
    if amt != 0 {
        konst(c, sf, amt as u64);
        arith(c, sf, op32);
    }
}

/// Pushes the shifted-register operand (Rm, shift type 23:22, amount 15:10).
fn shifted(c: &mut Code, i: u32) {
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
fn extended(c: &mut Code, i: u32) {
    let sf = bit(i, 31);
    extend(c, sf, bits(i, 20, 16), bits(i, 15, 13), bits(i, 12, 10));
}

/// Pushes ExtendReg(Rm, `option`, `amt`) at the operation size.
fn extend(c: &mut Code, sf: bool, rm: u32, option: u32, amt: u32) {
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
fn swap(c: &mut Code, sf: bool, sh: u32, m: u64) {
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
fn bswap(c: &mut Code, sf: bool) {
    swap(c, sf, 8, 0x00ff_00ff_00ff_00ff);
    if sf {
        swap(c, sf, 16, 0x0000_ffff_0000_ffff);
    }
    shift(c, sf, ROTR, if sf { 32 } else { 16 });
}

/// Pushes the high 64 bits of Xn × Xm, from 32-bit halves; signed, it
/// subtracts `b` if `a` < 0 and `a` if `b` < 0 from the unsigned result.
fn mulh(c: &mut Code, signed: bool, rn: u32, rm: u32) {
    let (a, b, u, w) = (2, 3, 4, 5);
    let lo = |c: &mut Code, v: u32| {
        c.local_get(v);
        mask(c, true, 0xffff_ffff);
    };
    let hi = |c: &mut Code, v: u32| {
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

fn mask(c: &mut Code, sf: bool, m: u64) {
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
        let mut c = Code::default();
        inline(&mut c, i, decode(i), k, cx).then_some(c.b)
    }

    #[test]
    fn moves() {
        // movz x1, #5, lsl #16: vcpu; i64.const 0x50000; i64.store 8
        assert_eq!(
            emit(0xd2a000a1, 0).unwrap(),
            [0x20, 0, 0x42, 0x80, 0x80, 0x14, 0x37, 3, 8]
        );
        // movk w2, #1: vcpu; vcpu; i32.load 16; i32.const !0xffff; and; i32.const 1; or;
        // i64.extend_i32_u; i64.store 16
        #[rustfmt::skip]
        let want = [
            0x20, 0, 0x20, 0, 0x28, 2, 16, 0x41, 0x80, 0x80, 0x7c, 0x71, 0x41, 1, 0x72,
            0xad, 0x37, 3, 16,
        ];
        assert_eq!(emit(0x72800022, 0).unwrap(), want);
        assert_eq!(emit(0xd280001f, 0).unwrap(), []); // movz xzr: nothing to do
        assert_eq!(emit(0x52c00000, 0), None); // movz w0, #0, lsl #32: UNDEFINED, a helper
        // mov x3, x4 (orr x3, xzr, x4): vcpu; vcpu; i64.load 32; i64.store 24
        assert_eq!(
            emit(0xaa0403e3, 0).unwrap(),
            [0x20, 0, 0x20, 0, 0x29, 3, 32, 0x37, 3, 24]
        );
        // orr x3, xzr, x4, lsl #4: the shift, no or
        assert_eq!(
            emit(0xaa0413e3, 0).unwrap(),
            [0x20, 0, 0x20, 0, 0x29, 3, 32, 0x42, 4, 0x86, 0x37, 3, 24]
        );
    }

    #[test]
    fn pc_relative() {
        // adr x0, .+8 as instruction 2: vcpu; entry; i64.const 16; add; i64.store 0
        assert_eq!(
            emit(0x10000040, 2).unwrap(),
            [0x20, 0, 0x20, 1, 0x42, 16, 0x7c, 0x37, 3, 0]
        );
        // adrp x1, .+0x1000 as instruction 0: (entry & !0xfff) + 0x1000
        #[rustfmt::skip]
        let want = [
            0x20, 0, 0x20, 1, 0x42, 0x80, 0x60, 0x83, 0x42, 0x80, 0x20, 0x7c, 0x37, 3, 8,
        ];
        assert_eq!(emit(0xb0000001, 0).unwrap(), want);
    }

    #[test]
    fn add_sub() {
        // add x0, sp, #16: vcpu; vcpu; i64.load 248; i64.const 16; add; i64.store 0
        assert_eq!(
            emit(0x910043e0, 0).unwrap(),
            [
                0x20, 0, 0x20, 0, 0x29, 3, 0xf8, 1, 0x42, 16, 0x7c, 0x37, 3, 0
            ]
        );
        // sub w0, w1, w2, uxtb #2: w1 - ((w2 & 0xff) << 2), zero-extended
        #[rustfmt::skip]
        let want = [
            0x20, 0, 0x20, 0, 0x28, 2, 8, 0x20, 0, 0x28, 2, 16, 0x41, 0xff, 1, 0x71,
            0x41, 2, 0x74, 0x6b, 0xad, 0x37, 3, 0,
        ];
        assert_eq!(emit(0x4b220820, 0).unwrap(), want);
        // cmp x1, x2 (subs xzr, x1, x2): no register store, NZCV stored last.
        let b = emit(0xeb02003f, 0).unwrap();
        assert!(b.ends_with(&[0xad, 0x37, 3, 0x88, 2]));
        assert_eq!(b.iter().filter(|&&x| x == 0x37).count(), 1);
        assert_eq!(emit(0x91c00000, 0), None); // add x0, x0, #0, lsl #24: reserved shift
        assert_eq!(emit(0x8b221400, 0), None); // add x0, x0, w2, uxtb #5: reserved amount
    }

    #[test]
    fn logical_bitfield_shifts() {
        // lsr x0, x1, #4 (ubfm x0, x1, #4, #63): rotr 4, then the masks
        let mut want = vec![0x20, 0, 0x20, 0, 0x29, 3, 8, 0x42, 4, 0x8a, 0x42];
        crate::jit::wasm::sleb(&mut want, 0x0fff_ffff_ffff_ffff);
        want.extend([0x83, 0x37, 3, 0]);
        assert_eq!(emit(0xd344fc20, 0).unwrap(), want);
        // sxtw x0, w1 (sbfm x0, x1, #0, #31): shl 32, shr_s 32
        #[rustfmt::skip]
        let want = [0x20, 0, 0x20, 0, 0x29, 3, 8, 0x42, 32, 0x86, 0x42, 32, 0x87, 0x37, 3, 0];
        assert_eq!(emit(0x93407c20, 0).unwrap(), want);
        // lslv w0, w1, w2: i32.shl takes the amount modulo 32
        #[rustfmt::skip]
        let want = [0x20, 0, 0x20, 0, 0x28, 2, 8, 0x20, 0, 0x28, 2, 16, 0x74, 0xad, 0x37, 3, 0];
        assert_eq!(emit(0x1ac22020, 0).unwrap(), want);
        // tst w1, #1 (ands wzr, w1, #1): N and Z only, stored to NZCV
        let b = emit(0x7200003f, 0).unwrap();
        assert!(b.ends_with(&[0xad, 0x37, 3, 0x88, 2]));
        assert_eq!(emit(0x92400000 | 0x3f << 10, 0), None); // and x0, x0, #<all ones>: reserved
        assert_eq!(emit(0x13400000, 0), None); // sbfm w0, w0, #0, #0 with N = 1: UNDEFINED
    }

    #[test]
    fn conditional() {
        // csel x0, x1, x2, eq: x1, x2, NZCV & Z, select
        #[rustfmt::skip]
        let want = [
            0x20, 0, 0x20, 0, 0x29, 3, 8, 0x20, 0, 0x29, 3, 16,
            0x20, 0, 0x28, 2, 0x88, 2, 0x41, 0x80, 0x80, 0x80, 0x80, 0x04, 0x71, 0x1b, 0x37, 3, 0,
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
            0x20, 0, 0x20, 1, 0x42, 4, 0x7c, 0x37, 3, 0xf0, 1,
            0x20, 0, 0x20, 1, 0x42, 0x7c, 0x7c, 0x37, 3, 0x80, 2,
        ];
        assert_eq!(emit(0x97ffffff, 0).unwrap(), want);
        // cbnz w3, .+16: the target, the next PC, w3 != 0, select
        #[rustfmt::skip]
        let want = [
            0x20, 0, 0x20, 1, 0x42, 16, 0x7c, 0x20, 1, 0x42, 4, 0x7c,
            0x20, 0, 0x28, 2, 24, 0x45, 0x45, 0x1b, 0x37, 3, 0x80, 2,
        ];
        assert_eq!(emit(0x35000083, 0).unwrap(), want);
        // blr x30: the PC from x30 before x30 is written
        #[rustfmt::skip]
        let want = [
            0x20, 0, 0x20, 0, 0x29, 3, 0xf0, 1, 0x37, 3, 0x80, 2,
            0x20, 0, 0x20, 1, 0x42, 4, 0x7c, 0x37, 3, 0xf0, 1,
        ];
        assert_eq!(emit(0xd63f03c0, 0).unwrap(), want);
    }

    #[test]
    fn multiply_divide_bits() {
        // mul x0, x1, x2 (madd x0, x1, x2, xzr)
        #[rustfmt::skip]
        let want = [
            0x20, 0, 0x42, 0, 0x20, 0, 0x29, 3, 8, 0x20, 0, 0x29, 3, 16, 0x7e, 0x7c, 0x37, 3, 0,
        ];
        assert_eq!(emit(0x9b027c20, 0).unwrap(), want);
        // udiv w0, w1, w2: w2 == 0 ? 0 : w1 / w2
        #[rustfmt::skip]
        let want = [
            0x20, 0, 0x20, 0, 0x28, 2, 8, 0x21, 6, 0x20, 0, 0x28, 2, 16, 0x22, 7, 0x45,
            0x04, I32, 0x41, 0, 0x05, 0x20, 6, 0x20, 7, 0x6e, 0x0b, 0xad, 0x37, 3, 0,
        ];
        assert_eq!(emit(0x1ac20820, 0).unwrap(), want);
        // clz x0, x1
        assert_eq!(
            emit(0xdac01020, 0).unwrap(),
            [0x20, 0, 0x20, 0, 0x29, 3, 8, 0x79, 0x37, 3, 0]
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
            0x20, 0, 0x29, 3, 8, 0x21, 3,           // BASE = x1
            0x20, 3, 0x42, 8, 0x7c, 0x21, 2,        // ADDR = BASE + 8
            0x20, 2, 0x22, 4, 0x42, 0xf8, 0x1f, 0x58, // OFF = ADDR; OFF <= 0x1000 - 8
            0x04, 0x40, 0x20, 4, 0xa7, 0x21, 6,     // if: HOST = OFF
            0x20, 0, 0x20, 6, 0x29, 0, 0x80, 0x80, 4, 0x37, 3, 0, // x0 = [HOST + base]
            0x05, 0x20, 0, 0x41,                    // else: helper(vcpu, insn, pc)
        ];
        sleb(&mut want, insn as i32 as i64);
        want.extend([0x20, 1, 0x10, 0, 0x04, 0x40, 0x41, 0, 0x0f, 0x0b, 0x0b]);
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
