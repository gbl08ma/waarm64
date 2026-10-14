//! FEAT_RNG's source (`RNDR`, `RNDRRS`): a ChaCha20 stream per vCPU (RFC 8439's
//! block function), keyed by the host's CSPRNG in realtime mode
//! (`VmConfig.rng_seed`) and by a fixed key in deterministic mode, so step
//! counts stay exact. A read is one block's first 64 bits, the block counter
//! the only state (a snapshot keeps it). The nonce is the vCPU's index, so
//! no two vCPUs share a stream.

/// One vCPU's stream. All integers, valid zeroed (`mmu::Vcpu::new`).
#[derive(Clone, Copy, Debug, Default)]
pub struct Rng {
    key: [u32; 8],
    nonce: u32,
    /// The next block's counter (64 bits: the stream never wraps).
    pub counter: u64,
}

impl Rng {
    /// vCPU `cpu`'s stream from `seed` (the key's little-endian words).
    pub fn new(seed: [u64; 4], cpu: u32) -> Rng {
        let mut key = [0; 8];
        for (k, s) in key.as_chunks_mut::<2>().0.iter_mut().zip(seed) {
            (k[0], k[1]) = (s as u32, (s >> 32) as u32);
        }
        Rng {
            key,
            nonce: cpu,
            counter: 0,
        }
    }

    /// The next 64 random bits.
    pub fn draw(&mut self) -> u64 {
        let b = block(&self.key, self.counter, self.nonce);
        self.counter = self.counter.wrapping_add(1);
        b[0] as u64 | (b[1] as u64) << 32
    }
}

/// The ChaCha20 block function: 20 rounds over the constants, the key, a
/// 64-bit block counter (words 12 and 13; RFC 8439's 32-bit counter and the
/// nonce's first word) and the nonce (word 14; word 15 is 0).
fn block(key: &[u32; 8], counter: u64, nonce: u32) -> [u32; 16] {
    let mut s = [0u32; 16];
    s[..4].copy_from_slice(&[0x6170_7865, 0x3320_646e, 0x7962_2d32, 0x6b20_6574]);
    s[4..12].copy_from_slice(key);
    (s[12], s[13], s[14]) = (counter as u32, (counter >> 32) as u32, nonce);
    words(s)
}

/// 20 rounds and the final addition, on a whole input state.
fn words(input: [u32; 16]) -> [u32; 16] {
    let mut x = input;
    let qr = |x: &mut [u32; 16], a: usize, b: usize, c: usize, d: usize| {
        x[a] = x[a].wrapping_add(x[b]);
        x[d] = (x[d] ^ x[a]).rotate_left(16);
        x[c] = x[c].wrapping_add(x[d]);
        x[b] = (x[b] ^ x[c]).rotate_left(12);
        x[a] = x[a].wrapping_add(x[b]);
        x[d] = (x[d] ^ x[a]).rotate_left(8);
        x[c] = x[c].wrapping_add(x[d]);
        x[b] = (x[b] ^ x[c]).rotate_left(7);
    };
    for _ in 0..10 {
        qr(&mut x, 0, 4, 8, 12);
        qr(&mut x, 1, 5, 9, 13);
        qr(&mut x, 2, 6, 10, 14);
        qr(&mut x, 3, 7, 11, 15);
        qr(&mut x, 0, 5, 10, 15);
        qr(&mut x, 1, 6, 11, 12);
        qr(&mut x, 2, 7, 8, 13);
        qr(&mut x, 3, 4, 9, 14);
    }
    for (o, i) in x.iter_mut().zip(input) {
        *o = o.wrapping_add(i);
    }
    x
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 8439 §2.3.2's test vector: key 00..1f, counter 1, nonce
    /// 000000090000004a00000000 (as our layout: counter word 13 = 0x09000000,
    /// word 14 = 0x4a000000).
    #[test]
    fn rfc8439_block() {
        let key: [u32; 8] = core::array::from_fn(|i| {
            u32::from_le_bytes(core::array::from_fn(|j| (4 * i + j) as u8))
        });
        let b = block(&key, 0x0900_0000 << 32 | 1, 0x4a00_0000);
        assert_eq!(
            b,
            [
                0xe4e7f110, 0x15593bd1, 0x1fdd0f50, 0xc47120a3, 0xc7f4d1c7, 0x0368c033, 0x9aaa2204,
                0x4e6cd4c3, 0x466482d2, 0x09aa9f07, 0x05d7c214, 0xa2028bd9, 0xd19c12b5, 0xb94e16de,
                0xe883d0cb, 0x4e3c50a2,
            ]
        );
    }

    /// The streams: the counter moves, vCPUs and seeds differ, a seed repeats.
    #[test]
    fn streams() {
        let mut a = Rng::new([1, 2, 3, 4], 0);
        let (x, y) = (a.draw(), a.draw());
        assert_ne!(x, y);
        assert_eq!(a.counter, 2);
        assert_eq!(Rng::new([1, 2, 3, 4], 0).draw(), x);
        assert_ne!(Rng::new([1, 2, 3, 4], 1).draw(), x);
        assert_ne!(Rng::new([1, 2, 3, 5], 0).draw(), x);
    }
}
