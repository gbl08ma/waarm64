//! A room's lookups (docs/networking/rooms.md "Finding a peer"): a node's tag by the hour, and the sealed
//! question a dialer publishes under its target's tag.
//!
//! A lookup carries the dialer's node key, its home region (an index into the link's DERP
//! regions), a time and a random nonce. Sealed to the target's own key when the dialer knows it
//! (an X25519 box from an ephemeral key: only the target reads it), else with the room's lookup
//! key (any member who knows the address could). Both keys mix in the room's lookup key, so only a
//! member makes one, and the tag is the AEAD's associated data, so one can't be moved to another
//! address or hour. It's a hint, not a proof: the WireGuard handshake decides. The seal uses the
//! WireGuard node key itself, with a label of its own (rooms.md "Decisions": no second key). Both kinds look
//! alike to a relay: 32 bytes (the ephemeral key, or random bytes whose first 12 are the nonce),
//! then the ciphertext; the target tries the seal first.

use blake2::{Blake2s256, Digest};
use chacha20poly1305::{
    ChaCha20Poly1305, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use x25519_dalek::{X25519_BASEPOINT_BYTES, x25519};

use super::Room;

const PLAIN: usize = 32 + 2 + 8 + 16;
/// A lookup's bytes, either kind.
pub const SIZE: usize = 32 + PLAIN + 16;

#[derive(Debug, Clone, PartialEq)]
pub struct Lookup {
    pub key: [u8; 32],
    pub region: u16,
    /// Unix seconds.
    pub time: u64,
    pub nonce: [u8; 16],
}

impl Room {
    /// A node's tag for `hour` (Unix hours): what its subscription filters on.
    pub fn tag_for(&self, addr: &[u8; 16], hour: u64) -> String {
        let mut h = Blake2s256::new();
        h.update(self.salt);
        h.update(addr);
        h.update(hour.to_be_bytes());
        h.finalize()[..16]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}

fn seal_key(lookup: &[u8; 32], dh: &[u8; 32], eph: &[u8; 32], to: &[u8; 32]) -> [u8; 32] {
    let mut h = Blake2s256::new();
    h.update(b"waarm64 room lookup seal v1\0");
    h.update(lookup);
    h.update(dh);
    h.update(eph);
    h.update(to);
    h.finalize().into()
}

impl Lookup {
    fn plain(&self) -> Vec<u8> {
        let mut p = Vec::with_capacity(PLAIN);
        p.extend_from_slice(&self.key);
        p.extend_from_slice(&self.region.to_be_bytes());
        p.extend_from_slice(&self.time.to_be_bytes());
        p.extend_from_slice(&self.nonce);
        p
    }

    fn from_plain(p: &[u8]) -> Option<Lookup> {
        (p.len() == PLAIN).then(|| Lookup {
            key: p[..32].try_into().unwrap(),
            region: u16::from_be_bytes([p[32], p[33]]),
            time: u64::from_be_bytes(p[34..42].try_into().unwrap()),
            nonce: p[42..].try_into().unwrap(),
        })
    }

    /// Sealed to node key `to` when known, else with the room's lookup key; `tag` is the target's.
    pub fn seal(&self, room: &Room, to: Option<&[u8; 32]>, tag: &str) -> Vec<u8> {
        let mut rnd = [0u8; 32];
        getrandom::fill(&mut rnd).expect("randomness");
        let aad = tag.as_bytes();
        match to {
            Some(to) => {
                let eph = x25519(rnd, X25519_BASEPOINT_BYTES);
                let k = seal_key(&room.lookup, &x25519(rnd, *to), &eph, to);
                let ct = ChaCha20Poly1305::new(&k.into())
                    .encrypt(
                        &Nonce::default(),
                        Payload {
                            msg: &self.plain(),
                            aad,
                        },
                    )
                    .unwrap();
                [&eph[..], &ct].concat()
            }
            None => {
                let nonce = Nonce::from_slice(&rnd[..12]);
                let ct = ChaCha20Poly1305::new(&room.lookup.into())
                    .encrypt(
                        nonce,
                        Payload {
                            msg: &self.plain(),
                            aad,
                        },
                    )
                    .unwrap();
                [&rnd[..], &ct].concat()
            }
        }
    }

    /// A lookup for the node with key pair (`private`, `public`) under `tag`, if it is one.
    pub fn open(
        room: &Room,
        private: &[u8; 32],
        public: &[u8; 32],
        tag: &str,
        b: &[u8],
    ) -> Option<Lookup> {
        let aad = tag.as_bytes();
        if b.len() != SIZE {
            return None;
        }
        let (head, ct) = b.split_at(32);
        let eph: [u8; 32] = head.try_into().unwrap();
        let k = seal_key(&room.lookup, &x25519(*private, eph), &eph, public);
        let plain = ChaCha20Poly1305::new(&k.into())
            .decrypt(&Nonce::default(), Payload { msg: ct, aad })
            .or_else(|_| {
                ChaCha20Poly1305::new(&room.lookup.into())
                    .decrypt(Nonce::from_slice(&head[..12]), Payload { msg: ct, aad })
            })
            .ok()?;
        Lookup::from_plain(&plain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(seed: u8) -> ([u8; 32], [u8; 32]) {
        let k = [seed; 32];
        (k, x25519(k, X25519_BASEPOINT_BYTES))
    }

    #[test]
    fn a_lookup_opens_only_for_its_target_room_and_tag() {
        let room = Room::derive("r");
        let (tp, tq) = pair(7);
        let addr = room.addr(&tq);
        let tag = room.tag_for(&addr, 490_000);
        assert_ne!(tag, room.tag_for(&addr, 490_001), "the hour turns it");
        assert_ne!(tag, Room::derive("r2").tag_for(&addr, 490_000));
        let l = Lookup {
            key: [1; 32],
            region: 2,
            time: 1_764_000_000,
            nonce: [3; 16],
        };
        for to in [Some(&tq), None] {
            let b = l.seal(&room, to, &tag);
            assert_eq!(b.len(), SIZE, "both kinds alike");
            assert_eq!(Lookup::open(&room, &tp, &tq, &tag, &b), Some(l.clone()));
            assert_eq!(Lookup::open(&room, &tp, &tq, "another tag", &b), None);
            assert_eq!(Lookup::open(&Room::derive("r2"), &tp, &tq, &tag, &b), None);
            let mut bad = b.clone();
            *bad.last_mut().unwrap() ^= 1;
            assert_eq!(Lookup::open(&room, &tp, &tq, &tag, &bad), None);
        }
        // Sealed to the key: another node of the room can't read it, even under the same tag.
        let b = l.seal(&room, Some(&tq), &tag);
        let (op, oq) = pair(8);
        assert_eq!(Lookup::open(&room, &op, &oq, &tag, &b), None);
        // Bare: any member could.
        let b = l.seal(&room, None, &tag);
        assert!(Lookup::open(&room, &op, &oq, &tag, &b).is_some());
    }
}
