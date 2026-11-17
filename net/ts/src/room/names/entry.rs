//! Entries (room-names.md "Records"): `claim`, `renew` and `release`, binary, fixed order,
//! integers little-endian, 175 bytes. Signed with the name's owner key (BIP-340) over a tagged
//! hash of the fields before the signature and the room's value; proof of work (Argon2id salted
//! with the name id) over those fields, nonce included. An entry's id is the SHA-256 of its bytes.
//!
//! [`Stamped`] is an entry checked (signature, proof of work) with what makes it count: its
//! anchor, one, the earliest offered, whose block's time is the entry's time; or a pending
//! anchor, at most one, which proves nothing.

use argon2::{Algorithm, Argon2, Block, Version};
use k256::schnorr::{Signature, SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};

use super::{
    Invalid, Params,
    anchor::{Anchor, Pending},
    arr,
    header::Header,
    id::RoomNames,
};

/// 2: no `ref` (version 1 carried a recent block's hash, and salted the proof of work with it).
pub const VERSION: u8 = 2;
pub const ENTRY_LEN: usize = 175;
/// The fields before the signature: what proof of work and the signature cover.
const SIGNED_LEN: usize = ENTRY_LEN - 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Kind {
    Claim = 0,
    Renew = 1,
    Release = 2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub kind: Kind,
    /// The room's 40 prefix bits.
    pub room: [u8; 5],
    pub name: [u8; 32],
    /// The owner key (BIP-340, x only).
    pub owner: [u8; 32],
    /// The id of the entry before; zeros in a claim.
    pub prev: [u8; 32],
    pub nonce: u64,
    pub sig: [u8; 64],
}

/// BIP-340's tagged hash: SHA-256 of the tag's SHA-256 twice, then `parts`.
pub(super) fn tagged(tag: &str, parts: &[&[u8]]) -> [u8; 32] {
    let t = Sha256::digest(tag.as_bytes());
    let mut h = Sha256::new();
    h.update(t);
    h.update(t);
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

pub(super) fn sign(key: &SigningKey, msg: &[u8; 32]) -> [u8; 64] {
    let mut aux = [0u8; 32];
    let _ = getrandom::fill(&mut aux); // BIP-340's aux randomness is hardening only
    key.sign_prehash_with_aux_rand(msg, &aux)
        .expect("a valid key signs")
        .to_bytes()
}

pub(super) fn verify(owner: &[u8; 32], msg: &[u8; 32], sig: &[u8; 64]) -> bool {
    let (Ok(k), Ok(s)) = (
        VerifyingKey::from_bytes(owner),
        Signature::try_from(&sig[..]),
    ) else {
        return false;
    };
    k.verify_raw(msg, &s).is_ok()
}

/// What an entry's owner signs for a pending anchor of entry `id` (room-names.md "Records").
pub fn pending_hash(names: &RoomNames, id: &[u8; 32], p: &Pending) -> [u8; 32] {
    tagged("waarm64/names/pending", &[&names.value, id, &p.body()])
}

/// Signs pending anchor `p` of entry `id` with its owner key.
pub fn sign_pending(key: &SigningKey, names: &RoomNames, id: &[u8; 32], p: &mut Pending) {
    p.sig = sign(key, &pending_hash(names, id, p));
}

/// Whether `owner` signed pending anchor `p` of entry `id`.
pub fn pending_ok(names: &RoomNames, owner: &[u8; 32], id: &[u8; 32], p: &Pending) -> bool {
    verify(owner, &pending_hash(names, id, p), &p.sig)
}

impl Entry {
    /// An unsigned entry with no work done: [`Pow::mine`] and [`Entry::sign`] finish it.
    pub fn new(
        names: &RoomNames,
        kind: Kind,
        name: [u8; 32],
        owner: [u8; 32],
        prev: [u8; 32],
    ) -> Entry {
        Entry {
            kind,
            room: names.room,
            name,
            owner,
            prev,
            nonce: 0,
            sig: [0; 64],
        }
    }

    fn signed(&self) -> [u8; SIGNED_LEN] {
        self.encode()[..SIGNED_LEN].try_into().unwrap()
    }

    pub fn encode(&self) -> [u8; ENTRY_LEN] {
        let mut b = [0u8; ENTRY_LEN];
        b[0] = VERSION;
        b[1] = self.kind as u8;
        b[2..7].copy_from_slice(&self.room);
        b[7..39].copy_from_slice(&self.name);
        b[39..71].copy_from_slice(&self.owner);
        b[71..103].copy_from_slice(&self.prev);
        b[103..111].copy_from_slice(&self.nonce.to_le_bytes());
        b[111..].copy_from_slice(&self.sig);
        b
    }

    pub fn decode(b: &[u8]) -> Result<Entry, Invalid> {
        if b.len() != ENTRY_LEN || b[0] != VERSION {
            return Err(Invalid::Encoding);
        }
        let kind = match b[1] {
            0 => Kind::Claim,
            1 => Kind::Renew,
            2 => Kind::Release,
            _ => return Err(Invalid::Encoding),
        };
        Ok(Entry {
            kind,
            room: arr(b, 2),
            name: arr(b, 7),
            owner: arr(b, 39),
            prev: arr(b, 71),
            nonce: u64::from_le_bytes(arr(b, 103)),
            sig: arr(b, 111),
        })
    }

    pub fn id(&self) -> [u8; 32] {
        Sha256::digest(self.encode()).into()
    }

    /// What the owner signs: a tagged hash of the room's value and the fields before the
    /// signature.
    pub fn sighash(&self, names: &RoomNames) -> [u8; 32] {
        tagged("waarm64/names/entry", &[&names.value, &self.signed()])
    }

    pub fn sign(&mut self, key: &SigningKey, names: &RoomNames) {
        self.sig = sign(key, &self.sighash(names));
    }

    pub fn signature_ok(&self, names: &RoomNames) -> bool {
        verify(&self.owner, &self.sighash(names), &self.sig)
    }
}

/// The proof of work's function, with its memory kept between calls: Argon2id with the
/// parameters' memory, passes and lanes, 32 bytes out, salted with the name id (so work done for one name serves
/// no other, room-names.md "Records").
pub struct Pow {
    argon: Argon2<'static>,
    blocks: Vec<Block>,
    bits: u32,
}

impl Pow {
    pub fn new(params: &Params) -> Pow {
        let p = argon2::Params::new(params.pow_m_kib, params.pow_t, params.pow_p, Some(32))
            .expect("valid Argon2 parameters");
        let blocks = vec![Block::default(); p.block_count()];
        Pow {
            argon: Argon2::new(Algorithm::Argon2id, Version::V0x13, p),
            blocks,
            bits: params.pow_bits,
        }
    }

    /// The function's output for an entry's signed fields.
    pub fn hash(&mut self, e: &Entry) -> [u8; 32] {
        let mut out = [0u8; 32];
        self.argon
            .hash_password_into_with_memory(&e.signed(), &e.name, &mut out, &mut self.blocks[..])
            .expect("Argon2 with valid sizes");
        out
    }

    /// Whether `e`'s proof of work holds: `bits` leading zero bits.
    pub fn ok(&mut self, e: &Entry) -> bool {
        leading_zeros(&self.hash(e)) >= self.bits
    }

    /// Tries `tries` nonces from `e`'s; true when one holds (left in `e`).
    pub fn mine(&mut self, e: &mut Entry, tries: u64) -> bool {
        for _ in 0..tries {
            if self.ok(e) {
                return true;
            }
            e.nonce = e.nonce.wrapping_add(1);
        }
        false
    }
}

fn leading_zeros(h: &[u8; 32]) -> u32 {
    let mut n = 0;
    for &b in h {
        n += b.leading_zeros();
        if b != 0 {
            break;
        }
    }
    n
}

/// An anchor checked: its block's header, its time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anchored {
    pub anchor: Anchor,
    pub header: Header,
}

impl Anchored {
    pub fn time(&self) -> u32 {
        self.header.time()
    }

    /// The order among one entry's anchors: earliest time, then lower block hash, then lower
    /// bytes, so every node that saw the same anchors keeps the same one.
    fn key(&self) -> (u32, [u8; 32], Vec<u8>) {
        (self.time(), self.header.hash(), self.anchor.encode())
    }
}

/// An entry checked, with what anchors it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamped {
    pub entry: Entry,
    id: [u8; 32],
    anchor: Option<Anchored>,
    pending: Option<Pending>,
}

impl Stamped {
    /// Checks everything about `entry` but its anchor: its form, room, signature and proof of work.
    pub fn check(entry: Entry, names: &RoomNames, pow: &mut Pow) -> Result<Stamped, Invalid> {
        if (entry.kind == Kind::Claim) != (entry.prev == [0; 32]) {
            return Err(Invalid::Prev);
        }
        if entry.room != names.room {
            return Err(Invalid::Room);
        }
        if !entry.signature_ok(names) {
            return Err(Invalid::Signature);
        }
        if !pow.ok(&entry) {
            return Err(Invalid::Work);
        }
        let id = entry.id();
        Ok(Stamped {
            entry,
            id,
            anchor: None,
            pending: None,
        })
    }

    /// An entry as this node stored it, verified when it was first taken: not checked again (a
    /// server's store, room-names.md "Servers").
    pub fn trusted(entry: Entry, anchor: Option<Anchored>, pending: Option<Pending>) -> Stamped {
        let id = entry.id();
        let pending = pending.filter(|_| anchor.is_none());
        Stamped {
            entry,
            id,
            anchor,
            pending,
        }
    }

    pub fn id(&self) -> [u8; 32] {
        self.id
    }

    /// The entry's time: its anchor's block's. None while it has none (it counts for nothing).
    pub fn time(&self) -> Option<u32> {
        self.anchor.as_ref().map(Anchored::time)
    }

    pub fn anchor(&self) -> Option<&Anchored> {
        self.anchor.as_ref()
    }

    pub fn pending(&self) -> Option<&Pending> {
        self.pending.as_ref()
    }

    /// An anchor offered for this entry: checked (its block's header proves itself, the anchor
    /// reaches the header's Merkle root) and kept if it is the earliest. Ok(true) when it was
    /// taken.
    pub fn offer_anchor(
        &mut self,
        anchor: Anchor,
        header: Header,
        params: &Params,
        now: u64,
    ) -> Result<bool, Invalid> {
        header.check(params, now)?;
        if anchor.root(&self.id) != Some(header.merkle_root()) {
            return Err(Invalid::AnchorRoot);
        }
        Ok(self.take(Anchored { anchor, header }))
    }

    fn take(&mut self, a: Anchored) -> bool {
        if self.anchor.as_ref().is_some_and(|b| b.key() <= a.key()) {
            return false;
        }
        self.anchor = Some(a);
        self.pending = None;
        true
    }

    /// A pending anchor offered: kept while the entry has no anchor; of two, the lower (so the
    /// choice doesn't depend on which came first). Whether it can still link is its holder's to
    /// judge (chain.rs `Name::stale`): the entry before it is what says.
    pub fn offer_pending(&mut self, p: Pending) -> bool {
        if self.anchor.is_some() {
            return false;
        }
        if self.pending.as_ref().is_some_and(|q| *q <= p) {
            return false;
        }
        self.pending = Some(p);
        true
    }

    /// Drops the pending anchor (the chain's last entry is the only one that carries one).
    pub fn drop_pending(&mut self) {
        self.pending = None;
    }

    /// Takes what `other`, a copy of the same entry checked elsewhere, adds: its anchor if
    /// earlier, its pending if lower. True when anything changed.
    pub fn merge(&mut self, other: Stamped) -> bool {
        debug_assert_eq!(self.id, other.id);
        let mut changed = false;
        if let Some(a) = other.anchor {
            changed |= self.take(a);
        }
        if let Some(p) = other.pending {
            changed |= self.offer_pending(p);
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn an_entry_encodes_signs_and_reads_back() {
        let names = RoomNames::derive("entry test");
        let mut sk = [0u8; 32];
        sk[31] = 3;
        let key = SigningKey::from_bytes(&sk).unwrap();
        let owner: [u8; 32] = key.verifying_key().to_bytes().into();
        let mut e = Entry::new(
            &names,
            Kind::Renew,
            names.name_id("test123"),
            owner,
            [1; 32],
        );
        e.nonce = 0x0102_0304_0506_0708;
        let b = e.encode();
        assert_eq!(b.len(), 175);
        assert_eq!(b[..2], [2, 1]);
        assert_eq!(b[2..7], names.room);
        assert_eq!(b[39..71], owner);
        assert_eq!(b[71..103], [1; 32]);
        assert_eq!(b[103..111], [8, 7, 6, 5, 4, 3, 2, 1], "little-endian");
        e.sig = key
            .sign_prehash_with_aux_rand(&e.sighash(&names), &[0; 32])
            .unwrap()
            .to_bytes();
        assert!(e.signature_ok(&names));
        // Pinned: the encoding, the tagged hash and BIP-340 (aux randomness zero) as built.
        assert_eq!(
            hex(&e.sighash(&names)),
            "53bf36637984618fe5782cdffac0c09ba71aa829e23b2f234ae3273f95b711b9"
        );
        assert_eq!(
            hex(&e.id()),
            "47e4b2d91373127a452c0c26fccc6c8a7f89667ae82cd8d91116d33bf83980c1"
        );
        assert_eq!(Entry::decode(&e.encode()), Ok(e.clone()));
        // The signature takes the room's value: the same bytes in a room whose prefix collided.
        let mut other = RoomNames::derive("another room");
        other.room = names.room;
        assert!(!e.signature_ok(&other));
        // Any field changed breaks it.
        let mut f = e.clone();
        f.nonce += 1;
        assert!(!f.signature_ok(&names));
        assert_eq!(Entry::decode(&b[..174]), Err(Invalid::Encoding));
        let mut x = b;
        x[1] = 3;
        assert_eq!(Entry::decode(&x), Err(Invalid::Encoding));
        x[1] = 1;
        // Version 1 (with `ref`) is refused, at its own length too (pre-release: decision 11).
        x[0] = 1;
        assert_eq!(Entry::decode(&x), Err(Invalid::Encoding));
        let mut v1 = vec![1, 1];
        v1.resize(207, 0);
        assert_eq!(Entry::decode(&v1), Err(Invalid::Encoding));
    }

    #[test]
    fn argon2id_as_the_spec_has_it() {
        // The function the entries use: 1 MiB, t=1, p=1, 32 bytes, the signed fields as the
        // password, the name id as the salt.
        let mut pow = Pow::new(&Params::PRODUCTION);
        let names = RoomNames::derive("pow");
        let e = Entry::new(&names, Kind::Claim, [3; 32], [4; 32], [0; 32]);
        let h = pow.hash(&e);
        // The same from Node's `crypto.argon2Sync('argon2id', { message: <the 111 signed bytes>,
        // nonce: <the name id>, parallelism: 1, tagLength: 32, memory: 1024, passes: 1 })`
        // (OpenSSL's).
        assert_eq!(
            hex(&h),
            "25f4f6f765cbecb08e2841e4d3741cc12f3a4a53798da29cd3116e5286411ec8"
        );
        assert_eq!(h, pow.hash(&e), "deterministic, memory reused");
        let mut z = [0u8; 32];
        z[1] = 0x10;
        assert_eq!(leading_zeros(&z), 11);
        assert_eq!(leading_zeros(&[0; 32]), 256);
    }
}
