//! The crypto extensions as wasm SIMD128 (M6.5 loop 4 on): AES rounds, the
//! round and mix pair fused when the mix reads and writes the round's
//! register (compilers, OpenSSL and Linux emit them so). Table-free in the
//! constant-time sense of PLAN.md §7 M6.5: SubBytes is nested inversion over
//! GF(2⁴), nine `i8x16.swizzle`s of constant vectors (register permutes, no
//! memory indexed by data; never `relaxed_swizzle`, whose out-of-range lanes
//! aren't deterministic). It measured 30% faster than the S-box as sixteen
//! swizzles of 16-byte slices (`bench/interp/REPORT.md` "M6.5 loop 4").
//! Only when the vCPU has the feature (`Ctx::crypto`); operands come from
//! the `Cpu`'s V registers and results go back there.

use core::mem::offset_of;

use super::{Func, V, V128_LOAD, V128_STORE, VCPU, VT};
use crate::crypto::{INV_NESTED, NESTED};
use crate::decode::{Op, decode};
use crate::interp::bits;
use crate::mmu::Vcpu;

const SWIZZLE: u32 = 0x0e;
const AND: u32 = 0x4e;
const XOR: u32 = 0x51;
const SHL8: u32 = 0x6b;
const SHR_S8: u32 = 0x6c;
const SHR_U8: u32 = 0x6d;
/// 0x01 in every byte.
const LO: u128 = u128::MAX / 0xff;

/// The constants the AES code uses, in the `Vcpu` (`Vcpu::consts`).
#[repr(C, align(16))]
#[derive(Clone, Copy, Debug)]
pub struct Consts([u128; K_LEN]);

const fn v(t: &[u8; 16]) -> u128 {
    u128::from_le_bytes(*t)
}

// Indexes into `Consts`.
const K_LO: usize = 0; // then K_HI, K_F, K_G, for the S-box; +4 for its inverse
const K_INV: usize = 8;
const K_INVZ: usize = 9;
const K_0F: usize = 10;
const K_63: usize = 11;
const K_1B: usize = 12;
// Swizzle indices: ShiftRows, InvShiftRows, the column rotations by 1 and 3 bytes.
const K_SR: usize = 13;
const K_ISR: usize = 14;
const K_ROT1: usize = 15;
const K_ROT3: usize = 16;
const K_LEN: usize = 17;
pub const CONSTS: Consts = Consts([
    v(&NESTED.lo),
    v(&NESTED.hi),
    v(&NESTED.f),
    v(&NESTED.g),
    v(&INV_NESTED.lo),
    v(&INV_NESTED.hi),
    v(&INV_NESTED.f),
    v(&INV_NESTED.g),
    v(&NESTED.inv),
    v(&NESTED.invz),
    LO * 0x0f,
    LO * 0x63,
    LO * 0x1b,
    v(&SHIFT_ROWS),
    v(&INV_SHIFT_ROWS),
    v(&rot(1)),
    v(&rot(3)),
]);
const _: () = assert!(NESTED.inv[3] == INV_NESTED.inv[3] && NESTED.invz[5] == INV_NESTED.invz[5]);

/// Pushes constant `k` (loaded from the `Vcpu`).
fn konst(c: &mut Func, k: usize) {
    c.local_get(VCPU)
        .simd_mem(V128_LOAD, 0, (offset_of!(Vcpu, consts) + 16 * k) as u32);
}

/// ShiftRows and its inverse (FIPS 197 5.1.2, 5.3.1): byte j ← byte p[j].
const SHIFT_ROWS: [u8; 16] = [0, 5, 10, 15, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11];
const INV_SHIFT_ROWS: [u8; 16] = [0, 13, 10, 7, 4, 1, 14, 11, 8, 5, 2, 15, 12, 9, 6, 3];

/// Byte r of each 32-bit column ← byte r + k (mod 4).
const fn rot(k: u8) -> [u8; 16] {
    let mut p = [0; 16];
    let mut j = 0;
    while j < 16 {
        p[j] = (j as u8 & !3) | ((j as u8 + k) & 3);
        j += 1;
    }
    p
}

/// Emits `i` inline if it's an AES instruction; false (nothing emitted) otherwise.
pub(super) fn inline(c: &mut Func, i: u32, op: Op) -> bool {
    use Op::*;
    let (rd, rn) = (bits(i, 4, 0), bits(i, 9, 5));
    match op {
        AESE | AESD => {
            let dec = op == AESD;
            let next = c.next;
            let fuse = next != 0
                && decode(next) == if dec { AESIMC } else { AESMC }
                && bits(next, 4, 0) == rd
                && bits(next, 9, 5) == rd;
            c.local_get(VCPU);
            vreg(c, rd);
            vreg(c, rn);
            c.simd(XOR);
            perm(c, if dec { K_ISR } else { K_SR });
            nested(c, dec);
            if fuse {
                if dec {
                    inv_mix_columns(c);
                } else {
                    mix_columns(c);
                }
                c.fused = true;
            }
            c.simd_mem(V128_STORE, 0, V + 16 * rd);
        }
        AESMC | AESIMC => {
            c.local_get(VCPU);
            vreg(c, rn);
            if op == AESMC {
                mix_columns(c);
            } else {
                inv_mix_columns(c);
            }
            c.simd_mem(V128_STORE, 0, V + 16 * rd);
        }
        PMULL if bits(i, 23, 22) == 3 => pmull64(c, i),
        _ => return false,
    }
    true
}

// i64 scratch locals for PMULL (above the register locals, below the v128 ones).
const PA: u32 = 100;
const PB: u32 = 101;
const PLO: u32 = 102;
const PHI: u32 = 103;
const PMID: u32 = 104;
const PX: u32 = 105; // ..=108: x's four bit classes
const PY: u32 = 109; // ..=112: y's
const I64_AND: u8 = 0x83;
const I64_OR: u8 = 0x84;
const I64_XOR: u8 = 0x85;
const I64_SHL: u8 = 0x86;
const I64_SHR_U: u8 = 0x88;
const I64_MUL: u8 = 0x7e;
/// Every fourth bit, from bit k.
const HOLES: [i64; 4] = [
    0x1111_1111_1111_1111,
    0x2222_2222_2222_2222,
    0x4444_4444_4444_4444,
    0x8888_8888_8888_8888u64 as i64,
];

/// PMULL/PMULL2 Vd.1Q, Vn.1D, Vm.1D (or .2D): the 128-bit carry-less product
/// of the low (Q = 0) or high 64-bit halves, as `crypto::clmul64` computes it:
/// Karatsuba over three 32×32 products with holes, i64 multiplies only
/// (4.5% faster on GCM than four products, measured twice; wasm has no wide
/// or carry-less multiply, and `i64x2.mul` has no arm64 instruction).
fn pmull64(c: &mut Func, i: u32) {
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let half = 8 * bits(i, 30, 30);
    c.local_get(VCPU).i64_load(V + 16 * rn + half).local_set(PA);
    c.local_get(VCPU).i64_load(V + 16 * rm + half).local_set(PB);
    // lo = a0·b0, hi = a1·b1, mid = (a0 + a1)(b0 + b1) + lo + hi.
    let lo32 = |c: &mut Func, l: u32| {
        c.local_get(l).i64_const(0xffff_ffff).op(I64_AND);
    };
    let hi32 = |c: &mut Func, l: u32| {
        c.local_get(l).i64_const(32).op(I64_SHR_U);
    };
    lo32(c, PA);
    lo32(c, PB);
    clmul32(c, PLO);
    hi32(c, PA);
    hi32(c, PB);
    clmul32(c, PHI);
    lo32(c, PA);
    hi32(c, PA);
    c.op(I64_XOR);
    lo32(c, PB);
    hi32(c, PB);
    c.op(I64_XOR);
    clmul32(c, PMID);
    c.local_get(PMID)
        .local_get(PLO)
        .op(I64_XOR)
        .local_get(PHI)
        .op(I64_XOR)
        .local_set(PMID);
    c.local_get(VCPU);
    c.local_get(PLO)
        .local_get(PMID)
        .i64_const(32)
        .op(I64_SHL)
        .op(I64_XOR);
    c.i64_store(V + 16 * rd);
    c.local_get(VCPU);
    c.local_get(PHI)
        .local_get(PMID)
        .i64_const(32)
        .op(I64_SHR_U)
        .op(I64_XOR);
    c.i64_store(V + 16 * rd + 8);
}

/// The 64-bit carry-less product of the two 32-bit values on the stack (x
/// under y) into local `out`: each operand split into its four bit classes
/// (every fourth bit), so each integer product's partial sums (≤ 8 terms per
/// bit) can't carry into the next bit of its class.
fn clmul32(c: &mut Func, out: u32) {
    c.local_set(PY);
    c.local_set(PX);
    for k in (0..4).rev() {
        c.local_get(PX)
            .i64_const(HOLES[k])
            .op(I64_AND)
            .local_set(PX + k as u32);
        c.local_get(PY)
            .i64_const(HOLES[k])
            .op(I64_AND)
            .local_set(PY + k as u32);
    }
    for (k, &holes) in HOLES.iter().enumerate() {
        for j in 0..4 {
            c.local_get(PX + j as u32)
                .local_get(PY + ((k + 4 - j) % 4) as u32)
                .op(I64_MUL);
            if j > 0 {
                c.op(I64_XOR);
            }
        }
        c.i64_const(holes).op(I64_AND);
        if k > 0 {
            c.op(I64_OR);
        }
    }
    c.local_set(out);
}

/// Pushes Vn.
fn vreg(c: &mut Func, n: u32) {
    c.local_get(VCPU).simd_mem(V128_LOAD, 0, V + 16 * n);
}

/// The vector on the stack with its bytes permuted by constant `k`'s indices.
fn perm(c: &mut Func, k: usize) {
    konst(c, k);
    c.simd(SWIZZLE);
}

/// The S-box (with `add63`) or its inverse on each byte of the vector on the
/// stack, by nested inversion over GF(2⁴) (`crypto::Nested`): the basis change
/// in, 1/(ζ(x + y)), 1/x, 1/y, 1/p, 1/q and the two tables back, all swizzles.
fn nested(c: &mut Func, dec: bool) {
    let b = if dec { K_LO + 4 } else { K_LO };
    let (m, x, y, u) = (VT[0], VT[1], VT[2], VT[3]);
    c.local_set(m);
    konst(c, b);
    c.local_get(m);
    konst(c, K_0F);
    c.simd(AND).simd(SWIZZLE);
    konst(c, b + 1);
    c.local_get(m)
        .i32_const(4)
        .simd(SHR_U8)
        .simd(SWIZZLE)
        .simd(XOR);
    c.local_tee(m).i32_const(4).simd(SHR_U8).local_set(x);
    c.local_get(m);
    konst(c, K_0F);
    c.simd(AND).local_set(y);
    konst(c, K_INVZ);
    c.local_get(x)
        .local_get(y)
        .simd(XOR)
        .simd(SWIZZLE)
        .local_set(u);
    // f(1/(1/y + u) + x) + g(1/(1/x + u) + y)
    for (out, a, bb) in [(b + 2, y, x), (b + 3, x, y)] {
        konst(c, out);
        konst(c, K_INV);
        konst(c, K_INV);
        c.local_get(a).simd(SWIZZLE).local_get(u).simd(XOR);
        c.simd(SWIZZLE).local_get(bb).simd(XOR).simd(SWIZZLE);
    }
    c.simd(XOR);
    if !dec {
        konst(c, K_63);
        c.simd(XOR);
    }
}

/// Each byte of the vector on the stack times x in GF(2⁸).
fn xtime(c: &mut Func) {
    c.local_tee(VT[1]).i32_const(1).simd(SHL8);
    c.local_get(VT[1]).i32_const(7).simd(SHR_S8);
    konst(c, K_1B);
    c.simd(AND).simd(XOR);
}

/// MixColumns of the vector on the stack: b_r = 2(a_r + a_{r+1}) + a_{r+1} + a_{r+2} + a_{r+3}.
fn mix_columns(c: &mut Func) {
    let x = VT[2];
    c.local_tee(x);
    perm(c, K_ROT1);
    c.local_tee(VT[3]);
    c.local_get(x).simd(XOR);
    xtime(c);
    c.local_get(VT[3]).simd(XOR);
    c.local_get(x).local_get(x).shuffle(rot(2)).simd(XOR); // rev32 on arm64
    c.local_get(x);
    perm(c, K_ROT3);
    c.simd(XOR);
}

/// InvMixColumns of the vector on the stack, as MixColumns after adding
/// 4(a_r + a_{r+2}) to each byte (the circulant 0e 0b 0d 09 is 02 03 01 01
/// times 05 00 04 00; Daemen and Rijmen, "The Design of Rijndael", 4.1.3).
fn inv_mix_columns(c: &mut Func) {
    let x = VT[2];
    c.local_set(x);
    c.local_get(x).local_get(x).shuffle(rot(2));
    c.local_get(x).simd(XOR);
    xtime(c);
    xtime(c);
    c.local_get(x).simd(XOR);
    mix_columns(c);
}

#[cfg(test)]
mod tests {
    use super::*;

    const AESE: u32 = 0x4e284800;
    const AESD: u32 = 0x4e285800;
    const AESMC: u32 = 0x4e286800;
    const AESIMC: u32 = 0x4e287800;

    /// Whether `first` (v0, v1) fuses with `next`.
    fn fuses(first: u32, next: u32) -> bool {
        let mut c = Func {
            next,
            ..Func::default()
        };
        assert!(inline(&mut c, first | 1 << 5, decode(first)));
        c.fused
    }

    #[test]
    fn fuses_a_round_with_its_mix_on_the_same_register() {
        assert!(fuses(AESE, AESMC)); // aese v0, v1; aesmc v0, v0
        assert!(fuses(AESD, AESIMC));
        assert!(!fuses(AESE, AESMC | 2)); // aesmc v2, v0: v0 keeps the round
        assert!(!fuses(AESE, AESMC | 2 << 5)); // aesmc v0, v2
        assert!(!fuses(AESE, AESIMC)); // the other direction's mix
        assert!(!fuses(AESD, AESMC));
        assert!(!fuses(AESE, 0)); // the block's end
    }
}
