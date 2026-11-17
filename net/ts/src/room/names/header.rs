//! A Bitcoin block header as the names' clock (room-names.md "Bitcoin as the clock"): it proves
//! itself, with no height and no explorer. Its hash, its proof of work against its own target, that
//! target against the one floor compiled in ([`Params::floor`]), and its time no further past now
//! than block times may run ahead. An anchor carries its block's header alone.

use sha2::{Digest, Sha256};

use super::{Invalid, Params};

pub const HEADER_LEN: usize = 80;

/// An 80-byte header, as Bitcoin serializes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Header(pub [u8; HEADER_LEN]);

/// SHA-256 twice, as Bitcoin hashes headers and transactions.
pub fn sha256d(b: &[u8]) -> [u8; 32] {
    Sha256::digest(Sha256::digest(b)).into()
}

/// The target a header's compact `bits` stands for, as a big-endian 256-bit number; None when it
/// is negative, zero or overflows (Bitcoin's own reading).
pub fn target(bits: u32) -> Option<[u8; 32]> {
    let e = (bits >> 24) as i32;
    let m = bits & 0x007f_ffff;
    if bits & 0x0080_0000 != 0 || m == 0 {
        return None;
    }
    let mut t = [0u8; 32];
    if e <= 3 {
        let v = m >> (8 * (3 - e));
        t[28..].copy_from_slice(&v.to_be_bytes());
    } else {
        let mb = [(m >> 16) as u8, (m >> 8) as u8, m as u8];
        for (i, &b) in mb.iter().enumerate() {
            let pos = 32 - e + i as i32;
            if pos < 0 {
                if b != 0 {
                    return None;
                }
            } else {
                t[pos as usize] = b;
            }
        }
    }
    (t != [0; 32]).then_some(t)
}

impl Header {
    pub fn from_bytes(b: &[u8]) -> Option<Header> {
        Some(Header(b.try_into().ok()?))
    }

    /// The block's hash, in the byte order Bitcoin computes it (explorers show it reversed).
    pub fn hash(&self) -> [u8; 32] {
        sha256d(&self.0)
    }

    /// The hash of the block before, as Bitcoin computes it.
    pub fn prev(&self) -> [u8; 32] {
        self.0[4..36].try_into().unwrap()
    }

    pub fn merkle_root(&self) -> [u8; 32] {
        self.0[36..68].try_into().unwrap()
    }

    pub fn time(&self) -> u32 {
        u32::from_le_bytes(self.0[68..72].try_into().unwrap())
    }

    pub fn bits(&self) -> u32 {
        u32::from_le_bytes(self.0[72..76].try_into().unwrap())
    }

    /// Whether the header proves itself at `now` (Unix seconds): its hash under its own target,
    /// that target no easier than the floor, its time at most `drift` past now.
    pub fn check(&self, params: &Params, now: u64) -> Result<(), Invalid> {
        let t = target(self.bits()).ok_or(Invalid::HeaderWork)?;
        let mut h = self.hash();
        h.reverse();
        if h > t {
            return Err(Invalid::HeaderWork);
        }
        if t > target(params.floor).expect("a valid floor") {
            return Err(Invalid::HeaderFloor);
        }
        if self.time() as u64 > now + params.drift as u64 {
            return Err(Invalid::HeaderFuture);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_targets() {
        // Difficulty 1: 0x00000000ffff0000...
        let t = target(0x1d00_ffff).unwrap();
        assert_eq!(t[..6], [0, 0, 0, 0, 0xff, 0xff]);
        assert!(t[6..].iter().all(|&b| b == 0));
        // Regtest's.
        let t = target(0x207f_ffff).unwrap();
        assert_eq!(t[..3], [0x7f, 0xff, 0xff]);
        // Small exponents shift right; negative, zero and overflowing ones are refused.
        assert_eq!(target(0x0312_3456).unwrap()[29..], [0x12, 0x34, 0x56]);
        assert_eq!(target(0x0212_3456).unwrap()[30..], [0x12, 0x34]);
        assert_eq!(target(0x0180_0000), None);
        assert_eq!(target(0x1d00_0000), None);
        assert_eq!(target(0x2301_0000), None);
        assert!(target(0x2200_0001).is_some());
        // Production's floor is 1/16 of block 976,177's difficulty: sixteen times its target.
        let (a, f) = (
            target(0x1702_1673).unwrap(),
            target(Params::PRODUCTION.floor).unwrap(),
        );
        let a = u128::from_be_bytes(a[..16].try_into().unwrap());
        let f = u128::from_be_bytes(f[..16].try_into().unwrap());
        assert_eq!(f, a * 16);
    }
}
