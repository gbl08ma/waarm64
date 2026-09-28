//! The crypto extensions as wasm SIMD128 (M6.5 loop 4 on): AES rounds, the
//! round and mix pair fused when the mix reads and writes the round's
//! register (compilers, OpenSSL and Linux emit them so). Table-free in the
//! constant-time sense of docs/cpu.md "Crypto extensions": SubBytes is nested inversion over
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
const OR: u32 = 0x50;
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
        SHA1C | SHA1P | SHA1M => sha1(c, i, op),
        SHA1H => {
            // The rotation by 30 of Sn, the rest of Vd cleared.
            c.local_get(VCPU).local_get(VCPU).i32_load(V + 16 * rn);
            c.i32_const(30).op(I32_ROTL).op(0xad); // i64.extend_i32_u
            c.i64_store(V + 16 * rd);
            c.local_get(VCPU).i64_const(0).i64_store(V + 16 * rd + 8);
        }
        SHA1SU0 | SHA1SU1 | SHA256SU0 | SHA256SU1 => schedule(c, i, op),
        SHA256H | SHA256H2 => sha256(c, i, op == SHA256H2),
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

/// The i32 locals SHA's rounds use (`Func::locals` declares them i32).
pub(crate) const I32_LOCALS: core::ops::RangeInclusive<u32> = 80..=95;
const ST: u32 = 80; // the state's eight words: 80..=87
const TT: u32 = 88; // the round's T
const I32_ADD: u8 = 0x6a;
const I32_AND: u8 = 0x71;
const I32_OR: u8 = 0x72;
const I32_XOR: u8 = 0x73;
const I32_ROTL: u8 = 0x77;
const I32_ROTR: u8 = 0x78;
const I32X4_SHL: u32 = 0xab;
const I32X4_SHR_U: u32 = 0xad;
const I32X4_ADD: u32 = 0xae;

/// Lane `e` of Vn onto the stack.
fn lane(c: &mut Func, n: u32, e: u32) {
    c.local_get(VCPU).i32_load(V + 16 * n + 4 * e);
}

/// Vd's four lanes from locals `x`.
fn store_lanes(c: &mut Func, rd: u32, x: [u32; 4]) {
    for (e, &l) in x.iter().enumerate() {
        c.local_get(VCPU)
            .local_get(l)
            .i32_store(V + 16 * rd + 4 * e as u32);
    }
}

/// SHAchoose, SHAparity, SHAmajority of locals x, y, z onto the stack.
fn f3(c: &mut Func, f: u8, (x, y, z): (u32, u32, u32)) {
    match f {
        0 => {
            // ((y ^ z) & x) ^ z
            c.local_get(y)
                .local_get(z)
                .op(I32_XOR)
                .local_get(x)
                .op(I32_AND);
            c.local_get(z).op(I32_XOR);
        }
        1 => {
            c.local_get(x)
                .local_get(y)
                .op(I32_XOR)
                .local_get(z)
                .op(I32_XOR);
        }
        _ => {
            // (x & y) | ((x | y) & z)
            c.local_get(x).local_get(y).op(I32_AND);
            c.local_get(x)
                .local_get(y)
                .op(I32_OR)
                .local_get(z)
                .op(I32_AND);
            c.op(I32_OR);
        }
    }
}

/// SHA1C, SHA1P, SHA1M: four rounds on abcd (Vd) and e (Sn) with Vm's W + K
/// (`crypto::sha1`), the words renamed between rounds rather than moved.
fn sha1(c: &mut Func, i: u32, op: Op) {
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let f = match op {
        Op::SHA1C => 0,
        Op::SHA1P => 1,
        _ => 2,
    };
    let mut w = [ST, ST + 1, ST + 2, ST + 3, ST + 4]; // a b c d e
    for e in 0..4 {
        lane(c, rd, e);
        c.local_set(ST + e);
    }
    lane(c, rn, 0);
    c.local_set(ST + 4);
    for r in 0..4 {
        let [a, b, cc, d, e] = w;
        // e += rol(a, 5) + f(b, c, d) + W[r]; b = rol(b, 30)
        c.local_get(e)
            .local_get(a)
            .i32_const(5)
            .op(I32_ROTL)
            .op(I32_ADD);
        f3(c, f, (b, cc, d));
        c.op(I32_ADD);
        lane(c, rm, r);
        c.op(I32_ADD).local_set(e);
        c.local_get(b).i32_const(30).op(I32_ROTL).local_set(b);
        w = [e, a, b, cc, d];
    }
    store_lanes(c, rd, [w[0], w[1], w[2], w[3]]);
}

/// Σ of the local `x` onto the stack: its rotations right by `r`, XORed.
fn big_sigma(c: &mut Func, x: u32, r: [i32; 3]) {
    for (k, &r) in r.iter().enumerate() {
        c.local_get(x).i32_const(r).op(I32_ROTR);
        if k > 0 {
            c.op(I32_XOR);
        }
    }
}

/// SHA256H (`part2` false: abcd in Vd, efgh in Vn; writes abcd) and SHA256H2
/// (efgh in Vd, abcd in Vn; writes efgh): four rounds (`crypto::sha256hash`).
/// `mov S, A; sha256h A, E, W; sha256h2 E, S, W`, as OpenSSL and Linux write
/// them, is computed once: the pair would run the same rounds twice.
fn sha256(c: &mut Func, i: u32, part2: bool) {
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let (xr, yr) = if part2 { (rn, rd) } else { (rd, rn) };
    let (next, prev) = (c.next, c.prev);
    let save = bits(prev, 4, 0);
    let fuse = !part2
        && next != 0
        && decode(next) == Op::SHA256H2
        && (bits(next, 4, 0), bits(next, 9, 5), bits(next, 20, 16)) == (rn, save, rm)
        // mov S, A: ORR S.16B, A.16B, A.16B
        && prev & 0xffe0_fc00 == 0x4ea0_1c00
        && bits(prev, 9, 5) == rd
        && bits(prev, 20, 16) == rd
        && rd != rn
        && ![rd, rn, rm].contains(&save)
        && rm != rd
        && rm != rn;
    let (mut x, mut y) = (
        [ST, ST + 1, ST + 2, ST + 3],
        [ST + 4, ST + 5, ST + 6, ST + 7],
    );
    for e in 0..4 {
        lane(c, xr, e);
        c.local_set(x[e as usize]);
        lane(c, yr, e);
        c.local_set(y[e as usize]);
    }
    for r in 0..4 {
        // T = h + Σ1(e) + Ch(e, f, g) + W[r]; d += T; h = T + Σ0(a) + Maj(a, b, c)
        c.local_get(y[3]);
        big_sigma(c, y[0], [6, 11, 25]);
        c.op(I32_ADD);
        f3(c, 0, (y[0], y[1], y[2]));
        c.op(I32_ADD);
        lane(c, rm, r);
        c.op(I32_ADD).local_tee(TT);
        c.local_get(x[3]).op(I32_ADD).local_set(x[3]);
        c.local_get(TT);
        big_sigma(c, x[0], [2, 13, 22]);
        c.op(I32_ADD);
        f3(c, 2, (x[0], x[1], x[2]));
        c.op(I32_ADD).local_set(y[3]);
        (x, y) = ([y[3], x[0], x[1], x[2]], [x[3], y[0], y[1], y[2]]);
    }
    if fuse {
        store_lanes(c, rd, x);
        store_lanes(c, rn, y);
        c.fused = true;
    } else {
        store_lanes(c, rd, if part2 { y } else { x });
    }
}

/// Each 32-bit lane of the vector on the stack rotated right by `r`.
fn ror4(c: &mut Func, r: i32) {
    let t = VT[3];
    c.local_tee(t).i32_const(r).simd(I32X4_SHR_U);
    c.local_get(t).i32_const(32 - r).simd(I32X4_SHL).simd(OR);
}

/// σ of the vector in local `x`: rotations right by r[0], r[1], a shift right by r[2].
fn small_sigma(c: &mut Func, x: u32, r: [i32; 3]) {
    c.local_get(x);
    ror4(c, r[0]);
    c.local_get(x);
    ror4(c, r[1]);
    c.simd(XOR)
        .local_get(x)
        .i32_const(r[2])
        .simd(I32X4_SHR_U)
        .simd(XOR);
}

/// Bytes 4..20 of a:b (a shifted down one lane, b's first lane on top).
const DOWN1: [u8; 16] = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];

/// The message schedule updates, as SIMD128 (`crypto::sha1su0` & co).
fn schedule(c: &mut Func, i: u32, op: Op) {
    use Op::*;
    let (rd, rn, rm) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let (a, b) = (VT[0], VT[1]);
    c.local_get(VCPU);
    match op {
        SHA1SU0 => {
            // (n.lo : d.hi) ^ d ^ m
            vreg(c, rd);
            vreg(c, rn);
            c.shuffle([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
            vreg(c, rd);
            c.simd(XOR);
            vreg(c, rm);
            c.simd(XOR);
        }
        SHA1SU1 => {
            // t = d ^ (n >> 32); rol(t, 1) in each lane, lane 3 also ^ rol(t0, 2)
            vreg(c, rd);
            vreg(c, rn);
            c.v128_const(0).shuffle(DOWN1).simd(XOR).local_tee(a);
            c.i32_const(1)
                .simd(I32X4_SHL)
                .local_get(a)
                .i32_const(31)
                .simd(I32X4_SHR_U)
                .simd(OR);
            c.local_get(a)
                .i32_const(2)
                .simd(I32X4_SHL)
                .local_get(a)
                .i32_const(30)
                .simd(I32X4_SHR_U)
                .simd(OR);
            c.v128_const(0)
                .shuffle([16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 0, 1, 2, 3]);
            c.simd(XOR);
        }
        SHA256SU0 => {
            // σ0(n0 : d >> 32) + d
            vreg(c, rd);
            vreg(c, rn);
            c.shuffle(DOWN1).local_set(a);
            small_sigma(c, a, [7, 18, 3]);
            vreg(c, rd);
            c.simd(I32X4_ADD);
        }
        _ => {
            // SHA256SU1: A = d + (m0 : n >> 32); lanes 0, 1 = σ1(m2, m3) + A;
            // lanes 2, 3 = σ1(the first two results) + A.
            vreg(c, rd);
            vreg(c, rn);
            vreg(c, rm);
            c.shuffle(DOWN1).simd(I32X4_ADD).local_set(b);
            vreg(c, rm);
            vreg(c, rm);
            c.shuffle([8, 9, 10, 11, 12, 13, 14, 15, 8, 9, 10, 11, 12, 13, 14, 15])
                .local_set(a);
            small_sigma(c, a, [17, 19, 10]);
            c.local_get(b).simd(I32X4_ADD).local_set(a); // r0, r1 in lanes 0, 1
            c.local_get(a).local_get(a);
            c.shuffle([0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23]);
            c.local_set(VT[2]); // r0, r1, r0, r1
            c.local_get(a);
            small_sigma(c, VT[2], [17, 19, 10]);
            c.local_get(b).simd(I32X4_ADD); // r2, r3 in lanes 2, 3
            c.shuffle([0, 1, 2, 3, 4, 5, 6, 7, 24, 25, 26, 27, 28, 29, 30, 31]);
        }
    }
    c.simd_mem(V128_STORE, 0, V + 16 * rd);
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

#[cfg(test)]
mod sha_tests {
    use super::*;

    const MOV: u32 = 0x4ea01c00; // orr Vd.16b, Vn.16b, Vm.16b
    const H: u32 = 0x5e004000;
    const H2: u32 = 0x5e005000;
    const fn r(op: u32, d: u32, n: u32, m: u32) -> u32 {
        op | m << 16 | n << 5 | d
    }

    /// Whether sha256h A=0, E=1, W=2 fuses with `prev` and `next`.
    fn fuses(prev: u32, next: u32) -> bool {
        let mut c = Func {
            prev,
            next,
            ..Func::default()
        };
        let h = r(H, 0, 1, 2);
        assert!(inline(&mut c, h, decode(h)));
        c.fused
    }

    #[test]
    fn fuses_sha256h_with_h2_after_the_save() {
        let (mov, h2) = (r(MOV, 3, 0, 0), r(H2, 1, 3, 2)); // mov v3, v0; …; sha256h2 q1, q3, v2
        assert!(fuses(mov, h2));
        assert!(!fuses(0, h2)); // no save before
        assert!(!fuses(r(MOV, 3, 4, 4), h2)); // saved another register
        assert!(!fuses(mov, r(H2, 1, 4, 2))); // h2 reads another save
        assert!(!fuses(mov, r(H2, 1, 3, 4))); // other W
        assert!(!fuses(mov, r(H2, 4, 3, 2))); // other efgh
        assert!(!fuses(r(MOV, 1, 0, 0), r(H2, 1, 1, 2))); // S = E
    }
}
