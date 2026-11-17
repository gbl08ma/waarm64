//! A pretend Bitcoin for the registry's tests (and the room's, room/tests/names.rs): easy headers
//! mined to their own target, anchors made up to a header's Merkle root, cheap proof of work, and
//! titles made of them.

use k256::schnorr::SigningKey;

use super::{
    Params,
    anchor::{Anchor, Op, apply},
    entry::{Entry, Kind, Pow, Stamped},
    header::{FOLLOWERS, Header, Run, target},
    id::{RoomNames, owner_key},
    wire::{Item, WireEntry},
    zone::Zone,
};

pub const HOUR: u32 = 3600;
pub const DAY: u32 = 24 * HOUR;
/// Regtest's target: half of all hashes are under it.
pub const EASY: u32 = 0x207f_ffff;

/// The spec's clock with cheap proof of work and a floor any pretend header meets.
pub fn params() -> Params {
    Params::TEST
}

/// SplitMix64: the tests' only randomness.
pub struct Rng(pub u64);

impl Rng {
    #[allow(clippy::should_implement_trait)] // never ends: not an iterator
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    pub fn bytes<const N: usize>(&mut self) -> [u8; N] {
        let mut b = [0u8; N];
        for c in b.chunks_mut(8) {
            c.copy_from_slice(&self.next().to_le_bytes()[..c.len()]);
        }
        b
    }
}

/// A header at `time` over `root`, mined to its own `bits`, after a made-up block.
pub fn header(rng: &mut Rng, time: u32, root: [u8; 32], bits: u32) -> Header {
    let prev = rng.bytes::<32>();
    after(prev, time, root, bits)
}

/// A header at `time` over `root` naming block `prev`, mined to its own `bits`.
pub fn after(prev: [u8; 32], time: u32, root: [u8; 32], bits: u32) -> Header {
    let t = target(bits).unwrap();
    let mut h = [0u8; 80];
    h[..4].copy_from_slice(&0x2000_0000u32.to_le_bytes());
    h[4..36].copy_from_slice(&prev);
    h[36..68].copy_from_slice(&root);
    h[68..72].copy_from_slice(&time.to_le_bytes());
    h[72..76].copy_from_slice(&bits.to_le_bytes());
    for nonce in 0u32.. {
        h[76..].copy_from_slice(&nonce.to_le_bytes());
        let mut x = Header(h).hash();
        x.reverse();
        if x <= t {
            break;
        }
    }
    Header(h)
}

/// A clock past every pretend time, for checks that don't test the future.
pub const LATE: u64 = u32::MAX as u64;

pub struct Bitcoin {
    pub rng: Rng,
    pub params: Params,
    pub names: RoomNames,
    pub pow: Pow,
}

impl Bitcoin {
    pub fn new(room: &str, seed: u64) -> Bitcoin {
        let params = params();
        Bitcoin {
            rng: Rng(seed),
            pow: Pow::new(&params),
            params,
            names: RoomNames::derive(room),
        }
    }

    pub fn key(&self, secret: u8, name: &str) -> SigningKey {
        owner_key(&[secret; 32], &self.names, name)
    }

    /// An entry made after a `ref` block at `ref_time`, worked and signed; no anchor.
    pub fn entry(
        &mut self,
        kind: Kind,
        key: &SigningKey,
        name: &str,
        prev: [u8; 32],
        ref_time: u32,
    ) -> Stamped {
        let root = self.rng.bytes();
        let r = header(&mut self.rng, ref_time, root, EASY);
        let owner = key.verifying_key().to_bytes().into();
        let mut e = Entry::new(
            &self.names,
            kind,
            self.names.name_id(name),
            owner,
            prev,
            r.hash(),
        );
        e.nonce = self.rng.next();
        assert!(self.pow.mine(&mut e, 1 << 20));
        e.sign(key, &self.names);
        Stamped::check(e, r, &self.names, &self.params, &mut self.pow, LATE).unwrap()
    }

    /// An anchor for `id` in a block at `time`: a calendar's kind of path to a made-up root.
    pub fn anchor(&mut self, id: &[u8; 32], time: u32) -> (Anchor, Run) {
        let ops = vec![
            Op::Append(self.rng.bytes::<16>().to_vec()),
            Op::Sha256,
            Op::Prepend(self.rng.bytes::<32>().to_vec()),
            Op::Sha256,
        ];
        let root: [u8; 32] = apply(&ops, id).unwrap().try_into().unwrap();
        (
            Anchor {
                ops,
                height: 900_000,
            },
            self.run(time, root),
        )
    }

    /// A block at `time` over `root` and the six after it, ten minutes apart, each naming the one before.
    pub fn run(&mut self, time: u32, root: [u8; 32]) -> Run {
        let block = header(&mut self.rng, time, root, EASY);
        let mut next = Vec::new();
        let mut prev = block.hash();
        for k in 1..=FOLLOWERS as u32 {
            let root = self.rng.bytes();
            let h = after(prev, time + 600 * k, root, EASY);
            prev = h.hash();
            next.push(h);
        }
        Run { block, next }
    }

    /// An entry anchored at `time` (its `ref` an hour before).
    pub fn at(
        &mut self,
        kind: Kind,
        key: &SigningKey,
        name: &str,
        prev: [u8; 32],
        time: u32,
    ) -> Stamped {
        let mut s = self.entry(kind, key, name, prev, time - HOUR);
        let (a, h) = self.anchor(&s.id(), time);
        assert_eq!(s.offer_anchor(a, h, &self.params, LATE), Ok(true));
        s
    }

    /// A title: a claim at `claim` and a renewal at each of `renewals`, all anchored, and a zone
    /// pointing the name at `node`.
    pub fn title(
        &mut self,
        secret: u8,
        name: &str,
        claim: u32,
        renewals: &[u32],
        node: [u8; 32],
    ) -> ([u8; 32], Item) {
        let key = self.key(secret, name);
        let mut run = vec![self.at(Kind::Claim, &key, name, [0; 32], claim)];
        for t in renewals {
            let prev = run.last().unwrap().id();
            run.push(self.at(Kind::Renew, &key, name, prev, *t));
        }
        let zone = Zone::seal(&self.names, &key, name, 1, &[(None, node)], false).unwrap();
        (key.to_bytes().into(), self.item(name, &run, Some(zone)))
    }

    pub fn item(&self, name: &str, entries: &[Stamped], zone: Option<Zone>) -> Item {
        Item {
            id: self.names.name_id(name),
            entries: entries.iter().map(WireEntry::of).collect(),
            zone,
        }
    }
}
