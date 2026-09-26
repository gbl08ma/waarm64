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
use crate::interp::{adr_imm, bit, bits, trunc};

/// A block function's locals after its parameter (local 0, the vCPU): the
/// entry PC (local 1), then scratch: i64 in 2..=5, i32 in 6..=9.
pub const LOCALS: &[(u32, u8)] = &[(5, I64), (4, I32)];
const VCPU: u32 = 0;
const ENTRY: u32 = 1;

/// Offsets in the `Cpu`.
pub const PC: u32 = 256;

/// The `k`-th scratch local of the operation size.
#[allow(dead_code)]
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
pub fn inline(c: &mut Code, i: u32, op: Op, k: usize) -> bool {
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
                    konst(c, sf, !(0xffff << sh));
                    and(c, sf);
                    konst(c, sf, imm << sh);
                    or(c, sf);
                }),
            }
        }
        // MOV (register): ORR Rd, ZR, Rm with no shift.
        ORR_shift if rn == 31 && !bit(i, 21) && bits(i, 15, 10) == 0 => {
            set(c, sf, rd, |c| get(c, sf, rm));
        }
        _ => return false,
    }
    true
}

// i32 opcodes; the i64 twin of an arithmetic one is 0x12 higher.
const AND: u8 = 0x71;
const OR: u8 = 0x72;

/// A binary or unary arithmetic op at the operation size.
fn arith(c: &mut Code, sf: bool, op32: u8) {
    c.op(if sf { op32 + 0x12 } else { op32 });
}
fn and(c: &mut Code, sf: bool) {
    arith(c, sf, AND);
}
fn or(c: &mut Code, sf: bool) {
    arith(c, sf, OR);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::decode;

    fn emit(i: u32, k: usize) -> Option<Vec<u8>> {
        let mut c = Code::default();
        inline(&mut c, i, decode(i), k).then_some(c.b)
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
        assert_eq!(emit(0xaa0413e3, 0), None); // orr x3, xzr, x4, lsl #4: not yet
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
}
