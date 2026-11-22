//! Zones (names.md "Names nobody lists", "Records"): where a name points, a signed, numbered
//! record replaced whole. Version (2), room, name id, owner, `seq` (8 bytes), 4 or 16 slots of 56
//! bytes, a signature: 366 or 1,038 bytes.
//!
//! A slot is an 8-byte tag and a node key sealed with ChaCha20-Poly1305 (32 bytes and its 16-byte
//! tag), the tag and the AEAD's key both derived from the room's seal key, the name id, the owner
//! key, the full name asked (`test123`, `git.test123`) and `seq`, so no key or tag is used twice
//! across versions or owners and
//! unused slots (random bytes) can't be told from used ones. The AEAD's associated data is the
//! zone's head, so a slot can't be moved to another name, owner or version. Slots are sorted by
//! their bytes, so their order says nothing. The owner signs the sealed bytes: anyone can check a
//! zone without reading it; whoever knows a name opens its slot.

use chacha20poly1305::{
    ChaCha20Poly1305, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use k256::schnorr::SigningKey;
use sha2::{Digest, Sha256};

use super::{
    Invalid, arr,
    entry::{sign, tagged, verify},
    id::{RoomNames, acceptable, keyed, split},
};

pub const SLOT_LEN: usize = 56;
/// A zone's version byte: 2 since `seq` took 8 bytes (each copy of a title a 32-bit branch in its low half: the
/// names agent).
pub const ZONE_VERSION: u8 = 2;
/// Version, room, name id, owner, `seq`.
const HEAD_LEN: usize = 1 + 5 + 32 + 32 + 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Zone {
    pub room: [u8; 5],
    pub name: [u8; 32],
    pub owner: [u8; 32],
    pub seq: u64,
    pub slots: Vec<[u8; SLOT_LEN]>,
    pub sig: [u8; 64],
}

/// A slot's tag and AEAD key for `full` (relative to the room's domain) in a zone of name id `name` by `owner` at
/// `seq`: two owners of one name (after a lapse, or a back-order) both start at a small `seq`, so the owner is taken
/// too, or their zones would share keystreams and tags.
fn slot_keys(
    names: &RoomNames,
    full: &str,
    name: &[u8; 32],
    owner: &[u8; 32],
    seq: u64,
) -> ([u8; 8], [u8; 32]) {
    let s = seq.to_le_bytes();
    let tag = keyed(&names.seal, &[b"tag", name, owner, &s, full.as_bytes()]);
    let key = keyed(&names.seal, &[b"key", name, owner, &s, full.as_bytes()]);
    (tag[..8].try_into().unwrap(), key)
}

impl Zone {
    fn head(&self) -> [u8; HEAD_LEN] {
        let mut h = [0u8; HEAD_LEN];
        h[0] = ZONE_VERSION;
        h[1..6].copy_from_slice(&self.room);
        h[6..38].copy_from_slice(&self.name);
        h[38..70].copy_from_slice(&self.owner);
        h[70..78].copy_from_slice(&self.seq.to_le_bytes());
        h
    }

    /// A zone for `name` at `seq`: each of `points` (the name itself as None, or a label under it)
    /// sealed to its node key, `wide` for 16 slots (else 4), the rest random; signed by `key`.
    pub fn seal(
        names: &RoomNames,
        key: &SigningKey,
        name: &str,
        seq: u64,
        points: &[(Option<&str>, [u8; 32])],
        wide: bool,
    ) -> Result<Zone, Invalid> {
        let n = if wide { 16 } else { 4 };
        if points.len() > n || !acceptable(name) {
            return Err(Invalid::Zone);
        }
        let mut z = Zone {
            room: names.room,
            name: names.name_id(name),
            owner: key.verifying_key().to_bytes().into(),
            seq,
            slots: Vec::with_capacity(n),
            sig: [0; 64],
        };
        let head = z.head();
        let mut fulls = Vec::new();
        for (sub, node) in points {
            let full = match sub {
                Some(s) => format!("{s}.{name}"),
                None => name.to_string(),
            };
            if split(&full).is_none_or(|(s, m)| s != *sub || m != name) || fulls.contains(&full) {
                return Err(Invalid::Zone);
            }
            let (tag, k) = slot_keys(names, &full, &z.name, &z.owner, seq);
            let ct = ChaCha20Poly1305::new(&k.into())
                .encrypt(
                    &Nonce::default(),
                    Payload {
                        msg: node,
                        aad: &head,
                    },
                )
                .expect("sealing a key");
            let mut slot = [0u8; SLOT_LEN];
            slot[..8].copy_from_slice(&tag);
            slot[8..].copy_from_slice(&ct);
            z.slots.push(slot);
            fulls.push(full);
        }
        while z.slots.len() < n {
            #[cfg(not(test))]
            let slot = {
                let mut slot = [0u8; SLOT_LEN];
                getrandom::fill(&mut slot).map_err(|_| Invalid::Zone)?;
                slot
            };
            #[cfg(test)]
            let slot: [u8; SLOT_LEN] = super::server::random();
            z.slots.push(slot);
        }
        z.slots.sort();
        z.sig = sign(key, &z.sighash(names));
        Ok(z)
    }

    pub fn sighash(&self, names: &RoomNames) -> [u8; 32] {
        let b = self.encode();
        tagged("waarm64/names/zone", &[&names.value, &b[..b.len() - 64]])
    }

    /// Whether the zone is this room's and its owner signed it. Whether that owner holds the name
    /// is the chain's to say ([`super::chain`]).
    pub fn verify(&self, names: &RoomNames) -> bool {
        self.room == names.room && verify(&self.owner, &self.sighash(names), &self.sig)
    }

    /// The node key `full` (relative to the room's domain) points to, if the zone holds it.
    pub fn open(&self, names: &RoomNames, full: &str) -> Option<[u8; 32]> {
        let (_, name) = split(full)?;
        if names.name_id(name) != self.name {
            return None;
        }
        let (tag, k) = slot_keys(names, full, &self.name, &self.owner, self.seq);
        let head = self.head();
        let aead = ChaCha20Poly1305::new(&k.into());
        self.slots.iter().filter(|s| s[..8] == tag).find_map(|s| {
            aead.decrypt(
                &Nonce::default(),
                Payload {
                    msg: &s[8..],
                    aad: &head,
                },
            )
            .ok()?
            .try_into()
            .ok()
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut b = self.head().to_vec();
        for s in &self.slots {
            b.extend_from_slice(s);
        }
        b.extend_from_slice(&self.sig);
        b
    }

    pub fn decode(b: &[u8]) -> Result<Zone, Invalid> {
        let slots = match b
            .len()
            .checked_sub(HEAD_LEN + 64)
            .map(|n| (n / SLOT_LEN, n % SLOT_LEN))
        {
            Some((n @ (4 | 16), 0)) => n,
            _ => return Err(Invalid::Encoding),
        };
        if b[0] != ZONE_VERSION {
            return Err(Invalid::Encoding);
        }
        Ok(Zone {
            room: arr(b, 1),
            name: arr(b, 6),
            owner: arr(b, 38),
            seq: u64::from_le_bytes(arr(b, 70)),
            slots: (0..slots)
                .map(|i| arr(b, HEAD_LEN + i * SLOT_LEN))
                .collect(),
            sig: arr(b, b.len() - 64),
        })
    }

    /// Whether this zone replaces `other`: the higher `seq`; equal, the lower hash.
    pub fn beats(&self, other: &Zone) -> bool {
        self.seq > other.seq
            || self.seq == other.seq
                && Sha256::digest(self.encode()) < Sha256::digest(other.encode())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::room::names::id::owner_key;

    #[test]
    fn a_zone_seals_opens_and_reads_back() {
        let names = RoomNames::derive("zone test");
        let key = owner_key(&[1; 32], &names, "test123");
        let z = Zone::seal(
            &names,
            &key,
            "test123",
            7,
            &[(None, [0xaa; 32]), (Some("git"), [0xbb; 32])],
            false,
        )
        .unwrap();
        let b = z.encode();
        assert_eq!(b.len(), 366);
        assert_eq!(Zone::decode(&b), Ok(z.clone()));
        assert!(z.verify(&names));
        assert_eq!(z.open(&names, "test123"), Some([0xaa; 32]));
        assert_eq!(z.open(&names, "git.test123"), Some([0xbb; 32]));
        assert_eq!(z.open(&names, "www.test123"), None);
        let w = Zone::seal(&names, &key, "test123", 8, &[(None, [0xaa; 32])], true).unwrap();
        assert_eq!(w.encode().len(), 1038);
        assert_eq!(Zone::decode(&w.encode()), Ok(w.clone()));
        // Signed over the sealed bytes: a slot changed, the signature fails; another room's
        // value too.
        let mut x = z.clone();
        x.slots[0][20] ^= 1;
        assert!(!x.verify(&names));
        let mut other = RoomNames::derive("other");
        other.room = names.room;
        assert!(!z.verify(&other));
        assert!(Zone::decode(&b[..365]).is_err());
        assert!(
            Zone::decode(&[&b[..], &[0; 56]].concat()).is_err(),
            "5 slots"
        );
        // Too many places, a label twice, a bad label.
        let five: Vec<_> = ["a", "b", "c", "d", "e"]
            .iter()
            .map(|s| (Some(*s), [0; 32]))
            .collect();
        assert_eq!(
            Zone::seal(&names, &key, "test123", 1, &five, false),
            Err(Invalid::Zone)
        );
        assert!(Zone::seal(&names, &key, "test123", 1, &five, true).is_ok());
        assert_eq!(
            Zone::seal(
                &names,
                &key,
                "test123",
                1,
                &[(None, [0; 32]), (None, [1; 32])],
                false
            ),
            Err(Invalid::Zone)
        );
        assert_eq!(
            Zone::seal(&names, &key, "test123", 1, &[(Some("-x"), [0; 32])], false),
            Err(Invalid::Zone)
        );
        assert_eq!(
            Zone::seal(&names, &key, "wpad", 1, &[], false),
            Err(Invalid::Zone)
        );
    }

    #[test]
    fn a_zone_opens_only_under_its_own_name() {
        let names = RoomNames::derive("zone test");
        let key = owner_key(&[1; 32], &names, "alpha");
        let z = Zone::seal(
            &names,
            &key,
            "alpha",
            3,
            &[(None, [0xaa; 32]), (Some("git"), [0xbb; 32])],
            false,
        )
        .unwrap();
        // Another name's key, even with this zone's name id put on it, opens nothing; nor does
        // another seq or another room.
        let mut moved = z.clone();
        moved.name = names.name_id("beta");
        assert_eq!(moved.open(&names, "beta"), None);
        assert_eq!(moved.open(&names, "git.beta"), None);
        let mut later = z.clone();
        later.seq = 4;
        assert_eq!(later.open(&names, "alpha"), None);
        // `seq` is 64 bits, a copy's branch in the low half: two branches at one count seal under different keys
        // and tags (only the high half differing as well).
        let at = |seq: u64| {
            let x = Zone::seal(&names, &key, "alpha", seq, &[(None, [0xaa; 32])], false).unwrap();
            (x.open(&names, "alpha"), x)
        };
        let (a, za) = at((5 << 32) | 0x8000_0001);
        let (b, zb) = at((5 << 32) | 0x0000_0001);
        let (c, zc) = at((6 << 32) | 0x8000_0001);
        assert_eq!(
            (a, b, c),
            (Some([0xaa; 32]), Some([0xaa; 32]), Some([0xaa; 32]))
        );
        let tags = |z: &Zone| z.slots.iter().map(|s| s[..8].to_vec()).collect::<Vec<_>>();
        for (x, y) in [(&za, &zb), (&za, &zc), (&zb, &zc)] {
            assert!(
                tags(x).iter().all(|t| !tags(y).contains(t)),
                "a tag shared across seqs"
            );
        }
        // A zone of the 4-byte `seq` (version 1, 362 bytes) is refused.
        let mut old = z.encode();
        old[0] = 1;
        old.drain(74..78);
        assert_eq!(Zone::decode(&old), Err(Invalid::Encoding));
        let mut v1 = z.encode();
        v1[0] = 1;
        assert_eq!(Zone::decode(&v1), Err(Invalid::Encoding));
        let other = RoomNames::derive("another zone room");
        assert_eq!(z.open(&other, "alpha"), None);
        // The used slots look like the unused: no tag repeats across versions.
        let z2 = Zone::seal(&names, &key, "alpha", 4, &[(None, [0xaa; 32])], false).unwrap();
        assert!(
            z.slots
                .iter()
                .all(|s| z2.slots.iter().all(|t| s[..8] != t[..8]))
        );
    }

    #[test]
    fn two_owners_of_one_name_at_one_seq_share_no_key_or_tag() {
        // After a lapse (or a back-order) another owner starts its zone at the same small `seq`.
        let names = RoomNames::derive("zone owners");
        let a = owner_key(&[1; 32], &names, "shared");
        let b = owner_key(&[2; 32], &names, "shared");
        let za = Zone::seal(&names, &a, "shared", 1, &[(None, [0xaa; 32])], false).unwrap();
        let zb = Zone::seal(&names, &b, "shared", 1, &[(None, [0xbb; 32])], false).unwrap();
        assert!(
            za.slots
                .iter()
                .all(|s| zb.slots.iter().all(|t| s[..8] != t[..8])),
            "no tag in common"
        );
        assert_eq!(za.open(&names, "shared"), Some([0xaa; 32]));
        assert_eq!(zb.open(&names, "shared"), Some([0xbb; 32]));
    }

    #[test]
    fn the_higher_seq_wins_then_the_lower_hash() {
        let names = RoomNames::derive("zone order");
        let key = owner_key(&[2; 32], &names, "node1");
        let a = Zone::seal(&names, &key, "node1", 5, &[(None, [1; 32])], false).unwrap();
        let b = Zone::seal(&names, &key, "node1", 6, &[(None, [2; 32])], false).unwrap();
        assert!(b.beats(&a) && !a.beats(&b));
        let c = Zone::seal(&names, &key, "node1", 6, &[(None, [3; 32])], false).unwrap();
        assert!(b.beats(&c) != c.beats(&b), "equal seq: exactly one wins");
        let lower = if Sha256::digest(b.encode()) < Sha256::digest(c.encode()) {
            &b
        } else {
            &c
        };
        assert!(lower.beats(if lower == &b { &c } else { &b }));
        assert!(!a.beats(&a));
    }
}
