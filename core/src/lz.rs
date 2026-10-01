//! A small LZ codec in the LZ4 *block* format, written from the public format description
//! (token = literal-length nibble | match-length nibble, 255-extension bytes, a 2-byte
//! little-endian offset, minimum match 4; the last 5 bytes of a block are literals and the last
//! match starts at least 12 bytes before the end). Used for snapshot RAM chunks.
//!
//! The compressor is greedy with one hash table of 4096 positions on the stack. The decompressor
//! is strict about bounds and total: any input gives `None` or a result, never a panic, an
//! out-of-bounds access or an unbounded loop (every iteration consumes input).

const MIN_MATCH: usize = 4;
const LAST_LITERALS: usize = 5;
const MF_LIMIT: usize = 12;
const HASH_BITS: u32 = 12;
const MAX_OFFSET: usize = 65535;

/// The worst-case compressed size of `len` input bytes.
pub const fn bound(len: usize) -> usize {
    len + len / 255 + 16
}

#[inline(always)]
fn rd32(s: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([s[i], s[i + 1], s[i + 2], s[i + 3]])
}

#[inline(always)]
fn rd64(s: &[u8], i: usize) -> u64 {
    u64::from_le_bytes(s[i..i + 8].try_into().unwrap())
}

/// Writes a length's extension bytes (the part of a length at or above 15).
#[inline(always)]
fn put_ext(dst: &mut [u8], mut dp: usize, mut n: usize) -> usize {
    while n >= 255 {
        dst[dp] = 255;
        dp += 1;
        n -= 255;
    }
    dst[dp] = n as u8;
    dp + 1
}

/// The bytes a length's extension takes (0 below 15).
#[inline(always)]
fn ext_len(n: usize) -> usize {
    if n >= 15 { (n - 15) / 255 + 1 } else { 0 }
}

/// The exact bytes of one sequence: token, literal extension, literals, offset, match extension.
#[inline(always)]
fn seq_room(lit: usize, mlen: usize) -> usize {
    1 + ext_len(lit) + lit + 2 + ext_len(mlen - MIN_MATCH)
}

/// Compresses `src` into `dst`; the number of bytes written, or `None` if `dst` is too small
/// (`dst.len() >= bound(src.len())` always suffices) or `src` is over 4 GiB.
pub fn compress(src: &[u8], dst: &mut [u8]) -> Option<usize> {
    let n = src.len();
    if n > u32::MAX as usize - 1 {
        return None;
    }
    let mut table = [0u32; 1 << HASH_BITS]; // position + 1; 0 is empty
    let (mut ip, mut anchor, mut dp) = (0usize, 0usize, 0usize);
    if n > MF_LIMIT {
        let last_start = n - MF_LIMIT; // the last position a match may start at
        let match_end = n - LAST_LITERALS; // a match may not run past this
        let hash = |v: u32| (v.wrapping_mul(2654435761) >> (32 - HASH_BITS)) as usize;
        while ip <= last_start {
            let v = rd32(src, ip);
            let h = hash(v);
            let cand = table[h] as usize;
            table[h] = (ip + 1) as u32;
            if cand == 0 || ip - (cand - 1) > MAX_OFFSET || rd32(src, cand - 1) != v {
                // Skip faster through data that doesn't match.
                ip += 1 + ((ip - anchor) >> 6);
                continue;
            }
            let c = cand - 1;
            let mut m = MIN_MATCH;
            while ip + m + 8 <= match_end {
                let x = rd64(src, c + m) ^ rd64(src, ip + m);
                if x != 0 {
                    m += (x.trailing_zeros() / 8) as usize;
                    break;
                }
                m += 8;
            }
            if ip + m + 8 > match_end {
                while ip + m < match_end && src[c + m] == src[ip + m] {
                    m += 1;
                }
            }
            let lit = ip - anchor;
            if dst.len() - dp < seq_room(lit, m) {
                return None;
            }
            let tok = dp;
            dp += 1;
            let mut token = if lit >= 15 {
                dp = put_ext(dst, dp, lit - 15);
                15u8 << 4
            } else {
                (lit as u8) << 4
            };
            dst[dp..dp + lit].copy_from_slice(&src[anchor..ip]);
            dp += lit;
            dst[dp..dp + 2].copy_from_slice(&((ip - c) as u16).to_le_bytes());
            dp += 2;
            if m - MIN_MATCH >= 15 {
                token |= 15;
                dp = put_ext(dst, dp, m - MIN_MATCH - 15);
            } else {
                token |= (m - MIN_MATCH) as u8;
            }
            dst[tok] = token;
            ip += m;
            anchor = ip;
            if ip >= 2 && ip - 2 + 4 <= n {
                table[hash(rd32(src, ip - 2))] = (ip - 2 + 1) as u32;
            }
        }
    }
    // The final literals.
    let lit = n - anchor;
    if dst.len() - dp < 1 + ext_len(lit) + lit {
        return None;
    }
    if lit >= 15 {
        dst[dp] = 15 << 4;
        dp = put_ext(dst, dp + 1, lit - 15);
    } else {
        dst[dp] = (lit as u8) << 4;
        dp += 1;
    }
    dst[dp..dp + lit].copy_from_slice(&src[anchor..]);
    Some(dp + lit)
}

/// Decompresses a block into `dst`; the number of bytes produced, or `None` if the input is
/// malformed (truncated, an offset of 0 or before the start of the output, a length extension
/// running off the input) or the output doesn't fit in `dst`.
pub fn decompress(src: &[u8], dst: &mut [u8]) -> Option<usize> {
    let (mut sp, mut dp) = (0usize, 0usize);
    loop {
        let token = *src.get(sp)?;
        sp += 1;
        let mut lit = (token >> 4) as usize;
        if lit == 15 {
            loop {
                let b = *src.get(sp)?;
                sp += 1;
                lit = lit.checked_add(b as usize)?;
                if b != 255 {
                    break;
                }
            }
        }
        if lit > src.len() - sp || lit > dst.len() - dp {
            return None;
        }
        dst[dp..dp + lit].copy_from_slice(&src[sp..sp + lit]);
        sp += lit;
        dp += lit;
        if sp == src.len() {
            return Some(dp); // the last sequence has no match
        }
        if src.len() - sp < 2 {
            return None;
        }
        let off = u16::from_le_bytes([src[sp], src[sp + 1]]) as usize;
        sp += 2;
        if off == 0 || off > dp {
            return None;
        }
        let mut mlen = (token & 15) as usize;
        if mlen == 15 {
            loop {
                let b = *src.get(sp)?;
                sp += 1;
                mlen = mlen.checked_add(b as usize)?;
                if b != 255 {
                    break;
                }
            }
        }
        mlen = mlen.checked_add(MIN_MATCH)?;
        if mlen > dst.len() - dp {
            return None;
        }
        if off >= mlen {
            dst.copy_within(dp - off..dp - off + mlen, dp);
        } else {
            // Overlapping: the bytes just written are the source (offset 1 is a run).
            for i in 0..mlen {
                dst[dp + i] = dst[dp + i - off];
            }
        }
        dp += mlen;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            // xorshift64*
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545F4914F6CDD1D)
        }
        fn bytes(&mut self, n: usize) -> Vec<u8> {
            (0..n).map(|_| (self.next() >> 32) as u8).collect()
        }
    }

    fn roundtrip(src: &[u8]) -> usize {
        let mut c = vec![0u8; bound(src.len())];
        let n = compress(src, &mut c).expect("fits in bound");
        assert!(n <= bound(src.len()));
        let mut d = vec![0u8; src.len()];
        assert_eq!(decompress(&c[..n], &mut d), Some(src.len()));
        assert_eq!(d, src);
        n
    }

    #[test]
    fn empty_and_tiny() {
        assert_eq!(roundtrip(&[]), 1);
        let mut rng = Rng(1);
        for len in 1..=40 {
            roundtrip(&rng.bytes(len));
            roundtrip(&vec![7u8; len]);
            let v: Vec<u8> = (0..len).map(|i| (i % 3) as u8).collect();
            roundtrip(&v);
        }
    }

    #[test]
    fn zeros_compress_well() {
        let n = roundtrip(&vec![0u8; 1 << 20]);
        assert!(n < 5000, "{n}");
    }

    #[test]
    fn random_is_bounded() {
        let mut rng = Rng(2);
        let s = rng.bytes(100_000);
        let n = roundtrip(&s);
        assert!(n <= bound(s.len()));
    }

    #[test]
    fn text_like() {
        let words = [
            "the ", "quick ", "brown ", "fox ", "jumps ", "over ", "lazy ", "dog\n",
        ];
        let mut rng = Rng(3);
        let mut s = Vec::new();
        while s.len() < 200_000 {
            s.extend_from_slice(words[(rng.next() >> 40) as usize % words.len()].as_bytes());
        }
        let n = roundtrip(&s);
        assert!(n < s.len() * 6 / 10, "{n}");
    }

    #[test]
    fn mixed_pages() {
        let mut rng = Rng(4);
        let mut s = Vec::new();
        for p in 0..256 {
            match p % 4 {
                0 => s.extend(std::iter::repeat_n(0u8, 4096)),
                1 => s.extend(rng.bytes(4096)),
                2 => s.extend((0..4096).map(|i| (i / 16) as u8)),
                _ => {
                    for i in 0..512u64 {
                        s.extend_from_slice(&(0xffff_0000_0000_0000 + i * 8).to_le_bytes());
                    }
                }
            }
        }
        assert_eq!(s.len(), 1 << 20);
        roundtrip(&s);
    }

    #[test]
    fn long_literals_and_matches() {
        let mut rng = Rng(5);
        for lit in [
            14, 15, 16, 269, 270, 271, 300, 509, 510, 511, 525, 530, 1000, 5000,
        ] {
            // literals, then a repeat of them, then literals
            let s = rng.bytes(lit);
            for rep in [4usize, 18, 19, 20, 273, 274, 275, 528, 529, 530, 700, 5000] {
                let mut t = s.clone();
                let piece: Vec<u8> = (0..rep).map(|i| s[i % lit]).collect();
                t.extend_from_slice(&piece);
                t.extend(rng.bytes(30));
                roundtrip(&t);
            }
            let mut u = s.clone();
            u.extend(rng.bytes(7));
            roundtrip(&u);
        }
        // Lengths past 255 and 510 in both fields are really produced.
        let mut t = vec![1u8; 3];
        let mut rng2 = Rng(55);
        t.splice(1..1, rng2.bytes(600));
        t.extend_from_slice(&t.clone()[..600]);
        t.extend(rng2.bytes(20));
        let mut c = vec![0u8; bound(t.len())];
        let n = compress(&t, &mut c).unwrap();
        assert!(c[..n].windows(2).any(|w| w == [255, 255]) || n < t.len());
        roundtrip(&t);
    }

    #[test]
    fn overlapping_matches() {
        for len in [13, 14, 20, 100, 270, 600, 100_000] {
            let mut s = vec![9u8];
            s.extend(std::iter::repeat_n(b'x', len));
            roundtrip(&s);
            let s: Vec<u8> = (0..len).map(|i| [1u8, 2][i % 2]).collect();
            roundtrip(&s);
            let s: Vec<u8> = (0..len).map(|i| [1u8, 2, 3][i % 3]).collect();
            roundtrip(&s);
        }
        // Offset 1, by hand: literal 'a', match offset 1 length 10, then 5 literals.
        let blk = [0x16, b'a', 1, 0, 0x50, 1, 2, 3, 4, 5];
        let mut d = [0u8; 16];
        assert_eq!(decompress(&blk, &mut d), Some(16));
        assert_eq!(&d[..11], b"aaaaaaaaaaa");
        assert_eq!(&d[11..], &[1, 2, 3, 4, 5]);
    }

    #[test]
    fn window_limit() {
        // A repeat further back than 65535 bytes must not be matched at that distance.
        let mut rng = Rng(6);
        let head = rng.bytes(64);
        let mut s = head.clone();
        s.extend(rng.bytes(70_000));
        s.extend_from_slice(&head);
        s.extend(rng.bytes(20));
        roundtrip(&s);
    }

    #[test]
    fn dst_too_small() {
        let mut rng = Rng(7);
        let s = rng.bytes(1000);
        let mut c = vec![0u8; bound(s.len())];
        let n = compress(&s, &mut c).unwrap();
        for cap in [0, 1, 10, 500, n - 1] {
            assert_eq!(compress(&s, &mut c[..cap]), None, "cap {cap}");
        }
        let z = vec![0u8; 100_000];
        let mut cc = vec![0u8; bound(z.len())];
        let n = compress(&z, &mut cc).unwrap();
        assert_eq!(compress(&z, &mut cc[..n]), Some(n));
        assert_eq!(compress(&z, &mut cc[..n - 1]), None);

        let mut d = vec![0u8; z.len() - 1];
        assert_eq!(decompress(&cc[..n], &mut d), None);
        let mut d = vec![0u8; z.len()];
        assert_eq!(decompress(&cc[..n], &mut d), Some(z.len()));
        let mut d = vec![0u8; z.len() + 10];
        assert_eq!(decompress(&cc[..n], &mut d), Some(z.len()));
    }

    #[test]
    fn malformed_by_hand() {
        let mut d = [0u8; 64];
        assert_eq!(decompress(&[], &mut d), None);
        assert_eq!(decompress(&[0x10], &mut d), None); // literal missing
        assert_eq!(decompress(&[0x11, 1, 1], &mut d), None); // offset truncated
        assert_eq!(decompress(&[0x11, 1, 0, 0], &mut d), None); // offset 0
        assert_eq!(decompress(&[0x11, 1, 2, 0], &mut d), None); // offset before the start
        assert_eq!(decompress(&[0xf0], &mut d), None); // extension missing
        assert_eq!(decompress(&[0xf0, 255, 255], &mut d), None);
        assert_eq!(decompress(&[0x1f, 1, 1, 0, 255, 255], &mut d), None);
        assert_eq!(decompress(&[0x00], &mut d), Some(0));
    }

    #[test]
    fn truncations_never_panic() {
        let mut rng = Rng(8);
        let mut s = rng.bytes(300);
        s.extend(std::iter::repeat_n(0u8, 700));
        s.extend_from_slice(&rng.bytes(50));
        let mut c = vec![0u8; bound(s.len())];
        let n = compress(&s, &mut c).unwrap();
        let mut d = vec![0u8; s.len()];
        for k in 0..n {
            // A prefix is rejected, or ends at a sequence's literals and gives less output.
            if let Some(m) = decompress(&c[..k], &mut d) {
                assert!(m <= s.len());
            }
        }
        assert_eq!(decompress(&c[..n], &mut d), Some(s.len()));
    }

    #[test]
    fn garbage_never_panics() {
        let mut rng = Rng(9);
        let mut s = rng.bytes(2000);
        s.extend(vec![0u8; 3000]);
        let mut c = vec![0u8; bound(s.len())];
        let n = compress(&s, &mut c).unwrap();
        let mut d = vec![0u8; 8192];
        for _ in 0..5000 {
            let len = (rng.next() % 600) as usize;
            let r = rng.bytes(len);
            let _ = decompress(&r, &mut d);
        }
        for _ in 0..5000 {
            let mut m = c[..n].to_vec();
            for _ in 0..1 + rng.next() % 4 {
                let i = (rng.next() % n as u64) as usize;
                m[i] ^= 1 << (rng.next() % 8);
            }
            let _ = decompress(&m, &mut d);
            let mut tiny = [0u8; 16];
            let _ = decompress(&m, &mut tiny);
        }
        // Long runs of 255 extensions.
        let mut e = vec![0xffu8; 100_000];
        e[0] = 0xf0;
        assert_eq!(decompress(&e, &mut d), None);
        e.push(1);
        assert_eq!(decompress(&e, &mut d), None);
    }
}
