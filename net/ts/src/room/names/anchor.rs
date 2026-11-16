//! Anchors (room-names.md "Records", "Bitcoin as the clock"): an OpenTimestamps proof from an
//! entry's id to a Bitcoin block's Merkle root. Written from the format (a timestamp is a tree of
//! operations from a message to attestations; its serialization is documented by the
//! OpenTimestamps project), nothing taken from its LGPL libraries.
//!
//! The serialization: an operation is a tag byte (`0x08` SHA-256; `0xf0` append and `0xf1`
//! prepend, each followed by its argument as varbytes) and then the timestamp of its result; an
//! attestation is `0x00`, an 8-byte tag and its payload as varbytes; where a message has several
//! of those, all but the last are prefixed with `0xff`. Varuints are 7 bits a byte, low first, the
//! top bit saying more follows; varbytes are a varuint length and the bytes. The Bitcoin
//! attestation's payload is the block's height as a varuint, which nothing here trusts: the
//! block's header comes with the anchor and gives its time.
//!
//! An [`Anchor`] is one path, linear: operations then the Bitcoin attestation, 4 KiB at most; any
//! other operation, attestation or a fork is invalid. [`leaves`] reads a calendar's answer, which
//! may fork, to build one. A [`Pending`] anchor is a calendar's receipt kept as the calendar's
//! index (of the compiled three) and the operations to its commitment: never a URL.

use sha2::{Digest, Sha256};

use super::Invalid;

/// An anchor's bytes at most, and a pending one's.
pub const MAX_ANCHOR: usize = 4096;
/// The longest message the operations may make (the format's own limit).
const MAX_MSG: usize = 4096;
/// The most bytes [`leaves`] reads of a calendar's answer.
const MAX_TIMESTAMP: usize = 8192;
const BITCOIN: [u8; 8] = [0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01];
const PENDING: [u8; 8] = [0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e];

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Op {
    Sha256,
    Append(Vec<u8>),
    Prepend(Vec<u8>),
}

impl Op {
    fn apply(&self, m: &[u8]) -> Option<Vec<u8>> {
        let out = match self {
            Op::Sha256 => Sha256::digest(m).to_vec(),
            Op::Append(a) => [m, a].concat(),
            Op::Prepend(a) => [a, m].concat(),
        };
        (out.len() <= MAX_MSG).then_some(out)
    }

    fn write(&self, out: &mut Vec<u8>) {
        match self {
            Op::Sha256 => out.push(0x08),
            Op::Append(a) | Op::Prepend(a) => {
                out.push(if matches!(self, Op::Append(_)) {
                    0xf0
                } else {
                    0xf1
                });
                varuint(out, a.len() as u64);
                out.extend_from_slice(a);
            }
        }
    }
}

/// The operations applied to `msg` in turn; None when a message grows past the format's limit.
pub fn apply(ops: &[Op], msg: &[u8]) -> Option<Vec<u8>> {
    let mut m = msg.to_vec();
    for op in ops {
        m = op.apply(&m)?;
    }
    Some(m)
}

fn varuint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

fn ops_bytes(ops: &[Op]) -> Vec<u8> {
    let mut out = Vec::new();
    for op in ops {
        op.write(&mut out);
    }
    out
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Reader<'a> {
    fn byte(&mut self) -> Result<u8, Invalid> {
        let x = *self.b.get(self.i).ok_or(Invalid::AnchorFormat)?;
        self.i += 1;
        Ok(x)
    }

    fn varuint(&mut self) -> Result<u64, Invalid> {
        let mut v = 0u64;
        for shift in (0..64).step_by(7) {
            let x = self.byte()?;
            v |= ((x & 0x7f) as u64) << shift;
            if x & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err(Invalid::AnchorFormat)
    }

    fn bytes(&mut self, n: usize) -> Result<&'a [u8], Invalid> {
        let end = self.i.checked_add(n).ok_or(Invalid::AnchorFormat)?;
        let s = self.b.get(self.i..end).ok_or(Invalid::AnchorFormat)?;
        self.i = end;
        Ok(s)
    }

    fn varbytes(&mut self, max: usize) -> Result<&'a [u8], Invalid> {
        let n = self.varuint()?;
        if n > max as u64 {
            return Err(Invalid::AnchorFormat);
        }
        self.bytes(n as usize)
    }

    fn done(&self) -> bool {
        self.i == self.b.len()
    }

    /// An operation whose tag was read: append or prepend's argument, or SHA-256.
    fn op(&mut self, tag: u8) -> Result<Op, Invalid> {
        Ok(match tag {
            0x08 => Op::Sha256,
            0xf0 => Op::Append(self.varbytes(MAX_MSG)?.to_vec()),
            0xf1 => Op::Prepend(self.varbytes(MAX_MSG)?.to_vec()),
            _ => return Err(Invalid::AnchorFormat),
        })
    }
}

/// An anchor: the operations from an entry's id to a block's Merkle root, and the Bitcoin
/// attestation (its height, carried as the format has it and trusted for nothing).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anchor {
    pub ops: Vec<Op>,
    pub height: u64,
}

impl Anchor {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = ops_bytes(&self.ops);
        out.push(0x00);
        out.extend_from_slice(&BITCOIN);
        let mut h = Vec::new();
        varuint(&mut h, self.height);
        varuint(&mut out, h.len() as u64);
        out.extend_from_slice(&h);
        out
    }

    pub fn decode(b: &[u8]) -> Result<Anchor, Invalid> {
        if b.len() > MAX_ANCHOR {
            return Err(Invalid::AnchorFormat);
        }
        let mut r = Reader { b, i: 0 };
        let mut ops = Vec::new();
        loop {
            match r.byte()? {
                0x00 => break,
                tag => ops.push(r.op(tag)?),
            }
        }
        if r.bytes(8)? != BITCOIN {
            return Err(Invalid::AnchorFormat);
        }
        let mut p = Reader {
            b: r.varbytes(16)?,
            i: 0,
        };
        let height = p.varuint()?;
        if !p.done() || !r.done() {
            return Err(Invalid::AnchorFormat);
        }
        Ok(Anchor { ops, height })
    }

    /// The Merkle root this anchor reaches from `id`: None when it reaches no 32-byte message or
    /// is too big.
    pub fn root(&self, id: &[u8; 32]) -> Option<[u8; 32]> {
        if self.encode().len() > MAX_ANCHOR {
            return None;
        }
        apply(&self.ops, id)?.try_into().ok()
    }
}

/// What a path of a timestamp ends in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attestation {
    /// A Bitcoin block at this height.
    Bitcoin(u64),
    /// A calendar's promise (its URL is read past and kept nowhere).
    Pending,
    /// Any other kind: not for anchors.
    Unknown,
}

/// One path of a timestamp: the operations from its message to an attestation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Leaf {
    pub ops: Vec<Op>,
    pub attestation: Attestation,
}

/// Every attestation a serialized timestamp (a calendar's receipt or proof) reaches from `msg`,
/// with the operations on the way. Refused whole when it has an operation other than the three
/// (whose argument couldn't be read past), a message past the format's limit, or bytes after it.
pub fn leaves(b: &[u8], msg: &[u8]) -> Result<Vec<Leaf>, Invalid> {
    if b.len() > MAX_TIMESTAMP {
        return Err(Invalid::AnchorFormat);
    }
    let mut r = Reader { b, i: 0 };
    let mut out = Vec::new();
    // Each pending item: the message it starts from and the operations that made it. A tree's
    // depth is bounded by its bytes, so an explicit stack rather than recursion.
    let mut stack: Vec<(Vec<u8>, Vec<Op>)> = vec![(msg.to_vec(), Vec::new())];
    while let Some((m, ops)) = stack.pop() {
        let mut tag = r.byte()?;
        let more = tag == 0xff;
        if more {
            tag = r.byte()?;
            // After this item, another of the same message follows.
            stack.push((m.clone(), ops.clone()));
        }
        if tag == 0x00 {
            let kind: [u8; 8] = r.bytes(8)?.try_into().unwrap();
            let mut p = Reader {
                b: r.varbytes(MAX_MSG)?,
                i: 0,
            };
            let attestation = match kind {
                BITCOIN => {
                    let h = p.varuint()?;
                    if !p.done() {
                        return Err(Invalid::AnchorFormat);
                    }
                    Attestation::Bitcoin(h)
                }
                PENDING => Attestation::Pending,
                _ => Attestation::Unknown,
            };
            out.push(Leaf { ops, attestation });
        } else {
            let op = r.op(tag)?;
            let next = op.apply(&m).ok_or(Invalid::AnchorFormat)?;
            let mut ops = ops;
            ops.push(op);
            stack.push((next, ops));
        }
    }
    if !r.done() {
        return Err(Invalid::AnchorFormat);
    }
    Ok(out)
}

/// The calendars compiled in (room-names.md "Bitcoin as the clock"): `alice` and `bob` at
/// opentimestamps.org, `finney` at eternitywall.com.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Calendar {
    Alice = 0,
    Bob = 1,
    Finney = 2,
}

impl Calendar {
    pub const ALL: [Calendar; 3] = [Calendar::Alice, Calendar::Bob, Calendar::Finney];

    pub fn url(self) -> &'static str {
        match self {
            Calendar::Alice => "https://alice.btc.calendar.opentimestamps.org",
            Calendar::Bob => "https://bob.btc.calendar.opentimestamps.org",
            Calendar::Finney => "https://finney.calendar.eternitywall.com",
        }
    }

    fn from_u8(b: u8) -> Option<Calendar> {
        Calendar::ALL.get(b as usize).copied()
    }
}

/// A pending anchor: which calendar, and the operations from the entry's id to its commitment
/// (what `/timestamp/<commitment>` is asked for). Proves nothing.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Pending {
    pub calendar: Calendar,
    pub ops: Vec<Op>,
}

impl Pending {
    /// From a calendar's receipt for `id`: its first pending path.
    pub fn from_receipt(
        calendar: Calendar,
        receipt: &[u8],
        id: &[u8; 32],
    ) -> Result<Pending, Invalid> {
        let leaf = leaves(receipt, id)?
            .into_iter()
            .find(|l| l.attestation == Attestation::Pending)
            .ok_or(Invalid::AnchorFormat)?;
        let p = Pending {
            calendar,
            ops: leaf.ops,
        };
        if p.encode().len() > MAX_ANCHOR {
            return Err(Invalid::AnchorFormat);
        }
        Ok(p)
    }

    pub fn commitment(&self, id: &[u8; 32]) -> Option<Vec<u8>> {
        apply(&self.ops, id)
    }

    /// The anchors the calendar's finished proof (its answer for the commitment) gives: one per
    /// Bitcoin attestation it reaches, this pending's operations first. Each still needs its
    /// header checked ([`super::entry::Stamped::offer_anchor`]).
    pub fn finish(&self, id: &[u8; 32], proof: &[u8]) -> Result<Vec<Anchor>, Invalid> {
        let c = self.commitment(id).ok_or(Invalid::AnchorFormat)?;
        Ok(leaves(proof, &c)?
            .into_iter()
            .filter_map(|l| match l.attestation {
                Attestation::Bitcoin(height) => {
                    let ops = [self.ops.clone(), l.ops].concat();
                    let a = Anchor { ops, height };
                    (a.encode().len() <= MAX_ANCHOR).then_some(a)
                }
                _ => None,
            })
            .collect())
    }

    /// The calendar's index, then the operations.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = vec![self.calendar as u8];
        out.extend(ops_bytes(&self.ops));
        out
    }

    pub fn decode(b: &[u8]) -> Result<Pending, Invalid> {
        if b.len() > MAX_ANCHOR {
            return Err(Invalid::AnchorFormat);
        }
        let mut r = Reader { b, i: 0 };
        let calendar = Calendar::from_u8(r.byte()?).ok_or(Invalid::AnchorFormat)?;
        let mut ops = Vec::new();
        while !r.done() {
            let tag = r.byte()?;
            ops.push(r.op(tag)?);
        }
        Ok(Pending { calendar, ops })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varuints_round_trip() {
        for v in [0u64, 1, 127, 128, 300, 976_177, u32::MAX as u64, u64::MAX] {
            let mut b = Vec::new();
            varuint(&mut b, v);
            assert_eq!(Reader { b: &b, i: 0 }.varuint(), Ok(v));
        }
        // 976,177 as the format writes it.
        let mut b = Vec::new();
        varuint(&mut b, 976_177);
        assert_eq!(b, [0xb1, 0xca, 0x3b]);
        // Eleven continuation bytes: past 64 bits.
        assert!(
            Reader {
                b: &[0xff; 11],
                i: 0
            }
            .varuint()
            .is_err()
        );
    }

    #[test]
    fn only_the_four_are_taken() {
        let a = Anchor {
            ops: vec![Op::Append(vec![1; 16]), Op::Sha256, Op::Prepend(vec![2; 3])],
            height: 5,
        };
        let b = a.encode();
        assert_eq!(Anchor::decode(&b), Ok(a.clone()));
        // Another operation (RIPEMD-160, 0x03; reverse, 0xf2), another attestation (Litecoin's),
        // a fork, bytes after it, a truncation: all invalid.
        // The other hashes the format has (SHA-1 0x02, RIPEMD-160 0x03, Keccak-256 0x67) where a
        // SHA-256 stands, and the unary ones (reverse 0xf2, hexlify 0xf3).
        let one = Anchor {
            ops: vec![Op::Sha256, Op::Sha256],
            height: 5,
        }
        .encode();
        for tag in [0x02, 0x03, 0x67, 0xf2, 0xf3] {
            let mut x = one.clone();
            x[1] = tag;
            assert_eq!(Anchor::decode(&x), Err(Invalid::AnchorFormat), "{tag:#x}");
        }
        let mut x = b.clone();
        x[0] = 0x03;
        assert_eq!(Anchor::decode(&x), Err(Invalid::AnchorFormat));
        x[0] = 0xf2;
        assert_eq!(Anchor::decode(&x), Err(Invalid::AnchorFormat));
        let at = b.len() - 1 - 1 - 8;
        let mut x = b.clone();
        x[at + 1..at + 9].copy_from_slice(&[0x06, 0x86, 0x9a, 0x0d, 0x73, 0xd7, 0x1b, 0x45]);
        assert_eq!(Anchor::decode(&x), Err(Invalid::AnchorFormat));
        let x = [&[0xff][..], &b].concat();
        assert_eq!(Anchor::decode(&x), Err(Invalid::AnchorFormat));
        let x = [&b[..], &[0]].concat();
        assert_eq!(Anchor::decode(&x), Err(Invalid::AnchorFormat));
        assert_eq!(
            Anchor::decode(&b[..b.len() - 1]),
            Err(Invalid::AnchorFormat)
        );
        // 4 KiB at most.
        let big = Anchor {
            ops: vec![
                Op::Append(vec![0; 2100]),
                Op::Sha256,
                Op::Append(vec![0; 2100]),
            ],
            height: 1,
        };
        assert_eq!(Anchor::decode(&big.encode()), Err(Invalid::AnchorFormat));
        assert_eq!(big.root(&[0; 32]), None);
    }

    #[test]
    fn a_tree_forks_and_pending_round_trips() {
        // id -> append(a) -> sha256 -> { pending | bitcoin 7 }, as a receipt and a proof together.
        let mut t = Vec::new();
        Op::Append(vec![9; 4]).write(&mut t);
        Op::Sha256.write(&mut t);
        t.push(0xff);
        t.extend_from_slice(&[0x00]);
        t.extend_from_slice(&PENDING);
        t.extend_from_slice(&[5, 4, b'h', b't', b't', b'p']);
        t.extend_from_slice(&[0x00]);
        t.extend_from_slice(&BITCOIN);
        t.extend_from_slice(&[1, 7]);
        let l = leaves(&t, &[1; 32]).unwrap();
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].attestation, Attestation::Pending);
        assert_eq!(l[1].attestation, Attestation::Bitcoin(7));
        assert_eq!(l[0].ops, l[1].ops);
        let p = Pending::from_receipt(Calendar::Bob, &t, &[1; 32]).unwrap();
        assert_eq!(Pending::decode(&p.encode()), Ok(p.clone()));
        assert!(Pending::decode(&[3]).is_err(), "a calendar not compiled in");
        // A finished proof for the commitment.
        let mut proof = Vec::new();
        Op::Prepend(vec![7; 2]).write(&mut proof);
        Op::Sha256.write(&mut proof);
        proof.extend_from_slice(&[0x00]);
        proof.extend_from_slice(&BITCOIN);
        proof.extend_from_slice(&[1, 8]);
        let a = p.finish(&[1; 32], &proof).unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].height, 8);
        assert_eq!(a[0].ops.len(), 4);
        let c = p.commitment(&[1; 32]).unwrap();
        let want: [u8; 32] = Sha256::digest([&[7, 7][..], &c].concat()).into();
        assert_eq!(a[0].root(&[1; 32]), Some(want));
        // Junk after the tree, or a tree that never ends.
        assert!(leaves(&[&t[..], &[0]].concat(), &[1; 32]).is_err());
        assert!(leaves(&t[..t.len() - 3], &[1; 32]).is_err());
    }
}
