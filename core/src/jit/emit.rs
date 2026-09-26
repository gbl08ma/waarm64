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
        // MOV (register): ORR Rd, ZR, Rm with no shift.
        ORR_shift if rn == 31 && !bit(i, 21) && bits(i, 15, 10) == 0 => {
            set(c, sf, rd, |c| get(c, sf, rm));
        }
        _ => return false,
    }
    true
}

// i32 opcodes. The i64 twin of an arithmetic one is `W` higher, of a
// comparison `WC` higher.
const W: u8 = 0x12;
const WC: u8 = 0xb;
const ADD: u8 = 0x6a;
const SUB: u8 = 0x6b;
const AND: u8 = 0x71;
const OR: u8 = 0x72;
const XOR: u8 = 0x73;
const SHL: u8 = 0x74;
const SHR_S: u8 = 0x75;
const SHR_U: u8 = 0x76;
const ROTR: u8 = 0x78;
const EQZ: u8 = 0x45;
const EQ: u8 = 0x46;
const LT_U: u8 = 0x49;
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
    // AddWithCarry(x, sub ? !y : y, sub).
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
    set(c, sf, rd, |c| {
        c.local_get(tr);
    });
    add_flags(
        c,
        sf,
        tx,
        ty,
        tr,
        if sub { Carry::One } else { Carry::Zero },
    );
}

/// Stores AddWithCarry's NZCV for `r` = `x` + `y` + carry (locals of the
/// operation size): C is `r < x` unsigned, or `r <= x` with a carry in; V is
/// the sign of `(x ^ r) & (y ^ r)`.
fn add_flags(c: &mut Code, sf: bool, x: u32, y: u32, r: u32, carry: Carry) {
    c.local_get(VCPU);
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
    c.op(OR).i64_extend_i32_u().i64_store(NZCV);
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

/// Pushes the shifted-register operand (Rm, shift type 23:22, amount 15:10).
fn shifted(c: &mut Code, i: u32) {
    let (sf, amt) = (bit(i, 31), bits(i, 15, 10));
    get(c, sf, bits(i, 20, 16));
    if amt != 0 {
        konst(c, sf, amt as u64);
        arith(c, sf, [SHL, SHR_U, SHR_S, ROTR][bits(i, 23, 22) as usize]);
    }
}

/// Pushes the extended-register operand (Rm, option 15:13, left shift 12:10 ≤ 4).
fn extended(c: &mut Code, i: u32) {
    let (sf, amt) = (bit(i, 31), bits(i, 12, 10));
    get(c, sf, bits(i, 20, 16));
    match (bits(i, 15, 13), sf) {
        (0, _) => mask(c, sf, 0xff),
        (1, _) => mask(c, sf, 0xffff),
        (2, true) => mask(c, sf, 0xffff_ffff),
        // i32/i64.extend8_s, extend16_s, i64.extend32_s.
        (4, _) => drop(c.op(if sf { 0xc2 } else { 0xc0 })),
        (5, _) => drop(c.op(if sf { 0xc3 } else { 0xc1 })),
        (6, true) => drop(c.op(0xc4)),
        _ => {} // UXTW/SXTW at 32 bits, UXTX/SXTX
    }
    if amt != 0 {
        konst(c, sf, amt as u64);
        arith(c, sf, SHL);
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
}
