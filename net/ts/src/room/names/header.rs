//! A Bitcoin block header as the names' clock (room-names.md "Bitcoin as the clock"): it proves
//! itself, with no height and no explorer. Its hash, its proof of work against its own target, that
//! target against the floor compiled in for the header's own time ([`floor`]), and its time no
//! further past now than block times may run ahead. An anchor's block comes with the [`FOLLOWERS`]
//! headers after it ([`Run`]), each naming the one before, so that a forged time costs seven
//! headers' work at the floor, not one.

use sha2::{Digest, Sha256};

use super::{Invalid, Params};

pub const HEADER_LEN: usize = 80;
/// The headers an anchor's block carries after it.
pub const FOLLOWERS: usize = 6;

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
    /// that target no easier than the floor at the header's time, its time at most `drift` past
    /// now.
    pub fn check(&self, params: &Params, now: u64) -> Result<(), Invalid> {
        let t = target(self.bits()).ok_or(Invalid::HeaderWork)?;
        let mut h = self.hash();
        h.reverse();
        if h > t {
            return Err(Invalid::HeaderWork);
        }
        if t > floor(params, self.time()) {
            return Err(Invalid::HeaderFloor);
        }
        if self.time() as u64 > now + params.drift as u64 {
            return Err(Invalid::HeaderFuture);
        }
        Ok(())
    }
}

/// The floor at header time `time`: the easiest target a header of that time may claim (room-names.md "Bitcoin as the
/// clock"). The latest point of the schedule at or before `time`, its target doubled every `floor_step` seconds past
/// it, `floor_steps` times at most; a time before the first point takes the first point's.
pub fn floor(params: &Params, time: u32) -> [u8; 32] {
    let pts = params.floor;
    let i = pts.partition_point(|p| p.0 <= time);
    let (bits, steps) = match i {
        0 => (pts[0].1, 0),
        _ => {
            let (at, bits) = pts[i - 1];
            (
                bits,
                ((time - at) / params.floor_step).min(params.floor_steps),
            )
        }
    };
    shl(target(bits).expect("a valid floor"), steps)
}

/// `t` (big-endian) times `2^k`, saturating.
fn shl(t: [u8; 32], k: u32) -> [u8; 32] {
    let mut v = t;
    for _ in 0..k {
        if v[0] & 0x80 != 0 {
            return [0xff; 32];
        }
        let mut carry = 0u8;
        for b in v.iter_mut().rev() {
            let next = *b >> 7;
            *b = (*b << 1) | carry;
            carry = next;
        }
    }
    v
}

/// An anchor's block's header and the [`FOLLOWERS`] after it, each naming the one before
/// (room-names.md "Records"): what an anchor's time rests on.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Run {
    pub block: Header,
    pub next: Vec<Header>,
}

impl Run {
    /// Whether the run proves its block at `now`: every header proves itself (at the floor of its own time), there are
    /// [`FOLLOWERS`] after the block, each names the one before, and each is timed from the block's time less
    /// `drift` to the block's time plus `run_span` (so a forger can't time the followers where the floor is lowest).
    pub fn check(&self, params: &Params, now: u64) -> Result<(), Invalid> {
        self.block.check(params, now)?;
        if self.next.len() != FOLLOWERS {
            return Err(Invalid::HeaderRun);
        }
        let b = self.block.time() as u64;
        let mut prev = self.block.hash();
        for h in &self.next {
            let t = h.time() as u64;
            if h.prev() != prev || t + (params.drift as u64) < b || t > b + params.run_span as u64 {
                return Err(Invalid::HeaderRun);
            }
            h.check(params, now)?;
            prev = h.hash();
        }
        Ok(())
    }

    /// The followers' hashes: what tells two runs of one block apart.
    pub fn next_hashes(&self) -> Vec<[u8; 32]> {
        self.next.iter().map(Header::hash).collect()
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
        // Production's first point is half of block 976,177's difficulty: twice its target.
        let (a, f) = (
            target(0x1702_1673).unwrap(),
            target(Params::PRODUCTION.floor[0].1).unwrap(),
        );
        let a = u128::from_be_bytes(a[..16].try_into().unwrap());
        let f = u128::from_be_bytes(f[..16].try_into().unwrap());
        assert_eq!(f, a * 2);
        assert_eq!(Params::PRODUCTION.floor[0].0, 1_794_857_121, "its time");
    }

    #[test]
    fn doubling_saturates() {
        let mut t = [0u8; 32];
        t[31] = 1;
        assert_eq!(shl(t, 3)[31], 8);
        t[31] = 0x81;
        assert_eq!(shl(t, 1)[30..], [1, 2]);
        let mut top = [0u8; 32];
        top[0] = 0x40;
        assert_eq!(shl(top, 1)[0], 0x80);
        assert_eq!(shl(top, 2), [0xff; 32]);
    }

    #[test]
    fn the_floor_by_time() {
        // A schedule of two points: before the first, the first's; past each, its target doubled each step, five
        // times at most.
        const STEP: u32 = 21 * 24 * 3600;
        let p = Params {
            floor: &[(1_000_000, 0x1d00_ffff), (100_000_000, 0x1c00_ffff)],
            ..Params::PRODUCTION
        };
        assert_eq!(p.floor_step, STEP);
        let t1 = target(0x1d00_ffff).unwrap();
        let t2 = target(0x1c00_ffff).unwrap();
        assert_eq!(floor(&p, 0), t1);
        assert_eq!(floor(&p, 999_999), t1);
        assert_eq!(floor(&p, 1_000_000), t1);
        assert_eq!(floor(&p, 1_000_000 + STEP - 1), t1);
        assert_eq!(floor(&p, 1_000_000 + STEP), shl(t1, 1));
        assert_eq!(floor(&p, 1_000_000 + 5 * STEP), shl(t1, 5));
        assert_eq!(
            floor(&p, 1_000_000 + 50 * STEP),
            shl(t1, 5),
            "five times at most"
        );
        assert_eq!(floor(&p, 100_000_000), t2);
        assert_eq!(floor(&p, u32::MAX), shl(t2, 5));
        // A point added later changes nothing before it: the old entries chains carry keep their floor.
        let q = Params {
            floor: &[
                (1_000_000, 0x1d00_ffff),
                (100_000_000, 0x1c00_ffff),
                (200_000_000, 0x1b00_ffff),
            ],
            ..p.clone()
        };
        for t in (0..200_000_000u32).step_by(997_003) {
            assert_eq!(floor(&p, t), floor(&q, t), "{t}");
        }
        // The schedule compiled in: points in time order, valid targets.
        let s = Params::PRODUCTION.floor;
        assert!(s.windows(2).all(|w| w[0].0 < w[1].0));
        assert!(s.iter().all(|p| target(p.1).is_some()));
    }
}
