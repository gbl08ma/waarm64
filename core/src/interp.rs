//! Tier-0 interpreter: the reference semantics for A64 integer instructions.
//! FP/AdvSIMD (M2) and EL1 system instructions (M3) come back as
//! [`Exit::Unimplemented`].

mod float;
mod ldst;
mod ldst_fp;
mod simd;
mod simd_fp;
mod simd_int;

use crate::cpu::{Cpu, FPCR_MASK, FPSR_MASK};
use crate::decode::{Op, decode};
use crate::mem::{Fault, Mem};

/// Why an instruction didn't retire. The PC still points at it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    /// UNDEFINED at EL0: unallocated, a reserved field value, or a feature we don't advertise.
    Undefined,
    /// Allocated, but implemented in a later milestone.
    Unimplemented(Op),
    Fault(Fault),
    Svc(u16),
    Brk(u16),
}

impl From<Fault> for Exit {
    fn from(f: Fault) -> Self {
        Exit::Fault(f)
    }
}

type R<T = ()> = Result<T, Exit>;

/// Executes one instruction at `cpu.pc`. On `Err`, the PC is unchanged.
// ponytail: fetch + decode every instruction; add a decoded-block cache if the
// M1 MIPS baseline says the interpreter matters beyond being the JIT's fallback.
pub fn step(cpu: &mut Cpu, mem: &Mem) -> R {
    let pc = cpu.pc;
    if pc & 3 != 0 {
        return Err(Exit::Fault(Fault::Align { addr: pc }));
    }
    let insn = mem.read(pc, 4)? as u32;
    cpu.pc = pc.wrapping_add(4);
    let r = exec(cpu, mem, insn, pc);
    if r.is_err() {
        cpu.pc = pc;
    }
    r
}

/// Runs up to `n` instructions; returns how many retired and why it stopped early.
pub fn run(cpu: &mut Cpu, mem: &Mem, n: u64) -> (u64, R) {
    for done in 0..n {
        if let Err(e) = step(cpu, mem) {
            return (done, Err(e));
        }
    }
    (n, Ok(()))
}

// Field helpers.
#[inline]
fn bits(i: u32, hi: u32, lo: u32) -> u32 {
    (i >> lo) & ((1 << (hi - lo + 1)) - 1)
}

#[inline]
fn bit(i: u32, n: u32) -> bool {
    (i >> n) & 1 == 1
}

/// Sign-extends the low `n` bits of `v`.
#[inline]
fn sext(v: u64, n: u32) -> u64 {
    (((v << (64 - n)) as i64) >> (64 - n)) as u64
}

/// Truncates to the operation size: 64 bits if `sf`, else 32 (upper bits zero).
#[inline]
fn trunc(v: u64, sf: bool) -> u64 {
    if sf { v } else { v as u32 as u64 }
}

#[inline]
fn width(sf: bool) -> u32 {
    if sf { 64 } else { 32 }
}

fn nzcv(n: bool, z: bool, c: bool, v: bool) -> u64 {
    (n as u64) << 31 | (z as u64) << 30 | (c as u64) << 29 | (v as u64) << 28
}

/// AddWithCarry: result and NZCV.
fn add_with_carry(x: u64, y: u64, carry: bool, sf: bool) -> (u64, u64) {
    if sf {
        let (r1, c1) = x.overflowing_add(y);
        let (r, c2) = r1.overflowing_add(carry as u64);
        let v = ((x ^ r) & (y ^ r)) >> 63 == 1;
        (r, nzcv(r >> 63 == 1, r == 0, c1 | c2, v))
    } else {
        let (x, y) = (x as u32, y as u32);
        let (r1, c1) = x.overflowing_add(y);
        let (r, c2) = r1.overflowing_add(carry as u32);
        let v = ((x ^ r) & (y ^ r)) >> 31 == 1;
        (r as u64, nzcv(r >> 31 == 1, r == 0, c1 | c2, v))
    }
}

/// ConditionHolds.
fn cond_holds(nzcv: u64, cond: u32) -> bool {
    let (n, z, c, v) = (
        bit(nzcv as u32, 31),
        bit(nzcv as u32, 30),
        bit(nzcv as u32, 29),
        bit(nzcv as u32, 28),
    );
    let r = match cond >> 1 {
        0 => z,
        1 => c,
        2 => n,
        3 => v,
        4 => c && !z,
        5 => n == v,
        6 => n == v && !z,
        _ => true,
    };
    if cond & 1 == 1 && cond != 15 { !r } else { r }
}

fn ror(v: u64, amt: u32, sf: bool) -> u64 {
    if sf {
        v.rotate_right(amt)
    } else {
        (v as u32).rotate_right(amt) as u64
    }
}

/// ShiftReg with shift type LSL/LSR/ASR/ROR; `amt` < operation width.
fn shift(v: u64, ty: u32, amt: u32, sf: bool) -> u64 {
    let v = trunc(v, sf);
    trunc(
        match ty {
            0 => v << amt,
            1 => v >> amt,
            2 if sf => ((v as i64) >> amt) as u64,
            2 => ((v as u32 as i32) >> amt) as u64,
            _ => ror(v, amt, sf),
        },
        sf,
    )
}

/// ExtendReg: UXTB..SXTX by `option`, then shifted left by `amt` (≤ 4).
fn extend(v: u64, option: u32, amt: u32) -> u64 {
    let v = match option {
        0 => v as u8 as u64,
        1 => v as u16 as u64,
        2 => v as u32 as u64,
        3 => v,
        4 => v as i8 as u64,
        5 => v as i16 as u64,
        6 => v as i32 as u64,
        _ => v,
    };
    v << amt
}

fn ones(n: u32) -> u64 {
    if n >= 64 { u64::MAX } else { (1 << n) - 1 }
}

fn replicate(v: u64, esize: u32) -> u64 {
    let mut r = v;
    let mut e = esize;
    while e < 64 {
        r |= r << e;
        e *= 2;
    }
    r
}

/// DecodeBitMasks: (wmask, tmask), or `None` for a reserved encoding.
fn bit_masks(n: u32, imms: u32, immr: u32, immediate: bool) -> Option<(u64, u64)> {
    let x = (n << 6) | (!imms & 0x3f);
    if x == 0 {
        return None;
    }
    let len = 31 - x.leading_zeros();
    if len < 1 {
        return None;
    }
    let levels = (1u32 << len) - 1;
    if immediate && imms & levels == levels {
        return None;
    }
    let (s, r) = (imms & levels, immr & levels);
    let esize = 1u32 << len;
    let d = s.wrapping_sub(r) & levels;
    let welem = ones(s + 1);
    let telem = ones(d + 1);
    let rot = if r == 0 {
        welem
    } else {
        ((welem >> r) | (welem << (esize - r))) & ones(esize)
    };
    Some((replicate(rot, esize), replicate(telem, esize)))
}

/// ADR/ADRP immediate: immhi:immlo, sign-extended.
fn adr_imm(i: u32) -> u64 {
    sext(((bits(i, 23, 5) << 2) | bits(i, 30, 29)) as u64, 21)
}

fn exec(c: &mut Cpu, m: &Mem, i: u32, pc: u64) -> R {
    use Op::*;
    let sf = bit(i, 31);
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let op = decode(i);
    match op {
        // PC-relative addressing.
        ADR => c.set_reg(rd, pc.wrapping_add(adr_imm(i))),
        ADRP => c.set_reg(rd, (pc & !0xfff).wrapping_add(adr_imm(i) << 12)),

        // Add/subtract.
        ADD_imm | ADDS_imm | SUB_imm | SUBS_imm => {
            let imm = bits(i, 21, 10) as u64;
            let imm = match bits(i, 23, 22) {
                0 => imm,
                1 => imm << 12,
                _ => return Err(Exit::Undefined),
            };
            addsub(c, i, c.reg_sp(rn), imm, true);
        }
        ADD_shift | ADDS_shift | SUB_shift | SUBS_shift => {
            if bits(i, 23, 22) == 3 {
                return Err(Exit::Undefined);
            }
            let y = shifted_operand(c, i)?;
            addsub(c, i, c.reg(rn), y, false);
        }
        ADD_ext | ADDS_ext | SUB_ext | SUBS_ext => {
            let amt = bits(i, 12, 10);
            if amt > 4 {
                return Err(Exit::Undefined);
            }
            let y = extend(c.reg(rm), bits(i, 15, 13), amt);
            addsub(c, i, c.reg_sp(rn), y, true);
        }
        ADC | ADCS | SBC | SBCS => {
            let y = if bit(i, 30) { !c.reg(rm) } else { c.reg(rm) };
            let (r, f) = add_with_carry(c.reg(rn), y, bit(c.nzcv as u32, 29), sf);
            if bit(i, 29) {
                c.nzcv = f;
            }
            c.set_reg(rd, r);
        }

        // Logical.
        AND_imm | ORR_imm | EOR_imm | ANDS_imm => {
            let n = bits(i, 22, 22);
            if !sf && n == 1 {
                return Err(Exit::Undefined);
            }
            let (imm, _) =
                bit_masks(n, bits(i, 15, 10), bits(i, 21, 16), true).ok_or(Exit::Undefined)?;
            logical(c, i, c.reg(rn), imm, true);
        }
        AND_shift | BIC_shift | ORR_shift | ORN_shift | EOR_shift | EON | ANDS_shift | BICS => {
            let y = shifted_operand(c, i)?;
            logical(c, i, c.reg(rn), if bit(i, 21) { !y } else { y }, false);
        }

        // Move wide.
        MOVN | MOVZ | MOVK => {
            let hw = bits(i, 22, 21);
            if !sf && hw >= 2 {
                return Err(Exit::Undefined);
            }
            let (sh, imm) = (hw * 16, bits(i, 20, 5) as u64);
            let v = match op {
                MOVN => !(imm << sh),
                MOVZ => imm << sh,
                _ => (c.reg(rd) & !(0xffff << sh)) | imm << sh,
            };
            c.set_reg(rd, trunc(v, sf));
        }

        // Bitfield and extract.
        SBFM | BFM | UBFM | ASR_1 | ASR_2 | SXTB_1 | SXTB_2 | SXTH_1 | SXTH_2 | SXTW => {
            let (n, immr, imms) = (bits(i, 22, 22), bits(i, 21, 16), bits(i, 15, 10));
            if (sf && n != 1) || (!sf && (n != 0 || immr >= 32 || imms >= 32)) {
                return Err(Exit::Undefined);
            }
            if bits(i, 30, 29) == 3 {
                return Err(Exit::Undefined);
            }
            let (wmask, tmask) = bit_masks(n, imms, immr, false).ok_or(Exit::Undefined)?;
            let src = c.reg(rn);
            let bot = ror(trunc(src, sf), immr, sf) & wmask;
            let r = match bits(i, 30, 29) {
                0 => {
                    // SBFM: the top is copies of bit `imms` of the source.
                    let top = if (src >> imms) & 1 == 1 { u64::MAX } else { 0 };
                    (top & !tmask) | (bot & tmask)
                }
                1 => {
                    let dst = c.reg(rd);
                    let bot = (dst & !wmask) | bot;
                    (dst & !tmask) | (bot & tmask)
                }
                _ => bot & tmask,
            };
            c.set_reg(rd, trunc(r, sf));
        }
        EXTR => {
            let (n, lsb) = (bit(i, 22), bits(i, 15, 10));
            if n != sf || (!sf && lsb >= 32) {
                return Err(Exit::Undefined);
            }
            let (hi, lo) = (c.reg(rn), c.reg(rm));
            let r = if sf {
                ((((hi as u128) << 64) | lo as u128) >> lsb) as u64
            } else {
                ((((hi as u32 as u64) << 32) | lo as u32 as u64) >> lsb) as u32 as u64
            };
            c.set_reg(rd, r);
        }

        // Data processing, 2 source.
        UDIV | SDIV => {
            let (x, y) = (trunc(c.reg(rn), sf), trunc(c.reg(rm), sf));
            let r = match (op, sf) {
                _ if y == 0 => 0,
                (UDIV, _) => x / y,
                (_, true) => (x as i64).wrapping_div(y as i64) as u64,
                (_, false) => (x as u32 as i32).wrapping_div(y as u32 as i32) as u32 as u64,
            };
            c.set_reg(rd, r);
        }
        LSLV | LSRV | ASRV | RORV => {
            let amt = (c.reg(rm) % width(sf) as u64) as u32;
            c.set_reg(rd, shift(c.reg(rn), bits(i, 11, 10), amt, sf));
        }
        CRC32 | CRC32C => {
            let sz = bits(i, 11, 10);
            if sf != (sz == 3) {
                return Err(Exit::Undefined);
            }
            let poly = if op == CRC32 {
                0xedb8_8320
            } else {
                0x82f6_3b78
            };
            let mut acc = c.reg(rn) as u32;
            let data = c.reg(rm);
            for b in 0..(1u32 << sz) {
                acc ^= (data >> (8 * b)) as u8 as u32;
                for _ in 0..8 {
                    acc = (acc >> 1) ^ (poly & (acc & 1).wrapping_neg());
                }
            }
            c.set_reg(rd, acc as u64);
        }

        // Data processing, 1 source.
        RBIT_int => {
            let x = c.reg(rn);
            c.set_reg(
                rd,
                if sf {
                    x.reverse_bits()
                } else {
                    (x as u32).reverse_bits() as u64
                },
            );
        }
        REV16_int => {
            let x = c.reg(rn);
            let m8 = 0x00ff_00ff_00ff_00ff;
            c.set_reg(rd, trunc(((x & m8) << 8) | ((x >> 8) & m8), sf));
        }
        REV32_int => {
            let x = c.reg(rn);
            c.set_reg(
                rd,
                (x as u32).swap_bytes() as u64 | (((x >> 32) as u32).swap_bytes() as u64) << 32,
            );
        }
        REV => {
            let x = c.reg(rn);
            let r = match (sf, bit(i, 10)) {
                (false, false) => (x as u32).swap_bytes() as u64,
                (true, true) => x.swap_bytes(),
                _ => return Err(Exit::Undefined),
            };
            c.set_reg(rd, r);
        }
        CLZ_int => {
            let x = c.reg(rn);
            c.set_reg(
                rd,
                if sf {
                    x.leading_zeros()
                } else {
                    (x as u32).leading_zeros()
                } as u64,
            );
        }
        CLS_int => {
            let x = c.reg(rn);
            let r = if sf {
                ((x ^ (x >> 1)) & (u64::MAX >> 1)).leading_zeros() - 1
            } else {
                let x = x as u32;
                ((x ^ (x >> 1)) & (u32::MAX >> 1)).leading_zeros() - 1
            };
            c.set_reg(rd, r as u64);
        }

        // Data processing, 3 source.
        MADD | MSUB => {
            let p = c.reg(rn).wrapping_mul(c.reg(rm));
            let a = c.reg(bits(i, 14, 10));
            c.set_reg(
                rd,
                trunc(
                    if op == MADD {
                        a.wrapping_add(p)
                    } else {
                        a.wrapping_sub(p)
                    },
                    sf,
                ),
            );
        }
        SMADDL | SMSUBL | UMADDL | UMSUBL => {
            let (x, y) = if matches!(op, SMADDL | SMSUBL) {
                (c.reg(rn) as i32 as u64, c.reg(rm) as i32 as u64)
            } else {
                (c.reg(rn) as u32 as u64, c.reg(rm) as u32 as u64)
            };
            let (p, a) = (x.wrapping_mul(y), c.reg(bits(i, 14, 10)));
            c.set_reg(
                rd,
                if bit(i, 15) {
                    a.wrapping_sub(p)
                } else {
                    a.wrapping_add(p)
                },
            );
        }
        SMULH => c.set_reg(
            rd,
            ((c.reg(rn) as i64 as i128 * c.reg(rm) as i64 as i128) >> 64) as u64,
        ),
        UMULH => c.set_reg(rd, ((c.reg(rn) as u128 * c.reg(rm) as u128) >> 64) as u64),

        // Conditional compare and select.
        CCMN_reg | CCMP_reg | CCMN_imm | CCMP_imm => {
            if cond_holds(c.nzcv, bits(i, 15, 12)) {
                let y = if bit(i, 11) { rm as u64 } else { c.reg(rm) };
                let sub = bit(i, 30);
                c.nzcv = add_with_carry(c.reg(rn), if sub { !y } else { y }, sub, sf).1;
            } else {
                c.nzcv = (bits(i, 3, 0) as u64) << 28;
            }
        }
        CSEL | CSINC | CSINV | CSNEG => {
            let r = if cond_holds(c.nzcv, bits(i, 15, 12)) {
                c.reg(rn)
            } else {
                let y = c.reg(rm);
                match op {
                    CSEL => y,
                    CSINC => y.wrapping_add(1),
                    CSINV => !y,
                    _ => y.wrapping_neg(),
                }
            };
            c.set_reg(rd, trunc(r, sf));
        }

        // Branches.
        B_uncond => c.pc = pc.wrapping_add(sext((bits(i, 25, 0) << 2) as u64, 28)),
        BL => {
            c.x[30] = pc.wrapping_add(4);
            c.pc = pc.wrapping_add(sext((bits(i, 25, 0) << 2) as u64, 28));
        }
        B_cond => {
            if cond_holds(c.nzcv, bits(i, 3, 0)) {
                c.pc = pc.wrapping_add(sext((bits(i, 23, 5) << 2) as u64, 21));
            }
        }
        CBZ | CBNZ => {
            if (trunc(c.reg(rd), sf) == 0) == (op == CBZ) {
                c.pc = pc.wrapping_add(sext((bits(i, 23, 5) << 2) as u64, 21));
            }
        }
        TBZ | TBNZ => {
            let b = (bits(i, 31, 31) << 5) | bits(i, 23, 19);
            if ((c.reg(rd) >> b) & 1 == 0) == (op == TBZ) {
                c.pc = pc.wrapping_add(sext((bits(i, 18, 5) << 2) as u64, 16));
            }
        }
        BR | RET => c.pc = c.reg(rn),
        BLR => {
            c.pc = c.reg(rn);
            c.x[30] = pc.wrapping_add(4);
        }

        // Hints, barriers, exceptions, NZCV. Unallocated hints and the PAC/BTI
        // hint-space instructions are NOPs (PLAN.md §1). WFE/WFI may complete at
        // once; M3 gives them wake-up semantics.
        NOP | YIELD | WFE | WFI | SEV | SEVL | HINT | XPAC_2 | PACIA_2 | PACIB_2 | AUTIA_2
        | AUTIB_2 | BTI | ESB | PSB | TSB | CSDB | DGH => {}
        CLREX => c.monitor.size = 0,
        DMB | DSB | SSBB | PSSBB => core::sync::atomic::fence(core::sync::atomic::Ordering::SeqCst),
        ISB => {}
        SVC => return Err(Exit::Svc(bits(i, 20, 5) as u16)),
        BRK => return Err(Exit::Brk(bits(i, 20, 5) as u16)),
        MRS | MSR_reg if bits(i, 20, 5) == 0xda10 => {
            // NZCV (op0=3 op1=3 CRn=4 CRm=2 op2=0). Other registers are M2/M3.
            if op == MRS {
                c.set_reg(rd, c.nzcv);
            } else {
                c.nzcv = c.reg(rd) & 0xf000_0000;
            }
        }
        // FPCR (op0=3 op1=3 CRn=4 CRm=4 op2=0) and FPSR (op2=1).
        MRS | MSR_reg if bits(i, 20, 6) == 0xda20 >> 1 => {
            let x = c.reg(rd);
            let (reg, mask) = if bit(i, 5) {
                (&mut c.fpsr, FPSR_MASK)
            } else {
                (&mut c.fpcr, FPCR_MASK)
            };
            if op == MSR_reg {
                *reg = x & mask;
            } else {
                let v = *reg;
                c.set_reg(rd, v);
            }
        }
        DC_ZVA => {
            // DCZID_EL0.BS = 4: 64-byte blocks (as on the M4).
            let a = c.reg(rd) & !63;
            for k in 0..8 {
                m.write(a + 8 * k, 8, 0)?;
            }
        }
        // Cache maintenance permitted at EL0: nothing to do on flat memory
        // without caches. M5 hooks JIT invalidation into IC IVAU.
        DC_CVAC | DC_CVAU | DC_CIVAC | IC_IVAU => {}

        // Loads and stores.
        LDR_lit_gen | LDRSW_lit | PRFM_lit | STNP_LDNP_gen | STP_LDP_gen | STURx_LDURx
        | STRx_LDRx_imm_1 | STRx_LDRx_imm_2 | PRFM_imm | PRFM_unscaled_imm | STRx_reg
        | LDRx_reg | STTRB | LDTRB | LDTRSB | STTRH | LDTRH | LDTRSH | STTR | LDTR | LDTRSW
        | STXR | STLXR | STXP | STLXP | LDXR | LDAXR | LDXP | LDAXP | STLR | LDAR | CAS | CASB
        | CASH | CASP | LDADDB | LDCLRB | LDEORB | LDSETB | LDSMAXB | LDSMINB | LDUMAXB
        | LDUMINB | SWPB | LDADDH | LDCLRH | LDEORH | LDSETH | LDSMAXH | LDSMINH | LDUMAXH
        | LDUMINH | SWPH | LDADD | LDCLR | LDEOR | LDSET | LDSMAX | LDSMIN | LDUMAX | LDUMIN
        | SWP => ldst::exec(c, m, i, pc, op)?,
        LDR_lit_fpsimd | STNP_LDNP_fpsimd | STP_LDP_fpsimd | STUR_fpsimd | LDUR_fpsimd
        | STR_imm_fpsimd_1 | STR_imm_fpsimd_2 | LDR_imm_fpsimd_1 | LDR_imm_fpsimd_2
        | STR_reg_fpsimd | LDR_reg_fpsimd | STx_mult_1 | STx_mult_2 | LDx_mult_1 | LDx_mult_2
        | ST1_sngl_1 | ST1_sngl_2 | ST2_sngl_1 | ST2_sngl_2 | ST3_sngl_1 | ST3_sngl_2
        | ST4_sngl_1 | ST4_sngl_2 | LD1_sngl_1 | LD1_sngl_2 | LD2_sngl_1 | LD2_sngl_2
        | LD3_sngl_1 | LD3_sngl_2 | LD4_sngl_1 | LD4_sngl_2 | LD1R_1 | LD1R_2 | LD2R_1 | LD2R_2
        | LD3R_1 | LD3R_2 | LD4R_1 | LD4R_2 => ldst_fp::exec(c, m, i, pc, op)?,

        // Scalar floating point.
        FCVT_float | SCVTF_float_int | UCVTF_float_int | SCVTF_float_fix | UCVTF_float_fix
        | FCVTNS_float | FCVTNU_float | FCVTAS_float | FCVTAU_float | FCVTPS_float
        | FCVTPU_float | FCVTMS_float | FCVTMU_float | FCVTZS_float_int | FCVTZU_float_int
        | FCVTZS_float_fix | FCVTZU_float_fix | FCMP_float | FCMPE_float | FCCMP_float
        | FCCMPE_float | FCSEL_float | FABS_float | FNEG_float | FSQRT_float | FRINTN_float
        | FRINTP_float | FRINTM_float | FRINTZ_float | FRINTA_float | FRINTX_float
        | FRINTI_float | FMUL_float | FNMUL_float | FDIV_float | FADD_float | FSUB_float
        | FMAX_float | FMIN_float | FMAXNM_float | FMINNM_float | FMADD_float | FMSUB_float
        | FNMADD_float | FNMSUB_float => float::exec(c, i, op)?,

        // AdvSIMD and FP moves.
        DUP_elt_1 | DUP_elt_2 | DUP_gen | SMOV | UMOV | INS_gen | INS_elt | MOVI | FMOV_2
        | FMOV_float_gen | FMOV_float | FMOV_float_imm => simd::exec(c, i, op)?,

        // Unallocated, or features PLAN.md §1 leaves out (PAC, BTI, MTE, SB,
        // v8.2+ flag manipulation, RCpc, LOR, DPB, LS64, WFxT, FP16).
        UnallocatedEncoding | ADDG | SUBG | PACIA_1 | PACIB_1 | AUTIA_1 | AUTIB_1 | PACDA
        | PACDB | AUTDA | AUTDB | XPAC_1 | PACGA | BLRA | BRA | RETA | ERETA | LDRA | SUBP
        | SUBPS | IRG | GMI | STGP_1 | STGP_2 | STGP_3 | STG_1 | STG_2 | STG_3 | LDG | STZG_1
        | STZG_2 | STZG_3 | ST2G_1 | ST2G_2 | ST2G_3 | STZ2G_1 | STZ2G_2 | STZ2G_3 | STGV
        | LDGV | SB | CFINV | RMIF | SETF8 | SETF16 | XAFlag | AXFlag | LDAPRB | LDAPRH | LDAPR
        | STLLR | LDLAR | DC_CVAP | LD64B | ST64B | ST64BV | ST64BV0 | WFET | WFIT | FMOV_3 => {
            return Err(Exit::Undefined);
        }
        // FP/AdvSIMD beyond v8.0: RDM, DotProd, I8MM, FCMA, FHM, FRINTTS, JSCVT,
        // BF16, SHA3, SHA512, SM3, SM4. The v8.0 crypto instructions (AES, SHA1,
        // SHA256, 64-bit PMULL) come in M6.5 and are UNDEFINED until then.
        SQRDMLAH_vec_1 | SQRDMLAH_vec_2 | SQRDMLSH_vec_1 | SQRDMLSH_vec_2 | SQRDMLAH_elt_1
        | SQRDMLSH_elt_1 | SQRDMLAH_elt_2 | SQRDMLSH_elt_2 | SDOT_vec | UDOT_vec | SDOT_elt
        | UDOT_elt | SMMLA_vec | UMMLA_vec | USMMLA_vec | SUDOT_element | USDOT_element
        | USDOT_vec | FCMLA_vec | FCADD_vec | FCMLA_elt | FMLAL_vec_1 | FMLSL_vec_1
        | FMLAL_vec_2 | FMLSL_vec_2 | FMLAL_elt_1 | FMLAL_elt_2 | FMLSL_elt_1 | FMLSL_elt_2
        | FRINT32X_1 | FRINT64X_1 | FRINT32Z_1 | FRINT64Z_1 | FRINT32X_float | FRINT64X_float
        | FRINT32Z_float | FRINT64Z_float | FJCVTZS | BFCVT | BFCVTN | BFDOT_element
        | BFDOT_vec | BFMLALX_element | BFMLALX_vector | BFMMLA | SHA512H | SHA512H2
        | SHA512SU1 | SHA512SU0 | RAX1 | XAR | EOR3 | BCAX | SM3TT1A | SM3TT1B | SM3TT2A
        | SM3TT2B | SM3PARTW1 | SM3PARTW2 | SM3SS1 | SM4EKEY | SM4E | AESE | AESD | AESMC
        | AESIMC | SHA1C | SHA1P | SHA1M | SHA1SU0 | SHA256H | SHA256H2 | SHA256SU1 | SHA1H
        | SHA1SU1 | SHA256SU0 => return Err(Exit::Undefined),
        // Half-precision AdvSIMD arithmetic (FEAT_FP16).
        FMULX_vec_1 | FCMEQ_reg_1 | FRECPS_1 | FRSQRTS_1 | FCMGE_reg_1 | FACGE_1 | FABD_1
        | FCMGT_reg_1 | FACGT_1 | FCVTNS_1 | FCVTMS_1 | FCVTAS_1 | SCVTF_int_1 | FCMGT_zero_1
        | FCMEQ_zero_1 | FCMLT_1 | FCVTPS_1 | FCVTZS_int_1 | FRECPE_1 | FRECPX_1 | FCVTNU_1
        | FCVTMU_1 | FCVTAU_1 | UCVTF_int_1 | FCMGE_zero_1 | FCMLE_1 | FCVTPU_1 | FCVTZU_int_1
        | FRSQRTE_1 | FMAXNMP_pair_1 | FADDP_pair_1 | FMAXP_pair_1 | FMINNMP_pair_1
        | FMINP_pair_1 | FMLA_elt_1 | FMLS_elt_1 | FMUL_elt_1 | FMULX_elt_1 | FMULX_vec_3
        | FCMEQ_reg_3 | FRECPS_3 | FRSQRTS_3 | FCMGE_reg_3 | FACGE_3 | FABD_3 | FCMGT_reg_3
        | FACGT_3 | FMAXNM_1 | FMLA_vec_1 | FADD_1 | FMAX_1 | FMINNM_1 | FMLS_vec_1 | FSUB_1
        | FMIN_1 | FMAXNMP_vec_1 | FADDP_vec_1 | FMUL_vec_1 | FMAXP_vec_1 | FDIV_1
        | FMINNMP_vec_1 | FMINP_vec_1 | FRINTN_1 | FRINTM_1 | FCVTNS_3 | FCVTMS_3 | FCVTAS_3
        | SCVTF_int_3 | FCMGT_zero_3 | FCMEQ_zero_3 | FCMLT_3 | FABS_1 | FRINTP_1 | FRINTZ_1
        | FCVTPS_3 | FCVTZS_int_3 | FRECPE_3 | FRINTA_1 | FRINTX_1 | FCVTNU_3 | FCVTMU_3
        | FCVTAU_3 | UCVTF_int_3 | FNEG_1 | FRINTI_1 | FCMGE_zero_3 | FCMLE_3 | FCVTPU_3
        | FCVTZU_int_3 | FRSQRTE_3 | FSQRT_1 | FMAXNMV_1 | FMAXV_1 | FMINNMV_1 | FMINV_1
        | FMLA_elt_3 | FMLS_elt_3 | FMUL_elt_3 | FMULX_elt_3 => return Err(Exit::Undefined),

        // AdvSIMD integer and FP; EL1 system instructions (M3) are still unimplemented.
        _ => match simd_int::handler(op).or_else(|| simd_fp::handler(op)) {
            Some(f) => f(c, i)?,
            None => return Err(Exit::Unimplemented(op)),
        },
    }
    Ok(())
}

/// Shifted-register operand (Rm, shift type 23:22, amount 15:10).
fn shifted_operand(c: &Cpu, i: u32) -> R<u64> {
    let (sf, amt) = (bit(i, 31), bits(i, 15, 10));
    if !sf && amt >= 32 {
        return Err(Exit::Undefined);
    }
    Ok(shift(c.reg(bits(i, 20, 16)), bits(i, 23, 22), amt, sf))
}

/// ADD/ADDS/SUB/SUBS (op in bit 30, S in bit 29). Without S, Rd 31 is SP if `sp_dest`.
fn addsub(c: &mut Cpu, i: u32, x: u64, y: u64, sp_dest: bool) {
    let (sf, sub, s, rd) = (bit(i, 31), bit(i, 30), bit(i, 29), bits(i, 4, 0));
    let (r, f) = add_with_carry(x, if sub { !y } else { y }, sub, sf);
    if s {
        c.nzcv = f;
        c.set_reg(rd, r);
    } else if sp_dest {
        c.set_reg_sp(rd, r);
    } else {
        c.set_reg(rd, r);
    }
}

/// AND/ORR/EOR/ANDS (opc in 30:29). Without S, Rd 31 is SP if `sp_dest`.
fn logical(c: &mut Cpu, i: u32, x: u64, y: u64, sp_dest: bool) {
    let (sf, rd) = (bit(i, 31), bits(i, 4, 0));
    let opc = bits(i, 30, 29);
    let r = trunc(
        match opc {
            0 | 3 => x & y,
            1 => x | y,
            _ => x ^ y,
        },
        sf,
    );
    if opc == 3 {
        c.nzcv = nzcv((r >> (width(sf) - 1)) & 1 == 1, r == 0, false, false);
        c.set_reg(rd, r);
    } else if sp_dest {
        c.set_reg_sp(rd, r);
    } else {
        c.set_reg(rd, r);
    }
}

#[cfg(test)]
mod tests;
