//! AdvSIMD integer instructions and SIMD&FP register moves as wasm SIMD128
//! (M6 loop 4). Operands come from the `Cpu`'s V registers and results go
//! back there (vector registers in locals are loop 3). Each emitter mirrors
//! its interpreter handler (`interp::simd`, `interp::simd_int`): the same
//! encodings are left to the helper (UNDEFINED, or forms not covered here),
//! and the same lanes are computed; a 64-bit arrangement (Q = 0) clears the
//! top half of the result. Callers run [`super::fp_guard`] first.

use super::{Func, V, V128_LOAD, V128_STORE, VCPU, get, set};
use crate::decode::Op;
use crate::interp::simd::{adv_simd_expand_imm, vfp_expand_imm};
use crate::interp::{bit, bits};

// SIMD opcodes (0xfd-prefixed), by lane size where they come in four.
const SPLAT: [u32; 4] = [0x0f, 0x10, 0x11, 0x12];
const EXTRACT_S: [u32; 4] = [0x15, 0x18, 0x1b, 0x1d];
const EXTRACT_U: [u32; 4] = [0x16, 0x19, 0x1b, 0x1d];
const REPLACE: [u32; 4] = [0x17, 0x1a, 0x1c, 0x1e];
const ADD: [u32; 4] = [0x6e, 0x8e, 0xae, 0xce];
const SUB: [u32; 4] = [0x71, 0x91, 0xb1, 0xd1];
const MUL: [u32; 4] = [0, 0x95, 0xb5, 0xd5]; // no i8x16.mul
const SHL: [u32; 4] = [0x6b, 0x8b, 0xab, 0xcb];
const SHR_S: [u32; 4] = [0x6c, 0x8c, 0xac, 0xcc];
const SHR_U: [u32; 4] = [0x6d, 0x8d, 0xad, 0xcd];
const EQ: [u32; 4] = [0x23, 0x2d, 0x37, 0xd6];
const GT_S: [u32; 4] = [0x27, 0x31, 0x3b, 0xd9];
const GE_S: [u32; 4] = [0x2b, 0x35, 0x3f, 0xdb];
const MIN_S: [u32; 3] = [0x76, 0x96, 0xb6];
const MIN_U: [u32; 3] = [0x77, 0x97, 0xb7];
const MAX_S: [u32; 3] = [0x78, 0x98, 0xb8];
const MAX_U: [u32; 3] = [0x79, 0x99, 0xb9];
const NEG: [u32; 4] = [0x61, 0x81, 0xa1, 0xc1];
const ABS: [u32; 4] = [0x60, 0x80, 0xa0, 0xc0];
const VNOT: u32 = 0x4d;
const AND: u32 = 0x4e;
const ANDNOT: u32 = 0x4f;
const OR: u32 = 0x50;
const XOR: u32 = 0x51;
const BITSELECT: u32 = 0x52;
const POPCNT: u32 = 0x62;

/// Emits AdvSIMD instruction `i` inline if it's one this covers; false (and
/// nothing emitted) otherwise.
pub(super) fn inline(c: &mut Func, i: u32, op: Op) -> bool {
    use Op::*;
    match op {
        ADD_vector | SUB_2 | AND_asimd | BIC_asimd_reg | ORR_asimd_reg | ORN_asimd | EOR_asimd
        | BSL | BIT | BIF | CMEQ_reg_2 | CMTST_2 | CMGT_reg_2 | CMHI_2 | CMGE_reg_2 | CMHS_2
        | MUL_vec | MLA_vec | MLS_vec | SMAX | SMIN | UMAX | UMIN => three_same(c, i),
        SSHR_2 | USHR_2 | SSRA_2 | USRA_2 | SHL_2 | SLI_2 | SRI_2 => shift_imm(c, i),
        REV16_asimd | REV32_asimd | REV64_asimd | NOT | NEG_2 | ABS_2 | CNT | XTN => {
            two_misc(c, i, op)
        }
        EXT => ext(c, i),
        DUP_gen | DUP_elt_1 | DUP_elt_2 | INS_gen | INS_elt | UMOV | SMOV | MOVI | FMOV_2
        | FMOV_float_gen | FMOV_float | FMOV_float_imm => moves(c, i, op),
        _ => false,
    }
}

/// Pushes Vn.
fn vreg(c: &mut Func, n: u32) {
    c.local_get(VCPU).simd_mem(V128_LOAD, 0, V + 16 * n);
}

/// Vd = what `value` pushes, its top half cleared unless `q`.
fn put(c: &mut Func, rd: u32, q: bool, value: impl FnOnce(&mut Func)) {
    c.local_get(VCPU);
    value(c);
    if !q {
        c.i64_const(0).simd_lane(REPLACE[3], 1);
    }
    c.simd_mem(V128_STORE, 0, V + 16 * rd);
}

/// `x` (the low `esize` bits) in every `esize`-bit lane of a u128.
fn lanes_of(x: u64, esize: u32) -> u128 {
    let x = x as u128 & (u128::MAX >> (128 - esize));
    (0..128 / esize).fold(0, |v, e| v | x << (e * esize))
}

/// The three-same group, vector forms (`interp::simd_int::three_same`).
fn three_same(c: &mut Func, i: u32) -> bool {
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let (q, u, size, opc) = (
        bit(i, 30),
        bit(i, 29),
        bits(i, 23, 22) as usize,
        bits(i, 15, 11),
    );
    if bit(i, 28) {
        return false; // scalar forms
    }
    let q128 = !(size == 3 && !q);
    if opc == 0b00011 {
        // Logical: size picks AND/BIC/ORR/ORN (U=0) or EOR/BSL/BIT/BIF (U=1).
        put(c, rd, q, |c| match (u, size) {
            (false, 0) => ops(c, &[rn, rm], &[AND]),
            (false, 1) => ops(c, &[rn, rm], &[ANDNOT]),
            (false, 2) => ops(c, &[rn, rm], &[OR]),
            (false, _) => {
                vreg(c, rn);
                vreg(c, rm);
                c.simd(VNOT).simd(OR);
            }
            (true, 0) => ops(c, &[rn, rm], &[XOR]),
            // bitselect(a, b, m) = a & m | b & !m
            (true, 1) => ops(c, &[rn, rm, rd], &[BITSELECT]), // BSL: d ? n : m
            (true, 2) => ops(c, &[rn, rd, rm], &[BITSELECT]), // BIT: m ? n : d
            (true, _) => ops(c, &[rd, rn, rm], &[BITSELECT]), // BIF: m ? d : n
        });
        return true;
    }
    let ok = match opc {
        0b10000 | 0b10001 | 0b00110 | 0b00111 => q128,
        0b10010 | 0b10011 => size != 3 && size != 0 && !(opc == 0b10011 && u), // MLA/MLS/MUL; not PMUL, no i8x16.mul
        0b01100 | 0b01101 => size != 3,
        _ => false,
    };
    if !ok {
        return false;
    }
    put(c, rd, q, |c| match opc {
        0b10000 => ops(c, &[rn, rm], &[if u { SUB[size] } else { ADD[size] }]),
        // CMEQ (U), CMTST: (n & m) != 0.
        0b10001 if u => ops(c, &[rn, rm], &[EQ[size]]),
        0b10001 => {
            ops(c, &[rn, rm], &[AND]);
            c.v128_const(0).simd(EQ[size]).simd(VNOT);
        }
        // CMGT/CMGE, CMHI/CMHS (U): unsigned 64-bit lanes have no wasm compare,
        // so every unsigned one flips the sign bits and compares signed.
        0b00110 | 0b00111 => {
            let cmp = if opc == 0b00110 {
                GT_S[size]
            } else {
                GE_S[size]
            };
            if u {
                let sign = lanes_of(1 << ((8 << size) - 1), 8 << size);
                vreg(c, rn);
                c.v128_const(sign).simd(XOR);
                vreg(c, rm);
                c.v128_const(sign).simd(XOR).simd(cmp);
            } else {
                ops(c, &[rn, rm], &[cmp]);
            }
        }
        0b10011 => ops(c, &[rn, rm], &[MUL[size]]),
        // MLA, MLS (U): d ± n * m.
        0b10010 => {
            vreg(c, rd);
            ops(c, &[rn, rm], &[MUL[size]]);
            c.simd(if u { SUB[size] } else { ADD[size] });
        }
        _ => {
            let t = match (opc, u) {
                (0b01100, false) => MAX_S,
                (0b01100, true) => MAX_U,
                (_, false) => MIN_S,
                (_, true) => MIN_U,
            };
            ops(c, &[rn, rm], &[t[size]]);
        }
    });
    true
}

/// Pushes the V registers `regs`, then applies `ops`.
fn ops(c: &mut Func, regs: &[u32], ops: &[u32]) {
    for &r in regs {
        vreg(c, r);
    }
    for &o in ops {
        c.simd(o);
    }
}

/// Shifts by immediate, vector, non-rounding, non-saturating, not narrowing or
/// widening (`interp::simd_int::shift_imm`).
fn shift_imm(c: &mut Func, i: u32) -> bool {
    let (rd, rn) = (bits(i, 4, 0), bits(i, 9, 5));
    let (q, u, immh, opc) = (bit(i, 30), bit(i, 29), bits(i, 22, 19), bits(i, 15, 11));
    let immhb = bits(i, 22, 16);
    if bit(i, 28) || immh == 0 {
        return false;
    }
    let size = (31 - immh.leading_zeros()) as usize;
    let esize = 8u32 << size;
    if size == 3 && !q {
        return false;
    }
    let right = 2 * esize - immhb; // 1..=esize
    let left = immhb - esize; // 0..esize
    let all = u64::MAX >> (64 - esize);
    put(c, rd, q, |c| match (opc, u) {
        // SSHR, USHR; SSRA, USRA add to Vd. A shift by the lane width: wasm
        // shifts take it modulo the width, so USHR gives 0 and SSHR shifts by
        // one less (the same sign bits).
        (0b00000 | 0b00010, _) => {
            if opc == 0b00010 {
                vreg(c, rd);
            }
            if u && right == esize {
                c.v128_const(0);
            } else {
                vreg(c, rn);
                c.i32_const(right.min(esize - 1) as i32);
                c.simd(if u { SHR_U[size] } else { SHR_S[size] });
            }
            if opc == 0b00010 {
                c.simd(ADD[size]);
            }
        }
        // SHL.
        (0b01010, false) => {
            vreg(c, rn);
            c.i32_const(left as i32).simd(SHL[size]);
        }
        // SLI: Vd's bits below the shift kept.
        (0b01010, true) => {
            vreg(c, rn);
            c.i32_const(left as i32).simd(SHL[size]);
            vreg(c, rd);
            c.v128_const(lanes_of(all << left, esize)).simd(BITSELECT);
        }
        // SRI: Vd's bits above the shift kept (all of them for a full shift).
        (0b01000, true) => {
            if right == esize {
                vreg(c, rd);
            } else {
                vreg(c, rn);
                c.i32_const(right as i32).simd(SHR_U[size]);
                vreg(c, rd);
                c.v128_const(lanes_of(all >> right, esize)).simd(BITSELECT);
            }
        }
        _ => unreachable!("{i:#x}"),
    });
    true
}

/// The byte shuffle reversing `esize`-bit lanes within each `cont`-bit container.
fn rev(cont: u32, esize: u32) -> [u8; 16] {
    let (cb, eb) = (cont / 8, esize / 8);
    core::array::from_fn(|b| {
        let (b, per) = (b as u32, cb / eb);
        let (base, o) = (b - b % cb, b % cb);
        (base + (per - 1 - o / eb) * eb + o % eb) as u8
    })
}

fn two_misc(c: &mut Func, i: u32, op: Op) -> bool {
    use Op::*;
    let (rd, rn) = (bits(i, 4, 0), bits(i, 9, 5));
    let (q, size) = (bit(i, 30), bits(i, 23, 22) as usize);
    let esize = 8 << size;
    let q128 = !(size == 3 && !q);
    let shuffle = |c: &mut Func, s: [u8; 16]| {
        vreg(c, rn);
        vreg(c, rn);
        c.shuffle(s);
    };
    match op {
        REV64_asimd if size != 3 => put(c, rd, q, |c| shuffle(c, rev(64, esize))),
        REV32_asimd if size < 2 => put(c, rd, q, |c| shuffle(c, rev(32, esize))),
        REV16_asimd if size == 0 => put(c, rd, q, |c| shuffle(c, rev(16, 8))),
        NOT if size == 0 => put(c, rd, q, |c| ops(c, &[rn], &[VNOT])),
        CNT if size == 0 => put(c, rd, q, |c| ops(c, &[rn], &[POPCNT])),
        NEG_2 if q128 && !bit(i, 28) => put(c, rd, q, |c| ops(c, &[rn], &[NEG[size]])),
        ABS_2 if q128 && !bit(i, 28) => put(c, rd, q, |c| ops(c, &[rn], &[ABS[size]])),
        // XTN(2): the low halves of 2 × esize lanes, into Vd's low half (the
        // top cleared), or with Q into its top half (the low half kept).
        XTN if size != 3 => {
            let eb = esize as u8 / 8;
            let low: [u8; 8] = core::array::from_fn(|b| (b as u8 / eb) * 2 * eb + b as u8 % eb);
            put(c, rd, true, |c| {
                vreg(c, rn);
                if q {
                    vreg(c, rd);
                    // Vd's low 8 bytes (16–23), then the narrowed ones.
                    c.shuffle(core::array::from_fn(|b| {
                        if b < 8 { 16 + b as u8 } else { low[b - 8] }
                    }));
                } else {
                    c.v128_const(0);
                    c.shuffle(core::array::from_fn(|b| if b < 8 { low[b] } else { 16 }));
                }
            });
        }
        _ => return false,
    }
    true
}

/// EXT: bytes `pos` on of Vm:Vn (`interp::simd_int::ext`).
fn ext(c: &mut Func, i: u32) -> bool {
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let (q, pos) = (bit(i, 30), bits(i, 14, 11) as u8);
    if !q && pos >= 8 {
        return false;
    }
    put(c, rd, q, |c| {
        vreg(c, rn);
        vreg(c, rm);
        c.shuffle(core::array::from_fn(|b| {
            let k = pos + b as u8;
            match (q, k) {
                (true, _) => k,
                // 64-bit: Vn's low 8 bytes, then Vm's.
                (false, 0..8) => k,
                (false, _) => 16 + (k - 8) % 8,
            }
        }));
    });
    true
}

/// Element size (log2 bytes) and index from imm5 (`interp::simd::imm5`).
fn imm5(i: u32) -> Option<(usize, u8)> {
    let imm5 = bits(i, 20, 16);
    let size = imm5.trailing_zeros();
    (size <= 3).then_some((size as usize, (imm5 >> (size + 1)) as u8))
}

/// DUP, INS, UMOV/SMOV, MOVI & co, FMOV (`interp::simd::exec`).
fn moves(c: &mut Func, i: u32, op: Op) -> bool {
    use Op::*;
    let (rd, rn) = (bits(i, 4, 0), bits(i, 9, 5));
    let q = bit(i, 30);
    // Bytes of lane `index` of `esize` bits, repeated in every lane.
    let dup = |size: usize, index: u8| -> [u8; 16] {
        let eb = 1u8 << size;
        core::array::from_fn(|b| index * eb + b as u8 % eb)
    };
    match op {
        DUP_elt_1 | DUP_elt_2 => {
            let Some((size, index)) = imm5(i) else {
                return false;
            };
            if op == DUP_elt_2 && size == 3 && !q {
                return false;
            }
            // The scalar form (DUP_elt_1) keeps the element alone.
            let (s, keep) = (
                dup(size, index),
                if op == DUP_elt_1 { 1 << size } else { 16 },
            );
            put(c, rd, op == DUP_elt_1 || q, |c| {
                vreg(c, rn);
                c.v128_const(0);
                c.shuffle(core::array::from_fn(|b| if b < keep { s[b] } else { 16 }));
            });
        }
        DUP_gen => {
            let Some((size, _)) = imm5(i) else {
                return false;
            };
            if size == 3 && !q {
                return false;
            }
            put(c, rd, q, |c| {
                get(c, size == 3, rn);
                c.simd(SPLAT[size]);
            });
        }
        INS_gen => {
            let Some((size, index)) = imm5(i) else {
                return false;
            };
            put(c, rd, true, |c| {
                vreg(c, rd);
                get(c, size == 3, rn);
                c.simd_lane(REPLACE[size], index);
            });
        }
        INS_elt => {
            let Some((size, dst)) = imm5(i) else {
                return false;
            };
            let src = (bits(i, 14, 11) >> size) as u8;
            put(c, rd, true, |c| {
                vreg(c, rd);
                vreg(c, rn);
                c.simd_lane(EXTRACT_U[size], src)
                    .simd_lane(REPLACE[size], dst);
            });
        }
        SMOV | UMOV => {
            let Some((size, index)) = imm5(i) else {
                return false;
            };
            let ok = match (op, q) {
                (SMOV, false) => size < 2,
                (SMOV, true) => size < 3,
                (_, false) => size < 3,
                (_, true) => size == 3,
            };
            if !ok {
                return false;
            }
            set(c, q, rd, |c| {
                vreg(c, rn);
                if op == SMOV {
                    c.simd_lane(EXTRACT_S[size], index);
                    if q {
                        c.op(0xac); // i64.extend_i32_s
                    }
                } else {
                    c.simd_lane(EXTRACT_U[size], index);
                }
            });
        }
        MOVI | FMOV_2 => {
            let (op1, cmode) = (bit(i, 29), bits(i, 15, 12));
            let imm8 = bits(i, 18, 16) << 5 | bits(i, 9, 5);
            let Ok(imm) = adv_simd_expand_imm(op1, cmode, imm8, q) else {
                return false;
            };
            let imm = imm as u128 | (imm as u128) << 64;
            // cmode 0xx1 and 10x1 are ORR (op 0) and BIC (op 1); the rest MOVI/MVNI/FMOV.
            let logical = cmode & 1 == 1 && cmode < 12;
            put(c, rd, q, |c| match (logical, op1) {
                (true, false) => {
                    vreg(c, rd);
                    c.v128_const(imm).simd(OR);
                }
                (true, true) => {
                    vreg(c, rd);
                    c.v128_const(!imm).simd(AND);
                }
                (false, true) if cmode < 14 => {
                    c.v128_const(!imm);
                }
                _ => {
                    c.v128_const(imm);
                }
            });
        }
        FMOV_float_gen => {
            // sf (31), ftype (23:22), rmode (20:19), opcode<0> (16): 1 is to the vector register.
            let (sf, ftype, rmode, to_v) =
                (bit(i, 31), bits(i, 23, 22), bits(i, 20, 19), bit(i, 16));
            match (sf, ftype, rmode, to_v) {
                (false, 0, 0, true) | (true, 1, 0, true) => put(c, rd, true, |c| {
                    c.v128_const(0);
                    get(c, sf, rn);
                    if !sf {
                        c.op(0xad); // i64.extend_i32_u
                    }
                    c.simd_lane(REPLACE[3], 0);
                }),
                (false, 0, 0, false) => set(c, false, rd, |c| {
                    vreg(c, rn);
                    c.simd_lane(EXTRACT_U[2], 0);
                }),
                (true, 1, 0, false) | (true, 2, 1, false) => set(c, true, rd, |c| {
                    vreg(c, rn);
                    c.simd_lane(EXTRACT_U[3], (ftype == 2) as u8);
                }),
                (true, 2, 1, true) => put(c, rd, true, |c| {
                    vreg(c, rd);
                    get(c, true, rn);
                    c.simd_lane(REPLACE[3], 1);
                }),
                // Half precision needs FEAT_FP16, which we don't advertise.
                _ => return false,
            }
        }
        FMOV_float => {
            let w = match bits(i, 23, 22) {
                0 => 32,
                1 => 64,
                _ => return false,
            };
            put(c, rd, true, |c| {
                vreg(c, rn);
                c.v128_const(u128::MAX >> (128 - w)).simd(AND);
            });
        }
        FMOV_float_imm => {
            let n = match bits(i, 23, 22) {
                0 => 32,
                1 => 64,
                _ => return false,
            };
            let v = vfp_expand_imm(bits(i, 20, 13), n) as u128;
            put(c, rd, true, |c| {
                c.v128_const(v);
            });
        }
        _ => return false,
    }
    true
}
