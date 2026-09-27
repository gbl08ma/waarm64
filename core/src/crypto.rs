//! The v8.0 crypto extensions' arithmetic (M6.5): AES rounds, SHA-1 and
//! SHA-256 hash updates, carry-less multiplies. Our own code, written from
//! FIPS 197, FIPS 180-4 and the Arm pseudocode (AESSubBytes, SHA256hash, …);
//! the interpreter's reference semantics and the JIT's helpers.
//!
//! **Constant time** (PLAN.md §7 M6.5): no memory index or branch depends on
//! the data. The S-box isn't a table: it is the GF(2⁸) inverse (x²⁵⁴ by an
//! addition chain) and the affine map, on all 16 bytes at once as lanes of a
//! u128. The carry-less multiply uses integer multiplies of operands with holes
//! (BearSSL's `bmul` idea, reimplemented; `THIRD_PARTY.md`).
//!
//! A vector register is a u128 with byte *i* (of an AES block, in memory
//! order) in bits 8i+7:8i, and 32-bit element *e* in bits 32e+31:32e.

/// 0x01 in every byte.
const LO: u128 = u128::MAX / 0xff;

/// Each byte shifted left by `k` (0 < k < 8) within itself.
fn shl8(x: u128, k: u32) -> u128 {
    (x << k) & (LO * ((0xff << k) & 0xff))
}

/// Each byte rotated left by `k` (0 < k < 8).
fn rotl8(x: u128, k: u32) -> u128 {
    shl8(x, k) | (x >> (8 - k)) & (LO * (0xff >> (8 - k)))
}

/// Each byte times x in GF(2⁸) mod x⁸ + x⁴ + x³ + x + 1.
fn xtime(x: u128) -> u128 {
    let hi = (x >> 7) & LO;
    shl8(x, 1) ^ hi << 4 ^ hi << 3 ^ hi << 1 ^ hi
}

/// Bytewise GF(2⁸) product.
fn gmul(mut a: u128, b: u128) -> u128 {
    let mut r = 0;
    for k in 0..8 {
        let m = (b >> k) & LO;
        r ^= a & (m << 8).wrapping_sub(m); // 0xff in the bytes where b has bit k
        a = xtime(a);
    }
    r
}

/// Bytewise GF(2⁸) inverse (0 for 0): x²⁵⁴.
fn ginv(x: u128) -> u128 {
    let x2 = gmul(x, x);
    let x3 = gmul(x2, x);
    let x6 = gmul(x3, x3);
    let x12 = gmul(x6, x6);
    let x15 = gmul(x12, x3);
    let x30 = gmul(x15, x15);
    let x60 = gmul(x30, x30);
    let x120 = gmul(x60, x60);
    let x240 = gmul(x120, x120);
    let x252 = gmul(x240, x12);
    gmul(x252, x2)
}

/// SubBytes (FIPS 197 5.1.1) of all 16 bytes.
pub fn sub_bytes(x: u128) -> u128 {
    let b = ginv(x);
    b ^ rotl8(b, 1) ^ rotl8(b, 2) ^ rotl8(b, 3) ^ rotl8(b, 4) ^ (LO * 0x63)
}

/// InvSubBytes (FIPS 197 5.3.2): the inverse affine map, then the inverse.
pub fn inv_sub_bytes(x: u128) -> u128 {
    ginv(rotl8(x, 1) ^ rotl8(x, 3) ^ rotl8(x, 6) ^ (LO * 0x05))
}

/// The S-box and its inverse as bytes, computed at compile time one byte at a
/// time: the tests' reference (the core has no S-box table).
#[cfg(test)]
pub const SBOX: [u8; 256] = sbox(false);
#[cfg(test)]
pub const INV_SBOX: [u8; 256] = sbox(true);

#[cfg(test)]
const fn sbox(inv: bool) -> [u8; 256] {
    const fn mul(mut a: u8, mut b: u8) -> u8 {
        let mut r = 0;
        while b != 0 {
            if b & 1 != 0 {
                r ^= a;
            }
            a = (a << 1) ^ if a & 0x80 != 0 { 0x1b } else { 0 };
            b >>= 1;
        }
        r
    }
    let mut t = [0u8; 256];
    let mut x = 0;
    while x < 256 {
        // x²⁵⁴ by square and multiply, then the affine map.
        let (mut p, mut e, mut b) = (1u8, 254u32, x as u8);
        while e != 0 {
            if e & 1 != 0 {
                p = mul(p, b);
            }
            b = mul(b, b);
            e >>= 1;
        }
        let s =
            p ^ p.rotate_left(1) ^ p.rotate_left(2) ^ p.rotate_left(3) ^ p.rotate_left(4) ^ 0x63;
        if inv {
            t[s as usize] = x as u8;
        } else {
            t[x] = s;
        }
        x += 1;
    }
    t
}

/// The 16-entry tables of the S-box by nested inversion (Hamburg, "Accelerating
/// AES with vector permute instructions", CHES 2009, 3.3; our own
/// implementation of the paper's formulas): GF(2⁸) as GF(2⁴)[t]/(t² + t + ζ),
/// GF(2⁴) = F₂[ζ]/(ζ⁴ + ζ³ + ζ² + ζ + 1), an element as x·t + y·t̄ (t̄ = t + 1)
/// with x in the high nibble, and
///   1/(xt + yt̄) = (t + ζ)/P + (t̄ + ζ)/Q,
///   P = 1/(1/y + 1/ζ(x + y)) + x,  Q = 1/(1/x + 1/ζ(x + y)) + y,
/// where 1/0 is ∞ (0x80: a swizzle index ≥ 16 reads 0, so 1/∞ = 0 and
/// ∞ + a stays ∞). For the S-box (`inv` false): `lo`/`hi` map the input's
/// nibbles into the tower (XOR them), `f`/`g` map 1/P and 1/Q back with the
/// affine map's linear part (0x63 is added after). For its inverse, `lo`/`hi`
/// apply the inverse affine map first (its constant folded into `lo`) and
/// `f`/`g` map back plainly.
#[derive(Clone, Copy, Debug)]
pub struct Nested {
    pub lo: [u8; 16],
    pub hi: [u8; 16],
    pub inv: [u8; 16],
    pub invz: [u8; 16],
    pub f: [u8; 16],
    pub g: [u8; 16],
}

pub const NESTED: Nested = nested(false);
pub const INV_NESTED: Nested = nested(true);

/// GF(2⁴) = F₂[ζ]/(ζ⁴ + ζ³ + ζ² + ζ + 1).
const fn gm16(a: u8, b: u8) -> u8 {
    let mut r = 0u8;
    let mut s = 0;
    while s < 4 {
        if b >> s & 1 != 0 {
            r ^= a << s;
        }
        s += 1;
    }
    let mut s = 7;
    while s >= 4 {
        if r >> s & 1 != 0 {
            r ^= 0b11111 << (s - 4);
        }
        s -= 1;
    }
    r
}

const fn inv16(a: u8) -> u8 {
    let mut b = 1;
    while b < 16 {
        if gm16(a, b) == 1 {
            return b;
        }
        b += 1;
    }
    0
}

/// ζ, and the tower's product of x·t + y·t̄ pairs (as `x << 4 | y`): with
/// a = y and b = x + y, (a + bt)(c + dt) = ac + ζbd + (ad + bc + bd)t.
const ZETA: u8 = 2;
const fn tmul(p: u8, q: u8) -> u8 {
    let (a, b, c, d) = (p & 15, (p >> 4) ^ (p & 15), q & 15, (q >> 4) ^ (q & 15));
    let lo = gm16(a, c) ^ gm16(gm16(b, d), ZETA);
    let hi = gm16(a, d) ^ gm16(b, c) ^ gm16(b, d);
    (lo ^ hi) << 4 | lo
}

/// The AES field's basis zᵏ in the tower: powers of a root of z⁸ + z⁴ + z³ + z + 1.
const fn tower_basis() -> [u8; 8] {
    const ONE: u8 = 0x11; // t + t̄
    let mut r = 1;
    while r < 256 {
        let mut pw = [0u8; 9];
        pw[0] = ONE;
        let mut k = 1;
        while k < 9 {
            pw[k] = tmul(pw[k - 1], r as u8);
            k += 1;
        }
        if pw[8] ^ pw[4] ^ pw[3] ^ pw[1] ^ pw[0] == 0 {
            let mut b = [0u8; 8];
            let mut k = 0;
            while k < 8 {
                b[k] = pw[k];
                k += 1;
            }
            return b;
        }
        r += 1;
    }
    panic!("no root");
}

/// The linear parts of the affine map and its inverse (FIPS 197 5.1.1, 5.3.2).
const fn skew(b: u8) -> u8 {
    b ^ b.rotate_left(1) ^ b.rotate_left(2) ^ b.rotate_left(3) ^ b.rotate_left(4)
}
const fn unskew(b: u8) -> u8 {
    b.rotate_left(1) ^ b.rotate_left(3) ^ b.rotate_left(6)
}

const fn nested(inv: bool) -> Nested {
    const INF: u8 = 0x80;
    let mut n = Nested {
        lo: [0; 16],
        hi: [0; 16],
        inv: [0; 16],
        invz: [0; 16],
        f: [0; 16],
        g: [0; 16],
    };
    // AES bytes to the tower (GF(2)-linear) and back.
    let basis = tower_basis();
    let (mut to, mut from) = ([0u8; 256], [0u8; 256]);
    let mut x = 0;
    while x < 256 {
        let mut t = 0;
        let mut k = 0;
        while k < 8 {
            if x >> k & 1 != 0 {
                t ^= basis[k];
            }
            k += 1;
        }
        to[x] = t;
        from[t as usize] = x as u8;
        x += 1;
    }
    // (t + ζ) and (t̄ + ζ) as pairs: ζ = ζ(t + t̄).
    let (tz, tbz) = ((1 ^ ZETA) << 4 | ZETA, ZETA << 4 | (1 ^ ZETA));
    let mut v = 0;
    while v < 16 {
        let v8 = v as u8;
        if inv {
            n.lo[v] = to[unskew(v8 ^ 0x63) as usize];
            n.hi[v] = to[unskew(v8 << 4) as usize];
        } else {
            n.lo[v] = to[v];
            n.hi[v] = to[(v8 << 4) as usize];
        }
        n.inv[v] = if v == 0 { INF } else { inv16(v8) };
        n.invz[v] = if v == 0 { INF } else { inv16(gm16(ZETA, v8)) };
        if v != 0 {
            let r = inv16(v8);
            let (fp, gq) = (from[scale(r, tz) as usize], from[scale(r, tbz) as usize]);
            n.f[v] = if inv { fp } else { skew(fp) };
            n.g[v] = if inv { gq } else { skew(gq) };
        }
        v += 1;
    }
    n
}

/// c · (x·t + y·t̄) for c in GF(2⁴).
const fn scale(c: u8, p: u8) -> u8 {
    gm16(c, p >> 4) << 4 | gm16(c, p & 15)
}

/// `out[j] = x[p[j]]` for a constant byte permutation.
fn permute(x: u128, p: &[usize; 16]) -> u128 {
    p.iter()
        .enumerate()
        .fold(0, |o, (j, &i)| o | (x >> (8 * i) & 0xff) << (8 * j))
}

/// ShiftRows (FIPS 197 5.1.2): byte r + 4c ← byte r + 4((c + r) mod 4).
pub fn shift_rows(x: u128) -> u128 {
    permute(x, &[0, 5, 10, 15, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11])
}

/// InvShiftRows (FIPS 197 5.3.1): byte r + 4c ← byte r + 4((c − r) mod 4).
pub fn inv_shift_rows(x: u128) -> u128 {
    permute(x, &[0, 13, 10, 7, 4, 1, 14, 11, 8, 5, 2, 15, 12, 9, 6, 3])
}

/// Each 32-bit column rotated so that byte r ← byte r + k/8 (mod 4).
fn rotcol(x: u128, k: u32) -> u128 {
    let m = u128::MAX / 0xffff_ffff;
    (x >> k) & (m * (0xffff_ffff >> k))
        | (x << (32 - k)) & (m * (0xffff_ffff << (32 - k) & 0xffff_ffff))
}

/// MixColumns (FIPS 197 5.1.3): b_r = 2a_r + 3a_{r+1} + a_{r+2} + a_{r+3}.
pub fn mix_columns(x: u128) -> u128 {
    let (r1, r2, r3) = (rotcol(x, 8), rotcol(x, 16), rotcol(x, 24));
    xtime(x ^ r1) ^ r1 ^ r2 ^ r3
}

/// InvMixColumns (FIPS 197 5.3.3): b_r = 14a_r + 11a_{r+1} + 13a_{r+2} + 9a_{r+3}.
pub fn inv_mix_columns(x: u128) -> u128 {
    let (x2, x4, x8) = (xtime(x), xtime(xtime(x)), xtime(xtime(xtime(x))));
    let (m9, m11, m13, m14) = (x8 ^ x, x8 ^ x2 ^ x, x8 ^ x4 ^ x, x8 ^ x4 ^ x2);
    m14 ^ rotcol(m11, 8) ^ rotcol(m13, 16) ^ rotcol(m9, 24)
}

/// AESE: AddRoundKey, ShiftRows, SubBytes.
pub fn aese(d: u128, n: u128) -> u128 {
    sub_bytes(shift_rows(d ^ n))
}

/// AESD: AddRoundKey, InvShiftRows, InvSubBytes.
pub fn aesd(d: u128, n: u128) -> u128 {
    inv_sub_bytes(inv_shift_rows(d ^ n))
}

fn elem(x: u128, e: usize) -> u32 {
    (x >> (32 * e)) as u32
}

fn from_elems(e: [u32; 4]) -> u128 {
    e.iter().rev().fold(0, |o, &w| o << 32 | w as u128)
}

fn elems(x: u128) -> [u32; 4] {
    [elem(x, 0), elem(x, 1), elem(x, 2), elem(x, 3)]
}

fn choose(x: u32, y: u32, z: u32) -> u32 {
    ((y ^ z) & x) ^ z
}

fn majority(x: u32, y: u32, z: u32) -> u32 {
    (x & y) | ((x | y) & z)
}

fn parity(x: u32, y: u32, z: u32) -> u32 {
    x ^ y ^ z
}

/// SHA1C, SHA1P, SHA1M: four rounds from the state abcd (`x`) and e (`y`),
/// with `w` + K already added, as the Arm pseudocode's loop does.
fn sha1(x: u128, mut y: u32, w: u128, f: fn(u32, u32, u32) -> u32) -> u128 {
    let mut x = elems(x);
    for e in 0..4 {
        let t = f(x[1], x[2], x[3]);
        y = y
            .wrapping_add(x[0].rotate_left(5))
            .wrapping_add(t)
            .wrapping_add(elem(w, e));
        x[1] = x[1].rotate_left(30);
        // <Y, X> = ROL(Y:X, 32)
        (x, y) = ([y, x[0], x[1], x[2]], x[3]);
    }
    from_elems(x)
}

pub fn sha1c(d: u128, n: u128, m: u128) -> u128 {
    sha1(d, n as u32, m, choose)
}

pub fn sha1p(d: u128, n: u128, m: u128) -> u128 {
    sha1(d, n as u32, m, parity)
}

pub fn sha1m(d: u128, n: u128, m: u128) -> u128 {
    sha1(d, n as u32, m, majority)
}

/// SHA1H: the rotation by 30 of e.
pub fn sha1h(n: u128) -> u128 {
    (n as u32).rotate_left(30) as u128
}

/// SHA1SU0: the first half of the message schedule's update.
pub fn sha1su0(d: u128, n: u128, m: u128) -> u128 {
    ((n as u64 as u128) << 64 | d >> 64) ^ d ^ m
}

/// SHA1SU1: the second half.
pub fn sha1su1(d: u128, n: u128) -> u128 {
    let t = elems(d ^ n >> 32);
    let r = t.map(|w| w.rotate_left(1));
    from_elems([r[0], r[1], r[2], r[3] ^ t[0].rotate_left(2)])
}

fn sigma0(x: u32) -> u32 {
    x.rotate_right(2) ^ x.rotate_right(13) ^ x.rotate_right(22)
}

fn sigma1(x: u32) -> u32 {
    x.rotate_right(6) ^ x.rotate_right(11) ^ x.rotate_right(25)
}

/// The Arm pseudocode's SHA256hash: four rounds of the compression function
/// on abcd (`x`) and efgh (`y`) with `w` + K; `part1` returns the new abcd.
fn sha256hash(x: u128, y: u128, w: u128, part1: bool) -> u128 {
    let (mut x, mut y) = (elems(x), elems(y));
    for e in 0..4 {
        let chs = choose(y[0], y[1], y[2]);
        let maj = majority(x[0], x[1], x[2]);
        let t = y[3]
            .wrapping_add(sigma1(y[0]))
            .wrapping_add(chs)
            .wrapping_add(elem(w, e));
        x[3] = t.wrapping_add(x[3]);
        y[3] = t.wrapping_add(sigma0(x[0])).wrapping_add(maj);
        // <Y, X> = ROL(Y:X, 32)
        (x, y) = ([y[3], x[0], x[1], x[2]], [x[3], y[0], y[1], y[2]]);
    }
    from_elems(if part1 { x } else { y })
}

pub fn sha256h(d: u128, n: u128, m: u128) -> u128 {
    sha256hash(d, n, m, true)
}

pub fn sha256h2(d: u128, n: u128, m: u128) -> u128 {
    sha256hash(n, d, m, false)
}

/// SHA256SU0: W[t−16] + σ0(W[t−15]) for four elements.
pub fn sha256su0(d: u128, n: u128) -> u128 {
    let t = elems((n as u32 as u128) << 96 | d >> 32);
    let d = elems(d);
    from_elems([0, 1, 2, 3].map(|e| {
        let x = t[e];
        (x.rotate_right(7) ^ x.rotate_right(18) ^ x >> 3).wrapping_add(d[e])
    }))
}

/// SHA256SU1: adds σ1(W[t−2]) and W[t−7], the last two from the first two results.
pub fn sha256su1(d: u128, n: u128, m: u128) -> u128 {
    let t0 = elems((m as u32 as u128) << 96 | n >> 32);
    let d = elems(d);
    let s1 = |x: u32| x.rotate_right(17) ^ x.rotate_right(19) ^ x >> 10;
    let mut r = [0u32; 4];
    let t1 = elems(m >> 64);
    for e in 0..2 {
        r[e] = s1(t1[e]).wrapping_add(d[e]).wrapping_add(t0[e]);
    }
    for e in 2..4 {
        r[e] = s1(r[e - 2]).wrapping_add(d[e]).wrapping_add(t0[e]);
    }
    from_elems(r)
}

/// 32×32 → 64-bit carry-less product: integer multiplies of the operands with
/// holes (every fourth bit), so a product's partial sums (≤ 8 terms per bit)
/// never carry into the next bit of the same class.
pub fn clmul32(x: u32, y: u32) -> u64 {
    const M: [u64; 4] = [
        0x1111_1111_1111_1111,
        0x2222_2222_2222_2222,
        0x4444_4444_4444_4444,
        0x8888_8888_8888_8888,
    ];
    let (x, y) = (x as u64, y as u64);
    let xs = M.map(|m| x & m);
    let ys = M.map(|m| y & m);
    let mut z = 0;
    for (k, m) in M.iter().enumerate() {
        // The bits of class k come from x's class i times y's class k − i.
        let mut s = 0u64;
        for (i, xi) in xs.iter().enumerate() {
            s ^= xi.wrapping_mul(ys[(k + 4 - i) % 4]);
        }
        z |= s & m;
    }
    z
}

/// 64×64 → 128-bit carry-less product (PMULL.1Q), by Karatsuba over clmul32.
pub fn clmul64(x: u64, y: u64) -> u128 {
    let (x0, x1, y0, y1) = (x as u32, (x >> 32) as u32, y as u32, (y >> 32) as u32);
    let lo = clmul32(x0, y0);
    let hi = clmul32(x1, y1);
    let mid = clmul32(x0 ^ x1, y0 ^ y1) ^ lo ^ hi;
    lo as u128 ^ (mid as u128) << 32 ^ (hi as u128) << 64
}

/// 8×8 → 16-bit carry-less product (PMULL.8H and PMUL), without branches.
pub fn clmul8(x: u64, y: u64) -> u64 {
    (0..8).fold(0, |acc, k| acc ^ (x << k) & ((y >> k) & 1).wrapping_neg())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A block as FIPS 197 writes it (hex, first byte first) → register.
    fn blk(s: &str) -> u128 {
        u128::from_be_bytes(u128::from_str_radix(s, 16).unwrap().to_le_bytes())
    }

    /// The textbook S-box, computed slowly by search, for the check below.
    fn sbox_ref(b: u8) -> u8 {
        let mul = |mut a: u8, mut b: u8| {
            let mut r = 0u8;
            while b != 0 {
                if b & 1 != 0 {
                    r ^= a;
                }
                a = a << 1 ^ if a & 0x80 != 0 { 0x1b } else { 0 };
                b >>= 1;
            }
            r
        };
        let inv = if b == 0 {
            0
        } else {
            (1..=255u8).find(|&c| mul(b, c) == 1).unwrap()
        };
        inv ^ inv.rotate_left(1)
            ^ inv.rotate_left(2)
            ^ inv.rotate_left(3)
            ^ inv.rotate_left(4)
            ^ 0x63
    }

    #[test]
    fn sbox_all_bytes() {
        for base in (0..256).step_by(16) {
            let x = (0..16).fold(0u128, |o, i| o | ((base + i) as u128) << (8 * i));
            let s = sub_bytes(x);
            for i in 0..16 {
                let b = (base + i) as u8;
                assert_eq!((s >> (8 * i)) as u8, sbox_ref(b), "S({b:#x})");
            }
            assert_eq!(inv_sub_bytes(s), x);
        }
        // FIPS 197 figure 7: S(0x53) = 0xed.
        assert_eq!(sub_bytes(0x53) as u8, 0xed);
    }

    #[test]
    fn sbox_tables() {
        for x in 0..=255u8 {
            assert_eq!(SBOX[x as usize], sub_bytes(x as u128) as u8);
            assert_eq!(INV_SBOX[SBOX[x as usize] as usize], x);
        }
    }

    /// The nested-inversion S-box as the JIT computes it, one byte at a time
    /// with swizzle semantics (an index ≥ 16 reads 0), against SubBytes.
    pub fn nested_byte(b: u8, n: &Nested) -> u8 {
        let swz = |t: &[u8; 16], i: u8| if i < 16 { t[i as usize] } else { 0 };
        let m = swz(&n.lo, b & 15) ^ swz(&n.hi, b >> 4);
        let (x, y) = (m >> 4, m & 15);
        let u = swz(&n.invz, x ^ y);
        let (p, q) = (swz(&n.inv, y) ^ u, swz(&n.inv, x) ^ u);
        swz(&n.f, swz(&n.inv, p) ^ x) ^ swz(&n.g, swz(&n.inv, q) ^ y)
    }

    #[test]
    fn nested_inversion() {
        for x in 0..=255u8 {
            assert_eq!(
                nested_byte(x, &NESTED) ^ 0x63,
                SBOX[x as usize],
                "S({x:#x})"
            );
            assert_eq!(
                nested_byte(x, &INV_NESTED),
                INV_SBOX[x as usize],
                "S⁻¹({x:#x})"
            );
        }
    }

    #[test]
    fn rounds_invert() {
        let x = 0x0123_4567_89ab_cdef_fedc_ba98_7654_3210u128;
        assert_eq!(inv_shift_rows(shift_rows(x)), x);
        assert_eq!(inv_mix_columns(mix_columns(x)), x);
        // FIPS 197 appendix B, round 1: after ShiftRows, then MixColumns.
        let s = blk("d4bf5d30e0b452aeb84111f11e2798e5");
        assert_eq!(mix_columns(s), blk("046681e5e0cb199a48f8d37a2806264c"));
    }

    /// FIPS 197 5.2 KeyExpansion for 128-bit keys, from our SubBytes.
    pub fn expand128(key: u128) -> [u128; 11] {
        let mut w: Vec<u32> = (0..4).map(|i| elem(key, i)).collect();
        let mut rcon = 1u32;
        for i in 4..44 {
            let mut t = w[i - 1];
            if i % 4 == 0 {
                t = (sub_bytes(t.rotate_right(8) as u128) as u32) ^ rcon;
                rcon = xtime(rcon as u128) as u32;
            }
            w.push(w[i - 4] ^ t);
        }
        core::array::from_fn(|r| from_elems([w[4 * r], w[4 * r + 1], w[4 * r + 2], w[4 * r + 3]]))
    }

    #[test]
    fn aes128_fips197_c1() {
        let rk = expand128(blk("000102030405060708090a0b0c0d0e0f"));
        let pt = blk("00112233445566778899aabbccddeeff");
        let ct = blk("69c4e0d86a7b0430d8cdb78070b4c55a");
        let mut s = pt;
        for k in &rk[..9] {
            s = mix_columns(aese(s, *k));
        }
        assert_eq!(aese(s, rk[9]) ^ rk[10], ct);
        // The equivalent inverse cipher (FIPS 197 5.3.5), as AESD/AESIMC run it.
        let mut s = inv_mix_columns(aesd(ct, rk[10]));
        for k in rk[2..10].iter().rev() {
            s = inv_mix_columns(aesd(s, inv_mix_columns(*k)));
        }
        assert_eq!(aesd(s, inv_mix_columns(rk[1])) ^ rk[0], pt);
    }

    #[test]
    fn clmul() {
        let slow = |x: u64, y: u64| {
            (0..64).fold(0u128, |a, k| {
                if y >> k & 1 == 1 {
                    a ^ (x as u128) << k
                } else {
                    a
                }
            })
        };
        let mut s = 0x9e37_79b9_7f4a_7c15u64;
        for _ in 0..1000 {
            s = s
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let x = s;
            s = s
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let y = s;
            assert_eq!(clmul64(x, y), slow(x, y));
            assert_eq!(clmul8(x & 0xff, y & 0xff), slow(x & 0xff, y & 0xff) as u64);
        }
        assert_eq!(clmul64(u64::MAX, u64::MAX), slow(u64::MAX, u64::MAX));
    }
}
