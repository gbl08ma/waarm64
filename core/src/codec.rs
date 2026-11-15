//! The snapshot file's codec 2 and its frames' checksum (docs/platform.md "The snapshot file"; docs/abi.md "SNAPZ: the
//! snapshot codec and CRC"): the LZ4 *block* format through lz4_flex (its safe encoder and decoder, no allocation),
//! and the IEEE CRC-32 through crc32fast.
//!
//! The decompressor reads files a user chose: any input gives `None` or a result, never a panic or an access
//! outside its slices (the tests below throw truncations, flipped bits and garbage at it).

/// The worst-case compressed size of `len` input bytes: `compress` needs this much room.
pub const fn bound(len: usize) -> usize {
    lz4_flex::block::get_maximum_output_size(len)
}

/// Compresses `src` into `dst`; the number of bytes written, or `None` if `dst` is under `bound(src.len())`.
pub fn compress(src: &[u8], dst: &mut [u8]) -> Option<usize> {
    lz4_flex::block::compress_into(src, dst).ok()
}

/// Decompresses a block into `dst`; the number of bytes produced, or `None` if the input is malformed (truncated, an
/// offset before the start of the output, a length running off the input) or the output doesn't fit in `dst`.
pub fn decompress(src: &[u8], dst: &mut [u8]) -> Option<usize> {
    lz4_flex::block::decompress_into(src, dst).ok()
}

/// The IEEE CRC-32 of `bytes`, continued from `seed` (the CRC of what came before; 0 to start), as zlib's `crc32`.
pub fn crc32(seed: u32, bytes: &[u8]) -> u32 {
    let mut h = crc32fast::Hasher::new_with_initial(seed);
    h.update(bytes);
    h.finalize()
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
        assert!(d == src, "a round trip of {} bytes differs", src.len());
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
        // A frame's largest payload (a RAM chunk and its bitmap), at its bound.
        s.extend(rng.bytes(32));
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
        // Under the bound, compressing refuses (lz4_flex checks the room up front).
        let mut rng = Rng(7);
        for s in [rng.bytes(1000), vec![0u8; 100_000], Vec::new()] {
            let b = bound(s.len());
            let mut c = vec![0u8; b];
            let n = compress(&s, &mut c).unwrap();
            for cap in [0, 1, b / 2, b - 1] {
                assert_eq!(compress(&s, &mut c[..cap]), None, "cap {cap} of {b}");
            }
            assert_eq!(compress(&s, &mut c[..b]), Some(n));
        }
        // Decompressing into less than the output refuses; into more gives the output's size.
        let z = vec![0u8; 100_000];
        let mut cc = vec![0u8; bound(z.len())];
        let n = compress(&z, &mut cc).unwrap();
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
        assert_eq!(decompress(&[0x10], &mut d), None); // literal missing
        assert_eq!(decompress(&[0x11, 1, 1], &mut d), None); // offset truncated
        assert_eq!(decompress(&[0x11, 1, 2, 0], &mut d), None); // offset before the start
        assert_eq!(decompress(&[0xf0], &mut d), None); // extension missing
        assert_eq!(decompress(&[0xf0, 255, 255], &mut d), None);
        assert_eq!(decompress(&[0x1f, 1, 1, 0, 255, 255], &mut d), None);
        assert_eq!(decompress(&[0x00], &mut d), Some(0));
        // Offset 0 (no encoder writes it) is taken, from bytes of the output: no access outside it.
        let _ = decompress(&[], &mut d);
        let _ = decompress(&[0x11, 1, 0, 0], &mut d);
        let _ = decompress(&[0x11, 1, 0, 0], &mut d[..5]);
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
        s.extend((0..3000).map(|i| (i % 7) as u8));
        let mut c = vec![0u8; bound(s.len())];
        let n = compress(&s, &mut c).unwrap();
        let mut d = vec![0u8; 8192];
        for _ in 0..5000 {
            let len = (rng.next() % 600) as usize;
            let r = rng.bytes(len);
            let _ = decompress(&r, &mut d);
        }
        for _ in 0..20000 {
            let mut m = c[..n].to_vec();
            for _ in 0..1 + rng.next() % 4 {
                let i = (rng.next() % n as u64) as usize;
                m[i] ^= 1 << (rng.next() % 8);
            }
            let _ = decompress(&m, &mut d);
            let cap = (rng.next() % 64) as usize;
            let _ = decompress(&m, &mut d[..cap]);
            let _ = decompress(&m, &mut d[..s.len() - 1]);
            let _ = decompress(&m, &mut d[..s.len()]);
        }
        // Long runs of 255 extensions.
        let mut e = vec![0xffu8; 100_000];
        e[0] = 0xf0;
        assert_eq!(decompress(&e, &mut d), None);
        e.push(1);
        assert_eq!(decompress(&e, &mut d), None);
    }

    #[test]
    fn crc32_check_values() {
        assert_eq!(crc32(0, b"123456789"), 0xcbf4_3926);
        assert_eq!(crc32(0, b""), 0);
        let mut rng = Rng(10);
        let s = rng.bytes(10_000);
        for k in [0, 1, 7, 8, 9, 63, 64, 65, 5000, 10_000] {
            assert_eq!(
                crc32(crc32(0, &s[..k]), &s[k..]),
                crc32(0, &s),
                "split at {k}"
            );
        }
    }
}
